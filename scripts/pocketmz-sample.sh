#!/bin/sh
# Read-only sampler while the user plays: per-thread CPU of the NW.js processes, game frame
# stats (10 s windows through the PocketMZ_Debug REPL), temperature and memory.
# Usage: pocketmz-sample.sh [windows=12]
N="${1:-12}"
T=/storage/pocketmz/pocketmz-test.sh
CG=/sys/fs/cgroup/unified/pocketmz
HZ=100
pids() { for p in $(pidof nw) $(pgrep -f -- "/proc/self/exe --type"); do echo $p; done | sort -u; }
kind() { tr '\0' ' ' < /proc/$1/cmdline 2>/dev/null | grep -o -- "--type=[a-z]*\|--utility-sub-type=[a-z.]*" | tail -1 | sed 's/--type=//;s/--utility-sub-type=//'; }
snap() { for p in $(pids); do k=$(kind $p); k=${k:-browser}; for t in /proc/$p/task/*; do
  awk -v k="$k" -v n="$(cat $t/comm 2>/dev/null | tr ' ' '_')" '{print k"/"n, $14+$15}' $t/stat 2>/dev/null; done; done; }
PROF='new Promise(res=>{const r=Graphics.app.renderer,r0=r.render,u0=SceneManager.updateMain;let rt=0,rn=0,ut=0,un=0,gap=0,h=0,last=performance.now();r.render=function(){const a=performance.now();try{return r0.apply(this,arguments)}finally{rt+=performance.now()-a;rn++}};SceneManager.updateMain=function(){const a=performance.now();const g=a-last;last=a;if(g>50)h++;gap=Math.max(gap,g);try{return u0.apply(this,arguments)}finally{ut+=performance.now()-a;un++}};setTimeout(()=>{r.render=r0;SceneManager.updateMain=u0;res("map="+$gameMap.mapId()+" "+($dataMapInfos[$gameMap.mapId()]||{}).name+" scene="+SceneManager._scene.constructor.name+" logic="+Math.round(un/10)+"/s draw="+Math.round(rn/10)+"/s upd="+(ut/un).toFixed(1)+"ms render="+(rt/rn).toFixed(1)+"ms hitches="+h+" worst="+Math.round(gap)+"ms")},10000)})'
for i in $(seq 1 "$N"); do
  pidof nw >/dev/null || { echo "game not running"; exit 0; }
  snap > /tmp/s0; T=20 $T js "$PROF" > /tmp/sg & sleep 10; snap > /tmp/s1; wait
  echo "== $(date +%T) $(tr -d '"\n' < /tmp/sg) | t=$(( $(cat /sys/class/thermal/thermal_zone0/temp)/1000 ))C f=$(( $(cat /sys/devices/system/cpu/cpufreq/policy0/scaling_cur_freq)/1000 )) mem=$(( ($(awk '$1=="anon"{print $2}' $CG/memory.stat) + $(cat $CG/memory.swap.current)) >> 20 ))MB"
  # CPU % per process kind and the busiest threads (100 % = one core)
  awk -v hz=$HZ 'NR==FNR{a[$1]+=$2; next} {b[$1]+=$2} END{for(k in b){d=(b[k]-a[k])/hz*10; split(k,s,"/"); P[s[1]]+=d; if(d>=3) printf "   %5.0f%%  %s\n", d, k} for(p in P) printf "  [%s %d%%]\n", p, P[p]}' /tmp/s0 /tmp/s1 | sort -t% -k1 -rn | sort -s -k1,1r
done
