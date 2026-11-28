    // ---- TMNamePop (MV: per-map Bitmap cache + off-screen skip for Sprite_NamePop) ----
    if (Utils.RPGMAKER_NAME === "MV" &&
        String((window.process && process.env && process.env.POCKETMZ_NAMEPOP_FIX) || "on").toLowerCase() !== "off" &&
        hasPlugin("TMNamePop") && window.Sprite_Character &&
        Sprite_Character.prototype.updateNamePop && !Sprite_Character.prototype.updateNamePop._pmzNpFix) {
        const npCache = new Map();
        let npMapId = -1;
        const releaseNpBmp = b => {
            try {
                if (b.__baseTexture) { b.__baseTexture.destroy(); b.__baseTexture = null; }
                if (b.__canvas) { b.__canvas.width = 0; b.__canvas.height = 0; b.__canvas = null; b.__context = null; }
            } catch (e) {}
        };
        const clearNpCache = () => {
            for (const b of npCache.values()) releaseNpBmp(b);
            npCache.clear();
        };
        if (window.Scene_Title && Scene_Title.prototype.create) {
            const _npTitle = Scene_Title.prototype.create;
            Scene_Title.prototype.create = function() { clearNpCache(); return _npTitle.apply(this, arguments); };
        }
        const patchNpProto = proto => {
            if (!proto || !proto.refresh || proto.refresh._pmzCached) return;
            const _origNpRefresh = proto.refresh;
            const wrappedNpRefresh = function(text, outlineColor) {
                const curMap = window.$gameMap && $gameMap.mapId ? ($gameMap.mapId() || 0) : 0;
                if (curMap !== npMapId) { clearNpCache(); npMapId = curMap; }
                const key = String(text) + "\0" + String(outlineColor || "");
                const hit = npCache.get(key);
                if (hit) { this.bitmap = hit; return; }
                const w = (window.TMPlugin && TMPlugin.NamePop && TMPlugin.NamePop.Width) || 160;
                const fs = (window.TMPlugin && TMPlugin.NamePop && TMPlugin.NamePop.FontSize) || 20;
                const ow = (window.TMPlugin && TMPlugin.NamePop && TMPlugin.NamePop.OutlineWidth) || 4;
                let bmp = this.bitmap;
                if (!bmp || bmp._pmzCachedBmp || bmp.width !== w || bmp.height !== fs + 4) {
                    bmp = new Bitmap(w, fs + 4);
                    bmp.fontSize = fs;
                    bmp.outlineWidth = ow;
                    this.bitmap = bmp;
                }
                _origNpRefresh.call(this, text, outlineColor);
                bmp._pmzCachedBmp = true;
                if (npCache.size >= 80) {
                    const oldestKey = npCache.keys().next().value;
                    const oldest = npCache.get(oldestKey);
                    npCache.delete(oldestKey);
                    if (oldest) releaseNpBmp(oldest);
                }
                npCache.set(key, bmp);
            };
            wrappedNpRefresh._pmzCached = true;
            proto.refresh = wrappedNpRefresh;
        };
        const _origUpdateNp = Sprite_Character.prototype.updateNamePop;
        const wrappedUpdateNp = function() {
            if (this._gkdOff) return;
            const r = _origUpdateNp.apply(this, arguments);
            if (this._namePopSprite) patchNpProto(Object.getPrototypeOf(this._namePopSprite));
            return r;
        };
        wrappedUpdateNp._pmzNpFix = true;
        Sprite_Character.prototype.updateNamePop = wrappedUpdateNp;
    }
