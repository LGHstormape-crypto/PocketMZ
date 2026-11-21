// Dev probe (REPL, MZ): WebCodecs Vorbis decoding vs the engine's full decode.
// window.PMZ_VP_URL = "audio/bgm/Battle4.ogg" (MZ encrypted .ogg_ read and decrypted).
// Checks (1) decoding from the first audio packet lines up with decodeAudioData sample-exactly,
// (2) decoding from the last packet of a page in the middle starts at that page's granule.
(async () => {
    const url = window.PMZ_VP_URL || "audio/bgm/Battle4.ogg";
    const enc = Utils.hasEncryptedAudio();
    let buf = await (await fetch(enc ? url + "_" : url)).arrayBuffer();
    if (enc) buf = Utils.decryptArrayBuffer(buf);
    const u8 = new Uint8Array(buf);
    // --- Ogg pages -> packets (granule on the last packet that ends in a page)
    const packets = [];
    let cur = [], pos = 0, pages = 0;
    while (pos + 27 <= u8.length) {
        if (u8[pos] !== 0x4f || u8[pos + 1] !== 0x67 || u8[pos + 2] !== 0x67 || u8[pos + 3] !== 0x53) { pos++; continue; }
        const dv = new DataView(buf, pos);
        const g = dv.getUint32(6, true) + dv.getInt32(10, true) * 4294967296;
        const ns = u8[pos + 26];
        let dp = pos + 27 + ns, lastEnd = -1;
        for (let s = 0; s < ns; s++) {
            const len = u8[pos + 27 + s];
            cur.push(u8.subarray(dp, dp + len));
            dp += len;
            if (len < 255) {
                let n = 0; for (const c of cur) n += c.length;
                const d = new Uint8Array(n); let o = 0; for (const c of cur) { d.set(c, o); o += c.length; }
                packets.push({ d, g: -1 }); cur = []; lastEnd = packets.length - 1;
            }
        }
        if (lastEnd >= 0) packets[lastEnd].g = g;
        pos = dp; pages++;
    }
    const h = packets.slice(0, 3).map(p => p.d);
    const ch = h[0][11], rate = new DataView(h[0].buffer, h[0].byteOffset).getUint32(12, true);
    const lace = n => { const a = []; while (n >= 255) { a.push(255); n -= 255; } a.push(n); return a; };
    const head = [2, ...lace(h[0].length), ...lace(h[1].length)];
    const desc = new Uint8Array(head.length + h[0].length + h[1].length + h[2].length);
    desc.set(head, 0); desc.set(h[0], head.length); desc.set(h[1], head.length + h[0].length);
    desc.set(h[2], head.length + h[0].length + h[1].length);
    const decode = async (from, maxFrames) => {
        const outs = []; let total = 0, err = null, firstTs = null;
        const t0 = performance.now();
        const dec = new AudioDecoder({
            output: a => { if (firstTs === null) firstTs = a.timestamp;
                const n = a.numberOfFrames, f = new Float32Array(n);
                a.copyTo(f, { planeIndex: 0, format: "f32-planar" }); outs.push(f); total += n; a.close(); },
            error: e => { err = String(e); } });
        dec.configure({ codec: "vorbis", sampleRate: rate, numberOfChannels: ch, description: desc });
        let est = 0;
        for (let i = from; i < packets.length && total < maxFrames; i++) {
            if (packets[i].g >= 0) est = packets[i].g;
            dec.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round(est * 1e6 / rate) + i, data: packets[i].d }));
            if (dec.decodeQueueSize > 50) await new Promise(r => setTimeout(r, 5));
        }
        await dec.flush(); dec.close();
        const all = new Float32Array(total); let o = 0; for (const f of outs) { all.set(f, o); o += f.length; }
        return { all, err, ms: Math.round(performance.now() - t0), firstTs, chunks: outs.length };
    };
    const ref = (await new OfflineAudioContext(ch, 1, rate).decodeAudioData(buf.slice(0))).getChannelData(0);
    const align = (a, aAt, refAt) => {   // offset k minimizing |a[aAt+i] - ref[refAt+k+i]|
        let best = [1e9, 0];
        for (let k = -3000; k <= 3000; k++) {
            let e = 0; for (let i = 0; i < 2048; i++) { const d = a[aAt + i] - ref[refAt + k + i]; e += d * d; }
            if (e < best[0]) best = [e, k];
        }
        return { offset: best[1], err: +best[0].toExponential(2) };
    };
    const res = { rate, ch, pages, packets: packets.length, lastGranule: packets[packets.length - 1].g, refLen: ref.length };
    const A = await decode(3, Infinity);
    res.full = { frames: A.all.length, ms: A.ms, err: A.err, chunks: A.chunks, at100k: align(A.all, 100000, 100000) };
    // start in the middle: the last packet of the page whose granule is near 30 s
    let k = -1; for (let i = 3; i < packets.length; i++) if (packets[i].g >= 30 * rate) { k = i; break; }
    const G = packets[k].g;
    const B = await decode(k, rate * 3);
    res.mid = { G, k, frames: B.all.length, err: B.err, firstTs: B.firstTs, at0: align(B.all, 0, G), at20k: align(B.all, 20000, G + 20000) };
    // and from the packet after it
    const C = await decode(k + 1, rate * 3);
    res.midNext = { frames: C.all.length, at0: align(C.all, 0, G), at20k: align(C.all, 20000, G + 20000) };
    return JSON.stringify(res);
})()
