#!/bin/sh
# Run pmzrun.js (real MZ engine + real PIXI on our WebGL1 layer, SDL window) inside the beta overlay chroot.
# Usage: run-pmzrun.sh   env: PMZ_VOLUME PMZ_AUDIO_DUMP PMZ_AUDIO=off AUDIOTEST=1, HOLD=5 (s on title) PMZ_HINT/PMZ_HINTMETRICS/PMZ_AA (text tuning) SHOT PMZ_GLDEBUG=1 TOUCH=0 MAXSEC=50 SHOT=/path.png
# MODE=test (default): scripted harness, 75 s timeout, pad input only logged. MODE=play: run the game normally, no timeout/screenshots (quit: Select+Start or window close; saves in game/save).
#   SAVE_DIR=<dir> (tests default to /tmp/pmz-save-test), SAVETEST=1 / INPUTTEST=1 (scripted stages), PMZ_INPUTLOG=1 (log SDL events)
# Game: PMZ_GAME_ID=<id> (MZ or MV, required); TELEPORT=<map id> (default 0 = stay on the opening map).
# Defaults: PMZ_ROOTDIR=root24 (Node 24 dev overlay; rt = release image, auto = rt else root24), PMZ_PATCHES=Handheld,HandheldMV,PluginFixes,Menu (α patches kept, each checks its engine; add Debug = REPL on :9333 + global require; PMZ_PATCHES= for stock), PMZ_NODEFLAGS=--maglev, PMZ_ORPHAN=1 (buffer orphaning in pmzrt)
# play mode: Select + X toggles PocketMZ_Menu, Select + Start quits.
#   Launcher (pocketmz-run.sh, runtime beta/auto): MODE=play PMZ_GUARD=1 PMZ_FAIL_FILE=<file> PMZ_COMPAT_FILE=<file> POCKETMZ_TITLE=<launcher name>; pmzrun.js exits 3 on a boot problem / COMPAT event and writes the reason to PMZ_FAIL_FILE (PMZ_GUARD_FORCE=<text> = fail on purpose, for tests).
#   PMZ_NOQUIT=1: quit combos / menu quit / nw.App.quit are ignored (autotests). Per-game env (games/<id>/env, pocketmz.json renderScale) and the UI language are passed on like pocketmz-run.sh does.
RZ="${POCKETMZ_DATA:-/storage/pocketmz}"
B="$RZ/beta"
[ -n "$(pidof nw)" ] && { echo "a game (nw) is running, abort"; exit 1; }
export POCKETMZ_ROOT=$("$B/beta-mount.sh" ${PMZ_ROOTDIR:-root24}) || exit 1
# PMZ_ROOTDIR: root24 (default, dev overlay) | root | rt (release image, read-only root) | auto (rt if installed, else root24; what the launcher passes). The release root is read-only:
# pmzrun.js' result file goes to /tmp there (PMZ_OUT overrides); /tmp, /root (home, fontconfig cache), shots and the game folders are bind mounts.
OUTV=$PMZ_OUT; export OUTV; case "$POCKETMZ_ROOT" in */rt) [ -z "$OUTV" ] && OUTV=/tmp/pmzrun-result.txt ;; esac
# game: PMZ_GAME_ID=<id> (MZ or MV). Writable state dir $RZ/games/<id>/game, original folder from POCKETMZ_SRC (VFS).
# MV games keep index.html in www/: GAME=/game/www inside the chroot (pmzrun.js detects MV via VFS).
ID="$PMZ_GAME_ID"; [ -n "$ID" ] || { echo "set PMZ_GAME_ID=<id>" >&2; exit 2; }
G="$RZ/games/$ID"
SRC="${POCKETMZ_SRC:-}"
SRC="${SRC%/}"; [ -d "$SRC" ] || { echo "original folder of $ID not found ($SRC)" >&2; exit 1; }
GAMEDIR=/game; ENG=MZ; WEB=""
if [ ! -f "$SRC/index.html" ] && [ -f "$SRC/www/index.html" ]; then GAMEDIR=/game/www; ENG=MV; WEB="www/"; fi
mkdir -p "$G/game${WEB:+/${WEB%/}}"
export POCKETMZ_GAME=$G/game POCKETMZ_SRC="$SRC" PMZ_GAMESRC="/gamesrc${WEB:+/${WEB%/}}"
echo "game $ID ($ENG) src=$SRC"; echo "root $POCKETMZ_ROOT"
export GAME=$GAMEDIR TELEPORT="${TELEPORT:-0}"
export POCKETMZ_TOUCH="${TOUCH:-1}" POCKETMZ_GLDEBUG="${PMZ_GLDEBUG:-0}" POCKETMZ_HOLD="${HOLD:-5}" POCKETMZ_MAXSEC="${MAXSEC:-70}"
mkdir -p $B/shots
# Wake ES screensaver if active before measuring/running
if [ "$(cat /sys/class/backlight/*/bl_power 2>/dev/null | head -n1)" != 0 ]; then for f in /var/run/emulationstation/scripts/screensaver-stop/*; do [ -x "$f" ] && "$f" >/dev/null 2>&1; done; sleep 1; fi
echo "cpu online: $(cat /sys/devices/system/cpu/online)"
# button map: same lookup order as pocketmz-run.sh (user map in the thin copy > per-game override > default).
# Fallback goes to /tmp/pmz-gptk; PMZ_USER_GPTK points at the live thin-copy file so Select+X menu edits take effect immediately.
GP="$RZ/pocketmz.gptk"
for g in pocketmz.gptk rpgmz.gptk; do [ -f "$G/$g" ] && { GP="$G/$g"; break; }; done
cp "$GP" /tmp/pmz-gptk
# SDL gamecontroller mapping: generate from ES es_input.cfg via pocketmz-pad.py so A/B/X/Y match ES/α
GCDB="$SDL_GAMECONTROLLERCONFIG_FILE"
if [ -z "$GCDB" ] || [ ! -f "$GCDB" ]; then
  GCDB=$(python3 "$RZ/pocketmz-pad.py" 2>/dev/null || true)
fi
[ -z "$GCDB" ] && [ -f /tmp/pmz-gamecontrollerdb.txt ] && GCDB=/tmp/pmz-gamecontrollerdb.txt
[ -z "$GCDB" ] && [ -f /storage/.config/SDL-GameControllerDB/gamecontrollerdb.txt ] && GCDB=/storage/.config/SDL-GameControllerDB/gamecontrollerdb.txt
if [ -n "$GCDB" ] && [ -f "$GCDB" ]; then
  case "$GCDB" in /tmp/*) ;; *) cp "$GCDB" /tmp/pmz-gcdb.txt && GCDB=/tmp/pmz-gcdb.txt ;; esac
elif [ -n "$SDL_GAMECONTROLLERCONFIG" ]; then
  printf '%s\n' "$SDL_GAMECONTROLLERCONFIG" > /tmp/pmz-gcdb.txt && GCDB=/tmp/pmz-gcdb.txt
else
  GCDB=""
fi
export GCDB
# α's per-game settings reach the patches as process.env.POCKETMZ_*: same sources as pocketmz-run.sh (env file, ES override, in-game menu's pocketmz.json, system language)
[ -f $G/env ] && { set -a; . $G/env; set +a; }
if [ -z "$POCKETMZ_ES_RENDER_SCALE" ]; then
  RS=$(grep -o '"renderScale": *"[a-z0-9.]*"' $G/game/pocketmz.json 2>/dev/null | head -1 | cut -d'"' -f4); [ -n "$RS" ] && POCKETMZ_RENDER_SCALE=$RS
fi
if [ -z "$POCKETMZ_LANG" ]; then
  WEB=""; [ "$ENG" = MV ] && WEB="www/"
  GLOC=$(grep -o '"locale" *: *"[^"]*"' "$G/game/${WEB}data/System.json" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/')
  POCKETMZ_LANG="${GLOC%%_*}"; POCKETMZ_LANG="${POCKETMZ_LANG:-ja}"
fi
if [ -z "$POCKETMZ_UI_LANG" ] && [ -f "$RZ/settings.json" ]; then
  SL=$(grep -o '"language": *"[^"]*"' "$RZ/settings.json" 2>/dev/null | head -1 | cut -d'"' -f4)
  case "$SL" in zh|en|ja) POCKETMZ_UI_LANG="$SL" ;; esac
fi
. /etc/profile >/dev/null 2>&1 || true; UI_LANG=$(get_setting system.language 2>/dev/null || true); export POCKETMZ_UI_LANG="${POCKETMZ_UI_LANG:-${UI_LANG:-zh_CN}}" POCKETMZ_LANG
if [ -z "$POCKETMZ_SMOOTH" ]; then
  SM=$(grep -o '"smooth": *[a-z]*' "$G/game/pocketmz.json" 2>/dev/null | head -1 | sed 's/.*: *//')
  if [ -z "$SM" ] && [ -f "$RZ/settings.json" ]; then
    SM=$(grep -o '"smooth": *[a-z]*' "$RZ/settings.json" 2>/dev/null | head -1 | sed 's/.*: *//')
  fi
  case "$SM" in true|1|on) POCKETMZ_SMOOTH=1 ;; false|0|off) POCKETMZ_SMOOTH=0 ;; esac
