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
import re
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.realpath(__file__))
RZ = os.environ.get("POCKETMZ_DATA", "/storage/pocketmz")
LIB = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else os.path.join(RZ, "launcher", "library")
SELFTEST = "--selftest" in sys.argv[1:]
START_SETTINGS = "--settings" in sys.argv[1:]
COLS = 3
RECENT_MAX = 12

sdl2 = None
img = None
ttf = None
if not SELFTEST:
    sys.path.insert(0, os.path.join(HERE, "vendor"))
    os.environ.setdefault("PYSDL2_DLL_PATH", "/usr/lib")
    if sys.platform.startswith("linux"):
        os.environ.setdefault("SDL_VIDEODRIVER", "wayland")
    os.environ["SDL_VIDEO_WAYLAND_WMCLASS"] = "pocketmz-menu"   # app_id; the caller focuses by it
    import sdl2
    import sdl2.sdlimage as img
    import sdl2.sdlttf as ttf

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/noto-cjk/NotoSansCJKsc-Regular.otf",
    "/storage/pocketmz/root-sqfs/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/config/emulationstation/resources/DroidSansFallbackFull.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]
# Unified controller DB generated from ES es_input.cfg by pocketmz-pad.py
GAMEPAD_DB = os.environ.get("SDL_GAMECONTROLLERCONFIG_FILE") or "/tmp/pmz-gamecontrollerdb.txt"
PROJECT_URL = "https://github.com/LGHstormape-crypto/PocketMZ"

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
        "hints": "A 启动 · X 收藏 · Y 删除 · Start 设置 · L1/R1 分类 · B 退出",
        "convBadge": "需要转换",
        "convWarn": "此游戏的脚本被打包在 Game.exe 里，需要先在电脑上用 PocketMZ 转换器处理",
        "convMsg": "此游戏需要先在电脑上用 PocketMZ 转换器处理，才能在这里运行。",
        "missBadge": "原文件已丢失",
        "missMsg": "原游戏文件夹已不存在。按 Y 可删除该映射和残留副本。",
        "today": "今天", "yesterday": "昨天", "daysAgo": lambda n: "%d 天前" % n, "never": "从未",
        "launching": lambda t: "正在启动「" + t + "」…",
        "quit": "退出 PocketMZ？", "no": "否", "yes": "是", "ok": "好",
        "empty": "没有找到游戏。把 RPG Maker MV/MZ 游戏文件夹放进 roms/rpgmaker，按 Start 扫描游戏。",
        "err": "读取游戏列表失败：",
        "scanning": "正在查找游戏…",
        "del_ask": lambda t: "删除「%s」？\n会删除原游戏文件夹和运行副本。" % t,
        "del_keep": "删游戏(保留存档)", "del_all": "连存档彻底删除",
        "del_all_confirm": lambda t: "确定连同「%s」的存档一起彻底删除？此操作无法恢复！" % t,
        "deleting": "正在删除…",
        "settings": "设置", "scan": "刷新游戏列表", "defaults": "游戏默认设置", "saves": "存档",
        "runtime": "运行环境", "about": "关于", "exit": "返回游戏列表",
        "hint": "A 确定  B 返回", "hint_cycle": "左右 修改  A 切换  B 返回",
        "d_fps": "默认帧率", "d_scale": "渲染缩放", "d_smooth": "平滑游戏（双线性过滤）", "d_stopes": "运行时关闭 ES", "d_runtime": "游戏运行时（下次启动生效）", "d_test": "测试模式（录制性能数据）", "d_lang": "界面语言", "lang_auto": "跟随系统", "rt_auto": "自动（默认 β）",
        "scale_auto": "自动缩小", "scale_off": "原生分辨率", "on": "开", "off": "关",
        "d_note": "只对没有单独设置的游戏生效；游戏内菜单 (Select+X) 可单独覆盖",
        "s_export": "导出全部存档", "s_clean": "清理游戏副本缓存",
        "r_info": "信息", "r_update": "检查更新包", "r_uninstall": "卸载 PocketMZ",
        "working": "请稍候…", "checking": "正在检查…", "installing": "正在安装…",
        "confirm_ok": "确定", "cancel": "取消",
        "clean_confirm": "清理游戏副本缓存？会删除可重建的副本文件，存档不受影响",
        "uninst1": "卸载 PocketMZ？",
        "uninst2": "存档保留在 /storage/roms/savestates/rpgmz/，然后删除全部 PocketMZ 程序文件。确定卸载？",
        "install_q": "安装 {0}？\n当前版本：{1}", "up_to_date": "已是最新版本 {0}", "no_pkg": "没有找到更新包",
        "take_effect": "下次启动时生效。", "scan_empty": "（没有输出）",
        "missing": "缺少脚本：{0}", "exit_code": "命令失败（退出码 {0}）",
        "version": "版本", "games": "游戏", "launchers": "启动项", "withSaves": "有存档",
        "dataSize": "数据大小", "free": "剩余空间", "ver_line": "版本 {0}",
    },
    "ja": {
        "recent": "最近遊んだ", "all": "すべて", "fav": "お気に入り",
        "hints": "A 起動 · X お気に入り · Y 削除 · Start 設定 · L1/R1 分類 · B 終了",
        "convBadge": "変換が必要",
        "convWarn": "このゲームのスクリプトは Game.exe に埋め込まれています。先にパソコンで PocketMZ コンバーターを実行してください",
        "convMsg": "このゲームは、先にパソコンで PocketMZ コンバーターを実行しないと起動できません。",
        "missBadge": "元フォルダなし",
        "missMsg": "元のゲームフォルダが見つかりません。Y で項目とキャッシュを削除できます。",
        "today": "今日", "yesterday": "昨日", "daysAgo": lambda n: "%d 日前" % n, "never": "未プレイ",
        "launching": lambda t: "「" + t + "」を起動中…",
        "quit": "PocketMZ を終了しますか？", "no": "いいえ", "yes": "はい", "ok": "OK",
        "empty": "ゲームが見つかりません。roms/rpgmaker にゲームを入れて Start でスキャンしてください。",
        "err": "ゲーム一覧の読み込みに失敗しました：",
        "scanning": "ゲームを探しています…",
        "del_ask": lambda t: "「%s」を削除しますか？\nゲーム本体とコピーを削除します。" % t,
        "del_keep": "ゲーム削除(セーブ残す)", "del_all": "セーブも含め完全削除",
        "del_all_confirm": lambda t: "「%s」のセーブデータも完全に削除しますか？元に戻せません！" % t,
        "deleting": "削除中…",
        "settings": "設定", "scan": "リスト更新", "defaults": "ゲームの既定設定", "saves": "セーブデータ",
        "runtime": "実行環境", "about": "このアプリについて", "exit": "ゲーム一覧に戻る",
        "hint": "A 決定  B 戻る", "hint_cycle": "左右 変更  A 切替  B 戻る",
        "d_fps": "既定フレームレート", "d_scale": "描画スケール", "d_smooth": "画面の平滑化（バイリニア）", "d_stopes": "実行中に ES を停止", "d_runtime": "ゲームの実行環境（次回起動から）", "d_test": "テストモード（性能記録）", "d_lang": "言語", "lang_auto": "システムに合わせる", "rt_auto": "自動（β 優先）",
        "scale_auto": "自動縮小", "scale_off": "ネイティブ解像度", "on": "オン", "off": "オフ",
        "d_note": "個別設定のないゲームに適用されます。ゲーム内 (Select+X) で個別に変更可",
        "s_export": "セーブデータをすべて書き出す", "s_clean": "ゲームのコピーキャッシュを削除",
        "r_info": "情報", "r_update": "更新パッケージを確認", "r_uninstall": "PocketMZ をアンインストール",
        "working": "お待ちください…", "checking": "確認中…", "installing": "インストール中…",
        "confirm_ok": "OK", "cancel": "キャンセル",
        "clean_confirm": "コピーキャッシュを削除しますか？再生成できるファイルのみ削除され、セーブデータは影響を受けません",
        "uninst1": "PocketMZ をアンインストールしますか？",
        "uninst2": "セーブデータは /storage/roms/savestates/rpgmz/ に残り、PocketMZ 本体のみ削除されます。実行しますか？",
        "install_q": "{0} をインストールしますか？\n現在のバージョン：{1}", "up_to_date": "最新バージョンです {0}",
        "no_pkg": "更新パッケージが見つかりません",
        "take_effect": "次回の起動から有効になります。", "scan_empty": "（出力なし）",
        "missing": "スクリプトがありません：{0}", "exit_code": "コマンドが失敗しました（終了コード {0}）",
        "version": "バージョン", "games": "ゲーム", "launchers": "ランチャー", "withSaves": "セーブあり",
        "dataSize": "データサイズ", "free": "空き容量", "ver_line": "バージョン {0}",
    },
    "en": {
        "recent": "Recent", "all": "All", "fav": "Favorites",
        "hints": "A Play · X Fav · Y Delete · Start Settings · L1/R1 Tabs · B Exit",
        "convBadge": "Needs conversion",
        "convWarn": "This game's scripts are packed inside Game.exe. Process it on a PC with the PocketMZ converter first.",
        "convMsg": "This game must be processed on a PC with the PocketMZ converter before it can run here.",
        "missBadge": "Missing folder",
        "missMsg": "Original game folder is gone. Press Y to remove this launcher and thin copy.",
        "today": "Today", "yesterday": "Yesterday", "daysAgo": lambda n: "%d days ago" % n, "never": "Never",
        "launching": lambda t: "Starting \"" + t + "\"…",
        "quit": "Exit PocketMZ?", "no": "No", "yes": "Yes", "ok": "OK",
        "empty": "No games found. Put MV/MZ folders into roms/rpgmaker, then press Start to scan.",
        "err": "Failed to read the game list: ",
        "scanning": "Looking for games…",
        "del_ask": lambda t: "Delete \"%s\"?\nRemoves the game folder and thin copy." % t,
        "del_keep": "Delete (keep saves)", "del_all": "Delete with saves",
        "del_all_confirm": lambda t: "Permanently delete \"%s\" AND all its saves? This cannot be undone!" % t,
        "deleting": "Deleting…",
        "settings": "Settings", "scan": "Refresh game list", "defaults": "Game defaults", "saves": "Saves",
        "runtime": "Runtime", "about": "About", "exit": "Back to games",
        "hint": "A OK  B Back", "hint_cycle": "Left/Right Change  A Toggle  B Back",
        "d_fps": "Default FPS", "d_scale": "Render scale", "d_smooth": "Smooth games (bilinear)", "d_stopes": "Stop ES while playing", "d_runtime": "Game runtime (next start)", "d_test": "Test mode (record telemetry)", "d_lang": "Language", "lang_auto": "Auto (System)", "rt_auto": "Auto (β default)",
        "scale_auto": "Auto downscale", "scale_off": "Native resolution", "on": "On", "off": "Off",
        "d_note": "Applies when per-game settings are unset; change per game via Select+X",
        "s_export": "Export all saves", "s_clean": "Clean game copy cache",
        "r_info": "Info", "r_update": "Check for update package", "r_uninstall": "Uninstall PocketMZ",
        "working": "Please wait…", "checking": "Checking…", "installing": "Installing…",
        "confirm_ok": "OK", "cancel": "Cancel",
        "clean_confirm": "Clean the game copy cache? Rebuildable copies are deleted; saves are not affected.",
        "uninst1": "Uninstall PocketMZ?",
        "uninst2": "Saves stay in /storage/roms/savestates/rpgmz/, and PocketMZ files are removed. Continue?",
        "install_q": "Install {0}?\nCurrent version: {1}", "up_to_date": "Already up to date ({0})",
        "no_pkg": "No update package found",
        "take_effect": "Takes effect on next start.", "scan_empty": "(no output)",
        "missing": "Missing script: {0}", "exit_code": "Command failed (exit code {0})",
        "version": "Version", "games": "Games", "launchers": "Launchers", "withSaves": "With saves",
        "dataSize": "Data size", "free": "Free space", "ver_line": "Version {0}",
    },
}


