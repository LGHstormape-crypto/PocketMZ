'use strict';
// webgl.js - WebGL1 (WebGLRenderingContext) on top of the pmzrt GLES passthrough.
// pmzrt (C) exposes the GLES calls with the same names/args as WebGL methods and GL names as plain numbers;
// this file wraps the names into WebGL* objects, tracks the few bits of state WebGL needs (unpack flags, bound
// framebuffer), reads pixels out of DOM-ish sources, and maps the game-sized default framebuffer into the
// (smaller) real window with aspect-preserving letterboxing.
// NOTE: do not use `process` here - the harness hides the global before the page code runs.

const GL = {
  DEPTH_BUFFER_BIT: 0x100, STENCIL_BUFFER_BIT: 0x400, COLOR_BUFFER_BIT: 0x4000,
  POINTS: 0, LINES: 1, LINE_LOOP: 2, LINE_STRIP: 3, TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6,
  ZERO: 0, ONE: 1, SRC_COLOR: 0x300, ONE_MINUS_SRC_COLOR: 0x301, SRC_ALPHA: 0x302, ONE_MINUS_SRC_ALPHA: 0x303,
  DST_ALPHA: 0x304, ONE_MINUS_DST_ALPHA: 0x305, DST_COLOR: 0x306, ONE_MINUS_DST_COLOR: 0x307, SRC_ALPHA_SATURATE: 0x308,
  FUNC_ADD: 0x8006, BLEND_EQUATION: 0x8009, BLEND_EQUATION_RGB: 0x8009, BLEND_EQUATION_ALPHA: 0x883D,
  FUNC_SUBTRACT: 0x800A, FUNC_REVERSE_SUBTRACT: 0x800B,
  BLEND_DST_RGB: 0x80C8, BLEND_SRC_RGB: 0x80C9, BLEND_DST_ALPHA: 0x80CA, BLEND_SRC_ALPHA: 0x80CB,
  CONSTANT_COLOR: 0x8001, ONE_MINUS_CONSTANT_COLOR: 0x8002, CONSTANT_ALPHA: 0x8003, ONE_MINUS_CONSTANT_ALPHA: 0x8004, BLEND_COLOR: 0x8005,
  ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, ARRAY_BUFFER_BINDING: 0x8894, ELEMENT_ARRAY_BUFFER_BINDING: 0x8895,
  STREAM_DRAW: 0x88E0, STATIC_DRAW: 0x88E4, DYNAMIC_DRAW: 0x88E8, BUFFER_SIZE: 0x8764, BUFFER_USAGE: 0x8765, CURRENT_VERTEX_ATTRIB: 0x8626,
  FRONT: 0x404, BACK: 0x405, FRONT_AND_BACK: 0x408,
  TEXTURE_2D: 0xDE1, CULL_FACE: 0xB44, BLEND: 0xBE2, DITHER: 0xBD0, STENCIL_TEST: 0xB90, DEPTH_TEST: 0xB71, SCISSOR_TEST: 0xC11,
  POLYGON_OFFSET_FILL: 0x8037, SAMPLE_ALPHA_TO_COVERAGE: 0x809E, SAMPLE_COVERAGE: 0x80A0,
  NO_ERROR: 0, INVALID_ENUM: 0x500, INVALID_VALUE: 0x501, INVALID_OPERATION: 0x502, OUT_OF_MEMORY: 0x505,
  CW: 0x900, CCW: 0x901,
  LINE_WIDTH: 0xB21, ALIASED_POINT_SIZE_RANGE: 0x846D, ALIASED_LINE_WIDTH_RANGE: 0x846E, CULL_FACE_MODE: 0xB45, FRONT_FACE: 0xB46,
  DEPTH_RANGE: 0xB70, DEPTH_WRITEMASK: 0xB72, DEPTH_CLEAR_VALUE: 0xB73, DEPTH_FUNC: 0xB74, STENCIL_CLEAR_VALUE: 0xB91,
  STENCIL_FUNC: 0xB92, STENCIL_FAIL: 0xB94, STENCIL_PASS_DEPTH_FAIL: 0xB95, STENCIL_PASS_DEPTH_PASS: 0xB96, STENCIL_REF: 0xB97,
  STENCIL_VALUE_MASK: 0xB93, STENCIL_WRITEMASK: 0xB98, STENCIL_BACK_FUNC: 0x8800, STENCIL_BACK_FAIL: 0x8801,
  STENCIL_BACK_PASS_DEPTH_FAIL: 0x8802, STENCIL_BACK_PASS_DEPTH_PASS: 0x8803, STENCIL_BACK_REF: 0x8CA3,
  STENCIL_BACK_VALUE_MASK: 0x8CA4, STENCIL_BACK_WRITEMASK: 0x8CA5,
  VIEWPORT: 0xBA2, SCISSOR_BOX: 0xC10, COLOR_CLEAR_VALUE: 0xC22, COLOR_WRITEMASK: 0xC23, UNPACK_ALIGNMENT: 0xCF5, PACK_ALIGNMENT: 0xD05,
  MAX_TEXTURE_SIZE: 0xD33, MAX_VIEWPORT_DIMS: 0xD3A, SUBPIXEL_BITS: 0xD50, RED_BITS: 0xD52, GREEN_BITS: 0xD53, BLUE_BITS: 0xD54,
  ALPHA_BITS: 0xD55, DEPTH_BITS: 0xD56, STENCIL_BITS: 0xD57, POLYGON_OFFSET_UNITS: 0x2A00, POLYGON_OFFSET_FACTOR: 0x8038,
  TEXTURE_BINDING_2D: 0x8069, SAMPLE_BUFFERS: 0x80A8, SAMPLES: 0x80A9, SAMPLE_COVERAGE_VALUE: 0x80AA, SAMPLE_COVERAGE_INVERT: 0x80AB,
  COMPRESSED_TEXTURE_FORMATS: 0x86A3,
  DONT_CARE: 0x1100, FASTEST: 0x1101, NICEST: 0x1102, GENERATE_MIPMAP_HINT: 0x8192,
  BYTE: 0x1400, UNSIGNED_BYTE: 0x1401, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403, INT: 0x1404, UNSIGNED_INT: 0x1405, FLOAT: 0x1406,
  DEPTH_COMPONENT: 0x1902, ALPHA: 0x1906, RGB: 0x1907, RGBA: 0x1908, LUMINANCE: 0x1909, LUMINANCE_ALPHA: 0x190A,
  UNSIGNED_SHORT_4_4_4_4: 0x8033, UNSIGNED_SHORT_5_5_5_1: 0x8034, UNSIGNED_SHORT_5_6_5: 0x8363,
  FRAGMENT_SHADER: 0x8B30, VERTEX_SHADER: 0x8B31, MAX_VERTEX_ATTRIBS: 0x8869, MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB,
  MAX_VARYING_VECTORS: 0x8DFC, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D, MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8B4C,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872, MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD, SHADER_TYPE: 0x8B4F, DELETE_STATUS: 0x8B80,
  LINK_STATUS: 0x8B82, VALIDATE_STATUS: 0x8B83, ATTACHED_SHADERS: 0x8B85, ACTIVE_UNIFORMS: 0x8B86, ACTIVE_ATTRIBUTES: 0x8B89,
  SHADING_LANGUAGE_VERSION: 0x8B8C, CURRENT_PROGRAM: 0x8B8D,
  NEVER: 0x200, LESS: 0x201, EQUAL: 0x202, LEQUAL: 0x203, GREATER: 0x204, NOTEQUAL: 0x205, GEQUAL: 0x206, ALWAYS: 0x207,
  KEEP: 0x1E00, REPLACE: 0x1E01, INCR: 0x1E02, DECR: 0x1E03, INVERT: 0x150A, INCR_WRAP: 0x8507, DECR_WRAP: 0x8508,
  VENDOR: 0x1F00, RENDERER: 0x1F01, VERSION: 0x1F02,
  NEAREST: 0x2600, LINEAR: 0x2601, NEAREST_MIPMAP_NEAREST: 0x2700, LINEAR_MIPMAP_NEAREST: 0x2701,
  NEAREST_MIPMAP_LINEAR: 0x2702, LINEAR_MIPMAP_LINEAR: 0x2703,
  TEXTURE_MAG_FILTER: 0x2800, TEXTURE_MIN_FILTER: 0x2801, TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
  TEXTURE: 0x1702, TEXTURE_CUBE_MAP: 0x8513, TEXTURE_BINDING_CUBE_MAP: 0x8514,
  TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515, TEXTURE_CUBE_MAP_NEGATIVE_X: 0x8516, TEXTURE_CUBE_MAP_POSITIVE_Y: 0x8517,
  TEXTURE_CUBE_MAP_NEGATIVE_Y: 0x8518, TEXTURE_CUBE_MAP_POSITIVE_Z: 0x8519, TEXTURE_CUBE_MAP_NEGATIVE_Z: 0x851A,
  MAX_CUBE_MAP_TEXTURE_SIZE: 0x851C, ACTIVE_TEXTURE: 0x84E0,
  REPEAT: 0x2901, CLAMP_TO_EDGE: 0x812F, MIRRORED_REPEAT: 0x8370,
  FLOAT_VEC2: 0x8B50, FLOAT_VEC3: 0x8B51, FLOAT_VEC4: 0x8B52, INT_VEC2: 0x8B53, INT_VEC3: 0x8B54, INT_VEC4: 0x8B55,
  BOOL: 0x8B56, BOOL_VEC2: 0x8B57, BOOL_VEC3: 0x8B58, BOOL_VEC4: 0x8B59, FLOAT_MAT2: 0x8B5A, FLOAT_MAT3: 0x8B5B, FLOAT_MAT4: 0x8B5C,
  SAMPLER_2D: 0x8B5E, SAMPLER_CUBE: 0x8B60,
  VERTEX_ATTRIB_ARRAY_ENABLED: 0x8622, VERTEX_ATTRIB_ARRAY_SIZE: 0x8623, VERTEX_ATTRIB_ARRAY_STRIDE: 0x8624,
  VERTEX_ATTRIB_ARRAY_TYPE: 0x8625, VERTEX_ATTRIB_ARRAY_NORMALIZED: 0x886A, VERTEX_ATTRIB_ARRAY_POINTER: 0x8645,
  VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: 0x889F,
  IMPLEMENTATION_COLOR_READ_TYPE: 0x8B9A, IMPLEMENTATION_COLOR_READ_FORMAT: 0x8B9B,
  COMPILE_STATUS: 0x8B81, INFO_LOG_LENGTH: 0x8B84, SHADER_SOURCE_LENGTH: 0x8B88,
  LOW_FLOAT: 0x8DF0, MEDIUM_FLOAT: 0x8DF1, HIGH_FLOAT: 0x8DF2, LOW_INT: 0x8DF3, MEDIUM_INT: 0x8DF4, HIGH_INT: 0x8DF5,
  FRAMEBUFFER: 0x8D40, RENDERBUFFER: 0x8D41, RGBA4: 0x8056, RGB5_A1: 0x8057, RGB565: 0x8D62, DEPTH_COMPONENT16: 0x81A5,
  STENCIL_INDEX8: 0x8D48, DEPTH_STENCIL: 0x84F9, STENCIL_INDEX: 0x1901,
  RENDERBUFFER_WIDTH: 0x8D42, RENDERBUFFER_HEIGHT: 0x8D43, RENDERBUFFER_INTERNAL_FORMAT: 0x8D44, RENDERBUFFER_RED_SIZE: 0x8D50,
  RENDERBUFFER_GREEN_SIZE: 0x8D51, RENDERBUFFER_BLUE_SIZE: 0x8D52, RENDERBUFFER_ALPHA_SIZE: 0x8D53, RENDERBUFFER_DEPTH_SIZE: 0x8D54,
  RENDERBUFFER_STENCIL_SIZE: 0x8D55,
  FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE: 0x8CD0, FRAMEBUFFER_ATTACHMENT_OBJECT_NAME: 0x8CD1, FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL: 0x8CD2,
  FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE: 0x8CD3, COLOR_ATTACHMENT0: 0x8CE0, DEPTH_ATTACHMENT: 0x8D00, STENCIL_ATTACHMENT: 0x8D20,
  DEPTH_STENCIL_ATTACHMENT: 0x821A, NONE: 0, FRAMEBUFFER_COMPLETE: 0x8CD5, FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8CD6,
  FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT: 0x8CD7, FRAMEBUFFER_INCOMPLETE_DIMENSIONS: 0x8CD9, FRAMEBUFFER_UNSUPPORTED: 0x8CDD,
  FRAMEBUFFER_BINDING: 0x8CA6, RENDERBUFFER_BINDING: 0x8CA7, MAX_RENDERBUFFER_SIZE: 0x84E8, INVALID_FRAMEBUFFER_OPERATION: 0x506,
  UNPACK_FLIP_Y_WEBGL: 0x9240, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241, CONTEXT_LOST_WEBGL: 0x9242,
  UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243, BROWSER_DEFAULT_WEBGL: 0x9244,
};
for (let i = 0; i < 32; i++) GL['TEXTURE' + i] = 0x84C0 + i;

