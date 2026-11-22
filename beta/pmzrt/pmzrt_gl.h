// pmzrt_gl.h - Runtime GLES function loader via SDL_GL_GetProcAddress (no link-time libGLESv2 dependency).
// Sets GL_GLES_PROTOTYPES=0 before including GLES headers so any missed gl* symbol fails at compile time.
#ifndef PMZRT_GL_H
#define PMZRT_GL_H

#define GL_GLES_PROTOTYPES 0
#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>
#include <SDL.h>
#include <string.h>

// All core GLES 2.0 functions used by pmzrt.c and pmzrt_canvas.c
#define PMZ_GL_CORE_LIST(X) \
  X(PFNGLACTIVETEXTUREPROC, glActiveTexture) \
  X(PFNGLATTACHSHADERPROC, glAttachShader) \
  X(PFNGLBINDATTRIBLOCATIONPROC, glBindAttribLocation) \
  X(PFNGLBINDBUFFERPROC, glBindBuffer) \
  X(PFNGLBINDFRAMEBUFFERPROC, glBindFramebuffer) \
  X(PFNGLBINDRENDERBUFFERPROC, glBindRenderbuffer) \
  X(PFNGLBINDTEXTUREPROC, glBindTexture) \
  X(PFNGLBLENDCOLORPROC, glBlendColor) \
  X(PFNGLBLENDEQUATIONPROC, glBlendEquation) \
  X(PFNGLBLENDEQUATIONSEPARATEPROC, glBlendEquationSeparate) \
  X(PFNGLBLENDFUNCPROC, glBlendFunc) \
  X(PFNGLBLENDFUNCSEPARATEPROC, glBlendFuncSeparate) \
  X(PFNGLBUFFERDATAPROC, glBufferData) \
  X(PFNGLBUFFERSUBDATAPROC, glBufferSubData) \
  X(PFNGLCHECKFRAMEBUFFERSTATUSPROC, glCheckFramebufferStatus) \
  X(PFNGLCLEARPROC, glClear) \
  X(PFNGLCLEARCOLORPROC, glClearColor) \
  X(PFNGLCLEARDEPTHFPROC, glClearDepthf) \
  X(PFNGLCLEARSTENCILPROC, glClearStencil) \
  X(PFNGLCOLORMASKPROC, glColorMask) \
  X(PFNGLCOMPILESHADERPROC, glCompileShader) \
  X(PFNGLCOPYTEXIMAGE2DPROC, glCopyTexImage2D) \
  X(PFNGLCOPYTEXSUBIMAGE2DPROC, glCopyTexSubImage2D) \
  X(PFNGLCREATEPROGRAMPROC, glCreateProgram) \
  X(PFNGLCREATESHADERPROC, glCreateShader) \
  X(PFNGLCULLFACEPROC, glCullFace) \
  X(PFNGLDELETEBUFFERSPROC, glDeleteBuffers) \
  X(PFNGLDELETEFRAMEBUFFERSPROC, glDeleteFramebuffers) \
  X(PFNGLDELETEPROGRAMPROC, glDeleteProgram) \
  X(PFNGLDELETERENDERBUFFERSPROC, glDeleteRenderbuffers) \
  X(PFNGLDELETESHADERPROC, glDeleteShader) \
  X(PFNGLDELETETEXTURESPROC, glDeleteTextures) \
  X(PFNGLDEPTHFUNCPROC, glDepthFunc) \
  X(PFNGLDEPTHMASKPROC, glDepthMask) \
  X(PFNGLDEPTHRANGEFPROC, glDepthRangef) \
  X(PFNGLDETACHSHADERPROC, glDetachShader) \
  X(PFNGLDISABLEPROC, glDisable) \
  X(PFNGLDISABLEVERTEXATTRIBARRAYPROC, glDisableVertexAttribArray) \
  X(PFNGLDRAWARRAYSPROC, glDrawArrays) \
  X(PFNGLDRAWELEMENTSPROC, glDrawElements) \
  X(PFNGLENABLEPROC, glEnable) \
  X(PFNGLENABLEVERTEXATTRIBARRAYPROC, glEnableVertexAttribArray) \
  X(PFNGLFINISHPROC, glFinish) \
  X(PFNGLFLUSHPROC, glFlush) \
  X(PFNGLFRAMEBUFFERRENDERBUFFERPROC, glFramebufferRenderbuffer) \
  X(PFNGLFRAMEBUFFERTEXTURE2DPROC, glFramebufferTexture2D) \
  X(PFNGLFRONTFACEPROC, glFrontFace) \
  X(PFNGLGENBUFFERSPROC, glGenBuffers) \
  X(PFNGLGENFRAMEBUFFERSPROC, glGenFramebuffers) \
  X(PFNGLGENRENDERBUFFERSPROC, glGenRenderbuffers) \
  X(PFNGLGENTEXTURESPROC, glGenTextures) \
  X(PFNGLGENERATEMIPMAPPROC, glGenerateMipmap) \
  X(PFNGLGETACTIVEATTRIBPROC, glGetActiveAttrib) \
  X(PFNGLGETACTIVEUNIFORMPROC, glGetActiveUniform) \
  X(PFNGLGETATTRIBLOCATIONPROC, glGetAttribLocation) \
  X(PFNGLGETBOOLEANVPROC, glGetBooleanv) \
  X(PFNGLGETBUFFERPARAMETERIVPROC, glGetBufferParameteriv) \
  X(PFNGLGETERRORPROC, glGetError) \
  X(PFNGLGETFLOATVPROC, glGetFloatv) \
  X(PFNGLGETFRAMEBUFFERATTACHMENTPARAMETERIVPROC, glGetFramebufferAttachmentParameteriv) \
  X(PFNGLGETINTEGERVPROC, glGetIntegerv) \
  X(PFNGLGETPROGRAMINFOLOGPROC, glGetProgramInfoLog) \
  X(PFNGLGETPROGRAMIVPROC, glGetProgramiv) \
  X(PFNGLGETRENDERBUFFERPARAMETERIVPROC, glGetRenderbufferParameteriv) \
  X(PFNGLGETSHADERINFOLOGPROC, glGetShaderInfoLog) \
  X(PFNGLGETSHADERPRECISIONFORMATPROC, glGetShaderPrecisionFormat) \
  X(PFNGLGETSHADERIVPROC, glGetShaderiv) \
  X(PFNGLGETSTRINGPROC, glGetString) \
  X(PFNGLGETTEXPARAMETERIVPROC, glGetTexParameteriv) \
  X(PFNGLGETUNIFORMLOCATIONPROC, glGetUniformLocation) \
  X(PFNGLGETUNIFORMFVPROC, glGetUniformfv) \
  X(PFNGLGETVERTEXATTRIBPOINTERVPROC, glGetVertexAttribPointerv) \
  X(PFNGLGETVERTEXATTRIBIVPROC, glGetVertexAttribiv) \
  X(PFNGLHINTPROC, glHint) \
  X(PFNGLISBUFFERPROC, glIsBuffer) \
  X(PFNGLISENABLEDPROC, glIsEnabled) \
  X(PFNGLISFRAMEBUFFERPROC, glIsFramebuffer) \
  X(PFNGLISPROGRAMPROC, glIsProgram) \
  X(PFNGLISRENDERBUFFERPROC, glIsRenderbuffer) \
  X(PFNGLISSHADERPROC, glIsShader) \
  X(PFNGLISTEXTUREPROC, glIsTexture) \
  X(PFNGLLINEWIDTHPROC, glLineWidth) \
  X(PFNGLLINKPROGRAMPROC, glLinkProgram) \
  X(PFNGLPIXELSTOREIPROC, glPixelStorei) \
  X(PFNGLPOLYGONOFFSETPROC, glPolygonOffset) \
  X(PFNGLREADPIXELSPROC, glReadPixels) \
  X(PFNGLRENDERBUFFERSTORAGEPROC, glRenderbufferStorage) \
  X(PFNGLSAMPLECOVERAGEPROC, glSampleCoverage) \
  X(PFNGLSCISSORPROC, glScissor) \
  X(PFNGLSHADERSOURCEPROC, glShaderSource) \
  X(PFNGLSTENCILFUNCPROC, glStencilFunc) \
  X(PFNGLSTENCILFUNCSEPARATEPROC, glStencilFuncSeparate) \
  X(PFNGLSTENCILMASKPROC, glStencilMask) \
  X(PFNGLSTENCILMASKSEPARATEPROC, glStencilMaskSeparate) \
  X(PFNGLSTENCILOPPROC, glStencilOp) \
  X(PFNGLSTENCILOPSEPARATEPROC, glStencilOpSeparate) \
  X(PFNGLTEXIMAGE2DPROC, glTexImage2D) \
  X(PFNGLTEXPARAMETERFPROC, glTexParameterf) \
  X(PFNGLTEXPARAMETERIPROC, glTexParameteri) \
  X(PFNGLTEXSUBIMAGE2DPROC, glTexSubImage2D) \
  X(PFNGLUNIFORM1FPROC, glUniform1f) \
  X(PFNGLUNIFORM1FVPROC, glUniform1fv) \
  X(PFNGLUNIFORM1IPROC, glUniform1i) \
  X(PFNGLUNIFORM1IVPROC, glUniform1iv) \
  X(PFNGLUNIFORM2FPROC, glUniform2f) \
  X(PFNGLUNIFORM2FVPROC, glUniform2fv) \
  X(PFNGLUNIFORM2IPROC, glUniform2i) \
  X(PFNGLUNIFORM2IVPROC, glUniform2iv) \
  X(PFNGLUNIFORM3FPROC, glUniform3f) \
  X(PFNGLUNIFORM3FVPROC, glUniform3fv) \
  X(PFNGLUNIFORM3IPROC, glUniform3i) \
  X(PFNGLUNIFORM3IVPROC, glUniform3iv) \
  X(PFNGLUNIFORM4FPROC, glUniform4f) \
  X(PFNGLUNIFORM4FVPROC, glUniform4fv) \
  X(PFNGLUNIFORM4IPROC, glUniform4i) \
  X(PFNGLUNIFORM4IVPROC, glUniform4iv) \
  X(PFNGLUNIFORMMATRIX2FVPROC, glUniformMatrix2fv) \
  X(PFNGLUNIFORMMATRIX3FVPROC, glUniformMatrix3fv) \
  X(PFNGLUNIFORMMATRIX4FVPROC, glUniformMatrix4fv) \
  X(PFNGLUSEPROGRAMPROC, glUseProgram) \
  X(PFNGLVALIDATEPROGRAMPROC, glValidateProgram) \
  X(PFNGLVERTEXATTRIB1FPROC, glVertexAttrib1f) \
  X(PFNGLVERTEXATTRIB1FVPROC, glVertexAttrib1fv) \
  X(PFNGLVERTEXATTRIB2FPROC, glVertexAttrib2f) \
  X(PFNGLVERTEXATTRIB2FVPROC, glVertexAttrib2fv) \
  X(PFNGLVERTEXATTRIB3FPROC, glVertexAttrib3f) \
  X(PFNGLVERTEXATTRIB3FVPROC, glVertexAttrib3fv) \
  X(PFNGLVERTEXATTRIB4FPROC, glVertexAttrib4f) \
  X(PFNGLVERTEXATTRIB4FVPROC, glVertexAttrib4fv) \
  X(PFNGLVERTEXATTRIBPOINTERPROC, glVertexAttribPointer) \
  X(PFNGLVIEWPORTPROC, glViewport)

