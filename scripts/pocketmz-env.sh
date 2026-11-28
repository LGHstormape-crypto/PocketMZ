#!/bin/sh
# SPDX-License-Identifier: MIT
# Shared environment detection for ROCKNIX & PortMaster / Anbernic Stock OS.
# Exports: POCKETMZ_DATA, POCKETMZ_ROMS, POCKETMZ_SAVE_BASE, POCKETMZ_PKG, POCKETMZ_LOGDIR, ESUDO

[ -n "$_PMZ_ENV_DONE" ] && return 0 2>/dev/null || true
_PMZ_ENV_DONE=1

pmz_detect_esudo() {
  if [ "$(id -u 2>/dev/null)" = 0 ]; then
    ESUDO=""
  elif [ -n "$ESUDO" ]; then
    :
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    ESUDO="sudo -n"
  else
    ESUDO=""
  fi
  export ESUDO
}

pmz_can_symlink() {
  local d="$1" t
  mkdir -p "$d" 2>/dev/null || return 1
  t="$d/.pmz_ln_$$"
  if ln -s . "$t" 2>/dev/null; then
    rm -f "$t"
    return 0
  fi
  rm -f "$t" 2>/dev/null
  return 1
}

pmz_free_mb() {
  df -Pm "$1" 2>/dev/null | awk 'NR==2 {print $4}'
}

pmz_detect_roms() {
  if [ -n "$POCKETMZ_ROMS" ] && [ -d "$POCKETMZ_ROMS" ]; then
    export POCKETMZ_ROMS
    return 0
  fi
  local c sub
  # Prefer any candidate that already contains rpgmaker games
  for c in "${PORTS_PARENT:-}" /mnt/sdcard/Roms /mnt/sdcard/roms /mnt/mmc/Roms /mnt/mmc/roms /roms /storage/roms; do
    [ -n "$c" ] && [ -d "$c" ] || continue
    for sub in rpgmaker RPGMAKER RpgMaker; do
      if [ -d "$c/$sub" ] && [ -n "$(ls -A "$c/$sub" 2>/dev/null)" ]; then
        POCKETMZ_ROMS="$c"
        export POCKETMZ_ROMS
        return 0
      fi
    done
  done
  # Next, prefer PORTS_PARENT (on ROCKNIX it is already /storage/roms; on Stock OS it is /mnt/mmc/Roms)
  for c in "${PORTS_PARENT:-}" /mnt/sdcard/Roms /mnt/sdcard/roms /mnt/mmc/Roms /mnt/mmc/roms /roms /storage/roms; do
    [ -n "$c" ] && [ -d "$c" ] || continue
    if [ -d "$c/rpgmaker" ] || [ -d "$c/RPGMAKER" ] || [ -d "$c/ports" ] || [ -d "$c/PORTS" ] || [ -d "$c/Ports" ]; then
      POCKETMZ_ROMS="$c"
      export POCKETMZ_ROMS
      return 0
    fi
  done
  POCKETMZ_ROMS="${PORTS_PARENT:-/storage/roms}"
  export POCKETMZ_ROMS
}

