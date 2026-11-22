// pmzrt: native rendering/input backend (N-API, plain C). M1-2 skeleton: SDL2 window + GLES2 context,
// event polling, a test triangle. The real WebGL1 binding comes next.
#define NAPI_VERSION 8
#include <node_api.h>
#include <SDL.h>
#include "pmzrt_gl.h"
#include <png.h>
#include <stdio.h>
#include <setjmp.h>
#include <jpeglib.h>
#include <webp/decode.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <stdio.h>

static SDL_Window *g_win;
static SDL_GLContext g_ctx;
static int g_inited, g_es3;

#define CHECK(call) do { napi_status s_ = (call); if (s_ != napi_ok) { napi_throw_error(env, NULL, "napi call failed: " #call); return NULL; } } while (0)

static napi_value throw_sdl(napi_env env, const char *what) {
  char buf[512];
  snprintf(buf, sizeof buf, "%s: %s", what, SDL_GetError());
  napi_throw_error(env, NULL, buf);
  return NULL;
}

static void set_str(napi_env env, napi_value o, const char *k, const char *v) {
  napi_value s; napi_create_string_utf8(env, v ? v : "", NAPI_AUTO_LENGTH, &s); napi_set_named_property(env, o, k, s);
}
static void set_int(napi_env env, napi_value o, const char *k, double v) {
  napi_value n; napi_create_double(env, v, &n); napi_set_named_property(env, o, k, n);
}

static int get_int_prop(napi_env env, napi_value o, const char *k, int def) {
  bool has = false; napi_has_named_property(env, o, k, &has);
  if (!has) return def;
  napi_value v; napi_get_named_property(env, o, k, &v);
  napi_valuetype t; napi_typeof(env, v, &t);
  if (t == napi_boolean) { bool b; napi_get_value_bool(env, v, &b); return b; }
  if (t == napi_number) { int32_t i; napi_get_value_int32(env, v, &i); return i; }
  return def;
}

static napi_value Init_(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1], opts;
  CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  if (g_inited) { napi_throw_error(env, NULL, "already initialised"); return NULL; }
  opts = argc > 0 ? argv[0] : NULL;
  int w = 640, h = 480, fs = 1, vsync = 1; char title[128] = "pmzrt";
  if (opts) {
    w = get_int_prop(env, opts, "width", w); h = get_int_prop(env, opts, "height", h);
    fs = get_int_prop(env, opts, "fullscreen", fs); vsync = get_int_prop(env, opts, "vsync", vsync);
    bool has = false; napi_has_named_property(env, opts, "title", &has);
    if (has) { napi_value t; size_t n; napi_get_named_property(env, opts, "title", &t); napi_get_value_string_utf8(env, t, title, sizeof title, &n); }
  }
  SDL_SetHint("SDL_VIDEO_WAYLAND_WMCLASS", "pmzrt");
  if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_GAMECONTROLLER | SDL_INIT_EVENTS) != 0) return throw_sdl(env, "SDL_Init");
  const char *gles_env = getenv("PMZ_GLES");
  int force_es2 = gles_env && gles_env[0] == '2';
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, force_es2 ? 2 : 3);   // ES 3.0 when available; PMZ_GLES=2 forces ES 2.0
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 0);
  SDL_GL_SetAttribute(SDL_GL_RED_SIZE, 8); SDL_GL_SetAttribute(SDL_GL_GREEN_SIZE, 8);
  SDL_GL_SetAttribute(SDL_GL_BLUE_SIZE, 8); SDL_GL_SetAttribute(SDL_GL_ALPHA_SIZE, 8);
  SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 0); SDL_GL_SetAttribute(SDL_GL_STENCIL_SIZE, 8);
  SDL_GL_SetAttribute(SDL_GL_MULTISAMPLEBUFFERS, 0); SDL_GL_SetAttribute(SDL_GL_MULTISAMPLESAMPLES, 0);
  Uint32 flags = SDL_WINDOW_OPENGL | SDL_WINDOW_SHOWN | (fs ? SDL_WINDOW_FULLSCREEN_DESKTOP : 0);
  g_win = SDL_CreateWindow(title, SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED, w, h, flags);
  if (!g_win) { napi_value e = throw_sdl(env, "SDL_CreateWindow"); SDL_Quit(); return e; }
  g_ctx = SDL_GL_CreateContext(g_win);
  g_es3 = (!force_es2) && (g_ctx != NULL);
  if (!g_ctx && !force_es2) {   // fall back to a plain ES 2.0 context
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 2);
    g_ctx = SDL_GL_CreateContext(g_win);
    g_es3 = 0;
  }
  if (!g_ctx) { napi_value e = throw_sdl(env, "SDL_GL_CreateContext"); SDL_DestroyWindow(g_win); g_win = NULL; SDL_Quit(); return e; }
  const char *missing = pmz_gl_load(g_es3);
  if (missing) {
    char buf[256]; snprintf(buf, sizeof buf, "pmz_gl_load: missing GLES symbol %s", missing);
    SDL_GL_DeleteContext(g_ctx); g_ctx = NULL; SDL_DestroyWindow(g_win); g_win = NULL; SDL_Quit();
    napi_throw_error(env, NULL, buf); return NULL;
  }
  const char *gl_ver = (const char *)glGetString(GL_VERSION);
  if (g_es3 && (!gl_ver || !strstr(gl_ver, "OpenGL ES 3."))) { g_es3 = 0; pmz_gl_load(0); }
  SDL_GL_SetSwapInterval(vsync ? 1 : 0);
  int nj = SDL_NumJoysticks();
  for (int i = 0; i < nj; i++) if (SDL_IsGameController(i)) SDL_GameControllerOpen(i);
  g_inited = 1;

  napi_value r; CHECK(napi_create_object(env, &r));
  set_str(env, r, "driver", SDL_GetCurrentVideoDriver());
  set_str(env, r, "glVendor", (const char *)glGetString(GL_VENDOR));
  set_str(env, r, "glRenderer", (const char *)glGetString(GL_RENDERER));
  set_str(env, r, "glVersion", gl_ver);
  int dw = 0, dh = 0; SDL_GL_GetDrawableSize(g_win, &dw, &dh);
  set_int(env, r, "drawableWidth", dw); set_int(env, r, "drawableHeight", dh);
  set_int(env, r, "joysticks", nj);
  set_int(env, r, "es3", g_es3);
  set_int(env, r, "hasVao", g_has_vao);
  set_int(env, r, "hasInstancing", g_has_instancing);
  return r;
}

