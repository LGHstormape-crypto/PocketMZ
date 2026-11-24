# SPDX-License-Identifier: MIT
"""PocketMZ PC converter (Windows).

Prepares downloaded RPG Maker MV/MZ game archives for the PocketMZ handheld
runtime: detects the game type from the archive listing, extracts into a clean
folder, unpacks Enigma Virtual Box games, strips Windows runtime files,
optionally transcodes big videos and sends the result to the handheld.

Safety: archives and extracted files are untrusted data. Nothing from them is
ever executed; every archive is extracted into a new empty folder; helper
interpreters are started with -P so the current directory is never imported.
Python standard library only.
"""
import argparse
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import tarfile
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path

DEFAULT_HOST = "gkd-rocknix"
ARCHIVE_EXTS = {".zip", ".7z", ".rar"}
IGNORED_DIRS = {"不满足", "_converted", "_x"}
RUNTIME_EXTS = {".exe", ".dll", ".pak", ".dat", ".bin"}
RUNTIME_FILES = {"debug.log"}
RUNTIME_DIRS = {"locales", "swiftshader"}
MB = 1024 * 1024
REMOTE_ROOT = "/storage/roms/rpgmaker"
REMOTE_SCAN = "if [ -x /storage/pocketmz/pocketmz-scan.sh ]; then /storage/pocketmz/pocketmz-scan.sh; elif [ -f /storage/pocketmz/pocketmz-library.py ]; then python3 /storage/pocketmz/pocketmz-library.py; fi"
DLSITE_RE = re.compile(r"(?<![A-Za-z0-9])[RVB]J\d{6,8}(?!\d)")


class ToolError(Exception):
    """Expected failure with a user-facing (Chinese) message."""


@dataclass
class Entry:
    raw: str          # path exactly as the archive lists it (for 7z member args)
    norm: str         # forward slashes, no leading/trailing slash
    size: int = 0
    enc: bool = False
    is_dir: bool = False


@dataclass
class Verdict:
    kind: str                 # mz / mv / packed / reject / nested
    prefix: str = ""          # game root inside the archive (original case, '' or ends with '/')
    reason: str = ""
    inner: list = None        # nested archive entries


@dataclass
class Item:
    path: Path
    is_dir: bool
    out: Path
    reject: Path


@dataclass
class Result:
    name: str
    outcome: str = ""
    title: str = "-"
    res: str = "-"
    plugins: str = "-"
    size: int = 0
    where: str = ""
    failed: bool = False


# ---------------------------------------------------------------- helpers

def human(n):
    n = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024


def dwidth(s):
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)


def cut(s, width):
    if dwidth(s) <= width:
        return s
    out, w = "", 0
    for c in s:
        cw = 2 if unicodedata.east_asian_width(c) in "WF" else 1
        if w + cw > width - 1:
            break
        out += c
        w += cw
    return out + "…"


def pad(s, width):
    return s + " " * max(0, width - dwidth(s))


_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)),
             *(f"lpt{i}" for i in range(1, 10))}


def sanitize(name, maxlen=None):
    """Make a string safe as a Windows file/folder name."""
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name)
    s = re.sub(r"\s+", " ", s).strip()
    if maxlen:
        s = s[:maxlen]
    s = s.rstrip(". ")
    if s.lower() in _RESERVED:
        s = "_" + s
    return s


def find_7z():
    for cand in (r"C:\Program Files\7-Zip\7z.exe", r"C:\Program Files (x86)\7-Zip\7z.exe"):
        if os.path.isfile(cand):
            return cand
    return shutil.which("7z")


def rmtree(path):
    def onexc(func, p, exc):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass
    shutil.rmtree(path, onexc=onexc)


def dir_size(path):
    total = 0
    for dp, _dn, fn in os.walk(path):
        for f in fn:
            try:
                total += os.lstat(os.path.join(dp, f)).st_size
            except OSError:
                pass
    return total


def unique_dest(folder, name):
    p = Path(name)
    cand = folder / name
    n = 2
    while cand.exists():
        cand = folder / f"{p.stem} ({n}){p.suffix}"
        n += 1
    return cand


