#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) PocketMZ contributors
"""pocketmz-benchgen: generate two small synthetic RPG Maker games (MZ and MV)
used as reproducible memory/performance benchmarks for PocketMZ.

Only the MIT-licensed engine core (scripts, libs, main.js, index.html, css,
plain system images, fonts) is copied from existing game folders given on the
command line.  All database content, maps, events and images are generated
here (abstract gradients/shapes/numbers, no characters, no game content).

Usage:
  python pocketmz-benchgen.py --mz-core DIR --mv-core DIR --out DIR [--scale 1.0]

  --mz-core  folder containing js/rmmz_*.js and js/libs
  --mv-core  folder containing www/js/rpg_*.js and js/libs (the game root,
             or its www/ subfolder, are both accepted)
  --scale    multiplies the pixel size of the big generated pictures
             (stand-up layers, enemies, parallax, battlebacks); 1.0 = 1920x1080
             layers, 800x800 enemies, 2400x1600 parallax.

Run modes (selected by the PocketMZ_BenchBoot plugin, default "text"):
  text   map 1 shows messages (needs OK presses from the autotest driver)
  nomsg  starts on map 3: pictures/tints/battles/transfers only, fully
         unattended.  Select via plugins.js parameter "mode", via the URL
         query ?mode=nomsg, or the env var POCKETMZ_BENCH_MODE=nomsg.
"""
import argparse
import colorsys
import json
import os
import random
import re
import shutil
import subprocess
import sys
import wave
import struct
import math

try:
    from PIL import Image, ImageDraw, ImageFont, ImageOps
    HAVE_PIL = True
except ImportError:  # tiny stdlib fallback below
    HAVE_PIL = False

# ---------------------------------------------------------------------------
# image helpers (Pillow, or a minimal zlib PNG encoder when Pillow is missing)
# ---------------------------------------------------------------------------

DIMS = {}  # absolute path -> (w, h) of every PNG we wrote or copied


