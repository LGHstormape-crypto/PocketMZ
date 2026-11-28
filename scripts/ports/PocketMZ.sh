#!/bin/bash
# SPDX-License-Identifier: MIT
# PocketMZ - RPG Maker MV/MZ runner for PortMaster / ROCKNIX / Anbernic Stock OS (β runtime default).
# In-game menu: Select + X   |   Quit game: Select + Start
# Install: place PocketMZ.sh and the PocketMZ folder (pocketmz.tar, VERSION) into roms/ports/.
# Games: place RPG Maker MV/MZ game folders into roms/rpgmaker/ (subfolders = categories).
. /etc/profile >/dev/null 2>&1 || true

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG="$SCRIPT_DIR/PocketMZ"
PORTS_PARENT="$(cd "$SCRIPT_DIR/.." 2>/dev/null && pwd)"
export POCKETMZ_PKG="$PKG" PORTS_PARENT

# Always save a copy of logs onto the SD card (PocketMZ/logs/) so users without SSH can report issues.
LOGDIR="$PKG/logs"
mkdir -p "$LOGDIR" 2>/dev/null || true
LOG="$PKG/pocketmz-last.log"
[ -f "$LOG" ] && mv -f "$LOG" "$PKG/pocketmz-prev.log" 2>/dev/null || true
export POCKETMZ_LOGDIR="$LOGDIR"
exec > "$LOG" 2>&1

echo "=== PocketMZ start $(date) ==="
echo "script=$0 pkg=$PKG ports_parent=$PORTS_PARENT uid=$(id -u) user=$(id -un 2>/dev/null)"
echo "uname=$(uname -a)"
echo "env DISPLAY=$DISPLAY WAYLAND_DISPLAY=$WAYLAND_DISPLAY XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR SDL_VIDEODRIVER=$SDL_VIDEODRIVER"
df -h / /storage "$SCRIPT_DIR" 2>/dev/null || df -h 2>/dev/null || true
ls -la /dev/fb* /dev/dri /dev/mali* /dev/input/event* 2>/dev/null || true
ls -ld /storage /storage/roms /roms "$PORTS_PARENT"/* 2>/dev/null || true
ls -la /roms/ports/PortMaster/libs* /usr/lib/aarch64-linux-gnu/libSDL2* 2>/dev/null | head -n 40 || true
ls -la /mnt/vendor/lib /usr/lib/libSDL2* /usr/lib/libEGL* /usr/lib/libMali* /usr/lib/libmali* 2>/dev/null | head -n 40 || true
echo "filesystems: $(awk '{print $NF}' /proc/filesystems 2>/dev/null | tr '\n' ' ')"

# Source PortMaster control.txt if available (sets $ESUDO / $controlfolder / $directory on Stock OS, muOS, ArkOS, etc.)
for ct in "$SCRIPT_DIR/PortMaster/control.txt" "$PORTS_PARENT/ports/PortMaster/control.txt" /opt/system/Tools/PortMaster/control.txt /roms/ports/PortMaster/control.txt /mnt/mmc/MUOS/PortMaster/control.txt; do
  if [ -f "$ct" ]; then
    echo "control.txt: $ct"
    . "$ct" >/dev/null 2>&1 || true
    break
  fi
done

# Re-exec as root if needed and sudo -n is available (required for loop mount / chroot on Stock OS)
if [ "$(id -u)" != 0 ] && [ -z "$PMZ_ELEVATED" ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    echo "elevating via sudo -n"
    export PMZ_ELEVATED=1
    exec sudo -n -E bash "$0" "$@"
  fi
fi

# Detect POCKETMZ_DATA, POCKETMZ_ROMS, POCKETMZ_SAVE_BASE
if [ -f "$PKG/pocketmz-env.sh" ]; then
  . "$PKG/pocketmz-env.sh"
else
  # Fallback before first install if pocketmz-env.sh is only inside pocketmz.tar
  if [ -d /storage ] && [ -w /storage ] && [ "$(df -Pm /storage 2>/dev/null | awk 'NR==2 {print $4}')" -ge 180 ] 2>/dev/null; then
    export POCKETMZ_DATA="${POCKETMZ_DATA:-/storage/pocketmz}"
  elif [ -d "${HOME:-/root}" ] && [ -w "${HOME:-/root}" ] && [ "$(df -Pm "${HOME:-/root}" 2>/dev/null | awk 'NR==2 {print $4}')" -ge 180 ] 2>/dev/null; then
    export POCKETMZ_DATA="${POCKETMZ_DATA:-${HOME:-/root}/.pocketmz}"
  else
    export POCKETMZ_DATA="${POCKETMZ_DATA:-/tmp/pocketmz}"
  fi
fi
RZ="$POCKETMZ_DATA"
echo "resolved POCKETMZ_DATA=$RZ POCKETMZ_ROMS=$POCKETMZ_ROMS POCKETMZ_SAVE_BASE=$POCKETMZ_SAVE_BASE"

notify() { [ -x /usr/bin/sdl2notify ] && /usr/bin/sdl2notify --center "$1" 255 255 255 "${2:-2}" >/dev/null 2>&1; echo "NOTIFY: $1"; }

if [ -f "$PKG/pocketmz.tar" ] && { [ ! -x "$RZ/pocketmz-menu.sh" ] || ! cmp -s "$PKG/VERSION" "$RZ/VERSION" 2>/dev/null; }; then
  if pidof nw >/dev/null 2>&1 || pidof node >/dev/null 2>&1; then
    notify "PocketMZ: quit the running game first" 3
    exit 1
  fi
  notify "PocketMZ\nInstalling $(cat "$PKG/VERSION" 2>/dev/null)...\nPlease wait" 5 &
  NEW="${RZ}-new"
  rm -rf "$NEW" 2>/dev/null || true
  mkdir -p "$NEW" || { echo "ERROR: cannot create $NEW"; exit 1; }
  if tar -xf "$PKG/pocketmz.tar" -C "$NEW" && sh "$NEW/pocketmz-install.sh" --menu > "$LOGDIR/install.log" 2>&1; then
    rm -rf "$NEW"
    cat "$LOGDIR/install.log"
    # Re-resolve env now that pocketmz-env.sh is installed
    [ -f "$RZ/pocketmz-env.sh" ] && . "$RZ/pocketmz-env.sh"
  else
    echo "ERROR: install failed, see $LOGDIR/install.log"
    cat "$LOGDIR/install.log" 2>/dev/null || true
    notify "PocketMZ: install failed\nSee PocketMZ/logs/install.log" 5
    exit 1
  fi
fi

[ -x "$RZ/pocketmz-menu.sh" ] || { notify "PocketMZ is not installed\n(missing PocketMZ/pocketmz.tar)" 5; exit 1; }
"$RZ/pocketmz-menu.sh"
RC=$?
echo "pocketmz-menu.sh exited rc=$RC"
[ -f "$RZ/games/_menu.log" ] && cp -f "$RZ/games/_menu.log" "$LOGDIR/menu.log" 2>/dev/null || true
exit $RC
