// Dev: where does one object's update time go? Set window.PMZ_OBJ to the object (default: the
// battle log window, or the first window of the scene). Every function of its prototype chain
// (up to PIXI.Container) gets a timer as an own property on that one object for
// PMZ_PROFILE_MS ms (default 5000), then the own properties are deleted. Inclusive ms per
// update() call, top 25. Safe while playing (nothing shared is changed).
new Promise((resolve) => {
    const ms = window.PMZ_PROFILE_MS || 5000;
    const sc = SceneManager._scene;
    const obj = window.PMZ_OBJ || (sc._logWindow) || (sc._windowLayer && sc._windowLayer.children[0]);
    if (!obj) return resolve("no object");
    const now = () => performance.now();
    const st = new Map(), added = [];
    const stop = window.PIXI ? PIXI.DisplayObject.prototype : Object.prototype;
    const seen = new Set();
    for (let p = Object.getPrototypeOf(obj); p && p !== stop && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
        const owner = p.constructor ? p.constructor.name : "?";
        for (const k of Object.getOwnPropertyNames(p)) {
            if (seen.has(k) || k === "constructor") continue;
            const d = Object.getOwnPropertyDescriptor(p, k);
            if (!d || typeof d.value !== "function" || Object.prototype.hasOwnProperty.call(obj, k)) continue;
            seen.add(k);
            const f = d.value, s = { ms: 0, n: 0, owner };
            st.set(k, s);
            obj[k] = function() { const a = now(); try { return f.apply(this, arguments); } finally { s.ms += now() - a; s.n++; } };
            added.push(k);
        }
    }
    setTimeout(() => {
        for (const k of added) delete obj[k];
        const u = st.get("update"), calls = Math.max(u ? u.n : 1, 1);
        resolve((window.PMZ_INFO ? window.PMZ_INFO + "\n" : "") + obj.constructor.name + ": " + calls + " updates\n" + [...st.entries()].filter(([, s]) => s.n)
            .sort((a, b) => b[1].ms - a[1].ms).slice(0, 25)
            .map(([k, s]) => (s.ms / calls).toFixed(3).padStart(7) + "ms x" + (s.n / calls).toFixed(1).padStart(5) + "  " + s.owner + "." + k).join("\n"));
    }, ms);
});
