#!/bin/bash
# SPDX-License-Identifier: MIT
# PocketMZ game menu: list the games, start the chosen one, come back to the menu when it ends.
# Started by roms/ports/PocketMZ.sh. Leaving the menu (B -> Exit, or Select+Start) returns to ES.
# The menu is an NW.js page ($RZ/launcher) run by pocketmz-run.sh --menu; it writes its choice to
# $RZ/launcher/library/choice.json ({"action":"play","id","dir"} or {"action":"exit"}).
# The game list is rebuilt in the background while the browser starts (the menu shows the
# previous list at once and takes the new one when library.json changes).
PMZ="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"   # program files
RZ="${POCKETMZ_DATA:-/storage/pocketmz}"                 # data (menu state and covers)
L="$RZ/launcher/library"
mkdir -p "$L"
. /etc/profile >/dev/null 2>&1
refresh_lang() {
  local sl=""
  [ -f "$RZ/settings.json" ] && sl=$(grep -o '"language": *"[^"]*"' "$RZ/settings.json" 2>/dev/null | head -1 | cut -d'"' -f4)
  case "$sl" in
    zh|en|ja) POCKETMZ_UI_LANG="$sl" ;;
    *) POCKETMZ_UI_LANG="$(get_setting system.language 2>/dev/null)"; [ -z "$POCKETMZ_UI_LANG" ] && POCKETMZ_UI_LANG="${LANG:-zh_CN}" ;;
  esac
  export POCKETMZ_UI_LANG
  case "$POCKETMZ_UI_LANG" in
    ja*) T_BACK="PocketMZ に戻っています…" ;;
    zh*) T_BACK="正在返回 PocketMZ…" ;;
    *)   T_BACK="Returning to PocketMZ…" ;;
  esac
}
refresh_lang
note() { command -v mako-notify >/dev/null && mako-notify "$1" >/dev/null 2>&1; }
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/var/run/0-runtime-dir}" WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}"
export SWAYSOCK="${SWAYSOCK:-$XDG_RUNTIME_DIR/sway-ipc.0.sock}"
# The menu: native SDL2 (pocketmz-launcher.py, opens in ~1 s, reads the pad itself) when the
# system's SDL2 libraries load; else the HTML page in NW.js (pocketmz-run.sh --menu, ~20 s).
# POCKETMZ_HTML_MENU=1 forces the HTML one.
# same pad mapping as the games (generated from ES es_input.cfg by pocketmz-pad.py)
GCDB=$(python3 "$PMZ/pocketmz-pad.py" 2>/dev/null || true)
[ -n "$GCDB" ] && [ -f "$GCDB" ] && export SDL_GAMECONTROLLERCONFIG_FILE="$GCDB"
LAUNCHER_ARGS=""
for a in "$@"; do
  [ "$a" = "--settings" ] && LAUNCHER_ARGS="--settings"
done
NATIVE=0
[ "${POCKETMZ_HTML_MENU:-0}" != 1 ] && PYSDL2_DLL_PATH=/usr/lib python3 -c   "import sys; sys.path.insert(0, '$PMZ/vendor'); import sdl2, sdl2.sdlttf, sdl2.sdlimage" >/dev/null 2>&1 && NATIVE=1
run_menu() {
  if [ $NATIVE = 1 ]; then
    ( for i in $(seq 1 40); do sleep 0.25; swaymsg '[app_id="pocketmz-menu"] focus' >/dev/null 2>&1 && break; done ) &
    PYSDL2_DLL_PATH=/usr/lib SDL_VIDEODRIVER=wayland python3 "$PMZ/pocketmz-launcher.py" "$L" $LAUNCHER_ARGS > "$RZ/games/_menu.log" 2>&1
  else
    "$PMZ/pocketmz-run.sh" --menu
  fi
}
while :; do
  python3 "$PMZ/pocketmz-library.py" "$L" > "$L/scan.log" 2>&1 &
  SCAN=$!
  rm -f "$L/choice.json"
  run_menu
  wait "$SCAN" 2>/dev/null
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
  refresh_lang
  note "$T_BACK"
done
exit 0