static void push(napi_env env, napi_value arr, uint32_t *n, napi_value o) { napi_set_element(env, arr, (*n)++, o); }

static napi_value PollEvents(napi_env env, napi_callback_info info) {
  napi_value arr; CHECK(napi_create_array(env, &arr));
  uint32_t n = 0; SDL_Event e;
  while (SDL_PollEvent(&e)) {
    napi_value o; napi_create_object(env, &o);
    switch (e.type) {
    case SDL_QUIT: set_str(env, o, "type", "quit"); break;
    case SDL_KEYDOWN: case SDL_KEYUP:
      set_str(env, o, "type", e.type == SDL_KEYDOWN ? "keydown" : "keyup");
      set_int(env, o, "keycode", e.key.keysym.sym);
      set_str(env, o, "scancode", SDL_GetScancodeName(e.key.keysym.scancode));
      set_int(env, o, "repeat", e.key.repeat); break;
    case SDL_CONTROLLERBUTTONDOWN: case SDL_CONTROLLERBUTTONUP:
      set_str(env, o, "type", e.type == SDL_CONTROLLERBUTTONDOWN ? "buttondown" : "buttonup");
      set_str(env, o, "button", SDL_GameControllerGetStringForButton((SDL_GameControllerButton)e.cbutton.button));
      set_int(env, o, "which", e.cbutton.which); break;
    case SDL_CONTROLLERAXISMOTION:
      set_str(env, o, "type", "axis");
      set_str(env, o, "axis", SDL_GameControllerGetStringForAxis((SDL_GameControllerAxis)e.caxis.axis));
      set_int(env, o, "value", e.caxis.value); set_int(env, o, "which", e.caxis.which); break;
    case SDL_CONTROLLERDEVICEADDED: {
      SDL_GameController *c = SDL_GameControllerOpen(e.cdevice.which);
      set_str(env, o, "type", "controlleradded");
      set_str(env, o, "name", c ? SDL_GameControllerName(c) : "(open failed)");
      set_int(env, o, "which", e.cdevice.which); break; }
    case SDL_CONTROLLERDEVICEREMOVED: {
      SDL_GameController *c = SDL_GameControllerFromInstanceID(e.cdevice.which);
      set_str(env, o, "type", "controllerremoved"); set_int(env, o, "which", e.cdevice.which);
      if (c) SDL_GameControllerClose(c);
      break; }
    case SDL_WINDOWEVENT: {
      const char *nm = NULL;
      switch (e.window.event) {
      case SDL_WINDOWEVENT_FOCUS_GAINED: nm = "focus"; break;
      case SDL_WINDOWEVENT_FOCUS_LOST: nm = "blur"; break;
      case SDL_WINDOWEVENT_RESIZED: nm = "resize"; break;
      case SDL_WINDOWEVENT_SIZE_CHANGED: nm = "sizechanged"; break;
      case SDL_WINDOWEVENT_CLOSE: nm = "close"; break;
      }
      if (!nm) continue;
      set_str(env, o, "type", "window"); set_str(env, o, "event", nm);
      set_int(env, o, "data1", e.window.data1); set_int(env, o, "data2", e.window.data2); break; }
    default: continue;
    }
    push(env, arr, &n, o);
  }
  return arr;
}

static napi_value Swap(napi_env env, napi_callback_info info) {
  if (g_win) SDL_GL_SwapWindow(g_win);
  return NULL;
}

static void au_close(void);
static void vid_close_all(void);
static napi_value Shutdown(napi_env env, napi_callback_info info) {
  vid_close_all();
  au_close();
  if (g_ctx) { SDL_GL_DeleteContext(g_ctx); g_ctx = NULL; }
  if (g_win) { SDL_DestroyWindow(g_win); g_win = NULL; }
  if (g_inited) { SDL_Quit(); g_inited = 0; }
  return NULL;
}

static double arg_d(napi_env env, napi_value *argv, size_t argc, size_t i) {
  double d = 0; if (i < argc) napi_get_value_double(env, argv[i], &d); return d;
}

static napi_value GlClearColor(napi_env env, napi_callback_info info) {
  size_t argc = 4; napi_value a[4]; napi_get_cb_info(env, info, &argc, a, NULL, NULL);
  glClearColor((float)arg_d(env, a, argc, 0), (float)arg_d(env, a, argc, 1), (float)arg_d(env, a, argc, 2), (float)arg_d(env, a, argc, 3));
  return NULL;
}
static napi_value GlClear(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value a[1]; napi_get_cb_info(env, info, &argc, a, NULL, NULL);
  glClear((GLbitfield)arg_d(env, a, argc, 0)); return NULL;
}
static napi_value GlViewport(napi_env env, napi_callback_info info) {
  size_t argc = 4; napi_value a[4]; napi_get_cb_info(env, info, &argc, a, NULL, NULL);
  glViewport((int)arg_d(env, a, argc, 0), (int)arg_d(env, a, argc, 1), (int)arg_d(env, a, argc, 2), (int)arg_d(env, a, argc, 3)); return NULL;
}

