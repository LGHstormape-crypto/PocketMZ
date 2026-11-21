#!/bin/bash
# SPDX-License-Identifier: MIT
# Dev: automatic play test on the handheld. Starts a game the way it normally runs (dev mode for the REPL),
# injects pocketmz-autotest.js (an autoplayer that also blocks every save write), and records a timeline of
# memory / swap / pressure / frame stats plus the driver's events while assets switch and load.
# Usage: pocketmz-autotest.sh <launcher.rpgmz | game id> [minutes=15] [play|tour]
#        pocketmz-autotest.sh --all [minutes] [mode]      every launcher in /storage/roms/rpgmz/*.rpgmz
# Result: /storage/pocketmz/games/<id>/autotest-<YYYYmmdd-HHMMSS>/{timeline.csv,events.log,summary.txt,*.png}
# Saves: the game's save folder is backed up first and restored (and diffed) at exit; a loud warning if it differs.
# modes: play = new game + autoplayer for <minutes>; tour = every map, every troop, menu scenes (ends when done).
# AT_SEED=<number>  deterministic run (same seed = same route): seeded driver + game Math.random, decisions timed in logic
#                   frames, <minutes> counts logic minutes (the wall-clock safety limit is 2x + 2 min). summary.txt gets a
#                   "trace: hash=... points=..." line; two runs of the same game and seed should print the same hash.
#                   Unset = the old wall-clock behaviour.
RZ=/storage/pocketmz
TS=$RZ/pocketmz-test.sh
HERE=$(cd "$(dirname "$0")" && pwd)
JSF=$RZ/pocketmz-autotest.js; [ -f "$JSF" ] || JSF=$HERE/pocketmz-autotest.js
CG=/sys/fs/cgroup/unified/pocketmz
export XDG_RUNTIME_DIR=/var/run/0-runtime-dir WAYLAND_DISPLAY=wayland-1 SWAYSOCK=/var/run/0-runtime-dir/sway-ipc.0.sock

TRACE="n/a"; ACTIVE=0; ABORT=0; STARTED=0; RESULTS=$(mktemp /tmp/autotest-results.XXXXXX)

up() { cut -d' ' -f1 /proc/uptime; }
mb() { [ -f "$1" ] && echo $(( $(cat "$1") >> 20 )) || echo 0; }
rjs() { curl -s -m "${2:-15}" --data-binary "$1" 127.0.0.1:9333 | tr -d '\r'; }   # REPL; a Promise result is awaited
unq() { local s="$1"; s=${s#\"}; s=${s%\"}; printf '%s' "$s"; }
scene() { unq "$(rjs 'SceneManager._scene?SceneManager._scene.constructor.name:""' 5)" | tr -d ' '; }
mmss() { printf '%02d:%02d' $(( $1 / 60 )) $(( $1 % 60 )); }
# Tests start the game outside ES, so ES sees no input and starts its black screensaver: backlight
# off, and 30 min later gkd-idle puts the CPU on powersave with cores 1-3 offline (fps 0-1, REPL
# hangs). End it the way essway does on restart: run the screensaver-stop scripts.
keep_awake() {
  grep -q '^4$' /sys/class/backlight/*/bl_power 2>/dev/null || [ -f /run/gkd-idle.state ] || return 0
  for s in /var/run/emulationstation/scripts/screensaver-stop/*; do [ -x "$s" ] && "$s"; done 2>/dev/null
  echo "$(( ${ELAPSED:-0} * 1000 ))|awake|screensaver / idle power saving ended" >> "$OUT/events.log"
}
shot() {   # shot <label>: screenshot via the test helper, copied next to the timeline (max 5 peak shots are taken by the caller)
  local n="autotest_${ID}_$1"
  $TS shot "$n" >/dev/null 2>&1; [ -f "/tmp/$n.png" ] && { cp "/tmp/$n.png" "$OUT/$1.png"; echo "$OUT/$1.png" >> "$OUT/shots.txt"; }
}
parse_status() {   # "k=v;k=v" from PMZ_AT.status() -> st_k variables
  st_ph=; st_step=; st_sc=; st_map=0; st_fr=0; st_fps=0; st_gap=0; st_heap=0; st_img=0/0; st_last=0; st_maps=0; st_battles=0; st_scenes=0; st_errs=0; st_tp=0; st_stuck=0
  eval "$(printf '%s' "$1" | awk -F';' '{for(i=1;i<=NF;i++){k=$i; sub(/=.*/,"",k); v=$i; sub(/^[^=]*=/,"",v); gsub(/[^A-Za-z0-9_.\/:, >-]/,"",v); if(k ~ /^[a-z]+$/) printf "st_%s=\047%s\047\n", k, v}}')"
}

