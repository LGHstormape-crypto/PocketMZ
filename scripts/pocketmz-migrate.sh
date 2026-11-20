#!/bin/sh
# One-time move of an installation made before the PocketMZ name: /storage/rpgmz -> /storage/pocketmz.
# Usage (on the handheld, no game running): sh pocketmz-migrate.sh <folder with the new files>
#   The folder holds the new package files (scripts, patches/, modules/, LICENSE ...), e.g. an
#   extracted bundle. Saves (games/<id>/game/save), thin copies, browser profiles (home/), the
#   runtime image and the maintenance rootfs move along unchanged.
# Afterwards: old scripts / GKD_* patches removed, Ports entries of the old name replaced
# (pocketmz-scan.sh), release mode (no dev flag). Thin copies are rebuilt at the next start.
set -e
OLD=/storage/rpgmz; NEW=/storage/pocketmz; FROM="${1:?usage: $0 <folder with the new files>}"
FROM=$(cd "$FROM" && pwd)
pidof nw >/dev/null 2>&1 && { echo "a game is running - quit it first" >&2; exit 1; }
[ -d "$OLD" ] || { echo "nothing to move: no $OLD" >&2; exit 1; }
[ -e "$NEW" ] && { echo "$NEW exists already" >&2; exit 1; }
[ -f "$FROM/pocketmz-run.sh" ] || { echo "no pocketmz-run.sh in $FROM" >&2; exit 1; }
# unmount the image and bind mounts of the old place
[ -x "$OLD/rpgmz-chroot.sh" ] && "$OLD/rpgmz-chroot.sh" umount all 2>/dev/null || true
if grep -q " $OLD/" /proc/mounts; then echo "still mounted under $OLD - reboot and run again" >&2; exit 1; fi
mv "$OLD" "$NEW"
cd "$NEW"
# old program files (data folders games/ home/ rootfs/ and rootfs.sqfs stay)
rm -f rpgmz-*.sh rpgmz-*.js rpgmz-*.py es_systems_rpgmz.cfg rpgmz.gptk dev stop-es
rm -f patches/GKD_*.js "modules/Scan RPG Maker MV-MZ Games.sh"
# new program files
for f in "$FROM"/*; do
  n=$(basename "$f")
  case "$n" in games|home|rootfs|rootfs.sqfs|root-sqfs) continue ;; esac
  rm -rf "$NEW/$n.new"; cp -a "$f" "$NEW/$n.new"; rm -rf "$NEW/$n"; mv "$NEW/$n.new" "$NEW/$n"
done
sed -i 's/\r$//' "$NEW"/*.sh "$NEW"/modules/*.sh 2>/dev/null || true
chmod +x "$NEW"/*.sh "$NEW"/modules/*.sh "$NEW/gkd-thermal" 2>/dev/null || true
"$NEW/pocketmz-scan.sh"
echo "moved to $NEW"
