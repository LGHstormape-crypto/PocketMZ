#!/bin/sh
# End-to-end test inside the real RPG Maker MZ engine on the read-only beta-runtime.sqfs (rt):
# exercises real MZ Video.play('/tmp/pmz-e2e/clip.mp4') and WebAudio('/tmp/pmz-e2e/tone.m4a') via PocketMZ_Debug REPL.
set -e
B=/storage/pocketmz/beta
D=/tmp/pmz-e2e
LOG=/tmp/pmz-e2e.log
mkdir -p "$D"
trap 'pkill -f pmzrun.js 2>/dev/null || true; kill $GPID 2>/dev/null; wait $GPID 2>/dev/null; rm -rf "$D" /tmp/pmz-e2e.log' EXIT

# Generate small test media using ffmpeg in root24
POCKETMZ_ROOT=$($B/beta-mount.sh root24) /storage/pocketmz/pocketmz-chroot.sh run ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'sine=frequency=440:duration=1.5:sample_rate=44100' -c:a aac -b:a 96k "$D/tone.m4a"
POCKETMZ_ROOT=$($B/beta-mount.sh root24) /storage/pocketmz/pocketmz-chroot.sh run ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'smptebars=size=640x360:rate=30:duration=2.0' \
  -f lavfi -i 'sine=frequency=440:duration=2.0:sample_rate=44100' \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 96k -shortest "$D/clip.mp4"

# Launch an MZ game (default: Bench MZ) on the read-only release image (rt) with Debug REPL + GLDEBUG
PMZ_ROOTDIR=rt PMZ_GAME_ID="${PMZ_GAME_ID:-PocketMZ_Bench_MZ-0fda2ad2}" \
  PMZ_PATCHES=Handheld,HandheldMV,PluginFixes,Menu,Debug \
  PMZ_GLDEBUG=1 PMZ_VOLUME=0.0 MODE=play POCKETMZ_HOTKEYS=0 \
  sh $B/run-pmzrun.sh >"$LOG" 2>&1 &
GPID=$!

repl() { curl -sf --max-time 3 --data-binary "$1" http://127.0.0.1:9333; }

# Wait for Scene_Title
i=0
while [ $i -lt 60 ]; do
  sc=$(repl 'SceneManager._scene && SceneManager._scene.constructor.name' 2>/dev/null || true)
  case "$sc" in *Scene_Title*) break ;; esac
  sleep 0.5; i=$((i + 1))
done
echo "scene: $sc"
case "$sc" in *Scene_Title*) ;; *) echo "FAIL boot"; tail -n 30 "$LOG"; exit 1 ;; esac

# 1. Real MZ WebAudio with .m4a
repl "window._ta = new WebAudio('$D/tone.m4a'); window._ta.play(false); 'ok'" >/dev/null
sleep 1
au=$(repl '({ready: _ta.isReady(), playing: _ta.isPlaying(), err: _ta.isError()})')
echo "m4a: $au"
repl '_ta.stop(); "ok"' >/dev/null

# 2. Real MZ Video.play with .mp4
repl "Video.play('$D/clip.mp4'); 'ok'" >/dev/null
played=0; ended=0
i=0
while [ $i -lt 50 ]; do
  vs=$(repl '({playing: Video.isPlaying(), op: Video._element.style.opacity, rs: Video._element.readyState, t: +Video._element.currentTime.toFixed(2), w: Video._element.videoWidth, h: Video._element.videoHeight})' | tr -d ' \n')
  case "$vs" in *'"playing":true'*) played=1; echo "video playing: $vs"; break ;; esac
  sleep 0.1; i=$((i + 1))
done
[ "$played" = 0 ] && echo "video last(play): $vs"
i=0
while [ $i -lt 60 ]; do
  vs=$(repl '({playing: Video.isPlaying(), op: Video._element.style.opacity, ended: Video._element.ended, t: +Video._element.currentTime.toFixed(2)})' | tr -d ' \n')
  case "$vs" in *'"playing":false'*) ended=1; echo "video ended: $vs"; break ;; esac
  sleep 0.15; i=$((i + 1))
done
[ "$ended" = 0 ] && echo "video last(end): $vs"

errs=$(repl 'PMZ_DEBUG.errors' | tr -d ' \n')
echo "debug errors: $errs"
pkill -f pmzrun.js 2>/dev/null || true
kill $GPID 2>/dev/null; wait $GPID 2>/dev/null || true
echo "log video/gl lines:"
grep -E 'VIDEO |GL error|COMPAT |UNCAUGHT|ERROR' "$LOG" | head -n 20 || true

au_c=$(printf '%s' "$au" | tr -d ' \n')
FAIL=0
case "$au_c" in *'"ready":true'*'"playing":true'*'"err":false'*) echo "PASS MZ WebAudio .m4a" ;; *) echo "FAIL MZ WebAudio .m4a"; FAIL=1 ;; esac
[ "$played" = 1 ] && [ "$ended" = 1 ] && echo "PASS MZ Video.play .mp4" || { echo "FAIL MZ Video.play (played=$played ended=$ended)"; FAIL=1; }
grep -q 'GL error' "$LOG" && { echo "FAIL GL errors found"; FAIL=1; } || echo "PASS 0 GL errors"
exit $FAIL
