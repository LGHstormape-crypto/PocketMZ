// Dev: shadow test of PocketMZ_PluginFixes sensorFan cache against the plugin's own sensorFan.
// Every frame, for every fan-sensing event, with the real player position and 3 random
// positions around the event: run original and fast, compare return value and fan state.
// PMZ_FANTEST.report()
(() => {
    if (window.PMZ_FANTEST) return "already installed";
    const X = window.PMZ_FANTEST = { n: 0, bad: 0, samples: [], frames: 0 };
    const { sensorFanOrig: fanO, sensorFanFast: fanF, isSideSearchOrig: sideO, isSideSearchFast: sideF } = window.PMZ_FIX || {};
    // original = plugin's sensorFan + plugin's isSideSearch; fast = both GKD versions
    const withSide = (f, sd) => function() { const keep = Game_Event.prototype.isSideSearch; Game_Event.prototype.isSideSearch = sd || keep; try { return f.call(this); } finally { Game_Event.prototype.isSideSearch = keep; } };
    const orig = withSide(fanO, sideO), fast = withSide(fanF, sideF);
    if (!fanO || !fanF) return "no PMZ_FIX.sensorFan* (fix not active)";
    const snap = ev => JSON.stringify([ev._coordinate.map(q => q.slice(0, 3)), ev._sensorRangeC, ev._bothSensorR, ev._bothSensorL]);
    const P = $gamePlayer;
    const upd = Scene_Map.prototype.update;
    Scene_Map.prototype.update = function() {
        upd.apply(this, arguments);
        if (!$gameMap || !$gameSystem.isSensorStart || !$gameSystem.isSensorStart()) return;
        X.frames++;
        const save = [P._x, P._y, P._realX, P._realY, P._direction];
        for (const ev of $gameMap.events()) {
            if (ev.getSensorStatus() !== 1 || !"fd".includes(ev.getSensorType())) continue;
            const isFan = ev.getSensorType() === "f";
            for (let k = 0; k < 4; k++) {
                if (k > 0) {
                    P._x = ev.x + Math.floor(Math.random() * 13) - 6; P._y = ev.y + Math.floor(Math.random() * 13) - 6;
                    P._realX = P._x + (Math.random() < 0.5 ? 0 : Math.random() * 2 - 1); P._realY = P._y + (Math.random() < 0.5 ? 0 : Math.random() * 2 - 1);
                    P._direction = [2, 4, 6, 8][k % 4];
                }
                let a = isFan ? orig.call(ev) : "", sa = isFan ? snap(ev) : "";
                let b = isFan ? fast.call(ev) : "", sb = isFan ? snap(ev) : "";
                if (sideO && sideF) for (const g of [[6, 4, -1, 0], [2, 8, 0, -1], [8, 2, 0, 1], [4, 6, 1, 0]]) {
                    a += "|" + sideO.apply(ev, g) + ev._bothSensorR + ev._bothSensorL;
                    b += "|" + sideF.apply(ev, g) + ev._bothSensorR + ev._bothSensorL;
                }
                X.n++;
                if (a !== b || sa !== sb) {
                    X.bad++;
                    if (X.samples.length < 5) X.samples.push({ ev: ev.eventId(), map: $gameMap.mapId(), a, b, sameState: sa === sb, pos: [ev.x, ev.y, ev.direction(), P._realX, P._realY, P._direction] });
                }
            }
            [P._x, P._y, P._realX, P._realY, P._direction] = save;
        }
    };
    X.report = () => ({ frames: X.frames, comparisons: X.n, mismatches: X.bad, samples: X.samples });
    return "fan shadow test installed";
})()