def pick_lang(cfg=None):
    if isinstance(cfg, dict) and cfg.get("language") in ("zh", "en", "ja"):
        return cfg["language"]
    v = (os.environ.get("POCKETMZ_UI_LANG") or os.environ.get("LANG") or "").strip().lower()
    if v.startswith("ja"):
        return "ja"
    if v.startswith("zh") or not v:
        return "zh"
    return "en"


INFO_KEYS = ("version", "games", "withSaves", "dataSize", "free")

# ---------- settings.json & maint helpers (unified with pocketmz-maint.sh) ----------
DEFAULTS = {"defaultFps": 30, "renderScale": "auto", "smooth": False, "stopES": False, "runtime": "auto", "testMode": False, "language": "auto"}


def has_nw():
    return os.path.isfile(os.path.join(RZ, "rootfs.sqfs")) or os.path.isdir(os.path.join(RZ, "rootfs"))


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
    if isinstance(d.get("smooth"), bool):
        s["smooth"] = d["smooth"]
    if isinstance(d.get("stopES"), bool):
        s["stopES"] = d["stopES"]
    if d.get("runtime") in ("nw", "beta", "auto"):
        s["runtime"] = d["runtime"]
    if isinstance(d.get("testMode"), bool):
        s["testMode"] = d["testMode"]
    if d.get("language") in ("auto", "zh", "en", "ja"):
        s["language"] = d["language"]
    return s


