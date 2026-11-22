'use strict';
// canvas2d.js - HTMLCanvasElement + CanvasRenderingContext2D + ImageData + FontFace/document.fonts on top of pmzrt's Cairo/Pango canvas (pmzrt_canvas.c).
// create({ pmz, FakeElement, resolvePath, createGL(canvas, attrs), onCreate(canvas), onSize(canvas, bytes), warn(msg) }) -> classes.
// The JS context keeps a mirror of the state (for getters and save/restore) and pushes changes to C immediately when they differ.

const ALIGN = { start: 0, left: 0, end: 1, right: 1, center: 2 };
const BASE = { alphabetic: 0, top: 1, hanging: 2, middle: 3, ideographic: 4, bottom: 5 };
const JOIN = { miter: 0, round: 1, bevel: 2 }, CAP = { butt: 0, round: 1, square: 2 };

function create(o) {
  const pmz = o.pmz, FakeElement = o.FakeElement;
  const warn = o.warn || (() => {});

  class ImageData {
    constructor(a, b, c) {
      if (typeof a === 'number') { this.width = a | 0; this.height = b | 0; this.data = new Uint8ClampedArray(this.width * this.height * 4); }
      else { this.data = a; this.width = b | 0; this.height = c === undefined ? (a.length / 4 / (b | 0)) | 0 : c | 0; }
      this.colorSpace = 'srgb';
    }
  }
  class CanvasGradient {
    constructor(p) { this._p = p; }
    addColorStop(off, color) {
      if (!(off >= 0 && off <= 1)) throw new RangeError('IndexSizeError: offset out of range');
      if (!pmz.cvAddColorStop(this._p, +off, String(color))) throw new SyntaxError('SyntaxError: invalid color "' + color + '"');
    }
  }
  class CanvasPattern { constructor(p) { this._p = p; } setTransform() {} }

  // native surface of a drawImage / createPattern source (our Image, a canvas, ImageData)
  function nativeOf(src) {
    if (!src) return null;
    if (src.tagName === 'CANVAS') return src._ensure();
    if (src._pix) {
      if (!src._cs || src._csPix !== src._pix) { src._cs = pmz.cvFromRGBA(src._pix.data, src._pix.width, src._pix.height); src._csPix = src._pix; }
      return src._cs;
    }
    if (src.data && src.width && src.height && !src.tagName) return pmz.cvFromRGBA(src.data, src.width, src.height);   // ImageData: temporary
    return null;
  }
  const sizeOf = s => s.tagName === 'CANVAS' ? [s.width, s.height] : s._pix ? [s._pix.width, s._pix.height] : [s.width | 0, s.height | 0];

  const DEFAULTS = () => ({
    fillStyle: '#000000', strokeStyle: '#000000', globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: true, imageSmoothingQuality: 'low',
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10, lineDashOffset: 0, lineDash: [],
    shadowColor: 'rgba(0, 0, 0, 0)', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, filter: 'none',
    font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', direction: 'ltr', fontKerning: 'auto', letterSpacing: '0px', wordSpacing: '0px', textRendering: 'auto', fontStretch: 'normal', fontVariantCaps: 'normal',
  });
  // canvas state with one fixed shape: save() copies it field by field (Object.assign on a 27-key literal was ~90 us per call)
  class CtxState {
    constructor(o) {
      this.fillStyle = o.fillStyle;
      this.strokeStyle = o.strokeStyle;
      this.globalAlpha = o.globalAlpha;
      this.globalCompositeOperation = o.globalCompositeOperation;
      this.imageSmoothingEnabled = o.imageSmoothingEnabled;
      this.imageSmoothingQuality = o.imageSmoothingQuality;
      this.lineWidth = o.lineWidth;
      this.lineCap = o.lineCap;
      this.lineJoin = o.lineJoin;
      this.miterLimit = o.miterLimit;
      this.lineDashOffset = o.lineDashOffset;
      this.shadowColor = o.shadowColor;
      this.shadowBlur = o.shadowBlur;
      this.shadowOffsetX = o.shadowOffsetX;
      this.shadowOffsetY = o.shadowOffsetY;
      this.filter = o.filter;
      this.font = o.font;
      this.textAlign = o.textAlign;
      this.textBaseline = o.textBaseline;
      this.direction = o.direction;
      this.fontKerning = o.fontKerning;
      this.letterSpacing = o.letterSpacing;
      this.wordSpacing = o.wordSpacing;
      this.textRendering = o.textRendering;
      this.fontStretch = o.fontStretch;
      this.fontVariantCaps = o.fontVariantCaps;
      this.lineDash = o.lineDash.slice();
    }
  }


  class CanvasRenderingContext2D {
    constructor(canvas) { this.canvas = canvas; this._s = new CtxState(DEFAULTS()); this._stack = []; this._fo = null; }
    _h() { return this.canvas._ensure(); }
    _reset() { this._s = new CtxState(DEFAULTS()); this._stack.length = 0; }

    // ---- state ----
    save() { this._stack.push(new CtxState(this._s)); pmz.cvSave(this._h()); }
    restore() { if (this._stack.length) { this._s = this._stack.pop(); pmz.cvRestore(this._h()); } }
    get fillStyle() { return this._s.fillStyle; }
    set fillStyle(v) {
      const s = this._s; if (v === s.fillStyle) return;
      if (typeof v === 'string') { if (pmz.cvSetFill(this._h(), v)) s.fillStyle = v; }
      else if (v && v._p) { pmz.cvSetFillPat(this._h(), v._p); s.fillStyle = v; }
    }
    get strokeStyle() { return this._s.strokeStyle; }
    set strokeStyle(v) {
      const s = this._s; if (v === s.strokeStyle) return;
      if (typeof v === 'string') { if (pmz.cvSetStroke(this._h(), v)) s.strokeStyle = v; }
      else if (v && v._p) { pmz.cvSetStrokePat(this._h(), v._p); s.strokeStyle = v; }
    }
    get globalAlpha() { return this._s.globalAlpha; }
    set globalAlpha(v) { v = +v; if (v >= 0 && v <= 1 && v !== this._s.globalAlpha) { this._s.globalAlpha = v; pmz.cvSetAlpha(this._h(), v); } }
    get globalCompositeOperation() { return this._s.globalCompositeOperation; }
    set globalCompositeOperation(v) { v = String(v); if (v !== this._s.globalCompositeOperation && pmz.cvSetOp(this._h(), v)) this._s.globalCompositeOperation = v; }
    get imageSmoothingEnabled() { return this._s.imageSmoothingEnabled; }
    set imageSmoothingEnabled(v) { v = !!v; if (v !== this._s.imageSmoothingEnabled) { this._s.imageSmoothingEnabled = v; pmz.cvSetSmooth(this._h(), v); } }
    get imageSmoothingQuality() { return this._s.imageSmoothingQuality; }
    set imageSmoothingQuality(v) { this._s.imageSmoothingQuality = v; }
    get lineWidth() { return this._s.lineWidth; }
    set lineWidth(v) { v = +v; if (v > 0 && isFinite(v) && v !== this._s.lineWidth) { this._s.lineWidth = v; pmz.cvSetLineWidth(this._h(), v); } }
    get lineCap() { return this._s.lineCap; }
    set lineCap(v) { if (v in CAP && v !== this._s.lineCap) { this._s.lineCap = v; pmz.cvSetLineCap(this._h(), CAP[v]); } }
    get lineJoin() { return this._s.lineJoin; }
    set lineJoin(v) { if (v in JOIN && v !== this._s.lineJoin) { this._s.lineJoin = v; pmz.cvSetLineJoin(this._h(), JOIN[v]); } }
    get miterLimit() { return this._s.miterLimit; }
    set miterLimit(v) { v = +v; if (v > 0 && isFinite(v) && v !== this._s.miterLimit) { this._s.miterLimit = v; pmz.cvSetMiter(this._h(), v); } }
    setLineDash(a) { a = Array.from(a || [], Number); if (a.some(x => !(x >= 0) || !isFinite(x))) return; if (a.length % 2) a = a.concat(a); this._s.lineDash = a; pmz.cvSetDash(this._h(), new Float64Array(a), this._s.lineDashOffset); }
    getLineDash() { return this._s.lineDash.slice(); }
    get lineDashOffset() { return this._s.lineDashOffset; }
    set lineDashOffset(v) { v = +v; if (isFinite(v)) { this._s.lineDashOffset = v; pmz.cvSetDash(this._h(), new Float64Array(this._s.lineDash), v); } }
    get shadowColor() { return this._s.shadowColor; }
    set shadowColor(v) { v = String(v); if (v !== this._s.shadowColor) { this._s.shadowColor = v; pmz.cvSetShadowColor(this._h(), v); } }
    get shadowBlur() { return this._s.shadowBlur; }
    set shadowBlur(v) { v = +v; if (v >= 0 && isFinite(v) && v !== this._s.shadowBlur) { this._s.shadowBlur = v; this._shadow(); } }
    get shadowOffsetX() { return this._s.shadowOffsetX; }
    set shadowOffsetX(v) { v = +v; if (isFinite(v) && v !== this._s.shadowOffsetX) { this._s.shadowOffsetX = v; this._shadow(); } }
    get shadowOffsetY() { return this._s.shadowOffsetY; }
    set shadowOffsetY(v) { v = +v; if (isFinite(v) && v !== this._s.shadowOffsetY) { this._s.shadowOffsetY = v; this._shadow(); } }
    _shadow() { const s = this._s; pmz.cvSetShadow(this._h(), s.shadowBlur, s.shadowOffsetX, s.shadowOffsetY); }
    get filter() { return this._s.filter; }
    set filter(v) {
      v = String(v); if (v === this._s.filter) return;
      let blur = 0;
      if (v !== 'none') { const m = /^\s*blur\(\s*([\d.]+)\s*(px)?\s*\)\s*$/.exec(v); if (m) blur = +m[1]; else warn('canvas filter ' + v + ' ignored'); }
      this._s.filter = v; pmz.cvSetBlur(this._h(), blur);
    }
    get font() { return this._s.font; }
    set font(v) { v = String(v); if (v !== this._s.font && pmz.cvSetFont(this._h(), v)) this._s.font = v; }
    get textAlign() { return this._s.textAlign; }
    set textAlign(v) { if (v in ALIGN && v !== this._s.textAlign) { this._s.textAlign = v; pmz.cvSetTextAlign(this._h(), ALIGN[v]); } }
    get textBaseline() { return this._s.textBaseline; }
    set textBaseline(v) { if (v in BASE && v !== this._s.textBaseline) { this._s.textBaseline = v; pmz.cvSetTextBaseline(this._h(), BASE[v]); } }
    get direction() { return this._s.direction; } set direction(v) { this._s.direction = v; }
    get fontKerning() { return this._s.fontKerning; } set fontKerning(v) { this._s.fontKerning = v; }
    get letterSpacing() { return this._s.letterSpacing; } set letterSpacing(v) { this._s.letterSpacing = v; }
    get wordSpacing() { return this._s.wordSpacing; } set wordSpacing(v) { this._s.wordSpacing = v; }
    get textRendering() { return this._s.textRendering; } set textRendering(v) { this._s.textRendering = v; }
    get fontStretch() { return this._s.fontStretch; } set fontStretch(v) { this._s.fontStretch = v; }
    get fontVariantCaps() { return this._s.fontVariantCaps; } set fontVariantCaps(v) { this._s.fontVariantCaps = v; }
    getContextAttributes() { return { alpha: true, desynchronized: false, colorSpace: 'srgb', willReadFrequently: false }; }

    // ---- transforms ----
    setTransform(a, b, c, d, e, f) {
      if (a && typeof a === 'object') { f = a.f; e = a.e; d = a.d; c = a.c; b = a.b; a = a.a; }
      if (a === undefined) return this.resetTransform();
      pmz.cvSetTransform(this._h(), a, b, c, d, e, f);
    }
    transform(a, b, c, d, e, f) { pmz.cvTransform(this._h(), a, b, c, d, e, f); }
    resetTransform() { pmz.cvResetTransform(this._h()); }
    translate(x, y) { pmz.cvTranslate(this._h(), x, y); }
    scale(x, y) { pmz.cvScale(this._h(), x, y); }
    rotate(a) { pmz.cvRotate(this._h(), a); }
    getTransform() { const m = pmz.cvGetTransform(this._h()); return { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5], is2D: true, isIdentity: m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0 }; }

    // ---- paths ----
    beginPath() { pmz.cvBeginPath(this._h()); }
    closePath() { pmz.cvClosePath(this._h()); }
    moveTo(x, y) { pmz.cvMoveTo(this._h(), x, y); }
    lineTo(x, y) { pmz.cvLineTo(this._h(), x, y); }
    rect(x, y, w, h) { pmz.cvRect(this._h(), x, y, w, h); }
    arc(x, y, r, a0, a1, ccw) { if (r < 0) throw new RangeError('IndexSizeError: negative radius'); pmz.cvArc(this._h(), x, y, r, a0, a1, !!ccw); }
    arcTo(x1, y1, x2, y2, r) { if (r < 0) throw new RangeError('IndexSizeError: negative radius'); pmz.cvArcTo(this._h(), x1, y1, x2, y2, r); }
    ellipse(x, y, rx, ry, rot, a0, a1, ccw) { if (rx < 0 || ry < 0) throw new RangeError('IndexSizeError: negative radius'); pmz.cvEllipse(this._h(), x, y, rx, ry, rot, a0, a1, !!ccw); }
    quadraticCurveTo(cx, cy, x, y) { pmz.cvQuadTo(this._h(), cx, cy, x, y); }
    bezierCurveTo(a, b, c, d, x, y) { pmz.cvBezierTo(this._h(), a, b, c, d, x, y); }
    roundRect(x, y, w, h, r) {
      r = Array.isArray(r) ? +r[0] : +(r || 0); r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
      this.moveTo(x + r, y); this.arcTo(x + w, y, x + w, y + h, r); this.arcTo(x + w, y + h, x, y + h, r); this.arcTo(x, y + h, x, y, r); this.arcTo(x, y, x + w, y, r); this.closePath();
    }
    fill(rule) { pmz.cvFill(this._h(), rule === 'evenodd'); }
    stroke() { pmz.cvStroke(this._h()); }
    clip(rule) { pmz.cvClip(this._h(), rule === 'evenodd'); }
    isPointInPath(x, y, rule) { if (typeof x === 'object') { rule = y; x = arguments[1]; y = arguments[2]; rule = arguments[3]; } return pmz.cvInPath(this._h(), x, y, rule === 'evenodd'); }
    isPointInStroke() { return false; }
    fillRect(x, y, w, h) { pmz.cvFillRect(this._h(), x, y, w, h); }
    strokeRect(x, y, w, h) { pmz.cvStrokeRect(this._h(), x, y, w, h); }
    clearRect(x, y, w, h) { pmz.cvClearRect(this._h(), x, y, w, h); }

    // ---- gradients / patterns ----
    createLinearGradient(x0, y0, x1, y1) { return new CanvasGradient(pmz.cvLinearGradient(x0, y0, x1, y1)); }
    createRadialGradient(x0, y0, r0, x1, y1, r1) { return new CanvasGradient(pmz.cvRadialGradient(x0, y0, r0, x1, y1, r1)); }
    createConicGradient() { warn('createConicGradient'); return new CanvasGradient(pmz.cvLinearGradient(0, 0, 1, 0)); }
    createPattern(img, rep) {
      const n = nativeOf(img); if (!n) return null;
      const m = { 'repeat': 0, '': 0, 'no-repeat': 1, 'repeat-x': 2, 'repeat-y': 3 }[rep === null || rep === undefined ? 'repeat' : String(rep)];
      if (m === undefined) throw new SyntaxError('SyntaxError: invalid repetition');
      return new CanvasPattern(pmz.cvPattern(n, m));
    }

    // ---- images ----
    drawImage(img, a, b, c, d, e, f, g, h) {
      const n = nativeOf(img); if (!n) return;
      const sz = sizeOf(img), na = arguments.length;
      if (na === 3) pmz.cvDrawImage(this._h(), n, 0, 0, sz[0], sz[1], a, b, sz[0], sz[1]);
      else if (na === 5) pmz.cvDrawImage(this._h(), n, 0, 0, sz[0], sz[1], a, b, c, d);
      else if (na === 9) pmz.cvDrawImage(this._h(), n, a, b, c, d, e, f, g, h);
      else throw new TypeError('drawImage: ' + na + ' arguments');
    }
    getImageData(x, y, w, h) {
      x = Math.floor(x); y = Math.floor(y); w = Math.trunc(w); h = Math.trunc(h);
      if (w < 0) { x += w; w = -w; } if (h < 0) { y += h; h = -h; }
      if (!(w > 0 && h > 0)) throw new RangeError('IndexSizeError: getImageData with zero size');
      const d = new Uint8ClampedArray(w * h * 4); pmz.cvGetImageData(this._h(), x, y, w, h, d);
      return new ImageData(d, w, h);
    }
    putImageData(im, dx, dy, ix, iy, iw, ih) {
      dx = Math.trunc(dx); dy = Math.trunc(dy);
      if (iw === undefined) { ix = 0; iy = 0; iw = im.width; ih = im.height; }
      pmz.cvPutImageData(this._h(), im.data, im.width, im.height, dx, dy, Math.trunc(ix), Math.trunc(iy), Math.trunc(iw), Math.trunc(ih));
    }
    createImageData(w, h) { if (typeof w === 'object') { h = w.height; w = w.width; } return new ImageData(w, h); }

    // ---- text ----
    fillText(t, x, y, maxW) { pmz.cvText(this._h(), String(t), +x, +y, maxW === undefined ? -1 : +maxW, false); }
    strokeText(t, x, y, maxW) { pmz.cvText(this._h(), String(t), +x, +y, maxW === undefined ? -1 : +maxW, true); }
    measureText(t) {
      const m = pmz.cvMeasure(this._h(), String(t));
      return { width: m[0], actualBoundingBoxLeft: m[1], actualBoundingBoxRight: m[2], actualBoundingBoxAscent: m[3], actualBoundingBoxDescent: m[4],
        fontBoundingBoxAscent: m[5], fontBoundingBoxDescent: m[6], emHeightAscent: m[7], emHeightDescent: m[8], alphabeticBaseline: 0, hangingBaseline: m[5] * 0.8, ideographicBaseline: -m[6] };
    }
    drawFocusIfNeeded() {} scrollPathIntoView() {} reset() { this.canvas._resize(); }
  }

  class HTMLCanvasElement extends FakeElement {
    constructor() { super('canvas'); this._w = 300; this._h = 150; this._cv = null; this._ctx = null; this._gl = null; if (o.onCreate) o.onCreate(this); }
    get width() { return this._w; } set width(v) { this._w = Math.max(0, Math.floor(+v) || 0); this._resize(); }
    get height() { return this._h; } set height(v) { this._h = Math.max(0, Math.floor(+v) || 0); this._resize(); }
    _ensure() { if (!this._cv) { this._cv = pmz.cvCreate(this._w, this._h); if (o.onSize) o.onSize(this, this._w * this._h * 4); } return this._cv; }
    // resizing (or re-assigning the size) clears the bitmap and resets the 2D state, like a browser
    _resize() {
      if (this._cv) { pmz.cvResize(this._cv, this._w, this._h); if (o.onSize) o.onSize(this, this._w * this._h * 4); }
      if (this._ctx) this._ctx._reset();
    }
    getContext(type, attrs) {
      if (type === 'webgl' || type === 'experimental-webgl') { if (!this._gl) this._gl = o.createGL(this, attrs); return this._gl; }
      if (type !== '2d') return null;   // webgl2, bitmaprenderer...
      if (!this._ctx) { this._ctx = new CanvasRenderingContext2D(this); this._ensure(); }
      return this._ctx;
    }
    toDataURL(type) {
      if (!(this._w > 0 && this._h > 0)) return 'data:,';
      const b = pmz.cvToPng(this._ensure()); return b ? 'data:image/png;base64,' + b.toString('base64') : 'data:,';
    }
    toBlob(cb, type) {
      setImmediate(() => { const b = this._w > 0 && this._h > 0 ? pmz.cvToPng(this._ensure()) : null; cb(o.makeBlob ? o.makeBlob(b ? [b] : [], 'image/png') : null); });
    }
  }

  // ---------- fonts ----------
  const faces = new Set();
  const stripQ = s => String(s).trim().replace(/^["']|["']$/g, '');
  class FontFace {
    constructor(family, source, desc) {
      this.family = stripQ(family); this.style = (desc && desc.style) || 'normal'; this.weight = (desc && desc.weight) || 'normal'; this.stretch = 'normal';
      this.unicodeRange = 'U+0-10FFFF'; this.display = 'auto'; this.status = 'unloaded'; this._source = source; this._p = null; this.real = null;
      this.loaded = new Promise((res, rej) => { this._res = res; this._rej = rej; }); this.loaded.catch(() => {});
    }
    load() {
      if (this._p) return this._p;
      this.status = 'loading';
      this._p = (async () => {
        try {
          await new Promise(r => setImmediate(r));
          let file = null;
          const src = this._source;
          if (typeof src === 'string') {
            const m = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(src); file = o.resolvePath(m ? m[2] : src);
          } else if (src && (src instanceof ArrayBuffer || ArrayBuffer.isView(src))) {
            const fs = require('fs'), os = require('os'), p = os.tmpdir() + '/pmzfont-' + process_pid() + '-' + (++tmpSeq) + '.font';
            fs.writeFileSync(p, Buffer.from(src instanceof ArrayBuffer ? src : src.buffer, src.byteOffset || 0, src.byteLength)); file = p;
          }
          const real = file && pmz.fontAdd(file);
          if (!real) throw new Error('NetworkError: cannot load font ' + file);
          pmz.fontMap(this.family, real); this.real = real;
          this.status = 'loaded'; this._res(this); return this;
        } catch (e) { this.status = 'error'; this._rej(e); throw e; }
      })();
      return this._p;
    }
  }
  let tmpSeq = 0;
  const process_pid = () => (o.pid || 0);
  const fontSet = {
    add(f) { faces.add(f); if (f.status === 'unloaded') f.load().catch(() => {}); return fontSet; },
    delete(f) { return faces.delete(f); }, clear() { faces.clear(); }, has(f) { return faces.has(f); },
    load(spec) {
      const fam = /(?:^|\s)\d[^\s]*\s+(.*)$/.exec(String(spec)); const names = fam ? fam[1].split(',').map(stripQ) : [];
      return Promise.all([...faces].filter(f => names.includes(f.family)).map(f => f.load())).then(() => [...faces].filter(f => names.includes(f.family)));
    },
    check() { return true; },
    forEach(cb, t) { faces.forEach(f => cb.call(t, f, f, fontSet)); },
    get size() { return faces.size; }, get status() { return 'loaded'; }, get ready() { return Promise.resolve(fontSet); },
    [Symbol.iterator]() { return faces[Symbol.iterator](); },
    addEventListener() {}, removeEventListener() {},
  };

  return { HTMLCanvasElement, CanvasRenderingContext2D, ImageData, CanvasGradient, CanvasPattern, FontFace, fontSet, nativeOf };
}

module.exports = { create };
