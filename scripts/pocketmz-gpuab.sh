#!/bin/sh
# Dev: what costs GPU time in the current scene? Loads the newest save of a game (save writes
# blocked; the save folder is backed up before and restored + compared after), then switches
# parts of the picture off one at a time and measures the GPU fragment engine busy time
# (panfrost fdinfo, profiling switched on only for the test) and the frame rate.
# Usage: pocketmz-gpuab.sh "/storage/roms/ports/<game>.sh" [secs per step]
PORT="$1"; SECS="${2:-4}"
RZ=/storage/pocketmz; T=$RZ/pocketmz-test.sh
ID=$(sed -n 's/^# pocketmz: //p; s/^id=//p' "$PORT" | head -1)
export POCKETMZ_TEST_PORT="$PORT" XDG_RUNTIME_DIR=/var/run/0-runtime-dir WAYLAND_DISPLAY=wayland-1
js() { T="${2:-30}" $T js "$1" | tr -d '\n'; }
scene() { js 'SceneManager._scene?SceneManager._scene.constructor.name:""' 5 | tr -d '" '; }
PROFF=/sys/bus/platform/drivers/panfrost/fde60000.gpu/profiling

pidof nw >/dev/null && { echo "a game is running - stop it first"; exit 1; }
G=$RZ/games/$ID/game; SAVE=$G/save; [ -d $G/www ] && SAVE=$G/www/save
B=$RZ/games/$ID/save-gpuab-$(date +%Y%m%d-%H%M%S); mkdir -p "$B"; cp -a "$SAVE/." "$B/"
restore() { echo 0 > $PROFF 2>/dev/null; $T stop >/dev/null 2>&1; rm -rf "$SAVE"/*; cp -a "$B/." "$SAVE/"
  diff -r "$B" "$SAVE" >/dev/null && { rm -rf "$B"; echo "saves restored"; } || echo "SAVES DIFFER - backup kept in $B"; }
trap restore EXIT
touch $RZ/dev
( $T start >/dev/null 2>&1 & )
for i in $(seq 1 240); do case "$(scene)" in *Title*) break;; esac; sleep 1; done
case "$(scene)" in *Title*) ;; *) false;; esac || { echo "no title"; exit 1; }
js 'StorageManager.saveObject = () => Promise.resolve(); DataManager.saveGame = () => Promise.resolve(true); ConfigManager.save = () => {}; 1' >/dev/null
[ -n "$GPUAB_PRE" ] && js "$GPUAB_PRE" >/dev/null
echo "load: $(js 'const id = DataManager.latestSavefileId(); DataManager.loadGame(id).then(() => { $gameSystem.onAfterLoad(); SceneManager.goto(Scene_Map); }); "save " + id')"
for i in $(seq 1 60); do [ "$(scene)" = Scene_Map ] && break; sleep 1; done
sleep 6
echo "map $(js '$gameMap.mapId()') tone=$(js 'JSON.stringify($gameScreen.tone())') fps option=$(js 'ConfigManager.gkdFrameRate') res=$(js 'Graphics.app.renderer.resolution')"

NW=$(pidof nw | tr ' ' '\n' | while read p; do grep -q "type=" /proc/$p/cmdline 2>/dev/null || echo $p; done | head -1)
# the WebGL client = the render node fd with the most resident GPU memory
FD=$(for fd in $(ls /proc/$NW/fd); do readlink /proc/$NW/fd/$fd | grep -q renderD && echo "$(awk '/drm-resident-memory/{print $2}' /proc/$NW/fdinfo/$fd 2>/dev/null) $fd"; done | sort -rn | head -1 | cut -d' ' -f2)
frag() { awk '/drm-engine-fragment/{print $2}' /proc/$NW/fdinfo/$FD; }
echo 1 > $PROFF
DRAWS='new Promise(r=>{const R=Graphics.app.renderer,o=R.render;let n=0;R.render=function(){n++;return o.apply(this,arguments)};setTimeout(()=>{delete R.render;if(R.render!==o)R.render=o;r(n)},'$((SECS*1000))')})'
step() { # <name> <js to switch off> <js to switch back on>
  [ -n "$2" ] && js "$2; 1" >/dev/null
  sleep 1; a=$(frag); n=$(js "$DRAWS" 20); b=$(frag)
  echo "$(printf %-28s "$1") gpu busy $(awk "BEGIN{printf \"%3d%%\", ($b-$a)/($SECS*1e9)*100}")  draws $(awk "BEGIN{printf \"%.1f/s\", $n/$SECS}")"
  [ -n "$3" ] && js "$3; 1" >/dev/null
}
S='SceneManager._scene'
if [ -n "$GPUAB_BATTLE" ]; then
  # auto battle nobody can lose: actors act on their own, HP never drops below 1
  echo "battle: $(js 'Game_Actor.prototype.isAutoBattle = () => true; Window_Message.prototype.isTriggered = () => true;
    const gh = Game_Battler.prototype.gainHp; Game_Battler.prototype.gainHp = function(v) { if (v < 0) v = -Math.min(-v, this.hp - 1); gh.call(this, v); };
    const enc = $gameMap.encounterList().map(e => e.troopId).filter(t => $dataTroops[t] && $dataTroops[t].members.length);
    const t = '"${GPUAB_BATTLE}"' > 1 ? '"${GPUAB_BATTLE}"' : (enc[0] || $dataTroops.findIndex(x => x && x.members.length));
    BattleManager.setup(t, true, false); SceneManager.push(Scene_Battle); "troop " + t + " " + $dataTroops[t].name')"
  for i in $(seq 1 30); do [ "$(scene)" = Scene_Battle ] && break; sleep 1; done; sleep 4
  [ -n "$GPUAB_SHOTS" ] && { for i in $(seq 1 $GPUAB_SHOTS); do grim -s 0.5 /tmp/gpuab_$i.png 2>/dev/null; sleep 0.7; done; echo "shots: /tmp/gpuab_*.png"; }
  for i in 1 2; do step "battle $i" "" ""; done
  step "battle fps 60" 'ConfigManager.gkdFrameRate=60' 'ConfigManager.gkdFrameRate=30'
  step "battleback hidden" "$S._spriteset._backgroundSprite&&($S._spriteset._backgroundSprite.visible=false); $S._spriteset._back1Sprite.visible=false; $S._spriteset._back2Sprite.visible=false" "$S._spriteset._back1Sprite.visible=true; $S._spriteset._back2Sprite.visible=true; $S._spriteset._backgroundSprite&&($S._spriteset._backgroundSprite.visible=true)"
  step "battle spriteset hidden" "$S._spriteset.visible=false" "$S._spriteset.visible=true"
  step "battle windows hidden" "$S._windowLayer.visible=false" "$S._windowLayer.visible=true"
  step "battle huds hidden" "window._h=$S.children.filter(c=>c!==$S._spriteset&&c!==$S._windowLayer&&c.visible); window._h.forEach(c=>c.visible=false)" "window._h.forEach(c=>c.visible=true)"
  [ -n "$GPUAB_JS" ] && echo "--- eval: $(T=40 $T js "$GPUAB_JS" | python3 -c 'import sys,json;print(json.loads(sys.stdin.read()))')"
  [ -n "$GPUAB_ONLY_JS" ] && exit 0
  echo "--- CPU split (sceneprof, 8 s):"; T=40 $T js "$(cat $RZ/pocketmz-sceneprof.js)" | python3 -c 'import sys,json;print(json.loads(sys.stdin.read()))' | head -24
  echo "--- frames: $(T=40 $T js "$(cat $RZ/pocketmz-rafprobe.js)")"
  echo "scene now: $(scene) phase=$(js 'BattleManager._phase') top children: $(js "$S.children.map(c=>c.constructor.name).join(',')")"
  exit 0
fi
step "baseline (fps 30)" "" ""
step "fps 60" 'ConfigManager.gkdFrameRate=60' 'ConfigManager.gkdFrameRate=30'
step "map tone filter off" "window._f=$S._spriteset._baseSprite.filters; $S._spriteset._baseSprite.filters=null" "$S._spriteset._baseSprite.filters=window._f"
step "map filter res 0.5" "window._fr=$S._spriteset._baseSprite.filters[0].resolution; $S._spriteset._baseSprite.filters.forEach(f=>f.resolution=Graphics.app.renderer.resolution)" "$S._spriteset._baseSprite.filters.forEach(f=>f.resolution=window._fr)"
step "all filters res 0.5" "window._af=[]; (function w(o){(o.filters||[]).forEach(f=>{window._af.push([f,f.resolution]); f.resolution=Graphics.app.renderer.resolution}); (o.children||[]).forEach(w)})($S)" "window._af.forEach(([f,r])=>f.resolution=r)"
step "filter info" "" ""
echo "map filter: $(js "(()=>{const f=$S._spriteset._baseSprite.filters[0];return f.constructor.name+\" res=\"+f.resolution+\" autoFit=\"+f.autoFit+\" padding=\"+f.padding+\" bounds=\"+JSON.stringify($S._spriteset._baseSprite.getBounds())})()")"
step "window filters off" "window._wf=[]; $S._windowLayer.children.forEach(w=>{const b=w._backSprite; if(b){window._wf.push([b,b.filters]); b.filters=null}})" "window._wf.forEach(([b,f])=>b.filters=f)"
step "pictures hidden" "$S._spriteset._pictureContainer.visible=false" "$S._spriteset._pictureContainer.visible=true"
step "windows hidden" "$S._windowLayer.visible=false" "$S._windowLayer.visible=true"
step "map hidden (spriteset)" "$S._spriteset.visible=false" "$S._spriteset.visible=true"
step "tilemap hidden" "$S._spriteset._tilemap.visible=false" "$S._spriteset._tilemap.visible=true"
step "everything hidden" "$S.visible=false" "$S.visible=true"
step "scene filters off" "window._sf=$S.filters; $S.filters=null" "$S.filters=window._sf"
step "baseline again" "" ""
echo "objects: $(js '(()=>{let n=0,v=0;const w=o=>(o.children||[]).forEach(c=>{n++;if(c.visible)v++;w(c)});w(SceneManager._scene);return n+" visible "+v})()')"
