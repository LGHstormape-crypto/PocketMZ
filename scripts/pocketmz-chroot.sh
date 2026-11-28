#!/bin/sh
# Mount the Debian chroot used to run RPG Maker MV/MZ games and run a command in it.
# Usage: pocketmz-chroot.sh mount | umount [all] | run <cmd...> | shell
# Root: <program dir>/rootfs.sqfs (read-only image, fast cold start) when present, mounted on
#       <data dir>/root-sqfs (data dir = POCKETMZ_DATA, default /storage/pocketmz),
#       else the maintenance directory /storage/pocketmz/rootfs (POCKETMZ_USE_DIR=1 forces it,
#       use that for apt; then rebuild the image with pocketmz-pack.sh).
# Binds: /root = /storage/pocketmz/home (browser profile, writable), /game = POCKETMZ_GAME (thin copy),
#        /gamesrc = POCKETMZ_SRC (original game, read-only), plus /dev /proc /sys /run /tmp.
# Locale is always C.UTF-8: ES passes LANG=zh_CN.UTF-8, which the chroot does not have ->
# glibc falls back to ASCII and Chromium cannot open files with Japanese names.
# malloc: decode threads (WebAudio, images) grew 64 MB glibc arenas that never shrink (renderer
# anon +60 MB per minute in battles); few arenas + a fixed mmap threshold return big blocks.
PMZ="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"   # program files: rootfs.sqfs
RZ="${POCKETMZ_DATA:-/storage/pocketmz}"                 # data: mount points, home/, rootfs/ (maintenance)
# dev hook: file $RZ/dev-root = "dir" (use the directory) or the path of a test image
[ -f "$RZ/dev-root" ] && { read -r DEVROOT < "$RZ/dev-root"; [ "$DEVROOT" = dir ] && POCKETMZ_USE_DIR=1; }
if [ -n "$DEVROOT" ] && [ "$DEVROOT" != dir ]; then ROOT="$RZ/root-test"; IMAGE="$DEVROOT"
elif [ -n "$POCKETMZ_ROOT" ]; then ROOT="$POCKETMZ_ROOT"
elif [ -f "$PMZ/rootfs.sqfs" ] && [ "$POCKETMZ_USE_DIR" != 1 ]; then ROOT="$RZ/root-sqfs"; IMAGE="$PMZ/rootfs.sqfs"
else ROOT="$RZ/rootfs"; fi

is_mounted() { grep -q " $1 " /proc/mounts; }

bind_to() { # <host dir> <chroot dir> [ro]
  [ -d "$ROOT/$2" ] || mkdir -p "$ROOT/$2"
  is_mounted "$ROOT/$2" && umount "$ROOT/$2"
  mount --bind "$1" "$ROOT/$2"
  [ "$3" = ro ] && mount -o remount,bind,ro "$ROOT/$2"
}

