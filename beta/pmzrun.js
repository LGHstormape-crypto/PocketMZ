'use strict';
// pmzrun.js - RPG Maker MZ in plain Node (no browser): real engine + plugins + REAL PIXI renderer drawing through
// pmzrt (SDL2 window + GLES) via our WebGL1 layer (pmzrt/webgl.js). Derived from mzfloor.js (which stays as the headless reference).
// M1-3: reach the title screen on the handheld screen, hold it, take a screenshot, print stats. See run-pmzrun.sh.
// Env: GAME, HOLD (seconds on title, default 10), SHOT (png path), PMZ_GLDEBUG=1 (glGetError after every GL call), TOUCH=0.
const proc = process;
const fs = require('fs'), vm = require('vm'), path = require('path'), crypto = require('crypto');
const BETA_DIR = process.env.PMZ_BETA_DIR || __dirname;
const PMZRT_DIR = process.env.PMZ_RT_DIR || path.join(BETA_DIR, 'pmzrt');
const GAME = process.env.GAME || '/game';        // folder with js/ and data/ (MV: the thin copy's www/; run-pmzrun.sh sets it)
const GAMESRC = (() => {
  if (process.env.PMZ_GAMESRC) return process.env.PMZ_GAMESRC;
  if (GAME === '/game' && fs.existsSync('/gamesrc')) return '/gamesrc';
  if (GAME === '/game/www' && fs.existsSync('/gamesrc/www')) return '/gamesrc/www';
  return '';
})();
const SKIP_PREFIX = 'PocketMZ_';                // PocketMZ patches are dropped, except those named in PMZ_PATCHES
const KEEP_PATCHES = (process.env.PMZ_PATCHES || '').split(',').map(x => x.trim()).filter(Boolean).map(x => x.startsWith(SKIP_PREFIX) ? x : SKIP_PREFIX + x);   // e.g. PMZ_PATCHES=Handheld,PluginFixes
const PATCH_FALLBACK_DIR = process.env.PMZ_PATCHES_DIR || path.join(BETA_DIR, 'patches');   // PocketMZ_*.js that are not in the thin copy's js/plugins
const vfs = require(path.join(PMZRT_DIR, 'vfs.js')).createVfs({ gameDir: GAME, srcDir: GAMESRC, patchesDir: PATCH_FALLBACK_DIR, keepPatches: KEEP_PATCHES, fsMod: fs });
const vfsFs = vfs.createFsProxy();
const MV = vfs.existsSync(path.join(GAME, 'js', 'rpg_core.js'));   // RPG Maker MV (PIXI v4, rpg_*.js) instead of MZ (PIXI v5, rmmz_*.js)
const OUT = process.env.OUT || path.join(BETA_DIR, 'pmzrun-result.txt');
const AT_SEED = process.env.PMZ_SEED || process.env.AT_SEED || '';
if (AT_SEED !== '') {
  let _s = (parseInt(AT_SEED, 10) >>> 0) || 0x9e3779b9;
  Math.random = function () {
    _s = (_s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const HOLD = (parseFloat(process.env.HOLD) || 10) * 1000;
const SHOT = process.env.SHOT || '/opt/beta/shots/title-beta.png';   // = /storage/pocketmz/beta/shots on the device (bind-mounted by run-pmzrun.sh)
const SHOT3 = process.env.SHOT3 || '/opt/beta/shots/map-beta.png';
const SHOT4 = process.env.SHOT4 || '/opt/beta/shots/map-beta-play.png';
const SHOT5 = process.env.SHOT5 || '/opt/beta/shots/map-beta-walk.png';
const SHOT2 = process.env.SHOT2 || SHOT.replace(/title-beta/, 'options-beta');
const GLDEBUG = process.env.PMZ_GLDEBUG === '1';
// MODE=test (default): scripted harness, physical input only logged. MODE=play: boot and run the game normally (quit: Select+Start / window close).
const PLAY = process.env.MODE === 'play';
const PROBE_FILE = process.env.PMZ_PROBE_FILE || '';
// PMZ_GUARD=1 (set by pocketmz-run.sh when the game is started on β, play mode only): runtime compatibility guard. Boot problems (uncaught error / unhandled
// rejection, a failed plugin that is not whitelisted, a GL error, no first scene after Scene_Boot within PMZ_GUARD_BOOT_SEC = 40 s) and COMPAT events during play
// (video, m4a/mp4/... files) end the run with exit code 3 after writing the reason to PMZ_FAIL_FILE; the launcher then marks the game "β not OK" and starts it on NW.js.
// PMZ_GUARD_FORCE=<text> (test): fail with that reason once the first scene is reached.
const GUARD = PLAY && process.env.PMZ_GUARD === '1';
const GUARD_BOOT_SEC = parseFloat(process.env.PMZ_GUARD_BOOT_SEC) || 40;
const GUARD_PLUGIN_OK = /^(Text2Frame)\b/;       // plugins that fail in β but are harmless (Text2Frame is a dev tool that wants require.main)
let guardBooted = false, guardFailed = false;
function guardFail(reason) {
  if (!GUARD || guardFailed) return; guardFailed = true;
  reason = String(reason).replace(/\s+/g, ' ').slice(0, 300);
  console.log('GUARD FAIL (exit 3): ' + reason);
  const f = proc.env.PMZ_FAIL_FILE; if (f) { try { fs.writeFileSync(f, reason + '\n'); } catch (e) {} }
  const t0 = Date.now(), done = () => { try { pmz.shutdown(); } catch (e) {} proc.exit(3); };
  // a save in flight (async pako + write) is finished first, as on a normal quit
  const wait = () => { let n = 0; try { n = pendingSaves; } catch (e) {} if (n > 0 && Date.now() - t0 < 5000) setTimeout(wait, 50); else done(); };
  wait();
}
// Save directory (NW style: <game>/save/). Tests default to a temp dir and never touch the real one; SAVE_DIR overrides in both modes.
const SAVE_DIR = (process.env.SAVE_DIR || (PLAY ? path.join(GAME, 'save') : '/tmp/pmz-save-test')).replace(/\/*$/, '/');
const GPTK_FILE = process.env.PMZ_GPTK || '';       // fallback button map (per-game override > global default)
const USER_GPTK = process.env.PMZ_USER_GPTK || '';  // live user button map in the thin copy (/game/pocketmz.gptk), edited by PocketMZ_Menu
const pmz = require(path.join(PMZRT_DIR, 'pmzrt.node'));
const webgl = require(path.join(PMZRT_DIR, 'webgl.js'));
const memguard = require(path.join(PMZRT_DIR, 'memguard.js'));
const nowMs = () => Number(proc.hrtime.bigint()) / 1e6;
const TOUCH = process.env.TOUCH !== '0';        // touch every page of fake canvas/image buffers so RSS counts them
// PMZ_NOQUIT=1 (autotests): pad quit combos, the PocketMZ menu's quit entry and nw.App.quit() are ignored (only a window close / MAXSEC ends the run)
const NOQUIT = process.env.PMZ_NOQUIT === '1';
// PocketMZ_Debug (REPL) / PMZ_GLOBAL_REQUIRE=1: a global `require` (not `process`: Utils.isNwjs() stays false) like NW.js has it, for the injected autotest driver
const GLOBAL_REQUIRE = process.env.PMZ_GLOBAL_REQUIRE === '1' || KEEP_PATCHES.includes('PocketMZ_Debug');
const T0 = Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(((Date.now() - T0) / 1000).toFixed(1) + 's', ...a);

// ---------- memory measurement ----------
const acct = { canvasLive: 0, canvasCount: 0, imageLive: 0, imageCount: 0, canvasEver: 0, imageEver: 0 };
const failedPlugins = [], loadedPlugins = [], otherErrors = [];
function readProc() {
  const r = {};
  try {
    for (const l of fs.readFileSync('/proc/self/status', 'utf8').split('\n')) {
      const m = /^(VmRSS|RssAnon|RssFile|RssShmem|VmSwap):\s+(\d+)/.exec(l);
      if (m) r[m[1]] = +m[2] / 1024;
    }
  } catch (e) {}
  try {
    for (const l of fs.readFileSync('/proc/self/smaps_rollup', 'utf8').split('\n')) {
      const m = /^(Pss|Pss_Anon|Pss_File):\s+(\d+)/.exec(l);
      if (m) r[m[1]] = +m[2] / 1024;
    }
  } catch (e) {}
  return r;
}
const results = {};
const MB = n => (n / 1048576);
async function measure(label, extra) {
  if (global.gc) { gc(); await sleep(100); gc(); await sleep(150); gc(); }
  const mu = proc.memoryUsage(), p = readProc();
  const r = Object.assign({
    t: (Date.now() - T0) / 1000,
    rss: MB(mu.rss), heapTotal: MB(mu.heapTotal), heapUsed: MB(mu.heapUsed), external: MB(mu.external), arrayBuffers: MB(mu.arrayBuffers),
    VmRSS: p.VmRSS, RssAnon: p.RssAnon, RssFile: p.RssFile, VmSwap: p.VmSwap, Pss_Anon: p.Pss_Anon,
    canvasMB: MB(acct.canvasLive), canvasN: acct.canvasCount, imageMB: MB(acct.imageLive), imageN: acct.imageCount,
    plugins: loadedPlugins.length, failed: failedPlugins.length,
  }, extra || {});
  results[label] = r;
  log('MEASURE', label, JSON.stringify(r, (k, v) => typeof v === 'number' ? +v.toFixed(1) : v));
  return r;
}

// memory guard (soft shrink + graceful termination with save-in-flight protection)
const memGuard = memguard.createMemGuard({
  softMB: proc.env.PMZ_MEM_SOFT_MB !== undefined && proc.env.PMZ_MEM_SOFT_MB !== '' ? parseFloat(proc.env.PMZ_MEM_SOFT_MB) : 160,
  hardMB: proc.env.PMZ_MEM_HARD_MB !== undefined && proc.env.PMZ_MEM_HARD_MB !== '' ? parseFloat(proc.env.PMZ_MEM_HARD_MB) : 120,
  swapHardMB: proc.env.PMZ_SWAP_HARD_MB !== undefined && proc.env.PMZ_SWAP_HARD_MB !== '' ? parseFloat(proc.env.PMZ_SWAP_HARD_MB) : 120,
  readMemInfo: () => memguard.parseMemInfo(fs.readFileSync('/proc/meminfo', 'utf8')),
  onShrink: ({ availMB, swapMB }) => {
    let freed = 0;
    try { if (typeof c2d !== 'undefined' && c2d.trimImageSurfaces) freed = c2d.trimImageSurfaces(0); } catch (e) {}
    try { if (typeof globalThis.__pmzShrinkCaches === 'function') globalThis.__pmzShrinkCaches(); } catch (e) {}
    try { if (typeof global.gc === 'function') global.gc(); } catch (e) {}
    log('MEMGUARD shrink: avail=' + availMB.toFixed(0) + 'MB swapFree=' + (Number.isFinite(swapMB) ? swapMB.toFixed(0) : '?') + 'MB csFreed=' + (freed / 1048576).toFixed(1) + 'MB');
  },
  getPendingSaves: () => pendingSaves + activeSaveWrites,
  onTerminate: ({ availMB, swapMB }) => {
    console.log('MEMGUARD: low memory avail=' + availMB.toFixed(0) + 'MB swapFree=' + (Number.isFinite(swapMB) ? swapMB.toFixed(0) : '?') + 'MB, shutting down');
    try {
      const mi = fs.readFileSync('/proc/meminfo', 'utf8').split('\n').filter(l => /^(MemTotal|MemFree|MemAvailable|SwapTotal|SwapFree):/.test(l)).join(' | ');
      if (mi) console.log('MEMGUARD meminfo:', mi);
    } catch (e) {}
    const killTimer = setTimeout(() => proc.kill(proc.pid, 'SIGKILL'), 1500);
    if (killTimer.unref) killTimer.unref();
    try { pmz.shutdown(); } catch (e) {}
    proc.exit(137);
  },
  log,
});
setInterval(() => {
  try { memGuard.tick(); } catch (e) {}
}, 1000).unref();
proc.on('uncaughtException', e => { otherErrors.push('uncaught: ' + (e && e.stack || e)); log('UNCAUGHT', e && e.stack || e); if (!guardBooted) guardFail('uncaught error at boot: ' + String(e && e.stack || e).split('\n').slice(0, 2).join(' ')); });
proc.on('unhandledRejection', e => { otherErrors.push('unhandled: ' + (e && e.stack || e)); log('UNHANDLED', e && e.stack || e); if (!guardBooted) guardFail('unhandled rejection at boot: ' + String(e && e.stack || e).split('\n').slice(0, 2).join(' ')); });

// hide Node's `process` from the page code (emscripten libs would take their Node path); we use `proc`
Object.defineProperty(globalThis, 'process', { value: undefined, writable: true, configurable: true });
// ---------- helpers ----------
const noop = function () {};
function makeNoopProxy(extra) {
  const f = function () {};
  const p = new Proxy(f, {
    get(t, k) {
      if (extra && k in extra) return extra[k];
      if (k === 'then' || typeof k === 'symbol') return undefined;
      return p;
    },
    set() { return true; },
    apply() { return p; },
    construct() { return p; },
  });
  return p;
}
function resolvePath(u) {
  u = String(u);
  if (u.startsWith('file://')) u = u.slice(7);
  u = u.split('?')[0].split('#')[0];
  try { u = decodeURIComponent(u); } catch (e) { try { u = decodeURI(u); } catch (e2) {} }   // MZ ImageManager uses encodeURIComponent: '$' arrives as %24 (decodeURI keeps it)
  if (!u.startsWith('/')) u = path.join(GAME, u);
  return u;
}
function touch(buf) {
  if (!TOUCH) return;
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < u8.length; i += 4096) u8[i] = 1;
}
const canvasReg = new FinalizationRegistry(h => { acct.canvasLive -= h.n; acct.canvasCount--; });
const imageReg = new FinalizationRegistry(h => { acct.imageLive -= h.n; acct.imageCount--; });
// --- module: beta/src/10-window-loop-probe.js ---
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
// --- module: beta/src/20-dom-media.js ---
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
// --- module: beta/src/30-scripts-globals.js ---
// ---------- script loading (sequential, like async=false) ----------
const queue = []; let pumping = false, mainDone = false;
function enqueueScript(el) { queue.push(el); if (!pumping) setImmediate(pump); }
async function pump() {
  if (pumping) return; pumping = true;
  while (queue.length) await runScript(queue.shift());
  pumping = false;
  if (mainDone && !global.__loadFired) {
    global.__loadFired = true;
    onAllScriptsLoaded();
  }
}
function scriptName(p) { return path.basename(p, '.js'); }
async function runScript(el) {
  const file = resolvePath(el.src);
  let code;
  const isPlugin = file.replace(/\\/g, '/').includes('/js/plugins/') && !file.endsWith('plugins.js');
  const name = scriptName(file);
  try { code = await vfs.readFilePromises(file, 'utf8'); }
  catch (e) {
    if (isPlugin && name.startsWith(SKIP_PREFIX)) { try { code = await fs.promises.readFile(path.join(PATCH_FALLBACK_DIR, name + '.js'), 'utf8'); log('plugin ' + name + ' from ' + PATCH_FALLBACK_DIR); } catch (e2) {} }
    if (code === undefined) { fire(el, 'error'); return; }
  }
  if (name === 'vorbisdecoder') { await new Promise(r => setImmediate(r)); fire(el, 'load'); return; }   // JS/wasm Ogg decoder (needs Worker): skipped, decodeAudioData decodes natively (pmzrt_audio.c)
  document.currentScript = el;
  // emscripten libs sniff `process` and would take their Node path (require/__dirname): hide it during load so they use the web path (XHR)
  const hideProc = false, realProc = null;
  try {
    if (hideProc) globalThis.process = undefined;
    if (isPlugin && name.startsWith(SKIP_PREFIX)) {
      // PocketMZ_* patches were written for NW.js (window.require / process.env / nw.__dirname, guarded by checks): they get those three names and a
      // window whose require/process/nw are the same, as function parameters (not globals: engine and other plugins keep seeing a plain browser)
      const fn = vm.runInThisContext('(function (window, require, process, nw) {' + code + '\n})', { filename: file });
      fn.call(globalThis, patchWindow, require, patchProcess, nwShim); loadedPlugins.push(name);
    } else { vm.runInThisContext(code, { filename: file }); if (isPlugin) loadedPlugins.push(name); }
  }
  catch (e) {
    if (isPlugin && e instanceof ReferenceError) {
      const m = /^([A-Za-z_$][\w$]*) is not defined$/.exec(String(e.message || ''));
      const re = m ? new RegExp('\\bfor\\s*\\(\\s*' + m[1] + '\\s+(in|of)\\b') : null;
      if (re && re.test(code)) {
        try {
          const fixed = code.replace(re, 'for (let ' + m[1] + ' $1');
          vm.runInThisContext(fixed, { filename: file });
          loadedPlugins.push(name);
          log('PATCHED plugin ' + name + ': added let to undeclared loop var ' + m[1]);
          document.currentScript = null;
          try { await afterScript(name); } catch (e2) { otherErrors.push('hook ' + name + ': ' + e2.stack); }
          await new Promise(r => setImmediate(r));
          fire(el, 'load');
          return;
        } catch (eRetry) { e = eRetry; }
      }
    }
    if (isPlugin) failedPlugins.push(name + ': ' + (e && e.message)); else otherErrors.push('script ' + name + ': ' + (e && e.stack)); log("SCRIPT ERROR", name, String(e && e.message).slice(0, 200));
    if (!guardBooted && !GUARD_PLUGIN_OK.test(name)) guardFail((isPlugin ? 'plugin ' : 'script ') + name + ' failed: ' + String(e && e.message).slice(0, 150)); }
  finally { if (hideProc) globalThis.process = realProc; }
  document.currentScript = null;
  try { await afterScript(name); } catch (e) { otherErrors.push('hook ' + name + ': ' + e.stack); }
  await new Promise(r => setImmediate(r));
  if (name === (MV ? 'main' : 'plugins')) mainDone = true;   // MV: main.js (PluginManager.setup) queues the plugin scripts; MZ: plugins.js
  fire(el, 'load');
}
async function afterScript(name) {
  if (name === 'pixi') {
    log('PIXI ' + PIXI.VERSION);
    // real PIXI.Application / renderer. MZ swallows exceptions of its constructor (Graphics._createPixiApp), so log them here.
    const RealApp = PIXI.Application;
    if (RealApp && !MV) PIXI.Application = class extends RealApp { constructor(o) { try { super(o); } catch (e) { log('PIXI.Application FAILED', e && e.stack || e); otherErrors.push('PIXI.Application: ' + (e && e.stack)); throw e; } } };
    await measure('baseline_shims_pixi');
  }
  if (name === 'rmmz_core') Utils.canUseWebGL = () => true;
  if (name === 'effekseer.min') {
    if (typeof effekseer !== 'undefined' && EFK_FAKE) effekseer.createContext = () => makeFakeEffekseerContext();
  }
  if (name === 'plugins') {
    const before = $plugins.length;
    $plugins = $plugins.filter(p => !p.name.startsWith(SKIP_PREFIX) || KEEP_PATCHES.includes(p.name));
    if (KEEP_PATCHES.includes('PocketMZ_Debug') && !$plugins.some(p => p.name === 'PocketMZ_Debug')) $plugins.push({ name: 'PocketMZ_Debug', status: true, description: '', parameters: {} });   // like pocketmz-run.sh in dev mode
    log('plugins.js: ' + before + ' entries, ' + $plugins.length + ' after dropping ' + SKIP_PREFIX + '* (kept: ' + (KEEP_PATCHES.join(',') || 'none') + ')');
  }
}
// Effekseer stand-in: nothing is drawn, but a played effect "exists" for as long as the real one does, because MZ's Sprite_Animation (and so battle
// flow) waits for handle.exists to turn false. Lifetimes (update() calls at speed 1) were measured once with the real Effekseer under NW.js
// (effect-lifetimes.json, 80 effects from a reference MZ game; unknown effects 90). update(dt) is called once per logic frame by SceneManager.
const EFK_FAKE = proc.env.PMZ_EFFEKSEER === 'fake';   // default: the game's real effekseer.min.js + effekseer.wasm (WebAssembly in Node, GL on our WebGL layer)
let effLife = {}; const EFF_ADD = proc.env.PMZ_EFFECT_ADD !== undefined && proc.env.PMZ_EFFECT_ADD !== '' ? +proc.env.PMZ_EFFECT_ADD : 1;   // + frames: the real animation ended 1 frame later in the NW.js autotest (calibrated against the seeded trace)
try { effLife = JSON.parse(fs.readFileSync(path.join(BETA_DIR, 'effect-lifetimes.json'), 'utf8')); } catch (e) { log('effect-lifetimes.json missing: all effects last 90 frames'); }
function makeFakeEffekseerContext() {
  const handles = new Set();
  const newHandle = life => {
    const st = { t: 0, life: life + EFF_ADD, speed: 1, stopped: false };
    const h = makeNoopProxy({
      get exists() { return !st.stopped && st.t < st.life; },
      setSpeed(v) { st.speed = +v > 0 ? +v : 1; },
      stop() { st.stopped = true; handles.delete(st); },
      _st: st,
    });
    handles.add(st); return h;
  };
  const ctx = makeNoopProxy({
    loadEffect(url, scale, onload) {
      let n = ''; try { n = decodeURIComponent(path.basename(String(url).split('?')[0], '.efkefc')); } catch (e) {}
      const e = { isLoaded: true, url, _life: effLife[n] !== undefined ? effLife[n] : 90 }; if (onload) setImmediate(onload); return e;
    },
    releaseEffect: noop,
    play(effect) { return newHandle(effect && effect._life || 90); },
    update(dt) { const d = dt === undefined ? 1 : dt; for (const st of handles) { st.t += d * st.speed; if (st.t >= st.life) handles.delete(st); } },
    stopAll() { for (const st of handles) st.stopped = true; handles.clear(); },
  });
  return ctx;
}

// ---------- globals ----------
const winListeners = {};
function def(k, v) { Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true, enumerable: true }); }
def('window', globalThis); def('self', globalThis); def('top', globalThis); def('parent', globalThis);
const navLang = proc.env.POCKETMZ_LANG || 'ja';
def('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36', platform: 'Linux aarch64', language: navLang, languages: [navLang], maxTouchPoints: 0, hardwareConcurrency: 4, getGamepads: () => [], vendor: 'Google Inc.', mediaDevices: undefined });
def('location', { href: 'file://' + GAME + '/index.html', protocol: 'file:', host: '', hostname: '', pathname: GAME + '/index.html', search: '', hash: '', origin: 'file://', reload: noop });
def('addEventListener', (t, f) => addL(winListeners, t, f)); def('removeEventListener', (t, f) => remL(winListeners, t, f));
def('dispatchEvent', ev => { fire(winListeners, ev.type, ev); });
def('innerWidth', 640); def('innerHeight', 480); def('outerWidth', 640); def('outerHeight', 480); def('devicePixelRatio', 1);
def('screen', { width: 640, height: 480, availWidth: 640, availHeight: 480 });
def('scrollTo', noop); def('focus', noop); def('alert', noop); def('close', noop); def('open', noop);
def('getComputedStyle', () => new Proxy({}, { get: () => '' }));
def('matchMedia', () => ({ matches: false, addListener: noop, removeListener: noop, addEventListener: noop }));
// requestAnimationFrame is serviced by frameLoop() (below): run callbacks, swap (vsync), poll SDL events
const rafPending = new Map(); let rafSeq = 0;
def('requestAnimationFrame', f => { const id = ++rafSeq; rafPending.set(id, f); return id; }); def('cancelAnimationFrame', id => { rafPending.delete(id); });
def('WebGLRenderingContext', webgl.WebGLRenderingContext);
def('requestIdleCallback', f => setTimeout(() => f({ timeRemaining: () => 10 }), 1));
const webcompat = require(path.join(PMZRT_DIR, 'webcompat.js'));
const PMZWorker = webcompat.createWorkerClass({ baseDir: GAME, blobUrls: blobs, maxWorkers: Number(proc.env.PMZ_MAX_WORKERS) || 2 });
def('HTMLElement', FakeElement); def('HTMLCanvasElement', c2d.HTMLCanvasElement); def('CanvasRenderingContext2D', c2d.CanvasRenderingContext2D); def('ImageData', c2d.ImageData); def('CanvasGradient', c2d.CanvasGradient); def('CanvasPattern', c2d.CanvasPattern); def('HTMLImageElement', FakeImage); def('Image', FakeImage); def('XMLDocument', webcompat.XMLDocument); def('DOMParser', webcompat.DOMParser); def('Worker', PMZWorker);
def('HTMLVideoElement', FakeMedia); def('HTMLAudioElement', FakeMedia); def('Audio', FakeMedia);
def('Blob', FakeBlob); def('XMLHttpRequest', FakeXHR); def('fetch', fakeFetch); def('FontFace', FakeFontFace);
def('MediaRecorder', class MediaRecorder { constructor() { this.state = 'inactive'; stubWarn('MediaRecorder'); } static isTypeSupported() { return false; } start() { stubWarn('MediaRecorder'); } stop() {} pause() {} resume() {} addEventListener() {} removeEventListener() {} });
def('MediaStream', class MediaStream { constructor(t) { this._tracks = t || []; } getTracks() { return this._tracks; } getVideoTracks() { return []; } getAudioTracks() { return []; } });
def('FinalizationRegistry', FinalizationRegistry);
def('localStorage', webcompat.createPersistentStorage(path.join(SAVE_DIR, 'pmz_localstorage.json')));
def('sessionStorage', webcompat.createMemoryStorage());
def('indexedDB', new Proxy({}, {
  get(_, prop) {
    stubWarn('indexedDB.' + String(prop));
    if (prop === 'open' || prop === 'deleteDatabase') {
      return () => {
        const req = { result: null, error: new Error('indexedDB unsupported'), onerror: null, onsuccess: null, onupgradeneeded: null };
        setImmediate(() => { if (typeof req.onerror === 'function') req.onerror({ target: req }); });
        return req;
      };
    }
    if (prop === 'cmp') return () => 0;
    return undefined;
  }
}));
def('PMZ_applyShader', mode => {
  const m = ensurePostProc().setMode(mode);
  globalThis.PMZ_FORCE_REDRAW = true;
  return m;
});
// audio: context stub so MZ believes WebAudio exists; AudioManager buffers are replaced after the engine loads (see onAllScriptsLoaded)
// M2-2: real WebAudio subset (pmzrt/webaudio.js over the C mixer + SDL audio). PMZ_AUDIO=off: the old stub (silent, dummy buffers; for baselines).
const AUDIO_ON = proc.env.PMZ_AUDIO !== 'off';
let wa = null;
if (AUDIO_ON) {
  const vol = parseFloat(proc.env.PMZ_VOLUME);   // run-pmzrun.sh: 0.3 in test mode, 1.0 in play mode
  wa = require(path.join(PMZRT_DIR, 'webaudio.js')).create({ pmz, log, warn: warnOnce, volume: vol >= 0 ? vol : 1, dump: proc.env.PMZ_AUDIO_DUMP || '', env: proc.env });
  def('AudioContext', wa.AudioContext); def('AudioBuffer', wa.AudioBuffer);
} else def('AudioContext', class { constructor() { return makeNoopProxy({ state: 'running', currentTime: 0, sampleRate: 44100, decodeAudioData: () => Promise.resolve(makeNoopProxy({ duration: 1, length: 1, numberOfChannels: 2, sampleRate: 44100 })) }); } });
def('webkitAudioContext', globalThis.AudioContext);
const bodyEl = new FakeElement('body'), headEl = new FakeElement('head'), htmlEl = new FakeElement('html');
const doc = Object.assign(new FakeElement('#document'), {
  body: bodyEl, head: headEl, documentElement: htmlEl, activeElement: bodyEl, currentScript: null, readyState: 'complete', visibilityState: 'visible', hidden: false, title: '',
  fonts: c2d.fontSet,
  createElement(tag) {
    tag = String(tag).toLowerCase();
    if (tag === 'canvas') return new c2d.HTMLCanvasElement();
    if (tag === 'img') return new FakeImage();
    if (tag === 'video' || tag === 'audio') return new FakeMedia(tag);
    if (tag === 'style') {
      const el = new FakeElement('style');
      el.sheet = {
        cssRules: [],
        insertRule(rule, idx) {
          const r = String(rule || '');
          this.cssRules.splice(idx || 0, 0, { cssText: r });
          if (/@font-face\b/i.test(r)) {
            const fam = /font-family\s*:\s*([^;}\n]+)/i.exec(r);
            const src = /url\(\s*(['"]?)([^'")]+)\1\s*\)/i.exec(r);
            if (fam && src) {
              const rawUrl = decodeURI(src[2].split('?')[0]);
              const file = path.isAbsolute(rawUrl) ? rawUrl : resolvePath(rawUrl);
              try {
                const f = new FakeFontFace(fam[1], 'url(' + file + ')');
                c2d.fontSet.add(f);
                f.load().then(() => log('font ' + f.family + ' <- ' + path.basename(file)))
                  .catch(e => log('font ' + fam[1].trim() + ' failed: ' + (e && e.message)));
              } catch (e) {}
            }
          }
          return idx || 0;
        },
        deleteRule(idx) { this.cssRules.splice(idx || 0, 1); },
      };
      return el;
    }
    return new FakeElement(tag);
  },
  createElementNS(ns, tag) { return this.createElement(tag); },
  createTextNode(t) { return new FakeElement('#text'); },
  getElementById(id) { return ids[id] || null; },
  hasFocus: () => true,
});
htmlEl.appendChild(headEl); htmlEl.appendChild(bodyEl); doc.appendChild(htmlEl);   // tree for getElementsByTagName
def('document', doc);
for (const k of ['Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'TouchEvent']) if (!(k in globalThis)) def(k, class {});


// ---------- HTML overlay (PocketMZ_Menu layers) ----------
// There is no DOM/CSS here: overlay.js draws what the menu builds (panel, fps box, toast, hint) onto a 640x480 canvas, which is rendered with PIXI on
// top of the game after Graphics.render (window space -> game space: the game canvas is letterboxed into the window by webgl.js).
let ov = null, ovTex = null, ovCont = null, ovSprite = null, ovTexDirty = false;
function overlayFrame(gameDrew, now) {
  if (typeof PIXI === 'undefined' || typeof Graphics === 'undefined') return false;
  if (MV ? !(Graphics._renderer && Graphics._renderer.gl) : !(Graphics.app && Graphics.app.renderer)) return false;   // MV: PIXI v4 Graphics._renderer (WebGLRenderer)
  if (!ov) {
    if (!gameDrew) return false;
    const getViewport = () => {
      const gw = (typeof Graphics !== 'undefined' && Graphics.width) || 640;
      const gh = (typeof Graphics !== 'undefined' && Graphics.height) || 480;
      const s = Math.min(640 / gw, 480 / gh);
      const vw = Math.round(gw * s), vh = Math.round(gh * s);
      const x0 = Math.max(0, Math.floor((640 - vw) / 2));
      const y0 = Math.max(0, Math.floor((480 - vh) / 2));
      return { x0, y0, w: Math.min(640 - x0 * 2, vw), h: Math.min(480 - y0 * 2, vh) };
    };
    ov = require(path.join(BETA_DIR, 'overlay.js')).create({ doc, getCursor, getViewport });
    ovTex = PIXI.Texture.from(ov.canvas); ovSprite = new PIXI.Sprite(ovTex); ovCont = new PIXI.Container(); ovCont.addChild(ovSprite);
    // warm-up at boot (invisible): texture allocation / first render of the overlay path cost ~0.7 s when the menu is opened for the first time
    const R0 = MV ? Graphics._renderer : Graphics.app.renderer, last0 = R0._lastObjectRendered; ovSprite.alpha = 0; ovTex.baseTexture.update();
    (MV ? PIXI.WebGLRenderer : PIXI.Renderer).prototype.render.call(R0, ovCont, undefined, false); R0._lastObjectRendered = last0; ovSprite.alpha = 1;
  }
  const st = ov.update();
  if (st === 'draw') ovTexDirty = true;
  if (!gameDrew) {
    const forceRedraw = !!globalThis.PMZ_FORCE_REDRAW;
    if (forceRedraw) globalThis.PMZ_FORCE_REDRAW = false;
    // Redraw + swap while idle/paused when DOM overlay changed (menu/toast/fps), forced by async resmooth, or cursor moved while idle >120ms.
    if (!forceRedraw && st !== 'draw' && st !== 'hide') return false;
    if (!forceRedraw && !ov.domChanged && (now - lastGameDrewAt) <= 120) return false;
    const R = MV ? Graphics._renderer : Graphics.app.renderer, last = R._lastObjectRendered;
    const curScene = typeof SceneManager !== 'undefined' && SceneManager._scene;
    const canRedrawLast = last && (!curScene || last === curScene);
    const protoRender = (MV ? PIXI.WebGLRenderer : PIXI.Renderer).prototype.render;
    if (canRedrawLast) {
      try { protoRender.call(R, last); }
      catch (e) {
        if (MV && R.currentRenderer && R.currentRenderer.sprites) R.currentRenderer.currentIndex = 0;
        log('overlay backdrop redraw skipped: ' + (e && e.message));
      }
      R._lastObjectRendered = last;
    } else {
      if (!ov.domChanged && !forceRedraw) return false;
      pmz.glClearColor(0, 0, 0, 1); pmz.glClear(pmz.COLOR_BUFFER_BIT);
    }
    if (st === 'draw' || st === 'same') {
      if (ovTexDirty) { ovTex.baseTexture.update(); ovTexDirty = false; }
      const gw = Graphics.width, gh = Graphics.height, s = Math.min(ov.W / gw, ov.H / gh);
      ovSprite.scale.set(1 / s); ovSprite.position.set(-(ov.W - gw * s) / 2 / s, -(ov.H - gh * s) / 2 / s);
      protoRender.call(R, ovCont, undefined, false);
      R._lastObjectRendered = canRedrawLast ? last : null;
      overlayFrame.n = (overlayFrame.n || 0) + 1;
    }
    return true;
  }
  if (st !== 'draw' && st !== 'same') return false;
  if (ovTexDirty) { ovTex.baseTexture.update(); ovTexDirty = false; }
  const gw = Graphics.width, gh = Graphics.height, s = Math.min(ov.W / gw, ov.H / gh);
  ovSprite.scale.set(1 / s); ovSprite.position.set(-(ov.W - gw * s) / 2 / s, -(ov.H - gh * s) / 2 / s);
  const R = MV ? Graphics._renderer : Graphics.app.renderer, last = R._lastObjectRendered;
  (MV ? PIXI.WebGLRenderer : PIXI.Renderer).prototype.render.call(R, ovCont, undefined, false);   // PIXI 5.3: render(object, renderTexture, clear); no clear = drawn over the game frame
  R._lastObjectRendered = last;   // the prototype's render: patches that count/wrap instance.render do not see it
  overlayFrame.n = (overlayFrame.n || 0) + 1;
  return false;
}
// --- module: beta/src/40-input-mouse.js ---
// ---------- input: SDL events -> engine keyboard & virtual mouse events ----------
// Physical events (play mode) and scripted ones (tests) both go through handleInput(), which turns them into keydown/keyup and
// mousemove/mousedown/mouseup events on `document` / canvas (rmmz/rpg Input & TouchInput listen there).
// Pad buttons follow the exact same gptk map as the NW.js runtime (live-reloaded when edited in PocketMZ_Menu).
const INPUTLOG = proc.env.PMZ_INPUTLOG === '1';
const JSKEY = { enter: 13, return: 13, esc: 27, escape: 27, shift: 16, ctrl: 17, alt: 18, space: 32, tab: 9, backspace: 8, pageup: 33, pagedown: 34, home: 36, end: 35,
  left: 37, up: 38, right: 39, down: 40, insert: 45, delete: 46 };
for (let i = 0; i < 26; i++) JSKEY[String.fromCharCode(97 + i)] = 65 + i;
for (let i = 0; i < 10; i++) JSKEY[String(i)] = 48 + i;
for (let i = 1; i <= 12; i++) JSKEY['f' + i] = 111 + i;
const KEYNAME = { 13: 'Enter', 27: 'Escape', 16: 'Shift', 17: 'Control', 18: 'Alt', 32: ' ', 9: 'Tab', 8: 'Backspace', 33: 'PageUp', 34: 'PageDown', 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 45: 'Insert' };
const GPTK_BTN = { a: 'a', b: 'b', x: 'x', y: 'y', back: 'back', start: 'start', l1: 'leftshoulder', r1: 'rightshoulder', l2: 'lefttrigger', r2: 'righttrigger', l3: 'leftstick', r3: 'rightstick',
  up: 'dpup', down: 'dpdown', left: 'dpleft', right: 'dpright' };
const DEFAULT_GPTK_TEXT = 'back = shift\nstart = esc\na = enter\nb = esc\nx = d\ny = shift\nl1 = pageup\nr1 = pagedown\nl2 = s\nr2 = a\nl3 = mouse_right\nr3 = mouse_left\nup = up\ndown = down\nleft = left\nright = right\nleft_analog_up = up\nleft_analog_down = down\nleft_analog_left = left\nleft_analog_right = right\nright_analog_up = mouse_movement_up\nright_analog_down = mouse_movement_down\nright_analog_left = mouse_movement_left\nright_analog_right = mouse_movement_right\ndeadzone_mode = scaled_radial\ndeadzone = 7200\ndeadzone_scale = 6\nmouse_scale = 5400\n';
const inputMap = {};      // SDL controller button/trigger name (or 'stick:up' ...) -> JS keyCode
const mouseBtnMap = {};   // SDL controller button/trigger name -> 'left' | 'right'
const rightStickMap = {}; // 'up'|'down'|'left'|'right' -> JS keyCode (when rightStickMode === 'keys')
let rightStickMode = 'mouse';   // 'mouse' | 'keys' | 'none'
let mouseSpeedScale = 1.0;

function loadGptk() {
  for (const k of Object.keys(inputMap)) delete inputMap[k];
  for (const k of Object.keys(mouseBtnMap)) delete mouseBtnMap[k];
  for (const k of Object.keys(rightStickMap)) delete rightStickMap[k];
  rightStickMode = 'none';
  mouseSpeedScale = 1.0;
  let text = '', src = 'default';
  if (USER_GPTK && fs.existsSync(USER_GPTK)) {
    try { text = fs.readFileSync(USER_GPTK, 'utf8'); src = USER_GPTK; } catch (e) {}
  }
  if (!text && GPTK_FILE) {
    try { text = fs.readFileSync(GPTK_FILE, 'utf8'); src = GPTK_FILE; } catch (e) {}
  }
  if (!text) { log('INPUT: no gptk (' + (USER_GPTK || GPTK_FILE) + '), built-in default'); text = DEFAULT_GPTK_TEXT; }
  const noKey = v => v === '\\"' || v === '"' || v === '' || v === 'nothing';
  let sawRight = false;
  for (const rawLine of text.split(/\r?\n/)) {
    if (/^\s*[#;]/.test(rawLine)) continue;
    const line = rawLine.replace(/\s+#.*$/, '');
    const m = /^\s*([a-z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line); if (!m) continue;
    const n = m[1].toLowerCase(), v = m[2].toLowerCase();
    if (n === 'deadzone_scale') {
      const ds = parseFloat(v);
      if (isFinite(ds) && ds > 0) mouseSpeedScale = Math.max(0.3, Math.min(2.5, ds / 6));
      continue;
    }
    if (n.startsWith('deadzone') || n === 'mouse_scale' || n === 'mouse_delay' || n === 'mouse_slow_scale' || n === 'dpad_mouse_step') continue;
    const ra = /^right_analog_(up|down|left|right)$/.exec(n);
    if (ra) {
      sawRight = true;
      if (v.startsWith('mouse_movement')) rightStickMode = 'mouse';
      else if (noKey(v)) { if (rightStickMode !== 'mouse' && rightStickMode !== 'keys') rightStickMode = 'none'; }
      else if (JSKEY[v]) { rightStickMode = 'keys'; rightStickMap[ra[1]] = JSKEY[v]; }
      continue;
    }
    const sa = /^left_analog_(up|down|left|right)$/.exec(n);
    if (sa) { if (!noKey(v) && JSKEY[v]) inputMap['stick:' + sa[1]] = JSKEY[v]; continue; }
    const slot = GPTK_BTN[n];
    if (!slot || noKey(v)) continue;
    if (v === 'mouse_left') mouseBtnMap[slot] = 'left';
    else if (v === 'mouse_right') mouseBtnMap[slot] = 'right';
    else if (JSKEY[v]) inputMap[slot] = JSKEY[v];
  }
  if (!sawRight) rightStickMode = 'mouse';
  log('INPUT map (' + src + '): keys=' + JSON.stringify(inputMap) + ' mouse=' + JSON.stringify(mouseBtnMap) + ' rstick=' + rightStickMode + ' mspeed=' + mouseSpeedScale.toFixed(2));
}
function gptkStamp() {
  if (!USER_GPTK) return 'none';
  try { const s = fs.statSync(USER_GPTK); return s.mtimeMs + ':' + s.size; } catch (e) { return 'none'; }
}
function watchUserGptk() {
  if (!PLAY || !USER_GPTK) return;
  let last = gptkStamp();
  setInterval(() => {
    const cur = gptkStamp();
    if (cur === last) return;
    last = cur;
    releaseAllKeys();
    releaseAllMouse();
    loadGptk();
  }, 1000).unref();
}

const keySources = new Map();   // keyCode -> Set of sources holding it (a key is down while any source holds it)
const btnDown = new Set();      // currently held gamepad button names (Select+X / Select+Start combos)
const stick = { up: false, down: false, left: false, right: false };
const rstick = { up: false, down: false, left: false, right: false };
const trig = { lefttrigger: false, righttrigger: false };
const inputStats = { keydown: 0, keyup: 0, swallowed: 0, mousemove: 0, mousedown: 0, mouseup: 0 };
const isMenuOpen = () => !!(ids.pmzMenu && !ids.pmzMenu.hidden);

// ---------- virtual mouse (right stick + L3/R3 + physical USB/BT mouse) ----------
const vmouse = {
  x: 320, y: 240, rx: 0, ry: 0,
  left: false, right: false,
  btnSources: { left: new Set(), right: new Set() },
  visibleUntil: 0, lastStep: 0, initedPos: false, lastIntX: -1, lastIntY: -1,
};
function mouseBounds() {
  return mainCanvas ? canvasScreenRect(mainCanvas) : { left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480 };
}
function ensureMousePos() {
  const b = mouseBounds();
  if (!vmouse.initedPos) {
    vmouse.x = b.left + b.width / 2;
    vmouse.y = b.top + b.height / 2;
    vmouse.initedPos = true;
  } else {
    vmouse.x = Math.max(b.left, Math.min(b.right - 1, vmouse.x));
    vmouse.y = Math.max(b.top, Math.min(b.bottom - 1, vmouse.y));
  }
}
function fireMouse(type, btn, extra) {
  const x = Math.round(vmouse.x), y = Math.round(vmouse.y);
  const buttons = (vmouse.left ? 1 : 0) | (vmouse.right ? 2 : 0);
  const target = mainCanvas || doc;
  const ev = Object.assign({
    type, target, currentTarget: target,
    clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y,
    offsetX: mainCanvas ? x - mainCanvas.offsetLeft : x,
    offsetY: mainCanvas ? y - mainCanvas.offsetTop : y,
    button: btn, buttons, which: btn === 0 ? 1 : btn === 2 ? 3 : 0,
    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
    defaultPrevented: false, _stop: false, _stopProp: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this._stopProp = true; },
    stopImmediatePropagation() { this._stop = true; this._stopProp = true; },
  }, extra);
  if (type in inputStats) inputStats[type]++;
  if (mainCanvas) fire(mainCanvas, type, ev);
  if (!ev._stopProp) fire(doc, type, ev);
  if (!ev._stopProp) fire(winListeners, type, ev);
}
function moveMouseTo(nx, ny, now, forceFire) {
  const b = mouseBounds();
  vmouse.initedPos = true;
  vmouse.x = Math.max(b.left, Math.min(b.right - 1, nx));
  vmouse.y = Math.max(b.top, Math.min(b.bottom - 1, ny));
  vmouse.visibleUntil = now + 3000;
  const ix = Math.round(vmouse.x), iy = Math.round(vmouse.y);
  if (forceFire || ix !== vmouse.lastIntX || iy !== vmouse.lastIntY) {
    vmouse.lastIntX = ix; vmouse.lastIntY = iy;
    fireMouse('mousemove', 0);
  }
}
function mousePress(src, which) {
  if (isMenuOpen()) return;
  if (which === 'left' && typeof ov !== 'undefined' && ov && ov.hitTargets && ov.hitTargets.length) {
    ensureMousePos();
    const dw = (glInfo && glInfo.drawableWidth) || ov.W || 640;
    const dh = (glInfo && glInfo.drawableHeight) || ov.H || 480;
    const ox = vmouse.x * (ov.W / dw), oy = vmouse.y * (ov.H / dh);
    for (let i = ov.hitTargets.length - 1; i >= 0; i--) {
      const h = ov.hitTargets[i];
      if (ox >= h.x && ox <= h.x + h.w && oy >= h.y && oy <= h.y + h.h) {
        if (typeof h.el.click === 'function') h.el.click();
        return;
      }
    }
  }
  const s = vmouse.btnSources[which]; if (!s) return;
  const first = s.size === 0; s.add(src);
  if (!first) return;
  ensureMousePos();
  const now = nowMs();
  vmouse.visibleUntil = now + 3000;
  vmouse[which] = true;
  fireMouse('mousemove', 0);
  fireMouse('mousedown', which === 'left' ? 0 : 2);
}
function mouseRelease(src, which) {
  const s = vmouse.btnSources[which]; if (!s || !s.delete(src)) return;
  if (s.size > 0) return;
  if (!vmouse[which]) return;
  vmouse[which] = false;
  vmouse.visibleUntil = nowMs() + 3000;
  fireMouse('mouseup', which === 'left' ? 0 : 2);
}
function releaseAllMouse() {
  for (const which of ['left', 'right']) {
    const s = vmouse.btnSources[which];
    if (s.size || vmouse[which]) {
      s.clear();
      if (vmouse[which]) { vmouse[which] = false; fireMouse('mouseup', which === 'left' ? 0 : 2); }
    }
  }
}
function stepVirtualMouse(now) {
  const dt = vmouse.lastStep ? Math.min(0.05, Math.max(0, (now - vmouse.lastStep) / 1000)) : 0;
  vmouse.lastStep = now;
  if (isMenuOpen()) {
    if (vmouse.left || vmouse.right) releaseAllMouse();
    return;
  }
  if (rightStickMode !== 'mouse' || dt <= 0) return;
  const nx = vmouse.rx / 32767, ny = vmouse.ry / 32767;
  const mag = Math.hypot(nx, ny);
  const DZ = 0.22;
  if (mag <= DZ) return;
  ensureMousePos();
  const t = Math.min(1, (mag - DZ) / (1 - DZ));
  const speed = (55 + 305 * t * t) * mouseSpeedScale;   // ~360 px/s at normal (scaled by deadzone_scale/6)
  moveMouseTo(vmouse.x + (nx / mag) * speed * dt, vmouse.y + (ny / mag) * speed * dt, now, false);
}
function getCursor() {
  if (isMenuOpen() || nowMs() > vmouse.visibleUntil) return null;
  ensureMousePos();
  return { x: Math.round(vmouse.x), y: Math.round(vmouse.y), down: vmouse.left || vmouse.right };
}

function fireKey(type, code) {
  const ev = { keyCode: code, which: code, key: KEYNAME[code] || String.fromCharCode(code).toLowerCase(), code: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, preventDefault: noop, stopPropagation: noop };
  ev._stop = false; ev.stopImmediatePropagation = () => { ev._stop = true; };
  inputStats[type]++;
  fire(winListeners, type, ev);   // window listeners first (PocketMZ_Menu captures keys there); stopImmediatePropagation keeps the key from the engine
  if (!ev._stop) { ev.target = doc; fire(doc, type, ev); }
}
function keyPress(src, code) { let s = keySources.get(code); if (!s) keySources.set(code, s = new Set()); const first = s.size === 0; s.add(src); if (first) fireKey('keydown', code); }
function keyRelease(src, code) { const s = keySources.get(code); if (!s || !s.delete(src)) return; if (s.size === 0) fireKey('keyup', code); }
function releaseAllKeys() { for (const [code, s] of keySources) if (s.size) { s.clear(); fireKey('keyup', code); } }
function handleMapped(slot, down) {
  const k = inputMap[slot];
  if (k) { (down ? keyPress : keyRelease)('btn:' + slot, k); return; }
  const mb = mouseBtnMap[slot];
  if (mb) (down ? mousePress : mouseRelease)('btn:' + slot, mb);
}
function sdlKeyToJs(sym) {
  if (sym >= 97 && sym <= 122) return sym - 32; if (sym >= 48 && sym <= 57) return sym;
  const t = { 13: 13, 27: 27, 32: 32, 8: 8, 9: 9, 0x40000052: 38, 0x40000051: 40, 0x40000050: 37, 0x4000004F: 39, 0x4000004B: 33, 0x4000004E: 34, 0x400000E1: 16, 0x400000E5: 16, 0x400000E0: 17, 0x400000E4: 17, 0x400000E2: 18, 0x400000E6: 18, 0x40000049: 45, 0x4000004A: 36, 0x4000004D: 35 };
  if (t[sym]) return t[sym];
  if (sym >= 0x4000003A && sym <= 0x40000045) return 112 + sym - 0x4000003A;   // F1..F12
  return 0;
}
function quitCombo() { if (PLAY && !NOQUIT) requestQuit('Select+Start'); else log('INPUT: Select+Start (ignored in ' + (PLAY ? 'PMZ_NOQUIT' : 'test') + ' mode)'); }
function toggleMenuCombo() {
  if (!PLAY) return;
  const menuApi = globalThis.PMZ_MENU || (globalThis.window && globalThis.window.PMZ_MENU);
  if (menuApi && typeof menuApi.command === 'function') {
    try { menuApi.command('menu'); } catch (e) {}
  }
}
function handleInput(e) {
  switch (e.type) {
    case 'controlleradded': log('INPUT: controller added ' + e.name); return;
    case 'controllerremoved': btnDown.clear(); log('INPUT: controller removed'); return;
    case 'buttondown': case 'buttonup': {
      const down = e.type === 'buttondown', b = e.button;
      if (down) {
        btnDown.add(b);
        if ((b === 'start' && btnDown.has('back')) || (b === 'back' && btnDown.has('start'))) {
          releaseAllKeys(); releaseAllMouse();
          quitCombo();
          return;
        }
        if ((b === 'x' && btnDown.has('back')) || (b === 'back' && btnDown.has('x'))) {
          releaseAllKeys(); releaseAllMouse();
          toggleMenuCombo();
          return;
        }
      } else {
        btnDown.delete(b);
      }
      handleMapped(b, down);
      return; }
    case 'axis': {
      const v = e.value, a = e.axis;
      if (a === 'lefttrigger' || a === 'righttrigger') {
        const on = trig[a] ? v > 8000 : v > 16000; if (on === trig[a]) return; trig[a] = on;
        handleMapped(a, on); return;
      }
      if (a === 'leftx' || a === 'lefty') {
        const neg = a === 'leftx' ? 'left' : 'up', pos = a === 'leftx' ? 'right' : 'down';   // dead zone: on at 50 %, off at 35 % (hysteresis)
        for (const [dir, active] of [[neg, v < -(stick[neg] ? 11500 : 16384)], [pos, v > (stick[pos] ? 11500 : 16384)]]) {
          if (active === stick[dir]) continue; stick[dir] = active;
          const k = inputMap['stick:' + dir]; if (k) (active ? keyPress : keyRelease)('stick:' + dir, k);
        }
        return;
      }
      if (a === 'rightx' || a === 'righty') {
        if (a === 'rightx') vmouse.rx = v; else vmouse.ry = v;
        if (rightStickMode === 'keys') {
          const neg = a === 'rightx' ? 'left' : 'up', pos = a === 'rightx' ? 'right' : 'down';
          for (const [dir, active] of [[neg, v < -(rstick[neg] ? 11500 : 16384)], [pos, v > (rstick[pos] ? 11500 : 16384)]]) {
            if (active === rstick[dir]) continue; rstick[dir] = active;
            const k = rightStickMap[dir]; if (k) (active ? keyPress : keyRelease)('rstick:' + dir, k);
          }
        }
        return;
      }
      return; }
    case 'mousemove': {
      if (!isMenuOpen()) moveMouseTo(e.x, e.y, nowMs(), false);
      return; }
    case 'mousedown': case 'mouseup': {
      const down = e.type === 'mousedown';
      const which = e.button === 1 ? 'left' : e.button === 3 ? 'right' : null;
      if (!which) return;
      if (down && !isMenuOpen()) moveMouseTo(e.x, e.y, nowMs(), false);
      (down ? mousePress : mouseRelease)('sdlmouse:' + which, which);
      return; }
    case 'wheel': {
      if (isMenuOpen()) return;
      fireMouse('wheel', 0, { deltaX: -(e.dx || 0) * 40, deltaY: -(e.dy || 0) * 40, wheelDelta: (e.dy || 0) * 120 });
      return; }
    case 'keydown': case 'keyup': {
      const down = e.type === 'keydown'; if (e.repeat) return;
      const k = sdlKeyToJs(e.keycode); if (k) (down ? keyPress : keyRelease)('key:' + e.keycode, k);
      return; }
  }
}
// play mode: leave after Select+Start / window close; saves in flight (async pako + file write) are finished first
let pendingSaves = 0, activeSaveWrites = 0, quitting = false;
async function requestQuit(why) {
  if (quitting) return; quitting = true; log('QUIT requested: ' + why);
  const t0 = Date.now(); while (pendingSaves > 0 && Date.now() - t0 < 8000) await sleep(50);
  if (pendingSaves > 0) log('QUIT: ' + pendingSaves + ' save(s) still pending after 8 s');
  try { if (globalThis.localStorage && globalThis.localStorage.flush) globalThis.localStorage.flush(); } catch (_) {}
  try { if (globalThis.Worker && globalThis.Worker.terminateAll) await globalThis.Worker.terminateAll(); } catch (_) {}
  finish(0);
}
// NW.js stand-ins for the PocketMZ_* patches (see runScript): `nw` (__dirname = the thin copy, App.quit = leave like F2+Start), a `process` that
// adds process.mainModule.filename (the page file, as in NW.js: patches take its dirname as the thin copy), and the window that carries them.
const nwShim = {
  __dirname: MV ? path.dirname(GAME) : GAME, /* the thin copy root (MV: the folder above www/) */ App: { argv: [], dataPath: '/tmp', quit() { if (PLAY && !NOQUIT) requestQuit('nw.App.quit'); else log('nw.App.quit ignored (' + (PLAY ? 'PMZ_NOQUIT' : 'test mode') + ')'); } },
  Window: { get: () => makeNoopProxy() },
};
const patchProcess = new Proxy(proc, { get(t, k) { if (k === 'mainModule') return { filename: resolvePath('index.html') }; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } });
const patchWindow = new Proxy(globalThis, {
  get(t, k) { return k === 'require' ? (n => n === 'fs' ? vfsFs : require(n)) : k === 'process' ? patchProcess : k === 'nw' ? nwShim : t[k]; },
  set(t, k, v) { t[k] = v; return true; },
});
// NW-style local-file saves. Utils.isNwjs() stays false here (no global require/process for the page), so StorageManager is switched to
// its local mode by hand: same files, same format (<dir>/fileN.rmmzsave, config/global.rmmzsave) as the NW.js runtime.
function patchStorage() {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  const S = StorageManager;
  if (MV) {   // MV: <dir>/file1.rpgsave, config.rpgsave, global.rpgsave (LZString base64), same files as NW.js; the engine's own versions call require('fs')
    S.isLocalMode = () => true;
    S.localFileDirectoryPath = () => SAVE_DIR;
    S.saveToLocalFile = function (id, json) {
      fs.mkdirSync(SAVE_DIR, { recursive: true });
      activeSaveWrites++;
      try { memguard.atomicWriteFileSync(fs, this.localFilePath(id), LZString.compressToBase64(json)); }
      finally { activeSaveWrites--; }
    };
    const rd = f => fs.existsSync(f) ? fs.readFileSync(f, { encoding: 'utf8' }) : null;
    S.loadFromLocalFile = function (id) { return LZString.decompressFromBase64(rd(this.localFilePath(id))); };
    S.loadFromLocalBackupFile = function (id) { return LZString.decompressFromBase64(rd(this.localFilePath(id) + '.bak')); };
    S.localFileBackupExists = function (id) { return fs.existsSync(this.localFilePath(id) + '.bak'); };
    S.localFileExists = function (id) { return fs.existsSync(this.localFilePath(id)); };
    S.removeLocalFile = function (id) { const f = this.localFilePath(id); if (fs.existsSync(f)) fs.unlinkSync(f); };
    log('SAVES: local mode (MV), dir ' + SAVE_DIR);
    return;
  }
  S.isLocalMode = () => true;
  S.fileDirectoryPath = () => SAVE_DIR;
  S.fsMkdir = p => { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); };
  S.fsRename = (a, b) => { if (fs.existsSync(a)) fs.renameSync(a, b); };
  S.fsUnlink = p => { if (fs.existsSync(p)) fs.unlinkSync(p); };
  S.fsReadFile = p => fs.existsSync(p) ? fs.readFileSync(p, { encoding: 'utf8' }) : null;
  S.fsWriteFile = (p, d) => {
    activeSaveWrites++;
    try { memguard.atomicWriteFileSync(fs, p, d); }
    finally { activeSaveWrites--; }
  };
  S.localFileExists = n => fs.existsSync(S.filePath(n));
  const so = S.saveObject;
  S.saveObject = function () { pendingSaves++; return so.apply(this, arguments).finally(() => { pendingSaves--; }); };
  log('SAVES: local mode, dir ' + SAVE_DIR);
}

(async () => {
  await measure('bare_node');
  loadGptk();
  watchUserGptk();
  initWindow();   // before shims are used by anything; process + this script only
  if (MV) await bootIndexHtml();   // MV: index.html lists every script (PIXI v4, rpg_*.js, plugins.js, main.js) and the font stylesheet
  else {
    // MZ: load main.js like index.html does (it loads the rest itself)
    const mainEl = new FakeElement('script'); mainEl.src = 'file://' + path.join(GAME, 'js', 'main.js'); mainEl.type = 'text/javascript';
    bodyEl.appendChild(mainEl);
  }
})();
// MV: do what the browser does with the game's index.html: @font-face rules of its stylesheets (loaded before the first script; MV's own
// "is GameFont loaded" check is document.fonts.check(), always true here), then <script src> in order.
async function bootIndexHtml() {
  // MV plugins assume NW.js (require('fs'), process.mainModule.filename, nw.gui) without asking Utils.isNwjs(), so MV gets the NW globals too (like
  // α): Utils.isNwjs() is true, StorageManager's own local-file mode works (patchStorage only redirects the folder). PMZ_NWJS=0: browser-only globals.
  if (proc.env.PMZ_NWJS !== '0') {
    const gui = { Window: { get: () => makeNoopProxy() }, App: nwShim.App, Shell: { openExternal: noop, openItem: noop, showItemInFolder: noop } };
    def('require', n => n === 'nw.gui' ? gui : n === 'fs' ? vfsFs : require(n)); def('process', patchProcess); def('nw', nwShim);
  }
  const html = vfs.readFileSync(path.join(GAME, 'index.html'), 'utf8');
  const attr = (tag, name) => { const m = new RegExp('\\b' + name + '\\s*=\\s*(["\'])(.*?)\\1', 'i').exec(tag); return m ? m[2] : null; };
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const href = /stylesheet/i.test(attr(tag, 'rel') || '') && attr(tag, 'href'); if (!href) continue;
    let css = ''; try { css = vfs.readFileSync(resolvePath(href), 'utf8'); } catch (e) { log('index.html: stylesheet ' + href + ' not readable'); continue; }
    const dir = path.dirname(resolvePath(href));
    for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
      const fam = /font-family\s*:\s*([^;]+)/i.exec(m[1]), src = /url\(\s*(['"]?)(.*?)\1\s*\)/i.exec(m[1]);
      if (!fam || !src) continue;
      const file = path.isAbsolute(src[2]) ? src[2] : path.join(dir, decodeURI(src[2].split('?')[0]));
      try { const f = new FakeFontFace(fam[1], 'url(' + file + ')'); document.fonts.add(f); await f.load(); log('font ' + f.family + ' <- ' + path.basename(file)); }
      catch (e) { log('font ' + fam[1].trim() + ' failed: ' + (e && e.message)); }
    }
  }
  for (const tag of html.match(/<script\b[^>]*>/gi) || []) {
    const src = attr(tag, 'src'); if (!src) continue;
    const el = new FakeElement('script'); el.src = src; el.type = 'text/javascript'; bodyEl.appendChild(el);
  }
}
// ---------- once all scripts (core + plugins) have loaded ----------
function onAllScriptsLoaded() {
  log('all scripts loaded: plugins ok ' + loadedPlugins.length + ', failed ' + failedPlugins.length);
  // PMZ_AUDIO=off: audio memory is excluded, buffers are dummies
  if (!AUDIO_ON) AudioManager.createBuffer = function (folder, name) {
    const b = makeNoopProxy({ isReady: () => true, isError: () => false, isPlaying: () => false, addLoadListener: f => f(b), name, volume: 1, pitch: 1, pan: 0, url: folder + name, retry: noop });
    return b;
  };
  const origPrint = Graphics.printError;
  Graphics.printError = function (name, msg, error) { log("Graphics.printError", name, String(msg).slice(0, 300), String(error && error.stack || "").slice(0, 600)); otherErrors.push('printError ' + name + ' ' + msg); try { return origPrint.apply(this, arguments); } catch (e) {} };
  patchStorage();
  if (GLOBAL_REQUIRE && typeof globalThis.require !== 'function') { def('require', require); log('global require defined (dev/test: PocketMZ_Debug)'); }
  try { performance.memory; if (!performance.memory) Object.defineProperty(performance, 'memory', { get: () => ({ usedJSHeapSize: proc.memoryUsage().heapUsed, totalJSHeapSize: proc.memoryUsage().heapTotal, jsHeapSizeLimit: 256 << 20 }) }); } catch (e) {}
  if (c2d.fontSet && !c2d.fontSet[Symbol.iterator]) try { c2d.fontSet[Symbol.iterator] = function* () {}; } catch (e) {}   // PocketMZ_Debug: [...document.fonts]
  if (typeof globalThis.onload === 'function') { try { globalThis.onload({ type: 'load', target: globalThis }); } catch (e) { otherErrors.push('window.onload: ' + e.stack); log('ONLOAD ERR', String(e.stack).slice(0, 500)); } }   // MV main.js: window.onload = SceneManager.run(Scene_Boot)
  fire(winListeners, 'load');   // -> Main.onWindowLoad -> effekseer.initRuntime -> SceneManager.run(Scene_Boot)
  (PLAY ? playDrive() : drive()).catch(e => { log('DRIVE FAILED', e && e.stack || e); otherErrors.push('drive: ' + (e && e.stack)); finish(1); });
}

async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try { ok = fn(); } catch (e) {}
    if (ok) return;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what + ' (scene=' + (SceneManager._scene && SceneManager._scene.constructor.name) + ')');
    await sleep(100);
    if ((Date.now() - t0) % 5000 < 100) { let st = ''; try { st = 'scene=' + (SceneManager._scene && SceneManager._scene.constructor.name) + ' main.xhr=' + main.xhrSucceeded + ' main.err=' + (main.error && main.error.message) + ' efk=' + typeof effekseer; } catch (e) { st = 'n/a ' + e.message; } log('waiting for ' + what + ' ' + st); }
  }
}
const sceneActive = cls => () => { const s = SceneManager._scene; return s instanceof cls && s.isActive() && ImageManager.isReady(); };

