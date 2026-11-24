#!/bin/bash
# SPDX-License-Identifier: MIT
# PocketMZ - RPG Maker MV/MZ runner for PortMaster / ROCKNIX handhelds (β runtime default).
# In-game menu: Select + X   |   Quit game: Select + Start
# Install: place PocketMZ.sh and the PocketMZ folder (pocketmz.tar, VERSION) into roms/ports/.
# Games: place RPG Maker MV/MZ game folders into roms/rpgmaker/ (subfolders = categories).
. /etc/profile >/dev/null 2>&1
PKG="$(cd "$(dirname "$0")" && pwd)/PocketMZ"
RZ=/storage/pocketmz
notify() { [ -x /usr/bin/sdl2notify ] && /usr/bin/sdl2notify --center "$1" 255 255 255 "${2:-2}"; }
if [ -f "$PKG/pocketmz.tar" ] && { [ ! -x "$RZ/pocketmz-menu.sh" ] || ! cmp -s "$PKG/VERSION" "$RZ/VERSION"; }; then
  if pidof nw >/dev/null 2>&1 || pidof node >/dev/null 2>&1; then
    notify "PocketMZ: quit the running game first" 3
    exit 1
  fi
  notify "PocketMZ\nInstalling $(cat "$PKG/VERSION" 2>/dev/null)...\nPlease wait" 5 &
  NEW=/storage/pocketmz-new
  rm -rf "$NEW"; mkdir -p "$NEW"
  if tar -xf "$PKG/pocketmz.tar" -C "$NEW" && sh "$NEW/pocketmz-install.sh" --menu > /storage/pocketmz-install.log 2>&1; then
    rm -rf "$NEW"
  else
    notify "PocketMZ: install failed\n/storage/pocketmz-install.log" 5
    exit 1
  fi
fi
[ -x "$RZ/pocketmz-menu.sh" ] || { notify "PocketMZ is not installed\n(missing PocketMZ/pocketmz.tar)" 5; exit 1; }
exec "$RZ/pocketmz-menu.sh"
