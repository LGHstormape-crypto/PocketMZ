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
