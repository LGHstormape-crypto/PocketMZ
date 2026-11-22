#!/bin/sh
# Pack the maintenance rootfs directory into a compressed read-only squashfs image.
# Usage: pocketmz-pack.sh            (run after apt changes in the rootfs directory)
# Default (slim whitelist): extracts only the runtime binaries, shared libs (ldd + dlopen),
# trimmed NW.js (no swiftshader/vulkan/.pak.info/crashpad/200pct), NotoSansCJK-Regular font
# (POCKETMZ_KEEP_BOLD=1 keeps Bold), pure-Python fontTools (run by host python3), xkb/fonts/
# glvnd/drirc configs, and third-party license notices. No GTK3/Adwaita, python3.13, systemd,
# udev, apt, vim, perl, or lapack. If $POCKETMZ_MESA_DIR (default /storage/pocketmz/mesa-panfrost)
# contains an LLVM-free panfrost-only Mesa build, it replaces Debian Mesa and drops libLLVM + libz3.
# POCKETMZ_PACK_FULL=1 falls back to the legacy whole-directory pack.
# Compression: zstd level 19, 256K blocks (smaller & faster cold start than zstd-15 128K).
set -e
RZ=/storage/pocketmz
ROOT="$RZ/rootfs"
OUT="${POCKETMZ_PACK_OUT:-$RZ/rootfs.sqfs}"
COMP="${POCKETMZ_PACK_COMP:--comp zstd -Xcompression-level 19 -b 256K}"
MESA_DIR="${POCKETMZ_MESA_DIR:-$RZ/mesa-panfrost}"
KEEP_BOLD="${POCKETMZ_KEEP_BOLD:-0}"

"$RZ/pocketmz-chroot.sh" umount all 2>/dev/null || true
mount --bind /proc "$ROOT/proc"; mount --bind /sys "$ROOT/sys"
cleanup_pack() {
  rm -rf "$ROOT/var/tmp/rootfs.sqfs" "$ROOT/var/tmp/pocketmz-pack.exclude" "$RZ/.pack-stage" 2>/dev/null || true
  umount "$ROOT/proc" "$ROOT/sys" 2>/dev/null || true
}
trap cleanup_pack EXIT

# License notices of everything in the maintenance rootfs (third-party/ is copied into the image)
"$RZ/pocketmz-licenses.sh" "$ROOT" >/dev/null || { echo "license notices failed" >&2; exit 1; }
cp -f "$ROOT/usr/share/pocketmz/third-party/README.txt" "$RZ/THIRD-PARTY.txt"

if [ "$POCKETMZ_PACK_FULL" = 1 ]; then
  EX="$ROOT/var/tmp/pocketmz-pack.exclude"
  printf '%s\n' 'proc/*' 'sys/*' 'dev/*' 'run/*' 'tmp/*' 'game/*' 'gamesrc/*' 'root/*' 'root/.*' \
    'var/tmp/*' 'var/cache/apt/*' 'var/lib/apt/lists/*' 'usr/share/doc/*' 'usr/share/man/*' opt/nwtest > "$EX"
  chroot "$ROOT" /usr/bin/mksquashfs / /var/tmp/rootfs.sqfs -noappend -quiet -no-progress \
    $COMP -wildcards -ef /var/tmp/pocketmz-pack.exclude
  mv -f "$ROOT/var/tmp/rootfs.sqfs" "$OUT"
  ls -lh "$OUT"
  exit 0
fi

STAGE="$RZ/.pack-stage"
rm -rf "$STAGE"
python3 - "$ROOT" "$STAGE" "$MESA_DIR" "$KEEP_BOLD" <<'PY'
import glob, os, shutil, subprocess, sys

SRC, STAGE, MESA_DIR, KEEP_BOLD = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
USE_SLIM_MESA = bool(MESA_DIR) and os.path.isdir(MESA_DIR + "/usr/lib/aarch64-linux-gnu")

