    // ---- ApngPicture / PixiApngAndGif (MZ; startup pre-decode OOM & canvas bloat) -
    //   1) CachePolicy=2 decodes every registered APNG at Scene_Boot (e.g. 31 files,
    //      795 frames, 485 MB raw RGBA -> >740 MB with per-frame <canvas> -> OOM).
    //      Downgrade CachePolicy=2 -> 1 (on-demand cached) before cacheStartup fires.
    //   2) PixiApngAndGif creates one <canvas> (Cairo surface) per frame via
    //      BaseTexture.from(canvas) + putImageData(). On PIXI v5 with BufferResource,
    //      intercept canvas/BaseTexture.from during decode to upload UPNG's Uint8Array
    //      directly with zero <canvas> allocation, halving memory per APNG.
    //   3) Bound _spriteCache with an off-screen LRU (<=3 sprites, <=48 MB RGBA),
    //      skip caching huge (>48 MB) APNGs, stop tickers on removeApng, and free
    //      backing buffers + tickers on destroyApng. POCKETMZ_APNG_FIX=off disables.
    if (hasPlugin("ApngPicture") && window.SceneManager && SceneManager.setupApngLoaderIfNeed &&
        String((window.process && process.env && process.env.POCKETMZ_APNG_FIX) || "on") !== "off") {
        const MAX_CACHE_COUNT = 4;
        const MAX_CACHE_BYTES = 48 * 1024 * 1024;

        const apngBytes = sp => {
            if (!sp || !sp.pixiApng || !sp.pixiApng.textures) return 0;
            let total = 0;
            const seen = new Set();
            for (const tx of sp.pixiApng.textures) {
                const bt = tx && tx.baseTexture;
                if (!bt || seen.has(bt)) continue;
                seen.add(bt);
                total += (bt.realWidth || bt.width || 0) * (bt.realHeight || bt.height || 0) * 4;
            }
            return total;
        };

        const releaseApngSprite = sp => {
            const pa = sp && sp.pixiApng;
            if (!pa) return;
            try { pa.stop(); } catch (e) {}
            if (pa.ticker && typeof pa.ticker.destroy === "function") {
                try { pa.ticker.destroy(); } catch (e) {}
            }
            const txs = pa.textures;
            if (Array.isArray(txs)) {
                const seenBt = new Set();
                const seenTx = new Set();
                for (const tx of txs) {
                    if (!tx || seenTx.has(tx)) continue;
                    seenTx.add(tx);
                    const bt = tx.baseTexture;
                    if (bt && !seenBt.has(bt)) {
                        seenBt.add(bt);
                        const res = bt.resource;
                        if (res) {
                            if (res.data) res.data = null;
                            if (res.source && res.source.tagName === "CANVAS") {
                                res.source.width = 0;
                                res.source.height = 0;
                            }
                        }
                        try { bt.destroy(); } catch (e) {}
                    }
                    try { tx.destroy(); } catch (e) {}
                }
                pa.textures = [];
            }
        };

        // 1. Zero-canvas BufferResource decode path (PIXI v5) + downsample/stride & disk cache for huge APNGs
        const HUGE_APNG_BYTES = 24 * 1024 * 1024;
        const TARGET_APNG_BYTES = 20 * 1024 * 1024;
        const APNG_MAGIC = 0x415A4D50;   // "PMZA"

        const readApngHeader = u8 => {
            if (!u8 || u8.length < 33 || u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4E || u8[3] !== 0x47) return null;
            let pos = 8, w = 0, h = 0, frames = 1;
            while (pos + 8 <= u8.length) {
                const len = ((u8[pos] << 24) | (u8[pos + 1] << 16) | (u8[pos + 2] << 8) | u8[pos + 3]) >>> 0;
                const c0 = u8[pos + 4], c1 = u8[pos + 5], c2 = u8[pos + 6], c3 = u8[pos + 7];
                pos += 8;
                if (pos + len > u8.length) break;
                if (c0 === 0x49 && c1 === 0x48 && c2 === 0x44 && c3 === 0x52 && len >= 8) {
                    w = ((u8[pos] << 24) | (u8[pos + 1] << 16) | (u8[pos + 2] << 8) | u8[pos + 3]) >>> 0;
                    h = ((u8[pos + 4] << 24) | (u8[pos + 5] << 16) | (u8[pos + 6] << 8) | u8[pos + 7]) >>> 0;
                } else if (c0 === 0x61 && c1 === 0x63 && c2 === 0x54 && c3 === 0x4C && len >= 4) {
                    frames = ((u8[pos] << 24) | (u8[pos + 1] << 16) | (u8[pos + 2] << 8) | u8[pos + 3]) >>> 0 || 1;
                } else if ((c0 === 0x49 && c1 === 0x44 && c2 === 0x41 && c3 === 0x54) ||
                           (c0 === 0x66 && c1 === 0x64 && c2 === 0x41 && c3 === 0x54)) {
                    break;
                }
                pos += len + 4;
            }
            return (w > 0 && h > 0) ? { w, h, frames } : null;
        };

        const chooseApngBudget = hdr => {
            const raw = hdr.w * hdr.h * 4 * hdr.frames;
            if (raw <= HUGE_APNG_BYTES) return null;
            const div = (hdr.w >= 320 || hdr.h >= 320) ? 2 : 1;
            const res = div === 2 ? 0.5 : 1;
            const dw = div === 2 ? Math.max(1, Math.ceil(hdr.w * res)) : hdr.w;
            const dh = div === 2 ? Math.max(1, Math.ceil(hdr.h * res)) : hdr.h;
            const perFrame = dw * dh * 4;
            let stride = Math.max(1, Math.ceil((perFrame * hdr.frames) / TARGET_APNG_BYTES));
            if (hdr.frames >= 48 && stride < 2) stride = 2;
            const keyCount = Math.ceil(hdr.frames / stride);
            return { div, res, dw, dh, stride, keyCount, perFrame };
        };

        const downsampleBox2x = (src, sw, sh, dw, dh) => {
            const out = new Uint8Array(dw * dh * 4);
            const sw4 = sw * 4;
            for (let y = 0; y < dh; y++) {
                const sy0 = Math.min(y * 2, sh - 1);
                const sy1 = Math.min(sy0 + 1, sh - 1);
                const r0 = sy0 * sw4, r1 = sy1 * sw4;
                let dp = y * dw * 4;
                for (let x = 0; x < dw; x++) {
                    const sx0 = Math.min(x * 2, sw - 1) * 4;
                    const sx1 = Math.min(x * 2 + 1, sw - 1) * 4;
                    const i00 = r0 + sx0, i01 = r0 + sx1, i10 = r1 + sx0, i11 = r1 + sx1;
                    out[dp]     = (src[i00]     + src[i01]     + src[i10]     + src[i11])     >> 2;
                    out[dp + 1] = (src[i00 + 1] + src[i01 + 1] + src[i10 + 1] + src[i11 + 1]) >> 2;
                    out[dp + 2] = (src[i00 + 2] + src[i01 + 2] + src[i10 + 2] + src[i11 + 2]) >> 2;
                    out[dp + 3] = (src[i00 + 3] + src[i01 + 3] + src[i10 + 3] + src[i11 + 3]) >> 2;
                    dp += 4;
                }
            }
            return out;
        };

        const apngDiskCache = (() => {
            try {
                const fs = require("fs"), path = require("path");
                const pageDir = path.dirname(process.mainModule.filename);
                const dir = path.join(pageDir, "pmz-cache", "apng");
                const keyFor = url => {
                    const raw = String(url || "").replace(/^img\//i, "");
                    let h = 2166136261;
                    for (let i = 0; i < raw.length; i++) h = Math.imul(h ^ raw.charCodeAt(i), 16777619) >>> 0;
                    const s = raw.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 48);
                    return path.join(dir, s + "_" + h.toString(16) + ".pmza");
                };
                return { fs, path, dir, keyFor };
            } catch (e) {
                return null;
            }
        })();

        if (window.PixiApngAndGif && window.PIXI && PIXI.resources && PIXI.resources.BufferResource && PIXI.BaseTexture) {
            const makeBufferBaseTexture = (u8, w, h, resolution) => {
                const res = new PIXI.resources.BufferResource(u8, { width: w, height: h });
                const bt = new PIXI.BaseTexture(res, {
                    width: w,
                    height: h,
                    resolution: resolution || 1,
                    scaleMode: PIXI.settings.SCALE_MODE,
                    format: PIXI.FORMATS.RGBA,
                    type: PIXI.TYPES.UNSIGNED_BYTE,
                    alphaMode: PIXI.ALPHA_MODES.UNPACK,
                });
                if (resolution && resolution !== 1 && typeof bt.setResolution === "function") {
                    bt.setResolution(resolution);
                }
                return bt;
            };

            const loadApngFromDiskCache = (resource, hdr, plan) => {
                if (!apngDiskCache || !resource || !resource.url) return null;
                try {
                    const p = apngDiskCache.keyFor(resource.url);
                    if (!apngDiskCache.fs.existsSync(p)) return null;
                    const buf = apngDiskCache.fs.readFileSync(p);
                    if (buf.byteLength < 40) return null;
                    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
                    if (dv.getUint32(0, true) !== APNG_MAGIC || dv.getUint32(4, true) !== 1) return null;
                    if (dv.getUint32(8, true) !== (resource.data.byteLength >>> 0)) return null;
                    if (dv.getUint32(12, true) !== hdr.w || dv.getUint32(16, true) !== hdr.h || dv.getUint32(20, true) !== hdr.frames) return null;
                    const dw = dv.getUint32(24, true), dh = dv.getUint32(28, true);
                    const stride = dv.getUint32(32, true), keyCount = dv.getUint32(36, true);
                    if (dw !== plan.dw || dh !== plan.dh || stride !== plan.stride || keyCount !== plan.keyCount) return null;
                    const delaysOff = 40;
                    const pxOff = delaysOff + hdr.frames * 4;
                    const expected = pxOff + keyCount * plan.perFrame;
                    if (buf.byteLength !== expected) return null;
                    const delayTimes = [];
                    for (let i = 0; i < hdr.frames; i++) delayTimes.push(dv.getFloat32(delaysOff + i * 4, true));
                    const keyTextures = [];
                    const rect = new PIXI.Rectangle(0, 0, hdr.w, hdr.h);
                    for (let k = 0; k < keyCount; k++) {
                        const view = new Uint8Array(buf.buffer, buf.byteOffset + pxOff + k * plan.perFrame, plan.perFrame);
                        const bt = makeBufferBaseTexture(view, dw, dh, plan.res);
                        keyTextures.push(new PIXI.Texture(bt, rect));
                    }
                    const textures = new Array(hdr.frames);
                    for (let i = 0; i < hdr.frames; i++) textures[i] = keyTextures[Math.floor(i / stride)];
                    return { delayTimes, textures };
                } catch (e) {
                    return null;
                }
            };

            const saveApngToDiskCache = (resource, hdr, plan, delayTimes, keyBuffers) => {
                if (!apngDiskCache || !resource || !resource.url || keyBuffers.length !== plan.keyCount) return;
                try {
                    const p = apngDiskCache.keyFor(resource.url);
                    const delaysOff = 40;
                    const pxOff = delaysOff + hdr.frames * 4;
                    const out = Buffer.allocUnsafe(pxOff + plan.keyCount * plan.perFrame);
                    out.writeUInt32LE(APNG_MAGIC, 0);
                    out.writeUInt32LE(1, 4);
                    out.writeUInt32LE(resource.data.byteLength >>> 0, 8);
                    out.writeUInt32LE(hdr.w >>> 0, 12);
                    out.writeUInt32LE(hdr.h >>> 0, 16);
                    out.writeUInt32LE(hdr.frames >>> 0, 20);
                    out.writeUInt32LE(plan.dw >>> 0, 24);
                    out.writeUInt32LE(plan.dh >>> 0, 28);
                    out.writeUInt32LE(plan.stride >>> 0, 32);
                    out.writeUInt32LE(plan.keyCount >>> 0, 36);
                    for (let i = 0; i < hdr.frames; i++) out.writeFloatLE(Number(delayTimes[i]) || 0, delaysOff + i * 4);
                    for (let k = 0; k < plan.keyCount; k++) Buffer.from(keyBuffers[k].buffer, keyBuffers[k].byteOffset, plan.perFrame).copy(out, pxOff + k * plan.perFrame);
                    const tmp = p + ".tmp." + process.pid;
                    apngDiskCache.fs.promises.mkdir(apngDiskCache.dir, { recursive: true })
                        .then(() => apngDiskCache.fs.promises.writeFile(tmp, out))
                        .then(() => apngDiskCache.fs.promises.rename(tmp, p))
                        .catch(() => {});
                } catch (e) {}
            };

            const wrapDecode = (methodName, isGif) => {
                const orig = PixiApngAndGif.prototype[methodName];
                if (typeof orig !== "function") return;
                PixiApngAndGif.prototype[methodName] = function(resource) {
                    let hdr = null, plan = null;
                    if (!isGif && resource && resource.data) {
                        hdr = readApngHeader(new Uint8Array(resource.data));
                        plan = hdr ? chooseApngBudget(hdr) : null;
                        if (plan) {
                            const hit = loadApngFromDiskCache(resource, hdr, plan);
                            if (hit) return hit;
                        }
                    }

                    const origCreateElement = document.createElement;
                    const origFrom = PIXI.BaseTexture.from;
                    let frameIdx = 0;
                    let lastKeyBt = null;
                    const keyBuffers = plan ? [] : null;

                    document.createElement = function(tag) {
                        if (String(tag).toLowerCase() !== "canvas") {
                            return origCreateElement.apply(this, arguments);
                        }
                        const curIdx = frameIdx++;
                        const isSkip = !!(plan && (curIdx % plan.stride) !== 0 && lastKeyBt);
                        const dummy = {
                            tagName: "CANVAS",
                            width: 0,
                            height: 0,
                            _pmzApngDummy: true,
                            _pmzSkip: isSkip,
                            _bt: null,
                            _rgba: null,
                            getContext(type) {
                                if (type !== "2d") return null;
                                return {
                                    createImageData(w, h) {
                                        w = w | 0; h = h | 0;
                                        if (isSkip) return { width: w, height: h, data: { set() {} } };
                                        if (isGif) return { width: w, height: h, data: new Uint8Array(w * h * 4) };
                                        return { width: w, height: h, data: { _src: null, set(src) { this._src = src; } } };
                                    },
                                    putImageData(im) {
                                        if (isSkip) return;
                                        const raw = im && im.data && im.data._src ? im.data._src : (im && im.data);
                                        if (!raw || !raw.buffer) return;
                                        let u8 = raw instanceof Uint8Array && !(raw instanceof Uint8ClampedArray)
                                            ? raw
                                            : new Uint8Array(raw.buffer, raw.byteOffset || 0, raw.byteLength);
                                        let w = im.width | 0 || dummy.width | 0 || 1;
                                        let h = im.height | 0 || dummy.height | 0 || 1;
                                        if (plan && plan.div === 2 && w === hdr.w && h === hdr.h) {
                                            u8 = downsampleBox2x(u8, w, h, plan.dw, plan.dh);
                                            w = plan.dw;
                                            h = plan.dh;
                                        }
                                        if (keyBuffers) keyBuffers.push(u8);
                                        if (dummy._bt) {
                                            const bt = dummy._bt;
                                            bt.resource.data = u8;
                                            const resScale = plan ? plan.res : 1;
                                            if (bt.resource.width !== w || bt.resource.height !== h) {
                                                bt.resource.width = w;
                                                bt.resource.height = h;
                                                if (typeof bt.setRealSize === "function") bt.setRealSize(w, h, resScale);
                                            }
                                            bt.update();
                                        } else {
                                            dummy._rgba = u8;
                                        }
                                    }
                                };
                            }
                        };
                        return dummy;
                    };
                    // Must be a regular function (PixiApngAndGif calls `new PIXI.BaseTexture.from(r)`).
                    PIXI.BaseTexture.from = function(src) {
                        if (src && src._pmzApngDummy) {
                            if (src._pmzSkip && lastKeyBt) {
                                src._bt = lastKeyBt;
                                return lastKeyBt;
                            }
                            const w = plan ? plan.dw : (src.width | 0 || 1);
                            const h = plan ? plan.dh : (src.height | 0 || 1);
                            const bt = makeBufferBaseTexture(src._rgba || new Uint8Array(4), w, h, plan ? plan.res : 1);
                            src._bt = bt;
                            lastKeyBt = bt;
                            return bt;
                        }
                        return origFrom.apply(this, arguments);
                    };
                    let decoded;
                    try {
                        decoded = orig.apply(this, arguments);
                    } finally {
                        document.createElement = origCreateElement;
                        PIXI.BaseTexture.from = origFrom;
                    }
                    if (plan && decoded && Array.isArray(decoded.textures)) {
                        // Reuse shared PIXI.Texture objects for strided duplicate frames
                        for (let i = 0; i < decoded.textures.length; i++) {
                            const keyIdx = Math.floor(i / plan.stride) * plan.stride;
                            if (i !== keyIdx && decoded.textures[keyIdx] && decoded.textures[i] !== decoded.textures[keyIdx]) {
                                try { decoded.textures[i].destroy(false); } catch (e) {}
                                decoded.textures[i] = decoded.textures[keyIdx];
                            }
                        }
                        if (keyBuffers) saveApngToDiskCache(resource, hdr, plan, decoded.delayTimes || [], keyBuffers);
                    }
                    return decoded;
                };
            };
            wrapDecode("apngResourceToTextures", false);
            wrapDecode("gifResourceToTextures", true);
        }

        // 2. Downgrade CachePolicy=2 -> 1 and enforce bounded LRU on cached sprites
        const lruOrder = [];   // [{ loader, name, bytes }]
        let lruBytes = 0;

        const touchLru = (loader, name, sp) => {
            const bytes = apngBytes(sp);
            const idx = lruOrder.findIndex(e => e.loader === loader && e.name === name);
            if (idx >= 0) {
                lruBytes -= lruOrder[idx].bytes;
                lruOrder.splice(idx, 1);
            }
            if (bytes > MAX_CACHE_BYTES) {
                // Too large to keep cached (e.g. 170 MB cutscene): treat as uncached so destroyApng frees it
                if (sp.pixiApngOption) sp.pixiApngOption.CachePolicy = 0;
                delete loader._spriteCache[name];
                return;
            }
            lruOrder.push({ loader, name, bytes });
            lruBytes += bytes;
            while (lruOrder.length > MAX_CACHE_COUNT || lruBytes > MAX_CACHE_BYTES) {
                const evIdx = lruOrder.findIndex(e => {
                    if (e.loader === loader && e.name === name) return false;   // never self-evict before caller mounts it
                    const cached = e.loader._spriteCache && e.loader._spriteCache[e.name];
                    return !cached || !cached.parent;
                });
                if (evIdx < 0) break;   // all other cached sprites are currently mounted on screen
                const ev = lruOrder.splice(evIdx, 1)[0];
                lruBytes -= ev.bytes;
                const oldSp = ev.loader._spriteCache && ev.loader._spriteCache[ev.name];
                if (oldSp) {
                    delete ev.loader._spriteCache[ev.name];
                    releaseApngSprite(oldSp);
                }
            }
        };

        const patchLoader = loader => {
            if (!loader || loader._pmzPatched) return;
            loader._pmzPatched = true;
            if (loader._cachePolicy) {
                for (const k of Object.keys(loader._cachePolicy)) {
                    if (loader._cachePolicy[k] === 2) loader._cachePolicy[k] = 1;
                }
            }
            const origCreate = loader.createSprite.bind(loader);
            loader.createSprite = function(name) {
                const cached = this._spriteCache && this._spriteCache[name];
                if (cached && (!cached.pixiApng || !Array.isArray(cached.pixiApng.textures) || cached.pixiApng.textures.length === 0)) {
                    delete this._spriteCache[name];
                }
                const sp = origCreate(name);
                if (sp && this._isNeedCache(name) && this._spriteCache && this._spriteCache[name] === sp) {
                    touchLru(this, name, sp);
                }
                return sp;
            };
        };

        const origSetup = SceneManager.setupApngLoaderIfNeed;
        SceneManager.setupApngLoaderIfNeed = function() {
            const r = origSetup.apply(this, arguments);
            patchLoader(this._apngLoaderPicture);
            patchLoader(this._apngLoaderEnemy);
            patchLoader(this._apngLoaderSideEnemy);
            patchLoader(this._apngLoaderSystem);
            return r;
        };

        // 3. Stop tickers on removeApng (when actually removed from this parent) and release buffers on destroyApng
        if (Sprite.prototype.removeApng) {
            const origRemove = Sprite.prototype.removeApng;
            Sprite.prototype.removeApng = function() {
                const sp = this._apngSprite;
                if (sp && sp.pixiApng && sp.parent === this) {
                    try { sp.pixiApng.stop(); } catch (e) {}
                }
                return origRemove.apply(this, arguments);
            };
        }
        if (Sprite.prototype.destroyApng) {
            const origDestroy = Sprite.prototype.destroyApng;
            Sprite.prototype.destroyApng = function() {
                const sp = this._apngSprite;
                origDestroy.apply(this, arguments);
                if (sp) releaseApngSprite(sp);
            };
        }
    }
