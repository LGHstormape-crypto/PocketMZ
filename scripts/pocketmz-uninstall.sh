#!/bin/sh
# Remove the RPG Maker MV/MZ runtime. Any unmigrated saves are merged into /storage/roms/savestates/rpgmz/<id>/save/
# (game-card saves in /storage/roms/savestates/rpgmz/ and original games stay untouched).
RZ=/storage/pocketmz
SAVE_BASE=/storage/roms/savestates/rpgmz
if pidof nw >/dev/null 2>&1 || pidof node >/dev/null 2>&1; then echo "a game is running - quit it first" >&2; exit 1; fi
echo "saves kept in $SAVE_BASE (unmigrated saves merged there):"
for g in "$RZ"/games/*/; do
  id=$(basename "$g")
  for s in "$g/game/save" "$g/game/www/save"; do
    [ -d "$s" ] && [ -n "$(ls -A "$s" 2>/dev/null)" ] && echo "  $id: $(ls "$s" | wc -l) files"
  done
done
echo "Ports entries:"; grep -l "^# pocketmz:" /storage/roms/ports/*.sh 2>/dev/null | sed 's/^/  /'
echo "launchers:"; ls /storage/roms/rpgmz/*.rpgmz 2>/dev/null | sed 's/^/  /'
echo "delete: $RZ ($(du -sh "$RZ" 2>/dev/null | cut -f1))"
[ "$1" = --yes ] || { echo "run again with --yes to do it"; exit 0; }

for g in "$RZ"/games/*/; do
  id=$(basename "$g")
  for s in "$g/game/save" "$g/game/www/save"; do
    if [ -d "$s" ] && [ -n "$(ls -A "$s" 2>/dev/null)" ]; then
      mkdir -p "$SAVE_BASE/$id/save"
      for f in "$s"/* "$s"/.[!.]*; do [ -e "$f" ] && [ ! -e "$SAVE_BASE/$id/save/$(basename "$f")" ] && cp -r "$f" "$SAVE_BASE/$id/save/"; done
    fi
  done
done
echo "saves kept in $SAVE_BASE"
"$RZ/pocketmz-scan.sh" --remove
# what pocketmz-install.sh --es added to the user config (files of a system image are not touched)
rm -f /storage/.config/emulationstation/es_systems_pocketmz.cfg "/storage/.config/modules/Scan PocketMZ Games.sh" "/storage/.config/modules/PocketMZ.sh" "/storage/.config/modules/PocketMZ Settings.sh"
rmdir /storage/roms/rpgmz 2>/dev/null
"$RZ/pocketmz-chroot.sh" umount all 2>/dev/null
grep -q " $RZ/" /proc/mounts && { echo "still mounted under $RZ - reboot and run again" >&2; exit 1; }
rm -rf "$RZ"
echo "removed $RZ"