// pnames of getParameter by result kind
const P_INT = new Set([GL.MAX_TEXTURE_SIZE, GL.MAX_VERTEX_ATTRIBS, GL.MAX_TEXTURE_IMAGE_UNITS, GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS,
  GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS, GL.MAX_VARYING_VECTORS, GL.MAX_VERTEX_UNIFORM_VECTORS, GL.MAX_FRAGMENT_UNIFORM_VECTORS,
  GL.MAX_CUBE_MAP_TEXTURE_SIZE, GL.MAX_RENDERBUFFER_SIZE, GL.SUBPIXEL_BITS, GL.RED_BITS, GL.GREEN_BITS, GL.BLUE_BITS, GL.ALPHA_BITS,
  GL.DEPTH_BITS, GL.STENCIL_BITS, GL.ACTIVE_TEXTURE, GL.BLEND_DST_RGB, GL.BLEND_SRC_RGB, GL.BLEND_DST_ALPHA, GL.BLEND_SRC_ALPHA,
  GL.BLEND_EQUATION_RGB, GL.BLEND_EQUATION_ALPHA, GL.CULL_FACE_MODE, GL.FRONT_FACE, GL.DEPTH_FUNC, GL.STENCIL_CLEAR_VALUE, GL.STENCIL_FUNC,
  GL.STENCIL_FAIL, GL.STENCIL_PASS_DEPTH_FAIL, GL.STENCIL_PASS_DEPTH_PASS, GL.STENCIL_REF, GL.STENCIL_VALUE_MASK, GL.STENCIL_WRITEMASK,
  GL.STENCIL_BACK_FUNC, GL.STENCIL_BACK_FAIL, GL.STENCIL_BACK_PASS_DEPTH_FAIL, GL.STENCIL_BACK_PASS_DEPTH_PASS, GL.STENCIL_BACK_REF,
  GL.STENCIL_BACK_VALUE_MASK, GL.STENCIL_BACK_WRITEMASK, GL.PACK_ALIGNMENT, GL.UNPACK_ALIGNMENT, GL.GENERATE_MIPMAP_HINT,
  GL.SAMPLE_BUFFERS, GL.SAMPLES, GL.IMPLEMENTATION_COLOR_READ_FORMAT, GL.IMPLEMENTATION_COLOR_READ_TYPE]);
