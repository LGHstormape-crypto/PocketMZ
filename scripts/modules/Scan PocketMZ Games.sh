#!/bin/bash
# SPDX-License-Identifier: MIT
# Tools entry (PocketMZ): find RPG Maker MV/MZ games in /storage/roms/rpgmaker (and roms/easyrpg) and list
# them under "RPGMZ" in EmulationStation. Same flow as "Scan ScummVM Games".
. /etc/profile
clear
/usr/bin/sdl2notify --center "Scanning \n PocketMZ Games" 255 255 255 2
/storage/pocketmz/pocketmz-scan.sh >/storage/pocketmz/scan.log 2>&1
n=$(grep -c "^added:" /storage/pocketmz/scan.log)
clear
/usr/bin/sdl2notify --center "Scanning Complete \n $n new" 255 255 255 2
systemctl restart ${UI_SERVICE}
