// ---------- DOM shims ----------
const listenersOf = o => o._ls || (o._ls = {});
function addL(o, t, f) { (listenersOf(o)[t] || (listenersOf(o)[t] = [])).push(f); }
function remL(o, t, f) { const a = listenersOf(o)[t]; if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } }
function fire(o, t, ev) {
  ev = ev || {}; ev.type = t; if (!ev.target) ev.target = o;
  const h = o['on' + t]; if (typeof h === 'function') { try { h.call(o, ev); } catch (e) { otherErrors.push(t + ' handler: ' + e.stack); log('HANDLER ERR', t, String(e.stack).slice(0, 500)); } }
  for (const f of (listenersOf(o)[t] || []).slice()) { if (ev._stop) break; try { f.call(o, ev); } catch (e) { otherErrors.push(t + ' listener: ' + e.stack); log('LISTENER ERR', t, String(e.stack).slice(0, 500)); } }
}
function canvasScreenRect(c) {
  const dw = (glInfo && glInfo.drawableWidth) || 640, dh = (glInfo && glInfo.drawableHeight) || 480;
  const cw = (c && c.width) || (typeof Graphics !== 'undefined' && Graphics.width) || dw;
  const ch = (c && c.height) || (typeof Graphics !== 'undefined' && Graphics.height) || dh;
  const s = Math.min(dw / cw, dh / ch);
  const w = Math.round(cw * s), h = Math.round(ch * s);
  const left = Math.round((dw - w) / 2), top = Math.round((dh - h) / 2);
  return { left, top, right: left + w, bottom: top + h, width: w, height: h };
}
const ids = {};
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.nodeName = this.tagName; this.children = []; this.childNodes = this.children;
    this.parentNode = null; this._attrs = {}; this.style = { setProperty: noop, removeProperty: noop }; this.dataset = {};
    this.classList = { add: noop, remove: noop, toggle: noop, contains: () => false };
    this.innerHTML = ''; this._text = ''; this.id = '';
    if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') {
      this.value = ''; this.type = 'text'; this.maxLength = -1; this.placeholder = '';
      this.disabled = false; this.readOnly = false;
    }
  }
  appendChild(c) {
    c.parentNode = this; this.children.push(c);
    if (c.id) ids[c.id] = c;
    if (c.tagName === 'SCRIPT' && c.src) enqueueScript(c);
    return c;
  }
  insertBefore(c) { return this.appendChild(c); }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; if (c.id && ids[c.id] === c) delete ids[c.id]; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children.length = 0; }   // like the DOM: assigning text drops the children (PocketMZ_Menu redraws with box.textContent = "")
  get outerHTML() { return '<' + this.tagName.toLowerCase() + ' id="' + this.id + '">' + this.innerHTML + '</' + this.tagName.toLowerCase() + '>'; }
  setAttribute(k, v) { this._attrs[k] = v; if (k === 'id') this.id = v; }
  getAttribute(k) { return this._attrs[k] === undefined ? null : this._attrs[k]; }
  removeAttribute(k) { delete this._attrs[k]; }
  addEventListener(t, f) { addL(this, t, f); }
  removeEventListener(t, f) { remL(this, t, f); }
  dispatchEvent(ev) { fire(this, ev.type, ev); return true; }
  getBoundingClientRect() { return this === mainCanvas ? canvasScreenRect(this) : { left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480 }; }
  focus() {
    doc.activeElement = this;
    fire(this, 'focus');
    if ((this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') && !this.disabled && !this.readOnly && typeof globalThis.__pmzOpenIme === 'function') {
      globalThis.__pmzOpenIme(this);
    }
  }
  blur() {
    if (doc.activeElement === this) doc.activeElement = bodyEl;
    fire(this, 'blur');
  }
  click() {
    fire(this, 'click', { target: this, currentTarget: this, preventDefault: noop, stopPropagation: noop, stopImmediatePropagation: noop });
  }
  scrollIntoView() {}
  querySelector(sel) { const s = String(sel || '').trim(); if (!s) return null; if (s[0] === '#') return ids[s.slice(1)] || null; const m = this.getElementsByTagName(s); return m[0] || null; } querySelectorAll() { const r = []; r.item = i => r[i] || null; return r; }
  // tree walk (MV Utils.canReadGameFiles() asks for the last <script>; _modifyExistingElements for '*'; Graphics.loadFont for head.item(0))
  getElementsByTagName(tag) { const t = String(tag).toUpperCase(), r = []; const walk = n => { for (const c of n.children || []) { if (t === '*' || c.tagName === t) r.push(c); walk(c); } }; walk(this); r.item = i => r[i] || null; return r; }
  get offsetLeft() { return this === mainCanvas ? canvasScreenRect(this).left : 0; }
  get offsetTop() { return this === mainCanvas ? canvasScreenRect(this).top : 0; }
  get offsetWidth() { return this === mainCanvas ? canvasScreenRect(this).width : 640; }
  get offsetHeight() { return this === mainCanvas ? canvasScreenRect(this).height : 480; }
  get clientWidth() { return this.offsetWidth; } get clientHeight() { return this.offsetHeight; }
}
// features β does not have (video, m4a): logged as "COMPAT <kind>: <detail>" (once per kind+detail), counted in the final summary and written to PMZ_COMPAT_FILE
// (a launcher can read it to prefer NW.js for that game); the engine carries on (video = finished at once, m4a = missing audio file)
const compatSeen = {};
function compat(kind, detail) {
  const k = kind + ': ' + detail; if (compatSeen[k]) return; compatSeen[k] = 1;
  log('COMPAT ' + k);
  if (GUARD) guardFail('COMPAT ' + k);   // a skipped cutscene / missing BGM is worse than a restart on NW.js
  const f = proc.env.PMZ_COMPAT_FILE; if (f) { try { fs.appendFileSync(f, k + '\n'); } catch (e) {} }
}
const MEDIA_UNSUPPORTED = /(?!)/;   // png/jpg/webp/gif, audio (.ogg/.m4a/.rpgmvm/.mp3/.aac/.wav), and <video> (.mp4/.webm/.ogv/.mov) are natively decoded in pmzrt
const activeVideos = new Set();
function visibleFullscreenVideo() {
  for (const v of activeVideos) {
    if (v._vidId <= 0 || v.readyState < 2 || v.ended || !v.parentNode) continue;
    const st = v.style;
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    const op = st.opacity;
    if (op !== undefined && op !== '' && !(Number(op) > 0)) continue;
    return v;
  }
  return null;
}
function pumpVideos() {
  if (!activeVideos.size || !pmz.vidState) return;
  for (const v of [...activeVideos]) {
    if (v._vidId <= 0) continue;
    const st = pmz.vidState(v._vidId);
    if (!st) continue;
    v._curTime = st.time;
    if (st.ready && !v._loadedFired) {
      v._loadedFired = true; v.readyState = 4;
      v.videoWidth = st.outWidth || st.width; v.videoHeight = st.outHeight || st.height;
      fire(v, 'loadedmetadata'); fire(v, 'loadeddata'); fire(v, 'canplay'); fire(v, 'canplaythrough');
    }
    if (st.ended && !v._endedFired) {
      v._endedFired = true; v.paused = true; v.ended = true;
      fire(v, 'ended');
    }
  }
}
class FakeMedia extends FakeElement {
  constructor(tag) {
    super(tag);
    this._vol = 1; this._muted = false; this._loop = false; this._curTime = 0;
    this.duration = 0; this.paused = true; this.ended = false; this.readyState = 0;
    this.videoWidth = 0; this.videoHeight = 0; this._src = ''; this._vidId = 0;
    this._loadedFired = false; this._endedFired = false; this.autoplay = false;
  }
  get src() { return this._src; }
  set src(u) {
    const s = String(u || '');
    if (s !== this._src) { this._closeVid(); this.readyState = 0; this._loadedFired = false; this._endedFired = false; }
    this._src = s;
    if (this.tagName === 'VIDEO' && this._src && this.autoplay) this.load();
  }
  get volume() { return this._vol; }
  set volume(v) { this._vol = Math.max(0, Math.min(1, Number(v) || 0)); if (this._vidId > 0 && pmz.vidSetVolume) pmz.vidSetVolume(this._vidId, this._vol); }
  get muted() { return this._muted; }
  set muted(m) { this._muted = !!m; if (this._vidId > 0 && pmz.vidSetMuted) pmz.vidSetMuted(this._vidId, this._muted); }
  get loop() { return this._loop; }
  set loop(l) { this._loop = !!l; if (this._vidId > 0 && pmz.vidSetLoop) pmz.vidSetLoop(this._vidId, this._loop); }
  get currentTime() { return this._curTime; }
  set currentTime(t) {
    const s = Math.max(0, Number(t) || 0); this._curTime = s; this.ended = false; this._endedFired = false;
    if (this._vidId > 0 && pmz.vidSeek) pmz.vidSeek(this._vidId, s);
  }
  _closeVid() {
    if (this._vidId > 0) { if (pmz.vidClose) pmz.vidClose(this._vidId); this._vidId = 0; }
    activeVideos.delete(this);
  }
  load() {
    if (this.tagName !== 'VIDEO') return;
    this._closeVid();
    this.readyState = 0; this.paused = true; this.ended = false; this._loadedFired = false; this._endedFired = false; this._curTime = 0;
    const raw = this._src;
    if (!raw || !pmz.vidOpen) return;
    let srcArg = null;
    if (raw.startsWith('blob:')) {
      const b = blobs.get(raw);
      if (b && b._data) srcArg = b._data;
    } else {
      let p = resolvePath(raw);
      if (!fs.existsSync(p)) {
        const alt = p.replace(/\.webm$/i, '.mp4');
        const alt2 = p.replace(/\.mp4$/i, '.webm');
        if (alt !== p && fs.existsSync(alt)) p = alt;
        else if (alt2 !== p && fs.existsSync(alt2)) p = alt2;
      }
      if (fs.existsSync(p)) srcArg = p;
    }
    if (!srcArg) {
      log('VIDEO missing:', raw);
      setImmediate(() => fire(this, 'error'));
      return;
    }
    const maxW = (glInfo && glInfo.drawableWidth) || 640, maxH = (glInfo && glInfo.drawableHeight) || 480;
    const r = pmz.vidOpen(srcArg, maxW, maxH);
    if (!r || r.error || !r.id) {
      log('VIDEO open failed:', raw, r && r.error);
      setImmediate(() => fire(this, 'error'));
      return;
    }
    this._vidId = r.id;
    this.videoWidth = r.outWidth || r.width || 0;
    this.videoHeight = r.outHeight || r.height || 0;
    this.duration = r.duration || 0;
    pmz.vidSetVolume(this._vidId, this._vol);
    pmz.vidSetMuted(this._vidId, this._muted);
    pmz.vidSetLoop(this._vidId, this._loop);
    activeVideos.add(this);
    log('VIDEO open', raw, r.width + 'x' + r.height + ' -> ' + this.videoWidth + 'x' + this.videoHeight, 'dur=' + this.duration.toFixed(1) + 's', 'audio=' + r.hasAudio);
  }
  play() {
    if (this.tagName === 'VIDEO') {
      if (this._vidId <= 0 && this._src) this.load();
      if (this._vidId > 0 && pmz.vidPlay) {
        this.paused = false; this.ended = false; this._endedFired = false;
        pmz.vidPlay(this._vidId);
      }
    }
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    if (this._vidId > 0 && pmz.vidPause) pmz.vidPause(this._vidId);
  }
  canPlayType(t) {
    return /ogg|vorbis|mp4|aac|m4a|mpeg|mp3|wav|webm|vp8|vp9|h264|avc1/i.test(t || '') ? 'probably' : '';
  }
}
class FakeBlob {
  constructor(parts, opts) {
    const bufs = (parts || []).map(p => p instanceof ArrayBuffer ? Buffer.from(p) : ArrayBuffer.isView(p) ? Buffer.from(p.buffer, p.byteOffset, p.byteLength) : Buffer.from(String(p)));
    this._data = Buffer.concat(bufs); this.size = this._data.length; this.type = (opts && opts.type) || '';
  }
  arrayBuffer() { const b = this._data; return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); }
  text() { return Promise.resolve(this._data.toString('utf8')); }
  slice() { return this; }
}
const blobs = new Map(); let blobSeq = 0;
URL.createObjectURL = b => { const u = 'blob:null/' + (++blobSeq); blobs.set(u, b); return u; };
URL.revokeObjectURL = u => { blobs.delete(u); };

