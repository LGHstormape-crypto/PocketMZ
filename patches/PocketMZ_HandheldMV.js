/*:
 * @target MV
 * @plugindesc PocketMZ handheld (RPG Maker MV): gamepad via gptokeyb, light audio, 30/60 fps option, off-screen sprites (load last).
 * @author PocketMZ (MIT)
 *
 * @help
 * MV counterpart of PocketMZ_Handheld.js (that one is MZ only). Written against the MV 1.6 core
 * scripts (rpgtkoolmv/corescript); every part checks that what it changes exists.
 * - Gamepad: gptokeyb turns the pad into keys; the browser Gamepad API is ignored (no double input).
 * - Audio: AudioContext at 24 kHz, "playback" latency (less CPU and decoded-PCM memory).
 * - Options: frame rate 30 / 60 (default 30). At 30 only every other frame is drawn; game logic
 *   stays at 60, so the game runs at full speed.
 * - Off-screen event sprites are not drawn; their animation is updated every 15th frame.
 * MV's own image cache (ImageCache.limit, 10 Mpx) and texture GC are kept as they are.
 */
(() => {
    "use strict";
    if (!window.Utils || Utils.RPGMAKER_NAME !== "MV") return;

    const AUDIO_SAMPLE_RATE = 24000;

    // 0. No page scrollbars (elements sized for a PC window can overflow the 640x480 screen)
    const noScroll = () => {
        for (const el of [document.documentElement, document.body]) if (el) el.style.overflow = "hidden";
    };
    noScroll();
    window.addEventListener("load", noScroll);
    // The game window is fullscreen. Plugins that fit a PC window to the game size
    // (YEP_CoreEngine: window.moveBy + window.resizeBy at start) would take it out of
    // fullscreen under sway and leave it tiled next to ES at half the screen.
    for (const k of ["resizeBy", "resizeTo", "moveBy", "moveTo"]) {
        try { window[k] = function() {}; } catch (e) {}
    }
    // Always fit the game to the screen: the engines stretch only under NW.js or on phones, so in
    // a plain browser (WPE WebKit) the canvas stayed at game size, cropped, and render scale was 1.
    if (window.Graphics) {
        Graphics._defaultStretchMode = function() { return true; };
        Graphics._stretchEnabled = true;
    }
    // Start sends Escape again (cancel / menu); quitting is F2 + Start (pocketmz-hotkeys.py ->
    // PocketMZ_Menu.js). End stays an alias of Escape for button maps made while Start sent End.
    if (window.Input && Input.keyMapper) Input.keyMapper[35] = "escape";

    // 1. Gamepad
    if (window.Input && Input._updateGamepadState) Input._updateGamepadState = function() {};

    // 2. Audio
    if (window.WebAudio && WebAudio._createContext) {
        WebAudio._createContext = function() {
            try {
                const AC = window.AudioContext || window.webkitAudioContext;
                this._context = new AC({ sampleRate: AUDIO_SAMPLE_RATE, latencyHint: "playback" });
            } catch (e) {
                try { this._context = new (window.AudioContext || window.webkitAudioContext)(); }
                catch (e2) { this._context = null; }
            }
        };
    }

    // 3. Frame rate option
    const FPS_KEY = "gkdFrameRate";
    const fpsLabel = () => {
        const loc = String((window.$dataSystem && $dataSystem.locale) || "ja");
        return loc.startsWith("ja") ? "画面フレームレート" : loc.startsWith("zh") ? "画面帧率" : "Frame Rate";
    };
    // default for games whose config has no choice yet: PocketMZ settings (POCKETMZ_DEFAULT_FPS)
    // ES explicit override (POCKETMZ_ES_FPS) forces runtime fps without overwriting saved config.
    const DEFAULT_FPS = window.process && process.env && process.env.POCKETMZ_DEFAULT_FPS === "60" ? 60 : 30;
    const ES_FPS = window.process && process.env && (process.env.POCKETMZ_ES_FPS === "60" ? 60 : process.env.POCKETMZ_ES_FPS === "30" ? 30 : 0);
    ConfigManager[FPS_KEY] = ES_FPS || DEFAULT_FPS;
    const _makeData = ConfigManager.makeData;
    ConfigManager.makeData = function() {
        const config = _makeData.call(this);
        config[FPS_KEY] = (ES_FPS && !this._gkdUserChangedFps && this._gkdSavedFrameRate) ? this._gkdSavedFrameRate : this[FPS_KEY];
        return config;
    };
    const _applyData = ConfigManager.applyData;
    ConfigManager.applyData = function(config) {
        _applyData.call(this, config);
        const savedFps = config[FPS_KEY] === 60 ? 60 : config[FPS_KEY] === 30 ? 30 : DEFAULT_FPS;
        this._gkdSavedFrameRate = savedFps;
        this[FPS_KEY] = ES_FPS || savedFps;
    };
    if (window.Window_Options && Window_Options.prototype.addGeneralOptions) {
        const W = Window_Options.prototype;
        const _add = W.addGeneralOptions;
        W.addGeneralOptions = function() { _add.call(this); this.addCommand(fpsLabel(), FPS_KEY); };
        const _status = W.statusText;
        W.statusText = function(i) { return this.commandSymbol(i) === FPS_KEY ? String(ConfigManager[FPS_KEY]) : _status.call(this, i); };
        const toggle = function() {
            ConfigManager[FPS_KEY] = ConfigManager[FPS_KEY] === 60 ? 30 : 60;
            ConfigManager._gkdUserChangedFps = true;
            ConfigManager._gkdSavedFrameRate = ConfigManager[FPS_KEY];
            this.redrawItem(this.findSymbol(FPS_KEY));
            SoundManager.playCursor();
        };
        for (const k of ["processOk", "cursorRight", "cursorLeft"]) {
            const f = W[k];
            W[k] = function() { if (this.commandSymbol(this.index()) === FPS_KEY) toggle.call(this); else f.apply(this, arguments); };
        }
    }
    // MV draws every requestAnimationFrame (Graphics.render, with its own skipping when slow).
    // At 30: skip by time (not parity), keeping frameCount and the FPS meter consistent.
    if (window.Graphics && Graphics.render) {
        const _render = Graphics.render;
        let last = 0;
        Graphics.render = function(stage) {
            if (ConfigManager[FPS_KEY] !== 60) {
                const now = performance.now();
                if (now - last < 1000 / 30 - 4) { this.frameCount++; this._rendered = false; return; }
                last = now;
            }
            _render.call(this, stage);
        };
    }

    // 4. Off-screen character sprites (same as PocketMZ_Handheld.js section 9)
    const CULL_X = 200, CULL_TOP = 48, CULL_BOTTOM = 400, CULL_REFRESH = 15;
    if (window.Sprite_Character) {
        const _update = Sprite_Character.prototype.update;
        Sprite_Character.prototype.update = function() {
            const c = this._character;
            if (c && c.screenX) {
                const x = c.screenX(), y = c.screenY();
                if (x < -CULL_X || x > Graphics.width + CULL_X || y < -CULL_TOP || y > Graphics.height + CULL_BOTTOM) {
                    if (!this._gkdOff) { this._gkdOff = true; this._gkdSkip = (this.spriteId || 0) % CULL_REFRESH; }
                    if (++this._gkdSkip % CULL_REFRESH === 0) _update.call(this);
                    this.visible = false;
                    return;
                }
                this._gkdOff = false;
            }
            _update.call(this);
        };
    }

    // 5. Render at screen size (same idea as PocketMZ_Handheld.js section 12, for PIXI v4).
    //    MV draws at the game's own size (e.g. 1080x720) and the browser scales the canvas down
    //    to the 640x480 screen. Here the renderer gets resolution = the display scale, so the
    //    WebGL buffer is already screen-sized. Game coordinates are unchanged.
    //    POCKETMZ_RENDER_SCALE (games/<id>/env or the settings): "off" = full size, a number = fixed.
    const RS_ENV = String((window.process && process.env && process.env.POCKETMZ_RENDER_SCALE) || "auto");
    if (RS_ENV !== "off" && RS_ENV !== "1") {
        const fixed = parseFloat(RS_ENV);
        const renderScale = g => {
            const s = isFinite(fixed) ? fixed : g._realScale;
            return Math.min(1, Math.max(0.25, Math.round((s || 1) * 1000) / 1000));
        };
        const webgl = R => R && R.rootRenderTarget && R.gl;
        Graphics._updateRenderer = function() {
            const R = this._renderer;
            if (!R) return;
            if (webgl(R)) {
                const r = renderScale(this);
                if (R.resolution !== r) {
                    R.resolution = r;
                    R.rootRenderTarget.resolution = r;
                    R.rootRenderTarget.size.width = -1;   // RenderTarget.resize skips an unchanged size
                }
            }
            R.resize(this._width, this._height);
        };
        Graphics._updateCanvas = function() {
            const R = this._renderer, r = webgl(R) ? R.resolution : 1;
            this._canvas.width = Math.round(this._width * r);
            this._canvas.height = Math.round(this._height * r);
            this._canvas.style.zIndex = 1;
            this._centerElement(this._canvas);
        };
        const _center = Graphics._centerElement;
        Graphics._centerElement = function(element) {
            _center.call(this, element);
            if (element === this._canvas) {   // element.width is the buffer size; show at game size
                element.style.width = this._width * this._realScale + "px";
                element.style.height = this._height * this._realScale + "px";
            }
        };
        // Filters keep their own resolution (default 1): a filtered container (map tone, picture
        // or plugin filters) would be drawn offscreen at full game size again.
        // (PIXI v4 does not export FilterManager: patch the prototype of the renderer's instance)
        const patchFilters = R => {
            const FM = R && R.filterManager && Object.getPrototypeOf(R.filterManager);
            if (!FM || !FM.pushFilter || FM._pmzPatched) return;
            FM._pmzPatched = true;
            // the pool key of a returned render target is recomputed as size * resolution and
            // truncated; with a resolution like 1/3 (1920x1080 game) 1024 / r * r = 1023.99… ->
            // another key with no pool -> "reading 'push'" crash. Rounded here.
            if (FM.freePotRenderTarget) FM.freePotRenderTarget = function(rt) {
                const w = Math.round(rt.size.width * rt.resolution), h = Math.round(rt.size.height * rt.resolution);
                const key = (w & 0xFFFF) << 16 | h & 0xFFFF;
                (this.pool[key] || (this.pool[key] = [])).push(rt);
            };
            const _push = FM.pushFilter;
            FM.pushFilter = function(target, filters) {
                const r = this.renderer.resolution;
                if (r < 1 && filters) for (let i = 0; i < filters.length; i++) {
                    if (filters[i] && filters[i].resolution > r) filters[i].resolution = r;
                }
                return _push.apply(this, arguments);
            };
        };
        // The window can reach its final (fullscreen) size after the last layout update; MV's
        // scale then changes without the renderer following. Check twice a second.
        const _render = Graphics.render;
        let rsTick = 0;
        Graphics.render = function(stage) {
            if (++rsTick >= 30) {
                rsTick = 0;
                const R = this._renderer;
                if (webgl(R) && this._realScale > 0 && R.resolution !== renderScale(this)) this._updateAllElements();
            }
            return _render.call(this, stage);
        };
        const _updRenderer = Graphics._updateRenderer;
        Graphics._updateRenderer = function() {
            patchFilters(this._renderer);
            _updRenderer.call(this);
        };
    }

    // 6. Large images kept at screen resolution (same idea as PocketMZ_Handheld.js section 17).
    //    MV decodes an image when it is first used (Bitmap#decode) and draws from _image, making a
    //    full-size canvas only when something draws into the bitmap. Large pictures / title
    //    images are drawn into a canvas at the display scale at decode time; the PIXI v4 texture
    //    keeps the game size (width/height) with realWidth/realHeight = the small canvas.
    //    Parallaxes and battlebacks (TilingSprite) are left as they are.
    //    POCKETMZ_IMG_SCALE: "off", or a factor on the display scale.
    //    The downscaled images are also kept in pmz-cache/ next to index.html (see IMG_CACHE below):
    //    the next time the small PNG is requested instead of the original (no full-size decode).
    //    POCKETMZ_IMG_CACHE=off disables that; window.PMZ_IMG.prebuild(dirs, onProgress) fills it.
    const IMG_ENV = String((window.process && process.env && process.env.POCKETMZ_IMG_SCALE) || "auto");
    const IMG_DIRS = /img\/(pictures|titles1|titles2|enemies|sv_enemies|faces)\//;
    const IMG_MIN_PIXELS = 400 * 300;
    if (IMG_ENV !== "off" && RS_ENV !== "off" && window.Bitmap && Bitmap.prototype.decode && window.PIXI) {
        const factor = isFinite(parseFloat(IMG_ENV)) ? parseFloat(IMG_ENV) : 1;
        const imgScale = () => Math.round(Math.min(1, (Graphics._realScale || 1) * factor) * 1000) / 1000;
        const PMZ_IMG = window.PMZ_IMG = { count: 0, saved: 0, upscaled: 0, cacheHits: 0, cacheSaved: 0, cacheBytes: 0, cacheOff: "" };
        const B = Bitmap.prototype;
        const small = b => b._pmzScale && !b.__canvas && b._image;
        // engine side of the cache: which file is read for a url, how a bitmap is loaded / released
        // (an encrypted image is img/..../name.rpgmvp: Decrypter.extToEncryptExt)
        const ENG = {
            isEnc: url => !!(window.Decrypter && Decrypter.hasEncryptedImages && !Decrypter.checkImgIgnore(url)),
            encFile: full => Decrypter.extToEncryptExt(full),
            encExt: ".rpgmvp",
            defaultDirs: ["pictures", "titles1", "titles2", "enemies", "sv_enemies", "faces"],
            load: (dir, base) => Bitmap.load("img/" + dir + "/" + base + ".png"),
            release: b => {
                try {
                    if (b.__baseTexture) { b.__baseTexture.destroy(); b.__baseTexture = null; }
                    const im = b._image;
                    if (im && im.tagName === "CANVAS") im.width = im.height = 0;
                    b._image = null;
                    if (b.__canvas) { b.__canvas.width = b.__canvas.height = 0; b.__canvas = null; b.__context = null; }
                } catch (e) { /* gone anyway */ }
            }
        };
        // Persistent cache of the downscaled images: <page dir>/pmz-cache/<url path>.pmz-<W>x<H>-<w>x<h>-<size>-<mtime>.png
        // (page dir = folder of index.html; W x H original, w x h cached, size / mtime of the source file).
        // A changed source or display scale gives another name, so stale files are just not used.
        // Nothing is ever written outside pmz-cache, and only after IMG_CACHE.prepare() has checked that
        // pmz-cache is a real directory inside the thin copy (the asset folders there link to the original game).
        // POCKETMZ_IMG_CACHE=off disables reading and writing.
        const IMG_CACHE = (() => {
            const C = { fs: null, path: null, pageDir: "", root: "", read: false, write: false, ready: false, checked: false,
                        dirs: new Map(), stats: new Map(), bad: new Set(), queued: new Set(), queue: [], busy: false,
                        // no-op defaults: the cache is off (POCKETMZ_IMG_CACHE=off, or no Node fs in a plain browser)
                        prepare: () => false, lookup: () => null, save: () => {}, idle: () => Promise.resolve(),
                        dims: () => { throw new Error("no image cache"); } };
            const off = why => { C.write = false; C.queue.length = 0; if (!PMZ_IMG.cacheOff) PMZ_IMG.cacheOff = why; };
            try {
                if (String((window.process && process.env && process.env.POCKETMZ_IMG_CACHE) || "on").toLowerCase() === "off") {
                    PMZ_IMG.cacheOff = "POCKETMZ_IMG_CACHE=off";
                    return C;
                }
                C.fs = require("fs"); C.path = require("path");
                C.pageDir = C.path.dirname(process.mainModule.filename);
                C.root = C.path.join(C.pageDir, "pmz-cache");
                C.read = C.write = true;
            } catch (e) { PMZ_IMG.cacheOff = "no node fs: " + (e && e.message); return C; }

            const inside = (p, base) => p.startsWith(base + C.path.sep);
            const srcFile = full => ENG.isEnc(full) ? ENG.encFile(full) : full;
            const relOf = url => {
                let p;
                try { p = decodeURIComponent(String(url)); } catch (e) { return null; }
                if (!/^img\/[^?#\\:]+\.png$/i.test(p)) return null;
                const segs = p.split("/");
                if (segs.some(sg => !sg || sg === "." || sg === "..")) return null;
                return { full: p, dir: segs.slice(0, -1).join("/"), file: segs[segs.length - 1] };
            };
            const srcStat = rel => {
                if (C.stats.has(rel.full)) return C.stats.get(rel.full);
                let r = null;
                try {
                    const st = C.fs.statSync(C.path.join(C.pageDir, srcFile(rel.full)));
                    if (st.isFile()) r = { size: st.size, mtime: Math.round(st.mtimeMs) };
                } catch (e) { /* source missing */ }
                C.stats.set(rel.full, r);
                return r;
            };
            const listing = dir => {
                let l = C.dirs.get(dir);
                if (!l) {
                    try { l = C.fs.readdirSync(C.path.join(C.root, dir)); } catch (e) { l = []; }
                    C.dirs.set(dir, l);
                }
                return l;
            };

            // The write checks (once, before the first write): the page dir is not a symlink and lies
            // inside the thin copy root (nw.__dirname), pmz-cache is a real directory made directly in
            // it and its real path stays inside the page dir.
            C.prepare = () => {
                if (C.ready) return true;
                if (!C.write || C.checked) return false;
                C.checked = true;
                try {
                    const fs = C.fs;
                    if (fs.lstatSync(C.pageDir).isSymbolicLink()) throw new Error("page dir is a symlink");
                    const pageReal = fs.realpathSync(C.pageDir);
                    if (typeof nw === "undefined" || !nw.__dirname) throw new Error("no nw.__dirname");
                    const nwReal = fs.realpathSync(nw.__dirname);
                    if (pageReal !== nwReal && !inside(pageReal, nwReal)) throw new Error("page dir is outside the app dir");
                    let st = null;
                    try { st = fs.lstatSync(C.root); } catch (e) { /* not there yet */ }
                    if (!st) fs.mkdirSync(C.root);
                    else if (!st.isDirectory()) throw new Error("pmz-cache is not a real directory");
                    if (!inside(fs.realpathSync(C.root), pageReal)) throw new Error("pmz-cache resolves outside the page dir");
                    C.ready = true;
                } catch (e) { off("write disabled: " + (e && e.message)); }
                return C.ready;
            };
            // sub folders of pmz-cache, one level at a time, never through a symlink
            const ensureDir = relDir => {
                let cur = C.root;
                for (const seg of relDir.split("/")) {
                    cur = C.path.join(cur, seg);
                    let st = null;
                    try { st = C.fs.lstatSync(cur); } catch (e) { /* new */ }
                    if (!st) C.fs.mkdirSync(cur);
                    else if (!st.isDirectory()) throw new Error("not a real directory: " + seg);
                }
                if (!inside(C.fs.realpathSync(cur), C.fs.realpathSync(C.root))) throw new Error("outside pmz-cache");
                return cur;
            };

            // cache entry for this url at the current display scale, or null
            C.lookup = url => {
                try {
                    if (!C.read || window.PMZ_IMG_OFF || C.bad.has(url)) return null;
                    const s = imgScale();
                    if (s > 0.9) return null;
                    const rel = relOf(url);
                    const src = rel && srcStat(rel);
                    if (!src) return null;
                    const prefix = rel.file + ".pmz-";
                    for (const n of listing(rel.dir)) {
                        if (!n.startsWith(prefix)) continue;
                        const m = /^(\d+)x(\d+)-(\d+)x(\d+)-(\d+)-(\d+)\.png$/.exec(n.slice(prefix.length));
                        if (!m || +m[5] !== src.size || +m[6] !== src.mtime) continue;
                        const W = +m[1], H = +m[2], sw = +m[3], sh = +m[4];
                        if (W * H < IMG_MIN_PIXELS || sw !== Math.max(1, Math.round(W * s)) || sh !== Math.max(1, Math.round(H * s))) continue;
                        return { W, H, sw, sh, src: ["pmz-cache"].concat(rel.dir.split("/"), [n]).map(encodeURIComponent).join("/") };
                    }
                } catch (e) { /* no cache */ }
                return null;
            };

            // save queue: one file at a time, started from setTimeout
            const fail = (e, tmp) => {
                off("write failed: " + (e && e.message));
                try { C.fs.unlinkSync(tmp); } catch (e2) { /* nothing to remove */ }
            };
            const run = job => {
                const done = () => { C.queued.delete(job.key); C.busy = false; pump(); };
                try {
                    const cv = job.canvas;
                    if (!C.prepare() || cv.width !== job.sw || cv.height !== job.sh) return done();   // canvas released meanwhile
                    cv.toBlob(blob => {
                        if (!blob) return done();
                        blob.arrayBuffer().then(ab => {
                            const buf = Buffer.from(ab);
                            const fin = C.path.join(ensureDir(job.rel.dir), job.name), tmp = fin + ".tmp";
                            if (C.fs.existsSync(fin)) return done();
                            C.fs.writeFile(tmp, buf, e1 => {
                                if (e1) { fail(e1, tmp); return done(); }
                                C.fs.rename(tmp, fin, e2 => {
                                    if (e2) fail(e2, tmp);
                                    else {
                                        PMZ_IMG.cacheSaved++; PMZ_IMG.cacheBytes += buf.length;
                                        listing(job.rel.dir).push(job.name);
                                    }
                                    done();
                                });
                            });
                        }).catch(e => { off("write failed: " + (e && e.message)); done(); });
                    }, "image/png");
                } catch (e) { off("write failed: " + (e && e.message)); done(); }
            };
            const pump = () => {
                if (C.busy || !C.queue.length) return;
                C.busy = true;
                setTimeout(() => run(C.queue.shift()), 100);
            };
            // queue the freshly made small canvas of this url (w x h = original size)
            C.save = (url, w, h, canvas) => {
                try {
                    if (!C.write || window.PMZ_IMG_OFF) return;
                    const rel = relOf(url);
                    const src = rel && srcStat(rel);
                    if (!src) return;
                    const name = `${rel.file}.pmz-${w}x${h}-${canvas.width}x${canvas.height}-${src.size}-${src.mtime}.png`;
                    const key = rel.dir + "/" + name;
                    if (C.queued.has(key) || listing(rel.dir).includes(name)) return;
                    C.queued.add(key);
                    C.queue.push({ rel, name, key, canvas, sw: canvas.width, sh: canvas.height });
                    pump();
                } catch (e) { off("write failed: " + (e && e.message)); }
            };
            C.idle = () => new Promise(res => { const t = () => (C.busy || C.queue.length) ? setTimeout(t, 50) : res(); t(); });
            // size of a source image from its PNG header (the 16 byte header and the encrypted first
            // 16 bytes come before IHDR width / height), without decoding anything
            C.dims = url => {
                const rel = relOf(url);
                if (!rel) return null;
                const enc = ENG.isEnc(rel.full);
                const fd = C.fs.openSync(C.path.join(C.pageDir, srcFile(rel.full)), "r");
                try {
                    const b = Buffer.alloc(40), o = enc ? 32 : 16;
                    if (C.fs.readSync(fd, b, 0, 40, 0) < o + 8) return null;
                    const w = b.readUInt32BE(o), h = b.readUInt32BE(o + 4);
                    return w > 0 && h > 0 && w < 65536 && h < 65536 ? { w, h } : null;
                } finally { C.fs.closeSync(fd); }
            };
            return C;
        })();

        // One-time "precompile": load every large image of these img folders, one at a time, and let
        // the normal path write the cache files. Resolves {total, built, skipped, failed, error}.
        PMZ_IMG.prebuild = (dirs, onProgress) => new Promise(resolve => {
            const res = { total: 0, built: 0, skipped: 0, failed: 0, error: "" };
            const list = [];
            let i = 0;
            const report = file => {
                try { if (onProgress) onProgress({ done: i, total: res.total, file, built: res.built, skipped: res.skipped, failed: res.failed }); }
                catch (e) { /* the caller's problem */ }
            };
            const finish = err => { if (err) res.error = err; resolve(res); };
            try {
                if (!IMG_CACHE.read || window.PMZ_IMG_OFF) return finish(PMZ_IMG.cacheOff || "image scaling is off");
                if (imgScale() > 0.9) return finish("display scale too large to need a cache");
                if (!IMG_CACHE.prepare()) return finish(PMZ_IMG.cacheOff || "cache is not writable");
                for (let d of (dirs && dirs.length ? dirs : ENG.defaultDirs)) {
                    d = String(d).replace(/^img\//, "").replace(/\/+$/, "");
                    if (!/^[\w-]+$/.test(d)) continue;
                    let names = [];
                    try { names = IMG_CACHE.fs.readdirSync(IMG_CACHE.path.join(IMG_CACHE.pageDir, "img", d)); } catch (e) { continue; }
                    for (const n of names.sort()) {
                        const ext = ENG.isEnc("img/" + d + "/" + n.replace(/\.[^.]*$/, ".png")) ? ENG.encExt : ".png";
                        if (!n.toLowerCase().endsWith(ext.toLowerCase())) continue;
                        list.push({ dir: d, base: n.slice(0, n.length - ext.length) });
                    }
                }
            } catch (e) { return finish("prebuild: " + (e && e.message)); }
            res.total = list.length;
            const step = it => new Promise(done => {
                try {
                    const url = "img/" + it.dir + "/" + it.base + ".png";
                    let d = null;
                    try { d = IMG_CACHE.dims(url); } catch (e) { /* unknown: try loading it */ }
                    if (IMG_CACHE.lookup(url) || (d && d.w * d.h < IMG_MIN_PIXELS)) { res.skipped++; return done(); }
                    const saved0 = PMZ_IMG.cacheSaved, bmp = ENG.load(it.dir, it.base);
                    let n = 0;
                    const poll = () => {
                        const st = bmp._loadingState;
                        if (st === "loaded") {
                            // the save needs the small canvas: release the bitmap only after the queue is empty
                            IMG_CACHE.idle().then(() => {
                                if (PMZ_IMG.cacheSaved > saved0) res.built++; else res.skipped++;
                                ENG.release(bmp); done();
                            });
                        } else if (st === "error" || ++n > 600) {
                            res.failed++; ENG.release(bmp); done();
                        } else setTimeout(poll, 50);
                    };
                    poll();
                } catch (e) { res.failed++; done(); }
            });
            const next = () => {
                if (i >= list.length) return finish("");
                if (!IMG_CACHE.write) return finish(PMZ_IMG.cacheOff || "writing disabled");
                const it = list[i++];
                step(it).then(() => { report(it.dir + "/" + it.base); setTimeout(next, 0); });
            };
            next();
        });

        // small canvas = img drawn at w x h
        const drawSmall = (img, w, h) => {
            const c = document.createElement("canvas");
            c.width = w; c.height = h;
            const ctx = c.getContext("2d");
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(img, 0, 0, w, h);
            return c;
        };
        // the bitmap now shows canvas c; its texture keeps the game size w x h
        const adopt = (b, c, w, h) => {
            b._image = c;
            b._pmzScale = c.width / w; b._pmzW = w; b._pmzH = h;
            b._loadingState = "loaded";
            if (window.PMZ_SMOOTH !== undefined) b._smooth = !!window.PMZ_SMOOTH;
            const bt = new PIXI.BaseTexture(c, b._smooth ? PIXI.SCALE_MODES.LINEAR : PIXI.SCALE_MODES.NEAREST, b._pmzScale);
            bt.mipmap = false;
            bt.realWidth = c.width; bt.realHeight = c.height;
            bt.width = w; bt.height = h;
            // keep the game size whenever PIXI recomputes it (realWidth / resolution rounds:
            // 101 px at 0.4 -> 40 -> 100, and frames of the full size would not fit)
            const _dims = bt._updateDimensions;
            if (_dims) bt._updateDimensions = function() { _dims.apply(this, arguments); this.width = w; this.height = h; };
            b.__baseTexture = bt;
            PMZ_IMG.count++; PMZ_IMG.saved += w * h - c.width * c.height;
            b._setDirty();
            b._callLoadListeners();
        };
        // Menu background snapshots at the render scale (as PocketMZ_Handheld.js section 17). MV
        // renders the stage into a game-size canvas (1600x1000 in a large game) and then blurs every
        // pixel of it on the CPU: ~0.5 s per menu open. Here the render texture has the renderer's
        // resolution, the small read-back becomes a downscaled bitmap of the game size, and blur()
        // works on that small canvas.
        const _snap = Bitmap.snap;
        if (_snap) Bitmap.snap = function(stage) {
            const R = Graphics._renderer, r = R && R.resolution;
            if (!stage || !R || !(r < 0.99) || !R.extract || !Graphics.isWebGL() || window.PMZ_IMG_OFF) return _snap.apply(this, arguments);
            let c = null;
            try {
                const w = Graphics.width, h = Graphics.height;
                const rt = PIXI.RenderTexture.create(w, h, undefined, r);
                R.render(stage, rt);
                stage.worldTransform.identity();
                c = R.extract.canvas(rt);
                rt.destroy(true);
                const bitmap = new Bitmap(1, 1);
                if (bitmap.__canvas) { bitmap.__canvas.width = 0; bitmap.__canvas.height = 0; }
                bitmap.__canvas = null; bitmap.__context = null; bitmap.__baseTexture = null;
                adopt(bitmap, c, w, h);
                PMZ_IMG.snaps = (PMZ_IMG.snaps || 0) + 1;
                return bitmap;
            } catch (e) {
                if (c) { c.width = c.height = 0; }
                return _snap.apply(this, arguments);
            }
        };
        const _blurSmall = B.blur;
        if (_blurSmall) B.blur = function() {
            if (!small(this) || this._image.tagName !== "CANVAS") return _blurSmall.apply(this, arguments);
            const c = this._image, t = document.createElement("canvas");
            t.width = c.width; t.height = c.height;
            const tc = t.getContext("2d");
            tc.filter = "blur(" + Math.max(0.5, Math.round(2 * this._pmzScale * 10) / 10) + "px)";   // MV: ~2 px at full size
            tc.drawImage(c, 0, 0);
            const cc = c.getContext("2d");
            cc.clearRect(0, 0, c.width, c.height);
            cc.drawImage(t, 0, 0);
            t.width = t.height = 0;
            if (this.__baseTexture) this.__baseTexture.update();
            this._setDirty();
        };
        PMZ_IMG.adopt = adopt;
        // a cached small PNG is requested instead of the original (plain file: no Decrypter);
        // _url stays the original url
        const _requestImage = B._requestImage;
        B._requestImage = function(url) {
            const hit = IMG_CACHE.lookup(url);
            this._pmzHit = hit;
            if (!hit) return _requestImage.apply(this, arguments);
            if (this._decodeAfterRequest && !this._loader) {
                this._loader = ResourceHandler.createLoader(url, this._requestImage.bind(this, url), this._onError.bind(this));
            }
            const img = this._image = new Image();
            this._url = url;
            this._loadingState = "requesting";
            // an unreadable cache file is not used again: the retry / next request takes the original
            img.addEventListener("error", this._pmzBadListener = () => IMG_CACHE.bad.add(url));
            img.addEventListener("load", this._loadListener = Bitmap.prototype._onLoad.bind(this));
            img.addEventListener("error", this._errorListener = this._loader || Bitmap.prototype._onError.bind(this));
            img.src = hit.src;
        };
        // last image errors with their state, for diagnosis (PMZ_IMG.errLog)
        const _onError = B._onError;
        if (_onError) B._onError = function() {
            try {
                const log = PMZ_IMG.errLog || (PMZ_IMG.errLog = []);
                log.push({ url: this._url, state: this._loadingState, hit: !!this._pmzHit, bad: IMG_CACHE.bad.has(this._url),
                           src: String(this._image && this._image.src || "").slice(0, 80), t: Math.round(performance.now()) });
                if (log.length > 20) log.shift();
            } catch (e) { /* diagnostics only */ }
            return _onError.apply(this, arguments);
        };
        const _decode = B.decode;
        B.decode = function() {
            const st = this._loadingState, img = this._image, hit = this._pmzHit;
            if (hit && st === "requestCompleted" && img && img.tagName === "IMG") {
                this._pmzHit = null;
                let c = null;
                if (!this.__canvas && img.width === hit.sw && img.height === hit.sh) {
                    try { c = drawSmall(img, hit.sw, hit.sh); } catch (e) { c = null; }
                }
                // our <img> is dropped, not recycled: clearing src queues an "error" event that
                // would reach the listeners of the next bitmap taking it from _reuseImages
                if (this._pmzBadListener) img.removeEventListener("error", this._pmzBadListener);
                this._pmzBadListener = null;
                img.onload = img.onerror = null;
                if (!c) {                              // not what the name says: back to the original
                    IMG_CACHE.bad.add(this._url);
                    this._image = null;
                    this._loadingState = "purged";
                    this._decodeAfterRequest = true;
                    return this._requestImage(this._url);
                }
                adopt(this, c, hit.W, hit.H);
                PMZ_IMG.cacheHits++;
                return;
            }
            const w = img && img.width, h = img && img.height, s = imgScale();
            if ((st !== "requestCompleted" && st !== "decryptCompleted") || this.__canvas || !img || img.tagName !== "IMG" ||
                s > 0.9 || w * h < IMG_MIN_PIXELS || !IMG_DIRS.test(this._url || "") || window.PMZ_IMG_OFF) {
                return _decode.apply(this, arguments);
            }
            let c;
            try {
                c = drawSmall(img, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
            } catch (e) {
                return _decode.apply(this, arguments);
            }
            // the full-size image goes back to MV's pool of reusable <img> elements
            img.src = ""; img.onload = img.onerror = null;
            if (Bitmap._reuseImages) Bitmap._reuseImages.push(img);
            IMG_CACHE.save(this._url, w, h, c);
            adopt(this, c, w, h);
        };
        for (const [prop, key] of [["width", "_pmzW"], ["height", "_pmzH"]]) {
            const d = Object.getOwnPropertyDescriptor(B, prop);
            Object.defineProperty(B, prop, {
                get: function() { return small(this) ? this[key] : d.get.call(this); },
                configurable: true
            });
        }
        // something draws into the bitmap: a full-size canvas again (upscaled from the small one)
        const _createCanvas = B._createCanvas;
        B._createCanvas = function(width, height) {
            if (!small(this)) return _createCanvas.apply(this, arguments);
            const c = this._image, w = this._pmzW, h = this._pmzH;
            this._image = null; this._pmzScale = 0;
            this.__canvas = document.createElement("canvas");
            this.__context = this.__canvas.getContext("2d");
            this.__canvas.width = w; this.__canvas.height = h;
            this.__context.imageSmoothingEnabled = true;
            this.__context.drawImage(c, 0, 0, w, h);
            c.width = c.height = 0;
            this._createBaseTexture(this.__canvas);
            PMZ_IMG.upscaled++;
            this._setDirty();
        };
        const mapBlt = (orig, srcProp) => function(source, sx, sy, sw, sh, dx, dy, dw, dh) {
            if (!source || !small(source)) return orig.apply(this, arguments);
            const k = source._pmzScale;
            dw = dw || sw; dh = dh || sh;
            if (sx >= 0 && sy >= 0 && sw > 0 && sh > 0 && dw > 0 && dh > 0 &&
                    sx + sw <= source.width && sy + sh <= source.height) {
                this._context.globalCompositeOperation = "source-over";
                this._context.drawImage(source._image, sx * k, sy * k, sw * k, sh * k, dx, dy, dw, dh);
                this._setDirty();
            }
        };
        B.blt = mapBlt(B.blt);
        if (B.bltImage) B.bltImage = mapBlt(B.bltImage);
        const pixel = (b, x, y) => b._image.getContext("2d").getImageData(
            Math.min(b._image.width - 1, Math.floor(x * b._pmzScale)), Math.min(b._image.height - 1, Math.floor(y * b._pmzScale)), 1, 1).data;
        const _getPixel = B.getPixel, _getAlpha = B.getAlphaPixel;
        B.getPixel = function(x, y) {
            if (!small(this)) return _getPixel.apply(this, arguments);
            const d = pixel(this, x, y);
            return "#" + [0, 1, 2].map(i => d[i].toString(16).padZero(2)).join("");
        };
        B.getAlphaPixel = function(x, y) {
            return small(this) ? pixel(this, x, y)[3] : _getAlpha.apply(this, arguments);
        };
    }

    // 7. Window contents freed when replaced. MV's Window_Base#createContents makes a new Bitmap
    //    (a canvas the size of the window) and drops the old one without freeing it; MZ destroys
    //    it first. Message / name-box plugins recreate contents for every message, and the old
    //    canvases (software bitmaps in the renderer, outside the JS heap) piled up until a GC:
    //    up to 244 canvases / 170 MB alive in a voiced MV game. The old canvas is released at once.
    if (window.Window_Base && Window_Base.prototype.createContents) {
        const release = b => {
            try {
                if (b.__baseTexture) { b.__baseTexture.destroy(); b.__baseTexture = null; }
                if (b.__canvas) { b.__canvas.width = 0; b.__canvas.height = 0; b.__canvas = null; b.__context = null; }
                // a downscaled snapshot (section 6) keeps its pixels in a small canvas as _image
                if (b._pmzScale && b._image && b._image.tagName === "CANVAS") { b._image.width = 0; b._image.height = 0; b._image = null; }
            } catch (e) { /* the window keeps working with its new contents */ }
        };
        // Window#_refreshBack / _refreshFrame make a new window-sized Bitmap for the back and the
        // frame every time the size or padding changes (message-window placement plugins do it
        // for every message); the previous ones are released the same way.
        for (const [fn, spr] of [["_refreshBack", "_windowBackSprite"], ["_refreshFrame", "_windowFrameSprite"]]) {
            const orig = window.Window && Window.prototype[fn];
            if (!orig) continue;
            Window.prototype[fn] = function() {
                const old = this[spr] && this[spr].bitmap;
                const r = orig.apply(this, arguments);
                if (old && this[spr] && old !== this[spr].bitmap && old instanceof Bitmap && !old._url) release(old);
                return r;
            };
        }
        const _createContents = Window_Base.prototype.createContents;
        Window_Base.prototype.createContents = function() {
            const old = this.contents;
            const r = _createContents.apply(this, arguments);
            if (old && old !== this.contents && old instanceof Bitmap && !old._url) release(old);
            return r;
        };
        // Windows of the scene that ended: MV never destroys a scene, so the contents / back /
        // frame canvases of every menu window stayed alive until a GC (the GC does not see canvas
        // memory): +14 sets of window canvases after 18 menu opens in the MV bench, RAM + swap
        // full after a few minutes of menus in a voiced 1600x1000 game. Released once the next
        // scene is created; windows a plugin carries over into the new scene are kept, and so
        // are bitmaps loaded from files (_url) and the menu background snapshot.
        if (SceneManager.changeScene) {
            const windowsIn = (root, out) => {
                const seen = new Set();
                const walk = (o, d) => {
                    if (!o || seen.has(o) || d > 8) return;
                    seen.add(o);
                    if (o instanceof Window) out.add(o);
                    if (o.children) for (const c of o.children) walk(c, d + 1);
                };
                walk(root, 0);
                return out;
            };
            const own = b => b && b instanceof Bitmap && !b._url && b !== SceneManager._backgroundBitmap;
            // the previous menu background snapshot (game-size canvas, blurred) when a new one is taken
            if (SceneManager.snapForBackground) {
                const _snapBg = SceneManager.snapForBackground;
                SceneManager.snapForBackground = function() {
                    const prev = this._backgroundBitmap;
                    const r = _snapBg.apply(this, arguments);
                    if (prev && prev !== this._backgroundBitmap && prev instanceof Bitmap && !prev._url &&
                        !window.PMZ_SCENE_RELEASE_OFF) release(prev);
                    return r;
                };
            }
            const _changeScene = SceneManager.changeScene;
            SceneManager.changeScene = function() {
                const old = this._scene;
                const r = _changeScene.apply(this, arguments);
                if (old && this._scene && this._scene !== old && !window.PMZ_SCENE_RELEASE_OFF) {
                    try {
                        if (window.Graphics && Graphics._renderer && Graphics._renderer._lastObjectRendered === old) {
                            Graphics._renderer._lastObjectRendered = null;
                        }
                        const keep = windowsIn(this._scene, new Set());
                        for (const w of windowsIn(old, new Set())) {
                            if (keep.has(w)) continue;
                            for (const b of [w.contents, w._windowBackSprite && w._windowBackSprite.bitmap,
                                             w._windowFrameSprite && w._windowFrameSprite.bitmap]) {
                                if (own(b)) release(b);
                            }
                        }
                    } catch (e) { /* the new scene runs anyway */ }
                }
                return r;
            };
        }
    }

    // 8. PIXI texture GC sooner (same as PocketMZ_Handheld.js section 5). GPU memory is system
    //    RAM here (panfrost buffers count as shared memory of the game); PIXI v4 keeps the texture
    //    of a bitmap nobody draws any more for 3600 frames. Old windows, menu backgrounds and
    //    pictures of the previous scenes. (MV 1.6 itself sets maxIdle = 1 on its renderer after
    //    creating it, which stays; this covers older MV cores.)
    if (window.PIXI && PIXI.settings && "GC_MAX_IDLE" in PIXI.settings) {
        PIXI.settings.GC_MAX_IDLE = 900;           // frames (~15 s)
        PIXI.settings.GC_MAX_CHECK_COUNT = 300;
        const gc = Graphics._renderer && Graphics._renderer.textureGC;   // renderer made already?
        if (gc) { gc.maxIdle = 900; gc.checkCountMax = 300; }
    }

    // 10. Full GC after scene changes and when memory runs low. Dropped canvases, images and decoded
    //     audio (WebAudio buffers: 20-50 MB per BGM at 24 kHz) live outside the small JS heap, so V8
    //     rarely collects their owners on its own: in an MZ game decoded audio grew to 153 MB and
    //     images to 95 MB within 10 minutes of maps and battles, most of it garbage. With
    //     --expose-gc (pocketmz-run.sh) a full GC runs ~0.5 s after each scene change (at most every
    //     8 s; scene changes are loading pauses anyway) and when MemAvailable drops below 300 MB
    //     (checked every 15 s, at most every 20 s). POCKETMZ_GC=off disables it.
    if (typeof window.gc === "function" && window.SceneManager && SceneManager.changeScene &&
        String((window.process && process.env && process.env.POCKETMZ_GC) || "on") !== "off") {
        let lastGc = 0;
        const gcNow = minGap => {
            const t = performance.now();
            if (t - lastGc < minGap) return;
            lastGc = t;
            try { window.gc(); } catch (e) { /* gc not available after all */ }
            window.PMZ_GC_COUNT = (window.PMZ_GC_COUNT || 0) + 1;
        };
        const _changeSceneGc = SceneManager.changeScene;
        SceneManager.changeScene = function() {
            const old = this._scene;
            const r = _changeSceneGc.apply(this, arguments);
            if (this._scene && this._scene !== old) setTimeout(() => gcNow(8000), 500);
            return r;
        };
        const fsGc = window.require ? (() => { try { return require("fs"); } catch (e) { return null; } })() : null;
        if (fsGc) setInterval(() => {
            try {
                const m = /MemAvailable:\s+(\d+)/.exec(fsGc.readFileSync("/proc/meminfo", "utf8"));
                if (m && +m[1] < 300 * 1024) gcNow(20000);
            } catch (e) { /* no /proc */ }
        }, 15000);
    }

    // 11. Decoded sound effects reused (as PocketMZ_Handheld.js section 19). MV loads and decodes an
    //     SE file again for every playSe; footstep plugins play one per step. Short SE files
    //     (audio/se/, <= 10 s) are decoded once and their AudioBuffer is shared by later plays
    //     (24 MB, least recently used out). POCKETMZ_SE_CACHE=off disables it.
    if (window.WebAudio && WebAudio.prototype._load && WebAudio.prototype._onLoad &&
        String((window.process && process.env && process.env.POCKETMZ_SE_CACHE) || "on") !== "off") {
        const W = WebAudio.prototype;
        const SE = new Map(), SE_MAX = 24 << 20;
        const PMZ_SE = window.PMZ_SE = { hits: 0, stored: 0, bytes: 0, size: () => SE.size };
        const isSe = url => /(^|\/)audio\/se\//.test(String(url || ""));
        const bytesOf = b => b.length * b.numberOfChannels * 4;
        const _load = W._load;
        W._load = function(url) {
            const hit = isSe(this._url) && SE.get(this._url);
            if (!hit || !WebAudio._context) return _load.apply(this, arguments);
            SE.delete(this._url); SE.set(this._url, hit);
            PMZ_SE.hits++;
            // MV's own decode callback sets these (loop points already in seconds) and calls _onLoad
            Promise.resolve().then(() => {
                if (this._url !== hit.url || this._buffer) return;
                this._buffer = hit.buffer;
                this._totalTime = hit.totalTime;
                this._sampleRate = hit.sampleRate;
                this._loopStart = hit.loopStart;
                this._loopLength = hit.loopLength;
                this._onLoad();
            });
        };
        const _onLoad = W._onLoad;
        W._onLoad = function() {
            const b = this._buffer;
            if (b && isSe(this._url) && b.duration <= 10 && !SE.has(this._url)) {
                SE.set(this._url, { url: this._url, buffer: b, totalTime: this._totalTime, sampleRate: this._sampleRate,
                                    loopStart: this._loopStart, loopLength: this._loopLength });
                PMZ_SE.bytes += bytesOf(b); PMZ_SE.stored++;
                for (const [k, v] of SE) {
                    if (PMZ_SE.bytes <= SE_MAX) break;
                    SE.delete(k); PMZ_SE.bytes -= bytesOf(v.buffer);
                }
            }
            return _onLoad.apply(this, arguments);
        };
    }

    // 12. The current map's JSON text kept. Scene_Map#create loads the map file again every time
    //     the map scene comes back (after the menu, a battle, a shop): a 2 MB map with 137 events
    //     took 250-540 ms to read in an MV game (1.5 s cold) before parsing. The text of the last
    //     loaded map stays in memory, and loading the same map again parses that text and runs
    //     the engine's own onLoad (plugins' load hooks included), like a fresh load without the
    //     file read. POCKETMZ_MAP_CACHE=off disables it.
    if (window.DataManager && DataManager.loadDataFile && DataManager.onLoad &&
        String((window.process && process.env && process.env.POCKETMZ_MAP_CACHE) || "on") !== "off") {
        const MAP_TEXT = window.PMZ_MAP_TEXT = { src: "", text: "", hits: 0 };
        const _loadDataFile = DataManager.loadDataFile;
        DataManager.loadDataFile = function(name, src) {
            if (name !== "$dataMap") return _loadDataFile.apply(this, arguments);
            if (MAP_TEXT.src === src && MAP_TEXT.text) {
                const text = MAP_TEXT.text;
                window[name] = null;
                MAP_TEXT.hits++;
                setTimeout(() => {            // asynchronous like the file load
                    let data;
                    try { data = JSON.parse(text); } catch (e) {
                        // not plain JSON (a data plugin transforms it): load normally from now on
                        MAP_TEXT.src = ""; MAP_TEXT.text = ""; MAP_TEXT.off = true;
                        return _loadDataFile.call(DataManager, name, src);
                    }
                    window[name] = data;
                    DataManager.onLoad(window[name]);
                }, 0);
                return;
            }
            // read through the engine; keep the text the request returns
            const _send = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function() {
                this.addEventListener("load", () => {
                    if (this.status < 400 && !MAP_TEXT.off && typeof this.responseText === "string") { MAP_TEXT.src = src; MAP_TEXT.text = this.responseText; }
                });
                return _send.apply(this, arguments);
            };
            try { return _loadDataFile.apply(this, arguments); } finally { XMLHttpRequest.prototype.send = _send; }
        };
    }

    // 9. Window bitmaps drawn at the display scale (as PocketMZ_Handheld.js section 17, MV 1.6's
    //    lazy Bitmap: __canvas / __context / __baseTexture). A 1600x1000 game makes window-size
    //    canvases for the contents, the back and the frame of every window and draws text into
    //    them at full size; the 640x480 screen shows 16% of those pixels. Bitmaps created inside
    //    Window_Base#createContents and Window#_refreshBack / _refreshFrame get a canvas of
    //    (w x h) * render scale with the context scaled by the same factor, so every 2D call keeps
    //    game coordinates; the texture keeps the game size (resolution = scale). Per-pixel tone /
    //    hue changes work on the real canvas pixels; getPixel is mapped; blur (and anything else
    //    that needs full-size pixels) gets a full-size canvas first.
    //    POCKETMZ_WIN_SCALE=off disables it; window.PMZ_WIN_OFF = true for A/B in a running game.
    const WIN_ENV = String((window.process && process.env && process.env.POCKETMZ_WIN_SCALE) || "auto");
    const lazyCanvas = Object.getOwnPropertyDescriptor(Bitmap.prototype, "_canvas");
    if (WIN_ENV !== "off" && RS_ENV !== "off" && window.Window_Base && window.Window && lazyCanvas && lazyCanvas.get &&
        Bitmap.prototype._createBaseTexture && PIXI.BaseTexture) {
        const B = Bitmap.prototype;
        const ST = window.PMZ_IMG || (window.PMZ_IMG = {});
        let depth = 0;
        const winScale = () => {
            const R = Graphics._renderer, r = R && R.resolution;
            return r && r <= 0.9 && !window.PMZ_WIN_OFF ? r : 0;
        };
        const scaled = b => b._pmzCS && b.__canvas && !b._pmzRaw;
        const pinTexture = (b, bt) => {   // game-size texture whatever PIXI recomputes
            if (!bt || bt._pmzPinned) return;
            bt._pmzPinned = true;
            const _dims = bt._updateDimensions;
            if (_dims) bt._updateDimensions = function() {
                _dims.apply(this, arguments);
                if (b._pmzCS) { this.width = b._pmzW; this.height = b._pmzH; }
            };
        };
        const syncTexture = b => {
            const bt = b.__baseTexture, c = b.__canvas;
            if (!bt || !c) return;
            bt.resolution = b._pmzCS || 1;
            bt.realWidth = c.width; bt.realHeight = c.height;
            if (bt._updateDimensions) bt._updateDimensions();
            else { bt.width = b._pmzCS ? b._pmzW : c.width; bt.height = b._pmzCS ? b._pmzH : c.height; }
        };
        const sizeCanvas = (b, w, h) => {
            const k = b._pmzCS, c = b.__canvas;
            b._pmzW = w; b._pmzH = h;
            c.width = Math.max(1, Math.ceil(w * k));
            c.height = Math.max(1, Math.ceil(h * k));
            b.__context.setTransform(k, 0, 0, k, 0, 0);   // reset by every size change
            syncTexture(b);
            b._setDirty();
        };
        const _createCanvas = B._createCanvas;
        B._createCanvas = function(width, height) {
            const k = depth > 0 && !this._image && width > 0 && height > 0 ? winScale() : 0;
            if (!k) { this._pmzCS = 0; return _createCanvas.apply(this, arguments); }
            _createCanvas.call(this, 1, 1);
            this._pmzCS = k;
            sizeCanvas(this, width, height);
            ST.winCount = (ST.winCount || 0) + 1;
            ST.winSaved = (ST.winSaved || 0) + width * height - this.__canvas.width * this.__canvas.height;
        };
        const _createBaseTexture = B._createBaseTexture;
        B._createBaseTexture = function(source) {
            const r = _createBaseTexture.apply(this, arguments);
            if (this._pmzCS && source === this.__canvas) { pinTexture(this, this.__baseTexture); syncTexture(this); }
            return r;
        };
        const unscale = b => {   // back to a full-size canvas, same texture object
            if (!b._pmzCS || !b.__canvas) return;
            const w = b._pmzW, h = b._pmzH, old = b.__canvas;
            const c = document.createElement("canvas");
            c.width = w; c.height = h;
            const ctx = c.getContext("2d");
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(old, 0, 0, w, h);
            b._pmzCS = 0;
            b.__canvas = c; b.__context = ctx;
            const bt = b.__baseTexture;
            if (bt) { bt.source = c; syncTexture(b); }
            old.width = old.height = 0;
            b._setDirty();
            ST.winUnscaled = (ST.winUnscaled || 0) + 1;
        };
        const counted = fn => function() {
            depth++;
            try { return fn.apply(this, arguments); } finally { depth--; }
        };
        Window_Base.prototype.createContents = counted(Window_Base.prototype.createContents);
        for (const fn of ["_refreshBack", "_refreshFrame"]) {
            if (Window.prototype[fn]) Window.prototype[fn] = counted(Window.prototype[fn]);
        }
        for (const [prop, key] of [["width", "_pmzW"], ["height", "_pmzH"]]) {
            const d = Object.getOwnPropertyDescriptor(B, prop);
            Object.defineProperty(B, prop, {
                get: function() { return scaled(this) && this.isReady() ? this[key] : d.get.call(this); },
                configurable: true
            });
        }
        const _resize = B.resize;
        B.resize = function(width, height) {
            if (!scaled(this)) return _resize.apply(this, arguments);
            sizeCanvas(this, Math.max(width || 0, 1), Math.max(height || 0, 1));
        };
        const _blt = B.blt;
        B.blt = function(source, sx, sy, sw, sh, dx, dy, dw, dh) {
            if (source && scaled(source)) {
                const k = source._pmzCS;
                dw = dw || sw; dh = dh || sh;
                if (sx >= 0 && sy >= 0 && sw > 0 && sh > 0 && dw > 0 && dh > 0 &&
                    sx + sw <= source.width && sy + sh <= source.height) {
                    this._context.globalCompositeOperation = "source-over";
                    this._context.drawImage(source.__canvas, sx * k, sy * k, sw * k, sh * k, dx, dy, dw, dh);
                    this._setDirty();
                }
                return;
            }
            return _blt.apply(this, arguments);
        };
        // whole-canvas pixel passes: run on the real canvas pixels (width/height = canvas size)
        for (const fn of ["adjustTone", "rotateHue"]) {
            const orig = B[fn];
            if (!orig) continue;
            B[fn] = function() {
                if (!scaled(this)) return orig.apply(this, arguments);
                this._pmzRaw = true;
                try { return orig.apply(this, arguments); } finally { this._pmzRaw = false; }
            };
        }
        const cpixel = (b, x, y) => b.__context.getImageData(
            Math.min(b.__canvas.width - 1, Math.floor(x * b._pmzCS)), Math.min(b.__canvas.height - 1, Math.floor(y * b._pmzCS)), 1, 1).data;
        const _getPixel = B.getPixel, _getAlpha = B.getAlphaPixel;
        B.getPixel = function(x, y) {
            if (!scaled(this)) return _getPixel.apply(this, arguments);
            const d = cpixel(this, x, y);
            return "#" + [0, 1, 2].map(i => d[i].toString(16).padZero(2)).join("");
        };
        B.getAlphaPixel = function(x, y) {
            return scaled(this) ? cpixel(this, x, y)[3] : _getAlpha.apply(this, arguments);
        };
        if (B.blur) {
            const _blur = B.blur;
            B.blur = function() { unscale(this); return _blur.apply(this, arguments); };
        }
        ST.unscaleWindow = unscale;
    }

    // 8. Smooth scaling (bilinear vs nearest-neighbor), driven by ES / PocketMZ Settings / F2 menu.
    if (window.PIXI && PIXI.glCore && PIXI.glCore.GLTexture && PIXI.glCore.GLTexture.prototype.upload) {
        const _glUpload = PIXI.glCore.GLTexture.prototype.upload;
        PIXI.glCore.GLTexture.prototype.upload = function(source) {
            if (!source) return;
            return _glUpload.apply(this, arguments);
        };
    }
    if (window.Bitmap && window.PIXI) {
        const updateGlTex = (gl, bt, on) => {
            if (!gl || !bt) return;
            const mag = on ? gl.LINEAR : gl.NEAREST;
            const min = bt.mipmap ? (on ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_LINEAR) : mag;
            const prev = gl.getParameter(gl.TEXTURE_BINDING_2D);
            const touchGt = gt => {
                if (!gt) return;
                if (typeof gt.enableLinearScaling === "function" && typeof gt.enableNearestScaling === "function") {
                    if (on) gt.enableLinearScaling(); else gt.enableNearestScaling();
                    return;
                }
                const raw = gt.texture || gt;
                if (raw) {
                    gl.bindTexture(gl.TEXTURE_2D, raw);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
                    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
                }
            };
            if (bt._glTextures) for (const id of Object.keys(bt._glTextures)) touchGt(bt._glTextures[id]);
            if (bt._glRenderTargets) for (const id of Object.keys(bt._glRenderTargets)) {
                const rt = bt._glRenderTargets[id];
                if (rt && rt.texture) touchGt(rt.texture);
            }
            if (prev !== undefined) gl.bindTexture(gl.TEXTURE_2D, prev);
        };
        const bInit = Bitmap.prototype.initialize;
        Bitmap.prototype.initialize = function() {
            bInit.apply(this, arguments);
            if (window.PMZ_SMOOTH !== undefined) {
                this._smooth = !!window.PMZ_SMOOTH;
                if (this.__baseTexture) {
                    this.__baseTexture.scaleMode = this._smooth ? PIXI.SCALE_MODES.LINEAR : PIXI.SCALE_MODES.NEAREST;
                }
            }
        };
        const smDesc = Object.getOwnPropertyDescriptor(Bitmap.prototype, "smooth");
        if (smDesc && smDesc.set) {
            Object.defineProperty(Bitmap.prototype, "smooth", {
                get: smDesc.get,
                set: function(v) {
                    const eff = window.PMZ_SMOOTH !== undefined ? !!window.PMZ_SMOOTH : !!v;
                    smDesc.set.call(this, eff);
                },
                configurable: true
            });
        }
        window.PMZ_applySmooth = function(on) {
            on = !!on;
            window.PMZ_SMOOTH = on;
            const mode = on ? PIXI.SCALE_MODES.LINEAR : PIXI.SCALE_MODES.NEAREST;
            if (PIXI.settings) PIXI.settings.SCALE_MODE = mode;
            else if (PIXI.SCALE_MODES && "DEFAULT" in PIXI.SCALE_MODES) PIXI.SCALE_MODES.DEFAULT = mode;
            if (PIXI.tilemap && PIXI.tilemap.TileRenderer) PIXI.tilemap.TileRenderer.SCALE_MODE = mode;
            if (window.Graphics && Graphics._canvas && Graphics._canvas.style) {
                Graphics._canvas.style.imageRendering = on ? "auto" : "pixelated";
            }
            const R = window.Graphics && Graphics._renderer;
            const gl = R && R.gl;
            const seen = new Set();
            const touchBt = bt => {
                if (!bt || seen.has(bt)) return;
                seen.add(bt);
                bt.scaleMode = mode;
                updateGlTex(gl, bt, on);
            };
            const ic = window.ImageManager && ImageManager._imageCache && ImageManager._imageCache._items;
            if (ic) {
                for (const k of Object.keys(ic)) {
                    const entry = ic[k], bmp = entry && entry.bitmap;
                    if (bmp) { bmp._smooth = on; touchBt(bmp.__baseTexture); }
                }
            }
            const btc = PIXI.utils && PIXI.utils.BaseTextureCache;
            if (btc) for (const k of Object.keys(btc)) touchBt(btc[k]);
            if (R && R.textureManager && R.textureManager._managedTextures) {
                for (const bt of R.textureManager._managedTextures) touchBt(bt);
            }
            if (R && R.plugins && R.plugins.tilemap && R.plugins.tilemap.glTextures) {
                for (const rt of R.plugins.tilemap.glTextures) if (rt) touchBt(rt.baseTexture || rt);
            }
            window.PMZ_FORCE_REDRAW = true;
            if (window.PMZ_MENU && PMZ_MENU.state && PMZ_MENU.state().open && R && window.SceneManager && SceneManager._scene) {
                try { R.render(SceneManager._scene); } catch (e) {}
            }
        };
        const smEnv = String((window.process && process.env && process.env.POCKETMZ_SMOOTH) || "").toLowerCase();
        if (smEnv === "1" || smEnv === "true" || smEnv === "on") window.PMZ_applySmooth(true);
        else if (smEnv === "0" || smEnv === "false" || smEnv === "off") window.PMZ_applySmooth(false);
    }

    // 13. Mali fp16 precision fix for pixi-tilemap: MV's 2048x2048 tile atlas uses shiftU/V=1024
    //     and aFrame inset eps=0.5 (e.g. 1071.5). Under PIXI v4's default mediump (fp16 on Mali),
    //     values >1024 have ULP=1.0 so 1071.5 rounds up to 1072.0 (adjacent tile/transparent edge),
    //     producing 1px dark vertical seams at tile borders (especially visible with NEAREST/smooth=0).
    //     Prefix starts with "precision" so PIXI v4 setPrecision() does not prepend mediump after it.
    if (window.PIXI && PIXI.tilemap && PIXI.tilemap.shaderGenerator &&
        PIXI.tilemap.shaderGenerator.generateFragmentSrc && !PIXI.tilemap.shaderGenerator._pmzHighp) {
        const sg = PIXI.tilemap.shaderGenerator;
        sg._pmzHighp = true;
        const _genFrag = sg.generateFragmentSrc;
        sg.generateFragmentSrc = function(maxTextures, fragmentSrc) {
            const src = _genFrag.call(this, maxTextures, fragmentSrc);
            if (typeof src === "string" && !src.includes("GL_FRAGMENT_PRECISION_HIGH")) {
                return "precision mediump float;\n#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#endif\n" + src;
            }
            return src;
        };
    }

    // 14. Game_Interpreter.skipBranch jump table (avoid linear re-scan of long event lists)
    if (String((window.process && process.env && process.env.POCKETMZ_SKIPBRANCH_CACHE) || "on").toLowerCase() !== "off" &&
        window.Game_Interpreter && Game_Interpreter.prototype.skipBranch &&
        !Game_Interpreter.prototype.skipBranch._pmzCached) {
        const origSkip = Game_Interpreter.prototype.skipBranch;
        if (String(origSkip).includes("this._list[this._index + 1]")) {
            const branchCache = new WeakMap();
            const wrapped = function() {
                const list = this._list;
                if (!list || !list.length) return origSkip.call(this);
                let entry = branchCache.get(list);
                if (!entry || entry.len !== list.length) {
                    entry = { len: list.length, map: new Map() };
                    branchCache.set(list, entry);
                }
                const indent = this._indent | 0;
                const key = (this._index << 8) | (indent & 0xff);
                const cached = entry.map.get(key);
                if (cached !== undefined && cached >= this._index && cached < list.length &&
                    (cached + 1 >= list.length || list[cached + 1].indent <= indent)) {
                    this._index = cached;
                    return;
                }
                origSkip.call(this);
                entry.map.set(key, this._index);
            };
            wrapped._pmzCached = true;
            Game_Interpreter.prototype.skipBranch = wrapped;
        }
    }

    // 15. Game_Interpreter.requestImages deduplication per map/cache generation
    if (String((window.process && process.env && process.env.POCKETMZ_REQIMG_CACHE) || "on").toLowerCase() !== "off" &&
        window.Game_Interpreter && typeof Game_Interpreter.requestImages === "function" &&
        !Game_Interpreter.requestImages._pmzDedup) {
        let reqImgGen = 0;
        const reqSeen = new WeakMap();
        if (window.ImageManager && ImageManager.clear) {
            const _mvClear = ImageManager.clear;
            ImageManager.clear = function() {
                reqImgGen++;
                return _mvClear.apply(this, arguments);
            };
        }
        if (window.Scene_Map && Scene_Map.prototype.create) {
            const _mvMapCreate = Scene_Map.prototype.create;
            Scene_Map.prototype.create = function() {
                reqImgGen++;
                return _mvMapCreate.apply(this, arguments);
            };
        }
        const _origReqImages = Game_Interpreter.requestImages;
        const wrappedReq = function(list, commonList) {
            if (!commonList && Array.isArray(list) && list.length > 0) {
                if (reqSeen.get(list) === reqImgGen) return;
                reqSeen.set(list, reqImgGen);
            }
            return _origReqImages.apply(this, arguments);
        };
        wrappedReq._pmzDedup = true;
        Game_Interpreter.requestImages = wrappedReq;
    }

    // 16. WindowLayer.renderWebGL skip when no visible children (avoid empty stencil/mask pass)
    if (String((window.process && process.env && process.env.POCKETMZ_WINLAYER_SKIP) || "on").toLowerCase() !== "off" &&
        window.WindowLayer && WindowLayer.prototype.renderWebGL &&
        !WindowLayer.prototype.renderWebGL._pmzSkip) {
        const _wlRender = WindowLayer.prototype.renderWebGL;
        const wrappedWl = function(renderer) {
            if (!this.visible || this.worldAlpha <= 0) return;
            const ch = this.children;
            let any = false;
            if (ch) {
                for (let i = 0; i < ch.length; i++) {
                    const c = ch[i];
                    if (c && c.visible && c.alpha > 0) { any = true; break; }
                }
            }
            if (!any) return;
            return _wlRender.apply(this, arguments);
        };
        wrappedWl._pmzSkip = true;
        WindowLayer.prototype.renderWebGL = wrappedWl;
    }
})();
