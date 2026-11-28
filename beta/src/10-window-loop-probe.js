// ---------- GL window + frame loop ----------
const warned = new Set(), warnings = [], glMessages = [], frames = [], runtimeStubs = new Set();
function warnOnce(m) { if (!warned.has(m)) { warned.add(m); warnings.push(m); log('WARN', m); } }
function stubWarn(name) { if (!runtimeStubs.has(name)) { runtimeStubs.add(name); warnOnce('runtime stub: ' + name); } }
let glInfo = null, mainGL = null, mainCanvas = null, shotPending = null, shotInfo = null, lastFrameStart = 0, nextTickAt = 0, lastGameDrewAt = 0, pp = null;
function ensurePostProc() {
  if (!pp) pp = require(path.join(PMZRT_DIR, 'postproc.js')).create({ pmz, getGL: () => mainGL, getDrawable: () => glInfo, onLog: (...a) => log(...a) });
  return pp;
}
if (proc.env.PMZ_SHADER && proc.env.PMZ_SHADER !== 'off') ensurePostProc().setMode(proc.env.PMZ_SHADER);
const shotInfos = {};
const timings = {};
function initWindow() {
  const t0 = nowMs();
  glInfo = pmz.init({ width: 640, height: 480, fullscreen: true, vsync: true, title: 'pmzrun' });
  timings.windowInitMs = nowMs() - t0;
  log('window', JSON.stringify(glInfo), 'init ' + timings.windowInitMs.toFixed(0) + ' ms');
  pmz.glClearColor(0, 0, 0, 1); pmz.glClear(pmz.COLOR_BUFFER_BIT); pmz.swap();
  frameLoop();
}
let debugInstalled = false, glDebugStats = null;
function createMainGL(canvas, attrs, probe) {
  if (GLDEBUG && !debugInstalled) { debugInstalled = true; glDebugStats = webgl.installDebug(pmz, m => { glMessages.push(m); log(m); }); }
  const gl = new webgl.WebGLRenderingContext(canvas, attrs, {
    pmz, drawableWidth: glInfo.drawableWidth, drawableHeight: glInfo.drawableHeight,
    es3: glInfo.es3, hasVao: glInfo.hasVao, hasInstancing: glInfo.hasInstancing,
    gpuWorkarounds: proc.env.PMZ_GPU_WORKAROUNDS || '',
    glMemWeight: proc.env.PMZ_GL_MEM_WEIGHT !== undefined && proc.env.PMZ_GL_MEM_WEIGHT !== '' ? parseFloat(proc.env.PMZ_GL_MEM_WEIGHT) : 0.5,
    onWarn: warnOnce, probe: !!probe,
  });
  if (probe) return gl;
  mainGL = gl;
  mainCanvas = canvas;
  log('WebGL context created for ' + canvas.width + 'x' + canvas.height + ' canvas, window ' + glInfo.drawableWidth + 'x' + glInfo.drawableHeight + ', attrs ' + JSON.stringify(attrs) + ', caps ' + JSON.stringify(gl.caps));
  return mainGL;
}
// one frame: SDL events, requestAnimationFrame callbacks (engine tick + PIXI render), swap (blocks until vblank)
function frameLoop() {
  const tStart = nowMs();
  if (wa) wa.pump();   // onended of finished audio sources
  pumpVideos();        // step active <video> elements (loadeddata / timeupdate / ended)
  for (const e of pmz.pollEvents()) {
    if (e.type === 'quit') { log('quit event'); if (PLAY) { requestQuit('window close'); continue; } return finish(5); }
    if (PLAY) { if (INPUTLOG && e.type !== 'axis') log('sdl ' + JSON.stringify(e)); handleInput(e); continue; }
    // test runner: button/key presses never end the test (an accidental touch must not abort it); only a window-close event
    // does. The run ends by itself (MAXSEC / timeout in run-pmzrun.sh).
    if (e.type === 'keydown' || e.type === 'buttondown' || e.type === 'controlleradded' || e.type === 'controllerremoved') log('input ignored ' + JSON.stringify(e));
  }
  stepVirtualMouse(tStart);
  const fsVid = visibleFullscreenVideo();
  if (rafPending.size || fsVid) {
    if (!nextTickAt || tStart - nextTickAt > 50) nextTickAt = tStart;
    nextTickAt += 1000 / 60;
    if (pp && pp.active) pp.beginFrame();
    if (mainGL) mainGL._defaultFbDirty = false;
    const cbs = [...rafPending.values()]; rafPending.clear(); const ts = performance.now();
    for (const f of cbs) { try { f(ts); } catch (e) { otherErrors.push('raf: ' + e.stack); log('RAF ERROR', e && e.stack); } }
    let drew = !!(mainGL && mainGL._defaultFbDirty);
    if (fsVid && pmz.vidDrawFullscreen) { pmz.vidDrawFullscreen(fsVid._vidId, glInfo.drawableWidth, glInfo.drawableHeight); drew = true; }
    if (drew) lastGameDrewAt = tStart;
    let ovSwapped = false;
    try { ovSwapped = !!overlayFrame(drew, tStart); } catch (e) { if (!overlayFrame.failed) { overlayFrame.failed = 1; otherErrors.push('overlay: ' + e.stack); log('OVERLAY ERROR', e && e.stack); } }
    const tJs = nowMs();
    let tEnd = tJs;
    if (drew || ovSwapped) {
      if (pp && pp.active) pp.present();
      if (shotPending) takeShot();
      pmz.swap();
      tEnd = nowMs();
      if (PLAY && frames.length > 4000) frames.splice(0, 2000);   // play mode runs for hours
      const fdt = lastFrameStart ? tStart - lastFrameStart : 0;
      const fjs = tJs - tStart, fsw = tEnd - tJs;
      frames.push({ t: tEnd, dt: fdt, js: fjs, swap: fsw });
      if (PROBE_FILE && frames.length > 1) probeOnFrame(fdt, fjs, fsw, false);
      if (frames.length === 1) { timings.firstFrameAt = proc.uptime(); log('first frame'); }
      lastFrameStart = tStart;
    } else if (PROBE_FILE && tJs - tStart >= 100) {
      probeOnFrame(tJs - tStart, tJs - tStart, 0, true);
    }
    const rem = nextTickAt - tEnd;
    if (rem > 1.5) setTimeout(frameLoop, Math.round(rem));
    else { if (rem < -50) nextTickAt = tEnd; setImmediate(frameLoop); }
  } else { lastFrameStart = 0; nextTickAt = 0; setTimeout(frameLoop, 4); }   // nothing asked to render: just keep polling
}
// screenshot of the window (before swap, so the back buffer still holds the frame): saved as PNG
function takeShot() {
  const SHOTP = shotPending; shotPending = null;
  const w = glInfo.drawableWidth, h = glInfo.drawableHeight, buf = new Uint8Array(w * h * 4);
  mainGL.bindFramebuffer(mainGL.FRAMEBUFFER, null);
  pmz.readPixels(0, 0, w, h, mainGL.RGBA, mainGL.UNSIGNED_BYTE, buf);
  let lit = 0, r = 0, g = 0, b = 0;
  for (let i = 0; i < buf.length; i += 4) if (buf[i] | buf[i + 1] | buf[i + 2]) { lit++; r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
  fs.mkdirSync(path.dirname(SHOTP), { recursive: true });
  pmz.writePng(SHOTP, w, h, buf, true);
  shotInfo = shotInfos[SHOTP] = { path: SHOTP, width: w, height: h, nonBlackPct: +(100 * lit / (w * h)).toFixed(1), meanRGB: lit ? [r / lit, g / lit, b / lit].map(v => +v.toFixed(0)) : [0, 0, 0] };
  log('screenshot', JSON.stringify(shotInfo));
}
function frameStats(t0, t1) {
  const fr = frames.filter(f => f.t >= t0 && f.t <= t1 && f.dt > 0 && f.dt < 500);
  if (!fr.length) return null;
  const dts = fr.map(f => f.dt).sort((a, b) => a - b), avg = a => a.reduce((x, y) => x + y, 0) / a.length, q = p => dts[Math.min(dts.length - 1, Math.floor(p * dts.length))];
  return { frames: fr.length, fps: +(1000 / avg(dts)).toFixed(1), avgMs: +avg(dts).toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2), maxMs: +dts[dts.length - 1].toFixed(2),
    over20: dts.filter(d => d > 20).length, over33: dts.filter(d => d > 33).length, jsAvgMs: +avg(fr.map(f => f.js)).toFixed(2), swapAvgMs: +avg(fr.map(f => f.swap)).toFixed(2) };
}

