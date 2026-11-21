#!/bin/sh
# SPDX-License-Identifier: MIT
# Collect the third-party license notices of the runtime rootfs into /usr/share/pocketmz/third-party/
# (kept in the image; the full /usr/share/doc is not). Run by pocketmz-pack.sh before packing.
# Usage: pocketmz-licenses.sh [rootfs dir]          default /storage/pocketmz/rootfs
#   packages.tsv     every installed Debian package: name, version, source package, source version
#   copyright.txt.gz the Debian copyright file of every package (licenses and notices)
#   README.txt       what is in the image and where its source code is
ROOT="${1:-/storage/pocketmz/rootfs}"
D="$ROOT/usr/share/pocketmz/third-party"
[ -x "$ROOT/usr/bin/dpkg-query" ] || { echo "no Debian rootfs at $ROOT" >&2; exit 1; }
mkdir -p "$D"
chroot "$ROOT" /usr/bin/dpkg-query -W \
  -f '${Package}\t${Version}\t${source:Package}\t${source:Version}\n' | sort > "$D/packages.tsv"
{
  for p in $(cut -f1 "$D/packages.tsv" | sed 's/:.*//' | sort -u); do
    f="$ROOT/usr/share/doc/$p/copyright"
    echo "================================================================================"
    echo "Package: $p"
    echo "================================================================================"
    if [ -f "$f" ]; then cat "$f"; else echo "(no copyright file shipped by this package)"; fi
    echo
  done
} | gzip -9 > "$D/copyright.txt.gz"
NW=$(cat "$ROOT/opt/nwjs/VERSION" 2>/dev/null || echo "v0.120.0")
cat > "$D/README.txt" <<EOF
PocketMZ runtime image - third-party software
=============================================

This image contains unmodified third-party software. PocketMZ's own scripts and patches are MIT
licensed (see LICENSE in the PocketMZ bundle / repository); they are not part of this list.

1. Debian GNU/Linux 13 (trixie) arm64 packages ($(wc -l < "$D/packages.tsv") packages)
   - packages.tsv: package, version, source package, source version.
   - copyright.txt.gz: the copyright and license file of every package, as shipped by Debian
     (GPL, LGPL, BSD, MIT, Apache and other licenses; full texts of the common licenses are in
     Debian's base-files package: /usr/share/common-licenses in a Debian system).
   - Source code: every package is unmodified Debian; the corresponding source is available from
     the Debian archive for exactly these source versions, e.g.
       https://snapshot.debian.org/package/<source package>/<source version>/
       or: apt-get source <source package>=<source version>  (with deb-src enabled)

2. NW.js $NW linux-arm64, official unmodified build from dl.nwjs.io (NW.js: MIT license). It
   contains Chromium 157.0.8103.39 (BSD-3-Clause and the licenses of its third-party components)
   and Node.js v26.12.1 (MIT and the licenses of its dependencies). The official build ships only a
   placeholder /opt/nwjs/credits.html, so the third-party notices are those of the upstream sources:
     NW.js:    https://github.com/nwjs/nw.js (tag nw-$NW)
     Chromium: https://chromium.googlesource.com/chromium/src/+/refs/tags/157.0.8103.39
               (LICENSE and the README.chromium / LICENSE files of third_party/)
     Node.js:  https://github.com/nodejs/node/blob/v26.12.1/LICENSE

3. Fonts: Noto Sans CJK (SIL Open Font License 1.1), from the Debian package fonts-noto-cjk.

4. Outside the image, in the PocketMZ bundle: vendor/sdl2 = PySDL2 0.9.15 core modules (public domain,
   CC0 1.0 / zlib alternative; https://github.com/py-sdl/py-sdl2), used by the native menus.
EOF
ls -la "$D"