const P_FLOAT1 = new Set([GL.LINE_WIDTH, GL.DEPTH_CLEAR_VALUE, GL.POLYGON_OFFSET_FACTOR, GL.POLYGON_OFFSET_UNITS, GL.SAMPLE_COVERAGE_VALUE, 0x84FF]);
const P_BOOL = new Set([GL.BLEND, GL.CULL_FACE, GL.DEPTH_TEST, GL.DEPTH_WRITEMASK, GL.DITHER, GL.POLYGON_OFFSET_FILL,
  GL.SAMPLE_ALPHA_TO_COVERAGE, GL.SAMPLE_COVERAGE, GL.SAMPLE_COVERAGE_INVERT, GL.SCISSOR_TEST, GL.STENCIL_TEST]);

class WebGLObject { constructor(id) { this._id = id; this._deleted = false; } }
class WebGLBuffer extends WebGLObject {}
class WebGLTexture extends WebGLObject {}
class WebGLProgram extends WebGLObject {}
class WebGLShader extends WebGLObject { constructor(id, type) { super(id); this._type = type; this._src = ''; } }
class WebGLFramebuffer extends WebGLObject {}
class WebGLRenderbuffer extends WebGLObject {}
class WebGLVertexArrayObjectOES extends WebGLObject {}
class WebGLUniformLocation { constructor(id) { this._id = id; } }
class WebGLShaderPrecisionFormat { constructor(a) { this.rangeMin = a[0]; this.rangeMax = a[1]; this.precision = a[2]; } }

const id = o => (o ? o._id : 0);
const f32 = a => (a instanceof Float32Array ? a : Float32Array.from(a));
const i32 = a => (a instanceof Int32Array ? a : Int32Array.from(a));

// Driver workaround table matched against (vendor + ' ' + renderer + ' ' + version).
// Override via PMZ_GPU_WORKAROUNDS="flag1,flag2" or "none". Supported flags:
//   no_buffer_orphan, no_vao, no_instancing, no_highp_frag, no_packed_depth_stencil
const GPU_WORKAROUND_RULES = [
  { match: /Mali-400|Mali-450/i, flags: ['no_highp_frag'] },
];

