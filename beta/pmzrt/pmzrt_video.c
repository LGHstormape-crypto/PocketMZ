// pmzrt_video.c - Native <video> playback (FFmpeg decode thread + lock-free audio ring + GLES2 fullscreen & texture upload).
// Included by pmzrt.c after pmzrt_audio.c. Uses only GLES 2.0 calls (via pmzrt_gl.h) so it works on Panfrost, closed libmali, and ES 2.0.
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libswscale/swscale.h>
#include <libswresample/swresample.h>
#include <libavutil/imgutils.h>
#include <libavutil/channel_layout.h>
#include <libavutil/opt.h>

#define VID_MAX 8
#define VID_ARING 65536   // stereo int16 frames (~1.48 s at 44100 Hz, power of 2 for fast masking)
#define VID_AMASK (VID_ARING - 1)

typedef struct { const uint8_t *p; size_t n, pos; } VMemR;
static int vmem_read(void *op, uint8_t *buf, int sz) {
  VMemR *m = (VMemR *)op;
  if (m->pos >= m->n) return AVERROR_EOF;
  size_t avail = m->n - m->pos;
  int take = (size_t)sz < avail ? sz : (int)avail;
  memcpy(buf, m->p + m->pos, take);
  m->pos += take;
  return take;
}
static int64_t vmem_seek(void *op, int64_t off, int wh) {
  VMemR *m = (VMemR *)op;
  if (wh == AVSEEK_SIZE) return (int64_t)m->n;
  int64_t np = wh == SEEK_SET ? off : wh == SEEK_CUR ? (int64_t)m->pos + off : (int64_t)m->n + off;
  if (np < 0 || np > (int64_t)m->n) return -1;
  m->pos = (size_t)np;
  return np;
}

typedef struct {
  int used;
  int id;
  char path[1024];
  uint8_t *memBuf; size_t memLen; VMemR memR;
  AVIOContext *avio;
  AVFormatContext *fmt;
  AVCodecContext *vcc, *acc;
  struct SwsContext *sws;
  struct SwrContext *swr;
  int vidx, aidx;
  double vtb, atb, duration;
  int srcW, srcH, outW, outH;
  int hasAudio;
  int arate;

  SDL_Thread *th;
  SDL_mutex *mx;
  uint8_t *rgba[2];   // [frontIdx] = readable by GL/JS, [1-frontIdx] = written by decode thread
  int frontIdx;
  volatile uint32_t frameSeq;
  uint32_t texSeq;
  GLuint tex;

  int16_t *aring;     // interleaved stereo S16 ring buffer (VID_ARING * 2 int16s)
  uint64_t arPos, awPos;
  double audioBasePts;
  int audioBaseSet;

  volatile int ready, playing, paused, ended, loop, muted, closing;
  volatile double vol;
  volatile double curTime;
  volatile double seekReq;   // < 0 = none
  double wallBase;
  double wallPts;
  char err[256];
} PmzVid;

static PmzVid g_vids[VID_MAX];
static int g_vidSeq = 1;
static GLuint g_vidProg, g_vidVbo, g_vidVao;
static GLint g_vidUTex = -1;

static double vid_now_sec(void) {
  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec + (double)ts.tv_nsec * 1e-9;
}

static void vid_ring_clear(PmzVid *v) {
  __atomic_store_n(&v->arPos, 0, __ATOMIC_RELEASE);
  __atomic_store_n(&v->awPos, 0, __ATOMIC_RELEASE);
  v->audioBaseSet = 0;
}

