#!/bin/sh
# Pack the installed runtime into one tarball (e.g. to reinstall after reflashing the handheld).
# Usage: pocketmz-bundle.sh [out.tar]     default /storage/pocketmz-bundle-<date>.tar
#        pocketmz-bundle.sh --ports [dir]  a Ports package: <dir>/PocketMZ.sh + <dir>/PocketMZ/
#                                          (pocketmz.tar, VERSION), default /storage/PocketMZ-ports-<version>;
#                                          copy both into roms/ports, start PocketMZ from Ports
# Contains rootfs.sqfs (the Debian/NW.js image; third-party notices inside, summary THIRD-PARTY.txt), scripts, patches, README, LICENSE, the ES system
# file + Tools entry (es_systems_pocketmz.cfg, modules/) and pocketmz-install.sh.
# Not included: games/ (thin copies and saves), home/ (browser profile), rootfs/ (maintenance dir).
set -e
RZ=/storage/pocketmz
PORTS=""; [ "$1" = --ports ] && { PORTS="${2:-/storage/PocketMZ-ports-$(cat "$RZ/VERSION" 2>/dev/null || date +%Y%m%d)}"; set --; }
OUT="${1:-/storage/pocketmz-bundle-$(date +%Y%m%d).tar}"
[ -n "$PORTS" ] && OUT="$PORTS/PocketMZ/pocketmz.tar" && mkdir -p "$PORTS/PocketMZ"
[ -f "$RZ/rootfs.sqfs" ] || { echo "no $RZ/rootfs.sqfs" >&2; exit 1; }
cd "$RZ"
LIST=""
for f in rootfs.sqfs VERSION patches launcher vendor ports README.md LICENSE THIRD-PARTY.txt INTEGRATION.md es_systems_pocketmz.cfg modules pocketmz.gptk gkd-thermal *.sh *.py *.js; do [ -e "$f" ] && LIST="$LIST $f"; done
# the menu's user data (launcher/library) and the desktop preview sample are not packed
# old single-game dev tests and local helpers are not shipped (same as the public repository)
NOSHIP="pocketmz-abes.sh pocketmz-entrytest.sh pocketmz-maptest.sh pocketmz-memlog.sh pocketmz-proftest.sh pocketmz-soak.sh battery-log.sh"
EXCL=""; for n in $NOSHIP; do EXCL="$EXCL --exclude=$n"; done
tar -cf "$OUT" --exclude=launcher/library --exclude=launcher/dev-sample $EXCL $LIST
if [ -n "$PORTS" ]; then
  cp "$RZ/VERSION" "$PORTS/PocketMZ/VERSION"; cp "$RZ/ports/PocketMZ.sh" "$PORTS/PocketMZ.sh"; chmod +x "$PORTS/PocketMZ.sh"
  echo "Ports package: $PORTS (copy PocketMZ.sh and the PocketMZ folder into roms/ports)"
fi
ls -la "$OUT"
echo "install on a handheld: mkdir /storage/pocketmz-new && tar -xf $(basename "$OUT") -C /storage/pocketmz-new && sh /storage/pocketmz-new/pocketmz-install.sh"