class WebGLRenderingContext {
  // opts: { pmz, drawableWidth, drawableHeight, es3, hasVao, hasInstancing, gpuWorkarounds, debug (bool), onWarn(msg) }
  constructor(canvas, attrs, opts) {
    this.canvas = canvas;
    this._pmz = opts.pmz; this._dw = opts.drawableWidth; this._dh = opts.drawableHeight; this._es3 = !!opts.es3;
    this._warn = opts.onWarn || (() => {});
    this._attrs = Object.assign({ alpha: true, depth: true, stencil: false, antialias: true, premultipliedAlpha: true,
      preserveDrawingBuffer: false, powerPreference: 'default', failIfMajorPerformanceCaveat: false, desynchronized: false }, attrs || {});
    this._flipY = false; this._premul = false;
    this._fb = null;                                    // currently bound WebGLFramebuffer (null = default/window)
    this._vp = [0, 0, canvas.width, canvas.height];     // viewport/scissor as the game sees them (canvas coordinates)
    this._sc = [0, 0, canvas.width, canvas.height];
    this._exts = null; this._extObjs = {}; this.stubs = new Set();
    this._reg = { buf: new Map(), tex: new Map(), prog: new Map(), vao: new Map(), rb: new Map() };   // GL name -> wrapper, for getParameter(*_BINDING) (Effekseer saves/restores PIXI's bindings)
    const p = this._pmz;
    this._glExt = ' ' + p.getString(0x1F03).replace(/GL_/g, '') + ' ';
    this._vendor = p.getString(GL.VENDOR); this._renderer = p.getString(GL.RENDERER); this._version = p.getString(GL.VERSION);
    const idStr = this._vendor + ' ' + this._renderer + ' ' + this._version;
    const wa = new Set();
    const waEnv = (opts.gpuWorkarounds || '').trim();
    if (waEnv !== 'none') {
      for (const r of GPU_WORKAROUND_RULES) if (r.match.test(idStr)) for (const f of r.flags) wa.add(f);
      if (waEnv) for (const f of waEnv.split(',')) if (f.trim()) wa.add(f.trim());
    }
    this.workarounds = [...wa];
    if (!opts.probe && wa.has('no_buffer_orphan') && p.setOrphan) p.setOrphan(false);
    const hasVaoOpt = opts.hasVao !== undefined ? !!opts.hasVao : this._es3;
    const hasInstOpt = opts.hasInstancing !== undefined ? !!opts.hasInstancing : this._es3;
    this._hasVao = hasVaoOpt && !wa.has('no_vao');
    this._hasInstancing = hasInstOpt && !wa.has('no_instancing');
    this._hasUintIndex = this._es3 || this._glExt.includes(' OES_element_index_uint ');
    this._packedDS = (this._es3 || this._glExt.includes(' OES_packed_depth_stencil ')) && !wa.has('no_packed_depth_stencil');
    const hp = p.getShaderPrecisionFormat(GL.FRAGMENT_SHADER, GL.HIGH_FLOAT);
    this._fragHighp = !wa.has('no_highp_frag') && hp[2] > 0;
    this.caps = {
      es3: this._es3, hasVao: this._hasVao, hasInstancing: this._hasInstancing,
      uintIndex: this._hasUintIndex, packedDS: this._packedDS,
      fragHighp: this._fragHighp ? hp : [0, 0, 0],
      maxTexSize: p.getIntegerv(GL.MAX_TEXTURE_SIZE, 1)[0],
      maxTexUnits: p.getIntegerv(GL.MAX_TEXTURE_IMAGE_UNITS, 1)[0],
      workarounds: this.workarounds,
    };
    if (!opts.probe) { this._applyViewport(); this._applyScissor(); }   // probe contexts share the GL context but must not touch window state
  }
  getContextAttributes() { return Object.assign({}, this._attrs, { depth: false, stencil: true, antialias: false }); }
  isContextLost() { return false; }
  get drawingBufferWidth() { return this.canvas.width; }
  get drawingBufferHeight() { return this.canvas.height; }
  _stub(name) { if (!this.stubs.has(name)) { this.stubs.add(name); this._warn('webgl stub: ' + name); } }

  // ---- default framebuffer -> window mapping (letterbox, aspect kept) ----
  _map(x, y, w, h) {
    const cw = this.canvas.width || 1, ch = this.canvas.height || 1;
    const s = Math.min(this._dw / cw, this._dh / ch), ox = (this._dw - cw * s) / 2, oy = (this._dh - ch * s) / 2;
    const x0 = Math.round(ox + x * s), y0 = Math.round(oy + y * s), x1 = Math.round(ox + (x + w) * s), y1 = Math.round(oy + (y + h) * s);
    return [x0, y0, x1 - x0, y1 - y0];
  }
  _applyViewport() { const v = this._vp, p = this._pmz; if (this._fb) p.viewport(v[0], v[1], v[2], v[3]); else { const m = this._map(v[0], v[1], v[2], v[3]); p.viewport(m[0], m[1], m[2], m[3]); } }
  _applyScissor() { const v = this._sc, p = this._pmz; if (this._fb) p.scissor(v[0], v[1], v[2], v[3]); else { const m = this._map(v[0], v[1], v[2], v[3]); p.scissor(m[0], m[1], m[2], m[3]); } }
  viewport(x, y, w, h) { this._vp = [x, y, w, h]; this._applyViewport(); }
  scissor(x, y, w, h) { this._sc = [x, y, w, h]; this._applyScissor(); }
  bindFramebuffer(t, fb) {
    const was = !!this._fb; this._fb = fb || null; this._pmz.bindFramebuffer(t, id(fb));
    // PIXI skips viewport/scissor calls it believes are unchanged: re-issue them when switching between window and offscreen
    if (was !== !!this._fb) { this._applyViewport(); this._applyScissor(); }
  }