static GLuint g_prog, g_vbo; static GLint g_uAngle;
static GLuint compile(GLenum type, const char *src) {
  GLuint s = glCreateShader(type); glShaderSource(s, 1, &src, NULL); glCompileShader(s);
  GLint ok = 0; glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) { char log[512]; glGetShaderInfoLog(s, sizeof log, NULL, log); fprintf(stderr, "shader: %s\n", log); }
  return s;
}
static napi_value DrawTestTriangle(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value a[1]; napi_get_cb_info(env, info, &argc, a, NULL, NULL);
  float t = (float)arg_d(env, a, argc, 0);
  if (!g_prog) {
    const char *vs = "attribute vec2 p; attribute vec3 c; uniform float a; varying vec3 vc;\n"
      "void main(){ float s=sin(a), co=cos(a); gl_Position=vec4(co*p.x-s*p.y, (s*p.x+co*p.y)*1.333, 0.0, 1.0); vc=c; }";
    const char *fs = "precision mediump float; varying vec3 vc; void main(){ gl_FragColor=vec4(vc,1.0); }";
    g_prog = glCreateProgram();
    glAttachShader(g_prog, compile(GL_VERTEX_SHADER, vs)); glAttachShader(g_prog, compile(GL_FRAGMENT_SHADER, fs));
    glBindAttribLocation(g_prog, 0, "p"); glBindAttribLocation(g_prog, 1, "c");
    glLinkProgram(g_prog);
    GLint ok = 0; glGetProgramiv(g_prog, GL_LINK_STATUS, &ok);
    if (!ok) { napi_throw_error(env, NULL, "triangle program link failed"); return NULL; }
    g_uAngle = glGetUniformLocation(g_prog, "a");
    static const float v[] = { 0.0f, 0.6f, 1, 0, 0,  -0.52f, -0.3f, 0, 1, 0,  0.52f, -0.3f, 0, 0, 1 };
    glGenBuffers(1, &g_vbo); glBindBuffer(GL_ARRAY_BUFFER, g_vbo); glBufferData(GL_ARRAY_BUFFER, sizeof v, v, GL_STATIC_DRAW);
  }
  glUseProgram(g_prog); glUniform1f(g_uAngle, t);
  glBindBuffer(GL_ARRAY_BUFFER, g_vbo);
  glEnableVertexAttribArray(0); glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 20, (void *)0);
  glEnableVertexAttribArray(1); glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, 20, (void *)8);
  glDrawArrays(GL_TRIANGLES, 0, 3);
  return NULL;
}


// ===================================================================================================
// WebGL1 passthrough: generic GLES calls, one-to-one with WebGLRenderingContext methods (see webgl.js).
// Objects are plain GL names (numbers). Typed arrays are passed zero-copy.
// ===================================================================================================
typedef struct { const char *name; napi_callback fn; } Reg;
static Reg g_regs[512]; static int g_nregs;
static void reg(const char *n, napi_callback f) { g_regs[g_nregs].name = n; g_regs[g_nregs].fn = f; g_nregs++; }

static double argd(napi_env env, napi_value v) {
  napi_valuetype t; if (napi_typeof(env, v, &t) != napi_ok) return 0;
  if (t == napi_number) { double d; napi_get_value_double(env, v, &d); return d; }
  if (t == napi_boolean) { bool b; napi_get_value_bool(env, v, &b); return b; }
  return 0;
}
// Typed array / ArrayBuffer / DataView -> raw pointer + byte length (data pointer already includes the view offset).
static int argbytes(napi_env env, napi_value v, void **p, size_t *len) {
  bool b = false; *p = NULL; *len = 0;
  napi_is_typedarray(env, v, &b);
  if (b) {
    napi_typedarray_type ty; size_t n, off; napi_value ab;
    if (napi_get_typedarray_info(env, v, &ty, &n, p, &ab, &off) != napi_ok) return 0;
    size_t sz = 1;
    switch (ty) { case napi_int16_array: case napi_uint16_array: sz = 2; break;
      case napi_int32_array: case napi_uint32_array: case napi_float32_array: sz = 4; break;
      case napi_float64_array: case napi_bigint64_array: case napi_biguint64_array: sz = 8; break; default: break; }
    *len = n * sz; return 1;
  }
  napi_is_arraybuffer(env, v, &b);
  if (b) return napi_get_arraybuffer_info(env, v, p, len) == napi_ok;
  napi_is_dataview(env, v, &b);
  if (b) { napi_value ab; size_t off; return napi_get_dataview_info(env, v, len, p, &ab, &off) == napi_ok; }
  return 0;
}
static napi_value ret_d(napi_env env, double d) { napi_value r; napi_create_double(env, d, &r); return r; }
static napi_value ret_b(napi_env env, int b) { napi_value r; napi_get_boolean(env, b != 0, &r); return r; }
static napi_value ret_str(napi_env env, const char *s) { napi_value r; napi_create_string_utf8(env, s ? s : "", NAPI_AUTO_LENGTH, &r); return r; }
static napi_value ret_null(napi_env env) { napi_value r; napi_get_null(env, &r); return r; }
static napi_value ret_arr_d(napi_env env, const double *v, int n) {
  napi_value a; napi_create_array_with_length(env, n, &a);
  for (int i = 0; i < n; i++) napi_set_element(env, a, i, ret_d(env, v[i]));
  return a;
}
static char *arg_utf8(napi_env env, napi_value v) {   // malloc'ed copy
  size_t n = 0; if (napi_get_value_string_utf8(env, v, NULL, 0, &n) != napi_ok) return NULL;
  char *s = malloc(n + 1); napi_get_value_string_utf8(env, v, s, n + 1, &n); s[n] = 0; return s;
}

#define BEGIN(n) size_t argc_ = (n); napi_value a_[(n) + 1]; napi_get_cb_info(env, info, &argc_, a_, NULL, NULL); \
  for (size_t i_ = argc_; i_ <= (n); i_++) napi_get_undefined(env, &a_[i_])
#define D(i) argd(env, a_[i])
#define I(i) ((GLint)D(i))
#define U(i) ((GLuint)D(i))
#define E(i) ((GLenum)(uint32_t)D(i))
#define F(i) ((GLfloat)D(i))
#define B(i) (D(i) != 0)
#define PTR(i) ((const void *)(uintptr_t)D(i))   // buffer offsets
// DEF: void function; DEFR: the body returns the napi_value itself. Both register themselves for export (variadic: bodies contain commas).
#define DEF(js, n, ...) \
  static napi_value f_##js(napi_env env, napi_callback_info info) { BEGIN(n); __VA_ARGS__; return NULL; } \
  __attribute__((constructor)) static void r_##js(void) { reg(#js, f_##js); }
#define DEFR(js, n, ...) \
  static napi_value f_##js(napi_env env, napi_callback_info info) { BEGIN(n); __VA_ARGS__ } \
  __attribute__((constructor)) static void r_##js(void) { reg(#js, f_##js); }

static int g_unpackAlign = 4, g_packAlign = 4;
static GLenum g_softErr;   // errors we detect ourselves (e.g. too-small pixel buffer), reported by getError

