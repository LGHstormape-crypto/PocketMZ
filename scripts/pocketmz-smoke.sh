#!/bin/sh
# Dev: first check of a newly added MV/MZ game, started from its Ports entry like the user does.
# Title time, errors / missing files, a new game for <secs> with save writes blocked (the game's
# save folder is backed up before and restored after), speed and memory, screenshots.
# Usage: pocketmz-smoke.sh "/storage/roms/ports/<game>.sh" [secs]
# Result: stdout + /tmp/smoke_<id>_{title,map1,map2}.png
PORT="$1"; SECS="${2:-60}"
RZ=/storage/pocketmz; T=$RZ/pocketmz-test.sh
[ -f "$PORT" ] || { echo "no $PORT" >&2; exit 1; }
ID=$(sed -n 's/^# pocketmz: //p; s/^id=//p' "$PORT" | head -1)
[ -n "$ID" ] || ID=$($RZ/pocketmz-scan.sh --id "$(sed -n 's/^exec .*pocketmz-run.sh "\([^"]*\)".*/\1/p' "$PORT")")
export POCKETMZ_TEST_PORT="$PORT"
export XDG_RUNTIME_DIR=/var/run/0-runtime-dir WAYLAND_DISPLAY=wayland-1
js() { T="${2:-30}" $T js "$1" | tr -d '\n'; }
scene() { js 'SceneManager._scene?SceneManager._scene.constructor.name:""' 5 | tr -d '" '; }
shot() { grim -s 0.5 "/tmp/smoke_${ID}_$1.png" 2>/dev/null; }
up() { cut -d' ' -f1 /proc/uptime; }

echo "== $ID  ($PORT)"
pidof nw >/dev/null && { echo "a game is running - stop it first"; exit 1; }
touch $RZ/dev
t0=$(up)
( $T start >/dev/null 2>&1 & )          # builds the copy on first run; we do our own waiting
# first run: copy + one-time font subset can take minutes; wait for it, then time the start
L=$RZ/games/$ID/run.log; sleep 3
for i in $(seq 1 900); do grep -qE "thin copy ready|nw start" "$L" 2>/dev/null && break; sleep 1; done
t1=$(up); [ "$(awk "BEGIN{print int($t1-$t0)}")" -gt 10 ] && echo "copy build: $(awk "BEGIN{print int($t1-$t0)}")s" && t0=$t1
for i in $(seq 1 150); do
  s=$(scene); [ -n "$s" ] && [ "$s" != Scene_Boot ] && [ "$s" != null ] && break; sleep 1
done
echo "first scene: ${s:-none} after $(awk "BEGIN{print int($(up)-$t0)}")s"
# splash/logo scenes first: wait up to 60 s more for a title scene (Scene_Title, Scene_TitleMap, ...)
case "$s" in *Title*) ;; *) for i in $(seq 1 60); do s=$(scene); case "$s" in *Title*) break;; esac; sleep 1; done
  echo "title scene: $s after $(awk "BEGIN{print int($(up)-$t0)}")s";; esac
