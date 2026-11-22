// pmzrt_audio.c - audio for the browser-less runtime (included by pmzrt.c): a small mixer behind a WebAudio subset.
// All sample data lives here as int16 (PCM), the JS layer (webaudio.js) only holds ids. Mixing runs in the SDL audio thread.
//   graph: source (int16 PCM voice, loop points, rate) -> gain -> panner -> gain (master) -> destination (id 0), pulled from the destination
//   clock: currentTime = frames output / rate (sample clock); events (start/stop/param automation) are sample accurate
//   decode: Ogg Vorbis via libvorbisfile in a libuv worker thread (decodeAudioData promise), kept at the file's own sample rate
// JS->C commands and the audio callback share one mutex; the callback holds it for one block (~0.3 ms).
#include <vorbis/vorbisfile.h>
#include <time.h>

#define AU_MAXB 2048        // frames per mixing chunk (the SDL buffer is cut into chunks of this size)
#define AU_DEPTH 12         // graph depth limit
#define AU_NEV 32           // automation events per parameter

typedef struct { double t, v, t0, v0, tc; int type; } AEv;     // type 0 set, 1 linear ramp, 2 exponential ramp, 3 setTarget
typedef struct { double v; AEv ev[AU_NEV]; int n; } AParam;
typedef struct { int16_t *d; int nch; int64_t n; int sr; int refs; int used; } ABuf;
typedef struct {
  int used, type;                        // type 0 gain, 1 panner, 2 source, 3 destination
  AParam p[2];                           // [0] gain, [1] playbackRate
  int *in; int nin, cin;                 // inputs (pull side)
  int out[4]; int nout;
  double pgm[2], pgs[2]; int pneg;       // panner: mono gains L/R, stereo gains L/R, stereo azimuth <= 0
  int vstate;                            // source: 0 not started, 1 playing/scheduled, 2 ended
  int buf; double pos; int64_t startF, stopF, ls, le, endPos; int loop, notify;
} ANode;

static SDL_mutex *au_mx;
static SDL_AudioDeviceID au_dev;
static int au_rate = 44100, au_blk;
static double au_vol = 1.0;
static volatile int64_t au_frames;      // frames mixed so far (the clock)
static ABuf *au_B; static int au_nB, au_cB;
static ANode *au_N; static int au_nN, au_cN;
static int au_ended[512]; static volatile int au_nended;
static float au_sc[AU_DEPTH][2][AU_MAXB], au_accL[AU_MAXB], au_accR[AU_MAXB];
static double au_cbNs, au_cbMax; static int64_t au_cbCount, au_cbOver; static double au_sumsq, au_peak; static int64_t au_msamp;
static float *au_cap; static int64_t au_capN, au_capCap; static char au_dumpPath[512];
static int au_inited_sub;
#define AU_LOCK() SDL_LockMutex(au_mx)
#define AU_UNLOCK() SDL_UnlockMutex(au_mx)

// ---- parameters (AudioParam automation) ----
static double ap_eval(const AParam *p, double t) {
  if (p->n == 0) return p->v;
  int i = -1;
  for (int k = 0; k < p->n; k++) { if (p->ev[k].t <= t) i = k; else break; }
  if (i + 1 < p->n) {
    const AEv *e = &p->ev[i + 1];
    if (e->type == 1 || e->type == 2) {
      double span = e->t - e->t0;
      if (span <= 0) return e->v;
      double f = (t - e->t0) / span; if (f < 0) f = 0;
      if (e->type == 1) return e->v0 + (e->v - e->v0) * f;
      if (e->v0 > 0 && e->v > 0) return e->v0 * pow(e->v / e->v0, f);
      return e->v0 + (e->v - e->v0) * f;
    }
  }
  if (i < 0) return p->v;
  const AEv *e = &p->ev[i];
  if (e->type == 3) return e->tc > 0 ? e->v + (e->v0 - e->v) * exp(-(t - e->t) / e->tc) : e->v;
  return e->v;
}
static void ap_prune(AParam *p, double t) {   // drop events that are over; fold a finished last event into the intrinsic value
  while (p->n > 1 && p->ev[1].t <= t) { memmove(&p->ev[0], &p->ev[1], (p->n - 1) * sizeof(AEv)); p->n--; }
  if (p->n == 1 && p->ev[0].t <= t) {
    const AEv *e = &p->ev[0];
    if (e->type != 3) { p->v = e->v; p->n = 0; }
    else if (e->tc <= 0 || t - e->t > 12 * e->tc) { p->v = e->v; p->n = 0; }
  }
}
// op: 0 setValueAtTime, 1 linearRamp, 2 exponentialRamp, 3 setTarget (tc), 4 cancelScheduledValues(t), 5 set intrinsic value
static void ap_op(AParam *p, int op, double v, double t, double tc, double now) {
  if (op == 5) { p->v = v; p->n = 0; return; }
  if (op == 4) { int k = 0; while (k < p->n && p->ev[k].t < t) k++; p->n = k; return; }
  AEv e; memset(&e, 0, sizeof e); e.t = t; e.v = v; e.type = op; e.tc = tc;
  if (op != 0) {   // start of the segment: the last event (or the current value)
    if (p->n > 0) { const AEv *l = &p->ev[p->n - 1]; if (l->type == 3) { e.t0 = now; e.v0 = ap_eval(p, now); } else { e.t0 = l->t; e.v0 = l->v; } }
    else { e.t0 = now; e.v0 = p->v; }
    if (op == 3) { e.t0 = t; e.v0 = ap_eval(p, t); }
  }
  if (p->n >= AU_NEV) { memmove(&p->ev[0], &p->ev[1], (AU_NEV - 1) * sizeof(AEv)); p->n--; }
  int k = p->n; while (k > 0 && p->ev[k - 1].t > t) k--;   // keep sorted by time (stable)
  memmove(&p->ev[k + 1], &p->ev[k], (p->n - k) * sizeof(AEv)); p->ev[k] = e; p->n++;
}

