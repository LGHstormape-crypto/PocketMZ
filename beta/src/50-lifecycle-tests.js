// ---------- once all scripts (core + plugins) have loaded ----------
function onAllScriptsLoaded() {
  log('all scripts loaded: plugins ok ' + loadedPlugins.length + ', failed ' + failedPlugins.length);
  // PMZ_AUDIO=off: audio memory is excluded, buffers are dummies
  if (!AUDIO_ON) AudioManager.createBuffer = function (folder, name) {
    const b = makeNoopProxy({ isReady: () => true, isError: () => false, isPlaying: () => false, addLoadListener: f => f(b), name, volume: 1, pitch: 1, pan: 0, url: folder + name, retry: noop });
    return b;
  };
  const origPrint = Graphics.printError;
  Graphics.printError = function (name, msg, error) { log("Graphics.printError", name, String(msg).slice(0, 300), String(error && error.stack || "").slice(0, 600)); otherErrors.push('printError ' + name + ' ' + msg); try { return origPrint.apply(this, arguments); } catch (e) {} };
  patchStorage();
  if (GLOBAL_REQUIRE && typeof globalThis.require !== 'function') { def('require', require); log('global require defined (dev/test: PocketMZ_Debug)'); }
  try { performance.memory; if (!performance.memory) Object.defineProperty(performance, 'memory', { get: () => ({ usedJSHeapSize: proc.memoryUsage().heapUsed, totalJSHeapSize: proc.memoryUsage().heapTotal, jsHeapSizeLimit: 256 << 20 }) }); } catch (e) {}
  if (c2d.fontSet && !c2d.fontSet[Symbol.iterator]) try { c2d.fontSet[Symbol.iterator] = function* () {}; } catch (e) {}   // PocketMZ_Debug: [...document.fonts]
  if (typeof globalThis.onload === 'function') { try { globalThis.onload({ type: 'load', target: globalThis }); } catch (e) { otherErrors.push('window.onload: ' + e.stack); log('ONLOAD ERR', String(e.stack).slice(0, 500)); } }   // MV main.js: window.onload = SceneManager.run(Scene_Boot)
  fire(winListeners, 'load');   // -> Main.onWindowLoad -> effekseer.initRuntime -> SceneManager.run(Scene_Boot)
  (PLAY ? playDrive() : drive()).catch(e => { log('DRIVE FAILED', e && e.stack || e); otherErrors.push('drive: ' + (e && e.stack)); finish(1); });
}

async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try { ok = fn(); } catch (e) {}
    if (ok) return;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what + ' (scene=' + (SceneManager._scene && SceneManager._scene.constructor.name) + ')');
    await sleep(100);
    if ((Date.now() - t0) % 5000 < 100) { let st = ''; try { st = 'scene=' + (SceneManager._scene && SceneManager._scene.constructor.name) + ' main.xhr=' + main.xhrSucceeded + ' main.err=' + (main.error && main.error.message) + ' efk=' + typeof effekseer; } catch (e) { st = 'n/a ' + e.message; } log('waiting for ' + what + ' ' + st); }
  }
}
const sceneActive = cls => () => { const s = SceneManager._scene; return s instanceof cls && s.isActive() && ImageManager.isReady(); };

async function takeShotTo(p) {
  shotInfo = null; shotPending = p;
  await until(() => shotInfo, 5000, 'screenshot ' + p);
}
// micro benchmarks inside the run (title scene is up): Bitmap.drawText and measureText with the game's main font
async function bench() {
  const r = {};
  let face = 'rmmz-mainfont'; try { face = $gameSystem.mainFontFace(); } catch (e) {}
  const bm = new Bitmap(640, 48); bm.fontFace = face; bm.fontSize = 26; bm.textColor = '#ffffff'; bm.outlineColor = 'rgba(0, 0, 0, 0.5)'; bm.outlineWidth = 4;
  const txt = 'テスト文字列 Test 123';
  bm.drawText(txt, 0, 0, 640, 48, 'left');   // warm-up (font lookup, glyph cache)
  const tt0 = pmz.textTimes ? pmz.textTimes() : [0, 0, 0];
  let t0 = nowMs(); for (let i = 0; i < 300; i++) bm.drawText(txt, 0, 0, 640, 48, 'left'); r.drawText300Ms = +(nowMs() - t0).toFixed(1);
  if (pmz.textTimes) { const tt1 = pmz.textTimes(); r.strokeN = tt1[0] - tt0[0]; r.layoutPathUsPerCall = +((tt1[1] - tt0[1]) / (r.strokeN || 1)).toFixed(0); r.strokeUsPerCall = +((tt1[2] - tt0[2]) / (r.strokeN || 1)).toFixed(0); if (pmz.textCacheStats) r.textCache = pmz.textCacheStats().join('/'); }
  const ctx = bm.context; ctx.font = bm._makeFontNameText();
  t0 = nowMs(); let wsum = 0; for (let i = 0; i < 2000; i++) wsum += ctx.measureText(txt + (i % 7)).width; r.measureText2000Ms = +(nowMs() - t0).toFixed(1);
  t0 = nowMs(); for (let i = 0; i < 2000; i++) wsum += bm.measureTextWidth(txt); r.measureTextWidth2000Ms = +(nowMs() - t0).toFixed(1);
  r.width = +(wsum / 4000).toFixed(2); r.font = ctx.font;
  bm.destroy && bm.destroy();
  timings.bench = r; log('BENCH', JSON.stringify(r));
}

async function drive() {
  // wait for Main.initEffekseerRuntime -> Scene_Boot
  await until(() => typeof SceneManager !== 'undefined' && SceneManager._scene, 120000, 'first scene');
  log('first scene', SceneManager._scene.constructor.name);
  await until(sceneActive(Scene_Title), 180000, 'Scene_Title');
  timings.titleAt = proc.uptime(); log('title reached');
  if (proc.env.SAVETEST === '1') { await saveTestStage(); return finish(0); }
  if (proc.env.INPUTTEST === '1') { await inputTestStage(); return finish(0); }
  if (proc.env.AUDIOTEST === '1') { await audioTestStage(); return finish(T.fails ? 1 : 0); }
  if (proc.env.PMZ_MTEST === '1') { log('MTEST ' + vm.runInThisContext(fs.readFileSync('/opt/beta/mtest.js', 'utf8'))); await bench(); return finish(0); }
  if (proc.env.PMZ_BATTLE === '1') { await battleStage(); return finish(0); }
  const tTitle = nowMs();
  await sleep(HOLD - 1500);
  await takeShotTo(SHOT);
  await sleep(1500);
  const tEnd = nowMs();
  timings.titleStats = frameStats(tTitle + 1000, tEnd);   // skip the first second (texture uploads / settling)
  timings.rssRawAtTitle = readProc();                     // before the gc in measure()
  await measure('title', { scene: SceneManager._scene.constructor.name });
  await bench();
  // options window (stock Scene_Options pushed from the title)
  const profSnap = () => Object.fromEntries(Object.entries(prof).map(([k, v]) => [k, { n: v.n, ms: v.ms }]));
  const p0 = profSnap(), tPush = nowMs(), f0 = frames.length;
  SceneManager.push(Scene_Options);
  await until(() => SceneManager._scene instanceof Scene_Options && SceneManager._scene.isActive() && ImageManager.isReady(), 15000, 'Scene_Options');
  {  // scene-open cost: push -> active (the frames in between include scene create, window contents, fade-in)
    const fr = frames.slice(f0).map(f => +f.dt.toFixed(1)); const p1 = profSnap();
    const d = Object.entries(p1).map(([k, v]) => [k, v.n - (p0[k] ? p0[k].n : 0), v.ms - (p0[k] ? p0[k].ms : 0)]).filter(e => e[1]).sort((a, b) => b[2] - a[2]).slice(0, 8);
    timings.optionsOpen = { ms: +(nowMs() - tPush).toFixed(0), frames: fr.length, longest: Math.max(0, ...fr), native: d.map(e => e[0] + ' ' + e[1] + '/' + e[2].toFixed(0)).join(', ') };
    log('OPTIONS_OPEN', JSON.stringify(timings.optionsOpen));
  }
  if (proc.env.PMZ_NOBLUR === '1') { const sp = SceneManager._scene._backgroundSprite; if (sp) sp.filters = null; log('PMZ_NOBLUR: background blur filter removed'); }
  const tOpt = nowMs();
  await sleep(2000);
  await takeShotTo(SHOT2);
  await sleep(1500);
  timings.optionsStats = frameStats(tOpt + 1000, nowMs());
  await measure('options', { scene: SceneManager._scene.constructor.name });
  SceneManager.pop(); await sleep(800);
  await mapStage();
  finish(0);
}


