    // 17. Large images kept at screen resolution. A 1920x1080 game shown on the 640x480 screen
    //     never draws a picture at more than 1/3 of its pixels, but MZ keeps every loaded image
    //     at full size (decoded + uploaded: GPU memory is system RAM here). Layered stand-up
    //     pictures (body / eyes / mouth, each full screen) filled RAM + swap within a minute and
    //     crashed the browser. Large images from these folders are drawn into a canvas at the
    //     display scale when they load; the texture gets resolution = that scale, so its size in
    //     game units, sprite frames and Bitmap.width/height stay the original ones.
    //     Drawing from such a bitmap (blt, getPixel) maps the coordinates; anything that writes
    //     into it gets a full-size canvas again (upscaled, as before but blurred).
    //     POCKETMZ_IMG_SCALE (games/<id>/env): "off", or a factor on the display scale (e.g. 1.5).
    //     The downscaled images are also kept in pmz-cache/ next to index.html (see IMG_CACHE below):
    //     the next time the small PNG is loaded instead of the original (no full-size decode).
    //     POCKETMZ_IMG_CACHE=off disables that; window.PMZ_IMG.prebuild(dirs, onProgress) fills it.
    const IMG_ENV = String((window.process && process.env && process.env.POCKETMZ_IMG_SCALE) || "auto");
    const IMG_DIRS = /img\/(pictures|parallaxes|battlebacks1|battlebacks2|titles1|titles2|enemies|sv_enemies|faces)\//;
    const IMG_MIN_PIXELS = 400 * 300;
    if (IMG_ENV !== "off" && RS_ENV !== "off" && window.Bitmap && PIXI.BaseTexture) {
        const factor = isFinite(parseFloat(IMG_ENV)) ? parseFloat(IMG_ENV) : 1;
        const imgScale = () => Math.round(Math.min(1, (Graphics._realScale || 1) * factor) * 1000) / 1000;
        const B = Bitmap.prototype;
        const PMZ_IMG = window.PMZ_IMG = { count: 0, saved: 0, upscaled: 0, cacheHits: 0, cacheSaved: 0, cacheBytes: 0, cacheOff: "" };
        // engine side of the cache: which file is read for a url, how a bitmap is loaded / released
        const ENG = {
            isEnc: () => Utils.hasEncryptedImages(),
            encFile: full => full + "_",
            encExt: ".png_",
            defaultDirs: ["pictures", "parallaxes", "battlebacks1", "battlebacks2", "titles1", "titles2", "enemies", "sv_enemies", "faces"],
            load: (dir, base) => Bitmap.load("img/" + dir + "/" + Utils.encodeURI(base) + ".png"),
            release: b => { try { b.destroy(); } catch (e) { /* gone anyway */ } }
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
        // the bitmap now shows `small`; its texture keeps the game size w x h
        const adopt = (b, small, w, h) => {
            b._image = small;                          // the full-size decode is dropped with img
            b._pmzScale = small.width / w;
            b._pmzW = w; b._pmzH = h;
            b._loadingState = "loaded";
            const bt = new PIXI.BaseTexture(small, { resolution: b._pmzScale });
            bt.mipmap = false;
            // keep the game size whenever PIXI recomputes it (realWidth / resolution rounds:
            // 101 px at 0.4 -> 40 -> 100, and frames of the full size would not fit)
            const _setReal = bt.setRealSize;
            bt.setRealSize = function() { _setReal.apply(this, arguments); this.width = w; this.height = h; return this; };
            bt.setRealSize(small.width, small.height, b._pmzScale);   // width/height = w, h
            b._baseTexture = bt;
            b._updateScaleMode();
            PMZ_IMG.count++; PMZ_IMG.saved += w * h - small.width * small.height;
            b._callLoadListeners();
        };
        PMZ_IMG.adopt = adopt;   // section 11 (blurred menu backgrounds)
        // Scene snapshots (menu / battle backgrounds, Bitmap.snap) at the render scale. The stock
        // snap renders the stage at the full game size into a render texture, reads it back and
        // draws it into a game-size canvas: 0.7 s and a 8 MB canvas + texture per menu open in a
        // 1920x1080 game. Here the render texture has the renderer's resolution and the small
        // read-back becomes a downscaled bitmap of the game size (as above).
        const _snap = Bitmap.snap;
        if (_snap) Bitmap.snap = function(stage) {
            const R = Graphics.app && Graphics.app.renderer, r = R && R.resolution;
            if (!stage || !R || !(r < 0.99) || !R.extract || window.PMZ_IMG_OFF) return _snap.apply(this, arguments);
            let c;
            try {
                const w = Graphics.width, h = Graphics.height;
                const rt = PIXI.RenderTexture.create({ width: w, height: h, resolution: r });
                R.render(stage, rt);
                stage.worldTransform.identity();
                c = R.extract.canvas(rt);
                rt.destroy(true);
                const bitmap = new Bitmap(1, 1);
                bitmap._destroyCanvas();
                if (bitmap._baseTexture) bitmap._baseTexture.destroy();
                adopt(bitmap, c, w, h);
                return bitmap;
            } catch (e) {
                if (c) { c.width = c.height = 0; }
                return _snap.apply(this, arguments);
            }
        };
        // a cached small PNG is read instead of the original (plain file, never encrypted)
        const _startLoading = B._startLoading;
        B._startLoading = function() {
            const hit = IMG_CACHE.lookup(this._url);
            this._pmzHit = hit;
            if (!hit) return _startLoading.apply(this, arguments);
            const img = this._image = new Image();
            img.onload = this._onLoad.bind(this);
            img.onerror = () => {                      // unreadable cache file: back to the original
                IMG_CACHE.bad.add(this._url);
                img.onload = img.onerror = null;
                this._pmzHit = null;
                _startLoading.call(this);
            };
            this._destroyCanvas();
            this._loadingState = "loading";
            img.src = hit.src;
        };
        const _onLoad = B._onLoad;
        B._onLoad = function() {
            const hit = this._pmzHit;
            this._pmzHit = null;
            const img = this._image;
            if (hit) {
                let small = null;
                if (img && img.width === hit.sw && img.height === hit.sh) {
                    try { small = drawSmall(img, hit.sw, hit.sh); } catch (e) { small = null; }
                }
                if (img) img.onload = img.onerror = null;
                if (!small) {                          // not what the name says: back to the original
                    IMG_CACHE.bad.add(this._url);
                    return _startLoading.call(this);
                }
                adopt(this, small, hit.W, hit.H);
                PMZ_IMG.cacheHits++;
                return;
            }
            const w = img && img.width, h = img && img.height, s = imgScale();
            if (!img || s > 0.9 || w * h < IMG_MIN_PIXELS || !IMG_DIRS.test(this._url || "") || window.PMZ_IMG_OFF) {
                return _onLoad.apply(this, arguments);
            }
            let small;
            try {
                small = drawSmall(img, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
            } catch (e) {
                return _onLoad.apply(this, arguments);
            }
            if (Utils.hasEncryptedImages()) URL.revokeObjectURL(img.src);
            img.onload = img.onerror = null;
            IMG_CACHE.save(this._url, w, h, small);
            adopt(this, small, w, h);
        };
        const small = b => b._pmzScale && !b._canvas && b._image;
        for (const [prop, key] of [["width", "_pmzW"], ["height", "_pmzH"]]) {
            const d = Object.getOwnPropertyDescriptor(B, prop);
            Object.defineProperty(B, prop, {
                get: function() { return small(this) ? this[key] : d.get.call(this); },
                configurable: true
            });
        }
        const _ensureCanvas = B._ensureCanvas;
        B._ensureCanvas = function() {
            if (small(this)) {
                const img = this._image;
                this._image = null;
                this._createCanvas(this._pmzW, this._pmzH);
                this._context.imageSmoothingEnabled = true;
                this._context.drawImage(img, 0, 0, this._pmzW, this._pmzH);
                this._baseTexture.update();
                img.width = img.height = 0;
                this._pmzScale = 0;
                PMZ_IMG.upscaled++;
                return;
            }
            return _ensureCanvas.apply(this, arguments);
        };
        const _blt = B.blt;
        B.blt = function(source, sx, sy, sw, sh, dx, dy, dw, dh) {
            if (source && small(source)) {
                const k = source._pmzScale;
                dw = dw || sw; dh = dh || sh;
                try {
                    this.context.globalCompositeOperation = "source-over";
                    this.context.drawImage(source._image, sx * k, sy * k, sw * k, sh * k, dx, dy, dw, dh);
                    this._baseTexture.update();
                } catch (e) { /* as the stock blt */ }
                return;
            }
            return _blt.apply(this, arguments);
        };
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
        const _destroy = B.destroy;
        B.destroy = function() {
            const img = small(this);
            _destroy.apply(this, arguments);
            if (img) { img.width = img.height = 0; this._image = null; }
        };

        // Window contents drawn at the display scale. A 1920x1080 game makes window-size canvases
        // (contents + contentsBack, up to 1872x1032) for every window, draws all text into them at
        // full size and uploads them; the screen shows 1/9 of those pixels. Bitmaps created while
        // Window_Base#createContents runs get a canvas of (w x h) * scale with the context scaled
        // by the same factor: every 2D call (text, rects, gradients, blt into it) keeps game
        // coordinates, the texture keeps the game size (resolution = scale, as above). Raw pixel
        // access is mapped (getPixel) and anything else that needs real pixels (blur, resize of
        // the bitmap by a plugin that then reads pixels) gets a full-size canvas first.
        // POCKETMZ_WIN_SCALE=off disables it; window.PMZ_WIN_OFF = true for A/B in a running game.
        const WIN_ENV = String((window.process && process.env && process.env.POCKETMZ_WIN_SCALE) || "auto");
        if (WIN_ENV !== "off" && window.Window_Base) {
            let winDepth = 0;
            const winScale = () => {
                const R = Graphics.app && Graphics.app.renderer, r = R && R.resolution;
                return r && r <= 0.9 && !window.PMZ_WIN_OFF ? r : 0;
            };
            const pin = (b) => {   // texture size in game units = _pmzW x _pmzH whatever PIXI recomputes
                const bt = b._baseTexture;
                if (!bt || bt._pmzPinned) return;
                bt._pmzPinned = true;
                const _setReal = bt.setRealSize;
                bt.setRealSize = function() {
                    _setReal.apply(this, arguments);
                    if (b._pmzCS) { this.width = b._pmzW; this.height = b._pmzH; }
                    return this;
                };
            };
            const scaleCanvas = (b, w, h) => {   // (re)size the canvas of scaled bitmap b to w x h game px
                const k = b._pmzCS;
                b._pmzW = w; b._pmzH = h;
                b._canvas.width = Math.max(1, Math.ceil(w * k));
                b._canvas.height = Math.max(1, Math.ceil(h * k));
                b._context.setTransform(k, 0, 0, k, 0, 0);   // reset by every size change
                const bt = b._baseTexture;
                if (bt) {
                    bt.setResolution ? bt.setResolution(k) : (bt.resolution = k);
                    bt.setRealSize(b._canvas.width, b._canvas.height, k);
                    bt.update();
                }
            };
            const _createCanvas = B._createCanvas;
            B._createCanvas = function(width, height) {
                const k = winDepth > 0 && width > 0 && height > 0 ? winScale() : 0;
                if (!k) return _createCanvas.apply(this, arguments);
                _createCanvas.call(this, 1, 1);
                this._pmzCS = k;
                pin(this);
                scaleCanvas(this, width, height);
                PMZ_IMG.winCount = (PMZ_IMG.winCount || 0) + 1;
                PMZ_IMG.winSaved = (PMZ_IMG.winSaved || 0) + width * height - this._canvas.width * this._canvas.height;
            };
            // back to a full-size canvas (same texture object, sprites keep it)
            const unscale = (b) => {
                if (!b._pmzCS || !b._canvas) return;
                const w = b._pmzW, h = b._pmzH, old = b._canvas;
                const c = document.createElement("canvas");
                c.width = w; c.height = h;
                const ctx = c.getContext("2d");
                ctx.imageSmoothingEnabled = true;
                ctx.drawImage(old, 0, 0, w, h);
                b._pmzCS = 0;
                b._canvas = c; b._context = ctx;
                const bt = b._baseTexture;
                if (bt) {
                    bt.setResolution ? bt.setResolution(1) : (bt.resolution = 1);
                    if (bt.setResource && PIXI.resources && PIXI.resources.CanvasResource) {
                        bt.setResource(new PIXI.resources.CanvasResource(c));
                    } else if (bt.resource) {
                        bt.resource.source = c;
                    }
                    bt.setRealSize(w, h, 1);
                    bt.update();
                }
                old.width = old.height = 0;
                PMZ_IMG.winUnscaled = (PMZ_IMG.winUnscaled || 0) + 1;
            };
            const _createContents = Window_Base.prototype.createContents;
            Window_Base.prototype.createContents = function() {
                winDepth++;
                try { return _createContents.apply(this, arguments); } finally { winDepth--; }
            };
            for (const [prop, key] of [["width", "_pmzW"], ["height", "_pmzH"]]) {
                const d = Object.getOwnPropertyDescriptor(B, prop);
                Object.defineProperty(B, prop, {
                    get: function() { return this._pmzCS && this._canvas ? this[key] : d.get.call(this); },
                    configurable: true
                });
            }
            const _resize = B.resize;
            B.resize = function(width, height) {
                if (!this._pmzCS || !this._canvas) return _resize.apply(this, arguments);
                scaleCanvas(this, Math.max(width || 0, 1), Math.max(height || 0, 1));
            };
            // blt from a scaled bitmap: the source rectangle is in game px
            const _blt2 = B.blt;
            B.blt = function(source, sx, sy, sw, sh, dx, dy, dw, dh) {
                if (source && source._pmzCS && source._canvas) {
                    const k = source._pmzCS;
                    dw = dw || sw; dh = dh || sh;
                    try {
                        this.context.globalCompositeOperation = "source-over";
                        this.context.drawImage(source._canvas, sx * k, sy * k, sw * k, sh * k, dx, dy, dw, dh);
                        this._baseTexture.update();
                    } catch (e) { /* as the stock blt */ }
                    return;
                }
                return _blt2.apply(this, arguments);
            };
            const cpixel = (b, x, y) => b._context.getImageData(
                Math.min(b._canvas.width - 1, Math.floor(x * b._pmzCS)), Math.min(b._canvas.height - 1, Math.floor(y * b._pmzCS)), 1, 1).data;
            const _getPixel2 = B.getPixel, _getAlpha2 = B.getAlphaPixel;
            B.getPixel = function(x, y) {
                if (!this._pmzCS || !this._canvas) return _getPixel2.apply(this, arguments);
                const d = cpixel(this, x, y);
                return "#" + [0, 1, 2].map(i => d[i].toString(16).padZero(2)).join("");
            };
            B.getAlphaPixel = function(x, y) {
                return this._pmzCS && this._canvas ? cpixel(this, x, y)[3] : _getAlpha2.apply(this, arguments);
            };
            if (B.blur) {
                const _blur = B.blur;
                B.blur = function() { unscale(this); return _blur.apply(this, arguments); };
            }
            PMZ_IMG.unscaleWindow = unscale;
        }
    }
