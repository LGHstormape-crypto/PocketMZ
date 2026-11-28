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

    // 4. Off-screen & empty-graphic character sprites (same as PocketMZ_Handheld.js section 9)
    const CULL_X = 200, CULL_TOP = 48, CULL_BOTTOM = 400, CULL_REFRESH = 15;
    const EMPTY_CHAR_SKIP = String((window.process && process.env && process.env.POCKETMZ_EMPTY_CHAR_SKIP) || "on").toLowerCase() !== "off";
    if (window.Sprite_Character) {
        const _update = Sprite_Character.prototype.update;
        Sprite_Character.prototype.update = function() {
            const c = this._character;
            if (EMPTY_CHAR_SKIP && c && typeof c.characterName === "function" &&
                !c.characterName() && !c.tileId() && !c._animationId && !c._balloonId &&
                (!this._animationSprites || this._animationSprites.length === 0) &&
                !this._balloonSprite && (!this.children || this.children.length === 0) &&
                this._characterName === "" && !this._tileId) {
                if (!this._gkdEmpty) { this._gkdEmpty = true; this._gkdEmptySkip = (this.spriteId || 0) % CULL_REFRESH; }
                this.visible = false;
                if (++this._gkdEmptySkip % CULL_REFRESH === 0) {
                    _update.call(this);
                    if (!c.characterName() && !c.tileId()) this.visible = false;
                }
                return;
            }
            this._gkdEmpty = false;
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
