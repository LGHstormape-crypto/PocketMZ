#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""PocketMZ: build a standalone SDL GameControllerDB from EmulationStation's es_input.cfg.

Why: avoids relying on PortMaster's control.txt/mapper.txt (which can break if permissions or
PortMaster files change after an OS reflash). Every PocketMZ entrypoint (α, β, and the launcher)
calls this single source, prints the generated DB path on stdout, and sets
SDL_GAMECONTROLLERCONFIG_FILE to it.

Usage:
  pocketmz-pad.py              -> prints path to generated DB (cached in /tmp/pmz-gamecontrollerdb.txt)
  pocketmz-pad.py --selftest   -> runs offline unit tests
"""
import os
import re
import sys
import tempfile
import xml.etree.ElementTree as ET

ES_INPUT_CANDIDATES = (
    "/storage/.config/emulationstation/es_input.cfg",
    "/usr/config/emulationstation/es_input.cfg",
)
SYS_GCDB_CANDIDATES = (
    "/storage/.config/SDL-GameControllerDB/gamecontrollerdb.txt",
    "/usr/config/SDL-GameControllerDB/gamecontrollerdb.txt",
    "/roms/ports/PortMaster/gamecontrollerdb.txt",
    "/opt/system/Tools/PortMaster/gamecontrollerdb.txt",
    "/mnt/mmc/Roms/PORTS/PortMaster/gamecontrollerdb.txt",
)
OUT_DB = os.environ.get("PMZ_PAD_DB") or "/tmp/pmz-gamecontrollerdb.txt"

AXIS_MAP = {
    "leftanalogup": "-lefty",
    "leftanalogdown": "+lefty",
    "leftanalogleft": "-leftx",
    "leftanalogright": "+leftx",
    "rightanalogup": "-righty",
    "rightanalogdown": "+righty",
    "rightanalogleft": "-rightx",
    "rightanalogright": "+rightx",
}

BTN_MAP = {
    "a": "a",
    "b": "b",
    "x": "x",
    "y": "y",
    "up": "dpup",
    "down": "dpdown",
    "left": "dpleft",
    "right": "dpright",
    "start": "start",
    "select": "back",
    "leftshoulder": "leftshoulder",
    "rightshoulder": "rightshoulder",
    "lefttrigger": "lefttrigger",
    "righttrigger": "righttrigger",
    "leftthumb": "leftstick",
    "rightthumb": "rightstick",
}


def first_existing(paths):
    for p in paths:
        if p and os.path.isfile(p):
            return p
    return None


def parse_sys_gcdb_extras(path):
    """Extract guide/misc1 tokens per GUID and full fallback lines from system gamecontrollerdb.txt."""
    extras = {}
    fallback_lines = []
    if not path or not os.path.isfile(path):
        return extras, fallback_lines
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                fallback_lines.append(line)
                parts = [p for p in line.split(",") if p]
                if len(parts) < 3:
                    continue
                guid = parts[0].strip()
                toks = {}
                for tok in parts[2:]:
                    if ":" in tok:
                        k, v = tok.split(":", 1)
                        if k in ("guide", "misc1"):
                            toks[k] = v
                if toks:
                    extras.setdefault(guid, {}).update(toks)
    except OSError:
        pass
    return extras, fallback_lines


def map_es_input(inp):
    """Convert an ES <input .../> element into (sdl_key, sdl_val) or None."""
    name = inp.attrib.get("name", "")
    itype = inp.attrib.get("type", "")
    iid = inp.attrib.get("id", "")
    val = inp.attrib.get("value", "")
    if not name or not itype or iid == "":
        return None
    if name in BTN_MAP:
        sdl_key = BTN_MAP[name]
    elif name in AXIS_MAP:
        sdl_key = AXIS_MAP[name]
    elif name == "hotkeyenable":
        sdl_key = "guide"
    else:
        return None

    if itype == "button":
        return sdl_key, "b" + iid
    if itype == "hat":
        return sdl_key, "h" + iid + "." + (val or "1")
    if itype == "axis":
        try:
            v = int(val)
        except ValueError:
            v = 1
        if name.endswith("trigger"):
            return sdl_key, "a" + iid
        return sdl_key, ("-a" if v < 0 else "+a") + iid
    return None


def build_db(es_path, sys_gcdb_path):
    """Build SDL GameControllerDB text from es_input.cfg + guide/misc1 supplements."""
    extras, fallback_lines = parse_sys_gcdb_extras(sys_gcdb_path)
    lines = []
    seen_guids = set()

    if es_path and os.path.isfile(es_path):
        try:
            root = ET.parse(es_path).getroot()
            for cfg in root.findall("inputConfig"):
                if cfg.attrib.get("type") != "joystick":
                    continue
                guid = cfg.attrib.get("deviceGUID", "").strip()
                name = cfg.attrib.get("deviceName", "").strip()
                if not guid or guid == "-1" or not name:
                    continue
                if guid in seen_guids:
                    continue
                seen_guids.add(guid)

                inputs = cfg.findall("input")
                sel_sig = None
                hk_sig = None
                for inp in inputs:
                    n = inp.attrib.get("name")
                    sig = (inp.attrib.get("type"), inp.attrib.get("id"))
                    if n == "select":
                        sel_sig = sig
                    elif n == "hotkeyenable":
                        hk_sig = sig

                mapped = {}
                order = []
                for inp in inputs:
                    if inp.attrib.get("name") == "hotkeyenable" and hk_sig and sel_sig and hk_sig == sel_sig:
                        continue
                    res = map_es_input(inp)
                    if not res:
                        continue
                    k, v = res
                    if k not in mapped:
                        order.append(k)
                    mapped[k] = v

                # Supplement guide / misc1 from system gamecontrollerdb.txt if missing
                sup = extras.get(guid, {})
                for k in ("guide", "misc1"):
                    if k not in mapped and k in sup:
                        order.append(k)
                        mapped[k] = sup[k]

                if not mapped:
                    continue
                body = ",".join(f"{k}:{mapped[k]}" for k in order)
                lines.append(f"{guid},{name},{body},platform:Linux,")
        except (ET.ParseError, OSError):
            pass

    if not lines and fallback_lines:
        return fallback_lines
    return lines


def ensure_db(out_path=OUT_DB, es_path=None, sys_gcdb_path=None):
    es_p = es_path or first_existing(ES_INPUT_CANDIDATES)
    sys_p = sys_gcdb_path or first_existing(SYS_GCDB_CANDIDATES)

    def mtime_str(p):
        try:
            return str(int(os.path.getmtime(p))) if p and os.path.isfile(p) else "0"
        except OSError:
            return "0"

    header = f"# pmz-pad:{mtime_str(es_p)}:{mtime_str(sys_p)}"
    if os.path.isfile(out_path):
        try:
            with open(out_path, "r", encoding="utf-8") as f:
                first = f.readline().rstrip("\r\n")
            if first == header:
                return out_path
        except OSError:
            pass

    lines = build_db(es_p, sys_p)
    if not lines:
        return sys_p or ""

    os.makedirs(os.path.dirname(out_path) or "/tmp", exist_ok=True)
    tmp = out_path + ".tmp." + str(os.getpid())
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(header + "\n")
        for ln in lines:
            f.write(ln + "\n")
    os.replace(tmp, out_path)
    return out_path


def selftest():
    tmp = tempfile.mkdtemp(prefix="pmz-pad-test-")
    es_xml = os.path.join(tmp, "es_input.cfg")
    sys_db = os.path.join(tmp, "gamecontrollerdb.txt")
    out_db = os.path.join(tmp, "pmz-gcdb.txt")

    with open(es_xml, "w", encoding="utf-8") as f:
        f.write("""<?xml version="1.0"?>