  // ---- simple state (straight through) ----
  activeTexture(t) { this._pmz.activeTexture(t); }
  blendColor(r, g, b, a) { this._pmz.blendColor(r, g, b, a); }
  blendEquation(m) { this._pmz.blendEquation(m); }
  blendEquationSeparate(a, b) { this._pmz.blendEquationSeparate(a, b); }
  blendFunc(a, b) { this._pmz.blendFunc(a, b); }
  blendFuncSeparate(a, b, c, d) { this._pmz.blendFuncSeparate(a, b, c, d); }
  clear(m) { this._pmz.clear(m); }
  clearColor(r, g, b, a) { this._pmz.clearColor(r, g, b, a); }
  clearDepth(d) { this._pmz.clearDepth(d); }
  clearStencil(s) { this._pmz.clearStencil(s); }
  colorMask(r, g, b, a) { this._pmz.colorMask(r, g, b, a); }
  cullFace(m) { this._pmz.cullFace(m); }
  depthFunc(f) { this._pmz.depthFunc(f); }
  depthMask(m) { this._pmz.depthMask(m); }
  depthRange(a, b) { this._pmz.depthRange(a, b); }
  disable(c) { this._pmz.disable(c); }
  enable(c) { this._pmz.enable(c); }
  frontFace(m) { this._pmz.frontFace(m); }
  hint(t, m) { this._pmz.hint(t, m); }
  lineWidth(w) { this._pmz.lineWidth(w); }
  polygonOffset(f, u) { this._pmz.polygonOffset(f, u); }
  sampleCoverage(v, i) { this._pmz.sampleCoverage(v, i); }
  stencilFunc(f, r, m) { this._pmz.stencilFunc(f, r, m); }
  stencilFuncSeparate(a, f, r, m) { this._pmz.stencilFuncSeparate(a, f, r, m); }
  stencilMask(m) { this._pmz.stencilMask(m); }
  stencilMaskSeparate(a, m) { this._pmz.stencilMaskSeparate(a, m); }
  stencilOp(a, b, c) { this._pmz.stencilOp(a, b, c); }
  stencilOpSeparate(f, a, b, c) { this._pmz.stencilOpSeparate(f, a, b, c); }
  flush() { this._pmz.flush(); }
  finish() { this._pmz.finish(); }
  isEnabled(c) { return this._pmz.isEnabled(c); }
  getError() { return this._pmz.getError(); }
  pixelStorei(p, v) {
    if (p === GL.UNPACK_FLIP_Y_WEBGL) this._flipY = !!v;
    else if (p === GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL) this._premul = !!v;
    else if (p === GL.UNPACK_COLORSPACE_CONVERSION_WEBGL) { /* no colour management */ }
    else { if (p === GL.UNPACK_ALIGNMENT) this._align = v; this._pmz.pixelStorei(p, v); }
  }
  getParameter(p) {
    const pm = this._pmz;
    if (P_INT.has(p)) return pm.getIntegerv(p, 1)[0];
    if (P_FLOAT1.has(p)) return pm.getFloatv(p, 1)[0];
    if (P_BOOL.has(p)) return pm.getBooleanv(p, 1)[0] !== 0;
    switch (p) {
      case GL.VIEWPORT: return new Int32Array(this._vp);
      case GL.SCISSOR_BOX: return new Int32Array(this._sc);
      case GL.MAX_VIEWPORT_DIMS: return new Int32Array(pm.getIntegerv(p, 2));
      case GL.ALIASED_LINE_WIDTH_RANGE: case GL.ALIASED_POINT_SIZE_RANGE: case GL.DEPTH_RANGE: return new Float32Array(pm.getFloatv(p, 2));
      case GL.BLEND_COLOR: case GL.COLOR_CLEAR_VALUE: return new Float32Array(pm.getFloatv(p, 4));
      case GL.COLOR_WRITEMASK: return pm.getBooleanv(p, 4).map(v => v !== 0);
      case GL.COMPRESSED_TEXTURE_FORMATS: return new Uint32Array(0);
      case GL.VENDOR: return 'WebKit'; case GL.RENDERER: return 'WebKit WebGL';
      case GL.VERSION: return 'WebGL 1.0 (' + this._version + ')';
      case GL.SHADING_LANGUAGE_VERSION: return 'WebGL GLSL ES 1.0 (' + pm.getString(GL.SHADING_LANGUAGE_VERSION) + ')';
      case 0x9245: return this._vendor; case 0x9246: return this._renderer;   // UNMASKED_VENDOR/RENDERER_WEBGL
      case GL.UNPACK_FLIP_Y_WEBGL: return this._flipY;
      case GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL: return this._premul;
      case GL.UNPACK_COLORSPACE_CONVERSION_WEBGL: return GL.BROWSER_DEFAULT_WEBGL;
      case GL.FRAMEBUFFER_BINDING: return this._fb;
      case GL.ARRAY_BUFFER_BINDING: case GL.ELEMENT_ARRAY_BUFFER_BINDING: return this._reg.buf.get(pm.getIntegerv(p, 1)[0]) || null;
      case GL.TEXTURE_BINDING_2D: return this._reg.tex.get(pm.getIntegerv(p, 1)[0]) || null;
      case GL.CURRENT_PROGRAM: return this._reg.prog.get(pm.getIntegerv(p, 1)[0]) || null;
      case GL.RENDERBUFFER_BINDING: return this._reg.rb.get(pm.getIntegerv(p, 1)[0]) || null;
      case 0x85B5: return this._hasVao ? (this._reg.vao.get(pm.getIntegerv(p, 1)[0]) || null) : null;   // VERTEX_ARRAY_BINDING(_OES)
      default: this._stub('getParameter(' + (typeof p === 'number' ? '0x' + p.toString(16) : String(p)) + ')'); return null;
    }
  }

  // ---- extensions ----
  getSupportedExtensions() {
    const l = ['WEBGL_lose_context', 'WEBGL_debug_renderer_info'];
    if (this._hasUintIndex) l.push('OES_element_index_uint');
    if (this._hasVao) l.push('OES_vertex_array_object');
    if (this._hasInstancing) l.push('ANGLE_instanced_arrays');
    if (this._es3 || this._glExt.includes(' OES_standard_derivatives ')) l.push('OES_standard_derivatives');
    if (this._glExt.includes(' EXT_texture_filter_anisotropic ')) l.push('EXT_texture_filter_anisotropic');
    return l;
  }
  getExtension(name) {
    if (this._extObjs[name] !== undefined) return this._extObjs[name];
    const pm = this._pmz; let o = null;
    if (this.getSupportedExtensions().includes(name)) {
      switch (name) {
        case 'OES_element_index_uint': o = {}; break;
        case 'WEBGL_lose_context': o = { loseContext() {}, restoreContext() {} }; break;
        case 'WEBGL_debug_renderer_info': o = { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 }; break;
        case 'OES_standard_derivatives': o = { FRAGMENT_SHADER_DERIVATIVE_HINT_OES: 0x8B8B }; break;
        case 'EXT_texture_filter_anisotropic': o = { TEXTURE_MAX_ANISOTROPY_EXT: 0x84FE, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84FF }; break;
        case 'OES_vertex_array_object': // GLES3 VAOs
          o = { VERTEX_ARRAY_BINDING_OES: 0x85B5,
            createVertexArrayOES: () => { const o = new WebGLVertexArrayObjectOES(pm.createVertexArray()); this._reg.vao.set(o._id, o); return o; },
            deleteVertexArrayOES: v => { if (v && !v._deleted) { v._deleted = true; this._reg.vao.delete(v._id); pm.deleteVertexArray(v._id); } },
            isVertexArrayOES: v => !!v && !v._deleted && pm.isVertexArray(v._id),
            bindVertexArrayOES: v => pm.bindVertexArray(id(v)) };
          break;
        case 'ANGLE_instanced_arrays':
          o = { VERTEX_ATTRIB_ARRAY_DIVISOR_ANGLE: 0x88FE,
            drawArraysInstancedANGLE: (m, f, c, n) => pm.drawArraysInstanced(m, f, c, n),
            drawElementsInstancedANGLE: (m, c, t, off, n) => pm.drawElementsInstanced(m, c, t, off, n),
            vertexAttribDivisorANGLE: (i, d) => pm.vertexAttribDivisor(i, d) };
          break;
      }
    }
    return (this._extObjs[name] = o);
  }