// ---------- continuous + event-driven telemetry probe (when PMZ_PROBE_FILE is set) ----------
let probeLastT = nowMs(), probeScene = '', probeMap = -1;
const probePendingEvents = [];
function probeCurState() {
  let scene = '', mapId = 0;
  try { if (typeof SceneManager !== 'undefined' && SceneManager._scene && SceneManager._scene.constructor) scene = SceneManager._scene.constructor.name || ''; } catch (e) {}
  try { if (typeof $gameMap !== 'undefined' && $gameMap && typeof $gameMap.mapId === 'function') mapId = $gameMap.mapId() || 0; } catch (e) {}
  return { scene, mapId };
}
function probeOnFrame(dt, js, swap, noDraw) {
  const st = probeCurState();
  if (dt >= 100 && probePendingEvents.length < 200) {
    probePendingEvents.push({
      ev: 'stutter', ts: +(Date.now() / 1000).toFixed(2), up: +proc.uptime().toFixed(2),
      dt: +dt.toFixed(1), js: +js.toFixed(1), swap: +swap.toFixed(1), noDraw: noDraw ? 1 : undefined,
      scene: st.scene, mapId: st.mapId, heapMB: +(proc.memoryUsage().heapUsed / 1048576).toFixed(1),
    });
  }
  if (st.scene !== probeScene || st.mapId !== probeMap) {
    if (probePendingEvents.length < 200) {
      probePendingEvents.push({
        ev: 'scene', ts: +(Date.now() / 1000).toFixed(2), up: +proc.uptime().toFixed(2),
        from: probeScene, to: st.scene, mapFrom: probeMap, mapTo: st.mapId,
        heapMB: +(proc.memoryUsage().heapUsed / 1048576).toFixed(1),
        canvasMB: +MB(acct.canvasLive).toFixed(1), canvasN: acct.canvasCount,
        imageMB: +MB(acct.imageLive).toFixed(1), imageN: acct.imageCount,
        glGc: mainGL && mainGL._gcStats ? Object.assign({}, mainGL._gcStats) : null,
      });
    }
    probeScene = st.scene;
    probeMap = st.mapId;
  }
}
function flushProbe() {
  if (!PROBE_FILE) return;
  try {
    const t0 = probeLastT, t1 = nowMs();
    probeLastT = t1;
    const fr = frames.filter(f => f.t > t0 && f.t <= t1 && f.dt > 0 && f.dt < 2000);
    let win = null;
    if (fr.length) {
      const dts = fr.map(f => f.dt).sort((a, b) => a - b);
      const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
      const q = p => dts[Math.min(dts.length - 1, Math.floor(p * dts.length))];
      win = {
        n: fr.length, fps: +(1000 / avg(dts)).toFixed(1), avgMs: +avg(dts).toFixed(2),
        p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), p99: +q(0.99).toFixed(1), maxMs: +dts[dts.length - 1].toFixed(1),
        over33: dts.filter(d => d > 33).length, over50: dts.filter(d => d > 50).length, over100: dts.filter(d => d > 100).length,
        jsAvg: +avg(fr.map(f => f.js)).toFixed(2), swapAvg: +avg(fr.map(f => f.swap)).toFixed(2),
      };
    }
    const st = probeCurState(), mu = proc.memoryUsage();
    let auBufMB = null, auOver50 = null;
    try {
      if (pmz.auStats) {
        const as = pmz.auStats();
        if (as) { auBufMB = +MB(as.bufferBytes || 0).toFixed(1); auOver50 = as.over50pct || 0; }
      }
    } catch (e) {}
    const lines = probePendingEvents.splice(0, probePendingEvents.length).map(e => JSON.stringify(e));
    lines.push(JSON.stringify({
      ev: 'win', ts: +(Date.now() / 1000).toFixed(2), up: +proc.uptime().toFixed(2),
      scene: st.scene, mapId: st.mapId, win,
      heapMB: +MB(mu.heapUsed).toFixed(1), extMB: +MB(mu.external).toFixed(1), abMB: +MB(mu.arrayBuffers).toFixed(1),
      canvasMB: +MB(acct.canvasLive).toFixed(1), canvasN: acct.canvasCount,
      imageMB: +MB(acct.imageLive).toFixed(1), imageN: acct.imageCount,
      glGc: mainGL && mainGL._gcStats ? Object.assign({}, mainGL._gcStats) : null,
      stubs: (runtimeStubs.size || (mainGL && mainGL.stubs.size)) ? [...Array.from(runtimeStubs), ...(mainGL ? Array.from(mainGL.stubs, s => 'gl:' + s) : [])] : undefined,
      glErrs: typeof glMessages !== 'undefined' ? glMessages.length : 0,
      otherErrs: typeof otherErrors !== 'undefined' ? otherErrors.length : 0,
      snaps: globalThis.PMZ_IMG ? (globalThis.PMZ_IMG.snaps || 0) : 0,
      auBufMB, auOver50,
    }));
    fs.appendFileSync(PROBE_FILE, lines.join('\n') + '\n');
  } catch (e) {}
}
if (PROBE_FILE) setInterval(flushProbe, 5000).unref();
