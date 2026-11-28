'use strict';
// postproc.js - zero-overhead-when-off single-pass GLES2 post-processing shader (sharp, lcd, crt, cas)
const MODES = ['off', 'sharp', 'lcd', 'crt', 'cas'];

const VERTEX_SRC = [
  'attribute vec2 a_pos;',
  'varying vec2 v_uv;',
  'void main() {',
  '  v_uv = a_pos * 0.5 + 0.5;',
  '  gl_Position = vec4(a_pos, 0.0, 1.0);',
  '}',
].join('\n');

function fragmentSource(mode) {
  if (mode === 'sharp') {
    return [
      'precision mediump float;',
      'uniform sampler2D u_tex;',
      'uniform vec2 u_texSize;',
      'uniform vec2 u_outSize;',
      'varying vec2 v_uv;',
      'void main() {',
      '  vec2 scale = max(vec2(1.0), floor(u_outSize / max(u_texSize, vec2(1.0)) + 0.5));',
      '  vec2 texel = v_uv * u_texSize;',
      '  vec2 fl = floor(texel);',
      '  vec2 fr = texel - fl;',
      '  vec2 w = clamp((fr - 0.5) * scale + 0.5, 0.0, 1.0);',
      '  vec2 uv = (fl + w) / u_texSize;',
      '  gl_FragColor = texture2D(u_tex, uv);',
      '}',
    ].join('\n');
  }
  if (mode === 'lcd') {
    return [
      'precision mediump float;',
      'uniform sampler2D u_tex;',
      'uniform vec2 u_texSize;',
      'uniform vec2 u_outSize;',
      'varying vec2 v_uv;',
      'void main() {',
      '  vec4 c = texture2D(u_tex, v_uv);',
      '  vec2 p = fract(v_uv * u_texSize);',
      '  float gx = smoothstep(0.0, 0.12, p.x) * (1.0 - smoothstep(0.88, 1.0, p.x));',
      '  float gy = smoothstep(0.0, 0.12, p.y) * (1.0 - smoothstep(0.88, 1.0, p.y));',
      '  float grid = mix(0.82, 1.0, gx * gy);',
      '  gl_FragColor = vec4(c.rgb * grid, c.a);',
      '}',
    ].join('\n');
  }
  if (mode === 'crt') {
    return [
      'precision mediump float;',
      'uniform sampler2D u_tex;',
      'uniform vec2 u_texSize;',
      'uniform vec2 u_outSize;',
      'varying vec2 v_uv;',
      'void main() {',
      '  vec4 c = texture2D(u_tex, v_uv);',
      '  float scan = 0.88 + 0.12 * cos(v_uv.y * u_texSize.y * 6.2831853);',
      '  vec2 d = v_uv - 0.5;',
      '  float vig = clamp(1.0 - dot(d, d) * 0.45, 0.7, 1.0);',
      '  gl_FragColor = vec4(c.rgb * scan * vig, c.a);',
      '}',
    ].join('\n');
  }
  if (mode === 'cas') {
    return [
      'precision mediump float;',
      'uniform sampler2D u_tex;',
      'uniform vec2 u_texSize;',
      'uniform vec2 u_outSize;',
      'varying vec2 v_uv;',
      'void main() {',
      '  vec2 px = 1.0 / max(u_texSize, vec2(1.0));',
      '  vec3 c = texture2D(u_tex, v_uv).rgb;',
      '  vec3 n = texture2D(u_tex, v_uv + vec2(0.0, -px.y)).rgb;',
      '  vec3 s = texture2D(u_tex, v_uv + vec2(0.0,  px.y)).rgb;',
      '  vec3 w = texture2D(u_tex, v_uv + vec2(-px.x, 0.0)).rgb;',
      '  vec3 e = texture2D(u_tex, v_uv + vec2( px.x, 0.0)).rgb;',
      '  vec3 mn = min(c, min(min(n, s), min(w, e)));',
      '  vec3 mx = max(c, max(max(n, s), max(w, e)));',
      '  vec3 sharp = clamp(c + (c - 0.25 * (n + s + w + e)) * 0.35, mn, mx);',
      '  gl_FragColor = vec4(sharp, 1.0);',
      '}',
    ].join('\n');
  }
  return null;
}