def walk_entries(root, maxdepth=None):
    """List files below root as Entry objects (symlinks skipped)."""
    out = []
    stack = [(root, "", 0)]
    while stack:
        d, rel, depth = stack.pop()
        try:
            it = list(os.scandir(d))
        except OSError:
            continue
        for e in it:
            try:
                if e.is_symlink():
                    continue
                relp = rel + e.name
                if e.is_dir(follow_symlinks=False):
                    if e.name.casefold() in IGNORED_DIRS and depth == 0 and maxdepth is not None:
                        continue
                    if maxdepth is None or depth + 1 < maxdepth:
                        stack.append((e.path, relp + "/", depth + 1))
                else:
                    out.append(Entry(relp, relp, e.stat(follow_symlinks=False).st_size))
            except OSError:
                continue
    return out


# ---------------------------------------------------------------- detection

def detect_game(files):
    """files: dict lower-case norm path -> Entry. Returns (kind, prefix) or None."""
    def has(p):
        return p in files

    def orig_prefix(low, suffix):
        return files[low].norm[: len(low) - len(suffix)]

    best = None
    for low in files:
        suf = "js/rmmz_core.js"
        if low.endswith(suf):
            pre = low[: -len(suf)]
            if (pre == "" or pre.endswith("/")) and has(pre + "index.html"):
                cand = (pre.count("/"), "mz", orig_prefix(low, suf))
                best = min(best, cand) if best else cand
    if best:
        return best[1], best[2]
    for low in files:
        suf = "js/rpg_core.js"
        if low.endswith(suf):
            wpre = low[: -len(suf)]                  # ends with 'www/'
            if wpre == "www/" or wpre.endswith("/www/"):
                parent = wpre[:-4]
                if has(wpre + "index.html") and has(parent + "package.json"):
                    cand = (parent.count("/"), "mv", orig_prefix(low, suf)[:-4])
                    best = min(best, cand) if best else cand
    if best:
        return best[1], best[2]
    for low in files:
        if low == "nw.dll" or low.endswith("/nw.dll"):
            pre = low[:-6]
            exe = files.get(pre + "game.exe")
            if (has(pre + "index.html") and has(pre + "package.json") and exe
                    and exe.size > 20 * MB
                    and not any(k.startswith(pre + "js/") for k in files)):
                cand = (pre.count("/"), "packed", files[low].norm[:-6])
                best = min(best, cand) if best else cand
    if best:
        return best[1], best[2]
    return None


def classify(entries):
    files = {e.norm.lower(): e for e in entries if not e.is_dir}
    if any(e.enc for e in files.values()):
        return Verdict("reject", reason="加密/需要密码")
    game = detect_game(files)
    if game:
        return Verdict(game[0], prefix=game[1])
    base = {k.rsplit("/", 1)[-1] for k in files}
    if "unityplayer.dll" in base or any("unitycrashhandler" in b for b in base):
        return Verdict("reject", reason="Unity 游戏")
    if "app.asar" in base or any(k.startswith("resources/app/") or "/resources/app/" in k for k in files):
        return Verdict("reject", reason="TyranoScript/Electron 游戏")
    inner = [e for k, e in sorted(files.items()) if Path(k).suffix in ARCHIVE_EXTS]
    if inner:
        return Verdict("nested", inner=inner)
    if any(k.endswith(".exe") for k in files) and not any(k.endswith("index.html") for k in files):
        return Verdict("reject", reason="只有 Windows exe（安装包/补丁）")
    return Verdict("reject", reason="未识别出 RPG Maker MV/MZ 游戏")


# ---------------------------------------------------------------- sources

