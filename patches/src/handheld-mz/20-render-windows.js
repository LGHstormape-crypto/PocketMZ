    // 8. Frame rate option
    const FPS_KEY = "gkdFrameRate";
    const fpsLabel = () => {   // option text in the game's language
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
    const _addGeneralOptions = Window_Options.prototype.addGeneralOptions;
    Window_Options.prototype.addGeneralOptions = function() {
        _addGeneralOptions.call(this);
        this.addCommand(fpsLabel(), FPS_KEY);
    };
    const _statusText = Window_Options.prototype.statusText;
    Window_Options.prototype.statusText = function(index) {
        return this.commandSymbol(index) === FPS_KEY ? String(ConfigManager[FPS_KEY]) : _statusText.call(this, index);
    };
    const _processOk = Window_Options.prototype.processOk;
    Window_Options.prototype.processOk = function() {
        if (this.commandSymbol(this.index()) === FPS_KEY) {
            this.gkdToggleFps();
        } else {
            _processOk.call(this);
        }
    };
    const _cursorRight = Window_Options.prototype.cursorRight;
    Window_Options.prototype.cursorRight = function() {
        if (this.commandSymbol(this.index()) === FPS_KEY) this.gkdToggleFps();
        else _cursorRight.apply(this, arguments);
    };
    const _cursorLeft = Window_Options.prototype.cursorLeft;
    Window_Options.prototype.cursorLeft = function() {
        if (this.commandSymbol(this.index()) === FPS_KEY) this.gkdToggleFps();
        else _cursorLeft.apply(this, arguments);
    };
    Window_Options.prototype.gkdToggleFps = function() {
        ConfigManager[FPS_KEY] = ConfigManager[FPS_KEY] === 60 ? 30 : 60;
        ConfigManager._gkdUserChangedFps = true;
        ConfigManager._gkdSavedFrameRate = ConfigManager[FPS_KEY];
        this.redrawItem(this.findSymbol(FPS_KEY));
        this.playCursorSound();
    };
    let frameNo = 0;
    const _canRender = Graphics._canRender;
    Graphics._canRender = function() {
        frameNo++;
        if (ConfigManager[FPS_KEY] !== 60 && (frameNo & 1)) return false;
        return _canRender.call(this);
    };
    // Window_Options may be taller now; let it scroll if the screen is full.
    const _maxCommands = Scene_Options.prototype.maxCommands;
    Scene_Options.prototype.maxCommands = function() {
        return _maxCommands.call(this) + 1;
    };

    // 9. Off-screen character sprites: not drawn, animation updated every 15th frame.
    //    MZ draws and updates every event's sprite each frame; on big maps most are off
    //    screen (a large town map: 281 of 295), costing ~10 ms per frame. Game logic (movement,
    //    events, sensors) is not affected; the screen test runs every frame, so a sprite
    //    is back to normal the moment it can be seen. Margins cover tall sprites (bosses).
    const CULL_X = 200, CULL_TOP = 48, CULL_BOTTOM = 400, CULL_REFRESH = 15;
    const _Sprite_Character_update = Sprite_Character.prototype.update;
    Sprite_Character.prototype.update = function() {
        const c = this._character;
        if (c && c.screenX) {
            const x = c.screenX(), y = c.screenY();
            const off = x < -CULL_X || x > Graphics.width + CULL_X ||
                        y < -CULL_TOP || y > Graphics.height + CULL_BOTTOM;
            if (off) {
                if (!this._gkdOff) {
                    this._gkdOff = true;
                    this._gkdSkip = this.spriteId % CULL_REFRESH; // spread the refreshes
                }
                // visible=false also skips PIXI's per-frame transform update of the
                // sprite and its children (renderable=false would only skip drawing)
                if (++this._gkdSkip % CULL_REFRESH === 0) _Sprite_Character_update.call(this);
                this.visible = false;
                return;
            }
            this._gkdOff = false; // the normal update below sets visible again
        }
        _Sprite_Character_update.call(this);
    };

    // 10. Menu / battle background snapshot at half size. MZ reads the whole 816x624 frame
    //     back from the GPU (261 ms when opening the menu). The snapshot is only shown
    //     blurred, so half size (1/4 of the read-back) scaled up looks the same. Snapshots
    //     taken inside a menu (Keke_MenuSkin's closing fade) stay full size.
    const SNAP_SCALE = 0.5;
    const _Bitmap_snap = Bitmap.snap;
    Bitmap.snap = function(stage) {
        const renderer = Graphics.app && Graphics.app.renderer;
        if (!stage || !renderer) return _Bitmap_snap.call(this, stage);
        if (SceneManager._scene instanceof Scene_MenuBase) {
            // Inside a menu (Keke_MenuSkin's closing animation): keep full size but skip
            // the read-back entirely; the bitmap's texture is the rendered frame on the GPU.
            const rt = PIXI.RenderTexture.create({ width: Graphics.width, height: Graphics.height });
            renderer.render(stage, rt);
            stage.worldTransform.identity();
            const gpuBitmap = new Bitmap(Graphics.width, Graphics.height);
            gpuBitmap._baseTexture.destroy();
            gpuBitmap._baseTexture = rt.baseTexture;
            gpuBitmap._gkdGpuOnly = true; // its canvas is empty; don't copy pixels from it
            return gpuBitmap;
        }
        const width = Graphics.width, height = Graphics.height;
        const sw = Math.ceil(width * SNAP_SCALE), sh = Math.ceil(height * SNAP_SCALE);
        const bitmap = new Bitmap(width, height);
        const renderTexture = PIXI.RenderTexture.create({ width: sw, height: sh });
        renderer.render(stage, renderTexture, true, new PIXI.Matrix().scale(SNAP_SCALE, SNAP_SCALE));
        stage.worldTransform.identity();
        const canvas = renderer.extract.canvas(renderTexture);
        bitmap.context.imageSmoothingEnabled = true;
        bitmap.context.drawImage(canvas, 0, 0, sw, sh, 0, 0, width, height);
        canvas.width = 0;
        canvas.height = 0;
        renderTexture.destroy(true);
        bitmap.baseTexture.update();
        return bitmap;
    };

    // 11. Blurred snapshot backgrounds baked once. MZ (and plugins copying it) put a
    //     PIXI BlurFilter on the background sprite: ~8 full-screen passes every frame
    //     for a picture that never changes. After a scene is created, such sprites get
    //     a pre-blurred copy of the snapshot and no filter. The snapshot itself is left
    //     as it is for anything else that uses it.
    //     The copy is made at the snapshot's own (display-scale) size when section 17 made it
    //     small, and the previous copy is destroyed when a new snapshot comes: a full-size
    //     copy per menu open (8 MB at 1920x1080, upscaling the small snapshot too) was never
    //     freed and filled RAM + swap after ~20 menu opens.
    const blurredCopies = new WeakMap();
    let lastBlur = null;
    const blurredOf = src => {
        let out = blurredCopies.get(src);
        if (out) return out;
        if (lastBlur && lastBlur.src !== src) {
            try { lastBlur.out.destroy(); } catch (e) { /* gone */ }
            lastBlur = null;
        }
        const w = src.width, h = src.height;
        const smallSrc = src._pmzScale && !src._canvas && src._image;   // downscaled snapshot
        const img = smallSrc || src.canvas;
        const adoptSmall = smallSrc && window.PMZ_IMG && PMZ_IMG.adopt;
        // blur radius 8 game px (4 px at the former half size)
        const t = adoptSmall ? img.width / w : 0.5;
        const sw = Math.max(1, Math.round(w * t)), sh = Math.max(1, Math.round(h * t));
        const tmp = document.createElement("canvas");
        tmp.width = sw;
        tmp.height = sh;
        const ctx = tmp.getContext("2d");
        ctx.filter = "blur(" + Math.max(1, Math.round(8 * t * 10) / 10) + "px)";
        ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, sw, sh);
        if (adoptSmall) {
            out = new Bitmap(1, 1);
            out._destroyCanvas();
            if (out._baseTexture) out._baseTexture.destroy();
            PMZ_IMG.adopt(out, tmp, w, h);   // texture keeps the game size, canvas stays small
        } else {
            out = new Bitmap(w, h);
            out.context.imageSmoothingEnabled = true;
            out.context.drawImage(tmp, 0, 0, sw, sh, 0, 0, w, h);
            tmp.width = tmp.height = 0;
            out.baseTexture.update();
        }
        blurredCopies.set(src, out);
        lastBlur = { src, out };
        return out;
    };
    const bakeBlur = (node, depth) => {
        const snapshot = SceneManager._backgroundBitmap;
        if (!snapshot || !node.children) return;
        for (const child of node.children) {
            const f = child.filters;
            if (child.bitmap === snapshot && !snapshot._gkdGpuOnly &&
                f && f.length === 1 && f[0] instanceof PIXI.filters.BlurFilter) {
                child.bitmap = blurredOf(snapshot);
                child.filters = null;
            } else if (depth < 3) {
                bakeBlur(child, depth + 1);
            }
        }
    };
    const _Scene_Base_start = Scene_Base.prototype.start;
    Scene_Base.prototype.start = function() {
        _Scene_Base_start.apply(this, arguments);
        try { bakeBlur(this, 0); } catch (e) {}
    };

    // 12. Render at screen size. MZ draws at the game's own size (e.g. 1280x720) and the
    //     browser scales the canvas down to the 640x480 screen. Here the PIXI renderer gets
    //     resolution = the display scale, so the WebGL buffer is already screen-sized
    //     (1280x720 -> 640x360: 1/4 of the pixels to fill). Game coordinates are unchanged.
    //     Effekseer sets raw GL viewports in buffer pixels: those are scaled to match.
    //     POCKETMZ_RENDER_SCALE (games/<id>/env): "off" = full size, a number = fixed scale.
    const RS_ENV = String((window.process && process.env && process.env.POCKETMZ_RENDER_SCALE) || "auto");
    if (RS_ENV !== "off" && RS_ENV !== "1") {
        const fixed = parseFloat(RS_ENV);
        const renderScale = g => {
            const s = isFinite(fixed) ? fixed : g._realScale;
            return Math.min(1, Math.max(0.25, Math.round((s || 1) * 1000) / 1000));
        };
        Graphics._updateCanvas = function() {
            const R = this._app && this._app.renderer;
            const r = R ? renderScale(this) : 1;
            if (R && R.resolution !== r) {
                R.resolution = r;
                R.resize(this._width, this._height);
            }
            this._canvas.width = Math.round(this._width * r);
            this._canvas.height = Math.round(this._height * r);
            this._canvas.style.zIndex = 1;
            this._centerElement(this._canvas);
        };
        Graphics._centerElement = function(element) {
            // element.width is the buffer size; the shown size comes from the game size
            const scaled = element === this._canvas;
            const width = (scaled ? this._width : element.width) * this._realScale;
            const height = (scaled ? this._height : element.height) * this._realScale;
            element.style.position = "absolute";
            element.style.margin = "auto";
            element.style.top = 0;
            element.style.left = 0;
            element.style.right = 0;
            element.style.bottom = 0;
            element.style.width = width + "px";
            element.style.height = height + "px";
        };
        // Filters keep their own resolution (PIXI default 1): a filtered container (MZ's map
        // tone, battle/picture filters, plugin filters) would be drawn offscreen at full game
        // size again. Measured on a night map (1280x720 game, tone [-68,-68,0,68]): GPU busy
        // 84% / 11 fps at filter resolution 1, 20% / 30 fps at the renderer's 0.5.
        const FS = PIXI.systems && PIXI.systems.FilterSystem && PIXI.systems.FilterSystem.prototype;
        if (FS && FS.push) {
            const _push = FS.push;
            FS.push = function(target, filters) {
                const r = this.renderer.resolution;
                if (r < 1 && filters && !window.PMZ_FILTER_RES_OFF) {   // dev switch for A/B
                    for (const f of filters) if (f && f.resolution > r) f.resolution = r;
                }
                return _push.apply(this, arguments);
            };
        }
    }
    // 12b. Effekseer projection & viewport: stock MZ assumes Spriteset_Base always renders
    //      into an offscreen FBO (via its always-on ColorFilter), where Y=0 is at the top and
    //      projection uses y=-1. Section 6 skips neutral ColorFilter so the scene draws straight
    //      to the default framebuffer (Y=0 at bottom, +Y up): flip projection y and viewport Y
    //      when not in a RenderTexture so animations match stock orientation and position.
    if (window.Sprite_Animation) {
        const A = Sprite_Animation.prototype;
        A.setProjectionMatrix = function(renderer) {
            const inFbo = !!(renderer.renderTexture && renderer.renderTexture.current);
            const x = this._mirror ? -1 : 1;
            const y = inFbo ? -1 : 1;
            const p = -(this._viewportSize / Graphics.height);
            Graphics.effekseer.setProjectionMatrix([x, 0, 0, 0, 0, y, 0, 0, 0, 0, 1, p, 0, 0, 0, 1]);
        };
        A.setViewport = function(renderer) {
            const r = renderer.resolution || 1;
            const inFbo = !!(renderer.renderTexture && renderer.renderTexture.current);
            const vw = this._viewportSize, vh = this._viewportSize;
            const vx = this._animation.offsetX - vw / 2;
            const vy = this._animation.offsetY - vh / 2;
            let pos;
            if (this._animation.displayType === 2) pos = { x: Graphics.width / 2, y: Graphics.height / 2 };
            else pos = this.targetPosition(renderer);
            const gx = (vx + pos.x) * r;
            const gy = inFbo ? (vy + pos.y) * r : renderer.view.height - (vy + pos.y + vh) * r;
            renderer.gl.viewport(gx, gy, vw * r, vh * r);
        };
    }

    // 13. Status sprites (gauges, names, state icons) of hidden or closed windows are not
    //     updated. MZ battles keep Window_BattleActor (a hidden copy of the status window)
    //     and closed status windows updating every gauge every frame: each reads HP/MP/TP and
    //     their maxima (slow in plugin-heavy games). Measured 1.1-3.2 ms per battle frame in
    //     three games for the hidden window alone. When the window shows again, a gauge that
    //     was skipped longer than its smoothing time shows the current value at once - what
    //     the stock gauge would show after finishing its animation while hidden.
    if (window.Window_StatusBase && Window_StatusBase.prototype.createInnerSprite) {
        const _createInnerSprite = Window_StatusBase.prototype.createInnerSprite;
        Window_StatusBase.prototype.createInnerSprite = function() {
            const sprite = _createInnerSprite.apply(this, arguments);
            if (sprite && !sprite._gkdWin) sprite._gkdWin = this;
            return sprite;
        };
        const hiddenWin = w => !w.visible || w.openness <= 0;
        const skipWhileHidden = (cls, onResume) => {
            if (!cls || typeof cls.prototype.update !== "function") return;
            const _update = cls.prototype.update;
            cls.prototype.update = function() {
                const w = this._gkdWin;
                if (w && hiddenWin(w)) { this._gkdSkip = (this._gkdSkip || 0) + 1; return; }
                if (this._gkdSkip) {
                    const n = this._gkdSkip;
                    this._gkdSkip = 0;
                    if (onResume) onResume.call(this, n);
                }
                _update.apply(this, arguments);
            };
        };
        skipWhileHidden(window.Sprite_Gauge, function(skipped) {
            if (skipped < this.smoothness()) return;
            if (this._duration > 0) {
                this._value = this._targetValue;
                this._maxValue = this._targetMaxValue;
                this._duration = 0;
                this.redraw();
            }
            // a changed value is taken over directly (updateTargetValue with no old value)
            if (this.currentValue() !== this._targetValue || this.currentMaxValue() !== this._targetMaxValue) this._value = NaN;
        });
        skipWhileHidden(window.Sprite_Name);
        skipWhileHidden(window.Sprite_StateIcon);
    }

    // 14. Window contents clipped with a scissor rectangle. MZ puts an AlphaFilter (alpha 1)
    //     with a filterArea on every window's client area just to clip the contents to the
    //     window: an offscreen render + composite per open window per frame (~0.6-2 ms CPU
    //     each here). When the window draws straight to the screen, the same clip is done with
    //     the GL scissor test. Anything unusual (offscreen target such as a fade or snapshot,
    //     another mask, rotation, changed filter, ADD/MULTIPLY... children whose blending
    //     would differ without the offscreen pass) uses the stock filter path.
    if (window.Window && Window.prototype._createClientArea && PIXI.filters && PIXI.filters.AlphaFilter) {
        const NORMAL = PIXI.BLEND_MODES.NORMAL;
        const plainBlend = c => {
            if (c.blendMode !== undefined && c.blendMode !== NORMAL) return false;
            const ch = c.children;
            if (ch) for (let i = 0; i < ch.length; i++) if (ch[i].visible && !plainBlend(ch[i])) return false;
            return true;
        };
        const containerRender = PIXI.Container.prototype.render;
        const clippedRender = function(renderer) {
            const f = this.filters;
            if (window.PMZ_WINCLIP_OFF || !this.visible || this.worldAlpha <= 0 || !this.renderable ||
                this._mask || !f || f.length !== 1 || f[0] !== this._gkdAlphaFilter || f[0].alpha !== 1 ||
                renderer.renderTexture.current || (renderer.mask.maskStack && renderer.mask.maskStack.length)) {
                return containerRender.call(this, renderer);
            }
            const wt = this.worldTransform, fa = this.filterArea;
            if (!fa || wt.b || wt.c || fa.width <= 0 || fa.height <= 0) return containerRender.call(this, renderer);
            for (let i = 0; i < this.children.length; i++) {
                const c = this.children[i];
                if (c.visible && !plainBlend(c)) return containerRender.call(this, renderer);
            }
            const gl = renderer.gl, r = renderer.resolution;
            // same pixel frame as PIXI's filter area (Rectangle.ceil: outward, eps 0.001)
            const x0 = Math.max(0, Math.floor((fa.x + 0.001) * r)), y0 = Math.max(0, Math.floor((fa.y + 0.001) * r));
            const x1 = Math.ceil((fa.x + fa.width - 0.001) * r), y1 = Math.ceil((fa.y + fa.height - 0.001) * r);
            if (x1 <= x0 || y1 <= y0) return;
            renderer.batch.flush();
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(x0, renderer.view.height - y1, x1 - x0, y1 - y0);
            try {
                this._render(renderer);
                for (let i = 0; i < this.children.length; i++) this.children[i].render(renderer);
                renderer.batch.flush();
            } finally {
                gl.disable(gl.SCISSOR_TEST);
            }
        };
        const _createClientArea = Window.prototype._createClientArea;
        Window.prototype._createClientArea = function() {
            _createClientArea.apply(this, arguments);
            const ca = this._clientArea;
            const f = ca && ca.filters;
            if (f && f.length === 1 && f[0] instanceof PIXI.filters.AlphaFilter && ca.filterArea) {
                ca._gkdAlphaFilter = f[0];
                ca.render = clippedRender;
            }
        };
    }

    // 15. Window backgrounds with a tone (any game that changes the window color) go through
    //     a ColorFilter pass per window per frame (~0.85 ms CPU each). The background only
    //     changes when the window is resized, re-toned or re-skinned, so it is drawn (with the
    //     filter) into a texture during update and that texture is drawn instead. Any change
    //     of skin, frame, size, opacity, tone, tiling or resolution rebuilds it; a window whose
    //     background keeps changing, or that has extra children/filters on its background,
    //     is drawn the stock way.
    if (window.Window && Window.prototype._createBackSprite && Window.prototype.update) {
        const backEligible = b => b && !b._destroyed && b._bitmap && b._bitmap.isReady() &&
            b.children.length === 1 && b.children[0] instanceof TilingSprite &&
            b.filters && b.filters.length === 1 && b.filters[0] === b._colorFilter && b._colorFilter.enabled &&
            !b._mask && b.scale.x > 0 && b.scale.y > 0 && b.rotation === 0 && b.skew.x === 0 && b.skew.y === 0 &&
            b.pivot.x === 0 && b.pivot.y === 0 && b.anchor.x === 0 && b.anchor.y === 0;
        const backMatches = (c, b, r) => {
            const t = b.children[0], f = b._frame, tf = t._frame, u = b._colorFilter.uniforms, bt = b._bitmap._baseTexture;
            const ct = u.colorTone, bc = u.blendColor;
            return c.r === r && c.fx === f.x && c.fy === f.y && c.fw === f.width && c.fh === f.height &&
                c.bsx === b.scale.x && c.bsy === b.scale.y && c.ba === b.alpha && c.bm === b.blendMode &&
                c.did === (bt ? bt.dirtyId : 0) && c.hue === u.hue && c.br === u.brightness &&
                c.ct0 === ct[0] && c.ct1 === ct[1] && c.ct2 === ct[2] && c.ct3 === ct[3] &&
                c.bc0 === bc[0] && c.bc1 === bc[1] && c.bc2 === bc[2] && c.bc3 === bc[3] &&
                c.tfx === tf.x && c.tfy === tf.y && c.tfw === tf.width && c.tfh === tf.height &&
                c.tx === t.x && c.ty === t.y && c.tw === t._width && c.th === t._height &&
                c.tsx === t.scale.x && c.tsy === t.scale.y && c.tox === t.origin.x && c.toy === t.origin.y &&
                c.ta === t.alpha && c.tv === t.visible && c.same === (t._bitmap === b._bitmap);
        };
        const backSave = (c, b, r) => {
            const t = b.children[0], f = b._frame, tf = t._frame, u = b._colorFilter.uniforms, bt = b._bitmap._baseTexture;
            const ct = u.colorTone, bc = u.blendColor;
            c.r = r; c.fx = f.x; c.fy = f.y; c.fw = f.width; c.fh = f.height;
            c.bsx = b.scale.x; c.bsy = b.scale.y; c.ba = b.alpha; c.bm = b.blendMode;
            c.did = bt ? bt.dirtyId : 0; c.hue = u.hue; c.br = u.brightness;
            c.ct0 = ct[0]; c.ct1 = ct[1]; c.ct2 = ct[2]; c.ct3 = ct[3];
            c.bc0 = bc[0]; c.bc1 = bc[1]; c.bc2 = bc[2]; c.bc3 = bc[3];
            c.tfx = tf.x; c.tfy = tf.y; c.tfw = tf.width; c.tfh = tf.height;
            c.tx = t.x; c.ty = t.y; c.tw = t._width; c.th = t._height;
            c.tsx = t.scale.x; c.tsy = t.scale.y; c.tox = t.origin.x; c.toy = t.origin.y;
            c.ta = t.alpha; c.tv = t.visible; c.same = t._bitmap === b._bitmap;
        };
        const releaseBack = b => {
            const c = b._gkdBack;
            if (c) { b._gkdBack = null; c.sprite.destroy(); c.rt.destroy(true); }
        };
        const buildBack = (win, b) => {
            const R = Graphics.app && Graphics.app.renderer;
            if (!R || window.PMZ_BACKCACHE_OFF || !backEligible(b)) { releaseBack(b); return; }
            const c = b._gkdBack;
            if (!win.visible || win.openness <= 0) return;          // build when it is shown
            if (c && c.bitmap === b._bitmap && backMatches(c, b, R.resolution)) return;
            const fc = Graphics.frameCount;
            b._gkdBuilds = (b._gkdBuilds || []).filter(n => fc - n < 60);
            if (b._gkdBuilds.length >= 3) { releaseBack(b); b._gkdNoCache = true; return; }   // keeps changing
            b._gkdBuilds.push(fc);
            const w = Math.ceil(b._frame.width * b.scale.x), h = Math.ceil(b._frame.height * b.scale.y);
            if (w <= 0 || h <= 0) { releaseBack(b); return; }
            let rt = c && c.rt;
            if (!rt || rt.width !== w || rt.height !== h || rt.baseTexture.resolution !== R.resolution) {
                releaseBack(b);
                rt = PIXI.RenderTexture.create({ width: w, height: h, resolution: R.resolution });
            }
            const x = b.x, y = b.y;
            b.position.set(0, 0);
            b._gkdBuilding = true;
            try { R.render(b, rt, true); } finally { b.position.set(x, y); b._gkdBuilding = false; }
            const sprite = (c && c.rt === rt) ? c.sprite : new PIXI.Sprite(rt);
            const nc = c && c.rt === rt ? c : { bitmap: b._bitmap, rt, sprite };
            nc.bitmap = b._bitmap;
            backSave(nc, b, R.resolution);
            b._gkdBack = nc;
        };
        const containerRender = PIXI.Container.prototype.render;
        const backRender = function(renderer) {
            if (!this.visible || this.worldAlpha <= 0 || !this.renderable) return;
            const c = this._gkdBack;
            if (!c || this._gkdBuilding || window.PMZ_BACKCACHE_OFF || this._gkdNoCache || c.bitmap !== this._bitmap ||
                !backEligible(this) || !backMatches(c, this, renderer.resolution)) {
                return containerRender.call(this, renderer);
            }
            // cached picture is in the parent's units, placed at the background's position;
            // its own opacity is already in it, the parents' opacity is applied here
            const s = c.sprite, p = this.parent.worldTransform, m = s.transform.worldTransform;
            m.a = p.a; m.b = p.b; m.c = p.c; m.d = p.d;
            m.tx = p.a * this.x + p.c * this.y + p.tx;
            m.ty = p.b * this.x + p.d * this.y + p.ty;
            s.transform._worldID++;
            s.worldAlpha = this.parent.worldAlpha;
            s.blendMode = this.blendMode;
            s._render(renderer);
        };
        const _createBackSprite = Window.prototype._createBackSprite;
        Window.prototype._createBackSprite = function() {
            _createBackSprite.apply(this, arguments);
            const b = this._backSprite;
            if (b) {
                b.render = backRender;
                const destroy = b.destroy;
                b.destroy = function() { releaseBack(this); return destroy.apply(this, arguments); };
            }
        };
        const _windowUpdate = Window.prototype.update;
        Window.prototype.update = function() {
            _windowUpdate.apply(this, arguments);
            if (!this.visible || this.openness <= 0) return;
            const b = this._backSprite;
            if (b && b.render === backRender && !b._gkdNoCache) buildBack(this, b);
        };
    }

    // 15b. Window_Scrollable.processWheelScroll calls isTouchedInsideFrame() (allocating Point +
    //      Rectangle + worldTransform.applyInverse) for every scrollable window on every logic frame
    //      even when TouchInput.wheelY is 0. Short-circuit when |wheelY| < 20 (identical threshold).
    if (window.Window_Scrollable && Window_Scrollable.prototype.processWheelScroll) {
        const _pws = Window_Scrollable.prototype.processWheelScroll;
        Window_Scrollable.prototype.processWheelScroll = function() {
            if (Math.abs(TouchInput.wheelY) < 20) return;
            return _pws.call(this);
        };
    }

    // 16. WindowLayer: the stock layer draws each open window's rectangle into the stencil
    //     with a new PIXI.Graphics (clear, drawShape, render: ~0.45 ms per window). For stock
    //     rectangular windows drawn to the screen, the same stencil value is written with a
    //     scissored stencil clear. A layer or window whose code is not the stock one, a
    //     scaled/rotated layer or an offscreen target uses the stock code.
    if (window.WindowLayer && WindowLayer.prototype.render && window.Window && Window.prototype.drawShape) {
        const src = String(WindowLayer.prototype.render);
        const stockLayer = ["new PIXI.Graphics()", "win.drawShape(graphics)", "gl.stencilFunc(gl.ALWAYS, 1, ~0)",
            "graphics.render(renderer)", "gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)", "!child._isWindow && child.visible"]
            .every(s => src.includes(s));
        const stockShape = Window.prototype.drawShape;
        if (stockLayer && String(stockShape).includes("drawRoundedRect(x, y, width, height, 0)")) {
            const _layerRender = WindowLayer.prototype.render;
            WindowLayer.prototype.render = function(renderer) {
                if (!this.visible) return;
                const wt = this.worldTransform;
                if (window.PMZ_WLSTENCIL_OFF || renderer.renderTexture.current || wt.a !== 1 || wt.d !== 1 || wt.b || wt.c ||
                    this.children.some(w => w._isWindow && w.visible && w.openness > 0 && w.drawShape !== stockShape)) {
                    return _layerRender.call(this, renderer);
                }
                const gl = renderer.gl, r = renderer.resolution, H = renderer.view.height;
                const children = this.children.slice();
                renderer.framebuffer.forceStencil();
                renderer.batch.flush();
                gl.enable(gl.STENCIL_TEST);
                while (children.length > 0) {
                    const win = children.pop();
                    if (win._isWindow && win.visible && win.openness > 0) {
                        gl.stencilFunc(gl.EQUAL, 0, ~0);
                        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
                        win.render(renderer);
                        renderer.batch.flush();
                        // stock: rectangle (x, y + (height - h) / 2, width, h) with h = height * openness / 255
                        const h = (win.height * win.openness) / 255;
                        const x = wt.tx + win.x, y = wt.ty + win.y + (win.height - h) / 2;
                        // pixels whose centre is inside, left/top edge included (GL rasterization)
                        const px = v => Math.ceil(v * r - 0.5);
                        const x0 = px(x), x1 = px(x + win.width), y0 = px(y), y1 = px(y + h);
                        if (x1 > x0 && y1 > y0) {
                            gl.enable(gl.SCISSOR_TEST);
                            gl.scissor(x0, H - y1, x1 - x0, y1 - y0);
                            gl.clearStencil(1);
                            gl.clear(gl.STENCIL_BUFFER_BIT);
                            gl.disable(gl.SCISSOR_TEST);
                        }
                        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                    }
                }
                gl.disable(gl.STENCIL_TEST);
                gl.clearStencil(0);
                gl.clear(gl.STENCIL_BUFFER_BIT);
                renderer.batch.flush();
                for (const child of this.children) {
                    if (!child._isWindow && child.visible) child.render(renderer);
                }
                renderer.batch.flush();
            };
        }
    }
