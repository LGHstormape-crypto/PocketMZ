// Dev: how much memory do the decoded BGM / BGS / ME take, do they use loop tags, and how long
// did decoding take? Read-only. Result: one line per buffer.
(() => {
    const out = [];
    const desc = (name, b) => {
        if (!b) return;
        let bytes = 0, ch = 0, sr = 0;
        for (const a of b._buffers || []) { bytes += a.length * a.numberOfChannels * 4; ch = a.numberOfChannels; sr = a.sampleRate; }
        out.push(name + " " + (b.name || b._url || "") + ": " + (bytes / 1048576).toFixed(1) + " MB PCM, " + (b._totalTime || 0).toFixed(1) +
            " s, " + ch + " ch @" + sr + " Hz, loop tags " + (b._loopLength > 0 ? "yes (start " + (b._loopStartTime || 0).toFixed(2) + " s, len " + (b._loopLengthTime || 0).toFixed(2) + " s)" : "no") +
            ", file " + ((b._data && b._data.length) ? (b._data.length / 1048576).toFixed(1) + " MB kept" : "freed"));
    };
    desc("BGM", AudioManager._bgmBuffer);
    desc("BGS", AudioManager._bgsBuffer);
    desc("ME", AudioManager._meBuffer);
    out.push("SE buffers: " + (AudioManager._seBuffers || []).length + ", static SE: " + (AudioManager._staticBuffers || []).length);
    return out.join("\n");
})()
