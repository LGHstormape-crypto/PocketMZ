// Dev: where does renderer.render() spend CPU time? Splits each drawn frame into
// updateTransform (whole scene graph), the render traversal (Container.render -> sprite
// batching) and the batch flush; counts visible/renderable display objects, draw calls and
// texture binds. Wraps the scene's own updateTransform/render (instance properties) and the
// GL context's drawElements/bindTexture (instance properties) for PMZ_PROFILE_MS ms (default
// 5000), then deletes them. Safe while playing.
new Promise((resolve) => {
    const ms = window.PMZ_PROFILE_MS || 5000;
    const now = () => performance.now();
    const R = Graphics.app.renderer, gl = R.gl, sc = SceneManager._scene;
    let frames = 0, tAll = 0, tUT = 0, tRen = 0, draws = 0, binds = 0, flushes = 0, tFlush = 0;
    const own = [];
    const wrap = (o, k, f) => { const orig = o[k]; o[k] = f(orig); own.push([o, k, orig]); };
    wrap(R, "render", o => function() { const a = now(); try { return o.apply(this, arguments); } finally { tAll += now() - a; frames++; } });
    wrap(sc, "updateTransform", o => function() { const a = now(); try { return o.apply(this, arguments); } finally { tUT += now() - a; } });
    wrap(sc, "render", o => function() { const a = now(); try { return o.apply(this, arguments); } finally { tRen += now() - a; } });
    wrap(gl, "drawElements", o => function() { draws++; return o.apply(gl, arguments); });
    wrap(gl, "bindTexture", o => function() { binds++; return o.apply(gl, arguments); });
    // per subtree: render time of the scene's children and grandchildren (instance wrappers)
    const sub = new Map();
    const subWrap = (o, label) => {
        if (!o || typeof o.render !== "function" || Object.prototype.hasOwnProperty.call(o, "render")) return;
        const s = { ms: 0, n: 0 }; sub.set(label, s);
        wrap(o, "render", orig => function() { const a = now(); try { return orig.apply(this, arguments); } finally { s.ms += now() - a; s.n++; } });
    };
    (sc.children || []).forEach((c, i) => {
        const l1 = c.constructor.name + "#" + i;
        subWrap(c, l1);
        (c.children || []).forEach((d, j) => {
            subWrap(d, l1 + "/" + d.constructor.name + "#" + j);
            (d.children || []).forEach((e, k) => { if ((e.children || []).length > 3 || e.filters) subWrap(e, l1 + "/" + d.constructor.name + "#" + j + "/" + e.constructor.name + "#" + k); });
        });
    });
    const br = R.plugins && R.plugins.batch;
    if (br && br.flush) wrap(br, "flush", o => function() { const a = now(); flushes++; try { return o.apply(this, arguments); } finally { tFlush += now() - a; } });
    setTimeout(() => {
        for (const [o, k, orig] of own.reverse()) { delete o[k]; if (o[k] !== orig) o[k] = orig; }
        let n = 0, vis = 0, ren = 0, filt = 0, masks = 0;
        const walk = (o, v) => (o.children || []).forEach(c => {
            n++; const cv = v && c.visible;
            if (cv) { vis++; if (c.renderable !== false && c.worldAlpha > 0) ren++; if (c.filters && c.filters.length) filt++; if (c.mask) masks++; }
            walk(c, cv);
        });
        walk(sc, true);
        const f = Math.max(frames, 1);
        resolve(sc.constructor.name + " map " + ($gameMap ? $gameMap.mapId() : "-") + ": " + frames + " frames, per frame " +
            "render " + (tAll / f).toFixed(2) + "ms = updateTransform " + (tUT / f).toFixed(2) + " + traversal " + (tRen / f).toFixed(2) +
            " (of it batch flush " + (tFlush / f).toFixed(2) + " in " + (flushes / f).toFixed(1) + ")" +
            " | drawCalls " + (draws / f).toFixed(1) + " texBinds " + (binds / f).toFixed(1) +
            " | objects " + n + " visible " + vis + " renderable " + ren + " withFilters " + filt + " masks " + masks + "\n" +
            [...sub.entries()].filter(([, s]) => s.n).sort((a, b) => b[1].ms - a[1].ms).slice(0, 12)
                .map(([k, s]) => (s.ms / f).toFixed(2).padStart(6) + "ms  " + k).join("\n"));
    }, ms);
});
