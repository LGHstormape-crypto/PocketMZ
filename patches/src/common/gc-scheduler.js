    // 18. Full GC after scene changes and when memory runs low. Dropped canvases, images and decoded
    //     audio (WebAudio buffers: 20-50 MB per BGM at 24 kHz) live outside the small JS heap, so V8
    //     rarely collects their owners on its own: in an MZ game decoded audio grew to 153 MB and
    //     images to 95 MB within 10 minutes of maps and battles, most of it garbage. With
    //     --expose-gc (pocketmz-run.sh) a full GC runs ~0.5 s after each scene change (at most every
    //     8 s; scene changes are loading pauses anyway) and when MemAvailable drops below 300 MB
    //     (checked every 15 s, at most every 20 s). POCKETMZ_GC=off disables it.
    if (typeof window.gc === "function" && window.SceneManager && SceneManager.changeScene &&
        String((window.process && process.env && process.env.POCKETMZ_GC) || "on") !== "off") {
        let lastGc = 0;
        const gcNow = minGap => {
            const t = performance.now();
            if (t - lastGc < minGap) return;
            lastGc = t;
            try { window.gc(); } catch (e) { /* gc not available after all */ }
            window.PMZ_GC_COUNT = (window.PMZ_GC_COUNT || 0) + 1;
        };
        const _changeSceneGc = SceneManager.changeScene;
        SceneManager.changeScene = function() {
            const old = this._scene;
            const r = _changeSceneGc.apply(this, arguments);
            if (this._scene && this._scene !== old) setTimeout(() => gcNow(8000), 500);
            return r;
        };
        const fsGc = window.require ? (() => { try { return require("fs"); } catch (e) { return null; } })() : null;
        if (fsGc) setInterval(() => {
            try {
                const m = /MemAvailable:\s+(\d+)/.exec(fsGc.readFileSync("/proc/meminfo", "utf8"));
                if (m && +m[1] < 300 * 1024) gcNow(20000);
            } catch (e) { /* no /proc */ }
        }, 15000);
    }
