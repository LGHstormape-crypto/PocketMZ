'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const canvas2d = require('./canvas2d.js');
const webgl = require('./webgl.js');
const memguard = require('./memguard.js');

// 1. Test canvas2d.js _cs LRU pool
{
  let cvSeq = 0;
  const mockPmz = {
    cvFromRGBA(data, w, h) { return { id: ++cvSeq, w, h }; },
    cvCreate(w, h) { return { id: ++cvSeq, w, h }; },
    cvResize() {},
  };
  class FakeElement { constructor(tag) { this.tagName = tag.toUpperCase(); } }
  const c2d = canvas2d.create({
    pmz: mockPmz,
    FakeElement,
    resolvePath: p => p,
    createGL: () => null,
    csCacheMaxBytes: 1024 * 1024, // 1 MB
  });

  const makeImg = (w, h) => ({
    tagName: 'IMG',
    _pix: { width: w, height: h, data: new Uint8Array(w * h * 4) },
    _cs: null,
    _csPix: null,
  });

  // 512x512 = 1 MB each -> limit 1 MB holds at most 1 image
  const imgA = makeImg(512, 512);
  const imgB = makeImg(512, 512);
  // 256x256 = 256 KB each
  const imgC = makeImg(256, 256);
  const imgD = makeImg(256, 256);

  assert.ok(c2d.nativeOf(imgA));
  assert.strictEqual(c2d.getImageSurfaceStats().bytes, 1024 * 1024);

  assert.ok(c2d.nativeOf(imgB));
  assert.strictEqual(imgA._cs, null, 'imgA should be evicted when imgB exceeds 1 MB');
  assert.ok(imgB._cs, 'imgB should stay cached');
  assert.strictEqual(c2d.getImageSurfaceStats().bytes, 1024 * 1024);

  c2d.dropImageSurface(imgB);
  assert.strictEqual(imgB._cs, null);
  assert.strictEqual(c2d.getImageSurfaceStats().bytes, 0);

  // Hit refreshes LRU order
  c2d.nativeOf(imgC);
  c2d.nativeOf(imgD);
  c2d.nativeOf(imgC); // refresh C so D is oldest
  assert.strictEqual(c2d.getImageSurfaceStats().bytes, 512 * 1024);
  const freed = c2d.trimImageSurfaces(256 * 1024);
  assert.strictEqual(freed, 256 * 1024);
  assert.strictEqual(imgD._cs, null, 'oldest imgD should be trimmed first');
  assert.ok(imgC._cs, 'recently used imgC should remain');
}

// 2. Test webgl.js texture & renderbuffer external memory accounting (zero drift)
{
  let extMem = 0;
  let seq = 0;
  const mockPmz = {
    getString: () => '',
    getShaderPrecisionFormat: () => [0, 0, 0],
    getIntegerv: () => [4096],
    viewport() {},
    scissor() {},
    createTexture: () => ++seq,
    deleteTexture() {},
    bindTexture() {},
    texImage2D() {},
    createRenderbuffer: () => ++seq,
    deleteRenderbuffer() {},
    bindRenderbuffer() {},
    renderbufferStorage() {},
    adjustExternalMemory(d) { extMem += d; return extMem; },
  };
  const canvas = { width: 816, height: 624 };
  const gl = new webgl.WebGLRenderingContext(canvas, {}, {
    pmz: mockPmz, drawableWidth: 640, drawableHeight: 480,
    es3: false, hasVao: false, hasInstancing: false, glMemWeight: 0.5,
  });

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // 1000x1000 RGBA = 4,000,000 bytes -> 0.5 weight = 2,000,000
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1000, 1000, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  assert.strictEqual(gl._glMemBytes, 4000000);
  assert.strictEqual(extMem, 2000000);

  // Odd-byte texture (1x1 RGB = 3 bytes -> Math.round(1.5) = 2)
  const texOdd = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texOdd);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, null);
  assert.strictEqual(extMem, 2000002);

  // Renderbuffer 100x100 STENCIL_INDEX8 (1 bpp = 10,000 -> 5,000)
  const rb = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.STENCIL_INDEX8, 100, 100);
  assert.strictEqual(extMem, 2005002);

  gl.deleteTexture(tex);
  gl.deleteTexture(texOdd);
  gl.deleteRenderbuffer(rb);
  assert.strictEqual(gl._glMemBytes, 0);
  assert.strictEqual(extMem, 0, 'external memory must return to exact 0 without drift');
}

// 3. Test memguard.js soft shrink, hard streak, save grace, and atomicWriteFileSync
{
  const parsed = memguard.parseMemInfo('MemTotal: 1000000 kB\nMemAvailable: 140000 kB\nSwapFree: 90000 kB\n');
  assert.strictEqual(parsed.memAvailableKB, 140000);
  assert.strictEqual(parsed.swapFreeKB, 90000);

  let nowMs = 0;
  let availMB = 200;
  let swapMB = 200;
  let pending = 0;
  let shrinks = 0;
  let terms = 0;

  const g = memguard.createMemGuard({
    softMB: 160, hardMB: 120, swapHardMB: 120, critMB: 80,
    hardStreak: 3, shrinkCooldownMs: 8000, saveGraceMs: 3000,
    now: () => nowMs,
    readMemInfo: () => ({ memAvailableKB: availMB * 1024, swapFreeKB: swapMB * 1024 }),
    onShrink: () => { shrinks++; },
    getPendingSaves: () => pending,
    onTerminate: () => { terms++; },
  });

  assert.strictEqual(g.tick(), 'ok');
  availMB = 150;
  assert.strictEqual(g.tick(), 'soft');
  assert.strictEqual(shrinks, 1);
  nowMs += 2000;
  assert.strictEqual(g.tick(), 'soft');
  assert.strictEqual(shrinks, 1, 'cooldown should prevent repeated shrink');

  // Hard streak resets if memory recovers
  availMB = 100; swapMB = 100;
  assert.strictEqual(g.tick(), 'warn'); // streak 1
  assert.strictEqual(g.tick(), 'warn'); // streak 2
  availMB = 180; swapMB = 200;
  assert.strictEqual(g.tick(), 'ok');   // reset
  availMB = 100; swapMB = 100; pending = 1;
  assert.strictEqual(g.tick(), 'warn'); // streak 1
  assert.strictEqual(g.tick(), 'warn'); // streak 2
  assert.strictEqual(g.tick(), 'grace'); // streak 3, delayed due to save in flight
  assert.strictEqual(terms, 0);
  nowMs += 3100;
  assert.strictEqual(g.tick(), 'terminated'); // grace expired
  assert.strictEqual(terms, 1);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-mg-'));
  const target = path.join(tmpDir, 'file1.rmmzsave');
  memguard.atomicWriteFileSync(fs, target, 'save-payload', 'utf8');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'save-payload');
  assert.strictEqual(fs.existsSync(target + '.pmz.tmp'), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('test-p0-memory ok');