async function takeShotTo(p) {
  shotInfo = null; shotPending = p;
  await until(() => shotInfo, 5000, 'screenshot ' + p);
}
// micro benchmarks inside the run (title scene is up): Bitmap.drawText and measureText with the game's main font
async function bench() {
  const r = {};
  let face = 'rmmz-mainfont'; try { face = $gameSystem.mainFontFace(); } catch (e) {}
  const bm = new Bitmap(640, 48); bm.fontFace = face; bm.fontSize = 26; bm.textColor = '#ffffff'; bm.outlineColor = 'rgba(0, 0, 0, 0.5)'; bm.outlineWidth = 4;
  const txt = 'テスト文字列 Test 123';
  bm.drawText(txt, 0, 0, 640, 48, 'left');   // warm-up (font lookup, glyph cache)
  const tt0 = pmz.textTimes ? pmz.textTimes() : [0, 0, 0];
  let t0 = nowMs(); for (let i = 0; i < 300; i++) bm.drawText(txt, 0, 0, 640, 48, 'left'); r.drawText300Ms = +(nowMs() - t0).toFixed(1);
  if (pmz.textTimes) { const tt1 = pmz.textTimes(); r.strokeN = tt1[0] - tt0[0]; r.layoutPathUsPerCall = +((tt1[1] - tt0[1]) / (r.strokeN || 1)).toFixed(0); r.strokeUsPerCall = +((tt1[2] - tt0[2]) / (r.strokeN || 1)).toFixed(0); if (pmz.textCacheStats) r.textCache = pmz.textCacheStats().join('/'); }
  const ctx = bm.context; ctx.font = bm._makeFontNameText();
  t0 = nowMs(); let wsum = 0; for (let i = 0; i < 2000; i++) wsum += ctx.measureText(txt + (i % 7)).width; r.measureText2000Ms = +(nowMs() - t0).toFixed(1);
  t0 = nowMs(); for (let i = 0; i < 2000; i++) wsum += bm.measureTextWidth(txt); r.measureTextWidth2000Ms = +(nowMs() - t0).toFixed(1);
  r.width = +(wsum / 4000).toFixed(2); r.font = ctx.font;
  bm.destroy && bm.destroy();
  timings.bench = r; log('BENCH', JSON.stringify(r));
}

