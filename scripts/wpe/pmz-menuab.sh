#!/bin/sh
# A/B: open menu scenes with window contents at display scale (on) and full size (off) in one
# running game. Usage: pmz-menuab.sh <launcher .rpgmz> [rounds=3]
L="$1"; N="${2:-3}"; TS=/storage/pocketmz/pocketmz-test.sh
export POCKETMZ_TEST_PORT="$L" POCKETMZ_TEST_VIA_ES=0
for s in /var/run/emulationstation/scripts/screensaver-stop/*; do [ -x "$s" ] && "$s"; done 2>/dev/null
$TS start || exit 1
js() { $TS js "$1"; }
# new game -> map
js 'DataManager.setupNewGame(); SceneManager.goto(Scene_Map); "ok"' >/dev/null
for i in $(seq 1 30); do sleep 1; [ "$(js 'SceneManager._scene && SceneManager._scene.constructor.name + ((SceneManager._scene.isStarted ? SceneManager._scene.isStarted() : SceneManager._sceneStarted) ? 1 : 0)')" = '"Scene_Map1"' ] && break; done
sleep 3
# time one scene: push it, wait until started, return ms; then back to the map
T='(async (cls) => { const st = () => SceneManager._scene.isStarted ? SceneManager._scene.isStarted() : SceneManager._sceneStarted; const t = performance.now(); SceneManager.push(window[cls]);
  while (!(SceneManager._scene instanceof window[cls] && st())) await new Promise(r => setTimeout(r, 10));
  const ms = Math.round(performance.now() - t); await new Promise(r => setTimeout(r, 300));
  SceneManager.pop(); while (!(SceneManager._scene instanceof Scene_Map && st())) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 500)); return ms; })'
echo "warm-up Scene_Menu: $(js "$T('Scene_Menu')")"
for r in $(seq 1 "$N"); do
  for mode in on off; do
    [ $mode = on ] && js 'window.PMZ_WIN_OFF = false' >/dev/null || js 'window.PMZ_WIN_OFF = true' >/dev/null
    line="round $r $mode:"
    for sc in Scene_Menu Scene_Item Scene_Skill Scene_Equip Scene_Status; do
      line="$line $sc=$(js "$T('$sc')")"
    done
    echo "$line"
  done
done
js 'window.PMZ_WIN_OFF = false; SceneManager.push(Scene_Menu); "ok"' >/dev/null; sleep 4
$TS shot pmz-menu-on >/dev/null 2>&1
js 'SceneManager.pop(); window.PMZ_WIN_OFF = true; "ok"' >/dev/null; sleep 3
js 'SceneManager.push(Scene_Menu); "ok"' >/dev/null; sleep 4
$TS shot pmz-menu-off >/dev/null 2>&1
echo "stats: $(js 'JSON.stringify({n: PMZ_IMG.winCount, savedMpx: Math.round((PMZ_IMG.winSaved||0)/1e6), unscaled: PMZ_IMG.winUnscaled||0})')"
$TS stop >/dev/null 2>&1
echo MENUABDONE