// ---- nodes / buffers ----
static int node_alloc(int type) {
  int id = -1;
  for (int i = 1; i < au_nN; i++) if (!au_N[i].used) { id = i; break; }
  if (id < 0) {
    if (au_nN >= au_cN) { au_cN = au_cN ? au_cN * 2 : 64; au_N = realloc(au_N, au_cN * sizeof(ANode)); }
    id = au_nN++;
  }
  ANode *n = &au_N[id]; memset(n, 0, sizeof *n);
  n->used = 1; n->type = type; n->p[0].v = 1; n->p[1].v = 1; n->buf = -1; n->stopF = -1; n->endPos = -1;
  n->pgm[0] = n->pgm[1] = 0.70710678; n->pgs[0] = 0; n->pgs[1] = 1; n->pneg = 1;
  return id;
}
static void buf_unref(int id) {
  if (id < 0 || id >= au_nB || !au_B[id].used) return;
  if (--au_B[id].refs <= 0) { free(au_B[id].d); memset(&au_B[id], 0, sizeof(ABuf)); }
}
static void unlink_edge(int s, int d) {
  if (s < 0 || d < 0 || s >= au_nN || d >= au_nN) return;
  ANode *S = &au_N[s], *D = &au_N[d];
  for (int i = 0; i < S->nout; i++) if (S->out[i] == d) { S->out[i] = S->out[--S->nout]; break; }
  for (int i = 0; i < D->nin; i++) if (D->in[i] == s) { D->in[i] = D->in[--D->nin]; break; }
}
static void link_edge(int s, int d) {
  if (s < 0 || d < 0 || s >= au_nN || d >= au_nN || !au_N[s].used || !au_N[d].used || au_N[d].type == 2 || s == d) return;
  ANode *S = &au_N[s], *D = &au_N[d];
  for (int i = 0; i < S->nout; i++) if (S->out[i] == d) return;
  if (S->nout >= 4) return;
  S->out[S->nout++] = d;
  if (D->nin >= D->cin) { D->cin = D->cin ? D->cin * 2 : 4; D->in = realloc(D->in, D->cin * sizeof(int)); }
  D->in[D->nin++] = s;
}
static void node_release(int id) {   // unlink everything, drop the buffer reference
  ANode *n = &au_N[id];
  while (n->nout) unlink_edge(id, n->out[0]);
  while (n->nin) unlink_edge(n->in[0], id);
  if (n->type == 2 && n->vstate == 1) buf_unref(n->buf);
  n->vstate = 2; n->buf = -1;
}
static void voice_end(int id) {
  ANode *n = &au_N[id];
  if (n->vstate != 1) return;
  while (n->nout) unlink_edge(id, n->out[0]);
  buf_unref(n->buf); n->buf = -1; n->vstate = 2;
  if (n->notify && au_nended < (int)(sizeof au_ended / sizeof au_ended[0])) au_ended[au_nended++] = id;
}