async function drive() {
  // wait for Main.initEffekseerRuntime -> Scene_Boot
  await until(() => typeof SceneManager !== 'undefined' && SceneManager._scene, 120000, 'first scene');
  log('first scene', SceneManager._scene.constructor.name);
  await until(sceneActive(Scene_Title), 180000, 'Scene_Title');
  timings.titleAt = proc.uptime(); log('title reached');
  if (proc.env.SAVETEST === '1') { await saveTestStage(); return finish(0); }
  if (proc.env.INPUTTEST === '1') { await inputTestStage(); return finish(0); }
  if (proc.env.AUDIOTEST === '1') { await audioTestStage(); return finish(T.fails ? 1 : 0); }
  if (proc.env.PMZ_MTEST === '1') { log('MTEST ' + vm.runInThisContext(fs.readFileSync('/opt/beta/mtest.js', 'utf8'))); await bench(); return finish(0); }
  if (proc.env.PMZ_BATTLE === '1') { await battleStage(); return finish(0); }
  const tTitle = nowMs();
  await sleep(HOLD - 1500);
  await takeShotTo(SHOT);
  await sleep(1500);
  const tEnd = nowMs();
  timings.titleStats = frameStats(tTitle + 1000, tEnd);   // skip the first second (texture uploads / settling)
  timings.rssRawAtTitle = readProc();                     // before the gc in measure()
  await measure('title', { scene: SceneManager._scene.constructor.name });
  await bench();
  // options window (stock Scene_Options pushed from the title)
  const profSnap = () => Object.fromEntries(Object.entries(prof).map(([k, v]) => [k, { n: v.n, ms: v.ms }]));
  const p0 = profSnap(), tPush = nowMs(), f0 = frames.length;
  SceneManager.push(Scene_Options);
  await until(() => SceneManager._scene instanceof Scene_Options && SceneManager._scene.isActive() && ImageManager.isReady(), 15000, 'Scene_Options');
  {  // scene-open cost: push -> active (the frames in between include scene create, window contents, fade-in)
    const fr = frames.slice(f0).map(f => +f.dt.toFixed(1)); const p1 = profSnap();
    const d = Object.entries(p1).map(([k, v]) => [k, v.n - (p0[k] ? p0[k].n : 0), v.ms - (p0[k] ? p0[k].ms : 0)]).filter(e => e[1]).sort((a, b) => b[2] - a[2]).slice(0, 8);
    timings.optionsOpen = { ms: +(nowMs() - tPush).toFixed(0), frames: fr.length, longest: Math.max(0, ...fr), native: d.map(e => e[0] + ' ' + e[1] + '/' + e[2].toFixed(0)).join(', ') };
    log('OPTIONS_OPEN', JSON.stringify(timings.optionsOpen));
  }
  if (proc.env.PMZ_NOBLUR === '1') { const sp = SceneManager._scene._backgroundSprite; if (sp) sp.filters = null; log('PMZ_NOBLUR: background blur filter removed'); }
  const tOpt = nowMs();
  await sleep(2000);
  await takeShotTo(SHOT2);
  await sleep(1500);
  timings.optionsStats = frameStats(tOpt + 1000, nowMs());
  await measure('options', { scene: SceneManager._scene.constructor.name });
  SceneManager.pop(); await sleep(800);
  await mapStage();
  finish(0);
}


