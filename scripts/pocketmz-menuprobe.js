// Dev: passive timing probe for menu scenes (install through the PocketMZ_Debug REPL; lost on
// restart). For every menu scene pushed: snapshot time, create time, time to its first
// frame, per-tick update/render, per-window update cost, and every image loaded meanwhile
// (time to load, size, file). Read with: PMZ_MENU.report()
(() => {
    if (window.PMZ_MENU) return "already installed";
    const M = window.PMZ_MENU = { log: [] };
    const now = () => performance.now();
    const add = (k, d) => { if (M.cur) M.cur[k] = (M.cur[k] || 0) + d; };
    const timed = (o, n, k) => {
        const f = o[n];
        o[n] = function() { const a = now(); try { return f.apply(this, arguments); } finally { add(k, now() - a); } };
    };
    const inMenu = () => SceneManager._scene instanceof Scene_MenuBase;
    const push = SceneManager.push;
    SceneManager.push = function(cls) {
        if (cls && cls.prototype instanceof Scene_MenuBase) {
            M.cur = { scene: cls.name, t0: now(), frames: 0, ticks: 0, upd: 0, render: 0, parts: {}, loads: [] };
            M.log.push(M.cur);
        }
        return push.apply(this, arguments);
    };
    timed(SceneManager, "snapForBackground", "snapMs");
    timed(Scene_MenuBase.prototype, "create", "createMs");
    const start = Scene_MenuBase.prototype.start;
    Scene_MenuBase.prototype.start = function() {
        const c = M.cur;
        if (c && !c.firstFrameMs) c.firstFrameMs = Math.round(now() - c.t0);
        const r = start.apply(this, arguments);
        if (c && !c.wrapped) {
            c.wrapped = true;
            const kids = [];
            for (const ch of this.children) {
                if (ch instanceof WindowLayer) kids.push(...ch.children); else kids.push(ch);
            }
            kids.forEach((k, i) => {
                const f = k.update;
                if (typeof f !== "function") return;
                const key = i + ":" + k.constructor.name;
                k.update = function() {
                    if (c.ticks > 300) return f.apply(this, arguments);
                    const a = now();
                    try { return f.apply(this, arguments); } finally { c.parts[key] = (c.parts[key] || 0) + now() - a; }
                };
            });
        }
        return r;
    };
    const r = Graphics.app.renderer, r0 = r.render;
    r.render = function() {
        const a = now();
        try { return r0.apply(this, arguments); } finally {
            const c = M.cur;
            if (c && inMenu() && c.frames < 300) { c.render += now() - a; c.frames++; }
        }
    };
    const u0 = SceneManager.updateMain;
    SceneManager.updateMain = function() {
        const a = now();
        try { return u0.apply(this, arguments); } finally {
            const c = M.cur;
            if (c && inMenu() && c.ticks < 300) { c.upd += now() - a; c.ticks++; }
        }
    };
    const load = ImageManager.loadBitmapFromUrl;
    ImageManager.loadBitmapFromUrl = function(url) {
        const cached = !!(this._cache[url] || this._system[url]);
        const b = load.apply(this, arguments);
        const c = M.cur;
        if (c && !cached && !b.isReady()) {
            const t0 = now(), i = c.loads.push(null) - 1;
            b.addLoadListener(() => {
                c.loads[i] = Math.round(now() - t0) + "ms " + b.width + "x" + b.height + " " + decodeURIComponent(url).replace("img/", "");
            });
        }
        return b;
    };
    M.report = () => M.log.map(c => ({
        scene: c.scene, snapMs: Math.round(c.snapMs || 0), createMs: Math.round(c.createMs || 0),
        firstFrameMs: c.firstFrameMs, ticks: c.ticks, frames: c.frames,
        updMs: c.ticks ? +(c.upd / c.ticks).toFixed(1) : null,
        renderMs: c.frames ? +(c.render / c.frames).toFixed(1) : null,
        parts: Object.entries(c.parts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => k + "=" + (v / (c.ticks || 1)).toFixed(2)),
        loads: c.loads.length, slowLoads: c.loads.filter(Boolean).sort((a, b) => parseInt(b) - parseInt(a)).slice(0, 8)
    }));
    return "menu probe installed";
})()
