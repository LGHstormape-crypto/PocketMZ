#!/bin/bash
# SPDX-License-Identifier: MIT
# Compatibility wrapper: PocketMZ settings are now integrated into pocketmz-launcher.py (via pocketmz-menu.sh --settings).
PMZ="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
exec "$PMZ/pocketmz-menu.sh" --settings "$@"