class ArchiveSource:
    def __init__(self, seven, path):
        self.seven = seven
        self.path = Path(path)
        self.extra = ["-mcp=932"] if self.path.suffix.lower() == ".zip" else []

    def _run(self, args):
        # cwd = archive folder + relative name: absolute non-ASCII paths failed before
        return subprocess.run([self.seven, *args], cwd=self.path.parent, stdin=subprocess.DEVNULL,
                              capture_output=True)

    def entries(self):
        r = self._run(["l", "-ba", "-slt", "-sccUTF-8", *self.extra, "--", self.path.name])
        text = r.stdout.decode("utf-8", "replace") + r.stderr.decode("utf-8", "replace")
        if r.returncode != 0:
            if re.search(r"password|encrypted", text, re.I):
                return [Entry("?", "?", 0, True)]
            raise ToolError("7z 无法读取压缩包: " + (text.strip().splitlines() or ["未知错误"])[-1])
        out, cur = [], {}

        def flush():
            if "Path" in cur:
                p = cur["Path"]
                out.append(Entry(p, p.replace("\\", "/").strip("/"), int(cur.get("Size") or 0),
                                 cur.get("Encrypted") == "+", cur.get("Folder") == "+"))
        for line in text.splitlines():
            if not line.strip():
                flush()
                cur = {}
                continue
            k, sep, v = line.partition(" = ")
            if sep:
                cur[k] = v
        flush()
        return out

    def read(self, entry):
        r = self._run(["e", "-so", "-spd", "-sccUTF-8", *self.extra, "--", self.path.name, entry.raw])
        return r.stdout if r.returncode == 0 and r.stdout else None

    def extract(self, dest, member=None):
        args = ["x", "-y", "-spd", f"-o{dest}", *self.extra, "--", self.path.name]
        if member:
            args.append(member)
        r = self._run(args)
        if r.returncode != 0:
            msg = r.stderr.decode("utf-8", "replace").strip().splitlines()
            raise ToolError("解压失败: " + (msg[-1] if msg else f"7z 返回 {r.returncode}"))


class FolderSource:
    def __init__(self, path):
        self.path = Path(path)

    def entries(self):
        return walk_entries(self.path)

    def read(self, entry):
        try:
            return (self.path / entry.norm).read_bytes()
        except OSError:
            return None


# ---------------------------------------------------------------- game info

def count_plugins(data):
    if not data:
        return "-"
    t = data.decode("utf-8-sig", "replace")
    a, b = t.find("["), t.rfind("]")
    if a < 0 or b < a:
        return "-"
    s = t[a:b + 1]
    for cand in (s, re.sub(r",\s*([\]}])", r"\1", s)):
        try:
            arr = json.loads(cand)
            return str(sum(1 for p in arr if isinstance(p, dict) and p.get("status") is True))
        except ValueError:
            continue
    return "-"


def read_info(read_path, kind, prefix):
    """read_path(rel_norm) -> bytes|None. Returns (title, locale, resolution, plugins)."""
    base = prefix + ("www/" if kind == "mv" else "")
    title, locale, res = "", "", "816x624"
    raw = read_path(base + "data/System.json")
    if raw:
        try:
            d = json.loads(raw.decode("utf-8-sig", "replace"))
            title = str(d.get("gameTitle", "")).split(" | ")[0].strip()
            locale = str(d.get("locale", ""))
            adv = d.get("advanced") or {}
            if adv.get("screenWidth") and adv.get("screenHeight"):
                res = f"{adv['screenWidth']}x{adv['screenHeight']}"
        except (ValueError, AttributeError):
            pass
    return title, locale, res, count_plugins(read_path(base + "js/plugins.js"))


# ---------------------------------------------------------------- work dir

class Work:
    def __init__(self, out, id_):
        self.parent = out / "_work"
        self.id = id_
        self.base = self.parent / f"{id_}-{secrets.token_hex(4)}"

    def new(self, label):
        p = self.base / label
        p.mkdir(parents=True)
        return p

    def cleanup(self):
        # only ever delete the dir this run created
        if self.base.exists() and self.base.parent == self.parent and self.base.name.startswith(self.id + "-"):
            rmtree(self.base)
            try:
                self.parent.rmdir()
            except OSError:
                pass


# ---------------------------------------------------------------- conversion steps

def evb_available():
    r = subprocess.run([sys.executable, "-P", "-c", "import evbunpack"], cwd=os.environ.get("TEMP", None),
                       capture_output=True, stdin=subprocess.DEVNULL)
    return r.returncode == 0


EVB_HELP = ("需要先安装 evbunpack："
            "`python -m pip install --user https://github.com/mos9527/evbunpack/archive/refs/tags/0.2.6.tar.gz`")


