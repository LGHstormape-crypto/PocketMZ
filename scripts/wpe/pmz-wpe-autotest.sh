#!/bin/sh
# PocketMZ WPE prototype: play a game in cog (WPE WebKit) with the PocketMZ auto-test driver and
# record a timeline in the same columns as pocketmz-autotest.sh (ram = PSS of cog + WebKit procs).
# Usage: pmz-wpe-autotest.sh <thin copy game dir> <original game dir> [minutes=5] [out dir]
G="$1"; SRCDIR="$2"; MIN="${3:-5}"; OUT="${4:-/storage/pocketmz/wpe/runs/at-$(date +%Y%m%d-%H%M%S)}"
HERE="$(cd "$(dirname "$0")" && pwd)"
AT="${PMZ_WPE_AUTOTEST:-/storage/pocketmz/pocketmz-autotest.js}"
mkdir -p "$OUT"
rjs() { curl -s -m "${2:-15}" --data-binary "$1" 127.0.0.1:9333 | tr -d '\r'; }
unq() { s="$1"; s=${s#\"}; s=${s%\"}; printf '%s' "$s"; }
"$HERE/pmz-wpe-stop.sh"
PMZ_WPE_SRC="$SRCDIR" setsid sh "$HERE/pmz-wpe-run.sh" "$G" $(( MIN * 60 + 120 )) "$OUT" > "$OUT/run.out" 2>&1 &
# wait for the title (or any scene past boot)
T0=$(date +%s)
while :; do
  sleep 2
  sc=$(unq "$(rjs 'SceneManager._scene?SceneManager._scene.constructor.name:""' 5)")
  case "$sc" in Scene_Title|Scene_Map) break ;; esac
  [ $(( $(date +%s) - T0 )) -gt 90 ] && { echo "no title after 90 s (scene='$sc')"; "$HERE/pmz-wpe-stop.sh"; exit 1; }
done
echo "boot to $sc: $(( $(date +%s) - T0 )) s"
curl -s -m 30 --data-binary @"$AT" 127.0.0.1:9333 >/dev/null
[ "$(unq "$(rjs 'typeof PMZ_AT' 5)")" = object ] || { echo "driver injection failed"; "$HERE/pmz-wpe-stop.sh"; exit 1; }
echo "blocked: $(unq "$(rjs 'PMZ_AT.blocked()' 5)")"
echo "driver: $(unq "$(rjs "PMZ_AT.start({mode:\"play\",minutes:$MIN})" 8)")"
echo "time,elapsed_s,phase,step,scene,map,ram_mb,swap_mb,avail_mb,psi_full10,fps,worst_gap_ms,heap_mb,img_keys_mpx" > "$OUT/timeline.csv"
S0=$(date +%s)
while :; do
  sleep 2
  el=$(( $(date +%s) - S0 ))
  pidof cog >/dev/null || { echo "$((el*1000))|exit|cog ended" >> "$OUT/events.log"; echo "cog ended at ${el}s"; break; }
  r=$(unq "$(rjs 'PMZ_AT.poll()' 6)")
  m=$(tail -1 "$OUT/mem.csv")   # time,pss,swap,avail,procs
  pss=$(echo "$m" | cut -d, -f2); sw=$(echo "$m" | cut -d, -f3); av=$(echo "$m" | cut -d, -f4)
  psi=$(awk '/^full/{for(i=1;i<=NF;i++) if($i ~ /^avg10=/){sub("avg10=","",$i); print $i}}' /proc/pressure/memory)
  st=${r%%@@*}; ev=${r#*@@}
  [ "$ev" != "$r" ] && [ -n "$ev" ] && printf '%s\n' "$ev" | tr '^' '\n' >> "$OUT/events.log"
  g() { printf '%s' "$st" | tr ';' '\n' | sed -n "s/^$1=//p" | head -1 | tr -d ','; }
  ph=$(g ph)
  echo "$(date +%T),$el,$ph,$(g step),$(g sc),$(g map),$pss,$sw,$av,$psi,$(g fps),$(g gap),$(g heap),$(g img)" >> "$OUT/timeline.csv"
  case "$ph" in done|aborted*|crashed) break ;; esac
  [ "$el" -gt $(( MIN * 60 + 60 )) ] && break
  [ "${av:-999}" -lt 140 ] && { echo "$((el*1000))|lowmem|avail=${av}MB" >> "$OUT/events.log"; echo "LOWMEM"; break; }
done
unq "$(rjs 'PMZ_AT.errors()' 6)" | tr '^' '\n' > "$OUT/errors.txt"
rjs 'PMZ_AT.report()' 6 > "$OUT/report.json"
rjs 'PMZ_AT.stop()' 4 >/dev/null
"$HERE/pmz-wpe-stop.sh"
# summary
awk -F, 'NR>1 { n++; if ($5=="Scene_Map" && $11>0) {mf+=$11; mn++}; t=$7+$8; if (t>pk) {pk=t; pkr=$7; pks=$8}; if (mina==""||$9<mina) mina=$9; if ($10>psi) psi=$10 }
  END { printf "samples %d  map fps avg %.1f  peak pss+swap %d MB (pss %d + swap %d)  min avail %d MB  max psi full %.2f\n", n, mn?mf/mn:0, pk, pkr, pks, mina, psi }' "$OUT/timeline.csv" | tee "$OUT/summary.txt"
grep -h "|scene|\|map|" "$OUT/events.log" 2>/dev/null | sed -n 's/.*ms=\([0-9]*\).*/\1/p' | sort -n | awk '{a[NR]=$1} END {if (NR) printf "scene/map changes %d  median %d ms  max %d ms\n", NR, a[int((NR+1)/2)], a[NR]}' | tee -a "$OUT/summary.txt"
grep -h "textbench" "$OUT/probe.log" | cut -d' ' -f2- | tee -a "$OUT/summary.txt"
echo "out: $OUT"
