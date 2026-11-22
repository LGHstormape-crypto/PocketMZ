'use strict';
// Media test (audio FFmpeg fallback + native video decode/sync/GL blit/texImage2D).
// Usage (in chroot with Wayland/SDL): node /opt/beta/pmzrt/test-media.js /tmp/pmz-media-test
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const pmz = require('/opt/beta/pmzrt/pmzrt.node');
const { WebGLRenderingContext, installDebug } = require('/opt/beta/pmzrt/webgl.js');

const CUSTOM_DIR = process.argv[2] || '';
const DIR = CUSTOM_DIR || '/tmp/pmz-media-test';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ensureFixtures() {
  fs.mkdirSync(DIR, { recursive: true });
  const run = args => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (!fs.existsSync(path.join(DIR, 'tone.m4a')))
    run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5:sample_rate=44100', '-c:a', 'aac', '-b:a', '96k', path.join(DIR, 'tone.m4a')]);
  if (!fs.existsSync(path.join(DIR, 'tone.mp3')))
    run(['-f', 'lavfi', '-i', 'sine=frequency=880:duration=1.5:sample_rate=44100', '-c:a', 'libmp3lame', '-b:a', '96k', path.join(DIR, 'tone.mp3')]);
  if (!fs.existsSync(path.join(DIR, 'tone.wav')))
    run(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=1.0:sample_rate=44100', '-c:a', 'pcm_s16le', path.join(DIR, 'tone.wav')]);
  if (!fs.existsSync(path.join(DIR, 'clip.mp4')))
    run(['-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=30:duration=2.0', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.0:sample_rate=44100',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-shortest', path.join(DIR, 'clip.mp4')]);
  if (!fs.existsSync(path.join(DIR, 'clip.webm')))
    run(['-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=24:duration=1.5', '-f', 'lavfi', '-i', 'sine=frequency=523:duration=1.5:sample_rate=48000',
      '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', path.join(DIR, 'clip.webm')]);
}

let fails = 0;
const check = (name, ok, detail) => {
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' ' + JSON.stringify(detail) : ''));
};

function readAB(f) {
  const b = fs.readFileSync(f);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
}

