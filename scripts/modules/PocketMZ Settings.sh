#!/bin/bash
# SPDX-License-Identifier: MIT
# Tools entry: PocketMZ settings (game defaults, scan, saves export, update, uninstall).
. /etc/profile >/dev/null 2>&1
# ES runs Tools scripts in a foot terminal; hide it so it cannot cover the menu
swaymsg "[pid=${PPID}] move container to workspace gkd-hidden" >/dev/null 2>&1
if [ -x /usr/bin/pocketmz ]; then exec /usr/bin/pocketmz settings; fi
exec /storage/pocketmz/pocketmz-settings.sh
