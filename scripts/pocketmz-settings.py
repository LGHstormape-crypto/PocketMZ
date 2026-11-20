#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# PocketMZ native settings screen (SDL2 via the vendored PySDL2). Same look and input handling as
# pocketmz-launcher.py. Maintenance work (scan, saves, update, uninstall) is done by shell scripts:
#   PMZ/pocketmz-scan.sh              : rescan the game folders
#   PMZ/pocketmz-maint.sh <sub> ...   : info | find-package | update <path> | export-saves |
#                                       clean-copies | uninstall; the LAST output line is
#                                       "OK <message>" or "ERROR <message>"
# Only file written by this program: $POCKETMZ_DATA/settings.json
#   {"defaultFps": 30, "renderScale": "auto", "stopES": false}
# `--selftest` skips SDL completely and checks the pure logic (settings, output parsing).
import ctypes
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import threading
import time

PMZ = os.path.dirname(os.path.realpath(__file__))
RZ = os.environ.get("POCKETMZ_DATA", "/storage/pocketmz")
SELFTEST = "--selftest" in sys.argv[1:]

sdl2 = None
ttf = None
if not SELFTEST:
    sys.path.insert(0, os.path.join(PMZ, "vendor"))
    os.environ.setdefault("PYSDL2_DLL_PATH", "/usr/lib")
    if sys.platform.startswith("linux"):
        os.environ.setdefault("SDL_VIDEODRIVER", "wayland")
    os.environ["SDL_VIDEO_WAYLAND_WMCLASS"] = "pocketmz-settings"   # app_id; the caller focuses by it
    os.environ["SDL_VIDEO_X11_WMCLASS"] = "pocketmz-settings"
    import sdl2
    import sdl2.sdlttf as ttf

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/noto-cjk/NotoSansCJKsc-Regular.otf",
    "/storage/pocketmz/root-sqfs/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/config/emulationstation/resources/DroidSansFallbackFull.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]
GAMEPAD_DB = os.environ.get("SDL_GAMECONTROLLERCONFIG_FILE") or "/storage/roms/ports/PortMaster/gamecontrollerdb.txt"
PROJECT_URL = "https://github.com/<TBD>/PocketMZ"

# ---------- colours (same as the launcher) ----------
BG = (0x14, 0x16, 0x1c)
CARD = (0x23, 0x27, 0x33)
CARD_SEL = (0x2c, 0x33, 0x45)
PANEL = (0x1d, 0x21, 0x2b)
ACCENT = (0x4f, 0x8c, 0xff)
TEXT = (0xe8, 0xea, 0xf0)
SECOND = (0x9a, 0xa3, 0xb5)
WARN = (0xff, 0x6b, 0x6b)
WARN_BG = (0xb0, 0x3a, 0x3a)
KEY_BORDER = (0x3a, 0x40, 0x54)
WHITE = (255, 255, 255)