// ---- mixing ----
static int voice_mix(int id, float *aL, float *aR, int n, int64_t F0, double t0) {
  ANode *nd = &au_N[id];
  if (nd->vstate != 1) return 0;
  ABuf *b = &au_B[nd->buf];
  int i0 = 0, iend = n, stopped = 0;
  if (nd->stopF >= 0 && nd->stopF < F0 + n && nd->stopF <= nd->startF) { voice_end(id); return 0; }   // stopped before it began
  if (nd->startF >= F0 + n) return b->nch;
  if (nd->startF > F0) i0 = (int)(nd->startF - F0);
  if (nd->stopF >= 0 && nd->stopF < F0 + n) { int64_t s = nd->stopF - F0; iend = s < i0 ? i0 : (int)s; stopped = 1; }
  double rate = ap_eval(&nd->p[1], t0); if (rate < 0) rate = 0;
  double step = rate * b->sr / au_rate, pos = nd->pos;
  int64_t len = b->n, ls = nd->ls, le = nd->le, lim = nd->endPos >= 0 && nd->endPos < len ? nd->endPos : len;
  int loop = nd->loop && le > ls; int ended = 0; const int16_t *d = b->d; const float k = 1.0f / 32768.0f; int st = b->nch == 2;
  for (int i = i0; i < iend; i++) {
    if (loop) { if (pos >= le) { double ll = (double)(le - ls); pos -= ll * floor((pos - ls) / ll); } }
    else if (pos >= lim) { ended = 1; break; }
    int64_t ip = (int64_t)pos; double fr = pos - ip;
    float l, r;
    if (fr == 0) { if (st) { l = d[2 * ip]; r = d[2 * ip + 1]; } else l = r = d[ip]; }
    else {
      int64_t i1 = ip + 1;
      if (loop && i1 >= le) i1 = ls + (i1 - le); else if (i1 >= len) i1 = ip;
      float f = (float)fr;
      if (st) { l = d[2 * ip] + (d[2 * i1] - d[2 * ip]) * f; r = d[2 * ip + 1] + (d[2 * i1 + 1] - d[2 * ip + 1]) * f; }
      else l = r = d[ip] + (d[i1] - d[ip]) * f;
    }
    aL[i] += l * k; aR[i] += r * k;
    pos += step;
  }
  nd->pos = pos;
  if (!loop && !ended && pos >= lim && step > 0) ended = 1;
  if (ended || stopped) voice_end(id);
  return b->nch;
}
static int render_into(int id, float *aL, float *aR, int n, int64_t F0, double t0, int depth) {
  ANode *nd = &au_N[id];
  if (!nd->used || depth >= AU_DEPTH) return 0;
  if (nd->type == 2) return voice_mix(id, aL, aR, n, F0, t0);
  if (nd->type == 3) { int ch = 0; for (int i = nd->nin - 1; i >= 0; i--) {   // backwards: an ending voice unlinks itself from this list
    if (i >= nd->nin) continue; int c = render_into(nd->in[i], aL, aR, n, F0, t0, depth + 1); if (c > ch) ch = c; } return ch; }
  if (nd->nin == 0) return 0;
  float *tL = au_sc[depth][0], *tR = au_sc[depth][1];
  memset(tL, 0, n * sizeof(float)); memset(tR, 0, n * sizeof(float));
  int ch = 0;
  for (int i = nd->nin - 1; i >= 0; i--) { if (i >= nd->nin) continue; int c = render_into(nd->in[i], tL, tR, n, F0, t0, depth + 1); if (c > ch) ch = c; }
  if (!ch) return 0;
  if (nd->type == 1) {   // panner (equal power, like Chrome's azimuth based panner)
    if (ch == 1) { float gl = (float)nd->pgm[0], gr = (float)nd->pgm[1]; for (int i = 0; i < n; i++) { aL[i] += tL[i] * gl; aR[i] += tL[i] * gr; } }
    else { float gl = (float)nd->pgs[0], gr = (float)nd->pgs[1];
      if (nd->pneg) for (int i = 0; i < n; i++) { aL[i] += tL[i] + tR[i] * gl; aR[i] += tR[i] * gr; }
      else for (int i = 0; i < n; i++) { aL[i] += tL[i] * gl; aR[i] += tR[i] + tL[i] * gr; } }
    return 2;
  }
  AParam *g = &nd->p[0];
  if (g->n == 0) { float v = (float)g->v; for (int i = 0; i < n; i++) { aL[i] += tL[i] * v; aR[i] += tR[i] * v; } }
  else {
    double inv = 1.0 / au_rate;
    for (int i = 0; i < n; i++) { float v = (float)ap_eval(g, (F0 + i) * inv); aL[i] += tL[i] * v; aR[i] += tR[i] * v; }
    ap_prune(g, (F0 + n) * inv);
  }
  return ch;
}
static void au_mix_block(float *out, int n) {   // n <= AU_MAXB; out interleaved stereo (pre master volume)
  int64_t F0 = au_frames; double t0 = (double)F0 / au_rate;
  memset(au_accL, 0, n * sizeof(float)); memset(au_accR, 0, n * sizeof(float));
  render_into(0, au_accL, au_accR, n, F0, t0, 0);
  for (int i = 0; i < n; i++) { out[2 * i] = au_accL[i]; out[2 * i + 1] = au_accR[i]; }
  for (int s = 1; s < au_nN; s++) if (au_N[s].used && au_N[s].type == 2 && au_N[s].p[1].n) ap_prune(&au_N[s].p[1], (double)(F0 + n) / au_rate);
  __atomic_store_n(&au_frames, F0 + n, __ATOMIC_RELEASE);
}
static void SDLCALL au_cb(void *ud, Uint8 *stream, int len) {
  struct timespec a, b; clock_gettime(CLOCK_MONOTONIC, &a);
  float *o = (float *)stream; int frames = len / 8;
  AU_LOCK();
  while (frames > 0) {
    int n = frames < AU_MAXB ? frames : AU_MAXB;
    au_mix_block(o, n);
    if (au_cap) {
      if (au_capN + n * 2 > au_capCap) { au_capCap = au_capCap * 2 + n * 2; au_cap = realloc(au_cap, au_capCap * sizeof(float)); }
      if (au_cap) { memcpy(au_cap + au_capN, o, n * 2 * sizeof(float)); au_capN += n * 2; }
    }
    for (int i = 0; i < n * 2; i++) { float v = o[i]; au_sumsq += (double)v * v; if (fabsf(v) > au_peak) au_peak = fabsf(v); v *= (float)au_vol; o[i] = v > 1 ? 1 : v < -1 ? -1 : v; }
    au_msamp += n * 2;
    o += n * 2; frames -= n;
  }
  AU_UNLOCK();
  clock_gettime(CLOCK_MONOTONIC, &b);
  double ns = (b.tv_sec - a.tv_sec) * 1e9 + (b.tv_nsec - a.tv_nsec);
  au_cbNs += ns; if (ns > au_cbMax) au_cbMax = ns; au_cbCount++;
  if (ns > 0.5 * 1e9 * (len / 8) / au_rate) au_cbOver++;   // more than half of the block time spent mixing
}

