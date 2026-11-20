#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""PocketMZ hotkeys: the handheld's unified "hold F2" combos for RPG Maker games.

Reads the built-in pad (evdev, not grabbed: gptokeyb and the system's input_sense keep
working) and sends commands to the game over 127.0.0.1:9334 (PocketMZ_Menu.js connects).
F1 is only visible here (gptokeyb has no name for it). Started / stopped by pocketmz-run.sh.

Protocol, one line each: "f2 1" / "f2 0" (the game drops its keys while F2 is held, so F2+A
does not also press OK), then: menu quit title save load slow ff1 ff0 pause fps vol+ vol- shot.
Screenshots are taken here with grim (into /storage/roms/screenshots).

Usage: pocketmz-hotkeys.py [device]   (default: the device named retrogame_joypad)
"""
import os, select, socket, struct, subprocess, sys, time

PORT = 9334
EV_KEY = 1
BTN = {305: "a", 304: "b", 307: "x", 308: "y", 310: "l1", 311: "r1", 312: "l2", 313: "r2",
       314: "select", 315: "start", 316: "f2", 317: "l3", 318: "r3",
       544: "up", 545: "down", 546: "left", 547: "right", 704: "f1"}
# button pressed while F2 is held -> command
COMBO = {"f1": "menu", "start": "quit", "select": "title", "l3": "save", "r3": "load",
         "l1": "slow", "r1": "ff1", "a": "pause", "x": "shot", "y": "fps", "up": "vol+", "down": "vol-"}
EVENT = struct.Struct("llHHi")          # struct input_event on 64-bit: timeval, type, code, value


def find_device():
    try:
        text = open("/proc/bus/input/devices", encoding="utf-8", errors="replace").read()
    except OSError:
        return None
    for block in text.split("\n\n"):
        if 'Name="retrogame_joypad"' in block:
            for line in block.splitlines():
                if line.startswith("H: Handlers="):
                    for h in line.split("=", 1)[1].split():
                        if h.startswith("event"):
                            return "/dev/input/" + h
    return None


def screenshot(title):
    os.environ.setdefault("XDG_RUNTIME_DIR", "/var/run/0-runtime-dir")
    os.environ.setdefault("WAYLAND_DISPLAY", "wayland-1")
    d = "/storage/roms/screenshots"
    os.makedirs(d, exist_ok=True)
    safe = "".join(c for c in (title or "pocketmz") if c not in '/\\:*?"<>|').strip()[:40] or "pocketmz"
    path = os.path.join(d, "%s-%s.png" % (safe, time.strftime("%Y%m%d-%H%M%S")))
    try:
        subprocess.run(["grim", path], timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return path if os.path.exists(path) else None
    except (OSError, subprocess.SubprocessError):
        return None


def main():
    dev = sys.argv[1] if len(sys.argv) > 1 else find_device()
    if not dev:
        print("hotkeys: no retrogame_joypad", file=sys.stderr)
        return 1
    title = os.environ.get("POCKETMZ_TITLE", "")
    fd = os.open(dev, os.O_RDONLY)
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", PORT))
    srv.listen(2)
    clients = []
    f2 = False
    ff = False

    def send(msg):
        for c in clients[:]:
            try:
                c.sendall((msg + "\n").encode())
            except OSError:
                clients.remove(c)
                c.close()

    print("hotkeys: %s -> 127.0.0.1:%d" % (dev, PORT), flush=True)
    while True:
        r, _, _ = select.select([fd, srv] + clients, [], [])
        if srv in r:
            c, _ = srv.accept()
            clients.append(c)
            if f2:
                send("f2 1")
        for c in [c for c in clients if c in r]:
            try:
                if not c.recv(256):
                    raise OSError
            except OSError:
                clients.remove(c)
                c.close()
        if fd not in r:
            continue
        try:
            data = os.read(fd, EVENT.size * 32)
        except OSError:                     # pad gone
            return 0
        for i in range(0, len(data) - EVENT.size + 1, EVENT.size):
            _, _, typ, code, value = EVENT.unpack_from(data, i)
            if typ != EV_KEY or value == 2 or code not in BTN:
                continue
            name = BTN[code]
            if name == "f2":
                f2 = value == 1
                send("f2 1" if f2 else "f2 0")
            elif name == "r1" and value == 0 and ff:
                ff = False
                send("ff0")
            elif value == 1 and f2 and name in COMBO:
                cmd = COMBO[name]
                if cmd == "ff1":
                    ff = True
                if cmd == "shot":
                    p = screenshot(title)
                    send("shot " + (p or ""))
                else:
                    send(cmd)


if __name__ == "__main__":
    sys.exit(main() or 0)
