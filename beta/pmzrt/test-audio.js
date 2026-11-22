'use strict';
// Native audio test (no window, no engine): decode a game BGM, play it through the same graph the engine builds
// (source -> gain -> panner -> master gain -> destination), force a short loop and compare the captured mixer output
// sample by sample with the decoded PCM. Also fades, scheduled start/stop, voice end, mixer timing.
// Usage (in the chroot): node test-audio.js [file.ogg_|.ogg] [gameDir]   env PMZ_AUDIO_DUMP=/path.wav keeps the dump
const fs = require('fs'), path = require('path');
const pmz = require('/opt/beta/pmzrt/pmzrt.node');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const GAMESRC = process.env.GAMESRC || '/gamesrc';
const file = process.argv[2] || GAMESRC + '/audio/bgm/Battle2.ogg_';
let fails = 0;
const check = (n, ok, d) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d !== undefined ? ' ' + JSON.stringify(d) : '')); };

function readOgg(f) {
  let b = fs.readFileSync(f);
  if (f.endsWith('_')) {   // RPG Maker MZ encrypted audio: 16 byte fake header, first 16 bytes of the file XOR the key
    const sys = JSON.parse(fs.readFileSync('/game/data/System.json', 'utf8')); const key = sys.encryptionKey.match(/.{2}/g).map(h => parseInt(h, 16));
    b = Buffer.from(b.subarray(16)); for (let i = 0; i < 16; i++) b[i] ^= key[i];
  }
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
}
(async () => {
  const dump = process.env.PMZ_AUDIO_DUMP || '/tmp/pmz-audio-test.wav';
  const info = pmz.auInit(1.0, dump, 44100, 512);
  console.log('init', JSON.stringify(info));
  check('device opened', !!info.ok, info);
  if (!info.ok) process.exit(1);
  const R = info.rate;
  const ab = readOgg(file);
  let t0 = Date.now();
  const dec = await pmz.auDecode(ab);
  const dms = Date.now() - t0;
  const secs = dec.length / dec.sampleRate;
  console.log('decoded', path.basename(file), JSON.stringify(dec), 'seconds', secs.toFixed(1), 'decode ms', dms, '=> x' + (secs * 1000 / dms).toFixed(1) + ' realtime', 'int16 MB', (dec.length * dec.numberOfChannels * 2 / 1048576).toFixed(1));
  check('decoded something', dec.length > 44100);
  const ch = dec.numberOfChannels, id = dec.id;
  const src = [pmz.auBufRead(id, 0, 0, dec.length), pmz.auBufRead(id, ch > 1 ? 1 : 0, 0, dec.length)];
  // graph like WebAudio: source -> gain -> panner -> master -> destination
  const master = pmz.auNode(0), panner = pmz.auNode(1), gain = pmz.auNode(0), s = pmz.auNode(2);
  pmz.auConnect(master, 0); pmz.auConnect(panner, master); pmz.auConnect(gain, panner); pmz.auConnect(s, gain);
  pmz.auPan(panner, 0, 0, 1);
  pmz.auParam(master, 0, 0, 1, 0, 0);
  // ---- loop: seconds [1.0, 2.3) of the file (in file frames), start slightly in the future, 3.4 loops ----
  const sr = dec.sampleRate, ls = Math.round(1.0 * sr), le = Math.round(2.3 * sr);
  const now = pmz.auTime(), when = now + 0.25, startF = Math.round(when * R);
  pmz.auStats(1);
  check('start ok', pmz.auStart(s, id, when, 0, -1, 1, ls / sr, le / sr));
  const playSec = 1.3 * 3.4 + 1.0;   // first pass 2.3 s then loops
  await sleep((when - now + 5.2) * 1000);
  const cap = pmz.auCaptureRead(startF, Math.round(5.0 * R));
  console.log('captured frames', cap.length / 2, 'resample ratio', (sr / R).toFixed(5));
  // expected output, same arithmetic as the mixer (double position, linear interpolation, wrap at loopEnd)
  const step = sr / R; let pos = 0, maxErr = 0, errAt = -1, zeroRun = 0, maxZeroRun = 0, sumsq = 0; const wraps = [];
  const get = (c, i) => src[ch > 1 ? c : 0][i];
  const N = cap.length / 2;
  for (let i = 0; i < N; i++) {
    if (pos >= le) { const ll = le - ls; pos -= ll * Math.floor((pos - ls) / ll); wraps.push(i); }
    const ip = Math.floor(pos), fr = pos - ip; let i1 = ip + 1; if (i1 >= le) i1 = ls + (i1 - le);
    for (let c = 0; c < 2; c++) {
      const e = fr === 0 ? get(c, ip) : get(c, ip) + (get(c, i1) - get(c, ip)) * fr;
      const err = Math.abs(cap[2 * i + c] - e); if (err > maxErr) { maxErr = err; errAt = i; }
    }
    const a = Math.abs(cap[2 * i]) + Math.abs(cap[2 * i + 1]); sumsq += cap[2 * i] ** 2;
    if (a === 0) { if (++zeroRun > maxZeroRun) maxZeroRun = zeroRun; } else zeroRun = 0;
    pos += step;
  }
  console.log('loop wraps at frames', wraps.slice(0, 6).join(','), '... n', wraps.length, ' (expected period ' + ((le - ls) / step).toFixed(2) + ' frames)');
  check('loop output matches decoded PCM sample for sample (' + wraps.length + ' loop points)', maxErr < 2e-6 * (sr === R ? 1 : 50), { maxErr, errAt, maxErrLSB: +(maxErr * 32768).toFixed(2) });
  check('no run of zero samples across the loop points', maxZeroRun < 64, { maxZeroRun });
  check('loop crossed at least twice', wraps.length >= 2);
  // jump at the loop points vs the same jump computed from the decoded source (the seam of a forced loop is a real discontinuity: it must be reproduced exactly, no extra gap)
  for (const w of wraps.slice(0, 3)) {
    const jump = Math.abs(cap[2 * w] - cap[2 * (w - 1)]);
    const exp = Math.abs(src[0][ls] - src[0][le - 1]);
    console.log('  seam at out frame ' + w + ': jump ' + jump.toFixed(5) + ' (source seam ' + exp.toFixed(5) + '), samples around: ' + [w - 2, w - 1, w, w + 1].map(k => cap[2 * k].toFixed(4)).join(' '));
  }
  console.log('rms', Math.sqrt(sumsq / N).toFixed(4));
  // ---- fade: gain ramp 1 -> 0 over 1.5 s, voice looping the whole file from 5.0 s ----
  pmz.auStop(s, 0); await sleep(100);
  const s2 = pmz.auNode(2); pmz.auConnect(s2, gain);
  const n2 = pmz.auTime(), w2 = n2 + 0.2, f2 = Math.round(w2 * R);
  pmz.auParam(gain, 0, 0, 1, w2, 0); pmz.auParam(gain, 0, 1, 0, w2 + 1.5, 0);   // setValueAtTime(1), linearRamp(0)
  pmz.auStart(s2, id, w2, 5.0, -1, 0, 0, 0);
  await sleep((w2 - n2 + 1.8) * 1000);
  const cap2 = pmz.auCaptureRead(f2, Math.round(1.6 * R));
  let maxDev = 0, nUsed = 0, clicks = 0, maxRel = 0;
  { let p2 = 5.0 * sr;   // expected = src(pos) * (1 - t/1.5)
    for (let i = 0; i < cap2.length / 2; i++) {
      const g = Math.max(0, 1 - (i / R) / 1.5); const ip = Math.floor(p2), fr = p2 - ip; const e = (src[0][ip] + (src[0][ip + 1] - src[0][ip]) * fr) * g;
      const err = Math.abs(cap2[2 * i] - e); if (err > maxDev) maxDev = err; p2 += step; nUsed++;
    } }
  check('fade-out is the exact linear ramp times the source (no clicks)', maxDev < 2e-4, { maxDev, frames: nUsed });
  pmz.auStop(s2, 0);
  // ---- scheduled stop + ended notification + non-looping end ----
  const s3 = pmz.auNode(2); pmz.auConnect(s3, gain); pmz.auParam(gain, 0, 5, 1, 0, 0);
  pmz.auEnded();
  pmz.auStart(s3, id, 0, 0, 0.3, 0, 0, 0);   // 0.3 s duration, plays now
  await sleep(700);
  const ended = pmz.auEnded();
  check('duration-limited source ends and is reported', ended && ended.includes(s3), ended);
  // ---- clock + cpu ----
  const st = pmz.auStats(0);
  console.log('stats', JSON.stringify(st));
  check('mixer callback average well below the block time', st.avgUs < st.blockUs * 0.25, { avgUs: st.avgUs, maxUs: st.maxUs, blockUs: st.blockUs });
  pmz.auBufFree(id);
  await sleep(100);
  console.log('RSS MB', (process.memoryUsage().rss / 1048576).toFixed(0));
  pmz.shutdown();
  console.log(fails ? 'FAILED ' + fails : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e && e.stack || e); process.exit(2); });
