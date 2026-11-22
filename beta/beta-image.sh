#!/bin/sh
# Build the β runtime image (release): /storage/pocketmz/beta-runtime-<date>.sqfs (+ hard link beta-runtime.sqfs, the name beta-mount.sh rt and the bundle use).
# The image is a squashfs that layers OVER the α rootfs image (overlay: lowerdir = beta image : root-sqfs): only what β needs at run time and
# what is not already identical in α: Node 24 + libnode + its libs, forky libc6 (whole package, ld.so and libc must match), SDL2, sndio, vorbisfile,
# ICU 78 ..., plus /opt/beta (pmzrun.js, overlay.js, effect-lifetimes.json, pmzrt/*.js, pmzrt.node, patches/PocketMZ_Debug.js; no tests, shots, node_modules).
# No compilers, headers, -dev packages, apt lists / caches, docs, man pages, locales.
# Usage (PC):     beta/beta-image.sh        pushes the sources and runs the build on the handheld (needs ssh gkd-rocknix, no game running)
#       (device): beta-image.sh --device    (called by the PC side; source files in /storage/pocketmz/beta/imgsrc)
# Input = the dev overlay root24 (Node 24 + libs from Debian forky, pmzrt.node built there by pmzrt/deploy.sh); compared against α (rootfs.sqfs mounted on root-sqfs).
# How the file list is made: ldd of node + pmzrt.node (+ a few libs SDL / Mesa load with dlopen, +the Node 24 packages) -> owning Debian packages (dpkg info lists)
# -> all their regular files / symlinks except docs, man, locales, headers, .a, pkg-config -> minus files identical in α (same symlink target / same bytes).
# Then ldconfig is run in a scratch overlay (stage : α) to regenerate /etc/ld.so.cache, and ldd + `require(pmzrt.node)` are checked there before squashing.
# Compression is the same as pocketmz-pack.sh uses for rootfs.sqfs (mksquashfs from the root24 chroot, zstd level 15, 128K blocks); override: BETA_IMG_COMP.
H=gkd-rocknix; RZ=/storage/pocketmz; B=$RZ/beta; SRC=$B/imgsrc; W=$B/imgwork
if [ "$1" != --device ]; then
  cd "$(dirname "$0")" || exit 1
  ssh $H "rm -rf $SRC; mkdir -p $SRC/pmzrt $SRC/patches" || exit 1
  scp -q pmzrun.js overlay.js effect-lifetimes.json beta-image.sh beta-mount.sh $H:$SRC/ \
    && scp -q $(ls pmzrt/*.js | grep -v '/test-') $H:$SRC/pmzrt/ && scp -q ../patches/PocketMZ_Debug.js $H:$SRC/patches/ || exit 1
  ssh $H "sed -i 's/\r\$//' $SRC/*.sh; chmod +x $SRC/beta-image.sh; $SRC/beta-image.sh --device"
  exit $?
fi

# ---------------------------------------------------------------- device side
[ -n "$(pidof nw)$(pidof node)" ] && { echo "a game (nw/node) is running, abort"; exit 1; }
DATE=$(date +%Y%m%d); OUT=$RZ/beta-runtime-$DATE.sqfs; A=$RZ/root-sqfs; ST=$W/stage
COMP="${BETA_IMG_COMP:--comp zstd -Xcompression-level 15 -b 128K}"
[ -f $RZ/rootfs.sqfs ] || { echo "no $RZ/rootfs.sqfs (the image is built against it)"; exit 1; }
grep -q " $A " /proc/mounts || mount -t squashfs -o loop,ro $RZ/rootfs.sqfs $A || exit 1
R=$($B/beta-mount.sh root24) || { echo "root24 not mounted"; exit 1; }
[ -f $R/opt/beta/pmzrt/pmzrt.node ] || { echo "no pmzrt.node in root24 (run pmzrt/deploy.sh)"; exit 1; }
rm -rf $W; mkdir -p $ST $W/up $W/work $W/mnt || exit 1
trap 'umount -l $W/mnt 2>/dev/null; rm -rf $W' EXIT

python3 - "$R" "$A" "$ST" "$SRC" "$W/report.txt" <<'PY' || exit 1
import os, sys, shutil, filecmp, subprocess, time
R, A, ST, SRC, REP = sys.argv[1:6]
def norm(p):
    for d in ('lib', 'bin', 'sbin', 'lib64'):
        if p == '/' + d or p.startswith('/' + d + '/'): return '/usr' + p
    return p
# dpkg: path -> owning packages, package -> paths
info = os.path.join(R, 'var/lib/dpkg/info'); own = {}; plist = {}
for f in os.listdir(info):
    if not f.endswith('.list'): continue
    pk = f[:-5]; plist[pk] = []
    for line in open(os.path.join(info, f), errors='replace'):
        p = norm(line.rstrip('\n')); plist[pk].append(p); own.setdefault(p, []).append(pk)
def ldd(f):
    out = subprocess.run(['chroot', R, 'ldd', f], stdout=subprocess.PIPE, universal_newlines=True).stdout
    r = []
    for l in out.splitlines():
        t = l.split('=>')[-1].split()
        if t and t[0].startswith('/'): r.append(norm(t[0]))
    return r
libs = set()
for f in ('/usr/bin/node', '/opt/beta/pmzrt/pmzrt.node'): libs.update(ldd(f))
pk = set()
for l in libs:
    o = own.get(l) or own.get(norm(os.path.realpath(R + l)[len(R):]))
    if not o: print('WARN no package owns', l)
    else: pk.update(o)
# not in ldd: loaded with dlopen by SDL2 / Mesa / the Node 24 internals (files identical to α are dropped below, so listing too much is harmless)
EXTRA = ('libc6:arm64 libc-bin libssl3t64:arm64 libfreetype6:arm64 nodejs libnode137:arm64 node-acorn node-cjs-module-lexer node-undici node-minimatch '
         'node-brace-expansion node-balanced-match node-xtend libegl1:arm64 libegl-mesa0:arm64 libgles2:arm64 libglvnd0:arm64 libgbm1:arm64 libgl1-mesa-dri:arm64 '
         'libglx-mesa0:arm64 libdrm2:arm64 libdecor-0-0:arm64 libdecor-0-plugin-1-cairo:arm64 libwayland-client0:arm64 libwayland-egl1:arm64 libwayland-cursor0:arm64 '
         'libxkbcommon0:arm64 libpulse0:arm64 libasound2t64:arm64').split()
for e in EXTRA:
    for c in (e, e + ':arm64', e.split(':')[0]):
        if c in plist: pk.add(c); break
SKIP = ('/usr/share/doc/', '/usr/share/man/', '/usr/share/info/', '/usr/share/locale/', '/usr/share/lintian/', '/usr/share/bug/', '/usr/share/pkgconfig/',
        '/usr/include/', '/usr/lib/debug/', '/usr/share/gdb/', '/usr/share/bash-completion/', '/usr/share/menu/', '/usr/share/pixmaps/', '/usr/share/zsh/')
def skip(p): return p.startswith(SKIP) or p.endswith('.a') or '/pkgconfig/' in p
def same(p):
    r, a = R + p, A + p
    if os.path.islink(r): return os.path.islink(a) and os.readlink(a) == os.readlink(r)
    return os.path.isfile(a) and not os.path.islink(a) and os.path.getsize(a) == os.path.getsize(r) and filecmp.cmp(r, a, shallow=False)
def mkparents(p):
    d = os.path.dirname(p)
    if d in ('', '/') or os.path.isdir(ST + d): return
    mkparents(d); os.mkdir(ST + d)
    s = os.stat(R + d); os.chmod(ST + d, s.st_mode & 0o7777); os.chown(ST + d, s.st_uid, s.st_gid)
def put(p, src=None):
    mkparents(p)
    if src is None and os.path.islink(R + p): os.symlink(os.readlink(R + p), ST + p); os.lchown(ST + p, 0, 0); return
    shutil.copy2(src or R + p, ST + p)
tot = 0; rep = []
for k in sorted(pk):
    n = 0; sz = 0
    for p in plist[k]:
        r = R + p
        if skip(p) or not os.path.lexists(r) or (os.path.isdir(r) and not os.path.islink(r)): continue
        if os.path.exists(ST + p) or os.path.islink(ST + p): continue
        if same(p): continue
        put(p); n += 1; sz += 0 if os.path.islink(r) else os.path.getsize(r)
    tot += sz; rep.append((sz, k, n))
rep.sort(reverse=True)
with open(REP, 'w') as f:
    for sz, k, n in rep:
        if n: f.write('%9.1f KB %5d files  %s\n' % (sz / 1024, n, k))
    f.write('packages: %d, payload %.1f MB\n' % (len(pk), tot / 1048576))
# /opt/beta: sources pushed from the PC + pmzrt.node as built in the overlay
def putf(rel, src):
    p = '/opt/beta/' + rel; mkparents(p); shutil.copyfile(src, ST + p); os.chmod(ST + p, 0o755 if rel.endswith('.node') else 0o644)
for rel in ('pmzrun.js', 'overlay.js', 'effect-lifetimes.json', 'patches/PocketMZ_Debug.js'): putf(rel, os.path.join(SRC, rel))
for f in sorted(os.listdir(os.path.join(SRC, 'pmzrt'))): putf('pmzrt/' + f, os.path.join(SRC, 'pmzrt', f))
putf('pmzrt/pmzrt.node', R + '/opt/beta/pmzrt/pmzrt.node')
os.makedirs(ST + '/opt/beta/shots', exist_ok=True)   # mount point of the shots dir (the image is read-only: mkdir -p of an existing dir works)
open(ST + '/opt/beta/IMAGE', 'w').write('beta-runtime %s\nbuilt against %s\npackages: %s\n' % (time.strftime('%Y-%m-%d'), 'rootfs.sqfs', ' '.join(sorted(pk))))
PY
cat $W/report.txt | head -25

# scratch overlay stage:α -> ldconfig (ld.so.cache) -> check that node and pmzrt.node load
unshare -m sh -c "
  mount --make-rprivate / &&
  mount -t overlay overlay -o lowerdir=$ST:$A,upperdir=$W/up,workdir=$W/work $W/mnt &&
  mount --bind /proc $W/mnt/proc && mount --bind /dev $W/mnt/dev && mount --bind /sys $W/mnt/sys &&
  chroot $W/mnt ldconfig &&
  if chroot $W/mnt ldd /usr/bin/node /opt/beta/pmzrt/pmzrt.node | grep -i 'not found'; then echo 'MISSING LIBS'; exit 1; fi &&
  chroot $W/mnt /usr/bin/node -e \"require('/opt/beta/pmzrt/pmzrt.node'); console.log('node', process.version, 'pmzrt.node loads')\"
" || { echo "verification failed"; exit 1; }
[ -z "$(find $W/up -type c)" ] || { echo "whiteouts in the scratch upper dir"; exit 1; }
cp -a $W/up/. $ST/ || exit 1
rm -rf $ST/proc/* $ST/dev/* $ST/sys/* 2>/dev/null

# squash (mksquashfs lives in the root24 chroot, as for pocketmz-pack.sh)
unshare -m sh -c "mount --make-rprivate / && mount --bind $W $R/mnt && chroot $R /usr/bin/mksquashfs /mnt/stage /mnt/out.sqfs -noappend -quiet -no-progress $COMP" || { echo "mksquashfs failed"; exit 1; }
mv -f $W/out.sqfs $OUT && ln -f $OUT $RZ/beta-runtime.sqfs || exit 1
ls -la $OUT $RZ/beta-runtime.sqfs
echo "image: $(du -h $OUT | cut -f1)  ($OUT)"
