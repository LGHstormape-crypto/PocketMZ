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
// --- module: patches/src/fixes/01-picture-color-change.js ---
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
// --- module: patches/src/fixes/02-filter-selectable-items.js ---
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
// --- module: patches/src/fixes/03-artm-player-sensor.js ---
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
// --- module: patches/src/fixes/04-character-picture-manager.js ---
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
// --- module: patches/src/fixes/05-panda-resource-preload.js ---
    // ---- PANDA_ResourcePreLoad (MZ; preloads the audio of every event) --------
    //   Its Game_Interpreter#loadImages calls AudioManager.preloadAudio for every BGM / BGS /
    //   ME / SE an event mentions, and preloadAudio keeps each WebAudio (decoded PCM) in
    //   AudioManager._audioBuffers forever; nothing plays from there (AudioManager makes its
    //   own buffer when it plays). After a few maps and battles 126 MB of decoded music
    //   stayed in memory and the game ran out of RAM within 5 minutes. Here music (bgm/ bgs/
    //   me/) is not preloaded (read from the local file when it plays), and a sound effect is
    //   decoded once and dropped again (PocketMZ_Handheld's SE cache keeps the PCM for the
    //   plays). POCKETMZ_PRELOAD_FIX=off keeps the plugin's own behaviour.
    if (hasPlugin("PANDA_ResourcePreLoad") && window.AudioManager && AudioManager.preloadAudio &&
        String((window.process && process.env && process.env.POCKETMZ_PRELOAD_FIX) || "on") !== "off") {
        AudioManager.preloadAudio = function(folder, name) {
            if (!name || folder !== "se/") return;
            const key = folder + name;
            const seen = this._audioBuffers || (this._audioBuffers = []);
            if (seen[key]) return;
            seen[key] = true;                                  // the plugin only checks for presence
            if (!window.PMZ_SE) return;                        // no SE cache: nothing to warm up
            const buffer = this.createBuffer(folder, name);
            buffer.addLoadListener(() => buffer.destroy());    // the cache keeps the decoded PCM
        };
    }
// --- module: patches/src/fixes/06-apng-picture.js ---
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
// --- module: patches/src/fixes/07-nuun-state-icons.js ---
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
// --- module: patches/src/fixes/08-plugin-common-base.js ---
    // ---- PluginCommonBase (per-frame getter regex churn) -----------------------
    //   PluginParam accessors call PluginManagerEx.convertVariables() on every read
    //   (e.g. ApngPicture Sprite.update reading param.FrameCount, PhantomEvent reading
    //   meta values), running 15+ RegExp passes even on static strings without escapes.
    if (hasPlugin("PluginCommonBase") && window.PluginManagerEx && PluginManagerEx.convertVariables &&
        String((window.process && process.env && process.env.POCKETMZ_PCB_FIX) || "on") !== "off") {
        const staticCache = new Map();
        const origConvertVariables = PluginManagerEx.convertVariables;
        PluginManagerEx.convertVariables = function(text, data = null) {
            if (typeof text !== "string") return text;
            if (text.indexOf("\\") < 0 && text.indexOf("\x1b") < 0) {
                if (staticCache.has(text)) return staticCache.get(text);
                if (staticCache.size >= 4096) staticCache.clear();
                let val;
                if (text === "true") val = true;
                else if (text === "false") val = false;
                else {
                    const pf = parseFloat(text);
                    val = (Number(text) === pf) ? pf : text;
                }
                staticCache.set(text, val);
                return val;
            }
            return origConvertVariables.call(this, text, data);
        };

        if (PluginManagerEx.findMetaValue) {
            const origFindMetaValue = PluginManagerEx.findMetaValue;
            PluginManagerEx.findMetaValue = function(object, nameList) {
                const meta = object && object.meta;
                if (!meta) return origFindMetaValue.call(this, object, nameList);
                if (Array.isArray(nameList)) {
                    for (let i = 0; i < nameList.length; i++) {
                        const k = nameList[i];
                        if (Object.prototype.hasOwnProperty.call(meta, k)) {
                            const raw = meta[k];
                            if (typeof raw !== "string" || (raw.indexOf("\\") < 0 && raw.indexOf("\x1b") < 0)) {
                                return this.convertVariables(raw, object);
                            }
                            return origFindMetaValue.call(this, object, nameList);
                        }
                    }
                    return undefined;
                }
                if (Object.prototype.hasOwnProperty.call(meta, nameList)) {
                    const raw = meta[nameList];
                    if (typeof raw !== "string" || (raw.indexOf("\\") < 0 && raw.indexOf("\x1b") < 0)) {
                        return this.convertVariables(raw, object);
                    }
                    return origFindMetaValue.call(this, object, nameList);
                }
                return undefined;
            };
        }
    }