// ---- WAV dump of the mixed output (float32 stereo, before the master volume knob) ----
static void au_write_dump(void) {
  if (!au_dumpPath[0] || !au_cap) return;
  FILE *f = fopen(au_dumpPath, "wb"); if (!f) return;
  uint32_t dl = (uint32_t)(au_capN * 4), v32; uint16_t v16;
  fwrite("RIFF", 1, 4, f); v32 = 36 + dl; fwrite(&v32, 4, 1, f); fwrite("WAVEfmt ", 1, 8, f);
  v32 = 16; fwrite(&v32, 4, 1, f); v16 = 3; fwrite(&v16, 2, 1, f); v16 = 2; fwrite(&v16, 2, 1, f);
  v32 = au_rate; fwrite(&v32, 4, 1, f); v32 = au_rate * 8; fwrite(&v32, 4, 1, f); v16 = 8; fwrite(&v16, 2, 1, f); v16 = 32; fwrite(&v16, 2, 1, f);
  fwrite("data", 1, 4, f); fwrite(&dl, 4, 1, f); fwrite(au_cap, 4, au_capN, f); fclose(f);
}
static void au_close(void) {
  if (au_dev) { SDL_CloseAudioDevice(au_dev); au_dev = 0; }
  au_write_dump();
  if (au_inited_sub) { SDL_QuitSubSystem(SDL_INIT_AUDIO); au_inited_sub = 0; }
}

