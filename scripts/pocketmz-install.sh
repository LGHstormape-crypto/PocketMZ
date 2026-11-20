#!/bin/sh
# Install (or update) the RPG Maker MV/MZ runtime from an extracted bundle into /storage/pocketmz.
# Usage: sh pocketmz-install.sh [--es]     (run from the extracted bundle folder)
# Existing games/ (saves), home/ (browser profile) and rootfs/ are kept. Then scans for games.
# --es: also add the ES system "RPGMZ" (run by PocketMZ) and the Tools entry "Scan PocketMZ Games"
#       in the user config (for a stock ROCKNIX; a system image can ship them instead, see
#       INTEGRATION.md). Without it games are listed in Ports, unless the system is already there.
# --menu: no Ports entry per game (installed from the Ports package: games are picked in the
#       PocketMZ menu, roms/ports/PocketMZ.sh).
set -e
RZ=/storage/pocketmz
ES=0; MENU=0
for a in "$@"; do case "$a" in --es) ES=1 ;; --menu) MENU=1 ;; esac; done
FROM=$(cd "$(dirname "$0")" && pwd)
. /etc/profile >/dev/null 2>&1 || true
if pidof nw >/dev/null 2>&1; then echo "a game is running - quit it first" >&2; exit 1; fi
mkdir -p "$RZ/games" "$RZ/home"
if [ "$FROM" != "$RZ" ]; then
  [ -x "$RZ/pocketmz-chroot.sh" ] && "$RZ/pocketmz-chroot.sh" umount all 2>/dev/null || true
  for f in "$FROM"/*; do
    n=$(basename "$f")
    case "$n" in games|home|rootfs) continue ;; esac
    if [ "$n" = launcher ] && [ -d "$RZ/launcher/library" ]; then   # keep the menu's state and covers
      rm -rf "$RZ/launcher.new"; cp -a "$f" "$RZ/launcher.new"; rm -rf "$RZ/launcher.new/library"
      mv "$RZ/launcher/library" "$RZ/launcher.new/library"; rm -rf "$RZ/launcher"; mv "$RZ/launcher.new" "$RZ/launcher"
      continue
    fi
    rm -rf "$RZ/$n.new"; cp -a "$f" "$RZ/$n.new"; rm -rf "$RZ/$n"; mv "$RZ/$n.new" "$RZ/$n"
  done
fi
chmod +x "$RZ"/*.sh "$RZ/gkd-thermal" 2>/dev/null || true
rm -f "$RZ/dev"                      # release mode: no debug REPL plugin in the games
if [ "$(get_setting gpu.driver 2>/dev/null)" != panfrost ]; then
  echo "NOTE: set the GPU driver to panfrost (ES: System Settings -> GPU DRIVER) and reboot;"
  echo "      the games need it (libmali gives the browser no WebGL)."
fi
ESCFG=/storage/.config/emulationstation
if [ $ES = 1 ]; then
  cp "$RZ/es_systems_pocketmz.cfg" "$ESCFG/es_systems_pocketmz.cfg"
  mkdir -p /storage/.config/modules /storage/roms/rpgmz
  for m in "PocketMZ.sh" "PocketMZ Settings.sh"; do
    cp "$RZ/modules/$m" "/storage/.config/modules/$m"; chmod +x "/storage/.config/modules/$m"
  done
  rm -f "/storage/.config/modules/Scan PocketMZ Games.sh"   # scanning is in PocketMZ Settings now
  echo "ES system RPGMZ and Tools entries PocketMZ / PocketMZ Settings added (restart ES to see them)"
fi
[ $MENU = 1 ] || "$RZ/pocketmz-scan.sh"   # --menu: games are started from the PocketMZ menu instead
if [ $MENU = 1 ]; then echo "installed in $RZ. Put MV/MZ game folders in /storage/roms/rpgmaker; they show up in the PocketMZ menu."
else echo "installed in $RZ. Put MV/MZ game folders in /storage/roms/rpgmaker and run $RZ/pocketmz-scan.sh"; fi
