#!/bin/sh
# Per-process memory of the running NW.js game every N seconds (dev): process type, RSS, anon,
# shmem/file in RSS (from smaps_rollup), swap, plus panfrost GEM resident of nw and MemAvailable.
# Usage: pmz-nwmem.sh <out.csv> [interval=10] [seconds=600]
OUT="$1"; IV="${2:-10}"; SECS="${3:-600}"; G=/sys/kernel/debug/dri/1/gems
echo "time,type,pid,rss_mb,anon_mb,shmem_mb,file_mb,swap_mb" > "$OUT"
end=$(( $(date +%s) + SECS ))
while [ "$(date +%s)" -lt $end ]; do
  t=$(date +%T)
  for p in $(pidof nw); do
    ty=$(tr '\0' '\n' < /proc/$p/cmdline 2>/dev/null | sed -n 's/^--type=//p' | head -1); ty=${ty:-browser}
    awk -v t="$t" -v ty="$ty" -v p="$p" '/^Rss:/{r=$2} /^Pss_Anon:/{a=$2} /^Pss_Shmem:/{s=$2} /^Pss_File:/{f=$2} /^Swap:/{w=$2}
      END {printf "%s,%s,%s,%d,%d,%d,%d,%d\n", t, ty, p, r/1024, a/1024, s/1024, f/1024, w/1024}' /proc/$p/smaps_rollup 2>/dev/null >> "$OUT"
  done
  gem=$(awk 'NF>=5 && $1 ~ /^nw\// {s+=$5} END {printf "%d", s/1048576}' $G 2>/dev/null)
  av=$(awk '/^MemAvailable/{print int($2/1024)}' /proc/meminfo)
  echo "$t,sys,0,0,0,0,0,0,gem=$gem,avail=$av" >> "$OUT"
  pidof nw >/dev/null || break
  sleep "$IV"
done