// Called from pmzrt_audio.c au_mix_block (wait-free SPSC consumer).
static void vid_mix_audio(float *aL, float *aR, int n, int rate) {
  (void)rate;
  for (int k = 0; k < VID_MAX; k++) {
    PmzVid *v = &g_vids[k];
    if (!v->used || !v->hasAudio || !v->aring || !__atomic_load_n(&v->playing, __ATOMIC_ACQUIRE)) continue;
    uint64_t r = __atomic_load_n(&v->arPos, __ATOMIC_RELAXED);
    uint64_t w = __atomic_load_n(&v->awPos, __ATOMIC_ACQUIRE);
    uint64_t avail = w > r ? w - r : 0;
    int take = (int)(avail < (uint64_t)n ? avail : (uint64_t)n);
    if (take <= 0) continue;
    float g = __atomic_load_n(&v->muted, __ATOMIC_RELAXED) ? 0.0f : (float)v->vol * (1.0f / 32768.0f);
    if (g > 0.0f) {
      for (int i = 0; i < take; i++) {
        uint32_t idx = (uint32_t)((r + i) & VID_AMASK) * 2;
        aL[i] += v->aring[idx] * g;
        aR[i] += v->aring[idx + 1] * g;
      }
    }
    __atomic_store_n(&v->arPos, r + take, __ATOMIC_RELEASE);
  }
}

static double vid_clock(PmzVid *v) {
  if (au_dev && v->hasAudio && v->audioBaseSet) {
    uint64_t played = __atomic_load_n(&v->arPos, __ATOMIC_ACQUIRE);
    uint64_t written = __atomic_load_n(&v->awPos, __ATOMIC_ACQUIRE);
    double aclk = v->audioBasePts + (double)played / (double)(v->arate > 0 ? v->arate : 44100);
    if (played < written) {
      v->wallPts = aclk;
      v->wallBase = vid_now_sec();
      return aclk;
    }
    // Audio ring drained (audio ended before video, EOF video flush, or gap): continue on monotonic wall clock.
  }
  if (!v->playing) return v->wallPts;
  return v->wallPts + (vid_now_sec() - v->wallBase);
}

static void vid_push_audio(PmzVid *v, const int16_t *pcm, int frames, double pts) {
  if (!au_dev || !v->aring || frames <= 0) return;
  if (!v->audioBaseSet) {
    v->audioBasePts = pts >= 0 ? pts : 0.0;
    v->wallPts = v->audioBasePts;
    v->wallBase = vid_now_sec();
    v->audioBaseSet = 1;
  }
  int off = 0;
  while (off < frames && !v->closing && v->seekReq < 0) {
    uint64_t r = __atomic_load_n(&v->arPos, __ATOMIC_ACQUIRE);
    uint64_t w = __atomic_load_n(&v->awPos, __ATOMIC_RELAXED);
    uint64_t freeF = (uint64_t)VID_ARING - (w - r);
    if (freeF < 64) {
      if (!v->ready && !__atomic_load_n(&v->playing, __ATOMIC_ACQUIRE)) break;
      SDL_Delay(5);
      continue;
    }
    int put = frames - off;
    if ((uint64_t)put > freeF) put = (int)freeF;
    for (int i = 0; i < put; i++) {
      uint32_t idx = (uint32_t)((w + i) & VID_AMASK) * 2;
      v->aring[idx] = pcm[(off + i) * 2];
      v->aring[idx + 1] = pcm[(off + i) * 2 + 1];
    }
    __atomic_store_n(&v->awPos, w + put, __ATOMIC_RELEASE);
    off += put;
  }
}

static void vid_publish_frame(PmzVid *v, AVFrame *vf, double pts, int isFirst) {
  int back = 1 - v->frontIdx;
  uint8_t *dst[4] = { v->rgba[back], NULL, NULL, NULL };
  int stride[4] = { v->outW * 4, 0, 0, 0 };
  sws_scale(v->sws, (const uint8_t *const *)vf->data, vf->linesize, 0, v->srcH, dst, stride);

  if (!isFirst && v->playing && pts >= 0) {
    double waitStart = vid_now_sec();
    for (;;) {
      if (v->closing || v->seekReq >= 0) return;
      if (!v->playing) { waitStart = vid_now_sec(); SDL_Delay(8); continue; }
      double clk = vid_clock(v);
      double diff = pts - clk;
      if (diff <= 0.004) break;
      if (diff > 2.0) break;   // guard against huge PTS jump
      if (vid_now_sec() - waitStart > 2.5) break;   // safety ceiling: never stall indefinitely
      SDL_Delay(diff > 0.015 ? 8 : 3);
    }
  }
  SDL_LockMutex(v->mx);
  v->frontIdx = back;
  if (pts >= 0) v->curTime = pts;
  __atomic_add_fetch(&v->frameSeq, 1, __ATOMIC_RELEASE);
  SDL_UnlockMutex(v->mx);
}