<inputList>
  <inputConfig type="joystick" deviceName="retrogame_joypad" deviceGUID="03009b4d4b4800000111000000010000">
    <input name="a" type="button" id="1" value="1" />
    <input name="b" type="button" id="0" value="1" />
    <input name="x" type="button" id="2" value="1" />
    <input name="y" type="button" id="3" value="1" />
    <input name="hotkeyenable" type="button" id="8" value="1" />
    <input name="select" type="button" id="8" value="1" />
    <input name="start" type="button" id="9" value="1" />
    <input name="lefttrigger" type="button" id="6" value="1" />
    <input name="leftanalogleft" type="axis" id="0" value="-1" />
    <input name="leftanalogright" type="axis" id="0" value="1" />
  </inputConfig>
</inputList>
""")
    with open(sys_db, "w", encoding="utf-8") as f:
        f.write("03009b4d4b4800000111000000010000,retrogame_joypad,platform:Linux,x:b2,a:b0,b:b1,y:b3,guide:b10,misc1:b17,\n")

    res = ensure_db(out_db, es_xml, sys_db)
    assert res == out_db
    txt = open(out_db, "r", encoding="utf-8").read()
    assert "03009b4d4b4800000111000000010000,retrogame_joypad," in txt, txt
    assert "a:b1,b:b0," in txt, txt
    assert "guide:b10" in txt and "misc1:b17" in txt, txt
    assert "back:b8" in txt and "start:b9" in txt, txt
    assert "-leftx:-a0,+leftx:+a0" in txt, txt
    # Cache hit check
    res2 = ensure_db(out_db, es_xml, sys_db)
    assert res2 == out_db
    print("pocketmz-pad selftest ok")
    return 0


def main():
    if "--selftest" in sys.argv[1:]:
        return selftest()
    p = ensure_db()
    if p:
        print(p)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
