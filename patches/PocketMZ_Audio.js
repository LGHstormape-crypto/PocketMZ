/*:
 * @target MZ MV
 * @plugindesc PocketMZ: BGM and BGS streamed by the browser's media decoder instead of decoded in full.
 * @author PocketMZ (MIT)
 *
 * @help
 * RPG Maker MV / MZ decode every BGM / BGS file completely into PCM before playing it
 * (WebAudio decodeAudioData): at 24 kHz stereo float that is ~11.5 MB per minute of music, so a
 * 6-minute battle theme takes ~70 MB, held while it plays, and decoding it takes seconds of CPU
 * at every map or battle change. On a 1 GB handheld the music alone could reach 100+ MB.
 *
 * Here BGM and BGS play from an <audio> element (the file is read once, decrypted if needed, and
 * decoded a little ahead while playing) routed through WebAudio's master volume, so the game's
 * volume settings, the PocketMZ menu volume, fades, pitch and pan work as before. Loop points
 * from LOOPSTART / LOOPLENGTH comments are honoured; the position for "replay BGM" (battles,
 * ME) comes from the element. ME and SE keep RPG Maker's own WebAudio.
 *
 * POCKETMZ_STREAM_BGM=off (games/<id>/env) or window.PMZ_STREAM_OFF = true (new tracks only)
 * turns it off.
 */
(() => {
    "use strict";
    const ENV = String((window.process && process.env && process.env.POCKETMZ_STREAM_BGM) || "on").toLowerCase();
    if (ENV === "off" || !window.WebAudio || !window.AudioManager || !AudioManager.createBuffer || !window.Utils) return;
    const IS_MZ = Utils.RPGMAKER_NAME === "MZ";
    const ctx = () => WebAudio._context;
    const now = () => (ctx() ? ctx().currentTime : 0);
    const STATS = window.PMZ_STREAM = { created: 0, played: 0, destroyed: 0, errors: 0, live: new Set() };
    // blob URLs of streams the game dropped without destroy() (MV only stops them)
    const blobs = window.FinalizationRegistry ? new FinalizationRegistry(url => URL.revokeObjectURL(url)) : null;

    const encrypted = () => (IS_MZ ? Utils.hasEncryptedAudio() : !!(window.Decrypter && Decrypter.hasEncryptedAudio));
    const realUrl = url => (encrypted() ? (IS_MZ ? url + "_" : Decrypter.extToEncryptExt(url)) : url);
    const decrypt = buf => (encrypted() ? (IS_MZ ? Utils.decryptArrayBuffer(buf) : Decrypter.decryptArrayBuffer(buf)) : buf);
    // loop points with the engine's own Ogg / MP4 comment reader (it sets _loopStart, _loopLength, _sampleRate)
    const loopPoints = buf => {
        const t = Object.create(WebAudio.prototype);
        t._loopStart = 0; t._loopLength = 0; t._sampleRate = 0;
        try { WebAudio.prototype._readLoopComments.call(t, IS_MZ ? buf : new Uint8Array(buf)); } catch (e) { return null; }
        return t._loopLength > 0 && t._sampleRate > 0
            ? { start: t._loopStart / t._sampleRate, end: (t._loopStart + t._loopLength) / t._sampleRate } : null;
    };

    class StreamAudio {
        constructor(url) {
            this._url = url;
            this.name = "";
            this.frameCount = 0;
            this._volume = 1; this._pitch = 1; this._pan = 0;
            this._loadListeners = []; this._stopListeners = [];
            this._ready = false; this._error = false; this._playing = false; this._loop = false;
            this._loopStart = 0; this._loopEnd = 0;     // seconds; 0 = loop the whole file
            this._el = null; this._src = null; this._gain = null; this._panner = null; this._blobUrl = "";
            this._loopTimer = null; this._fadeTimer = null;
            STATS.created++;
            this._load();
        }
        get url() { return this._url; }
        get volume() { return this._volume; }
        set volume(v) { this._volume = v; if (this._gain) this._gain.gain.setValueAtTime(v, now()); }
        get pitch() { return this._pitch; }
        set pitch(v) { this._pitch = v; if (this._el) this._el.playbackRate = v; }
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
            let data;
            try { data = decrypt(buf); } catch (e) { return this._fail(); }
            const lp = loopPoints(data);
            if (lp) { this._loopStart = lp.start; this._loopEnd = lp.end; }
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
        _graph() {   // element -> gain -> panner -> WebAudio master gain (volume settings, menu volume)
            const c = ctx();
            if (this._src || !c || !this._el) return;
            this._src = c.createMediaElementSource(this._el);
            this._gain = c.createGain();
            this._gain.gain.value = this._volume;
            this._src.connect(this._gain);
            let out = this._gain;
            if (c.createStereoPanner) {
                this._panner = c.createStereoPanner();
                this._panner.pan.value = Math.max(-1, Math.min(1, this._pan));
                out.connect(this._panner);
                out = this._panner;
            }
            out.connect(WebAudio._masterGainNode || c.destination);
        }
        play(loop, offset) {
            if (!this._ready) {
                if (!this._error) this.addLoadListener(() => this.play(loop, offset));
                return;
            }
            const el = this._el;
            this._graph();
            this._cancelFade();
            if (this._gain) { this._gain.gain.cancelScheduledValues(now()); this._gain.gain.setValueAtTime(this._volume, now()); }
            this._loop = !!loop;
            let pos = offset || 0;
            const dur = el.duration || 0;
            if (this._loop && this._loopEnd > 0 && pos >= this._loopEnd) {
                pos = this._loopStart + ((pos - this._loopStart) % (this._loopEnd - this._loopStart));
            } else if (dur > 0 && pos >= dur) {
                pos = this._loop ? pos % dur : 0;
            }
            el.loop = this._loop && !(this._loopEnd > 0);
            el.playbackRate = this._pitch;
            try { el.currentTime = pos; } catch (e) { /* not seekable yet: from the start */ }
            this._playing = true;
            STATS.live.add(this);
            STATS.played++;
            if (ctx() && ctx().state === "suspended" && ctx().resume) ctx().resume().catch(() => {});
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
        _cancelFade() {
            clearTimeout(this._fadeTimer);
            this._fadeTimer = null;
        }
        stop() {
            this._playing = false;
            clearTimeout(this._loopTimer);
            this._cancelFade();
            if (this._el) this._el.pause();
            STATS.live.delete(this);
            this._loadListeners = [];
            while (this._stopListeners.length > 0) this._stopListeners.shift()();
        }
        seek() {
            return this._el ? this._el.currentTime : 0;
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
            this._loop = false;
            if (this._el) this._el.loop = false;
            this._cancelFade();
            this._fadeTimer = setTimeout(() => { this._fadeTimer = null; if (this._playing) this.stop(); }, duration * 1000 + 50);
        }
        destroy() {
            this.stop();
            if (this._src) { try { this._src.disconnect(); } catch (e) { /* gone */ } }
            if (this._gain) { try { this._gain.disconnect(); } catch (e) { /* gone */ } }
            if (this._panner) { try { this._panner.disconnect(); } catch (e) { /* gone */ } }
            if (this._el) { this._el.removeAttribute("src"); try { this._el.load(); } catch (e) { /* ignore */ } }
            if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); if (blobs) blobs.unregister(this); }
            this._el = this._src = this._gain = this._panner = null;
            this._blobUrl = "";
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
