/*:
 * @target MZ
 * @plugindesc PocketMZ dev probe (remove for release).
 * @author PocketMZ (MIT)
 *
 * @help
 * - Every 10 s writes <game>/debug.json (scene, layout, FPS, JS heap, GL renderer).
 * - Dev REPL on 127.0.0.1:9333: POST JavaScript, get the JSON result back.
 *     curl -s --data-binary 'SceneManager._scene.constructor.name' 127.0.0.1:9333
 * - Collects uncaught errors and failed resource loads into PMZ_DEBUG.errors.
 */
(() => {
    "use strict";
    const fs = require("fs"), path = require("path"), http = require("http");
    const base = path.dirname(process.mainModule.filename);
    const out = path.join(base, "debug.json");
    const D = window.PMZ_DEBUG = { errors: [], loads: 0, started: Date.now() };
    // Timeline in kernel uptime seconds (same clock as pocketmz-run.sh's log)
    const up = () => { try { return Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]); } catch (e) { return 0; } };
    D.timeline = { pluginsLoaded: up() };
    const mark = (cls, key) => {
        const _start = cls.prototype.start;
        cls.prototype.start = function() { if (!D.timeline[key]) D.timeline[key] = up(); _start.apply(this, arguments); };
    };
    mark(Scene_Boot, "bootStart"); mark(Scene_Title, "titleStart"); mark(Scene_Map, "firstMapStart");
    // Boot phase detail: every data file / font / image loaded before the title, and when each
    // part of Scene_Boot.isReady() first became true. Read: PMZ_DEBUG.boot
    const B = D.boot = { loads: [], ready: {}, steps: {} };
    const t0 = performance.now(), ms = () => Math.round(performance.now() - t0);
    const step = k => { if (B.steps[k] === undefined) B.steps[k] = ms(); };
    window.addEventListener("load", () => step("windowLoad"));
    try {
        const M = typeof main !== "undefined" ? main : null;   // main.js: const main = new Main()
        if (M) for (const k of ["onWindowLoad", "initEffekseerRuntime", "onEffekseerLoad"]) {
            const f = M[k]; if (typeof f === "function") M[k] = function() { step(k); return f.apply(this, arguments); };
        }
        for (const [o, k, n] of [[SceneManager, "initialize", "smInit"], [SceneManager, "initGraphics", "graphics"],
                                 [SceneManager, "initAudio", "audio"], [SceneManager, "initVideo", "video"], [SceneManager, "initInput", "input"],
                                 [Scene_Boot.prototype, "create", "bootCreate"],
                                 ...["_createAllElements", "_createPixiApp", "_createEffekseerContext", "_setupPixi", "_createCanvas",
                                     "_createLoadingSpinner", "_createFPSCounter", "_updateAllElements"].map(k => [Graphics, k, "G" + k])]) {
            const f = o[k]; if (typeof f === "function") o[k] = function() { step(n); const r = f.apply(this, arguments); step(n + "Done"); return r; };
        }
    } catch (e) { B.stepErr = String(e); }
    const booting = () => !D.timeline.titleStart;
    const onXhr = DataManager.onXhrLoad;
    if (onXhr) {
        const _load = DataManager.loadDataFile;
        DataManager.loadDataFile = function(name, src) { if (booting()) B.loads.push({ f: src, start: ms() }); return _load.apply(this, arguments); };
        DataManager.onXhrLoad = function(xhr, name, src) {
            const e = B.loads.find(l => l.f === src && l.end === undefined); const a = performance.now();
            const r = onXhr.apply(this, arguments);
            if (e) { e.end = ms(); e.parse = Math.round(performance.now() - a); e.kb = Math.round((xhr.responseText || "").length / 1024); }
            return r;
        };
    }
    if (window.FontManager && FontManager.load) {   // MZ only
        const _font = FontManager.load;
        FontManager.load = function(family, file) { if (booting()) B.loads.push({ f: "font " + file, start: ms() }); return _font.apply(this, arguments); };
    }
    const _img = ImageManager.loadBitmapFromUrl;
    ImageManager.loadBitmapFromUrl = function(url) {
        const b = _img.apply(this, arguments);
        if (booting() && !b.isReady()) { const e = { f: decodeURIComponent(url), start: ms() }; B.loads.push(e); b.addLoadListener(() => { e.end = ms(); }); }
        return b;
    };
    const _ready = Scene_Boot.prototype.isReady;
    Scene_Boot.prototype.isReady = function() {
        const r = _ready.apply(this, arguments);
        const chk = { db: () => DataManager.isDatabaseLoaded(), fonts: () => !window.FontManager || FontManager.isReady(), images: () => ImageManager.isReady(),
                      player: () => !this.isPlayerDataLoaded || this.isPlayerDataLoaded(), all: () => r };
        for (const k in chk) { try { if (B.ready[k] === undefined && chk[k]()) B.ready[k] = ms(); } catch (e) {} }
        return r;
    };
    const note = (s) => { D.errors.push(Date.now() - D.started + "ms " + s); if (D.errors.length > 50) D.errors.shift(); };
    window.addEventListener("error", e => note("error: " + (e.message || (e.target && (e.target.src || e.target.href)) || e)), true);
    window.addEventListener("unhandledrejection", e => note("reject: " + (e.reason && (e.reason.stack || e.reason))));

    function info() {
        const c = (window.Graphics && Graphics._canvas) || document.querySelector("canvas");
        const r = c ? c.getBoundingClientRect() : null;
        let gl = null;
        try {
            const g = Graphics.app && Graphics.app.renderer && Graphics.app.renderer.gl;
            if (g) { const e = g.getExtension("WEBGL_debug_renderer_info");
                     gl = e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); }
        } catch (e) { gl = String(e); }
        const scene = window.SceneManager && SceneManager._scene;
        return {
            t: Date.now(), up: Math.round((Date.now() - D.started) / 1000),
            scene: scene && scene.constructor.name, map: window.$gameMap && $gameMap.mapId(),
            evRunning: window.$gameMap && $gameMap.isEventRunning && $gameMap.isEventRunning(),
            inner: [innerWidth, innerHeight], canvas: c && [c.width, c.height], rect: r && [r.x, r.y, r.width, r.height].map(Math.round),
            fps: window.Graphics && (Graphics._fpsCounter ? Math.round(Graphics._fpsCounter.fps) : Graphics._fpsMeter ? Math.round(Graphics._fpsMeter.fps) : 0),   // MZ / MV
            heapMB: performance.memory && Math.round(performance.memory.usedJSHeapSize / 1048576),
            imgCache: window.ImageManager && (ImageManager._cache ? Object.keys(ImageManager._cache).length
                : ImageManager._imageCache && ImageManager._imageCache._items ? Object.keys(ImageManager._imageCache._items).length : 0),   // MZ / MV 1.6
            fonts: [...document.fonts].map(f => f.family + ":" + f.status),
            gl, timeline: D.timeline, errors: D.errors.slice(-10)
        };
    }
    D.info = info;
    setInterval(() => { try { fs.writeFileSync(out, JSON.stringify(info(), null, 1)); } catch (e) {} }, 10000);

    const srv = http.createServer((req, res) => {
        let body = "";
        req.on("data", d => body += d);
        req.on("end", async () => {
            let result;
            try { result = await (0, eval)(body || "PMZ_DEBUG.info()"); }
            catch (e) { result = { exception: String(e && e.stack || e) }; }
            let text;
            try { text = JSON.stringify(result, null, 1); } catch (e) { text = String(result); }
            res.end((text === undefined ? "undefined" : text) + "\n");
        });
    });
    srv.on("error", e => note("repl: " + e));
    srv.listen(9333, "127.0.0.1");
})();