static int SDLCALL vid_thread(void *ud) {
  PmzVid *v = (PmzVid *)ud;
  AVPacket *pkt = av_packet_alloc();
  AVFrame *vf = av_frame_alloc();
  AVFrame *af = av_frame_alloc();
  int16_t *abuf = NULL; int abufCap = 0;
  int gotFirst = 0;
  int lastPlaying = 0;

  while (!v->closing) {
    // Handle pending seek
    double sq = v->seekReq;
    if (sq >= 0) {
      v->seekReq = -1;
      int64_t ts = (int64_t)(sq * AV_TIME_BASE);
      av_seek_frame(v->fmt, -1, ts, AVSEEK_FLAG_BACKWARD);
      avcodec_flush_buffers(v->vcc);
      if (v->acc) avcodec_flush_buffers(v->acc);
      vid_ring_clear(v);
      v->wallPts = sq; v->wallBase = vid_now_sec();
      v->curTime = sq;
      v->ended = 0;
    }

    int pl = __atomic_load_n(&v->playing, __ATOMIC_ACQUIRE);
    if (pl != lastPlaying) {
      if (pl) { v->wallBase = vid_now_sec(); }
      else { v->wallPts = vid_clock(v); }
      lastPlaying = pl;
    }

    if (gotFirst && (!pl || v->ended)) { SDL_Delay(10); continue; }

    // Throttle demuxing if audio ring already has > 0.6s buffered and no video frame needed immediately
    if (gotFirst && au_dev && v->hasAudio) {
      uint64_t r = __atomic_load_n(&v->arPos, __ATOMIC_ACQUIRE);
      uint64_t w = __atomic_load_n(&v->awPos, __ATOMIC_RELAXED);
      if (w - r > (uint64_t)(v->arate * 3 / 5)) { SDL_Delay(5); continue; }
    }

    int rc = av_read_frame(v->fmt, pkt);
    if (rc < 0) {
      if (rc == AVERROR_EOF) {
        // Flush video decoder
        avcodec_send_packet(v->vcc, NULL);
        while (!v->closing && avcodec_receive_frame(v->vcc, vf) == 0) {
          double pts = vf->best_effort_timestamp != AV_NOPTS_VALUE ? vf->best_effort_timestamp * v->vtb : v->curTime;
          vid_publish_frame(v, vf, pts, !gotFirst);
          gotFirst = 1; v->ready = 1;
        }
        if (v->loop && !v->closing) {
          av_seek_frame(v->fmt, -1, 0, AVSEEK_FLAG_BACKWARD);
          avcodec_flush_buffers(v->vcc);
          if (v->acc) avcodec_flush_buffers(v->acc);
          vid_ring_clear(v);
          v->wallPts = 0; v->wallBase = vid_now_sec();
          v->curTime = 0;
          continue;
        }
        // Drain remaining audio ring buffer before marking ended
        int waitMs = 0;
        while (au_dev && v->hasAudio && !v->closing && v->playing && waitMs < 1500) {
          uint64_t r = __atomic_load_n(&v->arPos, __ATOMIC_ACQUIRE);
          uint64_t w = __atomic_load_n(&v->awPos, __ATOMIC_RELAXED);
          if (w <= r + 128) break;
          SDL_Delay(10); waitMs += 10;
        }
        v->ready = 1;
        __atomic_store_n(&v->playing, 0, __ATOMIC_RELEASE);
        v->ended = 1;
        lastPlaying = 0;
        continue;
      }
      SDL_Delay(10); continue;
    }

    if (pkt->stream_index == v->vidx) {
      if (avcodec_send_packet(v->vcc, pkt) == 0) {
        while (!v->closing && avcodec_receive_frame(v->vcc, vf) == 0) {
          double pts = vf->best_effort_timestamp != AV_NOPTS_VALUE ? vf->best_effort_timestamp * v->vtb : v->curTime;
          if (!gotFirst) {
            v->wallPts = pts >= 0 ? pts : 0; v->wallBase = vid_now_sec();
            vid_publish_frame(v, vf, pts, 1);
            gotFirst = 1; v->ready = 1;
          } else {
            // Drop severely late frames (>150ms behind) to keep A/V sync smooth on heavy videos
            double clk = vid_clock(v);
            if (v->playing && pts >= 0 && pts < clk - 0.15) continue;
            vid_publish_frame(v, vf, pts, 0);
          }
        }
      }
    } else if (pkt->stream_index == v->aidx && v->acc && v->swr) {
      if (avcodec_send_packet(v->acc, pkt) == 0) {
        while (!v->closing && avcodec_receive_frame(v->acc, af) == 0) {
          int outN = (int)av_rescale_rnd(swr_get_delay(v->swr, v->acc->sample_rate) + af->nb_samples, v->arate, v->acc->sample_rate, AV_ROUND_UP);
          if (outN > abufCap) { abufCap = outN + 1024; abuf = realloc(abuf, (size_t)abufCap * 4); }
          if (!abuf) break;
          uint8_t *outP[1] = { (uint8_t *)abuf };
          int got = swr_convert(v->swr, outP, outN, (const uint8_t **)af->extended_data, af->nb_samples);
          if (got > 0) {
            double apts = af->best_effort_timestamp != AV_NOPTS_VALUE ? af->best_effort_timestamp * v->atb : -1.0;
            vid_push_audio(v, abuf, got, apts);
          }
        }
      }
    }
    av_packet_unref(pkt);
  }

  free(abuf);
  av_frame_free(&af); av_frame_free(&vf); av_packet_free(&pkt);
  return 0;
}