// ---- state ----
DEF(activeTexture, 1, glActiveTexture(E(0)))
DEF(blendColor, 4, glBlendColor(F(0), F(1), F(2), F(3)))
DEF(blendEquation, 1, glBlendEquation(E(0)))
DEF(blendEquationSeparate, 2, glBlendEquationSeparate(E(0), E(1)))
DEF(blendFunc, 2, glBlendFunc(E(0), E(1)))
DEF(blendFuncSeparate, 4, glBlendFuncSeparate(E(0), E(1), E(2), E(3)))
DEF(clear, 1, glClear((GLbitfield)D(0)))
DEF(clearColor, 4, glClearColor(F(0), F(1), F(2), F(3)))
DEF(clearDepth, 1, glClearDepthf(F(0)))
DEF(clearStencil, 1, glClearStencil(I(0)))
DEF(colorMask, 4, glColorMask(B(0), B(1), B(2), B(3)))
DEF(cullFace, 1, glCullFace(E(0)))
DEF(depthFunc, 1, glDepthFunc(E(0)))
DEF(depthMask, 1, glDepthMask(B(0)))
DEF(depthRange, 2, glDepthRangef(F(0), F(1)))
DEF(disable, 1, glDisable(E(0)))
DEF(enable, 1, glEnable(E(0)))
DEF(frontFace, 1, glFrontFace(E(0)))
DEF(hint, 2, glHint(E(0), E(1)))
DEF(lineWidth, 1, glLineWidth(F(0)))
DEF(polygonOffset, 2, glPolygonOffset(F(0), F(1)))
DEF(sampleCoverage, 2, glSampleCoverage(F(0), B(1)))
DEF(scissor, 4, glScissor(I(0), I(1), I(2), I(3)))
DEF(stencilFunc, 3, glStencilFunc(E(0), I(1), U(2)))
DEF(stencilFuncSeparate, 4, glStencilFuncSeparate(E(0), E(1), I(2), U(3)))
DEF(stencilMask, 1, glStencilMask(U(0)))
DEF(stencilMaskSeparate, 2, glStencilMaskSeparate(E(0), U(1)))
DEF(stencilOp, 3, glStencilOp(E(0), E(1), E(2)))
DEF(stencilOpSeparate, 4, glStencilOpSeparate(E(0), E(1), E(2), E(3)))
DEF(viewport, 4, glViewport(I(0), I(1), I(2), I(3)))
DEF(flush, 0, glFlush())
DEF(finish, 0, glFinish())
DEFR(isEnabled, 1, return ret_b(env, glIsEnabled(E(0)));)
DEFR(getError, 0, GLenum e = glGetError(); if (!e && g_softErr) { e = g_softErr; g_softErr = 0; } return ret_d(env, e);)
// FLIP_Y / PREMULTIPLY / COLORSPACE are handled on upload (JS passes the flags), only alignment goes to GL
DEF(pixelStorei, 2, GLenum p = E(0); if (p == GL_UNPACK_ALIGNMENT) g_unpackAlign = I(1); if (p == GL_PACK_ALIGNMENT) g_packAlign = I(1);
  if (p == GL_UNPACK_ALIGNMENT || p == GL_PACK_ALIGNMENT) glPixelStorei(p, I(1)))

// ---- buffers ----
DEFR(createBuffer, 0, GLuint i = 0; glGenBuffers(1, &i); return ret_d(env, i);)
DEF(deleteBuffer, 1, GLuint i = U(0); glDeleteBuffers(1, &i))
DEF(bindBuffer, 2, glBindBuffer(E(0), U(1)))
// bufferData(target, typedArray | byteSize, usage)
DEF(bufferData, 3, void *p; size_t len; if (argbytes(env, a_[1], &p, &len)) glBufferData(E(0), (GLsizeiptr)len, p, E(2)); else glBufferData(E(0), (GLsizeiptr)D(1), NULL, E(2)))
// bufferSubData at offset 0 (PIXI re-uploads its batch/geometry buffers every frame): first orphan the buffer (glBufferData
// with NULL, same size and usage) so the driver gives it fresh storage instead of waiting for the GPU to finish the draws that
// still read the old contents (on panfrost that wait was ~1 ms per call). PMZ_ORPHAN=0 turns this off.
static int g_orphan = -1;
DEF(setOrphan, 1, g_orphan = B(0) ? 1 : 0)
DEF(bufferSubData, 3, void *p; size_t len; if (argbytes(env, a_[2], &p, &len)) {
  if (g_orphan < 0) { const char *o = getenv("PMZ_ORPHAN"); g_orphan = !(o && o[0] == '0'); }
  GLenum t = E(0); GLintptr off = (GLintptr)D(1);
  if (g_orphan && off == 0) {
    GLint size = 0, usage = GL_DYNAMIC_DRAW; glGetBufferParameteriv(t, GL_BUFFER_SIZE, &size); glGetBufferParameteriv(t, GL_BUFFER_USAGE, &usage);
    if ((size_t)size >= len) { glBufferData(t, size, NULL, (GLenum)usage); }
  }
  glBufferSubData(t, off, (GLsizeiptr)len, p); })
DEFR(getBufferParameter, 2, GLint v = 0; glGetBufferParameteriv(E(0), E(1), &v); return ret_d(env, v);)
DEFR(isBuffer, 1, return ret_b(env, glIsBuffer(U(0)));)

// ---- textures ----
DEFR(createTexture, 0, GLuint i = 0; glGenTextures(1, &i); return ret_d(env, i);)
DEF(deleteTexture, 1, GLuint i = U(0); glDeleteTextures(1, &i))
DEF(bindTexture, 2, glBindTexture(E(0), U(1)))
DEF(texParameteri, 3, glTexParameteri(E(0), E(1), I(2)))
DEF(texParameterf, 3, glTexParameterf(E(0), E(1), F(2)))
DEFR(getTexParameter, 2, GLint v = 0; glGetTexParameteriv(E(0), E(1), &v); return ret_d(env, v);)
DEF(generateMipmap, 1, glGenerateMipmap(E(0)))
DEFR(isTexture, 1, return ret_b(env, glIsTexture(U(0)));)
DEF(copyTexImage2D, 8, glCopyTexImage2D(E(0), I(1), E(2), I(3), I(4), I(5), I(6), I(7)))
DEF(copyTexSubImage2D, 8, glCopyTexSubImage2D(E(0), I(1), I(2), I(3), I(4), I(5), I(6), I(7)))

