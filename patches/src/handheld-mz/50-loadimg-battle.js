    // 26. Game_Interpreter.loadImages deduplication per map/cache generation
    if (String((window.process && process.env && process.env.POCKETMZ_LOADIMG_CACHE) || "on").toLowerCase() !== "off" &&
        window.Game_Interpreter && Game_Interpreter.prototype.loadImages &&
        !Game_Interpreter.prototype.loadImages._pmzDedup) {
        let loadImgGen = 0;
        const loadedLists = new WeakMap();
        if (window.ImageManager && ImageManager.clear) {
            const _clearGen = ImageManager.clear;
            ImageManager.clear = function() {
                loadImgGen++;
                return _clearGen.apply(this, arguments);
            };
        }
        if (window.Scene_Map && Scene_Map.prototype.create) {
            const _mapCreateGen = Scene_Map.prototype.create;
            Scene_Map.prototype.create = function() {
                loadImgGen++;
                return _mapCreateGen.apply(this, arguments);
            };
        }
        const _origLoadImages = Game_Interpreter.prototype.loadImages;
        const wrappedLoad = function() {
            const list = this._list;
            if (list && loadedLists.get(list) === loadImgGen) return;
            if (list) loadedLists.set(list, loadImgGen);
            return _origLoadImages.apply(this, arguments);
        };
        wrappedLoad._pmzDedup = true;
        Game_Interpreter.prototype.loadImages = wrappedLoad;
    }

    // 27. Scene_Battle incremental battle-only image release on battle end
    if (String((window.process && process.env && process.env.POCKETMZ_BATTLE_RELEASE) || "on").toLowerCase() !== "off" &&
        window.Scene_Battle && Scene_Battle.prototype.create && Scene_Battle.prototype.terminate &&
        window.ImageManager && !Scene_Battle.prototype.terminate._pmzBattleRel) {
        const _battleCreate = Scene_Battle.prototype.create;
        Scene_Battle.prototype.create = function() {
            try {
                this._pmzPreBattleUrls = new Set(Object.keys(ImageManager._cache || {}));
            } catch (e) { this._pmzPreBattleUrls = null; }
            return _battleCreate.apply(this, arguments);
        };
        const _battleTerm = Scene_Battle.prototype.terminate;
        const BATTLE_IMG_RE = /^img\/(enemies|sv_enemies|battlebacks1|battlebacks2)\//;
        const wrappedTerm = function() {
            try {
                return _battleTerm.apply(this, arguments);
            } finally {
                try {
                    const pre = this._pmzPreBattleUrls;
                    const cache = ImageManager._cache;
                    if (pre && cache) {
                        const keep = protectedUrls();
                        let freed = 0;
                        for (const url of Object.keys(cache)) {
                            if (pre.has(url) || keep.has(url) || !BATTLE_IMG_RE.test(url)) continue;
                            const bmp = cache[url];
                            if (bmp && typeof bmp.isReady === "function" && !bmp.isReady()) continue;
                            try { if (bmp && typeof bmp.destroy === "function") bmp.destroy(); } catch (e) {}
                            delete cache[url];
                            lastUse.delete(url);
                            freed++;
                        }
                        if (freed > 0 && !gcPending) {
                            gcPending = true;
                            setTimeout(runGc, 200);
                        }
                    }
                } catch (e) {}
            }
        };
        wrappedTerm._pmzBattleRel = true;
        Scene_Battle.prototype.terminate = wrappedTerm;
    }
