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
