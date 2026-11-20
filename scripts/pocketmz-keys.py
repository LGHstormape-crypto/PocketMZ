#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Dev: press keys like gptokeyb does (a virtual keyboard through /dev/uinput), to drive the
PocketMZ menu or a game in automated tests. Keys go to the focused window.

Usage: pocketmz-keys.py <key>[+<key>][:<ms>] ...   keys: up down left right enter esc pageup pagedown d shift
       e.g. pocketmz-keys.py right right enter      (default 150 ms between keys)
No extra modules (raw ioctls; aarch64 struct layout).
"""
import fcntl, os, struct, sys, time

KEYS = {"esc": 1, "enter": 28, "up": 103, "down": 108, "left": 105, "right": 106,
        "pageup": 104, "pagedown": 109, "d": 32, "shift": 42, "end": 107, "s": 31, "a": 30}
UI_SET_EVBIT, UI_SET_KEYBIT, UI_DEV_CREATE, UI_DEV_DESTROY = 0x40045564, 0x40045565, 0x5501, 0x5502
EV_SYN, EV_KEY = 0, 1


def event(fd, etype, code, value):
    now = time.time()
    os.write(fd, struct.pack("llHHi", int(now), int((now % 1) * 1e6), etype, code, value))


def main(args):
    fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
    fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
    for code in KEYS.values():
        fcntl.ioctl(fd, UI_SET_KEYBIT, code)
    # legacy uinput_user_dev: name[80], input_id (4 x u16), ff_effects_max, abs arrays (4 x 64 s32)
    os.write(fd, struct.pack("80sHHHHi", b"pocketmz-keys", 3, 1, 1, 1, 0) + b"\0" * (4 * 64 * 4))
    fcntl.ioctl(fd, UI_DEV_CREATE)
    time.sleep(1.0)                      # let the compositor pick up the new device
    try:
        for a in args:
            name, _, ms = a.partition(":")
            codes = [KEYS[n] for n in name.lower().split("+")]   # "shift+pagedown": held together
            for code in codes:
                event(fd, EV_KEY, code, 1); event(fd, EV_SYN, 0, 0)
                time.sleep(0.05)
            for code in reversed(codes):
                event(fd, EV_KEY, code, 0); event(fd, EV_SYN, 0, 0)
                time.sleep(0.02)
            time.sleep(int(ms or 150) / 1000)
    finally:
        time.sleep(0.2)
        fcntl.ioctl(fd, UI_DEV_DESTROY)
        os.close(fd)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
