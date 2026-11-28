#!/bin/bash
# SPDX-License-Identifier: MIT
# PocketMZ game menu: list the games, start the chosen one, come back to the menu when it ends.
# Started by roms/ports/PocketMZ.sh. Leaving the menu (B -> Exit, or Select+Start) returns to ES.
PMZ="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"   # program files
[ -f "$PMZ/pocketmz-env.sh" ] && . "$PMZ/pocketmz-env.sh"
RZ="${POCKETMZ_DATA:-/storage/pocketmz}"                 # data (menu state and covers)
L="$RZ/launcher/library"
mkdir -p "$L" "$RZ/games"
. /etc/profile >/dev/null 2>&1 || true
refresh_lang() {
  local sl=""
  [ -f "$RZ/settings.json" ] && sl=$(grep -o '"language": *"[^"]*"' "$RZ/settings.json" 2>/dev/null | head -1 | cut -d'"' -f4)
  case "$sl" in
    zh|en|ja) POCKETMZ_UI_LANG="$sl" ;;
    *) POCKETMZ_UI_LANG="$(get_setting system.language 2>/dev/null || true)"; [ -z "$POCKETMZ_UI_LANG" ] && POCKETMZ_UI_LANG="${LANG:-zh_CN}" ;;
  esac
  export POCKETMZ_UI_LANG
  case "$POCKETMZ_UI_LANG" in
    ja*) T_BACK="PocketMZ に戻っています…" ;;
    zh*) T_BACK="正在返回 PocketMZ…" ;;
    *)   T_BACK="Returning to PocketMZ…" ;;
  esac
}
refresh_lang
note() { command -v mako-notify >/dev/null 2>&1 && mako-notify "$1" >/dev/null 2>&1 || true; }
copy_log() {
  [ -n "$POCKETMZ_LOGDIR" ] && [ -d "$POCKETMZ_LOGDIR" ] && [ -f "$1" ] && cp -f "$1" "$POCKETMZ_LOGDIR/$2" 2>/dev/null || true
}
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/var/run/0-runtime-dir}"

# Detect SDL video driver: Wayland socket -> X11 -> KMS/DRM
if [ -z "$SDL_VIDEODRIVER" ]; then
  _wd="${WAYLAND_DISPLAY:-wayland-1}"
  if [ -S "$XDG_RUNTIME_DIR/$_wd" ]; then
    export WAYLAND_DISPLAY="$_wd" SWAYSOCK="${SWAYSOCK:-$XDG_RUNTIME_DIR/sway-ipc.0.sock}" SDL_VIDEODRIVER=wayland
  elif [ -n "$DISPLAY" ]; then
    export SDL_VIDEODRIVER=x11
  elif [ -e /dev/dri/card0 ]; then
    export SDL_VIDEODRIVER=kmsdrm
  fi
fi

# Detect SDL2 shared library directory (prefer PortMaster bundled libs if present, else ROCKNIX /usr/lib and Debian aarch64)
if [ -z "$PYSDL2_DLL_PATH" ]; then
  _dll=""
  for _d in ${PM_LIBDIR:-} /roms/ports/PortMaster/libs.aarch64 /roms/ports/PortMaster/libs /opt/system/Tools/PortMaster/libs.aarch64 /mnt/mmc/Roms/PORTS/PortMaster/libs.aarch64 /usr/lib /usr/lib/aarch64-linux-gnu /usr/local/lib /lib/aarch64-linux-gnu; do
    [ -d "$_d" ] || continue
    if ls "$_d"/libSDL2*.so* >/dev/null 2>&1; then
      _dll="${_dll:+$_dll:}$_d"
    fi
  done
  export PYSDL2_DLL_PATH="${_dll:-/usr/lib}"
fi
echo "menu env: RZ=$RZ SDL_VIDEODRIVER=${SDL_VIDEODRIVER:-auto} PYSDL2_DLL_PATH=$PYSDL2_DLL_PATH LD_LIBRARY_PATH=${LD_LIBRARY_PATH:-}"

GCDB=$(python3 "$PMZ/pocketmz-pad.py" 2>/dev/null || true)
[ -n "$GCDB" ] && [ -f "$GCDB" ] && export SDL_GAMECONTROLLERCONFIG_FILE="$GCDB"
LAUNCHER_ARGS=""
for a in "$@"; do
  [ "$a" = "--settings" ] && LAUNCHER_ARGS="--settings"
done
NATIVE=0
if [ "${POCKETMZ_HTML_MENU:-0}" != 1 ]; then
  SDL_PROBE_ERR=$(PYSDL2_DLL_PATH="$PYSDL2_DLL_PATH" python3 -c "import sys; sys.path.insert(0, '$PMZ/vendor'); import sdl2, sdl2.sdlttf" 2>&1) && NATIVE=1
  [ $NATIVE = 0 ] && echo "native SDL2 menu unavailable: $SDL_PROBE_ERR"
fi
run_menu() {
  if [ $NATIVE = 1 ]; then
    if [ "$SDL_VIDEODRIVER" = wayland ] && command -v swaymsg >/dev/null 2>&1; then
      ( for i in $(seq 1 40); do sleep 0.25; swaymsg '[app_id="pocketmz-menu"] focus' >/dev/null 2>&1 && break; done ) &
    fi
    python3 "$PMZ/pocketmz-launcher.py" "$L" $LAUNCHER_ARGS > "$RZ/games/_menu.log" 2>&1
    local rc=$?
    copy_log "$RZ/games/_menu.log" "menu.log"
    [ $rc -ne 0 ] && echo "pocketmz-launcher.py exited rc=$rc (see logs/menu.log)"
    return $rc
  elif [ -f "$RZ/rootfs.sqfs" ] || [ -d "$RZ/rootfs" ]; then
    "$PMZ/pocketmz-run.sh" --menu
  else
    echo "ERROR: PySDL2 failed and no NW.js rootfs.sqfs present for HTML fallback"
    return 1
  fi
}
MENU_RC=0
while :; do
  python3 "$PMZ/pocketmz-library.py" "$L" > "$L/scan.log" 2>&1 &
  SCAN=$!
  rm -f "$L/choice.json"
  run_menu || { MENU_RC=$?; copy_log "$L/scan.log" "scan.log"; break; }
  wait "$SCAN" 2>/dev/null
  copy_log "$L/scan.log" "scan.log"
  [ -f "$L/choice.json" ] || break          # closed without a choice (Select+Start, error)
  CHOICE=$(python3 - "$L/choice.json" <<'PY'
import json, shlex, sys
try:
    c = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    c = {}
print(" ".join("%s=%s" % (k.upper(), shlex.quote(str(c.get(k, "")))) for k in ("action", "dir", "id")))
PY
)
  eval "$CHOICE"
  refresh_lang
  [ "$ACTION" = play ] && [ -d "$DIR" ] || break
  "$PMZ/pocketmz-run.sh" "$DIR" "$ID"
  copy_log "$RZ/games/$ID/run.log" "last-game-run.log"
  refresh_lang
  note "$T_BACK"
done
exit $MENU_RC
