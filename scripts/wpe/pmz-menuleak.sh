#!/bin/sh
# Memory per menu open: open/close Scene_Menu <n> times, print memory every 3 opens.
# Usage: pmz-menuleak.sh <launcher .rpgmz> <on|off> [n=15]  (on = window contents at display scale)
L="$1"; MODE="$2"; N="${3:-15}"; TS=/storage/pocketmz/pocketmz-test.sh
export POCKETMZ_TEST_PORT="$L" POCKETMZ_TEST_VIA_ES=0
for s in /var/run/emulationstation/scripts/screensaver-stop/*; do [ -x "$s" ] && "$s"; done 2>/dev/null
$TS start >/dev/null || exit 1
js() { $TS js "$1"; }
[ "$MODE" = off ] && js 'window.PMZ_WIN_OFF = true' >/dev/null
js 'DataManager.setupNewGame(); SceneManager.goto(Scene_Map); "ok"' >/dev/null
for i in $(seq 1 30); do sleep 1; [ "$(js 'SceneManager._scene && SceneManager._scene.constructor.name + ((SceneManager._scene.isStarted ? SceneManager._scene.isStarted() : SceneManager._sceneStarted) ? 1 : 0)')" = '"Scene_Map1"' ] && break; done
sleep 3
curl -s -m 30 --data-binary @/storage/pocketmz/pocketmz-autotest.js 127.0.0.1:9333 >/dev/null   # canvas / img counters
T='(async (cls) => { const st = () => SceneManager._scene.isStarted ? SceneManager._scene.isStarted() : SceneManager._sceneStarted; const t = performance.now(); SceneManager.push(window[cls]);
  while (!(SceneManager._scene instanceof window[cls] && st())) await new Promise(r => setTimeout(r, 10));
  const ms = Math.round(performance.now() - t); await new Promise(r => setTimeout(r, 300));
  SceneManager.pop(); while (!(SceneManager._scene instanceof Scene_Map && st())) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 500)); return ms; })'
CNT='(() => { let n = 0, px = 0; const seen = new Set(); const walk = (o) => { if (!o || seen.has(o)) return; seen.add(o);
  for (const b of [o.bitmap, o.contents, o.contentsBack]) if (b && b._canvas) { n++; px += b._canvas.width * b._canvas.height; }
  (o.children || []).forEach(walk); }; walk(SceneManager._scene); return n + " stage canvases " + Math.round(px / 1e6) + " Mpx"; })()'
echo "mode=$MODE start: $($TS mem | cut -c1-150)"
for i in $(seq 1 "$N"); do
  ms=$(js "$T('Scene_Menu')")
  [ $((i % 3)) = 0 ] && echo "open $i ${ms}ms: $($TS mem | cut -c1-150) | $(js "$CNT")"
  [ $((i % 10)) = 0 ] && js 'PMZ_AT.canvases()' | tr '^' '
' | head -8
  pidof nw >/dev/null || { echo "game ended"; break; }
done
echo "stats: $(js 'JSON.stringify({n: PMZ_IMG.winCount, savedMpx: Math.round((PMZ_IMG.winSaved||0)/1e6), unscaled: PMZ_IMG.winUnscaled||0, snapBg: !!SceneManager._backgroundBitmap})')"
$TS stop >/dev/null 2>&1
echo LEAKDONE
