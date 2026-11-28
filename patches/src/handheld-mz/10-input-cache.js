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