static PmzVid *vid_find(int id) {
  if (id <= 0) return NULL;
  for (int i = 0; i < VID_MAX; i++) if (g_vids[i].used && g_vids[i].id == id) return &g_vids[i];
  return NULL;
}

static void vid_free_slot(PmzVid *v) {
  if (!v || !v->used) return;
  __atomic_store_n(&v->playing, 0, __ATOMIC_RELEASE);
  v->closing = 1;
  if (v->th) { SDL_WaitThread(v->th, NULL); v->th = NULL; }
  if (v->tex && glDeleteTextures) { glDeleteTextures(1, &v->tex); v->tex = 0; }
  if (v->sws) sws_freeContext(v->sws);
  if (v->swr) swr_free(&v->swr);
  if (v->vcc) avcodec_free_context(&v->vcc);
  if (v->acc) avcodec_free_context(&v->acc);
  if (v->fmt) avformat_close_input(&v->fmt);
  if (v->avio) { av_freep(&v->avio->buffer); avio_context_free(&v->avio); }
  free(v->memBuf);
  free(v->rgba[0]); free(v->rgba[1]); free(v->aring);
  if (v->mx) SDL_DestroyMutex(v->mx);
  memset(v, 0, sizeof *v);
}

static void vid_close_all(void) {
  for (int i = 0; i < VID_MAX; i++) if (g_vids[i].used) vid_free_slot(&g_vids[i]);
  if (g_vidProg && glDeleteProgram) { glDeleteProgram(g_vidProg); g_vidProg = 0; }
  if (g_vidVbo && glDeleteBuffers) { glDeleteBuffers(1, &g_vidVbo); g_vidVbo = 0; }
  if (g_vidVao && g_has_vao && glDeleteVertexArrays) { glDeleteVertexArrays(1, &g_vidVao); g_vidVao = 0; }
}