  // ---- buffers ----
  createBuffer() { const o = new WebGLBuffer(this._pmz.createBuffer()); this._reg.buf.set(o._id, o); return o; }
  deleteBuffer(b) { if (b && !b._deleted) { b._deleted = true; this._reg.buf.delete(b._id); this._pmz.deleteBuffer(b._id); } }
  isBuffer(b) { return !!b && !b._deleted; }
  bindBuffer(t, b) { this._pmz.bindBuffer(t, id(b)); }
  bufferData(t, d, u) { this._pmz.bufferData(t, d === null || d === undefined ? 0 : d, u); }
  bufferSubData(t, off, d) { this._pmz.bufferSubData(t, off, d); }
  getBufferParameter(t, p) { return this._pmz.getBufferParameter(t, p); }

  // ---- textures ----
  createTexture() { const o = new WebGLTexture(this._pmz.createTexture()); this._reg.tex.set(o._id, o); return o; }
  deleteTexture(t) { if (t && !t._deleted) { t._deleted = true; this._reg.tex.delete(t._id); this._pmz.deleteTexture(t._id); } }
  isTexture(t) { return !!t && !t._deleted; }
  bindTexture(t, tex) { this._pmz.bindTexture(t, id(tex)); }
  texParameteri(t, p, v) { this._pmz.texParameteri(t, p, v); }
  texParameterf(t, p, v) { this._pmz.texParameterf(t, p, v); }
  getTexParameter(t, p) { return this._pmz.getTexParameter(t, p); }
  generateMipmap(t) { this._pmz.generateMipmap(t); }
  copyTexImage2D(t, l, f, x, y, w, h, b) { this._pmz.copyTexImage2D(t, l, f, x, y, w, h, b); }
  copyTexSubImage2D(t, l, xo, yo, x, y, w, h) { this._pmz.copyTexSubImage2D(t, l, xo, yo, x, y, w, h); }
  compressedTexImage2D() { this._stub('compressedTexImage2D'); }
  compressedTexSubImage2D() { this._stub('compressedTexSubImage2D'); }

  // Read RGBA pixels out of a DOM-ish source: our Image ({_pix}), canvas, ImageData. Returns {width,height,data|null}.
  _srcPixels(s) {
    if (!s) return { width: 0, height: 0, data: null };
    if (s._pix) return s._pix;                                            // decoded Image
    if (s.data && s.width && s.height && !s.tagName) return { width: s.width, height: s.height, data: s.data };   // ImageData
    if (s.tagName === 'CANVAS') {
      const w = s.width | 0, h = s.height | 0;
      if (s._cv) return { width: w, height: h, cv: s._cv, data: null };     // canvas with a Cairo surface: uploaded in C
      return { width: w, height: h, data: new Uint8Array(w * h * 4) };       // blank canvas: transparent black
    }
    if (s.tagName === 'VIDEO') {
      if (s._vidId > 0 && s.readyState >= 2) return { width: s.videoWidth | 0, height: s.videoHeight | 0, vid: s._vidId, data: null };
      return { width: 1, height: 1, data: new Uint8Array(4) };
    }
    if (s.tagName === 'IMG') return { width: s.naturalWidth | 0, height: s.naturalHeight | 0, data: null };   // not decoded (yet)
    this._stub('texImage2D source ' + (s.tagName || typeof s)); return { width: 1, height: 1, data: new Uint8Array(4) };
  }
  // RGBA8 -> requested WebGL format (RGB / LUMINANCE / ALPHA / LUMINANCE_ALPHA); RGBA passes through
  _convert(px, format) {
    if (format === GL.RGBA || !px.data) return px.data;
    const n = px.width * px.height, s = px.data;
    const ch = format === GL.RGB ? 3 : format === GL.LUMINANCE_ALPHA ? 2 : 1, o = new Uint8Array(n * ch);
    for (let i = 0; i < n; i++) {
      if (format === GL.RGB) { o[i * 3] = s[i * 4]; o[i * 3 + 1] = s[i * 4 + 1]; o[i * 3 + 2] = s[i * 4 + 2]; }
      else if (format === GL.ALPHA) o[i] = s[i * 4 + 3];
      else if (format === GL.LUMINANCE) o[i] = s[i * 4];
      else { o[i * 2] = s[i * 4]; o[i * 2 + 1] = s[i * 4 + 3]; }
    }
    return o;
  }
  texImage2D(target, level, ifmt, a, b, c, d, e, f) {
    const p = this._pmz;
    if (arguments.length >= 9) { p.texImage2D(target, level, ifmt, a, b, c, d, e, f || null, this._flipY, this._premul); return; }
    // (target, level, internalformat, format, type, source)
    let px = this._srcPixels(c);
    if (b !== GL.UNSIGNED_BYTE) this._stub('texImage2D(source) type 0x' + b.toString(16));
    if (px.vid && p.vidUploadTex) { p.vidUploadTex(px.vid, target, level, ifmt, a, b, this._flipY, this._premul, false, 0, 0); return; }
    if (px.cv) {
      if (a === GL.RGBA && px.width > 0 && px.height > 0) { p.texImageCv(target, level, ifmt, a, b, px.cv, this._flipY, this._premul, false, 0, 0); return; }
      px = { width: px.width, height: px.height, data: px.width > 0 && px.height > 0 ? p.cvReadRGBA(px.cv) : null };
    }
    if (!px.data) { p.texImage2D(target, level, ifmt, px.width, px.height, 0, a, b, null, false, false); return; }
    p.pixelStorei(GL.UNPACK_ALIGNMENT, 1);   // converted rows may not be 4-byte multiples
    p.texImage2D(target, level, ifmt, px.width, px.height, 0, a, b, this._convert(px, a), this._flipY, this._premul);
    p.pixelStorei(GL.UNPACK_ALIGNMENT, this._align || 4);
  }
  texSubImage2D(target, level, xo, yo, a, b, c, d, e, f) {
    const p = this._pmz;
    if (arguments.length >= 9) { p.texSubImage2D(target, level, xo, yo, a, b, c, d, e, this._flipY, this._premul); return; }
    // (target, level, xoffset, yoffset, format, type, source)
    let px = this._srcPixels(c);
    if (px.vid && p.vidUploadTex) { p.vidUploadTex(px.vid, target, level, 0, a, b, this._flipY, this._premul, true, xo, yo); return; }
    if (px.cv) {
      if (a === GL.RGBA && px.width > 0 && px.height > 0) { p.texImageCv(target, level, 0, a, b, px.cv, this._flipY, this._premul, true, xo, yo); return; }
      px = { width: px.width, height: px.height, data: px.width > 0 && px.height > 0 ? p.cvReadRGBA(px.cv) : null };
    }
    if (!px.data) return;
    p.pixelStorei(GL.UNPACK_ALIGNMENT, 1);
    p.texSubImage2D(target, level, xo, yo, px.width, px.height, a, b, this._convert(px, a), this._flipY, this._premul);
    p.pixelStorei(GL.UNPACK_ALIGNMENT, this._align || 4);
  }
  readPixels(x, y, w, h, fmt, type, buf) { this._pmz.readPixels(x, y, w, h, fmt, type, buf); }   // window pixels when the default framebuffer is bound (physical coordinates)

