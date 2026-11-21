#!/bin/sh
# Pack the maintenance rootfs directory into a compressed read-only image.
# Usage: pocketmz-pack.sh            (run after apt changes in the rootfs directory)
# Test images: POCKETMZ_PACK_OUT=/storage/pocketmz/test.sqfs POCKETMZ_PACK_COMP='-comp lz4 -Xhc -b 32K'
# Cold start reads ~3x fewer bytes from the slow SD card (zstd, 4 CPUs decompress).
set -e
RZ=/storage/pocketmz
ROOT="$RZ/rootfs"
OUT="${POCKETMZ_PACK_OUT:-$RZ/rootfs.sqfs}"
COMP="${POCKETMZ_PACK_COMP:--comp zstd -Xcompression-level 15 -b 128K}"
"$RZ/pocketmz-chroot.sh" umount all 2>/dev/null || true
mount --bind /proc "$ROOT/proc"; mount --bind /sys "$ROOT/sys"
rm -f "$ROOT/var/tmp/rootfs.sqfs"
# Left out of the image (they stay in the maintenance directory):
# - mounts, temp, apt caches, docs (as before)
# - things nothing uses at run time: translations, vim, unicode tables, locale sources, udev hwdb,
#   scipy/sympy/numpy/mpmath (pulled in as recommends of python3-fonttools; font subsetting
#   needs only fontTools), NW.js UI languages other than ja / zh-CN / zh-TW / en-US
# POCKETMZ_PACK_FULL=1 keeps the second group.
# license notices of everything in the image (usr/share/doc is left out below): third-party/ is kept
"$RZ/pocketmz-licenses.sh" "$ROOT" >/dev/null || { echo "license notices failed" >&2; umount "$ROOT/proc" "$ROOT/sys"; exit 1; }
cp -f "$ROOT/usr/share/pocketmz/third-party/README.txt" "$RZ/THIRD-PARTY.txt"
EX="$ROOT/var/tmp/pocketmz-pack.exclude"
{
  printf '%s\n' 'proc/*' 'sys/*' 'dev/*' 'run/*' 'tmp/*' 'game/*' 'gamesrc/*' 'root/*' 'root/.*' \
    'var/tmp/*' 'var/cache/apt/*' 'var/lib/apt/lists/*' 'usr/share/doc/*' 'usr/share/man/*' opt/nwtest
  if [ "$POCKETMZ_PACK_FULL" != 1 ]; then
    printf '%s\n' 'usr/share/locale/*' 'usr/share/vim/*' 'usr/share/unicode/*' 'usr/share/i18n/*' \
      'usr/share/info/*' 'usr/share/lintian/*' usr/lib/udev/hwdb.bin \
      usr/lib/python3/dist-packages/scipy usr/lib/python3/dist-packages/sympy \
      usr/lib/python3/dist-packages/numpy usr/lib/python3/dist-packages/mpmath
    for f in "$ROOT"/opt/nwjs/locales/*; do
      n=$(basename "$f")
      case "$n" in ja.pak*|zh-CN.pak*|zh-TW.pak*|en-US.pak*) ;; *) echo "opt/nwjs/locales/$n" ;; esac
    done
  fi
} > "$EX"
chroot "$ROOT" /usr/bin/mksquashfs / /var/tmp/rootfs.sqfs -noappend -quiet -no-progress \
  $COMP -wildcards -ef /var/tmp/pocketmz-pack.exclude || { rm -f "$EX"; umount "$ROOT/proc" "$ROOT/sys"; exit 1; }
rm -f "$EX"
umount "$ROOT/proc" "$ROOT/sys"
mv -f "$ROOT/var/tmp/rootfs.sqfs" "$OUT"
ls -la "$OUT"
