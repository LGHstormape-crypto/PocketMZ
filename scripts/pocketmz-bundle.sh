#!/bin/sh
# Pack the PortMaster release package (β runtime default + NW.js fallback).
# Usage: pocketmz-bundle.sh [dir]   default /storage/PocketMZ-ports-<version>
#        Produces <dir>/PocketMZ.sh + <dir>/PocketMZ/{pocketmz.tar, VERSION}
#        Copy both PocketMZ.sh and PocketMZ/ into roms/ports/ and start PocketMZ from Ports.
set -e
RZ=/storage/pocketmz
VER=$(cat "$RZ/VERSION" 2>/dev/null || date +%Y%m%d)
[ "$1" = --ports ] && shift
BETA_ONLY=0
[ "$1" = --beta-only ] && { BETA_ONLY=1; shift; }
PORTS="${1:-/storage/PocketMZ-ports-$VER}"
OUT="$PORTS/PocketMZ/pocketmz.tar"
mkdir -p "$PORTS/PocketMZ"
[ "$BETA_ONLY" = 1 ] || [ -f "$RZ/rootfs.sqfs" ] || { echo "no $RZ/rootfs.sqfs" >&2; exit 1; }
[ -f "$RZ/beta-runtime.sqfs" ] || { echo "no $RZ/beta-runtime.sqfs (build with beta/beta-image.sh)" >&2; exit 1; }
cd "$RZ"
LIST=""
[ "$BETA_ONLY" = 1 ] || LIST="rootfs.sqfs"
for f in beta-runtime.sqfs VERSION patches launcher vendor ports README.md LICENSE THIRD-PARTY.txt pocketmz.gptk \
         pocketmz-run.sh pocketmz-menu.sh pocketmz-mkgame.sh pocketmz-chroot.sh pocketmz-install.sh pocketmz-maint.sh \
         pocketmz-uninstall.sh pocketmz-betascan.sh pocketmz-pack.sh pocketmz-licenses.sh \
         pocketmz-launcher.py pocketmz-library.py pocketmz-pad.py pocketmz-fonts.py \
         beta/beta-mount.sh beta/run-pmzrun.sh beta/beta-version.sh; do
  [ -e "$f" ] || { echo "missing $RZ/$f" >&2; exit 1; }
  LIST="$LIST $f"
done
[ -f pocketmz-probe.py ] && LIST="$LIST pocketmz-probe.py"
tar -cf "$OUT" --exclude=launcher/library --exclude=launcher/dev-sample --exclude=patches/PocketMZ_Debug.js $LIST
cp "$RZ/VERSION" "$PORTS/PocketMZ/VERSION"
cp "$RZ/ports/PocketMZ.sh" "$PORTS/PocketMZ.sh"
chmod +x "$PORTS/PocketMZ.sh"
echo "Ports package: $PORTS (copy PocketMZ.sh and PocketMZ/ into roms/ports/)"
ls -la "$OUT"
