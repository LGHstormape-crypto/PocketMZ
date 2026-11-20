// PocketMZ WPE prototype probe: reports to /__log every 2 s (fps, scene, errors) and runs a
// text-drawing benchmark once the map is up. Works in NW.js too (log via console when no server).
(function () {
    "use strict";
    const send = (s) => {
        try { fetch("/__log?" + encodeURIComponent(s)).catch(() => {}); } catch (e) { console.log(s); }
    };
    window.PMZ_PROBE_LOG = send;
    send("probe ua=" + navigator.userAgent);
    window.addEventListener("error", (e) => send("error " + (e.message || e) + " @" + (e.filename || "") + ":" + (e.lineno || "")));
    window.addEventListener("unhandledrejection", (e) => send("reject " + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
    let frames = 0, worst = 0, last = performance.now(), t0 = last;
    const raf = () => {
        const now = performance.now();
        worst = Math.max(worst, now - last); last = now; frames++;
        requestAnimationFrame(raf);
    };
    requestAnimationFrame(raf);
    let gframes = 0, textDone = false;
    const hook = () => {   // count real renders (the 30 fps option skips every other render)
        const R = window.Graphics && (Graphics._app ? Graphics._app.renderer : Graphics._renderer);
        if (!R || !R.render) return setTimeout(hook, 200);
        const f = R.render;
        R.render = function () { gframes++; return f.apply(this, arguments); };
    };
    hook();
    const sceneName = () => {
        const s = window.SceneManager && SceneManager._scene;
        return s ? s.constructor.name : "-";
    };
    const textBench = () => {
        // 300 drawText calls on a window-size bitmap, with a fresh font each 50 (like refresh)
        const b = new Bitmap(816, 624);
        const t = performance.now();
        for (let i = 0; i < 300; i++) {
            if (i % 50 === 0) { b.clear(); b.fontSize = 22 + (i / 50 | 0); }
            b.drawText("PocketMZ テキスト速度 " + i + " あいうえお漢字", 4, (i % 25) * 24, 800, 24, "left");
        }
        const dt = performance.now() - t;
        const t2 = performance.now();
        let w = 0;
        for (let i = 0; i < 2000; i++) w += b.measureTextWidth("測定テキスト" + i);
        const dt2 = performance.now() - t2;
        b.destroy && b.destroy();
        send("textbench drawText300=" + dt.toFixed(0) + "ms measure2000=" + dt2.toFixed(0) + "ms");
    };
    // dev REPL client (server side: 127.0.0.1:9333 in pmz-wpe-serve.py): long-poll /__cmd, run the
    // code (a Promise is awaited), post JSON.stringify(result) to /__res/<id>
    const repl = () => {
        fetch("/__cmd").then((r) => (r.status === 200 ? r.json() : null)).then(async (c) => {
            if (c) {
                let out;
                try { out = await (0, eval)(c.code); } catch (e) { out = "THROW " + (e && e.stack || e); }
                let txt;
                try { txt = out === undefined ? "undefined" : JSON.stringify(out); } catch (e) { txt = JSON.stringify(String(out)); }
                await fetch("/__res/" + c.id, { method: "POST", body: txt }).catch(() => {});
            }
            setTimeout(repl, 0);
        }).catch(() => setTimeout(repl, 1000));
    };
    repl();
    setInterval(() => {
        const now = performance.now(), el = (now - t0) / 1000;
        const sc = sceneName();
        let rs = "";
        try {
            const r = window.Graphics && (Graphics._app ? Graphics._app.renderer : Graphics._renderer);
            if (r) rs = " res=" + r.resolution + " " + r.width + "x" + r.height + " gl=" + (r.gl ? 1 : 0);
        } catch (e) {}
        send("tick t=" + el.toFixed(0) + " raf=" + (frames / 2).toFixed(0) + " fps=" + (gframes / 2).toFixed(0) +
             " worst=" + worst.toFixed(0) + "ms scene=" + sc + rs + " win=" + innerWidth + "x" + innerHeight);
        frames = 0; gframes = 0; worst = 0;
        if (!textDone && sc === "Scene_Map" && el > 25) { textDone = true; setTimeout(textBench, 100); }
    }, 2000);
})();
