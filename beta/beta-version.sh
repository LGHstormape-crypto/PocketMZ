#!/bin/sh
# Device side: print the β build version = first 8 hex digits of the md5 over the runtime files in the overlay (pmzrun.js, overlay.js, pmzrt/*.js without test-*.js, pmzrt.node).
# The root is the one in PMZ_ROOTDIR (default root24; the launcher passes auto = release image rt, else root24), so the hash covers the files actually run.
# Used by pocketmz-run.sh for games/<id>/beta-status.json: a mark written by an older β build is ignored. Prints nothing (exit 1) when β is not installed.
RZ="${POCKETMZ_DATA:-/storage/pocketmz}"; B="$RZ/beta"; R=$($B/beta-mount.sh ${PMZ_ROOTDIR:-root24}) || exit 1
D=$R/opt/beta; [ -f $D/pmzrun.js ] && [ -f $D/pmzrt/pmzrt.node ] || exit 1
cat $D/pmzrun.js $D/overlay.js $(ls $D/pmzrt/*.js | grep -v '/test-') $D/pmzrt/pmzrt.node 2>/dev/null | md5sum | cut -c1-8
