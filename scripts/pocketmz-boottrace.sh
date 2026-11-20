#!/bin/sh
# Dev: trace NW.js startup every 0.5 s: CPU time and disk reads of all nw processes, and
# which threads are running / waiting on IO. Usage: pocketmz-boottrace.sh [secs]  (game must be stopped)
T=/storage/pocketmz/pocketmz-test.sh
( $T start >/dev/null 2>&1 & )
end=$(( $(date +%s) + ${1:-35} ))
while [ "$(date +%s)" -lt "$end" ]; do
  up=$(cut -d' ' -f1 /proc/uptime); cpu=0; rd=0; st=""
  for p in $(pidof nw); do
    set -- $(cut -d' ' -f14,15 /proc/$p/stat 2>/dev/null); cpu=$((cpu + ${1:-0} + ${2:-0}))
    rd=$((rd + $(awk '/^read_bytes/{print $2}' /proc/$p/io 2>/dev/null || echo 0)))
    for t in /proc/$p/task/*; do
      s=$(awk '{print $3}' $t/stat 2>/dev/null)
      [ "$s" = R ] || [ "$s" = D ] && st="$st $(cat $t/comm 2>/dev/null | tr ' ' _):$s"
    done
  done
  echo "$up procs=$(pidof nw | wc -w) cpu_ticks=$cpu readMB=$((rd >> 20)) io=$(awk '{print $4}' /proc/pressure/io 2>/dev/null | head -1) |$st"
  sleep 0.5
done