def norm(p):
    for d in ("lib", "bin", "sbin", "lib64"):
        if p == "/" + d or p.startswith("/" + d + "/"):
            return "/usr" + p
    return p

def mkparents(dst_rel):
    d = os.path.dirname(dst_rel)
    if d in ("", "/") or os.path.isdir(STAGE + d):
        return
    mkparents(d)
    os.makedirs(STAGE + d, exist_ok=True)
    if os.path.isdir(SRC + d):
        os.chmod(STAGE + d, os.stat(SRC + d).st_mode & 0o7777)

def copy_one(rel, root=SRC):
    rel = "/" + rel.lstrip("/")
    sp = root + rel
    dp = STAGE + rel
    if not os.path.lexists(sp) or os.path.lexists(dp):
        return
    mkparents(rel)
    if os.path.islink(sp):
        target = os.readlink(sp)
        os.symlink(target, dp)
        t_rel = target if target.startswith("/") else os.path.normpath(os.path.join(os.path.dirname(rel), target))
        copy_one(t_rel, root)
    elif os.path.isdir(sp):
        os.makedirs(dp, exist_ok=True)
    else:
        shutil.copy2(sp, dp)

def copy_tree(rel_dir, skip_fn=None, root=SRC):
    base = root + rel_dir
    if not os.path.isdir(base):
        return
    for r, dirs, files in os.walk(base):
        rel_r = r[len(root):]
        if skip_fn:
            dirs[:] = [d for d in dirs if not skip_fn(rel_r + "/" + d, True)]
        for fn in files:
            rel = rel_r + "/" + fn
            if skip_fn and skip_fn(rel, False):
                continue
            copy_one(rel, root)

def copy_glob(pattern, root=SRC):
    for full in glob.glob(root + pattern):
        if os.path.isdir(full) and not os.path.islink(full):
            continue
        copy_one(full[len(root):], root)