fi
export POCKETMZ_RENDER_SCALE POCKETMZ_IMG_SCALE POCKETMZ_IMG_CACHE POCKETMZ_WIN_SCALE POCKETMZ_GC POCKETMZ_SE_CACHE POCKETMZ_MAP_CACHE POCKETMZ_KEEP_IMAGES POCKETMZ_PRELOAD_SYSTEM POCKETMZ_TILE_ATLAS POCKETMZ_PRELOAD_FIX POCKETMZ_SMOOTH POCKETMZ_ES_RENDER_SCALE POCKETMZ_ES_SMOOTH POCKETMZ_ES_FPS POCKETMZ_ES_SHOW_FPS POCKETMZ_ES_RUNTIME POCKETMZ_ES_STOP_ES POCKETMZ_ES_AUTOSAVE
export MODE=${MODE:-test}; TMO="timeout 75"; [ "$MODE" = play ] && TMO=""
if [ "$MODE" = play ] && [ -z "$SAVE_DIR" ]; then
  [ "$ENG" = MV ] && export POCKETMZ_WEB="www/" || export POCKETMZ_WEB=""
  export POCKETMZ_SAVE_DIR="${POCKETMZ_SAVE_DIR:-${POCKETMZ_SAVE_BASE:-/storage/roms/savestates/rpgmz}/$ID/save}"
  export POCKETMZ_BACKUP_DIR="${POCKETMZ_BACKUP_DIR:-${POCKETMZ_SAVE_BASE:-/storage/roms/savestates/rpgmz}/$ID/save-backups}"
  export POCKETMZ_CACHE_DIR="${POCKETMZ_CACHE_DIR:-${POCKETMZ_SAVE_BASE:-/storage/roms/savestates/rpgmz}/_cache/$ID}"
  mkdir -p "$POCKETMZ_SAVE_DIR" "$POCKETMZ_BACKUP_DIR" "$POCKETMZ_CACHE_DIR"