function create({ pmz, getGL, getDrawable, onLog = () => {} }) {
  let mode = 'off';
  let fbo = 0, tex = 0, rb = 0, vbo = 0, prog = 0, vs = 0, fs = 0;
  let uTex = -1, uTexSize = -1, uOutSize = -1;
  let texW = 0, texH = 0, compiledMode = '';

  function dispose() {
    const gl = getGL();
    if (gl) gl._defaultFboId = 0;
    if (fbo) { try { pmz.deleteFramebuffer(fbo); } catch (_) {} fbo = 0; }
    if (tex) { try { pmz.deleteTexture(tex); } catch (_) {} tex = 0; }
    if (rb) { try { pmz.deleteRenderbuffer(rb); } catch (_) {} rb = 0; }
    if (vbo) { try { pmz.deleteBuffer(vbo); } catch (_) {} vbo = 0; }
    if (prog) { try { pmz.deleteProgram(prog); } catch (_) {} prog = 0; }
    if (vs) { try { pmz.deleteShader(vs); } catch (_) {} vs = 0; }
    if (fs) { try { pmz.deleteShader(fs); } catch (_) {} fs = 0; }
    texW = 0; texH = 0; compiledMode = '';
    uTex = -1; uTexSize = -1; uOutSize = -1;
  }

  function ensureResources(gl, cw, ch) {
    if (!vbo) {
      vbo = pmz.createBuffer();
      const prevAb = gl._bound && gl._bound.ab ? gl._bound.ab._id : 0;
      pmz.bindBuffer(0x8892, vbo);
      pmz.bufferData(0x8892, new Float32Array([-1, -1, 3, -1, -1, 3]), 0x88E4);
      pmz.bindBuffer(0x8892, prevAb);
    }
    if (compiledMode !== mode) {
      if (prog) { try { pmz.deleteProgram(prog); } catch (_) {} prog = 0; }
      if (vs) { try { pmz.deleteShader(vs); } catch (_) {} vs = 0; }
      if (fs) { try { pmz.deleteShader(fs); } catch (_) {} fs = 0; }
      const fsrc = fragmentSource(mode);
      if (!fsrc) return false;
      vs = pmz.createShader(0x8B31);
      pmz.shaderSource(vs, VERTEX_SRC);
      pmz.compileShader(vs);
      if (!pmz.getShaderParameter(vs, 0x8B81)) {
        onLog('postproc VS compile failed: ' + pmz.getShaderInfoLog(vs));
        dispose(); mode = 'off'; return false;
      }
      fs = pmz.createShader(0x8B30);
      pmz.shaderSource(fs, fsrc);
      pmz.compileShader(fs);
      if (!pmz.getShaderParameter(fs, 0x8B81)) {
        onLog('postproc FS compile failed (' + mode + '): ' + pmz.getShaderInfoLog(fs));
        dispose(); mode = 'off'; return false;
      }
      prog = pmz.createProgram();
      pmz.attachShader(prog, vs);
      pmz.attachShader(prog, fs);
      pmz.bindAttribLocation(prog, 0, 'a_pos');
      pmz.linkProgram(prog);
      if (!pmz.getProgramParameter(prog, 0x8B82)) {
        onLog('postproc link failed (' + mode + '): ' + pmz.getProgramInfoLog(prog));
        dispose(); mode = 'off'; return false;
      }
      uTex = pmz.getUniformLocation(prog, 'u_tex');
      uTexSize = pmz.getUniformLocation(prog, 'u_texSize');
      uOutSize = pmz.getUniformLocation(prog, 'u_outSize');
      compiledMode = mode;
    }
    if (!fbo || texW !== cw || texH !== ch) {
      const prevFb = gl._fb ? gl._fb._id : (gl._defaultFboId || 0);
      const prevActUnit = gl._activeUnit || 0;
      const prevTex = gl._bound && gl._bound.tex2d && gl._bound.tex2d[prevActUnit] ? gl._bound.tex2d[prevActUnit]._id : 0;
      const prevRb = gl._bound && gl._bound.rb ? gl._bound.rb._id : 0;
      if (!fbo) fbo = pmz.createFramebuffer();
      if (!tex) tex = pmz.createTexture();
      if (!rb) rb = pmz.createRenderbuffer();

      pmz.bindTexture(0x0DE1, tex);
      pmz.texParameteri(0x0DE1, 0x2801, 0x2601);
      pmz.texParameteri(0x0DE1, 0x2800, 0x2601);
      pmz.texParameteri(0x0DE1, 0x2802, 0x812F);
      pmz.texParameteri(0x0DE1, 0x2803, 0x812F);
      pmz.texImage2D(0x0DE1, 0, 0x1908, cw, ch, 0, 0x1908, 0x1401, null);

      pmz.bindRenderbuffer(0x8D41, rb);
      pmz.renderbufferStorage(0x8D41, 0x8D48, cw, ch);

      pmz.bindFramebuffer(0x8D40, fbo);
      pmz.framebufferTexture2D(0x8D40, 0x8CE0, 0x0DE1, tex, 0);
      pmz.framebufferRenderbuffer(0x8D40, 0x8D20, 0x8D41, rb);

      pmz.bindRenderbuffer(0x8D41, prevRb);
      pmz.bindTexture(0x0DE1, prevTex);
      pmz.bindFramebuffer(0x8D40, prevFb);
      texW = cw; texH = ch;
    }
    gl._defaultFboId = fbo;
    return true;
  }

  const api = {
    get mode() { return mode; },
    get active() { return mode !== 'off'; },
    setMode(m) {
      const next = MODES.includes(m) ? m : 'off';
      if (next === mode) return mode;
      mode = next;
      if (mode === 'off') dispose();
      return mode;
    },
    beginFrame() {
      if (mode === 'off') return false;
      const gl = getGL();
      if (!gl || !gl.canvas) return false;
      const cw = Math.max(1, gl.canvas.width | 0);
      const ch = Math.max(1, gl.canvas.height | 0);
      if (!ensureResources(gl, cw, ch)) return false;
      if (!gl._fb) pmz.bindFramebuffer(0x8D40, fbo);
      return true;
    },
    present() {
      if (mode === 'off' || !fbo || !prog) return false;
      const gl = getGL();
      if (!gl || !gl.canvas) return false;
      const dr = getDrawable ? getDrawable() : { width: 640, height: 480 };
      const dw = dr.width || 640, dh = dr.height || 480;
      const cw = texW || gl.canvas.width || 640, ch = texH || gl.canvas.height || 480;
      const m = gl._map(0, 0, cw, ch);

      const prevFb = gl._fb ? gl._fb._id : (gl._defaultFboId || 0);
      const prevProg = gl._bound && gl._bound.prog ? gl._bound.prog._id : 0;
      const prevAb = gl._bound && gl._bound.ab ? gl._bound.ab._id : 0;
      const prevActUnit = gl._activeUnit || 0;
      pmz.activeTexture(0x84C0);
      const prevTex0 = gl._bound && gl._bound.tex2d && gl._bound.tex2d[0] ? gl._bound.tex2d[0]._id : 0;
      const prevScissor = pmz.isEnabled(0x0C11);
      const prevBlend = pmz.isEnabled(0x0BE2);
      const prevDepth = pmz.isEnabled(0x0B71);
      const prevStencil = pmz.isEnabled(0x0B90);

      pmz.bindFramebuffer(0x8D40, 0);
      if (prevScissor) pmz.disable(0x0C11);
      if (prevBlend) pmz.disable(0x0BE2);
      if (prevDepth) pmz.disable(0x0B71);
      if (prevStencil) pmz.disable(0x0B90);

      pmz.viewport(0, 0, dw, dh);
      pmz.clearColor(0, 0, 0, 1);
      pmz.clear(0x4000);

      pmz.viewport(m[0], m[1], m[2], m[3]);
      pmz.useProgram(prog);
      pmz.bindTexture(0x0DE1, tex);
      if (uTex >= 0) pmz.uniform1i(uTex, 0);
      if (uTexSize >= 0) pmz.uniform2f(uTexSize, cw, ch);
      if (uOutSize >= 0) pmz.uniform2f(uOutSize, m[2], m[3]);

      pmz.bindBuffer(0x8892, vbo);
      pmz.enableVertexAttribArray(0);
      pmz.vertexAttribPointer(0, 2, 0x1406, false, 0, 0);
      pmz.drawArrays(0x0004, 0, 3);

      pmz.bindBuffer(0x8892, prevAb);
      pmz.bindTexture(0x0DE1, prevTex0);
      pmz.activeTexture(0x84C0 + prevActUnit);
      pmz.useProgram(prevProg);
      if (prevScissor) pmz.enable(0x0C11);
      if (prevBlend) pmz.enable(0x0BE2);
      if (prevDepth) pmz.enable(0x0B71);
      if (prevStencil) pmz.enable(0x0B90);
      pmz.bindFramebuffer(0x8D40, prevFb);
      gl._applyViewport();
      gl._applyScissor();
      return true;
    },
    dispose,
  };
  return api;
}

module.exports = { MODES, VERTEX_SRC, fragmentSource, create };
