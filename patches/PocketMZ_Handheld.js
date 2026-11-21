/*:
 * @target MZ
 * @plugindesc PocketMZ handheld fixes for RPG Maker MZ (load last).
 * @author PocketMZ (MIT)
 *
 * @help
 * Loaded after all other plugins. Does not modify other plugin files.
 * 1. Window: never resize the window (keeps the Wayland window fullscreen).
 * 2. Input: the pad is read by gptokeyb as keys; the browser Gamepad API is ignored.
 * 3. Preload: back to the stock MZ preload (faces/pictures in the first 200
 *    commands). PANDA_ResourcePreLoad loaded every resource of a whole event
 *    and Scene_Map waits for all of them -> endless spinner + out of memory.
 * 4. Image cache budget: MZ never drops cached images while playing. On every
 *    scene change the least recently used images beyond the budget are
 *    dropped from the cache (not destroyed: anything still holding one keeps
 *    a working bitmap; GC and PIXI's texture GC free the rest).
 *    A full GC follows (window.gc, --expose-gc) so the dropped images' decoded pixels
 *    are really freed; the budget is also checked every 60 s inside one scene.
 * 5. PIXI texture GC runs sooner (GPU memory is system RAM on this device).
 * 6. ColorFilter (tone / flash / fade) is skipped while it is neutral. MZ keeps
 *    three of them on screen; each one is a full-screen offscreen pass per frame.
 * 7. Audio: the AudioContext runs at 24 kHz. decodeAudioData() decodes to the
 *    context rate, so every decoded BGM/BGS/SE takes half the memory (a 160 s
 *    stereo BGM: 59 MB -> 29 MB) and half the decode time.
 *    Set AUDIO_SAMPLE_RATE to 0 for the browser default (48 kHz).
 * 8. Frame rate option (Options menu, "画面フレームレート" 30/60, default 30):
 *    game logic always runs 60 times a second, at 30 only every second frame
 *    is drawn. Most of the cost on this device is per drawn frame (Chromium
 *    compositing + ~800 display objects), so 30 saves ~1/3 of the CPU and
 *    gives steady pacing instead of 45-50 fps with jitter.
 * 9. Off-screen character sprites are not drawn and their animation is refreshed
 *    every 15th frame only (game logic is untouched).
 * 10. Menu/battle background snapshots are taken at half size (1/4 GPU read-back).
 * 11. Blurred snapshot backgrounds are blurred once on the CPU instead of a
 *    BlurFilter running every frame.
 * 12. The renderer draws at screen size (resolution = display scale): a 1280x720
 *    game fills 640x360 pixels instead of 1280x720; filters (map tone etc.) follow it.
 *    POCKETMZ_RENDER_SCALE=off disables.
 * 13. Gauges / names / state icons of hidden or closed status windows (e.g. the
 *    hidden Window_BattleActor in battle) are not updated; they catch up when shown.
 * 14-16. Windows: contents clipped by scissor instead of an AlphaFilter pass, toned
 *    backgrounds drawn from a cached texture, stencil shapes written by scissored clears.
 */