# ---------- i18n ----------
I18N = {
    "zh": {
        "settings": "设置", "scan": "扫描游戏", "defaults": "游戏默认设置", "saves": "存档",
        "runtime": "运行环境", "about": "关于", "exit": "退出",
        "hint": "A 确定  B 返回", "hint_cycle": "左右 修改  A 切换  B 返回",
        "d_fps": "默认帧率", "d_scale": "渲染缩放", "d_stopes": "运行时关闭 ES",
        "scale_auto": "自动缩小", "scale_off": "原生分辨率", "on": "开", "off": "关",
        "d_note": "只对没有单独设置的游戏生效；游戏内菜单 (F2+F1) 可单独修改",
        "s_export": "导出全部存档", "s_clean": "清理游戏副本缓存",
        "r_info": "信息", "r_update": "检查更新包", "r_uninstall": "卸载 PocketMZ",
        "scanning": "正在扫描…", "working": "请稍候…", "checking": "正在检查…", "installing": "正在安装…",
        "ok": "确定", "cancel": "取消",
        "clean_confirm": "清理游戏副本缓存？会删除可重建的副本文件，存档不受影响",
        "uninst1": "卸载 PocketMZ？",
        "uninst2": "存档会先复制到 /storage/pocketmz-saves-*，然后删除全部 PocketMZ 文件。确定卸载？",
        "install_q": "安装 {0}？\n当前版本：{1}", "up_to_date": "已是最新版本 {0}", "no_pkg": "没有找到更新包",
        "take_effect": "下次启动时生效。", "scan_empty": "（没有输出）",
        "missing": "缺少脚本：{0}", "exit_code": "命令失败（退出码 {0}）",
        "version": "版本", "games": "游戏", "launchers": "启动项", "withSaves": "有存档",
        "dataSize": "数据大小", "free": "剩余空间", "ver_line": "版本 {0}",
    },
    "ja": {
        "settings": "設定", "scan": "ゲームをスキャン", "defaults": "ゲームの既定設定", "saves": "セーブデータ",
        "runtime": "実行環境", "about": "このアプリについて", "exit": "終了",
        "hint": "A 決定  B 戻る", "hint_cycle": "左右 変更  A 切替  B 戻る",
        "d_fps": "既定フレームレート", "d_scale": "描画スケール", "d_stopes": "実行中に ES を停止",
        "scale_auto": "自動縮小", "scale_off": "ネイティブ解像度", "on": "オン", "off": "オフ",
        "d_note": "個別設定のないゲームにのみ適用されます。ゲーム内メニュー (F2+F1) で個別に変更できます",
        "s_export": "セーブデータをすべて書き出す", "s_clean": "ゲームのコピーキャッシュを削除",
        "r_info": "情報", "r_update": "更新パッケージを確認", "r_uninstall": "PocketMZ をアンインストール",
        "scanning": "スキャン中…", "working": "お待ちください…", "checking": "確認中…", "installing": "インストール中…",
        "ok": "OK", "cancel": "キャンセル",
        "clean_confirm": "コピーキャッシュを削除しますか？再生成できるファイルのみ削除され、セーブデータは影響を受けません",
        "uninst1": "PocketMZ をアンインストールしますか？",
        "uninst2": "セーブデータは先に /storage/pocketmz-saves-* へコピーされ、その後 PocketMZ のファイルがすべて削除されます。実行しますか？",
        "install_q": "{0} をインストールしますか？\n現在のバージョン：{1}", "up_to_date": "最新バージョンです {0}",
        "no_pkg": "更新パッケージが見つかりません",
        "take_effect": "次回の起動から有効になります。", "scan_empty": "（出力なし）",
        "missing": "スクリプトがありません：{0}", "exit_code": "コマンドが失敗しました（終了コード {0}）",
        "version": "バージョン", "games": "ゲーム", "launchers": "ランチャー", "withSaves": "セーブあり",
        "dataSize": "データサイズ", "free": "空き容量", "ver_line": "バージョン {0}",
    },
    "en": {
        "settings": "Settings", "scan": "Scan games", "defaults": "Game defaults", "saves": "Saves",
        "runtime": "Runtime", "about": "About", "exit": "Exit",
        "hint": "A OK  B Back", "hint_cycle": "Left/Right Change  A Toggle  B Back",
        "d_fps": "Default FPS", "d_scale": "Render scale", "d_stopes": "Stop ES while playing",
        "scale_auto": "Auto downscale", "scale_off": "Native resolution", "on": "On", "off": "Off",
        "d_note": "Only applies to games without their own setting; change per game in the in-game menu (F2+F1)",
        "s_export": "Export all saves", "s_clean": "Clean game copy cache",
        "r_info": "Info", "r_update": "Check for update package", "r_uninstall": "Uninstall PocketMZ",
        "scanning": "Scanning…", "working": "Please wait…", "checking": "Checking…", "installing": "Installing…",
        "ok": "OK", "cancel": "Cancel",
        "clean_confirm": "Clean the game copy cache? Rebuildable copies are deleted; saves are not affected.",
        "uninst1": "Uninstall PocketMZ?",
        "uninst2": "Saves are copied to /storage/pocketmz-saves-* first, then all PocketMZ files are removed. Continue?",
        "install_q": "Install {0}?\nCurrent version: {1}", "up_to_date": "Already up to date ({0})",
        "no_pkg": "No update package found",
        "take_effect": "Takes effect on next start.", "scan_empty": "(no output)",
        "missing": "Missing script: {0}", "exit_code": "Command failed (exit code {0})",
        "version": "Version", "games": "Games", "launchers": "Launchers", "withSaves": "With saves",
        "dataSize": "Data size", "free": "Free space", "ver_line": "Version {0}",
    },
}


def pick_lang():
    v = os.environ.get("POCKETMZ_UI_LANG", "").strip().lower()
    if v.startswith("ja"):
        return "ja"
    if v.startswith("zh") or not v:
        return "zh"
    return "en"


T = I18N[pick_lang()]
INFO_KEYS = ("version", "games", "launchers", "withSaves", "dataSize", "free")


# ---------- settings.json ----------
DEFAULTS = {"defaultFps": 30, "renderScale": "auto", "stopES": False}


def settings_path():
    return os.path.join(RZ, "settings.json")


def load_settings():
    """Existing file merged over the defaults; a missing/bad file or bad values fall back."""
    s = dict(DEFAULTS)
    try:
        with open(settings_path(), "r", encoding="utf-8-sig") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return s
    if not isinstance(d, dict):
        return s
    if d.get("defaultFps") in (30, 60) and not isinstance(d.get("defaultFps"), bool):
        s["defaultFps"] = int(d["defaultFps"])
    if d.get("renderScale") in ("auto", "off"):
        s["renderScale"] = d["renderScale"]
    if isinstance(d.get("stopES"), bool):
        s["stopES"] = d["stopES"]
    return s


def save_settings(s):
    """Atomic write (tmp + rename). Returns True on success."""
    try:
        os.makedirs(RZ, exist_ok=True)
        dst = settings_path()
        tmp = dst + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({k: s[k] for k in DEFAULTS}, f, indent=1)
        os.replace(tmp, dst)
        return True
    except OSError as e:
        sys.stderr.write("write settings.json failed: %s\n" % e)
        return False


# ---------- running the scripts ----------
def read_version():
    try:
        with open(os.path.join(PMZ, "VERSION"), "r", encoding="utf-8-sig") as f:
            return f.readline().strip() or "?"
    except OSError:
        return "?"