T = I18N[pick_lang(load_settings())]


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


def read_version():
    try:
        with open(os.path.join(HERE, "VERSION"), "r", encoding="utf-8-sig") as f:
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
    except Exception as e:
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
    script = os.path.join(HERE, "pocketmz-maint.sh")
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
    s["defaultFps"], s["renderScale"], s["smooth"], s["stopES"], s["testMode"], s["language"] = 60, "off", True, True, True, "ja"
    assert save_settings(s)
    assert load_settings() == {"defaultFps": 60, "renderScale": "off", "smooth": True, "stopES": True, "runtime": "auto", "testMode": True, "language": "ja"}
    assert pick_lang({"language": "ja"}) == "ja" and pick_lang({"language": "en"}) == "en" and pick_lang({"language": "zh"}) == "zh"
    assert not os.path.exists(settings_path() + ".tmp")
    with open(settings_path(), "w") as f:
        f.write("{not json")
    assert load_settings() == DEFAULTS, "bad file tolerated"
    with open(settings_path(), "w") as f:
        f.write('{"defaultFps": 45, "renderScale": 3, "stopES": "yes", "language": "fr"}')
    assert load_settings() == DEFAULTS, "bad values fall back"
    ok, msg, body = parse_maint_output(
        "version=1.2.0\ngames=14\nwithSaves=5\ndataSize=1.4G\nfree=22G\nOK info\n", 0)
    assert ok and msg == "info" and len(body) == 5
    rows = info_rows(parse_info(body))
    assert rows[0] == (T["version"], "1.2.0") and rows[4] == (T["free"], "22G"), rows
    ok, msg, body = parse_maint_output("/storage/up/pocketmz-1.3.0.tar\t1.3.0\nOK found\n", 0)
    assert ok and parse_package(body, msg) == ("/storage/up/pocketmz-1.3.0.tar", "1.3.0")
    ok, msg, _ = parse_maint_output("OK deleted game; saves kept in roms/savestates/rpgmz/RJ1/\n", 0)
    assert ok and "savestates" in msg
    ok, msg, _ = parse_maint_output("ERROR no package in /storage/roms\n", 1)
    assert not ok and msg == "no package in /storage/roms"
    ok, msg, _ = parse_maint_output("", 3)
    assert not ok and "3" in msg
    assert parse_package([], "OK") == ("", "")
    print("launcher+settings selftest ok")
    return 0


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
if sdl2:
    KEYMAP = {
        sdl2.SDLK_LEFT: "left", sdl2.SDLK_RIGHT: "right", sdl2.SDLK_UP: "up", sdl2.SDLK_DOWN: "down",
        sdl2.SDLK_RETURN: "ok", sdl2.SDLK_KP_ENTER: "ok", sdl2.SDLK_ESCAPE: "back",
        sdl2.SDLK_d: "fav", sdl2.SDLK_PAGEUP: "prev", sdl2.SDLK_PAGEDOWN: "next",
        sdl2.SDLK_y: "del", sdl2.SDLK_DELETE: "del", sdl2.SDLK_BACKSPACE: "del",
        sdl2.SDLK_TAB: "settings", sdl2.SDLK_F1: "settings",
    }
    PADMAP = {
        sdl2.SDL_CONTROLLER_BUTTON_DPAD_LEFT: "left", sdl2.SDL_CONTROLLER_BUTTON_DPAD_RIGHT: "right",
        sdl2.SDL_CONTROLLER_BUTTON_DPAD_UP: "up", sdl2.SDL_CONTROLLER_BUTTON_DPAD_DOWN: "down",
        sdl2.SDL_CONTROLLER_BUTTON_A: "ok", sdl2.SDL_CONTROLLER_BUTTON_B: "back",
        sdl2.SDL_CONTROLLER_BUTTON_X: "fav", sdl2.SDL_CONTROLLER_BUTTON_Y: "del",
        sdl2.SDL_CONTROLLER_BUTTON_START: "settings",
        sdl2.SDL_CONTROLLER_BUTTON_LEFTSHOULDER: "prev", sdl2.SDL_CONTROLLER_BUTTON_RIGHTSHOULDER: "next",
    }