// PMZ_BATTLE=1: scripted battle (no title/options/map stages): enter Scene_Battle, play real Effekseer animations on the first enemy, screenshot during one
// (PMZ_BATTLE_SHOT, default /opt/beta/shots/battle-beta-N.png), then measure fps / natives over PMZ_BATTLE_SEC seconds of repeated animations.
async function battleStage() {
  DataManager.setupNewGame();
  const tid = +(proc.env.PMZ_TROOP || 0) || ($dataTroops.find(t => t && t.members && t.members.length) || {}).id;
  const have = a => a && a.effectName && fs.existsSync(path.join(GAME, 'effects', a.effectName + '.efkefc'));
  const aid = +(proc.env.PMZ_ANIM || 0) || ($dataAnimations.find(have) || {}).id;
  log('BATTLE troop ' + tid + ' anim ' + aid + ' ' + ($dataAnimations[aid] && $dataAnimations[aid].effectName));
  const tB = nowMs();
  BattleManager.setup(tid, true, false);
  SceneManager.goto(Scene_Battle);
  await until(() => SceneManager._scene instanceof Scene_Battle && SceneManager._scene.isActive() && ImageManager.isReady(), 60000, 'Scene_Battle');
  timings.battleOpenMs = +(nowMs() - tB).toFixed(0); log('BATTLE_OPEN ' + timings.battleOpenMs + ' ms, enemies ' + $gameTroop.members().length + ', party ' + $gameParty.members().length);
  await sleep(3000);
  const spriteset = () => SceneManager._scene._spriteset, target = () => $gameTroop.members()[0] || $gameParty.members()[0];
  const play = async () => { $gameTemp.requestAnimation([target()], aid); const t0 = nowMs(); await until(() => spriteset().isAnimationPlaying(), 5000, 'animation start'); return t0; };
  const base = proc.env.PMZ_BATTLE_SHOT || '/opt/beta/shots/battle-beta.png';
  if (proc.env.PMZ_FREEZE) {   // PMZ_FREEZE=N: stop Effekseer's update after N updates since the request (the effect stays drawn at that frame), screenshot, release: same frame as in NW.js (beta/nw-battle-freeze.js)
    const N = +proc.env.PMZ_FREEZE, E = Graphics.effekseer, up = E.update; let cnt = 0, counting = false, frozen = false;
    const hasHandle = () => { try { return spriteset()._animationSprites.some(a => a._handle); } catch (e) { return false; } };   // count from the moment the effect is really playing (NW.js loads effects asynchronously, later than here)
    E.update = function () { if (frozen) return; if (counting && hasHandle() && ++cnt >= N) frozen = true; return up.apply(this, arguments); };
    for (let i = 1; i <= 2; i++) {
      cnt = 0; frozen = false; counting = true; await play();
      await until(() => frozen, 5000, 'effekseer freeze'); await sleep(600);
      await takeShotTo(base.replace(/\.png$/, '-freeze' + i + '.png'));
      frozen = false; counting = false; await until(() => !spriteset().isAnimationPlaying(), 20000, 'animation end'); await sleep(500);
    }
    E.update = up; return;
  }
  for (let i = 1; i <= 3; i++) {
    await play(); await sleep(150 + 100 * i);
    await takeShotTo(base.replace(/\.png$/, '-' + i + '.png'));
    const t0 = nowMs(); await until(() => !spriteset().isAnimationPlaying(), 20000, 'animation end'); log('ANIM ' + i + ' ended ' + (nowMs() - t0).toFixed(0) + ' ms after the shot');
    await sleep(500);
  }
  const sec = +(proc.env.PMZ_BATTLE_SEC || 12) * 1000, q0 = JSON.parse(JSON.stringify(prof)), g0 = frames.length, tM = nowMs(), cp = proc.env.PMZ_CPUPROF === '1' ? await cpuProfStart() : null;
  if (proc.env.PMZ_BATTLE_REAL === '1') {   // a real fight: pulse OK (Attack -> first enemy) for the whole window, new battle when it ends
    let pulses = 0, rounds = 0;
    while (nowMs() - tM < sec) {
      if (!(SceneManager._scene instanceof Scene_Battle)) { await sleep(300); continue; }
      Input._currentState.ok = true; await sleep(80); Input._currentState.ok = false; await sleep(100); pulses++;
      if (BattleManager.isBattleEnd && BattleManager.isBattleEnd() && pulses % 5 === 0) { rounds++; BattleManager.setup(tid, true, false); SceneManager.goto(Scene_Battle); await sleep(2500); }
    }
    log('BATTLE_REAL pulses ' + pulses + ' new battles ' + rounds);
  } else
  while (nowMs() - tM < sec) { await play(); await until(() => !spriteset().isAnimationPlaying(), 20000, 'animation end'); }
  const nf = frames.length - g0; const d = Object.entries(prof).map(([k, v]) => [k, v.n - (q0[k] ? q0[k].n : 0), v.ms - (q0[k] ? q0[k].ms : 0)]).filter(e => e[1]).sort((x, y) => y[2] - x[2]).slice(0, 16);
  if (d.length) log('BATTLE_NATIVE per frame (' + nf + ' frames): total ' + (d.reduce((t, e) => t + e[2], 0) / nf).toFixed(1) + 'ms; ' + d.map(e => e[0] + ' ' + (e[1] / nf).toFixed(1) + '/' + (e[2] / nf).toFixed(2) + 'ms').join(', '));
  if (cp) await cpuProfStop(cp);
  timings.battleStats = frameStats(tM, nowMs()); log('BATTLE_STATS ' + JSON.stringify(timings.battleStats) + (pmz.textCacheStats ? ' textCache=' + pmz.textCacheStats().join('/') : ''));
  await measure('battle', { scene: SceneManager._scene && SceneManager._scene.constructor.name });
}

