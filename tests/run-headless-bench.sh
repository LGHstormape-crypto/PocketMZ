#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Headless software-GL (llvmpipe) regression gate for PocketMZ β runtime on PocketMZ Bench MZ/MV.
# Usage:
#   tests/run-headless-bench.sh [--mz <dir>] [--mv <dir>]
# Env overrides: PMZ_BENCH_MZ, PMZ_BENCH_MV, PMZ_RT_NODE (prebuilt pmzrt.node), AT_SEED (default 42)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
MZ_DIR="${PMZ_BENCH_MZ:-}"
MV_DIR="${PMZ_BENCH_MV:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --mz) MZ_DIR="$2"; shift 2 ;;
    --mv) MV_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -n "$MZ_DIR" ] && [ -f "$MZ_DIR/index.html" ] || { echo "ERROR: valid --mz / PMZ_BENCH_MZ directory required" >&2; exit 2; }

WORK="$(mktemp -d /tmp/pmz-headless-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

RT_DIR="$WORK/pmzrt"
mkdir -p "$RT_DIR" "$WORK/shots"
cp -f "$REPO"/beta/pmzrt/*.js "$RT_DIR/"

if [ -n "${PMZ_RT_NODE:-}" ] && [ -f "$PMZ_RT_NODE" ]; then
  cp -f "$PMZ_RT_NODE" "$RT_DIR/pmzrt.node"
else
  echo "=== Building host pmzrt.node ==="
  FF_PC=""
  [ -d /opt/beta/ffmpeg/lib/pkgconfig ] && FF_PC="PKG_CONFIG_PATH=/opt/beta/ffmpeg/lib/pkgconfig"
  FF_FLAGS="$(eval "$FF_PC pkg-config --cflags --libs libavformat libavcodec libswresample libswscale libavutil")"
  gcc -O2 -Wall -Wno-unused-function -Wno-unused-variable -shared -fPIC \
    -I/usr/include/node "$REPO/beta/pmzrt/pmzrt.c" \
    $(pkg-config --cflags glesv2) \
    $(pkg-config --cflags --libs sdl2 libpng libjpeg libwebp cairo pangocairo fontconfig freetype2 vorbisfile) \
    $FF_FLAGS -lm -o "$RT_DIR/pmzrt.node"
fi

SEED="${AT_SEED:-42}"
NODE_BIN="$(command -v node)"

echo "=== Verifying native decodeGif + GC on pmzrt.node ==="
"$NODE_BIN" --expose-gc -e '
  const assert = require("assert");
  const pmz = require(process.argv[1]);
  // Minimal 2x2 2-frame GIF89a: frame 0 = red (delay 50ms), frame 1 = green (delay 80ms)
  const gif = Buffer.from([
    0x47,0x49,0x46,0x38,0x39,0x61, 0x02,0x00, 0x02,0x00, 0x91,0x00,0x00,
    0xff,0x00,0x00, 0x00,0xff,0x00, 0x00,0x00,0xff, 0x00,0x00,0x00,
    0x21,0xf9,0x04,0x04, 0x05,0x00, 0x00,0x00,
    0x2c, 0x00,0x00,0x00,0x00, 0x02,0x00,0x02,0x00, 0x00,
    0x02, 0x03, 0x04,0x00,0x05, 0x00,
    0x21,0xf9,0x04,0x04, 0x08,0x00, 0x00,0x00,
    0x2c, 0x00,0x00,0x00,0x00, 0x02,0x00,0x02,0x00, 0x00,
    0x02, 0x03, 0x4c,0x12,0x05, 0x00,
    0x3b
  ]);
  const res = pmz.decodeGif(gif);
  assert.strictEqual(res.width, 2);
  assert.strictEqual(res.height, 2);
  assert.strictEqual(res.frames.length, 2);
  assert.strictEqual(res.frames[0].delayMs, 50);
  assert.strictEqual(res.frames[1].delayMs, 80);
  assert.deepStrictEqual(Array.from(res.frames[0].data.slice(0, 4)), [255, 0, 0, 255]);
  assert.deepStrictEqual(Array.from(res.frames[1].data.slice(0, 4)), [0, 255, 0, 255]);
  global.gc();
  console.log("[pmzrt] decodeGif 2-frame OK");
' "$RT_DIR/pmzrt.node"

echo "=== Verifying GLES2 postproc shaders on llvmpipe ==="
SH_CMD=(
  env LIBGL_ALWAYS_SOFTWARE=1 SDL_VIDEODRIVER=x11 SDL_AUDIODRIVER=dummy
  "$NODE_BIN" -e '
    const assert = require("assert");
    const pmz = require(process.argv[1]);
    const postproc = require(process.argv[2]);
    const webgl = require(process.argv[3]);
    const glInfo = pmz.init({ width: 640, height: 480, fullscreen: false, vsync: false, title: "sh-test" });
    const gl = new webgl.WebGLRenderingContext({ width: 640, height: 480 }, {}, {
      pmz, drawableWidth: glInfo.drawableWidth, drawableHeight: glInfo.drawableHeight,
      es3: glInfo.es3, hasVao: glInfo.hasVao, hasInstancing: glInfo.hasInstancing,
    });
    const pp = postproc.create({ pmz, getGL: () => gl, getDrawable: () => glInfo, onLog: m => { throw new Error(m); } });
    for (const m of ["sharp", "lcd", "crt", "cas"]) {
      pp.setMode(m);
      assert.strictEqual(pp.beginFrame(), true, m + " beginFrame");
      assert.strictEqual(pp.present(), true, m + " present");
    }
    pp.setMode("off");
    assert.strictEqual(gl._defaultFboId, 0);
    pmz.shutdown();
    console.log("[postproc] GLES2 4 modes compile/link/present OK");
  ' "$RT_DIR/pmzrt.node" "$RT_DIR/postproc.js" "$RT_DIR/webgl.js"
)
if command -v xvfb-run >/dev/null 2>&1; then
  xvfb-run -a -s "-screen 0 640x480x24" "${SH_CMD[@]}"
else
  "${SH_CMD[@]}"
fi
XVFB=""
if command -v xvfb-run >/dev/null 2>&1; then
  XVFB="xvfb-run -a -s \"-screen 0 640x480x24\""
fi

run_one() {
  local label="$1"
  local game_dir="$2"
  local out_log="$WORK/${label}.log"
  local vfs_game="$WORK/vfs-game-${label}"
  mkdir -p "$vfs_game"
  echo "=== Running headless bench (pure VFS): $label (seed=$SEED) ==="
  local cmd=(
    env
    LIBGL_ALWAYS_SOFTWARE=1
    SDL_VIDEODRIVER=x11
    SDL_AUDIODRIVER=dummy
    PMZ_AUDIO=off
    PMZ_BETA_DIR="$REPO/beta"
    PMZ_RT_DIR="$RT_DIR"
    PMZ_PATCHES_DIR="$REPO/patches"
    PMZ_GAMESRC="$game_dir"
    MODE=test
    GAME="$vfs_game"
    PMZ_PATCHES=Handheld,HandheldMV,PluginFixes,Menu
    PMZ_ORPHAN=1
    AT_SEED="$SEED"
    TELEPORT=0
    HOLD=2 MAPADV=0 MAPHOLD=3000 MAXSEC=45
    OUT="$WORK/${label}-result.txt"
    SHOT="$WORK/shots/${label}-title.png"
    SHOT2="$WORK/shots/${label}-opt.png"
    SHOT3="$WORK/shots/${label}-map.png"
    "$NODE_BIN" --max-old-space-size=256 --expose-gc "$REPO/beta/pmzrun.js"
  )
  if [ -n "$XVFB" ]; then
    xvfb-run -a -s "-screen 0 640x480x24" "${cmd[@]}" > "$out_log" 2>&1 || { cat "$out_log"; return 1; }
  else
    "${cmd[@]}" > "$out_log" 2>&1 || { cat "$out_log"; return 1; }
  fi
  local summary
  summary="$(grep '^CI_SUMMARY ' "$out_log" | tail -n1 | sed 's/^CI_SUMMARY //' || true)"
  if [ -z "$summary" ]; then
    echo "ERROR: missing CI_SUMMARY in $label" >&2
    tail -n 40 "$out_log"
    return 1
  fi
  echo "[$label] $summary"
  "$NODE_BIN" -e '
    const s = JSON.parse(process.argv[1]);
    const label = process.argv[2];
    const fail = m => { console.error("GATE FAIL [" + label + "]: " + m); process.exit(1); };
    if (s.exitCode !== 0) fail("exitCode=" + s.exitCode);
    if (s.plugins < 4) fail("expected >=4 VFS-injected plugins, got " + s.plugins);
    if (s.failed !== 0) fail("failed plugins=" + s.failed);
    if (s.glStubs !== 0) fail("glStubs=" + s.glStubs);
    if (s.glErrors !== 0) fail("glErrors=" + s.glErrors);
    if (s.otherErrors !== 0) fail("otherErrors=" + s.otherErrors);
    if (s.mapId !== 1) fail("mapId=" + s.mapId);
    if (s.scene !== "Scene_Map") fail("scene=" + s.scene);
    if (s.externalMB >= 120) fail("externalMB=" + s.externalMB);
    if (s.csCacheMB > 24) fail("csCacheMB=" + s.csCacheMB);
    require("fs").writeFileSync(process.argv[3], String(s.traceHash || ""));
  ' "$summary" "$label" "$WORK/${label}.hash"
}

run_one "mz-1" "$MZ_DIR"
run_one "mz-2" "$MZ_DIR"
H1="$(cat "$WORK/mz-1.hash")"
H2="$(cat "$WORK/mz-2.hash")"
if [ "$H1" != "$H2" ]; then
  echo "ERROR: non-deterministic traceHash on MZ seed=$SEED ($H1 != $H2)" >&2
  exit 1
fi
echo "=== Deterministic traceHash verified: $H1 ==="

if [ -n "$MV_DIR" ]; then
  MV_WEB="$MV_DIR"
  [ -d "$MV_DIR/www" ] && MV_WEB="$MV_DIR/www"
  [ -f "$MV_WEB/index.html" ] || { echo "ERROR: invalid --mv directory $MV_DIR" >&2; exit 2; }
  run_one "mv-1" "$MV_WEB"
fi

echo "=== Headless bench regression gate PASSED ==="
