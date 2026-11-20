// Dev: is the browser main thread blocked between frames? Read-only, safe while someone plays.
// For PMZ_PROFILE_MS ms (default 8000): own requestAnimationFrame loop (frame intervals),
// PerformanceObserver long tasks (> 50 ms main-thread tasks, with attribution) and the
// JS time of the game's frame (PIXI ticker listeners). Result: one text block.
new Promise((resolve) => {
    const ms = window.PMZ_PROFILE_MS || 8000;
    const now = () => performance.now();
    const iv = [];
    let last = now(), on = true;
    const loop = () => { const t = now(); iv.push(t - last); last = t; if (on) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    const lt = [];
    let obs = null;
    try {
        obs = new PerformanceObserver(list => { for (const e of list.getEntries()) lt.push(Math.round(e.duration)); });
        obs.observe({ entryTypes: ["longtask"] });
    } catch (e) { lt.push("no longtask API"); }
    // JS time inside the PIXI ticker (= game update + render)
    const tk = Graphics.app.ticker;
    let js = 0, jsn = 0;
    const origUpdate = tk.update;
    tk.update = function() { const a = now(); try { return origUpdate.apply(this, arguments); } finally { js += now() - a; jsn++; } };
    const t0 = now();
    setTimeout(() => {
        on = false; tk.update = origUpdate; delete tk.update;
        if (tk.update !== origUpdate) tk.update = origUpdate;
        if (obs) obs.disconnect();
        const s = iv.slice(1).sort((a, b) => a - b), n = s.length, el = now() - t0;
        const q = p => s.length ? s[Math.min(n - 1, Math.floor(p * n))].toFixed(0) : "-";
        const ltSum = lt.filter(x => typeof x === "number").reduce((a, b) => a + b, 0);
        resolve("rAF " + (n / el * 1000).toFixed(1) + "/s  interval p50=" + q(0.5) + " p90=" + q(0.9) + " max=" + q(0.999) + "ms" +
            " | ticker JS " + (js / el * 100).toFixed(0) + "% of time, " + (jsn / el * 1000).toFixed(1) + "/s, " + (js / Math.max(jsn, 1)).toFixed(1) + "ms each" +
            " | longtasks " + lt.length + " total " + ltSum + "ms: " + lt.slice(0, 12).join(","));
    }, ms);
});