DEADZONE = 16000
REPEAT_FIRST = 0.35
REPEAT_NEXT = 0.09
TEXT_CACHE_MAX = 400


class Menu:
    def __init__(self):
        global T
        # ---- data ----
        self.cfg = load_settings()
        T = I18N[pick_lang(self.cfg)]
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
        self.stack = []             # settings pages when non-empty
        self.modal = None           # {"text","rows","buttons":[(lbl,cb,warn)...],"btn_idx","warn","on_close"}
        self.busy = None            # {"text","thread","res","cb"}
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
        if self.stack:
            self.draw_settings_page(self.stack[-1])
        else:
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
                g = self.list[self.idx] if 0 <= self.idx < len(self.list) else {}
                self.draw_dialog(T["missMsg"] if g.get("missing") else T["convMsg"], [(T["ok"], True)])
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
        if self.modal:
            self.draw_modal(self.modal)
        if self.busy:
            self.draw_busy(self.busy["text"])
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
        if g.get("missing"):
            badges.append((T["missBadge"], WARN_BG, WHITE))
        elif g.get("needsConversion"):
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

    # ================= settings & delete UI =================
    def wrap_lines(self, txt, px, maxw):
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

    def page(self, title, items, note=None, hint=None):
        return {"title": title, "items": items, "idx": 0, "top": 0, "note": note, "hint": hint or T["hint"]}

    def open_settings(self):
        self.cfg = load_settings()
        self.stack = [self.main_settings_page()]
        self.dirty = True

    def main_settings_page(self):
        return self.page(T["settings"], [
            {"label": T["scan"], "fn": self.do_scan},
            {"label": T["d_lang"], "cycle": "language", "opts": ["auto", "zh", "en", "ja"],
             "show": lambda v: {"auto": T["lang_auto"], "zh": "简体中文", "en": "English", "ja": "日本語"}.get(v, T["lang_auto"])},
            {"label": T["defaults"], "sub": True, "fn": lambda: self.push_page(self.defaults_page())},
            {"label": T["saves"], "sub": True, "fn": lambda: self.push_page(self.saves_page())},
            {"label": T["runtime"], "sub": True, "fn": lambda: self.push_page(self.runtime_page())},
            {"label": T["about"], "fn": self.show_about},
            {"label": T["exit"], "fn": self.close_settings},
        ], hint=T["hint_cycle"])

    def defaults_page(self):
        return self.page(T["defaults"], [
            {"label": T["d_fps"], "cycle": "defaultFps", "opts": [30, 60],
             "show": lambda v: str(v)},
            {"label": T["d_scale"], "cycle": "renderScale", "opts": ["auto", "off"],
             "show": lambda v: T["scale_auto"] if v == "auto" else T["scale_off"]},
            {"label": T["d_smooth"], "cycle": "smooth", "opts": [False, True],
             "show": lambda v: T["on"] if v else T["off"]},
            {"label": T["d_stopes"], "cycle": "stopES", "opts": [False, True],
             "show": lambda v: T["on"] if v else T["off"]},
            {"label": T["d_runtime"], "cycle": "runtime",
             "opts": ["nw", "beta", "auto"] if has_nw() else ["beta"],
             "show": lambda v: {"nw": "NW.js", "beta": "β" if has_nw() else "β (β-only)", "auto": T["rt_auto"]}.get(v, "β (β-only)")},
            {"label": T["d_test"], "cycle": "testMode", "opts": [False, True],
             "show": lambda v: T["on"] if v else T["off"]},
        ], note=T["d_note"], hint=T["hint_cycle"])

    def saves_page(self):
        return self.page(T["saves"], [
            {"label": T["s_export"], "fn": lambda: self.run_maint(T["working"], ("export-saves",), self.show_result)},
            {"label": T["s_clean"], "fn": lambda: self.confirm_modal(
                T["clean_confirm"], lambda: self.run_maint(T["working"], ("clean-copies",), self.show_result))},
        ])

    def runtime_page(self):
        return self.page(T["runtime"], [
            {"label": T["r_info"], "fn": self.do_info},
            {"label": T["r_update"], "fn": self.do_find_package},
            {"label": T["r_uninstall"], "fn": self.do_uninstall},
        ])

    def push_page(self, p):
        self.stack.append(p)
        self.dirty = True

    def pop_page(self):
        if len(self.stack) > 1:
            self.stack.pop()
        else:
            self.stack.clear()
        self.dirty = True

    def close_settings(self):
        self.stack.clear()
        self.dirty = True

    def message_modal(self, text, rows=None, warn=False, on_close=None):
        self.modal = {
            "text": text, "rows": rows, "warn": warn, "on_close": on_close,
            "buttons": [(T["confirm_ok"], lambda: None, False)], "btn_idx": 0,
        }
        self.dirty = True

    def confirm_modal(self, text, on_yes, warn=False, default_yes=False):
        self.modal = {
            "text": text, "rows": None, "warn": warn, "on_close": None,
            "buttons": [(T["confirm_ok"], on_yes, warn), (T["cancel"], lambda: None, False)],
            "btn_idx": 0 if default_yes else 1,
        }
        self.dirty = True

    def show_result(self, ok, msg, extra=None, on_close=None):
        self.message_modal(msg if not extra else msg + "\n" + extra, warn=not ok, on_close=on_close if ok else None)

    def run_async(self, text, func, cb):
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

    def refresh_library_sync(self):
        lib_py = os.path.join(HERE, "pocketmz-library.py")
        if os.path.isfile(lib_py):
            run_cmd([sys.executable, lib_py, LIB])

    def do_scan(self):
        def work():
            self.refresh_library_sync()
            return True, T["scan_empty"], []

        def done(r):
            self.load_initial()
            self.show_result(r[0], "%s (%d)" % (T["games"], len(self.games)))

        self.run_async(T["scanning"], work, done)

    def do_info(self):
        def done(r):
            ok, msg, body = r
            rows = info_rows(parse_info(body)) if ok else []
            if ok and rows:
                self.message_modal("", rows=rows)
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
            self.confirm_modal(T["install_q"].format(ver or "?", cur), lambda: self.run_maint(
                T["installing"], ("update", path),
                lambda ok2, msg2: self.show_result(ok2, msg2, T["take_effect"] if ok2 else None)),
                default_yes=True)
        self.run_async(T["checking"], lambda: maint("find-package"), done)

    def do_uninstall(self):
        def finish(ok, msg):
            self.show_result(ok, msg, on_close=lambda: setattr(self, "finish", ("exit", None)))
        self.confirm_modal(T["uninst1"], lambda: self.confirm_modal(
            T["uninst2"], lambda: self.run_maint(T["working"], ("uninstall",), finish), warn=True))

    def show_about(self):
        self.message_modal("PocketMZ\n%s\nMIT License\nRPG Maker MV/MZ runner for handhelds\n%s"
                           % (T["ver_line"].format(read_version()), PROJECT_URL))

    def apply_language(self):
        global T
        T = I18N[pick_lang(self.cfg)]
        if self.games:
            self.tabs = self.build_tabs()
        if self.stack:
            idx, top = self.stack[0]["idx"], self.stack[0]["top"]
            self.stack[0] = self.main_settings_page()
            self.stack[0]["idx"] = idx
            self.stack[0]["top"] = top

    def cycle_setting(self, item, d):
        opts = item["opts"]
        key = item["cycle"]
        cur = self.cfg.get(key)
        i = opts.index(cur) if cur in opts else 0
        self.cfg[key] = opts[(i + d) % len(opts)]
        save_settings(self.cfg)
        if key == "language":
            self.apply_language()
        self.dirty = True

    def prompt_delete_game(self):
        if not (0 <= self.idx < len(self.list)):
            return
        g = self.list[self.idx]
        gid = str(g["id"])
        gdir = str(g.get("dir") or "")
        title = str(g.get("title") or gid)

        def run_del(mode):
            def work():
                ok, msg, body = maint("delete-game", gid, gdir, mode)
                if ok:
                    self.refresh_library_sync()
                return ok, msg, body

            def done(r):
                if r[0]:
                    self.load_initial()
                self.show_result(r[0], r[1])

            self.run_async(T["deleting"], work, done)

        self.modal = {
            "text": T["del_ask"](title), "rows": None, "warn": False, "on_close": None,
            "buttons": [
                (T["del_keep"], lambda: run_del("keep-saves"), False),
                (T["del_all"], lambda: self.confirm_modal(T["del_all_confirm"](title), lambda: run_del("delete-all"), warn=True), True),
                (T["cancel"], lambda: None, False),
            ],
            "btn_idx": 2,
        }
        self.dirty = True

    def draw_settings_page(self, pg):
        S = self.S
        px, pw = self.px, self.pw
        hy, hh = self.hdr_y, self.hdr_h
        bw = self.put("PocketMZ", 16, ACCENT, px, hy, hh)
        self.put("·  " + pg["title"], 16, TEXT, px + bw + S(8), hy, hh)
        self.fill(px, hy + hh + S(2), pw, 1, KEY_BORDER)
        hint_h = S(28)
        hint_y = self.oy + S(480) - S(8) - hint_h
        self.rrect(px, hint_y, pw, hint_h, S(6), PANEL)
        self.put(self.fit(pg["hint"], self.fs(13), pw - S(16)), 13, SECOND, px, hint_y, hint_h, "c", pw)
        y0 = hy + hh + S(12)
        row_h, gap = S(46), S(6)
        note_lines = self.wrap_lines(pg["note"], self.fs(13), pw - S(8)) if pg["note"] else []
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

    def draw_modal(self, d):
        S = self.S
        self.fill(0, 0, self.W, self.H, (0, 0, 0), 176)
        px = self.fs(15)
        pad_x, pad_y, bd = S(20), S(16), S(2)
        maxw = int(self.W * 0.88) - 2 * (pad_x + bd)
        lines = self.wrap_lines(d["text"], px, maxw)[:12] if d["text"] else []
        lh = int(px * 1.55)
        rows = d["rows"] or []
        lw = max((self.text_w(k, px) for k, _ in rows), default=0)
        vw = max((self.text_w(v, px) for _, v in rows), default=0)
        vw = min(vw, max(S(40), maxw - lw - S(24)))
        rows_w = (lw + S(24) + vw) if rows else 0
        buttons = d["buttons"]
        bh = int(px * 1.4) + S(8)
        bgap = S(12)
        bws = [max(S(72), self.text_w(lbl, px) + 2 * S(12)) for lbl, _, _ in buttons]
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
            self.put(ln, 15, WARN if d["warn"] else TEXT, bx, y, lh, "c", bw_)
            y += lh
        if lines and rows:
            y += S(6)
        rx = bx + (bw_ - rows_w) // 2
        for k, v in rows:
            self.put(k, 15, SECOND, rx, y, lh)
            self.put(self.fit(v, px, vw), 15, TEXT, rx + lw + S(24), y, lh)
            y += lh
        y += S(14)
        x = bx + (bw_ - row_w) // 2
        for n, ((lbl, _, is_warn), w) in enumerate(zip(buttons, bws)):
            on = n == d["btn_idx"]
            bg = (WARN_BG if is_warn else ACCENT) if on else PANEL
            self.rrect(x, y, w, bh, S(6), bg)
            self.put(lbl, 15, WHITE if on else SECOND, x, y, bh, "c", w)
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
    def now(self):
        return time.monotonic()

    def dispatch(self, a):
        if self.busy or self.mode == "launching":
            return
        if self.modal:
            d = self.modal
            nbtn = len(d["buttons"])
            if a in ("left", "up") and nbtn > 1:
                d["btn_idx"] = (d["btn_idx"] - 1) % nbtn
            elif a in ("right", "down") and nbtn > 1:
                d["btn_idx"] = (d["btn_idx"] + 1) % nbtn
            elif a == "ok":
                _, cb, _ = d["buttons"][d["btn_idx"]]
                on_close = d["on_close"]
                self.modal = None
                cb()
                if on_close:
                    on_close()
            elif a == "back":
                on_close = d["on_close"] if nbtn == 1 else None
                self.modal = None
                if on_close:
                    on_close()
            else:
                return
            self.dirty = True
            return
        if self.stack:
            pg = self.stack[-1]
            items = pg["items"]
            it = items[pg["idx"]]
            if a == "up":
                pg["idx"] = (pg["idx"] - 1) % len(items)
            elif a == "down":
                pg["idx"] = (pg["idx"] + 1) % len(items)
            elif a in ("left", "right"):
                if "cycle" in it:
                    self.cycle_setting(it, -1 if a == "left" else 1)
            elif a == "ok":
                if "cycle" in it:
                    self.cycle_setting(it, 1)
                elif it.get("fn"):
                    it["fn"]()
            elif a in ("back", "settings"):
                self.pop_page()
            self.dirty = True
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
        if a == "settings":
            self.open_settings()
            return
        if a == "del":
            self.prompt_delete_game()
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
        if g.get("missing") or g.get("needsConversion"):
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
        if START_SETTINGS:
            self.open_settings()
        ev = sdl2.SDL_Event()
        while True:
            self.poll_busy()
            if self.busy:
                self.dirty = True
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
            if self.busy:
                timeout = 60
            elif self.thumbs_pending:
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
    if SELFTEST:
        return selftest()
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
