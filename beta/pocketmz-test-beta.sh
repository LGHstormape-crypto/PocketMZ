#!/bin/sh
# Device side: start / stop the β runtime (node + pmzrt, run-pmzrun.sh MODE=play) for pocketmz-test.sh / pocketmz-autotest.sh.
# Selected there by POCKETMZ_RUNTIME=beta (POCKETMZ_PROC=node tells the autotest which process to watch). Usage: pocketmz-test-beta.sh start|stop [game id]
# start: copies the game's save folder to /tmp/pmz-save-autotest and points β at the copy (the real save dir is never written; the autotest driver
# blocks writes anyway), runs in a memory cgroup like pocketmz-run.sh, F2 hotkeys and quit combos off, REPL on :9333 (PocketMZ_Debug).
B=/storage/pocketmz/beta; RZ=/storage/pocketmz; ID="$2"   # MZ or MV game (run-pmzrun.sh finds the engine)
[ -n "$ID" ] || { echo "usage: $0 start|stop <game id>" >&2; exit 2; }
L=$RZ/games/$ID/run.log; CG=/sys/fs/cgroup/unified/pocketmz; SAVETMP=/tmp/pmz-save-autotest
export XDG_RUNTIME_DIR=/var/run/0-runtime-dir WAYLAND_DISPLAY=wayland-1 SWAYSOCK=/var/run/0-runtime-dir/sway-ipc.0.sock
case "$1" in
  start)
    [ -d $RZ/games/$ID/game ] || { echo "no thin copy of $ID"; exit 2; }
    SD=$RZ/games/$ID/game/save; [ -d $RZ/games/$ID/game/www ] && SD=$RZ/games/$ID/game/www/save   # MZ: game/save, MV: game/www/save
    [ -n "$(pidof nw)$(pidof node)" ] && { echo "a game (nw/node) is running, abort"; exit 1; }
    if command -v systemctl >/dev/null && systemctl is-enabled essway >/dev/null 2>&1; then
      for i in $(seq 1 60); do [ "$(systemctl is-active essway)" = active ] && break; sleep 1; done
    fi
    MEM_MAX="${POCKETMZ_MEM_MAX:-760}" SWAP_MAX="${POCKETMZ_SWAP_MAX:-420}"
    if grep -qw memory /sys/fs/cgroup/unified/cgroup.subtree_control 2>/dev/null || echo "+memory" > /sys/fs/cgroup/unified/cgroup.subtree_control 2>/dev/null; then
      [ -d "$CG" ] && [ -z "$(cat "$CG/cgroup.procs")" ] && rmdir "$CG"   # fresh peak/events
      mkdir -p "$CG"; echo $((MEM_MAX << 20)) > "$CG/memory.max"; echo $((MEM_MAX << 20)) > "$CG/memory.high"; echo $((SWAP_MAX << 20)) > "$CG/memory.swap.max"; echo 1 > "$CG/memory.oom.group"
      echo $$ > "$CG/cgroup.procs" && echo "cgroup $CG max=${MEM_MAX}M swap=${SWAP_MAX}M"
    fi
    rm -rf $SAVETMP; mkdir -p $SAVETMP; [ -d $SD ] && cp -a $SD/. $SAVETMP/
    echo "$(date +%T) nw start (beta runtime: node + pmzrt)" >> $L
    ( MODE=play PMZ_PATCHES=Handheld,HandheldMV,PluginFixes,Menu,Debug PMZ_NOQUIT=1 POCKETMZ_HOTKEYS=0 SAVE_DIR=$SAVETMP PMZ_GAME_ID=$ID setsid $B/run-pmzrun.sh > $B/pmzrun-play.log 2>&1 & )
    s=$(date +%s)
    for i in $(seq 1 120); do sleep 1
      [ "$(curl -s -m 3 --data-binary 'SceneManager._scene&&SceneManager._scene.constructor.name' 127.0.0.1:9333 2>/dev/null | tr -d ' \r\n')" = '"Scene_Title"' ] && break
    done
    echo "title after $(( $(date +%s) - s ))s" ;;
  stop)
    kill $(pidof node) 2>/dev/null; sleep 2; kill -9 $(pidof node) 2>/dev/null; sleep 1
    rm -f /storage/pocketmz/dev   # pocketmz-autotest.sh turns on α dev mode at start; β does not use it, do not leave it behind
    echo "cgroup peak: $(cat "$CG/memory.peak" 2>/dev/null) events: $(tr '\n' ' ' < "$CG/memory.events" 2>/dev/null)" >> $L
    grep -E "cgroup|exit|内存" $L | tail -3 ;;
  *) echo "usage: $0 start|stop [game id]"; exit 2 ;;
esac