elif [ "$MODE" != play ]; then
  export POCKETMZ_SAVE_DIR="" POCKETMZ_BACKUP_DIR="" POCKETMZ_CACHE_DIR="" POCKETMZ_WEB=""
fi
# audio: PMZ_VOLUME master knob (default 1.0), PMZ_AUDIO_DUMP=/opt/beta/shots/x.wav writes the mixed output (float32 WAV), PMZ_AUDIO=off = old silent stub
[ -z "$PMZ_VOLUME" ] && export PMZ_VOLUME=1.0   # tests are audible too (user feedback); lower it explicitly if needed
# Display backend (P4): explicit SDL_VIDEODRIVER wins; else detect Wayland socket -> X11 -> KMS/DRM.
if [ -z "$SDL_VIDEODRIVER" ]; then
  _xr="${XDG_RUNTIME_DIR:-/var/run/0-runtime-dir}"; _wd="${WAYLAND_DISPLAY:-wayland-1}"
  if [ -S "$_xr/$_wd" ]; then SDL_VIDEODRIVER=wayland
  elif [ -n "$DISPLAY" ]; then SDL_VIDEODRIVER=x11
  elif [ -e /dev/dri/card0 ]; then SDL_VIDEODRIVER=kmsdrm
  fi
fi
# Host GPU driver passthrough (P2): POCKETMZ_HOST_GL=auto|1|0 (default auto).
# When the host uses a closed GLES driver (e.g. ROCKNIX libmali: /dev/mali0 or bind-mounted /usr/lib/libEGL.so*),
# bind ONLY the host GL/vendor .so files into a private tmpfs at $POCKETMZ_ROOT/tmp/pmz-hostgl so chroot Mesa
# and host libc are never mixed. On panfrost (open-source Mesa), HOST_GL stays 0.
HOST_GL=0
case "${POCKETMZ_HOST_GL:-auto}" in
  1|on|true) HOST_GL=1 ;;
  0|off|false) HOST_GL=0 ;;
  auto)
    if [ -e /dev/mali0 ] || grep -q ' /usr/lib/libEGL\.so' /proc/mounts 2>/dev/null; then HOST_GL=1
    elif { [ -e /usr/lib/libEGL.so.1 ] || [ -e /usr/lib/aarch64-linux-gnu/libEGL.so.1 ] || [ -e /usr/lib/mali/libEGL.so.1 ]; } && [ ! -d /sys/module/panfrost ] && [ ! -d /sys/bus/platform/drivers/panfrost ] && [ ! -d /sys/module/lima ] && [ ! -d /sys/module/etnaviv ]; then HOST_GL=1
    fi ;;
