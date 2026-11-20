// Dev: where does Scene_Map's update time go? Times a few core update functions (prototype,
// one by one) and every map event / character sprite / spriteset child (instance wrappers, no
// prototype identity changes) for PMZ_PROFILE_MS ms. Result in ms per tick (per updateMain).
new Promise((resolve) => {
    const ms = window.PMZ_PROFILE_MS || 5000;
    const now = () => performance.now();
    const st = {};
    const add = (k, d) => { const s = st[k] || (st[k] = { t: 0, n: 0 }); s.t += d; s.n++; };
    const restore = [];
    const timed = (f, label) => function() {
        const a = now();
        try { return f.apply(this, arguments); } finally { add(label, now() - a); }
    };
    const wrapProto = (cls, name) => {
        const p = cls.prototype, f = p[name];
        if (typeof f !== "function") return;
        p[name] = timed(f, cls.name + "#" + name);
        restore.push(() => { p[name] = f; });
    };
    const wrapInst = (o, label) => {
        const f = o.update;
        if (typeof f !== "function") return;
        o.update = timed(f, label);
        restore.push(() => { delete o.update; });
    };
    const f0 = SceneManager.updateMain;
    SceneManager.updateMain = timed(f0, "SceneManager.updateMain");
    restore.push(() => { SceneManager.updateMain = f0; });
    const r = Graphics.app.renderer, r0 = r.render;
    r.render = timed(r0, "render");
    restore.push(() => { r.render = r0; });
    [[Scene_Map, "update"], [Scene_Map, "updateMain"], [Game_Map, "update"], [Game_Map, "updateEvents"],
     [Game_Map, "updateInterpreter"], [Game_Map, "refresh"], [Game_Player, "update"], [Game_Screen, "update"],
     [Spriteset_Map, "update"], [Game_CommonEvent, "update"], [Game_Interpreter, "update"],
     [Game_Event, "refresh"], [Game_Event, "updateParallel"], [Game_Character, "updateRoutineMove"],
     [Window_Base, "update"], [Scene_Message, "update"]].forEach(([c, n]) => wrapProto(c, n));
    for (const ev of $gameMap.events()) wrapInst(ev, "ev" + ev.eventId() + " " + ev.event().name);
    const ss = SceneManager._scene._spriteset;
    for (const sp of ss._characterSprites) {
        const c = sp._character;
        wrapInst(sp, "sprite " + (c === $gamePlayer ? "player" : c && c.eventId ? "ev" + c.eventId() : c ? c.constructor.name : "?"));
    }
    const kids = new Set([...ss.children, ...(ss._baseSprite ? ss._baseSprite.children : [])]);
    for (const ch of kids) if (!ss._characterSprites.includes(ch)) wrapInst(ch, "spriteset child " + ch.constructor.name);
    setTimeout(() => {
        restore.reverse().forEach((f) => f());
        const ticks = (st["SceneManager.updateMain"] || { n: 1 }).n;
        resolve({
            ticks, sec: ms / 1000,
            top: Object.entries(st).sort((a, b) => b[1].t - a[1].t).slice(0, 45)
                .map(([k, s]) => (s.t / ticks).toFixed(2) + " ms/tick  x" + (s.n / ticks).toFixed(1) + "  " + k)
        });
    }, ms);
})
