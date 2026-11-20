#!/bin/sh
# System memory breakdown every 2 s until <seconds> or the stop file exists.
# Usage: pmz-memsample.sh <out.csv> [seconds=600]
# Columns (MB): avail, anon (AnonPages), shmem, cached (incl. shmem), swap used, GPU GEM resident
# total, then GEM resident of the 3 biggest processes ("name:MB").
OUT="$1"; SECS="${2:-600}"; G=/sys/kernel/debug/dri/1/gems
echo "time,avail,anon,shmem,cached,swap,gem,gem_top" > "$OUT"
end=$(( $(date +%s) + SECS ))
while [ "$(date +%s)" -lt $end ] && [ ! -f "$OUT.stop" ]; do
  m=$(awk '/^MemAvailable/{a=$2} /^AnonPages/{b=$2} /^Shmem:/{c=$2} /^Cached/{d=$2} /^SwapTotal/{t=$2} /^SwapFree/{f=$2}
           END {printf "%d,%d,%d,%d,%d", a/1024, b/1024, c/1024, d/1024, (t-f)/1024}' /proc/meminfo)
  g=$(awk '/^Total size/ {gsub(",",""); for(i=1;i<=NF;i++) if($i=="resident:") r=$(i+1)} END {printf "%d", r/1048576}' $G 2>/dev/null)
  top=$(awk 'NF>=5 && $1 ~ /\// && $5 ~ /^[0-9]+$/ {split($1,a,"/"); s[a[1]]+=$5} END {for (k in s) printf "%d %s\n", s[k]/1048576, k}' $G 2>/dev/null \
        | sort -rn | head -3 | awk '{printf "%s%s:%d", (NR>1?" ":""), $2, $1}')
  echo "$(date +%T),$m,${g:-0},$top" >> "$OUT"
  sleep 2
done
