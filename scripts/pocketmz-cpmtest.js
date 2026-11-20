// Dev: shadow test of the CharacterPictureManager fix in PocketMZ_PluginFixes.js. Needs a scene
// with stand pictures (battle). For every shown actor and many HP / TP / state combinations
// it runs the plugin's own file selection and the fast one and compares the chosen files.
// Actor state is put back afterwards. Also times both.
(() => {
    const F = window.PMZ_FIX;
    if (!F || !F.cpmProto) return "fix not applied";
    const scene = SceneManager._scene;
    const sprites = scene._standSprites ? [...scene._standSprites.values()] : [];
    if (!sprites.length) return "no stand pictures in this scene";
    const names = p => p._standPictures.map(x => x.FileName).join("|");
    let n = 0, tOrig = 0, tFast = 0;
    const bad = [];
    const now = () => performance.now();
    for (const s of sprites) {
        const p = s._pictures, act = p._actor;
        const save = { hp: act._hp, tp: act._tp, states: act._states.slice(), turns: Object.assign({}, act._stateTurns) };
        const ids = new Set();
        for (const pic of p._standPictures) for (const f of (pic.FileList || [])) {
            if (f.State) ids.add(Number(f.State));
            for (const m of String(f.Script || "").matchAll(/isStateAffected\((\d+)\)/g)) ids.add(Number(m[1]));
        }
        const list = [...ids];
        const combos = [[]].concat(list.map(i => [i]));
        for (let k = 0; k < 40 && list.length > 1; k++) combos.push([list[k % list.length], list[(k * 7 + 3) % list.length]]);
        for (const hpr of [1, 0.8, 0.5, 0.3, 0.1])
            for (const tp of [0, 50, 51, 100])
                for (const st of combos) {
                    act._hp = Math.max(1, Math.round(act.mhp * hpr)); act._tp = tp; act._states = st.slice();
                    // plugin path: its own update + its own per-file test
                    F.cpmProto.setFileNameIfValid = F.cpmSetOrig;
                    let a = now(); F.cpmUpdOrig.call(p); tOrig += now() - a; const x = names(p);
                    F.cpmProto.setFileNameIfValid = F.cpmSetFast;
                    a = now(); F.cpmUpdFast.call(p); tFast += now() - a; const y = names(p);
                    F.cpmUpdFast.call(p); const y2 = names(p);   // second call: memo path
                    n++;
                    if ((x !== y || y !== y2) && bad.length < 8) bad.push(act.actorId() + " hp" + hpr + " tp" + tp + " st[" + st + "]: " + x + " != " + y + (y !== y2 ? " (memo " + y2 + ")" : ""));
                }
        act._hp = save.hp; act._tp = save.tp; act._states = save.states; act._stateTurns = save.turns;
        F.cpmUpdFast.call(p);
    }
    const sc = [...F.cpmScripts.values()];
    return "actors " + sprites.length + ", checks " + n + ", mismatches " + bad.length +
        " | per update: plugin " + (tOrig / n).toFixed(3) + "ms, fast " + (tFast / n).toFixed(3) + "ms" +
        " | scripts compiled " + sc.filter(f => f).length + ", via plugin " + sc.filter(f => !f).length +
        (bad.length ? "\n" + bad.join("\n") : "");
})()
