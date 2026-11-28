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
