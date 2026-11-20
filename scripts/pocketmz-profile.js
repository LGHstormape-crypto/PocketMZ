// Dev: V8 CPU profile of the running game for N ms (default 10000) through node's inspector
// (NW.js shares one V8 isolate between node and the page). Returns the top functions by
// self time, grouped by script, plus totals per script. Sent through the PocketMZ_Debug REPL.
new Promise((resolve) => {
    const ms = window.PMZ_PROFILE_MS || 10000;
    const inspector = require("inspector");
    const session = new inspector.Session();
    session.connect();
    session.post("Profiler.enable", () => {
        session.post("Profiler.setSamplingInterval", { interval: 500 }, () => {
            session.post("Profiler.start", () => {
                setTimeout(() => {
                    session.post("Profiler.stop", (err, res) => {
                        session.disconnect();
                        if (err) return resolve({ error: String(err) });
                        const p = res.profile;
                        const dt = (p.endTime - p.startTime) / 1000; // ms
                        const total = p.samples.length;
                        const self = new Map(), byScript = new Map();
                        for (const n of p.nodes) {
                            const f = n.callFrame;
                            const script = (f.url || "").split("/").pop() || "(" + f.functionName + ")";
                            const key = (f.functionName || "(anon)") + " @" + script + ":" + (f.lineNumber + 1);
                            self.set(key, (self.get(key) || 0) + (n.hitCount || 0));
                            byScript.set(script, (byScript.get(script) || 0) + (n.hitCount || 0));
                        }
                        const pct = (h) => +(100 * h / total).toFixed(1);
                        resolve({
                            ms: Math.round(dt), samples: total,
                            top: [...self].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, h]) => pct(h) + "% " + k),
                            scripts: [...byScript].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, h]) => pct(h) + "% " + k)
                        });
                    });
                }, ms);
            });
        });
    });
})