function cpuProfStart() {
  const insp = require('inspector'); const ses = new insp.Session(); ses.connect();
  return new Promise(r => ses.post('Profiler.enable', () => ses.post('Profiler.setSamplingInterval', { interval: 500 }, () => ses.post('Profiler.start', () => r(ses)))));
}
function cpuProfStop(ses) {
  return new Promise(r => ses.post('Profiler.stop', (e, { profile }) => {
    const self = new Map(), byId = new Map(); profile.nodes.forEach(n => byId.set(n.id, n));
    const dt = profile.timeDeltas; let tot = 0;
    profile.samples.forEach((id, i) => { const n = byId.get(id), cf = n.callFrame, k = (cf.functionName || '(anon)') + ' ' + cf.url.split('/').slice(-2).join('/') + ':' + cf.lineNumber; self.set(k, (self.get(k) || 0) + dt[i]); tot += dt[i]; });
    const byFile = new Map(); self.forEach((v, k) => { const f = k.replace(/^.*? (\S+):-?\d+$/, '$1'); byFile.set(f, (byFile.get(f) || 0) + v); });
    log('CPUPROF by file: ' + [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(e => e[0] + ' ' + (e[1] / 1000).toFixed(0)).join(', '));
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    log('CPUPROF total ' + (tot / 1000).toFixed(0) + ' ms\n' + top.map(e => '  ' + (e[1] / 1000).toFixed(0) + ' ms ' + e[0]).join('\n'));
    r();
  }));
}
// M1-5: new game -> Scene_Map exactly like Scene_Title.commandNewGame, hold, measure
async function mapStage() {
  await until(sceneActive(Scene_Title), 10000, 'Scene_Title (after options)');
  const tNew = nowMs();
  DataManager.setupNewGame();
  try { SceneManager._scene._commandWindow.close(); } catch (e) {}
  SceneManager._scene.fadeOutAll();
  SceneManager.goto(Scene_Map);
  await until(() => SceneManager._scene instanceof Scene_Map && SceneManager._scene.isActive() && $gamePlayer && $gameMap && $gameMap.mapId() > 0, 30000, 'Scene_Map');
  timings.mapOpenMs = +(nowMs() - tNew).toFixed(0);
  const info = () => ({ mapId: $gameMap.mapId(), x: $gamePlayer.x, y: $gamePlayer.y, msgBusy: $gameMessage.isBusy(), interpreter: $gameMap._interpreter.isRunning(), scene: SceneManager._scene.constructor.name });
  timings.mapInfoOpen = info(); log('MAP_OPEN', JSON.stringify(timings.mapInfoOpen));
  let mtStat = null;
  if (proc.env.PMZ_CPUPROF === '1') {   // who calls measureText, with what
    const P = Object.getPrototypeOf(new Bitmap(4, 4).context), orig = P.measureText; mtStat = { n: 0, ms: 0, by: {} };
    P.measureText = function (t) {
      const a = nowMs(); const r = orig.call(this, t); const d = nowMs() - a; mtStat.n++; mtStat.ms += d;
      const st = (new Error().stack || '').split('\n').slice(2, 5).map(l => l.trim().replace(/^at /, '').replace(/\(?file:\/\/\/game\//, '(')).join(' < ');
      const e = mtStat.by[st] || (mtStat.by[st] = { n: 0, ms: 0, ex: String(t).slice(0, 30), font: this.font }); e.n++; e.ms += d; return r;
    };
  }
  const pSnap0 = JSON.parse(JSON.stringify(prof)), f0 = frames.length;
  const tMap = nowMs(); const cp = proc.env.PMZ_CPUPROF === '1' ? await cpuProfStart() : null;
  await sleep(+(proc.env.MAPHOLD || 10000) - 2500);
  await takeShotTo(SHOT3);
  await sleep(2500);
  timings.mapStats = frameStats(tMap + 1000, nowMs());
  { const nf = frames.length - f0; const d = Object.entries(prof).map(([k, v]) => [k, v.n - (pSnap0[k] ? pSnap0[k].n : 0), v.ms - (pSnap0[k] ? pSnap0[k].ms : 0)]).filter(e => e[1]).sort((a, b) => b[2] - a[2]).slice(0, 14);
    if (d.length) log('MAP_NATIVE per frame (' + nf + ' frames): ' + d.map(e => e[0] + ' ' + (e[1] / nf).toFixed(1) + '/' + (e[2] / nf).toFixed(2) + 'ms').join(', ')); }
  if (cp) await cpuProfStop(cp);
  if (mtStat) log('MEASURETEXT n ' + mtStat.n + ' ms ' + mtStat.ms.toFixed(0) + '\n' + Object.entries(mtStat.by).sort((a, b) => b[1].ms - a[1].ms).slice(0, 8).map(e => '  ' + e[1].n + ' ' + e[1].ms.toFixed(0) + 'ms "' + e[1].ex + '" ' + e[1].font + ' @ ' + e[0].slice(0, 400)).join('\n'));
  timings.mapInfo = info(); log('MAP_INFO', JSON.stringify(timings.mapInfo));
  await measure('map', { scene: SceneManager._scene.constructor.name });
  // teleport to a real map (the opening is a long chain of questions on a black map), settle, measure still + walking
  if (proc.env.TELEPORT !== '0') {
    const tid = +(proc.env.TELEPORT || 11);
    $gameMap.events().forEach(e => e.erase()); $gameMessage.clear(); $gameMap._interpreter.clear(); $gamePlayer.reserveTransfer(tid, 10, 10, 2, 0);
    await sleep(500);
    for (let i = 0; i < 4; i++) { await sleep(1000); const sc = SceneManager._scene; log('TP_STATE', JSON.stringify({ scene: sc.constructor.name, map: $gameMap.mapId(), transferring: $gamePlayer.isTransferring(), msgBusy: $gameMessage.isBusy(), msgWinOpen: sc._messageWindow && sc._messageWindow.isOpen && sc._messageWindow.isOpen(), choiceOpen: sc._messageWindow && sc._messageWindow._choiceListWindow.isOpen(), interp: $gameMap._interpreter.isRunning(), changing: SceneManager.isSceneChanging(), imgReady: ImageManager.isReady(), fade: $gameScreen.brightness && sc._fadeSprite && sc._fadeSprite.opacity })); }
    await until(() => SceneManager._scene instanceof Scene_Map && SceneManager._scene.isActive() && !SceneManager.isSceneChanging() && $gameMap.mapId() === tid && ImageManager.isReady() && !$gamePlayer.isTransferring(), 40000, 'teleport');
    if (!$gameMap.isPassable($gamePlayer.x, $gamePlayer.y, 2)) {   // nearest passable tile
      let best = null; for (let y = 0; y < $gameMap.height(); y++) for (let x = 0; x < $gameMap.width(); x++) if ($gameMap.isPassable(x, y, 2) && $gameMap.isPassable(x, y, 6) && $gameMap.isPassable(x + 1, y, 6) && $gameMap.isPassable(x + 2, y, 6)) { const d = Math.abs(x - $gameMap.width() / 2) + Math.abs(y - $gameMap.height() / 2); if (!best || d < best.d) best = { x, y, d }; }
      if (best) $gamePlayer.locate(best.x, best.y);
    }
    await sleep(2500);
    timings.teleport = { map: $gameMap.mapId(), w: $gameMap.width(), h: $gameMap.height(), x: $gamePlayer.x, y: $gamePlayer.y, events: $gameMap.events().length, tileset: $gameMap.tilesetId(), msgBusy: $gameMessage.isBusy(), interp: $gameMap._interpreter.isRunning() };
    log('TELEPORT', JSON.stringify(timings.teleport));
    // profile the still town map (no screenshot inside the window): PMZ_PROF=all -> GL natives per frame, PMZ_CPUPROF2=1 -> JS self time
    { const q0 = JSON.parse(JSON.stringify(prof)), g0 = frames.length, cp2 = proc.env.PMZ_CPUPROF2 === '1' ? await cpuProfStart() : null;
      await sleep(3000);
      const nf = frames.length - g0; const d = Object.entries(prof).map(([k, v]) => [k, v.n - (q0[k] ? q0[k].n : 0), v.ms - (q0[k] ? q0[k].ms : 0)]).filter(e => e[1]).sort((x, y) => y[2] - x[2]).slice(0, 16);
      if (d.length) log('MAP2_NATIVE per frame (' + nf + ' frames): total ' + (d.reduce((t, e) => t + e[2], 0) / nf).toFixed(1) + 'ms; ' + d.map(e => e[0] + ' ' + (e[1] / nf).toFixed(1) + '/' + (e[2] / nf).toFixed(2) + 'ms').join(', '));
      if (cp2) await cpuProfStop(cp2); }
    const tS = nowMs(); await sleep(1500); await takeShotTo(SHOT4); await sleep(2500);
    timings.mapPlayStats = frameStats(tS + 1000, nowMs());
    await measure('map2', { scene: SceneManager._scene.constructor.name });
    const px = $gamePlayer.x, tW = nowMs(), w0 = JSON.parse(JSON.stringify(prof)), wf0 = frames.length, cp3 = proc.env.PMZ_CPUPROF3 === '1' ? await cpuProfStart() : null;
    Input._currentState.right = true; await sleep(4000); Input._currentState.right = false;
    { const nf = frames.length - wf0; const d = Object.entries(prof).map(([k, v]) => [k, v.n - (w0[k] ? w0[k].n : 0), v.ms - (w0[k] ? w0[k].ms : 0)]).filter(e => e[1]).sort((x, y) => y[2] - x[2]).slice(0, 16);
      if (d.length) log('WALK_NATIVE per frame (' + nf + ' frames): total ' + (d.reduce((t, e) => t + e[2], 0) / nf).toFixed(1) + 'ms; ' + d.map(e => e[0] + ' ' + (e[1] / nf).toFixed(1) + '/' + (e[2] / nf).toFixed(2) + 'ms').join(', '));
      if (cp3) await cpuProfStop(cp3); }
    await sleep(200);
    timings.walkStats = frameStats(tW + 200, nowMs() - 200); timings.walk = { dx: $gamePlayer.x - px, x: $gamePlayer.x, y: $gamePlayer.y };
    await sleep(800); await takeShotTo(SHOT5);
  }
  // advance the opening event (press OK) until the interpreter is idle, then measure the real map
  if (proc.env.MAPADV === '1') {
    const tAdv = nowMs(); let idleSince = 0, presses = 0;
    for (;;) {
      Input._currentState.ok = true; await sleep(100); Input._currentState.ok = false; presses++; await sleep(120);
      if ($gameMessage.isChoice() && presses % 4 === 0) { const w = SceneManager._scene._messageWindow._choiceListWindow; if (presses % 25 === 0) log('CHOICE_STATE', JSON.stringify({ active: w.active, open: w.isOpen(), idx: w.index(), items: w.maxItems(), okEnabled: w.isOkEnabled(), okTrig: w.isOkTriggered && w.isOkTriggered(), choices: $gameMessage.choices() })); { w.select(w.maxItems() - 1); w.processOk(); } }
      const idle = !$gameMessage.isBusy() && !$gameMap._interpreter.isRunning() && !SceneManager.isSceneChanging() && SceneManager._scene instanceof Scene_Map;
      if (idle) { if (!idleSince) idleSince = nowMs(); if (nowMs() - idleSince > 1500) break; } else idleSince = 0;
      if (nowMs() - tAdv > 55000) { log('MAP_ADV timeout'); break; }
    }
    timings.mapAdv = { ms: +(nowMs() - tAdv).toFixed(0), presses, info: info() }; log('MAP_ADV', JSON.stringify(timings.mapAdv));
    await sleep(2000);
    const tP = nowMs(); await sleep(1500); await takeShotTo(SHOT4); await sleep(2500);
    timings.mapPlayStats = frameStats(tP + 1000, nowMs());
    await measure('map2', { scene: SceneManager._scene.constructor.name });
  }
}


// PMZ_PROFLOG=1 (play mode, e.g. under the autotest): every ~10 s an 8 s window -> log line with scene, fps, JS/native split and the top natives per frame
// (needs PMZ_PROF=all); PMZ_CPUPROF=1 adds a JS CPU profile of the windows that fall into Scene_Battle.
async function profLoop() {
  const snap = () => JSON.parse(JSON.stringify(prof));
  for (;;) {
    await sleep(2000);
    const sc = sceneName(), q0 = snap(), g0 = frames.length, t0 = nowMs();
    const cp = proc.env.PMZ_CPUPROF === '1' && sc === 'Scene_Battle' ? await cpuProfStart() : null;
    let tp = null, origDT = null;   // PMZ_TEXTPROF=1: who calls Bitmap.drawText (battle windows)
    if (proc.env.PMZ_TEXTPROF === '1' && sc === 'Scene_Battle') {
      tp = { n: 0, by: {} }; origDT = Bitmap.prototype.drawText;
      Bitmap.prototype.drawText = function (text) {
        tp.n++; const st = (new Error().stack || '').split('\n').slice(2, 6).map(l => l.trim().replace(/^at /, '').replace(/\(?file:\/\/\/game\//, '(').replace(/js\/plugins\//, '')).join(' < ');
        const e = tp.by[st] || (tp.by[st] = { n: 0, ex: String(text).slice(0, 20) + '|' + this.width + 'x' + this.height }); e.n++; return origDT.apply(this, arguments);
      };
    }
    await sleep(8000);
    if (tp) { Bitmap.prototype.drawText = origDT; log('TEXTPROF drawText calls ' + tp.n + ' in 8 s\n' + Object.entries(tp.by).sort((a, b) => b[1].n - a[1].n).slice(0, 8).map(e => '  ' + e[1].n + ' "' + e[1].ex + '" ' + e[0]).join('\n')); }
    const nf = frames.length - g0, st = frameStats(t0, nowMs());
    const d = Object.entries(prof).map(([k, v]) => [k, v.n - (q0[k] ? q0[k].n : 0), v.ms - (q0[k] ? q0[k].ms : 0)]).filter(e => e[1]).sort((x, y) => y[2] - x[2]).slice(0, 10);
    log('PROFWIN scene=' + sc + '->' + sceneName() + ' ' + (st ? 'fps ' + st.fps + ' avg ' + st.avgMs + 'ms js ' + st.jsAvgMs + 'ms swap ' + st.swapAvgMs + 'ms p95 ' + st.p95 + ' max ' + st.maxMs : 'no frames') + ' | natives/frame ' + (d.reduce((t, e) => t + e[2], 0) / Math.max(1, nf)).toFixed(1) + 'ms: ' + d.map(e => e[0] + ' ' + (e[1] / Math.max(1, nf)).toFixed(1) + '/' + (e[2] / Math.max(1, nf)).toFixed(2)).join(', '));
    if (cp) await cpuProfStop(cp);
  }
}

// guard (PMZ_GUARD=1): watches the boot. Booted = the scene after Scene_Boot exists; a GL error (read once, they stick until read) or a timeout fails it.
function guardBoot() {
  const t0 = Date.now(), timer = setInterval(() => {
    if (guardFailed) return clearInterval(timer);
    const sc = typeof SceneManager !== 'undefined' && SceneManager._scene && SceneManager._scene.constructor.name;
    if (sc && sc !== 'Scene_Boot') {
      clearInterval(timer);
      const errs = []; let e, n = 0; while ((e = pmz.getError()) && n++ < 8) errs.push('0x' + e.toString(16));
      if (errs.length) return guardFail('GL error at boot: ' + errs.join(','));
      guardBooted = true; log('GUARD boot ok: scene ' + sc + ' after ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
      if (proc.env.PMZ_GUARD_FORCE) guardFail('forced: ' + proc.env.PMZ_GUARD_FORCE);
    } else if (Date.now() - t0 > GUARD_BOOT_SEC * 1000) { clearInterval(timer); guardFail('no scene after Scene_Boot within ' + GUARD_BOOT_SEC + ' s (scene ' + sc + ')'); }
  }, 200);
}
// play mode: the engine runs by itself (Scene_Boot -> title ...); we only wait for the first scene so errors show up in the log
async function playDrive() {
  if (GUARD) guardBoot();
  await until(() => typeof SceneManager !== 'undefined' && SceneManager._scene, 120000, 'first scene');
  log('PLAY: first scene ' + SceneManager._scene.constructor.name + ', saves in ' + SAVE_DIR + '; quit with Select+Start');
  if (proc.env.PMZ_PROFLOG === '1') profLoop().catch(e => log('profLoop failed', e && e.stack));
  if (proc.env.PMZ_PLAYSELFTEST === '1') {   // self-ending check of the play-mode quit path (needs SAVE_DIR: never the real save dir)
    if (!proc.env.SAVE_DIR) { log('PLAYSELFTEST needs SAVE_DIR'); return finish(2); }
    setTimeout(() => { log('PLAYSELFTEST watchdog'); finish(9); }, 60000);
    await until(sceneActive(Scene_Title), 60000, 'Scene_Title'); await sleep(1500);
    ConfigManager.save(); handleInput({ type: 'buttondown', button: 'back' }); handleInput({ type: 'buttondown', button: 'start' });   // save in flight + Select+Start
    log('PLAYSELFTEST: Select+Start injected, pendingSaves ' + pendingSaves);
  }
}

// ---------- scripted tests (MODE=test) ----------
const T = { fails: 0 };
function check(name, ok, detail) { if (!ok) T.fails++; log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); return ok; }
const sceneName = () => SceneManager._scene && SceneManager._scene.constructor.name;
const mapReady = id => () => SceneManager._scene instanceof Scene_Map && SceneManager._scene.isActive() && !SceneManager.isSceneChanging() && $gameMap.mapId() === id && ImageManager.isReady() && !$gamePlayer.isTransferring();

// SAVETEST=1: (a) load the newest alpha save of the (copied) SAVE_DIR, (b) save to a new slot, compare formats, load it back
async function saveTestStage() {
  const dir = StorageManager.fileDirectoryPath();
  check('save dir is the test dir', dir === SAVE_DIR && dir !== path.join(GAME, 'save') + '/', dir);
  const files = fs.readdirSync(dir).sort(); log('SAVETEST files: ' + files.join(', '));
  const raw = {}; for (const f of files) raw[f] = fs.readFileSync(dir + f, 'utf8');
  DataManager.loadGlobalInfo(); await until(() => DataManager._globalInfo, 5000, 'global info');
  const gi = DataManager._globalInfo; log('SAVETEST globalInfo: ' + JSON.stringify(gi.map(x => x && { title: x.title, chars: x.characters && x.characters.length, playtime: x.playtime, ts: x.timestamp })));
  const alphaIds = gi.map((x, i) => x && i > 0 ? i : 0).filter(i => i && StorageManager.exists('file' + i));
  let loadedSlot = 0;
  if (!alphaIds.length) log('SAVETEST: no alpha saves in the test dir, part (a) skipped');
  else {
    const id = loadedSlot = DataManager.latestSavefileId(); log('SAVETEST newest slot ' + id);
    const alphaJson = JSON.parse(await StorageManager.zipToJson(raw['file' + id + '.rmmzsave']));
    await DataManager.loadGame(id);
    const info = { map: $gameMap.mapId(), x: $gamePlayer.x, y: $gamePlayer.y, gold: $gameParty.gold(), members: $gameParty.members().map(a => a.name() + ' L' + a.level), playtime: $gameSystem.playtimeText() };
    log('SAVETEST loaded ' + JSON.stringify(info));
    check('loaded map id matches the save file', $gameMap.mapId() === alphaJson.map._mapId, { fileMap: alphaJson.map._mapId });
    check('party has members', $gameParty.members().length > 0);
    check('gold matches the save file', $gameParty.gold() === alphaJson.party._gold, { fileGold: alphaJson.party._gold });
    log('SAVETEST versionId save ' + $gameSystem.versionId() + ' data ' + $dataSystem.versionId);
    { // pure round trip: save straight after the load (no scene change) and compare the sizes per key with the file we loaded
      await DataManager.saveGame(6); while (pendingSaves > 0) await sleep(20);
      const j6 = JSON.parse(await StorageManager.zipToJson(fs.readFileSync(dir + 'file6.rmmzsave', 'utf8')));
      const same = Object.keys(alphaJson).every(k => JSON.stringify(alphaJson[k]) === JSON.stringify(j6[k]));
      const diff = Object.keys(alphaJson).filter(k => JSON.stringify(alphaJson[k]) !== JSON.stringify(j6[k]));
      check('load -> save round trip reproduces the alpha save content', same || diff.every(k => ['system', 'screen', 'player'].includes(k)), { differing: diff.map(k => k + ' ' + JSON.stringify(alphaJson[k]).length + '/' + JSON.stringify(j6[k]).length) });
    }
    if ($gameSystem.versionId() !== $dataSystem.versionId) { $gamePlayer.reserveTransfer($gameMap.mapId(), $gamePlayer.x, $gamePlayer.y); $gamePlayer.requestMapReload(); }
    SceneManager.goto(Scene_Map);
    await until(() => SceneManager._scene instanceof Scene_Map && SceneManager._scene.isActive() && !SceneManager.isSceneChanging() && ImageManager.isReady() && !$gamePlayer.isTransferring(), 40000, 'Scene_Map after load');
    await sleep(2500); await takeShotTo('/opt/beta/shots/save-loaded.png');
    const sh = shotInfos['/opt/beta/shots/save-loaded.png'];
    check('map shown after load', sh.nonBlackPct > 20, sh);
  }
  // (b) save into a fresh slot of the test dir
  if (!$gameParty || !$gameParty.members) { log('SAVETEST: no game loaded, starting a new game for part (b)'); DataManager.setupNewGame(); }
  const SLOT = 7, before = { map: $gameMap.mapId ? $gameMap.mapId() : 0, gold: $gameParty.gold(), members: $gameParty.members().map(a => a.actorId()) };
  if (typeof $gameSystem.onBeforeSave === 'function') $gameSystem.onBeforeSave();
  await DataManager.saveGame(SLOT);
  { const t0 = Date.now(); while (pendingSaves > 0 && Date.now() - t0 < 3000) await sleep(20); check('save finished, global info write flushed (pendingSaves -> 0)', pendingSaves === 0, { waitedMs: Date.now() - t0 }); }
  const nf = dir + 'file' + SLOT + '.rmmzsave'; check('new save file exists', fs.existsSync(nf));
  const nraw = fs.readFileSync(nf, 'utf8'), njson = JSON.parse(await StorageManager.zipToJson(nraw));
  const ref = loadedSlot ? 'file' + loadedSlot + '.rmmzsave' : files.filter(f => /^file\d+\.rmmzsave$/.test(f))[0];
  if (ref) {
    const rjson = JSON.parse(await StorageManager.zipToJson(raw[ref]));
    const rk = Object.keys(rjson).sort().join(','), nk = Object.keys(njson).sort().join(',');
    check('top-level keys equal alpha (' + ref + ')', rk === nk, nk);
    const tm = k => Object.keys(rjson[k] || {}).sort().join(',') === Object.keys(njson[k] || {}).sort().join(',');
    check('system/party/map/player sub-keys equal', ['system', 'party', 'map', 'player', 'screen', 'timer', 'switches', 'variables'].filter(k => k in rjson).every(k => typeof rjson[k] === typeof njson[k]) && tm('party') && tm('player'));
    const zh = t => [...t.slice(0, 2)].map(c => c.charCodeAt(0).toString(16)).join(' ');   // zlib header bytes of the pako 'to: string' output
    check('same container (zlib header, utf8 text file)', zh(raw[ref]) === zh(nraw) && fs.statSync(nf).size > nraw.length, { alphaHeader: zh(raw[ref]), newHeader: zh(nraw), alphaChars: raw[ref].length, newChars: nraw.length });
    const sz = o => Object.fromEntries(Object.keys(o).map(k => [k, JSON.stringify(o[k]).length]));
    log('SAVETEST json bytes per key alpha ' + JSON.stringify(sz(rjson)) + ' new ' + JSON.stringify(sz(njson)));
  } else log('SAVETEST: no alpha file to compare the format with');
  // load it back
  await DataManager.loadGame(SLOT);
  check('reload of the new slot', $gameParty.gold() === before.gold && JSON.stringify($gameParty.members().map(a => a.actorId())) === JSON.stringify(before.members), { gold: $gameParty.gold() });
  const gi2 = await StorageManager.loadObject('global'); check('global info lists the new slot', !!gi2[SLOT], gi2[SLOT] && gi2[SLOT].title);
  log('SAVETEST done, fails ' + T.fails);
}

// INPUTTEST=1: scripted SDL-equivalent events through handleInput(): walk, dead zone, F2 swallow, menu open/close
async function inputTestStage() {
  const press = (b, ms) => { handleInput({ type: 'buttondown', button: b }); return sleep(ms || 120).then(() => handleInput({ type: 'buttonup', button: b })); };
  DataManager.setupNewGame(); SceneManager.goto(Scene_Map);
  await until(() => SceneManager._scene instanceof Scene_Map && SceneManager._scene.isActive() && $gamePlayer && $gameMap.mapId() > 0, 30000, 'Scene_Map');
  $gameMap.events().forEach(e => e.erase()); $gameMessage.clear(); $gameMap._interpreter.clear(); $gamePlayer.reserveTransfer(11, 10, 10, 2, 0);
  await sleep(500); await until(mapReady(11), 40000, 'map 11');
  if (!$gameMap.isPassable($gamePlayer.x, $gamePlayer.y, 2)) {
    let best = null; for (let y = 0; y < $gameMap.height(); y++) for (let x = 0; x < $gameMap.width(); x++) if ($gameMap.isPassable(x, y, 2) && $gameMap.isPassable(x, y, 6) && $gameMap.isPassable(x + 1, y, 6) && $gameMap.isPassable(x + 2, y, 6) && $gameMap.isPassable(x, y, 4)) { const d = Math.abs(x - $gameMap.width() / 2) + Math.abs(y - $gameMap.height() / 2); if (!best || d < best.d) best = { x, y, d }; }
    if (best) $gamePlayer.locate(best.x, best.y);
  }
  await sleep(2000);
  log('INPUTTEST map ' + $gameMap.mapId() + ' at ' + $gamePlayer.x + ',' + $gamePlayer.y + ' map: ' + JSON.stringify(inputMap));
  // 1. dpad right moves the player
  let x0 = $gamePlayer.x; handleInput({ type: 'buttondown', button: 'dpright' }); await sleep(900); handleInput({ type: 'buttonup', button: 'dpright' }); await sleep(500);
  check('dpad right moves the player right', $gamePlayer.x > x0, { from: x0, to: $gamePlayer.x });
  // 2. stick left moves it back; a small deflection (dead zone) does not
  let x1 = $gamePlayer.x; handleInput({ type: 'axis', axis: 'leftx', value: 6000 }); await sleep(600); handleInput({ type: 'axis', axis: 'leftx', value: 0 }); await sleep(300);
  check('stick inside the dead zone does not move', $gamePlayer.x === x1 && !Input.isPressed('right'), { x: $gamePlayer.x });
  handleInput({ type: 'axis', axis: 'leftx', value: -30000 }); await sleep(250); const heldLeft = Input.isPressed('left'); await sleep(650); handleInput({ type: 'axis', axis: 'leftx', value: 0 }); await sleep(500);
  check('stick left moves the player left', $gamePlayer.x < x1 && heldLeft && !Input.isPressed('left'), { from: x1, to: $gamePlayer.x });
  // 3. dpad + stick share a key: releasing one keeps it down
  handleInput({ type: 'buttondown', button: 'dpup' }); handleInput({ type: 'axis', axis: 'lefty', value: -30000 }); handleInput({ type: 'buttonup', button: 'dpup' }); await sleep(100);
  const upStill = Input.isPressed('up'); handleInput({ type: 'axis', axis: 'lefty', value: 0 }); await sleep(100);
  check('shared key stays down until the last source is released', upStill && !Input.isPressed('up'));
  await sleep(600);
  // 4. Select+Start does not quit in test mode
  handleInput({ type: 'buttondown', button: 'back' }); await sleep(100);
  handleInput({ type: 'buttondown', button: 'start' }); await sleep(100); handleInput({ type: 'buttonup', button: 'start' });
  handleInput({ type: 'buttonup', button: 'back' }); await sleep(100);
  check('Select+Start does not quit in test mode', sceneName() === 'Scene_Map');
  // 5. B (esc) opens the menu, B closes it; Start does too; keyboard Escape works
  const menuCycle = async (open, close, label) => {
    await until(() => SceneManager._scene instanceof Scene_Map && SceneManager._scene.isActive() && !SceneManager.isSceneChanging(), 10000, 'map before ' + label);
    if (label === 'pad B (esc)') { log('DIAG isMenuCalled=' + String(Scene_Map.prototype.isMenuCalled).replace(/\s+/g, ' ').slice(0, 300) + ' | updateCallMenu=' + String(Scene_Map.prototype.updateCallMenu).replace(/\s+/g, ' ').slice(0, 500) + ' | isMenuEnabled=' + String(Scene_Map.prototype.isMenuEnabled).replace(/\s+/g, ' ').slice(0, 200) + ' | canMove=' + String(Game_Player.prototype.canMove).replace(/\s+/g, ' ').slice(0, 300)); }
    const dg = () => ({ esc: Input.isPressed('escape'), trig: Input.isTriggered('menu'), mcalled: SceneManager._scene.isMenuCalled(), canMove: $gamePlayer.canMove(), ev: $gameMap.isEventRunning(), fol: $gamePlayer.areFollowersGathering(), route: $gamePlayer.isMoveRouteForcing(), tr: $gamePlayer.isTransferring() });
    // this game's menu key starts a common event (CommonEventOpen); stock games push Scene_Menu
    await open(); log('DIAG after open ' + JSON.stringify(dg())); const t0 = Date.now(); let ok = false; while (Date.now() - t0 < 6000) { if (SceneManager._scene instanceof Scene_Menu ? SceneManager._scene.isActive() && ImageManager.isReady() : $gameMap.isEventRunning() && SceneManager._scene instanceof Scene_Map) { ok = true; break; } await sleep(100); }
    check(label + ': menu opened', ok, ok ? sceneName() : { scene: sceneName(), msg: $gameMessage.isBusy(), interp: $gameMap._interpreter.isRunning(), menuEnabled: $gameSystem.isMenuEnabled(), menuCalled: SceneManager._scene.isMenuCalled && SceneManager._scene.isMenuCalled(), esc: Input.isPressed('escape'), disabled: SceneManager._scene.isMenuEnabled && SceneManager._scene.isMenuEnabled(), moving: $gamePlayer.isMoving(), canMove: $gamePlayer.canMove() }); if (!ok) return;
    log('MENU kind ' + sceneName() + ' ev=' + $gameMap.isEventRunning() + ' msg=' + $gameMessage.isBusy() + ' choice=' + $gameMessage.isChoice()); await sleep(1200); await close(); const t1 = Date.now(); let back = false; while (Date.now() - t1 < 6000) { if (SceneManager._scene instanceof Scene_Map && SceneManager._scene.isActive() && !SceneManager.isSceneChanging() && !$gameMap.isEventRunning() && !$gameMessage.isBusy()) { back = true; break; } await sleep(100); }
    check(label + ': back on the map', back, sceneName());
    await sleep(400);
  };
  await menuCycle(() => press('b', 150), () => press('b', 150), 'pad B (esc)');
  await menuCycle(() => press('start', 150), () => press('start', 150), 'pad Start (esc)');
  const kb = (sym, ms) => { handleInput({ type: 'keydown', keycode: sym, repeat: 0 }); return sleep(ms || 150).then(() => handleInput({ type: 'keyup', keycode: sym, repeat: 0 })); };
  await menuCycle(() => kb(27, 150), () => kb(27, 150), 'keyboard Escape');
  // stock Scene_Menu (the game's own menu is a common event): opened by code, closed by pad B (cancel)
  SceneManager.push(Scene_Menu); await until(() => SceneManager._scene instanceof Scene_Menu && SceneManager._scene.isActive() && ImageManager.isReady(), 10000, 'Scene_Menu'); await sleep(700);
  await press('b', 150); { const t1 = Date.now(); let back = false; while (Date.now() - t1 < 6000) { if (SceneManager._scene instanceof Scene_Map && SceneManager._scene.isActive() && !SceneManager.isSceneChanging()) { back = true; break; } await sleep(100); } check('stock Scene_Menu closes with pad B', back, sceneName()); }
  await sleep(600);
  x0 = $gamePlayer.x; await kb(0x4000004F, 700); await sleep(500);   // SDLK_RIGHT
  check('keyboard arrow right moves the player', $gamePlayer.x > x0, { from: x0, to: $gamePlayer.x });
  check('no keys left held', [...keySources.values()].every(s => s.size === 0));
  log('INPUTTEST done, fails ' + T.fails + ' stats ' + JSON.stringify(inputStats));
}

// AUDIOTEST=1 (needs PMZ_AUDIO_DUMP for the sample checks): title BGM audible, SE on cursor move, seamless forced loop compared sample by
// sample with the decoded PCM, fade-out, BGM change (fade out + new BGM) without clicks, mixer cost
async function audioTestStage() {
  const R = wa.rate, st0 = () => wa.stats(true);
  const cap = (f, n) => pmz.auCaptureRead(Math.max(0, f), n);
  log('AUDIOTEST device ' + JSON.stringify(wa.info));
  check('audio device open and callbacks running', wa.hasDevice && wa.stats(false).callbacks > 0, wa.stats(false));
  // 1. title BGM
  await until(() => wa.playingCount() > 0, 20000, 'title BGM playing (decoded)');
  st0(); await sleep(2500); let st = wa.stats(false);
  check('title BGM is audible (non-silent RMS at the mixer)', st.rms > 0.005, { rms: +st.rms.toFixed(4), peak: +st.peak.toFixed(3), bgm: AudioManager._currentBgm && AudioManager._currentBgm.name });
  // 2. SE on cursor move
  st0(); AudioManager.stopBgm(); await sleep(300); st0();
  for (let i = 0; i < 3; i++) { SoundManager.playCursor(); await sleep(450); }
  st = wa.stats(false);
  check('SE (cursor) is audible', st.peak > 0.01, { peak: +st.peak.toFixed(3), rms: +st.rms.toFixed(4), active: wa.playingCount() });
  // 3. forced loop through the engine's WebAudio: loop 1.0 s .. 2.3 s of the file
  const name = proc.env.AUDIOTEST_BGM || 'Battle2';
  const buf = AudioManager.createBuffer('bgm/', name);
  await until(() => buf.isReady() && buf._isLoaded, 20000, 'bgm decoded');
  const ab = buf._buffers[0], sr = ab.sampleRate, ch0 = ab.getChannelData(0), ch1 = ab.numberOfChannels > 1 ? ab.getChannelData(1) : ch0;
  buf._loopStartTime = 1.0; buf._loopLengthTime = 1.3; buf.volume = 1;
  await sleep(300);
  const ls = Math.round(1.0 * sr), le = Math.round(2.3 * sr), step = sr / R;
  const capBefore = wa.stats(false).capFrames;
  buf.play(true, 0);
  const startF = Math.round(buf._startTime * R), master = WebAudio._masterVolume;
  log('AUDIOTEST loop: file ' + name + ' sr ' + sr + ' out rate ' + R + ' start frame ' + startF + ' master ' + master + ' loopStartTime ' + buf._loopStartTime + ' len ' + buf._loopLengthTime);
  await sleep(5500);
  const N = Math.round(5.0 * R), out = cap(startF, N);
  const expected = (i0 => { const e = new Float32Array(N * 2); let pos = 0; const get = (c, i) => (c ? ch1 : ch0)[i];
    for (let i = 0; i < N; i++) { if (pos >= le) { const ll = le - ls; pos -= ll * Math.floor((pos - ls) / ll); } const ip = Math.floor(pos), fr = pos - ip; let i1 = ip + 1; if (i1 >= le) i1 = ls + (i1 - le);
      for (let c = 0; c < 2; c++) e[2 * i + c] = fr === 0 ? get(c, ip) : get(c, ip) + (get(c, i1) - get(c, ip)) * fr; pos += step; }
    return e; })();
  let num = 0, den = 0; for (let i = 0; i < out.length; i++) { num += out[i] * expected[i]; den += expected[i] * expected[i]; }
  const scale = num / den; let maxErr = 0, zr = 0, maxZr = 0; for (let i = 0; i < N; i++) { for (let c = 0; c < 2; c++) maxErr = Math.max(maxErr, Math.abs(out[2 * i + c] - scale * expected[2 * i + c])); if (out[2 * i] === 0 && out[2 * i + 1] === 0) { if (++zr > maxZr) maxZr = zr; } else zr = 0; }
  const loops = Math.floor((N - 0) / ((le - ls) / step));
  check('forced loop is sample exact over ' + loops + ' loop points (fit scale ' + scale.toFixed(4) + ' = BGM vol x master)', maxErr < 1e-5 && Math.abs(scale - master) < 0.02, { maxErr, scale, master });
  check('no run of zero samples at the loop points', maxZr < 32, { maxZr });
  // 4. fade out (engine fadeOut: setValueAtTime + linearRamp), exact envelope check
  const ct = WebAudio._currentTime(), i0 = Math.round(ct * R), fd = 1.5;
  buf.fadeOut(fd); await sleep(2000);
  const NF = Math.round(fd * R) + 2000, outF = cap(i0, NF);
  // expected continues the same loop: position at frame i0 is (i0 - startF)
  let maxDev = 0, maxJump = 0, srcJump = 0;
  { let pos = (i0 - startF) * step; const ll = le - ls; if (pos >= le) pos -= ll * Math.floor((pos - ls) / ll);
    let prev = 0, prevE = 0;
    for (let i = 0; i < NF; i++) { if (pos >= le) pos -= ll * Math.floor((pos - ls) / ll); const ip = Math.floor(pos), fr = pos - ip; let i1 = ip + 1; if (i1 >= le) i1 = ls + (i1 - le);
      const e = (ch0[ip] + (ch0[i1] - ch0[ip]) * fr) * scale * Math.max(0, 1 - i / (fd * R)); maxDev = Math.max(maxDev, Math.abs(outF[2 * i] - e));
      if (i) { maxJump = Math.max(maxJump, Math.abs(outF[2 * i] - prev)); srcJump = Math.max(srcJump, Math.abs(e - prevE)); } prev = outF[2 * i]; prevE = e; pos += step; } }
  const tail = outF.subarray(2 * Math.round(fd * R) + 200); let tailMax = 0; for (const v of tail) tailMax = Math.max(tailMax, Math.abs(v));
  check('fade-out follows the exact linear ramp (no clicks), silent afterwards', maxDev < 1e-4 && tailMax < 1e-6, { maxDev, maxJump: +maxJump.toFixed(4), expectedMaxJump: +srcJump.toFixed(4), tailMax });
  buf.stop();
  // 5. BGM change like a map transfer: fadeOutBgm(1) then playBgm of another file
  AudioManager.playBgm({ name, volume: 90, pitch: 100, pan: 0 }); await sleep(2500);
  const c5 = WebAudio._currentTime(); AudioManager.fadeOutBgm(1); await sleep(300);
  AudioManager.playBgm({ name: proc.env.AUDIOTEST_BGM2 || 'Dungeon6', volume: 90, pitch: 100, pan: 0 }); await sleep(3500);
  const w5 = cap(Math.round(c5 * R), Math.round(4.0 * R)); let pk = 0, mj = 0; for (let i = 0; i < w5.length; i++) { pk = Math.max(pk, Math.abs(w5[i])); if (i > 1) mj = Math.max(mj, Math.abs(w5[i] - w5[i - 2])); }
  check('BGM change (fade out + new BGM): audible, no step larger than 0.5 of peak', pk > 0.05 && mj < 0.5 * pk + 0.05, { peak: +pk.toFixed(3), maxSampleJump: +mj.toFixed(3), now: AudioManager._currentBgm && AudioManager._currentBgm.name });
  AudioManager.stopAll();
  const sf = wa.stats(false);
  log('AUDIOTEST mixer ' + JSON.stringify({ callbacks: sf.callbacks, avgUs: +sf.avgUs.toFixed(0), maxUs: +sf.maxUs.toFixed(0), blockUs: +sf.blockUs.toFixed(0), over50pct: sf.over50pct, buffers: sf.buffers, bufferMB: +(sf.bufferBytes / 1048576).toFixed(1) }));
  log('AUDIOTEST done, fails ' + T.fails);
}

function finish(code) {
  if (finish.done) return; finish.done = true;
  try { if (globalThis.localStorage && globalThis.localStorage.flush) globalThis.localStorage.flush(); } catch (_) {}
  try { if (globalThis.Worker && globalThis.Worker.terminateAll) globalThis.Worker.terminateAll(); } catch (_) {}
  if (PLAY) { console.log('play mode ended, code ' + code + ', input ' + JSON.stringify(inputStats) + ', otherErrors ' + otherErrors.length + (otherErrors.length ? '\n  ' + otherErrors.slice(0, 5).map(x => String(x).split('\n').slice(0, 2).join(' | ').slice(0, 300)).join('\n  ') : '')); try { pmz.shutdown(); } catch (e) {} proc.exit(code); }
  const f = (v, d) => (typeof v === 'number' ? v.toFixed(d === undefined ? 1 : d) : String(v));
  let out = 'pmzrun result (MB unless noted) - plain Node ' + proc.version + ', real PIXI ' + (typeof PIXI !== 'undefined' ? PIXI.VERSION : '?') + ' on pmzrt WebGL1 (' + (glInfo && glInfo.glRenderer) + ', ' + (glInfo && glInfo.glVersion) + ')\n';
  out += 'exit code ' + code + (code ? ' (scene=' + (typeof SceneManager !== 'undefined' && SceneManager._scene && SceneManager._scene.constructor.name) + ')' : '') + '\n';
  out += 'timings (s since process start): ' + JSON.stringify(Object.assign({}, timings, { windowInitMs: undefined, titleStats: undefined, rssRawAtTitle: undefined }), (k, v) => typeof v === 'number' ? +v.toFixed(2) : v) + '; window init ' + f(timings.windowInitMs, 0) + ' ms\n';
  out += 'title frame stats: ' + JSON.stringify(timings.titleStats) + '\n';
  const rr = timings.rssRawAtTitle, m = results.title;
  if (rr) out += 'RSS at title before gc: VmRSS ' + f(rr.VmRSS) + ' RssAnon ' + f(rr.RssAnon) + ' RssFile ' + f(rr.RssFile) + ' VmSwap ' + f(rr.VmSwap) + ' Pss_Anon ' + f(rr.Pss_Anon) + '\n';
  if (m) out += 'RSS at title after gc:  VmRSS ' + f(m.VmRSS) + ' RssAnon ' + f(m.RssAnon) + ' RssFile ' + f(m.RssFile) + ' heapUsed ' + f(m.heapUsed) + ' external ' + f(m.external) + ' arrayBuffers ' + f(m.arrayBuffers) + ' decoded images live ' + f(m.imageMB) + ' (' + m.imageN + ') canvases ' + f(m.canvasMB) + ' (' + m.canvasN + ')\n';
  out += 'options frame stats: ' + JSON.stringify(timings.optionsStats) + '\n';
  out += 'map open ms ' + timings.mapOpenMs + ' info ' + JSON.stringify(timings.mapInfoOpen) + ' -> ' + JSON.stringify(timings.mapInfo) + '\n' + 'map frame stats: ' + JSON.stringify(timings.mapStats) + '\n';
  const mm = results.map; if (mm) out += 'RSS at map after gc: VmRSS ' + f(mm.VmRSS) + ' RssAnon ' + f(mm.RssAnon) + ' RssFile ' + f(mm.RssFile) + ' heapUsed ' + f(mm.heapUsed) + ' canvases ' + f(mm.canvasMB) + ' (' + mm.canvasN + ') images ' + f(mm.imageMB) + '\n';
  out += 'map after advance: ' + JSON.stringify(timings.mapAdv) + '\n' + 'map play frame stats: ' + JSON.stringify(timings.mapPlayStats) + '\n';
  const m2 = results.map2; if (m2) out += 'RSS at map2 after gc: VmRSS ' + f(m2.VmRSS) + ' RssAnon ' + f(m2.RssAnon) + ' canvases ' + f(m2.canvasMB) + ' (' + m2.canvasN + ')\n';
  out += 'teleport: ' + JSON.stringify(timings.teleport) + '\nwalk: ' + JSON.stringify(timings.walk) + ' ' + JSON.stringify(timings.walkStats) + '\n';
  out += 'bench: ' + JSON.stringify(timings.bench) + '\n';
  if (wa) out += 'audio: ' + JSON.stringify(wa.info) + ' stats ' + JSON.stringify(wa.stats(false)) + '\n';
  const mo = results.options; if (mo) out += 'RSS at options after gc: VmRSS ' + f(mo.VmRSS) + ' RssAnon ' + f(mo.RssAnon) + ' RssFile ' + f(mo.RssFile) + ' canvases live ' + f(mo.canvasMB) + ' (' + mo.canvasN + ')\n';
  out += 'screenshots: ' + JSON.stringify(shotInfos) + '\n';
  if (Object.keys(prof).length) out += 'native profile (n, ms): ' + Object.entries(prof).filter(e => e[1].n).sort((a, b) => b[1].ms - a[1].ms).slice(0, 14).map(e => e[0] + ' ' + e[1].n + '/' + e[1].ms.toFixed(0)).join(', ') + '\n';
  out += 'GL stubs/unsupported hit (' + (mainGL ? mainGL.stubs.size : 0) + '): ' + (mainGL ? [...mainGL.stubs].join('; ') : '') + '\n';
  out += 'GL errors (debug=' + GLDEBUG + (glDebugStats ? ', ' + glDebugStats.calls + ' calls checked' : '') + ', ' + glMessages.length + '):\n' + glMessages.map(x => '  ' + x.slice(0, 300)).join('\n') + '\n';
  out += 'compat (' + Object.keys(compatSeen).length + '): ' + Object.keys(compatSeen).join(' | ') + '\n';
  out += 'warnings (' + warnings.length + '): ' + warnings.map(x => x.slice(0, 200)).join(' | ') + '\n';
  out += 'failed plugins (' + failedPlugins.length + '):\n' + failedPlugins.map(x => '  ' + x).join('\n') + '\n';
  out += 'other errors (' + otherErrors.length + ', first 15):\n' + otherErrors.slice(0, 15).map(x => '  ' + String(x).split('\n').slice(0, 3).join(' | ').slice(0, 300)).join('\n') + '\n';
  const muEnd = proc.memoryUsage();
  const csStats = (typeof c2d !== 'undefined' && c2d.getImageSurfaceStats) ? c2d.getImageSurfaceStats() : { bytes: 0 };
  const tracePayload = {
    seed: AT_SEED || null,
    engine: MV ? 'MV' : 'MZ',
    plugins: loadedPlugins,
    failed: failedPlugins,
    titleScene: results.title && results.title.scene || null,
    optionsScene: results.options && results.options.scene || null,
    mapOpen: timings.mapInfoOpen || null,
    mapEnd: timings.mapInfo || null,
  };
  const traceHash = crypto.createHash('sha256').update(JSON.stringify(tracePayload)).digest('hex').slice(0, 16);
  const ciSummary = {
    exitCode: code,
    seed: AT_SEED || null,
    engine: MV ? 'MV' : 'MZ',
    glRenderer: glInfo ? glInfo.glRenderer : null,
    plugins: loadedPlugins.length,
    failed: failedPlugins.length,
    glStubs: mainGL ? mainGL.stubs.size : 0,
    rtStubs: runtimeStubs.size,
    glErrors: glMessages.length,
    otherErrors: otherErrors.length,
    externalMB: +(muEnd.external / 1048576).toFixed(2),
    glMemMB: mainGL ? +(mainGL._glMemBytes / 1048576).toFixed(2) : 0,
    csCacheMB: +(csStats.bytes / 1048576).toFixed(2),
    mapId: timings.mapInfo ? timings.mapInfo.mapId : null,
    scene: (typeof SceneManager !== 'undefined' && SceneManager._scene && SceneManager._scene.constructor) ? SceneManager._scene.constructor.name : null,
    traceHash,
  };
  out += 'CI_SUMMARY ' + JSON.stringify(ciSummary) + '\n';
  console.log('\n' + out);
  try { fs.writeFileSync(OUT, out); } catch (e) { console.log('cannot write ' + OUT + ': ' + e.message); }
  try { pmz.shutdown(); } catch (e) {}
  proc.exit(code);
}
const MAXSEC = parseFloat(proc.env.MAXSEC) || 55;
if (!PLAY) setTimeout(() => { log('WATCHDOG: no result within ' + MAXSEC + ' s'); finish(9); }, MAXSEC * 1000);
