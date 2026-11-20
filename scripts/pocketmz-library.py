#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""PocketMZ: build the game list for the menu (runs on the handheld, system python3).

Usage: pocketmz-library.py [out dir]      default /storage/pocketmz/launcher/library
Writes <out>/library.json and title-screen covers <out>/covers/<id>-1.png / -2.png (title1 and
title2 images, decrypted when the game encrypts its images). Game folders are only read.

Games: folders under /storage/roms/rpgmaker and /storage/roms/easyrpg (up to 4 levels) with
index.html + js/rmmz_core.js (MZ) or package.json + www/index.html + www/js/rpg_core.js (MV).
Category: a first-level folder that holds 2 or more games (e.g. rpgmaker/RPG/...); a folder that
only wraps one game is not a category. Folders with index.html but no js/ next to a large
Game.exe are listed as "needs conversion" (scripts packed into the exe; convert on a PC).
id: DLsite code in the path (RJ/VJ/BJ + 6-8 digits), else folder name + md5 of the path (the
same as pocketmz-scan.sh, so saves in /storage/pocketmz/games/<id>/ match).
"""
import hashlib, json, os, re, sys, time

RZ = os.environ.get("POCKETMZ_DATA", "/storage/pocketmz")   # data dir (games/<id>/run.log)
ROOTS = [("rpgmaker", "/storage/roms/rpgmaker"), ("easyrpg", "/storage/roms/easyrpg")]
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(RZ, "launcher", "library")
SKIP = {"img", "audio", "movies", "effects", "fonts", "save", "locales", "swiftshader", "data", "js", "css", "icon",
        # asset folders of RPG Maker 2000/2003 games (EasyRPG) living in the same roms folders
        "Backdrop", "Battle", "Battle2", "BattleCharSet", "BattleWeapon", "CharSet", "ChipSet", "FaceSet",
        "Frame", "GameOver", "Monster", "Movie", "Music", "Panorama", "Picture", "Sound", "System",
        "System2", "Title"}
MV_HEADER_LEN = 16


def game_id(path):
    m = re.findall(r"[RVB]J[0-9]{6,8}", path)
    if m:
        return m[-1]
    name = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(path))
    name = re.sub(r"_+", "_", name).strip("_")[:32]
    h = hashlib.md5(path.encode("utf-8")).hexdigest()[:8]
    return (name + "-" if name else "") + h


def walk_games(top, max_depth):
    """(game dir, web dir, kind) for every game in top and below, at most max_depth levels down."""
    found = []
    base = top.rstrip("/").count("/")
    for d, dirs, files in os.walk(top):
        depth = d.rstrip("/").count("/") - base
        dirs[:] = [x for x in dirs if x not in SKIP and not x.startswith(".")] if depth < max_depth else []
        if "index.html" not in files:
            continue
        if os.path.isfile(os.path.join(d, "js", "rmmz_core.js")):
            found.append((d, d, "MZ"))
            dirs[:] = []
        elif os.path.basename(d) == "www" and os.path.isfile(os.path.join(d, "js", "rpg_core.js")) \
                and os.path.isfile(os.path.join(os.path.dirname(d), "package.json")):
            found.append((os.path.dirname(d), d, "MV"))
            dirs[:] = []
        elif not os.path.isdir(os.path.join(d, "js")):
            exe = os.path.join(d, "Game.exe")
            if os.path.isfile(exe) and os.path.getsize(exe) > 20 * 1024 * 1024:
                found.append((d, d, "packed"))
    return found


def find_games(root, cache, new_cache):
    """Games below root (at most 4 levels). Walking big game folders on the exFAT card is slow
    (~13 s after a game pushed the directory cache out), so the result per first-level folder is
    cached by that folder's mtime, which changes when a game is added or removed in it."""
    found = []
    try:
        entries = sorted(os.scandir(root), key=lambda e: e.name)
    except OSError:
        return found
    for e in entries:
        if e.name.startswith(".") or e.name in SKIP or not e.is_dir():
            continue
        try:
            mtime = e.stat().st_mtime
        except OSError:
            continue
        c = cache.get(e.path)
        if c and c.get("mtime") == mtime and all(os.path.isdir(g[0]) for g in c["found"]):
            sub = [tuple(g) for g in c["found"]]
        else:
            sub = walk_games(e.path, 3)
        new_cache[e.path] = {"mtime": mtime, "found": [list(g) for g in sub]}
        found.extend(sub)
    return found