// auInit(volume, dumpPath, wantRate, wantFrames) -> { rate, frames, driver, device, ok }
DEFR(auInit, 4,
  napi_value o; napi_create_object(env, &o);
  if (!au_mx) au_mx = SDL_CreateMutex();
  if (!au_N) { au_cN = 64; au_N = calloc(au_cN, sizeof(ANode)); au_nN = 1; au_N[0].used = 1; au_N[0].type = 3; }
  au_vol = D(0); if (!(au_vol >= 0)) au_vol = 1;
  char *dp = a_[1] ? arg_utf8(env, a_[1]) : NULL;
  if (dp && dp[0]) { snprintf(au_dumpPath, sizeof au_dumpPath, "%s", dp); au_capCap = 1 << 20; au_cap = malloc(au_capCap * sizeof(float)); au_capN = 0; }
  free(dp);
  int want = (int)D(2); if (want < 8000) want = 44100;
  int blk = (int)D(3); if (blk < 64) blk = 512;
  if (SDL_InitSubSystem(SDL_INIT_AUDIO) != 0) { set_str(env, o, "error", SDL_GetError()); set_int(env, o, "ok", 0); return o; }
  au_inited_sub = 1;
  SDL_AudioSpec w, h; SDL_zero(w); w.freq = want; w.format = AUDIO_F32SYS; w.channels = 2; w.samples = blk; w.callback = au_cb;
  au_dev = SDL_OpenAudioDevice(NULL, 0, &w, &h, SDL_AUDIO_ALLOW_FREQUENCY_CHANGE | SDL_AUDIO_ALLOW_SAMPLES_CHANGE);
  if (!au_dev) { set_str(env, o, "error", SDL_GetError()); set_int(env, o, "ok", 0); set_int(env, o, "rate", want); return o; }
  au_rate = h.freq; au_blk = h.samples;
  SDL_PauseAudioDevice(au_dev, 0);
  set_int(env, o, "ok", 1); set_int(env, o, "rate", au_rate); set_int(env, o, "frames", au_blk); set_int(env, o, "channels", h.channels); set_int(env, o, "format", h.format); set_int(env, o, "wantRate", want);
  set_str(env, o, "driver", SDL_GetCurrentAudioDriver()); set_str(env, o, "device", SDL_GetAudioDeviceName(0, 0));
  return o;)
DEF(auClose, 0, au_close())
DEFR(auTime, 0, return ret_d(env, (double)__atomic_load_n(&au_frames, __ATOMIC_ACQUIRE) / au_rate);)
// auStats(reset) -> mixer timing + meter (rms/peak of the pre-volume output since the last reset)
DEFR(auStats, 1,
  napi_value o; napi_create_object(env, &o);
  AU_LOCK();
  set_int(env, o, "callbacks", (double)au_cbCount); set_int(env, o, "avgUs", au_cbCount ? au_cbNs / au_cbCount / 1000 : 0); set_int(env, o, "maxUs", au_cbMax / 1000);
  set_int(env, o, "over50pct", (double)au_cbOver); set_int(env, o, "frames", (double)au_frames);
  set_int(env, o, "blockUs", au_rate ? 1e6 * au_blk / au_rate : 0);
  set_int(env, o, "rms", au_msamp ? sqrt(au_sumsq / au_msamp) : 0); set_int(env, o, "peak", au_peak);
  set_int(env, o, "capFrames", (double)(au_capN / 2));
  int nb = 0; double bytes = 0; for (int i = 0; i < au_nB; i++) if (au_B[i].used) { nb++; bytes += (double)au_B[i].n * au_B[i].nch * 2; }
  int nn = 0; for (int i = 1; i < au_nN; i++) if (au_N[i].used) nn++;
  set_int(env, o, "buffers", nb); set_int(env, o, "bufferBytes", bytes); set_int(env, o, "nodes", nn);
  if (D(0) != 0) { au_cbNs = au_cbMax = 0; au_cbCount = au_cbOver = 0; au_sumsq = au_peak = 0; au_msamp = 0; }
  AU_UNLOCK();
  return o;)
// auCaptureRead(startFrame, nFrames) -> Float32Array interleaved stereo (only with PMZ_AUDIO_DUMP)
DEFR(auCaptureRead, 2,
  int64_t s = (int64_t)D(0), n = (int64_t)D(1);
  AU_LOCK();
  if (!au_cap || s < 0) { AU_UNLOCK(); return ret_null(env); }
  if (s * 2 > au_capN) s = au_capN / 2;
  if ((s + n) * 2 > au_capN) n = au_capN / 2 - s;
  napi_value ab, ta; void *p; napi_create_arraybuffer(env, n * 8, &p, &ab);
  memcpy(p, au_cap + s * 2, n * 8);
  AU_UNLOCK();
  napi_create_typedarray(env, napi_float32_array, n * 2, ab, 0, &ta);
  return ta;)

