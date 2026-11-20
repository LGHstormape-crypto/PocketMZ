// Dev: who creates Bitmaps (each one = a new canvas + GPU texture upload) while the game runs?
// Wraps Bitmap.prototype.initialize for PMZ_PROFILE_MS ms (default 5000), then puts the
// original back. Result: bitmaps per second by size and creating call site (first frames
// outside rmmz_core / libs), top 12.
new Promise((resolve) => {
    const ms = window.PMZ_PROFILE_MS || 5000;
    const P = Bitmap.prototype, orig = P.initialize;
    const by = new Map();
    let n = 0, px = 0;
    Error.stackTraceLimit = 20;
    P.initialize = function(w, h) {
        n++; px += (w || 0) * (h || 0);
        const fr = String(new Error().stack).split("\n").slice(2)
            .filter(x => !/libs\/|rmmz_core|<anonymous>/.test(x)).slice(0, 3)
            .map(x => x.trim().replace(/^at /, "").replace(/\(.*\/js\//, "(").replace(/:\d+\)$/, ")").slice(0, 60)).join(" < ");
        const k = (w || 0) + "x" + (h || 0) + "  " + fr;
        by.set(k, (by.get(k) || 0) + 1);
        return orig.apply(this, arguments);
    };
    setTimeout(() => {
        P.initialize = orig;
        Error.stackTraceLimit = 10;
        resolve("new Bitmaps " + (n / ms * 1000).toFixed(1) + "/s, " + (px / ms * 1000 / 1e6).toFixed(2) + " Mpx/s, scene=" +
            SceneManager._scene.constructor.name + " map=" + $gameMap.mapId() + "\n" +
            [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
                .map(([k, c]) => (c / ms * 1000).toFixed(1).padStart(5) + "/s  " + k).join("\n"));
    }, ms);
});
