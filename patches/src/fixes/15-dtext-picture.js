    // ---- DTextPicture (MV: deterministic key + LRU Bitmap cache + Cairo canvas release) ----
    if (Utils.RPGMAKER_NAME === "MV" &&
        String((window.process && process.env && process.env.POCKETMZ_DTEXT_FIX) || "on").toLowerCase() !== "off" &&
        hasPlugin("DTextPicture") &&
        window.Game_Picture && window.Sprite_Picture &&
        Sprite_Picture.prototype.makeDynamicBitmap &&
        !Sprite_Picture.prototype.makeDynamicBitmap._pmzDTextFix) {
        const dtextKey = info => "pmz_dt:" + [
            info.value, info.size || 0, info.align || 0,
            info.color || "", info.font || "", info.windowFrame ? 1 : 0
        ].join("\x1f");
        const releaseBmp = b => {
            if (!b || b._url || !b.__canvas) return;
            try {
                if (b.__baseTexture) { b.__baseTexture.destroy(); b.__baseTexture = null; }
                b.__canvas.width = 0; b.__canvas.height = 0;
                b.__canvas = null; b.__context = null;
            } catch (e) {}
        };
        const isBmpInUse = bmp => {
            try {
                const pc = window.SceneManager && SceneManager._scene && SceneManager._scene._spriteset &&
                    SceneManager._scene._spriteset._pictureContainer;
                const ch = pc && pc.children;
                if (!ch) return false;
                for (let i = 0; i < ch.length; i++) {
                    if (ch[i] && ch[i].bitmap === bmp) return true;
                }
            } catch (e) {}
            return false;
        };

        const _gpShow = Game_Picture.prototype.show;
        Game_Picture.prototype.show = function() {
            const r = _gpShow.apply(this, arguments);
            if (this.dTextInfo) this._name = dtextKey(this.dTextInfo);
            return r;
        };
        if (Game_Picture.prototype.updateDTextVariable) {
            const _gpUpdDt = Game_Picture.prototype.updateDTextVariable;
            Game_Picture.prototype.updateDTextVariable = function() {
                const r = _gpUpdDt.apply(this, arguments);
                if (this.dTextInfo) this._name = dtextKey(this.dTextInfo);
                return r;
            };
        }

        const MAX_CACHE = 24;
        const cache = new Map();
        const _makeDyn = Sprite_Picture.prototype.makeDynamicBitmap;
        const wrappedMakeDyn = function() {
            const old = this.bitmap;
            if (old && old._pmzDText && !old._pmzDTextCached) releaseBmp(old);
            const info = this.dTextInfo;
            if (!info) return _makeDyn.apply(this, arguments);
            const key = dtextKey(info);
            const cached = cache.get(key);
            if (cached && cached.__canvas && cached.__canvas.width > 0) {
                cache.delete(key);
                cache.set(key, cached);
                this.bitmap = cached;
                this._colorTone = [0, 0, 0, 0];
                if (this._frameWindow && this.removeFrameWindow) this.removeFrameWindow();
                if (info.windowFrame && this.makeFrameWindow && window.SceneManager && SceneManager.getHiddenWindow) {
                    this.hiddenWindow = SceneManager.getHiddenWindow();
                    this.hiddenWindow.resetFontSettings(info);
                    const scaleX = this.picture() ? this.picture().scaleX() / 100 : 1;
                    const scaleY = this.picture() ? this.picture().scaleY() / 100 : 1;
                    this.makeFrameWindow(cached.width * scaleX, cached.height * scaleY);
                    this.hiddenWindow = null;
                }
                return;
            }
            if (cached) cache.delete(key);
            const r = _makeDyn.apply(this, arguments);
            if (this.bitmap && this.bitmap.__canvas) {
                this.bitmap._pmzDText = true;
                this.bitmap._pmzDTextCached = true;
                cache.set(key, this.bitmap);
                while (cache.size > MAX_CACHE) {
                    const firstKey = cache.keys().next().value;
                    const evicted = cache.get(firstKey);
                    cache.delete(firstKey);
                    if (evicted) {
                        evicted._pmzDTextCached = false;
                        if (!isBmpInUse(evicted)) releaseBmp(evicted);
                    }
                }
            }
            return r;
        };
        wrappedMakeDyn._pmzDTextFix = true;
        Sprite_Picture.prototype.makeDynamicBitmap = wrappedMakeDyn;

        if (window.Scene_Base && Scene_Base.prototype.terminate) {
            const _sbTermDt = Scene_Base.prototype.terminate;
            Scene_Base.prototype.terminate = function() {
                const r = _sbTermDt.apply(this, arguments);
                for (const bmp of cache.values()) {
                    if (bmp) { bmp._pmzDTextCached = false; releaseBmp(bmp); }
                }
                cache.clear();
                return r;
            };
        }
    }