static int comps_of(GLenum f) { switch (f) { case GL_RGBA: return 4; case GL_RGB: return 3; case GL_LUMINANCE_ALPHA: return 2; default: return 1; } }
static int bpp_of(GLenum f, GLenum t) {
  switch (t) {
  case GL_UNSIGNED_BYTE: case GL_BYTE: return comps_of(f);
  case GL_UNSIGNED_SHORT_4_4_4_4: case GL_UNSIGNED_SHORT_5_5_5_1: case GL_UNSIGNED_SHORT_5_6_5: case GL_UNSIGNED_SHORT: return 2;
  case GL_UNSIGNED_INT: return 4;
  case GL_FLOAT: return comps_of(f) * 4;
  case 0x8D61: return comps_of(f) * 2;   // HALF_FLOAT_OES
  default: return comps_of(f);
  }
}
static size_t row_bytes(int w, int bpp, int align) { size_t r = (size_t)w * bpp; return (r + align - 1) / align * align; }
static size_t bytes_needed(int w, int h, GLenum f, GLenum t, int align) {
  if (w <= 0 || h <= 0) return 0;
  int bpp = bpp_of(f, t); return row_bytes(w, bpp, align) * (h - 1) + (size_t)w * bpp;
}
// Apply UNPACK_FLIP_Y / UNPACK_PREMULTIPLY_ALPHA on a copy of the source rows (GLES has neither). Returns src if nothing to do.
static const uint8_t *prep_pixels(const uint8_t *src, int w, int h, GLenum f, GLenum t, int flip, int premul, uint8_t **owned) {
  *owned = NULL;
  int do_pm = premul && f == GL_RGBA && t == GL_UNSIGNED_BYTE;
  if ((!flip && !do_pm) || w <= 0 || h <= 0) return src;
  int bpp = bpp_of(f, t); size_t rb = row_bytes(w, bpp, g_unpackAlign);
  uint8_t *out = malloc(rb * h); if (!out) return src;
  for (int y = 0; y < h; y++) {
    const uint8_t *s = src + (size_t)(flip ? h - 1 - y : y) * rb; uint8_t *d = out + (size_t)y * rb;
    if (do_pm) {
      for (int x = 0; x < w; x++) {
        unsigned a = s[x * 4 + 3];
        d[x * 4] = (uint8_t)((s[x * 4] * a + 127) / 255); d[x * 4 + 1] = (uint8_t)((s[x * 4 + 1] * a + 127) / 255);
        d[x * 4 + 2] = (uint8_t)((s[x * 4 + 2] * a + 127) / 255); d[x * 4 + 3] = (uint8_t)a;
      }
    } else memcpy(d, s, (size_t)w * bpp);
  }
  *owned = out; return out;
}
// texImage2D(target, level, internalformat, width, height, border, format, type, pixels|null, flipY, premultiply)
DEF(texImage2D, 11,
  void *p = NULL; size_t len = 0; int have = argbytes(env, a_[8], &p, &len);
  int w = I(3), h = I(4); GLenum fmt = E(6), ty = E(7); uint8_t *own = NULL;
  if (have && len < bytes_needed(w, h, fmt, ty, g_unpackAlign)) { g_softErr = GL_INVALID_OPERATION; }
  else {
    const uint8_t *src = have ? prep_pixels(p, w, h, fmt, ty, B(9), B(10), &own) : NULL;
    glTexImage2D(E(0), I(1), I(2), w, h, I(5), fmt, ty, src); free(own);
  })
// texSubImage2D(target, level, x, y, width, height, format, type, pixels, flipY, premultiply)
DEF(texSubImage2D, 11,
  void *p = NULL; size_t len = 0; int have = argbytes(env, a_[8], &p, &len);
  int w = I(4), h = I(5); GLenum fmt = E(6), ty = E(7); uint8_t *own = NULL;
  if (!have || len < bytes_needed(w, h, fmt, ty, g_unpackAlign)) { g_softErr = GL_INVALID_OPERATION; }
  else { const uint8_t *src = prep_pixels(p, w, h, fmt, ty, B(9), B(10), &own);
    glTexSubImage2D(E(0), I(1), I(2), I(3), w, h, fmt, ty, src); free(own); })
DEF(readPixels, 7,
  void *p; size_t len; int w = I(2), h = I(3); GLenum fmt = E(4), ty = E(5);
  if (!argbytes(env, a_[6], &p, &len) || len < bytes_needed(w, h, fmt, ty, g_packAlign)) g_softErr = GL_INVALID_OPERATION;
  else glReadPixels(I(0), I(1), w, h, fmt, ty, p))

// ---- framebuffers / renderbuffers ----
DEFR(createFramebuffer, 0, GLuint i = 0; glGenFramebuffers(1, &i); return ret_d(env, i);)
DEF(deleteFramebuffer, 1, GLuint i = U(0); glDeleteFramebuffers(1, &i))
DEF(bindFramebuffer, 2, glBindFramebuffer(E(0), U(1)))
DEF(framebufferTexture2D, 5, glFramebufferTexture2D(E(0), E(1), E(2), U(3), I(4)))
DEF(framebufferRenderbuffer, 4, glFramebufferRenderbuffer(E(0), E(1), E(2), U(3)))
DEFR(checkFramebufferStatus, 1, return ret_d(env, glCheckFramebufferStatus(E(0)));)
DEFR(getFramebufferAttachmentParameter, 3, GLint v = 0; glGetFramebufferAttachmentParameteriv(E(0), E(1), E(2), &v); return ret_d(env, v);)
DEFR(createRenderbuffer, 0, GLuint i = 0; glGenRenderbuffers(1, &i); return ret_d(env, i);)
DEF(deleteRenderbuffer, 1, GLuint i = U(0); glDeleteRenderbuffers(1, &i))
DEF(bindRenderbuffer, 2, glBindRenderbuffer(E(0), U(1)))
DEF(renderbufferStorage, 4, glRenderbufferStorage(E(0), E(1), I(2), I(3)))
DEFR(getRenderbufferParameter, 2, GLint v = 0; glGetRenderbufferParameteriv(E(0), E(1), &v); return ret_d(env, v);)
DEFR(isFramebuffer, 1, return ret_b(env, glIsFramebuffer(U(0)));)
DEFR(isRenderbuffer, 1, return ret_b(env, glIsRenderbuffer(U(0)));)