// vidOpen(pathOrBuffer, maxW, maxH) -> { id, width, height, duration, hasAudio } | { error }
DEFR(vidOpen, 3,
  av_log_set_level(AV_LOG_ERROR);
  int slot = -1;
  for (int i = 0; i < VID_MAX; i++) if (!g_vids[i].used) { slot = i; break; }
  napi_value o; napi_create_object(env, &o);
  if (slot < 0) { set_str(env, o, "error", "too many open videos"); return o; }
  PmzVid *v = &g_vids[slot];
  memset(v, 0, sizeof *v);
  v->used = 1; v->id = g_vidSeq++; v->vidx = -1; v->aidx = -1; v->vol = 1.0; v->seekReq = -1;
  v->arate = au_rate > 0 ? au_rate : 44100;
  int maxW = I(1), maxH = I(2); if (maxW <= 0) maxW = 640; if (maxH <= 0) maxH = 480;

  void *bp = NULL; size_t blen = 0;
  if (argbytes(env, a_[0], &bp, &blen) && blen > 0) {
    v->memBuf = malloc(blen); if (!v->memBuf) { vid_free_slot(v); set_str(env, o, "error", "oom"); return o; }
    memcpy(v->memBuf, bp, blen); v->memLen = blen;
    v->memR.p = v->memBuf; v->memR.n = blen; v->memR.pos = 0;
    uint8_t *iob = av_malloc(32768);
    v->avio = avio_alloc_context(iob, 32768, 0, &v->memR, vmem_read, NULL, vmem_seek);
    v->fmt = avformat_alloc_context();
    v->fmt->pb = v->avio; v->fmt->flags |= AVFMT_FLAG_CUSTOM_IO;
    if (avformat_open_input(&v->fmt, NULL, NULL, NULL) < 0) { vid_free_slot(v); set_str(env, o, "error", "avformat_open_input(mem) failed"); return o; }
  } else {
    char *ps = arg_utf8(env, a_[0]);
    if (!ps || !ps[0]) { free(ps); vid_free_slot(v); set_str(env, o, "error", "empty video path"); return o; }
    snprintf(v->path, sizeof v->path, "%s", ps); free(ps);
    if (avformat_open_input(&v->fmt, v->path, NULL, NULL) < 0) { vid_free_slot(v); set_str(env, o, "error", "avformat_open_input failed"); return o; }
  }

  if (avformat_find_stream_info(v->fmt, NULL) < 0) { vid_free_slot(v); set_str(env, o, "error", "find_stream_info failed"); return o; }
  const AVCodec *vc = NULL, *ac = NULL;
  v->vidx = av_find_best_stream(v->fmt, AVMEDIA_TYPE_VIDEO, -1, -1, &vc, 0);
  if (v->vidx < 0 || !vc) { vid_free_slot(v); set_str(env, o, "error", "no video stream"); return o; }
  v->vcc = avcodec_alloc_context3(vc);
  avcodec_parameters_to_context(v->vcc, v->fmt->streams[v->vidx]->codecpar);
  v->vcc->thread_count = 2;
  if (avcodec_open2(v->vcc, vc, NULL) < 0) { vid_free_slot(v); set_str(env, o, "error", "video codec open failed"); return o; }
  v->vtb = av_q2d(v->fmt->streams[v->vidx]->time_base);
  v->srcW = v->vcc->width; v->srcH = v->vcc->height;
  if (v->srcW <= 0 || v->srcH <= 0) { vid_free_slot(v); set_str(env, o, "error", "bad video size"); return o; }
  double sc = 1.0;
  if (v->srcW > maxW) sc = fmin(sc, (double)maxW / v->srcW);
  if (v->srcH > maxH) sc = fmin(sc, (double)maxH / v->srcH);
  v->outW = (int)lround(v->srcW * sc); if (v->outW < 2) v->outW = 2;
  v->outH = (int)lround(v->srcH * sc); if (v->outH < 2) v->outH = 2;
  v->duration = v->fmt->duration != AV_NOPTS_VALUE ? (double)v->fmt->duration / AV_TIME_BASE : 0.0;

  v->sws = sws_getContext(v->srcW, v->srcH, v->vcc->pix_fmt, v->outW, v->outH, AV_PIX_FMT_RGBA, SWS_BILINEAR, NULL, NULL, NULL);
  if (!v->sws) { vid_free_slot(v); set_str(env, o, "error", "sws_getContext failed"); return o; }

  v->aidx = av_find_best_stream(v->fmt, AVMEDIA_TYPE_AUDIO, -1, v->vidx, &ac, 0);
  if (v->aidx >= 0 && ac) {
    v->acc = avcodec_alloc_context3(ac);
    avcodec_parameters_to_context(v->acc, v->fmt->streams[v->aidx]->codecpar);
    if (avcodec_open2(v->acc, ac, NULL) == 0) {
      AVChannelLayout outL; av_channel_layout_default(&outL, 2);
      if (swr_alloc_set_opts2(&v->swr, &outL, AV_SAMPLE_FMT_S16, v->arate, &v->acc->ch_layout, v->acc->sample_fmt, v->acc->sample_rate, 0, NULL) == 0 && swr_init(v->swr) == 0) {
        v->aring = calloc(VID_ARING * 2, sizeof(int16_t));
        v->atb = av_q2d(v->fmt->streams[v->aidx]->time_base);
        v->hasAudio = v->aring != NULL;
      } else { swr_free(&v->swr); avcodec_free_context(&v->acc); v->aidx = -1; }
      av_channel_layout_uninit(&outL);
    } else { avcodec_free_context(&v->acc); v->aidx = -1; }
  }

  size_t fbytes = (size_t)v->outW * v->outH * 4;
  v->rgba[0] = calloc(1, fbytes); v->rgba[1] = calloc(1, fbytes);
  v->mx = SDL_CreateMutex();
  if (!v->rgba[0] || !v->rgba[1] || !v->mx) { vid_free_slot(v); set_str(env, o, "error", "oom"); return o; }

  v->th = SDL_CreateThread(vid_thread, "pmzvid", v);
  if (!v->th) { vid_free_slot(v); set_str(env, o, "error", "thread failed"); return o; }

  set_int(env, o, "id", v->id);
  set_int(env, o, "width", v->srcW); set_int(env, o, "height", v->srcH);
  set_int(env, o, "outWidth", v->outW); set_int(env, o, "outHeight", v->outH);
  set_int(env, o, "duration", v->duration); set_int(env, o, "hasAudio", v->hasAudio);
  return o;)

