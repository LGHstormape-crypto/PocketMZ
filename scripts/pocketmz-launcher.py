#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# PocketMZ native game menu (SDL2 via the vendored PySDL2).
#
# Replaces the HTML menu (launcher/menu.js + menu.css): a browser needs 15-20 s to start, this
# opens in about 1 s. Same data files as the HTML version, all in the library dir
# ($POCKETMZ_DATA/launcher/library, or argv[1]):
#   library.json  in  : game list written by pocketmz-library.py (may be rewritten while we run)
#   state.json    i/o : favourites, last tab, selected game per tab
#   choice.json   out : {"action":"play","id","dir"} or {"action":"exit"}; then we quit
#   shown.json    out : {"t": unix ms} written after the first frame is presented
#   thumbs/       out : cached card thumbnails (<id>-<w>x<h>.png), so full-size covers are
#                       decoded only once and never kept in memory
import colorsys
import ctypes
import datetime
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, os.path.join(HERE, "vendor"))
os.environ.setdefault("PYSDL2_DLL_PATH", "/usr/lib")
if sys.platform.startswith("linux"):
    os.environ.setdefault("SDL_VIDEODRIVER", "wayland")
os.environ["SDL_VIDEO_WAYLAND_WMCLASS"] = "pocketmz-menu"   # app_id; the caller focuses by it

import sdl2
import sdl2.sdlimage as img
import sdl2.sdlttf as ttf

RZ = os.environ.get("POCKETMZ_DATA", "/storage/pocketmz")
LIB = sys.argv[1] if len(sys.argv) > 1 else os.path.join(RZ, "launcher", "library")
COLS = 3
RECENT_MAX = 12

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/noto-cjk/NotoSansCJKsc-Regular.otf",
    "/storage/pocketmz/root-sqfs/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/config/emulationstation/resources/DroidSansFallbackFull.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]
# The device's own mapping (PortMaster's get_controls writes it and exports the path; on this
# handheld it swaps A/B against SDL's default), else PortMaster's generic database.
GAMEPAD_DB = os.environ.get("SDL_GAMECONTROLLERCONFIG_FILE") or "/storage/roms/ports/PortMaster/gamecontrollerdb.txt"

# ---------- colours ----------
BG = (0x14, 0x16, 0x1c)
CARD = (0x23, 0x27, 0x33)
CARD_SEL = (0x2c, 0x33, 0x45)
PANEL = (0x1d, 0x21, 0x2b)
ACCENT = (0x4f, 0x8c, 0xff)
TEXT = (0xe8, 0xea, 0xf0)
SECOND = (0x9a, 0xa3, 0xb5)
WARN = (0xff, 0x6b, 0x6b)
WARN_BG = (0xb0, 0x3a, 0x3a)
BADGE_BG = (0x2c, 0x33, 0x45)
BADGE_TX = (0xcf, 0xd5, 0xe3)
COVER_BG = (0x1a, 0x1d, 0x26)
KEY_BORDER = (0x3a, 0x40, 0x54)
GOLD = (0xff, 0xcf, 0x33)
WHITE = (255, 255, 255)

# ---------- i18n (same strings as menu.js) ----------
I18N = {
    "zh": {
        "recent": "最近", "all": "全部", "fav": "收藏",
        "hints": "A 启动 · X 收藏 · L1/R1 分类 · B 退出",
        "convBadge": "需要转换",
        "convWarn": "此游戏的脚本被打包在 Game.exe 里，需要先在电脑上用 PocketMZ 转换器处理",
        "convMsg": "此游戏需要先在电脑上用 PocketMZ 转换器处理，才能在这里运行。",
        "today": "今天", "yesterday": "昨天", "daysAgo": lambda n: "%d 天前" % n, "never": "从未",
        "launching": lambda t: "正在启动「" + t + "」…",
        "quit": "退出 PocketMZ？", "no": "否", "yes": "是", "ok": "好",
        "empty": "没有找到游戏。把 RPG Maker MV/MZ 游戏文件夹放进 roms/rpgmaker，再打开 PocketMZ。",
        "err": "读取游戏列表失败：",
        "scanning": "正在查找游戏…",
    },
    "ja": {
        "recent": "最近遊んだ", "all": "すべて", "fav": "お気に入り",
        "hints": "A 起動 · X お気に入り · L1/R1 分類 · B 終了",
        "convBadge": "変換が必要",
        "convWarn": "このゲームのスクリプトは Game.exe に埋め込まれています。先にパソコンで PocketMZ コンバーターを実行してください",
        "convMsg": "このゲームは、先にパソコンで PocketMZ コンバーターを実行しないと起動できません。",
        "today": "今日", "yesterday": "昨日", "daysAgo": lambda n: "%d 日前" % n, "never": "未プレイ",
        "launching": lambda t: "「" + t + "」を起動中…",
        "quit": "PocketMZ を終了しますか？", "no": "いいえ", "yes": "はい", "ok": "OK",
        "empty": "ゲームが見つかりません。RPG Maker MV/MZ のゲームフォルダを roms/rpgmaker に入れてから、PocketMZ を開いてください。",
        "err": "ゲーム一覧の読み込みに失敗しました：",
        "scanning": "ゲームを探しています…",
    },
    "en": {
        "recent": "Recent", "all": "All", "fav": "Favorites",
        "hints": "A Play · X Favorite · L1/R1 Tabs · B Exit",
        "convBadge": "Needs conversion",
        "convWarn": "This game's scripts are packed inside Game.exe. Process it on a PC with the PocketMZ converter first.",
        "convMsg": "This game must be processed on a PC with the PocketMZ converter before it can run here.",
        "today": "Today", "yesterday": "Yesterday", "daysAgo": lambda n: "%d days ago" % n, "never": "Never",
        "launching": lambda t: "Starting \"" + t + "\"…",
        "quit": "Exit PocketMZ?", "no": "No", "yes": "Yes", "ok": "OK",
        "empty": "No games found. Put RPG Maker MV/MZ game folders into roms/rpgmaker, then open PocketMZ again.",
        "err": "Failed to read the game list: ",
        "scanning": "Looking for games…",
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


# ---------- small helpers ----------
def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def hue_of(s):
    h = 0
    for ch in s:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return h % 360


def day_diff(ts):
    a = datetime.date.today()
    try:
        b = datetime.date.fromtimestamp(ts)
    except (OverflowError, OSError, ValueError):
        return 0
    return max(0, (a - b).days)


def last_played_text(ts):
    ts = num(ts)
    if not ts > 0:
        return T["never"]
    d = day_diff(ts)
    return T["today"] if d == 0 else T["yesterday"] if d == 1 else T["daysAgo"](d)


def write_json(name, obj):
    """Atomic write (tmp + rename) into the library dir."""
    try:
        dst = os.path.join(LIB, name)
        tmp = dst + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False))
        os.replace(tmp, dst)
    except OSError as e:
        sys.stderr.write("write %s failed: %s\n" % (name, e))


