// SPDX-License-Identifier: MIT
// PocketMZ auto-test driver (RPG Maker MV / MZ). Dev tool: inject ONCE through the PocketMZ_Debug REPL
// (pocketmz-autotest.sh does this), then control it with PMZ_AT.start({...}) / status() / poll() / report().
//
// It plays the game the way a person would (message skipping, choices, walking to events, battles, menus,
// map transfers) by poking RPG Maker's Input state, and records what happens while assets switch and load:
// scene / map load times, errors, failed or slow image and audio loads, frame stalls, heap and image cache.
//
// Safety: every save write path is blocked first. Any trusted key / pointer event from the window means a
// person picked up the handheld: the driver stops at once (phase "aborted-user").
//
// All values returned to the REPL are plain strings without quotes, backslashes or newlines ("k=v;k=v" for
// status, "^" between event lines) so they survive any REPL result encoding.
(function () {
  'use strict';
  if (window.PMZ_AT) return; // already installed in this page

  var NOW = function () { return performance.now(); };
  var T0 = NOW();
  var MZ = typeof Utils !== 'undefined' && Utils.RPGMAKER_NAME === 'MZ';
  var G = window;

  // ---------------------------------------------------------------- state
  var S = {
    phase: 'idle', step: '', mode: 'play', opts: {}, running: false,
    t0: 0, lastProgress: NOW(), lastDecide: 0,
    fr: 0, fps: 0, gap: 0, gapMax: 0, lastRender: 0, sFr: 0, sT: NOW(), lastStall: 0,
    heap: 0, img: '0/0', peakHeap: 0, peakImgMpx: 0,
    pics: 0, picT: NOW(), reqT: 0, transferT: 0, transferMap: 0,
    n: { maps: 0, mapLoads: 0, battles: 0, scenes: 0, newgames: 0, gameovers: 0, events: 0, msgs: 0, errors: 0, stuck: 0, teleports: 0, menus: 0, movies: 0, slowimg: 0 },
    maps: {}, mapLoads: [], sceneMs: [], errs: {}, q: [], dropped: 0, crashed: false
  };
  var P = { // autoplayer state
    sceneObj: null, sceneSince: 0, lastStarted: '', lastPress: 0, target: null, visited: {}, fail: {},
    mapId: 0, mapSince: 0, lastMenu: 0, menu: null, randomUntil: 0, lastTeleport: 0, wasEv: false, evSince: 0,
    msgSince: 0, chSeen: 0, chSel: 0, chIdx: 0, battleSince: 0, battleTroop: 0, troopRun: false, fixSpawn: false,
    unkPress: 0, gameoverSeen: null, nameSeen: null, tour: null
  };
  var inj = {}; // input name -> frames to stay down (1 = one frame down, then one frame up)

  // ---------------------------------------------------------------- helpers
  function san(s) { return String(s).replace(/[\r\n\t^"\\|;@]+/g, ' ').slice(0, 220); }
  function el() { return Math.round(NOW() - T0); }
  function ev(kind, text) {
    try {
      if (S.q.length >= 3000) { S.q.shift(); S.dropped++; }
      S.q.push(el() + '|' + kind + '|' + san(text));
    } catch (e) { /* never throw */ }
  }
  function progress() { S.lastProgress = NOW(); }
  function sceneName(sc) { return sc ? (sc.constructor && sc.constructor.name) || 'anon' : ''; }
  function curMapId() { try { return G.$gameMap ? ($gameMap.mapId() || 0) : 0; } catch (e) { return 0; } }
  function mapName(id) { try { var m = G.$dataMapInfos && $dataMapInfos[id]; return m ? m.name : ''; } catch (e) { return ''; } }
  function rnd(n) { return Math.floor(Math.random() * n); }
  function logError(msg) {
    try {
      msg = san(msg);
      S.n.errors++;
      var c = (S.errs[msg] = (S.errs[msg] || 0) + 1);
      if (c <= 3 || c % 50 === 0) ev('error', msg + ' (x' + c + ') step=' + S.step);
    } catch (e) { /* never throw */ }
  }
  // pre/post hook: the game's own exceptions pass through unchanged
  function hook(obj, name, pre, post) {
    var o = obj && obj[name];
    if (typeof o !== 'function') return false;
    obj[name] = function () {
      if (pre) { try { pre.apply(this, arguments); } catch (e) { /* ignore */ } }
      var r = o.apply(this, arguments);
      if (post) { try { post.call(this, r, arguments); } catch (e) { /* ignore */ } }
      return r;
    };
    return true;
  }
  function hookThrow(obj, name, onThrow) {
    var o = obj && obj[name];
    if (typeof o !== 'function') return false;
    obj[name] = function () {
      try { return o.apply(this, arguments); } catch (e) {
        try { onThrow.call(this, e, arguments); } catch (e2) { /* ignore */ }
        throw e;
      }
    };
    return true;
  }
  function press(name) { if (inj[name] === undefined) inj[name] = 1; }
  function releaseInputs() {
    try { for (var n in inj) { if (G.Input && Input._currentState) Input._currentState[n] = false; } } catch (e) { /* ignore */ }
    inj = {};
  }
  function safePop() { // SceneManager.pop() with an empty stack would exit the game
    try {
      if (SceneManager._stack && SceneManager._stack.length > 0) SceneManager.pop();
      else SceneManager.goto(Scene_Map);
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- save blocking (first thing)
  // Every write path in rpg_managers.js (MV) / rmmz_managers.js (MZ) goes through these.
  function blockSaves() {
    var done = [];
    var ok = function () { return Promise.resolve(); };
    var sm = G.StorageManager;
    if (sm) {
      ['save', 'backup', 'cleanBackup', 'restoreBackup', 'remove', 'saveToLocalFile', 'saveToWebStorage',
        'removeLocalFile', 'removeWebStorage', 'saveObject', 'saveZip', 'saveToForage', 'removeForage'].forEach(function (n) {
        if (typeof sm[n] === 'function') { sm[n] = ok; done.push('SM.' + n); }
      });
      ['fsMkdir', 'fsRename', 'fsUnlink', 'fsWriteFile'].forEach(function (n) {
        if (typeof sm[n] === 'function') { sm[n] = function () {}; done.push('SM.' + n); }
      });
    }
    var dm = G.DataManager;
    if (dm) {
      ['saveGame', 'saveGameWithoutRescue'].forEach(function (n) {
        if (typeof dm[n] === 'function') { dm[n] = function () { return MZ ? Promise.resolve(true) : true; }; done.push('DM.' + n); }
      });
      if (typeof dm.saveGlobalInfo === 'function') { dm.saveGlobalInfo = function () {}; done.push('DM.saveGlobalInfo'); }
    }
    if (G.ConfigManager && typeof ConfigManager.save === 'function') { ConfigManager.save = function () {}; done.push('CM.save'); }
    // plugins that write save files by themselves: guard node fs paths inside a save folder, and RPG* web storage keys
    try {
      if (S.opts.fsGuard !== false && typeof require === 'function') {
        var fs = require('fs');
        var bad = function (p) { return typeof p === 'string' && /[\\/]save[\\/]|\.(rpgsave|rmmzsave)$/i.test(p); };
        ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'unlinkSync', 'unlink', 'renameSync', 'rename',
          'copyFileSync', 'copyFile', 'rmSync', 'rm'].forEach(function (n) {
          var o = fs[n];
          if (typeof o !== 'function' || o.__pmzat) return;
          var w = function () {
            if (bad(arguments[0]) || ((n === 'renameSync' || n === 'rename' || n === 'copyFileSync' || n === 'copyFile') && bad(arguments[1]))) {
              var cb = arguments[arguments.length - 1];
              if (typeof cb === 'function') { try { cb(null); } catch (e) { /* ignore */ } }
              return undefined;
            }
            return o.apply(this, arguments);
          };
          w.__pmzat = true;
          try { fs[n] = w; done.push('fs.' + n); } catch (e) { /* read-only module */ }
        });
      }
    } catch (e) { /* fs not available */ }
    try {
      var ls = Storage.prototype;
      if (!ls.__pmzat) {
        var os = ls.setItem;
        ls.setItem = function (k) { if (/^RPG/i.test(String(k))) return; return os.apply(this, arguments); };
        ls.__pmzat = true;
        done.push('localStorage.RPG*');
      }
    } catch (e) { /* ignore */ }
    return done;
  }
  var BLOCKED = blockSaves();

  // ---------------------------------------------------------------- measurements
  function imgCache() {
    try {
      var IM = G.ImageManager, keys = 0, px = 0, b;
      if (!IM) return '0/0';
      if (IM._cache && !(IM.cache && IM.cache._inner)) { // MZ: url -> Bitmap
        var ks = Object.keys(IM._cache);
        for (var i = 0; i < ks.length; i++) { b = IM._cache[ks[i]]; if (b && b.width) px += b.width * b.height; }
        keys = ks.length;
      } else if (IM.cache && IM.cache._inner) { // MV: CacheMap of CacheEntry{item: Bitmap}
        var k2 = Object.keys(IM.cache._inner);
        for (var j = 0; j < k2.length; j++) { var en = IM.cache._inner[k2[j]]; b = en && en.item; if (b && b.width) px += b.width * b.height; }
        keys = k2.length;
      }
      var mpx = px / 1e6;
      if (mpx > S.peakImgMpx) S.peakImgMpx = mpx;
      return keys + '/' + mpx.toFixed(1);
    } catch (e) { return '0/0'; }
  }
  function heapMB() { try { return Math.round(performance.memory.usedJSHeapSize / 1048576); } catch (e) { return 0; } }
  // decoded audio (PCM kept in AudioBuffers, outside the JS heap): counted when decoded,
  // subtracted when the buffer is garbage collected (from the driver's start on)
  var AUD = { live: 0, total: 0, n: 0 };
  try {
    var AC = G.AudioContext || G.webkitAudioContext;
    var fin = G.FinalizationRegistry ? new FinalizationRegistry(function (bytes) { AUD.live -= bytes; }) : null;
    if (AC && AC.prototype.decodeAudioData && !AC.prototype._pmzAud) {
      var _dec = AC.prototype.decodeAudioData;
      AC.prototype._pmzAud = true;
      AC.prototype.decodeAudioData = function (data, ok, fail) {
        var count = function (buf) {
          try {
            var bytes = buf.length * buf.numberOfChannels * 4;
            AUD.live += bytes; AUD.total += bytes; AUD.n++;
            if (fin) fin.register(buf, bytes);
          } catch (e) { /* ignore */ }
          return buf;
        };
        var p = _dec.call(this, data, ok ? function (b) { ok(count(b)); } : undefined, fail);
        return p && p.then && !ok ? p.then(count) : p;
      };
    }
  } catch (e) { /* ignore */ }
  function audMB() { return Math.round(AUD.live / 1048576) + '/' + Math.round(AUD.total / 1048576); }
  // canvases and decoded <img> alive in the renderer (2D canvases are software bitmaps here, outside
  // the JS heap; GC frees them only when their wrappers are collected). Sizes are tracked through
  // the width/height setters and the img load event; freed through a FinalizationRegistry.
  var CNV = { live: 0, n: 0, img: 0, imgN: 0, refs: [] };
  try {
    var cfin = G.FinalizationRegistry ? new FinalizationRegistry(function (h) { CNV[h.k] -= h.b; CNV[h.k === 'live' ? 'n' : 'imgN']--; }) : null;
    var CP = G.HTMLCanvasElement && HTMLCanvasElement.prototype;
    if (cfin && CP && !CP._pmzCnv) {
      CP._pmzCnv = true;
      var held = new WeakMap();
      var track = function (c) {
        var h = held.get(c);
        if (!h) {
          h = { k: 'live', b: 0 }; held.set(c, h); cfin.register(c, h); CNV.n++;
          // where it was made: first stack frame outside this file and the core Bitmap code
          var st = (new Error().stack || '').split(String.fromCharCode(10)).slice(1).map(function (l) { return l.trim(); })
            .filter(function (l) { return /js\/(?!libs\/)/.test(l) && !/rpg_core\.js|rmmz_core\.js|PocketMZ_Debug|pocketmz-autotest|<anonymous>/.test(l); });
          h.from = st.slice(0, 2).map(function (l) { return l.replace(/^at /, '').replace(/\(?[^ ]*\/(js\/[^)]*)\)?/, '$1'); }).join(' < ').slice(0, 140);
          CNV.refs.push({ r: G.WeakRef ? new WeakRef(c) : null, h: h });
          if (CNV.refs.length > 4000) CNV.refs = CNV.refs.filter(function (x) { return x.r && x.r.deref(); });
        }
        var b = (c.width || 0) * (c.height || 0) * 4;
        CNV.live += b - h.b; h.b = b;
      };
      ['width', 'height'].forEach(function (p) {
        var d = Object.getOwnPropertyDescriptor(CP, p);
        if (d && d.set) Object.defineProperty(CP, p, { configurable: true, enumerable: d.enumerable, get: d.get,
          set: function (v) { d.set.call(this, v); try { track(this); } catch (e) { /* ignore */ } } });
      });
      var IP = G.HTMLImageElement && HTMLImageElement.prototype;
      var heldI = new WeakMap();
      // <img> elements outside the document (MV / MZ load images that way): follow the src setter;
      // the decoded size is counted on load and dropped when src is cleared or the element is GC'd
      var srcD = IP && Object.getOwnPropertyDescriptor(IP, 'src');
      if (srcD && srcD.set) {
        var imgSize = function (im) {
          var h = heldI.get(im);
          if (!h) { h = { k: 'img', b: 0 }; heldI.set(im, h); cfin.register(im, h); CNV.imgN++; }
          var b = im.src ? (im.naturalWidth || 0) * (im.naturalHeight || 0) * 4 : 0;
          CNV.img += b - h.b; h.b = b;
        };
        Object.defineProperty(IP, 'src', { configurable: true, enumerable: srcD.enumerable, get: srcD.get,
          set: function (v) {
            srcD.set.call(this, v);
            var im = this;
            try {
              if (!v) imgSize(im);
              else im.addEventListener('load', function () { try { imgSize(im); } catch (e) { /* ignore */ } }, { once: true });
            } catch (e) { /* ignore */ }
          } });
      }
    }
  } catch (e) { /* ignore */ }
  // live canvases grouped by creator and size (top 12), for PMZ_AT.canvases()
  function canvasTable() {
    var g = {};
    CNV.refs = CNV.refs.filter(function (x) { return x.r && x.r.deref(); });
    CNV.refs.forEach(function (x) {
      var c = x.r.deref(), k = x.h.from + ' ' + c.width + 'x' + c.height;
      g[k] = g[k] || { n: 0, b: 0 }; g[k].n++; g[k].b += c.width * c.height * 4;
    });
    return Object.keys(g).sort(function (a, b) { return g[b].b - g[a].b; }).slice(0, 12)
      .map(function (k) { return (g[k].b / 1048576).toFixed(1) + 'MB n=' + g[k].n + ' ' + k; }).join('^');
  }
  function cnvMB() { return Math.round(CNV.live / 1048576) + 'MB/' + CNV.n + ' imgs=' + Math.round(CNV.img / 1048576) + 'MB/' + CNV.imgN; }

  function statsTick() {
    try {
      var now = NOW(), dt = (now - S.sT) / 1000 || 1;
      S.fps = Math.round((S.fr - S.sFr) / dt); S.sFr = S.fr; S.sT = now;
      S.gap = Math.round(S.gapMax); S.gapMax = 0;
      S.heap = heapMB(); if (S.heap > S.peakHeap) S.peakHeap = S.heap;
      S.img = imgCache();
      ev('frames', 'n=' + S.fr + ' fps=' + S.fps + ' gap=' + S.gap + 'ms heap=' + S.heap + 'MB img=' + S.img + ' audio=' + audMB() + 'MB canvas=' + cnvMB() + ' step=' + S.step);
      if (now - S.picT >= 60000) { ev('pics', 'n=' + S.pics + '/min'); S.pics = 0; S.picT = now; }
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- hooks on the engine
  function installHooks() {
    // input injection + per-frame driver
    hook(G.Input, 'update', function () {
      if (S.running) {
        for (var n in inj) {
          if (inj[n] > 0) { Input._currentState[n] = true; inj[n]--; } else { Input._currentState[n] = false; delete inj[n]; }
        }
        frameDrive();
      }
    });
    // frames drawn / worst gap
    try {
      var R = (G.Graphics && Graphics.app && Graphics.app.renderer) || (G.Graphics && Graphics._renderer);
      hook(R, 'render', function () {
        var now = NOW();
        if (S.lastRender) {
          var g = now - S.lastRender;
          if (g > S.gapMax) S.gapMax = g;
          if (g > 700 && now - S.lastStall > 500) { S.lastStall = now; ev('stall', 'gap=' + Math.round(g) + 'ms step=' + S.step + ' scene=' + sceneName(G.SceneManager && SceneManager._scene)); }
        }
        S.lastRender = now; S.fr++;
      });
    } catch (e) { /* ignore */ }
    // scene timing
    ['goto', 'push', 'pop'].forEach(function (n) { hook(G.SceneManager, n, function () { S.reqT = NOW(); }); });
    hook(G.SceneManager, 'onSceneStart', null, function () {
      var now = NOW(), sc = SceneManager._scene, nm = sceneName(sc), ms = S.reqT ? Math.round(now - S.reqT) : -1;
      S.n.scenes++; progress();
      if (ms >= 0) S.sceneMs.push({ from: P.lastStarted, to: nm, ms: ms });
      if (S.sceneMs.length > 3000) S.sceneMs.shift();
      ev('scene', (P.lastStarted || '-') + '>' + nm + ' ms=' + ms);
      if (G.Scene_Map && sc instanceof Scene_Map) {
        var id = curMapId(), mms = Math.round(now - (S.transferT || S.reqT || now));
        S.n.mapLoads++;
        if (!S.maps[id]) S.n.maps++;
        S.maps[id] = (S.maps[id] || 0) + 1;
        S.mapLoads.push({ id: id, name: mapName(id), ms: mms });
        if (S.mapLoads.length > 2000) S.mapLoads.shift();
        ev('map', 'id=' + id + ' name=' + mapName(id) + ' ms=' + mms);
        S.transferT = 0;
        if (P.fixSpawn) fixSpawn();
      }
      P.lastStarted = nm;
    });
    hook(G.Game_Player && Game_Player.prototype, 'reserveTransfer', function (mapId) { S.transferT = NOW(); S.transferMap = mapId; });
    // battles
    hook(G.BattleManager, 'setup', function (troopId) { P.battleTroop = troopId; });
    hook(G.BattleManager, 'startBattle', function () {
      S.n.battles++; P.battleSince = NOW(); progress();
      ev('battle', 'start troop=' + P.battleTroop + ' map=' + curMapId());
    });
    hook(G.BattleManager, 'endBattle', function (result) {
      ev('battle', 'end troop=' + P.battleTroop + ' result=' + result + ' ms=' + Math.round(NOW() - P.battleSince));
      progress();
    });
    // pictures and movies
    hook(G.Game_Screen && Game_Screen.prototype, 'showPicture', function () { S.pics++; });
    hook(G.Graphics, 'playVideo', function (src) { S.n.movies++; ev('movie', 'Graphics.playVideo ' + src); });
    if (G.Video) hook(G.Video, 'play', function (src) { S.n.movies++; ev('movie', 'Video.play ' + src); });
    // images: failed and slow loads
    var BP = G.Bitmap && Bitmap.prototype;
    hook(BP, '_onError', function () { ev('imgerr', 'url=' + this._url); logError('image load failed ' + this._url); });
    hook(BP, MZ ? '_startLoading' : '_requestImage', function () { this._pmzT = NOW(); });
    hook(BP, '_onLoad', function () {
      if (!this._pmzT) return;
      var d = NOW() - this._pmzT; this._pmzT = 0;
      if (d >= 300) { S.n.slowimg++; ev('slowimg', 'url=' + this._url + ' ms=' + Math.round(d)); }
    });
    // audio: failed and slow loads
    var WP = G.WebAudio && WebAudio.prototype;
    hook(WP, WP && WP._load ? '_load' : '_startLoading', function () { this._pmzT = NOW(); });
    hook(WP, '_onLoad', function () {
      if (!this._pmzT) return;
      var d = NOW() - this._pmzT; this._pmzT = 0;
      if (d >= 500) ev('slowaudio', 'url=' + this._url + ' ms=' + Math.round(d));
    });
    hook(WP, '_onError', function () { ev('audioerr', 'url=' + this._url); logError('audio load failed ' + this._url); });
    hookThrow(G.AudioManager, 'checkWebAudioError', function (e, a) { ev('audioerr', 'url=' + (a[0] && a[0].url)); logError('audio ' + e); });
    hook(G.AudioManager, 'throwLoadError', function (webAudio) { ev('audioerr', 'LoadError url=' + (webAudio && webAudio.url)); });
    // fatal engine errors (the game stops after these)
    hook(G.SceneManager, 'catchException', function (e) {
      logError('FATAL ' + (e && e.stack ? String(e.stack).split('\n').slice(0, 2).join(' ') : (e && e[0] === 'LoadError' ? 'LoadError ' + e[1] : e)));
      S.crashed = true; S.running = false; S.phase = 'crashed'; releaseInputs(); ev('phase', 'crashed step=' + S.step);
    });
    hook(G.Graphics, 'printError', function (name, message) { ev('error', 'printError ' + name + ' ' + message); });
    // window level errors, resource errors (capture), rejected promises
    window.addEventListener('error', function (e) {
      try {
        var t = e.target;
        if (t && t !== window && (t.src || t.href)) logError('resource ' + (t.src || t.href));
        else logError((e.message || 'error') + ' @' + String(e.filename || '').split('/').pop() + ':' + e.lineno);
      } catch (x) { /* ignore */ }
    }, true);
    window.addEventListener('unhandledrejection', function (e) {
      try { var r = e.reason; logError('rejection ' + (r && r.stack ? String(r.stack).split('\n').slice(0, 2).join(' ') : r)); } catch (x) { /* ignore */ }
    });
    // a person is using the handheld: trusted input events only (our own input never dispatches DOM events)
    ['keydown', 'mousedown', 'pointerdown', 'touchstart', 'wheel'].forEach(function (t) {
      window.addEventListener(t, function (e) {
        try { if (S.running && e.isTrusted && !S.opts.ignoreUser) abortUser(t); } catch (x) { /* ignore */ }
      }, true);
    });
  }

  function abortUser(why) {
    S.running = false; S.phase = 'aborted-user'; releaseInputs();
    ev('user', 'trusted ' + why + ' event, driver stopped step=' + S.step);
  }
  function finish(phase) {
    S.running = false; S.phase = phase; releaseInputs();
    ev('phase', phase + ' step=' + S.step);
  }

  // ---------------------------------------------------------------- game helpers
  function started() {   // MZ: Scene_Base#isStarted; MV 1.6: SceneManager._sceneStarted
    const sc = G.SceneManager && SceneManager._scene;
    if (!sc || SceneManager.isSceneChanging()) return false;
    return typeof sc.isStarted === "function" ? !!sc.isStarted() : !!SceneManager._sceneStarted;
  }
  function inGame() { return !!(G.$gameMap && G.$gamePlayer && G.$gameMessage && G.$gameParty); }
  function isMap(sc) { return !!(G.Scene_Map && sc instanceof Scene_Map); }
  function mapFree() {
    try {
      return isMap(SceneManager._scene) && started() && !$gamePlayer.isTransferring() && !$gameMap.isEventRunning() && !$gameMessage.isBusy();
    } catch (e) { return false; }
  }
  function findActive(sc, cls) {
    var C = G[cls], list = (sc && sc._windowLayer && sc._windowLayer.children) || [];
    if (!C) return null;
    for (var i = 0; i < list.length; i++) if (list[i] instanceof C && list[i].active) return list[i];
    return null;
  }
  var dataDirOk = null, fsMod = null;
  function mapExists(id) { // false only when we can prove the map file is missing
    try {
      if (dataDirOk === null) {
        fsMod = typeof require === 'function' ? require('fs') : null;
        var base = decodeURIComponent(location.pathname.replace(/[^/]*$/, ''));
        G.__pmzatBase = base + 'data/';
        dataDirOk = !!(fsMod && fsMod.existsSync(G.__pmzatBase + 'System.json'));
      }
      if (!dataDirOk) return true;
      return fsMod.existsSync(G.__pmzatBase + 'Map' + ('000' + id).slice(-3) + '.json');
    } catch (e) { return true; }
  }
  function mapIds() {
    var out = [];
    try { for (var i = 1; i < $dataMapInfos.length; i++) if ($dataMapInfos[i] && mapExists(i)) out.push(i); } catch (e) { /* ignore */ }
    return out;
  }
  function canStand(x, y) {
    var W = $gameMap.width(), H = $gameMap.height();
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    var ds = [2, 4, 6, 8];
    for (var i = 0; i < 4; i++) {
      var d = ds[i], nx = $gameMap.roundXWithDirection(x, d), ny = $gameMap.roundYWithDirection(y, d);
      if ($gameMap.isPassable(x, y, d) && $gameMap.isPassable(nx, ny, 10 - d)) {
        var evs = $gameMap.eventsXy(x, y);
        for (var k = 0; k < evs.length; k++) if (evs[k].isNormalPriority()) return false;
        return true;
      }
    }
    return false;
  }
  function spiral(x0, y0) { // nearest standable tile around (x0, y0)
    var W = $gameMap.width(), H = $gameMap.height(), R = Math.max(W, H);
    for (var r = 0; r <= R; r++) {
      for (var dy = -r; dy <= r; dy++) {
        for (var dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (canStand(x0 + dx, y0 + dy)) return { x: x0 + dx, y: y0 + dy };
        }
      }
    }
    return null;
  }
  function fixSpawn() { // after a teleport: move the player from the dummy tile to a real standable one
    P.fixSpawn = false;
    try {
      var evs = $gameMap.events().filter(function (e) { return !e._erased; });
      var x = $gameMap.width() >> 1, y = $gameMap.height() >> 1;
      if (evs.length) { var e = evs[rnd(evs.length)]; x = e.x; y = e.y; }
      var p = spiral(x, y);
      if (p) $gamePlayer.locate(p.x, p.y);
      ev('teleport', 'spawn map=' + curMapId() + ' at=' + (p ? p.x + ',' + p.y : 'none'));
    } catch (e) { logError('fixSpawn ' + e); }
  }
  function teleport(mapId, reason) {
    try {
      $gameMessage.clear();
      var it = $gameMap._interpreter;
      if (it && it.terminate) it.terminate();
      P.fixSpawn = true; P.target = null; P.lastTeleport = NOW();
      $gamePlayer.reserveTransfer(mapId, 1, 1, 2, 2);
      S.n.teleports++; progress();
      ev('teleport', 'map=' + mapId + ' name=' + mapName(mapId) + ' reason=' + reason);
    } catch (e) { logError('teleport ' + e); }
  }
  function newGame(why) {
    P.visited = {}; P.fail = {}; P.target = null; P.menu = null; P.mapId = 0; P.troopRun = false;
    DataManager.setupNewGame();
    SceneManager.goto(G.Scene_Map);
    S.n.newgames++; progress();
    ev('newgame', why);
  }

  // ---------------------------------------------------------------- autoplayer
  function frameDrive() {
    var now = NOW();
    if (S.opts.watchPad) {
      try {
        var gps = navigator.getGamepads ? navigator.getGamepads() : [];
        for (var i = 0; i < gps.length; i++) if (gps[i] && gps[i].buttons.some(function (b) { return b.pressed; })) { abortUser('gamepad'); return; }
      } catch (e) { /* ignore */ }
    }
    if (now - S.lastDecide < 100) return;
    S.lastDecide = now;
    try { decide(now); } catch (e) { logError('driver ' + (e && e.stack ? String(e.stack).split('\n').slice(0, 2).join(' ') : e)); }
  }

  function decide(now) {
    var sc = G.SceneManager && SceneManager._scene;
    if (!sc) return;
    if (S.opts.minutes && now - S.t0 > S.opts.minutes * 60000) { finish('done'); return; }
    var nm = sceneName(sc);
    if (sc !== P.sceneObj) { P.sceneObj = sc; P.sceneSince = now; P.msgSince = 0; P.chSeen = 0; P.chSel = 0; }
    if (!started()) { S.step = 'loading ' + nm; return; }
    if (S.phase === 'init') {
      if (nm === 'Scene_Boot' || !G.DataManager) return;
      S.phase = S.mode; S.t0 = now; P.lastMenu = now; progress();
      ev('phase', S.mode + ' start scene=' + nm);
      if (S.mode === 'tour') startTour();
      if (!isMap(sc)) { newGame('start from ' + nm); return; } // already on a map: just carry on from there
    }
    if (inGame()) watchEvents(now);
    if (inGame()) stuckCheck(now, sc);
    if (P.menu && menuStep(now, sc)) return;
    if (isMap(sc)) return mapStep(now, sc);
    if (G.Scene_Battle && sc instanceof Scene_Battle) return battleStep(now, sc);
    if (/title/i.test(nm)) { S.step = 'title'; if (now - P.sceneSince > 1200) newGame('title'); return; }
    if (G.Scene_Gameover && sc instanceof Scene_Gameover) {
      S.step = 'gameover';
      if (P.gameoverSeen !== sc) { P.gameoverSeen = sc; S.n.gameovers++; ev('gameover', 'map=' + curMapId()); }
      if (now - P.sceneSince > 1500) newGame('gameover');
      return;
    }
    if (G.Scene_Name && sc instanceof Scene_Name) {
      S.step = 'name input';
      if (now - P.sceneSince > 800 && typeof sc.onInputOk === 'function') sc.onInputOk();
      return;
    }
    otherScene(now, sc, nm);
  }

  function watchEvents(now) {
    var evr = false;
    try { evr = $gameMap.isEventRunning() || $gameMessage.isBusy(); } catch (e) { /* ignore */ }
    if (evr && !P.wasEv) { S.n.events++; progress(); P.evSince = now; }
    if (evr && $gameMessage.isBusy()) progress();
    P.wasEv = evr;
  }

  function stuckCheck(now, sc) {
    var idle = now - S.lastProgress;
    if (!isMap(sc) || !started()) return;
    if (idle > 120000 && now - P.lastTeleport > 120000) {
      var ids = mapIds(), cur = curMapId();
      ids = ids.filter(function (i) { return i !== cur; });
      S.n.stuck++;
      ev('stuck', 'level=2 idle=' + Math.round(idle / 1000) + 's map=' + cur + ' step=' + S.step);
      if (ids.length) teleport(ids[rnd(ids.length)], 'stuck'); else progress();
    } else if (idle > 60000 && now > P.randomUntil + 20000 && idle < 119000) {
      P.randomUntil = now + 15000; P.target = null; S.n.stuck++;
      ev('stuck', 'level=1 idle=' + Math.round(idle / 1000) + 's random walk map=' + curMapId() + ' step=' + S.step);
    }
  }

  function otherScene(now, sc, nm) { // shops, save/load, options, plugin scenes: leave them again
    S.step = 'scene ' + nm;
    var t = now - P.sceneSince;
    if (t > 3000 && now - P.unkPress > 1000) { press(((t / 1000) | 0) % 3 === 2 ? 'ok' : 'cancel'); P.unkPress = now; }
    if (t > 20000 && now - P.unkPress > 500) { ev('stuck', 'scene ' + nm + ' for 20s, leaving'); safePop(); P.sceneSince = now; }
  }

  function msgStep(now, sc) {
    var gm = $gameMessage;
    if (!P.msgSince) { P.msgSince = now; S.n.msgs++; }
    S.step = 'msg';
    if (gm.isChoice()) {
      var w = findActive(sc, 'Window_ChoiceList');
      if (!P.chSeen) { P.chSeen = now; P.chIdx = rnd(Math.max(1, gm.choices().length)); P.chSel = 0; }
      if (w && !P.chSel) { w.select(P.chIdx); P.chSel = now; return; }
      if (P.chSel && now - P.chSel > 300 && now - P.lastPress >= 400) { press('ok'); P.lastPress = now; }
      if ((P.chSel && now - P.chSel > 3000) || (!w && now - P.chSeen > 5000)) { // window ignores us: answer directly
        gm.onChoice(P.chIdx); gm.clear(); P.chSeen = 0; P.chSel = 0;
      }
      return;
    }
    P.chSeen = 0; P.chSel = 0;
    if (now - P.lastPress < 400) return;
    P.lastPress = now;
    if (gm.isItemChoice() && now - P.msgSince > 3000) press((((now - P.msgSince) / 1000) | 0) % 2 ? 'cancel' : 'ok');
    else press('ok');
  }

  function battleStep(now, sc) {
    S.step = 'battle t' + P.battleTroop;
    if (!P.battleSince) P.battleSince = now;
    if ($gameMessage.isBusy()) { msgStep(now, sc); }
    var dur = now - P.battleSince, lim = P.troopRun ? (S.opts.battleSec || 20) * 1000 : 90000;
    if (dur > lim + 30000) { ev('stuck', 'battle ' + Math.round(dur / 1000) + 's, leaving'); P.battleSince = 0; try { SceneManager.goto(Scene_Map); } catch (e) { /* ignore */ } return; }
    if (dur > lim + 15000) { if (!P.bAbort) { P.bAbort = 1; ev('stuck', 'battle forced abort'); try { BattleManager.processAbort(); } catch (e) { logError('abort ' + e); } } return; }
    if (dur > lim) { if (!P.bWin) { P.bWin = 1; ev('stuck', 'battle forced victory'); try { BattleManager.processVictory(); } catch (e) { logError('victory ' + e); } } return; }
    P.bWin = 0; P.bAbort = 0;
    if (!$gameMessage.isBusy() && now - P.lastPress >= 400) { press('ok'); P.lastPress = now; }
  }

  var MENU_SCENES = ['Scene_Menu', 'Scene_Item', 'Scene_Skill', 'Scene_Equip', 'Scene_Status'];
  function startMenu() { P.menu = { i: 0, state: 'push', t: 0, cancelAt: 0, name: '' }; P.lastMenu = NOW(); S.n.menus++; }
  function menuStep(now, sc) { // returns true while it owns this tick
    var m = P.menu;
    while (m.i < MENU_SCENES.length && !G[MENU_SCENES[m.i]]) m.i++;
    if (m.i >= MENU_SCENES.length) { P.menu = null; return false; }
    if (m.state === 'push') {
      if (!mapFree()) return false;
      m.name = MENU_SCENES[m.i]; m.state = 'in'; m.t = now; m.cancelAt = 0; P.target = null;
      S.step = 'menu ' + m.name;
      try { SceneManager.push(G[m.name]); } catch (e) { logError('menu push ' + e); m.i++; m.state = 'push'; }
      return true;
    }
    S.step = 'menu ' + m.name;
    if (isMap(sc) && now - m.t > 800) { m.i++; m.state = 'push'; return true; } // back on the map
    var t = now - m.t;
    if (t > 1800 && now - m.cancelAt > 900) { press('cancel'); m.cancelAt = now; }
    if (t > 8000) { ev('stuck', 'menu ' + m.name + ' did not close, leaving'); safePop(); m.t = now; }
    return true;
  }

  // ---- map walking
  function failTarget(t) { if (t.key) P.fail[t.key] = (P.fail[t.key] || 0) + 1; }
  function pickTarget(now) {
    var mapId = curMapId(), randomOnly = now < P.randomUntil;
    if (!randomOnly && Math.random() < 0.75) {
      var c = [], evs = $gameMap.events();
      for (var i = 0; i < evs.length; i++) {
        try {
          var e = evs[i];
          if (e._erased || e._pageIndex < 0 || !e.event()) continue;
          if (e._trigger !== 0 && e._trigger !== 1) continue; // action button / player touch
          var key = mapId + ':' + e.eventId() + ':' + e._pageIndex;
          if ((P.fail[key] || 0) >= 2) continue;
          var list = e.list() || [], s = P.visited[key] ? -3 : 4;
          if (e._characterName || e._tileId > 0) s += 2;
          if (list.some(function (cm) { return cm.code === 201; })) s += 3;
          c.push({ e: e, key: key, s: s });
        } catch (x) { /* skip event */ }
      }
      c.sort(function (a, b) { return b.s - a.s; });
      if (c.length && (c[0].s > 0 || Math.random() < 0.1)) {
        var top = c.filter(function (q) { return q.s >= c[0].s - 1; }).slice(0, 3), q = top[rnd(top.length)];
        return { x: q.e.x, y: q.e.y, ev: q.e, key: q.key, since: now, pressN: 0, lastPress: 0 };
      }
    }
    var W = $gameMap.width(), H = $gameMap.height(), px = $gamePlayer.x, py = $gamePlayer.y;
    for (var n = 0; n < 60; n++) {
      var far = randomOnly ? 6 : 3, r = randomOnly ? 25 : 14;
      var x = Math.max(0, Math.min(W - 1, px + rnd(2 * r + 1) - r)), y = Math.max(0, Math.min(H - 1, py + rnd(2 * r + 1) - r));
      if (Math.abs(x - px) + Math.abs(y - py) >= far && canStand(x, y)) return { x: x, y: y, ev: null, key: '', since: now };
    }
    return null;
  }
  function interact(t, now) {
    if (now - t.lastPress < 1200) return;
    var dx = t.x - $gamePlayer.x, dy = t.y - $gamePlayer.y;
    if (dx || dy) $gamePlayer.setDirection(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 6 : 4) : (dy > 0 ? 2 : 8));
    press('ok'); t.lastPress = now; t.pressN++;
    P.visited[t.key] = 1;
    if (t.pressN >= 2) { P.target = null; }
  }
  function walkStep(now) {
    var t = P.target;
    if (t && now - t.since > (t.ev ? 8000 : (now < P.randomUntil ? 3000 : 8000))) { failTarget(t); P.target = t = null; }
    if (!t) { t = P.target = pickTarget(now); if (!t) { S.step = 'walk (no target)'; return; } }
    if (t.ev && (t.ev._erased || t.ev._pageIndex < 0)) { P.target = null; return; }
    var dist = Math.abs($gamePlayer.x - t.x) + Math.abs($gamePlayer.y - t.y);
    S.step = 'walk ' + (t.ev ? 'ev' + t.ev.eventId() : 'tile') + ' ' + t.x + ',' + t.y;
    if (!$gamePlayer.isMoving()) {
      if (t.ev && dist <= 1) { interact(t, now); return; }
      if (!t.ev && dist === 0) { P.target = null; return; }
      if (!$gameTemp.isDestinationValid()) $gameTemp.setDestination(t.x, t.y);
    }
  }

  // Some plugins put real HTML controls over the canvas (e.g. a name-entry <input> with a 決定
  // button) and wait for them; RPG Maker's Input state does not reach those. Click a visible
  // button / submit, else send Enter to a visible text input. Logged once per 10 s at most.
  function domForm(now) {
    try {
      var vis = function (el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
      var btn = Array.prototype.filter.call(document.querySelectorAll('button, input[type=submit], input[type=button]'), vis)
        .filter(function (el) { return !el.closest || !el.closest('#pmzMenu'); })[0];
      var inp = Array.prototype.filter.call(document.querySelectorAll('input[type=text], input:not([type]), textarea'), vis)[0];
      if (!btn && !inp) return false;
      if (inp && !inp.value) { inp.value = 'Test'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
      if (btn) btn.click();
      else {
        inp.focus();
        ['keydown', 'keypress', 'keyup'].forEach(function (type) {
          inp.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        });
      }
      if (!P.lastDomLog || now - P.lastDomLog > 10000) { P.lastDomLog = now; ev('dom', (btn ? 'clicked ' + (btn.textContent || btn.value || 'button') : 'enter in input')); }
      return true;
    } catch (e) { return false; }
  }

  function mapStep(now, sc) {
    var id = curMapId();
    if (id !== P.mapId) { P.mapId = id; P.mapSince = now; P.target = null; progress(); }
    if (!inGame()) return;
    if ($gamePlayer.isTransferring()) { S.step = 'transfer'; return; }
    if (sc.isBusy && sc.isBusy()) { S.step = 'map busy'; return; }
    if (S.mode === 'tour' && P.tour && tourStep(now)) return;
    if ($gameMessage.isBusy()) { msgStep(now, sc); return; }
    if ($gameMap.isEventRunning()) {
      S.step = 'event running';
      if (now - P.evSince > 1500 && now - P.lastPress >= 600) {   // plugin events waiting for a key
        P.lastPress = now;
        if (now - P.evSince > 4000 && domForm(now)) return;         // HTML input form (name entry plugins)
        press('ok');
      }
      return;
    }
    if (!$gamePlayer.canMove()) { S.step = 'player busy'; return; }
    if (S.mode === 'play' && now - P.lastMenu > 90000) { startMenu(); return; }
    walkStep(now);
  }

  // ---- tour mode
  function startTour() {
    var o = S.opts, maps = mapIds(), troops = [], lim = o.limit || 0;
    if (o.shuffle) maps.sort(function () { return Math.random() - 0.5; });
    if (lim) maps = maps.slice(0, lim);
    try { for (var i = 1; i < $dataTroops.length; i++) if ($dataTroops[i] && $dataTroops[i].members && $dataTroops[i].members.length) troops.push(i); } catch (e) { /* ignore */ }
    if (o.shuffle) troops.sort(function () { return Math.random() - 0.5; });
    var tl = o.troopLimit !== undefined ? o.troopLimit : lim;
    if (tl) troops = troops.slice(0, tl);
    P.tour = { maps: maps, troops: troops, mi: 0, ti: 0, stage: 'maps', state: 'tp', t: 0, menuStarted: false };
    ev('tour', 'maps=' + maps.length + ' troops=' + troops.length);
  }
  function tourStep(now) { // true = consumed this tick
    var T = P.tour, free = mapFree();
    if (T.stage === 'maps') {
      if (T.mi >= T.maps.length) { T.stage = 'troops'; T.state = 'go'; return false; }
      var cur = T.maps[T.mi];
      if (T.state === 'tp') {
        if (!free && now - T.t < 10000) return false;
        teleport(cur, 'tour ' + (T.mi + 1) + '/' + T.maps.length); T.state = 'wait'; T.t = now; return true;
      }
      if (T.state === 'wait') { T.state = 'play'; T.t = now; return false; }
      S.step = 'tour map ' + cur + ' ' + mapName(cur);
      var el2 = now - T.t, sec = (S.opts.secPerMap || 20) * 1000;
      if ((el2 > sec && free) || el2 > sec * 3) { T.mi++; T.state = 'tp'; T.t = now; return true; }
      return false;
    }
    if (T.stage === 'troops') {
      if (T.ti >= T.troops.length) { T.stage = 'menus'; return false; }
      if (T.state === 'fight') { T.ti++; T.state = 'go'; P.troopRun = false; return false; } // back on the map: battle is over
      if (!free) return false;
      var tid = T.troops[T.ti];
      try {
        BattleManager.setup(tid, true, true);
        if (BattleManager.saveBgmAndBgs) BattleManager.saveBgmAndBgs();
        P.troopRun = true; P.battleSince = 0; P.bWin = 0; P.bAbort = 0;
        SceneManager.push(Scene_Battle);
      } catch (e) { logError('troop ' + tid + ' ' + e); T.ti++; return true; }
      T.state = 'fight'; T.t = now; S.step = 'tour troop ' + tid;
      return true;
    }
    if (T.stage === 'menus') {
      if (!T.menuStarted) { T.menuStarted = true; startMenu(); return true; }
      if (!P.menu) { T.stage = 'done'; finish('done'); }
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- public API
  function statusStr() {
    var sc = G.SceneManager && SceneManager._scene, now = NOW();
    var pairs = [
      ['ph', S.phase], ['step', S.step], ['sc', sceneName(sc)], ['map', curMapId()], ['fr', S.fr], ['fps', S.fps],
      ['gap', S.gap], ['heap', S.heap], ['img', S.img], ['last', Math.round(now - S.lastProgress)], ['t', S.running ? Math.round(now - S.t0) : 0],
      ['maps', S.n.maps], ['battles', S.n.battles], ['scenes', S.n.scenes], ['errs', S.n.errors], ['tp', S.n.teleports], ['stuck', S.n.stuck]
    ];
    return pairs.map(function (p) { return p[0] + '=' + san(p[1]); }).join(';');
  }
  function drainStr() { var q = S.q; S.q = []; return q.join('^'); }
  function top(arr, key, n) { return arr.slice().sort(function (a, b) { return b[key] - a[key]; }).slice(0, n); }

  G.PMZ_AT = {
    canvases: function () { return canvasTable(); },
    _installed: true,
    start: function (opts) {
      try {
        if (S.running) return 'already running';
        S.opts = opts || {}; S.mode = S.opts.mode === 'tour' ? 'tour' : 'play';
        S.phase = 'init'; S.step = 'wait title'; S.running = true; S.crashed = false; S.t0 = NOW(); progress();
        ev('phase', 'init mode=' + S.mode + ' engine=' + (G.Utils ? Utils.RPGMAKER_NAME + ' ' + Utils.RPGMAKER_VERSION : '?'));
        return 'started ' + S.mode;
      } catch (e) { return 'error ' + san(e); }
    },
    stop: function () { try { if (S.running) finish('stopped'); return 'stopped'; } catch (e) { return 'error'; } },
    status: statusStr,
    drain: drainStr,
    poll: function () { return statusStr() + '@@' + drainStr(); },
    errors: function () { // "count message" per distinct error, most frequent first, joined by ^
      try {
        return Object.keys(S.errs).sort(function (x, y) { return S.errs[y] - S.errs[x]; }).slice(0, 40)
          .map(function (k) { return S.errs[k] + ' ' + k; }).join('^');
      } catch (e) { return ''; }
    },
    blocked: function () { return BLOCKED.join(','); },
    report: function () {
      try {
        var errs = Object.keys(S.errs).map(function (k) { return { msg: k, n: S.errs[k] }; });
        return JSON.stringify({
          phase: S.phase, mode: S.mode, engine: G.Utils ? Utils.RPGMAKER_NAME + ' ' + Utils.RPGMAKER_VERSION : '',
          game: G.$dataSystem ? $dataSystem.gameTitle : '', seconds: Math.round((NOW() - S.t0) / 1000),
          counters: S.n, mapsVisited: Object.keys(S.maps), peakHeapMB: S.peakHeap, peakImgMpx: Math.round(S.peakImgMpx * 10) / 10,
          slowMaps: top(S.mapLoads, 'ms', 10), slowScenes: top(S.sceneMs, 'ms', 10), errors: errs, droppedEvents: S.dropped
        });
      } catch (e) { return 'error ' + san(e); }
    }
  };

  try { installHooks(); } catch (e) { ev('error', 'install ' + e); }
  setInterval(statsTick, 2000);
  ev('install', 'engine=' + (G.Utils ? Utils.RPGMAKER_NAME : '?') + ' blocked=' + BLOCKED.length);
})();
