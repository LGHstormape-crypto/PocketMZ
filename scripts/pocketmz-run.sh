#!/bin/bash
# Run an RPG Maker MV/MZ game (NW.js arm64 in the Debian chroot) on ROCKNIX / sway.
# Usage: pocketmz-run.sh <original game dir> [id]
# The game dir holds index.html (MZ) or package.json + www/index.html (MV). Without an id one is
# derived from the path (DLsite code RJ/VJ######, else folder name + hash), the same way as
# pocketmz-scan.sh, so saves in /storage/pocketmz/games/<id>/ stay with the game.
# The original folder is never written: a thin copy lives in /storage/pocketmz/games/<id>/game
# (saves in .../game/save, patches PocketMZ_*.js registered last in js/plugins.js).
#
# POCKETMZ_STOP_ES=0 (default): ES stays running behind the game; the kernel moves it into zram
# (~40-50 MB real), measured no difference in free memory or speed (notes/progress.md), and
# returning to ES is instant. POCKETMZ_STOP_ES=1: the game runs in its own systemd unit, ES is
# stopped while it runs and started again afterwards (~20 s back to the game list).
#
# Also: pocketmz-run.sh <launcher.rpgmz> - the ES system "RPGMZ" (run by PocketMZ) starts games through
# small launcher files (made by pocketmz-scan.sh) holding the lines dir=<game dir> and id=<id>.
# And: pocketmz-run.sh --menu - the PocketMZ game menu ($RZ/launcher, an NW.js page) instead of a
# game, with the same window / button / memory setup (used by pocketmz-menu.sh).
PMZ="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"   # program files (may be read-only)
RZ="${POCKETMZ_DATA:-/storage/pocketmz}"                 # data: games, saves, browser profiles
SRC="${1%/}"; ID="$2"
MENU=""
[ "$1" = --menu ] && { MENU=1; SRC="$PMZ/launcher"; ID=_menu; }
case "$SRC" in
  *.rpgmz)
    [ -f "$SRC" ] || { echo "no launcher $SRC" >&2; exit 1; }
    L="$SRC"
    SRC=$(sed -n 's/^dir=//p' "$L" | head -1); SRC="${SRC%/}"
    ID=$(sed -n 's/^id=//p' "$L" | head -1)
    [ -d "$SRC" ] || { echo "game folder not found: $SRC (launcher $L)" >&2; exit 1; } ;;
esac
[ -z "$L" ] && [ -n "$POCKETMZ_LAUNCHER" ] && L="$POCKETMZ_LAUNCHER"
[ -n "$L" ] && export POCKETMZ_LAUNCHER="$L"
[ -z "$ID" ] && ID=$("$PMZ/pocketmz-scan.sh" --id "$SRC")
WEB=""; [ ! -f "$SRC/index.html" ] && [ -f "$SRC/www/index.html" ] && WEB="www/"
LOG="$RZ/games/$ID/run.log"
. /etc/profile >/dev/null 2>&1
[ -f /etc/profile.d/099-freqfunctions ] && . /etc/profile.d/099-freqfunctions >/dev/null 2>&1
# per-game settings: games/<id>/env (shell variables, e.g. POCKETMZ_MEM_MAX=700, POCKETMZ_EXTRA_ARGS=...),
# games/<id>/pocketmz.gptk (button mapping instead of the default pocketmz.gptk)
# exported (set -a): pocketmz-chroot.sh passes every exported POCKETMZ_* variable into the game
[ -f "$RZ/games/$ID/env" ] && { set -a; . "$RZ/games/$ID/env"; set +a; }
# settings written with the old prefix (before the PocketMZ name) still count
for v in STOP_ES MEM_MAX MEM_HIGH SWAP_MAX SWAPPINESS EXTRA_ARGS JS_FLAGS RENDER_SCALE IMG_SCALE SUBSET_FONTS; do
  eval "[ -z \"\$POCKETMZ_$v\" ] && [ -n \"\$RPGMZ_$v\" ] && POCKETMZ_$v=\"\$RPGMZ_$v\""