(async () => {
  ensureFixtures();
  // ---- 1. Audio FFmpeg fallback (.m4a, .mp3, .wav + bad input) ----
  const au = pmz.auInit(0.0, '', 44100, 512);
  check('auInit ok', !!au.ok, au);

  for (const [fn, expSec] of [['tone.m4a', 1.5], ['tone.mp3', 1.5], ['tone.wav', 1.0]]) {
    const fp = path.join(DIR, fn);
    const t0 = Date.now();
    const dec = await pmz.auDecode(readAB(fp));
    const ms = Date.now() - t0;
    const sec = dec.length / dec.sampleRate;
    const pcm = pmz.auBufRead(dec.id, 0, 0, Math.min(dec.length, 44100));
    let sumsq = 0, peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const a = Math.abs(pcm[i]);
      sumsq += pcm[i] * pcm[i];
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sumsq / Math.max(1, pcm.length));
    check(`auDecode ${fn} ok`, dec.length > 0 && Math.abs(sec - expSec) < 0.25 && rms > 0.05 && peak > 0.1,
      { sr: dec.sampleRate, ch: dec.numberOfChannels, sec: +sec.toFixed(3), rms: +rms.toFixed(3), peak: +peak.toFixed(3), ms });
    pmz.auBufFree(dec.id);
  }

  let badRejected = false;
  try {
    await pmz.auDecode(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer);
  } catch (e) {
    badRejected = true;
  }
  check('auDecode rejects garbage cleanly', badRejected);

  // ---- 2. Video init + GL context ----
  const info = pmz.init({ width: 640, height: 480, fullscreen: 1, vsync: 1, title: 'test-media' });
  console.log('gl info:', JSON.stringify(info));
  const glErrors = [];
  if (process.env.PMZ_GLDEBUG === '1') installDebug(pmz, m => glErrors.push(m));
  const canvas = { width: 640, height: 480 };
  const dw = info.drawableWidth || 640, dh = info.drawableHeight || 480;
  const gl = new WebGLRenderingContext(canvas, {}, {
    pmz, drawableWidth: dw, drawableHeight: dh,
    es3: !!info.es3, hasVao: !!info.hasVao, hasInstancing: !!info.hasInstancing,
  });

  // ---- 3. MP4 (file path): decode, fullscreen blit, GL state preserve, audio mix, seek, end ----
  const mp4 = pmz.vidOpen(path.join(DIR, 'clip.mp4'));
  check('vidOpen mp4 ok', mp4.id > 0 && mp4.width === 640 && mp4.height === 360 && mp4.outWidth === 640 && mp4.outHeight === 360 && mp4.hasAudio === 1, mp4);

  pmz.auStats(1);
  pmz.vidPlay(mp4.id);

  // Wait for first several frames
  let st = null;
  for (let i = 0; i < 120; i++) {
    pmz.pollEvents();
    st = pmz.vidState(mp4.id);
    if (st && st.ready && st.frameSeq >= 6) break;
    await sleep(25);
  }
  check('mp4 ready & frames advancing', !!(st && st.ready && st.frameSeq >= 6), st);

  // Set distinctive GL state to verify vidDrawFullscreen preserves everything
  gl.viewport(10, 20, 300, 200);
  gl.clearColor(0.25, 0.5, 0.75, 1.0);
  gl.enable(gl.BLEND);
  gl.enable(gl.SCISSOR_TEST);
  gl.colorMask(true, false, true, true);

  pmz.vidDrawFullscreen(mp4.id, dw, dh);
  const drawErr = pmz.getError();
  check('vidDrawFullscreen 0 GL error', drawErr === 0, drawErr);

  // Check GL state preserved
  const vpAfter = pmz.getIntegerv(0xBA2, 4);
  const ccAfter = pmz.getFloatv(0xC22, 4);
  const blAfter = gl.isEnabled(gl.BLEND);
  const scAfter = gl.isEnabled(gl.SCISSOR_TEST);
  const cmAfter = pmz.getBooleanv(0xC23, 4);
  check('vidDrawFullscreen preserves GL state',
    vpAfter[0] === 10 && vpAfter[1] === 20 && vpAfter[2] === 300 && vpAfter[3] === 200 &&
    Math.abs(ccAfter[0] - 0.25) < 0.01 && Math.abs(ccAfter[1] - 0.5) < 0.01 &&
    blAfter === true && scAfter === true && cmAfter[1] === 0,
    { vpAfter: [...vpAfter], ccAfter: [...ccAfter], blAfter, scAfter, cmAfter: [...cmAfter] });

  // Reset scissor/colorMask to readPixels from default framebuffer
  gl.disable(gl.SCISSOR_TEST);
  gl.colorMask(true, true, true, true);

  // Sample center (inside 640x360 letterbox on 640x480 -> y in [60..420]) and top letterbox (y=10)
  const midPx = new Uint8Array(64 * 4);
  pmz.readPixels(288, 240, 64, 1, 0x1908, 0x1401, midPx);
  let nonBlack = 0, maxC = 0;
  for (let i = 0; i < midPx.length; i += 4) {
    const m = Math.max(midPx[i], midPx[i + 1], midPx[i + 2]);
    if (m > 20) nonBlack++;
    if (m > maxC) maxC = m;
  }
  const barPx = new Uint8Array(16 * 4);
  pmz.readPixels(300, 10, 16, 1, 0x1908, 0x1401, barPx);
  let barMax = 0;
  for (let i = 0; i < barPx.length; i += 4) barMax = Math.max(barMax, barPx[i], barPx[i + 1], barPx[i + 2]);
  check('mp4 fullscreen pixels non-black & letterbox black', nonBlack >= 32 && maxC > 100 && barMax === 0, { nonBlack, maxC, barMax });
  pmz.swap();

  // Check video audio mixed into SDL audio stream
  await sleep(350);
  const astats = pmz.auStats(0);
  check('mp4 audio mixed (non-zero RMS)', astats.rms > 0.01 && astats.peak > 0.05, astats);

  // Pause, seek near end, resume and wait for ended
  pmz.vidPause(mp4.id);
  const seqPaused = pmz.vidState(mp4.id).frameSeq;
  await sleep(150);
  const stPaused = pmz.vidState(mp4.id);
  check('mp4 pause holds frames', stPaused.playing === 0 && stPaused.frameSeq <= seqPaused + 1, { seqPaused, after: stPaused.frameSeq });

  pmz.vidSeek(mp4.id, 1.4);
  pmz.vidPlay(mp4.id);
  let ended = false;
  for (let i = 0; i < 120; i++) {
    pmz.pollEvents();
    st = pmz.vidState(mp4.id);
    if (st && st.ended) { ended = true; break; }
    await sleep(30);
  }
  check('mp4 seek & ended ok', ended, st);
  pmz.vidClose(mp4.id);

  // ---- 4. WebM (Buffer / blob: memory open, 1280x720 -> auto downscale 640x360, WebGL texImage2D) ----
  const webmBuf = fs.readFileSync(path.join(DIR, 'clip.webm'));
  const webm = pmz.vidOpen(webmBuf);
  check('vidOpen webm Buffer + downscale ok',
    webm.id > 0 && webm.width === 1280 && webm.height === 720 && webm.outWidth === 640 && webm.outHeight === 360, webm);

  pmz.vidSetLoop(webm.id, true);
  pmz.vidSetMuted(webm.id, true);
  pmz.vidSetVolume(webm.id, 0.5);
  pmz.vidPlay(webm.id);
  for (let i = 0; i < 120; i++) {
    pmz.pollEvents();
    st = pmz.vidState(webm.id);
    if (st && st.ready && st.frameSeq >= 3) break;
    await sleep(25);
  }
  check('webm ready & decoding', !!(st && st.ready && st.frameSeq >= 3), st);

  // Upload to WebGL texture via webgl.js texImage2D + texSubImage2D
  const fakeVideoEl = { tagName: 'VIDEO', _vidId: webm.id, readyState: 4, videoWidth: webm.outWidth, videoHeight: webm.outHeight, width: webm.outWidth, height: webm.outHeight };
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, fakeVideoEl);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, fakeVideoEl);
  const texErr = pmz.getError();
  check('webgl.js texImage2D + texSubImage2D(VIDEO) 0 GL error', texErr === 0, texErr);

  // Read back uploaded texture through an FBO to verify non-black video pixels
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  const tpx = new Uint8Array(64 * 4);
  gl.readPixels(288, 180, 64, 1, gl.RGBA, gl.UNSIGNED_BYTE, tpx);
  let tNonBlack = 0;
  for (let i = 0; i < tpx.length; i += 4) if (Math.max(tpx[i], tpx[i + 1], tpx[i + 2]) > 20) tNonBlack++;
  check('webgl.js VIDEO texture has real pixels', fbStatus === gl.FRAMEBUFFER_COMPLETE && tNonBlack >= 32, { fbStatus, tNonBlack });
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(tex);

  pmz.vidClose(webm.id);
  check('0 GL debug errors overall', glErrors.length === 0, glErrors);

  pmz.shutdown();
  if (!CUSTOM_DIR) { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} }
  console.log(`DONE fails=${fails}`);
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error(e);
  try { pmz.shutdown(); } catch {}
  process.exit(1);
});
