// Dev: per-frame probe (install through the PocketMZ_Debug REPL; lost on restart).
// Records every frame: logic (updateMain) and render ms, GPU texture uploads (count, Mpx, ms),
// MPP_MapLight darkness repaint ms, images that finished loading. Frames > 50 ms are kept
// with details. Read with PMZ_FRAME.report(sinceMs) / PMZ_FRAME.reset().
(() => {
    if (window.PMZ_FRAME) return "already installed";
    const now = () => performance.now();
    const F = window.PMZ_FRAME = { frames: [], slow: [], t0: now() };
    let cur = null;
    const begin = () => { cur = { t: Math.round(now() - F.t0), upd: 0, ren: 0, up: 0, upPx: 0, upMs: 0, light: 0, imgs: [] }; };
    begin();
    const R = Graphics.app.renderer;
    // texture uploads
    const ts = R.texture, ut = ts.updateTexture;
    ts.updateTexture = function(tex) {
        const a = now(); const r = ut.apply(this, arguments);
        cur.up++; cur.upMs += now() - a; cur.upPx += (tex.realWidth || tex.width || 0) * (tex.realHeight || tex.height || 0);
        if (now() - a > 15) cur.imgs.push("upload " + Math.round(now() - a) + "ms " + (tex.realWidth || tex.width) + "x" + (tex.realHeight || tex.height) + " " + String((tex.resource && tex.resource.url) || (tex.cacheId) || "").slice(-40));
        return r;
    };
    // MapLight darkness repaint
    if (Tilemap.prototype._paintDarknessLayer) {
        const p = Tilemap.prototype._paintDarknessLayer;
        Tilemap.prototype._paintDarknessLayer = function() { const a = now(); try { return p.apply(this, arguments); } finally { cur.light += now() - a; } };
    }
    // image loads finishing
    const lb = ImageManager.loadBitmapFromUrl;
    ImageManager.loadBitmapFromUrl = function(url) {
        const b = lb.apply(this, arguments);
        if (!b.isReady()) { const a = now(); b.addLoadListener(() => cur.imgs.push("img " + Math.round(now() - a) + "ms " + b.width + "x" + b.height + " " + decodeURIComponent(url).replace("img/", ""))); }
        return b;
    };
    const rr = R.render;
    R.render = function() { const a = now(); try { return rr.apply(this, arguments); } finally { cur.ren += now() - a; } };
    const um = SceneManager.updateMain;
    let last = now();
    SceneManager.updateMain = function() {
        const a = now(); const gap = a - last; last = a;
        cur.gap = Math.round(gap);
        const f = cur; F.frames.push(f); if (F.frames.length > 4000) F.frames.shift();
        if (gap > 50) F.slow.push(f);
        begin();
        const b = now(); try { return um.apply(this, arguments); } finally { cur.upd += now() - b; }
    };
    const r1 = x => Math.round(x * 10) / 10;
    F.reset = () => { F.frames = []; F.slow = []; F.t0 = now(); return "reset"; };
    F.report = (since = 0, until = 1e12) => {
        const fr = F.frames.filter(f => f.t >= since && f.t < until); const n = fr.length || 1;
        const avg = k => r1(fr.reduce((s, f) => s + f[k], 0) / n);
        return {
            frames: fr.length, avgGap: avg("gap"), upd: avg("upd"), ren: avg("ren"), light: avg("light"),
            uploadsPerFrame: avg("up"), uploadMpxPerFrame: r1(fr.reduce((s, f) => s + f.upPx, 0) / n / 1e6), uploadMs: avg("upMs"),
            slow: F.slow.filter(f => f.t >= since && f.t < until).slice(0, 12).map(f => `t=${f.t} gap=${f.gap} upd=${Math.round(f.upd)} ren=${Math.round(f.ren)} up=${f.up}/${r1(f.upPx / 1e6)}Mpx/${Math.round(f.upMs)}ms light=${r1(f.light)} ${f.imgs.slice(0, 4).join(" | ")}`)
        };
    };
    return "frame probe installed";
})()