// ---- buffers ----
static int buf_new(int16_t *d, int nch, int64_t n, int sr) {   // takes ownership of d; caller holds no lock
  AU_LOCK();
  int id = -1;
  for (int i = 0; i < au_nB; i++) if (!au_B[i].used) { id = i; break; }
  if (id < 0) { if (au_nB >= au_cB) { au_cB = au_cB ? au_cB * 2 : 64; au_B = realloc(au_B, au_cB * sizeof(ABuf)); } id = au_nB++; }
  au_B[id].d = d; au_B[id].nch = nch; au_B[id].n = n; au_B[id].sr = sr; au_B[id].refs = 1; au_B[id].used = 1;
  AU_UNLOCK();
  return id;
}
DEFR(auBufCreate, 3,
  int nch = (int)D(0); int64_t n = (int64_t)D(1); int sr = (int)D(2);
  if (nch < 1) nch = 1; if (nch > 2) nch = 2; if (n < 1) n = 1;
  int16_t *d = calloc((size_t)n * nch, 2); if (!d) { napi_throw_error(env, NULL, "auBufCreate: out of memory"); return NULL; }
  int id = buf_new(d, nch, n, sr);
  { int64_t adj_; napi_adjust_external_memory(env, (int64_t)n * nch * 2, &adj_); };
  return ret_d(env, id);)
DEF(auBufWrite, 4,   // (id, channel, Float32Array, startFrame)
  void *p; size_t len; int id = (int)D(0), ch = (int)D(1); int64_t st = (int64_t)D(3);
  if (argbytes(env, a_[2], &p, &len) && id >= 0 && id < au_nB && au_B[id].used) {
    ABuf *b = &au_B[id]; const float *src = p; int64_t cnt = len / 4;
    if (ch >= 0 && ch < b->nch && st >= 0) { if (st + cnt > b->n) cnt = b->n - st;
      for (int64_t i = 0; i < cnt; i++) { float v = src[i] * 32768.0f; b->d[(st + i) * b->nch + ch] = v >= 32767 ? 32767 : v <= -32768 ? -32768 : (int16_t)lrintf(v); } }
  })
DEFR(auBufRead, 4,   // (id, channel, start, count) -> Float32Array
  int id = (int)D(0), ch = (int)D(1); int64_t st = (int64_t)D(2), cnt = (int64_t)D(3);
  if (id < 0 || id >= au_nB || !au_B[id].used) return ret_null(env);
  ABuf *b = &au_B[id]; if (ch < 0 || ch >= b->nch) ch = 0; if (st < 0) st = 0; if (st > b->n) st = b->n; if (st + cnt > b->n) cnt = b->n - st;
  napi_value ab, ta; float *p; napi_create_arraybuffer(env, cnt * 4, (void **)&p, &ab);
  for (int64_t i = 0; i < cnt; i++) p[i] = b->d[(st + i) * b->nch + ch] / 32768.0f;
  napi_create_typedarray(env, napi_float32_array, cnt, ab, 0, &ta);
  return ta;)
DEF(auBufFree, 1,
  int id = (int)D(0);
  AU_LOCK();
  if (id >= 0 && id < au_nB && au_B[id].used) { int64_t by = au_B[id].n * au_B[id].nch * 2; buf_unref(id); { int64_t adj_; napi_adjust_external_memory(env, -by, &adj_); }; }
  AU_UNLOCK();)