def collect_ldd(paths):
    seen, queue, libs = set(), list(paths), set()
    while queue:
        f = queue.pop()
        if f in seen:
            continue
        seen.add(f)
        if not os.path.exists(SRC + f):
            continue
        r = subprocess.run(["chroot", SRC, "/usr/bin/ldd", f], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        for line in r.stdout.splitlines():
            rhs = line.split("=>", 1)[1].strip().split() if "=>" in line else line.strip().split()
            if rhs and rhs[0].startswith("/"):
                p = norm(rhs[0])
                if USE_SLIM_MESA and os.path.basename(p).startswith(("libLLVM", "libz3", "libgallium-")):
                    continue
                if p not in libs:
                    libs.add(p)
                    queue.append(p)
    return libs

os.makedirs(STAGE, exist_ok=True)
for d in ("bin", "sbin", "lib", "lib64"):
    if os.path.islink(SRC + "/" + d):
        os.symlink(os.readlink(SRC + "/" + d), STAGE + "/" + d)
for d in ("dev", "dev/pts", "dev/shm", "proc", "sys", "run", "tmp", "root", "game", "gamesrc", "mnt", "var/tmp"):
    os.makedirs(STAGE + "/" + d, exist_ok=True)
os.symlink("/run", STAGE + "/var/run")
os.chmod(STAGE + "/tmp", 0o1777)

# 1. Minimal binaries
for b in ("/usr/bin/env", "/usr/bin/dash", "/usr/bin/sh", "/usr/bin/fc-cache", "/usr/sbin/ldconfig", "/usr/sbin/ldconfig.real"):
    copy_one(b)

# 2. Trimmed NW.js (no swiftshader/vulkan, no .pak.info build manifests, no crashpad, no 200% hidpi pak)
nw_drop = {
    "/opt/nwjs/chrome_crashpad_handler",
    "/opt/nwjs/nw_200_percent.pak",
    "/opt/nwjs/lib/libvk_swiftshader.so",
    "/opt/nwjs/lib/libvulkan.so.1",
    "/opt/nwjs/lib/vk_swiftshader_icd.json",
}
keep_loc = ("ja.pak", "zh-CN.pak", "zh-TW.pak", "en-US.pak")
def nw_skip(rel, is_dir):
    if is_dir and rel == "/opt/nwjs/swiftshader":
        return True
    if rel in nw_drop or rel.endswith(".pak.info"):
        return True
    if not is_dir and rel.startswith("/opt/nwjs/locales/") and os.path.basename(rel) not in keep_loc:
        return True
    return False
copy_tree("/opt/nwjs", nw_skip)

# 3. Mesa (prefer LLVM-free panfrost-only build from MESA_DIR if present)
L = "/usr/lib/aarch64-linux-gnu"
roots = [
    "/opt/nwjs/nw", "/opt/nwjs/lib/libnw.so", "/opt/nwjs/lib/libnode.so",
    "/opt/nwjs/lib/libffmpeg.so", "/opt/nwjs/lib/libGLESv2.so", "/opt/nwjs/lib/libEGL.so",
    "/usr/bin/env", "/usr/bin/dash", "/usr/bin/fc-cache",
]
if USE_SLIM_MESA:
    print("using LLVM-free Mesa from", MESA_DIR)
    copy_tree(L, lambda r, is_dir: (is_dir and os.path.basename(r) == "pkgconfig") or r.endswith((".a", ".la")), root=MESA_DIR)
    copy_tree("/usr/share/glvnd", root=MESA_DIR)
    copy_tree("/usr/share/drirc.d", root=MESA_DIR)
    # Keep glvnd dispatchers & libGLESv2 from Debian (Mesa provides libEGL_mesa + libgbm + libgallium + dri + gbm)
    mesa_globs = [f"{L}/libEGL.so*", f"{L}/libGLESv2.so*", f"{L}/libGLdispatch.so*"]
else:
    mesa_globs = [
        f"{L}/libEGL.so*", f"{L}/libEGL_mesa.so*", f"{L}/libGLESv2.so*",
        f"{L}/libGLdispatch.so*", f"{L}/libgbm.so*", f"{L}/gbm/*.so*", f"{L}/libgallium-*.so",
        f"{L}/dri/libdril_dri.so", f"{L}/dri/panfrost_dri.so", f"{L}/dri/rockchip_dri.so",
        f"{L}/dri/kms_swrast_dri.so", f"{L}/dri/swrast_dri.so",
    ]

dlopen_globs = mesa_globs + [
    f"{L}/libwayland-client.so*", f"{L}/libwayland-egl.so*", f"{L}/libwayland-cursor.so*",
    f"{L}/libwayland-server.so*", f"{L}/libxkbcommon.so*",
    f"{L}/libpulse.so*", f"{L}/libpulse-simple.so*", f"{L}/pulseaudio/libpulsecommon-*.so",
    f"{L}/libasound.so*", f"{L}/alsa-lib/*.so",
    f"{L}/libsoftokn3.*", f"{L}/libfreeblpriv3.*", f"{L}/libnssckbi.so*", f"{L}/libnssdbm3.*",
    f"{L}/libnss_files.so*", f"{L}/libnss_dns.so*",
    f"{L}/libpangocairo-1.0.so*", f"{L}/libpangoft2-1.0.so*", f"{L}/libpango-1.0.so*",
    f"{L}/libcairo.so*", f"{L}/libfontconfig.so*", f"{L}/libfreetype.so*",
    f"{L}/libharfbuzz.so*", f"{L}/libfribidi.so*",
    f"{L}/libpng16.so*", f"{L}/libjpeg.so*", f"{L}/libwebp.so*", f"{L}/libsharpyuv.so*",
    f"{L}/libudev.so*", f"{L}/libdbus-1.so*", f"{L}/libdrm.so*", f"{L}/libexpat.so*", f"{L}/libzstd.so*", f"{L}/libstdc++.so*",
]
for pat in dlopen_globs:
    for full in glob.glob(SRC + pat):
        rel = full[len(SRC):]
        copy_one(rel)
        if rel.endswith(".so") or ".so." in os.path.basename(rel):
            roots.append(rel)

for p in sorted(collect_ldd(roots)):
    copy_one(p)
copy_glob(f"{L}/ld-linux-aarch64.so*")
copy_glob("/usr/lib/ld-linux-aarch64.so*")

# 4. Runtime configs, xkb, fonts, C.utf8 locale, certs, licenses, pure-Python fontTools
for f in ("/etc/passwd", "/etc/group", "/etc/hosts", "/etc/nsswitch.conf", "/etc/ld.so.conf", "/etc/ssl/certs/ca-certificates.crt"):
    copy_one(f)
copy_tree("/etc/ld.so.conf.d")
copy_tree("/etc/fonts")
copy_tree("/var/cache/fontconfig")
copy_tree("/usr/share/glvnd")
copy_tree("/usr/share/drirc.d")
copy_tree("/usr/share/X11/xkb")
copy_tree("/usr/share/zoneinfo")
copy_tree("/usr/lib/locale/C.utf8")
copy_tree("/usr/share/pocketmz")
copy_glob(f"{L}/gconv/gconv-modules*")
for enc in ("UTF-16.so", "UTF-32.so", "SHIFT_JISX0213.so", "SJIS.so", "CP932.so", "EUC-JP.so", "GB18030.so", "GBK.so", "BIG5.so", "ISO8859-1.so"):
    copy_one(f"{L}/gconv/{enc}")
copy_tree("/usr/lib/python3/dist-packages/fontTools",
          lambda r, is_dir: (is_dir and os.path.basename(r) == "__pycache__") or r.endswith((".c", ".so", ".pyc")))

copy_one("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")
if KEEP_BOLD:
    copy_one("/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc")

# Finalize caches & check shared libraries inside STAGE
subprocess.run(["chroot", STAGE, "/usr/sbin/ldconfig"], check=True)
subprocess.run(["chroot", STAGE, "/usr/bin/fc-cache", "-f"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
check_bins = ["/opt/nwjs/nw", "/opt/nwjs/lib/libnw.so", "/opt/nwjs/lib/libnode.so"]
if USE_SLIM_MESA:
    check_bins += [p[len(STAGE):] for p in glob.glob(STAGE + f"{L}/libgallium-*.so") + [STAGE + f"{L}/libEGL_mesa.so.0", STAGE + f"{L}/libgbm.so.1"] if os.path.exists(p)]
bad = []
for b in check_bins:
    r = subprocess.run(["chroot", STAGE, "/usr/bin/env", "LD_LIBRARY_PATH=/opt/nwjs/lib", "LD_TRACE_LOADED_OBJECTS=1", "/lib/ld-linux-aarch64.so.1", b],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for l in r.stdout.splitlines():
        if "not found" in l:
            bad.append(f"{b}: {l.strip()}")
if bad:
    print("MISSING LIBS:", "\n".join(bad), file=sys.stderr)
    sys.exit(1)

tot = sum(os.path.getsize(os.path.join(r, fn)) for r, _, fs in os.walk(STAGE) for fn in fs if not os.path.islink(os.path.join(r, fn)))
print(f"slim stage ready: {tot / 1048576:.1f} MB unpacked (slim_mesa={USE_SLIM_MESA}, bold={KEEP_BOLD})")
PY

unshare -m sh -c "
  mount --make-rprivate / &&
  mount --bind '$STAGE' '$ROOT/mnt' &&
  chroot '$ROOT' /usr/bin/mksquashfs /mnt /var/tmp/rootfs.sqfs -noappend -quiet -no-progress $COMP
"
mv -f "$ROOT/var/tmp/rootfs.sqfs" "$OUT"
ls -lh "$OUT"