// Optional GLES 3.0 / OES / EXT functions
#define PMZ_GL_OPT_LIST(X) \
  X(PFNGLGENVERTEXARRAYSPROC, glGenVertexArrays) \
  X(PFNGLDELETEVERTEXARRAYSPROC, glDeleteVertexArrays) \
  X(PFNGLBINDVERTEXARRAYPROC, glBindVertexArray) \
  X(PFNGLISVERTEXARRAYPROC, glIsVertexArray) \
  X(PFNGLDRAWARRAYSINSTANCEDPROC, glDrawArraysInstanced) \
  X(PFNGLDRAWELEMENTSINSTANCEDPROC, glDrawElementsInstanced) \
  X(PFNGLVERTEXATTRIBDIVISORPROC, glVertexAttribDivisor)

#define PMZ_GL_DECL(T, name) static T pmz_##name;
PMZ_GL_CORE_LIST(PMZ_GL_DECL)
PMZ_GL_OPT_LIST(PMZ_GL_DECL)
#undef PMZ_GL_DECL

static int g_has_vao, g_has_instancing;

static int pmz_has_ext(const char *exts, const char *name) {
  if (!exts || !name) return 0;
  size_t n = strlen(name);
  const char *p = exts;
  while ((p = strstr(p, name)) != NULL) {
    int left = (p == exts) || (p[-1] == ' ');
    int right = (p[n] == '\0') || (p[n] == ' ');
    if (left && right) return 1;
    p += n;
  }
  return 0;
}