def unpack_evb(final, work):
    exe = next((p for p in final.iterdir() if p.is_file() and p.name.lower() == "game.exe"), None)
    if not exe:
        raise ToolError("找不到 Game.exe")
    tmp = work.new("evb")
    shutil.copy2(exe, tmp / "Game.exe")
    # -P: never import from cwd; cwd holds only the copied exe
    r = subprocess.run([sys.executable, "-P", "-m", "evbunpack", "--ignore-pe", "Game.exe", "out"],
                       cwd=tmp, capture_output=True, stdin=subprocess.DEVNULL)
    outdir = tmp / "out"
    if r.returncode != 0 or not outdir.is_dir():
        err = r.stderr.decode("utf-8", "replace").strip().splitlines()
        raise ToolError("evbunpack 失败: " + (err[-1] if err else f"返回 {r.returncode}"))
    for dp, _dn, fn in os.walk(outdir):
        rel = os.path.relpath(dp, outdir)
        target = final if rel == "." else final / rel
        target.mkdir(parents=True, exist_ok=True)
        for f in fn:
            t = target / f
            if not t.exists():           # never overwrite existing files
                shutil.copy2(os.path.join(dp, f), t)
    if not any((final / p).is_file() for p in ("js/rmmz_core.js", "js/rpg_core.js",
                                                "www/js/rpg_core.js")):
        raise ToolError("解包后仍找不到 rmmz_core.js / rpg_core.js")


def strip_runtime(final):
    """Delete Windows runtime files at the top level of the game root only."""
    n, freed = 0, 0
    for p in list(final.iterdir()):
        low = p.name.lower()
        if p.is_symlink():
            continue
        if p.is_file() and (p.suffix.lower() in RUNTIME_EXTS or low in RUNTIME_FILES):
            freed += p.stat().st_size
            p.unlink()
            n += 1
        elif p.is_dir() and low in RUNTIME_DIRS:
            freed += dir_size(p)
            rmtree(p)
            n += 1
    return n, freed


def video_height(v):
    """--video value: 480, 720, "720p" or any height from 144 to 2160 (even)."""
    try:
        h = int(str(v).lower().rstrip("p"))
    except ValueError:
        raise argparse.ArgumentTypeError(f"视频高度应为数字，如 480 或 720：{v}")
    if not 144 <= h <= 2160:
        raise argparse.ArgumentTypeError(f"视频高度应在 144 到 2160 之间：{v}")
    return h - h % 2


def transcode_videos(final, kind, height_max=480):
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        print("    未找到 ffmpeg/ffprobe，跳过 --video")
        return
    mdir = final / ("www/movies" if kind == "mv" else "movies")
    if not mdir.is_dir():
        return
    for f in sorted(mdir.iterdir()):
        if not f.is_file():
            continue
        # RPG Maker loads movies/*.webm, but some games ship MP4 (H.264) under that name; the
        # browser sniffs the content and plays both. MP4 stays MP4 (H.264 decodes cheaper on the
        # handheld's CPU than VP9), WebM stays WebM.
        with open(f, "rb") as fh:
            head = fh.read(12)
        if head[:4] == b"\x1a\x45\xdf\xa3":
            container = "webm"
        elif head[4:8] == b"ftyp":
            container = "mp4"
        else:
            continue
        pr = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
                             "stream=height", "-of", "csv=p=0", str(f)],
                            capture_output=True, stdin=subprocess.DEVNULL)
        try:
            height = int(pr.stdout.decode().strip().split(",")[0])
        except (ValueError, IndexError):
            continue
        if height <= height_max:
            continue
        tmp = f.with_name(f"{f.stem}.__tmp__{f.suffix}")
        before = f.stat().st_size
        print(f"    转码视频 {f.name} ({height}p) ...")
        if container == "webm":
            enc = ["-c:v", "libvpx-vp9", "-crf", "36", "-b:v", "0", "-row-mt", "1",
                   "-deadline", "good", "-cpu-used", "4", "-c:a", "copy", "-f", "webm"]
        else:
            enc = ["-c:v", "libx264", "-preset", "slow", "-crf", "23", "-pix_fmt", "yuv420p",
                   "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-f", "mp4"]
        r = subprocess.run([ffmpeg, "-y", "-nostdin", "-v", "error", "-i", str(f), "-vf", f"scale=-2:{height_max}",
                            *enc, str(tmp)],
                           capture_output=True, stdin=subprocess.DEVNULL)
        if r.returncode != 0:
            tmp.unlink(missing_ok=True)
            print(f"    转码失败，保留原文件: {f.name}")
            continue
        os.replace(tmp, f)
        print(f"    {f.name}: {human(before)} -> {human(f.stat().st_size)}")


