#!/bin/sh
# Install (or update) the RPG Maker MV/MZ runtime from an extracted bundle into /storage/pocketmz.
# Usage: sh pocketmz-install.sh [--menu]   (run from the extracted bundle folder)
# Existing games/ (saves), home/ (browser profile) and rootfs/ are kept.
# Includes β runtime (beta-runtime.sqfs + beta/*.sh) and NW.js fallback (rootfs.sqfs).
set -e
RZ=/storage/pocketmz
FROM=$(cd "$(dirname "$0")" && pwd)
. /etc/profile >/dev/null 2>&1 || true
if pidof nw >/dev/null 2>&1 || pidof node >/dev/null 2>&1; then
  echo "a game is running - quit it first" >&2
  exit 1
fi
mkdir -p "$RZ/games" "$RZ/home"
if [ "$FROM" != "$RZ" ]; then
  [ -x "$RZ/pocketmz-chroot.sh" ] && "$RZ/pocketmz-chroot.sh" umount all 2>/dev/null || true
  [ -f "$FROM/beta-runtime.sqfs" ] && [ -x "$RZ/beta/beta-mount.sh" ] && "$RZ/beta/beta-mount.sh" umount 2>/dev/null || true   # the β image is replaced below
  for f in "$FROM"/*; do
    n=$(basename "$f")
    case "$n" in games|home|rootfs) continue ;; esac
    if [ "$n" = beta ]; then   # β runtime scripts: merge file by file, dev dirs if any stay intact
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
chmod +x "$RZ"/*.sh 2>/dev/null || true
[ -f "$RZ/beta-runtime.sqfs" ] && echo "β runtime installed (default runtime: auto -> β first, NW.js fallback)"
rm -f "$RZ/dev"                      # release mode: no debug REPL plugin in the games
rm -f "$RZ/pocketmz-hotkeys.py" "$RZ/gkd-thermal" "$RZ/pocketmz-scan.sh" "$RZ/pocketmz-bootstrap.sh" "$RZ/pocketmz-settings.py"
mkdir -p /storage/roms/rpgmaker
echo "installed in $RZ. Put MV/MZ game folders in /storage/roms/rpgmaker and start PocketMZ from Ports."