def _png_chunk(tag, data):
    import zlib
    c = struct.pack(">I", len(data)) + tag + data
    return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def _write_png_raw(path, w, h, rows):
    """rows: iterator of bytes (RGBA, w*4 bytes each)."""
    import zlib
    raw = b"".join(b"\x00" + r for r in rows)
    data = (b"\x89PNG\r\n\x1a\n"
            + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + _png_chunk(b"IDAT", zlib.compress(raw, 6))
            + _png_chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(data)


class Canvas:
    """Very small RGBA canvas used only when Pillow is unavailable."""
    def __init__(self, w, h, color=(0, 0, 0, 0)):
        self.w, self.h = w, h
        self.px = bytearray(bytes(color) * (w * h))

    def fill_rect(self, x0, y0, x1, y1, color, grad=None):
        x0, y0 = max(0, int(x0)), max(0, int(y0))
        x1, y1 = min(self.w, int(x1)), min(self.h, int(y1))
        for y in range(y0, y1):
            c = color
            if grad:
                t = (y - y0) / max(1, y1 - y0 - 1)
                c = tuple(int(color[i] + (grad[i] - color[i]) * t) for i in range(4))
            row = bytes(c) * (x1 - x0)
            o = (y * self.w + x0) * 4
            self.px[o:o + len(row)] = row

    def fill_ellipse(self, x0, y0, x1, y1, color, grad=None):
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        rx, ry = max(1, (x1 - x0) / 2), max(1, (y1 - y0) / 2)
        for y in range(max(0, int(y0)), min(self.h, int(y1))):
            dy = (y - cy) / ry
            if abs(dy) > 1:
                continue
            dx = math.sqrt(1 - dy * dy) * rx
            c = color
            if grad:
                t = (y - y0) / max(1, y1 - y0 - 1)
                c = tuple(int(color[i] + (grad[i] - color[i]) * t) for i in range(4))
            xa, xb = max(0, int(cx - dx)), min(self.w, int(cx + dx))
            if xb > xa:
                o = (y * self.w + xa) * 4
                self.px[o:o + (xb - xa) * 4] = bytes(c) * (xb - xa)

    def save(self, path):
        stride = self.w * 4
        _write_png_raw(path, self.w, self.h,
                       (bytes(self.px[y * stride:(y + 1) * stride]) for y in range(self.h)))


def _font(size):
    if not HAVE_PIL:
        return None
    try:
        return ImageFont.load_default(size=max(8, int(size)))
    except Exception:
        return ImageFont.load_default()


def hue_color(h, s=0.6, v=0.9, a=255):
    r, g, b = colorsys.hsv_to_rgb(h % 1.0, s, v)
    return (int(r * 255), int(g * 255), int(b * 255), a)


def register(path, size):
    DIMS[os.path.normcase(os.path.abspath(path))] = size


def save_img(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if HAVE_PIL:
        img.save(path, "PNG", compress_level=6)
        register(path, img.size)
    else:
        img.save(path)
        register(path, (img.w, img.h))


def new_img(w, h, color=(0, 0, 0, 0)):
    return Image.new("RGBA", (w, h), color) if HAVE_PIL else Canvas(w, h, color)


def gradient_fill(w, h, c1, c2, horizontal=False):
    """Pillow gradient image (RGBA) c1 -> c2."""
    g = Image.linear_gradient("L").resize((w, h))
    if horizontal:
        g = g.rotate(90, expand=True).resize((w, h))
    return ImageOps.colorize(g, c1[:3], c2[:3]).convert("RGBA")


def draw_label(img, text, cx, cy, size, fill=(255, 255, 255, 255)):
    if not HAVE_PIL:
        return
    d = ImageDraw.Draw(img)
    f = _font(size)
    try:
        d.text((cx, cy), text, font=f, fill=fill, anchor="mm",
               stroke_width=max(1, int(size // 14)), stroke_fill=(0, 0, 0, 255))
    except Exception:
        d.text((cx, cy), text, fill=fill)


def block_noise(w, h, block=8, sigma=10):
    """Low-entropy noise (blocky) as an L image centred on 128."""
    n = Image.effect_noise((max(1, w // block), max(1, h // block)), sigma)
    return n.resize((w, h), Image.BILINEAR)


# ---------------------------------------------------------------------------
# image generators
# ---------------------------------------------------------------------------

def gen_gradient_card(path, w, h, hue, label=None, noise=False, circle=False):
    if HAVE_PIL:
        base = gradient_fill(w, h, hue_color(hue, 0.7, 0.35), hue_color(hue + 0.12, 0.5, 0.95))
        if noise:
            n = block_noise(w, h, 8, 14)
            base = Image.blend(base, Image.merge("RGBA", (n, n, n, Image.new("L", (w, h), 255))), 0.12)
        if circle:
            m = Image.new("L", (w, h), 0)
            ImageDraw.Draw(m).ellipse([w * 0.05, h * 0.05, w * 0.95, h * 0.95], fill=255)
            out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            out.paste(base, (0, 0), m)
            base = out
        if label:
            draw_label(base, label, w / 2, h / 2, min(w, h) / 4)
        save_img(base, path)
    else:
        c = Canvas(w, h, (0, 0, 0, 0))
        top, bot = hue_color(hue, 0.7, 0.4), hue_color(hue + 0.12, 0.5, 0.95)
        (c.fill_ellipse if circle else c.fill_rect)(0, 0, w, h, top, bot)
        save_img(c, path)


def gen_sheet_tiles(path, w, h, tile=48, hue0=0.0):
    """Plain coloured tile sheet with a 1px darker border per tile."""
    if HAVE_PIL:
        img = Image.new("RGBA", (w, h), (0, 0, 0, 255))
        d = ImageDraw.Draw(img)
        cols = w // tile
        for ty in range(h // tile):
            for tx in range(cols):
                hue = hue0 + ((tx + ty * cols) % 24) / 24.0
                col = hue_color(hue, 0.35, 0.75)
                x0, y0 = tx * tile, ty * tile
                d.rectangle([x0, y0, x0 + tile - 1, y0 + tile - 1], fill=col,
                            outline=hue_color(hue, 0.5, 0.45))
        save_img(img, path)
    else:
        c = Canvas(w, h, (0, 0, 0, 255))
        cols = w // tile
        for ty in range(h // tile):
            for tx in range(cols):
                hue = hue0 + ((tx + ty * cols) % 24) / 24.0
                c.fill_rect(tx * tile, ty * tile, (tx + 1) * tile, (ty + 1) * tile,
                            hue_color(hue, 0.35, 0.75))
        save_img(c, path)


def gen_faces(path):
    if HAVE_PIL:
        img = Image.new("RGBA", (576, 288), (0, 0, 0, 0))
        for i in range(8):
            tile = gradient_fill(144, 144, hue_color(i / 8, 0.7, 0.4), hue_color(i / 8 + 0.1, 0.4, 0.95))
            m = Image.new("L", (144, 144), 0)
            ImageDraw.Draw(m).rounded_rectangle([4, 4, 139, 139], 24, fill=255)
            img.paste(tile, ((i % 4) * 144, (i // 4) * 144), m)
            draw_label(img, str(i), (i % 4) * 144 + 72, (i // 4) * 144 + 72, 64)
        save_img(img, path)
    else:
        c = Canvas(576, 288, (0, 0, 0, 0))
        for i in range(8):
            c.fill_ellipse((i % 4) * 144 + 4, (i // 4) * 144 + 4, (i % 4) * 144 + 140,
                           (i // 4) * 144 + 140, hue_color(i / 8, 0.7, 0.4), hue_color(i / 8 + 0.1, 0.4, 0.95))
        save_img(c, path)


def gen_character_sheet(path, cols, rows, single):
    """cols x rows characters of 3x4 48px frames; `single` -> one character."""
    w, h = cols * 144, rows * 192
    if HAVE_PIL:
        img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        for cy in range(rows):
            for cx in range(cols):
                hue = ((cy * cols + cx) / max(1, cols * rows)) if not single else 0.58
                for dr in range(4):        # down, left, right, up
                    for pat in range(3):
                        ox = cx * 144 + pat * 48
                        oy = cy * 192 + dr * 48
                        bob = (pat - 1) * 2
                        d.ellipse([ox + 10, oy + 8 + bob, ox + 38, oy + 42 + bob],
                                  fill=hue_color(hue, 0.7, 0.9), outline=(20, 20, 40, 255))
                        px = {0: (24, 36), 1: (14, 26), 2: (34, 26), 3: (24, 14)}[dr]
                        d.ellipse([ox + px[0] - 5, oy + px[1] - 5 + bob, ox + px[0] + 5,
                                   oy + px[1] + 5 + bob], fill=(255, 255, 255, 255))
        save_img(img, path)
    else:
        c = Canvas(w, h, (0, 0, 0, 0))
        for cy in range(rows):
            for cx in range(cols):
                hue = ((cy * cols + cx) / max(1, cols * rows)) if not single else 0.58
                for dr in range(4):
                    for pat in range(3):
                        ox, oy = cx * 144 + pat * 48, cy * 192 + dr * 48
                        c.fill_ellipse(ox + 10, oy + 8, ox + 38, oy + 42, hue_color(hue, 0.7, 0.9))
        save_img(c, path)


def gen_window_skin(path):
    """192x192 windowskin: background, frame, arrows, pause sign, 32 text colours."""
    if not HAVE_PIL:
        c = Canvas(192, 192, (0, 0, 0, 0))
        c.fill_rect(0, 0, 96, 96, (20, 30, 60, 200))
        for n in range(32):
            c.fill_rect(96 + (n % 8) * 12, 144 + (n // 8) * 12,
                        96 + (n % 8) * 12 + 12, 144 + (n // 8) * 12 + 12, hue_color(n / 32, 0.6, 0.9))
        c.fill_rect(96 + 0, 144, 96 + 12, 156, (255, 255, 255, 255))
        save_img(c, path)
        return
    img = Image.new("RGBA", (192, 192), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 95, 95], fill=(18, 26, 56, 200))
    for i in range(0, 96, 16):
        d.line([i, 0, 0, i], fill=(40, 52, 96, 200))
    d.rounded_rectangle([96, 0, 191, 95], 12, outline=(235, 235, 255, 255), width=3)
    d.rectangle([96 + 4, 4, 96 + 91, 91], outline=(120, 130, 190, 255), width=1)
    d.polygon([(120, 112), (136, 112), (128, 124)], fill=(255, 255, 255, 255))      # arrows
    d.polygon([(152, 124), (168, 124), (160, 112)], fill=(255, 255, 255, 255))
    d.polygon([(120, 164 - 24 + 8), (136, 164 - 24 + 8), (128, 164 - 24 + 20)],
              fill=(255, 255, 255, 255))
    d.rectangle([96 + 0, 96, 96 + 95, 96 + 47], outline=(0, 0, 0, 0))
    d.rounded_rectangle([108, 100, 116, 108], 2, fill=(255, 255, 255, 255))           # cursor-ish
    d.rounded_rectangle([64, 64, 95, 95], 6, outline=(255, 255, 255, 200), width=2)   # cursor (MZ/MV)
    palette = [(255, 255, 255), (32, 160, 214), (255, 120, 76), (102, 204, 64), (153, 204, 255),
               (192, 128, 255), (255, 255, 64), (128, 128, 128), (192, 192, 192), (32, 128, 192),
               (255, 32, 32), (80, 160, 80), (128, 160, 255), (160, 96, 224), (255, 192, 32),
               (0, 0, 0), (128, 64, 0), (255, 160, 128), (255, 96, 96), (96, 255, 96),
               (160, 208, 255), (208, 160, 255), (255, 255, 160), (64, 64, 64), (224, 224, 224),
               (0, 96, 160), (200, 0, 0), (0, 128, 0), (64, 96, 200), (112, 48, 160), (200, 160, 0),
               (32, 32, 32)]
    for n, col in enumerate(palette):
        d.rectangle([96 + (n % 8) * 12, 144 + (n // 8) * 12,
                     96 + (n % 8) * 12 + 11, 144 + (n // 8) * 12 + 11], fill=col + (255,))
    save_img(img, path)


def gen_generic_sheet(path, w, h, hue):
    if HAVE_PIL:
        img = gradient_fill(w, h, hue_color(hue, 0.5, 0.35), hue_color(hue + 0.15, 0.4, 0.9))
        d = ImageDraw.Draw(img)
        step = 48 if w % 48 == 0 else 32
        for x in range(0, w, step):
            d.line([x, 0, x, h], fill=(0, 0, 0, 90))
        for y in range(0, h, step):
            d.line([0, y, w, y], fill=(0, 0, 0, 90))
        save_img(img, path)
    else:
        c = Canvas(w, h, (0, 0, 0, 255))
        c.fill_rect(0, 0, w, h, hue_color(hue, 0.5, 0.35), hue_color(hue + 0.15, 0.4, 0.9))
        save_img(c, path)


SYSTEM_SIZES = {
    "Balloon": (480, 480), "ButtonSet": (576, 144), "GameOver": (1280, 720),
    "IconSet": (512, 640), "Loading": (96, 96), "Shadow1": (48, 48),
    "Shadow2": (192, 192), "States": (768, 1152), "Weapons1": (576, 384),
    "Weapons2": (576, 384), "Weapons3": (576, 384), "Damage": (480, 288),
    "Window": (192, 192),
}


# ---------------------------------------------------------------------------
# event command helpers
# ---------------------------------------------------------------------------

def cmd(code, params=None, indent=0):
    return {"code": code, "indent": indent, "parameters": params if params is not None else []}


def shift(cmds, n):
    out = []
    for c in cmds:
        c2 = dict(c)
        c2["indent"] = c["indent"] + n
        out.append(c2)
    return out


def end(cmds):
    return cmds + [cmd(0)]


class Gen:
    """Per-engine generator (mz=True for RPG Maker MZ, False for MV)."""

    SW_PHASE = {"T_M1_A": 10, "T_M2_A": 11, "T_M1_B": 12, "T_M4": 13, "T_M1_C": 14,
                "T_M2_B": 15, "N_M3": 20, "N_M2": 21, "N_M4": 22}
    VAR_COUNTER, VAR_TROOP, VAR_LOOP = 1, 4, 5
    PIC_FX0 = 21

    def __init__(self, mz, root, scale, have_se):
        self.mz = mz
        self.root = root                       # directory holding data/ img/ js/ ...
        self.scale = scale
        self.have_se = have_se
        self.rng = random.Random(1234 if mz else 4321)
        # stand-up layer images: 12 slots (3 chars x 4 layers), 40 images total
        self.slot_counts = [4] * 4 + [3] * 8
        assert sum(self.slot_counts) == 40
        self.n_sets = 40
        self.W, self.H = 1920, 1080

    # ----- paths -----
    def p(self, *parts):
        return os.path.join(self.root, *parts)

    def S(self, n):
        return max(16, int(round(n * self.scale)))

    # ----- commands -----
    def show_picture(self, pid, name, x=0, y=0, opacity=255, sx=100, sy=100):
        return cmd(231, [pid, name, 0, 0, x, y, sx, sy, opacity, 0])

    def move_picture(self, pid, x, y, opacity, duration, wait=True, sx=100, sy=100):
        params = [pid, 0, 0, 0, x, y, sx, sy, opacity, 0, duration, wait]
        if self.mz:
            params.append(0)  # easing
        return cmd(232, params)

    def tint_picture(self, pid, tone, duration=20, wait=False):
        return cmd(234, [pid, tone, duration, wait])

    def text(self, face, face_idx, bg, pos, lines):
        p = [face, face_idx, bg, pos]
        if self.mz:
            p.append("Bench")
        out = [cmd(101, p)]
        out += [cmd(401, [ln]) for ln in lines]
        return out

    def play_se(self):
        return [cmd(250, [{"name": "bench_se", "volume": 70, "pitch": 100, "pan": 0}])] if self.have_se else []

    def battle(self):
        """Battle Processing with troop id taken from variable 4 (cycled 1..3)."""
        v = self.VAR_TROOP
        return [cmd(355, ["$gameVariables.setValue(%d,($gameVariables.value(%d)%%3)+1);" % (v, v)]),
                cmd(301, [1, v, True, True]),
                cmd(601), cmd(0, indent=1), cmd(602), cmd(0, indent=1),
                cmd(603), cmd(0, indent=1), cmd(604)]

    def transfer(self, map_id, x=20, y=15):
        return [cmd(201, [0, map_id, x, y, 2, 0])]

    def phase(self, own, nxt):
        s = self.SW_PHASE
        return [cmd(121, [s[own], s[own], 1]), cmd(121, [s[nxt], s[nxt], 0])]

    # ----- common events -----
    def stand_set(self, k):
        out = []
        for slot in range(12):
            v = (k + slot) % self.slot_counts[slot]
            c, l = divmod(slot, 4)
            out.append(self.show_picture(slot + 1, "stand_c%d_l%d_v%d" % (c, l, v)))
        return out

    def common_events(self):
        ces = [None]

        def add(name, lst):
            ces.append({"id": len(ces), "list": end(lst), "name": name, "switchId": 1, "trigger": 0})

        # 1 tones
        l = []
        tones = [[-68, -68, 34, 0], [68, 0, -68, 68], [0, 68, 68, -34], [0, 0, 0, 0]]
        for i, t in enumerate(tones):
            for pid in range(1, 13):
                l.append(self.tint_picture(pid, t, 12, False))
            l.append(cmd(223, [t, 15, False]))
            if i == 1:
                l.append(cmd(224, [[255, 255, 255, 170], 12, False]))
            if i == 2:
                l.append(cmd(225, [5, 5, 20, False]))
            l.append(cmd(230, [14]))
        add("BenchTones", l)
        # 2 eight pictures fade in/out
        l = []
        for k in range(8):
            pid = self.PIC_FX0 + k
            l.append(self.show_picture(pid, "bench_fx%d" % (k + 1), 60 + (k % 4) * 450,
                                       100 + (k // 4) * 450, 0))
        for k in range(8):
            l.append(self.move_picture(self.PIC_FX0 + k, 60 + (k % 4) * 450 + 20,
                                       100 + (k // 4) * 450, 255, 15, wait=(k == 7)))
        for k in range(8):
            l.append(self.move_picture(self.PIC_FX0 + k, 60 + (k % 4) * 450 + 40,
                                       100 + (k // 4) * 450 - 20, 0, 15, wait=(k == 7)))
        for k in range(8):
            l.append(cmd(235, [self.PIC_FX0 + k]))
        add("BenchPics8", l)
        # 3 battle
        add("BenchBattle", self.battle())
        # 4 clear stand-up pictures
        add("BenchClear", [cmd(235, [i]) for i in range(1, 13)])
        while len(ces) < 10:
            add("Reserved", [])
        for k in range(self.n_sets):
            add("BenchStand%02d" % k, self.stand_set(k))
        return ces

    # ----- message block -----
    def message_block(self, i):
        out = [cmd(117, [10 + (i % self.n_sets)])]
        out += self.play_se()
        pos, bg = i % 3, (0, 1, 2, 0)[i % 4]
        lines = [
            "[%02d] Synthetic window text \\C[%d]coloured\\C[0] with icon \\I[%d]." % (i, 1 + i % 7, 64 + i % 40),
            "Line two for window churn: position %d, background %d, value \\V[1]." % (pos, bg),
        ]
        if i % 3 == 0:
            lines.append("A third line makes the message window taller (%d)." % i)
        out += self.text("bench_face", i % 8, bg, pos, lines)
        if i % 5 == 4:
            out.append(cmd(117, [1]))
        if i % 7 == 3:
            out.append(cmd(223, [[(i * 17) % 100 - 50, 0, (i * 29) % 100 - 50, 0], 20, False]))
        if i % 6 == 2:
            out.append(cmd(224, [[255, 255, 255, 200], 15, False]))
        if i % 9 == 5:
            out.append(cmd(225, [4, 6, 18, False]))
        out.append(cmd(122, [self.VAR_COUNTER, self.VAR_COUNTER, 1, 0, 1]))   # counter += 1
        out.append(cmd(230, [6]))
        return out

    def text_phase_page(self, own, nxt, start, count, dest_map):
        l = [cmd(121, [self.SW_PHASE[own], self.SW_PHASE[own], 1])]
        if own == "T_M1_A":
            l.append(cmd(122, [self.VAR_COUNTER, self.VAR_COUNTER, 0, 0, 0]))
        for i in range(start, start + count):
            l += self.message_block(i)
        l += self.battle()
        l.append(cmd(121, [self.SW_PHASE[nxt], self.SW_PHASE[nxt], 0]))
        l += self.transfer(dest_map)
        return end(l)

    # ----- map pages -----
    def page(self, trigger, lst, switch=None, move_type=0, char=("", 0), tile=0, speed=3,
             through=False, anim_walk=True):
        cond = {"actorId": 1, "actorValid": False, "itemId": 1, "itemValid": False,
                "selfSwitchCh": "A", "selfSwitchValid": False,
                "switch1Id": switch or 1, "switch1Valid": switch is not None,
                "switch2Id": 1, "switch2Valid": False,
                "variableId": 1, "variableValid": False, "variableValue": 0}
        return {"conditions": cond, "directionFix": False,
                "image": {"characterIndex": char[1], "characterName": char[0],
                          "direction": 2, "pattern": 1, "tileId": tile},
                "list": lst, "moveFreq": 3, "moveFrequency": 3,
                "moveRoute": {"list": [{"code": 0, "parameters": []}], "repeat": True,
                              "skippable": False, "wait": False},
                "moveSpeed": speed, "moveType": move_type, "priorityType": 1,
                "stepAnime": False, "through": through, "trigger": trigger, "walkAnime": anim_walk}

    def event(self, eid, name, x, y, pages):
        return {"id": eid, "name": name, "note": "", "pages": pages, "x": x, "y": y}

    def map_events(self, mid):
        W, H = 40, 30
        events = [None]
        s = self.SW_PHASE
        # --- autorun controllers ---
        pages = []
        if mid == 1:
            pages = [
                self.page(3, self.text_phase_page("T_M1_A", "T_M2_A", 0, 20, 2), s["T_M1_A"]),
                self.page(3, self.text_phase_page("T_M1_B", "T_M4", 20, 20, 4), s["T_M1_B"]),
                self.page(3, self.text_phase_page("T_M1_C", "T_M2_B", 40, 20, 2), s["T_M1_C"]),
            ]
        elif mid == 2:
            a = [cmd(121, [s["T_M2_A"], s["T_M2_A"], 1]), cmd(117, [2]), cmd(117, [1])]
            a += self.text("bench_face", 3, 0, 2, ["Map 2 (parallax): quick pictures done.",
                                                  "Returning to map 1 for the next 20 messages."])
            a += self.play_se() + [cmd(121, [s["T_M1_B"], s["T_M1_B"], 0])] + self.transfer(1)
            b = [cmd(121, [s["T_M2_B"], s["T_M2_B"], 1]), cmd(117, [2]), cmd(117, [4]),
                 cmd(121, [s["T_M1_A"], s["T_M1_A"], 0])] + self.transfer(1)
            c = [cmd(121, [s["N_M2"], s["N_M2"], 1]), cmd(117, [2]), cmd(117, [1])] \
                + self.phase_set("N_M4") + self.transfer(4)
            pages = [self.page(3, end(a), s["T_M2_A"]), self.page(3, end(b), s["T_M2_B"]),
                     self.page(3, end(c), s["N_M2"])]
        elif mid == 3:
            pages = [self.page(3, end(self.nomsg_map3(s)), s["N_M3"])]
        elif mid == 4:
            a = [cmd(121, [s["T_M4"], s["T_M4"], 1]), cmd(117, [1]), cmd(117, [2]),
                 cmd(121, [s["T_M1_C"], s["T_M1_C"], 0])] + self.transfer(1)
            b = [cmd(121, [s["N_M4"], s["N_M4"], 1]), cmd(117, [1]), cmd(117, [4]),
                 cmd(121, [s["N_M3"], s["N_M3"], 0])] + self.transfer(3)
            pages = [self.page(3, end(a), s["T_M4"]), self.page(3, end(b), s["N_M4"])]
        events.append(self.event(1, "BenchController", 20, 15, pages))

        # --- edge touch transfers (player touch) ---
        links = {1: [(39, 15, 2, 1, 15), (0, 15, 4, 38, 15)],
                 2: [(0, 15, 1, 38, 15), (39, 15, 3, 1, 15)],
                 3: [(0, 15, 2, 38, 15), (39, 15, 4, 1, 15)],
                 4: [(0, 15, 3, 38, 15), (39, 15, 1, 1, 15)]}
        for (x, y, dest, dx, dy) in links[mid]:
            lst = end([cmd(201, [0, dest, dx, dy, 2, 0])])
            events.append(self.event(len(events), "Edge%d_%d" % (x, y), x, y,
                                     [self.page(1, lst, None, char=("benchchars", 0), speed=3,
                                                anim_walk=False)]))
        # --- many random-walking decoration events ---
        n = {1: 120, 2: 120, 3: 60, 4: 60}[mid]
        for i in range(n):
            x, y = self.rng.randrange(1, W - 1), self.rng.randrange(1, H - 1)
            if (x, y) == (20, 15):
                x = 21
            events.append(self.event(len(events), "Deco%03d" % i, x, y,
                                     [self.page(0, end([]), None, move_type=1,
                                                char=("benchchars", i % 8), speed=3 + (i % 2))]))
        return events

    def phase_set(self, nxt):
        return [cmd(121, [self.SW_PHASE[nxt], self.SW_PHASE[nxt], 0])]

    def nomsg_map3(self, s):
        """Map 3 (no messages): loop x3 of pictures/tints/common events, then battle + transfer."""
        body = []
        for k in range(4):
            body += [cmd(117, [10 + (k * 9) % self.n_sets]), cmd(230, [8]),
                     cmd(117, [10 + (k * 9 + 3) % self.n_sets]), cmd(230, [8])]
        body += [cmd(117, [1]), cmd(117, [2]), cmd(223, [[40, -40, 20, 20], 20, False]),
                 cmd(224, [[255, 255, 255, 200], 15, False]), cmd(225, [4, 6, 18, True]),
                 cmd(223, [[0, 0, 0, 0], 20, False]),
                 cmd(122, [self.VAR_LOOP, self.VAR_LOOP, 1, 0, 1]),
                 cmd(111, [1, self.VAR_LOOP, 0, 3, 1])]
        l = [cmd(121, [s["N_M3"], s["N_M3"], 1]),
             cmd(122, [self.VAR_LOOP, self.VAR_LOOP, 0, 0, 0]),
             cmd(112)]
        l += shift(body, 1)
        l += [cmd(113, [], 2), cmd(0, indent=2), cmd(412, [], 1), cmd(0, indent=1), cmd(413)]
        l += self.battle()
        l += [cmd(117, [4])]
        l += [cmd(121, [s["N_M2"], s["N_M2"], 0])] + self.transfer(2)
        return l

    # ----- database -----
    def database(self):
        mz = self.mz
        d = {}
        n_params = [2000, 100, 200, 20, 20, 20, 50, 30]
        cls = lambda i, nm, k: {
            "id": i, "expParams": [15, 0, 10, 10],
            "traits": [{"code": 23, "dataId": 0, "value": 1}, {"code": 22, "dataId": 0, "value": 0.95},
                       {"code": 22, "dataId": 1, "value": 0.05}],
            "learnings": [], "name": nm, "note": "",
            "params": [[p * k] * 100 for p in n_params]}
        d["Classes"] = [None, cls(1, "Bench Class A", 1), cls(2, "Bench Class B", 1)]
        d["Actors"] = [None, {
            "id": 1, "battlerName": "", "characterIndex": 0, "characterName": "$benchchar",
            "classId": 1, "equips": [0, 0, 0, 0, 0], "faceIndex": 0, "faceName": "bench_face",
            "traits": [{"code": 62, "dataId": 0, "value": 1}],   # auto battle (unattended)
            "initialLevel": 1, "maxLevel": 99, "name": "Tester", "nickname": "", "note": "", "profile": ""}]

        def skill(i, name, formula, scope, dtype=1, effects=None, stype=0):
            s = {"id": i, "animationId": 0,
                 "damage": {"critical": True, "elementId": -1, "formula": formula,
                            "type": dtype, "variance": 20},
                 "description": "", "effects": effects if effects is not None else
                 [{"code": 21, "dataId": 0, "value1": 1, "value2": 0}],
                 "hitType": 1, "iconIndex": 76, "message1": "%1 uses " + name + "!", "message2": "",
                 "mpCost": 0, "name": name, "note": "", "occasion": 1, "repeats": 1,
                 "requiredWtypeId1": 0, "requiredWtypeId2": 0, "scope": scope, "speed": 0,
                 "stypeId": stype, "successRate": 100, "tpCost": 0, "tpGain": 10}
            if mz:
                s["messageType"] = 1
            return s
        d["Skills"] = [None,
                       skill(1, "Attack", "a.atk * 4 - b.def * 2", 1),
                       skill(2, "Guard", "0", 11, 0, [{"code": 21, "dataId": 2, "value1": 1, "value2": 0}]),
                       skill(3, "Bench Slash", "a.atk * 5 - b.def * 2", 1, stype=1),
                       skill(4, "Bench Mend", "a.mat * 2", 11, 3, [], stype=1),
                       skill(5, "Bench Nova", "a.mat * 6", 2, stype=1)]

        def item(i, name, eff):
            return {"id": i, "animationId": 0, "consumable": True,
                    "damage": {"critical": False, "elementId": 0, "formula": "0", "type": 0, "variance": 20},
                    "description": "", "effects": eff, "hitType": 0, "iconIndex": 176 + i,
                    "itypeId": 1, "name": name, "note": "", "occasion": 0, "price": 10,
                    "repeats": 1, "scope": 7, "speed": 0, "successRate": 100, "tpGain": 0}
        d["Items"] = [None, item(1, "Bench Potion", [{"code": 11, "dataId": 0, "value1": 0, "value2": 200}]),
                      item(2, "Bench Ether", [{"code": 12, "dataId": 0, "value1": 0, "value2": 50}]),
                      item(3, "Bench Tonic", [{"code": 21, "dataId": 3, "value1": 1, "value2": 0}])]
        d["Weapons"] = [None] + [{"id": i, "animationId": 0, "description": "", "etypeId": 1, "traits": [],
                                  "iconIndex": 96 + i, "name": "Bench Blade %d" % i, "note": "",
                                  "params": [0, 0, 5 * i, 0, 0, 0, 0, 0], "price": 20, "wtypeId": 1}
                                 for i in (1, 2, 3)]
        d["Armors"] = [None] + [{"id": i, "atypeId": 1, "description": "", "etypeId": 2 + (i % 3),
                                 "traits": [], "iconIndex": 128 + i, "name": "Bench Armor %d" % i,
                                 "note": "", "params": [0, 0, 0, 3 * i, 0, 0, 0, 0], "price": 20}
                                for i in (1, 2, 3)]

        def state(i, name, restriction, prio, traits, remove_battle=False, icon=1):
            s = {"id": i, "autoRemovalTiming": 0, "chanceByDamage": 100, "iconIndex": icon,
                 "maxTurns": 1, "message1": "", "message2": "", "message3": "", "message4": "",
                 "minTurns": 1, "motion": 0, "name": name, "note": "", "overlay": 0,
                 "priority": prio, "releaseByDamage": False, "removeAtBattleEnd": remove_battle,
                 "removeByDamage": False, "removeByRestriction": False, "removeByWalking": False,
                 "restriction": restriction, "stepsToRemove": 100, "traits": traits}
            if mz:
                s["messageType"] = 1
            return s
        d["States"] = [None,
                       state(1, "Knocked Out", 4, 100, [{"code": 23, "dataId": 9, "value": 0}], icon=1),
                       state(2, "Guard", 0, 50, [{"code": 62, "dataId": 1, "value": 1}], True, 2),
                       state(3, "Bench Aura", 0, 30, [{"code": 21, "dataId": 2, "value": 1.2}], True, 3)]
        en = lambda i, nm, hp: {
            "id": i, "actions": [{"conditionParam1": 0, "conditionParam2": 0, "conditionType": 0,
                                  "rating": 5, "skillId": 1}],
            "battlerHue": 0, "battlerName": "bench_enemy%d" % i,
            "dropItems": [{"dataId": 1, "denominator": 3, "kind": 1}, {"dataId": 0, "denominator": 1, "kind": 0},
                          {"dataId": 0, "denominator": 1, "kind": 0}],
            "exp": 5, "traits": [{"code": 22, "dataId": 0, "value": 0.95}], "gold": 5, "name": nm,
            "note": "", "params": [hp, 0, 30, 10, 10, 10, 20, 10]}
        d["Enemies"] = [None, en(1, "Bench Orb", 400), en(2, "Bench Cube", 500), en(3, "Bench Prism", 600)]
        pg = lambda: {"conditions": {"actorHp": 50, "actorId": 1, "actorValid": False, "enemyHp": 50,
                                     "enemyIndex": 0, "enemyValid": False, "switchId": 1,
                                     "switchValid": False, "turnA": 0, "turnB": 0,
                                     "turnEnding": False, "turnValid": False},
                      "list": [cmd(0)], "span": 0}
        d["Troops"] = [None,
                       {"id": 1, "members": [{"enemyId": 1, "x": 960, "y": 1000, "hidden": False}],
                        "name": "Bench Troop 1", "pages": [pg()]},
                       {"id": 2, "members": [{"enemyId": 1, "x": 600, "y": 1000, "hidden": False},
                                             {"enemyId": 2, "x": 1320, "y": 1000, "hidden": False}],
                        "name": "Bench Troop 2", "pages": [pg()]},
                       {"id": 3, "members": [{"enemyId": 1, "x": 400, "y": 1000, "hidden": False},
                                             {"enemyId": 2, "x": 960, "y": 1000, "hidden": False},
                                             {"enemyId": 3, "x": 1520, "y": 1000, "hidden": False}],
                        "name": "Bench Troop 3", "pages": [pg()]}]
        d["Animations"] = [None]
        flags = [0] * 8192
        d["Tilesets"] = [None, {"id": 1, "flags": flags, "mode": 1 if mz else 1, "name": "Bench Tileset",
                                "note": "",
                                "tilesetNames": ["bench_A1", "bench_A2", "bench_A3", "bench_A4",
                                                 "bench_A5", "bench_B", "bench_C", "bench_D", "bench_E"]}]
        d["CommonEvents"] = self.common_events()
        return d

    def system(self):
        mz = self.mz
        snd = {"name": "", "pan": 0, "pitch": 100, "volume": 90}
        msgs = {k: v for k, v in {
            "alwaysDash": "Always Dash", "commandRemember": "Command Remember", "touchUI": "Touch UI",
            "bgmVolume": "BGM Volume", "bgsVolume": "BGS Volume", "meVolume": "ME Volume",
            "seVolume": "SE Volume", "possession": "Possession", "expTotal": "Current %1",
            "expNext": "To Next %1", "saveMessage": "Save to which file?",
            "loadMessage": "Load which file?", "file": "File", "autosave": "Autosave",
            "partyName": "%1's team", "emerge": "%1 appeared.", "preemptive": "%1 got the initiative.",
            "surprise": "%1 was caught off guard.", "escapeStart": "%1 runs.",
            "escapeFailure": "Could not escape.", "victory": "%1 won.", "defeat": "%1 lost.",
            "obtainExp": "%1 %2 gained.", "obtainGold": "%1\\G gained.", "obtainItem": "Got %1.",
            "levelUp": "%1 reached %2 %3.", "obtainSkill": "Learned %1.", "useItem": "%1 uses %2.",
            "criticalToEnemy": "Critical!", "criticalToActor": "Critical hit!",
            "actorDamage": "%1 takes %2 damage.", "actorRecovery": "%1 recovers %3 %2.",
            "actorGain": "%1 gains %3 %2.", "actorLoss": "%1 loses %3 %2.",
            "actorDrain": "%1 drained %3 %2.", "actorNoDamage": "%1 takes no damage.",
            "actorNoHit": "Miss! %1 unharmed.", "enemyDamage": "%1 takes %2 damage.",
            "enemyRecovery": "%1 recovers %3 %2.", "enemyGain": "%1 gains %3 %2.",
            "enemyLoss": "%1 loses %3 %2.", "enemyDrain": "%1 drained %3 %2.",
            "enemyNoDamage": "%1 takes no damage.", "enemyNoHit": "Miss! %1 unharmed.",
            "evasion": "%1 evaded.", "magicEvasion": "%1 nullified.", "magicReflection": "%1 reflected.",
            "counterAttack": "%1 counters.", "substitute": "%1 covers %2.", "buffAdd": "%1 %2 up.",
            "debuffAdd": "%1 %2 down.", "buffRemove": "%1 %2 normal.", "actionFailure": "No effect on %1."
        }.items()}
        terms = {
            "basic": ["Level", "Lv", "HP", "HP", "MP", "MP", "TP", "TP", "EXP", "EXP"],
            "commands": ["Fight", "Escape", "Attack", "Guard", "Item", "Skill", "Equip", "Status",
                         "Formation", "Save", "Game End", "Options", "Weapon", "Armor", "Key Item",
                         "Equip", "Optimize", "Clear", "New Game", "Continue", None, "To Title",
                         "Cancel", None, "Buy", "Sell"],
            "params": ["Max HP", "Max MP", "Attack", "Defense", "M.Attack", "M.Defense", "Agility",
                       "Luck", "Hit", "Evasion"],
            "messages": msgs}
        sw = [""] + ["bench_sw_%d" % i for i in range(1, 30)]
        var = [""] + ["bench_var_%d" % i for i in range(1, 11)]
        sysd = {
            "airship": {"bgm": dict(snd), "characterIndex": 3, "characterName": "", "startMapId": 0,
                        "startX": 0, "startY": 0},
            "armorTypes": ["", "General"],
            "attackMotions": [{"type": 0, "weaponImageId": 0}, {"type": 1, "weaponImageId": 1}],
            "battleBgm": dict(snd), "battleback1Name": "bench_bg1", "battleback2Name": "bench_bg2",
            "battlerHue": 0, "battlerName": "", "boat": {"bgm": dict(snd), "characterIndex": 0,
                                                         "characterName": "", "startMapId": 0,
                                                         "startX": 0, "startY": 0},
            "currencyUnit": "G", "defeatMe": dict(snd), "editMapId": 1, "elements": ["", "Physical"],
            "equipTypes": ["", "Weapon", "Shield", "Head", "Body", "Accessory"],
            "gameTitle": "PocketMZ Bench " + ("MZ" if mz else "MV"), "gameoverMe": dict(snd),
            "itemCategories": [True, True, True, True], "locale": "en_US",
            "magicSkills": [1], "menuCommands": [True, True, True, True, False, True],
            "optDisplayTp": True, "optDrawTitle": False, "optExtraExp": False, "optFloorDeath": False,
            "optFollowers": False, "optSideView": False, "optSlipDeath": False, "optTransparent": True,
            "partyMembers": [1], "ship": {"bgm": dict(snd), "characterIndex": 1, "characterName": "",
                                          "startMapId": 0, "startX": 0, "startY": 0},
            "skillTypes": ["", "Special"], "sounds": [dict(snd) for _ in range(24)],
            "startMapId": 1, "startX": 20, "startY": 15, "switches": sw,
            "terms": terms, "testBattlers": [{"actorId": 1, "equips": [0, 0, 0, 0, 0], "level": 1}],
            "testTroopId": 1, "title1Name": "", "title2Name": "", "titleBgm": dict(snd),
            "variables": var, "versionId": 20260101 if mz else 20260102,
            "victoryMe": dict(snd), "weaponTypes": ["", "Sword"],
            "windowTone": [0, 0, 0, 0],
            "hasEncryptedImages": False, "hasEncryptedAudio": False,
            "encryptionKey": "00000000000000000000000000000000",
        }
        if mz:
            sysd.update({
                "advanced": {"gameId": 20260101, "screenWidth": 1920, "screenHeight": 1080,
                             "uiAreaWidth": 1920, "uiAreaHeight": 1080,
                             "numberFontFilename": "mplus-2p-bold-sub.woff",
                             "fallbackFonts": "Verdana, sans-serif", "fontSize": 28,
                             "mainFontFilename": "mplus-1m-regular.woff", "screenScale": 1,
                             "windowOpacity": 192, "picturesUpperLimit": 100},
                "battleSystem": 0, "faceSize": 144, "iconSize": 32, "tileSize": 48,
                "optAutosave": False, "optKeyItemsNumber": False, "optMessageSkip": True,
                "optSplashScreen": False,
                "titleCommandWindow": {"background": 0, "offsetX": 0, "offsetY": 0},
                "editor": {"jsonFormatLevel": 2, "messageWidth1": 816, "messageWidth2": 816}})
        else:
            sysd["optTransparent"] = True
        return sysd

    def map_data(self, mid):
        W, H = 40, 30
        data = [0] * (W * H * 6)
        for y in range(H):
            for x in range(W):
                data[y * W + x] = 1536 + ((x // 4 + y // 4) % 8)
        names = {1: "Bench Text Hub", 2: "Bench Parallax", 3: "Bench NoMsg Hub", 4: "Bench Tint Room"}
        m = {"autoplayBgm": False, "autoplayBgs": False, "battleback1Name": "bench_bg1",
             "battleback2Name": "bench_bg2", "bgm": {"name": "", "pan": 0, "pitch": 100, "volume": 90},
             "bgs": {"name": "", "pan": 0, "pitch": 100, "volume": 90},
             "disableDashing": False, "displayName": "", "encounterList": [], "encounterStep": 30,
             "height": H, "note": "", "parallaxLoopX": mid == 2, "parallaxLoopY": False,
             "parallaxName": "bench_parallax" if mid == 2 else "", "parallaxShow": True,
             "parallaxSx": 1 if mid == 2 else 0, "parallaxSy": 0, "scrollType": 0,
             "specifyBattleback": True, "tilesetId": 1, "width": W, "data": data,
             "events": self.map_events(mid)}
        return m, names[mid]


# ---------------------------------------------------------------------------
# plugins
# ---------------------------------------------------------------------------

PLUGIN_BOOT = r"""//=============================================================================
// PocketMZ_BenchBoot.js
// SPDX-License-Identifier: MIT
//=============================================================================
/*:
 * @plugindesc PocketMZ bench: skips the title screen and selects the run mode.
 * @target MZ
 * @param mode
 * @text Run mode
 * @desc "text" = messages on map 1 (needs OK presses). "nomsg" = starts on map 3, no messages, fully unattended.
 * @default text
 */
(() => {
    "use strict";
    const params = PluginManager.parameters("PocketMZ_BenchBoot");
    function runMode() {
        let m = String(params.mode || "text");
        try {
            const q = /[?&]mode=([a-z]+)/.exec(location.search || "");
            if (q) m = q[1];
        } catch (e) { /* ignore */ }
        try {
            if (typeof process === "object" && process.env && process.env.POCKETMZ_BENCH_MODE) {
                m = process.env.POCKETMZ_BENCH_MODE;
            }
        } catch (e) { /* ignore */ }
        return m === "nomsg" ? "nomsg" : "text";
    }

    const _setupNewGame = DataManager.setupNewGame;
    DataManager.setupNewGame = function() {
        _setupNewGame.call(this);
        if (runMode() === "nomsg") {
            $gameSwitches.setValue(20, true);          // phase N_M3
            $gamePlayer.reserveTransfer(3, 20, 15, 2, 0);
        } else {
            $gameSwitches.setValue(10, true);          // phase T_M1_A
        }
    };

    if (typeof Scene_Boot.prototype.startNormalGame === "function") {
        // MZ: go straight to the map instead of the title screen
        Scene_Boot.prototype.startNormalGame = function() {
            this.checkPlayerLocation();
            DataManager.setupNewGame();
            SceneManager.goto(Scene_Map);
        };
    } else {
        // MV
        const _start = Scene_Boot.prototype.start;
        Scene_Boot.prototype.start = function() {
            if (DataManager.isBattleTest() || DataManager.isEventTest()) {
                return _start.call(this);
            }
            Scene_Base.prototype.start.call(this);
            SoundManager.preloadImportantSounds();
            this.checkPlayerLocation();
            DataManager.setupNewGame();
            SceneManager.goto(Scene_Map);
            this.updateDocumentTitle();
        };
    }
})();
"""

PLUGIN_SCREEN_MV = r"""//=============================================================================
// PocketMZ_BenchScreen.js
// SPDX-License-Identifier: MIT
//=============================================================================
/*:
 * @plugindesc PocketMZ bench: 1920x1080 screen for RPG Maker MV.
 */
(function() {
    "use strict";
    SceneManager._screenWidth = 1920;
    SceneManager._screenHeight = 1080;
    SceneManager._boxWidth = 1920;
    SceneManager._boxHeight = 1080;
})();
"""


# ---------------------------------------------------------------------------
# file operations
# ---------------------------------------------------------------------------

def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def copy_file(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)


def fail(msg):
    print("error: " + msg, file=sys.stderr)
    sys.exit(2)


def copy_core_mz(core, root):
    js = os.path.join(core, "js")
    if not os.path.isdir(js):
        fail("--mz-core: %s has no js/ folder" % core)
    names = sorted(f for f in os.listdir(js) if re.fullmatch(r"rmmz_.*\.js", f))
    if len(names) < 6:
        fail("--mz-core: expected js/rmmz_*.js (found %d)" % len(names))
    for f in names:
        copy_file(os.path.join(js, f), os.path.join(root, "js", f))
    libs = os.path.join(js, "libs")
    if not os.path.isdir(libs):
        fail("--mz-core: missing js/libs")
    for f in sorted(os.listdir(libs)):
        if os.path.isfile(os.path.join(libs, f)):
            copy_file(os.path.join(libs, f), os.path.join(root, "js", "libs", f))
    copy_file(os.path.join(js, "main.js"), os.path.join(root, "js", "main.js"))
    html = open(os.path.join(core, "index.html"), encoding="utf-8").read()
    html = re.sub(r"<title>.*?</title>", "<title>PocketMZ Bench MZ</title>", html, flags=re.S)
    write_text(os.path.join(root, "index.html"), html)
    css = os.path.join(core, "css", "game.css")
    copy_file(css, os.path.join(root, "css", "game.css"))
    # fonts: the two woff files that System.json references (M+ fonts are free)
    for f in ("mplus-1m-regular.woff", "mplus-2p-bold-sub.woff"):
        src = os.path.join(core, "fonts", f)
        if os.path.isfile(src):
            copy_file(src, os.path.join(root, "fonts", f))
        else:
            print("warning: font %s missing in --mz-core (text will use fallback fonts)" % f)
    copy_system_images(os.path.join(core, "img", "system"), os.path.join(root, "img", "system"))


def copy_core_mv(core, www):
    base = core
    if not os.path.isdir(os.path.join(base, "js")) and os.path.isdir(os.path.join(base, "www", "js")):
        base = os.path.join(base, "www")
    js = os.path.join(base, "js")
    if not os.path.isdir(js):
        fail("--mv-core: %s has no js/ (or www/js) folder" % core)
    names = sorted(f for f in os.listdir(js) if re.fullmatch(r"rpg_.*\.js", f))
    if len(names) < 6:
        fail("--mv-core: expected js/rpg_*.js (found %d)" % len(names))
    for f in names:
        copy_file(os.path.join(js, f), os.path.join(www, "js", f))
    libs = os.path.join(js, "libs")
    if not os.path.isdir(libs):
        fail("--mv-core: missing js/libs")
    for f in sorted(os.listdir(libs)):
        if os.path.isfile(os.path.join(libs, f)):
            copy_file(os.path.join(libs, f), os.path.join(www, "js", "libs", f))
    copy_file(os.path.join(js, "main.js"), os.path.join(www, "js", "main.js"))
    html = open(os.path.join(base, "index.html"), encoding="utf-8").read()
    html = re.sub(r"<title>.*?</title>", "<title>PocketMZ Bench MV</title>", html, flags=re.S)
    write_text(os.path.join(www, "index.html"), html)
    # fonts referenced by gamefont.css
    css_path = os.path.join(base, "fonts", "gamefont.css")
    if os.path.isfile(css_path):
        css = open(css_path, encoding="utf-8").read()
        write_text(os.path.join(www, "fonts", "gamefont.css"), css)
        for ref in re.findall(r"url\(\s*[\"']?([^\"')]+)[\"']?\s*\)", css):
            src = os.path.join(base, "fonts", ref)
            if os.path.isfile(src):
                copy_file(src, os.path.join(www, "fonts", ref))
            else:
                print("warning: font %s missing in --mv-core" % ref)
    else:
        write_text(os.path.join(www, "fonts", "gamefont.css"),
                   "@font-face {\n    font-family: GameFont;\n    src: local(sans-serif);\n}\n")
    copy_system_images(os.path.join(base, "img", "system"), os.path.join(www, "img", "system"))


def copy_system_images(src_dir, dst_dir):
    """Copy plain (unencrypted) PNGs from img/system; encrypted ones are skipped and regenerated later."""
    if not os.path.isdir(src_dir):
        return
    for f in sorted(os.listdir(src_dir)):
        if not f.lower().endswith(".png"):
            continue
        src = os.path.join(src_dir, f)
        try:
            with open(src, "rb") as fh:
                if fh.read(8) != b"\x89PNG\r\n\x1a\n":
                    continue
            w, h = struct.unpack(">II", open(src, "rb").read(24)[16:24])
        except Exception:
            continue
        # normalise case of the names the engine asks for
        stem = os.path.splitext(f)[0]
        canon = {k.lower(): k for k in SYSTEM_SIZES}.get(stem.lower(), stem)
        dst = os.path.join(dst_dir, canon + ".png")
        copy_file(src, dst)
        register(dst, (w, h))


def make_system_images(root):
    sysdir = os.path.join(root, "img", "system")
    for name, (w, h) in SYSTEM_SIZES.items():
        path = os.path.join(sysdir, name + ".png")
        if os.path.isfile(path):
            continue
        if name == "Window":
            gen_window_skin(path)
        else:
            gen_generic_sheet(path, w, h, (sum(map(ord, name)) % 100) / 100.0)


def make_icon(root):
    gen_gradient_card(os.path.join(root, "icon", "icon.png"), 192, 192, 0.58, "PMZ", circle=True)


def make_se(root):
    """Short blip WAV -> OGG when ffmpeg exists. Returns True if audio/se/bench_se.ogg exists."""
    ff = shutil.which("ffmpeg")
    if not ff:
        return False
    d = os.path.join(root, "audio", "se")
    os.makedirs(d, exist_ok=True)
    wav = os.path.join(d, "bench_se.wav")
    with wave.open(wav, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(44100)
        frames = bytearray()
        n = int(44100 * 0.15)
        for i in range(n):
            env = 1 - i / n
            frames += struct.pack("<h", int(12000 * env * math.sin(2 * math.pi * 880 * i / 44100)))
        w.writeframes(bytes(frames))
    ogg = os.path.join(d, "bench_se.ogg")
    r = subprocess.run([ff, "-y", "-loglevel", "error", "-i", wav, "-c:a", "libvorbis", ogg],
                       capture_output=True)
    os.remove(wav)
    if r.returncode != 0 or not os.path.isfile(ogg):
        return False
    return True


# ---------------------------------------------------------------------------
# generated images for one game
# ---------------------------------------------------------------------------

def gen_images(g):
    root = g.root
    S = g.S
    img = lambda *a: os.path.join(root, "img", *a)
    # tilesets
    sheets = {"A1": (768, 576), "A2": (768, 576), "A3": (768, 384), "A4": (768, 720),
              "A5": (384, 768), "B": (768, 768), "C": (768, 768), "D": (768, 768), "E": (768, 768)}
    for i, (k, (w, h)) in enumerate(sheets.items()):
        gen_sheet_tiles(img("tilesets", "bench_%s.png" % k), w, h, hue0=i * 0.07)
    # faces / characters
    gen_faces(img("faces", "bench_face.png"))
    gen_character_sheet(img("characters", "$benchchar.png"), 1, 1, True)
    gen_character_sheet(img("characters", "benchchars.png"), 4, 2, False)
    # enemies 800x800
    for i in range(1, 4):
        gen_gradient_card(img("enemies", "bench_enemy%d.png" % i), S(800), S(800), i / 5.0,
                          "ENEMY %d" % i, noise=True, circle=True)
    # battlebacks and parallax
    gen_gradient_card(img("battlebacks1", "bench_bg1.png"), S(1280), S(720), 0.55, "BG1", noise=True)
    if HAVE_PIL:
        w, h = S(1280), S(720)
        bg2 = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(bg2)
        for i in range(6):
            d.ellipse([w * (0.05 + i * 0.16), h * 0.55, w * (0.2 + i * 0.16), h * 0.95],
                      fill=hue_color(0.08 + i * 0.1, 0.5, 0.6, 150))
        save_img(bg2, img("battlebacks2", "bench_bg2.png"))
    else:
        c = Canvas(S(1280), S(720), (0, 0, 0, 0))
        c.fill_ellipse(100, 400, 500, 700, (120, 80, 40, 150))
        save_img(c, img("battlebacks2", "bench_bg2.png"))
    pw, ph = S(2400), S(1600)
    if HAVE_PIL:
        base = gradient_fill(pw, ph, hue_color(0.62, 0.7, 0.25), hue_color(0.72, 0.4, 0.8))
        n = block_noise(pw, ph, 16, 18)
        base = Image.blend(base, Image.merge("RGBA", (n, n, n, Image.new("L", (pw, ph), 255))), 0.1)
        d = ImageDraw.Draw(base)
        rr = random.Random(7)
        for _ in range(60):
            x, y, r = rr.randrange(pw), rr.randrange(ph), rr.randrange(30, 200)
            d.ellipse([x - r, y - r, x + r, y + r], outline=hue_color(rr.random(), 0.4, 0.95, 200), width=6)
        draw_label(base, "PARALLAX %dx%d" % (pw, ph), pw / 2, ph / 2, ph / 8)
        save_img(base, img("parallaxes", "bench_parallax.png"))
    else:
        c = Canvas(pw, ph, (0, 0, 0, 255))
        c.fill_rect(0, 0, pw, ph, hue_color(0.62, 0.7, 0.25), hue_color(0.72, 0.4, 0.8))
        save_img(c, img("parallaxes", "bench_parallax.png"))
    # fx pictures for the quick fade in/out test
    for k in range(8):
        gen_gradient_card(img("pictures", "bench_fx%d.png" % (k + 1)), S(480), S(480), k / 8.0,
                          "FX %d" % (k + 1), circle=True)
    # 40 stand-up layer pictures, 1920x1080 mostly transparent
    W, H = S(1920), S(1080)
    k = W / 1920.0
    slot = 0
    for c in range(3):
        for l in range(4):
            for v in range(g.slot_counts[slot]):
                path = img("pictures", "stand_c%d_l%d_v%d.png" % (c, l, v))
                cx = (320 + c * 640) * k
                hue = (c * 0.31 + l * 0.07 + v * 0.11) % 1.0
                if HAVE_PIL:
                    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
                    shapes = {0: ("rr", [cx - 170 * k, 380 * k, cx + 170 * k, 1080 * k]),
                              1: ("rr", [cx - 190 * k, 520 * k, cx + 190 * k, 900 * k]),
                              2: ("el", [cx - 120 * k, 120 * k, cx + 120 * k, 400 * k]),
                              3: ("el", [cx - 60 * k, 20 * k, cx + 60 * k, 110 * k])}
                    kind, box = shapes[l]
                    x0, y0, x1, y1 = [int(b) for b in box]
                    mask = Image.new("L", (x1 - x0, y1 - y0), 0)
                    md = ImageDraw.Draw(mask)
                    if kind == "rr":
                        md.rounded_rectangle([0, 0, x1 - x0 - 1, y1 - y0 - 1], int(50 * k), fill=235)
                    else:
                        md.ellipse([0, 0, x1 - x0 - 1, y1 - y0 - 1], fill=235)
                    fill = gradient_fill(x1 - x0, y1 - y0, hue_color(hue, 0.7, 0.45), hue_color(hue + 0.1, 0.5, 0.95))
                    canvas.paste(fill, (x0, y0), mask)
                    draw_label(canvas, "C%d L%d V%d" % (c, l, v), (x0 + x1) / 2, (y0 + y1) / 2, 44 * k)
                    save_img(canvas, path)
                else:
                    cv = Canvas(W, H, (0, 0, 0, 0))
                    boxes = {0: (cx - 170 * k, 380 * k, cx + 170 * k, 1080 * k),
                             1: (cx - 190 * k, 520 * k, cx + 190 * k, 900 * k),
                             2: (cx - 120 * k, 120 * k, cx + 120 * k, 400 * k),
                             3: (cx - 60 * k, 20 * k, cx + 60 * k, 110 * k)}
                    (cv.fill_ellipse if l >= 2 else cv.fill_rect)(
                        *boxes[l], hue_color(hue, 0.7, 0.45, 235), hue_color(hue + 0.1, 0.5, 0.95, 235))
                    save_img(cv, path)
            slot += 1


# ---------------------------------------------------------------------------
# build one game
# ---------------------------------------------------------------------------

PLUGINS_HEADER = "// Generated by pocketmz-benchgen.\n// Do not edit this file directly.\nvar $plugins =\n[\n"


def build_game(mz, core, out_dir, scale):
    name = "PocketMZ Bench " + ("MZ" if mz else "MV")
    game_dir = os.path.join(out_dir, name)
    if os.path.isdir(game_dir):
        shutil.rmtree(game_dir)
    root = game_dir if mz else os.path.join(game_dir, "www")
    os.makedirs(root, exist_ok=True)
    (copy_core_mz if mz else copy_core_mv)(core, root)
    have_se = make_se(root)
    g = Gen(mz, root, scale, have_se)
    make_system_images(root)
    make_icon(root)
    gen_images(g)
    # data
    db = g.database()
    for fname, key in (("Actors", "Actors"), ("Classes", "Classes"), ("Skills", "Skills"),
                       ("Items", "Items"), ("Weapons", "Weapons"), ("Armors", "Armors"),
                       ("States", "States"), ("Enemies", "Enemies"), ("Troops", "Troops"),
                       ("Animations", "Animations"), ("Tilesets", "Tilesets"),
                       ("CommonEvents", "CommonEvents")):
        write_json(os.path.join(root, "data", fname + ".json"), db[key])
    write_json(os.path.join(root, "data", "System.json"), g.system())
    infos = [None]
    for mid in range(1, 5):
        m, nm = g.map_data(mid)
        write_json(os.path.join(root, "data", "Map%03d.json" % mid), m)
        infos.append({"id": mid, "expanded": False, "name": nm, "order": mid, "parentId": 0,
                      "scrollX": 0, "scrollY": 0})
    write_json(os.path.join(root, "data", "MapInfos.json"), infos)
    # plugins
    write_text(os.path.join(root, "js", "plugins", "PocketMZ_BenchBoot.js"), PLUGIN_BOOT)
    entries = []
    if not mz:
        write_text(os.path.join(root, "js", "plugins", "PocketMZ_BenchScreen.js"), PLUGIN_SCREEN_MV)
        entries.append({"name": "PocketMZ_BenchScreen", "status": True, "description": "1920x1080 screen",
                        "parameters": {}})
    entries.append({"name": "PocketMZ_BenchBoot", "status": True,
                    "description": "skip title, select run mode", "parameters": {"mode": "text"}})
    write_text(os.path.join(root, "js", "plugins.js"),
               PLUGINS_HEADER + ",\n".join(json.dumps(e) for e in entries) + "\n];\n")
    # package.json
    if mz:
        pkg = {"name": "pocketmz-bench-mz", "main": "index.html",
               "chromium-args": "--force-color-profile=srgb --disable-devtools",
               "window": {"title": name, "width": 960, "height": 540, "position": "center",
                          "icon": "icon/icon.png"}}
    else:
        pkg = {"name": "pocketmz-bench-mv", "main": "www/index.html", "js-flags": "--expose-gc",
               "window": {"title": name, "toolbar": False, "width": 960, "height": 540,
                          "icon": "www/icon/icon.png"}}
    write_json(os.path.join(game_dir, "package.json"), pkg)
    return game_dir, root, have_se, ((os.path.join(core, 'data')) if mz else os.path.join(
        core if os.path.isdir(os.path.join(core, 'js')) else os.path.join(core, 'www'), 'data'))


# ---------------------------------------------------------------------------
# validation
# ---------------------------------------------------------------------------

BLOCK_OPEN = {111: 412, 112: 413, 301: 604, 102: 404}


def _keyset(o, p=""):
    out = set()
    if isinstance(o, dict):
        for k, v in o.items():
            out.add(p + "/" + k)
            out |= _keyset(v, p + "/" + k)
    elif isinstance(o, list):
        for x in [x for x in o if isinstance(x, (dict, list))][:1]:
            out |= _keyset(x, p + "[]")
    return out


def check_keys(root, src_data, mz):
    """Every key (recursive) of the source game's data files must exist in ours."""
    errs = []
    skip = ("/list[]", "parameters", "/learnings[]", "/traits[]", "/effects[]", "/dropItems[]")
    files = ["System", "Actors", "Classes", "Skills", "Items", "Weapons", "Armors", "States",
             "Enemies", "Troops", "Tilesets", "CommonEvents", "MapInfos"]
    pairs = [(f, f) for f in files] + [("Map003" if mz else "Map001", "Map001")]
    for sf, df in pairs:
        sp = os.path.join(src_data, sf + ".json")
        if not os.path.isfile(sp):
            continue
        a = _keyset(json.load(open(sp, encoding="utf-8")))
        b = _keyset(json.load(open(os.path.join(root, "data", df + ".json"), encoding="utf-8")))
        miss = sorted(k for k in a - b if not any(t in k for t in skip))
        if miss:
            errs.append("%s.json missing keys vs source: %s" % (df, miss[:12]))
    return errs


def validate(game_dir, root, mz, scale, src_data=None):
    errs = []
    if src_data:
        errs += check_keys(root, src_data, mz)
    nfiles = 0
    jsons = {}
    for dp, _, fs in os.walk(root):
        for f in fs:
            if f.endswith(".json"):
                try:
                    jsons[f] = json.load(open(os.path.join(dp, f), encoding="utf-8"))
                    nfiles += 1
                except Exception as e:
                    errs.append("bad JSON %s: %s" % (f, e))
    try:
        json.load(open(os.path.join(game_dir, "package.json"), encoding="utf-8"))
    except Exception as e:
        errs.append("bad package.json: %s" % e)
    # plugins.js
    pj = open(os.path.join(root, "js", "plugins.js"), encoding="utf-8").read()
    m = re.search(r"\$plugins\s*=\s*(\[.*\]);", pj, re.S)
    try:
        plugins = json.loads(m.group(1))
        for p in plugins:
            if not os.path.isfile(os.path.join(root, "js", "plugins", p["name"] + ".js")):
                errs.append("plugin file missing: " + p["name"])
    except Exception as e:
        errs.append("plugins.js parse: %s" % e)

    def img_ok(sub, name, expect=None):
        if not name:
            return
        path = os.path.normcase(os.path.abspath(os.path.join(root, "img", sub, name + ".png")))
        if not os.path.isfile(path):
            errs.append("missing image img/%s/%s.png" % (sub, name))
            return
        size = DIMS.get(path)
        if size is None:
            with open(path, "rb") as fh:
                size = struct.unpack(">II", fh.read(24)[16:24])
        if expect and tuple(size) != tuple(expect):
            errs.append("size mismatch img/%s/%s.png %s != %s" % (sub, name, size, expect))

    ces = jsons["CommonEvents.json"]
    maps = {i: jsons["Map%03d.json" % i] for i in range(1, 5)}
    troops = jsons["Troops.json"]
    ncmd = 0
    lists = []
    for ce in ces:
        if ce:
            lists.append(("CE%d" % ce["id"], ce["list"]))
    for mid, md in maps.items():
        if len(md["data"]) != md["width"] * md["height"] * 6:
            errs.append("map %d data size" % mid)
        for ev in md["events"]:
            if ev:
                for pi, pg in enumerate(ev["pages"]):
                    lists.append(("Map%d/EV%d/p%d" % (mid, ev["id"], pi), pg["list"]))
                    ci = pg["image"]["characterName"]
                    if ci:
                        img_ok("characters", ci)
                if not (0 <= ev["x"] < md["width"] and 0 <= ev["y"] < md["height"]):
                    errs.append("event out of map %d/%d" % (mid, ev["id"]))
        if md["parallaxName"]:
            img_ok("parallaxes", md["parallaxName"], (max(16, int(round(2400 * scale))), max(16, int(round(1600 * scale)))))
        img_ok("battlebacks1", md["battleback1Name"])
        img_ok("battlebacks2", md["battleback2Name"])
    for t in troops:
        if t:
            for pg in t["pages"]:
                lists.append(("Troop%d" % t["id"], pg["list"]))
    S = lambda n: max(16, int(round(n * scale)))
    codes_seen = {}
    for label, lst in lists:
        if not lst or lst[-1]["code"] != 0:
            errs.append("%s: list does not end with code 0" % label)
        stack = []
        prev_indent = 0
        for c in lst:
            ncmd += 1
            codes_seen[c["code"]] = codes_seen.get(c["code"], 0) + 1
            if c["indent"] < 0 or c["indent"] > prev_indent + 1:
                errs.append("%s: bad indent jump at code %d" % (label, c["code"]))
            prev_indent = c["indent"]
            p, code = c["parameters"], c["code"]
            if code == 231:
                img_ok("pictures", p[1], (S(1920), S(1080)) if p[1].startswith("stand_") else (S(480), S(480)))
                if len(p) != 10:
                    errs.append("%s: 231 param count %d" % (label, len(p)))
            elif code == 232 and len(p) != (13 if mz else 12):
                errs.append("%s: 232 param count %d" % (label, len(p)))
            elif code == 101:
                if len(p) != (5 if mz else 4):
                    errs.append("%s: 101 param count %d" % (label, len(p)))
                img_ok("faces", p[0], (576, 288))
            elif code == 117 and not (0 < p[0] < len(ces) and ces[p[0]]):
                errs.append("%s: missing common event %d" % (label, p[0]))
            elif code == 201:
                if p[1] not in maps:
                    errs.append("%s: transfer to missing map %d" % (label, p[1]))
                else:
                    mm = maps[p[1]]
                    if not (0 <= p[2] < mm["width"] and 0 <= p[3] < mm["height"]):
                        errs.append("%s: transfer out of bounds" % label)
            elif code == 301 and p[0] == 0 and not troops[p[1]]:
                errs.append("%s: missing troop" % label)
            elif code == 301 and p[0] == 1 and not (1 <= p[1] < 100):
                errs.append("%s: bad troop variable" % label)
            if code in BLOCK_OPEN:
                stack.append((BLOCK_OPEN[code], c["indent"]))
            elif stack and code == stack[-1][0] and c["indent"] == stack[-1][1]:
                stack.pop()
        if stack:
            errs.append("%s: unclosed block %s" % (label, stack))
    # database images
    for a in jsons["Actors.json"]:
        if a:
            img_ok("faces", a["faceName"], (576, 288))
            img_ok("characters", a["characterName"].lstrip("$"), None) if False else \
                img_ok("characters", a["characterName"], (144, 192))
    for e in jsons["Enemies.json"]:
        if e:
            img_ok("enemies", e["battlerName"], (S(800), S(800)))
    ts = jsons["Tilesets.json"][1]
    sizes = {"A1": (768, 576), "A2": (768, 576), "A3": (768, 384), "A4": (768, 720),
             "A5": (384, 768), "B": (768, 768), "C": (768, 768), "D": (768, 768), "E": (768, 768)}
    for nm, k in zip(ts["tilesetNames"], sizes):
        img_ok("tilesets", nm, sizes[k])
    if len(ts["flags"]) != 8192:
        errs.append("tileset flags length")
    sysd = jsons["System.json"]
    for k in ("startMapId", "startX", "startY", "partyMembers", "windowTone", "terms", "sounds",
              "versionId", "switches", "variables", "gameTitle", "weaponTypes"):
        if k not in sysd:
            errs.append("System.json missing " + k)
    if len(sysd["sounds"]) != 24:
        errs.append("System.json sounds != 24")
    if sysd["startMapId"] not in maps:
        errs.append("startMapId invalid")
    if mz:
        for k in ("advanced", "tileSize", "faceSize", "iconSize"):
            if k not in sysd:
                errs.append("System.json (MZ) missing " + k)
    for nm in SYSTEM_SIZES:
        img_ok("system", nm, SYSTEM_SIZES[nm] if nm not in ("Window", "Loading") else None)
    # no save folders copied
    for dp, ds, _ in os.walk(game_dir):
        for d in ds:
            if d.lower() == "save":
                errs.append("save folder present: " + os.path.join(dp, d))
    return errs, ncmd, nfiles, codes_seen


def dir_size(path):
    total = 0
    for dp, _, fs in os.walk(path):
        for f in fs:
            total += os.path.getsize(os.path.join(dp, f))
    return total


def fmt(n):
    return "%.1f MB" % (n / 1048576.0) if n >= 1048576 else "%.0f KB" % (n / 1024.0)


def main():
    ap = argparse.ArgumentParser(description="Generate PocketMZ synthetic benchmark games (MZ + MV).")
    ap.add_argument("--mz-core", required=True)
    ap.add_argument("--mv-core", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--scale", type=float, default=1.0)
    a = ap.parse_args()
    if not HAVE_PIL:
        print("note: Pillow not found; using the plain stdlib PNG encoder (shapes only, no labels)")
    os.makedirs(a.out, exist_ok=True)
    bad = False
    for mz, core in ((True, a.mz_core), (False, a.mv_core)):
        game_dir, root, se, src_data = build_game(mz, core, a.out, a.scale)
        errs, ncmd, njson, codes = validate(game_dir, root, mz, a.scale, src_data)
        print("== %s  (%s)" % (os.path.basename(game_dir), game_dir))
        print("   total %s | img %s | data %s | js %s | audio %s" % (
            fmt(dir_size(game_dir)), fmt(dir_size(os.path.join(root, "img"))),
            fmt(dir_size(os.path.join(root, "data"))), fmt(dir_size(os.path.join(root, "js"))),
            "ogg SE on" if se else "off (no ffmpeg)"))
        pics = os.path.join(root, "img", "pictures")
        print("   pictures: %d files, %s | %d json files, %d event commands | validation: %s" % (
            len(os.listdir(pics)), fmt(dir_size(pics)), njson, ncmd,
            "OK" if not errs else "%d PROBLEMS" % len(errs)))
        for e in errs[:20]:
            print("   !! " + e)
        bad |= bool(errs)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
