#!/usr/bin/env python3
"""Subset the fonts an RPG Maker MV/MZ game actually uses (runs inside the chroot).

/gamesrc = original game (read-only), /game = thin copy. For every file in
/gamesrc/fonts: referenced by js/plugins.js, data/System.json or css/*.css ->
written to /game/fonts/<same name> with only the characters found in the game's
data and plugins (+ ASCII, kana, common punctuation); otherwise a symlink to the
original. Re-run is cheap: unchanged fonts with the same character set are kept.
"""
import glob, hashlib, json, os, re, sys, time

SRC = os.environ.get("POCKETMZ_FONT_SRC", "/gamesrc")
DST = os.environ.get("POCKETMZ_FONT_DST", "/game")
EXTS = (".ttf", ".otf", ".woff", ".woff2")
RANGES = [(0x20, 0x7E), (0xA0, 0xFF), (0x2000, 0x206F), (0x2190, 0x21FF), (0x2460, 0x24FF),
          (0x2500, 0x257F), (0x25A0, 0x25FF), (0x2600, 0x26FF), (0x3000, 0x30FF), (0xFF00, 0xFFEF)]


def read(path):
    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            return f.read()
    except OSError:
        return ""


def walk(value, out):
    if isinstance(value, str):
        out.update(value)
    elif isinstance(value, list):
        for v in value:
            walk(v, out)
    elif isinstance(value, dict):
        for k, v in value.items():
            out.update(k)
            walk(v, out)


def game_chars():
    chars = set()
    for path in glob.glob(os.path.join(DST, "data", "*.json")):
        try:
            walk(json.loads(read(path)), chars)
        except ValueError:
            chars.update(read(path))
    for path in [os.path.join(DST, "js", "plugins.js")] + glob.glob(os.path.join(DST, "js", "plugins", "*.js")):
        text = read(path)
        chars.update(text)
        # plugin parameters are JSON inside JSON: pick up \uXXXX escapes too
        chars.update(chr(int(h, 16)) for h in re.findall(r"\\u([0-9a-fA-F]{4})", text))
    for lo, hi in RANGES:
        chars.update(chr(c) for c in range(lo, hi + 1))
    return "".join(sorted(c for c in chars if c.isprintable() or c == " "))


def main():
    from fontTools import subset
    from fontTools.ttLib import TTFont

    src_fonts = os.path.join(SRC, "fonts")
    dst_fonts = os.path.join(DST, "fonts")
    if os.path.islink(dst_fonts):
        os.unlink(dst_fonts)
    os.makedirs(dst_fonts, exist_ok=True)
    refs = read(os.path.join(DST, "js", "plugins.js")) + read(os.path.join(DST, "data", "System.json"))
    refs += "".join(read(p) for p in glob.glob(os.path.join(DST, "css", "*.css")))
    text = game_chars()
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()
    stamp = os.path.join(dst_fonts, ".subset-" + digest[:12])
    print("characters: %d" % len(text))
    for name in sorted(os.listdir(src_fonts)):
        src = os.path.join(src_fonts, name)
        dst = os.path.join(dst_fonts, name)
        stem, ext = os.path.splitext(name)
        used = ext.lower() in EXTS and stem in refs
        if not used:
            if not os.path.islink(dst):
                if os.path.exists(dst):
                    os.unlink(dst)
                os.symlink("/gamesrc/fonts/" + name, dst)
            continue
        if (os.path.isfile(dst) and not os.path.islink(dst) and os.path.exists(stamp)
                and os.path.getmtime(dst) >= os.path.getmtime(src)):
            print("keep   %s" % name)
            continue
        if os.path.lexists(dst):
            os.unlink(dst)
        t = time.time()
        flavor = {".woff": "woff", ".woff2": "woff2"}.get(ext.lower())
        for drop in ([], ["gasp", "hdmx", "VDMX", "LTSH", "kern", "mort"]):
            try:
                options = subset.Options()
                options.layout_features = ["*"]
                options.name_IDs = ["*"]
                options.name_languages = ["*"]
                options.hinting = False
                options.notdef_outline = True
                options.ignore_missing_glyphs = True
                options.ignore_missing_unicodes = True
                options.drop_tables += drop
                options.flavor = flavor
                font = TTFont(src, lazy=False)
                sub = subset.Subsetter(options)
                sub.populate(text=text)
                sub.subset(font)
                font.flavor = flavor
                font.save(dst + ".tmp")
                os.replace(dst + ".tmp", dst)
                print("subset %s: %d KB -> %d KB (%.1fs)" % (name, os.path.getsize(src) // 1024,
                                                             os.path.getsize(dst) // 1024, time.time() - t))
                break
            except Exception as e:  # malformed tables in some free fonts
                print("subset %s failed%s: %s" % (name, " (retry without %s)" % drop if drop else "", e))
                if os.path.exists(dst + ".tmp"):
                    os.unlink(dst + ".tmp")
        else:
            os.symlink("/gamesrc/fonts/" + name, dst)
            print("keep original %s" % name)
    for old in glob.glob(os.path.join(dst_fonts, ".subset-*")):
        os.unlink(old)
    open(stamp, "w").close()


if __name__ == "__main__":
    sys.exit(main())
