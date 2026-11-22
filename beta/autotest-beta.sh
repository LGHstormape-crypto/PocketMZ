#!/bin/sh
# PC side: seeded 4-minute autotest on the β runtime (same pocketmz-autotest.sh / driver / summary as α; compare "trace: hash=" with an NW.js run).
# Usage: PMZ_GAME_ID=<id> autotest-beta.sh [minutes=4] [seed=12345] [nw]   (MZ or MV; 3rd arg "nw" runs the NW.js reference for comparison)
# PMZ_ROOTDIR=rt runs on the release image (default root24 = dev overlay).
# Needs the scripts deployed (scripts/deploy.sh pocketmz-test.sh pocketmz-autotest.sh) and ./deploy-pmzrun.sh run once for the current pmzrun.js.
ID="$PMZ_GAME_ID"; [ -n "$ID" ] || { echo "set PMZ_GAME_ID=<id>" >&2; exit 2; }
M=${1:-4}; SEED=${2:-12345}; RT=beta; PROC=node; [ "$3" = nw ] && { RT=nw; PROC=nw; }
ssh gkd-rocknix "[ -z \"\$(pidof nw)\$(pidof node)\" ] || { echo 'a game is running, abort'; exit 1; }; PMZ_ROOTDIR=$PMZ_ROOTDIR POCKETMZ_RUNTIME=$RT POCKETMZ_PROC=$PROC AT_SEED=$SEED /storage/pocketmz/pocketmz-autotest.sh $ID $M play"
