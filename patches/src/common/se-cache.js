    // Decoded sound effects reused (24 MB LRU for audio/se/ <= 10 s).
    // Supports both MZ (_startLoading/_onDecode) and MV (_load/_onLoad); POCKETMZ_SE_CACHE=off disables it.
    if (window.WebAudio &&
        String((window.process && process.env && process.env.POCKETMZ_SE_CACHE) || "on") !== "off") {
        const W = WebAudio.prototype;
        const SE = new Map(), SE_MAX = 24 << 20;
        const PMZ_SE = window.PMZ_SE = { hits: 0, stored: 0, bytes: 0, size: () => SE.size };
        const isSe = url => /(^|\/)audio\/se\//.test(String(url || ""));
        const bytesOf = b => b.length * b.numberOfChannels * 4;
        const evictSe = () => {
            for (const [k, v] of SE) {
                if (PMZ_SE.bytes <= SE_MAX) break;
                SE.delete(k); PMZ_SE.bytes -= bytesOf(v.buffer);
            }
        };
        if (W._startLoading && W._onDecode) {
            const _startLoading = W._startLoading;
            W._startLoading = function() {
                const hit = isSe(this._url) && SE.get(this._url);
                if (!hit || !WebAudio._context) return _startLoading.apply(this, arguments);
                SE.delete(this._url); SE.set(this._url, hit);
                this._isError = false;
                this._isLoaded = true;
                this._sampleRate = hit.sampleRate; this._loopStart = hit.loopStart; this._loopLength = hit.loopLength;
                this._lastUpdateTime = WebAudio._currentTime() - 0.5;
                PMZ_SE.hits++;
                Promise.resolve().then(() => {
                    if (this._url === hit.url && this._buffers && !this._buffers.length) this._onDecode(hit.buffer);
                });
            };
            const _onDecode = W._onDecode;
            W._onDecode = function(buffer) {
                if (buffer && this._isLoaded && isSe(this._url) && !this._shouldUseDecoder() &&
                    buffer.duration <= 10 && !SE.has(this._url)) {
                    SE.set(this._url, { url: this._url, buffer, sampleRate: this._sampleRate,
                                        loopStart: this._loopStart, loopLength: this._loopLength });
                    PMZ_SE.bytes += bytesOf(buffer); PMZ_SE.stored++;
                    evictSe();
                }
                return _onDecode.apply(this, arguments);
            };
        } else if (W._load && W._onLoad) {
            const _load = W._load;
            W._load = function(url) {
                const hit = isSe(this._url) && SE.get(this._url);
                if (!hit || !WebAudio._context) return _load.apply(this, arguments);
                SE.delete(this._url); SE.set(this._url, hit);
                PMZ_SE.hits++;
                Promise.resolve().then(() => {
                    if (this._url !== hit.url || this._buffer) return;
                    this._buffer = hit.buffer;
                    this._totalTime = hit.totalTime;
                    this._sampleRate = hit.sampleRate;
                    this._loopStart = hit.loopStart;
                    this._loopLength = hit.loopLength;
                    this._onLoad();
                });
            };
            const _onLoad = W._onLoad;
            W._onLoad = function() {
                const b = this._buffer;
                if (b && isSe(this._url) && b.duration <= 10 && !SE.has(this._url)) {
                    SE.set(this._url, { url: this._url, buffer: b, totalTime: this._totalTime, sampleRate: this._sampleRate,
                                        loopStart: this._loopStart, loopLength: this._loopLength });
                    PMZ_SE.bytes += bytesOf(b); PMZ_SE.stored++;
                    evictSe();
                }
                return _onLoad.apply(this, arguments);
            };
        }
    }