# ---------------------------------------------------------------- one game
finish_game() {   # idempotent: stop game, restore saves, write the summary
  [ "$ACTIVE" = 1 ] || return 0
  ACTIVE=0
  STARTED=0; echo "== stopping $ID"
  if pidof nw >/dev/null; then
    unq "$(rjs 'PMZ_AT.errors()' 6)" | tr '^' '\n' > "$OUT/errors.txt"
    rjs 'PMZ_AT.report()' 6 > "$OUT/report.json"
    TRACE=$(unq "$(rjs 'PMZ_AT.trace()' 6)"); case "$TRACE" in hash=*points=*) ;; *) TRACE="n/a" ;; esac
    rjs 'PMZ_AT.stop()' 4 >/dev/null
  fi
  $TS stop > "$OUT/stop.log" 2>&1
  SAVES_MSG="saves restored"
  case "$SAVE" in "$RZ"/games/?*/game/save|"$RZ"/games/?*/game/www/save) ;;
    *) echo "## refusing to restore: unexpected save path '$SAVE' (backup kept in $B)"; make_summary; return 1 ;; esac
  [ -d "$B" ] || { echo "## no backup folder '$B' - saves not touched"; make_summary; return 1; }
  rm -rf "$SAVE"/* "$SAVE"/.[!.]* 2>/dev/null; mkdir -p "$SAVE"; cp -a "$B/." "$SAVE/"
  if diff -r "$B" "$SAVE" >/dev/null 2>&1; then rm -rf "$B"
  else
    SAVES_MSG="SAVES DIFFER - backup kept in $B"
    echo "######################################################################"
    echo "## WARNING: save folder differs from the backup after restore!"
    echo "## backup kept: $B"
    echo "## live saves:  $SAVE"
    echo "######################################################################"
  fi
  make_summary
}

make_summary() {
  local csv="$OUT/timeline.csv" evl="$OUT/events.log" mins peak low
  mins=$(( (END_S - START_S) / 60 )); [ -f "$csv" ] || return 0
  peak=$(awk -F, 'NR>1{t=$7+$8; if(t>m){m=t;mm=$7;ss=$8;r=$2"|"$4"|"$6}} END{printf "%d|%d|%d|%s", m, mm, ss, r}' "$csv")
  low=$(awk -F, 'NR>1 && $9!=""{if(mn==""||$9+0<mn){mn=$9+0;r=$2"|"$4"|"$6}} END{printf "%d|%s", mn, r}' "$csv")
  PEAK=${peak%%|*}; LOW=${low%%|*}
  {
    echo "== autotest $ID  mode=$MODE  engine=${ENGINE:-?}  title=${GTITLE:-?}${AT_SEED:+  seed=$AT_SEED}"
    echo "run: ${mins} min (${ELAPSED}s), result: $RESULT  $SAVES_MSG"
    [ -n "$AT_SEED" ] && echo "trace: $TRACE"
    echo "maps visited: $st_maps   battles: $st_battles   scene changes: $st_scenes   teleports: $st_tp   stuck: $st_stuck"
    echo "$peak" | awk -F'|' '{printf "peak ram+swap: %d MB (ram %d + swap %d) at %s step=%s map=%s\n", $1,$2,$3,sprintf("%02d:%02d",$4/60,$4%60),$5,$6}'
    echo "$low" | awk -F'|' '{printf "lowest MemAvailable: %d MB at %s step=%s map=%s\n", $1,sprintf("%02d:%02d",$2/60,$2%60),$3,$4}'
    echo "memory watchdog lines: $WD   OOM kills (dmesg): $OOM_NEW   max pressure(full avg10): $(awk -F, 'NR>1{if($10+0>m)m=$10+0} END{print m+0}' "$csv")%"
    echo "slowest map loads / scene changes:"
    awk -F'|' '
      function ms(s) { if (match(s, / ms=-?[0-9]+/)) return substr(s, RSTART+4, RLENGTH-4)+0; return -1 }
      ($2=="map") || ($2=="scene" && $3 !~ />Scene_Map ms=/) { v=ms($3); if (v>=0) { l=$3; sub(/ ms=-?[0-9]+/,"",l); printf "%d\t%s %s\t%d\n", v, $2, l, $1/1000 } }
    ' "$evl" 2>/dev/null | sort -rn | head -10 | awk -F'\t' '{printf "  %6d ms  %s  (at %02d:%02d)\n",$1,$2,$3/60,$3%60}'
    awk -F'|' '$2=="stall"{g=$3; sub(/^gap=/,"",g); sub(/ms.*/,"",g); printf "%d\t%s\t%d\n", g, $3, $1/1000}' "$evl" 2>/dev/null | sort -rn | head -3 | awk -F'\t' 'BEGIN{n=0} {if(!n++)print "worst frame stalls:"; printf "  %s (at %02d:%02d)\n",$2,$3/60,$3%60}'
    echo "errors (deduplicated):"
    if [ -s "$OUT/errors.txt" ]; then head -8 "$OUT/errors.txt" | sed 's/^/  x/'
    else
      awk -F'|' '$2=="error"||$2=="imgerr"||$2=="audioerr"{m=$3; sub(/ \(x[0-9]+\) step=.*/,"",m); c[$2" "m]++} END{for(k in c) printf "%d %s\n", c[k], k}' "$evl" 2>/dev/null | sort -rn | head -8 | sed 's/^/  x/'
    fi
    [ -s "$OUT/hangs.txt" ] && { echo "HANGS:"; sed 's/^/  /' "$OUT/hangs.txt"; }
    [ -s "$OUT/shots.txt" ] && { echo "screenshots:"; sed 's/^/  /' "$OUT/shots.txt"; }
    echo "files: $OUT"
  } > "$OUT/summary.txt"
  cat "$OUT/summary.txt"
  # one result line for the --all table
  printf '%s|%s|%s|%s|%s|%s|%s|%s|%s\n' "$ID" "$RESULT" "$mins" "$st_maps" "$st_battles" "$PEAK" "$LOW" "$st_errs" "$(wc -l < "$OUT/hangs.txt" 2>/dev/null | tr -d ' ')" >> "$RESULTS"
}