DEF(vidPlay, 1, PmzVid *v = vid_find(I(0)); if (v) { if (v->ended) v->seekReq = 0; __atomic_store_n(&v->playing, 1, __ATOMIC_RELEASE); })
DEF(vidPause, 1, PmzVid *v = vid_find(I(0)); if (v) __atomic_store_n(&v->playing, 0, __ATOMIC_RELEASE);)
DEF(vidSeek, 2, PmzVid *v = vid_find(I(0)); if (v) { double s = D(1); if (s < 0) s = 0; v->seekReq = s; })
DEF(vidSetVolume, 2, PmzVid *v = vid_find(I(0)); if (v) { double g = D(1); v->vol = g < 0 ? 0 : g > 2 ? 2 : g; })
DEF(vidSetMuted, 2, PmzVid *v = vid_find(I(0)); if (v) __atomic_store_n(&v->muted, B(1) ? 1 : 0, __ATOMIC_RELEASE);)
DEF(vidSetLoop, 2, PmzVid *v = vid_find(I(0)); if (v) v->loop = B(1) ? 1 : 0;)
DEF(vidClose, 1, PmzVid *v = vid_find(I(0)); if (v) vid_free_slot(v);)

DEFR(vidState, 1,
  PmzVid *v = vid_find(I(0));
  if (!v) return ret_null(env);
  napi_value o; napi_create_object(env, &o);
  set_int(env, o, "ready", v->ready);
  set_int(env, o, "playing", __atomic_load_n(&v->playing, __ATOMIC_ACQUIRE));
  set_int(env, o, "ended", v->ended);
  set_int(env, o, "time", v->curTime);
  set_int(env, o, "frameSeq", (double)__atomic_load_n(&v->frameSeq, __ATOMIC_ACQUIRE));
  set_int(env, o, "width", v->srcW); set_int(env, o, "height", v->srcH);
  set_int(env, o, "outWidth", v->outW); set_int(env, o, "outHeight", v->outH);
  return o;)