// ---- Ogg Vorbis decode on a worker thread ----
typedef struct { const uint8_t *p; size_t n, pos; } AMemR;
static size_t am_read(void *ptr, size_t sz, size_t nm, void *ds) { AMemR *m = ds; size_t want = sz * nm, have = m->n - m->pos; if (want > have) want = have; memcpy(ptr, m->p + m->pos, want); m->pos += want; return sz ? want / sz : 0; }
static int am_seek(void *ds, ogg_int64_t off, int wh) { AMemR *m = ds; int64_t np = wh == SEEK_SET ? off : wh == SEEK_CUR ? (int64_t)m->pos + off : (int64_t)m->n + off; if (np < 0 || np > (int64_t)m->n) return -1; m->pos = np; return 0; }
static int am_close(void *ds) { return 0; }
static long am_tell(void *ds) { return (long)((AMemR *)ds)->pos; }
typedef struct { napi_async_work work; napi_deferred def; uint8_t *src; size_t len; int16_t *pcm; int64_t frames; int nch, sr; char err[128]; } ADec;
static void adec_exec(napi_env env, void *data) {
  ADec *d = data; AMemR m = { d->src, d->len, 0 };
  ov_callbacks cb = { am_read, am_seek, am_close, am_tell }; OggVorbis_File vf;
  if (ov_open_callbacks(&m, &vf, NULL, 0, cb) < 0) { snprintf(d->err, sizeof d->err, "not an Ogg Vorbis stream"); return; }
  vorbis_info *vi = ov_info(&vf, -1); int nch = vi->channels, sr = (int)vi->rate;
  ogg_int64_t tot = ov_pcm_total(&vf, -1); int64_t cap = tot > 0 ? tot : 65536;
  int oc = nch > 2 ? 2 : nch; int16_t *pcm = malloc((size_t)cap * oc * 2);
  int64_t n = 0; int bs = 0;
  if (!pcm) { snprintf(d->err, sizeof d->err, "out of memory"); ov_clear(&vf); return; }
  for (;;) {
    float **pp; long got = ov_read_float(&vf, &pp, 4096, &bs);
    if (got == OV_HOLE) continue;
    if (got <= 0) break;
    if (n + got > cap) { cap = (n + got) * 2; int16_t *q = realloc(pcm, (size_t)cap * oc * 2); if (!q) { snprintf(d->err, sizeof d->err, "out of memory"); free(pcm); ov_clear(&vf); return; } pcm = q; }
    for (int c = 0; c < oc; c++) { const float *s = pp[c]; int16_t *o = pcm + n * oc + c;
      for (long i = 0; i < got; i++) { float v = s[i] * 32768.0f; o[i * oc] = v >= 32767 ? 32767 : v <= -32768 ? -32768 : (int16_t)lrintf(v); } }
    n += got;
  }
  ov_clear(&vf);
  if (n < 1) { free(pcm); snprintf(d->err, sizeof d->err, "empty stream"); return; }
  d->pcm = pcm; d->frames = n; d->nch = oc; d->sr = sr;
}
static void adec_done(napi_env env, napi_status st, void *data) {
  ADec *d = data; napi_value v;
  if (d->pcm) {
    int id = buf_new(d->pcm, d->nch, d->frames, d->sr);
    { int64_t adj_; napi_adjust_external_memory(env, d->frames * d->nch * 2, &adj_); };
    napi_create_object(env, &v); set_int(env, v, "id", id); set_int(env, v, "sampleRate", d->sr); set_int(env, v, "length", (double)d->frames); set_int(env, v, "numberOfChannels", d->nch);
    napi_resolve_deferred(env, d->def, v);
  } else {
    napi_value msg, err; napi_create_string_utf8(env, d->err[0] ? d->err : "decode failed", NAPI_AUTO_LENGTH, &msg); napi_create_error(env, NULL, msg, &err);
    napi_reject_deferred(env, d->def, err);
  }
  napi_delete_async_work(env, d->work); free(d->src); free(d);
}
DEFR(auDecode, 1,   // (ArrayBuffer | typed array) -> Promise<{id, sampleRate, length, numberOfChannels}>
  void *p; size_t len; napi_value promise; ADec *d = calloc(1, sizeof *d);
  napi_create_promise(env, &d->def, &promise);
  if (!argbytes(env, a_[0], &p, &len) || !len) { napi_value msg, err; napi_create_string_utf8(env, "decodeAudioData: no data", NAPI_AUTO_LENGTH, &msg); napi_create_error(env, NULL, msg, &err); napi_reject_deferred(env, d->def, err); free(d); return promise; }
  d->src = malloc(len); memcpy(d->src, p, len); d->len = len;
  napi_value nm; napi_create_string_utf8(env, "pmzDecode", NAPI_AUTO_LENGTH, &nm);
  napi_create_async_work(env, NULL, nm, adec_exec, adec_done, d, &d->work); napi_queue_async_work(env, d->work);
  return promise;)

// ---- graph commands ----
DEFR(auNode, 1, int id; AU_LOCK(); id = node_alloc((int)D(0)); AU_UNLOCK(); return ret_d(env, id);)
DEF(auFree, 1, int id = (int)D(0); AU_LOCK(); if (id > 0 && id < au_nN && au_N[id].used) { node_release(id); free(au_N[id].in); au_N[id].in = NULL; au_N[id].cin = 0; au_N[id].used = 0; } AU_UNLOCK();)
DEF(auConnect, 2, AU_LOCK(); link_edge((int)D(0), (int)D(1)); AU_UNLOCK();)
DEF(auDisconnect, 2, int s = (int)D(0), t = (int)D(1); AU_LOCK(); if (s > 0 && s < au_nN && au_N[s].used) { if (t < 0) { while (au_N[s].nout) unlink_edge(s, au_N[s].out[0]); } else unlink_edge(s, t); } AU_UNLOCK();)
DEF(auParam, 6,   // (node, which, op, value, time, timeConstant)
  int id = (int)D(0), w = (int)D(1) ? 1 : 0;
  AU_LOCK(); if (id > 0 && id < au_nN && au_N[id].used) ap_op(&au_N[id].p[w], (int)D(2), D(3), D(4), D(5), (double)au_frames / au_rate); AU_UNLOCK();)