static void *pmz_gl_proc_any(const char *a, const char *b, const char *c, const char *d) {
  void *p = NULL;
  if (a && (p = SDL_GL_GetProcAddress(a))) return p;
  if (b && (p = SDL_GL_GetProcAddress(b))) return p;
  if (c && (p = SDL_GL_GetProcAddress(c))) return p;
  if (d && (p = SDL_GL_GetProcAddress(d))) return p;
  return NULL;
}

// Returns NULL on success, or the name of the first missing core GLES 2.0 entry point.
static const char *pmz_gl_load(int es3) {
  #define PMZ_GL_GET(T, name) \
    pmz_##name = (T)SDL_GL_GetProcAddress(#name); \
    if (!pmz_##name) return #name;
  PMZ_GL_CORE_LIST(PMZ_GL_GET)
  #undef PMZ_GL_GET

  const char *exts = (const char *)pmz_glGetString(GL_EXTENSIONS);
  int vao_ok = es3 || pmz_has_ext(exts, "GL_OES_vertex_array_object");
  if (vao_ok) {
    pmz_glGenVertexArrays = (PFNGLGENVERTEXARRAYSPROC)pmz_gl_proc_any(es3 ? "glGenVertexArrays" : NULL, "glGenVertexArraysOES", "glGenVertexArrays", NULL);
    pmz_glDeleteVertexArrays = (PFNGLDELETEVERTEXARRAYSPROC)pmz_gl_proc_any(es3 ? "glDeleteVertexArrays" : NULL, "glDeleteVertexArraysOES", "glDeleteVertexArrays", NULL);
    pmz_glBindVertexArray = (PFNGLBINDVERTEXARRAYPROC)pmz_gl_proc_any(es3 ? "glBindVertexArray" : NULL, "glBindVertexArrayOES", "glBindVertexArray", NULL);
    pmz_glIsVertexArray = (PFNGLISVERTEXARRAYPROC)pmz_gl_proc_any(es3 ? "glIsVertexArray" : NULL, "glIsVertexArrayOES", "glIsVertexArray", NULL);
    g_has_vao = pmz_glGenVertexArrays && pmz_glDeleteVertexArrays && pmz_glBindVertexArray && pmz_glIsVertexArray;
  } else {
    pmz_glGenVertexArrays = NULL; pmz_glDeleteVertexArrays = NULL; pmz_glBindVertexArray = NULL; pmz_glIsVertexArray = NULL;
    g_has_vao = 0;
  }

  int inst_ok = es3 || pmz_has_ext(exts, "GL_EXT_draw_instanced") || pmz_has_ext(exts, "GL_ANGLE_instanced_arrays") || pmz_has_ext(exts, "GL_NV_draw_instanced");
  int div_ok = es3 || pmz_has_ext(exts, "GL_EXT_instanced_arrays") || pmz_has_ext(exts, "GL_ANGLE_instanced_arrays") || pmz_has_ext(exts, "GL_NV_instanced_arrays");
  if (inst_ok && div_ok) {
    pmz_glDrawArraysInstanced = (PFNGLDRAWARRAYSINSTANCEDPROC)pmz_gl_proc_any(es3 ? "glDrawArraysInstanced" : NULL, "glDrawArraysInstancedEXT", "glDrawArraysInstancedANGLE", "glDrawArraysInstancedNV");
    pmz_glDrawElementsInstanced = (PFNGLDRAWELEMENTSINSTANCEDPROC)pmz_gl_proc_any(es3 ? "glDrawElementsInstanced" : NULL, "glDrawElementsInstancedEXT", "glDrawElementsInstancedANGLE", "glDrawElementsInstancedNV");
    pmz_glVertexAttribDivisor = (PFNGLVERTEXATTRIBDIVISORPROC)pmz_gl_proc_any(es3 ? "glVertexAttribDivisor" : NULL, "glVertexAttribDivisorEXT", "glVertexAttribDivisorANGLE", "glVertexAttribDivisorNV");
    g_has_instancing = pmz_glDrawArraysInstanced && pmz_glDrawElementsInstanced && pmz_glVertexAttribDivisor;
  } else {
    pmz_glDrawArraysInstanced = NULL; pmz_glDrawElementsInstanced = NULL; pmz_glVertexAttribDivisor = NULL;
    g_has_instancing = 0;
  }
  return NULL;
}

// Redirect all gl* call sites in pmzrt.c and pmzrt_canvas.c through the loaded pointers.
#define glActiveTexture pmz_glActiveTexture
#define glAttachShader pmz_glAttachShader
#define glBindAttribLocation pmz_glBindAttribLocation
#define glBindBuffer pmz_glBindBuffer
#define glBindFramebuffer pmz_glBindFramebuffer
#define glBindRenderbuffer pmz_glBindRenderbuffer
#define glBindTexture pmz_glBindTexture
#define glBlendColor pmz_glBlendColor
#define glBlendEquation pmz_glBlendEquation
#define glBlendEquationSeparate pmz_glBlendEquationSeparate
#define glBlendFunc pmz_glBlendFunc
#define glBlendFuncSeparate pmz_glBlendFuncSeparate
#define glBufferData pmz_glBufferData
#define glBufferSubData pmz_glBufferSubData
#define glCheckFramebufferStatus pmz_glCheckFramebufferStatus
#define glClear pmz_glClear
#define glClearColor pmz_glClearColor
#define glClearDepthf pmz_glClearDepthf
#define glClearStencil pmz_glClearStencil
#define glColorMask pmz_glColorMask
#define glCompileShader pmz_glCompileShader
#define glCopyTexImage2D pmz_glCopyTexImage2D
#define glCopyTexSubImage2D pmz_glCopyTexSubImage2D
#define glCreateProgram pmz_glCreateProgram
#define glCreateShader pmz_glCreateShader
#define glCullFace pmz_glCullFace
#define glDeleteBuffers pmz_glDeleteBuffers
#define glDeleteFramebuffers pmz_glDeleteFramebuffers
#define glDeleteProgram pmz_glDeleteProgram
#define glDeleteRenderbuffers pmz_glDeleteRenderbuffers
#define glDeleteShader pmz_glDeleteShader
#define glDeleteTextures pmz_glDeleteTextures
#define glDepthFunc pmz_glDepthFunc
#define glDepthMask pmz_glDepthMask
#define glDepthRangef pmz_glDepthRangef
#define glDetachShader pmz_glDetachShader
#define glDisable pmz_glDisable
#define glDisableVertexAttribArray pmz_glDisableVertexAttribArray
#define glDrawArrays pmz_glDrawArrays
#define glDrawElements pmz_glDrawElements
#define glEnable pmz_glEnable
#define glEnableVertexAttribArray pmz_glEnableVertexAttribArray
#define glFinish pmz_glFinish
#define glFlush pmz_glFlush
#define glFramebufferRenderbuffer pmz_glFramebufferRenderbuffer
#define glFramebufferTexture2D pmz_glFramebufferTexture2D
#define glFrontFace pmz_glFrontFace
#define glGenBuffers pmz_glGenBuffers
#define glGenFramebuffers pmz_glGenFramebuffers
#define glGenRenderbuffers pmz_glGenRenderbuffers
#define glGenTextures pmz_glGenTextures
#define glGenerateMipmap pmz_glGenerateMipmap
#define glGetActiveAttrib pmz_glGetActiveAttrib
#define glGetActiveUniform pmz_glGetActiveUniform
#define glGetAttribLocation pmz_glGetAttribLocation
#define glGetBooleanv pmz_glGetBooleanv
#define glGetBufferParameteriv pmz_glGetBufferParameteriv
#define glGetError pmz_glGetError
#define glGetFloatv pmz_glGetFloatv
#define glGetFramebufferAttachmentParameteriv pmz_glGetFramebufferAttachmentParameteriv
#define glGetIntegerv pmz_glGetIntegerv
#define glGetProgramInfoLog pmz_glGetProgramInfoLog
#define glGetProgramiv pmz_glGetProgramiv
#define glGetRenderbufferParameteriv pmz_glGetRenderbufferParameteriv
#define glGetShaderInfoLog pmz_glGetShaderInfoLog
#define glGetShaderPrecisionFormat pmz_glGetShaderPrecisionFormat
#define glGetShaderiv pmz_glGetShaderiv
#define glGetString pmz_glGetString
#define glGetTexParameteriv pmz_glGetTexParameteriv
#define glGetUniformLocation pmz_glGetUniformLocation
#define glGetUniformfv pmz_glGetUniformfv
#define glGetVertexAttribPointerv pmz_glGetVertexAttribPointerv
#define glGetVertexAttribiv pmz_glGetVertexAttribiv
#define glHint pmz_glHint
#define glIsBuffer pmz_glIsBuffer
#define glIsEnabled pmz_glIsEnabled
#define glIsFramebuffer pmz_glIsFramebuffer
#define glIsProgram pmz_glIsProgram
#define glIsRenderbuffer pmz_glIsRenderbuffer
#define glIsShader pmz_glIsShader
#define glIsTexture pmz_glIsTexture
#define glLineWidth pmz_glLineWidth
#define glLinkProgram pmz_glLinkProgram
#define glPixelStorei pmz_glPixelStorei
#define glPolygonOffset pmz_glPolygonOffset
#define glReadPixels pmz_glReadPixels
#define glRenderbufferStorage pmz_glRenderbufferStorage
#define glSampleCoverage pmz_glSampleCoverage
#define glScissor pmz_glScissor
#define glShaderSource pmz_glShaderSource
#define glStencilFunc pmz_glStencilFunc
#define glStencilFuncSeparate pmz_glStencilFuncSeparate
#define glStencilMask pmz_glStencilMask
#define glStencilMaskSeparate pmz_glStencilMaskSeparate
#define glStencilOp pmz_glStencilOp
#define glStencilOpSeparate pmz_glStencilOpSeparate
#define glTexImage2D pmz_glTexImage2D
#define glTexParameterf pmz_glTexParameterf
#define glTexParameteri pmz_glTexParameteri
#define glTexSubImage2D pmz_glTexSubImage2D
#define glUniform1f pmz_glUniform1f
#define glUniform1fv pmz_glUniform1fv
#define glUniform1i pmz_glUniform1i
#define glUniform1iv pmz_glUniform1iv
#define glUniform2f pmz_glUniform2f
#define glUniform2fv pmz_glUniform2fv
#define glUniform2i pmz_glUniform2i
#define glUniform2iv pmz_glUniform2iv
#define glUniform3f pmz_glUniform3f
#define glUniform3fv pmz_glUniform3fv
#define glUniform3i pmz_glUniform3i
#define glUniform3iv pmz_glUniform3iv
#define glUniform4f pmz_glUniform4f
#define glUniform4fv pmz_glUniform4fv
#define glUniform4i pmz_glUniform4i
#define glUniform4iv pmz_glUniform4iv
#define glUniformMatrix2fv pmz_glUniformMatrix2fv
#define glUniformMatrix3fv pmz_glUniformMatrix3fv
#define glUniformMatrix4fv pmz_glUniformMatrix4fv
#define glUseProgram pmz_glUseProgram
#define glValidateProgram pmz_glValidateProgram
#define glVertexAttrib1f pmz_glVertexAttrib1f
#define glVertexAttrib1fv pmz_glVertexAttrib1fv
#define glVertexAttrib2f pmz_glVertexAttrib2f
#define glVertexAttrib2fv pmz_glVertexAttrib2fv
#define glVertexAttrib3f pmz_glVertexAttrib3f
#define glVertexAttrib3fv pmz_glVertexAttrib3fv
#define glVertexAttrib4f pmz_glVertexAttrib4f
#define glVertexAttrib4fv pmz_glVertexAttrib4fv
#define glVertexAttribPointer pmz_glVertexAttribPointer
#define glViewport pmz_glViewport
#define glGenVertexArrays pmz_glGenVertexArrays
#define glDeleteVertexArrays pmz_glDeleteVertexArrays
#define glBindVertexArray pmz_glBindVertexArray
#define glIsVertexArray pmz_glIsVertexArray
#define glDrawArraysInstanced pmz_glDrawArraysInstanced
#define glDrawElementsInstanced pmz_glDrawElementsInstanced
#define glVertexAttribDivisor pmz_glVertexAttribDivisor

#endif
