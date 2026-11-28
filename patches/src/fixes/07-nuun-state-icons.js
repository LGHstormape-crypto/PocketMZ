    // ---- NUUN_StateTurn + NUUN_StateIconSideBySide (14.88 MB IconSet clones) -
    //   NUUN_StateTurn.js:275 allocates `new Bitmap(this.bitmap.width, this.bitmap.height)`
    //   for `textSprite` even though updateFrame() only draws a 1-digit turn number inside
    //   (0, 0, iconWidth, iconHeight). Combined with NUUN_StateIconSideBySide (7+ slots per
    //   battler referencing IconSet 512x7616), this allocates ~200+ MB of 2D canvases and
    //   calls clear()+BaseTexture.update() every frame even when no turn changed.
    if (hasPlugin("NUUN_StateTurn") && window.Sprite_StateIcon && Sprite_StateIcon.prototype.textTurn &&
        String((window.process && process.env && process.env.POCKETMZ_STATETURN_FIX) || "on") !== "off") {
        const turnParams = PluginManager.parameters("NUUN_StateTurn") || {};
        const turnX = Number(turnParams.TurnX || 0);
        const turnY = Number(turnParams.TurnY || -4);
        const noop = () => {};

        Sprite_StateIcon.prototype.textTurn = function() {
            const sprite = new Sprite();
            this.addChild(sprite);
            this.textSprite = sprite;
            this.textSprite.x = this.x + turnX;
            this.textSprite.y = this.y + turnY;
            const w = Math.max((window.ImageManager && ImageManager.iconWidth) || 32, 32);
            const h = Math.max((window.ImageManager && ImageManager.iconHeight) || 32, 32);
            this.textSprite.bitmap = new Bitmap(w, h);
            this._pmzLastTurns = 0;   // fresh transparent bitmap is already clear
            this._pmzLastTurnColor = undefined;
        };

        const origStateIconUpdateFrame = Sprite_StateIcon.prototype.updateFrame;
        Sprite_StateIcon.prototype.updateFrame = function() {
            const ts = this.textSprite;
            const bm = ts && ts.bitmap;
            if (!bm) return origStateIconUpdateFrame.apply(this, arguments);

            const turns = this._stateBuffTurns > 0 ? this._stateBuffTurns : 0;
            const color = this._trunTextColor;
            if (turns === this._pmzLastTurns && (turns === 0 || color === this._pmzLastTurnColor)) {
                const origClear = bm.clear;
                const origDraw = bm.drawText;
                bm.clear = noop;
                bm.drawText = noop;
                try {
                    return origStateIconUpdateFrame.apply(this, arguments);
                } finally {
                    bm.clear = origClear;
                    bm.drawText = origDraw;
                }
            }
            this._pmzLastTurns = turns;
            this._pmzLastTurnColor = color;
            return origStateIconUpdateFrame.apply(this, arguments);
        };
    }