// ---- shaders / programs ----
DEFR(createShader, 1, return ret_d(env, glCreateShader(E(0)));)
DEF(deleteShader, 1, glDeleteShader(U(0)))
DEF(shaderSource, 2, char *s = arg_utf8(env, a_[1]); if (s) { const char *c = s; glShaderSource(U(0), 1, &c, NULL); free(s); })
DEF(compileShader, 1, glCompileShader(U(0)))
DEFR(getShaderParameter, 2, GLint v = 0; glGetShaderiv(U(0), E(1), &v); return ret_d(env, v);)
DEFR(getShaderInfoLog, 1,
  GLint n = 0; glGetShaderiv(U(0), GL_INFO_LOG_LENGTH, &n); char *s = calloc(n + 1, 1); GLsizei l = 0;
  if (n > 0) glGetShaderInfoLog(U(0), n, &l, s); napi_value r = ret_str(env, s); free(s); return r;)
DEFR(isShader, 1, return ret_b(env, glIsShader(U(0)));)
DEFR(getShaderPrecisionFormat, 2, GLint r[2] = {0, 0}; GLint p = 0; glGetShaderPrecisionFormat(E(0), E(1), r, &p); double v[3] = {r[0], r[1], p}; return ret_arr_d(env, v, 3);)
DEFR(createProgram, 0, return ret_d(env, glCreateProgram());)
DEF(deleteProgram, 1, glDeleteProgram(U(0)))
DEF(attachShader, 2, glAttachShader(U(0), U(1)))
DEF(detachShader, 2, glDetachShader(U(0), U(1)))
DEF(linkProgram, 1, glLinkProgram(U(0)))
DEF(validateProgram, 1, glValidateProgram(U(0)))
DEF(useProgram, 1, glUseProgram(U(0)))
DEFR(isProgram, 1, return ret_b(env, glIsProgram(U(0)));)
DEFR(getProgramParameter, 2, GLint v = 0; glGetProgramiv(U(0), E(1), &v); return ret_d(env, v);)
DEFR(getProgramInfoLog, 1,
  GLint n = 0; glGetProgramiv(U(0), GL_INFO_LOG_LENGTH, &n); char *s = calloc(n + 1, 1); GLsizei l = 0;
  if (n > 0) glGetProgramInfoLog(U(0), n, &l, s); napi_value r = ret_str(env, s); free(s); return r;)
DEF(bindAttribLocation, 3, char *s = arg_utf8(env, a_[2]); if (s) { glBindAttribLocation(U(0), U(1), s); free(s); })
DEFR(getAttribLocation, 2, char *s = arg_utf8(env, a_[1]); GLint r = s ? glGetAttribLocation(U(0), s) : -1; free(s); return ret_d(env, r);)
DEFR(getUniformLocation, 2, char *s = arg_utf8(env, a_[1]); GLint r = s ? glGetUniformLocation(U(0), s) : -1; free(s); return ret_d(env, r);)
static napi_value active_info(napi_env env, GLuint prog, GLuint idx, int uniform) {
  char name[256]; GLsizei len = 0; GLint size = 0; GLenum type = 0; name[0] = 0;
  if (uniform) glGetActiveUniform(prog, idx, sizeof name, &len, &size, &type, name);
  else glGetActiveAttrib(prog, idx, sizeof name, &len, &size, &type, name);
  if (!len) return ret_null(env);
  napi_value o; napi_create_object(env, &o);
  set_str(env, o, "name", name); set_int(env, o, "size", size); set_int(env, o, "type", type); return o;
}
DEFR(getActiveUniform, 2, return active_info(env, U(0), U(1), 1);)
DEFR(getActiveAttrib, 2, return active_info(env, U(0), U(1), 0);)
// getUniform(program, location) -> array of 16 numbers (JS reshapes by uniform type)
DEFR(getUniform, 2, GLfloat v[16] = {0}; glGetUniformfv(U(0), I(1), v); double d[16]; for (int i = 0; i < 16; i++) d[i] = v[i]; return ret_arr_d(env, d, 16);)

// ---- uniforms ----
DEF(uniform1f, 2, glUniform1f(I(0), F(1)))
DEF(uniform2f, 3, glUniform2f(I(0), F(1), F(2)))
DEF(uniform3f, 4, glUniform3f(I(0), F(1), F(2), F(3)))
DEF(uniform4f, 5, glUniform4f(I(0), F(1), F(2), F(3), F(4)))
DEF(uniform1i, 2, glUniform1i(I(0), I(1)))
DEF(uniform2i, 3, glUniform2i(I(0), I(1), I(2)))
DEF(uniform3i, 4, glUniform3i(I(0), I(1), I(2), I(3)))
DEF(uniform4i, 5, glUniform4i(I(0), I(1), I(2), I(3), I(4)))
#define UNIFV(js, glfn, comp, T) DEF(js, 2, void *p; size_t len; if (argbytes(env, a_[1], &p, &len)) glfn(I(0), (GLsizei)(len / ((comp) * sizeof(T))), (const T *)p))
UNIFV(uniform1fv, glUniform1fv, 1, GLfloat) UNIFV(uniform2fv, glUniform2fv, 2, GLfloat) UNIFV(uniform3fv, glUniform3fv, 3, GLfloat) UNIFV(uniform4fv, glUniform4fv, 4, GLfloat)
UNIFV(uniform1iv, glUniform1iv, 1, GLint) UNIFV(uniform2iv, glUniform2iv, 2, GLint) UNIFV(uniform3iv, glUniform3iv, 3, GLint) UNIFV(uniform4iv, glUniform4iv, 4, GLint)
#define UNIFM(js, glfn, n2) DEF(js, 3, void *p; size_t len; if (argbytes(env, a_[2], &p, &len)) glfn(I(0), (GLsizei)(len / ((n2) * sizeof(GLfloat))), B(1), (const GLfloat *)p))
UNIFM(uniformMatrix2fv, glUniformMatrix2fv, 4) UNIFM(uniformMatrix3fv, glUniformMatrix3fv, 9) UNIFM(uniformMatrix4fv, glUniformMatrix4fv, 16)

