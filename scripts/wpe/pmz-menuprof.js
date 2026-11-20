// Phase timing of scene changes (dev): inject through the REPL, then PMZ_MP.report().
// Records per scene: snap (snapForBackground), terminate of the old scene, create, wait for
// isReady (with the images loaded meanwhile), start, first update; plus every window
// constructor > 20 ms and every image load (url, ms).
(function () {
    if (window.PMZ_MP) return "already";
    const now = () => performance.now();
    const R = { log: [], cur: null };
    const mark = (k, ms, extra) => { if (R.cur) R.cur.parts.push(k + "=" + Math.round(ms) + (extra ? "(" + extra + ")" : "")); };
    const wrap = (obj, name, label) => {
        const f = obj[name];
        if (typeof f !== "function" || f.__mp) return;
        obj[name] = function () {
            const t = now();
            try { return f.apply(this, arguments); } finally { mark(label || name, now() - t); }
        };
        obj[name].__mp = true;
    };
    wrap(SceneManager, "snapForBackground", "snap");
    const _goto = SceneManager.goto, _push = SceneManager.push;
    const begin = (cls) => { R.cur = { scene: cls && cls.name, t0: now(), parts: [], imgs: [] }; };
    SceneManager.push = function (cls) { begin(cls); return _push.apply(this, arguments); };
    SceneManager.goto = function (cls) { if (!R.cur || R.cur.done) begin(cls); return _goto.apply(this, arguments); };
    const _change = SceneManager.changeScene;
    SceneManager.changeScene = function () {
        const s = this._scene, n = this._nextScene;
        const t = now();
        const r = _change.apply(this, arguments);
        if (n && this._scene === n && R.cur) mark("terminate+create", now() - t);
        if (n && this._scene === n) this._mpCreated = now();
        return r;
    };
    const _updateScene = SceneManager.updateScene;
    SceneManager.updateScene = function () {
        const s = this._scene;
        const wasStarted = s && s._started;
        const t = now();
        const r = _updateScene.apply(this, arguments);
        if (s && !wasStarted && s._started && R.cur && !R.cur.done) {
            mark("wait-ready", t - (this._mpCreated || t));
            mark("start", now() - t);
            R.cur.total = Math.round(now() - R.cur.t0);
            R.cur.done = true;
            R.log.push(R.cur);
        }
        return r;
    };
    // window constructors
    for (const k of Object.keys(window)) {
        const C = window[k];
        if (typeof C === "function" && /^Window_/.test(k) && C.prototype && C.prototype.initialize && !C.prototype.initialize.__mp) {
            const f = C.prototype.initialize;
            if (Object.prototype.hasOwnProperty.call(C.prototype, "initialize")) {
                C.prototype.initialize = function () {
                    const t = now();
                    const r = f.apply(this, arguments);
                    const ms = now() - t;
                    if (ms > 20 && this.constructor === C) mark(k, ms);
                    return r;
                };
                C.prototype.initialize.__mp = true;
            }
        }
    }
    // image loads
    const _load = Bitmap.load;
    Bitmap.load = function (url) {
        const b = _load.apply(this, arguments);
        const t = now(), cur = R.cur;
        if (cur && !cur.done) b.addLoadListener(() => cur.imgs.push(String(url).replace(/^img\//, "") + ":" + Math.round(now() - t)));
        return b;
    };
    window.PMZ_MP = {
        report: () => R.log.map(c => c.scene + " total=" + c.total + " | " + c.parts.join(" ") + (c.imgs.length ? " | imgs " + c.imgs.join(" ") : "")).join("^"),
        clear: () => { R.log = []; return "ok"; }
    };
    return "installed";
})();
