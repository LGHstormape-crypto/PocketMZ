// Dev: which WebGL calls does the game make per frame, and which ones block? Read-only:
// wraps every function of the game's WebGL context instance for PMZ_PROFILE_MS ms (default
// 5000), then deletes the wrappers. Result: per drawn frame, calls and ms by function (top 20),
// slow calls (> 8 ms) with a short JS stack of the caller.
new Promise((resolve) => {
    const ms = window.PMZ_PROFILE_MS || 5000;
    const now = () => performance.now();
    const gl = Graphics.app.renderer.gl;
    const st = new Map(), slow = [], callers = new Map();
    const names = [];
    for (let p = Object.getPrototypeOf(gl); p && p !== Object.prototype; p = Object.getPrototypeOf(p))
        for (const k of Object.getOwnPropertyNames(p)) {
            if (names.includes(k) || k === "constructor") continue;
            const d = Object.getOwnPropertyDescriptor(p, k);
            if (d && typeof d.value === "function") names.push(k);
        }
    for (const k of names) {
        if (Object.prototype.hasOwnProperty.call(gl, k)) continue;
        const f = gl[k];
        const s = { n: 0, ms: 0 };
        st.set(k, s);
        gl[k] = function() {
            const a = now();
            try { return f.apply(gl, arguments); } finally {
                const d = now() - a; s.n++; s.ms += d;
                if (k === "texImage2D" || k === "texSubImage2D" || k === "createTexture") {
                    // first callers outside PIXI = who makes or changes the texture
                    const fr = String(new Error().stack).split("\n").slice(2)
                        .filter(x => !/libs\/|<anonymous>/.test(x)).slice(0, 3)
                        .map(x => x.trim().replace(/^at /, "").replace(/\(.*\/js\//, "(").replace(/:\d+\)$/, ")").slice(0, 70)).join(" < ");
                    const c = callers.get(k + " " + fr) || { n: 0, ms: 0 };
                    c.n++; c.ms += d; callers.set(k + " " + fr, c);
                }
                if (d > 8 && slow.length < 12) slow.push(k + " " + d.toFixed(0) + "ms " + String(new Error().stack).split("\n").slice(2, 5).map(x => x.trim().replace(/^at /, "").replace(/\(.*\/js\//, "(").slice(0, 60)).join(" < "));
            }
        };
    }
    const R = Graphics.app.renderer, origRender = R.render;
    let frames = 0;
    R.render = function() { frames++; return origRender.apply(this, arguments); };
    setTimeout(() => {
        for (const k of st.keys()) delete gl[k];
        delete R.render; if (R.render !== origRender) R.render = origRender;
        const f = Math.max(frames, 1);
        const rows = [...st.entries()].filter(([, s]) => s.n).sort((a, b) => b[1].ms - a[1].ms).slice(0, 20)
            .map(([k, s]) => (s.ms / f).toFixed(2).padStart(6) + "ms " + (s.n / f).toFixed(1).padStart(6) + "x  " + k);
        resolve("frames=" + frames + " in " + ms + "ms, per frame:\n" + rows.join("\n") + "\ntexture callers (per second):\n" +
            [...callers.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10)
                .map(([k, c]) => (c.n / ms * 1000).toFixed(1).padStart(5) + "/s " + c.ms.toFixed(0).padStart(5) + "ms  " + k).join("\n") +
            "\nslow calls:\n" + slow.join("\n"));
    }, ms);
});
