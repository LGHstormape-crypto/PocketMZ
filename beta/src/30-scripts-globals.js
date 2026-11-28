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
