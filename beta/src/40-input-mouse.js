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
