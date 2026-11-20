// Dev probe (MV or MZ): average update / render time per frame over 4 s, plus renderer facts.
// Usage on the handheld: curl -s --data-binary @pocketmz-mvprof.js 127.0.0.1:9333
new Promise(function (res) {
    var S = SceneManager, ou = S.updateScene, or = S.renderScene, tu = 0, tr = 0, n = 0;
    S.updateScene = function () { var t = performance.now(); ou.call(S); tu += performance.now() - t; };
    S.renderScene = function () { var t = performance.now(); or.call(S); tr += performance.now() - t; n++; };
    setTimeout(function () {
        S.updateScene = ou; S.renderScene = or;
        var r = Graphics._renderer, c = Graphics._canvas;
        res([
            "frames=" + n + " (" + (n / 4).toFixed(1) + "/s)",
            "update=" + (tu / Math.max(n, 1)).toFixed(1) + "ms render=" + (tr / Math.max(n, 1)).toFixed(1) + "ms",
            "canvas=" + c.width + "x" + c.height + " css=" + c.style.width + " res=" + (r && r.resolution),
            "renderer=" + (r && r.constructor && r.constructor.name) + " webgl=" + (Graphics.isWebGL ? Graphics.isWebGL() : "?"),
            "plugins=" + $plugins.filter(function (p) { return p.status; }).length,
            "scene=" + S._scene.constructor.name
        ].join(" | "));
    }, 4000);
});
