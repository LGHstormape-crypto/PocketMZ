#!/usr/bin/env python3
"""Global LRU trimmer for PocketMZ SD-card pmz-cache directories.

Usage:
  pocketmz-cache-trim.py <cache_base_dir> [max_mb=512]
  pocketmz-cache-trim.py --selftest
"""
import os
import sys
import tempfile


def trim_cache(base_dir: str, max_mb: float = 512.0) -> tuple[int, int, int]:
    """Trim oldest files under base_dir when total exceeds max_mb.

    Returns (removed_files, removed_bytes, remaining_bytes).
    """
    if not base_dir or not os.path.isdir(base_dir) or max_mb <= 0:
        return (0, 0, 0)
    limit = int(max_mb * 1024 * 1024)
    target = int(limit * 0.9)
    files = []
    total = 0
    for root, _, names in os.walk(base_dir):
        for name in names:
            path = os.path.join(root, name)
            try:
                st = os.lstat(path)
            except OSError:
                continue
            if os.path.isfile(path) and not os.path.islink(path):
                files.append((st.st_mtime, st.st_size, path))
                total += st.st_size
    if total <= limit:
        return (0, 0, total)
    files.sort(key=lambda item: item[0])
    removed_files = 0
    removed_bytes = 0
    for _, size, path in files:
        if total <= target:
            break
        try:
            os.unlink(path)
            total -= size
            removed_files += 1
            removed_bytes += size
        except OSError:
            pass
    for root, dirs, names in os.walk(base_dir, topdown=False):
        if root == base_dir:
            continue
        if not dirs and not names:
            try:
                os.rmdir(root)
            except OSError:
                pass
    return (removed_files, removed_bytes, total)


def _selftest() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        g1 = os.path.join(tmp, "game1")
        g2 = os.path.join(tmp, "game2", "img")
        os.makedirs(g1)
        os.makedirs(g2)
        p1 = os.path.join(g1, "old.png")
        p2 = os.path.join(g2, "mid.png")
        p3 = os.path.join(g2, "new.png")
        for idx, (p, mtime) in enumerate(((p1, 1000.0), (p2, 2000.0), (p3, 3000.0))):
            with open(p, "wb") as f:
                f.write(b"x" * (600 * 1024))
            os.utime(p, (mtime, mtime))
        rm_n, rm_b, rem = trim_cache(tmp, max_mb=1.0)
        assert rm_n == 2 and rm_b == 1200 * 1024, (rm_n, rm_b)
        assert not os.path.exists(p1) and not os.path.exists(p2) and os.path.exists(p3)
        assert not os.path.exists(g1)
        assert rem == 600 * 1024
    print("pocketmz-cache-trim selftest ok")
    return 0


def main() -> int:
    if len(sys.argv) >= 2 and sys.argv[1] == "--selftest":
        return _selftest()
    if len(sys.argv) < 2:
        print("usage: pocketmz-cache-trim.py <cache_base_dir> [max_mb=512]", file=sys.stderr)
        return 2
    base_dir = sys.argv[1]
    max_mb = float(sys.argv[2]) if len(sys.argv) >= 3 else 512.0
    rm_n, rm_b, rem = trim_cache(base_dir, max_mb)
    if rm_n:
        print(f"pmz-cache trim: removed {rm_n} files ({rm_b // 1048576} MB), remaining {rem // 1048576} MB (limit {int(max_mb)} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
