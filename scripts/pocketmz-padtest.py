#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Dev helper: a virtual gamepad (uinput) to test pocketmz-hotkeys.py without pressing buttons.

Usage: pocketmz-padtest.py <combo>...   e.g.  f2+a  f2+f1  f2+r1:1.5 (hold 1.5 s)
Prints the device path first ("dev /dev/input/eventN"), waits 2 s so a reader can open it,
then for each combo presses the buttons in order (0.1 s apart) and releases them in reverse.
"""
import fcntl, os, struct, sys, time

CODES = {"a": 305, "b": 304, "x": 307, "y": 308, "l1": 310, "r1": 311, "l2": 312, "r2": 313,
         "select": 314, "start": 315, "f2": 316, "l3": 317, "r3": 318,
         "up": 544, "down": 545, "left": 546, "right": 547, "f1": 704}
UI_SET_EVBIT, UI_SET_KEYBIT, UI_DEV_CREATE, UI_DEV_DESTROY = 0x40045564, 0x40045565, 0x5501, 0x5502
EV_KEY, EV_SYN = 1, 0


def emit(fd, typ, code, val):
    os.write(fd, struct.pack("llHHi", 0, 0, typ, code, val))


def main(args):
    fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
    fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
    for c in CODES.values():
        fcntl.ioctl(fd, UI_SET_KEYBIT, c)
    name = b"pocketmz-test-pad"
    os.write(fd, name.ljust(80, b"\0") + struct.pack("HHHHi", 3, 1, 1, 1, 0) + b"\0" * (64 * 4 * 4))
    fcntl.ioctl(fd, UI_DEV_CREATE)
    time.sleep(0.5)
    dev = None
    for d in sorted(os.listdir("/sys/class/input")):
        try:
            if d.startswith("event") and open("/sys/class/input/%s/device/name" % d).read().strip() == name.decode():
                dev = "/dev/input/" + d
        except OSError:
            pass
    print("dev", dev, flush=True)
    time.sleep(2.0)
    for combo in args:
        hold = 0.15
        if ":" in combo:
            combo, h = combo.split(":"); hold = float(h)
        if combo == "sleep":            # "sleep:N" waits N seconds
            time.sleep(hold); continue
        keys = [CODES[k] for k in combo.split("+")]
        for k in keys:
            emit(fd, EV_KEY, k, 1); emit(fd, EV_SYN, 0, 0); time.sleep(0.1)
        time.sleep(hold)
        for k in reversed(keys):
            emit(fd, EV_KEY, k, 0); emit(fd, EV_SYN, 0, 0); time.sleep(0.1)
        time.sleep(0.6)
    fcntl.ioctl(fd, UI_DEV_DESTROY)
    os.close(fd)


if __name__ == "__main__":
    main(sys.argv[1:])