// vidUploadTex(id, target, level, ifmt, fmt, type, flipY, premul, isSub, xo, yo) -> bool
DEFR(vidUploadTex, 11,
  PmzVid *v = vid_find(I(0));
  if (!v || !v->rgba[0]) return ret_b(env, 0);
  SDL_LockMutex(v->mx);
  const uint8_t *raw = v->rgba[v->frontIdx];
  int w = v->outW, h = v->outH;
  uint8_t *own = NULL;
  GLint prevAlign = 4; glGetIntegerv(GL_UNPACK_ALIGNMENT, &prevAlign);
  if (prevAlign != 1) glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
  int saveAlign = g_unpackAlign; g_unpackAlign = 1;
  const uint8_t *src = prep_pixels(raw, w, h, E(4), E(5), B(6), B(7), &own);
  g_unpackAlign = saveAlign;
  if (B(8)) glTexSubImage2D(E(1), I(2), I(9), I(10), w, h, E(4), E(5), src);
  else glTexImage2D(E(1), I(2), I(3), w, h, 0, E(4), E(5), src);
  free(own);
  if (prevAlign != 1) glPixelStorei(GL_UNPACK_ALIGNMENT, prevAlign);
  SDL_UnlockMutex(v->mx);
  return ret_b(env, 1);)