def send_folder(folder, host, size):
    name = folder.name
    if "'" in name or any(ord(c) < 32 for c in name):
        raise ToolError("文件夹名含单引号或控制字符，拒绝发送")
    if not re.fullmatch(r"[A-Za-z0-9._@\-]+", host) or host.startswith("-"):
        raise ToolError(f"主机名不合法: {host}")
    ssh = shutil.which("ssh")
    if not ssh:
        raise ToolError("需要 OpenSSH ssh")
    sshcmd = [ssh, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host]
    r = subprocess.run([*sshcmd, "df -k /storage/roms"], capture_output=True, stdin=subprocess.DEVNULL)
    try:
        avail = int(r.stdout.decode().strip().splitlines()[-1].split()[3]) * 1024
    except (ValueError, IndexError):
        raise ToolError("无法读取掌机剩余空间（ssh 连接失败？）")
    if avail < size + 200 * MB:
        raise ToolError(f"掌机空间不足：剩余 {human(avail)}，需要 {human(size + 200 * MB)}")
    dest = f"{REMOTE_ROOT}/{name}"
    remote = f"mkdir -p '{dest}' && tar -xf - -C '{dest}'"
    print(f"    发送到 {host}:{dest} ...")
    # tar stream written by Python's tarfile (Windows tar.exe crashed on Japanese paths)
    sp = subprocess.Popen([*sshcmd, remote], stdin=subprocess.PIPE)
    err = None
    try:
        with tarfile.open(fileobj=sp.stdin, mode="w|", format=tarfile.GNU_FORMAT, encoding="utf-8") as tf:
            for p in sorted(folder.rglob("*")):
                tf.add(str(p), arcname=p.relative_to(folder).as_posix(), recursive=False)
    except (OSError, tarfile.TarError) as e:
        err = e
    finally:
        try:
            sp.stdin.close()
        except OSError:
            pass
    src = sp.wait()
    if src != 0 or err:
        raise ToolError(f"发送失败（ssh={src}{', ' + str(err) if err else ''}）")
    r = subprocess.run([*sshcmd, REMOTE_SCAN], capture_output=True, stdin=subprocess.DEVNULL)
    for line in r.stdout.decode("utf-8", "replace").splitlines():
        if "added:" in line:
            print("    " + line.strip())
    if r.returncode != 0:
        raise ToolError("掌机扫描脚本返回错误")


# ---------------------------------------------------------------- item processing

def make_id(item_name, entries, title):
    m = DLSITE_RE.search(item_name)
    if not m:
        for e in entries[:500]:
            m = DLSITE_RE.search(e.norm)
            if m:
                break
    if m:
        return m.group(0)
    return sanitize(title, 40) or sanitize(Path(item_name).stem, 40) or "game"


def reject(item, res, reason, o):
    res.outcome = f"不合格: {reason}"
    if item.is_dir:
        res.where = "文件夹，仅报告"
    elif o.dry_run:
        res.where = f"将移动到 {item.reject}"
    else:
        item.reject.mkdir(parents=True, exist_ok=True)
        dest = unique_dest(item.reject, item.path.name)
        shutil.move(str(item.path), str(dest))
        res.where = f"已移动到 {dest}"
    return res