done
# Query ES system.cfg ONLY at rpgmz["<game>.rpgmz"] / rpgmz levels so "auto" stays empty
es_setting() {
  local conf="${J_CONF:-/storage/.config/system/configs/system.cfg}"
  [ -r "$conf" ] || return 0
  GS_KEY="$1" GS_GAME="$(basename "${L:-}")" awk '
    BEGIN {
      k = ENVIRON["GS_KEY"]; g = ENVIRON["GS_GAME"]
      if (g != "") key[++n] = "rpgmz[\"" g "\"]." k
      key[++n] = "rpgmz." k
      for (i = 1; i <= n; i++) len[i] = length(key[i]) + 1
    }
    {
      for (i = 1; i <= n; i++)
        if (!(i in val) && substr($0, 1, len[i]) == key[i] "=")
          val[i] = substr($0, len[i] + 1)
    }
    END {
      for (i = 1; i <= n; i++)
        if (val[i] != "") { print val[i]; exit }
    }' "$conf"
}
# global defaults from the PocketMZ settings ($RZ/settings.json, written by pocketmz-settings.py);
# ES explicit settings win over in-game pocketmz.json and settings.json; ES "auto" leaves them to the game.
GSET="$RZ/settings.json"
gset() { [ -f "$GSET" ] && grep -o "\"$1\": *[^,}]*" "$GSET" | head -1 | sed 's/.*: *//; s/"//g; s/ //g'; }
if [ -z "$MENU" ]; then
  ES_STOP=$(es_setting stop_es)
  case "$ES_STOP" in
    true|1|on) POCKETMZ_STOP_ES=1; export POCKETMZ_ES_STOP_ES=1 ;;
    false|0|off) POCKETMZ_STOP_ES=0; export POCKETMZ_ES_STOP_ES=0 ;;
  esac
  ES_RS=$(es_setting render_scale)
  case "$ES_RS" in
    screen|auto) export POCKETMZ_RENDER_SCALE=auto POCKETMZ_ES_RENDER_SCALE=auto ;;
    off|native) export POCKETMZ_RENDER_SCALE=off POCKETMZ_ES_RENDER_SCALE=off ;;
  esac
  ES_SM=$(es_setting smooth)
  case "$ES_SM" in
    true|1|on) export POCKETMZ_SMOOTH=1 POCKETMZ_ES_SMOOTH=1 ;;
    false|0|off) export POCKETMZ_SMOOTH=0 POCKETMZ_ES_SMOOTH=0 ;;
  esac
  ES_FPS=$(es_setting fps_limit)
  case "$ES_FPS" in
    30|60) export POCKETMZ_DEFAULT_FPS="$ES_FPS" POCKETMZ_ES_FPS="$ES_FPS" ;;
  esac
  ES_SF=$(es_setting show_fps)
  case "$ES_SF" in
    true|1|on) export POCKETMZ_ES_SHOW_FPS=1 ;;
    false|0|off) export POCKETMZ_ES_SHOW_FPS=0 ;;
  esac
  ES_RT=$(es_setting runtime)
  case "$ES_RT" in
    autopick|auto) export POCKETMZ_GAME_RUNTIME=auto POCKETMZ_ES_RUNTIME=auto ;;
    beta|nw) export POCKETMZ_GAME_RUNTIME="$ES_RT" POCKETMZ_ES_RUNTIME="$ES_RT" ;;
  esac
  ES_AS=$(es_setting autosave)
  case "$ES_AS" in
    true|1|on) export POCKETMZ_ES_AUTOSAVE=1 ;;
    false|0|off) export POCKETMZ_ES_AUTOSAVE=0 ;;
  esac
fi
if [ -z "$POCKETMZ_STOP_ES" ] && [ -f "$RZ/games/$ID/game/pocketmz.json" ]; then
  case "$(grep -o '"stopES": *[a-z]*' "$RZ/games/$ID/game/pocketmz.json" | head -1 | sed 's/.*: *//')" in
    true) POCKETMZ_STOP_ES=1 ;; false) POCKETMZ_STOP_ES=0 ;;
  esac
fi
[ -z "$POCKETMZ_STOP_ES" ] && [ "$(gset stopES)" = true ] && POCKETMZ_STOP_ES=1
[ -z "$POCKETMZ_RENDER_SCALE" ] && [ "$(gset renderScale)" = off ] && POCKETMZ_RENDER_SCALE=off
[ -z "$POCKETMZ_DEFAULT_FPS" ] && export POCKETMZ_DEFAULT_FPS="$(gset defaultFps)"
GPTK_MAP="$PMZ/pocketmz.gptk"
for g in pocketmz.gptk rpgmz.gptk; do [ -f "$RZ/games/$ID/$g" ] && { GPTK_MAP="$RZ/games/$ID/$g"; break; }; done
[ -f "$RZ/stop-es" ] && POCKETMZ_STOP_ES=1   # dev hook: stop ES (A/B tests through the ES launch API)
[ -n "$MENU" ] && POCKETMZ_STOP_ES=0          # the menu loop waits for each run

# Smooth (bilinear filtering): ES explicit override > game pocketmz.json > PocketMZ settings.json
if [ -z "$MENU" ] && [ -z "$POCKETMZ_SMOOTH" ]; then
  SM=$(grep -o '"smooth": *[a-z]*' "$RZ/games/$ID/game/pocketmz.json" 2>/dev/null | head -1 | sed 's/.*: *//')
  [ -z "$SM" ] && SM=$(gset smooth)
  case "$SM" in
    true|1|on) export POCKETMZ_SMOOTH=1 ;;
    false|0|off) export POCKETMZ_SMOOTH=0 ;;
  esac
fi

if [ "${POCKETMZ_STOP_ES:-0}" = 1 ] && [ -z "$POCKETMZ_DETACHED" ] && systemctl is-active essway | grep -qE "^(active|activating|reloading)$"; then
  # Leave ES's process tree (stopping ES would kill it), run as unit pocketmz-<id>.
  systemctl reset-failed "pocketmz-$ID" 2>/dev/null
  systemd-run --unit="pocketmz-$ID" --collect --quiet \
    -E POCKETMZ_DETACHED=1 -E HOME="${HOME:-/storage}" -E LANG="${LANG:-C.UTF-8}" \
    -E XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/var/run/0-runtime-dir}" -E WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}" \
    -E SWAYSOCK="${SWAYSOCK:-/var/run/0-runtime-dir/sway-ipc.0.sock}" \
    -E POCKETMZ_LAUNCHER="$POCKETMZ_LAUNCHER" -E POCKETMZ_STOP_ES="$POCKETMZ_STOP_ES" \
    -E POCKETMZ_EXTRA_ARGS="$POCKETMZ_EXTRA_ARGS" -E POCKETMZ_MEM_MAX="$POCKETMZ_MEM_MAX" -E POCKETMZ_SWAP_MAX="$POCKETMZ_SWAP_MAX" \
    /bin/bash "$0" "$SRC" "$ID" && exit 0
  echo "systemd-run failed, running inside ES" >&2
