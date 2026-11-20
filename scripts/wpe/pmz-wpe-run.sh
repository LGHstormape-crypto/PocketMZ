#!/bin/sh
# PocketMZ WPE prototype: run a game folder in cog (WPE WebKit) from the overlay chroot and log
# probe output + memory. Usage: pmz-wpe-run.sh <game dir> [seconds=120] [out dir]
# Needs: /storage/pocketmz/wpe/root (overlay rootfs with cog). Memory: PSS of cog + WebKit* procs.
G="$1"; SECS="${2:-120}"; OUT="${3:-/storage/pocketmz/wpe/runs/$(date +%Y%m%d-%H%M%S)}"
W=/storage/pocketmz/wpe; HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$G/index.html" ] || { echo "no index.html in $G" >&2; exit 2; }
mkdir -p "$OUT"
# canonical /run path: the WebKit sandbox binds it and then fails to make the /var/run symlink
export XDG_RUNTIME_DIR=/run/0-runtime-dir WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}"
export SWAYSOCK="${SWAYSOCK:-$XDG_RUNTIME_DIR/sway-ipc.0.sock}"
grep -q " $W/root " /proc/mounts || mount -t overlay overlay \
  -o lowerdir=/storage/pocketmz/rootfs,upperdir=$W/upper,workdir=$W/work $W/root || exit 1
PORT=8765
# test runs only: drop the WebKit HTTP cache (it kept an old plugins.js)
rm -rf /storage/pocketmz/home/.cache/wpe
python3 "$HERE/pmz-wpe-serve.py" "$G" $PORT > "$OUT/probe.log" 2>&1 &
SRV=$!
sleep 1
swaymsg 'for_window [app_id="com.igalia.Cog"] fullscreen enable' >/dev/null 2>&1
# own mount namespace with private propagation: WebKit's bubblewrap sandbox needs pivot_root,
# which fails (EINVAL) while the chroot's parent mount is shared
POCKETMZ_ROOT=$W/root unshare -m sh -c 'mount --make-rprivate / && exec "$@"' sh /storage/pocketmz/pocketmz-chroot.sh run \
  env COG_PLATFORM_WL_VIEW_FULLSCREEN=1 ${PMZ_WPE_ENV} \
  cog -P wl ${PMZ_WPE_ARGS} "http://127.0.0.1:$PORT/index.html" > "$OUT/cog.log" 2>&1 &
( for i in $(seq 1 30); do sleep 1; swaymsg '[app_id="com.igalia.Cog"] fullscreen enable, focus' >/dev/null 2>&1 && break; done ) &
echo "time,pss_mb,swap_mb,avail_mb,procs" > "$OUT/mem.csv"
end=$(( $(date +%s) + SECS ))
while [ "$(date +%s)" -lt $end ]; do
  sleep 2
  # started outside ES: end ES's black screensaver / gkd-idle power saving (cores 1-3 offline)
  if grep -q '^4$' /sys/class/backlight/*/bl_power 2>/dev/null || [ -f /run/gkd-idle.state ]; then
    for s in /var/run/emulationstation/scripts/screensaver-stop/*; do [ -x "$s" ] && "$s"; done 2>/dev/null
    echo "$(date +%s)000 awake: screensaver / idle power saving ended" >> "$OUT/probe.log"
  fi
  P=$(ps -eo pid,comm | awk '$2 ~ /^(cog|WPE|WebKit)/ {print $1}')
  pss=0; sw=0; n=0
  for p in $P; do
    v=$(awk '/^Pss:/ {a=$2} /^Swap:/ {b=$2} END {print a+0, b+0}' /proc/$p/smaps_rollup 2>/dev/null) || continue
    set -- $v; pss=$((pss + $1)); sw=$((sw + $2)); n=$((n + 1))
  done
  av=$(awk '/^MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  echo "$(date +%T),$((pss >> 10)),$((sw >> 10)),$av,$n" >> "$OUT/mem.csv"
  # guard: same limits as the autotest
  [ "$av" -lt 140 ] && { echo "LOWMEM avail=$av" >> "$OUT/probe.log"; break; }
done
pkill -TERM -x cog 2>/dev/null; sleep 2; pkill -KILL -x cog 2>/dev/null
pkill -KILL -f WPEWebProcess 2>/dev/null; pkill -KILL -f WPENetworkProcess 2>/dev/null
kill $SRV 2>/dev/null
echo "out: $OUT"
