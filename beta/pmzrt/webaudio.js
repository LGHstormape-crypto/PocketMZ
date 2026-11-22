'use strict';
// webaudio.js - WebAudio subset on top of the pmzrt audio mixer (pmzrt_audio.c). Thin objects: every node, buffer and parameter is an id in C.
// Implemented: AudioContext (currentTime on the sample clock, destination, decodeAudioData for Ogg Vorbis, createBuffer, createGain,
//   createPanner (setPosition, equalpower), createBufferSource (buffer, loop, loopStart, loopEnd, playbackRate, start(when, offset, duration),
//   stop, onended)), AudioParam (value, setValueAtTime, linear/exponential ramps, setTargetAtTime, cancelScheduledValues), AudioBuffer
//   (duration, length, sampleRate, getChannelData (a COPY), copyToChannel, copyFromChannel).
// Stubbed (pass-through or no-op): createBiquadFilter, createAnalyser, createDynamicsCompressor, createStereoPanner, createChannelSplitter/Merger,
//   createDelay, createConvolver, createWaveShaper, createMediaElementSource, createOscillator (silent), listener, resume/suspend/close.
// Buffers keep the file's own sample rate (not resampled to the context rate); the mixer resamples while mixing.
module.exports.create = function ({ pmz, log, warn, volume, dump, env }) {
  const info = pmz.auInit(volume, dump || '', +(env.PMZ_AUDIO_RATE || 44100), +(env.PMZ_AUDIO_BUF || 2048));
  const hasDevice = !!(info && info.ok);
  log('AUDIO ' + JSON.stringify(info));
  if (!hasDevice) warn('audio: no output device (' + (info && info.error) + '), running silent');
  const rate = hasDevice ? info.rate : 44100;
  let silentT0 = Date.now();
  const nodeReg = new FinalizationRegistry(id => { try { pmz.auFree(id); } catch (e) {} });
  const bufReg = new FinalizationRegistry(id => { try { pmz.auBufFree(id); } catch (e) {} });
  const playing = new Map();   // source nodes that are started and not ended (kept alive: the graph does not hold JS references)
  const now = () => hasDevice ? pmz.auTime() : (Date.now() - silentT0) / 1000;

  class AudioParam {
    constructor(node, which, v) { this._n = node; this._w = which; this._v = v; this.defaultValue = v; this.minValue = -3.4e38; this.maxValue = 3.4e38; }
    get value() { return this._v; }
    set value(x) { this._v = +x; pmz.auParam(this._n._id, this._w, 5, +x, 0, 0); }
    setValueAtTime(v, t) { this._v = +v; pmz.auParam(this._n._id, this._w, 0, +v, +t, 0); return this; }
    linearRampToValueAtTime(v, t) { this._v = +v; pmz.auParam(this._n._id, this._w, 1, +v, +t, 0); return this; }
    exponentialRampToValueAtTime(v, t) { this._v = +v; pmz.auParam(this._n._id, this._w, 2, +v, +t, 0); return this; }
    setTargetAtTime(v, t, tc) { pmz.auParam(this._n._id, this._w, 3, +v, +t, +tc); return this; }
    setValueCurveAtTime(curve, t, d) { const v = curve[curve.length - 1]; this._v = v; pmz.auParam(this._n._id, this._w, 0, +v, +t + +d, 0); return this; }
    cancelScheduledValues(t) { pmz.auParam(this._n._id, this._w, 4, 0, +t, 0); return this; }
    cancelAndHoldAtTime(t) { pmz.auParam(this._n._id, this._w, 4, 0, +t, 0); return this; }
  }
  class AudioNode {
    constructor(ctx, type) {
      this.context = ctx; this._id = pmz.auNode(type); this._dests = new Set();
      nodeReg.register(this, this._id);
      this.numberOfInputs = 1; this.numberOfOutputs = 1; this.channelCount = 2; this.channelCountMode = 'max'; this.channelInterpretation = 'speakers';
    }
    connect(dest) {
      if (dest instanceof AudioParam || !dest || dest._id === undefined) return dest;
      pmz.auConnect(this._id, dest._id); this._dests.add(dest); return dest;   // strong reference: a playing chain stays alive
    }
    disconnect(dest) { if (dest && dest._id !== undefined) { pmz.auDisconnect(this._id, dest._id); this._dests.delete(dest); } else { pmz.auDisconnect(this._id, -1); this._dests.clear(); } }
    addEventListener() {} removeEventListener() {}
  }
  class GainNode extends AudioNode { constructor(ctx) { super(ctx, 0); this.gain = new AudioParam(this, 0, 1); } }
  class PannerNode extends AudioNode {
    constructor(ctx) {
      super(ctx, 1);
      this.panningModel = 'equalpower'; this.distanceModel = 'inverse'; this.refDistance = 1; this.maxDistance = 10000; this.rolloffFactor = 1;
      this.coneInnerAngle = 360; this.coneOuterAngle = 360; this.coneOuterGain = 0; this._pos = [0, 0, 1];
      pmz.auPan(this._id, 0, 0, 1);
    }
    setPosition(x, y, z) { this._pos = [x, y, z]; pmz.auPan(this._id, +x, +y, +z); }
    setOrientation() {} setVelocity() {}
  }
  class AudioBufferSourceNode extends AudioNode {
    constructor(ctx, o) {
      super(ctx, 2);
      this.buffer = null; this._loop = false; this._ls = 0; this._le = 0; this._started = false; this.onended = null;
      this.playbackRate = new AudioParam(this, 1, 1); this.detune = new AudioParam(this, 0, 0);
    }
    get loop() { return this._loop; } set loop(v) { this._loop = !!v; this._relink(); }
    get loopStart() { return this._ls; } set loopStart(v) { this._ls = +v || 0; this._relink(); }
    get loopEnd() { return this._le; } set loopEnd(v) { this._le = +v || 0; this._relink(); }
    _relink() { if (this._started) pmz.auSrcLoop(this._id, this._loop ? 1 : 0, this._ls, this._le); }
    start(when, offset, duration) {
      if (this._started) throw new Error('InvalidStateError: start called more than once');
      if (!this.buffer) throw new Error('InvalidStateError: no buffer');
      const ok = pmz.auStart(this._id, this.buffer._id, +when || 0, +offset || 0, duration === undefined ? -1 : +duration, this._loop ? 1 : 0, this._ls, this._le);
      if (!ok) return;
      this._started = true; playing.set(this._id, this);
    }
    stop(when) {
      if (!this._started) throw new Error('InvalidStateError: stop before start');
      pmz.auStop(this._id, +when || 0);
    }
  }
  class AudioBuffer {
    constructor(o) {
      if (o && o._native) { this._id = o.id; this.sampleRate = o.sampleRate; this.length = o.length; this.numberOfChannels = o.numberOfChannels; }
      else { const n = Math.max(1, o.length | 0), ch = o.numberOfChannels || 1, sr = o.sampleRate || rate; this._id = pmz.auBufCreate(ch, n, sr); this.sampleRate = sr; this.length = n; this.numberOfChannels = Math.min(ch, 2); }
      this.duration = this.length / this.sampleRate;
      bufReg.register(this, this._id);
    }
    getChannelData(ch) { return pmz.auBufRead(this._id, ch | 0, 0, this.length); }   // a copy: writes to it do not reach the mixer
    copyFromChannel(dst, ch, start) { const a = pmz.auBufRead(this._id, ch | 0, start | 0, dst.length); dst.set(a.subarray(0, Math.min(a.length, dst.length))); }
    copyToChannel(src, ch, start) { pmz.auBufWrite(this._id, ch | 0, src, start | 0); }
  }
  class StubNode extends GainNode {   // pass-through node with the common stub properties
    constructor(ctx) { super(ctx); this.frequency = new AudioParam(this, 0, 350); this.Q = new AudioParam(this, 0, 1); this.type = 'lowpass'; this.fftSize = 2048; this.frequencyBinCount = 1024; this.pan = new AudioParam(this, 0, 0); this.threshold = new AudioParam(this, 0, -24); }
    getByteFrequencyData(a) { a.fill(0); } getByteTimeDomainData(a) { a.fill(128); } getFloatFrequencyData(a) { a.fill(-100); } getFloatTimeDomainData(a) { a.fill(0); }
  }
  class AudioContext {
    constructor(opts) {
      this.sampleRate = rate; this.state = 'running'; this.destination = { _id: 0, context: this, numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, maxChannelCount: 2, connect() {}, disconnect() {} };   // node 0 in C
      this.listener = { setPosition() {}, setOrientation() {}, positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 } };
      this.baseLatency = hasDevice ? info.frames / rate : 0; this.outputLatency = this.baseLatency; this.onstatechange = null;
    }
    get currentTime() { return now(); }
    createGain() { return new GainNode(this); }
    createPanner() { return new PannerNode(this); }
    createBufferSource() { return new AudioBufferSourceNode(this); }
    createBuffer(ch, len, sr) { return new AudioBuffer({ numberOfChannels: ch, length: len, sampleRate: sr }); }
    decodeAudioData(data, ok, fail) {
      const p = pmz.auDecode(data).then(r => new AudioBuffer(Object.assign(r, { _native: true })));
      p.then(b => { if (ok) ok(b); }, e => { let m = ''; try { const u = new Uint8Array(data.buffer || data, data.byteOffset || 0, 12); m = Buffer.from(u).toString('latin1').replace(/[^ -~]/g, '.'); } catch (x) {} warn('audio decode failed (' + (e && e.message) + '), header "' + m + '" (Ogg Vorbis only; m4a/wav/mp3 unsupported)'); if (fail) fail(e); });
      return p;
    }
    resume() { return Promise.resolve(); } suspend() { return Promise.resolve(); } close() { return Promise.resolve(); }
    createBiquadFilter() { return new StubNode(this); } createAnalyser() { return new StubNode(this); } createDynamicsCompressor() { return new StubNode(this); }
    createStereoPanner() { return new StubNode(this); } createDelay() { return new StubNode(this); } createConvolver() { return new StubNode(this); } createWaveShaper() { return new StubNode(this); }
    createChannelSplitter() { return new StubNode(this); } createChannelMerger() { return new StubNode(this); }
    createMediaElementSource() { return new StubNode(this); } createOscillator() { const n = new StubNode(this); n.start = n.stop = () => {}; return n; }
    addEventListener() {} removeEventListener() {}
  }
  // per frame: sources that finished fire onended
  function pump() {
    const ended = pmz.auEnded();
    if (!ended) return;
    for (const id of ended) {
      const n = playing.get(id); if (!n) continue;
      playing.delete(id);
      if (typeof n.onended === 'function') { try { n.onended({ type: 'ended', target: n }); } catch (e) { warn('onended: ' + (e && e.message)); } }
    }
  }
  return { AudioContext, AudioBuffer, AudioParam, GainNode, PannerNode, AudioBufferSourceNode, pump, info, hasDevice, rate, stats: r => pmz.auStats(r ? 1 : 0), playingCount: () => playing.size };
};
