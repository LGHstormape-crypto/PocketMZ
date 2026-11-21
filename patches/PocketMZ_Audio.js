/*:
 * @target MZ MV
 * @plugindesc PocketMZ: BGM and BGS decoded a few seconds ahead instead of decoded in full.
 * @author PocketMZ (MIT)
 *
 * @help
 * RPG Maker MV / MZ decode every BGM / BGS file completely into PCM before playing it
 * (WebAudio decodeAudioData): at 24 kHz stereo float that is ~11.5 MB per minute of music, so a
 * 6-minute battle theme takes ~70 MB, held while it plays, and decoding it takes seconds of CPU
 * at every map or battle change. On a 1 GB handheld the music alone could reach 100+ MB.
 *
 * Here BGM and BGS keep only the file (read once, decrypted if needed) and decode while playing:
 * - Ogg Vorbis: a shared Worker decodes it in small pieces with WebCodecs (AudioDecoder),
 *   resamples it to the WebAudio rate (windowed sinc) and sends PCM chunks; the main thread
 *   queues them as WebAudio buffers ~6 s ahead, so loops from LOOPSTART / LOOPLENGTH comments are
 *   sample-exact and a busy main thread does not slow the decoding (~1 MB of PCM per track).
 * - Anything else (m4a, Opus Ogg), no Worker / AudioDecoder, an unsupported file or a decoder
 *   error: an <audio> element (the browser's media decoder); loop jumps there are timer based.
 * Both go through WebAudio's master volume, so the game's volume settings, the PocketMZ menu
 * volume, fades, pitch and pan work as before; the position for "replay BGM" (battles, ME) is
 * kept too. ME and SE keep RPG Maker's own WebAudio.
 *
 * POCKETMZ_STREAM_BGM=off (games/<id>/env) or window.PMZ_STREAM_OFF = true (new tracks only)
 * turns it all off. POCKETMZ_STREAM_DECODE=off or window.PMZ_DECODE_OFF = true (new tracks only)
 * always uses the <audio> element. Counters: window.PMZ_STREAM.
 */
