#!/bin/sh
# Install (or update) the RPG Maker MV/MZ runtime from an extracted bundle into /storage/pocketmz.
# Usage: sh pocketmz-install.sh [--es]     (run from the extracted bundle folder)
# Existing games/ (saves), home/ (browser profile) and rootfs/ are kept; a bundle made with --beta also brings beta-runtime.sqfs + beta/*.sh (merged into beta/). Then scans for games.
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
  [ -f "$FROM/beta-runtime.sqfs" ] && [ -x "$RZ/beta/beta-mount.sh" ] && "$RZ/beta/beta-mount.sh" umount 2>/dev/null || true   # the β image is replaced below
  for f in "$FROM"/*; do
    n=$(basename "$f")
    case "$n" in games|home|rootfs) continue ;; esac
    if [ "$n" = beta ]; then   # β runtime scripts: merge file by file, the dev folder beta/ (overlays, logs, shots) must stay
      [ -x "$RZ/beta/beta-mount.sh" ] && "$RZ/beta/beta-mount.sh" umount 2>/dev/null || true
      mkdir -p "$RZ/beta"
      for bf in "$f"/*; do cp -a "$bf" "$RZ/beta/$(basename "$bf").new" && mv -f "$RZ/beta/$(basename "$bf").new" "$RZ/beta/$(basename "$bf")"; done
      continue
    fi
    if [ "$n" = launcher ] && [ -d "$RZ/launcher/library" ]; then   # keep the menu's state and covers
      rm -rf "$RZ/launcher.new"; cp -a "$f" "$RZ/launcher.new"; rm -rf "$RZ/launcher.new/library"
      mv "$RZ/launcher/library" "$RZ/launcher.new/library"; rm -rf "$RZ/launcher"; mv "$RZ/launcher.new" "$RZ/launcher"
      continue
    fi
    rm -rf "$RZ/$n.new"; cp -a "$f" "$RZ/$n.new"; rm -rf "$RZ/$n"; mv "$RZ/$n.new" "$RZ/$n"
  done
fi
chmod +x "$RZ"/*.sh "$RZ/gkd-thermal" 2>/dev/null || true
[ -f "$RZ/beta-runtime.sqfs" ] && echo "β runtime installed: default runtime is auto (falls back to nw when needed)"
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
# Add/update PocketMZ features in ES's es_features.cfg if present
if [ -f "$RZ/es_features_pocketmz.cfg" ] && [ -d "$ESCFG" ]; then
  ESF="$ESCFG/es_features.cfg"
  if [ -L "$ESF" ] && [ -f "$ESF" ]; then cp -fL "$ESF" "$ESF.tmp" && rm -f "$ESF" && mv -f "$ESF.tmp" "$ESF"; fi
  if [ -f "$ESF" ]; then
    awk -v blk="$RZ/es_features_pocketmz.cfg" '
      BEGIN {
        in_b=0
        while ((getline line < blk) > 0) {
          if (line ~ /<emulator name="pocketmz"/) in_b=1
          if (in_b) { em = (em ? em "\n" : "") line }
          if (in_b && line ~ /<\/emulator>/) break
        }
        close(blk)
      }
      /<emulator name="pocketmz"/ { skip=1; next }
      skip && /<\/emulator>/ { skip=0; next }
      skip { next }
      /^<\/features>/ { if (em) print em }
      { print }
    ' "$ESF" > "$ESF.tmp" && mv -f "$ESF.tmp" "$ESF"
  fi
fi
[ $MENU = 1 ] || "$RZ/pocketmz-scan.sh"   # --menu: games are started from the PocketMZ menu instead
if [ $MENU = 1 ]; then echo "installed in $RZ. Put MV/MZ game folders in /storage/roms/rpgmaker; they show up in the PocketMZ menu."
else echo "installed in $RZ. Put MV/MZ game folders in /storage/roms/rpgmaker and run $RZ/pocketmz-scan.sh"; fi
