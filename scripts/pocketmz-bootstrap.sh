#!/bin/bash
# SPDX-License-Identifier: MIT
# PocketMZ launcher for a system image (install it as /usr/bin/pocketmz). The runtime itself is
# not in the image: it lives in /storage/pocketmz and is installed / updated from a package
# (pocketmz.tar). This script installs it on first use when a package is found.
# Usage: pocketmz [menu]          game menu (Tools > PocketMZ)
#        pocketmz settings        settings screen (Tools > PocketMZ Settings)
#        pocketmz scan            add new games to the RPGMZ list
#        pocketmz run <launcher>  start a game (ES system RPGMZ command)
RZ=/storage/pocketmz
. /etc/profile >/dev/null 2>&1
notify() { [ -x /usr/bin/sdl2notify ] && /usr/bin/sdl2notify --center "$1" 255 255 255 "${2:-3}"; echo "$1"; }
PKG_PLACES="/storage/roms/ports/PocketMZ/pocketmz.tar /storage/downloads/pocketmz.tar /storage/roms/pocketmz.tar
/storage/roms/rpgmaker/pocketmz.tar /storage/roms/rpgmz/pocketmz.tar /storage/pocketmz.tar"
if [ ! -x "$RZ/pocketmz-run.sh" ]; then
  PKG=""; for p in $PKG_PLACES; do [ -f "$p" ] && { PKG="$p"; break; }; done
  if [ -z "$PKG" ]; then
    notify "PocketMZ is not installed.\nPut pocketmz.tar in roms/ports/PocketMZ/\nor downloads/, then start again." 6
    exit 1
  fi
  notify "Installing PocketMZ..." 3 &
  NEW=/storage/pocketmz-new
  rm -rf "${NEW:?}"; mkdir -p "$NEW"
  MODE=--menu   # with the ES system "RPGMZ" the scan writes launchers; otherwise games are picked in the menu
  grep -qs "<name>rpgmz</name>" /storage/.config/emulationstation/es_systems_*.cfg /usr/config/emulationstation/es_systems*.cfg && MODE=""
  if tar -xf "$PKG" -C "$NEW" && sh "$NEW/pocketmz-install.sh" $MODE > /storage/pocketmz-install.log 2>&1; then
    rm -rf "${NEW:?}"
  else
    rm -rf "${NEW:?}"; notify "PocketMZ: install failed\n/storage/pocketmz-install.log" 6; exit 1
  fi
fi
case "${1:-menu}" in
  menu)     exec "$RZ/pocketmz-menu.sh" ;;
  settings) exec "$RZ/pocketmz-settings.sh" ;;
  scan)     exec "$RZ/pocketmz-scan.sh" ;;
  run)      shift; exec "$RZ/pocketmz-run.sh" "$@" ;;
  *)        sed -n '6,10p' "$0"; exit 1 ;;
esac