pmz_detect_data() {
  if [ -n "$POCKETMZ_DATA" ] && pmz_can_symlink "$POCKETMZ_DATA"; then
    export POCKETMZ_DATA
    return 0
  fi
  local c free
  for c in /storage/pocketmz "${HOME:-/root}/.pocketmz" /userdata/pocketmz /opt/pocketmz /var/lib/pocketmz; do
    [ -n "$c" ] || continue
    if [ -d "$c/games" ] && pmz_can_symlink "$c"; then
      free=$(pmz_free_mb "$c")
      if [ "${free:-0}" -ge 120 ] 2>/dev/null || [ -f "$c/beta-runtime.sqfs" ]; then
        POCKETMZ_DATA="$c"
        export POCKETMZ_DATA
        return 0
      fi
    fi
  done
  for c in /storage/pocketmz "${HOME:-/root}/.pocketmz" /userdata/pocketmz /opt/pocketmz /var/lib/pocketmz; do
    [ -n "$c" ] || continue
    local parent
    parent=$(dirname "$c")
    [ -d "$parent" ] || [ "$parent" = "/storage" ] || continue
    if pmz_can_symlink "$c"; then
      free=$(pmz_free_mb "$c")
      if [ "${free:-0}" -ge 180 ] 2>/dev/null; then
        POCKETMZ_DATA="$c"
        export POCKETMZ_DATA
        return 0
      fi
    fi
  done
  # If no POSIX-symlink filesystem is available:
  # - β runtime uses VFS and needs NO symlinks or 512 MB ext4 loop image, so a plain SD-card dir works.
  # - Only create/mount the 512 MB ext4 loop image when NW.js (rootfs.sqfs) or POCKETMZ_NEED_SYMLINKS=1 is present.
  local need_symlinks="${POCKETMZ_NEED_SYMLINKS:-0}"
  if [ "$need_symlinks" != 1 ] && [ -n "$POCKETMZ_PKG" ]; then
    [ -f "$POCKETMZ_PKG/rootfs.sqfs" ] && need_symlinks=1
  fi
  if [ "$need_symlinks" != 1 ] && [ -n "$POCKETMZ_PKG" ] && [ -d "$POCKETMZ_PKG" ]; then
    free=$(pmz_free_mb "$POCKETMZ_PKG")
    if [ "${free:-0}" -ge 180 ] 2>/dev/null; then
      mkdir -p "$POCKETMZ_PKG/data" 2>/dev/null || true
      if [ -d "$POCKETMZ_PKG/data" ]; then
        POCKETMZ_DATA="$POCKETMZ_PKG/data"
        export POCKETMZ_DATA
        return 0
      fi
    fi
  fi
  # Fallback for NW.js on Stock OS with tiny rootfs and exFAT SD card: loop-mounted ext4 image on SD card
  if [ -n "$POCKETMZ_PKG" ] && [ -d "$POCKETMZ_PKG" ]; then
    local img="$POCKETMZ_PKG/pocketmz-data.img" mnt="/tmp/pmz-data"
    if grep -q " $mnt " /proc/mounts 2>/dev/null; then
      POCKETMZ_DATA="$mnt"
      export POCKETMZ_DATA
      return 0
    fi
    if [ ! -f "$img" ] && command -v mkfs.ext4 >/dev/null 2>&1; then
      free=$(pmz_free_mb "$POCKETMZ_PKG")
      if [ "${free:-0}" -ge 600 ] 2>/dev/null; then
        if command -v truncate >/dev/null 2>&1; then
          truncate -s 512M "$img" && mkfs.ext4 -F -q "$img"
        else
          dd if=/dev/zero of="$img" bs=1M count=1 seek=511 2>/dev/null && mkfs.ext4 -F -q "$img"
        fi
      fi
    fi
    if [ -f "$img" ]; then
      $ESUDO mkdir -p "$mnt" 2>/dev/null || mkdir -p "$mnt" 2>/dev/null
      if $ESUDO mount -o loop "$img" "$mnt" 2>/dev/null || mount -o loop "$img" "$mnt" 2>/dev/null; then
        $ESUDO chmod 777 "$mnt" 2>/dev/null || true
        POCKETMZ_DATA="$mnt"
        export POCKETMZ_DATA
        return 0
      fi
    fi
  fi
  # Last resort: tmpfs /tmp/pocketmz (POSIX symlinks work, though not persistent across reboot)
  POCKETMZ_DATA="/tmp/pocketmz"
  mkdir -p "$POCKETMZ_DATA" 2>/dev/null || true
  export POCKETMZ_DATA
}

pmz_detect_esudo
pmz_detect_roms
pmz_detect_data
if [ -z "$POCKETMZ_SAVE_BASE" ]; then
  if [ -d "$POCKETMZ_ROMS" ]; then
    POCKETMZ_SAVE_BASE="$POCKETMZ_ROMS/savestates/rpgmz"
  else
    POCKETMZ_SAVE_BASE="/storage/roms/savestates/rpgmz"
  fi
  export POCKETMZ_SAVE_BASE
fi
