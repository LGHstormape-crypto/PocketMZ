// Dev probe (REPL, MV + MZ): how the streamed BGM sounds at its loop point.
// Plays the current BGM (or window.PMZ_LP_NAME) from 2.5 s before its loop end, taps the WebAudio
// master output (peak per 128-frame block) and records every currentTime jump of the element.
// Reports: the element time when it jumped (overshoot past the loop end), the silent run around
// the jump, and the same window played straight from the loop start as the reference.
(async () => {
    const c = WebAudio._context, M = WebAudio._masterGainNode;
    if (!c || !M) return "no WebAudio";
    if (!window.__pmzTap) {
        const src = "class T extends AudioWorkletProcessor{process(i){const ch=i[0]&&i[0][0];let p=0;" +
            "if(ch)for(let k=0;k<ch.length;k++){const a=Math.abs(ch[k]);if(a>p)p=a;}" +
            "this.port.postMessage([currentTime,p]);return true;}}registerProcessor('pmz-tap',T);";
        await c.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: "application/javascript" })));
        const node = new AudioWorkletNode(c, "pmz-tap");
        const mute = c.createGain(); mute.gain.value = 0;
        M.connect(node); node.connect(mute); mute.connect(c.destination);
        window.__pmzTap = { node, log: null };
        node.port.onmessage = e => { if (window.__pmzTap.log) window.__pmzTap.log.push(e.data); };
    }
    const tap = window.__pmzTap;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let b = AudioManager._bgmBuffer;
    if (window.PMZ_LP_NAME) {
        AudioManager.playBgm({ name: window.PMZ_LP_NAME, volume: 90, pitch: 100, pan: 0 });
        b = AudioManager._bgmBuffer;
    }
    for (let i = 0; i < 100 && b && b.isReady && !b.isReady(); i++) await sleep(50);
    if (!b || !(b._el || b._mode === "decoded")) return "no streamed BGM (" + (b && b.constructor.name) + ")";
    const dec = b._mode === "decoded";
    const el = b._el || document.createElement("audio"), dur = dec ? b._total / b._rate : el.duration;
    const tagged = b._loopEnd > 0;
    const lEnd = tagged ? b._loopEnd : dur, lStart = tagged ? b._loopStart : 0;
    // record jumps of the element's position
    const P = HTMLMediaElement.prototype, d = Object.getOwnPropertyDescriptor(P, "currentTime");
    const jumps = [];
    Object.defineProperty(el, "currentTime", { configurable: true,
        get() { return d.get.call(el); },
        set(v) { jumps.push([c.currentTime, d.get.call(el), v]); d.set.call(el, v); } });
    let seekedAt = [];
    const onSeeked = () => seekedAt.push(c.currentTime);
    el.addEventListener("seeked", onSeeked);
    const capture = async (from, ms) => {
        tap.log = [];
        const s0 = { ...window.PMZ_STREAM };
        b.play(true, from);
        let t0 = c.currentTime;
        if (dec) { for (let i = 0; i < 100 && !b._items.length; i++) await sleep(10); if (b._items.length) t0 = b._items[0].t0; }
        await sleep(ms);
        res0.loops = window.PMZ_STREAM.loops - s0.loops; res0.underruns = window.PMZ_STREAM.underruns - s0.underruns;
        const log = tap.log; tap.log = null;
        return { t0, log };
    };
    const res0 = {};
    const QUIET = 0.002;
    const runs = (log, a, z) => {  // longest run of quiet blocks between ctx times a..z, in ms
        let best = 0, cur = 0, blk = 128 / c.sampleRate;
        for (const [t, p] of log) {
            if (t < a || t > z) continue;
            if (p < QUIET) { cur++; best = Math.max(best, cur); } else cur = 0;
        }
        return Math.round(best * blk * 1000);
    };
    // 1) across the loop point
    jumps.length = 0; seekedAt = [];
    const A = await capture(lEnd - 2.5, 4500);
    const loopJump = jumps.find(j => j[2] < j[1] - 1) || null;   // a backward jump = the loop
    const startJump = jumps[0] || null;
    let res = { mode: b._mode, name: b.name, tagged, loops: res0.loops, underruns: res0.underruns, dur: +dur.toFixed(3), loopStart: +lStart.toFixed(3), loopEnd: +lEnd.toFixed(3),
        jumps: jumps.length, ended: 0 };
    if (loopJump) {
        const tj = loopJump[0];
        res.overshootMs = Math.round((loopJump[1] - lEnd) * 1000);
        res.seekMs = Math.round(((seekedAt.find(t => t >= tj) || tj) - tj) * 1000);
        res.quietAroundJumpMs = runs(A.log, tj - 0.1, tj + 0.6);
        res.quietBeforeMs = runs(A.log, A.t0 + 0.3, tj - 0.3);
    } else {
        // element loop (untagged) or no jump seen: look at the time the file wrapped
        const wrapAt = A.t0 + (lEnd - (lEnd - 2.5)) / b._pitch;
        res.quietAroundWrapMs = runs(A.log, wrapAt - 0.15, wrapAt + 0.6);
        res.quietBeforeMs = runs(A.log, A.t0 + 0.3, wrapAt - 0.3);
    }
    // 2) reference: the same music right after the loop start, played straight
    const R = await capture(lStart, 1200);
    res.refQuietMs = runs(R.log, R.t0 + 0.1, R.t0 + 0.7);
    res.blocks = A.log.length;
    el.removeEventListener("seeked", onSeeked);
    delete el.currentTime;
    return JSON.stringify(res);
})()