// vidDrawFullscreen(id, winW, winH): draws the current video frame letterboxed onto the default framebuffer, saving/restoring GL state.
DEF(vidDrawFullscreen, 3,
  PmzVid *v = vid_find(I(0)); int ww = I(1), wh = I(2);
  if (!v || !v->ready || ww <= 0 || wh <= 0) return NULL;

  // Save GL state touched by fullscreen blit
  GLint pProg = 0, pFb = 0, pAb = 0, pAct = 0, pTex = 0, pVp[4] = {0}, pVao = 0, pAlign = 4;
  GLfloat pCc[4] = {0, 0, 0, 0};
  GLboolean pSc = glIsEnabled(GL_SCISSOR_TEST), pBl = glIsEnabled(GL_BLEND), pSt = glIsEnabled(GL_STENCIL_TEST);
  GLboolean pDp = glIsEnabled(GL_DEPTH_TEST), pCu = glIsEnabled(GL_CULL_FACE);
  GLboolean pCm[4] = {1, 1, 1, 1};
  glGetIntegerv(GL_CURRENT_PROGRAM, &pProg);
  glGetIntegerv(GL_FRAMEBUFFER_BINDING, &pFb);
  glGetIntegerv(GL_ARRAY_BUFFER_BINDING, &pAb);
  glGetIntegerv(GL_ACTIVE_TEXTURE, &pAct);
  glGetIntegerv(GL_VIEWPORT, pVp);
  glGetIntegerv(GL_UNPACK_ALIGNMENT, &pAlign);
  glGetBooleanv(GL_COLOR_WRITEMASK, pCm);
  glGetFloatv(GL_COLOR_CLEAR_VALUE, pCc);
  if (g_has_vao) glGetIntegerv(0x85B5, &pVao);

  if (!g_vidProg) {
    const char *vs = "attribute vec2 aP; attribute vec2 aT; varying vec2 vT; void main(){ gl_Position=vec4(aP,0.0,1.0); vT=aT; }";
    const char *fs = "precision mediump float; varying vec2 vT; uniform sampler2D uS; void main(){ gl_FragColor=texture2D(uS,vT); }";
    g_vidProg = glCreateProgram();
    GLuint sv = compile(GL_VERTEX_SHADER, vs), sf = compile(GL_FRAGMENT_SHADER, fs);
    glAttachShader(g_vidProg, sv); glAttachShader(g_vidProg, sf);
    glBindAttribLocation(g_vidProg, 0, "aP"); glBindAttribLocation(g_vidProg, 1, "aT");
    glLinkProgram(g_vidProg);
    glDeleteShader(sv); glDeleteShader(sf);
    g_vidUTex = glGetUniformLocation(g_vidProg, "uS");
    static const float quad[] = { -1,-1, 0,1,  1,-1, 1,1,  -1,1, 0,0,  1,1, 1,0 };
    glGenBuffers(1, &g_vidVbo);
    if (g_has_vao) {
      glGenVertexArrays(1, &g_vidVao);
      glBindVertexArray(g_vidVao);
      glBindBuffer(GL_ARRAY_BUFFER, g_vidVbo);
      glBufferData(GL_ARRAY_BUFFER, sizeof quad, quad, GL_STATIC_DRAW);
      glEnableVertexAttribArray(0); glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 16, (void *)0);
      glEnableVertexAttribArray(1); glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 16, (void *)8);
    } else {
      glBindBuffer(GL_ARRAY_BUFFER, g_vidVbo);
      glBufferData(GL_ARRAY_BUFFER, sizeof quad, quad, GL_STATIC_DRAW);
    }
  }

  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  glActiveTexture(GL_TEXTURE0);
  glGetIntegerv(GL_TEXTURE_BINDING_2D, &pTex);
  if (!v->tex) {
    glGenTextures(1, &v->tex);
    glBindTexture(GL_TEXTURE_2D, v->tex);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  } else {
    glBindTexture(GL_TEXTURE_2D, v->tex);
  }

  uint32_t seq = __atomic_load_n(&v->frameSeq, __ATOMIC_ACQUIRE);
  if (seq != v->texSeq) {
    SDL_LockMutex(v->mx);
    if (pAlign != 1) glPixelStorei(GL_UNPACK_ALIGNMENT, 1);
    if (v->texSeq == 0) glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, v->outW, v->outH, 0, GL_RGBA, GL_UNSIGNED_BYTE, v->rgba[v->frontIdx]);
    else glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, v->outW, v->outH, GL_RGBA, GL_UNSIGNED_BYTE, v->rgba[v->frontIdx]);
    if (pAlign != 1) glPixelStorei(GL_UNPACK_ALIGNMENT, pAlign);
    v->texSeq = seq;
    SDL_UnlockMutex(v->mx);
  }

  glDisable(GL_SCISSOR_TEST); glDisable(GL_BLEND); glDisable(GL_STENCIL_TEST); glDisable(GL_DEPTH_TEST); glDisable(GL_CULL_FACE);
  glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
  glViewport(0, 0, ww, wh);
  glClearColor(0, 0, 0, 1);
  glClear(GL_COLOR_BUFFER_BIT);

  double sc = fmin((double)ww / v->srcW, (double)wh / v->srcH);
  int dw = (int)lround(v->srcW * sc), dh = (int)lround(v->srcH * sc);
  glViewport((ww - dw) / 2, (wh - dh) / 2, dw, dh);

  glUseProgram(g_vidProg);
  glUniform1i(g_vidUTex, 0);
  if (g_has_vao) {
    glBindVertexArray(g_vidVao);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glBindVertexArray((GLuint)pVao);
  } else {
    GLint e0 = 0, e1 = 0;
    glGetVertexAttribiv(0, GL_VERTEX_ATTRIB_ARRAY_ENABLED, &e0);
    glGetVertexAttribiv(1, GL_VERTEX_ATTRIB_ARRAY_ENABLED, &e1);
    glBindBuffer(GL_ARRAY_BUFFER, g_vidVbo);
    glEnableVertexAttribArray(0); glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 16, (void *)0);
    glEnableVertexAttribArray(1); glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 16, (void *)8);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    if (!e0) glDisableVertexAttribArray(0);
    if (!e1) glDisableVertexAttribArray(1);
  }

  // Restore GL state
  glBindTexture(GL_TEXTURE_2D, (GLuint)pTex);
  glActiveTexture((GLenum)pAct);
  glBindBuffer(GL_ARRAY_BUFFER, (GLuint)pAb);
  glUseProgram((GLuint)pProg);
  glBindFramebuffer(GL_FRAMEBUFFER, (GLuint)pFb);
  glViewport(pVp[0], pVp[1], pVp[2], pVp[3]);
  glColorMask(pCm[0], pCm[1], pCm[2], pCm[3]);
  glClearColor(pCc[0], pCc[1], pCc[2], pCc[3]);
  if (pSc) glEnable(GL_SCISSOR_TEST);
  if (pBl) glEnable(GL_BLEND);
  if (pSt) glEnable(GL_STENCIL_TEST);
  if (pDp) glEnable(GL_DEPTH_TEST);
  if (pCu) glEnable(GL_CULL_FACE);)