// ---- vertex attributes / drawing ----
DEF(enableVertexAttribArray, 1, glEnableVertexAttribArray(U(0)))
DEF(disableVertexAttribArray, 1, glDisableVertexAttribArray(U(0)))
DEF(vertexAttribPointer, 6, glVertexAttribPointer(U(0), I(1), E(2), B(3), I(4), PTR(5)))
DEF(vertexAttrib1f, 2, glVertexAttrib1f(U(0), F(1)))
DEF(vertexAttrib2f, 3, glVertexAttrib2f(U(0), F(1), F(2)))
DEF(vertexAttrib3f, 4, glVertexAttrib3f(U(0), F(1), F(2), F(3)))
DEF(vertexAttrib4f, 5, glVertexAttrib4f(U(0), F(1), F(2), F(3), F(4)))
#define ATTRV(js, glfn, comp) DEF(js, 2, void *p; size_t len; if (argbytes(env, a_[1], &p, &len) && len >= (comp) * sizeof(GLfloat)) glfn(U(0), (const GLfloat *)p))
ATTRV(vertexAttrib1fv, glVertexAttrib1fv, 1) ATTRV(vertexAttrib2fv, glVertexAttrib2fv, 2) ATTRV(vertexAttrib3fv, glVertexAttrib3fv, 3) ATTRV(vertexAttrib4fv, glVertexAttrib4fv, 4)
DEFR(getVertexAttrib, 2, GLint v = 0; glGetVertexAttribiv(U(0), E(1), &v); return ret_d(env, v);)
DEFR(getVertexAttribOffset, 2, void *p = NULL; glGetVertexAttribPointerv(U(0), E(1), &p); return ret_d(env, (double)(uintptr_t)p);)
DEF(drawArrays, 3, glDrawArrays(E(0), I(1), I(2)))
DEF(drawElements, 4, glDrawElements(E(0), I(1), E(2), PTR(3)))
DEF(drawArraysInstanced, 4, if (glDrawArraysInstanced) glDrawArraysInstanced(E(0), I(1), I(2), I(3)); else g_softErr = GL_INVALID_OPERATION)
DEF(drawElementsInstanced, 5, if (glDrawElementsInstanced) glDrawElementsInstanced(E(0), I(1), E(2), PTR(3), I(4)); else g_softErr = GL_INVALID_OPERATION)
DEF(vertexAttribDivisor, 2, if (glVertexAttribDivisor) glVertexAttribDivisor(U(0), U(1)); else g_softErr = GL_INVALID_OPERATION)
DEFR(createVertexArray, 0, GLuint i = 0; if (glGenVertexArrays) glGenVertexArrays(1, &i); else g_softErr = GL_INVALID_OPERATION; return ret_d(env, i);)
DEF(deleteVertexArray, 1, GLuint i = U(0); if (glDeleteVertexArrays) glDeleteVertexArrays(1, &i))
DEF(bindVertexArray, 1, if (glBindVertexArray) glBindVertexArray(U(0)); else g_softErr = GL_INVALID_OPERATION)
DEFR(isVertexArray, 1, return ret_b(env, glIsVertexArray ? glIsVertexArray(U(0)) : 0);)

// ---- queries ----
DEFR(getString, 1, return ret_str(env, (const char *)glGetString(E(0)));)
DEFR(getIntegerv, 2, GLint v[16] = {0}; int n = I(1); if (n > 16) n = 16; glGetIntegerv(E(0), v); double d[16]; for (int i = 0; i < n; i++) d[i] = v[i]; return ret_arr_d(env, d, n);)
DEFR(getFloatv, 2, GLfloat v[16] = {0}; int n = I(1); if (n > 16) n = 16; glGetFloatv(E(0), v); double d[16]; for (int i = 0; i < n; i++) d[i] = v[i]; return ret_arr_d(env, d, n);)
DEFR(getBooleanv, 2, GLboolean v[16] = {0}; int n = I(1); if (n > 16) n = 16; glGetBooleanv(E(0), v); double d[16]; for (int i = 0; i < n; i++) d[i] = v[i]; return ret_arr_d(env, d, n);)

// ---- PNG ----
static void free_cb(napi_env env, void *data, void *hint) { free(data); }
// decodePng(bytes) -> { width, height, data: Uint8Array RGBA non-premultiplied }  (data is an external buffer, freed by GC)
static napi_value DecodePng(napi_env env, napi_callback_info info) {
  BEGIN(1); void *p; size_t len;
  if (!argbytes(env, a_[0], &p, &len)) { napi_throw_type_error(env, NULL, "decodePng: buffer expected"); return NULL; }
  png_image img; memset(&img, 0, sizeof img); img.version = PNG_IMAGE_VERSION;
  if (!png_image_begin_read_from_memory(&img, p, len)) { napi_throw_error(env, NULL, img.message); png_image_free(&img); return NULL; }
  img.format = PNG_FORMAT_RGBA;
  size_t size = PNG_IMAGE_SIZE(img); uint8_t *buf = malloc(size ? size : 1);
  if (!buf) { png_image_free(&img); napi_throw_error(env, NULL, "decodePng: out of memory"); return NULL; }
  if (!png_image_finish_read(&img, NULL, buf, 0, NULL)) { char m[256]; snprintf(m, sizeof m, "%s", img.message); free(buf); png_image_free(&img); napi_throw_error(env, NULL, m); return NULL; }
  napi_value o, ab, ta; napi_create_object(env, &o);
  napi_create_external_arraybuffer(env, buf, size, free_cb, NULL, &ab);
  napi_create_typedarray(env, napi_uint8_array, size, ab, 0, &ta);
  set_int(env, o, "width", img.width); set_int(env, o, "height", img.height); napi_set_named_property(env, o, "data", ta);
  return o;
}

