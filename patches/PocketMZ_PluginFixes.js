/*:
 * @target MZ
 * @plugindesc PocketMZ: speed fixes for specific third-party plugins (load last).
 * @author PocketMZ (MIT)
 *
 * @help
 * Each fix only applies when its plugin is present and its parameters are plain values;
 * otherwise the plugin's own code is used unchanged. Plugin files are not modified.
 *
 * ARTM_PlayerSensorMZ (enemy sight, <PsensorF:...> etc.)
 *   Every sensing event rebuilds its view area every frame and calls
 *   isMapPassableEx() for each tile (~400 calls per frame on a map with 10 sensing
 *   monsters). Each call re-parsed plugin parameters (regex + escape expansion) and
 *   rebuilt the region list: ~25 of ~45 ms per frame on the RK3566 -> big maps ran at
 *   40 % speed. Same logic here with the constant parts parsed once; values that use
 *   \V[n] / \S[n] escapes still go through the plugin's own code.
 */

(() => {
    "use strict";

    const hasPlugin = name => $plugins.some(p => p.name === name && p.status);

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

    // ---- FilterSelectableItems (game data bug, same on PC) --------------------
    //   "SetSelectableItems" restricts the Select Item window to a list of item IDs.
    //   2 of its 71 uses in this game have an empty list (e.g. map 118 EV002, the
    //   persuasion that then checks for item 502), which leaves the window empty and
    //   the player stuck with "cancel". An empty list now means "no restriction".
    if (hasPlugin("FilterSelectableItems")) {
        const key = "FilterSelectableItems:SetSelectableItems";
        const orig = PluginManager._commands && PluginManager._commands[key];
        if (orig) {
            PluginManager._commands[key] = function(args) {
                let ids = [];
                try { ids = JSON.parse(args.itemIds || "[]"); } catch (e) {}
                if (!Array.isArray(ids) || ids.length === 0) {
                    return PluginManager.callCommand(this, "FilterSelectableItems", "ClearSelectableItems", {});
                }
                return orig.apply(this, arguments);
            };
        }
    }

    // ---- ARTM_PlayerSensorMZ -------------------------------------------------
    if (hasPlugin("ARTM_PlayerSensorMZ") && Game_CharacterBase.prototype.isMapPassableEx) {
        const P = PluginManager.parameters("ARTM_PlayerSensorMZ");
        const rawEvent = String(P.Event_Decision === undefined ? "false" : P.Event_Decision);
        const rawRegion = String(P.Region_Decision === undefined ? "[]" : P.Region_Decision).trim();
        const plain = s => s.indexOf("\\") < 0;
        if (plain(rawEvent) && (rawRegion === "" || rawRegion === "[]")) {
            const defEventDecision = rawEvent.trim().toLowerCase() === "true";
            const origPassable = Game_CharacterBase.prototype.isMapPassableEx;

            // ConvSw(): plain "true"/"1" -> 1, other strings -> 0, non-strings as they are
            const fastEventDecision = raw => {
                if (typeof raw !== "string") return parseInt(raw, 10);
                if (!plain(raw)) return undefined;
                return (raw.toLowerCase() === "true" || raw === "1") ? 1 : 0;
            };
            // ConvVb(): plain values are returned as they are
            const fastRegionDecision = raw => {
                if (typeof raw === "string" && !plain(raw)) return undefined;
                return parseInt(raw, 10);
            };

            Game_CharacterBase.prototype.isMapPassableEx = function(x, y, d) {
                const ed = fastEventDecision(this._eventDecision);
                const rd = fastRegionDecision(this._regionDecision);
                if (ed === undefined || rd === undefined) return origPassable.apply(this, arguments);
                const x2 = $gameMap.roundXWithDirection(x, d);
                const y2 = $gameMap.roundYWithDirection(y, d);
                if (!$gameMap.isPassable(x, y, d) || !$gameMap.isPassable(x2, y2, this.reverseDir(d))) {
                    return false;
                }
                if (ed === 1 || (ed === -1 && defEventDecision)) {
                    if ($gameMap.eventsXyNt(x2, y2).some(event => event.isNormalPriority())) return false;
                }
                // getRegionIds(DefRegionDecisions=[], regionDecision): [n] when n > 0
                if (rd > 0 && $gameMap.regionId(x2, y2) === rd) return false;
                return true;
            };

            // sensorFan(): the fan (this._coordinate) depends only on the event's tile, facing,
            // range and the static map; only the final "is the player inside" test depends on
            // the player. The plugin rebuilt the fan for every sensing event every frame (and
            // re-parsed parameters in every loop step). Rebuild it only when its inputs change.
            const realOk = s => s === undefined || (plain(String(s)) && isFinite(String(s)));
            const clampReal = s => Math.min(Math.max(isFinite(s) ? parseFloat(s) : 0, 0), 0.999);   // CEC_float(.., 0, 0.999)
            const fan = Game_Event.prototype.sensorFan;
            if (fan && realOk(P.Real_Range_X) && realOk(P.Real_Range_Y)) {
                const realX = clampReal(P.Real_Range_X), realY = clampReal(P.Real_Range_Y);
                const T = {   // testSensorFanDir (plugin-private table, same code)
                    "8": { "8": () => false, "2": () => false,
                           "6": (a, b, c) => { c = Math.ceil(c); return c <= a + b && c >= a - b; },
                           "4": (a, b, c) => { c = Math.floor(c); return c <= a - b && c >= a + b; } },
                    "6": { "6": () => false, "4": () => false,
                           "8": (a, b, c) => { c = Math.floor(c); return c >= a - b && c <= a + b; },
                           "2": (a, b, c) => { c = Math.ceil(c); return c >= a - b && c <= a + b; } },
                    "4": { "6": () => false, "4": () => false,
                           "8": (a, b, c) => { c = Math.floor(c); return c <= a + b && c >= a - b; },
                           "2": (a, b, c) => { c = Math.ceil(c); return c <= a + b && c >= a - b; } },
                    "2": { "8": () => false, "2": () => false,
                           "6": (a, b, c) => { c = Math.ceil(c); return c >= a - b && c <= a + b; },
                           "4": (a, b, c) => { c = Math.floor(c); return c >= a - b && c <= a + b; } }
                };
                // isSideSearch arguments after the fan loop (diagoDir reversed once)
                const SIDE = { 8: [6, 4, -1, 0], 6: [2, 8, 0, -1], 4: [8, 2, 0, 1], 2: [4, 6, 1, 0] };
                const fanKey = ev => {
                    const ed = fastEventDecision(ev._eventDecision), rd = fastRegionDecision(ev._regionDecision);
                    if (ed === undefined || rd === undefined || ed === 1 || (ed === -1 && defEventDecision)) return null;
                    const df = ev.getDirectionFixed();
                    return [ev.x, ev.y, df === -1 ? ev.direction() : df, ev.getSensorRange(), ev.getTerrainDecision(), rd,
                            $gameMap.mapId(), $gameMap.tilesetId(), $gameMap.width(), $gameMap.height()].join(",");
                };
                const fastFan = function() {
                    const key = fanKey(this);
                    if (key === null) return fan.apply(this, arguments);
                    const c = this._gkdFan;
                    if (!c || c.key !== key) {
                        const r = fan.apply(this, arguments);
                        this._gkdFan = { key, coords: this._coordinate };
                        return r;
                    }
                    const sensorRange = this.getSensorRange();
                    const df = this.getDirectionFixed();
                    const dir = df === -1 ? this.direction() : df;
                    const px = $gamePlayer._realX, py = $gamePlayer._realY;
                    const rex = this._realX, rey = this._realY;
                    const found = this.isSensorFound();
                    const pyDir = "" + $gamePlayer.direction();
                    this.setSensorRangeC(sensorRange);
                    this._coordinate = c.coords;
                    const side = SIDE[dir];
                    if (!side) return false;
                    if (this.isSideSearch(side[0], side[1], side[2], side[3])) return true;
                    const cs = c.coords, t = T[dir];
                    for (let i = 0; i < cs.length; i++) {
                        const q = cs[i];
                        if (q[2] === "Add" || q[2] === "C" || (q[0] === 0 && q[1] === 0)) continue;
                        let hx, hy;
                        if (dir === 8) {
                            hx = px <= rex + q[0] + realX && px >= rex + q[0] - realX;
                            hy = py <= rey - Math.abs(q[0]) + realY && py >= rey + q[1] - realY;
                            if (hx && hy) return true;
                            if (found && hy && t[pyDir](rex + q[0], realX, px)) return true;
                        } else if (dir === 6) {
                            hy = py >= rey + q[1] - realY && py <= rey + q[1] + realY;
                            hx = px >= rex + Math.abs(q[1]) - realX && px <= rex + q[0] + realX;
                            if (hy && hx) return true;
                            if (found && hx && t[pyDir](rey + q[1], realY, py)) return true;
                        } else if (dir === 4) {
                            hy = py <= rey + q[1] + realY && py >= rey + q[1] - realY;
                            hx = px <= rex - Math.abs(q[1]) + realX && px >= rex + q[0] - realX;
                            if (hy && hx) return true;
                            if (found && hx && t[pyDir](rey + q[1], realY, py)) return true;
                        } else {
                            hy = py >= rey + Math.abs(q[0]) - realY && py <= rey + q[1] + realY;
                            hx = px >= rex + q[0] - realX && px <= rex + q[0] + realX;
                            if (hy && hx) return true;
                            if (found && hy && t[pyDir](rex + q[0], realX, px)) return true;
                        }
                    }
                    return false;
                };
                Game_Event.prototype.sensorFan = fastFan;
                window.PMZ_FIX = Object.assign(window.PMZ_FIX || {}, { sensorFanOrig: fan, sensorFanFast: fastFan });
            }

            // isSideSearch(): same code with the two global parameters parsed once
            // (CEC() re-parsed them on every call: 93 of 128 us per sensing event per frame).
            const boolOk = s => s === undefined || plain(String(s));
            const side = Game_Event.prototype.isSideSearch;
            if (side && boolOk(P.Both_Sensor) && boolOk(P.Terrain_Decision)) {
                const pb = s => { s = String(s === undefined ? "" : s); if (s === "") return false; s = s.toUpperCase(); return s === "ON" || s === "TRUE" || s === "1"; };
                const bothSensor = pb(P.Both_Sensor), terrainDecision = pb(P.Terrain_Decision);
                const BIAS = 0.9999;
                const realX = clampReal(P.Real_Range_X), realY = clampReal(P.Real_Range_Y);
                const fastSide = function(directionR, directionL, vx, vy) {
                    const sx = this.deltaXFrom($gamePlayer._realX);
                    const sy = this.deltaYFrom($gamePlayer._realY);
                    const key = "" + $gamePlayer.direction() + vx + vy;
                    const ex = this.x, ey = this.y;
                    let biasX = [0, 0], biasY = [0, 0];
                    if (this.getSensorType() === "f") {
                        biasX = [{ "60-1": -BIAS, "40-1": -BIAS }[key] ?? 0, { "401": BIAS, "601": BIAS }[key] ?? 0];
                        biasY = [{ "210": -BIAS, "810": -BIAS }[key] ?? 0, { "8-10": BIAS, "2-10": BIAS }[key] ?? 0];
                    }
                    const bs = this.getBothSensor();
                    if ((bs === -1 && bothSensor) || bs === 1) {
                        const td = this.getTerrainDecision();
                        if (td === 1 || (td === -1 && terrainDecision)) {
                            this.setBothSensorRight(this.isMapPassableEx(ex, ey, directionR));
                            this.setBothSensorLeft(this.isMapPassableEx(ex, ey, directionL));
                        } else {
                            this.setBothSensorRight(true);
                            this.setBothSensorLeft(true);
                        }
                    } else {
                        this.setBothSensorRight(false);
                        this.setBothSensorLeft(false);
                    }
                    if (this.getBothSensorRight() &&
                        sx >= vx + biasX[0] - realX && sx <= vx + biasX[1] + realX &&
                        sy >= vy + biasY[0] - realY && sy <= vy + biasY[1] + realY) return true;
                    vx = vx === 0 ? vx : -vx;
                    vy = vy === 0 ? vy : -vy;
                    if (this.getBothSensorLeft() &&
                        sx >= vx + biasX[0] - realX && sx <= vx + biasX[1] + realX &&
                        sy >= vy + biasY[0] - realY && sy <= vy + biasY[1] + realY) return true;
                    return false;
                };
                if (realOk(P.Real_Range_X) && realOk(P.Real_Range_Y)) {
                    Game_Event.prototype.isSideSearch = fastSide;
                    window.PMZ_FIX = Object.assign(window.PMZ_FIX || {}, { isSideSearchOrig: side, isSideSearchFast: fastSide });
                }
            }
        }
    }

    // ---- CharacterPictureManager (triacontane, stand pictures) -----------------
    //   Every frame, for every picture layer of every shown actor, the plugin copies and
    //   reverses the layer's file list and tests each file with 10 new closures, one of
    //   them eval(file.Script), until one matches. A game with 1179 files / 1140 scripts
    //   (a battle-heavy MZ game) spent ~13 of ~29 ms per battle frame there, mostly in a.hpRate(): its mhp
    //   runs through every trait/passive-skill plugin (~35 us each) and was asked up to twice
    //   per file. Same tests here, same order and short-circuiting, the HP rate computed once
    //   per scan (it cannot change during it), no copies/closures, each script compiled
    //   once. Scripts that are not a plain expression (statements, strings, comments
    //   inside) and scripts that need the plugin's own scope still go through the plugin.
    //   Only applied when the plugin's code is the version this was written against.
    if (hasPlugin("CharacterPictureManager") && Scene_Base.prototype.updateStandPicture) {
        const EXPECT = ["!file.HpUpperLimit || file.HpUpperLimit >= a.hpRate() * 100",
            "!file.HpLowerLimit || file.HpLowerLimit <= a.hpRate() * 100", "!file.Damage || a.isDamage()",
            "!file.Action || a.isAction()", "!file.State || a.isStateAffected(file.State)",
            "!file.Weapon || a.hasWeapon($dataWeapons[file.Weapon])", "!file.Armor || a.hasArmor($dataArmors[file.Armor])",
            "!file.Note || this.findStandPictureMeta() === file.Note", "!file.Switch || $gameSwitches.value(file.Switch)",
            "!file.Script || eval(file.Script)"];
        const compile = src => {
            let s = String(src);
            if (/['"`\\]|\/\*/.test(s)) return null;          // strings / escapes / block comments
            const c = s.indexOf("//");
            if (c >= 0) s = s.slice(0, c);                     // trailing line comment
            s = s.trim().replace(/;+\s*$/, "").trim();
            if (!s || s[0] === "{" || /[;\n]/.test(s)) return null; // one expression only
            try { return new Function("a", "file", "picture", "return (" + s + ");"); } catch (e) { return null; }
        };
        const patch = P => {
            if (!P || typeof P.setFileNameIfValid !== "function" || typeof P.updatePictureFiles !== "function") return;
            const srcSet = String(P.setFileNameIfValid), srcUpd = String(P.updatePictureFiles);
            let at = 0;
            for (const e of EXPECT) { const i = srcSet.indexOf(e, at); if (i < 0) return; at = i + e.length; }
            if (!srcUpd.includes("picture.FileList.clone().reverse().some(file => this.setFileNameIfValid(file, picture))")) return;
            const origSet = P.setFileNameIfValid, origUpd = P.updatePictureFiles;
            const scripts = new Map();                         // script text -> function | null (use plugin)
            P.setFileNameIfValid = function(file, picture) {
                let fn = null;
                if (file.Script) {
                    fn = scripts.get(file.Script);
                    if (fn === undefined) { fn = compile(file.Script); scripts.set(file.Script, fn); }
                    if (fn === null) return origSet.call(this, file, picture);
                }
                picture.FileName = null;
                const a = this._actor;
                // a.hpRate() is the expensive part (mhp goes through every trait/passive plugin:
                // ~35 us on RK3566 in that game); it cannot change during one scan of the lists
                const hpr = () => this._gkdHpScan ? (this._gkdHp === undefined ? (this._gkdHp = a.hpRate() * 100) : this._gkdHp) : a.hpRate() * 100;
                if ((!file.HpUpperLimit || file.HpUpperLimit >= hpr()) &&
                    (!file.HpLowerLimit || file.HpLowerLimit <= hpr()) &&
                    (!file.Damage || a.isDamage()) &&
                    (!file.Action || a.isAction()) &&
                    (!file.State || a.isStateAffected(file.State)) &&
                    (!file.Weapon || a.hasWeapon($dataWeapons[file.Weapon])) &&
                    (!file.Armor || a.hasArmor($dataArmors[file.Armor])) &&
                    (!file.Note || this.findStandPictureMeta() === file.Note) &&
                    (!file.Switch || $gameSwitches.value(file.Switch))) {
                    if (fn) {
                        let ok;
                        try { ok = fn.call(this, a, file, picture); } catch (e) {
                            if (!(e instanceof ReferenceError)) throw e;
                            scripts.set(file.Script, null);    // needs the plugin's scope
                            return origSet.call(this, file, picture);
                        }
                        if (!ok) return false;
                    }
                    picture.FileName = file.FileName;
                    return true;
                }
                return false;
            };
            // Memo: when every file of an actor only tests HP limits, states and scripts made of
            // a.isStateAffected(n) / a.tpRate() / a.hpRate() and operators, the chosen files depend
            // on (HP rate, TP rate, states) only: if those did not change, the last result is reused.
            const memoOk = new WeakMap();
            const plainScript = src => /^[\s()0-9.<>=!&|+\-*\/;]*$/.test(String(src).replace(/\/\/[^\n]*/g, "")
                .replace(/a\.isStateAffected\(\d+\)|a\.tpRate\(\)|a\.hpRate\(\)/g, ""));
            const canMemo = pics => {
                let ok = memoOk.get(pics);
                if (ok === undefined) {
                    ok = pics.every(pic => !pic.DynamicFileName && (pic.FileList || []).every(f =>
                        !f.Damage && !f.Action && !f.Weapon && !f.Armor && !f.Note && !f.Switch &&
                        (!f.Script || (plainScript(f.Script) && compile(f.Script)))));
                    memoOk.set(pics, ok);
                }
                return ok;
            };
            P.updatePictureFiles = function() {
                const pics = this._standPictures;
                let key = null;
                this._gkdHp = undefined;
                if (canMemo(pics)) {
                    const a = this._actor;
                    this._gkdHp = a.hpRate() * 100;
                    key = this._gkdHp + "|" + a.tpRate() + "|" + a._states.join(",");
                    if (key === this._gkdKey) {
                        pics.forEach((pic, i) => { if (pic.FileList && pic.FileList.length) pic.FileName = this._gkdNames[i]; });
                        return pics;
                    }
                }
                this._gkdHpScan = true;
                try { this._standPictures.forEach(picture => {
                    if (!picture.FileList) return;
                    const list = picture.FileList;
                    for (let i = list.length - 1; i >= 0; i--) {
                        if (this.setFileNameIfValid(list[i], picture)) break;
                    }
                    if (!picture.FileName && picture.DynamicFileName) {
                        picture.FileName = this.createDynamicFileName(picture.DynamicFileName);
                    }
                }); } finally { this._gkdHpScan = false; }
                if (key !== null) { this._gkdKey = key; this._gkdNames = pics.map(pic => pic.FileName); }
                return this._standPictures;
            };
            window.PMZ_FIX = Object.assign(window.PMZ_FIX || {}, {
                cpmProto: P, cpmSetOrig: origSet, cpmUpdOrig: origUpd,
                cpmSetFast: P.setFileNameIfValid, cpmUpdFast: P.updatePictureFiles, cpmScripts: scripts, cpmCanMemo: canMemo });
        };
        let tried = false;
        const _updateStandPicture = Scene_Base.prototype.updateStandPicture;
        Scene_Base.prototype.updateStandPicture = function(actor) {
            _updateStandPicture.apply(this, arguments);
            if (!tried && this._standSprites && actor) {
                const s = this._standSprites.get(actor.actorId());
                if (s && s._pictures) { tried = true; patch(Object.getPrototypeOf(s._pictures)); }
            }
        };
    }
})();
