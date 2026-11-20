// Dev: JS-level profile. Wraps every method of the game's classes and singletons (core + plugin
// classes: global names starting with an upper-case letter) with a timer for PMZ_PROFILE_MS ms,
// then restores them. Times are inclusive (a caller includes its wrapped callees) and the
// wrappers add overhead, so read it as a ranking: who calls what how often and how heavy.
new Promise((resolve) => {
    const ms = window.PMZ_PROFILE_MS || 5000;
    const stats = new Map(), wrapped = [];
    const now = () => performance.now();
    const seen = new Set();
    let depth = 0;
    for (const name of Object.getOwnPropertyNames(window)) {
        if (!/^[A-Z]/.test(name) || /^(PIXI|Effekseer|VorbisDecoder|localforage|pako|Utils|JsonEx)$/.test(name)) continue;
        let obj;
        try { obj = window[name]; } catch (e) { continue; }
        if (!obj || (typeof obj !== "function" && typeof obj !== "object")) continue;
        const isNative = (fn) => /\[native code\]/.test(Function.prototype.toString.call(fn));
        if (typeof obj === "function" && isNative(obj)) continue; // Object, Array, Performance...
        if (typeof obj === "object" && Object.getPrototypeOf(obj) !== Object.prototype) continue; // window.performance etc.
        const targets = [[obj, name + "."]];
        if (typeof obj === "function" && obj.prototype) targets.push([obj.prototype, name + "#"]);
        for (const [t, pfx] of targets) {
            if (seen.has(t) || t === Function.prototype || t === Object.prototype) continue;
            seen.add(t);
            for (const k of Object.getOwnPropertyNames(t)) {
                if (k === "constructor" || k === "prototype") continue;
                const d = Object.getOwnPropertyDescriptor(t, k);
                if (!d || typeof d.value !== "function" || !d.writable || !d.configurable) continue;
                const f = d.value;
                const src = Function.prototype.toString.call(f);
                if (/^class\s/.test(src) || /\[native code\]/.test(src)) continue;
                const st = { t: 0, n: 0 };
                stats.set(pfx + k, st);
                const w = function() {
                    if (depth > 40) return Reflect.apply(f, this, arguments); // deep recursion: don't add frames' cost twice
                    depth++;
                    const a = now();
                    try { return Reflect.apply(f, this, arguments); } finally { st.t += now() - a; st.n++; depth--; }
                };
                try { t[k] = w; wrapped.push([t, k, f]); } catch (e) {}
            }
        }
    }
    const fps0 = Graphics._fpsCounter.fps;
    setTimeout(() => {
        for (const [t, k, f] of wrapped) t[k] = f;
        resolve({
            wrapped: wrapped.length, ms, fpsBefore: Math.round(fps0),
            top: [...stats].filter(([, s]) => s.n).sort((a, b) => b[1].t - a[1].t).slice(0, 60)
                .map(([k, s]) => Math.round(s.t) + "ms n=" + s.n + " " + k)
        });
    }, ms);
})
