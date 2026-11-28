    // 15. Game_Interpreter.requestImages deduplication per map/cache generation
    if (String((window.process && process.env && process.env.POCKETMZ_REQIMG_CACHE) || "on").toLowerCase() !== "off" &&
        window.Game_Interpreter && typeof Game_Interpreter.requestImages === "function" &&
        !Game_Interpreter.requestImages._pmzDedup) {
        let reqImgGen = 0;
        const reqSeen = new WeakMap();
        if (window.ImageManager && ImageManager.clear) {
            const _mvClear = ImageManager.clear;
            ImageManager.clear = function() {
                reqImgGen++;
                return _mvClear.apply(this, arguments);
            };
        }
        if (window.Scene_Map && Scene_Map.prototype.create) {
            const _mvMapCreate = Scene_Map.prototype.create;
            Scene_Map.prototype.create = function() {
                reqImgGen++;
                return _mvMapCreate.apply(this, arguments);
            };
        }
        const _origReqImages = Game_Interpreter.requestImages;
        const wrappedReq = function(list, commonList) {
            if (!commonList && Array.isArray(list) && list.length > 0) {
                if (reqSeen.get(list) === reqImgGen) return;
                reqSeen.set(list, reqImgGen);
            }
            return _origReqImages.apply(this, arguments);
        };
        wrappedReq._pmzDedup = true;
        Game_Interpreter.requestImages = wrappedReq;
    }

    // 16. WindowLayer.renderWebGL skip when empty, and direct-render bypass when open windows don't overlap
    if (String((window.process && process.env && process.env.POCKETMZ_WINLAYER_SKIP) || "on").toLowerCase() !== "off" &&
        window.WindowLayer && WindowLayer.prototype.renderWebGL &&
        !WindowLayer.prototype.renderWebGL._pmzSkip) {
        const _wlRender = WindowLayer.prototype.renderWebGL;
        const wrappedWl = function(renderer) {
            if (!this.visible || !this.renderable || this.worldAlpha <= 0 || !this.children || this.children.length === 0) return;
            const ch = this.children;
            const openWins = [];
            const nonWins = [];
            for (let i = 0; i < ch.length; i++) {
                const c = ch[i];
                if (!c || !c.visible || !c.renderable || c.alpha <= 0) continue;
                if (c._isWindow) {
                    if (c.openness > 0 && c.width > 0 && c.height > 0) openWins.push(c);
                } else {
                    nonWins.push(c);
                }
            }
            if (openWins.length === 0 && nonWins.length === 0) return;
            const defaultVoidOnly = !this.filters || this.filters.length === 0 ||
                (this.filters.length === 1 && (this.filters[0] === this._voidFilter ||
                    (window.PIXI && PIXI.filters && PIXI.filters.VoidFilter && this.filters[0] instanceof PIXI.filters.VoidFilter)));
            if (defaultVoidOnly) {
                let overlaps = false;
                for (let i = 0; i < openWins.length && !overlaps; i++) {
                    const a = openWins[i];
                    for (let j = i + 1; j < openWins.length; j++) {
                        const b = openWins[j];
                        if (a.x < b.x + b.width && a.x + a.width > b.x &&
                            a.y < b.y + b.height && a.y + a.height > b.y) {
                            overlaps = true;
                            break;
                        }
                    }
                }
                if (!overlaps) {
                    for (let i = 0; i < openWins.length; i++) openWins[i].renderWebGL(renderer);
                    for (let j = 0; j < nonWins.length; j++) nonWins[j].renderWebGL(renderer);
                    return;
                }
            }
            return _wlRender.apply(this, arguments);
        };
        wrappedWl._pmzSkip = true;
        wrappedWl._pmzDirect = true;
        WindowLayer.prototype.renderWebGL = wrappedWl;
    }

    // 17. Fix PIXI v4 GLFramebuffer.destroy stencil renderbuffer leak + empty filter pool on scene change
    if (window.PIXI && PIXI.glCore && PIXI.glCore.GLFramebuffer && PIXI.glCore.GLFramebuffer.prototype.destroy &&
        !PIXI.glCore.GLFramebuffer.prototype.destroy._pmzStencilFix) {
        const _fbDestroy = PIXI.glCore.GLFramebuffer.prototype.destroy;
        if (!String(_fbDestroy).includes("deleteRenderbuffer")) {
            const wrappedFbDestroy = function() {
                if (this.gl && this.stencil) {
                    try { this.gl.deleteRenderbuffer(this.stencil); } catch (e) {}
                    this.stencil = null;
                }
                return _fbDestroy.call(this);
            };
            wrappedFbDestroy._pmzStencilFix = true;
            PIXI.glCore.GLFramebuffer.prototype.destroy = wrappedFbDestroy;
        }
    }
    if (window.Scene_Base && Scene_Base.prototype.create && !Scene_Base.prototype.create._pmzPoolClean) {
        const _mvSceneCreate = Scene_Base.prototype.create;
        const wrappedSceneCreate = function() {
            try {
                const fm = window.Graphics && Graphics._renderer && Graphics._renderer.filterManager;
                if (fm && typeof fm.emptyPool === "function") fm.emptyPool();
            } catch (e) {}
            return _mvSceneCreate.apply(this, arguments);
        };
        wrappedSceneCreate._pmzPoolClean = true;
        Scene_Base.prototype.create = wrappedSceneCreate;
    }

    // 18. Fix upstream pixi-tilemap getVb typo (sets lastAccessTime while checkLeaks reads lastTimeAccess)
    if (window.PIXI && PIXI.tilemap && PIXI.tilemap.TileRenderer && PIXI.tilemap.TileRenderer.prototype.getVb &&
        !PIXI.tilemap.TileRenderer.prototype.getVb._pmzLeakFix) {
        const _getVb = PIXI.tilemap.TileRenderer.prototype.getVb;
        if (String(_getVb).includes("lastAccessTime")) {
            const wrappedGetVb = function(id) {
                const vb = _getVb.call(this, id);
                if (vb) vb.lastTimeAccess = vb.lastAccessTime || Date.now();
                return vb;
            };
            wrappedGetVb._pmzLeakFix = true;
            PIXI.tilemap.TileRenderer.prototype.getVb = wrappedGetVb;
        }
    }

    // 19. Window dirty-check + immediate Cairo canvas release on refresh and Scene_Base.terminate
    if (String((window.process && process.env && process.env.POCKETMZ_WIN_CLEANUP) || "on").toLowerCase() !== "off" &&
        window.Window && Window.prototype) {
        const releaseOwnBmp = b => {
            if (!b || b._url || !b.__canvas) return;
            try {
                if (b.__baseTexture) { b.__baseTexture.destroy(); b.__baseTexture = null; }
                b.__canvas.width = 0; b.__canvas.height = 0;
                b.__canvas = null; b.__context = null;
            } catch (e) {}
        };
        const WP = Window.prototype;
        if (!WP._pmzDirtyPatched) {
            WP._pmzDirtyPatched = true;
            for (const prop of ["width", "height", "padding"]) {
                const desc = Object.getOwnPropertyDescriptor(WP, prop);
                if (!desc || !desc.set || !desc.get) continue;
                const priv = "_" + prop;
                Object.defineProperty(WP, prop, {
                    get: desc.get,
                    set: function(v) {
                        if (this[priv] === v && this._windowBackSprite && this._windowBackSprite.bitmap) return;
                        desc.set.call(this, v);
                    },
                    configurable: true
                });
            }
            for (const [fn, sprKey] of [
                ["_refreshBack", "_windowBackSprite"],
                ["_refreshFrame", "_windowFrameSprite"],
                ["_refreshCursor", "_windowCursorSprite"]
            ]) {
                const orig = WP[fn];
                if (!orig) continue;
                WP[fn] = function() {
                    const spr = this[sprKey];
                    const old = spr && spr.bitmap;
                    const r = orig.apply(this, arguments);
                    const cur = spr && spr.bitmap;
                    if (old && old !== cur) releaseOwnBmp(old);
                    return r;
                };
            }
            if (window.Window_Base && Window_Base.prototype.createContents) {
                const _cc = Window_Base.prototype.createContents;
                Window_Base.prototype.createContents = function() {
                    const old = this.contents;
                    const r = _cc.apply(this, arguments);
                    if (old && old !== this.contents) releaseOwnBmp(old);
                    return r;
                };
            }
        }
        if (window.Scene_Base && Scene_Base.prototype.terminate && !Scene_Base.prototype.terminate._pmzWinClean) {
            const _mvTerm = Scene_Base.prototype.terminate;
            const freeWinTree = (node, depth) => {
                if (!node || depth > 12) return;
                if (node instanceof Window) {
                    for (const k of ["_windowBackSprite", "_windowFrameSprite", "_windowCursorSprite"]) {
                        const sp = node[k];
                        if (sp && sp.bitmap) { releaseOwnBmp(sp.bitmap); sp.bitmap = null; }
                    }
                    if (node._windowContentsSprite && node._windowContentsSprite.bitmap) {
                        releaseOwnBmp(node._windowContentsSprite.bitmap);
                        node._windowContentsSprite.bitmap = null;
                    }
                }
                const ch = node.children;
                if (ch) for (let i = 0; i < ch.length; i++) freeWinTree(ch[i], depth + 1);
            };
            const wrappedTerm = function() {
                const r = _mvTerm.apply(this, arguments);
                try { freeWinTree(this, 0); } catch (e) {}
                return r;
            };
            wrappedTerm._pmzWinClean = true;
            Scene_Base.prototype.terminate = wrappedTerm;
        }
    }

    // 20. Neutral ToneFilter bypass (skip full-screen FBO pass when screen tone is [0,0,0,0])
    if (String((window.process && process.env && process.env.POCKETMZ_TONEFILTER_FIX) || "on").toLowerCase() !== "off" &&
        window.ToneFilter && ToneFilter.prototype && window.Spriteset_Base &&
        Spriteset_Base.prototype.updateWebGLToneChanger && !Spriteset_Base.prototype.updateWebGLToneChanger._pmzToneFix) {
        const TFP = ToneFilter.prototype;
        const _tfReset = TFP.reset;
        if (_tfReset) {
            TFP.reset = function() {
                this.enabled = false;
                return _tfReset.apply(this, arguments);
            };
        }
        const _tfTone = TFP.adjustTone;
        if (_tfTone) {
            TFP.adjustTone = function(r, g, b) {
                if (r || g || b) this.enabled = true;
                return _tfTone.apply(this, arguments);
            };
        }
        const _tfSat = TFP.adjustSaturation;
        if (_tfSat) {
            TFP.adjustSaturation = function(value) {
                if (value) this.enabled = true;
                return _tfSat.apply(this, arguments);
            };
        }
        const _tfHue = TFP.adjustHue;
        if (_tfHue) {
            TFP.adjustHue = function(value) {
                if (value) this.enabled = true;
                return _tfHue.apply(this, arguments);
            };
        }
        const _sbCreateTc = Spriteset_Base.prototype.createWebGLToneChanger;
        if (_sbCreateTc) {
            Spriteset_Base.prototype.createWebGLToneChanger = function() {
                const r = _sbCreateTc.apply(this, arguments);
                if (this._toneFilter) {
                    const t = this._tone;
                    this._toneFilter.enabled = !!(t && (t[0] || t[1] || t[2] || t[3]));
                }
                return r;
            };
        }
        const _sbUpdateTc = Spriteset_Base.prototype.updateWebGLToneChanger;
        const wrappedUpdateTc = function() {
            const r = _sbUpdateTc.apply(this, arguments);
            if (this._toneFilter) {
                const t = this._tone;
                this._toneFilter.enabled = !!(t && (t[0] || t[1] || t[2] || t[3]));
            }
            return r;
        };
        wrappedUpdateTc._pmzToneFix = true;
        Spriteset_Base.prototype.updateWebGLToneChanger = wrappedUpdateTc;
    }

    // 21. Empty Sprite_Picture fast-path skip
    if (String((window.process && process.env && process.env.POCKETMZ_EMPTY_PIC_SKIP) || "on").toLowerCase() !== "off" &&
        window.Sprite_Picture && Sprite_Picture.prototype.update &&
        !Sprite_Picture.prototype.update._pmzEmptyPicSkip) {
        const _spUpdate = Sprite_Picture.prototype.update;
        const wrappedSpUpdate = function() {
            if (!this.picture() && !this._pictureName && !this.bitmap && !this.visible &&
                !this._frameWindow && (!this.children || this.children.length === 0)) {
                return;
            }
            return _spUpdate.apply(this, arguments);
        };
        wrappedSpUpdate._pmzEmptyPicSkip = true;
        Sprite_Picture.prototype.update = wrappedSpUpdate;
    }

    // 22. No-op $gameMap.requestRefresh() guard for Game_Switches / Game_Party.gainItem
    if (String((window.process && process.env && process.env.POCKETMZ_MAP_REFRESH_GUARD) || "on").toLowerCase() !== "off" &&
        window.Game_Switches && Game_Switches.prototype.setValue &&
        window.Game_Party && Game_Party.prototype.gainItem &&
        !Game_Party.prototype.gainItem._pmzNoopGuard) {
        const _gsSet = Game_Switches.prototype.setValue;
        const wrappedGsSet = function(switchId, value) {
            if (switchId > 0 && window.$dataSystem && switchId < $dataSystem.switches.length &&
                Boolean(this._data[switchId]) === Boolean(value)) {
                return;
            }
            return _gsSet.apply(this, arguments);
        };
        wrappedGsSet._pmzNoopGuard = true;
        Game_Switches.prototype.setValue = wrappedGsSet;

        const _gpGain = Game_Party.prototype.gainItem;
        const wrappedGpGain = function(item, amount, includeEquip) {
            if (item && typeof this.itemContainer === "function") {
                const container = this.itemContainer(item);
                if (container) {
                    const last = this.numItems(item);
                    const raw = last + amount;
                    const next = raw.clamp(0, this.maxItems(item));
                    if (next === last && !(includeEquip && raw < 0)) return;
                }
            }
            return _gpGain.apply(this, arguments);
        };
        wrappedGpGain._pmzNoopGuard = true;
        Game_Party.prototype.gainItem = wrappedGpGain;
    }

    // 23. Closed-idle Window / Window_Selectable update skip
    if (String((window.process && process.env && process.env.POCKETMZ_CLOSED_WIN_SKIP) || "on").toLowerCase() !== "off" &&
        window.Window && Window.prototype.update && !Window.prototype.update._pmzClosedSkip) {
        const spriteUp = window.Sprite && Sprite.prototype.update;
        const contUp = window.PIXI && PIXI.Container && PIXI.Container.prototype.update;
        const _wUpdate = Window.prototype.update;
        const wrappedWUpdate = function() {
            if (this.openness === 0 && !this._opening && !this._closing && !this.active) {
                const ch = this.children;
                if (ch) {
                    for (let i = 0; i < ch.length; i++) {
                        const c = ch[i];
                        if (c && c.update && c.update !== spriteUp && c.update !== contUp) c.update();
                    }
                }
                return;
            }
            return _wUpdate.apply(this, arguments);
        };
        wrappedWUpdate._pmzClosedSkip = true;
        Window.prototype.update = wrappedWUpdate;

        if (window.Window_Selectable && Window_Selectable.prototype.update &&
            window.Window_Base && Window_Base.prototype.update) {
            const _wsUpdate = Window_Selectable.prototype.update;
            const wrappedWsUpdate = function() {
                if (this.openness === 0 && !this._opening && !this._closing && !this.active) {
                    return Window_Base.prototype.update.call(this);
                }
                return _wsUpdate.apply(this, arguments);
            };
            wrappedWsUpdate._pmzClosedSkip = true;
            Window_Selectable.prototype.update = wrappedWsUpdate;
        }
    }