// --- module: patches/src/fixes/09-passive-skill.js ---
    // ---- PassiveSkill (Game_Actor.enableSkills O(N^2) concat churn) ----------
    //   PassiveSkill.js:624 runs `this._enableSkills.reduce((r, id) => r.concat([$dataSkills[id]]), [])`
    //   on every Game_Actor.traitObjects() call. Cache the resolved array between refreshes.
    if (hasPlugin("PassiveSkill") && window.Game_Actor && Game_Actor.prototype.enableSkills) {
        const origEnableSkills = Game_Actor.prototype.enableSkills;
        Game_Actor.prototype.enableSkills = function() {
            if (!this._enableSkills || this._passiveRefresh || this._pmzSkillIds !== this._enableSkills) {
                const rebuilt = origEnableSkills.call(this);
                this._pmzSkillIds = this._enableSkills;
                this._pmzSkillObjs = rebuilt;
                return rebuilt;
            }
            return this._pmzSkillObjs.slice();
        };
    }
// --- module: patches/src/fixes/10-phantom-event.js ---
    // ---- PhantomEvent (per-frame party trait scan for every phantom event) ---
    //   Map events with <VisibleDistance> call $gameParty.findVisibleDistanceRate()
    //   for every event on every frame, re-scanning actor.traitObjects() + meta tags.
    if (hasPlugin("PhantomEvent") && window.Game_Party && Game_Party.prototype.findVisibleDistanceRate) {
        const origFindVdr = Game_Party.prototype.findVisibleDistanceRate;
        Game_Party.prototype.findVisibleDistanceRate = function() {
            const fc = window.Graphics ? Graphics.frameCount : -1;
            if (fc >= 0 && this._pmzVdrFrame === fc) return this._pmzVdrVal;
            const v = origFindVdr.call(this);
            this._pmzVdrFrame = fc;
            this._pmzVdrVal = v;
            return v;
        };
    }
// --- module: patches/src/fixes/11-ll-variable-window.js ---
    // ---- LL_VariableWindowMV / MV2 / MV3 (MV: avoid 4x full-screen Window bitmaps on Scene_Map) ----
    if (Utils.RPGMAKER_NAME === "MV" &&
        String((window.process && process.env && process.env.POCKETMZ_LLVAR_FIX) || "on").toLowerCase() !== "off" &&
        (hasPlugin("LL_VariableWindowMV") || hasPlugin("LL_VariableWindowMV2") || hasPlugin("LL_VariableWindowMV3")) &&
        window.Window_Base && Window_Base.prototype.initialize &&
        !Window_Base.prototype.initialize._pmzLlVarFix) {
        const _llWbInit = Window_Base.prototype.initialize;
        const wrappedLlWbInit = function(x, y, w, h) {
            if (this.constructor && this.constructor.name === "Window_ExVariableWindow" &&
                w === Graphics.boxWidth && h === Graphics.boxHeight && typeof this.fittingHeight === "function") {
                h = this.fittingHeight(1);
            }
            return _llWbInit.call(this, x, y, w, h);
        };
        wrappedLlWbInit._pmzLlVarFix = true;
        Window_Base.prototype.initialize = wrappedLlWbInit;
    }
