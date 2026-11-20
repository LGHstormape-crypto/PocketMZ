// Dev: inclusive timing of map-loading functions (install through the PocketMZ_Debug REPL).
// Wraps own prototype functions of a few classes; records calls taking > 3 ms.
// PMZ_EPROF.start() / PMZ_EPROF.report()
(() => {
    if (window.PMZ_EPROF) return "already installed";
    const now = () => performance.now();
    const P = window.PMZ_EPROF = { on: false, t: {} };
    const classes = { Scene_Map, Spriteset_Map, Spriteset_Base, Game_Map, Tilemap, Game_Player, Bitmap, ImageManager, DataManager, Sprite_Character, Game_Event, Game_CharacterBase };
    for (const [cn, C] of Object.entries(classes)) {
        const o = C.prototype && cn !== "ImageManager" && cn !== "DataManager" ? C.prototype : C;
        for (const k of Object.getOwnPropertyNames(o)) {
            if (k === "constructor" || k === "initialize" && cn === "Bitmap") continue;
            const d = Object.getOwnPropertyDescriptor(o, k);
            if (!d || typeof d.value !== "function" || d.value.__gkdWrapped) continue;
            const f = d.value, key = cn + "." + k;
            const w = function() {
                if (!P.on) return f.apply(this, arguments);
                const a = now();
                try { return f.apply(this, arguments); } finally {
                    const dt = now() - a;
                    if (dt > 3) { const e = P.t[key] || (P.t[key] = { n: 0, ms: 0, max: 0 }); e.n++; e.ms += dt; e.max = Math.max(e.max, dt); }
                }
            };
            w.__gkdWrapped = true;
            Object.keys(f).forEach(p => { try { w[p] = f[p]; } catch (e) {} });
            o[k] = w;
        }
    }
    P.start = () => { P.t = {}; P.on = true; return "on"; };
    P.report = () => Object.entries(P.t).sort((a, b) => b[1].ms - a[1].ms).slice(0, 25)
        .map(([k, e]) => `${k} ${Math.round(e.ms)}ms n=${e.n} max=${Math.round(e.max)}`);
    return "entry profiler installed";
})()