def run_cmd(args, timeout=1800):
    """Run a command, merged stdout+stderr. Returns (returncode, text)."""
    try:
        p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                           timeout=timeout, stdin=subprocess.DEVNULL)
        return p.returncode, p.stdout.decode("utf-8", "replace")
    except FileNotFoundError as e:
        return 127, str(e)
    except subprocess.TimeoutExpired:
        return 124, "timeout"
    except Exception as e:  # never let a worker thread die silently
        return 1, repr(e)


def parse_maint_output(out, rc):
    """-> (ok, message, body_lines). The last non-empty line should be 'OK <msg>' / 'ERROR <msg>'."""
    lines = [ln.rstrip("\r") for ln in out.splitlines() if ln.strip()]
    if not lines:
        return False, T["exit_code"].format(rc), []
    m = re.match(r"^(OK|ERROR)\b[ \t]*(.*)$", lines[-1].strip())
    if m:
        return m.group(1) == "OK", m.group(2).strip(), lines[:-1]
    return False, lines[-1].strip(), lines[:-1]


def maint(sub, *args):
    script = os.path.join(PMZ, "pocketmz-maint.sh")
    if not os.path.isfile(script):
        return False, T["missing"].format("pocketmz-maint.sh"), []
    rc, out = run_cmd(["bash", script, sub] + list(args))
    return parse_maint_output(out, rc)


def parse_info(lines):
    d = {}
    for ln in lines:
        if "=" in ln:
            k, v = ln.split("=", 1)
            d[k.strip()] = v.strip()
    return d


def info_rows(d):
    rows = [(T.get(k, k), d[k]) for k in INFO_KEYS if k in d]
    rows += [(k, v) for k, v in d.items() if k not in INFO_KEYS]
    return rows


def parse_package(body, msg):
    """find-package OK output: first line 'path<TAB>version' (fall back to the OK message)."""
    for cand in (body[0] if body else "", msg):
        if "\t" in cand:
            p, v = cand.split("\t", 1)
            if p.strip():
                return p.strip(), v.strip()
    return "", ""


def selftest():
    global RZ
    if not os.environ.get("POCKETMZ_DATA"):
        RZ = tempfile.mkdtemp(prefix="pmz-selftest-")
    assert load_settings() == DEFAULTS, "defaults when file is missing"
    s = load_settings()
    s["defaultFps"], s["renderScale"], s["stopES"] = 60, "off", True
    assert save_settings(s)
    assert load_settings() == {"defaultFps": 60, "renderScale": "off", "stopES": True}
    assert not os.path.exists(settings_path() + ".tmp")
    with open(settings_path(), "w") as f:
        f.write("{not json")
    assert load_settings() == DEFAULTS, "bad file tolerated"
    with open(settings_path(), "w") as f:
        f.write('{"defaultFps": 45, "renderScale": 3, "stopES": "yes"}')
    assert load_settings() == DEFAULTS, "bad values fall back"
    ok, msg, body = parse_maint_output(
        "version=1.2.0\ngames=14\nlaunchers=3\nwithSaves=5\ndataSize=1.4G\nfree=22G\nOK info\n", 0)
    assert ok and msg == "info" and len(body) == 6
    rows = info_rows(parse_info(body))
    assert rows[0] == (T["version"], "1.2.0") and rows[5] == (T["free"], "22G"), rows
    ok, msg, body = parse_maint_output("/storage/up/pocketmz-1.3.0.tar\t1.3.0\nOK found\n", 0)
    assert ok and parse_package(body, msg) == ("/storage/up/pocketmz-1.3.0.tar", "1.3.0")
    ok, msg, body = parse_maint_output("ERROR no package in /storage/roms\n", 1)
    assert not ok and msg == "no package in /storage/roms"
    ok, msg, _ = parse_maint_output("something odd\nlast line\n", 1)
    assert not ok and msg == "last line"
    ok, msg, _ = parse_maint_output("", 3)
    assert not ok and "3" in msg
    assert parse_package([], "OK") == ("", "")
    print("selftest ok")
    return 0


# ================= SDL side =================
if sdl2:
    KEYMAP = {
        sdl2.SDLK_LEFT: "left", sdl2.SDLK_RIGHT: "right", sdl2.SDLK_UP: "up", sdl2.SDLK_DOWN: "down",
        sdl2.SDLK_RETURN: "ok", sdl2.SDLK_KP_ENTER: "ok", sdl2.SDLK_ESCAPE: "back",
    }
    PADMAP = {
        sdl2.SDL_CONTROLLER_BUTTON_DPAD_LEFT: "left", sdl2.SDL_CONTROLLER_BUTTON_DPAD_RIGHT: "right",
        sdl2.SDL_CONTROLLER_BUTTON_DPAD_UP: "up", sdl2.SDL_CONTROLLER_BUTTON_DPAD_DOWN: "down",
        sdl2.SDL_CONTROLLER_BUTTON_A: "ok", sdl2.SDL_CONTROLLER_BUTTON_B: "back",
    }
DIRS = ("up", "down", "left", "right")
DEADZONE = 16000
REPEAT_FIRST = 0.35
REPEAT_NEXT = 0.09
TEXT_CACHE_MAX = 400


def col(c, a=255):
    return sdl2.SDL_Color(c[0], c[1], c[2], a)