[ -z "$s" ] && { echo "game did not start:"; tail -20 $RZ/games/$ID/run.log; exit 1; }
sleep 3; shot title
G=$RZ/games/$ID/game; SAVE=$G/save; [ -d $G/www ] && SAVE=$G/www/save
echo "engine: $(js 'Utils.RPGMAKER_NAME+" "+Utils.RPGMAKER_VERSION') screen: $(js '[Graphics.width,Graphics.height].join("x")') plugins: $(js '$plugins.filter(p=>p.status).length')"
# someone picked up the game on the handheld (left the title): leave it running, untouched
# someone picked up the handheld (a key was pressed since the game started): leave it untouched
[ "$(js 'Input.date ? "pressed" : "none"' 5 | tr -d '"')" = none ] || { echo "keys were pressed (someone is playing?) - smoke stopped, game left running"; exit 1; }
# saves: back up, block writes, restore at exit
B=$RZ/games/$ID/save-smoke-$(date +%Y%m%d-%H%M%S); mkdir -p "$SAVE" "$B"; cp -a "$SAVE/." "$B/"
restore() { $T stop >/dev/null 2>&1; rm -rf "$SAVE"/*; cp -a "$B/." "$SAVE/"
  diff -r "$B" "$SAVE" >/dev/null && { rm -rf "$B"; echo "saves restored"; } || echo "SAVES DIFFER - backup kept in $B"; }
trap restore EXIT
js 'StorageManager.saveObject = () => Promise.resolve(); if (StorageManager.saveToLocalFile) StorageManager.saveToLocalFile = () => {}; if (StorageManager.saveToWebStorage) StorageManager.saveToWebStorage = () => {}; DataManager.saveGame = () => Promise.resolve(true); DataManager.saveGameWithoutRescue && (DataManager.saveGameWithoutRescue = () => true); "saves blocked"'; echo
js 'DataManager.setupNewGame(); SceneManager.goto(Scene_Map); 1' >/dev/null
for i in $(seq 1 60); do [ "$(scene)" = Scene_Map ] && break; sleep 1; done
echo "new game: $(scene) map $(js '$gameMap.mapId()')"
# SMOKE_FPS=60: switch the PocketMZ frame-rate option to 60 for this run (not saved: saves are blocked)
[ "$SMOKE_FPS" = 60 ] && echo "fps option: $(js 'ConfigManager.gkdFrameRate = 60')"
# GPU: average devfreq clock over each sample (simple_ondemand follows GPU load)
GPUF=$(ls -d /sys/class/devfreq/*gpu* 2>/dev/null | head -1)
gpu_snap() { [ -n "$GPUF" ] && sed 's/^\*/ /' "$GPUF/trans_stat" | awk '$1 ~ /^[0-9]+:$/ {sub(/:/,"",$1); print $1, $NF}'; }
gpu_avg() { printf '%s\n%s\n' "$1" "$2" | awk 'NR==FNR{} {if (seen[$1]=="") seen[$1]=$2; else {d=$2-seen[$1]; s+=d*$1; t+=d}} END{if (t>0) printf "gpu=%dMHz", s/t/1e6}'; }
PROF='new Promise(res=>{const R=(window.Graphics&&Graphics.app&&Graphics.app.renderer)||Graphics._renderer;let u=0,r=0,f=0,t=0,gap=0,last=performance.now();const oR=R.render,oU=SceneManager.updateMain;R.render=function(){const a=performance.now();oR.apply(this,arguments);r+=performance.now()-a;f++;};SceneManager.updateMain=function(){const a=performance.now();gap=Math.max(gap,a-last);last=a;oU.apply(this,arguments);u+=performance.now()-a;t++;};setTimeout(()=>{R.render=oR;SceneManager.updateMain=oU;res("logic="+(t/10).toFixed(0)+"/s draw="+(f/10).toFixed(0)+"/s upd="+(u/Math.max(t,1)).toFixed(1)+"ms render="+(r/Math.max(f,1)).toFixed(1)+"ms worstGap="+Math.round(gap)+"ms");},10000)})'
sleep 5; shot map1
end=$(( $(date +%s) + SECS ))
while [ "$(date +%s)" -lt "$end" ]; do
  g0=$(gpu_snap); p=$(T=20 $T js "$PROF" | tr -d '"\n'); g1=$(gpu_snap)
  echo "  $p $(gpu_avg "$g0" "$g1") | $($T mem | cut -d'|' -f1) scene=$(scene) map=$(js '$gameMap.mapId()' 5)"
done
shot map2
echo "errors: $(js 'JSON.stringify(PMZ_DEBUG.errors.slice(-8))')"
echo "missing/failed files in run.log:"; grep -iE "failed to load|404|not found|ERR_FILE" $RZ/games/$ID/run.log | grep -viE "dbus|UPower" | head -5
grep -E "case fix|WARNING|app name" $RZ/games/$ID/run.log | head -5