// --- module: patches/src/fixes/12-tm-name-pop.js ---
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
// --- module: patches/src/fixes/13-111-input-form.js ---
    // ---- 111_InputForm (MV on β: bridge HTML <input> form to native gamepad Scene_Name) ----
    if (Utils.RPGMAKER_NAME === "MV" &&
        String((window.process && process.env && process.env.POCKETMZ_INPUTFORM_FIX) || "on").toLowerCase() !== "off" &&
        hasPlugin("111_InputForm") &&
        typeof document !== "undefined" && !("selectionStart" in document.createElement("input")) &&
        window.Game_Interpreter && Game_Interpreter.prototype.pluginCommand &&
        window.Scene_Name && !Game_Interpreter.prototype.pluginCommand._pmzIfBridge) {
        const ifParam = PluginManager.parameters("111_InputForm") || {};
        const okSw = Number(ifParam["Switch ID Selected OK"] || 0);
        const resolveVarId = tok => {
            const s = String(tok || "").trim();
            const m = /^(V?)([0-9]+)$/i.exec(s);
            if (m) return m[1] ? $gameVariables.value(+m[2]) : +m[2];
            const vars = window.$dataSystem && $dataSystem.variables;
            if (vars) {
                for (let i = 1; i < vars.length; i++) if (vars[i] === s) return i;
            }
            return 0;
        };
        const parseIfArgs = raw => {
            const out = {};
            for (const part of String(raw || "").split(";")) {
                const m = /^(\w+)=(\S*)$/i.exec(part.trim());
                if (!m) continue;
                const k = m[1].toLowerCase(), v = m[2];
                if (k === "v" || k === "init_v") out[k] = resolveVarId(v);
                else if (k === "init") out[k] = v;
                else out[k] = Number(v);
            }
            return out;
        };
        let pendingIf = null;
        const _origPluginCmd = Game_Interpreter.prototype.pluginCommand;
        const wrappedPluginCmd = function(command, args) {
            if (command !== "InputForm") return _origPluginCmd.apply(this, arguments);
            const p = parseIfArgs(args && args[0]);
            const varId = p.v || 0;
            const actorId = p.n || 0;
            const maxLen = Math.max(1, Number(p.max) || 8);
            let initStr = "";
            if (p.init !== undefined) initStr = String(p.init);
            else if (p.init_n && $gameActors.actor(p.init_n)) initStr = $gameActors.actor(p.init_n).name();
            else if (actorId && $gameActors.actor(actorId)) initStr = $gameActors.actor(actorId).name();
            else if (p.init_v) {
                const vv = $gameVariables.value(p.init_v);
                if (typeof vv === "string") initStr = vv;
            } else if (varId) {
                const vv = $gameVariables.value(varId);
                if (typeof vv === "string") initStr = vv;
            }
            const actor = actorId > 0 ? $gameActors.actor(actorId) : null;
            if (actor) {
                const origName = actor.name();
                if (initStr !== origName && (p.init !== undefined || p.init_n || p.init_v)) actor.setName(initStr);
                pendingIf = { actorId, varId, okSw, origName, varOnly: false, val: initStr };
                SceneManager.push(Scene_Name);
                SceneManager.prepareNextScene(actorId, maxLen);
            } else {
                pendingIf = { actorId: 0, varId, okSw, origName: initStr, varOnly: true, val: initStr };
                SceneManager.push(Scene_Name);
                SceneManager.prepareNextScene(0, maxLen);
            }
        };
        wrappedPluginCmd._pmzIfBridge = true;
        Game_Interpreter.prototype.pluginCommand = wrappedPluginCmd;

        const _snCreate = Scene_Name.prototype.create;
        Scene_Name.prototype.create = function() {
            if (!pendingIf || !pendingIf.varOnly) return _snCreate.apply(this, arguments);
            const dummyActor = {
                actorId: () => 0, faceName: () => "", faceIndex: () => 0,
                name: () => pendingIf.val, setName: s => { pendingIf.val = s; }
            };
            const _gaActor = $gameActors.actor;
            $gameActors.actor = function(id) { return id === 0 ? dummyActor : _gaActor.apply(this, arguments); };
            try { return _snCreate.apply(this, arguments); }
            finally { $gameActors.actor = _gaActor; }
        };

        const _snOnOk = Scene_Name.prototype.onInputOk;
        Scene_Name.prototype.onInputOk = function() {
            if (!pendingIf) return _snOnOk.apply(this, arguments);
            const cur = pendingIf;
            pendingIf = null;
            const name = this._editWindow ? this._editWindow.name() : cur.val;
            if (cur.varOnly) {
                if (cur.varId > 0) $gameVariables.setValue(cur.varId, name);
                if (cur.okSw > 0) $gameSwitches.setValue(cur.okSw, true);
                this.popScene();
                return;
            }
            const r = _snOnOk.apply(this, arguments);
            if (cur.varId > 0) $gameVariables.setValue(cur.varId, name);
            if (cur.okSw > 0) $gameSwitches.setValue(cur.okSw, true);
            return r;
        };

        const _snTerm = Scene_Name.prototype.terminate;
        Scene_Name.prototype.terminate = function() {
            if (pendingIf) {
                const cur = pendingIf;
                pendingIf = null;
                if (!cur.varOnly && cur.actorId > 0 && $gameActors.actor(cur.actorId)) {
                    $gameActors.actor(cur.actorId).setName(cur.origName);
                }
                if (cur.okSw > 0) $gameSwitches.setValue(cur.okSw, false);
            }
            return _snTerm.apply(this, arguments);
        };

        // Compact Scene_Name layout on short screens (e.g. 745x400) so all 9 rows + edit box fit
        if (window.Window_NameEdit && window.Window_NameInput) {
            const WNE = Window_NameEdit.prototype;
            const _wneInit = WNE.initialize, _wneWh = WNE.windowHeight, _wneFw = WNE.faceWidth;
            const _wnePad = WNE.standardPadding, _wneLh = WNE.lineHeight, _wneIr = WNE.itemRect;
            const compact = () => !!pendingIf && Graphics.boxHeight < 560;
            WNE.windowHeight = function() { return compact() ? 64 : _wneWh.call(this); };
            WNE.faceWidth = function() { return compact() ? 0 : _wneFw.call(this); };
            WNE.standardPadding = function() { return compact() ? 10 : _wnePad.call(this); };
            WNE.lineHeight = function() { return compact() ? 28 : _wneLh.call(this); };
            WNE.initialize = function(actor, maxLength) {
                const r = _wneInit.apply(this, arguments);
                if (compact()) { this.y = 8; this.refresh(); }
                return r;
            };
            WNE.itemRect = function(index) {
                const r = _wneIr.call(this, index);
                if (compact()) r.y = Math.max(0, Math.floor((this.contentsHeight() - r.height) / 2));
                return r;
            };
            const WNI = Window_NameInput.prototype;
            const _wniInit = WNI.initialize, _wniPad = WNI.standardPadding;
            const _wniFs = WNI.standardFontSize, _wniLh = WNI.lineHeight;
            WNI.standardPadding = function() { return compact() ? 10 : _wniPad.call(this); };
            WNI.standardFontSize = function() { return compact() ? 20 : _wniFs.call(this); };
            WNI.lineHeight = function() { return compact() ? Math.max(24, Math.floor((Graphics.boxHeight - 104) / 9)) : _wniLh.call(this); };
            WNI.initialize = function(editWindow) {
                const r = _wniInit.apply(this, arguments);
                if (compact() && editWindow) {
                    this.y = editWindow.y + editWindow.height + 6;
                    this.refresh();
                    this.updateCursor();
                }
                return r;
            };
        }
    }
