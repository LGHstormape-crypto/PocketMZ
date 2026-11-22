#!/bin/sh
# Run pmzrun.js (real MZ engine + real PIXI on our WebGL1 layer, SDL window) inside the beta overlay chroot.
# Usage: run-pmzrun.sh   env: PMZ_VOLUME PMZ_AUDIO_DUMP PMZ_AUDIO=off AUDIOTEST=1, HOLD=5 (s on title) PMZ_HINT/PMZ_HINTMETRICS/PMZ_AA (text tuning) SHOT PMZ_GLDEBUG=1 TOUCH=0 MAXSEC=50 SHOT=/path.png
# MODE=test (default): scripted harness, 75 s timeout, pad input only logged. MODE=play: run the game normally, no timeout/screenshots (quit: F2+Start or window close; saves in game/save).
#   SAVE_DIR=<dir> (tests default to /tmp/pmz-save-test), SAVETEST=1 / INPUTTEST=1 (scripted stages), PMZ_INPUTLOG=1 (log SDL events)
# Game: PMZ_GAME_ID=<id> (MZ or MV, required); TELEPORT=<map id> (default 0 = stay on the opening map).
# Defaults: PMZ_ROOTDIR=root24 (Node 24 dev overlay; rt = release image, auto = rt else root24), PMZ_PATCHES=Handheld,HandheldMV,PluginFixes,Menu (α patches kept, each checks its engine; add Debug = REPL on :9333 + global require; PMZ_PATCHES= for stock), PMZ_NODEFLAGS=--maglev, PMZ_ORPHAN=1 (buffer orphaning in pmzrt)
# play mode: pocketmz-hotkeys.py (evdev, outside the chroot) runs next to the game and drives PocketMZ_Menu over 127.0.0.1:9334 (F2+F1 menu, F2+Start quit, ... as in α); POCKETMZ_HOTKEYS=0 = off.
#   Launcher (pocketmz-run.sh, runtime beta/auto): MODE=play PMZ_GUARD=1 PMZ_FAIL_FILE=<file> PMZ_COMPAT_FILE=<file> POCKETMZ_TITLE=<launcher name>; pmzrun.js exits 3 on a boot problem / COMPAT event and writes the reason to PMZ_FAIL_FILE (PMZ_GUARD_FORCE=<text> = fail on purpose, for tests).
#   PMZ_NOQUIT=1: quit combos / menu quit / nw.App.quit are ignored (autotests). Per-game env (games/<id>/env, pocketmz.json renderScale) and the UI language are passed on like pocketmz-run.sh does.
B=/storage/pocketmz/beta
[ -n "$(pidof nw)" ] && { echo "a game (nw) is running, abort"; exit 1; }
export POCKETMZ_ROOT=$($B/beta-mount.sh ${PMZ_ROOTDIR:-root24}) || exit 1
# PMZ_ROOTDIR: root24 (default, dev overlay) | root | rt (release image, read-only root) | auto (rt if installed, else root24; what the launcher passes). The release root is read-only:
# pmzrun.js' result file goes to /tmp there (PMZ_OUT overrides); /tmp, /root (home, fontconfig cache), shots and the game folders are bind mounts.
OUTV=$PMZ_OUT; export OUTV; case "$POCKETMZ_ROOT" in */rt) [ -z "$OUTV" ] && OUTV=/tmp/pmzrun-result.txt ;; esac
# game: PMZ_GAME_ID=<id> (MZ or MV). Thin copy /storage/pocketmz/games/<id>/game, original folder from POCKETMZ_SRC or the launcher in /storage/roms/rpgmz (line id=<id> -> dir=...).
# MV games keep index.html in the thin copy's www/: GAME=/game/www inside the chroot (pmzrun.js detects MV by js/rpg_core.js there).
ID="$PMZ_GAME_ID"; [ -n "$ID" ] || { echo "set PMZ_GAME_ID=<id>" >&2; exit 2; }
G=/storage/pocketmz/games/$ID
[ -d $G/game ] || { echo "no thin copy $G/game (run the game once with pocketmz-run.sh)"; exit 1; }
SRC="$POCKETMZ_SRC"
if [ -z "$SRC" ]; then
  LF=$(grep -lx "id=$ID" /storage/roms/rpgmz/*.rpgmz 2>/dev/null | head -1)
  [ -n "$LF" ] && SRC=$(sed -n 's/^dir=//p' "$LF" | head -1)
fi
SRC="${SRC%/}"; [ -d "$SRC" ] || { echo "original folder of $ID not found ($SRC)"; exit 1; }
GAMEDIR=/game; ENG=MZ; [ ! -f $G/game/index.html ] && [ -f $G/game/www/index.html ] && { GAMEDIR=/game/www; ENG=MV; }
export POCKETMZ_GAME=$G/game POCKETMZ_SRC="$SRC"
echo "game $ID ($ENG) src=$SRC"; echo "root $POCKETMZ_ROOT"
export GAME=$GAMEDIR TELEPORT="${TELEPORT:-0}"
export POCKETMZ_TOUCH="${TOUCH:-1}" POCKETMZ_GLDEBUG="${PMZ_GLDEBUG:-0}" POCKETMZ_HOLD="${HOLD:-5}" POCKETMZ_MAXSEC="${MAXSEC:-70}"
mkdir -p $B/shots
# ES blacks the screen when it sees no input and gkd-idle takes cores 1-3 offline after 30 min: run ES's own screensaver-stop scripts first (same as pocketmz-autotest.sh)
if [ -f /run/gkd-idle.state ] || [ "$(cat /sys/class/backlight/*/bl_power 2>/dev/null | head -n1)" != 0 ]; then for f in /var/run/emulationstation/scripts/screensaver-stop/*; do [ -x "$f" ] && "$f" >/dev/null 2>&1; done; sleep 1; fi
echo "cpu online: $(cat /sys/devices/system/cpu/online)"
# button map: same lookup order as pocketmz-run.sh (user map in the thin copy > per-game override > default), copied to /tmp (visible in the chroot)
GP=/storage/pocketmz/pocketmz.gptk
for g in pocketmz.gptk rpgmz.gptk; do [ -f $G/$g ] && { GP=$G/$g; break; }; done
[ -f $G/game/pocketmz.gptk ] && GP=$G/game/pocketmz.gptk
cp "$GP" /tmp/pmz-gptk
# α's per-game settings reach the patches as process.env.POCKETMZ_*: same sources as pocketmz-run.sh (env file, in-game menu's pocketmz.json, system language)
[ -f $G/env ] && { set -a; . $G/env; set +a; }
RS=$(grep -o '"renderScale": *"[a-z0-9.]*"' $G/game/pocketmz.json 2>/dev/null | head -1 | cut -d'"' -f4); [ -z "$POCKETMZ_RENDER_SCALE" ] && [ -n "$RS" ] && POCKETMZ_RENDER_SCALE=$RS
. /etc/profile >/dev/null 2>&1; UI_LANG=$(get_setting system.language 2>/dev/null); export POCKETMZ_UI_LANG="${POCKETMZ_UI_LANG:-${UI_LANG:-zh_CN}}"
export POCKETMZ_RENDER_SCALE POCKETMZ_IMG_SCALE POCKETMZ_IMG_CACHE POCKETMZ_WIN_SCALE POCKETMZ_GC POCKETMZ_SE_CACHE POCKETMZ_MAP_CACHE POCKETMZ_KEEP_IMAGES POCKETMZ_PRELOAD_SYSTEM POCKETMZ_TILE_ATLAS POCKETMZ_PRELOAD_FIX
export MODE=${MODE:-test}; TMO="timeout 75"; [ "$MODE" = play ] && TMO=""
# audio: PMZ_VOLUME master knob (default 1.0), PMZ_AUDIO_DUMP=/opt/beta/shots/x.wav writes the mixed output (float32 WAV), PMZ_AUDIO=off = old silent stub
[ -z "$PMZ_VOLUME" ] && export PMZ_VOLUME=1.0   # tests are audible too (user feedback); lower it explicitly if needed
HK_PID=""
if [ "$MODE" = play ] && [ "${POCKETMZ_HOTKEYS:-1}" = 1 ] && [ -f /storage/pocketmz/pocketmz-hotkeys.py ]; then   # same hold-F2 combos as α; talks to PocketMZ_Menu on :9334
  kill $(pgrep -f pocketmz-hotkeys.py) 2>/dev/null
  command -v set_kill >/dev/null && set_kill set "-9 node"   # L1+Select+Start (system) force-quits the game, as with nw in α
  POCKETMZ_TITLE="${POCKETMZ_TITLE:-$ID}" python3 /storage/pocketmz/pocketmz-hotkeys.py >/tmp/pmz-hotkeys.log 2>&1 &
  HK_PID=$!
