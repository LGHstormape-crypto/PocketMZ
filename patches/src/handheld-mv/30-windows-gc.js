    // 7. Window contents freed when replaced. MV's Window_Base#createContents makes a new Bitmap
    //    (a canvas the size of the window) and drops the old one without freeing it; MZ destroys
    //    it first. Message / name-box plugins recreate contents for every message, and the old
    //    canvases (software bitmaps in the renderer, outside the JS heap) piled up until a GC:
    //    up to 244 canvases / 170 MB alive in a voiced MV game. The old canvas is released at once.
    if (window.Window_Base && Window_Base.prototype.createContents) {
        const release = b => {
            try {
                if (b.__baseTexture) { b.__baseTexture.destroy(); b.__baseTexture = null; }
                if (b.__canvas) { b.__canvas.width = 0; b.__canvas.height = 0; b.__canvas = null; b.__context = null; }
                // a downscaled snapshot (section 6) keeps its pixels in a small canvas as _image
                if (b._pmzScale && b._image && b._image.tagName === "CANVAS") { b._image.width = 0; b._image.height = 0; b._image = null; }
            } catch (e) { /* the window keeps working with its new contents */ }
        };
        // Window#_refreshBack / _refreshFrame make a new window-sized Bitmap for the back and the
        // frame every time the size or padding changes (message-window placement plugins do it
        // for every message); the previous ones are released the same way.
        for (const [fn, spr] of [["_refreshBack", "_windowBackSprite"], ["_refreshFrame", "_windowFrameSprite"]]) {
            const orig = window.Window && Window.prototype[fn];
            if (!orig) continue;
            Window.prototype[fn] = function() {
                const old = this[spr] && this[spr].bitmap;
                const r = orig.apply(this, arguments);
                if (old && this[spr] && old !== this[spr].bitmap && old instanceof Bitmap && !old._url) release(old);
                return r;
            };
        }
        const _createContents = Window_Base.prototype.createContents;
        Window_Base.prototype.createContents = function() {
            const old = this.contents;
            const r = _createContents.apply(this, arguments);
            if (old && old !== this.contents && old instanceof Bitmap && !old._url) release(old);
            return r;
        };
        // Windows of the scene that ended: MV never destroys a scene, so the contents / back /
        // frame canvases of every menu window stayed alive until a GC (the GC does not see canvas
        // memory): +14 sets of window canvases after 18 menu opens in the MV bench, RAM + swap
        // full after a few minutes of menus in a voiced 1600x1000 game. Released once the next
        // scene is created; windows a plugin carries over into the new scene are kept, and so
        // are bitmaps loaded from files (_url) and the menu background snapshot.
        if (SceneManager.changeScene) {
            const windowsIn = (root, out) => {
                const seen = new Set();
                const walk = (o, d) => {
                    if (!o || seen.has(o) || d > 8) return;
                    seen.add(o);
                    if (o instanceof Window) out.add(o);
                    if (o.children) for (const c of o.children) walk(c, d + 1);
                };
                walk(root, 0);
                return out;
            };
            const own = b => b && b instanceof Bitmap && !b._url && b !== SceneManager._backgroundBitmap;
            // the previous menu background snapshot (game-size canvas, blurred) when a new one is taken
            if (SceneManager.snapForBackground) {
                const _snapBg = SceneManager.snapForBackground;
                SceneManager.snapForBackground = function() {
                    const prev = this._backgroundBitmap;
                    const r = _snapBg.apply(this, arguments);
                    if (prev && prev !== this._backgroundBitmap && prev instanceof Bitmap && !prev._url &&
                        !window.PMZ_SCENE_RELEASE_OFF) release(prev);
                    return r;
                };
            }
            const _changeScene = SceneManager.changeScene;
            SceneManager.changeScene = function() {
                const old = this._scene;
                const r = _changeScene.apply(this, arguments);
                if (old && this._scene && this._scene !== old && !window.PMZ_SCENE_RELEASE_OFF) {
                    try {
                        if (window.Graphics && Graphics._renderer && Graphics._renderer._lastObjectRendered === old) {
                            Graphics._renderer._lastObjectRendered = null;
                        }
                        const keep = windowsIn(this._scene, new Set());
                        for (const w of windowsIn(old, new Set())) {
                            if (keep.has(w)) continue;
                            for (const b of [w.contents, w._windowBackSprite && w._windowBackSprite.bitmap,
                                             w._windowFrameSprite && w._windowFrameSprite.bitmap]) {
                                if (own(b)) release(b);
                            }
                        }
                    } catch (e) { /* the new scene runs anyway */ }
                }
                return r;
            };
        }
    }

    // 8. PIXI texture GC sooner (same as PocketMZ_Handheld.js section 5). GPU memory is system
    //    RAM here (panfrost buffers count as shared memory of the game); PIXI v4 keeps the texture
    //    of a bitmap nobody draws any more for 3600 frames. Old windows, menu backgrounds and
    //    pictures of the previous scenes. (MV 1.6 itself sets maxIdle = 1 on its renderer after
    //    creating it, which stays; this covers older MV cores.)
    if (window.PIXI && PIXI.settings && "GC_MAX_IDLE" in PIXI.settings) {
        PIXI.settings.GC_MAX_IDLE = 900;           // frames (~15 s)
        PIXI.settings.GC_MAX_CHECK_COUNT = 300;
        const gc = Graphics._renderer && Graphics._renderer.textureGC;   // renderer made already?
        if (gc) { gc.maxIdle = 900; gc.checkCountMax = 300; }
    }