// ---- JPEG / WebP (same result shape as decodePng) ----
static napi_value rgba_result(napi_env env, uint8_t *buf, size_t size, int w, int h) {
  napi_value o, ab, ta; napi_create_object(env, &o);
  napi_create_external_arraybuffer(env, buf, size, free_cb, NULL, &ab);
  napi_create_typedarray(env, napi_uint8_array, size, ab, 0, &ta);
  set_int(env, o, "width", w); set_int(env, o, "height", h); napi_set_named_property(env, o, "data", ta);
  return o;
}
struct jerr { struct jpeg_error_mgr pub; jmp_buf jb; char msg[JMSG_LENGTH_MAX]; };
static void jerr_exit(j_common_ptr c) { struct jerr *e = (struct jerr *)c->err; (*c->err->format_message)(c, e->msg); longjmp(e->jb, 1); }
static void jerr_silent(j_common_ptr c, int lvl) {}
// decodeJpeg(bytes) -> { width, height, data RGBA (alpha 255) }; CMYK/YCCK are converted by libjpeg-turbo to RGB
static napi_value DecodeJpeg(napi_env env, napi_callback_info info) {
  BEGIN(1); void *p; size_t len;
  if (!argbytes(env, a_[0], &p, &len)) { napi_throw_type_error(env, NULL, "decodeJpeg: buffer expected"); return NULL; }
  struct jpeg_decompress_struct c; struct jerr je; uint8_t *volatile buf = NULL;
  c.err = jpeg_std_error(&je.pub); je.pub.error_exit = jerr_exit; je.pub.emit_message = jerr_silent; je.msg[0] = 0;
  if (setjmp(je.jb)) { jpeg_destroy_decompress(&c); free(buf); napi_throw_error(env, NULL, je.msg[0] ? je.msg : "decodeJpeg failed"); return NULL; }
  jpeg_create_decompress(&c); jpeg_mem_src(&c, p, len); jpeg_read_header(&c, TRUE);
  c.out_color_space = (c.jpeg_color_space == JCS_CMYK || c.jpeg_color_space == JCS_YCCK) ? JCS_CMYK : JCS_EXT_RGBA;
  if (c.out_color_space == JCS_CMYK) c.out_color_space = JCS_RGB;   // libjpeg-turbo converts YCCK/CMYK -> RGB; expand to RGBA below
  jpeg_start_decompress(&c);
  int w = c.output_width, h = c.output_height, nc = c.output_components; size_t size = (size_t)w * h * 4;
  buf = malloc(size ? size : 1); if (!buf) { jpeg_destroy_decompress(&c); napi_throw_error(env, NULL, "decodeJpeg: out of memory"); return NULL; }
  while (c.output_scanline < c.output_height) {
    uint8_t *row = buf + (size_t)c.output_scanline * w * 4; JSAMPROW rp = row; jpeg_read_scanlines(&c, &rp, 1);
    if (nc == 3) for (int x = w - 1; x >= 0; x--) { row[x * 4 + 3] = 255; row[x * 4 + 2] = row[x * 3 + 2]; row[x * 4 + 1] = row[x * 3 + 1]; row[x * 4] = row[x * 3]; }   // RGB rows were read into the RGBA row: expand in place, back to front
    else if (nc == 1) for (int x = w - 1; x >= 0; x--) { uint8_t g = row[x]; row[x * 4] = row[x * 4 + 1] = row[x * 4 + 2] = g; row[x * 4 + 3] = 255; }
  }
  jpeg_finish_decompress(&c); jpeg_destroy_decompress(&c);
  return rgba_result(env, buf, size, w, h);
}
// decodeWebp(bytes) -> { width, height, data RGBA non-premultiplied } (lossy, lossless, alpha; first frame of an animation is not supported)
static napi_value DecodeWebp(napi_env env, napi_callback_info info) {
  BEGIN(1); void *p; size_t len;
  if (!argbytes(env, a_[0], &p, &len)) { napi_throw_type_error(env, NULL, "decodeWebp: buffer expected"); return NULL; }
  int w = 0, h = 0; if (!WebPGetInfo(p, len, &w, &h)) { napi_throw_error(env, NULL, "decodeWebp: not a WebP"); return NULL; }
  uint8_t *rgba = WebPDecodeRGBA(p, len, &w, &h); if (!rgba) { napi_throw_error(env, NULL, "decodeWebp failed"); return NULL; }
  size_t size = (size_t)w * h * 4; uint8_t *buf = malloc(size ? size : 1);   // copy: the WebP buffer must be released with WebPFree, our external buffer with free
  if (!buf) { WebPFree(rgba); napi_throw_error(env, NULL, "decodeWebp: out of memory"); return NULL; }
  memcpy(buf, rgba, size); WebPFree(rgba);
  return rgba_result(env, buf, size, w, h);
}
// writePng(path, width, height, rgba, flipY): used for screenshots
static napi_value WritePng(napi_env env, napi_callback_info info) {
  BEGIN(5); void *p; size_t len; char *path = arg_utf8(env, a_[0]); int w = I(1), h = I(2), flip = B(4);
  if (!path || !argbytes(env, a_[3], &p, &len) || len < (size_t)w * h * 4) { free(path); napi_throw_error(env, NULL, "writePng: bad arguments"); return NULL; }
  uint8_t *tmp = NULL; const uint8_t *src = p;
  if (flip) { tmp = malloc((size_t)w * h * 4); for (int y = 0; y < h; y++) memcpy(tmp + (size_t)y * w * 4, (uint8_t *)p + (size_t)(h - 1 - y) * w * 4, (size_t)w * 4); src = tmp; }
  png_image img; memset(&img, 0, sizeof img); img.version = PNG_IMAGE_VERSION; img.width = w; img.height = h; img.format = PNG_FORMAT_RGBA;
  int ok = png_image_write_to_file(&img, path, 0, src, 0, NULL);
  char m[256]; snprintf(m, sizeof m, "writePng: %s", img.message); free(tmp); free(path); png_image_free(&img);
  if (!ok) { napi_throw_error(env, NULL, m); return NULL; }
  return NULL;
}

#include "pmzrt_canvas.c"   // Canvas 2D (Cairo + Pango), registers its exports with DEF
#include "pmzrt_audio.c"    // audio mixer + Ogg/FFmpeg decode (WebAudio backend), registers its exports with DEF
#include "pmzrt_video.c"    // native <video> playback (FFmpeg + GLES2 + audio ring), registers its exports with DEF

#define EXPORT(name, fn) do { napi_value fv_; napi_create_function(env, name, NAPI_AUTO_LENGTH, fn, NULL, &fv_); napi_set_named_property(env, exports, name, fv_); } while (0)
NAPI_MODULE_INIT() {
  EXPORT("init", Init_); EXPORT("pollEvents", PollEvents); EXPORT("swap", Swap); EXPORT("shutdown", Shutdown);
  EXPORT("glClearColor", GlClearColor); EXPORT("glClear", GlClear); EXPORT("glViewport", GlViewport);
  EXPORT("drawTestTriangle", DrawTestTriangle); EXPORT("decodePng", DecodePng); EXPORT("decodeJpeg", DecodeJpeg); EXPORT("decodeWebp", DecodeWebp); EXPORT("writePng", WritePng);
  for (int i = 0; i < g_nregs; i++) EXPORT(g_regs[i].name, g_regs[i].fn);
  napi_value c; napi_create_int32(env, GL_COLOR_BUFFER_BIT, &c); napi_set_named_property(env, exports, "COLOR_BUFFER_BIT", c);
  return exports;
}
