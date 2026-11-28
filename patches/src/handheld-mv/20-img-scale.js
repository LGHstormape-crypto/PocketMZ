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
            let c = null, rt = null;
            try {
                const w = Graphics.width, h = Graphics.height;
                rt = PIXI.RenderTexture.create(w, h, undefined, r);
                R.render(stage, rt);
                stage.worldTransform.identity();
                c = R.extract.canvas(rt);
                rt.destroy(true);
                rt = null;
                const bitmap = new Bitmap(1, 1);
                if (bitmap.__canvas) { bitmap.__canvas.width = 0; bitmap.__canvas.height = 0; }
                bitmap.__canvas = null; bitmap.__context = null; bitmap.__baseTexture = null;
                adopt(bitmap, c, w, h);
                PMZ_IMG.snaps = (PMZ_IMG.snaps || 0) + 1;
                return bitmap;
            } catch (e) {
                if (rt) { try { rt.destroy(true); } catch (e2) {} }
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