fi
$TMO unshare -m sh -c 'mount --make-rprivate / && mkdir -p $POCKETMZ_ROOT/opt/beta/shots && mount --bind /storage/pocketmz/beta/shots $POCKETMZ_ROOT/opt/beta/shots && exec /storage/pocketmz/pocketmz-chroot.sh run /usr/bin/env SDL_VIDEODRIVER=wayland mesa_glthread=${mesa_glthread:-false} MODE=$MODE OUT=$OUTV SAVE_DIR=$SAVE_DIR SAVETEST=$SAVETEST INPUTTEST=$INPUTTEST PMZ_PLAYSELFTEST=$PMZ_PLAYSELFTEST PMZ_VOLUME=$PMZ_VOLUME PMZ_AUDIO=$PMZ_AUDIO PMZ_AUDIO_DUMP=$PMZ_AUDIO_DUMP PMZ_AUDIO_RATE=$PMZ_AUDIO_RATE PMZ_AUDIO_BUF=$PMZ_AUDIO_BUF AUDIOTEST=$AUDIOTEST SDL_AUDIODRIVER=$SDL_AUDIODRIVER PMZ_INPUTLOG=$PMZ_INPUTLOG PMZ_GPTK=/tmp/pmz-gptk PMZ_PATCHES=${PMZ_PATCHES-Handheld,HandheldMV,PluginFixes,Menu} GAME=$GAME PMZ_NOQUIT=$PMZ_NOQUIT PMZ_GUARD=$PMZ_GUARD PMZ_GUARD_FORCE=$PMZ_GUARD_FORCE PMZ_GUARD_BOOT_SEC=$PMZ_GUARD_BOOT_SEC PMZ_FAIL_FILE=$PMZ_FAIL_FILE PMZ_COMPAT_FILE=$PMZ_COMPAT_FILE PMZ_GLOBAL_REQUIRE=$PMZ_GLOBAL_REQUIRE PMZ_EFFECT_ADD=$PMZ_EFFECT_ADD PMZ_EFFEKSEER=$PMZ_EFFEKSEER PMZ_BATTLE=$PMZ_BATTLE PMZ_FREEZE=$PMZ_FREEZE PMZ_TEXTPROF=$PMZ_TEXTPROF PMZ_MTEST=$PMZ_MTEST PMZ_PROFLOG=$PMZ_PROFLOG PMZ_BATTLE_REAL=$PMZ_BATTLE_REAL PMZ_BATTLE_SEC=$PMZ_BATTLE_SEC PMZ_TROOP=$PMZ_TROOP PMZ_ANIM=$PMZ_ANIM PMZ_BATTLE_SHOT=$PMZ_BATTLE_SHOT POCKETMZ_UI_LANG=$POCKETMZ_UI_LANG POCKETMZ_RT_NOW=$POCKETMZ_RT_NOW POCKETMZ_RT_GLOBAL=$POCKETMZ_RT_GLOBAL POCKETMZ_BETA_INST=$POCKETMZ_BETA_INST POCKETMZ_RENDER_SCALE=$POCKETMZ_RENDER_SCALE POCKETMZ_IMG_SCALE=$POCKETMZ_IMG_SCALE POCKETMZ_IMG_CACHE=$POCKETMZ_IMG_CACHE POCKETMZ_WIN_SCALE=$POCKETMZ_WIN_SCALE POCKETMZ_GC=$POCKETMZ_GC POCKETMZ_SE_CACHE=$POCKETMZ_SE_CACHE POCKETMZ_MAP_CACHE=$POCKETMZ_MAP_CACHE POCKETMZ_KEEP_IMAGES=$POCKETMZ_KEEP_IMAGES POCKETMZ_PRELOAD_SYSTEM=$POCKETMZ_PRELOAD_SYSTEM POCKETMZ_TILE_ATLAS=$POCKETMZ_TILE_ATLAS POCKETMZ_PRELOAD_FIX=$POCKETMZ_PRELOAD_FIX PMZ_ORPHAN=$PMZ_ORPHAN POCKETMZ_DEFAULT_FPS=${POCKETMZ_DEFAULT_FPS:-60} TOUCH=$POCKETMZ_TOUCH PMZ_GLDEBUG=$POCKETMZ_GLDEBUG PMZ_HINT=$PMZ_HINT PMZ_HINTMETRICS=$PMZ_HINTMETRICS PMZ_AA=$PMZ_AA PMZ_PROF=$PMZ_PROF PMZ_CPUPROF=$PMZ_CPUPROF PMZ_CPUPROF2=$PMZ_CPUPROF2 PMZ_CPUPROF3=$PMZ_CPUPROF3 PMZ_NOBLUR=$PMZ_NOBLUR PMZ_TEXT_TOL=$PMZ_TEXT_TOL SHOT2=${SHOT2:-} SHOT4=${SHOT4:-/opt/beta/shots/map-beta-play.png} MAPADV=${MAPADV:-0} TELEPORT=$TELEPORT SHOT5=${SHOT5:-/opt/beta/shots/map-beta-walk.png} SHOT3=${SHOT3:-/opt/beta/shots/map-beta.png} MAPHOLD=${MAPHOLD:-10000} SHOT=${SHOT:-/opt/beta/shots/title-beta.png} HOLD=$POCKETMZ_HOLD MAXSEC=$POCKETMZ_MAXSEC /usr/bin/node --max-old-space-size=256 --expose-gc ${PMZ_NODEFLAGS:---maglev} /opt/beta/pmzrun.js'
RC=$?
[ -n "$HK_PID" ] && { kill $HK_PID 2>/dev/null; command -v set_kill >/dev/null && set_kill stop; }
exit $RC
