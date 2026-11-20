#!/bin/bash
# SPDX-License-Identifier: MIT
# Start the PocketMZ settings screen (pocketmz-settings.py, native SDL2) with the display, pad
# mapping and language set up like the game menu. Started by "pocketmz settings" / Tools.
PMZ="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
. /etc/profile >/dev/null 2>&1
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/var/run/0-runtime-dir}" WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}"
export SWAYSOCK="${SWAYSOCK:-$XDG_RUNTIME_DIR/sway-ipc.0.sock}" POCKETMZ_UI_LANG="$(get_setting system.language 2>/dev/null)"
[ -f /storage/roms/ports/PortMaster/control.txt ] && { source /storage/roms/ports/PortMaster/control.txt; get_controls; } >/dev/null 2>&1
( for i in $(seq 1 40); do sleep 0.25; swaymsg '[app_id="pocketmz-settings"] focus' >/dev/null 2>&1 && break; done ) &
PYSDL2_DLL_PATH=/usr/lib SDL_VIDEODRIVER=wayland exec python3 "$PMZ/pocketmz-settings.py" "$@"