// --- module: patches/src/fixes/14-ftkr-ex-message-window2.js ---
    // ---- FTKR_ExMessageWindow2 (MV: skip closed-idle Window_MessageEx updates) ----
    if (Utils.RPGMAKER_NAME === "MV" &&
        String((window.process && process.env && process.env.POCKETMZ_FTKR_MSG_FIX) || "on").toLowerCase() !== "off" &&
        hasPlugin("FTKR_ExMessageWindow2") &&
        window.Window_MessageEx && Window_MessageEx.prototype.update &&
        !Window_MessageEx.prototype.update._pmzFtkrSkip) {
        const _wmExUpdate = Window_MessageEx.prototype.update;
        const wrappedWmExUpdate = function() {
            if (this.openness === 0 && !this._opening && !this._closing &&
                !this._textState && !this._waitCount &&
                this._gameMessage && !this._gameMessage.isBusy()) {
                return;
            }
            return _wmExUpdate.apply(this, arguments);
        };
        wrappedWmExUpdate._pmzFtkrSkip = true;
        Window_MessageEx.prototype.update = wrappedWmExUpdate;
    }
// --- module: patches/src/fixes/15-dtext-picture.js ---
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
// --- module: patches/src/fixes/16-generic-ime.js ---
    // ---- Generic <input>/<textarea> IME bridge -> native gamepad Scene_Name ----
    if (String((window.process && process.env && process.env.POCKETMZ_GENERIC_IME) || "on").toLowerCase() !== "off" &&
        window.SceneManager && window.Scene_Name && window.$gameActors) {
        let pendingIme = null;
        if (!Scene_Name.prototype._pmzImeWrapped) {
            Scene_Name.prototype._pmzImeWrapped = true;
            const _snCreate = Scene_Name.prototype.create;
            Scene_Name.prototype.create = function() {
                if (!pendingIme) return _snCreate.apply(this, arguments);
                const dummyActor = {
                    actorId: () => 0, faceName: () => "", faceIndex: () => 0,
                    name: () => pendingIme.val, setName: s => { pendingIme.val = String(s || ""); }
                };
                const _gaActor = $gameActors.actor;
                $gameActors.actor = function(id) { return id === 0 ? dummyActor : _gaActor.apply(this, arguments); };
                try { return _snCreate.apply(this, arguments); }
                finally { $gameActors.actor = _gaActor; }
            };
            const _snOnOk = Scene_Name.prototype.onInputOk;
            Scene_Name.prototype.onInputOk = function() {
                if (!pendingIme) return _snOnOk.apply(this, arguments);
                const cur = pendingIme;
                pendingIme = null;
                const name = this._editWindow ? this._editWindow.name() : cur.val;
                cur.el.value = name;
                const dispatch = (type, extra) => {
                    if (typeof cur.el.dispatchEvent === "function") {
                        cur.el.dispatchEvent(Object.assign({ type, target: cur.el, currentTarget: cur.el }, extra));
                    }
                };
                dispatch("input", {});
                dispatch("change", {});
                dispatch("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13 });
                this.popScene();
                if (typeof cur.el.blur === "function") cur.el.blur();
            };
            const _snTerm = Scene_Name.prototype.terminate;
            Scene_Name.prototype.terminate = function() {
                if (pendingIme) {
                    const cur = pendingIme;
                    pendingIme = null;
                    if (typeof cur.el.blur === "function") cur.el.blur();
                }
                return _snTerm.apply(this, arguments);
            };
            if (window.Window_NameEdit && window.Window_NameInput) {
                const compact = () => !!pendingIme && window.Graphics && Graphics.boxHeight < 560;
                const WNE = Window_NameEdit.prototype;
                const _wneInit = WNE.initialize, _wneWh = WNE.windowHeight, _wneFw = WNE.faceWidth;
                const _wnePad = WNE.standardPadding, _wneLh = WNE.lineHeight, _wneIr = WNE.itemRect;
                WNE.windowHeight = function() { return compact() ? 64 : _wneWh.call(this); };
                WNE.faceWidth = function() { return compact() ? 0 : _wneFw.call(this); };
                WNE.standardPadding = function() { return compact() ? 10 : _wnePad.call(this); };
                WNE.lineHeight = function() { return compact() ? 28 : _wneLh.call(this); };
                WNE.initialize = function() {
                    const r = _wneInit.apply(this, arguments);
                    if (compact()) { this.y = 8; this.refresh(); }
                    return r;
                };
                WNE.itemRect = function(index) {
                    const r = _wneIr.call(this, index);
                    if (compact()) r.y = Math.max(0, Math.floor((this.contentsHeight() - r.height) / 2));
                    return r;
                };
                const WNI = Window_NameInput.prototype;
                const _wniInit = WNI.initialize, _wniPad = WNI.standardPadding;
                const _wniFs = WNI.standardFontSize, _wniLh = WNI.lineHeight;
                WNI.standardPadding = function() { return compact() ? 10 : _wniPad.call(this); };
                WNI.standardFontSize = function() { return compact() ? 20 : _wniFs.call(this); };
                WNI.lineHeight = function() { return compact() ? Math.max(24, Math.floor((Graphics.boxHeight - 104) / 9)) : _wniLh.call(this); };
                WNI.initialize = function(editWindow) {
                    const r = _wniInit.apply(this, arguments);
                    if (compact() && editWindow) {
                        this.y = editWindow.y + editWindow.height + 6;
                        this.refresh();
                        this.updateCursor();
                    }
                    return r;
                };
            }
        }
        window.__pmzOpenIme = function(el) {
            if (!el || !window.SceneManager || !window.Scene_Name || !window.$gameActors) return false;
            if (pendingIme || SceneManager._scene instanceof Scene_Name) return false;
            const initVal = String(el.value || "");
            const maxLen = el.maxLength > 0 ? Math.min(32, Math.max(1, Number(el.maxLength))) : 16;
            pendingIme = { el, val: initVal };
            SceneManager.push(Scene_Name);
            SceneManager.prepareNextScene(0, maxLen);
            return true;
        };
    }
})();