def read_json(name):
    """Parsed JSON, None if the file does not exist; raises on read/parse errors."""
    try:
        with open(os.path.join(LIB, name), "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def lib_mtime():
    try:
        return os.stat(os.path.join(LIB, "library.json")).st_mtime
    except OSError:
        return 0


def col(c, a=255):
    return sdl2.SDL_Color(c[0], c[1], c[2], a)


def safe_name(s):
    return "".join("_" if ch in '/\\:*?"<>|' else ch for ch in str(s))


# Input action names
DIRS = ("up", "down", "left", "right")
KEYMAP = {
    sdl2.SDLK_LEFT: "left", sdl2.SDLK_RIGHT: "right", sdl2.SDLK_UP: "up", sdl2.SDLK_DOWN: "down",
    sdl2.SDLK_RETURN: "ok", sdl2.SDLK_KP_ENTER: "ok", sdl2.SDLK_ESCAPE: "back",
    sdl2.SDLK_d: "fav", sdl2.SDLK_PAGEUP: "prev", sdl2.SDLK_PAGEDOWN: "next",
}
PADMAP = {
    sdl2.SDL_CONTROLLER_BUTTON_DPAD_LEFT: "left", sdl2.SDL_CONTROLLER_BUTTON_DPAD_RIGHT: "right",
    sdl2.SDL_CONTROLLER_BUTTON_DPAD_UP: "up", sdl2.SDL_CONTROLLER_BUTTON_DPAD_DOWN: "down",
    sdl2.SDL_CONTROLLER_BUTTON_A: "ok", sdl2.SDL_CONTROLLER_BUTTON_B: "back",
    sdl2.SDL_CONTROLLER_BUTTON_X: "fav",
    sdl2.SDL_CONTROLLER_BUTTON_LEFTSHOULDER: "prev", sdl2.SDL_CONTROLLER_BUTTON_RIGHTSHOULDER: "next",
}
DEADZONE = 16000
REPEAT_FIRST = 0.35
REPEAT_NEXT = 0.09
TEXT_CACHE_MAX = 400


class Menu:
    def __init__(self):
        # ---- data ----
        self.games = []
        self.load_error = None
        self.scanning = False
        self.st = {"favorites": [], "tab": "", "selected": {}}
        self.tabs = []
        self.tab_key = "all"
        self.list = []
        self.idx = 0
        self.top_row = 0
        self.vis = 2
        self.mode = "grid"          # grid | confirm | msg | launching
        self.confirm_yes = False
        self.finish = None          # ("play", game) | ("exit", None) once we should leave
        self.dirty = True
        self.first_shown = False
        # ---- input ----
        self.held = None            # [source, action, next_time]
        self.stick = [0, 0]
        self.stick_dir = None
        self.pad_down = set()
        self.pads = {}              # instance id -> controller
        # ---- live refresh ----
        self.live_t0 = time.monotonic()
        self.live_next = 0.0
        self.lib_mtime = 0
        self.lib_pending = False
        # ---- SDL ----
        self.win = None
        self.ren = None
        self.W = 640
        self.H = 480
        self.font_path = None
        self.fonts = {}
        self.tcache = {}            # (text, px, colour) -> (texture, w, h)
        self.measure_cache = {}
        self.memo = {}
        self.thumbs = {}            # game id -> texture | False (no cover / failed)
        self.thumbs_pending = False

    # ================= SDL setup =================
    def init_sdl(self):
        sdl2.SDL_SetHint(sdl2.SDL_HINT_RENDER_SCALE_QUALITY, b"1")
        sdl2.SDL_SetHint(b"SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS", b"1")
        if sdl2.SDL_Init(sdl2.SDL_INIT_VIDEO | sdl2.SDL_INIT_GAMECONTROLLER | sdl2.SDL_INIT_EVENTS) != 0:
            raise RuntimeError("SDL_Init: " + sdl2.SDL_GetError().decode("utf-8", "replace"))
        if ttf.TTF_Init() != 0:
            raise RuntimeError("TTF_Init failed")
        img.IMG_Init(img.IMG_INIT_PNG | img.IMG_INIT_JPG)
        if os.path.exists(GAMEPAD_DB):
            sdl2.SDL_GameControllerAddMappingsFromFile(os.fsencode(GAMEPAD_DB))
        self.win = sdl2.SDL_CreateWindow(
            b"PocketMZ", sdl2.SDL_WINDOWPOS_UNDEFINED, sdl2.SDL_WINDOWPOS_UNDEFINED, 640, 480,
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
        except Exception as e:  # a broken pad must not stop the menu
            sys.stderr.write("open pad failed: %s\n" % e)

    def close_pad(self, iid):
        c = self.pads.pop(iid, None)
        if c:
            sdl2.SDL_GameControllerClose(c)

    def update_size(self):
        w = ctypes.c_int()
        h = ctypes.c_int()
        sdl2.SDL_GetRendererOutputSize(self.ren, ctypes.byref(w), ctypes.byref(h))
        if w.value > 0 and h.value > 0 and (w.value != self.W or h.value != self.H or not hasattr(self, "s")):
            self.W, self.H = w.value, h.value
            self.relayout()
        self.dirty = True

    # ================= layout =================
    def S(self, v):
        return int(round(v * self.s))

    def fs(self, size):
        return max(8, int(round(size * self.s)))

    def relayout(self):
        """Compute all geometry from the 640x480 design scaled to the window."""
        self.s = s = min(self.W / 640.0, self.H / 480.0)
        S = self.S
        self.ox = int((self.W - 640 * s) / 2)
        self.oy = int((self.H - 480 * s) / 2)
        self.px = self.ox + S(12)
        self.pw = S(616)
        self.hdr_y = self.oy + S(8)
        self.hdr_h = S(32)
        self.info_h = S(116)
        self.info_y = self.oy + S(480) - S(6) - self.info_h
        self.gy0 = self.hdr_y + self.hdr_h + S(6)
        self.gy1 = self.info_y - S(6)
        self.gap_x = S(10)
        self.gap_y = S(8)
        self.card_w = (self.pw - 2 * self.gap_x) // COLS
        self.pad = S(6)                       # border 2 + padding 4
        self.cov_w = self.card_w - 2 * self.pad
        self.cov_h = self.cov_w * 9 // 16
        self.title_h = S(20)
        self.card_h = 2 * self.pad + self.cov_h + S(3) + self.title_h
        gh = self.gy1 - self.gy0
        self.vis = max(1, min(6, (gh + self.gap_y) // (self.card_h + self.gap_y)))
        # caches that depend on the scale
        self.free_text_cache()
        self.measure_cache.clear()
        self.memo.clear()
        for f in self.fonts.values():
            ttf.TTF_CloseFont(f)
        self.fonts.clear()
        self.free_thumbs()
        if self.list:
            self.ensure_visible()

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
        px = self.fs(size)
        v = self.get_tex(txt, px, color)
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

    def wrap(self, txt, px, maxw, maxlines):
        """Greedy wrap (breaks at spaces when possible, else per character); the last allowed
        line is ellipsized if the text does not fit."""
        k = (txt, px, maxw, maxlines)
        v = self.memo.get(k)
        if v is not None:
            return v
        starts = []
        lines = []
        i, n = 0, len(txt)
        while i < n and len(lines) < maxlines:
            if txt[i] == "\n":
                i += 1
                continue
            j = i
            last_space = -1
            while j < n and txt[j] != "\n":
                if self.text_w(txt[i:j + 1], px) > maxw and j > i:
                    break
                if txt[j] == " ":
                    last_space = j
                j += 1
            if j < n and txt[j] != "\n" and last_space > i:
                j = last_space + 1
            starts.append(i)
            lines.append(txt[i:j].rstrip())
            i = j
        if i < n and txt[i:].strip():
            lines[-1] = self.fit(txt[starts[-1]:].replace("\n", " "), px, maxw)
        if len(self.memo) > 500:
            self.memo.clear()
        self.memo[k] = lines
        return lines

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

    # ================= library / tabs =================
    def is_fav(self, gid):
        return gid in self.st["favorites"]

    def build_tabs(self):
        out = []
        if any(num(g.get("lastPlayed")) > 0 for g in self.games):
            out.append(("recent", T["recent"]))
        out.append(("all", T["all"]))
        cats = []
        for g in self.games:
            c = g.get("category")
            if c and c not in cats:
                cats.append(c)
        cats.sort(key=lambda c: str(c).casefold())
        for c in cats:
            out.append(("cat:" + str(c), str(c)))
        if any(self.is_fav(g["id"]) for g in self.games):
            out.append(("fav", T["fav"]))
        return out

    def list_for(self, key):
        if key == "recent":
            lst = [g for g in self.games if num(g.get("lastPlayed")) > 0]
            lst.sort(key=lambda g: -num(g.get("lastPlayed")))
            return lst[:RECENT_MAX]
        if key == "fav":
            return [g for g in self.games if self.is_fav(g["id"])]
        if key.startswith("cat:"):
            c = key[4:]
            return [g for g in self.games if str(g.get("category")) == c and g.get("category")]
        return list(self.games)

    def has_tab(self, key):
        return any(k == key for k, _ in self.tabs)

    def remember(self):
        if 0 <= self.idx < len(self.list):
            self.st["selected"][self.tab_key] = self.list[self.idx]["id"]

    def ensure_visible(self):
        row = self.idx // COLS
        if row < self.top_row:
            self.top_row = row
        elif row >= self.top_row + self.vis:
            self.top_row = row - self.vis + 1
        max_top = max(0, -(-len(self.list) // COLS) - self.vis)
        self.top_row = max(0, min(self.top_row, max_top))

    def set_tab(self, key):
        if not self.has_tab(key):
            key = "all"
        self.tab_key = key
        self.st["tab"] = key
        self.list = self.list_for(key)
        sid = self.st["selected"].get(key)
        at = next((i for i, g in enumerate(self.list) if g["id"] == sid), -1)
        self.idx = at if at >= 0 else 0
        self.top_row = 0
        self.ensure_visible()
        self.remember()
        self.dirty = True
        self.save_state()

    def step_tab(self, d):
        if len(self.tabs) < 2:
            return
        i = next((n for n, (k, _) in enumerate(self.tabs) if k == self.tab_key), 0)
        i = (i + d) % len(self.tabs)
        self.set_tab(self.tabs[i][0])

    def toggle_fav(self):
        if not (0 <= self.idx < len(self.list)):
            return
        gid = self.list[self.idx]["id"]
        favs = self.st["favorites"]
        if gid in favs:
            favs.remove(gid)
        else:
            favs.append(gid)
        self.tabs = self.build_tabs()
        if not self.has_tab(self.tab_key):
            self.set_tab("all")
            return
        self.list = self.list_for(self.tab_key)
        self.idx = max(0, min(len(self.list) - 1, self.idx))
        self.ensure_visible()
        self.remember()
        self.dirty = True
        self.save_state()

    def select(self, n):
        if not self.list:
            return
        n = max(0, min(len(self.list) - 1, n))
        if n == self.idx:
            return
        self.idx = n
        self.ensure_visible()
        self.remember()
        self.dirty = True

    def move(self, dx, dy):
        if not self.list:
            return
        if dx:
            self.select(self.idx + dx)
            return
        n = self.idx + dy * COLS
        if 0 <= n < len(self.list):
            self.select(n)
        elif dy > 0 and self.idx // COLS < (len(self.list) - 1) // COLS:
            self.select(len(self.list) - 1)

    def apply_library(self, lib):
        sel = self.list[self.idx]["id"] if 0 <= self.idx < len(self.list) else None
        self.games = [g for g in lib["games"] if isinstance(g, dict) and g.get("id") is not None]
        self.load_error = None
        self.scanning = False
        if not self.games:
            self.tabs = []
            self.list = []
            self.idx = 0
            self.dirty = True
            return
        self.tabs = self.build_tabs()
        if self.has_tab(self.tab_key) and self.list:
            key = self.tab_key
        elif self.has_tab(self.st["tab"]):
            key = self.st["tab"]
        else:
            key = "recent" if self.has_tab("recent") else "all"
        if sel is not None:
            self.st["selected"][key] = sel
        self.set_tab(key)

    def load_initial(self):
        try:
            s = read_json("state.json")
            if isinstance(s, dict):
                favs = s.get("favorites")
                self.st["favorites"] = list(favs) if isinstance(favs, list) else []
                self.st["tab"] = s["tab"] if isinstance(s.get("tab"), str) else ""
                sel = s.get("selected")
                self.st["selected"] = sel if isinstance(sel, dict) else {}
        except (OSError, ValueError) as e:
            sys.stderr.write("state.json ignored: %s\n" % e)
        self.lib_mtime = lib_mtime()
        if not os.path.exists(os.path.join(LIB, "library.json")):
            self.scanning = True            # first start: the background scan is still running
            return
        try:
            lib = read_json("library.json")
            if not isinstance(lib, dict) or not isinstance(lib.get("games"), list):
                raise ValueError("library.json: missing or no games array")
            self.apply_library(lib)
        except (OSError, ValueError) as e:
            self.load_error = str(e)
            self.games = []

    def tick_live(self, now):
        if now - self.live_t0 > 180 or now < self.live_next:
            return
        self.live_next = now + 1.0
        m = lib_mtime()
        if m and m != self.lib_mtime:
            self.lib_mtime = m
            self.lib_pending = True
        if not self.lib_pending or self.mode != "grid":
            return
        self.lib_pending = False
        try:
            lib = read_json("library.json")
            if isinstance(lib, dict) and isinstance(lib.get("games"), list):
                self.apply_library(lib)
        except (OSError, ValueError):
            self.lib_pending = True         # half-written: try again next tick

    def save_state(self):
        write_json("state.json", self.st)

    # ================= thumbnails =================
    def cover_file(self, f):
        p = os.path.join(LIB, "covers", f)
        return p if os.path.isfile(p) else None

    def thumb_path(self, g):
        return os.path.join(LIB, "thumbs", "%s-%dx%d.png" % (safe_name(g["id"]), self.cov_w, self.cov_h))

    def cover_sources(self, g):
        out = []
        for k in ("cover1", "cover2"):
            f = g.get(k)
            if f:
                p = self.cover_file(str(f))
                if p:
                    out.append(p)
        # an overlay alone (no base cover) is not worth a thumbnail
        return out if g.get("cover1") and out else []

    def load_cached(self, g, srcs):
        tp = self.thumb_path(g)
        try:
            if os.path.getmtime(tp) < max(os.path.getmtime(p) for p in srcs):
                return None
        except OSError:
            return None
        tex = img.IMG_LoadTexture(self.ren, os.fsencode(tp))
        return tex or None

    def generate(self, g, srcs):
        """Render the covers cropped to 16:9 into a card-sized texture, save it as PNG."""
        r = self.ren
        cw, ch = self.cov_w, self.cov_h
        fmt = sdl2.SDL_PIXELFORMAT_ARGB8888
        target = sdl2.SDL_CreateTexture(r, fmt, sdl2.SDL_TEXTUREACCESS_TARGET, cw, ch)
        if not target:
            return None
        result = None
        try:
            sdl2.SDL_SetRenderTarget(r, target)
            sdl2.SDL_SetRenderDrawColor(r, COVER_BG[0], COVER_BG[1], COVER_BG[2], 255)
            sdl2.SDL_RenderClear(r)
            drawn = False
            for p in srcs:
                t = img.IMG_LoadTexture(r, os.fsencode(p))
                if not t:
                    continue
                try:
                    sdl2.SDL_SetTextureScaleMode(t, sdl2.SDL_ScaleModeLinear)
                except Exception:
                    pass
                tw = ctypes.c_int()
                th = ctypes.c_int()
                sdl2.SDL_QueryTexture(t, None, None, ctypes.byref(tw), ctypes.byref(th))
                if tw.value > 0 and th.value > 0:
                    # "cover" fit: crop the source to the target aspect ratio, centred
                    if tw.value * ch > th.value * cw:
                        sw, sh = th.value * cw // ch, th.value
                    else:
                        sw, sh = tw.value, tw.value * ch // cw
                    src = sdl2.SDL_Rect((tw.value - sw) // 2, (th.value - sh) // 2, max(1, sw), max(1, sh))
                    sdl2.SDL_RenderCopy(r, t, src, None)
                    drawn = True
                sdl2.SDL_DestroyTexture(t)
            if drawn:
                surf = sdl2.SDL_CreateRGBSurfaceWithFormat(0, cw, ch, 32, fmt)
                if surf:
                    try:
                        sdl2.SDL_RenderReadPixels(r, None, fmt, surf.contents.pixels, surf.contents.pitch)
                        sdl2.SDL_SetRenderTarget(r, None)
                        tp = self.thumb_path(g)
                        try:
                            os.makedirs(os.path.dirname(tp), exist_ok=True)
                            tmp = tp + ".tmp"
                            if img.IMG_SavePNG(surf, os.fsencode(tmp)) == 0:
                                os.replace(tmp, tp)
                        except OSError as e:
                            sys.stderr.write("thumb save failed: %s\n" % e)
                        result = sdl2.SDL_CreateTextureFromSurface(r, surf) or None
                    finally:
                        sdl2.SDL_FreeSurface(surf)
        finally:
            sdl2.SDL_SetRenderTarget(r, None)
            sdl2.SDL_DestroyTexture(target)
        return result

    def free_thumbs(self):
        for t in self.thumbs.values():
            if t:
                sdl2.SDL_DestroyTexture(t)
        self.thumbs.clear()

    def step_thumbs(self):
        """Keep thumbnails for visible rows +- 1, load/generate missing ones (one generation per call)."""
        self.thumbs_pending = False
        if not self.list or self.mode == "launching":
            return
        r0 = max(0, self.top_row - 1)
        r1 = self.top_row + self.vis + 1
        keep_idx = range(r0 * COLS, min(len(self.list), r1 * COLS))
        vis_idx = range(self.top_row * COLS, min(len(self.list), (self.top_row + self.vis) * COLS))
        keep_ids = {self.list[i]["id"] for i in keep_idx}
        for gid in [k for k in self.thumbs if k not in keep_ids]:
            t = self.thumbs.pop(gid)
            if t:
                sdl2.SDL_DestroyTexture(t)
        order = list(vis_idx) + [i for i in keep_idx if i not in vis_idx]
        loads = 0
        for n, i in enumerate(order):
            g = self.list[i]
            if g["id"] in self.thumbs:
                continue
            srcs = self.cover_sources(g)
            if not srcs:
                self.thumbs[g["id"]] = False
                continue
            tex = self.load_cached(g, srcs)
            generated = False
            if tex is None:
                tex = self.generate(g, srcs)
                generated = True
            self.thumbs[g["id"]] = tex or False
            self.dirty = True
            loads += 1
            if generated or loads >= 6:
                # more may remain; come back next iteration
                self.thumbs_pending = any(self.list[j]["id"] not in self.thumbs for j in order[n + 1:])
                return

    # ================= drawing =================
    def draw(self):
        if len(self.tcache) > TEXT_CACHE_MAX:
            self.free_text_cache()
        r = self.ren
        sdl2.SDL_SetRenderDrawColor(r, BG[0], BG[1], BG[2], 255)
        sdl2.SDL_RenderClear(r)
        S = self.S
        # header
        bw = self.put("PocketMZ", 16, ACCENT, self.px, self.hdr_y, self.hdr_h)
        if self.games:
            self.draw_tabs(self.px + bw + S(12))
        if not self.games:
            self.draw_empty()
        else:
            self.draw_grid()
            self.draw_info()
        if self.mode == "confirm":
            self.draw_dialog(T["quit"], [(T["no"], not self.confirm_yes), (T["yes"], self.confirm_yes)])
        elif self.mode == "msg":
            self.draw_dialog(T["convMsg"], [(T["ok"], True)])
        elif self.mode == "launching":
            g = self.list[self.idx] if 0 <= self.idx < len(self.list) else {}
            self.fill(0, 0, self.W, self.H, BG, 242)
            px = self.fs(18)
            lines = self.wrap(T["launching"](str(g.get("title") or g.get("id") or "")), px, self.W - 2 * S(24), 4)
            lh = int(px * 1.4)
            y = (self.H - lh * len(lines)) // 2
            for ln in lines:
                self.put(ln, 18, TEXT, 0, y, lh, "c", self.W)
                y += lh
        sdl2.SDL_RenderPresent(r)

    def draw_tabs(self, x0):
        S = self.S
        hy, hh = self.hdr_y, self.hdr_h
        mh = S(18)
        lw = self.text_w("L1", self.fs(10)) + S(8)
        rw = self.text_w("R1", self.fs(10)) + S(8)
        right = self.px + self.pw
        for mx, mw, label in ((x0, lw, "L1"), (right - rw, rw, "R1")):
            self.rrect_border(mx, hy + (hh - mh) // 2, mw, mh, S(4), 1, KEY_BORDER, BG)
            self.put(label, 10, SECOND, mx, hy + (hh - mh) // 2, mh, "c", mw)
        vx0 = x0 + lw + S(6)
        vx1 = right - rw - S(6)
        px14 = self.fs(14)
        gap = S(4)
        th = S(24)
        pos = []
        x = 0
        for k, label in self.tabs:
            w = self.text_w(label, px14) + S(20)
            pos.append((x, w, k, label))
            x += w + gap
        view = vx1 - vx0
        off = 0
        for tx, tw, k, _ in pos:
            if k == self.tab_key:
                off = max(0, tx + tw - view)
                if tx - off < 0:
                    off = tx
        sdl2.SDL_RenderSetClipRect(self.ren, sdl2.SDL_Rect(vx0, hy, max(1, view), hh))
        for tx, tw, k, label in pos:
            dx = vx0 + tx - off
            if dx + tw < vx0 or dx > vx1:
                continue
            on = k == self.tab_key
            ty = hy + (hh - th) // 2
            self.rrect(dx, ty, tw, th, S(12), ACCENT if on else PANEL)
            self.put(label, 14, WHITE if on else SECOND, dx, ty, th, "c", tw)
        sdl2.SDL_RenderSetClipRect(self.ren, None)

    def draw_empty(self):
        S = self.S
        maxw = self.W - 2 * S(24)
        blocks = []
        if self.scanning:
            blocks.append((T["scanning"], 16, SECOND))
        else:
            if self.load_error:
                blocks.append((T["err"] + self.load_error, 13, WARN))
            blocks.append((T["empty"], 16, SECOND))
        rows = []
        for txt, size, c in blocks:
            px = self.fs(size)
            lh = int(px * 1.6)
            for ln in self.wrap(txt, px, maxw, 8):
                rows.append((ln, size, c, lh))
            rows.append(("", 0, c, S(12)))
        total = sum(r[3] for r in rows) - S(12)
        y = max(self.gy0, (self.gy0 + self.info_y + self.info_h - total) // 2)
        for ln, size, c, lh in rows:
            if ln:
                self.put(ln, size, c, 0, y, lh, "c", self.W)
            y += lh

    def draw_cover(self, g, x, y):
        w, h = self.cov_w, self.cov_h
        t = self.thumbs.get(g["id"])
        if t:
            sdl2.SDL_RenderCopy(self.ren, t, None, sdl2.SDL_Rect(x, y, w, h))
            return
        has_cover = bool(self.cover_sources(g)) and t is None
        if has_cover:
            self.fill(x, y, w, h, COVER_BG)       # thumbnail still pending
            return
        # no cover: coloured box with the title centred
        hh = hue_of(str(g["id"]))
        rgb = colorsys.hls_to_rgb(hh / 360.0, 0.30, 0.35)
        self.fill(x, y, w, h, tuple(int(v * 255) for v in rgb))
        px = self.fs(13)
        lh = int(px * 1.25)
        maxl = max(1, (h - 2 * self.S(8)) // lh)
        lines = self.wrap(str(g.get("title") or g["id"]), px, w - 2 * self.S(8), maxl)
        yy = y + (h - lh * len(lines)) // 2
        self.sdl_clip(x, y, w, h)
        for ln in lines:
            self.put(ln, 13, WHITE, x, yy, lh, "c", w)
            yy += lh
        self.sdl_clip(None)

    def sdl_clip(self, x, y=None, w=None, h=None):
        if x is None:
            sdl2.SDL_RenderSetClipRect(self.ren, None)
        else:
            sdl2.SDL_RenderSetClipRect(self.ren, sdl2.SDL_Rect(x, y, w, h))

    def draw_grid(self):
        S = self.S
        start = self.top_row * COLS
        end = min(len(self.list), (self.top_row + self.vis) * COLS)
        px13 = self.fs(13)
        for i in range(start, end):
            g = self.list[i]
            row, c = divmod(i - start, COLS)
            cx = self.px + c * (self.card_w + self.gap_x)
            cy = self.gy0 + row * (self.card_h + self.gap_y)
            sel = i == self.idx
            if sel:
                self.rrect_border(cx, cy, self.card_w, self.card_h, S(6), S(2), ACCENT, CARD_SEL)
            else:
                self.rrect(cx, cy, self.card_w, self.card_h, S(6), CARD)
            vx, vy = cx + self.pad, cy + self.pad
            self.draw_cover(g, vx, vy)
            if self.is_fav(g["id"]):
                sw = self.text_w("★", self.fs(16)) + S(6)
                sh = self.fs(16) + S(2)
                bx = cx + self.card_w - S(8) - sw
                by = cy + S(7)
                self.rrect(bx, by, sw, sh, S(3), (0, 0, 0), 170)
                self.put("★", 16, GOLD, bx, by, sh, "c", sw)
            title = self.fit(str(g.get("title") or g["id"]), px13, self.cov_w)
            self.put(title, 13, TEXT, vx, vy + self.cov_h + S(3), self.title_h)

    def draw_info(self):
        S = self.S
        g = self.list[self.idx] if 0 <= self.idx < len(self.list) else None
        x, y, w, h = self.px, self.info_y, self.pw, self.info_h
        self.rrect(x, y, w, h, S(6), PANEL)
        ix = x + S(8)
        iw = w - S(16)
        hints_y = y + h - S(6) - S(16)
        self.put(T["hints"] and self.fit(T["hints"], self.fs(12), iw), 12, SECOND, ix, hints_y, S(16))
        if not g:
            return
        px16 = self.fs(16)
        lines = self.wrap(str(g.get("title") or g["id"]), px16, iw, 2)
        ty = y + S(6)
        for ln in lines:
            self.put(ln, 16, TEXT, ix, ty, S(20))
            ty += S(20)
        by = ty + S(4)
        bh = S(16)
        bx = ix
        badges = []
        if g.get("needsConversion"):
            badges.append((T["convBadge"], WARN_BG, WHITE))
        else:
            badges.append((str(g.get("kind") or "?"), ACCENT, WHITE))
        if g.get("width") and g.get("height"):
            badges.append(("%s×%s" % (g["width"], g["height"]), BADGE_BG, BADGE_TX))
        badges.append((last_played_text(g.get("lastPlayed")), BADGE_BG, BADGE_TX))
        cat = g.get("category") or g.get("folder")
        if cat:
            badges.append((str(cat), BADGE_BG, BADGE_TX))
        if self.is_fav(g["id"]):
            badges.append(("★", BADGE_BG, BADGE_TX))
        self.sdl_clip(ix, by, iw, bh)
        for label, bg, fg in badges:
            bw = self.text_w(label, self.fs(12)) + S(12)
            self.rrect(bx, by, bw, bh, S(3), bg)
            self.put(label, 12, fg, bx, by, bh, "c", bw)
            bx += bw + S(5)
            if bx > ix + iw:
                break
        self.sdl_clip(None)
        if g.get("needsConversion"):
            wy = by + bh + S(3)
            self.put(self.fit(T["convWarn"], self.fs(12), iw), 12, WARN, ix, wy, S(16))

    def draw_dialog(self, text, buttons):
        S = self.S
        self.fill(0, 0, self.W, self.H, (0, 0, 0), 176)
        px = self.fs(16)
        pad_x, pad_y, bd = S(22), S(18), S(2)
        maxw = int(self.W * 0.86) - 2 * (pad_x + bd)
        lines = self.wrap(text, px, maxw, 6)
        lh = int(px * 1.6)
        tw = max((self.text_w(ln, px) for ln in lines), default=0)
        bh = int(px * 1.4) + S(8)
        bgap = S(16)
        bws = [max(S(76), self.text_w(lbl, px) + 2 * S(14)) for lbl, _ in buttons]
        row_w = sum(bws) + bgap * (len(bws) - 1)
        inner = max(tw, row_w)
        bw_ = inner + 2 * (pad_x + bd)
        bh_ = 2 * (pad_y + bd) + lh * len(lines) + S(14) + bh
        bx = (self.W - bw_) // 2
        by = (self.H - bh_) // 2
        self.rrect_border(bx, by, bw_, bh_, S(8), bd, ACCENT, CARD)
        y = by + bd + pad_y
        for ln in lines:
            self.put(ln, 16, TEXT, bx, y, lh, "c", bw_)
            y += lh
        y += S(14)
        x = bx + (bw_ - row_w) // 2
        for (lbl, on), w in zip(buttons, bws):
            self.rrect(x, y, w, bh, S(6), ACCENT if on else PANEL)
            self.put(lbl, 16, WHITE if on else SECOND, x, y, bh, "c", w)
            x += w + bgap

    # ================= input =================
    def now(self):
        return time.monotonic()

    def dispatch(self, a):
        if self.mode == "launching":
            return
        if self.mode == "confirm":
            if a == "left":
                self.confirm_yes = False
            elif a == "right":
                self.confirm_yes = True
            elif a == "ok":
                self.accept_confirm()
            elif a == "back":
                self.mode = "grid"
            else:
                return
            self.dirty = True
            return
        if self.mode == "msg":
            if a in ("ok", "back"):
                self.mode = "grid"
                self.dirty = True
            return
        if a == "left":
            self.move(-1, 0)
        elif a == "right":
            self.move(1, 0)
        elif a == "up":
            self.move(0, -1)
        elif a == "down":
            self.move(0, 1)
        elif a == "prev":
            self.step_tab(-1)
        elif a == "next":
            self.step_tab(1)
        elif a == "ok":
            self.activate()
        elif a == "back":
            self.mode = "confirm"
            self.confirm_yes = False
            self.dirty = True
        elif a == "fav":
            self.toggle_fav()

    def accept_confirm(self):
        if not self.confirm_yes:
            self.mode = "grid"
            return
        self.finish = ("exit", None)

    def activate(self):
        if not (0 <= self.idx < len(self.list)):
            return
        g = self.list[self.idx]
        if g.get("needsConversion"):
            self.mode = "msg"
            self.dirty = True
            return
        self.mode = "launching"
        self.remember()
        self.finish = ("play", g)
        self.dirty = True

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
            self.finish = ("quit", None)
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
            b = e.cbutton.button
            self.pad_down.add(b)
            if (sdl2.SDL_CONTROLLER_BUTTON_BACK in self.pad_down
                    and sdl2.SDL_CONTROLLER_BUTTON_START in self.pad_down):
                self.finish = ("exit", None)
                return
            a = PADMAP.get(b)
            if a:
                self.press(a, "pad")
        elif t == sdl2.SDL_CONTROLLERBUTTONUP:
            b = e.cbutton.button
            self.pad_down.discard(b)
            a = PADMAP.get(b)
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
        self.load_initial()
        ev = sdl2.SDL_Event()
        while True:
            if self.dirty:
                self.dirty = False
                self.draw()
                if not self.first_shown:
                    self.first_shown = True
                    write_json("shown.json", {"t": int(time.time() * 1000)})
            if self.finish:
                break
            now = self.now()
            timeout = 250
            if self.thumbs_pending:
                timeout = 1
            elif self.held:
                timeout = max(1, min(50, int((self.held[2] - now) * 1000)))
            if sdl2.SDL_WaitEventTimeout(ctypes.byref(ev), timeout):
                self.handle(ev)
                while sdl2.SDL_PollEvent(ctypes.byref(ev)):
                    self.handle(ev)
            if self.finish:
                # draw the "starting" frame (if any) before leaving
                if self.dirty and self.finish[0] == "play":
                    continue
                break
            now = self.now()
            if self.held and now >= self.held[2]:
                self.held[2] = now + REPEAT_NEXT
                self.dispatch(self.held[1])
            self.tick_live(now)
            self.step_thumbs()
        self.leave()

    def leave(self):
        kind, g = self.finish
        self.save_state()
        if kind == "play":
            sdl2.SDL_Delay(100)       # let the "starting" frame reach the screen
            write_json("choice.json", {"action": "play", "id": g["id"], "dir": g.get("dir")})
        elif kind == "exit":
            write_json("choice.json", {"action": "exit"})
        try:
            self.free_thumbs()
            self.free_text_cache()
            for iid in list(self.pads):
                self.close_pad(iid)
            sdl2.SDL_DestroyRenderer(self.ren)
            sdl2.SDL_DestroyWindow(self.win)
            sdl2.SDL_Quit()
        except Exception:
            pass


def main():
    try:
        os.makedirs(LIB, exist_ok=True)
    except OSError:
        pass
    m = Menu()
    try:
        m.run()
    except Exception as e:
        sys.stderr.write("pocketmz-launcher failed: %r\n" % (e,))
        import traceback
        traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