// PMZ_BATTLE=1: scripted battle (no title/options/map stages): enter Scene_Battle, play real Effekseer animations on the first enemy, screenshot during one
// (PMZ_BATTLE_SHOT, default /opt/beta/shots/battle-beta-N.png), then measure fps / natives over PMZ_BATTLE_SEC seconds of repeated animations.
async function battleStage() {
  DataManager.setupNewGame();
  const tid = +(proc.env.PMZ_TROOP || 0) || ($dataTroops.find(t => t && t.members && t.members.length) || {}).id;
  const have = a => a && a.effectName && fs.existsSync(path.join(GAME, 'effects', a.effectName + '.efkefc'));
  const aid = +(proc.env.PMZ_ANIM || 0) || ($dataAnimations.find(have) || {}).id;
  log('BATTLE troop ' + tid + ' anim ' + aid + ' ' + ($dataAnimations[aid] && $dataAnimations[aid].effectName));
  const tB = nowMs();
  BattleManager.setup(tid, true, false);
  SceneManager.goto(Scene_Battle);
  await until(() => SceneManager._scene instanceof Scene_Battle && SceneManager._scene.isActive() && ImageManager.isReady(), 60000, 'Scene_Battle');
  timings.battleOpenMs = +(nowMs() - tB).toFixed(0); log('BATTLE_OPEN ' + timings.battleOpenMs + ' ms, enemies ' + $gameTroop.members().length + ', party ' + $gameParty.members().length);
  await sleep(3000);
  const spriteset = () => SceneManager._scene._spriteset, target = () => $gameTroop.members()[0] || $gameParty.members()[0];
  const play = async () => { $gameTemp.requestAnimation([target()], aid); const t0 = nowMs(); await until(() => spriteset().isAnimationPlaying(), 5000, 'animation start'); return t0; };
  const base = proc.env.PMZ_BATTLE_SHOT || '/opt/beta/shots/battle-beta.png';
  if (proc.env.PMZ_FREEZE) {   // PMZ_FREEZE=N: stop Effekseer's update after N updates since the request (the effect stays drawn at that frame), screenshot, release: same frame as in NW.js (beta/nw-battle-freeze.js)
    const N = +proc.env.PMZ_FREEZE, E = Graphics.effekseer, up = E.update; let cnt = 0, counting = false, frozen = false;
    const hasHandle = () => { try { return spriteset()._animationSprites.some(a => a._handle); } catch (e) { return false; } };   // count from the moment the effect is really playing (NW.js loads effects asynchronously, later than here)
    E.update = function () { if (frozen) return; if (counting && hasHandle() && ++cnt >= N) frozen = true; return up.apply(this, arguments); };
    for (let i = 1; i <= 2; i++) {
      cnt = 0; frozen = false; counting = true; await play();
      await until(() => frozen, 5000, 'effekseer freeze'); await sleep(600);
      await takeShotTo(base.replace(/\.png$/, '-freeze' + i + '.png'));
      frozen = false; counting = false; await until(() => !spriteset().isAnimationPlaying(), 20000, 'animation end'); await sleep(500);
    }
    E.update = up; return;
  }
  for (let i = 1; i <= 3; i++) {
    await play(); await sleep(150 + 100 * i);
    await takeShotTo(base.replace(/\.png$/, '-' + i + '.png'));
    const t0 = nowMs(); await until(() => !spriteset().isAnimationPlaying(), 20000, 'animation end'); log('ANIM ' + i + ' ended ' + (nowMs() - t0).toFixed(0) + ' ms after the shot');
    await sleep(500);
  }
  const sec = +(proc.env.PMZ_BATTLE_SEC || 12) * 1000, q0 = JSON.parse(JSON.stringify(prof)), g0 = frames.length, tM = nowMs(), cp = proc.env.PMZ_CPUPROF === '1' ? await cpuProfStart() : null;
  if (proc.env.PMZ_BATTLE_REAL === '1') {   // a real fight: pulse OK (Attack -> first enemy) for the whole window, new battle when it ends
    let pulses = 0, rounds = 0;
    while (nowMs() - tM < sec) {
      if (!(SceneManager._scene instanceof Scene_Battle)) { await sleep(300); continue; }
      Input._currentState.ok = true; await sleep(80); Input._currentState.ok = false; await sleep(100); pulses++;
      if (BattleManager.isBattleEnd && BattleManager.isBattleEnd() && pulses % 5 === 0) { rounds++; BattleManager.setup(tid, true, false); SceneManager.goto(Scene_Battle); await sleep(2500); }
    }
    log('BATTLE_REAL pulses ' + pulses + ' new battles ' + rounds);
  } else
  while (nowMs() - tM < sec) { await play(); await until(() => !spriteset().isAnimationPlaying(), 20000, 'animation end'); }
  const nf = frames.length - g0; const d = Object.entries(prof).map(([k, v]) => [k, v.n - (q0[k] ? q0[k].n : 0), v.ms - (q0[k] ? q0[k].ms : 0)]).filter(e => e[1]).sort((x, y) => y[2] - x[2]).slice(0, 16);
  if (d.length) log('BATTLE_NATIVE per frame (' + nf + ' frames): total ' + (d.reduce((t, e) => t + e[2], 0) / nf).toFixed(1) + 'ms; ' + d.map(e => e[0] + ' ' + (e[1] / nf).toFixed(1) + '/' + (e[2] / nf).toFixed(2) + 'ms').join(', '));
  if (cp) await cpuProfStop(cp);
  timings.battleStats = frameStats(tM, nowMs()); log('BATTLE_STATS ' + JSON.stringify(timings.battleStats) + (pmz.textCacheStats ? ' textCache=' + pmz.textCacheStats().join('/') : ''));
  await measure('battle', { scene: SceneManager._scene && SceneManager._scene.constructor.name });
}