def process(item, seven, o):
    res = Result(item.path.name)
    work = None
    final = None
    created = False
    try:
        if item.is_dir:
            src = FolderSource(item.path)
        else:
            if not seven:
                raise ToolError("未找到 7-Zip（C:\\Program Files\\7-Zip\\7z.exe）")
            src = ArchiveSource(seven, item.path)
        entries = src.entries()
        v = classify(entries)
        outer_name = item.path.name
        id_entries = entries

        if v.kind == "nested":
            names = ", ".join(e.norm for e in v.inner[:3])
            if o.dry_run:
                res.outcome = "嵌套压缩包（未展开）"
                res.where = f"内含: {cut(names, 60)}"
                return res
            work = Work(item.out, make_id(outer_name, entries, ""))
            found = None
            for e in v.inner:
                d = work.new(f"inner{secrets.token_hex(2)}")
                src.extract(d, e.raw)
                ip = (d / e.norm).resolve()
                if d.resolve() not in ip.parents or not ip.is_file():
                    continue
                isrc = ArchiveSource(seven, ip)
                try:
                    ient = isrc.entries()
                except ToolError:
                    continue
                iv = classify(ient)
                if iv.kind in ("mz", "mv", "packed"):
                    found = (isrc, ient, iv)
                    break
            if not found:
                return reject(item, res, "嵌套压缩包内未识别出游戏", o)
            src, entries, v = found
            print(f"    （嵌套压缩包: {src.path.name}）")

        if v.kind == "reject":
            return reject(item, res, v.reason, o)

        # game metadata (packed games only have it after unpacking)
        title, locale, resolution, plugins = "", "", "-", "-"
        if v.kind in ("mz", "mv"):
            lookup = {e.norm.lower(): e for e in entries if not e.is_dir}

            def read_path(rel):
                e = lookup.get(rel.lower())
                return src.read(e) if e else None
            title, locale, resolution, plugins = read_info(read_path, v.kind, v.prefix)
        low_pre = v.prefix.lower()
        res.size = sum(e.size for e in entries if not e.is_dir and e.norm.lower().startswith(low_pre))
        res.title = (title + (f" [{locale}]" if locale else "")) or "-"
        res.res, res.plugins = resolution, plugins
        id_ = make_id(outer_name, id_entries, title)
        st = sanitize(title, 40) if title else ""
        folder_name = f"{id_} {st}".strip() if st and st != id_ else id_   # no DLsite code: id is the title
        final = item.out / folder_name
        label = {"mz": "MZ", "mv": "MV", "packed": "待解包(EVB)"}[v.kind]

        if v.kind == "packed" and not evb_available():
            res.outcome = "失败: 缺少 evbunpack"
            res.where = EVB_HELP
            res.failed = not o.dry_run
            return res
        if o.dry_run:
            res.outcome = label
            res.where = f"将输出到 {final}"
            return res
        if final.exists():
            raise ToolError(f"目标文件夹已存在: {final}")

        # extract / copy the game root into its final folder
        item.out.mkdir(parents=True, exist_ok=True)
        if work is None:
            work = Work(item.out, id_)
        if isinstance(src, ArchiveSource):
            print("    解压中 ...")
            ex = work.new("x")
            src.extract(ex)
            game = detect_game({e.norm.lower(): e for e in walk_entries(ex)})
            if not game:
                raise ToolError("解压后找不到游戏根目录")
            root = ex / game[1]
            final.mkdir()
            created = True
            for child in list(root.iterdir()):
                shutil.move(str(child), str(final / child.name))
        else:
            print("    复制中 ...")
            root = src.path / v.prefix
            shutil.copytree(root, final, symlinks=True)
            created = True

        if v.kind == "packed":
            print("    解包 Enigma Virtual Box ...")
            unpack_evb(final, work)

        # re-read info from the final folder (needed for packed games)
        kind = v.kind
        if (final / "js/rmmz_core.js").is_file():
            kind = "mz"
        elif (final / "www/js/rpg_core.js").is_file() or (final / "js/rpg_core.js").is_file():
            kind = "mv"
        if v.kind == "packed":
            title, locale, resolution, plugins = read_info(
                lambda rel: (final / rel).read_bytes() if (final / rel).is_file() else None, kind, "")
            res.title = (title + (f" [{locale}]" if locale else "")) or "-"
            res.res, res.plugins = resolution, plugins
            if title:
                newfinal = item.out / f"{id_} {sanitize(title, 40)}".strip()
                if not newfinal.exists():
                    final.rename(newfinal)
                    final = newfinal

        if not o.keep_runtime:
            n, freed = strip_runtime(final)
            print(f"    已删除 Windows 运行时文件 {n} 项，释放 {human(freed)}")
        if o.video:
            transcode_videos(final, kind, o.video_height)

        res.size = dir_size(final)
        res.outcome = f"已解包({kind.upper()})" if v.kind == "packed" else kind.upper()
        res.where = str(final)
        created = False  # success: keep the folder
        if o.send:
            send_folder(final, o.send, res.size)
            res.where += f" -> {o.send}"
    except ToolError as e:
        res.outcome = f"失败: {e}"
        res.failed = True
    except Exception as e:  # unexpected
        import traceback
        traceback.print_exc()
        res.outcome = f"失败: 意外错误 {type(e).__name__}: {e}"
        res.failed = True
    finally:
        if created and final is not None and final.exists():
            rmtree(final)           # remove only the half-built folder we created
        if work is not None:
            work.cleanup()
    return res


# ---------------------------------------------------------------- input collection

def is_game_dir(p):
    files = {e.norm.lower(): e for e in walk_entries(p, maxdepth=3)}
    g = detect_game(files)
    return bool(g) and g[1] == ""