class App:
    def __init__(self):
        self.cfg = load_settings()
        self.stack = []             # pages; each {"title","items","idx","top","note","hint"}
        self.dialog = None          # {"text","rows","confirm","warn","yes","on_yes","on_close"}
        self.busy = None            # {"text","thread","res","cb"}
        self.finish = False
        self.dirty = True
        self.held = None            # [source, action, next_time]
        self.stick = [0, 0]
        self.stick_dir = None
        self.pads = {}
        self.win = None
        self.ren = None
        self.W = 640
        self.H = 480
        self.s = 1.0
        self.font_path = None
        self.fonts = {}
        self.tcache = {}
        self.measure_cache = {}
        self.stack.append(self.main_page())

    # ================= SDL setup =================
    def init_sdl(self):
        sdl2.SDL_SetHint(sdl2.SDL_HINT_RENDER_SCALE_QUALITY, b"1")
        sdl2.SDL_SetHint(b"SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS", b"1")
        sdl2.SDL_SetHint(b"SDL_VIDEO_WAYLAND_WMCLASS", b"pocketmz-settings")
        sdl2.SDL_SetHint(b"SDL_VIDEO_X11_WMCLASS", b"pocketmz-settings")
        if sdl2.SDL_Init(sdl2.SDL_INIT_VIDEO | sdl2.SDL_INIT_GAMECONTROLLER | sdl2.SDL_INIT_EVENTS) != 0:
            raise RuntimeError("SDL_Init: " + sdl2.SDL_GetError().decode("utf-8", "replace"))
        if ttf.TTF_Init() != 0:
            raise RuntimeError("TTF_Init failed")
        if os.path.exists(GAMEPAD_DB):
            sdl2.SDL_GameControllerAddMappingsFromFile(os.fsencode(GAMEPAD_DB))
        self.win = sdl2.SDL_CreateWindow(
            b"PocketMZ Settings", sdl2.SDL_WINDOWPOS_UNDEFINED, sdl2.SDL_WINDOWPOS_UNDEFINED, 640, 480,
            sdl2.SDL_WINDOW_FULLSCREEN_DESKTOP)
        if not self.win:
            raise RuntimeError("SDL_CreateWindow: " + sdl2.SDL_GetError().decode("utf-8", "replace"))
        self.ren = sdl2.SDL_CreateRenderer(
            self.win, -1, sdl2.SDL_RENDERER_ACCELERATED | sdl2.SDL_RENDERER_PRESENTVSYNC)
        if not self.ren:
            self.ren = sdl2.SDL_CreateRenderer(self.win, -1, sdl2.SDL_RENDERER_SOFTWARE)
        if not self.ren:
            raise RuntimeError("SDL_CreateRenderer: " + sdl2.SDL_GetError().decode("utf-8", "replace"))
        sdl2.SDL_SetRenderDrawBlendMode(self.ren, sdl2.SDL_BLENDMODE_BLEND)
        sdl2.SDL_ShowCursor(0)
        for p in FONT_CANDIDATES:
            if os.path.exists(p):
                self.font_path = p
                break
        if not self.font_path:
            raise RuntimeError("no usable font found")
        for i in range(sdl2.SDL_NumJoysticks()):
            self.open_pad(i)
        self.update_size()

    def open_pad(self, dev_index):
        try:
            if not sdl2.SDL_IsGameController(dev_index):
                return
            c = sdl2.SDL_GameControllerOpen(dev_index)
            if not c:
                return
            iid = sdl2.SDL_JoystickInstanceID(sdl2.SDL_GameControllerGetJoystick(c))
            self.pads[iid] = c
        except Exception as e:  # a broken pad must not stop the screen
            sys.stderr.write("open pad failed: %s\n" % e)

    def close_pad(self, iid):
        c = self.pads.pop(iid, None)
        if c:
            sdl2.SDL_GameControllerClose(c)

    def update_size(self):
        w = ctypes.c_int()
        h = ctypes.c_int()
        sdl2.SDL_GetRendererOutputSize(self.ren, ctypes.byref(w), ctypes.byref(h))
        if w.value > 0 and h.value > 0:
            self.W, self.H = w.value, h.value
        self.s = min(self.W / 640.0, self.H / 480.0)
        self.free_text_cache()
        self.measure_cache.clear()
        for f in self.fonts.values():
            ttf.TTF_CloseFont(f)
        self.fonts.clear()
        self.dirty = True

    def S(self, v):
        return int(round(v * self.s))

    def fs(self, size):
        return max(8, int(round(size * self.s)))

    # ================= text =================
    def font(self, px):
        f = self.fonts.get(px)
        if f is None:
            f = ttf.TTF_OpenFont(os.fsencode(self.font_path), px)
            if not f:
                raise RuntimeError("TTF_OpenFont failed")
            self.fonts[px] = f
        return f

    def text_w(self, txt, px):
        if not txt:
            return 0
        k = (txt, px)
        v = self.measure_cache.get(k)
        if v is None:
            w = ctypes.c_int()
            h = ctypes.c_int()
            ttf.TTF_SizeUTF8(self.font(px), txt.encode("utf-8"), ctypes.byref(w), ctypes.byref(h))
            v = w.value
            if len(self.measure_cache) > 4000:
                self.measure_cache.clear()
            self.measure_cache[k] = v
        return v

    def get_tex(self, txt, px, color):
        k = (txt, px, color)
        v = self.tcache.get(k)
        if v is not None:
            return v
        surf = ttf.TTF_RenderUTF8_Blended(self.font(px), txt.encode("utf-8"), col(color))
        if not surf:
            return None
        tex = sdl2.SDL_CreateTextureFromSurface(self.ren, surf)
        w, h = surf.contents.w, surf.contents.h
        sdl2.SDL_FreeSurface(surf)
        if not tex:
            return None
        sdl2.SDL_SetTextureBlendMode(tex, sdl2.SDL_BLENDMODE_BLEND)
        v = (tex, w, h)
        self.tcache[k] = v
        return v

    def free_text_cache(self):
        for tex, _, _ in self.tcache.values():
            sdl2.SDL_DestroyTexture(tex)
        self.tcache.clear()

    def put(self, txt, size, color, x, y, h=None, align="l", w=None):
        """Draw one line. (x, y) = top-left of the box; h centres vertically; w + align horizontally."""
        if not txt:
            return 0
        v = self.get_tex(txt, self.fs(size), color)
        if v is None:
            return 0
        tex, tw, th = v
        dx = x
        if w is not None:
            if align == "c":
                dx = x + (w - tw) // 2
            elif align == "r":
                dx = x + w - tw
        dy = y + ((h - th) // 2 if h is not None else 0)
        sdl2.SDL_RenderCopy(self.ren, tex, None, sdl2.SDL_Rect(dx, dy, tw, th))
        return tw

    def fit(self, txt, px, maxw):
        """Ellipsize with '…' to fit maxw pixels."""
        if self.text_w(txt, px) <= maxw:
            return txt
        lo, hi = 0, len(txt)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self.text_w(txt[:mid] + "…", px) <= maxw:
                lo = mid
            else:
                hi = mid - 1
        return txt[:lo] + "…"

    def wrap(self, txt, px, maxw):
        """Character-level wrap by pixel width (CJK-safe); '\\n' starts a new line."""
        out = []
        for para in txt.replace("\t", " ").split("\n"):
            cur = ""
            for ch in para:
                if cur and self.text_w(cur + ch, px) > maxw:
                    out.append(cur.rstrip())
                    cur = "" if ch == " " else ch
                else:
                    cur += ch
            out.append(cur.rstrip())
        return out

    # ================= primitives =================
    def fill(self, x, y, w, h, c, a=255):
        if w <= 0 or h <= 0:
            return
        sdl2.SDL_SetRenderDrawColor(self.ren, c[0], c[1], c[2], a)
        sdl2.SDL_RenderFillRect(self.ren, sdl2.SDL_Rect(x, y, w, h))

    def rrect(self, x, y, w, h, r, c, a=255):
        if r <= 1 or w < 2 * r or h < 2 * r:
            self.fill(x, y, w, h, c, a)
            return
        self.fill(x, y + r, w, h - 2 * r, c, a)
        for i in range(r):
            off = r - int(math.sqrt(max(0.0, r * r - (r - i - 0.5) ** 2)))
            self.fill(x + off, y + i, w - 2 * off, 1, c, a)
            self.fill(x + off, y + h - 1 - i, w - 2 * off, 1, c, a)

    def rrect_border(self, x, y, w, h, r, bw, border, c):
        self.rrect(x, y, w, h, r, border)
        self.rrect(x + bw, y + bw, w - 2 * bw, h - 2 * bw, max(0, r - bw), c)

    # ================= pages =================
    def page(self, title, items, note=None, hint=None):
        return {"title": title, "items": items, "idx": 0, "top": 0, "note": note, "hint": hint or T["hint"]}

    def main_page(self):
        return self.page(T["settings"], [
            {"label": T["scan"], "fn": self.do_scan},
            {"label": T["defaults"], "sub": True, "fn": lambda: self.push(self.defaults_page())},
            {"label": T["saves"], "sub": True, "fn": lambda: self.push(self.saves_page())},
            {"label": T["runtime"], "sub": True, "fn": lambda: self.push(self.runtime_page())},
            {"label": T["about"], "fn": self.show_about},
            {"label": T["exit"], "fn": self.quit},
        ])

    def defaults_page(self):
        return self.page(T["defaults"], [
            {"label": T["d_fps"], "cycle": "defaultFps", "opts": [30, 60],
             "show": lambda v: str(v)},
            {"label": T["d_scale"], "cycle": "renderScale", "opts": ["auto", "off"],
             "show": lambda v: T["scale_auto"] if v == "auto" else T["scale_off"]},
            {"label": T["d_stopes"], "cycle": "stopES", "opts": [False, True],
             "show": lambda v: T["on"] if v else T["off"]},
        ], note=T["d_note"], hint=T["hint_cycle"])

    def saves_page(self):
        return self.page(T["saves"], [
            {"label": T["s_export"], "fn": lambda: self.run_maint(T["working"], ("export-saves",), self.show_result)},
            {"label": T["s_clean"], "fn": lambda: self.confirm(
                T["clean_confirm"], lambda: self.run_maint(T["working"], ("clean-copies",), self.show_result))},
        ])

    def runtime_page(self):
        return self.page(T["runtime"], [
            {"label": T["r_info"], "fn": self.do_info},
            {"label": T["r_update"], "fn": self.do_find_package},
            {"label": T["r_uninstall"], "fn": self.do_uninstall},
        ])

    def push(self, p):
        self.stack.append(p)
        self.dirty = True

    def pop(self):
        if len(self.stack) > 1:
            self.stack.pop()
            self.dirty = True
        else:
            self.quit()

    def quit(self):
        self.finish = True

    # ================= dialogs / busy =================
    def message(self, text, rows=None, warn=False, on_close=None):
        self.dialog = {"text": text, "rows": rows, "confirm": False, "warn": warn, "yes": True,
                       "on_yes": None, "on_close": on_close}
        self.dirty = True

    def confirm(self, text, on_yes, warn=False, default_yes=False):
        self.dialog = {"text": text, "rows": None, "confirm": True, "warn": warn, "yes": default_yes,
                       "on_yes": on_yes, "on_close": None}
        self.dirty = True

    def show_result(self, ok, msg, extra=None, on_close=None):
        self.message(msg if not extra else msg + "\n" + extra, warn=not ok, on_close=on_close if ok else None)

    def run_async(self, text, func, cb):
        """func runs in a thread (no SDL calls in it); cb(result) runs on the main loop."""
        b = {"text": text, "res": None, "cb": cb}

        def work():
            try:
                b["res"] = func()
            except Exception as e:
                b["res"] = (False, repr(e), [])
        b["thread"] = threading.Thread(target=work, daemon=True)
        self.busy = b
        self.held = None
        b["thread"].start()
        self.dirty = True

    def run_maint(self, text, args, cb):
        self.run_async(text, lambda: maint(*args), lambda r: cb(r[0], r[1]))

    def poll_busy(self):
        b = self.busy
        if b and not b["thread"].is_alive():
            self.busy = None
            self.dirty = True
            b["cb"](b["res"])

    # ================= actions =================
    def do_scan(self):
        def work():
            script = os.path.join(PMZ, "pocketmz-scan.sh")
            if not os.path.isfile(script):
                return False, T["missing"].format("pocketmz-scan.sh"), []
            rc, out = run_cmd(["bash", script])
            lines = [ln.rstrip() for ln in out.splitlines() if ln.strip()]
            return rc == 0, "\n".join(lines[-6:]) or T["scan_empty"], []
        self.run_async(T["scanning"], work, lambda r: self.show_result(r[0], r[1]))

    def do_info(self):
        def done(r):
            ok, msg, body = r
            rows = info_rows(parse_info(body)) if ok else []
            if ok and rows:
                self.message("", rows=rows)
            else:
                self.show_result(ok, msg)
        self.run_async(T["working"], lambda: maint("info"), done)

    def do_find_package(self):
        def done(r):
            ok, msg, body = r
            if not ok:
                return self.show_result(False, msg)
            path, ver = parse_package(body, msg)
            if not path:
                return self.show_result(True, T["no_pkg"])
            cur = read_version()
            if ver == cur:
                return self.show_result(True, T["up_to_date"].format(cur))
            self.confirm(T["install_q"].format(ver or "?", cur), lambda: self.run_maint(
                T["installing"], ("update", path),
                lambda ok2, msg2: self.show_result(ok2, msg2, T["take_effect"] if ok2 else None)),
                default_yes=True)
        self.run_async(T["checking"], lambda: maint("find-package"), done)

    def do_uninstall(self):
        def finish(ok, msg):
            self.show_result(ok, msg, on_close=self.quit)
        self.confirm(T["uninst1"], lambda: self.confirm(
            T["uninst2"], lambda: self.run_maint(T["working"], ("uninstall",), finish), warn=True))

    def show_about(self):
        self.message("PocketMZ\n%s\nMIT License\nRPG Maker MV/MZ runner for handhelds\n%s"
                     % (T["ver_line"].format(read_version()), PROJECT_URL))

    def cycle(self, item, d):
        opts = item["opts"]
        key = item["cycle"]
        cur = self.cfg.get(key)
        i = opts.index(cur) if cur in opts else 0
        self.cfg[key] = opts[(i + d) % len(opts)]
        save_settings(self.cfg)
        self.dirty = True

    # ================= drawing =================
    def draw(self):
        if len(self.tcache) > TEXT_CACHE_MAX:
            self.free_text_cache()
        r = self.ren
        sdl2.SDL_SetRenderDrawColor(r, BG[0], BG[1], BG[2], 255)
        sdl2.SDL_RenderClear(r)
        self.draw_page(self.stack[-1])
        if self.dialog:
            self.draw_dialog(self.dialog)
        if self.busy:
            self.draw_busy(self.busy["text"])
        sdl2.SDL_RenderPresent(r)

    def draw_page(self, pg):
        S = self.S
        ox = (self.W - S(640)) // 2
        oy = (self.H - S(480)) // 2
        px, pw = ox + S(12), S(616)
        hy, hh = oy + S(8), S(32)
        bw = self.put("PocketMZ", 16, ACCENT, px, hy, hh)
        self.put("·  " + pg["title"], 16, TEXT, px + bw + S(8), hy, hh)
        self.fill(px, hy + hh + S(2), pw, 1, KEY_BORDER)
        hint_h = S(28)
        hint_y = oy + S(480) - S(8) - hint_h
        self.rrect(px, hint_y, pw, hint_h, S(6), PANEL)
        self.put(self.fit(pg["hint"], self.fs(13), pw - S(16)), 13, SECOND, px, hint_y, hint_h, "c", pw)
        # rows
        y0 = hy + hh + S(12)
        row_h, gap = S(46), S(6)
        note_lines = self.wrap(pg["note"], self.fs(13), pw - S(8)) if pg["note"] else []
        note_h = (len(note_lines) * S(20) + S(8)) if note_lines else 0
        vis = max(1, (hint_y - S(8) - y0 - note_h + gap) // (row_h + gap))
        items = pg["items"]
        if pg["idx"] < pg["top"]:
            pg["top"] = pg["idx"]
        elif pg["idx"] >= pg["top"] + vis:
            pg["top"] = pg["idx"] - vis + 1
        shown = items[pg["top"]:pg["top"] + vis]
        for n, it in enumerate(shown):
            i = pg["top"] + n
            y = y0 + n * (row_h + gap)
            if i == pg["idx"]:
                self.rrect_border(px, y, pw, row_h, S(6), S(2), ACCENT, CARD_SEL)
            else:
                self.rrect(px, y, pw, row_h, S(6), CARD)
            self.put(it["label"], 18, TEXT, px + S(16), y, row_h)
            if "cycle" in it:
                v = it["show"](self.cfg.get(it["cycle"]))
                if i == pg["idx"]:
                    v = "◀  " + v + "  ▶"
                self.put(v, 18, ACCENT, px, y, row_h, "r", pw - S(16))
            elif it.get("sub"):
                self.put("›", 18, ACCENT if i == pg["idx"] else SECOND, px, y, row_h, "r", pw - S(16))
        yy = y0 + len(shown) * (row_h + gap) + S(4)
        for ln in note_lines:
            self.put(ln, 13, SECOND, px + S(4), yy, S(20))
            yy += S(20)

    def draw_dialog(self, d):
        S = self.S
        self.fill(0, 0, self.W, self.H, (0, 0, 0), 176)
        px = self.fs(16)
        pad_x, pad_y, bd = S(22), S(18), S(2)
        maxw = int(self.W * 0.86) - 2 * (pad_x + bd)
        lines = self.wrap(d["text"], px, maxw)[:12] if d["text"] else []
        lh = int(px * 1.6)
        rows = d["rows"] or []
        lw = max((self.text_w(k, px) for k, _ in rows), default=0)
        vw = max((self.text_w(v, px) for _, v in rows), default=0)
        vw = min(vw, max(S(40), maxw - lw - S(24)))
        rows_w = (lw + S(24) + vw) if rows else 0
        labels = [T["ok"], T["cancel"]] if d["confirm"] else [T["ok"]]
        bh = int(px * 1.4) + S(8)
        bgap = S(16)
        bws = [max(S(76), self.text_w(lbl, px) + 2 * S(14)) for lbl in labels]
        row_w = sum(bws) + bgap * (len(bws) - 1)
        tw = max((self.text_w(ln, px) for ln in lines), default=0)
        inner = min(maxw, max(tw, rows_w, row_w))
        bw_ = inner + 2 * (pad_x + bd)
        body_h = lh * len(lines) + lh * len(rows) + (S(6) if lines and rows else 0)
        bh_ = 2 * (pad_y + bd) + body_h + S(14) + bh
        bx = (self.W - bw_) // 2
        by = (self.H - bh_) // 2
        edge = WARN if d["warn"] else ACCENT
        self.rrect_border(bx, by, bw_, bh_, S(8), bd, edge, CARD)
        y = by + bd + pad_y
        for ln in lines:
            self.put(ln, 16, WARN if d["warn"] and d["confirm"] else TEXT, bx, y, lh, "c", bw_)
            y += lh
        if lines and rows:
            y += S(6)
        rx = bx + (bw_ - rows_w) // 2
        for k, v in rows:
            self.put(k, 16, SECOND, rx, y, lh)
            self.put(self.fit(v, px, vw), 16, TEXT, rx + lw + S(24), y, lh)
            y += lh
        y += S(14)
        x = bx + (bw_ - row_w) // 2
        for n, (lbl, w) in enumerate(zip(labels, bws)):
            on = (d["yes"] if n == 0 else not d["yes"]) if d["confirm"] else True
            self.rrect(x, y, w, bh, S(6), (WARN_BG if d["warn"] else ACCENT) if on else PANEL)
            self.put(lbl, 16, WHITE if on else SECOND, x, y, bh, "c", w)
            x += w + bgap

    def draw_busy(self, text):
        S = self.S
        self.fill(0, 0, self.W, self.H, BG, 235)
        cx, cy = self.W // 2, self.H // 2 - S(28)
        phase = int(time.monotonic() * 10) % 8
        sz = S(8)
        for i in range(8):
            a = 255 - ((phase - i) % 8) * 28
            ang = i * math.pi / 4
            self.fill(int(cx + math.cos(ang) * S(22)) - sz // 2, int(cy + math.sin(ang) * S(22)) - sz // 2,
                      sz, sz, ACCENT, max(40, a))
        self.put(text, 18, TEXT, 0, cy + S(44), S(26), "c", self.W)

    # ================= input =================
    def dispatch(self, a):
        if self.busy:
            return
        d = self.dialog
        if d:
            if d["confirm"]:
                if a == "left":
                    d["yes"] = True
                elif a == "right":
                    d["yes"] = False
                elif a in ("ok", "back"):
                    yes = d["yes"] and a == "ok"
                    self.dialog = None
                    if yes and d["on_yes"]:
                        d["on_yes"]()
                else:
                    return
            elif a in ("ok", "back"):
                self.dialog = None
                if d["on_close"]:
                    d["on_close"]()
            else:
                return
            self.dirty = True
            return
        pg = self.stack[-1]
        items = pg["items"]
        it = items[pg["idx"]]
        if a == "up":
            pg["idx"] = (pg["idx"] - 1) % len(items)
        elif a == "down":
            pg["idx"] = (pg["idx"] + 1) % len(items)
        elif a in ("left", "right"):
            if "cycle" in it:
                self.cycle(it, -1 if a == "left" else 1)
        elif a == "ok":
            if "cycle" in it:
                self.cycle(it, 1)
            elif it.get("fn"):
                it["fn"]()
        elif a == "back":
            self.pop()
        self.dirty = True

    def now(self):
        return time.monotonic()

    def press(self, a, src):
        self.dispatch(a)
        if a in DIRS:
            self.held = [src, a, self.now() + REPEAT_FIRST]

    def release(self, a, src):
        if self.held and self.held[0] == src and self.held[1] == a:
            self.held = None

    def on_stick(self):
        x, y = self.stick
        d = None
        if abs(x) > DEADZONE and abs(x) >= abs(y):
            d = "right" if x > 0 else "left"
        elif abs(y) > DEADZONE:
            d = "down" if y > 0 else "up"
        if d != self.stick_dir:
            if self.stick_dir:
                self.release(self.stick_dir, "stick")
            self.stick_dir = d
            if d:
                self.press(d, "stick")

    def handle(self, e):
        t = e.type
        if t == sdl2.SDL_QUIT:
            self.finish = True
        elif t == sdl2.SDL_KEYDOWN:
            if e.key.repeat:
                return
            a = KEYMAP.get(e.key.keysym.sym)
            if a:
                self.press(a, "key")
        elif t == sdl2.SDL_KEYUP:
            a = KEYMAP.get(e.key.keysym.sym)
            if a in DIRS:
                self.release(a, "key")
        elif t == sdl2.SDL_CONTROLLERBUTTONDOWN:
            a = PADMAP.get(e.cbutton.button)
            if a:
                self.press(a, "pad")
        elif t == sdl2.SDL_CONTROLLERBUTTONUP:
            a = PADMAP.get(e.cbutton.button)
            if a in DIRS:
                self.release(a, "pad")
        elif t == sdl2.SDL_CONTROLLERAXISMOTION:
            ax = e.caxis.axis
            if ax == sdl2.SDL_CONTROLLER_AXIS_LEFTX:
                self.stick[0] = e.caxis.value
                self.on_stick()
            elif ax == sdl2.SDL_CONTROLLER_AXIS_LEFTY:
                self.stick[1] = e.caxis.value
                self.on_stick()
        elif t == sdl2.SDL_CONTROLLERDEVICEADDED:
            self.open_pad(e.cdevice.which)
        elif t == sdl2.SDL_CONTROLLERDEVICEREMOVED:
            self.close_pad(e.cdevice.which)
        elif t == sdl2.SDL_WINDOWEVENT:
            if e.window.event in (sdl2.SDL_WINDOWEVENT_SIZE_CHANGED, sdl2.SDL_WINDOWEVENT_RESIZED):
                self.update_size()
            elif e.window.event in (sdl2.SDL_WINDOWEVENT_EXPOSED, sdl2.SDL_WINDOWEVENT_SHOWN,
                                    sdl2.SDL_WINDOWEVENT_RESTORED, sdl2.SDL_WINDOWEVENT_FOCUS_GAINED):
                self.dirty = True

    # ================= main loop =================
    def run(self):
        self.init_sdl()
        ev = sdl2.SDL_Event()
        while True:
            self.poll_busy()
            if self.busy:
                self.dirty = True           # spinner animation
            if self.dirty:
                self.dirty = False
                self.draw()
            if self.finish:
                break
            now = self.now()
            timeout = 250
            if self.busy:
                timeout = 60
            elif self.held:
                timeout = max(1, min(50, int((self.held[2] - now) * 1000)))
            if sdl2.SDL_WaitEventTimeout(ctypes.byref(ev), timeout):
                self.handle(ev)
                while sdl2.SDL_PollEvent(ctypes.byref(ev)):
                    self.handle(ev)
            if self.finish:
                break
            now = self.now()
            if self.held and now >= self.held[2]:
                self.held[2] = now + REPEAT_NEXT
                self.dispatch(self.held[1])
        self.leave()

    def leave(self):
        try:
            self.free_text_cache()
            for iid in list(self.pads):
                self.close_pad(iid)
            sdl2.SDL_DestroyRenderer(self.ren)
            sdl2.SDL_DestroyWindow(self.win)
            sdl2.SDL_Quit()
        except Exception:
            pass


def main():
    if SELFTEST:
        return selftest()
    try:
        App().run()
    except Exception as e:
        sys.stderr.write("pocketmz-settings failed: %r\n" % (e,))
        import traceback
        traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