const prof = {};
if (proc.env.PMZ_PROF) for (const k of Object.keys(pmz)) if (proc.env.PMZ_PROF === 'all' ? typeof pmz[k] === 'function' && !/^(swap|poll|shutdown|writePng)/.test(k) : /^(cv|texImageCv|font)/.test(k)) {   // PMZ_PROF=1: per-function call count + time of the canvas natives
  const f = pmz[k], st = prof[k] = { n: 0, ms: 0 };
  pmz[k] = function () { const t = nowMs(); try { return f.apply(this, arguments); } finally { st.n++; st.ms += nowMs() - t; } };
}
const c2d = require(path.join(PMZRT_DIR, 'canvas2d.js')).create({
  pmz, FakeElement, resolvePath: u => vfs.resolvePath(resolvePath(u)), makeBlob: (parts, type) => new FakeBlob(parts, { type }), pid: proc.pid, warn: warnOnce,
  csCacheMaxBytes: proc.env.PMZ_CS_CACHE_MB !== undefined && proc.env.PMZ_CS_CACHE_MB !== '' ? parseFloat(proc.env.PMZ_CS_CACHE_MB) * 1024 * 1024 : 20 * 1024 * 1024,
  // only one GL context exists (the SDL window): it belongs to the game canvas. Other canvases (PIXI's isWebGLSupported() and
  // shader-introspection test contexts) get a 'probe' wrapper on the same GL context that never touches viewport state.
  createGL: (canvas, attrs) => createMainGL(canvas, attrs, String(canvas.id).toLowerCase() !== 'gamecanvas'),   // MZ 'gameCanvas', MV 'GameCanvas'
  onCreate: canvas => { canvas._held = { n: 0 }; canvasReg.register(canvas, canvas._held); acct.canvasCount++; },
  onSize: (canvas, n) => { acct.canvasLive += n - canvas._held.n; canvas._held.n = n; if (n > 0) acct.canvasEver += n; },
});
function pngSize(buf) {
  if (buf.length >= 24 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  return null;
}
// png / jpg / webp / gif by magic bytes
function imageKind(b) {
  if (!b || b.length < 6) return null;
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'gif';
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  return null;
}
class FakeImage extends FakeElement {
  // _pix = { width, height, data: RGBA8 non-premultiplied } is what webgl.js uploads (texImage2D with an Image source)
  constructor() { super('img'); this._src = ''; this.width = 0; this.height = 0; this.naturalWidth = 0; this.naturalHeight = 0; this.complete = false; this._pix = null; this._animTimer = null; this._held = { n: 0 }; imageReg.register(this, this._held); acct.imageCount++; }
  _stopAnim() { if (this._animTimer) { clearTimeout(this._animTimer); this._animTimer = null; } }
  get src() { return this._src; }
  set src(v) {
    this._src = String(v); this.complete = false; this._stopAnim();
    if (!this._src) { c2d.dropImageSurface(this); this._pix = null; acct.imageLive -= this._held.n; this._held.n = 0; return; }   // src = '' releases the pixels
    const done = (data, err) => {
      if (err) { this.complete = true; this.error = true; fire(this, 'error'); return; }
      let pix; const kind = imageKind(data);
      if (kind) {
        try { pix = kind === 'png' ? pmz.decodePng(data) : kind === 'jpg' ? pmz.decodeJpeg(data) : kind === 'gif' ? pmz.decodeGif(data) : pmz.decodeWebp(data); }
        catch (e) { log(kind.toUpperCase() + ' decode failed:', String(this._src).slice(0, 80), e.message); this.complete = true; this.error = true; fire(this, 'error'); return; }
      } else { warnOnce('unsupported image format (' + (data && data.length >= 4 ? 'magic ' + Buffer.from(data.buffer, data.byteOffset, 4).toString('hex') : 'empty') + ', only png/jpg/webp/gif): ' + String(this._src).slice(0, 60)); pix = { width: 1, height: 1, data: new Uint8Array(4) }; }
      this._pix = pix; this.width = this.naturalWidth = pix.width; this.height = this.naturalHeight = pix.height;
      if (pix.frames && pix.frames.length > 1) {
        let fi = 0;
        const step = () => {
          if (!this._pix || this._pix.frames !== pix.frames) return;
          fi = (fi + 1) % pix.frames.length;
          c2d.dropImageSurface(this);
          this._pix = { width: pix.width, height: pix.height, data: pix.frames[fi].data, frames: pix.frames };
          const t = setTimeout(step, Math.max(16, pix.frames[fi].delayMs || 100));
          if (t.unref) t.unref();
          this._animTimer = t;
        };
        const t = setTimeout(step, Math.max(16, pix.frames[0].delayMs || 100));
        if (t.unref) t.unref();
        this._animTimer = t;
      }
      const n = pix.data.length;
      acct.imageLive += n - this._held.n; this._held.n = n; acct.imageEver += n;
      this.complete = true; fire(this, 'load');
    };
    const s = this._src;
    if (s.startsWith('blob:')) {
      const b = blobs.get(s);
      setImmediate(() => b ? done(b._data) : done(null, true));
    } else if (s.startsWith('data:')) {
      setImmediate(() => { const i = s.indexOf('base64,'); done(i >= 0 ? Buffer.from(s.slice(i + 7), 'base64') : Buffer.alloc(0)); });
    } else if (s) {
      vfs.readFile(resolvePath(s), (e, d) => e ? done(null, true) : done(d));
    }
  }
  decode() { return Promise.resolve(); }
}
function readFileWithAudioFallback(p, cb) {
  vfs.readFile(p, (e, d) => {
    if (!e || e.code !== 'ENOENT') return cb(e, d);
    let alts = null;
    if (/\.ogg$/i.test(p)) alts = [p.slice(0, -4) + '.m4a', p.slice(0, -4) + '.mp3', p.slice(0, -4) + '.wav'];
    else if (/\.rpgmvo$/i.test(p)) alts = [p.slice(0, -7) + '.rpgmvm'];
    else if (/\.m4a$/i.test(p)) alts = [p.slice(0, -4) + '.ogg'];
    else if (/\.rpgmvm$/i.test(p)) alts = [p.slice(0, -7) + '.rpgmvo'];
    if (alts) {
      for (const a of alts) { if (vfs.existsSync(a)) return vfs.readFile(a, cb); }
    }
    cb(e, d);
  });
}
class FakeXHR {
  constructor() { this.readyState = 0; this.status = 0; this.responseType = ''; this.response = null; this.responseText = ''; this.responseXML = null; this._h = {}; }
  open(m, url) { this._url = url; this.readyState = 1; }
  setRequestHeader() {} overrideMimeType() {} abort() {} getResponseHeader() { return null; }
  addEventListener(t, f) { addL(this, t, f); }
  send() {
    if (MEDIA_UNSUPPORTED.test(String(this._url))) compat('media-file', String(this._url).slice(0, 80));
    readFileWithAudioFallback(resolvePath(this._url), (e, d) => {
      if (e) { if (/(^|\/)(audio|movies)\//.test(String(this._url))) warnOnce('missing ' + (/(^|\/)movies\//.test(String(this._url)) ? 'movie' : 'audio') + ' file: ' + decodeURI(String(this._url)).slice(-70)); this.status = 404; this.readyState = 4; fire(this, 'readystatechange'); fire(this, 'error'); return; }
      this.status = 200; this.readyState = 4;
      if (this.responseType === 'arraybuffer') this.response = d.buffer.slice(d.byteOffset, d.byteOffset + d.length);
      else {
        let s = d.toString('utf8'); if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
        this.responseText = s;
        if (this.responseType === 'json') { try { this.response = JSON.parse(s); } catch (x) { this.response = null; } }
        else if (this.responseType === 'document' || /\.xml(\?|#|$)/i.test(String(this._url || ''))) {
          try { this.responseXML = new DOMParser().parseFromString(s, 'text/xml'); } catch (x) { this.responseXML = null; }
          this.response = this.responseType === 'document' ? this.responseXML : s;
        } else this.response = s;
      }
      fire(this, 'readystatechange'); fire(this, 'load');
    });
  }
}
function fakeFetch(url) {
  if (MEDIA_UNSUPPORTED.test(String(url))) compat('media-file', String(url).slice(0, 80));
  return new Promise((res, rej) => readFileWithAudioFallback(resolvePath(url), (e, d) => {
    if (e) return res({ ok: false, status: 404, statusText: 'Not Found', arrayBuffer: () => Promise.reject(e), text: () => Promise.reject(e), json: () => Promise.reject(e) });
    const ab = () => d.buffer.slice(d.byteOffset, d.byteOffset + d.length);
    res({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(ab()), text: () => Promise.resolve(d.toString('utf8')), json: () => Promise.resolve(JSON.parse(d.toString('utf8'))), clone() { return this; } });
  }));
}
const FakeFontFace = c2d.FontFace;
// emscripten (effekseer.min.js) prefers WebAssembly.instantiateStreaming(fetch(url)): our fetch result is no Response, so give it a Response-compatible path
if (typeof WebAssembly.instantiateStreaming === 'function') WebAssembly.instantiateStreaming = async (src, imports) => WebAssembly.instantiate(await (await src).arrayBuffer(), imports);