function cpuProfStart() {
  const insp = require('inspector'); const ses = new insp.Session(); ses.connect();
  return new Promise(r => ses.post('Profiler.enable', () => ses.post('Profiler.setSamplingInterval', { interval: 500 }, () => ses.post('Profiler.start', () => r(ses)))));
}
function cpuProfStop(ses) {
  return new Promise(r => ses.post('Profiler.stop', (e, { profile }) => {
    const self = new Map(), byId = new Map(); profile.nodes.forEach(n => byId.set(n.id, n));
    const dt = profile.timeDeltas; let tot = 0;
    profile.samples.forEach((id, i) => { const n = byId.get(id), cf = n.callFrame, k = (cf.functionName || '(anon)') + ' ' + cf.url.split('/').slice(-2).join('/') + ':' + cf.lineNumber; self.set(k, (self.get(k) || 0) + dt[i]); tot += dt[i]; });
    const byFile = new Map(); self.forEach((v, k) => { const f = k.replace(/^.*? (\S+):-?\d+$/, '$1'); byFile.set(f, (byFile.get(f) || 0) + v); });
    log('CPUPROF by file: ' + [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(e => e[0] + ' ' + (e[1] / 1000).toFixed(0)).join(', '));
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    log('CPUPROF total ' + (tot / 1000).toFixed(0) + ' ms\n' + top.map(e => '  ' + (e[1] / 1000).toFixed(0) + ' ms ' + e[0]).join('\n'));
    r();
  }));
}
// M1-5: new game -> Scene_Map exactly like Scene_Title.commandNewGame, hold, measure
async function mapStage() {
  await until(sceneActive(Scene_Title), 10000, 'Scene_Title (after options)');
  const tNew = nowMs();
  DataManager.setupNewGame();
  try { SceneManager._scene._commandWindow.close(); } catch (e) {}
  SceneManager._scene.fadeOutAll();
  SceneManager.goto(Scene_Map);
  await until(() => SceneManager._scene instanceof Scene_Map && SceneManager._scene.isActive() && $gamePlayer && $gameMap && $gameMap.mapId() > 0, 30000, 'Scene_Map');
  timings.mapOpenMs = +(nowMs() - tNew).toFixed(0);
  const info = () => ({ mapId: $gameMap.mapId(), x: $gamePlayer.x, y: $gamePlayer.y, msgBusy: $gameMessage.isBusy(), interpreter: $gameMap._interpreter.isRunning(), scene: SceneManager._scene.constructor.name });
  timings.mapInfoOpen = info(); log('MAP_OPEN', JSON.stringify(timings.mapInfoOpen));
  let mtStat = null;
  if (proc.env.PMZ_CPUPROF === '1') {   // who calls measureText, with what
    const P = Object.getPrototypeOf(new Bitmap(4, 4).context), orig = P.measureText; mtStat = { n: 0, ms: 0, by: {} };
    P.measureText = function (t) {
      const a = nowMs(); const r = orig.call(this, t); const d = nowMs() - a; mtStat.n++; mtStat.ms += d;
      const st = (new Error().stack || '').split('\n').slice(2, 5).map(l => l.trim().replace(/^at /, '').replace(/\(?file:\/\/\/game\//, '(')).join(' < ');
      const e = mtStat.by[st] || (mtStat.by[st] = { n: 0, ms: 0, ex: String(t).slice(0, 30), font: this.font }); e.n++; e.ms += d; return r;
    };
  }
  const pSnap0 = JSON.parse(JSON.stringify(prof)), f0 = frames.length;
  const tMap = nowMs(); const cp = proc.env.PMZ_CPUPROF === '1' ? await cpuProfStart() : null;
  await sleep(+(proc.env.MAPHOLD || 10000) - 2500);
  await takeShotTo(SHOT3);
  await sleep(2500);
  timings.mapStats = frameStats(tMap + 1000, nowMs());
  { const nf = frames.length - f0; const d = Object.entries(prof).map(([k, v]) => [k, v.n - (pSnap0[k] ? pSnap0[k].n : 0), v.ms - (pSnap0[k] ? pSnap0[k].ms : 0)]).filter(e => e[1]).sort((a, b) => b[2] - a[2]).slice(0, 14);
    if (d.length) log('MAP_NATIVE per frame (' + nf + ' frames): ' + d.map(e => e[0] + ' ' + (e[1] / nf).toFixed(1) + '/' + (e[2] / nf).toFixed(2) + 'ms').join(', ')); }
  if (cp) await cpuProfStop(cp);
  if (mtStat) log('MEASURETEXT n ' + mtStat.n + ' ms ' + mtStat.ms.toFixed(0) + '\n' + Object.entries(mtStat.by).sort((a, b) => b[1].ms - a[1].ms).slice(0, 8).map(e => '  ' + e[1].n + ' ' + e[1].ms.toFixed(0) + 'ms "' + e[1].ex + '" ' + e[1].font + ' @ ' + e[0].slice(0, 400)).join('\n'));
  timings.mapInfo = info(); log('MAP_INFO', JSON.stringify(timings.mapInfo));
  await measure('map', { scene: SceneManager._scene.constructor.name });
  // teleport to a real map (the opening is a long chain of questions on a black map), settle, measure still + walking
  if (proc.env.TELEPORT !== '0') {
    const tid = +(proc.env.TELEPORT || 11);
    $gameMap.events().forEach(e => e.erase()); $gameMessage.clear(); $gameMap._interpreter.clear(); $gamePlayer.reserveTransfer(tid, 10, 10, 2, 0);
    await sleep(500);
    for (let i = 0; i < 4; i++) { await sleep(1000); const sc = SceneManager._scene; log('TP_STATE', JSON.stringify({ scene: sc.constructor.name, map: $gameMap.mapId(), transferring: $gamePlayer.isTransferring(), msgBusy: $gameMessage.isBusy(), msgWinOpen: sc._messageWindow && sc._messageWindow.isOpen && sc._messageWindow.isOpen(), choiceOpen: sc._messageWindow && sc._messageWindow._choiceListWindow.isOpen(), interp: $gameMap._interpreter.isRunning(), changing: SceneManager.isSceneChanging(), imgReady: ImageManager.isReady(), fade: $gameScreen.brightness && sc._fadeSprite && sc._fadeSprite.opacity })); }
    await until(() => SceneManager._scene instanceof Scene_Map && SceneManager._scene.isActive() && !SceneManager.isSceneChanging() && $gameMap.mapId() === tid && ImageManager.isReady() && !$gamePlayer.isTransferring(), 40000, 'teleport');
    if (!$gameMap.isPassable($gamePlayer.x, $gamePlayer.y, 2)) {   // nearest passable tile
      let best = null; for (let y = 0; y < $gameMap.height(); y++) for (let x = 0; x < $gameMap.width(); x++) if ($gameMap.isPassable(x, y, 2) && $gameMap.isPassable(x, y, 6) && $gameMap.isPassable(x + 1, y, 6) && $gameMap.isPassable(x + 2, y, 6)) { const d = Math.abs(x - $gameMap.width() / 2) + Math.abs(y - $gameMap.height() / 2); if (!best || d < best.d) best = { x, y, d }; }
      if (best) $gamePlayer.locate(best.x, best.y);
    }
    await sleep(2500);
    timings.teleport = { map: $gameMap.mapId(), w: $gameMap.width(), h: $gameMap.height(), x: $gamePlayer.x, y: $gamePlayer.y, events: $gameMap.events().length, tileset: $gameMap.tilesetId(), msgBusy: $gameMessage.isBusy(), interp: $gameMap._interpreter.isRunning() };
    log('TELEPORT', JSON.stringify(timings.teleport));
    // profile the still town map (no screenshot inside the window): PMZ_PROF=all -> GL natives per frame, PMZ_CPUPROF2=1 -> JS self time
    { const q0 = JSON.parse(JSON.stringify(prof)), g0 = frames.length, cp2 = proc.env.PMZ_CPUPROF2 === '1' ? await cpuProfStart() : null;
      await sleep(3000);
      const nf = frames.length - g0; const d = Object.entries(prof).map(([k, v]) => [k, v.n - (q0[k] ? q0[k].n : 0), v.ms - (q0[k] ? q0[k].ms : 0)]).filter(e => e[1]).sort((x, y) => y[2] - x[2]).slice(0, 16);
      if (d.length) log('MAP2_NATIVE per frame (' + nf + ' frames): total ' + (d.reduce((t, e) => t + e[2], 0) / nf).toFixed(1) + 'ms; ' + d.map(e => e[0] + ' ' + (e[1] / nf).toFixed(1) + '/' + (e[2] / nf).toFixed(2) + 'ms').join(', '));
      if (cp2) await cpuProfStop(cp2); }
    const tS = nowMs(); await sleep(1500); await takeShotTo(SHOT4); await sleep(2500);
    timings.mapPlayStats = frameStats(tS + 1000, nowMs());
    await measure('map2', { scene: SceneManager._scene.constructor.name });
    const px = $gamePlayer.x, tW = nowMs(), w0 = JSON.parse(JSON.stringify(prof)), wf0 = frames.length, cp3 = proc.env.PMZ_CPUPROF3 === '1' ? await cpuProfStart() : null;
    Input._currentState.right = true; await sleep(4000); Input._currentState.right = false;
    { const nf = frames.length - wf0; const d = Object.entries(prof).map(([k, v]) => [k, v.n - (w0[k] ? w0[k].n : 0), v.ms - (w0[k] ? w0[k].ms : 0)]).filter(e => e[1]).sort((x, y) => y[2] - x[2]).slice(0, 16);
      if (d.length) log('WALK_NATIVE per frame (' + nf + ' frames): total ' + (d.reduce((t, e) => t + e[2], 0) / nf).toFixed(1) + 'ms; ' + d.map(e => e[0] + ' ' + (e[1] / nf).toFixed(1) + '/' + (e[2] / nf).toFixed(2) + 'ms').join(', '));
      if (cp3) await cpuProfStop(cp3); }
    await sleep(200);
    timings.walkStats = frameStats(tW + 200, nowMs() - 200); timings.walk = { dx: $gamePlayer.x - px, x: $gamePlayer.x, y: $gamePlayer.y };
    await sleep(800); await takeShotTo(SHOT5);
  }
  // advance the opening event (press OK) until the interpreter is idle, then measure the real map
  if (proc.env.MAPADV === '1') {
    const tAdv = nowMs(); let idleSince = 0, presses = 0;
    for (;;) {
      Input._currentState.ok = true; await sleep(100); Input._currentState.ok = false; presses++; await sleep(120);
      if ($gameMessage.isChoice() && presses % 4 === 0) { const w = SceneManager._scene._messageWindow._choiceListWindow; if (presses % 25 === 0) log('CHOICE_STATE', JSON.stringify({ active: w.active, open: w.isOpen(), idx: w.index(), items: w.maxItems(), okEnabled: w.isOkEnabled(), okTrig: w.isOkTriggered && w.isOkTriggered(), choices: $gameMessage.choices() })); { w.select(w.maxItems() - 1); w.processOk(); } }
      const idle = !$gameMessage.isBusy() && !$gameMap._interpreter.isRunning() && !SceneManager.isSceneChanging() && SceneManager._scene instanceof Scene_Map;
      if (idle) { if (!idleSince) idleSince = nowMs(); if (nowMs() - idleSince > 1500) break; } else idleSince = 0;
      if (nowMs() - tAdv > 55000) { log('MAP_ADV timeout'); break; }
    }
    timings.mapAdv = { ms: +(nowMs() - tAdv).toFixed(0), presses, info: info() }; log('MAP_ADV', JSON.stringify(timings.mapAdv));
    await sleep(2000);
    const tP = nowMs(); await sleep(1500); await takeShotTo(SHOT4); await sleep(2500);
    timings.mapPlayStats = frameStats(tP + 1000, nowMs());
    await measure('map2', { scene: SceneManager._scene.constructor.name });
  }
}


// PMZ_PROFLOG=1 (play mode, e.g. under the autotest): every ~10 s an 8 s window -> log line with scene, fps, JS/native split and the top natives per frame
// (needs PMZ_PROF=all); PMZ_CPUPROF=1 adds a JS CPU profile of the windows that fall into Scene_Battle.
async function profLoop() {
  const snap = () => JSON.parse(JSON.stringify(prof));
  for (;;) {
    await sleep(2000);
    const sc = sceneName(), q0 = snap(), g0 = frames.length, t0 = nowMs();
    const cp = proc.env.PMZ_CPUPROF === '1' && sc === 'Scene_Battle' ? await cpuProfStart() : null;
    let tp = null, origDT = null;   // PMZ_TEXTPROF=1: who calls Bitmap.drawText (battle windows)
    if (proc.env.PMZ_TEXTPROF === '1' && sc === 'Scene_Battle') {
      tp = { n: 0, by: {} }; origDT = Bitmap.prototype.drawText;
      Bitmap.prototype.drawText = function (text) {
        tp.n++; const st = (new Error().stack || '').split('\n').slice(2, 6).map(l => l.trim().replace(/^at /, '').replace(/\(?file:\/\/\/game\//, '(').replace(/js\/plugins\//, '')).join(' < ');
        const e = tp.by[st] || (tp.by[st] = { n: 0, ex: String(text).slice(0, 20) + '|' + this.width + 'x' + this.height }); e.n++; return origDT.apply(this, arguments);
      };
    }
    await sleep(8000);
    if (tp) { Bitmap.prototype.drawText = origDT; log('TEXTPROF drawText calls ' + tp.n + ' in 8 s\n' + Object.entries(tp.by).sort((a, b) => b[1].n - a[1].n).slice(0, 8).map(e => '  ' + e[1].n + ' "' + e[1].ex + '" ' + e[0]).join('\n')); }
    const nf = frames.length - g0, st = frameStats(t0, nowMs());
    const d = Object.entries(prof).map(([k, v]) => [k, v.n - (q0[k] ? q0[k].n : 0), v.ms - (q0[k] ? q0[k].ms : 0)]).filter(e => e[1]).sort((x, y) => y[2] - x[2]).slice(0, 10);
    log('PROFWIN scene=' + sc + '->' + sceneName() + ' ' + (st ? 'fps ' + st.fps + ' avg ' + st.avgMs + 'ms js ' + st.jsAvgMs + 'ms swap ' + st.swapAvgMs + 'ms p95 ' + st.p95 + ' max ' + st.maxMs : 'no frames') + ' | natives/frame ' + (d.reduce((t, e) => t + e[2], 0) / Math.max(1, nf)).toFixed(1) + 'ms: ' + d.map(e => e[0] + ' ' + (e[1] / Math.max(1, nf)).toFixed(1) + '/' + (e[2] / Math.max(1, nf)).toFixed(2)).join(', '));
    if (cp) await cpuProfStop(cp);
  }
}

// guard (PMZ_GUARD=1): watches the boot. Booted = the scene after Scene_Boot exists; a GL error (read once, they stick until read) or a timeout fails it.
function guardBoot() {
  const t0 = Date.now(), timer = setInterval(() => {
    if (guardFailed) return clearInterval(timer);
    const sc = typeof SceneManager !== 'undefined' && SceneManager._scene && SceneManager._scene.constructor.name;
    if (sc && sc !== 'Scene_Boot') {
      clearInterval(timer);
      const errs = []; let e, n = 0; while ((e = pmz.getError()) && n++ < 8) errs.push('0x' + e.toString(16));
      if (errs.length) return guardFail('GL error at boot: ' + errs.join(','));
      guardBooted = true; log('GUARD boot ok: scene ' + sc + ' after ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
      if (proc.env.PMZ_GUARD_FORCE) guardFail('forced: ' + proc.env.PMZ_GUARD_FORCE);
    } else if (Date.now() - t0 > GUARD_BOOT_SEC * 1000) { clearInterval(timer); guardFail('no scene after Scene_Boot within ' + GUARD_BOOT_SEC + ' s (scene ' + sc + ')'); }
  }, 200);
}
// play mode: the engine runs by itself (Scene_Boot -> title ...); we only wait for the first scene so errors show up in the log
async function playDrive() {
  if (GUARD) guardBoot();
  await until(() => typeof SceneManager !== 'undefined' && SceneManager._scene, 120000, 'first scene');
  log('PLAY: first scene ' + SceneManager._scene.constructor.name + ', saves in ' + SAVE_DIR + '; quit with Select+Start');
  if (proc.env.PMZ_PROFLOG === '1') profLoop().catch(e => log('profLoop failed', e && e.stack));
  if (proc.env.PMZ_PLAYSELFTEST === '1') {   // self-ending check of the play-mode quit path (needs SAVE_DIR: never the real save dir)
    if (!proc.env.SAVE_DIR) { log('PLAYSELFTEST needs SAVE_DIR'); return finish(2); }
    setTimeout(() => { log('PLAYSELFTEST watchdog'); finish(9); }, 60000);
    await until(sceneActive(Scene_Title), 60000, 'Scene_Title'); await sleep(1500);
    ConfigManager.save(); handleInput({ type: 'buttondown', button: 'back' }); handleInput({ type: 'buttondown', button: 'start' });   // save in flight + Select+Start
    log('PLAYSELFTEST: Select+Start injected, pendingSaves ' + pendingSaves);
  }
}

// ---------- scripted tests (MODE=test) ----------
const T = { fails: 0 };
function check(name, ok, detail) { if (!ok) T.fails++; log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); return ok; }
const sceneName = () => SceneManager._scene && SceneManager._scene.constructor.name;
const mapReady = id => () => SceneManager._scene instanceof Scene_Map && SceneManager._scene.isActive() && !SceneManager.isSceneChanging() && $gameMap.mapId() === id && ImageManager.isReady() && !$gamePlayer.isTransferring();

// SAVETEST=1: (a) load the newest alpha save of the (copied) SAVE_DIR, (b) save to a new slot, compare formats, load it back
async function saveTestStage() {
  const dir = StorageManager.fileDirectoryPath();
  check('save dir is the test dir', dir === SAVE_DIR && dir !== path.join(GAME, 'save') + '/', dir);
  const files = fs.readdirSync(dir).sort(); log('SAVETEST files: ' + files.join(', '));
  const raw = {}; for (const f of files) raw[f] = fs.readFileSync(dir + f, 'utf8');
  DataManager.loadGlobalInfo(); await until(() => DataManager._globalInfo, 5000, 'global info');
  const gi = DataManager._globalInfo; log('SAVETEST globalInfo: ' + JSON.stringify(gi.map(x => x && { title: x.title, chars: x.characters && x.characters.length, playtime: x.playtime, ts: x.timestamp })));
  const alphaIds = gi.map((x, i) => x && i > 0 ? i : 0).filter(i => i && StorageManager.exists('file' + i));
  let loadedSlot = 0;
  if (!alphaIds.length) log('SAVETEST: no alpha saves in the test dir, part (a) skipped');
  else {
    const id = loadedSlot = DataManager.latestSavefileId(); log('SAVETEST newest slot ' + id);
    const alphaJson = JSON.parse(await StorageManager.zipToJson(raw['file' + id + '.rmmzsave']));
    await DataManager.loadGame(id);
    const info = { map: $gameMap.mapId(), x: $gamePlayer.x, y: $gamePlayer.y, gold: $gameParty.gold(), members: $gameParty.members().map(a => a.name() + ' L' + a.level), playtime: $gameSystem.playtimeText() };
    log('SAVETEST loaded ' + JSON.stringify(info));
    check('loaded map id matches the save file', $gameMap.mapId() === alphaJson.map._mapId, { fileMap: alphaJson.map._mapId });
    check('party has members', $gameParty.members().length > 0);
    check('gold matches the save file', $gameParty.gold() === alphaJson.party._gold, { fileGold: alphaJson.party._gold });
    log('SAVETEST versionId save ' + $gameSystem.versionId() + ' data ' + $dataSystem.versionId);
    { // pure round trip: save straight after the load (no scene change) and compare the sizes per key with the file we loaded
      await DataManager.saveGame(6); while (pendingSaves > 0) await sleep(20);
      const j6 = JSON.parse(await StorageManager.zipToJson(fs.readFileSync(dir + 'file6.rmmzsave', 'utf8')));
      const same = Object.keys(alphaJson).every(k => JSON.stringify(alphaJson[k]) === JSON.stringify(j6[k]));
      const diff = Object.keys(alphaJson).filter(k => JSON.stringify(alphaJson[k]) !== JSON.stringify(j6[k]));
      check('load -> save round trip reproduces the alpha save content', same || diff.every(k => ['system', 'screen', 'player'].includes(k)), { differing: diff.map(k => k + ' ' + JSON.stringify(alphaJson[k]).length + '/' + JSON.stringify(j6[k]).length) });
    }
    if ($gameSystem.versionId() !== $dataSystem.versionId) { $gamePlayer.reserveTransfer($gameMap.mapId(), $gamePlayer.x, $gamePlayer.y); $gamePlayer.requestMapReload(); }
    SceneManager.goto(Scene_Map);
    await until(() => SceneManager._scene instanceof Scene_Map && SceneManager._scene.isActive() && !SceneManager.isSceneChanging() && ImageManager.isReady() && !$gamePlayer.isTransferring(), 40000, 'Scene_Map after load');
    await sleep(2500); await takeShotTo('/opt/beta/shots/save-loaded.png');
    const sh = shotInfos['/opt/beta/shots/save-loaded.png'];
    check('map shown after load', sh.nonBlackPct > 20, sh);
  }
  // (b) save into a fresh slot of the test dir
  if (!$gameParty || !$gameParty.members) { log('SAVETEST: no game loaded, starting a new game for part (b)'); DataManager.setupNewGame(); }
  const SLOT = 7, before = { map: $gameMap.mapId ? $gameMap.mapId() : 0, gold: $gameParty.gold(), members: $gameParty.members().map(a => a.actorId()) };
  if (typeof $gameSystem.onBeforeSave === 'function') $gameSystem.onBeforeSave();
  await DataManager.saveGame(SLOT);
  { const t0 = Date.now(); while (pendingSaves > 0 && Date.now() - t0 < 3000) await sleep(20); check('save finished, global info write flushed (pendingSaves -> 0)', pendingSaves === 0, { waitedMs: Date.now() - t0 }); }
  const nf = dir + 'file' + SLOT + '.rmmzsave'; check('new save file exists', fs.existsSync(nf));
  const nraw = fs.readFileSync(nf, 'utf8'), njson = JSON.parse(await StorageManager.zipToJson(nraw));
  const ref = loadedSlot ? 'file' + loadedSlot + '.rmmzsave' : files.filter(f => /^file\d+\.rmmzsave$/.test(f))[0];
  if (ref) {
    const rjson = JSON.parse(await StorageManager.zipToJson(raw[ref]));
    const rk = Object.keys(rjson).sort().join(','), nk = Object.keys(njson).sort().join(',');
    check('top-level keys equal alpha (' + ref + ')', rk === nk, nk);
    const tm = k => Object.keys(rjson[k] || {}).sort().join(',') === Object.keys(njson[k] || {}).sort().join(',');
    check('system/party/map/player sub-keys equal', ['system', 'party', 'map', 'player', 'screen', 'timer', 'switches', 'variables'].filter(k => k in rjson).every(k => typeof rjson[k] === typeof njson[k]) && tm('party') && tm('player'));
    const zh = t => [...t.slice(0, 2)].map(c => c.charCodeAt(0).toString(16)).join(' ');   // zlib header bytes of the pako 'to: string' output
    check('same container (zlib header, utf8 text file)', zh(raw[ref]) === zh(nraw) && fs.statSync(nf).size > nraw.length, { alphaHeader: zh(raw[ref]), newHeader: zh(nraw), alphaChars: raw[ref].length, newChars: nraw.length });
    const sz = o => Object.fromEntries(Object.keys(o).map(k => [k, JSON.stringify(o[k]).length]));
    log('SAVETEST json bytes per key alpha ' + JSON.stringify(sz(rjson)) + ' new ' + JSON.stringify(sz(njson)));
  } else log('SAVETEST: no alpha file to compare the format with');
  // load it back
  await DataManager.loadGame(SLOT);
  check('reload of the new slot', $gameParty.gold() === before.gold && JSON.stringify($gameParty.members().map(a => a.actorId())) === JSON.stringify(before.members), { gold: $gameParty.gold() });
  const gi2 = await StorageManager.loadObject('global'); check('global info lists the new slot', !!gi2[SLOT], gi2[SLOT] && gi2[SLOT].title);
  log('SAVETEST done, fails ' + T.fails);
}

// INPUTTEST=1: scripted SDL-equivalent events through handleInput(): walk, dead zone, F2 swallow, menu open/close
async function inputTestStage() {
  const press = (b, ms) => { handleInput({ type: 'buttondown', button: b }); return sleep(ms || 120).then(() => handleInput({ type: 'buttonup', button: b })); };
  DataManager.setupNewGame(); SceneManager.goto(Scene_Map);
  await until(() => SceneManager._scene instanceof Scene_Map && SceneManager._scene.isActive() && $gamePlayer && $gameMap.mapId() > 0, 30000, 'Scene_Map');
  $gameMap.events().forEach(e => e.erase()); $gameMessage.clear(); $gameMap._interpreter.clear(); $gamePlayer.reserveTransfer(11, 10, 10, 2, 0);
  await sleep(500); await until(mapReady(11), 40000, 'map 11');
  if (!$gameMap.isPassable($gamePlayer.x, $gamePlayer.y, 2)) {
    let best = null; for (let y = 0; y < $gameMap.height(); y++) for (let x = 0; x < $gameMap.width(); x++) if ($gameMap.isPassable(x, y, 2) && $gameMap.isPassable(x, y, 6) && $gameMap.isPassable(x + 1, y, 6) && $gameMap.isPassable(x + 2, y, 6) && $gameMap.isPassable(x, y, 4)) { const d = Math.abs(x - $gameMap.width() / 2) + Math.abs(y - $gameMap.height() / 2); if (!best || d < best.d) best = { x, y, d }; }
    if (best) $gamePlayer.locate(best.x, best.y);
  }
  await sleep(2000);
  log('INPUTTEST map ' + $gameMap.mapId() + ' at ' + $gamePlayer.x + ',' + $gamePlayer.y + ' map: ' + JSON.stringify(inputMap));
  // 1. dpad right moves the player
  let x0 = $gamePlayer.x; handleInput({ type: 'buttondown', button: 'dpright' }); await sleep(900); handleInput({ type: 'buttonup', button: 'dpright' }); await sleep(500);
  check('dpad right moves the player right', $gamePlayer.x > x0, { from: x0, to: $gamePlayer.x });
  // 2. stick left moves it back; a small deflection (dead zone) does not
  let x1 = $gamePlayer.x; handleInput({ type: 'axis', axis: 'leftx', value: 6000 }); await sleep(600); handleInput({ type: 'axis', axis: 'leftx', value: 0 }); await sleep(300);
  check('stick inside the dead zone does not move', $gamePlayer.x === x1 && !Input.isPressed('right'), { x: $gamePlayer.x });
  handleInput({ type: 'axis', axis: 'leftx', value: -30000 }); await sleep(250); const heldLeft = Input.isPressed('left'); await sleep(650); handleInput({ type: 'axis', axis: 'leftx', value: 0 }); await sleep(500);
  check('stick left moves the player left', $gamePlayer.x < x1 && heldLeft && !Input.isPressed('left'), { from: x1, to: $gamePlayer.x });
  // 3. dpad + stick share a key: releasing one keeps it down
  handleInput({ type: 'buttondown', button: 'dpup' }); handleInput({ type: 'axis', axis: 'lefty', value: -30000 }); handleInput({ type: 'buttonup', button: 'dpup' }); await sleep(100);
  const upStill = Input.isPressed('up'); handleInput({ type: 'axis', axis: 'lefty', value: 0 }); await sleep(100);
  check('shared key stays down until the last source is released', upStill && !Input.isPressed('up'));
  await sleep(600);
  // 4. Select+Start does not quit in test mode
  handleInput({ type: 'buttondown', button: 'back' }); await sleep(100);
  handleInput({ type: 'buttondown', button: 'start' }); await sleep(100); handleInput({ type: 'buttonup', button: 'start' });
  handleInput({ type: 'buttonup', button: 'back' }); await sleep(100);
  check('Select+Start does not quit in test mode', sceneName() === 'Scene_Map');
  // 5. B (esc) opens the menu, B closes it; Start does too; keyboard Escape works
  const menuCycle = async (open, close, label) => {
    await until(() => SceneManager._scene instanceof Scene_Map && SceneManager._scene.isActive() && !SceneManager.isSceneChanging(), 10000, 'map before ' + label);
    if (label === 'pad B (esc)') { log('DIAG isMenuCalled=' + String(Scene_Map.prototype.isMenuCalled).replace(/\s+/g, ' ').slice(0, 300) + ' | updateCallMenu=' + String(Scene_Map.prototype.updateCallMenu).replace(/\s+/g, ' ').slice(0, 500) + ' | isMenuEnabled=' + String(Scene_Map.prototype.isMenuEnabled).replace(/\s+/g, ' ').slice(0, 200) + ' | canMove=' + String(Game_Player.prototype.canMove).replace(/\s+/g, ' ').slice(0, 300)); }
    const dg = () => ({ esc: Input.isPressed('escape'), trig: Input.isTriggered('menu'), mcalled: SceneManager._scene.isMenuCalled(), canMove: $gamePlayer.canMove(), ev: $gameMap.isEventRunning(), fol: $gamePlayer.areFollowersGathering(), route: $gamePlayer.isMoveRouteForcing(), tr: $gamePlayer.isTransferring() });
    // this game's menu key starts a common event (CommonEventOpen); stock games push Scene_Menu
    await open(); log('DIAG after open ' + JSON.stringify(dg())); const t0 = Date.now(); let ok = false; while (Date.now() - t0 < 6000) { if (SceneManager._scene instanceof Scene_Menu ? SceneManager._scene.isActive() && ImageManager.isReady() : $gameMap.isEventRunning() && SceneManager._scene instanceof Scene_Map) { ok = true; break; } await sleep(100); }
    check(label + ': menu opened', ok, ok ? sceneName() : { scene: sceneName(), msg: $gameMessage.isBusy(), interp: $gameMap._interpreter.isRunning(), menuEnabled: $gameSystem.isMenuEnabled(), menuCalled: SceneManager._scene.isMenuCalled && SceneManager._scene.isMenuCalled(), esc: Input.isPressed('escape'), disabled: SceneManager._scene.isMenuEnabled && SceneManager._scene.isMenuEnabled(), moving: $gamePlayer.isMoving(), canMove: $gamePlayer.canMove() }); if (!ok) return;
    log('MENU kind ' + sceneName() + ' ev=' + $gameMap.isEventRunning() + ' msg=' + $gameMessage.isBusy() + ' choice=' + $gameMessage.isChoice()); await sleep(1200); await close(); const t1 = Date.now(); let back = false; while (Date.now() - t1 < 6000) { if (SceneManager._scene instanceof Scene_Map && SceneManager._scene.isActive() && !SceneManager.isSceneChanging() && !$gameMap.isEventRunning() && !$gameMessage.isBusy()) { back = true; break; } await sleep(100); }
    check(label + ': back on the map', back, sceneName());
    await sleep(400);
  };
  await menuCycle(() => press('b', 150), () => press('b', 150), 'pad B (esc)');
  await menuCycle(() => press('start', 150), () => press('start', 150), 'pad Start (esc)');
  const kb = (sym, ms) => { handleInput({ type: 'keydown', keycode: sym, repeat: 0 }); return sleep(ms || 150).then(() => handleInput({ type: 'keyup', keycode: sym, repeat: 0 })); };
  await menuCycle(() => kb(27, 150), () => kb(27, 150), 'keyboard Escape');
  // stock Scene_Menu (the game's own menu is a common event): opened by code, closed by pad B (cancel)
  SceneManager.push(Scene_Menu); await until(() => SceneManager._scene instanceof Scene_Menu && SceneManager._scene.isActive() && ImageManager.isReady(), 10000, 'Scene_Menu'); await sleep(700);
  await press('b', 150); { const t1 = Date.now(); let back = false; while (Date.now() - t1 < 6000) { if (SceneManager._scene instanceof Scene_Map && SceneManager._scene.isActive() && !SceneManager.isSceneChanging()) { back = true; break; } await sleep(100); } check('stock Scene_Menu closes with pad B', back, sceneName()); }
  await sleep(600);
  x0 = $gamePlayer.x; await kb(0x4000004F, 700); await sleep(500);   // SDLK_RIGHT
  check('keyboard arrow right moves the player', $gamePlayer.x > x0, { from: x0, to: $gamePlayer.x });
  check('no keys left held', [...keySources.values()].every(s => s.size === 0));
  log('INPUTTEST done, fails ' + T.fails + ' stats ' + JSON.stringify(inputStats));
}

// AUDIOTEST=1 (needs PMZ_AUDIO_DUMP for the sample checks): title BGM audible, SE on cursor move, seamless forced loop compared sample by
// sample with the decoded PCM, fade-out, BGM change (fade out + new BGM) without clicks, mixer cost
async function audioTestStage() {
  const R = wa.rate, st0 = () => wa.stats(true);
  const cap = (f, n) => pmz.auCaptureRead(Math.max(0, f), n);
  log('AUDIOTEST device ' + JSON.stringify(wa.info));
  check('audio device open and callbacks running', wa.hasDevice && wa.stats(false).callbacks > 0, wa.stats(false));
  // 1. title BGM
  await until(() => wa.playingCount() > 0, 20000, 'title BGM playing (decoded)');
  st0(); await sleep(2500); let st = wa.stats(false);
  check('title BGM is audible (non-silent RMS at the mixer)', st.rms > 0.005, { rms: +st.rms.toFixed(4), peak: +st.peak.toFixed(3), bgm: AudioManager._currentBgm && AudioManager._currentBgm.name });
  // 2. SE on cursor move
  st0(); AudioManager.stopBgm(); await sleep(300); st0();
  for (let i = 0; i < 3; i++) { SoundManager.playCursor(); await sleep(450); }
  st = wa.stats(false);
  check('SE (cursor) is audible', st.peak > 0.01, { peak: +st.peak.toFixed(3), rms: +st.rms.toFixed(4), active: wa.playingCount() });
  // 3. forced loop through the engine's WebAudio: loop 1.0 s .. 2.3 s of the file
  const name = proc.env.AUDIOTEST_BGM || 'Battle2';
  const buf = AudioManager.createBuffer('bgm/', name);
  await until(() => buf.isReady() && buf._isLoaded, 20000, 'bgm decoded');
  const ab = buf._buffers[0], sr = ab.sampleRate, ch0 = ab.getChannelData(0), ch1 = ab.numberOfChannels > 1 ? ab.getChannelData(1) : ch0;
  buf._loopStartTime = 1.0; buf._loopLengthTime = 1.3; buf.volume = 1;
  await sleep(300);
  const ls = Math.round(1.0 * sr), le = Math.round(2.3 * sr), step = sr / R;
  const capBefore = wa.stats(false).capFrames;
  buf.play(true, 0);
  const startF = Math.round(buf._startTime * R), master = WebAudio._masterVolume;
  log('AUDIOTEST loop: file ' + name + ' sr ' + sr + ' out rate ' + R + ' start frame ' + startF + ' master ' + master + ' loopStartTime ' + buf._loopStartTime + ' len ' + buf._loopLengthTime);
  await sleep(5500);
  const N = Math.round(5.0 * R), out = cap(startF, N);
  const expected = (i0 => { const e = new Float32Array(N * 2); let pos = 0; const get = (c, i) => (c ? ch1 : ch0)[i];
    for (let i = 0; i < N; i++) { if (pos >= le) { const ll = le - ls; pos -= ll * Math.floor((pos - ls) / ll); } const ip = Math.floor(pos), fr = pos - ip; let i1 = ip + 1; if (i1 >= le) i1 = ls + (i1 - le);
      for (let c = 0; c < 2; c++) e[2 * i + c] = fr === 0 ? get(c, ip) : get(c, ip) + (get(c, i1) - get(c, ip)) * fr; pos += step; }
    return e; })();
  let num = 0, den = 0; for (let i = 0; i < out.length; i++) { num += out[i] * expected[i]; den += expected[i] * expected[i]; }
  const scale = num / den; let maxErr = 0, zr = 0, maxZr = 0; for (let i = 0; i < N; i++) { for (let c = 0; c < 2; c++) maxErr = Math.max(maxErr, Math.abs(out[2 * i + c] - scale * expected[2 * i + c])); if (out[2 * i] === 0 && out[2 * i + 1] === 0) { if (++zr > maxZr) maxZr = zr; } else zr = 0; }
  const loops = Math.floor((N - 0) / ((le - ls) / step));
  check('forced loop is sample exact over ' + loops + ' loop points (fit scale ' + scale.toFixed(4) + ' = BGM vol x master)', maxErr < 1e-5 && Math.abs(scale - master) < 0.02, { maxErr, scale, master });
  check('no run of zero samples at the loop points', maxZr < 32, { maxZr });
  // 4. fade out (engine fadeOut: setValueAtTime + linearRamp), exact envelope check
  const ct = WebAudio._currentTime(), i0 = Math.round(ct * R), fd = 1.5;
  buf.fadeOut(fd); await sleep(2000);
  const NF = Math.round(fd * R) + 2000, outF = cap(i0, NF);
  // expected continues the same loop: position at frame i0 is (i0 - startF)
  let maxDev = 0, maxJump = 0, srcJump = 0;
  { let pos = (i0 - startF) * step; const ll = le - ls; if (pos >= le) pos -= ll * Math.floor((pos - ls) / ll);
    let prev = 0, prevE = 0;
    for (let i = 0; i < NF; i++) { if (pos >= le) pos -= ll * Math.floor((pos - ls) / ll); const ip = Math.floor(pos), fr = pos - ip; let i1 = ip + 1; if (i1 >= le) i1 = ls + (i1 - le);
      const e = (ch0[ip] + (ch0[i1] - ch0[ip]) * fr) * scale * Math.max(0, 1 - i / (fd * R)); maxDev = Math.max(maxDev, Math.abs(outF[2 * i] - e));
      if (i) { maxJump = Math.max(maxJump, Math.abs(outF[2 * i] - prev)); srcJump = Math.max(srcJump, Math.abs(e - prevE)); } prev = outF[2 * i]; prevE = e; pos += step; } }
  const tail = outF.subarray(2 * Math.round(fd * R) + 200); let tailMax = 0; for (const v of tail) tailMax = Math.max(tailMax, Math.abs(v));
  check('fade-out follows the exact linear ramp (no clicks), silent afterwards', maxDev < 1e-4 && tailMax < 1e-6, { maxDev, maxJump: +maxJump.toFixed(4), expectedMaxJump: +srcJump.toFixed(4), tailMax });
  buf.stop();
  // 5. BGM change like a map transfer: fadeOutBgm(1) then playBgm of another file
  AudioManager.playBgm({ name, volume: 90, pitch: 100, pan: 0 }); await sleep(2500);
  const c5 = WebAudio._currentTime(); AudioManager.fadeOutBgm(1); await sleep(300);
  AudioManager.playBgm({ name: proc.env.AUDIOTEST_BGM2 || 'Dungeon6', volume: 90, pitch: 100, pan: 0 }); await sleep(3500);
  const w5 = cap(Math.round(c5 * R), Math.round(4.0 * R)); let pk = 0, mj = 0; for (let i = 0; i < w5.length; i++) { pk = Math.max(pk, Math.abs(w5[i])); if (i > 1) mj = Math.max(mj, Math.abs(w5[i] - w5[i - 2])); }
  check('BGM change (fade out + new BGM): audible, no step larger than 0.5 of peak', pk > 0.05 && mj < 0.5 * pk + 0.05, { peak: +pk.toFixed(3), maxSampleJump: +mj.toFixed(3), now: AudioManager._currentBgm && AudioManager._currentBgm.name });
  AudioManager.stopAll();
  const sf = wa.stats(false);
  log('AUDIOTEST mixer ' + JSON.stringify({ callbacks: sf.callbacks, avgUs: +sf.avgUs.toFixed(0), maxUs: +sf.maxUs.toFixed(0), blockUs: +sf.blockUs.toFixed(0), over50pct: sf.over50pct, buffers: sf.buffers, bufferMB: +(sf.bufferBytes / 1048576).toFixed(1) }));
  log('AUDIOTEST done, fails ' + T.fails);
}

function finish(code) {
  if (finish.done) return; finish.done = true;
  try { if (globalThis.localStorage && globalThis.localStorage.flush) globalThis.localStorage.flush(); } catch (_) {}
  try { if (globalThis.Worker && globalThis.Worker.terminateAll) globalThis.Worker.terminateAll(); } catch (_) {}
  if (PLAY) { console.log('play mode ended, code ' + code + ', input ' + JSON.stringify(inputStats) + ', otherErrors ' + otherErrors.length + (otherErrors.length ? '\n  ' + otherErrors.slice(0, 5).map(x => String(x).split('\n').slice(0, 2).join(' | ').slice(0, 300)).join('\n  ') : '')); try { pmz.shutdown(); } catch (e) {} proc.exit(code); }
  const f = (v, d) => (typeof v === 'number' ? v.toFixed(d === undefined ? 1 : d) : String(v));
  let out = 'pmzrun result (MB unless noted) - plain Node ' + proc.version + ', real PIXI ' + (typeof PIXI !== 'undefined' ? PIXI.VERSION : '?') + ' on pmzrt WebGL1 (' + (glInfo && glInfo.glRenderer) + ', ' + (glInfo && glInfo.glVersion) + ')\n';
  out += 'exit code ' + code + (code ? ' (scene=' + (typeof SceneManager !== 'undefined' && SceneManager._scene && SceneManager._scene.constructor.name) + ')' : '') + '\n';
  out += 'timings (s since process start): ' + JSON.stringify(Object.assign({}, timings, { windowInitMs: undefined, titleStats: undefined, rssRawAtTitle: undefined }), (k, v) => typeof v === 'number' ? +v.toFixed(2) : v) + '; window init ' + f(timings.windowInitMs, 0) + ' ms\n';
  out += 'title frame stats: ' + JSON.stringify(timings.titleStats) + '\n';
  const rr = timings.rssRawAtTitle, m = results.title;
  if (rr) out += 'RSS at title before gc: VmRSS ' + f(rr.VmRSS) + ' RssAnon ' + f(rr.RssAnon) + ' RssFile ' + f(rr.RssFile) + ' VmSwap ' + f(rr.VmSwap) + ' Pss_Anon ' + f(rr.Pss_Anon) + '\n';
  if (m) out += 'RSS at title after gc:  VmRSS ' + f(m.VmRSS) + ' RssAnon ' + f(m.RssAnon) + ' RssFile ' + f(m.RssFile) + ' heapUsed ' + f(m.heapUsed) + ' external ' + f(m.external) + ' arrayBuffers ' + f(m.arrayBuffers) + ' decoded images live ' + f(m.imageMB) + ' (' + m.imageN + ') canvases ' + f(m.canvasMB) + ' (' + m.canvasN + ')\n';
  out += 'options frame stats: ' + JSON.stringify(timings.optionsStats) + '\n';
  out += 'map open ms ' + timings.mapOpenMs + ' info ' + JSON.stringify(timings.mapInfoOpen) + ' -> ' + JSON.stringify(timings.mapInfo) + '\n' + 'map frame stats: ' + JSON.stringify(timings.mapStats) + '\n';
  const mm = results.map; if (mm) out += 'RSS at map after gc: VmRSS ' + f(mm.VmRSS) + ' RssAnon ' + f(mm.RssAnon) + ' RssFile ' + f(mm.RssFile) + ' heapUsed ' + f(mm.heapUsed) + ' canvases ' + f(mm.canvasMB) + ' (' + mm.canvasN + ') images ' + f(mm.imageMB) + '\n';
  out += 'map after advance: ' + JSON.stringify(timings.mapAdv) + '\n' + 'map play frame stats: ' + JSON.stringify(timings.mapPlayStats) + '\n';
  const m2 = results.map2; if (m2) out += 'RSS at map2 after gc: VmRSS ' + f(m2.VmRSS) + ' RssAnon ' + f(m2.RssAnon) + ' canvases ' + f(m2.canvasMB) + ' (' + m2.canvasN + ')\n';
  out += 'teleport: ' + JSON.stringify(timings.teleport) + '\nwalk: ' + JSON.stringify(timings.walk) + ' ' + JSON.stringify(timings.walkStats) + '\n';
  out += 'bench: ' + JSON.stringify(timings.bench) + '\n';
  if (wa) out += 'audio: ' + JSON.stringify(wa.info) + ' stats ' + JSON.stringify(wa.stats(false)) + '\n';
  const mo = results.options; if (mo) out += 'RSS at options after gc: VmRSS ' + f(mo.VmRSS) + ' RssAnon ' + f(mo.RssAnon) + ' RssFile ' + f(mo.RssFile) + ' canvases live ' + f(mo.canvasMB) + ' (' + mo.canvasN + ')\n';
  out += 'screenshots: ' + JSON.stringify(shotInfos) + '\n';
  if (Object.keys(prof).length) out += 'native profile (n, ms): ' + Object.entries(prof).filter(e => e[1].n).sort((a, b) => b[1].ms - a[1].ms).slice(0, 14).map(e => e[0] + ' ' + e[1].n + '/' + e[1].ms.toFixed(0)).join(', ') + '\n';
  out += 'GL stubs/unsupported hit (' + (mainGL ? mainGL.stubs.size : 0) + '): ' + (mainGL ? [...mainGL.stubs].join('; ') : '') + '\n';
  out += 'GL errors (debug=' + GLDEBUG + (glDebugStats ? ', ' + glDebugStats.calls + ' calls checked' : '') + ', ' + glMessages.length + '):\n' + glMessages.map(x => '  ' + x.slice(0, 300)).join('\n') + '\n';
  out += 'compat (' + Object.keys(compatSeen).length + '): ' + Object.keys(compatSeen).join(' | ') + '\n';
  out += 'warnings (' + warnings.length + '): ' + warnings.map(x => x.slice(0, 200)).join(' | ') + '\n';
  out += 'failed plugins (' + failedPlugins.length + '):\n' + failedPlugins.map(x => '  ' + x).join('\n') + '\n';
  out += 'other errors (' + otherErrors.length + ', first 15):\n' + otherErrors.slice(0, 15).map(x => '  ' + String(x).split('\n').slice(0, 3).join(' | ').slice(0, 300)).join('\n') + '\n';
  const muEnd = proc.memoryUsage();
  const csStats = (typeof c2d !== 'undefined' && c2d.getImageSurfaceStats) ? c2d.getImageSurfaceStats() : { bytes: 0 };
  const tracePayload = {
    seed: AT_SEED || null,
    engine: MV ? 'MV' : 'MZ',
    plugins: loadedPlugins,
    failed: failedPlugins,
    titleScene: results.title && results.title.scene || null,
    optionsScene: results.options && results.options.scene || null,
    mapOpen: timings.mapInfoOpen || null,
    mapEnd: timings.mapInfo || null,
  };
  const traceHash = crypto.createHash('sha256').update(JSON.stringify(tracePayload)).digest('hex').slice(0, 16);
  const ciSummary = {
    exitCode: code,
    seed: AT_SEED || null,
    engine: MV ? 'MV' : 'MZ',
    glRenderer: glInfo ? glInfo.glRenderer : null,
    plugins: loadedPlugins.length,
    failed: failedPlugins.length,
    glStubs: mainGL ? mainGL.stubs.size : 0,
    rtStubs: runtimeStubs.size,
    glErrors: glMessages.length,
    otherErrors: otherErrors.length,
    externalMB: +(muEnd.external / 1048576).toFixed(2),
    glMemMB: mainGL ? +(mainGL._glMemBytes / 1048576).toFixed(2) : 0,
    csCacheMB: +(csStats.bytes / 1048576).toFixed(2),
    mapId: timings.mapInfo ? timings.mapInfo.mapId : null,
    scene: (typeof SceneManager !== 'undefined' && SceneManager._scene && SceneManager._scene.constructor) ? SceneManager._scene.constructor.name : null,
    traceHash,
  };
  out += 'CI_SUMMARY ' + JSON.stringify(ciSummary) + '\n';
  console.log('\n' + out);
  try { fs.writeFileSync(OUT, out); } catch (e) { console.log('cannot write ' + OUT + ': ' + e.message); }
  try { pmz.shutdown(); } catch (e) {}
  proc.exit(code);
}
const MAXSEC = parseFloat(proc.env.MAXSEC) || 55;
if (!PLAY) setTimeout(() => { log('WATCHDOG: no result within ' + MAXSEC + ' s'); finish(9); }, MAXSEC * 1000);
