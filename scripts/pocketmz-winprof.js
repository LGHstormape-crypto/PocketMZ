// Dev: render cost inside windows. For every open window, every descendant gets an instance
// render() timer for PMZ_PROFILE_MS ms (default 5000; deleted afterwards). Result: inclusive ms
// per frame by path inside the window (summed over windows), with filters noted. Safe to run.
new Promise((resolve) => {
    const ms = window.PMZ_PROFILE_MS || 5000;
    const now = () => performance.now();
    const sc = SceneManager._scene, wl = sc._windowLayer;
    const st = new Map(), undo = [];
    let frames = 0;
    const R = Graphics.app.renderer, oR = R.render;
    R.render = function() { frames++; return oR.apply(this, arguments); };
    const wrap = (o, label) => {
        if (!o || typeof o.render !== "function" || Object.prototype.hasOwnProperty.call(o, "render")) return;
        const f = o.render, s = st.get(label) || { ms: 0, n: 0 };
        st.set(label, s);
        o.render = function() { const a = now(); try { return f.apply(this, arguments); } finally { s.ms += now() - a; s.n++; } };
        undo.push(() => delete o.render);
    };
    const walk = (o, path, d) => (o.children || []).forEach((c, i) => {
        const fl = (c.filters || []).filter(x => x && x.enabled !== false).map(x => x.constructor.name);
        const p = path + "/" + c.constructor.name + "#" + i + (fl.length ? "[" + fl.join(",") + "]" : "");
        wrap(c, p);
        if (d < 4) walk(c, p, d + 1);
    });
    (wl ? wl.children : []).forEach(w => { if (w._isWindow && w.visible && w.openness > 0) { wrap(w, "WINDOW"); walk(w, "W", 1); } });
    setTimeout(() => {
        undo.forEach(f => f()); delete R.render; if (R.render !== oR) R.render = oR;
        const f = Math.max(frames, 1);
        resolve("frames " + frames + "\n" + [...st.entries()].filter(([, s]) => s.n).sort((a, b) => b[1].ms - a[1].ms).slice(0, 22)
            .map(([k, s]) => (s.ms / f).toFixed(3).padStart(7) + "ms x" + (s.n / f).toFixed(1).padStart(4) + "  " + k).join("\n"));
    }, ms);
});
