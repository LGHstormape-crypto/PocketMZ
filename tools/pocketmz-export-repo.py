#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Copy the publishable part of the PocketMZ working folder into a separate git repository folder.

Usage: python tools/pocketmz-export-repo.py [target dir]   (default: ../PocketMZ-repo next to this folder)

Only whitelisted files are copied (no notes, build output, bench games or personal files); files in the
target that are no longer exported are deleted (except .git). Before anything is written, every exported
text file is checked against a local block list (notes/export-blocklist.txt); any hit stops the export with a list.
"""
import fnmatch
import os
import re
import shutil
import sys

SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DST = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(os.path.dirname(SRC), "PocketMZ-repo")

INCLUDE = [
    "LICENSE", "README.md", "BUILD.md",
    "patches/*",
    "scripts/*", "scripts/launcher/*", "scripts/modules/*", "scripts/wpe/*",
    "beta/*", "beta/pmzrt/*",
    "tools/*",
]
EXCLUDE = [
    "scripts/SHA256SUMS",                       # made by pocketmz-bundle.sh
    # old single-game dev tests (hard-wired to one test game; pocketmz-autotest.sh replaces them)
    "scripts/pocketmz-abes.sh", "scripts/pocketmz-entrytest.sh", "scripts/pocketmz-maptest.sh",
    "scripts/pocketmz-memlog.sh", "scripts/pocketmz-proftest.sh", "scripts/pocketmz-soak.sh",
    "scripts/launcher/dev-sample",
    # internal β dev plan and early single-game / M0 prototypes
    "beta/PLAN.md", "beta/mzfloor.js", "beta/run-mzfloor.sh", "beta/deploy-run.sh",
    "beta/mtest.js", "beta/nw-battle-freeze.js", "beta/nw-battle-real.js",
    "beta/deploy-audiotest.sh", "beta/deploy-canvastest.sh", "beta/run-canvastest.sh",
    "*/__pycache__/*", "*.pyc",
]
# private or game-specific text that must not be published: regular expressions, one per line, in a
# local file that is never exported (the list itself names what it protects)
BLOCKLIST = os.environ.get("POCKETMZ_EXPORT_BLOCKLIST", os.path.join(SRC, "notes", "export-blocklist.txt"))
REPO_FILES = {
    ".gitattributes": "* text=auto eol=lf\n*.bat text eol=crlf\n*.png binary\n*.ttf binary\n*.otf binary\n",
    ".gitignore": "__pycache__/\n*.pyc\nrunwpe*/\n",
}


def wanted():
    out = []
    for pat in INCLUDE:
        d, mask = os.path.split(pat)
        base = os.path.join(SRC, d)
        if not os.path.isdir(base):
            continue
        for n in sorted(os.listdir(base)):
            rel = (d + "/" + n) if d else n
            full = os.path.join(SRC, rel)
            if not os.path.isfile(full) or not fnmatch.fnmatch(n, mask):
                continue
            if any(fnmatch.fnmatch(rel, x) for x in EXCLUDE):
                continue
            out.append(rel)
    return sorted(set(out))


def main():
    if not os.path.isfile(BLOCKLIST):
        print("missing block list", BLOCKLIST)
        return 2
    with open(BLOCKLIST, encoding="utf-8") as f:
        block = [l.strip() for l in f if l.strip() and not l.startswith("#")]
    block_re = re.compile("|".join(block))
    files = wanted()
    hits = []
    for rel in files:
        with open(os.path.join(SRC, rel), "rb") as f:
            data = f.read()
        if b"\0" in data[:4096]:
            continue
        for i, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
            m = block_re.search(line)
            if m:
                hits.append(f"{rel}:{i}: {m.group(0)}  | {line.strip()[:100]}")
    if hits:
        print("export stopped - private / game-specific text found:")
        print("\n".join(hits))
        return 1
    os.makedirs(DST, exist_ok=True)
    keep = set(files) | set(REPO_FILES)
    for root, dirs, names in os.walk(DST):
        dirs[:] = [d for d in dirs if d != ".git"]
        for n in names:
            rel = os.path.relpath(os.path.join(root, n), DST).replace(os.sep, "/")
            if rel not in keep:
                os.remove(os.path.join(root, n))
                print("removed", rel)
    for rel in files:
        dst = os.path.join(DST, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(os.path.join(SRC, rel), dst)
    for rel, text in REPO_FILES.items():
        with open(os.path.join(DST, rel), "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
    print(f"exported {len(files)} files to {DST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