(() => {
    "use strict";
    const env = name => String((window.process && process.env && process.env[name]) || "on").toLowerCase();
    if (env("POCKETMZ_STREAM_BGM") === "off" || !window.WebAudio || !window.AudioManager || !AudioManager.createBuffer || !window.Utils) return;
    const DECODE = env("POCKETMZ_STREAM_DECODE") !== "off" && typeof window.Worker === "function";
    const IS_MZ = Utils.RPGMAKER_NAME === "MZ";
    const ctx = () => WebAudio._context;
    const now = () => (ctx() ? ctx().currentTime : 0);
    const STATS = window.PMZ_STREAM = {
        created: 0, played: 0, destroyed: 0, errors: 0,
        decoded: 0, element: 0,     // backend chosen per buffer (a fallback counts in both)
        underruns: 0, underrunLog: [], loops: 0, collected: 0, live: new Set(),   // underrunLog: [s, ms late, name]
        open: () => workerStreams.size,     // streams the worker holds
    };
    // blob URLs of streams the game dropped without destroy() (MV only stops them)
    const blobs = window.FinalizationRegistry ? new FinalizationRegistry(url => URL.revokeObjectURL(url)) : null;

    const encrypted = () => (IS_MZ ? Utils.hasEncryptedAudio() : !!(window.Decrypter && Decrypter.hasEncryptedAudio));
    const realUrl = url => (encrypted() ? (IS_MZ ? url + "_" : Decrypter.extToEncryptExt(url)) : url);
    const decrypt = buf => (encrypted() ? (IS_MZ ? Utils.decryptArrayBuffer(buf) : Decrypter.decryptArrayBuffer(buf)) : buf);
    // loop points in samples with the engine's own Ogg / MP4 comment reader (it sets _loopStart, _loopLength, _sampleRate)
    const loopPoints = buf => {
        const t = Object.create(WebAudio.prototype);
        t._loopStart = 0; t._loopLength = 0; t._sampleRate = 0;
        try { WebAudio.prototype._readLoopComments.call(t, IS_MZ ? buf : new Uint8Array(buf)); } catch (e) { return null; }
        return t._loopLength > 0 && t._sampleRate > 0
            ? { start: t._loopStart, end: t._loopStart + t._loopLength, rate: t._sampleRate } : null;
    };

    // ======== worker code: the helpers below run in the Worker (built from their source text) ========
    const TAPS = 32, HALF = TAPS / 2, PHASES = 256, BETA = 6;
    const AHEAD = 10;           // seconds sent ahead of what the main thread has played (main-thread stalls of up to ~5 s)
    const QUEUE = 32;           // packets in the decoder at most
    const CHUNK_FIRST = 0.25, CHUNK = 0.5;
    const tables = new Map();

    // ---- Ogg Vorbis -> packets, seek index, decoder config ----
    const u32 = (u8, i) => (u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24)) >>> 0;
    const isVorbisHeader = (p, type) => !!p && p.length > 7 && p[0] === type
        && p[1] === 0x76 && p[2] === 0x6f && p[3] === 0x72 && p[4] === 0x62 && p[5] === 0x69 && p[6] === 0x73;
    const concat = parts => {
        let n = 0;
        for (const p of parts) n += p.length;
        const out = new Uint8Array(n);
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    };
    const lace = (out, n) => { while (n >= 255) { out.push(255); n -= 255; } out.push(n); };
    // null = not a single-stream Vorbis file (the element plays it)
    const parseVorbis = data => {
        const u8 = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
        const packets = [], ends = [];    // ends: packet index, granule of each page that completes a packet
        let pos = 0, serial = -1, part = null;
        while (pos + 27 <= u8.length) {
            if (u32(u8, pos) !== 0x5367674f) return null;    // "OggS"
            const flags = u8[pos + 5], nseg = u8[pos + 26];
            const lo = u32(u8, pos + 6), hi = u32(u8, pos + 10) | 0;
            const granule = lo === 0xffffffff && hi === -1 ? -1 : hi * 4294967296 + lo;
            const sn = u32(u8, pos + 14);
            if (serial === -1) serial = sn;
            else if (sn !== serial) return null;            // chained or multiplexed
            const body = pos + 27 + nseg;
            let size = 0;
            for (let i = 0; i < nseg; i++) size += u8[pos + 27 + i];
            if (body + size > u8.length) break;             // truncated last page
            if (!(flags & 1)) part = null;                  // not a continued packet: drop an unfinished one
            let start = body, len = 0, last = -1;
            for (let i = 0; i < nseg; i++) {
                const s = u8[pos + 27 + i];
                len += s;
                if (s === 255) continue;                    // the packet goes on
                let pkt = u8.subarray(start, start + len);
                if (part) { part.push(pkt); pkt = concat(part); part = null; }
                packets.push(pkt);
                last = packets.length - 1;
                start += len; len = 0;
            }
            if (len > 0) (part || (part = [])).push(u8.subarray(start, start + len));
            if (last >= 0 && granule >= 0) ends.push(last, granule);
            pos = body + size;
        }
        const h0 = packets[0], h1 = packets[1], h2 = packets[2];
        if (packets.length < 4 || !isVorbisHeader(h0, 1) || h0.length < 16 || !isVorbisHeader(h1, 3) || !isVorbisHeader(h2, 5)) return null;
        const channels = h0[11], rate = u32(h0, 12);
        if (!channels || !rate) return null;
        // a fresh decoder fed from the last packet of a page outputs from that page's granule on
        const granules = new Float64Array(packets.length).fill(-1);
        const index = [{ g: 0, p: 3 }];
        for (let i = 0; i < ends.length; i += 2) {
            const p = ends[i], g = ends[i + 1];
            if (p < 3) continue;
            granules[p] = g;
            if (g > index[index.length - 1].g) index.push({ g, p });
        }
        const total = index[index.length - 1].g;     // the decoder outputs a little more: trimmed here
        if (!(total > 0)) return null;
        const head = [2];
        lace(head, h0.length); lace(head, h1.length);
        const description = concat([new Uint8Array(head), h0, h1, h2]);
        return { packets, granules, index, total, rate, channels,
            config: { codec: "vorbis", sampleRate: rate, numberOfChannels: channels, description } };
    };

    // ---- fractional resampler (Kaiser-windowed sinc); its state carries across chunks and loop jumps ----
    const sincTable = fc => {
        const key = fc.toFixed(5);
        if (tables.has(key)) return tables.get(key);
        const i0 = x => {
            let s = 1, term = 1;
            for (let k = 1; k < 40; k++) { term *= (x / (2 * k)) * (x / (2 * k)); s += term; if (term < 1e-12 * s) break; }
            return s;
        };
        const ib = i0(BETA), tab = new Float32Array((PHASES + 1) * TAPS);
        for (let p = 0; p <= PHASES; p++) {    // row p: output at fraction p / PHASES after input sample i
            const f = p / PHASES, row = p * TAPS;
            let sum = 0;
            for (let j = 0; j < TAPS; j++) {
                const d = j - HALF + 1 - f, x = d / HALF, a = Math.PI * fc * d;
                const v = (a === 0 ? 1 : Math.sin(a) / a) * i0(BETA * Math.sqrt(Math.max(0, 1 - x * x))) / ib;
                tab[row + j] = v; sum += v;
            }
            for (let j = 0; j < TAPS; j++) tab[row + j] /= sum;    // unity gain at DC
        }
        tables.set(key, tab);
        return tab;
    };
    class Resampler {
        constructor(channels, inRate, outRate) {
            this.ch = channels;
            this.pass = inRate === outRate;
            this.step = inRate / outRate;
            this.table = this.pass ? null : sincTable(0.9 * Math.min(1, outRate / inRate));
            this.buf = [];
            for (let c = 0; c < channels; c++) this.buf.push(new Float32Array(16384));
            this.base = this.pass ? 0 : -HALF;   // input index of buf[0]; zeros before the first sample
            this.len = this.pass ? 0 : HALF;
            this.t = 0;                          // input position of the next output frame
            this.coef = new Float32Array(TAPS);
        }
        get end() { return this.base + this.len; }    // input index after the last frame pushed
        push(chans, n) {
            const keepFrom = Math.floor(this.t) - (this.pass ? 0 : HALF - 1);
            const drop = Math.min(this.len, Math.max(0, keepFrom - this.base));
            if (drop > 0) {
                for (const b of this.buf) b.copyWithin(0, drop, this.len);
                this.base += drop; this.len -= drop;
            }
            if (this.len + n > this.buf[0].length) {
                const size = Math.max(this.buf[0].length * 2, this.len + n);
                this.buf = this.buf.map(b => { const nb = new Float32Array(size); nb.set(b.subarray(0, this.len)); return nb; });
            }
            for (let c = 0; c < this.ch; c++) this.buf[c].set(chans[c].subarray(0, n), this.len);
            this.len += n;
        }
        // zeros after the end so the last frames can be produced; returns the real end
        finish() {
            const end = this.end;
            if (!this.pass) {
                const z = new Float32Array(HALF + 1), zs = [];
                for (let c = 0; c < this.ch; c++) zs.push(z);
                this.push(zs, HALF + 1);
            }
            return end;
        }
        // up to max output frames into out[c][off..], stopping before input position limit; returns the count
        pull(out, off, max, limit) {
            if (max <= 0) return 0;
            if (this.pass) {
                const k = Math.max(0, Math.min(max, Math.min(this.end, limit) - this.t));
                const s = this.t - this.base;
                for (let c = 0; c < this.ch; c++) out[c].set(this.buf[c].subarray(s, s + k), off);
                this.t += k;
                return k;
            }
            const tab = this.table, coef = this.coef, step = this.step, ch = this.ch, end = this.end;
            let k = 0, t = this.t;
            while (k < max && t < limit) {
                const i = Math.floor(t);
                if (i + HALF >= end) break;                 // needs input up to i + HALF
                const fp = (t - i) * PHASES, p = fp | 0, w = fp - p, r0 = p * TAPS, r1 = r0 + TAPS;
                for (let j = 0; j < TAPS; j++) coef[j] = tab[r0 + j] + (tab[r1 + j] - tab[r0 + j]) * w;
                const s = i - HALF + 1 - this.base;
                for (let c = 0; c < ch; c++) {
                    const x = this.buf[c];
                    let acc = 0;
                    for (let j = 0; j < TAPS; j++) acc += x[s + j] * coef[j];
                    out[c][off + k] = acc;
                }
                k++;
                t += step;
            }
            this.t = t;
            return k;
        }
    }

    // ---- worker main: streams by id; packets -> AudioDecoder (one per segment: from a start position
    // to the loop end or the file end) -> resampler -> chunks posted to the main thread ----
    const workerMain = () => {
        const HAVE = typeof AudioDecoder === "function" && typeof EncodedAudioChunk === "function";
        const streams = new Map(), supportChecks = new Map();
        const post = (m, transfer) => self.postMessage(m, transfer || []);
        const supported = config => {
            const key = config.sampleRate + "/" + config.numberOfChannels;
            if (!supportChecks.has(key)) {
                let p;
                try { p = AudioDecoder.isConfigSupported(config).then(r => !!(r && r.supported), () => false); } catch (e) { p = Promise.resolve(false); }
                supportChecks.set(key, p);
            }
            return supportChecks.get(key);
        };
        class Stream {
            constructor(id) {
                this.id = id; this.gen = -1; this.pk = null;
                this.ls = 0; this.le = 0;                   // loop tags in file samples; le 0 = none
                this.dec = null; this.rs = null; this.marks = []; this.pend = null; this.pendLen = 0; this.scratch = [];
            }
            open(m) {
                let v = null;
                if (HAVE) { try { v = parseVorbis(m.bytes); } catch (e) { v = null; } }
                if (!v) { streams.delete(this.id); post({ type: "opened", id: this.id, ok: false }); return; }
                this.pk = v.packets; this.pg = v.granules; this.index = v.index; this.config = v.config;
                this.rate = v.rate; this.ch = v.channels; this.total = v.total; this.outRate = m.outRate;
                if (m.loopEnd > 0 && m.loopRate > 0) {
                    const k = v.rate / m.loopRate, s = Math.round(m.loopStart * k), e = Math.min(Math.round(m.loopEnd * k), v.total);
                    if (e > s) { this.ls = s; this.le = e; }
                }
                supported(v.config).then(ok => {
                    if (streams.get(this.id) !== this) return;
                    if (!ok) { streams.delete(this.id); this.pk = null; }
                    post({ type: "opened", id: this.id, ok, total: v.total, rate: v.rate, channels: v.channels, loopStart: this.ls, loopEnd: this.le });
                });
            }
            start(gen, s, loop) {
                this.halt();
                if (!this.pk) return;
                this.gen = gen;
                const tagged = loop && this.le > 0;
                this.segLoop = loop;
                this.segEnd = tagged ? this.le : this.total;
                this.loopTo = tagged ? this.ls : 0;
                if (!(s >= 0 && s < this.segEnd)) s = this.loopTo;
                this.rs = new Resampler(this.ch, this.rate, this.outRate);
                this.pendPos = s / this.rate;
                this.produced = 0; this.acked = 0; this.first = true; this.endAt = Infinity; this.jumps = 0;
                if (this.startSegment(s)) this.pump();
            }
            halt() {
                this.closeDecoder();
                this.gen = -1; this.rs = null; this.marks = []; this.pend = null; this.pendLen = 0;
            }
            fail() {
                const gen = this.gen;
                this.halt();
                post({ type: "error", id: this.id, gen });
            }
            ack(m) {
                if (m.gen !== this.gen) return;
                this.acked += m.seconds;
                this.pump();
            }
            // a new decoder from the last page end at or before sample s; the frames before s are dropped
            startSegment(s) {
                this.closeDecoder();
                const idx = this.index;
                let lo = 0, hi = idx.length - 1;
                while (lo < hi) { const m = (lo + hi + 1) >> 1; if (idx[m].g <= s) lo = m; else hi = m - 1; }
                const e = idx[lo];
                let dec = null;
                try {
                    dec = new AudioDecoder({ output: d => this.onOutput(dec, d), error: () => { if (dec === this.dec) this.fail(); } });
                    dec.configure(this.config);
                } catch (err) {
                    if (dec) { try { dec.close(); } catch (e2) { /* ignore */ } }
                    this.fail();
                    return false;
                }
                this.dec = dec; this.feed = e.p; this.lastG = e.g; this.outPos = e.g; this.drop = s - e.g;
                this.segFrames = 0; this.flushing = false;
                return true;
            }
            closeDecoder() {
                const d = this.dec;
                this.dec = null;
                if (d && d.state !== "closed") { try { d.close(); } catch (e) { /* ignore */ } }
            }
            // seconds sent and pending that the main thread has not played yet
            ahead() { return this.produced - this.acked + this.pendLen / this.outRate; }
            pump() {
                const d = this.dec;
                if (!d || d.state !== "configured") return;
                const pk = this.pk;
                try {
                    while (this.feed < pk.length && d.decodeQueueSize < QUEUE && this.ahead() < AHEAD) {
                        const i = this.feed++;
                        // timestamps only need to increase
                        if (pk[i].length) d.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round(this.lastG * 1e6 / this.rate) + i, data: pk[i] }));
                        if (this.pg[i] >= 0) this.lastG = this.pg[i];
                    }
                } catch (e) { return this.fail(); }
                if (this.feed >= pk.length && !this.flushing) {    // flush only at the end of the file
                    this.flushing = true;
                    d.flush().then(() => {
                        if (d !== this.dec) return;
                        try { this.segmentEnd(); } catch (e) { this.fail(); }
                    }, () => {});
                }
            }
            onOutput(dec, d) {
                if (dec !== this.dec || !this.rs) { d.close(); return; }
                try {
                    const n = d.numberOfFrames, skip = Math.min(n, this.drop);
                    const keep = Math.max(0, Math.min(n - skip, this.segEnd - this.outPos - skip));
                    this.drop -= skip;
                    this.outPos += n;
                    if (keep > 0) {
                        const nc = d.numberOfChannels, sc = this.scratch, out = [];
                        for (let c = 0; c < this.ch; c++) {
                            if (!sc[c] || sc[c].length < keep) sc[c] = new Float32Array(Math.max(keep, 8192));
                            const a = sc[c].subarray(0, keep);
                            d.copyTo(a, { planeIndex: Math.min(c, nc - 1), frameOffset: skip, frameCount: keep, format: "f32-planar" });
                            out.push(a);
                        }
                        this.rs.push(out, keep);
                        this.segFrames += keep;
                    }
                    d.close();
                    if (this.drop === 0 && this.outPos >= this.segEnd) this.segmentEnd();
                    else { this.drain(); this.pump(); }
                } catch (e) {
                    try { d.close(); } catch (e2) { /* closed */ }
                    this.fail();
                }
            }
            // the segment reached its end (or the decoder ran out at the end of the file)
            segmentEnd() {
                if (!this.rs) return;
                if (this.segLoop) {
                    if (this.segFrames === 0) return this.fail();    // a loop that yields no audio
                    this.jumps++;
                    // the input simply continues; output from here on is at the loop start
                    this.marks.push({ at: this.rs.end, pos: this.loopTo / this.rate });
                    if (!this.startSegment(this.loopTo)) return;
                    this.drain();
                    this.pump();
                    return;
                }
                this.closeDecoder();
                this.endAt = this.rs.finish();
                this.drain();
            }
            // resampled frames -> chunks; a loop jump starts a new chunk so each chunk has one file position
            drain() {
                const rs = this.rs;
                while (rs && this.rs === rs) {
                    const mark = this.marks[0], limit = mark ? mark.at : this.endAt;
                    if (!this.pend) {
                        const want = Math.round((this.first ? CHUNK_FIRST : CHUNK) * this.outRate);
                        this.pend = [];
                        for (let c = 0; c < this.ch; c++) this.pend.push(new Float32Array(want));
                    }
                    const room = this.pend[0].length;
                    this.pendLen += rs.pull(this.pend, this.pendLen, room - this.pendLen, limit);
                    if (this.pendLen >= room) { this.emit(); continue; }
                    if (rs.t < limit) break;            // needs more input
                    this.emit();
                    if (!mark) { this.rs = null; post({ type: "end", id: this.id, gen: this.gen }); break; }
                    this.pendPos = mark.pos + (rs.t - mark.at) / this.rate;
                    this.marks.shift();
                }
            }
            emit() {
                const n = this.pendLen, p = this.pend;
                if (!n) return;
                this.pend = null; this.pendLen = 0;
                post({ type: "chunk", id: this.id, gen: this.gen, pos0: this.pendPos, frames: n, channels: p, loops: this.jumps },
                    p.map(a => a.buffer));
                this.jumps = 0; this.first = false;
                this.produced += n / this.outRate;
                this.pendPos += n / this.outRate;
            }
        }
        self.onmessage = e => {
            const m = e.data;
            let st = streams.get(m.id);
            try {
                if (m.type === "open") {
                    if (st) st.halt();
                    st = new Stream(m.id);
                    streams.set(m.id, st);
                    st.open(m);
                } else if (!st) {
                    return;
                } else if (m.type === "start") {
                    st.start(m.gen, m.s, m.loop);
                } else if (m.type === "stop") {
                    if (m.gen === st.gen) st.halt();
                } else if (m.type === "ack") {
                    st.ack(m);
                } else if (m.type === "close") {
                    st.halt();
                    st.pk = null;
                    streams.delete(m.id);
                }
            } catch (err) {
                if (st) st.fail();
            }
        };
        post({ type: "hello", ok: HAVE });
    };
    const workerSource = () => [
        '"use strict";',
        `const TAPS = ${TAPS}, HALF = ${HALF}, PHASES = ${PHASES}, BETA = ${BETA};`,
        `const AHEAD = ${AHEAD}, QUEUE = ${QUEUE}, CHUNK_FIRST = ${CHUNK_FIRST}, CHUNK = ${CHUNK};`,
        "const tables = new Map();",
        `const u32 = ${u32};`,
        `const isVorbisHeader = ${isVorbisHeader};`,
        `const concat = ${concat};`,
        `const lace = ${lace};`,
        `const parseVorbis = ${parseVorbis};`,
        `const sincTable = ${sincTable};`,
        String(Resampler),
        `(${workerMain})();`,
    ].join("\n");

    // ======== main thread ========
    // one Worker for all streams, created on first use and never terminated
    let worker = null, workerDead = !DECODE, nextStreamId = 1;
    // id -> WeakRef(StreamAudio) waiting for or using the worker. Weak: MV only stops a BGM it drops
    // (never destroy()), so the worker's copy of the file is closed when the buffer is collected.
    const workerStreams = new Map();
    const weak = o => (window.WeakRef ? new WeakRef(o) : { deref: () => o });
    const closer = window.FinalizationRegistry ? new FinalizationRegistry(id => {
        if (!workerStreams.has(id)) return;
        workerStreams.delete(id);
        STATS.collected++;
        toWorker({ type: "close", id });
    }) : null;
    const workerFailed = () => {
        workerDead = true;
        const list = Array.from(workerStreams.values(), r => r.deref()).filter(Boolean);
        workerStreams.clear();
        for (const s of list) s._workerLost();
    };
    const getWorker = () => {
        if (workerDead) return null;
        if (!worker) {
            try {
                worker = new Worker(URL.createObjectURL(new Blob([workerSource()], { type: "text/javascript" })));
            } catch (e) { workerDead = true; return null; }
            worker.onmessage = e => {
                const m = e.data;
                if (!m) return;
                if (m.type === "hello") { if (!m.ok) workerFailed(); return; }
                const r = workerStreams.get(m.id), s = r && r.deref();
                if (s) s._onWorker(m);
            };
            worker.onerror = e => { if (e && e.preventDefault) e.preventDefault(); STATS.errors++; workerFailed(); };
        }
        return worker;
    };
    const toWorker = (m, transfer) => { if (worker && !workerDead) worker.postMessage(m, transfer || []); };

    const LEAD = 0.05;          // seconds from now to the first chunk (and after an underrun)

    class StreamAudio {
        constructor(url) {
            this._url = url;
            this.name = "";
            this.frameCount = 0;
            this._volume = 1; this._pitch = 1; this._pan = 0;
            this._loadListeners = []; this._stopListeners = [];
            this._ready = false; this._error = false; this._playing = false; this._loop = false; this._destroyed = false;
            this._mode = "";                            // "decoded" or "element" once the backend is chosen
            this._gain = null; this._panner = null; this._fadeTimer = null;
            this._pos = 0;                              // seconds; last known position
            // element backend
            this._el = null; this._src = null; this._blobUrl = "";
            this._loopStart = 0; this._loopEnd = 0;     // seconds; 0 = loop the whole file
            this._loopTimer = null;
            // decoded backend (positions in file samples unless noted)
            this._id = 0; this._gen = 0; this._running = false; this._data = null;
            this._rate = 0; this._ch = 0; this._total = 0; this._lsS = 0; this._leS = 0;   // _leS 0 = no loop tags
            this._items = []; this._nextT = 0; this._sr = 0; this._segLoop = false; this._ended = false;
            STATS.created++;
            this._load();
        }
        get url() { return this._url; }
        get volume() { return this._volume; }
        set volume(v) { this._volume = v; if (this._gain) this._gain.gain.setValueAtTime(v, now()); }
        get pitch() { return this._pitch; }
        set pitch(v) {
            if (v === this._pitch) return;
            this._pitch = v;
            if (this._el) this._el.playbackRate = v;
            // decoded: the rate is fixed per scheduled buffer, so start again from here
            if (this._mode === "decoded" && this._playing && this._running) this._decStart(this._segLoop, this.seek());
        }
        get pan() { return this._pan; }
        set pan(v) { this._pan = v; if (this._panner) this._panner.pan.setValueAtTime(Math.max(-1, Math.min(1, v)), now()); }
        isReady() { return this._ready; }
        isError() { return this._error; }
        isPlaying() { return this._playing; }
        addLoadListener(f) { this._loadListeners.push(f); }
        addStopListener(f) { this._stopListeners.push(f); }
        retry() { this._error = false; this._ready = false; this._load(); }

        _load() {
            const xhr = new XMLHttpRequest();
            xhr.open("GET", realUrl(this._url));
            xhr.responseType = "arraybuffer";
            xhr.onload = () => (xhr.status < 400 ? this._onBytes(xhr.response) : this._fail());
            xhr.onerror = () => this._fail();
            xhr.send();
        }
        _fail() { this._error = true; STATS.errors++; }
        _onBytes(buf) {
            if (this._destroyed) return;
            let data;
            try { data = decrypt(buf); } catch (e) { return this._fail(); }
            const lp = loopPoints(data);
            if (lp) { this._loopStart = lp.start / lp.rate; this._loopEnd = lp.end / lp.rate; }
            const c = ctx();
            const w = DECODE && !window.PMZ_DECODE_OFF && c && !/\.m4a$/i.test(this._url) ? getWorker() : null;
            if (!w) return this._useElement(data);
            // the worker gets its own copy (it needs the file for loops); this one is for an element fallback
            this._data = data;
            this._id = nextStreamId++;
            workerStreams.set(this._id, weak(this));
            if (closer) closer.register(this, this._id, this);
            const copy = ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data.slice(0);
            toWorker({ type: "open", id: this._id, bytes: copy, outRate: c.sampleRate,
                loopStart: lp ? lp.start : 0, loopEnd: lp ? lp.end : 0, loopRate: lp ? lp.rate : 0 }, [copy]);
        }
        _useElement(data) {
            this._mode = "element";
            STATS.element++;
            const type = /\.m4a$/i.test(this._url) ? "audio/mp4" : "audio/ogg";
            this._blobUrl = URL.createObjectURL(new Blob([data], { type }));
            if (blobs) blobs.register(this, this._blobUrl, this);
            const el = this._el = new Audio();
            el.preload = "auto";
            el.preservesPitch = false; el.mozPreservesPitch = false; el.webkitPreservesPitch = false;
            el.addEventListener("canplay", () => this._onReady(), { once: true });
            el.addEventListener("error", () => { if (!this._ready) this._fail(); });
            el.addEventListener("ended", () => this._onEnded());
            el.src = this._blobUrl;
        }
        _onReady() {
            if (this._ready) return;
            this._ready = true;
            while (this._loadListeners.length > 0) this._loadListeners.shift()();
        }
        _graph() {   // [element source ->] gain -> panner -> WebAudio master gain (volume settings, menu volume)
            const c = ctx();
            if (!c) return;
            if (!this._gain) {
                this._gain = c.createGain();
                this._gain.gain.value = this._volume;
                let out = this._gain;
                if (c.createStereoPanner) {
                    this._panner = c.createStereoPanner();
                    this._panner.pan.value = Math.max(-1, Math.min(1, this._pan));
                    out.connect(this._panner);
                    out = this._panner;
                }
                out.connect(WebAudio._masterGainNode || c.destination);
            }
            if (this._mode === "element" && this._el && !this._src) {
                this._src = c.createMediaElementSource(this._el);
                this._src.connect(this._gain);
            }
        }
        play(loop, offset) {
            if (!this._ready) {
                if (!this._error) this.addLoadListener(() => this.play(loop, offset));
                return;
            }
            this._graph();
            this._cancelFade();
            if (this._gain) { this._gain.gain.cancelScheduledValues(now()); this._gain.gain.setValueAtTime(this._volume, now()); }
            this._loop = !!loop;
            this._playing = true;
            STATS.live.add(this);
            STATS.played++;
            if (ctx() && ctx().state === "suspended" && ctx().resume) ctx().resume().catch(() => {});
            if (this._mode === "decoded") this._decStart(this._loop, offset || 0);
            else this._elStart(this._loop, offset || 0);
        }

        // ---- element backend ----
        _elStart(loop, offset) {
            const el = this._el;
            if (!el) return;
            this._graph();
            let pos = offset;
            const dur = el.duration || 0;
            if (loop && this._loopEnd > 0 && pos >= this._loopEnd) {
                pos = this._loopStart + ((pos - this._loopStart) % (this._loopEnd - this._loopStart));
            } else if (dur > 0 && pos >= dur) {
                pos = loop ? pos % dur : 0;
            }
            el.loop = loop && !(this._loopEnd > 0);
            el.playbackRate = this._pitch;
            try { el.currentTime = pos; } catch (e) { /* not seekable yet: from the start */ }
            const p = el.play();
            if (p && p.catch) p.catch(() => {});
            this._watchLoop();
        }
        // LOOPSTART / LOOPLENGTH: jump back shortly before the loop end (checked more often near it)
        _watchLoop() {
            clearTimeout(this._loopTimer);
            if (!this._playing || !this._loop || !(this._loopEnd > 0)) return;
            const tick = () => {
                if (!this._playing || !this._el) return;
                const el = this._el, t = el.currentTime;
                if (t >= this._loopEnd - 0.02) {
                    try { el.currentTime = this._loopStart + Math.max(0, t - this._loopEnd); } catch (e) { /* ignore */ }
                }
                const left = (this._loopEnd - el.currentTime) / Math.max(0.1, this._pitch);
                this._loopTimer = setTimeout(tick, Math.max(5, Math.min(250, left * 1000 - 30)));
            };
            tick();
        }
        _onEnded() {
            if (!this._playing) return;
            if (this._loop) {   // a loop end past the end of the file, or no element loop
                try { this._el.currentTime = this._loopEnd > 0 ? this._loopStart : 0; } catch (e) { /* ignore */ }
                const p = this._el.play();
                if (p && p.catch) p.catch(() => {});
            } else {
                this.stop();
            }
        }

        // ---- decoded backend: the worker sends PCM chunks, scheduled back to back on this._nextT ----
        _onWorker(m) {
            if (this._destroyed) return;
            if (m.type === "opened") {
                if (this._mode) return;
                if (!m.ok) { this._detach(); const d = this._data; this._data = null; this._useElement(d); return; }
                this._mode = "decoded";
                STATS.decoded++;
                this._rate = m.rate; this._ch = m.channels; this._total = m.total;
                this._lsS = m.loopStart; this._leS = m.loopEnd;
                this._onReady();
            } else if (m.type === "chunk") {
                this._onChunk(m);
            } else if (m.type === "end") {
                if (m.gen !== this._gen || !this._running) return;
                this._ended = true;
                if (!this._items.length && this._playing) this.stop();
            } else if (m.type === "error") {
                if (!this._mode) { this._detach(); const d = this._data; this._data = null; this._useElement(d); }
                else if (m.gen === this._gen && this._running) this._decodeFailed();
            }
        }
        // the worker is gone (failed to start, or crashed)
        _workerLost() {
            this._id = 0;
            if (this._destroyed) return;
            if (!this._mode) { const d = this._data; this._data = null; this._useElement(d); }
            else if (this._mode === "decoded") this._decodeFailed();
        }
        _detach() {
            if (!this._id) return;
            toWorker({ type: "close", id: this._id });
            workerStreams.delete(this._id);
            if (closer) closer.unregister(this);
            this._id = 0;
        }
        _decStart(loop, offset) {
            this._decHalt();
            const c = ctx();
            if (!c || !this._id) return;
            const total = this._total, tagged = loop && this._leS > 0;
            let s = Math.max(0, Math.round(offset * this._rate));
            if (tagged && s >= this._leS) s = this._lsS + ((s - this._lsS) % (this._leS - this._lsS));
            else if (s >= total) s = loop ? s % total : 0;
            this._segLoop = loop;
            this._sr = c.sampleRate;
            this._pos = s / this._rate;
            this._nextT = 0; this._ended = false;
            this._gen++;
            this._running = true;
            toWorker({ type: "start", id: this._id, gen: this._gen, s, loop });
        }
        _onChunk(m) {
            if (m.gen !== this._gen || !this._running) return;     // from an earlier start
            if (m.loops) STATS.loops += m.loops;
            const c = ctx(), n = m.frames, sr = this._sr;
            if (!c || !n) { this._ack(n / sr); return; }
            const buf = c.createBuffer(m.channels.length, n, sr);
            for (let i = 0; i < m.channels.length; i++) buf.copyToChannel(m.channels[i].subarray(0, n), i);
            const src = c.createBufferSource();
            src.buffer = buf;
            if (this._pitch !== 1) src.playbackRate.value = this._pitch;
            src.connect(this._gain || WebAudio._masterGainNode || c.destination);
            const t = c.currentTime;
            if (!this._nextT || this._nextT < t + 0.01) {
                if (this._nextT) {
                    STATS.underruns++;
                    STATS.underrunLog.push([Math.round(performance.now() / 1000), Math.round((t - this._nextT) * 1000), this.name]);
                    if (STATS.underrunLog.length > 20) STATS.underrunLog.shift();
                }
                this._nextT = Math.ceil((t + LEAD) * sr) / sr;    // on a frame, so later chunks are too
            }
            const item = { src, t0: this._nextT, dur: n / sr / this._pitch, pos0: m.pos0, rate: this._pitch, sec: n / sr };
            src.onended = () => this._onSourceEnded(item);
            src.start(item.t0);
            this._items.push(item);
            this._nextT += item.dur;
        }
        // tells the worker how much has been played (flow control)
        _ack(seconds) {
            if (this._running) toWorker({ type: "ack", id: this._id, gen: this._gen, seconds });
        }
        _onSourceEnded(item) {
            const i = this._items.indexOf(item);
            if (i < 0) return;
            this._items.splice(i, 1);
            try { item.src.disconnect(); } catch (e) { /* gone */ }
            this._pos = item.pos0 + item.dur * item.rate;
            this._ack(item.sec);
            if (this._ended && !this._items.length && this._playing) this.stop();
        }
        // stop the worker's stream and the scheduled sources (no stop listeners)
        _decHalt() {
            if (this._running) {
                this._running = false;
                toWorker({ type: "stop", id: this._id, gen: this._gen });
            }
            for (const it of this._items) {
                it.src.onended = null;
                try { it.src.stop(); } catch (e) { /* not started */ }
                try { it.src.disconnect(); } catch (e) { /* gone */ }
            }
            this._items = [];
            this._ended = false;
        }
        // decoder trouble: this buffer continues on the element backend from the same position
        _decodeFailed() {
            STATS.errors++;
            if (this._mode !== "decoded") return;
            const playing = this._playing, pos = this.seek();
            this._decHalt();
            this._detach();
            const data = this._data;
            this._data = null;
            this._pos = pos;
            this._ready = false;
            if (playing) this._loadListeners.unshift(() => { if (this._playing) this._elStart(this._loop, pos); });
            this._useElement(data);
        }

        _cancelFade() {
            clearTimeout(this._fadeTimer);
            this._fadeTimer = null;
        }
        stop() {
            if (this._mode === "decoded") { this._pos = this.seek(); this._decHalt(); }
            this._playing = false;
            clearTimeout(this._loopTimer);
            this._cancelFade();
            if (this._el) this._el.pause();
            STATS.live.delete(this);
            this._loadListeners = [];
            while (this._stopListeners.length > 0) this._stopListeners.shift()();
        }
        seek() {
            if (this._mode !== "decoded") return this._el && this._ready ? this._el.currentTime : this._pos;
            const t = now(), items = this._items;
            for (const it of items) {
                if (t < it.t0) return it.pos0;
                if (t < it.t0 + it.dur) return it.pos0 + (t - it.t0) * it.rate;
            }
            const last = items[items.length - 1];
            return last ? last.pos0 + last.dur * last.rate : this._pos;
        }
        fadeIn(duration) {
            if (!this._ready) {
                if (!this._error) this.addLoadListener(() => this.fadeIn(duration));
                return;
            }
            this._graph();
            if (!this._gain) return;
            const g = this._gain.gain, t = now();
            g.cancelScheduledValues(t);
            g.setValueAtTime(0, t);
            g.linearRampToValueAtTime(this._volume, t + duration);
        }
        fadeOut(duration) {
            if (this._gain) {
                const g = this._gain.gain, t = now();
                g.cancelScheduledValues(t);
                g.setValueAtTime(g.value, t);
                g.linearRampToValueAtTime(0, t + duration);
            }
            // like the engine: no more looping; silent after the fade, stopped then
            // (the decoded backend keeps looping silently until then)
            this._loop = false;
            if (this._el) this._el.loop = false;
            this._cancelFade();
            this._fadeTimer = setTimeout(() => { this._fadeTimer = null; if (this._playing) this.stop(); }, duration * 1000 + 50);
        }
        destroy() {
            this.stop();
            this._destroyed = true;
            this._detach();
            if (this._src) { try { this._src.disconnect(); } catch (e) { /* gone */ } }
            if (this._gain) { try { this._gain.disconnect(); } catch (e) { /* gone */ } }
            if (this._panner) { try { this._panner.disconnect(); } catch (e) { /* gone */ } }
            if (this._el) { this._el.removeAttribute("src"); try { this._el.load(); } catch (e) { /* ignore */ } }
            if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); if (blobs) blobs.unregister(this); }
            this._el = this._src = this._gain = this._panner = null;
            this._blobUrl = "";
            this._data = null;
            this._ready = false;
            STATS.destroyed++;
        }
    }
    window.PMZ_StreamAudio = StreamAudio;

    const _createBuffer = AudioManager.createBuffer;
    AudioManager.createBuffer = function(folder, name) {
        const f = String(folder || "").replace(/\/$/, "");
        if ((f === "bgm" || f === "bgs") && name && ctx() && !window.PMZ_STREAM_OFF) {
            const url = this._path + f + "/" + (IS_MZ ? Utils.encodeURI(name) : encodeURIComponent(name)) + this.audioFileExt();
            const buffer = new StreamAudio(url);
            buffer.name = name;
            buffer.frameCount = Graphics.frameCount;
            return buffer;
        }
        return _createBuffer.apply(this, arguments);
    };
})();