run_one() {   # run_one <launcher> <minutes> <mode>
  local PORT="$1" MINUTES="$2"
  MODE="$3"
  [ -f "$PORT" ] || { echo "no such launcher: $PORT" >&2; return 1; }
  ID=$(sed -n 's/^# pocketmz: //p; s/^id=//p' "$PORT" | head -1)
  [ -n "$ID" ] || ID=$($RZ/pocketmz-scan.sh --id "$(sed -n 's/^exec .*pocketmz-run.sh "\([^"]*\)".*/\1/p' "$PORT")")
  echo "== $ID  ($PORT)  ${MINUTES} min  $MODE${AT_SEED:+  seed=$AT_SEED}"
  pidof nw >/dev/null && { echo "a game is running (someone playing?) - stop it first"; RESULT=skipped; return 1; }
  [ -f "$JSF" ] || { echo "missing $JSF" >&2; return 1; }
  export POCKETMZ_TEST_PORT="$PORT" POCKETMZ_TEST_VIA_ES=0 POCKETMZ_HOTKEYS=0
  local STAMP; STAMP=$(date +%Y%m%d-%H%M%S)
  OUT=$RZ/games/$ID/autotest-$STAMP; mkdir -p "$OUT"
  : > "$OUT/events.log"; : > "$OUT/hangs.txt"; : > "$OUT/shots.txt"
  echo "time,elapsed_s,phase,step,scene,map,ram_mb,swap_mb,avail_mb,psi_full10,fps,worst_gap_ms,heap_mb,img_keys_mpx" > "$OUT/timeline.csv"
  TRACE="n/a"; RESULT=running; ENGINE=; GTITLE=; PEAK=0; LOW=0; WD=0; OOM_NEW=0; ELAPSED=0
  st_maps=0; st_battles=0; st_scenes=0; st_tp=0; st_stuck=0; st_errs=0
  local L=$RZ/games/$ID/run.log OOM0; OOM0=$(dmesg 2>/dev/null | grep -ci "out of memory")
  START_S=$(date +%s); END_S=$START_S

  # --- start the game (own waiting, like pocketmz-smoke.sh)
  touch $RZ/dev; STARTED=1
  local t0 t1 s i
  t0=$(up)
  ( $TS start >"$OUT/start.log" 2>&1 & )
  sleep 3
  for i in $(seq 1 900); do grep -qE "thin copy ready|nw start" "$L" 2>/dev/null && break; sleep 1; done
  for i in $(seq 1 150); do
    s=$(scene); [ -n "$s" ] && [ "$s" != Scene_Boot ] && [ "$s" != null ] && break; sleep 1
  done
  case "$s" in *Title*) ;; *) for i in $(seq 1 60); do s=$(scene); case "$s" in *Title*) break;; esac; sleep 1; done;; esac
  [ -z "$s" ] && { echo "game did not start:"; tail -20 "$L"; $TS stop >/dev/null 2>&1; RESULT="no-start"; return 1; }
  echo "scene $s after $(awk "BEGIN{print int($(up)-$t0)}")s"
  sleep 2
  local G=$RZ/games/$ID/game; SAVE=$G/save; [ -d $G/www ] && SAVE=$G/www/save
  # someone picked up the handheld since the game started: leave it untouched
  if [ "$(unq "$(rjs 'Input.date ? "pressed" : "none"' 5)")" != none ]; then
    echo "keys were pressed (someone is playing?) - autotest not started, game left running"; RESULT="user-active"; return 1
  fi

  # --- saves: back up, inject (blocks all writes), restore at exit
  B=$RZ/games/$ID/save-autotest-$STAMP; mkdir -p "$SAVE" "$B"; cp -a "$SAVE/." "$B/"
  ACTIVE=1
  curl -s -m 30 --data-binary @"$JSF" 127.0.0.1:9333 >/dev/null
  if [ "$(unq "$(rjs 'typeof PMZ_AT' 5)")" != object ]; then
    echo "injection failed"; RESULT="inject-failed"; END_S=$(date +%s); finish_game; return 1
  fi
  echo "write paths blocked: $(unq "$(rjs 'PMZ_AT.blocked()' 5)")"
  ENGINE=$(unq "$(rjs 'Utils.RPGMAKER_NAME+" "+Utils.RPGMAKER_VERSION' 5)")
  GTITLE=$(unq "$(rjs '$dataSystem.gameTitle' 5)" | tr -d '|,')
  local opts="{mode:\"$MODE\",minutes:$MINUTES${AT_SEED:+,seed:$AT_SEED}}"
  echo "driver: $(unq "$(rjs "PMZ_AT.start($opts)" 8)")  engine=$ENGINE"

  # --- monitor loop
  # seeded: the driver's minutes are logic minutes (slower than wall-clock under load), so the wall-clock limit is generous
  START_S=$(date +%s); local limit=$(( MINUTES * 60 + 45 )) peak_base=-1 shots=0 last_peak=0
  [ -n "$AT_SEED" ] && limit=$(( MINUTES * 120 + 120 ))
  local fr_last=-1 fr_since=$START_S ok_last=$START_S wd_seen=0 next_print=0 now el r e cur mm sw av psi tot
  while :; do
    now=$(date +%s); el=$(( now - START_S )); END_S=$now; ELAPSED=$el
    [ $(( el % 30 )) -lt 3 ] && keep_awake
    if ! pidof nw >/dev/null; then
      echo "$(( el * 1000 ))|exit|game process ended" >> "$OUT/events.log"; RESULT="GAME-EXITED"; echo "game process ended at $(mmss $el)"; break
    fi
    r=$(unq "$(rjs 'PMZ_AT.poll()' 6)")
    mm=$(mb $CG/memory.current); sw=$(mb $CG/memory.swap.current)
    av=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
    psi=$(awk '/^full/{for(i=1;i<=NF;i++) if($i ~ /^avg10=/){sub("avg10=","",$i); print $i}}' /proc/pressure/memory 2>/dev/null)
    case "$r" in
      *ph=*@@*)
        ok_last=$now
        parse_status "${r%%@@*}"
        e=${r#*@@}; [ -n "$e" ] && printf '%s\n' "$e" | tr '^' '\n' >> "$OUT/events.log"
        ;;
      *) st_ph=norepl; st_step="no answer from REPL" ;;
    esac
    printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' "$(date +%H:%M:%S)" "$el" "$st_ph" "${st_step//,/ }" "$st_sc" "$st_map" "$mm" "$sw" "${av:-0}" "${psi:-0}" "$st_fps" "$st_gap" "$st_heap" "$st_img" >> "$OUT/timeline.csv"
    # memory peak screenshots (max 5): a new peak of ram+swap more than 50 MB above the last shot
    tot=$(( mm + sw )); [ "$peak_base" -lt 0 ] && peak_base=$tot
    if [ "$tot" -gt $(( peak_base + 50 )) ] && [ "$shots" -lt 5 ]; then
      peak_base=$tot; shots=$(( shots + 1 )); shot "peak${shots}_${tot}MB"
      echo "$(( el * 1000 ))|peakshot|ram+swap=${tot}MB step=${st_step}" >> "$OUT/events.log"
    fi
    # memory guard: end the game before the handheld stalls in swap (sshd and the REPL stop
    # answering long before the kernel or the PocketMZ watchdog acts). Same shape as the watchdog:
    # low MemAvailable only counts while swap is short too (system SwapFree < AT_SWAPFREE MB or game
    # swap > AT_MAX_SWAP - 40); hard limits: MemAvailable < AT_HARD_AVAIL or game swap > AT_MAX_SWAP.
    # (A heavy MZ game sat at avail 120-140 MB with PSI < 10% and swap half free: not a stall.)
    local swf; swf=$(awk '/^SwapFree/{print int($2/1024)}' /proc/meminfo)
    if { [ "${av:-999}" -lt "${AT_MIN_AVAIL:-140}" ] && { [ "${swf:-999}" -lt "${AT_SWAPFREE:-150}" ] || [ "${sw:-0}" -gt $(( ${AT_MAX_SWAP:-400} - 40 )) ]; }; } ||
       [ "${av:-999}" -lt "${AT_HARD_AVAIL:-90}" ] || [ "${sw:-0}" -gt "${AT_MAX_SWAP:-400}" ]; then
      RESULT="LOWMEM(avail=${av}MB swap=${sw}MB)"; echo "memory guard: avail=${av}MB swap=${sw}MB at step $st_step - ending the game"
      echo "$(mmss $el) LOWMEM avail=${av}MB swap=${sw}MB step=$st_step scene=$st_sc map=$st_map" >> "$OUT/hangs.txt"
      echo "$(( el * 1000 ))|LOWMEM|avail=${av}MB swap=${sw}MB step=$st_step" >> "$OUT/events.log"
      kill -9 $(pidof nw) 2>/dev/null; break
    fi
    # run.log: PocketMZ memory watchdog
    cur=$(grep -c "watchdog:" "$L" 2>/dev/null); cur=${cur:-0}
    if [ "$cur" -gt "$wd_seen" ]; then
      echo "$(( el * 1000 ))|watchdog|$(grep 'watchdog:' "$L" | tail -1 | tr '|' ' ')" >> "$OUT/events.log"; wd_seen=$cur
    fi
    WD=$cur
    # progress line every 30 s
    if [ "$el" -ge "$next_print" ]; then
      next_print=$(( el + 30 ))
      echo "[$(mmss $el)] $st_ph ${st_step} | $st_sc map=$st_map | ram+swap=${tot}MB avail=${av}MB psi=${psi}% fps=$st_fps gap=${st_gap}ms heap=${st_heap}MB img=$st_img"
    fi
    # end states reported by the driver
    case "$st_ph" in
      done) RESULT=done; echo "driver finished"; break ;;
      stopped) RESULT=stopped; break ;;
      aborted-user) RESULT="aborted-user"; echo "a person used the handheld - test stopped"; break ;;
      crashed) RESULT="CRASH"; echo "game crashed (engine error), step: $st_step"
        echo "$(mmss $el) CRASH step=$st_step scene=$st_sc map=$st_map" >> "$OUT/hangs.txt"; shot crash; break ;;
    esac
    # hang: REPL silent for 20 s, or no frame drawn for 20 s while the driver runs
    if [ $(( now - ok_last )) -ge 20 ]; then
      RESULT=HANG; echo "HANG: REPL not answering for 20 s (last step: $st_step)"
      echo "$(mmss $el) HANG REPL silent 20s, last step=$st_step scene=$st_sc map=$st_map" >> "$OUT/hangs.txt"
      echo "$(( el * 1000 ))|HANG|REPL silent last step=$st_step" >> "$OUT/events.log"; shot hang; break
    fi
    if [ "$st_fr" != "$fr_last" ]; then fr_last=$st_fr; fr_since=$now
    elif [ $(( now - fr_since )) -ge 20 ] && { [ "$st_ph" = play ] || [ "$st_ph" = tour ] || [ "$st_ph" = init ]; }; then
      RESULT=HANG; echo "HANG: no frame drawn for 20 s (last step: $st_step)"
      echo "$(mmss $el) HANG no frames 20s, last step=$st_step scene=$st_sc map=$st_map" >> "$OUT/hangs.txt"
      echo "$(( el * 1000 ))|HANG|no frames, last step=$st_step" >> "$OUT/events.log"; shot hang; break
    fi
    [ "$el" -ge "$limit" ] && { RESULT="timeout(driver still $st_ph)"; break; }
    [ "$ABORT" = 1 ] && { RESULT=interrupted; break; }
    sleep 2
  done
  OOM_NEW=$(( $(dmesg 2>/dev/null | grep -ci "out of memory") - OOM0 ))
  [ "$OOM_NEW" -gt 0 ] && RESULT="$RESULT+OOM"
  END_S=$(date +%s); ELAPSED=$(( END_S - START_S ))
  finish_game
}