  // ---- framebuffers / renderbuffers ----
  createFramebuffer() { return new WebGLFramebuffer(this._pmz.createFramebuffer()); }
  deleteFramebuffer(f) { if (f && !f._deleted) { f._deleted = true; this._pmz.deleteFramebuffer(f._id); } }
  isFramebuffer(f) { return !!f && !f._deleted; }
  framebufferTexture2D(t, a, tt, tex, l) { this._pmz.framebufferTexture2D(t, a, tt, id(tex), l); }
  framebufferRenderbuffer(t, a, rt, rb) {
    const rid = id(rb);
    if (a === GL.DEPTH_STENCIL_ATTACHMENT && !this._es3) {
      // GLES 2.0 does not accept GL_DEPTH_STENCIL_ATTACHMENT: attach DEPTH + STENCIL separately (or STENCIL only without OES_packed_depth_stencil).
      if (this._packedDS) this._pmz.framebufferRenderbuffer(t, GL.DEPTH_ATTACHMENT, rt, rid);
      this._pmz.framebufferRenderbuffer(t, GL.STENCIL_ATTACHMENT, rt, rid);
      return;
    }
    this._pmz.framebufferRenderbuffer(t, a, rt, rid);
  }
  checkFramebufferStatus(t) { return this._pmz.checkFramebufferStatus(t); }
  getFramebufferAttachmentParameter(t, a, p) {
    const att = (a === GL.DEPTH_STENCIL_ATTACHMENT && !this._es3) ? GL.STENCIL_ATTACHMENT : a;
    return this._pmz.getFramebufferAttachmentParameter(t, att, p);
  }
  createRenderbuffer() { const o = new WebGLRenderbuffer(this._pmz.createRenderbuffer()); this._reg.rb.set(o._id, o); return o; }
  deleteRenderbuffer(r) { if (r && !r._deleted) { r._deleted = true; this._reg.rb.delete(r._id); this._pmz.deleteRenderbuffer(r._id); } }
  isRenderbuffer(r) { return !!r && !r._deleted; }
  bindRenderbuffer(t, r) { this._pmz.bindRenderbuffer(t, id(r)); }
  renderbufferStorage(t, f, w, h) {
    const fmt = f === GL.DEPTH_STENCIL ? (this._packedDS ? 0x88F0 : GL.STENCIL_INDEX8) : f;   // DEPTH24_STENCIL8 when supported, else STENCIL_INDEX8
    this._pmz.renderbufferStorage(t, fmt, w, h);
  }
  getRenderbufferParameter(t, p) { return this._pmz.getRenderbufferParameter(t, p); }

  // ---- shaders / programs ----
  createShader(t) { return new WebGLShader(this._pmz.createShader(t), t); }
  deleteShader(s) { if (s && !s._deleted) { s._deleted = true; this._pmz.deleteShader(s._id); } }
  isShader(s) { return !!s && !s._deleted; }
  shaderSource(s, src) {
    let text = String(src);
    if (s._type === GL.FRAGMENT_SHADER && !this._fragHighp) {
      text = text.replace(/\bprecision\s+highp\s+float\s*;/g, 'precision mediump float;');
    }
    s._src = text; this._pmz.shaderSource(s._id, text);
  }
  getShaderSource(s) { return s._src; }
  compileShader(s) { this._pmz.compileShader(s._id); }
  getShaderParameter(s, p) { const v = this._pmz.getShaderParameter(s._id, p); return (p === GL.COMPILE_STATUS || p === GL.DELETE_STATUS) ? v !== 0 : v; }
  getShaderInfoLog(s) { return this._pmz.getShaderInfoLog(s._id); }
  getShaderPrecisionFormat(st, pt) {
    if (st === GL.FRAGMENT_SHADER && pt === GL.HIGH_FLOAT && !this._fragHighp) return new WebGLShaderPrecisionFormat([0, 0, 0]);
    return new WebGLShaderPrecisionFormat(this._pmz.getShaderPrecisionFormat(st, pt));
  }
  createProgram() { const o = new WebGLProgram(this._pmz.createProgram()); this._reg.prog.set(o._id, o); return o; }
  deleteProgram(p) { if (p && !p._deleted) { p._deleted = true; this._reg.prog.delete(p._id); this._pmz.deleteProgram(p._id); } }
  isProgram(p) { return !!p && !p._deleted; }
  attachShader(p, s) { this._pmz.attachShader(p._id, s._id); }
  detachShader(p, s) { this._pmz.detachShader(p._id, s._id); }
  linkProgram(p) { this._pmz.linkProgram(p._id); }
  validateProgram(p) { this._pmz.validateProgram(p._id); }
  useProgram(p) { this._pmz.useProgram(id(p)); }
  getProgramParameter(p, n) {
    const v = this._pmz.getProgramParameter(p._id, n);
    return (n === GL.DELETE_STATUS || n === GL.LINK_STATUS || n === GL.VALIDATE_STATUS) ? v !== 0 : v;
  }
  getProgramInfoLog(p) { return this._pmz.getProgramInfoLog(p._id); }
  bindAttribLocation(p, i, n) { this._pmz.bindAttribLocation(p._id, i, n); }
  getAttribLocation(p, n) { return this._pmz.getAttribLocation(p._id, n); }
  getUniformLocation(p, n) { const l = this._pmz.getUniformLocation(p._id, n); return l < 0 ? null : new WebGLUniformLocation(l); }
  getActiveUniform(p, i) { return this._pmz.getActiveUniform(p._id, i); }
  getActiveAttrib(p, i) { return this._pmz.getActiveAttrib(p._id, i); }
  getUniform(p, l) { this._stub('getUniform (returns first component only)'); return this._pmz.getUniform(p._id, l._id)[0]; }

