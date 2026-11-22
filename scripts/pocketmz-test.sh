#!/bin/sh
# Dev helper: start the game through the real port launcher, then sample memory.
# Usage: pocketmz-test.sh start            launch (background), wait for Scene_Title
#        pocketmz-test.sh js '<code>'      run JS in the game (PocketMZ_Debug REPL)
#        pocketmz-test.sh mem [label]      one line: cgroup RAM/swap/peak, MemAvailable, scene, fps, heap
#        pocketmz-test.sh shot <name>      screenshot to /tmp/<name>.png
#        pocketmz-test.sh stop             kill the game (launcher cleans up)
# start turns on dev mode (/storage/pocketmz/dev); remove that file afterwards for normal play.
# game: POCKETMZ_TEST_PORT=<launcher .rpgmz or Ports .sh>, or POCKETMZ_TEST_ID=<game id> (its launcher)
# POCKETMZ_TEST_VIA_ES=0: start directly instead of through the ES launch API
PORT="$POCKETMZ_TEST_PORT"
[ -z "$PORT" ] && PORT=$(grep -lx "id=$POCKETMZ_TEST_ID" /storage/roms/rpgmz/*.rpgmz 2>/dev/null | head -1)
[ -z "$PORT" ] && PORT=$(grep -l "^# pocketmz: $POCKETMZ_TEST_ID" /storage/roms/ports/*.sh 2>/dev/null | head -1)
[ -n "$PORT" ] || { echo "set POCKETMZ_TEST_PORT=<launcher> or POCKETMZ_TEST_ID=<game id>" >&2; exit 2; }
TID=$(sed -n 's/^# pocketmz: //p; s/^id=//p' "$PORT" | head -1); TID="${TID:-$POCKETMZ_TEST_ID}"
CG=/sys/fs/cgroup/unified/pocketmz
# POCKETMZ_RUNTIME=beta: start / stop the β runtime (node + pmzrt, beta/pocketmz-test-beta.sh) instead of the NW.js launcher; everything else (js, mem, shot) is the same
[ "$POCKETMZ_RUNTIME" = beta ] && case "$1" in start|stop) exec /storage/pocketmz/beta/pocketmz-test-beta.sh "$1" "$TID" ;; esac
export XDG_RUNTIME_DIR=/var/run/0-runtime-dir WAYLAND_DISPLAY=wayland-1 SWAYSOCK=/var/run/0-runtime-dir/sway-ipc.0.sock
js() { curl -s -m "${T:-15}" --data-binary "$1" 127.0.0.1:9333; }
mb() { [ -f "$1" ] && echo $(( $(cat "$1") >> 20 )) || echo -; }
case "$1" in
  start)
    touch /storage/pocketmz/dev   # tests need the PocketMZ_Debug REPL (rm /storage/pocketmz/dev = release copy again)
    kill $(pidof nw) 2>/dev/null; sleep 1; kill -9 $(pidof nw) 2>/dev/null; sleep 1
    for i in $(seq 1 60); do [ "$(systemctl is-active essway)" = active ] && curl -s -m 2 127.0.0.1:1234/runningGame >/dev/null && break; sleep 1; done; sleep 5
    # same path as the user: ES -> runemu -> port script (falls back to a direct start)
    # ES sometimes accepts /launch and does nothing (seen once after idling): retry, then start directly
    # only the launcher's own process (not a shell whose command line merely mentions it)
    launched() { pidof nw >/dev/null || pgrep -f "^/bin/bash /storage/pocketmz/pocketmz-run.sh" >/dev/null; }
    VIA_ES=${POCKETMZ_TEST_VIA_ES:-1}   # a .rpgmz launcher goes through ES only when ES has the RPGMZ system
    case "$PORT" in *.rpgmz) grep -qs "<name>rpgmz</name>" /storage/.config/emulationstation/es_systems_*.cfg       /usr/config/emulationstation/es_systems*.cfg || VIA_ES=0 ;; esac
    [ $VIA_ES = 1 ] && for try in 1 2; do
      curl -s -m 5 -X POST --data-binary "$PORT" http://127.0.0.1:1234/launch >/dev/null
      for i in $(seq 1 15); do launched && break 2; sleep 1; done
      echo "ES did not launch (try $try)"
    done
    if ! launched; then
      case "$PORT" in *.rpgmz) ( setsid /storage/pocketmz/pocketmz-run.sh "$PORT" >/dev/null 2>&1 & ) ;; *) ( setsid "$PORT" >/dev/null 2>&1 & ) ;; esac
    fi
    s=$(date +%s)
    for i in $(seq 1 90); do sleep 1
      [ "$(T=3 js 'SceneManager._scene&&SceneManager._scene.constructor.name' 2>/dev/null)" = '"Scene_Title"' ] && break
    done
    echo "title after $(( $(date +%s) - s ))s" ;;
  js) T="${T:-60}" js "$2"; echo ;;
  mem)
    i=$(T=5 js '(()=>{const d=PMZ_DEBUG.info();return d.scene+" map="+d.map+" fps="+d.fps+" heap="+d.heapMB+" img="+d.imgCache})()' 2>/dev/null | tr -d '"')
    echo "$2 ram=$(mb $CG/memory.current) swap=$(mb $CG/memory.swap.current) peak=$(mb $CG/memory.peak) avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo) zram=$(awk 'NR==2{print int($4/1024)}' /proc/swaps) | ${i:-no-repl}" ;;
  shot) grim "/tmp/$2.png" ;;
  stop) kill $(pidof nw) 2>/dev/null; sleep 2; kill -9 $(pidof nw) 2>/dev/null; sleep 2
        grep -E "cgroup|exit|内存" /storage/pocketmz/games/$TID/run.log ;;
esac
