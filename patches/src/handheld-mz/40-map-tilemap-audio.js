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
                "#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n" +
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
                baseTexture.scaleMode = window.PMZ_SMOOTH === true ? PIXI.SCALE_MODES.LINEAR : PIXI.SCALE_MODES.NEAREST;
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
            const u = this._shader && this._shader.uniforms;
            if (u) {
                for (let t = 0; t < 3; t++) {
                    const a = this._internalTextures[t];
                    if (!a) continue;
                    const v = u["uSize" + t];
                    if (v) {
                        v[0] = a.width;
                        v[1] = a.height;
                        u["uSize" + t] = v;
                    } else if (u.uSamplerSize && u.uSamplerSize.length >= (t + 1) * 2) {
                        u.uSamplerSize[2 * t] = 1 / a.width;
                        u.uSamplerSize[2 * t + 1] = 1 / a.height;
                    }
                }
                if (u.uSamplerSize) u.uSamplerSize = u.uSamplerSize;
            }
            renderer.shader.bind(this._shader);
        };
        if (window.UltraMode7 && typeof UltraMode7.generateFragmentShader === "function") {
            const origUm7Frag = UltraMode7.generateFragmentShader;
            UltraMode7.generateFragmentShader = function() {
                let src = origUm7Frag.apply(this, arguments);
                if (typeof src === "string" && !/\bprecision\s+(lowp|mediump|highp)\s+float\b/.test(src)) {
                    src = "#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n" + src;
                }
                return src;
            };
        }
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

    // 24. Smooth scaling (bilinear vs nearest-neighbor), driven by ES / PocketMZ Settings / F2 menu.
    if (window.Bitmap && window.PIXI) {
        const updateGlTex = (gl, bt, on) => {
            if (!gl || !bt || !bt._glTextures) return;
            const mag = on ? gl.LINEAR : gl.NEAREST;
            const min = bt.mipmap ? (on ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_LINEAR) : mag;
            const prev = gl.getParameter(gl.TEXTURE_BINDING_2D);
            for (const id of Object.keys(bt._glTextures)) {
                const gt = bt._glTextures[id];
                const raw = gt && gt.texture;
                if (!raw) continue;
                gl.bindTexture(gl.TEXTURE_2D, raw);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
            }
            if (prev !== undefined) gl.bindTexture(gl.TEXTURE_2D, prev);
        };
        const bInit = Bitmap.prototype.initialize;
        Bitmap.prototype.initialize = function() {
            bInit.apply(this, arguments);
            if (window.PMZ_SMOOTH !== undefined) {
                this._smooth = !!window.PMZ_SMOOTH;
                if (this._updateScaleMode) this._updateScaleMode();
            }
        };
        const smDesc = Object.getOwnPropertyDescriptor(Bitmap.prototype, "smooth");
        if (smDesc && smDesc.set) {
            Object.defineProperty(Bitmap.prototype, "smooth", {
                get: smDesc.get,
                set: function(v) {
                    const eff = window.PMZ_SMOOTH !== undefined ? !!window.PMZ_SMOOTH : !!v;
                    smDesc.set.call(this, eff);
                },
                configurable: true
            });
        }
        window.PMZ_applySmooth = function(on) {
            on = !!on;
            window.PMZ_SMOOTH = on;
            const mode = on ? PIXI.SCALE_MODES.LINEAR : PIXI.SCALE_MODES.NEAREST;
            if (PIXI.settings) PIXI.settings.SCALE_MODE = mode;
            if (window.Graphics && Graphics._canvas && Graphics._canvas.style) {
                Graphics._canvas.style.imageRendering = on ? "auto" : "pixelated";
            }
            const R = window.Graphics && Graphics.app && Graphics.app.renderer;
            const gl = R && R.gl;
            const seen = new Set();
            const touchBt = bt => {
                if (!bt || seen.has(bt)) return;
                seen.add(bt);
                bt.scaleMode = mode;
                updateGlTex(gl, bt, on);
            };
            if (window.ImageManager && ImageManager._cache) {
                for (const k of Object.keys(ImageManager._cache)) {
                    const bmp = ImageManager._cache[k];
                    if (bmp) { bmp._smooth = on; touchBt(bmp._baseTexture); }
                }
            }
            const btc = PIXI.utils && PIXI.utils.BaseTextureCache;
            if (btc) for (const k of Object.keys(btc)) touchBt(btc[k]);
            if (R && R.texture && R.texture.managedTextures) {
                for (const bt of R.texture.managedTextures) touchBt(bt);
            }
            if (window.Tilemap && Tilemap.Renderer) {
                const tr = R && R.plugins && R.plugins.tilemap;
                if (tr && tr._internalTextures) for (const bt of tr._internalTextures) touchBt(bt);
            }
            window.PMZ_FORCE_REDRAW = true;
            if (window.PMZ_MENU && PMZ_MENU.state && PMZ_MENU.state().open && R && window.SceneManager && SceneManager._scene) {
                try { R.render(SceneManager._scene); } catch (e) {}
            }
        };
        const smEnv = String((window.process && process.env && process.env.POCKETMZ_SMOOTH) || "").toLowerCase();
        if (smEnv === "1" || smEnv === "true" || smEnv === "on") window.PMZ_applySmooth(true);
        else if (smEnv === "0" || smEnv === "false" || smEnv === "off") window.PMZ_applySmooth(false);
    }