cleanup() { ABORT=1; END_S=$(date +%s); [ "$STARTED" = 1 ] && [ "$ACTIVE" = 0 ] && { $TS stop >/dev/null 2>&1; STARTED=0; }; [ "$ACTIVE" = 1 ] && { RESULT="${RESULT:-interrupted}"; [ "$RESULT" = running ] && RESULT=interrupted; finish_game; }; }
trap 'cleanup; exit 130' INT TERM
trap 'cleanup; rm -f "$RESULTS"' EXIT

# ---------------------------------------------------------------- args
usage() { echo "usage: $0 <launcher.rpgmz | game id> [minutes=15] [play|tour]"; echo "       $0 --all [minutes] [mode]"; exit 2; }
[ -n "$1" ] || usage
ALL=0
if [ "$1" = "--all" ]; then ALL=1; shift; WHAT=; else WHAT="$1"; shift; fi
MINS="${1:-15}"; MODE_ARG="${2:-play}"
case "$MINS" in ''|*[!0-9]*) usage ;; esac
case "$MODE_ARG" in play|tour) ;; *) usage ;; esac
case "$AT_SEED" in *[!0-9]*) echo "AT_SEED must be a number" >&2; exit 2 ;; esac

resolve() {   # launcher path for a path or a game id
  [ -f "$1" ] && { echo "$1"; return; }
  grep -lx "id=$1" /storage/roms/rpgmz/*.rpgmz 2>/dev/null | head -1
}

if [ "$ALL" = 0 ]; then
  PORT=$(resolve "$WHAT"); [ -n "$PORT" ] || { echo "no launcher found for '$WHAT'" >&2; exit 1; }
  run_one "$PORT" "$MINS" "$MODE_ARG"
  exit 0
fi

for PORT in /storage/roms/rpgmz/*.rpgmz; do
  [ -f "$PORT" ] || continue
  [ "$ABORT" = 1 ] && break
  run_one "$PORT" "$MINS" "$MODE_ARG"
  sleep 5
done
echo
echo "== all games (mode $MODE_ARG, ${MINS} min each)"
printf '%-14s %-18s %4s %5s %7s %8s %8s %5s %5s\n' game result min maps battles peakMB lowAvail errs hangs
awk -F'|' '{printf "%-14s %-18s %4s %5s %7s %8s %8s %5s %5s\n",$1,$2,$3,$4,$5,$6,$7,$8,$9}' "$RESULTS"
