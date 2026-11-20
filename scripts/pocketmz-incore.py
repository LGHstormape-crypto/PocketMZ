# Dev: which files of the chroot are in the page cache (run inside the chroot, read-only).
# Usage: chroot <root> python3 -I - < pocketmz-incore.py
import ctypes, os
libc = ctypes.CDLL("libc.so.6", use_errno=True)
libc.mmap.restype = ctypes.c_void_p
libc.mmap.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_long]
PAGE = os.sysconf("SC_PAGE_SIZE")
res = []
for top in ("/usr", "/opt", "/etc", "/var"):
    for d, dirs, files in os.walk(top):
        for f in files:
            p = os.path.join(d, f)
            try:
                if os.path.islink(p): continue
                n = os.path.getsize(p)
                if n < 65536: continue
                fd = os.open(p, os.O_RDONLY)
                try:
                    a = libc.mmap(None, ctypes.c_size_t(n), 1, 1, fd, ctypes.c_long(0))  # PROT_READ, MAP_SHARED
                    pages = (n + PAGE - 1) // PAGE
                    vec = (ctypes.c_ubyte * pages)()
                    libc.mincore(ctypes.c_void_p(a), ctypes.c_size_t(n), vec)
                    libc.munmap(ctypes.c_void_p(a), ctypes.c_size_t(n))
                    inc = sum(v & 1 for v in vec) * PAGE
                except Exception:
                    inc = 0
                finally:
                    os.close(fd)
                if inc > 1 << 20: res.append((inc, n, p))
            except OSError:
                pass
res.sort(reverse=True)
tot = sum(r[0] for r in res)
print("total cached in files >1MB cached: %d MB" % (tot >> 20))
for inc, n, p in res[:30]:
    print("%6d / %6d KB  %s" % (inc >> 10, n >> 10, p))
