    // ---- PictureColorChange (MV; picture hue / tint) ---------------------------
    //   Its Sprite_Picture#updateBitmap copies every newly shown picture into a new
    //   canvas Bitmap (so the cached image is never tinted in place), even when the
    //   picture has no hue and no tint, and drops the previous copy without freeing it.
    //   With stand-up pictures changing on every line (1600x1000 = 6 MB per copy) the
    //   copies filled the renderer's memory within two minutes. Same result here: an
    //   untinted picture shows the cached bitmap itself (no copy); a tinted one gets a
    //   copy as before, and the previous copy of that sprite is freed at once.
    if (hasPlugin("PictureColorChange") && window.Sprite_Picture && Bitmap.prototype.setTint &&
            Game_Picture.prototype.rotateHue && Utils.RPGMAKER_NAME === "MV") {
        const release = b => {
            try {
                if (b.__baseTexture) { b.__baseTexture.destroy(); b.__baseTexture = null; }
                if (b.__canvas) { b.__canvas.width = 0; b.__canvas.height = 0; b.__canvas = null; b.__context = null; }
            } catch (e) { /* not used any more anyway */ }
        };
        const dropCopy = sp => { if (sp._pmzCopy) { const c = sp._pmzCopy; sp._pmzCopy = null; if (sp.bitmap !== c) release(c); } };
        Sprite_Picture.prototype.updateBitmap = function() {
            const picture = this.picture();
            const isPictureChanged = picture && picture.name() !== this._pictureName;
            // MV core
            if (picture) {
                const pictureName = picture.name();
                if (this._pictureName !== pictureName) {
                    this._pictureName = pictureName;
                    this.loadBitmap();
                }
                this.visible = true;
            } else {
                this._pictureName = "";
                this.bitmap = null;
                this.visible = false;
            }
            if (!picture) {
                this.__hue = 0;
                this.__tint = 0xFFFFFF;
                dropCopy(this);
                return;
            }
            const isHueChanged = picture.hue != this.__hue;
            const isTintChanged = picture.tint != this.__tint;
            if (isHueChanged || isTintChanged || isPictureChanged) {
                this.__hue = picture.hue;
                this.__tint = picture.tint;
                this.bitmap.addLoadListener(() => {
                    if (isPictureChanged) this.defaultBitmap = this.bitmap;
                    const src = this.defaultBitmap;
                    if (!src) return;
                    const hue = this.__hue || 0;
                    const tint = this.__tint === undefined ? 0xFFFFFF : this.__tint;
                    const old = this._pmzCopy;
                    if (hue === 0 && tint === 0xFFFFFF) {           // nothing to change: no copy
                        this.bitmap = src;
                        this._pmzCopy = null;
                        if (old && old !== src) release(old);
                        return;
                    }
                    const bitmap = new Bitmap(src.width, src.height);
                    bitmap.smooth = true;
                    bitmap.blt(src, 0, 0, src.width, src.height, 0, 0);
                    this.bitmap = bitmap;
                    this._pmzCopy = bitmap;
                    if (tint !== 0xFFFFFF) bitmap.setTint(tint);
                    if (hue !== 0) bitmap.rotateHue(hue);
                    if (old && old !== bitmap) release(old);
                });
            }
        };
    }