def read_json(path):
    try:
        with open(path, encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception:
        return None


def decrypt(data, key_hex):
    """RPG Maker MV/MZ image: 16 byte header, then the first 16 bytes XOR the key."""
    if not data[:5] == b"RPGMV":
        return data
    body = bytearray(data[MV_HEADER_LEN:])
    key = bytes.fromhex(key_hex)
    for i in range(min(16, len(body))):
        body[i] ^= key[i % len(key)]
    return bytes(body)


def cover(web, system, name, folder, out_file):
    """Copy img/<folder>/<name> (decrypted) to out_file when it is missing or older."""
    if not name:
        return None
    img = os.path.join(web, "img", folder)
    for ext in (".png", ".png_", ".rpgmvp"):
        src = os.path.join(img, name + ext)
        if os.path.isfile(src):
            break
    else:
        return None
    try:
        if not os.path.isfile(out_file) or os.path.getmtime(out_file) < os.path.getmtime(src):
            with open(src, "rb") as f:
                data = f.read()
            if not src.endswith(".png"):
                key = (system or {}).get("encryptionKey") or ""
                if not re.fullmatch(r"[0-9a-fA-F]{32}", key):
                    return None
                data = decrypt(data, key)
            if not data.startswith(b"\x89PNG"):
                return None
            tmp = out_file + ".tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, out_file)
        return os.path.basename(out_file)
    except OSError:
        return None


def main():
    os.makedirs(os.path.join(OUT, "covers"), exist_ok=True)
    cache_file = os.path.join(OUT, "scan-cache.json")
    cache = read_json(cache_file) or {}
    new_cache = {}
    games, seen = [], set()
    for root_name, root in ROOTS:
        if not os.path.isdir(root):
            continue
        found = find_games(root, cache, new_cache)
        # categories: first-level folders holding 2+ games
        first = {}
        for gdir, _, _ in found:
            rel = os.path.relpath(gdir, root).split(os.sep)
            if len(rel) > 1:
                first[rel[0]] = first.get(rel[0], 0) + 1
        for gdir, web, kind in found:
            if gdir in seen:
                continue
            seen.add(gdir)
            gid = game_id(gdir)
            rel = os.path.relpath(gdir, root).split(os.sep)
            category = rel[0] if len(rel) > 1 and first.get(rel[0], 0) >= 2 else ""
            system = read_json(os.path.join(web, "data", "System.json")) if kind != "packed" else None
            title = ((system or {}).get("gameTitle") or "").split(" | ")[0].strip() or os.path.basename(gdir)
            adv = (system or {}).get("advanced") or {}
            log = os.path.join(RZ, "games", gid, "run.log")
            entry = {
                "id": gid, "title": title, "kind": kind, "dir": gdir, "root": root_name,
                "category": category, "folder": os.path.basename(gdir),
                "locale": (system or {}).get("locale", ""),
                "width": adv.get("screenWidth") or (816 if kind == "MZ" else 816),
                "height": adv.get("screenHeight") or 624,
                "lastPlayed": int(os.path.getmtime(log)) if os.path.isfile(log) else 0,
                "needsConversion": kind == "packed",
            }
            if system:
                entry["cover1"] = cover(web, system, system.get("title1Name"), "titles1",
                                        os.path.join(OUT, "covers", gid + "-1.png"))
                entry["cover2"] = cover(web, system, system.get("title2Name"), "titles2",
                                        os.path.join(OUT, "covers", gid + "-2.png"))
            games.append(entry)
    games.sort(key=lambda g: (g["category"], g["title"]))
    lib_file = os.path.join(OUT, "library.json")
    old = read_json(lib_file)
    if not (old and old.get("games") == games):     # unchanged: no rewrite (the menu reloads on change)
        data = {"generated": int(time.time()), "games": games}
        tmp = lib_file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, lib_file)
    try:
        with open(cache_file + ".tmp", "w", encoding="utf-8") as f:
            json.dump(new_cache, f, ensure_ascii=False)
        os.replace(cache_file + ".tmp", cache_file)
    except OSError:
        pass
    print("%d games" % len(games))


if __name__ == "__main__":
    main()