DEF(auPan, 4,   // setPosition(x, y, z): azimuth of the source relative to a listener at the origin looking down -z
  int id = (int)D(0);
  AU_LOCK();
  if (id > 0 && id < au_nN && au_N[id].used) {
    ANode *n = &au_N[id]; double x = D(1), z = D(3);
    double az = atan2(x, fabs(z)) * 180.0 / M_PI;   // [-90, 90] (sources behind fold to the front, like Chrome)
    double pp = (az + 90) / 180; n->pgm[0] = cos(pp * M_PI / 2); n->pgm[1] = sin(pp * M_PI / 2);
    n->pneg = az <= 0; double p2 = n->pneg ? (az + 90) / 90 : az / 90; n->pgs[0] = cos(p2 * M_PI / 2); n->pgs[1] = sin(p2 * M_PI / 2);
  }
  AU_UNLOCK();)
// auStart(node, buffer, when, offset, duration(-1 none), loop, loopStart, loopEnd): times in seconds (buffer time for offsets/loop points)
DEFR(auStart, 8,
  int id = (int)D(0), bi = (int)D(1), ok = 0;
  AU_LOCK();
  if (id > 0 && id < au_nN && au_N[id].used && au_N[id].type == 2 && au_N[id].vstate == 0 && bi >= 0 && bi < au_nB && au_B[bi].used) {
    ANode *n = &au_N[id]; ABuf *b = &au_B[bi]; b->refs++;
    n->buf = bi; n->vstate = 1; n->notify = 1;
    double when = D(2), off = D(3), dur = D(4);
    n->startF = when > 0 ? llround(when * au_rate) : 0; n->stopF = -1;
    n->pos = off > 0 ? off * b->sr : 0; n->endPos = dur >= 0 ? (int64_t)llround((off > 0 ? off : 0) * b->sr + dur * b->sr) : -1;
    n->loop = D(5) != 0; n->ls = llround(D(6) * b->sr); n->le = llround(D(7) * b->sr);
    if (n->ls < 0) n->ls = 0; if (n->le > b->n) n->le = b->n; if (n->le <= n->ls) { n->ls = 0; n->le = b->n; }
    if (n->loop && n->pos >= n->le) n->pos = n->ls + fmod(n->pos - n->ls, (double)(n->le - n->ls));
    ok = 1;
  }
  AU_UNLOCK();
  return ret_b(env, ok);)
DEF(auSrcLoop, 4,   // (node, loop, loopStart, loopEnd) after start
  int id = (int)D(0);
  AU_LOCK();
  if (id > 0 && id < au_nN && au_N[id].used && au_N[id].type == 2 && au_N[id].vstate == 1) {
    ANode *n = &au_N[id]; ABuf *b = &au_B[n->buf];
    n->loop = D(1) != 0; n->ls = llround(D(2) * b->sr); n->le = llround(D(3) * b->sr);
    if (n->ls < 0) n->ls = 0; if (n->le > b->n) n->le = b->n; if (n->le <= n->ls) { n->ls = 0; n->le = b->n; }
  }
  AU_UNLOCK();)
DEF(auStop, 2,
  int id = (int)D(0); double when = D(1);
  AU_LOCK();
  if (id > 0 && id < au_nN && au_N[id].used && au_N[id].type == 2 && au_N[id].vstate == 1) {
    au_N[id].stopF = when > 0 ? llround(when * au_rate) : 0;
    if (!au_dev) voice_end(id);   // nothing renders without a device
  }
  AU_UNLOCK();)
DEFR(auEnded, 0,   // ids of sources that finished since the last call (null if none)
  if (!au_mx || !au_nended) return ret_null(env);   // unlocked peek: the common case costs nothing and never waits for the mixer
  if (SDL_TryLockMutex(au_mx) != 0) return ret_null(env);   // mixer busy: try again next frame
  int n = au_nended; int tmp[512]; memcpy(tmp, au_ended, n * sizeof(int)); au_nended = 0; AU_UNLOCK();
  if (!n) return ret_null(env);
  napi_value a; napi_create_array_with_length(env, n, &a);
  for (int i = 0; i < n; i++) napi_set_element(env, a, i, ret_d(env, tmp[i]));
  return a;)
