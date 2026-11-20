#!/bin/sh
# Dev: same measurements for any game, to find costs shared by many games. Loads the newest
# save (or a new game when there is none) with save writes blocked (save folder backed up
# before, restored and compared after), then on the map and in an auto battle measures:
# GPU fragment busy + draws/s, renderer CPU split (pocketmz-renderprof.js) and update split
# (pocketmz-sceneprof.js, top lines). Usage: pocketmz-survey.sh "<Ports .sh>" [troop id]
PORT="$1"; TROOP="${2:-0}"
RZ=/storage/pocketmz; T=$RZ/pocketmz-test.sh
ID=$(sed -n 's/^# pocketmz: //p; s/^id=//p' "$PORT" | head -1)
export POCKETMZ_TEST_PORT="$PORT" XDG_RUNTIME_DIR=/var/run/0-runtime-dir WAYLAND_DISPLAY=wayland-1
js() { T="${2:-30}" $T js "$1" | tr -d '\n'; }
jsl() { T="${2:-40}" $T js "$1" | python3 -c 'import sys,json; print(json.loads(sys.stdin.read()))'; }
scene() { js 'SceneManager._scene?SceneManager._scene.constructor.name:""' 5 | tr -d '" '; }
PROFF=/sys/bus/platform/drivers/panfrost/fde60000.gpu/profiling
pidof nw >/dev/null && { echo "a game is running - stop it first"; exit 1; }
G=$RZ/games/$ID/game; SAVE=$G/save; [ -d $G/www ] && SAVE=$G/www/save
B=$RZ/games/$ID/save-survey-$(date +%Y%m%d-%H%M%S); mkdir -p "$SAVE" "$B"; cp -a "$SAVE/." "$B/"
restore() { echo 0 > $PROFF 2>/dev/null; $T stop >/dev/null 2>&1; rm -rf "$SAVE"/*; cp -a "$B/." "$SAVE/"
  diff -r "$B" "$SAVE" >/dev/null && { rm -rf "$B"; echo "saves restored"; } || echo "SAVES DIFFER - backup kept in $B"; }
trap restore EXIT
touch $RZ/dev
( $T start >/dev/null 2>&1 & ); sleep 3
for i in $(seq 1 900); do grep -qE "nw start" $RZ/games/$ID/run.log 2>/dev/null && break; sleep 1; done
for i in $(seq 1 180); do case "$(scene)" in *Title*) break;; esac; sleep 1; done
case "$(scene)" in *Title*) ;; *) false;; esac || { echo "no title"; exit 1; }
js 'StorageManager.saveObject = () => Promise.resolve(); if (StorageManager.saveToLocalFile) StorageManager.saveToLocalFile = () => {}; DataManager.saveGame = () => Promise.resolve(true); ConfigManager.save = () => {}; 1' >/dev/null
echo "== $ID $(js 'Utils.RPGMAKER_NAME+" "+Utils.RPGMAKER_VERSION+" "+Graphics.width+"x"+Graphics.height+" plugins "+$plugins.filter(p=>p.status).length+" res "+(Graphics.app?Graphics.app.renderer.resolution:"-")')"
echo "start: $(js 'const id = DataManager.latestSavefileId(); if (id >= 0 && DataManager.savefileExists(id)) { DataManager.loadGame(id).then(() => { $gameSystem.onAfterLoad(); SceneManager.goto(Scene_Map); }); "save " + id } else { DataManager.setupNewGame(); SceneManager.goto(Scene_Map); "new game" }')"
for i in $(seq 1 60); do [ "$(scene)" = Scene_Map ] && break; sleep 1; done; sleep 8
NW=$(pidof nw | tr ' ' '\n' | while read p; do grep -q "type=" /proc/$p/cmdline 2>/dev/null || echo $p; done | head -1)
FD=$(for fd in $(ls /proc/$NW/fd 2>/dev/null); do readlink /proc/$NW/fd/$fd 2>/dev/null | grep -q renderD && echo "$(awk '/drm-resident-memory/{print $2}' /proc/$NW/fdinfo/$fd 2>/dev/null) $fd"; done | sort -rn | head -1 | cut -d' ' -f2)
echo 1 > $PROFF
gpu() { a=$(awk '/drm-engine-fragment/{print $2}' /proc/$NW/fdinfo/$FD); sleep 4; b=$(awk '/drm-engine-fragment/{print $2}' /proc/$NW/fdinfo/$FD); awk "BEGIN{printf \"gpu busy %d%%\", ($b-$a)/4e7}"; }
measure() {
  echo "-- $1: $(gpu) | $(js "$(cat $RZ/pocketmz-rafprobe.js)" 30)"
  jsl "$(cat $RZ/pocketmz-renderprof.js)"
  jsl "$(cat $RZ/pocketmz-sceneprof.js)" | head -14
}
measure "map $(js '$gameMap.mapId()')"
js 'Game_Actor.prototype.isAutoBattle = () => true; Window_Message.prototype.isTriggered = () => true;
  const gh = Game_Battler.prototype.gainHp; Game_Battler.prototype.gainHp = function(v) { if (v < 0) v = -Math.min(-v, this.hp - 1); gh.call(this, v); }; 1' >/dev/null
echo "battle: $(js 'const enc = $gameMap.encounterList().map(e => e.troopId).filter(t => $dataTroops[t] && $dataTroops[t].members.length);
  const t = '"$TROOP"' > 0 ? '"$TROOP"' : (enc[0] || $dataTroops.findIndex((x, i) => i > 1 && x && x.members.length));
  BattleManager.setup(t, true, false); SceneManager.push(Scene_Battle); "troop " + t')"
for i in $(seq 1 30); do [ "$(scene)" = Scene_Battle ] && break; sleep 1; done; sleep 5
[ "$(scene)" = Scene_Battle ] && measure "battle" || echo "battle did not start ($(scene))"
echo "errors: $(js 'JSON.stringify((window.PMZ_DEBUG && PMZ_DEBUG.errors || []).slice(-5))')"