do_mount() {
  if [ -n "$IMAGE" ] && ! is_mounted "$ROOT"; then
    mkdir -p "$ROOT"
    mount -t squashfs -o loop,ro "$IMAGE" "$ROOT" || exit 1
  fi
  for d in dev dev/pts dev/shm proc sys run tmp; do
    [ -d "/$d" ] || continue
    [ -d "$ROOT/$d" ] || mkdir -p "$ROOT/$d" 2>/dev/null || true
    is_mounted "$ROOT/$d" || mount --bind "/$d" "$ROOT/$d" 2>/dev/null || true
  done
  [ -z "$IMAGE" ] && cp -f /etc/resolv.conf "$ROOT/etc/resolv.conf" 2>/dev/null
  mkdir -p "$RZ/home"
  is_mounted "$ROOT/root" || mount --bind "$RZ/home" "$ROOT/root"
  [ -n "$POCKETMZ_GAME" ] && bind_to "$POCKETMZ_GAME" game
  if [ -n "$POCKETMZ_GAME" ] && [ -n "$POCKETMZ_SAVE_DIR" ]; then
    mkdir -p "$POCKETMZ_SAVE_DIR" "$POCKETMZ_GAME/${POCKETMZ_WEB}save"
    bind_to "$POCKETMZ_SAVE_DIR" "game/${POCKETMZ_WEB}save"
  fi
  if [ -n "$POCKETMZ_GAME" ] && [ -n "$POCKETMZ_BACKUP_DIR" ]; then
    mkdir -p "$POCKETMZ_BACKUP_DIR" "$POCKETMZ_GAME/save-backups"
    bind_to "$POCKETMZ_BACKUP_DIR" "game/save-backups"
  fi
  if [ -n "$POCKETMZ_GAME" ] && [ -n "$POCKETMZ_CACHE_DIR" ]; then
    mkdir -p "$POCKETMZ_CACHE_DIR" "$POCKETMZ_GAME/${POCKETMZ_WEB}pmz-cache"
    bind_to "$POCKETMZ_CACHE_DIR" "game/${POCKETMZ_WEB}pmz-cache"
  fi
  [ -n "$POCKETMZ_SRC" ] && bind_to "$POCKETMZ_SRC" gamesrc ro
  return 0
}

do_umount() {
  for r in "$RZ/root-sqfs" "$RZ/root-test" "$RZ/rootfs" "$RZ/beta/rt" "$RZ/beta/root24" "$RZ/beta/root"; do
    for d in game/www/save game/save game/save-backups game/www/pmz-cache game/pmz-cache root gamesrc game tmp run sys proc dev/shm dev/pts dev; do
      is_mounted "$r/$d" && umount -l "$r/$d"
    done
  done
  # The image stays mounted (read-only, costs nothing): its cached pages make the next start
  # faster. "umount all" also detaches it (needed before pocketmz-pack.sh rewrites it).
  [ "$1" = all ] && for r in "$RZ/root-sqfs" "$RZ/root-test"; do is_mounted "$r" && umount -l "$r"; done
  return 0
}

case "$1" in
  mount) do_mount ;;
  umount) do_umount "$2" ;;
  run) shift; do_mount
       # env -i keeps the game environment clean; exported POCKETMZ_* switches (games/<id>/env, tests)
       # go in as NAME=value arguments after the defaults below, so they win
       for n in $(env | sed -n 's/^\(POCKETMZ_[A-Za-z0-9_]*\)=.*/\1/p'); do eval "v=\${$n}"; set -- "$n=$v" "$@"; done
       exec chroot "$ROOT" /usr/bin/env -i HOME=/root PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin \
         MALLOC_ARENA_MAX=2 MALLOC_MMAP_THRESHOLD_=131072 MALLOC_TRIM_THRESHOLD_=131072 \
         POCKETMZ_RENDER_SCALE="${POCKETMZ_RENDER_SCALE:-auto}" POCKETMZ_IMG_SCALE="${POCKETMZ_IMG_SCALE:-auto}" POCKETMZ_UI_LANG="${POCKETMZ_UI_LANG:-zh_CN}" TZ="${TZ:-UTC}" POCKETMZ_DEFAULT_FPS="${POCKETMZ_DEFAULT_FPS:-30}" LANG=C.UTF-8 LC_ALL=C.UTF-8 LANGUAGE="${POCKETMZ_LANG:-ja}" FC_LANG="${POCKETMZ_LANG:-ja}" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/var/run/0-runtime-dir}" \
         WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}" DISPLAY="${DISPLAY:-:0.0}" \
         DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR:-/var/run/0-runtime-dir}/bus" \
         PULSE_SERVER="unix:${XDG_RUNTIME_DIR:-/var/run/0-runtime-dir}/pulse/native" \
         "$@" ;;
  shell) do_mount; exec chroot "$ROOT" /bin/bash -l ;;
  *) echo "usage: $0 mount|umount|run <cmd>|shell" >&2; exit 2 ;;
esac