def collect(paths, o):
    items = []

    def mk(p, is_dir, base):
        out = Path(o.out) if o.out else base / "_converted"
        rej = Path(o.reject_dir) if o.reject_dir else base / "不满足"
        items.append(Item(p, is_dir, out, rej))

    def skip(child):
        return child.name.casefold() in IGNORED_DIRS

    def expand(folder, base, level):
        try:
            kids = sorted(folder.iterdir(), key=lambda x: x.name.lower())
        except OSError:
            return
        for c in kids:
            if c.is_symlink() or (c.is_dir() and skip(c)):
                continue
            if c.is_file() and c.suffix.lower() in ARCHIVE_EXTS:
                mk(c, False, base)
            elif c.is_dir():
                if is_game_dir(c):
                    mk(c, True, base)
                elif level < 2:
                    expand(c, base, level + 1)

    for raw in paths:
        p = Path(raw).resolve()
        if p.is_file():
            if p.suffix.lower() in ARCHIVE_EXTS:
                mk(p, False, p.parent)
            else:
                print(f"跳过（不支持的文件类型）: {p}")
        elif p.is_dir():
            if is_game_dir(p):
                mk(p, True, p.parent)
            else:
                expand(p, p, 1)
        else:
            print(f"跳过（路径不存在）: {raw}")
    return items


# ---------------------------------------------------------------- main

def print_table(results):
    heads = ["项目", "结果", "标题", "分辨率", "插件", "大小", "输出/去向"]
    widths = [30, 20, 26, 9, 4, 9]
    rows = [[cut(r.name, widths[0]), cut(r.outcome, widths[1]), cut(r.title, widths[2]), r.res,
             r.plugins, human(r.size) if r.size else "-", r.where] for r in results]
    print()
    print("  ".join(pad(h, w) for h, w in zip(heads, widths + [0])))
    print("-" * 100)
    for row in rows:
        print("  ".join(pad(c, w) for c, w in zip(row, widths + [0])))
    for r in results:
        if len(r.outcome) > widths[1]:
            print(f"  [{r.name}] {r.outcome}")


def main(argv=None):
    if not sys.stdout.isatty():
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(
        prog="pocketmz-convert.py",
        description="PocketMZ 转换器：整理 RPG Maker MV/MZ 游戏压缩包，可选发送到掌机。")
    ap.add_argument("paths", nargs="*", help="压缩包 (.zip .7z .rar)、游戏文件夹，或包含它们的文件夹")
    ap.add_argument("--out", help="输出目录（默认：输入所在目录\\_converted）")
    ap.add_argument("--reject-dir", help="不合格压缩包的移动目录（默认：输入所在目录\\不满足）")
    ap.add_argument("--dry-run", action="store_true", help="只检查并显示将要做什么，不解压、不移动、不发送")
    ap.add_argument("--video", action="store_true",
                    help="用 ffmpeg 把高于 --video-height 的视频（WebM，或改名为 .webm 的 MP4）转码，宽度按原比例")
    ap.add_argument("--video-height", type=video_height, default=480, metavar="高度",
                    help="视频转码的目标高度：480（默认）、720 或其他数字（144–2160）")
    ap.add_argument("--send", nargs="?", const=DEFAULT_HOST, default=None, metavar="HOST",
                    help=f"转换后通过 ssh 发送到掌机（默认主机 {DEFAULT_HOST}）")
    ap.add_argument("--keep-runtime", action="store_true", help="保留 Windows 运行时文件")
    o = ap.parse_args(argv)
    # "--send <path>" would swallow the path as HOST; give it back
    if o.send and (os.path.exists(o.send) or "\\" in o.send or "/" in o.send):
        o.paths.insert(0, o.send)
        o.send = DEFAULT_HOST
    if not o.paths:
        ap.print_help()
        return 0

    seven = find_7z()
    items = collect(o.paths, o)
    if not items:
        print("没有找到可处理的项目。")
        return 0
    if o.dry_run:
        print("【dry-run】只检查，不会修改任何文件。")
    results = []
    for i, it in enumerate(items, 1):
        print(f"[{i}/{len(items)}] {it.path.name}")
        results.append(process(it, seven, o))
        print(f"    -> {results[-1].outcome}")
    print_table(results)
    return 1 if any(r.failed for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