fi

controlfolder="/roms/ports/PortMaster"
[ -d /storage/roms/ports/PortMaster ] && controlfolder="/storage/roms/ports/PortMaster"
source "$controlfolder/control.txt"
get_controls

mkdir -p "$RZ/games/$ID"
exec > "$LOG" 2>&1
echo "start $(date) uptime=$(cut -d' ' -f1 /proc/uptime) src=$SRC"

msg() { command -v mako-notify >/dev/null && mako-notify "$1"; echo "$1"; }

GPU_DRV=$(get_setting gpu.driver 2>/dev/null)

ts() { echo "[$(cut -d' ' -f1 /proc/uptime)] $*"; }

# CPU/GPU/threads/forcepack from ES rpgmz system/per-game setting (default performance when auto); restore afterwards
CPU_GOV_FILE=/sys/devices/system/cpu/cpufreq/policy0/scaling_governor
GPU_GOV_FILE=$(ls -d /sys/class/devfreq/*.gpu 2>/dev/null | head -1)/governor
OLD_CPU_GOV=$(cat "$CPU_GOV_FILE" 2>/dev/null); OLD_GPU_GOV=$(cat "$GPU_GOV_FILE" 2>/dev/null)
OLD_DMC_GOV=$([ -n "${DMC_FREQ:-}" ] && cat "${DMC_FREQ}/governor" 2>/dev/null || true)
# Reclaim: prefer pushing cold anonymous memory into zram over dropping NW.js code pages,
# which then have to be read back from the slow SD card (stutter, kswapd at 35 % CPU).
OLD_SWAPPINESS=$(cat /proc/sys/vm/swappiness 2>/dev/null)
cleanup() {
  [ -n "$OLD_SWAPPINESS" ] && echo "$OLD_SWAPPINESS" > /proc/sys/vm/swappiness 2>/dev/null
  if [ -n "$OLD_CPU_GOV" ]; then
    command -v set_cpu_gov >/dev/null && set_cpu_gov "$OLD_CPU_GOV" || echo "$OLD_CPU_GOV" > "$CPU_GOV_FILE" 2>/dev/null
  fi
  [ -n "$OLD_DMC_GOV" ] && [ -n "${DMC_FREQ:-}" ] && echo "$OLD_DMC_GOV" > "${DMC_FREQ}/governor" 2>/dev/null
  [ -n "$OLD_GPU_GOV" ] && echo "$OLD_GPU_GOV" > "$GPU_GOV_FILE" 2>/dev/null
  SYS_THREADS=$(get_setting system.threads 2>/dev/null)
  if command -v onlinethreads >/dev/null; then
    [ -n "$SYS_THREADS" ] && [ "$SYS_THREADS" != default ] && onlinethreads "$SYS_THREADS" 0 2>/dev/null || onlinethreads all 1 2>/dev/null
  fi
  [ -n "$OWN_THERMAL" ] && systemctl stop pocketmz-thermal
  [ -n "$POCKETMZ_DETACHED" ] && systemctl start essway
  ts "cleanup done"
}
trap cleanup EXIT

if [ -n "$POCKETMZ_DETACHED" ]; then
  sleep 1                        # let ES finish returning from the port script
  systemctl stop essway && ts "ES stopped"
fi
ES_FORCEPACK=$(es_setting forcepack)
case "$ES_FORCEPACK" in On|on|1|true) export PAN_MESA_DEBUG="${PAN_MESA_DEBUG:+$PAN_MESA_DEBUG,}forcepack" ;; esac
ES_THREADS=$(es_setting threads)
if command -v onlinethreads >/dev/null; then
  if [ -n "$ES_THREADS" ] && [ "$ES_THREADS" != default ] && [ "$ES_THREADS" != auto ]; then
    onlinethreads "$ES_THREADS" 0
  else
    onlinethreads all 1
  fi
fi
ES_CPUGOV=$(es_setting cpugovernor)
case "$ES_CPUGOV" in ""|auto|default) ES_CPUGOV=performance ;; esac
if command -v "$ES_CPUGOV" >/dev/null; then
  "$ES_CPUGOV"
else
  echo "$ES_CPUGOV" > "$CPU_GOV_FILE" 2>/dev/null
fi
ES_GPUPERF=$(es_setting gpuperf)
case "$ES_GPUPERF" in ""|auto|default) ES_GPUPERF=performance ;; esac
if command -v gpu_performance_level >/dev/null; then
  gpu_performance_level "$ES_GPUPERF"
else
  echo "$ES_GPUPERF" > "$GPU_GOV_FILE" 2>/dev/null
fi
echo "hw: cpu=${ES_CPUGOV} gpu=${ES_GPUPERF} threads=${ES_THREADS:-all} forcepack=${ES_FORCEPACK:-off} online=$(cat /sys/devices/system/cpu/online 2>/dev/null)"
echo "${POCKETMZ_SWAPPINESS:-160}" > /proc/sys/vm/swappiness 2>/dev/null
# Thermal guard: sustained load would reach the 95 C hardware shutdown (instant reset).
# Use the system one when it runs, else run ours for the duration of the game.
if ! systemctl -q is-active gkd-thermal && [ -x "$PMZ/gkd-thermal" ]; then
  systemd-run --unit=pocketmz-thermal --collect --quiet "$PMZ/gkd-thermal" run && OWN_THERMAL=1 && ts "thermal guard started"
fi

export POCKETMZ_SRC="$SRC" POCKETMZ_GAME="$RZ/games/$ID/game" POCKETMZ_RENDER_SCALE="${POCKETMZ_RENDER_SCALE:-auto}"
if [ -n "$MENU" ]; then
  # the menu page runs from the data dir (it keeps its state and covers in launcher/library)
  POCKETMZ_GAME="$RZ/launcher"; mkdir -p "$POCKETMZ_GAME/library"
  [ "$PMZ/launcher" -ef "$POCKETMZ_GAME" ] || cp -u "$PMZ/launcher/"*.* "$POCKETMZ_GAME/"
fi
# (Re)build the thin copy when missing or when patches changed
PJS="$POCKETMZ_GAME/${WEB}js/plugins.js"
DEV_NOW=0; [ -f "$RZ/dev" ] && DEV_NOW=1
DEV_COPY=0; grep -q '"name":"PocketMZ_Debug"' "$PJS" 2>/dev/null && DEV_COPY=1
# ... or when the original game's copied files changed (a new version of the game was put over it):
# size + ctime of every file in data/ js/ css/ and index.html / package.json (ctime also changes
# when an archive is extracted with old mtimes). Saves, settings and the image cache are kept.
SRCSIG=""; SIGF="$POCKETMZ_GAME/.pmz-src"
[ -z "$MENU" ] && SRCSIG=$(find "$SRC/${WEB}data" "$SRC/${WEB}js" "$SRC/${WEB}css" "$SRC/${WEB}index.html" "$SRC/package.json" \
  -type f -exec stat -c '%s %Z %n' {} + 2>/dev/null | md5sum | cut -c1-32)
if [ -z "$MENU" ] && { [ ! -f "$POCKETMZ_GAME/${WEB}index.html" ] || [ "$DEV_NOW" != "$DEV_COPY" ] || \
   [ "$SRCSIG" != "$(cat "$SIGF" 2>/dev/null)" ] || \
   [ -n "$(find "$PMZ/patches" -newer "$PJS" \( -name 'PocketMZ_*.js' -o -name params.json \) 2>/dev/null)" ]; }; then
  [ -f "$SIGF" ] && [ "$SRCSIG" != "$(cat "$SIGF")" ] && echo "original game changed: refreshing the copy"
  "$PMZ/pocketmz-mkgame.sh" "$SRC" "$POCKETMZ_GAME" || { msg "游戏复制失败"; sleep 5; exit 1; }
  echo "$SRCSIG" > "$SIGF"
fi

# Save backup before each start (only when the saves changed since the last one); the 5 newest are
# kept in <thin copy>/save-backups/<date-time>/. The in-game PocketMZ menu can restore them.
SAVEDIR="$POCKETMZ_GAME/${WEB}save"; BKDIR="$POCKETMZ_GAME/save-backups"
if [ -z "$MENU" ] && [ -d "$SAVEDIR" ] && [ -n "$(ls -A "$SAVEDIR" 2>/dev/null)" ]; then
  LASTBK=$(ls -1d "$BKDIR"/2* 2>/dev/null | tail -1)
  if [ -z "$LASTBK" ] || ! diff -r "$SAVEDIR" "$LASTBK" >/dev/null 2>&1; then
    NEWBK="$BKDIR/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$NEWBK" && cp -a "$SAVEDIR/." "$NEWBK/" && echo "save backup: $NEWBK"
  fi
  NBK=$(ls -1d "$BKDIR"/2* 2>/dev/null | wc -l)
  if [ "$NBK" -gt 5 ]; then
    ls -1d "$BKDIR"/2* | head -n $((NBK - 5)) | while read -r OLDBK; do
      case "$OLDBK" in "$BKDIR"/2*) rm -rf "$OLDBK" ;; esac
    done
  fi
fi

# ---- runtime: auto (default) | beta | nw -------------------------------------------------------------
# "runtime" in the thin copy's pocketmz.json (in-game menu file: F2 menu, item "运行时") wins over the global default in settings.json; POCKETMZ_GAME_RUNTIME (env / games/<id>/env) over both.
# nw = NW.js (α, fallback/unchanged path below). beta = the browser-less runtime (beta/run-pmzrun.sh, MODE=play). auto = beta unless the game has a "β not OK" mark or β is not installed (default).
# Mark: games/<id>/beta-status.json {"ok":false,"reason":..,"beta":<β build>,"game":<game fingerprint (SRCSIG)>,"time":..}; ignored when the β build or the game changed.
# For auto the first launch of a game runs a static scan (pocketmz-betascan.sh: m4a/mp4/webm/gif, movies/, play-movie command, playVideo) and stores the result in the same file (ok:true = scanned, nothing found).
# When β fails (exit 3 = its own boot / COMPAT check, or a crash in the first 45 s) the game is marked and started again on NW.js right here (falls through to the code below); a normal quit ends the script.
# Test hook: POCKETMZ_BETA_FORCE_FAIL=<text> makes β fail on purpose once it reaches the first scene.
pmz_cgroup() {
  # Memory cgroup: when the game outgrows it, only the game is OOM-killed
  # (instead of the whole handheld thrashing in swap). Values in MB, override via env.
  CG=/sys/fs/cgroup/unified/pocketmz
  MEM_MAX="${POCKETMZ_MEM_MAX:-760}" SWAP_MAX="${POCKETMZ_SWAP_MAX:-420}"
  MEM_HIGH="${POCKETMZ_MEM_HIGH:-$MEM_MAX}"   # memory.high below max throttles (slow start)
  if grep -qw memory /sys/fs/cgroup/unified/cgroup.subtree_control 2>/dev/null || \
     echo "+memory" > /sys/fs/cgroup/unified/cgroup.subtree_control 2>/dev/null; then
    [ -d "$CG" ] && [ -z "$(cat "$CG/cgroup.procs")" ] && rmdir "$CG"   # fresh peak/events
    mkdir -p "$CG"
    echo $((MEM_MAX << 20)) > "$CG/memory.max"
    echo $((MEM_HIGH << 20)) > "$CG/memory.high"
    echo $((SWAP_MAX << 20)) > "$CG/memory.swap.max"
    echo 1 > "$CG/memory.oom.group"
    OOM_BEFORE=$(sed -n 's/^oom_kill //p' "$CG/memory.events")
    echo $$ > "$CG/cgroup.procs" && echo "cgroup $CG high=${MEM_HIGH}M max=${MEM_MAX}M swap=${SWAP_MAX}M"
  fi
}
RT=auto
if [ -z "$MENU" ]; then
  RT="${POCKETMZ_GAME_RUNTIME:-$(grep -o '"runtime": *"[a-z]*"' "$POCKETMZ_GAME/pocketmz.json" 2>/dev/null | head -1 | cut -d'"' -f4)}"
  [ -z "$RT" ] && RT=$(gset runtime)
  case "$RT" in nw|beta|auto) ;; *) RT=auto ;; esac
fi
BSTAT="$RZ/games/$ID/beta-status.json"
bs_get() { [ -f "$BSTAT" ] && grep -o "\"$1\": *\"[^\"]*\"" "$BSTAT" | head -1 | cut -d'"' -f4; }
bs_write() {   # <true|false> <reason>
  printf '{"ok":%s,"reason":"%s","beta":"%s","game":"%s","time":"%s"}\n' "$1" "$(printf '%s' "$2" | tr -d '"\' | tr '\n\r\t' '   ' | cut -c1-200)" "$BVER" "$SRCSIG" "$(date '+%F %T')" > "$BSTAT.tmp" && mv -f "$BSTAT.tmp" "$BSTAT"
}
# β root: PMZ_ROOTDIR=auto (beta-mount.sh) = the release image beta-runtime.sqfs (read-only overlay on the α image) when installed, else the dev overlay root24 so a development
# handheld keeps working; neither installed -> β is "not installed" below. An explicit PMZ_ROOTDIR in the environment (rt | root24 | root) wins. Only the β branch sets it.
[ "$RT" != nw ] && export PMZ_ROOTDIR="${PMZ_ROOTDIR:-auto}"
if [ "$RT" != nw ]; then
  BVER=$("$RZ/beta/beta-version.sh" 2>/dev/null)
  if [ ! -x "$RZ/beta/run-pmzrun.sh" ] || [ -z "$BVER" ]; then echo "runtime $RT: β not installed, using NW.js"; RT=nw; fi
fi
# facts for the in-game menu's runtime item (the game's root does not see /storage): global default, β installed (image or dev overlay)
case "$(gset runtime)" in nw|beta|auto) export POCKETMZ_RT_GLOBAL="$(gset runtime)" ;; *) export POCKETMZ_RT_GLOBAL=auto ;; esac
if [ -x "$RZ/beta/run-pmzrun.sh" ] && { [ -f "$RZ/beta-runtime.sqfs" ] || [ -d "$RZ/beta/upper24" ]; }; then export POCKETMZ_BETA_INST=1; else export POCKETMZ_BETA_INST=0; fi
if [ "$RT" = auto ]; then
  if [ "$(bs_get beta)" = "$BVER" ] && [ "$(bs_get game)" = "$SRCSIG" ]; then
    if grep -q '"ok": *false' "$BSTAT"; then echo "runtime auto: β not OK for this game ($(bs_get reason)), using NW.js"; RT=nw; fi
  else
    BS_T0=$(date +%s%N); BS_WHY=$("$PMZ/pocketmz-betascan.sh" "$SRC"); BS_RC=$?
    echo "β scan: rc=$BS_RC $(( ($(date +%s%N) - BS_T0) / 1000000 )) ms ${BS_WHY}"
    if [ $BS_RC -ne 0 ]; then bs_write false "scan: $BS_WHY"; RT=nw; else bs_write true "scan ok"; fi
  fi
fi
if [ "$RT" != nw ]; then
  export POCKETMZ_RT_NOW=beta
  echo "runtime: β ($BVER) root: $("$RZ/beta/beta-mount.sh" "$PMZ_ROOTDIR" 2>/dev/null)"
  pmz_cgroup
  # same start-up settings as the NW.js path: render scale from ES or in-game menu file, game locale, locale-independent TZ, 30 fps default (run-pmzrun.sh would use 60)
  if [ -z "$POCKETMZ_ES_RENDER_SCALE" ]; then
    RS=$(grep -o '"renderScale": *"[a-z0-9.]*"' "$POCKETMZ_GAME/pocketmz.json" 2>/dev/null | head -1 | cut -d'"' -f4); [ -n "$RS" ] && export POCKETMZ_RENDER_SCALE="$RS"
  fi
  GAME_LOCALE=$(grep -o '"locale" *: *"[^"]*"' "$POCKETMZ_GAME/${WEB}data/System.json" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/')
  GAME_LOCALE="${GAME_LOCALE:-ja_JP}"; export POCKETMZ_LANG="${GAME_LOCALE%%_*}"
  export POCKETMZ_DEFAULT_FPS="${POCKETMZ_DEFAULT_FPS:-30}"
  TZ="${TZ:-$(get_setting system.timezone 2>/dev/null)}"; export TZ="${TZ:-UTC}"
  BFAIL=/tmp/pmz-beta-fail.txt; rm -f "$BFAIL" /tmp/pmz-beta-compat.txt
  ts "beta start"; BT0=$SECONDS
  POCKETMZ_TITLE="$(basename "${L:-$SRC}" .rpgmz)" MODE=play PMZ_GAME_ID="$ID" PMZ_GUARD=1 PMZ_GUARD_FORCE="$(printf %s "$POCKETMZ_BETA_FORCE_FAIL" | tr -c "A-Za-z0-9._-" _)" \
    PMZ_FAIL_FILE="$BFAIL" PMZ_COMPAT_FILE=/tmp/pmz-beta-compat.txt "$RZ/beta/run-pmzrun.sh"
  BRC=$?; BDT=$((SECONDS - BT0))
  ts "beta exit $BRC after ${BDT}s"
  BWHY=""
  if [ $BRC -eq 3 ]; then BWHY="$(head -c 300 "$BFAIL" 2>/dev/null)"; [ -z "$BWHY" ] && BWHY="exit 3"
  elif [ $BRC -ne 0 ] && [ $BDT -lt 45 ]; then
    case $BRC in 130|137|143) ;; *) BWHY="crash (exit $BRC) ${BDT}s after start" ;; esac   # SIGINT/KILL/TERM = the user's quit combo or the system, not a β failure
  fi
  rm -f "$BFAIL" /tmp/pmz-beta-compat.txt
  if [ -z "$BWHY" ]; then
    if [ -f "$CG/memory.events" ]; then
      echo "cgroup peak: $(cat "$CG/memory.peak" 2>/dev/null) events: $(tr '\n' ' ' < "$CG/memory.events")"
      [ "$(sed -n 's/^oom_kill //p' "$CG/memory.events")" != "${OOM_BEFORE:-0}" ] && { msg "内存不足，游戏已退出（请把当前情况告诉开发者）"; sleep 4; }
    fi
    exit $BRC
  fi
  echo "β failed: $BWHY - marking the game and starting it on NW.js"
  bs_write false "$BWHY"
  if [ -n "$GPU_DRV" ] && [ "$GPU_DRV" != "panfrost" ]; then
    msg "β 运行时不兼容这个游戏，且 NW.js 需要 panfrost 驱动"
    sleep 5; exit 1
  fi
  msg "β 运行时不兼容这个游戏，改用 NW.js 重新启动"
fi
# ---- NW.js path (α, unchanged) ----
if [ -n "$GPU_DRV" ] && [ "$GPU_DRV" != "panfrost" ]; then
  msg "NW.js 需要 GPU 驱动 panfrost（可在设置中切换 β 运行时，或 ES 切回 panfrost）"
  sleep 5; exit 1
fi
export POCKETMZ_RT_NOW=nw   # (only read by the in-game menu)

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/var/run/0-runtime-dir}" WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}"
export SWAYSOCK="${SWAYSOCK:-$XDG_RUNTIME_DIR/sway-ipc.0.sock}"
APPID=$(sed -n 's/^ *"name" *: *"\([^"]*\)".*/\1/p' "$POCKETMZ_GAME/package.json" | head -1)
swaymsg "for_window [app_id=\"${APPID}\"] fullscreen enable" >/dev/null 2>&1
rm -f "$RZ/home/.config/${APPID}/Singleton"*

# -hotkey guide: with the default hotkey (Select) gptokeyb holds Select back and only taps Shift on
# release, so Select+R1 never reached the game. Hotkeys are "hold F2" now (pocketmz-hotkeys.py).
# Button mapping made in the in-game PocketMZ menu (Key mapping page): <thin copy>/pocketmz.gptk.
# It wins over the defaults; when the menu changes or removes it, gptokeyb is restarted with the
# new map (the game keeps running).
USER_GPTK="$POCKETMZ_GAME/pocketmz.gptk"
[ -z "$MENU" ] && [ -f "$USER_GPTK" ] && GPTK_MAP="$USER_GPTK" && echo "button map: $USER_GPTK"
DEFAULT_GPTK="$GPTK_MAP"; [ "$GPTK_MAP" = "$USER_GPTK" ] && DEFAULT_GPTK="$PMZ/pocketmz.gptk"
for g in pocketmz.gptk rpgmz.gptk; do [ -f "$RZ/games/$ID/$g" ] && { DEFAULT_GPTK="$RZ/games/$ID/$g"; break; }; done
$GPTOKEYB "nw" -c "$GPTK_MAP" -hotkey guide &
if [ -z "$MENU" ]; then
  (
    RUN=$$; stamp() { stat -c %Y "$USER_GPTK" 2>/dev/null || echo none; }
    last=$(stamp)
    while kill -0 $RUN 2>/dev/null; do
      sleep 1
      now=$(stamp); [ "$now" = "$last" ] && continue
      last=$now
      map="$DEFAULT_GPTK"; [ -f "$USER_GPTK" ] && map="$USER_GPTK"
      echo "button map changed: restarting gptokeyb with $map"
      $ESUDO kill -9 $(pidof gptokeyb) 2>/dev/null
      pidof nw >/dev/null || break
      $GPTOKEYB "nw" -c "$map" -hotkey guide &
    done
  ) &
fi
# give the window the focus once it exists (started from a script instead of ES, the focus
# would otherwise stay on ES and the game window would sit behind it)
# and make it fullscreen: the for_window rule above does not always catch it (seen with an MV game
# whose window was left tiled next to ES at half width)
( for i in $(seq 1 90); do sleep 1; swaymsg "[app_id=\"${APPID}\"] fullscreen enable, focus" >/dev/null 2>&1 && break; done ) &

pmz_cgroup   # defined above (also used by the β runtime branch)

# Memory watchdog. The cgroup alone does not stop the handheld from thrashing: when RAM + swap run
# out system-wide (ES, sway and the game together) everything stalls in swap long before the
# game reaches its own limit, and the handheld looks frozen. When the kernel reports processes
# stalled on memory ("full" pressure) most of the time for WD_SECS seconds, end the game.
# Runs outside the game's cgroup so it is not throttled with it.
WD_LIMIT="${POCKETMZ_WD_PRESSURE:-50}" WD_SECS="${POCKETMZ_WD_SECS:-15}"
# low-memory trigger: MemAvailable below WD_AVAIL MB and swap nearly used up (system SwapFree
# below WD_SWAPFREE MB, or the game's own swap above WD_GAMESWAP MB) for WD_LOWSECS seconds
WD_AVAIL="${POCKETMZ_WD_AVAIL:-150}" WD_SWAPFREE="${POCKETMZ_WD_SWAPFREE:-150}"
WD_GAMESWAP="${POCKETMZ_WD_GAMESWAP:-$(( SWAP_MAX - 40 ))}" WD_LOWSECS="${POCKETMZ_WD_LOWSECS:-6}"
if [ "$WD_LIMIT" != off ] && [ -r /proc/pressure/memory ]; then
  (
    # outside the game's cgroup, never picked by the OOM killer, scheduled first
    echo $BASHPID > /sys/fs/cgroup/unified/cgroup.procs 2>/dev/null
    echo -1000 > /proc/$BASHPID/oom_score_adj 2>/dev/null
    renice -n -15 -p $BASHPID >/dev/null 2>&1
    n=0; nl=0; RUN=$$
    while kill -0 $RUN 2>/dev/null; do
      sleep 2
      p=$(awk '/^full/ { split($2, a, "="); printf "%d", a[2] }' /proc/pressure/memory)
      gs=$(( $(cat "$CG/memory.swap.current" 2>/dev/null || echo 0) >> 20 ))
      low=$(awk -v av="$WD_AVAIL" -v sf="$WD_SWAPFREE" -v gs="$gs" -v gmax="$WD_GAMESWAP" \
        '/^MemAvailable/ {a=$2} /^SwapFree/ {s=$2} END {print (a < av*1024 && (s < sf*1024 || gs > gmax)) ? 1 : 0}' /proc/meminfo)
      if [ "${p:-0}" -ge "$WD_LIMIT" ]; then n=$((n + 2)); else n=0; fi
      if [ "$low" = 1 ]; then nl=$((nl + 2)); else nl=0; fi
      if { [ $n -ge "$WD_SECS" ] || [ $nl -ge "$WD_LOWSECS" ]; } && pidof nw >/dev/null; then
        echo "watchdog: low memory (full avg10=$p% for ${n}s, low for ${nl}s, game swap ${gs}MB) - ending the game"
        grep -E '^(MemAvailable|SwapFree)' /proc/meminfo | tr -s ' ' | tr '\n' ' '; echo
        touch "$RZ/games/.watchdog-$RUN"
        command -v mako-notify >/dev/null && mako-notify "内存快用完了，正在退出游戏（未存档的进度会丢失）" &
        # a normal close first (the browser saves its state), forced after 3 s
        kill -TERM $(pidof nw) 2>/dev/null
        for i in 1 2 3; do sleep 1; pidof nw >/dev/null || break; done
        kill -9 $(pidof nw) 2>/dev/null
        break
      fi
    done
  ) &
fi

# Browser language = the game's language (MZ data/System.json "locale", e.g. ja_JP; MV: ja).
# Affects CJK fallback glyph shapes and navigator.language; file names stay UTF-8 (C.UTF-8).
GAME_LOCALE=$(grep -o '"locale" *: *"[^"]*"' "$POCKETMZ_GAME/${WEB}data/System.json" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/')
UI_LANG=$(get_setting system.language 2>/dev/null)
export POCKETMZ_UI_LANG="${UI_LANG:-zh_CN}"                  # language of the PocketMZ menus
TZ="${TZ:-$(get_setting system.timezone 2>/dev/null)}"; export TZ="${TZ:-UTC}"   # local time in the game (and backup names)
[ -n "$MENU" ] && GAME_LOCALE="$UI_LANG"                     # the game menu page: system language
# in-game PocketMZ menu settings that apply at start (pocketmz.json in the thin copy, unless forced by ES)
if [ -z "$MENU" ] && [ -z "$POCKETMZ_ES_RENDER_SCALE" ] && [ -f "$POCKETMZ_GAME/pocketmz.json" ]; then
  RS=$(grep -o '"renderScale": *"[a-z0-9.]*"' "$POCKETMZ_GAME/pocketmz.json" | head -1 | cut -d'"' -f4)
  [ -n "$RS" ] && export POCKETMZ_RENDER_SCALE="$RS" && echo "render scale from menu settings: $RS"
fi
GAME_LOCALE="${GAME_LOCALE:-ja_JP}"
export POCKETMZ_LANG="${GAME_LOCALE%%_*}"
echo "game locale $GAME_LOCALE"

# Chromium trimmed for 1 GB RAM: GPU thread in the browser process, no zygote,
# one renderer, no crash reporter, no background services.
NW_ARGS="--no-sandbox --ozone-platform=wayland --ignore-gpu-blocklist --enable-gpu-rasterization
 --in-process-gpu --no-zygote --renderer-process-limit=1 --disable-breakpad --disable-accelerated-2d-canvas
 --disable-background-networking --disable-component-update --disable-sync --disable-default-apps
 --disable-features=Translate,OptimizationHints,MediaRouter,OnDeviceModelService,AutofillServerCommunication,SpareRendererForSitePerProcess,BackForwardCache,Vulkan,AudioServiceOutOfProcess
 --enable-features=NetworkServiceInProcess2 --disk-cache-size=1048576 --lang=$(echo "$GAME_LOCALE" | tr _ -) $POCKETMZ_EXTRA_ARGS"
# dev hook: extra Chromium args from a file (e.g. --remote-debugging-port=9223 for profiling)
[ -f "$RZ/extra-args" ] && NW_ARGS="$NW_ARGS $(cat "$RZ/extra-args")"
# dev hook: extra V8 flags (e.g. --no-wasm-lazy-compilation)
JS_EXTRA="$POCKETMZ_JS_FLAGS"; [ -f "$RZ/js-flags" ] && JS_EXTRA="$JS_EXTRA $(cat "$RZ/js-flags")"
echo "args: $(echo $NW_ARGS)"

# Handheld integration (same as runemu does for emulators):
# - L1+Select+Start (system input_sense) force-quits the process named in /tmp/.process-kill-data
# - L1+X shows the guide that game-guides-tool picks for this game
# - "hold F2" hotkeys: pocketmz-hotkeys.py reads the pad and talks to PocketMZ_Menu.js
HK_PID=""
if [ -z "$MENU" ]; then
  command -v set_kill >/dev/null && set_kill set "-9 nw"
  [ -x /usr/bin/game-guides-tool ] && [ -n "$L" ] && /usr/bin/game-guides-tool "$L" >/dev/null 2>&1
  if [ "${POCKETMZ_HOTKEYS:-1}" = 1 ] && [ -f "$PMZ/pocketmz-hotkeys.py" ]; then
    POCKETMZ_TITLE="$(basename "${L:-$SRC}" .rpgmz)" python3 "$PMZ/pocketmz-hotkeys.py" &
    HK_PID=$!
  fi
fi
ts "nw start"
"$PMZ/pocketmz-chroot.sh" run /opt/nwjs/nw $NW_ARGS "--js-flags=--max-old-space-size=256 --expose-gc $JS_EXTRA" /game
ts "nw exit $?"
[ -n "$HK_PID" ] && kill "$HK_PID" 2>/dev/null
[ -z "$MENU" ] && command -v set_kill >/dev/null && set_kill stop

if [ -f "$CG/memory.events" ]; then
  OOM_AFTER=$(sed -n 's/^oom_kill //p' "$CG/memory.events")
  echo "cgroup peak: $(cat "$CG/memory.peak" 2>/dev/null) events: $(tr '\n' ' ' < "$CG/memory.events")"
  [ "${OOM_AFTER:-0}" != "${OOM_BEFORE:-0}" ] && { msg "内存不足，游戏已退出（请把当前情况告诉开发者）"; sleep 4; }
fi
if [ -f "$RZ/games/.watchdog-$$" ]; then
  rm -f "$RZ/games/.watchdog-$$"
  msg "内存耗尽，掌机快卡死，已结束游戏（未存档的进度会丢失）"; sleep 4
fi

$ESUDO kill -9 $(pidof gptokeyb) 2>/dev/null
"$PMZ/pocketmz-chroot.sh" umount