  // ---- uniforms (null location = ignored, like WebGL) ----
  uniform1f(l, x) { if (l) this._pmz.uniform1f(l._id, x); }
  uniform2f(l, x, y) { if (l) this._pmz.uniform2f(l._id, x, y); }
  uniform3f(l, x, y, z) { if (l) this._pmz.uniform3f(l._id, x, y, z); }
  uniform4f(l, x, y, z, w) { if (l) this._pmz.uniform4f(l._id, x, y, z, w); }
  uniform1i(l, x) { if (l) this._pmz.uniform1i(l._id, x); }
  uniform2i(l, x, y) { if (l) this._pmz.uniform2i(l._id, x, y); }
  uniform3i(l, x, y, z) { if (l) this._pmz.uniform3i(l._id, x, y, z); }
  uniform4i(l, x, y, z, w) { if (l) this._pmz.uniform4i(l._id, x, y, z, w); }
  uniform1fv(l, v) { if (l) this._pmz.uniform1fv(l._id, f32(v)); }
  uniform2fv(l, v) { if (l) this._pmz.uniform2fv(l._id, f32(v)); }
  uniform3fv(l, v) { if (l) this._pmz.uniform3fv(l._id, f32(v)); }
  uniform4fv(l, v) { if (l) this._pmz.uniform4fv(l._id, f32(v)); }
  uniform1iv(l, v) { if (l) this._pmz.uniform1iv(l._id, i32(v)); }
  uniform2iv(l, v) { if (l) this._pmz.uniform2iv(l._id, i32(v)); }
  uniform3iv(l, v) { if (l) this._pmz.uniform3iv(l._id, i32(v)); }
  uniform4iv(l, v) { if (l) this._pmz.uniform4iv(l._id, i32(v)); }
  uniformMatrix2fv(l, t, v) { if (l) this._pmz.uniformMatrix2fv(l._id, t, f32(v)); }
  uniformMatrix3fv(l, t, v) { if (l) this._pmz.uniformMatrix3fv(l._id, t, f32(v)); }
  uniformMatrix4fv(l, t, v) { if (l) this._pmz.uniformMatrix4fv(l._id, t, f32(v)); }

  // ---- vertex attributes / drawing ----
  enableVertexAttribArray(i) { this._pmz.enableVertexAttribArray(i); }
  disableVertexAttribArray(i) { this._pmz.disableVertexAttribArray(i); }
  vertexAttribPointer(i, s, t, n, st, o) { this._pmz.vertexAttribPointer(i, s, t, n, st, o); }
  vertexAttrib1f(i, x) { this._pmz.vertexAttrib1f(i, x); }
  vertexAttrib2f(i, x, y) { this._pmz.vertexAttrib2f(i, x, y); }
  vertexAttrib3f(i, x, y, z) { this._pmz.vertexAttrib3f(i, x, y, z); }
  vertexAttrib4f(i, x, y, z, w) { this._pmz.vertexAttrib4f(i, x, y, z, w); }
  vertexAttrib1fv(i, v) { this._pmz.vertexAttrib1fv(i, f32(v)); }
  vertexAttrib2fv(i, v) { this._pmz.vertexAttrib2fv(i, f32(v)); }
  vertexAttrib3fv(i, v) { this._pmz.vertexAttrib3fv(i, f32(v)); }
  vertexAttrib4fv(i, v) { this._pmz.vertexAttrib4fv(i, f32(v)); }
  getVertexAttrib(i, p) { const v = this._pmz.getVertexAttrib(i, p); return p === GL.VERTEX_ATTRIB_ARRAY_ENABLED || p === GL.VERTEX_ATTRIB_ARRAY_NORMALIZED ? v !== 0 : v; }
  getVertexAttribOffset(i, p) { return this._pmz.getVertexAttribOffset(i, p); }
  drawArrays(m, f, c) { this._pmz.drawArrays(m, f, c); }
  drawElements(m, c, t, o) { this._pmz.drawElements(m, c, t, o); }
}
Object.assign(WebGLRenderingContext, GL);
Object.assign(WebGLRenderingContext.prototype, GL);

// GL error debugging: after every wrapped call run glGetError and report each (method, error, call site) once.
function installDebug(pmz, report) {
  const stats = { calls: 0 };
  const proto = WebGLRenderingContext.prototype;
  const seen = new Set();
  const names = { 0x500: 'INVALID_ENUM', 0x501: 'INVALID_VALUE', 0x502: 'INVALID_OPERATION', 0x505: 'OUT_OF_MEMORY', 0x506: 'INVALID_FRAMEBUFFER_OPERATION' };
  while (pmz.getError());   // drain
  for (const name of Object.getOwnPropertyNames(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (typeof d.value !== 'function' || name === 'constructor' || name === 'getError' || name[0] === '_') continue;
    const orig = d.value;
    proto[name] = function (...args) {
      const r = orig.apply(this, args); stats.calls++;
      let e;
      while ((e = pmz.getError())) {
        const stack = String(new Error().stack).split('\n').slice(2).find(l => !l.includes('webgl.js')) || '?';
        const key = name + ':' + e + ':' + stack;
        if (seen.has(key)) continue; seen.add(key);
        report(`GL error ${names[e] || '0x' + e.toString(16)} in gl.${name}(${args.slice(0, 4).map(a => typeof a === 'number' ? '0x' + a.toString(16) : typeof a === 'object' && a ? a.constructor.name : String(a)).join(', ')}) at ${stack.trim()}`);
      }
      return r;
    };
  }
  return stats;
}

module.exports = { WebGLRenderingContext, WebGLBuffer, WebGLTexture, WebGLProgram, WebGLShader, WebGLFramebuffer, WebGLRenderbuffer, WebGLUniformLocation, WebGLShaderPrecisionFormat, GL, installDebug };
