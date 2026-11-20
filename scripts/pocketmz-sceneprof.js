// Dev: where does the current scene's update time go? Read-only and safe to run while someone
// plays: for PMZ_PROFILE_MS ms (default 8000) it wraps .update of the scene, its display
// objects (down to depth 4) and BattleManager/$gameMap/$gameTroop with per-instance timers
// (own property on the object, deleted afterwards; prototypes are not touched). Also times
// the renderer. Result: inclusive ms per scene tick, by object path (Class#index), top 30.
new Promise((resolve) => {
    const ms = window.PMZ_PROFILE_MS || 8000;
    const now = () => performance.now();
    const stats = new Map(), undo = [];
    let ticks = 0;
    const wrap = (obj, key, label) => {
        if (!obj || typeof obj[key] !== "function" || stats.has(label)) return;
        // singletons (SceneManager, BattleManager...) have own functions: put the original back;
        // display objects get an own property that is deleted again (prototype untouched)
        const own = Object.prototype.hasOwnProperty.call(obj, key);
        if (own && obj !== SceneManager && obj !== BattleManager && obj !== Graphics && obj !== Graphics.app.renderer) return;
        const orig = obj[key];
        const st = { ms: 0, n: 0 };
        stats.set(label, st);
        obj[key] = function() {
            const a = now();
            try { return orig.apply(this, arguments); } finally { st.ms += now() - a; st.n++; }
        };
        undo.push(() => { if (own) obj[key] = orig; else delete obj[key]; });
    };
    const scene = SceneManager._scene;
    const walk = (o, path, depth) => {
        if (!o || !o.children) return;
        o.children.forEach((c, i) => {
            const p = path + "/" + (c.constructor ? c.constructor.name : "?") + "#" + i;
            wrap(c, "update", p);
            if (depth < 4) walk(c, p, depth + 1);
        });
    };
    wrap(scene, "update", "SCENE " + scene.constructor.name);
    walk(scene, "", 1);
    if (scene.constructor.name === "Scene_Battle") {
        wrap(BattleManager, "update", "BattleManager.update");
        wrap($gameTroop, "updateInterpreter", "$gameTroop.updateInterpreter");
    }
    wrap($gameMap, "update", "$gameMap.update");
    wrap($gameScreen, "update", "$gameScreen.update");
    const R = Graphics.app.renderer;
    wrap(R, "render", "RENDER (renderer.render)");
    wrap(SceneManager, "updateMain", "TICK (updateMain)");
    for (const k of ["updateInputData", "updateEffekseer", "changeScene", "updateScene", "updateFrameCount"])
        wrap(SceneManager, k, "SceneManager." + k);
    wrap(Graphics, "_onTick", "FRAME (Graphics._onTick)");
    const tick = stats.get("TICK (updateMain)");
    setTimeout(() => {
        undo.forEach(f => f());
        const t = Math.max(tick ? tick.n : 1, 1);
        const rows = [...stats.entries()].filter(([, s]) => s.n > 0)
            .sort((a, b) => b[1].ms - a[1].ms).slice(0, 30)
            .map(([k, s]) => (s.ms / t).toFixed(2).padStart(6) + " ms/tick  x" + (s.n / t).toFixed(1) + "  " + k);
        resolve("scene=" + scene.constructor.name + " ticks=" + t + " in " + ms + "ms\n" + rows.join("\n"));
    }, ms);
});