(() => {
    "use strict";
    // Written against RPG Maker MZ 1.x internals; MV games get PocketMZ_HandheldMV.js instead.
    if (!window.Utils || Utils.RPGMAKER_NAME !== "MZ") return;

    const IMAGE_BUDGET_PX = 16 * 1024 * 1024; // ~64 MB of RGBA (protected map images not counted out)
    const TEXTURE_GC_MAX_IDLE = 900;          // frames (~15 s), PIXI default 3600
    const AUDIO_SAMPLE_RATE = 24000;          // 0 = browser default

    // 1. Window
    Scene_Boot.prototype.adjustWindow = function() {};
    // No page scrollbars: the game is one canvas sized to the screen, but other elements sized
    // for a PC window (e.g. an error screen plugin's 1152 px error box) overflow the 640x480
    // screen and the browser shows scrollbars over the game.
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

    // 2. Input
    Input._updateGamepadState = function() {};

    // 3. Preload (stock MZ 1.10 Game_Interpreter.loadImages)
    Game_Interpreter.prototype.loadImages = function() {
        const list = this._list.slice(0, 200);
        for (const command of list) {
            switch (command.code) {
                case 101: // Show Text
                    ImageManager.loadFace(command.parameters[0]);
                    break;
                case 231: // Show Picture
                    ImageManager.loadPicture(command.parameters[1]);
                    break;
            }
        }
    };

    // 4. Image cache budget
    const lastUse = new Map();
    let useTick = 0;
    const _loadBitmapFromUrl = ImageManager.loadBitmapFromUrl;
    ImageManager.loadBitmapFromUrl = function(url) {
        lastUse.set(url, ++useTick);
        return _loadBitmapFromUrl.call(this, url);
    };

    const bitmapPixels = bitmap => (bitmap && bitmap.isReady() ? bitmap.width * bitmap.height : 0);

    // Never drop what the current map needs: menus and battles return to it, and reloading
    // tilesets / standing pictures from the SD card took 0.7-5 s each when closing a menu.
    const imageUrl = (folder, name) => "img/" + folder + "/" + Utils.encodeURI(name) + ".png";
    const protectedUrls = () => {
        const set = new Set();
        try {
            if (window.$gameMap && $gameMap.mapId() > 0) {
                const tileset = $gameMap.tileset();
                if (tileset) for (const n of tileset.tilesetNames) if (n) set.add(imageUrl("tilesets", n));
                if ($gameMap.parallaxName()) set.add(imageUrl("parallaxes", $gameMap.parallaxName()));
                const chars = [$gamePlayer, ...$gamePlayer.followers()._data, ...$gameMap.events()];
                for (const c of chars) if (c && c.characterName()) set.add(imageUrl("characters", c.characterName()));
            }
            if (window.$gameParty) {
                for (const a of $gameParty.members()) {
                    if (a.faceName()) set.add(imageUrl("faces", a.faceName()));
                    if (a.characterName()) set.add(imageUrl("characters", a.characterName()));
                }
            }
        } catch (e) {}
        return set;
    };

    ImageManager.gkdTrimCache = function(budget = IMAGE_BUDGET_PX) {
        const cache = this._cache;
        const urls = Object.keys(cache);
        let total = 0;
        for (const url of urls) total += bitmapPixels(cache[url]);
        if (total <= budget) return 0;
        const target = budget * 0.7;
        const keep = protectedUrls();
        urls.sort((a, b) => (lastUse.get(a) || 0) - (lastUse.get(b) || 0));
        let dropped = 0;
        for (const url of urls) {
            if (total <= target) break;
            const bitmap = cache[url];
            if (!bitmap.isReady() || keep.has(url)) continue; // loading, or the map needs it
            total -= bitmapPixels(bitmap);
            delete cache[url];
            lastUse.delete(url);
            dropped++;
        }
        return dropped;
    };

    // Dropped images keep their decoded pixels (several MB each) alive until V8 collects the
    // Image objects, but the JS heap is tiny (~45 MB) so a major GC rarely happens on its own.
    // With --expose-gc (pocketmz-run.sh) run one right after a scene change that dropped images.
    let gcPending = false;
    const runGc = () => {
        gcPending = false;
        if (typeof window.gc === "function") window.gc();
    };
    const _Scene_Base_create = Scene_Base.prototype.create;
    Scene_Base.prototype.create = function() {
        // Filter render targets are pooled per size and never released (34 pooled after
        // a few battles); between scenes none are in use, so drop them.
        try {
            const pool = Graphics.app && Graphics.app.renderer.filter.texturePool;
            if (pool) pool.clear(true);
        } catch (e) {}
        if (ImageManager.gkdTrimCache() > 0 && !gcPending) {
            gcPending = true;
            setTimeout(runGc, 500); // after the old scene's sprites are gone
        }
        _Scene_Base_create.call(this);
    };
    // Long stays in one scene (maps): check the budget every 60 s as well.
    setInterval(() => {
        const scene = window.SceneManager && SceneManager._scene;
        if (scene && !SceneManager.isSceneChanging() && ImageManager.gkdTrimCache() > 0) runGc();
    }, 60000);

    // 5. PIXI texture GC
    const _createPixiApp = Graphics._createPixiApp;
    Graphics._createPixiApp = function() {
        _createPixiApp.call(this);
        const gc = this._app && this._app.renderer && this._app.renderer.textureGC;
        if (gc) {
            gc.maxIdle = TEXTURE_GC_MAX_IDLE;
            gc.checkCountMax = 300;
        }
    };

    // 6. ColorFilter: enabled only when it changes something
    const isNeutral = u => {
        const t = u.colorTone, b = u.blendColor;
        return (Number(u.hue) || 0) % 360 === 0 &&
            (!t || (!t[0] && !t[1] && !t[2] && !t[3])) &&
            (!b || !b[3]) &&
            (u.brightness === undefined || Number(u.brightness) >= 255);
    };
    Object.defineProperty(ColorFilter.prototype, "enabled", {
        configurable: true,
        get() { return this._gkdEnabled !== false && !(this.uniforms && isNeutral(this.uniforms)); },
        set(value) { this._gkdEnabled = value; }
    });

    // 8. Frame rate option
    const FPS_KEY = "gkdFrameRate";
    const fpsLabel = () => {   // option text in the game's language
        const loc = String((window.$dataSystem && $dataSystem.locale) || "ja");
        return loc.startsWith("ja") ? "画面フレームレート" : loc.startsWith("zh") ? "画面帧率" : "Frame Rate";
    };
    // default for games whose config has no choice yet: PocketMZ settings (POCKETMZ_DEFAULT_FPS)
    const DEFAULT_FPS = window.process && process.env && process.env.POCKETMZ_DEFAULT_FPS === "60" ? 60 : 30;
    ConfigManager[FPS_KEY] = DEFAULT_FPS;
    const _makeData = ConfigManager.makeData;
    ConfigManager.makeData = function() {
        const config = _makeData.call(this);
        config[FPS_KEY] = this[FPS_KEY];
        return config;
    };
    const _applyData = ConfigManager.applyData;
    ConfigManager.applyData = function(config) {
        _applyData.call(this, config);
        this[FPS_KEY] = config[FPS_KEY] === 60 ? 60 : config[FPS_KEY] === 30 ? 30 : DEFAULT_FPS;
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
        if (window.Sprite_Animation) {
            const A = Sprite_Animation.prototype;
            const _proj = A.setProjectionMatrix, _view = A.setViewport;
            A.setProjectionMatrix = function(renderer) {
                if (renderer.resolution === 1) return _proj.call(this, renderer);
                const x = this._mirror ? -1 : 1;
                const p = -(this._viewportSize / Graphics.height);
                Graphics.effekseer.setProjectionMatrix([x, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, p, 0, 0, 0, 1]);
            };
            A.setViewport = function(renderer) {
                const r = renderer.resolution;
                if (r === 1) return _view.call(this, renderer);
                const vw = this._viewportSize, vh = this._viewportSize;
                const vx = this._animation.offsetX - vw / 2;
                const vy = this._animation.offsetY - vh / 2;
                let pos;
                if (this._animation.displayType === 2) pos = { x: Graphics.width / 2, y: Graphics.height / 2 };
                else pos = this.targetPosition(renderer);
                renderer.gl.viewport((vx + pos.x) * r, (vy + pos.y) * r, vw * r, vh * r);
            };
        }
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
        const backKey = (b, r) => {
            const t = b.children[0], f = b._frame, tf = t._frame, u = b._colorFilter.uniforms, bt = b._bitmap._baseTexture;
            return [r, f.x, f.y, f.width, f.height, b.scale.x, b.scale.y, b.alpha, b.blendMode, bt ? bt.dirtyId : 0,
                u.hue, String(u.colorTone), String(u.blendColor), u.brightness,
                tf.x, tf.y, tf.width, tf.height, t.x, t.y, t._width, t._height, t.scale.x, t.scale.y, t.origin.x, t.origin.y,
                t.alpha, t.visible, t._bitmap === b._bitmap].join(",");
        };
        const releaseBack = b => {
            const c = b._gkdBack;
            if (c) { b._gkdBack = null; c.sprite.destroy(); c.rt.destroy(true); }
        };
        const buildBack = (win, b) => {
            const R = Graphics.app && Graphics.app.renderer;
            if (!R || window.PMZ_BACKCACHE_OFF || !backEligible(b)) { releaseBack(b); return; }
            const key = backKey(b, R.resolution);
            const c = b._gkdBack;
            if (c && c.key === key && c.bitmap === b._bitmap) return;
            if (!win.visible || win.openness <= 0) return;          // build when it is shown
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
            b._gkdBack = { key, bitmap: b._bitmap, rt, sprite };
        };
        const containerRender = PIXI.Container.prototype.render;
        const backRender = function(renderer) {
            if (!this.visible || this.worldAlpha <= 0 || !this.renderable) return;
            const c = this._gkdBack;
            if (!c || this._gkdBuilding || window.PMZ_BACKCACHE_OFF || this._gkdNoCache || c.bitmap !== this._bitmap ||
                !backEligible(this) || c.key !== backKey(this, renderer.resolution)) {
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
            const b = this._backSprite;
            if (b && b.render === backRender && !b._gkdNoCache) buildBack(this, b);
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

    // 18. Full GC after scene changes and when memory runs low. Dropped canvases, images and decoded
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

    // 19. Decoded sound effects reused. MZ fetches and decodes an SE file again for every playSe (a new
    //     WebAudio each time); footstep plugins play one per step: up to 3.7 s of decoding next to
    //     the game and a new PCM buffer per step (decoded audio reached 95 MB within 2 minutes in a
    //     game with two footstep plugins). Short SE files (audio/se/, <= 10 s) are decoded once and
    //     their AudioBuffer is shared by later plays (24 MB, least recently used out).
    //     POCKETMZ_SE_CACHE=off disables it.
    if (window.WebAudio && WebAudio.prototype._startLoading && WebAudio.prototype._onDecode &&
        String((window.process && process.env && process.env.POCKETMZ_SE_CACHE) || "on") !== "off") {
        const W = WebAudio.prototype;
        const SE = new Map(), SE_MAX = 24 << 20;
        const PMZ_SE = window.PMZ_SE = { hits: 0, stored: 0, bytes: 0, size: () => SE.size };
        const isSe = url => /(^|\/)audio\/se\//.test(String(url || ""));
        const bytesOf = b => b.length * b.numberOfChannels * 4;
        const _startLoading = W._startLoading;
        W._startLoading = function() {
            const hit = isSe(this._url) && SE.get(this._url);
            if (!hit || !WebAudio._context) return _startLoading.apply(this, arguments);
            SE.delete(this._url); SE.set(this._url, hit);   // most recently used last
            this._isError = false;
            this._isLoaded = true;
            this._sampleRate = hit.sampleRate; this._loopStart = hit.loopStart; this._loopLength = hit.loopLength;
            this._lastUpdateTime = WebAudio._currentTime() - 0.5;
            PMZ_SE.hits++;
            // asynchronous like a real decode: load listeners added right after new WebAudio() still run
            Promise.resolve().then(() => {
                if (this._url === hit.url && this._buffers && !this._buffers.length) this._onDecode(hit.buffer);
            });
        };
        const _onDecode = W._onDecode;
        W._onDecode = function(buffer) {
            if (buffer && this._isLoaded && isSe(this._url) && !this._shouldUseDecoder() &&
                buffer.duration <= 10 && !SE.has(this._url)) {
                SE.set(this._url, { url: this._url, buffer, sampleRate: this._sampleRate,
                                    loopStart: this._loopStart, loopLength: this._loopLength });
                PMZ_SE.bytes += bytesOf(buffer); PMZ_SE.stored++;
                for (const [k, v] of SE) {
                    if (PMZ_SE.bytes <= SE_MAX) break;
                    SE.delete(k); PMZ_SE.bytes -= bytesOf(v.buffer);
                }
            }
            return _onDecode.apply(this, arguments);
        };
    }

    // 20. The current map's JSON text kept. Scene_Map#create loads the map file again every time
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

    // 21. Images of the previous map kept across a map transfer. Scene_Map#onTransfer calls
    //     ImageManager.clear(), which destroys every cached bitmap; moving between two maps with the
    //     same tileset then loads and decodes all 9 tileset images and the character sheets again:
    //     1.1-1.6 s of a 1.8-2.9 s transfer. Ready tileset, character and parallax bitmaps
    //     (<= 12 million pixels in total) are set aside by clear() instead of destroyed, handed back
    //     when the new map asks for the same url, and whatever is still unclaimed is destroyed once
    //     Scene_Map#start has run. Nothing is kept while MemAvailable is below 280 MB.
    //     POCKETMZ_KEEP_IMAGES=off disables it.
    if (window.ImageManager && ImageManager.clear && ImageManager.loadBitmapFromUrl && window.Scene_Map &&
        String((window.process && process.env && process.env.POCKETMZ_KEEP_IMAGES) || "on").toLowerCase() !== "off") {
        const KEEP = new Map(), KEEP_PX = 12000000, KEEP_MIN_MEM = 280 * 1024;   // pixels; kB
        const PMZ_KEEP = window.PMZ_KEEP = { kept: 0, reused: 0, dropped: 0, size: () => KEEP.size };
        const keepable = url => /(^|\/)img\/(tilesets|characters|parallaxes)\//.test(String(url));
        const memOk = () => {
            try {
                const m = /MemAvailable:\s+(\d+)/.exec(require("fs").readFileSync("/proc/meminfo", "utf8"));
                return !m || Number(m[1]) >= KEEP_MIN_MEM;
            } catch (e) { return true; }
        };
        const destroy = b => { try { b.destroy(); } catch (e) { /* already gone */ } };
        const dropKept = () => {
            for (const b of KEEP.values()) { destroy(b); PMZ_KEEP.dropped++; }
            KEEP.clear();
        };
        ImageManager.clear = function() {
            dropKept();                                  // a second clear without a map start between
            const cache = this._cache || {};
            const keep = memOk();
            let px = 0;
            for (const url in cache) {
                const b = cache[url];
                let ok = false;
                try {
                    ok = keep && keepable(url) && b.isReady() && !b.isError() &&
                         px + b.width * b.height <= KEEP_PX;
                } catch (e) { ok = false; }
                if (ok) { px += b.width * b.height; KEEP.set(url, b); PMZ_KEEP.kept++; }
                else destroy(b);
            }
            this._cache = {};
        };
        const _loadBitmapFromUrl = ImageManager.loadBitmapFromUrl;
        ImageManager.loadBitmapFromUrl = function(url) {
            if (!String(url).includes("/system/") && this._cache && !this._cache[url] && KEEP.has(url)) {
                const b = KEEP.get(url);
                KEEP.delete(url);
                this._cache[url] = b;
                PMZ_KEEP.reused++;
                return b;
            }
            return _loadBitmapFromUrl.apply(this, arguments);
        };
        const _mapStart = Scene_Map.prototype.start;
        Scene_Map.prototype.start = function() {
            try { return _mapStart.apply(this, arguments); } finally { dropKept(); }
        };
    }

    // 22. Battle system images loaded early. MZ loads Shadow2, Weapons1-3 and States only when the
    //     first battle starts (MV loads them at boot): 1-2 s more for the first battle. They are
    //     requested 3 s after the first map has started (the system cache is never cleared; a few MB).
    //     POCKETMZ_PRELOAD_SYSTEM=off disables it.
    if (window.Scene_Map && window.Spriteset_Battle && Spriteset_Battle.prototype.loadSystemImages && window.ImageManager &&
        String((window.process && process.env && process.env.POCKETMZ_PRELOAD_SYSTEM) || "on").toLowerCase() !== "off") {
        let preloaded = false;
        const _startPre = Scene_Map.prototype.start;
        Scene_Map.prototype.start = function() {
            const r = _startPre.apply(this, arguments);
            if (!preloaded) {
                preloaded = true;
                setTimeout(() => {
                    try {
                        Spriteset_Battle.prototype.loadSystemImages.call(Object.create(Spriteset_Battle.prototype));
                        ImageManager.loadSystem("States");
                    } catch (e) { /* a plugin changed the spriteset */ }
                }, 3000);
            }
            return r;
        };
    }

    // 23. Tilemap atlas sized to the tileset. MZ's Tilemap.Renderer always allocates 3 render
    //     textures of 2048x2048 RGBA (48 MB of shared GPU memory), though most tilesets are 768 px
    //     wide and atlas 2 holds only one image, and it uploads a 4 MB zero buffer before every
    //     image. Fix: each atlas is allocated just big enough for its quadrants (multiple of 16),
    //     the shader divides by a per-atlas size uniform instead of 2048.0, only the part of a
    //     quadrant that the previous image covered and the new one does not is cleared, and the
    //     second layer's update of the same list in the same frame is skipped. The quadrant layout
    //     (and so the vertex data) is unchanged. POCKETMZ_TILE_ATLAS=off disables it.
    //     window.PMZ_TILE = { updates, skipped, cleared, resized, bytes() } for diagnostics.
    if (window.Tilemap && Tilemap.Renderer && Tilemap.Layer && Tilemap.Layer.MAX_GL_TEXTURES === 3 &&
        window.PIXI &&
        String((window.process && process.env && process.env.POCKETMZ_TILE_ATLAS) || "on").toLowerCase() !== "off" &&
        String(Tilemap.Renderer.prototype._createShader).includes("textureCoord / 2048.0") &&
        String(Tilemap.Renderer.prototype.updateTextures).includes("1024 * (i % 2)") &&
        String(Tilemap.Renderer.prototype._createInternalTextures).includes("resize(2048, 2048)")) {
        const PMZ_TILE = window.PMZ_TILE = {
            updates: 0, skipped: 0, cleared: 0, resized: 0,
            bytes: () => {
                const t = (lastInst && lastInst._internalTextures) || [];
                let n = 0;
                for (const b of t) n += b.width * b.height * 4;
                return n;
            }
        };
        const TR = Tilemap.Renderer.prototype;
        let lastInst = null;
        const MAX_SLOTS = 12;
        const round16 = v => Math.min(2048, Math.max(16, Math.ceil(v / 16) * 16));
        const imgSize = img => {
            if (!img) return [0, 0];
            const w = img.naturalWidth || img.width || 0;
            const h = img.naturalHeight || img.height || 0;
            return [w, h];
        };
        TR._createShader = function() {
            const vertexSrc =
                "attribute float aTextureId;" +
                "attribute vec4 aFrame;" +
                "attribute vec2 aSource;" +
                "attribute vec2 aDest;" +
                "uniform mat3 uProjectionMatrix;" +
                "varying vec4 vFrame;" +
                "varying vec2 vTextureCoord;" +
                "varying float vTextureId;" +
                "void main(void) {" +
                "  vec3 position = uProjectionMatrix * vec3(aDest, 1.0);" +
                "  gl_Position = vec4(position, 1.0);" +
                "  vFrame = aFrame;" +
                "  vTextureCoord = aSource;" +
                "  vTextureId = aTextureId;" +
                "}";
            // highp: with PIXI's default mediump (fp16 on Mali) "coord / 1792.0" is off by up to ~1 texel
            // (thin dark lines at tile edges); stock got away with it because /2048 is exact
            const fragmentSrc =
                "precision highp float;" +
                "varying vec4 vFrame;" +
                "varying vec2 vTextureCoord;" +
                "varying float vTextureId;" +
                "uniform sampler2D uSampler0;" +
                "uniform sampler2D uSampler1;" +
                "uniform sampler2D uSampler2;" +
                "uniform vec2 uSize0;" +
                "uniform vec2 uSize1;" +
                "uniform vec2 uSize2;" +
                "void main(void) {" +
                "  vec2 textureCoord = clamp(vTextureCoord, vFrame.xy, vFrame.zw);" +
                "  int textureId = int(vTextureId);" +
                "  vec4 color;" +
                "  if (textureId < 0) {" +
                "    color = vec4(0.0, 0.0, 0.0, 0.5);" +
                "  } else if (textureId == 0) {" +
                "    color = texture2D(uSampler0, textureCoord / uSize0);" +
                "  } else if (textureId == 1) {" +
                "    color = texture2D(uSampler1, textureCoord / uSize1);" +
                "  } else if (textureId == 2) {" +
                "    color = texture2D(uSampler2, textureCoord / uSize2);" +
                "  }" +
                "  gl_FragColor = color;" +
                "}";
            return new PIXI.Shader(PIXI.Program.from(vertexSrc, fragmentSrc), {
                uSampler0: 0, uSampler1: 0, uSampler2: 0,
                uSize0: new Float32Array([2048, 2048]),
                uSize1: new Float32Array([2048, 2048]),
                uSize2: new Float32Array([2048, 2048]),
                uProjectionMatrix: new PIXI.Matrix()
            });
        };
        TR._createInternalTextures = function() {
            this._destroyInternalTextures();
            for (let i = 0; i < Tilemap.Layer.MAX_GL_TEXTURES; i++) {
                const baseTexture = new PIXI.BaseRenderTexture();
                baseTexture.resize(16, 16);
                baseTexture.scaleMode = PIXI.SCALE_MODES.NEAREST;
                this._internalTextures.push(baseTexture);
            }
            this._pmzSlots = [];
            this._pmzLast = null;
            lastInst = this;
        };
        TR.updateTextures = function(renderer, images) {
            const frame = window.Graphics ? Graphics.frameCount : 0;
            const last = this._pmzLast;
            if (last && last.frame === frame && last.list.length === images.length &&
                last.list.every((img, i) => img === images[i])) {
                PMZ_TILE.skipped++;
                return;
            }
            this._pmzLast = { frame: frame, list: images.slice() };
            PMZ_TILE.updates++;
            const gl = renderer.gl;
            const format = gl.RGBA;
            const type = gl.UNSIGNED_BYTE;
            const n = Math.min(images.length, MAX_SLOTS);
            const slots = this._pmzSlots || (this._pmzSlots = []);
            const sizes = [];
            for (let i = 0; i < n; i++) sizes.push(imgSize(images[i]));
            for (let t = 0; t < 3; t++) {
                const atlas = this._internalTextures[t];
                let needW = 0, needH = 0;
                for (let q = 0; q < 4; q++) {
                    const i = 4 * t + q;
                    if (i >= n) break;
                    needW = Math.max(needW, 1024 * (q % 2) + sizes[i][0]);
                    needH = Math.max(needH, 1024 * ((q >> 1) % 2) + sizes[i][1]);
                }
                if (4 * t >= n) continue;
                needW = round16(needW);
                needH = round16(needH);
                let fresh = false;
                if (atlas.width !== needW || atlas.height !== needH) {
                    atlas.resize(needW, needH);
                    renderer.texture.bind(atlas, 0);
                    for (let q = 0; q < 4; q++) slots[4 * t + q] = null;
                    PMZ_TILE.resized++;
                    fresh = true;
                }
                for (let q = 0; q < 4; q++) {
                    const i = 4 * t + q;
                    if (i >= n) break;
                    const x = 1024 * (q % 2);
                    const y = 1024 * ((q >> 1) % 2);
                    const w = sizes[i][0], h = sizes[i][1];
                    const prev = slots[i];
                    if (!fresh && prev && (prev.w > w || prev.h > h) && prev.w > 0 && prev.h > 0) {
                        renderer.texture.bind(atlas, 0);
                        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
                        gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, prev.w, prev.h, format, type,
                            this._clearBuffer.subarray(0, prev.w * prev.h * 4));
                        PMZ_TILE.cleared++;
                    }
                    if (w > 0 && h > 0) {
                        renderer.texture.bind(atlas, 0);
                        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
                        gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, format, type, images[i]);
                    }
                    slots[i] = { w: w, h: h };
                }
            }
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
            const u = this._shader.uniforms;
            for (let t = 0; t < 3; t++) {
                const a = this._internalTextures[t];
                const v = u["uSize" + t];
                v[0] = a.width;
                v[1] = a.height;
                u["uSize" + t] = v;
            }
            renderer.shader.bind(this._shader);
        };
    }

    // 7. Audio sample rate
    if (AUDIO_SAMPLE_RATE > 0) {
        WebAudio._createContext = function() {
            try {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                this._context = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE, latencyHint: "playback" });
            } catch (e) {
                try { this._context = new (window.AudioContext || window.webkitAudioContext)(); }
                catch (e2) { this._context = null; }
            }
        };
    }
})();