esac
export HOST_GL SDL_VIDEODRIVER RZ PMZ_HOST_SDL
[ "$HOST_GL" = 1 ] && echo "host GL passthrough enabled (video=${SDL_VIDEODRIVER:-auto})"
if [ "$HOST_GL" = 1 ] && [ -z "$SDL_VIDEODRIVER" ] && [ "${PMZ_HOST_SDL:-0}" != 1 ]; then
  echo "note: no Wayland/X11/DRM detected; if SDL video init fails on fbdev/Mali, retry with PMZ_HOST_SDL=1"
fi
$TMO unshare -m sh -c '
  mount --make-rprivate / || exit 1
  mkdir -p "$POCKETMZ_ROOT/opt/beta/shots" && mount --bind "$RZ/beta/shots" "$POCKETMZ_ROOT/opt/beta/shots" || exit 1
  HOSTGL_ENV=""
  if [ "$HOST_GL" = 1 ]; then
    "$RZ/pocketmz-chroot.sh" mount || exit 1
    HG="$POCKETMZ_ROOT/tmp/pmz-hostgl"
    mkdir -p "$HG" && mount -t tmpfs -o size=2M tmpfs "$HG" || exit 1
    is_elf64() {
      command -v od >/dev/null 2>&1 || return 0
      [ "$(od -An -tx1 -N5 "$1" 2>/dev/null | tr -d ' \n')" = "7f454c4602" ]
    }
    for d in /mnt/vendor/lib64 /mnt/vendor/lib /usr/lib /usr/lib/aarch64-linux-gnu /usr/lib/mali /usr/lib64 /lib /lib/aarch64-linux-gnu; do
      [ -d "$d" ] || continue
      for pat in "libEGL.so*" "libGLESv2.so*" "libGLESv1_CM.so*" "libgbm.so*" "libmali*.so*" "libMali*.so*" "libPVR*.so*" "libIMG*.so*" "libsrv_um*.so*" "libusc*.so*" "libump.so*" "libion.so*"; do
        for f in "$d"/$pat; do
          [ -e "$f" ] || [ -L "$f" ] || continue
          bn="${f##*/}"; [ -e "$HG/$bn" ] || [ -L "$HG/$bn" ] && continue
          real="$(readlink -f "$f" 2>/dev/null)"
          [ -f "$real" ] && is_elf64 "$real" || continue
          touch "$HG/$bn" && mount --bind "$real" "$HG/$bn" && mount -o remount,bind,ro "$HG/$bn" 2>/dev/null
        done
      done
    done
    # On fbdev/Mali-only hosts (no Wayland, X11, or DRM), chroot Debian libSDL2 cannot open /dev/fb0 + /dev/mali0;
    # opt-in via PMZ_HOST_SDL=1 to bind host 64-bit libSDL2-2.0.so.0 (pmzrt.node uses classic SDL 2.0.0-2.0.4 symbols).
    if [ "${PMZ_HOST_SDL:-0}" = 1 ] && [ ! -e "$HG/libSDL2-2.0.so.0" ]; then
      for d in /usr/lib /mnt/vendor/lib /usr/lib/aarch64-linux-gnu /lib /lib/aarch64-linux-gnu; do
        [ -e "$d/libSDL2-2.0.so.0" ] || continue
        real="$(readlink -f "$d/libSDL2-2.0.so.0" 2>/dev/null)"
        if [ -f "$real" ] && is_elf64 "$real"; then
          touch "$HG/libSDL2-2.0.so.0" && mount --bind "$real" "$HG/libSDL2-2.0.so.0" && mount -o remount,bind,ro "$HG/libSDL2-2.0.so.0" 2>/dev/null
          break
        fi
      done
    fi
    [ -e "$HG/libEGL.so.1" ] && [ -z "$SDL_VIDEO_EGL_DRIVER" ] && SDL_VIDEO_EGL_DRIVER=/tmp/pmz-hostgl/libEGL.so.1
    [ -e "$HG/libGLESv2.so.2" ] && [ -z "$SDL_VIDEO_GL_DRIVER" ] && SDL_VIDEO_GL_DRIVER=/tmp/pmz-hostgl/libGLESv2.so.2
    HOSTGL_ENV="LD_LIBRARY_PATH=/tmp/pmz-hostgl"
    echo "hostgl libs: $(ls "$HG" 2>/dev/null | tr '\n' ' ')"
  fi
  if [ -d "$RZ/patches" ]; then
    mkdir -p "$POCKETMZ_ROOT/tmp/pmz-patches" && mount --bind "$RZ/patches" "$POCKETMZ_ROOT/tmp/pmz-patches" && mount -o remount,bind,ro "$POCKETMZ_ROOT/tmp/pmz-patches" 2>/dev/null
    PMZ_PATCHES_DIR=/tmp/pmz-patches
  fi
  exec "$RZ/pocketmz-chroot.sh" run /usr/bin/env $HOSTGL_ENV ${SDL_VIDEODRIVER:+SDL_VIDEODRIVER=$SDL_VIDEODRIVER} ${SDL_VIDEO_EGL_DRIVER:+SDL_VIDEO_EGL_DRIVER=$SDL_VIDEO_EGL_DRIVER} ${SDL_VIDEO_GL_DRIVER:+SDL_VIDEO_GL_DRIVER=$SDL_VIDEO_GL_DRIVER} ${GCDB:+SDL_GAMECONTROLLERCONFIG_FILE=$GCDB} ${PMZ_PATCHES_DIR:+PMZ_PATCHES_DIR=$PMZ_PATCHES_DIR} PMZ_GAMESRC="$PMZ_GAMESRC" PMZ_GLES=$PMZ_GLES PMZ_GPU_WORKAROUNDS=$PMZ_GPU_WORKAROUNDS mesa_glthread=${mesa_glthread:-false} MODE=$MODE OUT=$OUTV SAVE_DIR=$SAVE_DIR SAVETEST=$SAVETEST INPUTTEST=$INPUTTEST PMZ_PLAYSELFTEST=$PMZ_PLAYSELFTEST PMZ_VOLUME=$PMZ_VOLUME PMZ_AUDIO=$PMZ_AUDIO PMZ_AUDIO_DUMP=$PMZ_AUDIO_DUMP PMZ_AUDIO_RATE=$PMZ_AUDIO_RATE PMZ_AUDIO_BUF=$PMZ_AUDIO_BUF AUDIOTEST=$AUDIOTEST SDL_AUDIODRIVER=$SDL_AUDIODRIVER PMZ_INPUTLOG=$PMZ_INPUTLOG PMZ_GPTK=/tmp/pmz-gptk PMZ_USER_GPTK=/game/pocketmz.gptk PMZ_PATCHES=${PMZ_PATCHES-Handheld,HandheldMV,PluginFixes,Menu} GAME=$GAME PMZ_NOQUIT=$PMZ_NOQUIT PMZ_GUARD=$PMZ_GUARD PMZ_GUARD_FORCE=$PMZ_GUARD_FORCE PMZ_GUARD_BOOT_SEC=$PMZ_GUARD_BOOT_SEC PMZ_FAIL_FILE=$PMZ_FAIL_FILE PMZ_COMPAT_FILE=$PMZ_COMPAT_FILE PMZ_PROBE_FILE=$PMZ_PROBE_FILE PMZ_GLOBAL_REQUIRE=$PMZ_GLOBAL_REQUIRE PMZ_EFFECT_ADD=$PMZ_EFFECT_ADD PMZ_EFFEKSEER=$PMZ_EFFEKSEER PMZ_BATTLE=$PMZ_BATTLE PMZ_FREEZE=$PMZ_FREEZE PMZ_TEXTPROF=$PMZ_TEXTPROF PMZ_MTEST=$PMZ_MTEST PMZ_PROFLOG=$PMZ_PROFLOG PMZ_BATTLE_REAL=$PMZ_BATTLE_REAL PMZ_BATTLE_SEC=$PMZ_BATTLE_SEC PMZ_TROOP=$PMZ_TROOP PMZ_ANIM=$PMZ_ANIM PMZ_BATTLE_SHOT=$PMZ_BATTLE_SHOT POCKETMZ_UI_LANG=$POCKETMZ_UI_LANG POCKETMZ_LANG=$POCKETMZ_LANG POCKETMZ_SMOOTH=$POCKETMZ_SMOOTH POCKETMZ_RT_NOW=$POCKETMZ_RT_NOW POCKETMZ_RT_GLOBAL=$POCKETMZ_RT_GLOBAL POCKETMZ_BETA_INST=$POCKETMZ_BETA_INST POCKETMZ_RENDER_SCALE=$POCKETMZ_RENDER_SCALE POCKETMZ_ES_RENDER_SCALE=$POCKETMZ_ES_RENDER_SCALE POCKETMZ_ES_SMOOTH=$POCKETMZ_ES_SMOOTH POCKETMZ_ES_FPS=$POCKETMZ_ES_FPS POCKETMZ_ES_SHOW_FPS=$POCKETMZ_ES_SHOW_FPS POCKETMZ_ES_RUNTIME=$POCKETMZ_ES_RUNTIME POCKETMZ_ES_STOP_ES=$POCKETMZ_ES_STOP_ES POCKETMZ_ES_AUTOSAVE=$POCKETMZ_ES_AUTOSAVE POCKETMZ_IMG_SCALE=$POCKETMZ_IMG_SCALE POCKETMZ_IMG_CACHE=$POCKETMZ_IMG_CACHE POCKETMZ_WIN_SCALE=$POCKETMZ_WIN_SCALE POCKETMZ_GC=$POCKETMZ_GC POCKETMZ_SE_CACHE=$POCKETMZ_SE_CACHE POCKETMZ_MAP_CACHE=$POCKETMZ_MAP_CACHE POCKETMZ_KEEP_IMAGES=$POCKETMZ_KEEP_IMAGES POCKETMZ_PRELOAD_SYSTEM=$POCKETMZ_PRELOAD_SYSTEM POCKETMZ_TILE_ATLAS=$POCKETMZ_TILE_ATLAS POCKETMZ_PRELOAD_FIX=$POCKETMZ_PRELOAD_FIX POCKETMZ_COMPAT_MODE=$POCKETMZ_COMPAT_MODE POCKETMZ_MAP_REFRESH_GUARD=$POCKETMZ_MAP_REFRESH_GUARD POCKETMZ_CLOSED_WIN_SKIP=$POCKETMZ_CLOSED_WIN_SKIP POCKETMZ_EMPTY_CHAR_SKIP=$POCKETMZ_EMPTY_CHAR_SKIP POCKETMZ_EMPTY_PIC_SKIP=$POCKETMZ_EMPTY_PIC_SKIP POCKETMZ_TONEFILTER_FIX=$POCKETMZ_TONEFILTER_FIX POCKETMZ_SKIPBRANCH_CACHE=$POCKETMZ_SKIPBRANCH_CACHE PMZ_SHADER=$PMZ_SHADER PMZ_PANGO_LANG=$PMZ_PANGO_LANG PMZ_MAX_WORKERS=$PMZ_MAX_WORKERS PMZ_ORPHAN=$PMZ_ORPHAN PMZ_GL_MEM_WEIGHT=$PMZ_GL_MEM_WEIGHT PMZ_CS_CACHE_MB=$PMZ_CS_CACHE_MB PMZ_MEM_SOFT_MB=$PMZ_MEM_SOFT_MB PMZ_MEM_HARD_MB=$PMZ_MEM_HARD_MB PMZ_SWAP_HARD_MB=$PMZ_SWAP_HARD_MB POCKETMZ_DEFAULT_FPS=${POCKETMZ_DEFAULT_FPS:-60} TOUCH=$POCKETMZ_TOUCH PMZ_GLDEBUG=$POCKETMZ_GLDEBUG PMZ_HINT=$PMZ_HINT PMZ_HINTMETRICS=$PMZ_HINTMETRICS PMZ_AA=$PMZ_AA PMZ_PROF=$PMZ_PROF PMZ_CPUPROF=$PMZ_CPUPROF PMZ_CPUPROF2=$PMZ_CPUPROF2 PMZ_CPUPROF3=$PMZ_CPUPROF3 PMZ_NOBLUR=$PMZ_NOBLUR PMZ_TEXT_TOL=$PMZ_TEXT_TOL SHOT2=${SHOT2:-} SHOT4=${SHOT4:-/opt/beta/shots/map-beta-play.png} MAPADV=${MAPADV:-0} TELEPORT=$TELEPORT SHOT5=${SHOT5:-/opt/beta/shots/map-beta-walk.png} SHOT3=${SHOT3:-/opt/beta/shots/map-beta.png} MAPHOLD=${MAPHOLD:-10000} SHOT=${SHOT:-/opt/beta/shots/title-beta.png} HOLD=$POCKETMZ_HOLD MAXSEC=$POCKETMZ_MAXSEC /usr/bin/node --max-old-space-size=256 --expose-gc ${PMZ_NODEFLAGS:---maglev} /opt/beta/pmzrun.js'
RC=$?
exit $RC
