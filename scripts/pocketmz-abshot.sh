#!/bin/sh
# Dev: A/B of a runtime switch on the same screen. Loads the newest save (save writes blocked,
# save folder backed up/restored), opens a scene (Scene_Menu by default, or "battle"), then
# with the switch on and off: render CPU (pocketmz-renderprof.js) and a full-size screenshot
# /tmp/ab_<id>_<scene>_{on,off}.png for a pixel compare.
# Usage: pocketmz-abshot.sh "<Ports .sh>" <js that turns the change OFF> <js that turns it ON> [Scene_Menu|battle]
PORT="$1"; OFF="$2"; ON="$3"; WHAT="${4:-Scene_Menu}"
RZ=/storage/pocketmz; T=$RZ/pocketmz-test.sh
ID=$(sed -n 's/^# pocketmz: //p; s/^id=//p' "$PORT" | head -1)
export POCKETMZ_TEST_PORT="$PORT" XDG_RUNTIME_DIR=/var/run/0-runtime-dir WAYLAND_DISPLAY=wayland-1
js() { T="${2:-30}" $T js "$1" | tr -d '\n'; }
jsl() { T="${2:-40}" $T js "$1" | python3 -c 'import sys,json; print(json.loads(sys.stdin.read()))'; }
scene() { js 'SceneManager._scene?SceneManager._scene.constructor.name:""' 5 | tr -d '" '; }
pidof nw >/dev/null && { echo "a game is running - stop it first"; exit 1; }
G=$RZ/games/$ID/game; SAVE=$G/save; [ -d $G/www ] && SAVE=$G/www/save
B=$RZ/games/$ID/save-ab-$(date +%Y%m%d-%H%M%S); mkdir -p "$SAVE" "$B"; cp -a "$SAVE/." "$B/"
restore() { $T stop >/dev/null 2>&1; rm -rf "$SAVE"/*; cp -a "$B/." "$SAVE/"
  diff -r "$B" "$SAVE" >/dev/null && { rm -rf "$B"; echo "saves restored"; } || echo "SAVES DIFFER - backup kept in $B"; }
trap restore EXIT
touch $RZ/dev
( $T start >/dev/null 2>&1 & ); sleep 3
for i in $(seq 1 900); do grep -qE "nw start" $RZ/games/$ID/run.log 2>/dev/null && break; sleep 1; done
for i in $(seq 1 180); do case "$(scene)" in *Title*) break;; esac; sleep 1; done
js 'StorageManager.saveObject = () => Promise.resolve(); DataManager.saveGame = () => Promise.resolve(true); ConfigManager.save = () => {}; 1' >/dev/null
js 'const id = DataManager.latestSavefileId(); if (id >= 0 && DataManager.savefileExists(id)) { DataManager.loadGame(id).then(() => { $gameSystem.onAfterLoad(); SceneManager.goto(Scene_Map); }); } else { DataManager.setupNewGame(); SceneManager.goto(Scene_Map); } 1' >/dev/null
for i in $(seq 1 60); do [ "$(scene)" = Scene_Map ] && break; sleep 1; done; sleep 6
if [ "$WHAT" = battle ]; then
  js 'Game_Actor.prototype.isAutoBattle = () => false; const t = $dataTroops.findIndex((x, i) => i > 1 && x && x.members.length); BattleManager.setup(t, true, false); SceneManager.push(Scene_Battle); 1' >/dev/null
  for i in $(seq 1 30); do [ "$(scene)" = Scene_Battle ] && break; sleep 1; done; sleep 8   # waits at the start message / command input
else
  js "SceneManager.push($WHAT); 1" >/dev/null; for i in $(seq 1 30); do [ "$(scene)" = "$WHAT" ] && break; sleep 1; done; sleep 4
fi
S=$(scene); echo "== $ID scene $S"
for m in on off; do
  [ $m = off ] && js "$OFF; 1" >/dev/null || js "$ON; 1" >/dev/null
  sleep 1; grim "/tmp/ab_${ID}_${S}_$m.png" 2>/dev/null
  if [ -n "$ABSHOT_LINES" ]; then echo "[$m]"; jsl "$(cat ${ABSHOT_PROBE:-$RZ/pocketmz-renderprof.js})" | head -$ABSHOT_LINES
  else echo "[$m] $(jsl "$(cat ${ABSHOT_PROBE:-$RZ/pocketmz-renderprof.js})" | head -4 | tr '\n' ' ')"; fi
done
js "$ON; 1" >/dev/null
echo "errors: $(js 'JSON.stringify((window.PMZ_DEBUG && PMZ_DEBUG.errors || []).slice(-5))')"
echo "state: $(js 'SceneManager._scene.constructor.name + " stopped=" + !!SceneManager._stopped + " busy=" + SceneManager.isSceneChanging() + " fade=" + (SceneManager._scene._fadeDuration||0) + " map=" + $gameMap.mapId() + " troop=" + ($gameTroop._troopId||0)')"
