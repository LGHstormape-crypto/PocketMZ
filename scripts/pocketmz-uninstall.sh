#!/bin/sh
# Remove the RPG Maker MV/MZ runtime. Saves are copied out first.
# Usage: pocketmz-uninstall.sh          show what would happen
#        pocketmz-uninstall.sh --yes    do it
# Saves of every game go to /storage/pocketmz-saves-<date>/<id>/ (the original game folders were
# never written to and stay as they are). Removes the Ports entries / launchers made by
# pocketmz-scan.sh, the ES system file and Tools entry added by pocketmz-install.sh --es, and
# /storage/pocketmz (runtime image, thin copies, browser profile, maintenance rootfs).
RZ=/storage/pocketmz
KEEP=/storage/pocketmz-saves-$(date +%Y%m%d-%H%M%S)
if pidof nw >/dev/null 2>&1; then echo "a game is running - quit it first" >&2; exit 1; fi
echo "saves -> $KEEP:"
for g in "$RZ"/games/*/; do
  id=$(basename "$g")
  for s in "$g/game/save" "$g/game/www/save"; do
    [ -d "$s" ] && [ -n "$(ls -A "$s")" ] && echo "  $id: $(ls "$s" | wc -l) files"
  done
done
echo "Ports entries:"; grep -l "^# pocketmz:" /storage/roms/ports/*.sh 2>/dev/null | sed 's/^/  /'
echo "launchers:"; ls /storage/roms/rpgmz/*.rpgmz 2>/dev/null | sed 's/^/  /'
echo "delete: $RZ ($(du -sh "$RZ" 2>/dev/null | cut -f1))"
[ "$1" = --yes ] || { echo "run again with --yes to do it"; exit 0; }

for g in "$RZ"/games/*/; do
  id=$(basename "$g")
  for s in "$g/game/save" "$g/game/www/save"; do
    [ -d "$s" ] && [ -n "$(ls -A "$s")" ] && { mkdir -p "$KEEP/$id"; cp -a "$s/." "$KEEP/$id/"; }
  done
done
[ -d "$KEEP" ] && echo "saves kept in $KEEP"
"$RZ/pocketmz-scan.sh" --remove
# what pocketmz-install.sh --es added to the user config (files of a system image are not touched)
rm -f /storage/.config/emulationstation/es_systems_pocketmz.cfg "/storage/.config/modules/Scan PocketMZ Games.sh"
rmdir /storage/roms/rpgmz 2>/dev/null
"$RZ/pocketmz-chroot.sh" umount all 2>/dev/null
grep -q " $RZ/" /proc/mounts && { echo "still mounted under $RZ - reboot and run again" >&2; exit 1; }
rm -rf "$RZ"
echo "removed $RZ"
