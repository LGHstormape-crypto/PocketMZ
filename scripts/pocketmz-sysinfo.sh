#!/bin/sh
# SPDX-License-Identifier: MIT
# Read-only environment probe for PocketMZ community porting & bug reports.
# Usage: sh pocketmz-sysinfo.sh [output_file]
# Strictly read-only: never writes system files or touches i2c-0.

OUT="${1:-}"
if [ -z "$OUT" ] && [ -n "${POCKETMZ_LOGDIR:-}" ] && [ -d "${POCKETMZ_LOGDIR:-}" ]; then
  OUT="$POCKETMZ_LOGDIR/pocketmz-sysinfo.txt"
fi

emit_report() {
  echo "=== PocketMZ sysinfo $(date 2>/dev/null || echo unknown) ==="
  echo "uid=$(id -u 2>/dev/null) user=$(id -un 2>/dev/null) pwd=$(pwd)"
  echo "uname=$(uname -a 2>/dev/null)"
  if [ -r /etc/os-release ]; then
    echo "--- /etc/os-release ---"
    grep -E '^(NAME|PRETTY_NAME|VERSION|VERSION_ID|ID|BUILD_ID)=' /etc/os-release 2>/dev/null || true
  fi

  echo "--- CPU & Memory ---"
  echo "online=$(cat /sys/devices/system/cpu/online 2>/dev/null || echo unknown)"
  if [ -r /proc/cpuinfo ]; then
    grep -E '^(Hardware|Model|model name|Processor|CPU architecture|BogoMIPS)' /proc/cpuinfo 2>/dev/null | head -n 12 || true
    echo "cpu_cores=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo unknown)"
  fi
  command -v free >/dev/null 2>&1 && free -m 2>/dev/null || true
  if [ -r /proc/meminfo ]; then
    grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null || true
  fi

  echo "--- Kernel Capabilities & Storage ---"
  [ -r /proc/filesystems ] && echo "filesystems=$(awk '{print $NF}' /proc/filesystems 2>/dev/null | tr '\n' ' ')"
  for cg in /sys/fs/cgroup/unified /sys/fs/cgroup; do
    [ -r "$cg/cgroup.controllers" ] && echo "cgroup_v2($cg)=$(cat "$cg/cgroup.controllers" 2>/dev/null)"
  done
  [ -r /proc/pressure/memory ] && echo "psi_memory=$(head -n 2 /proc/pressure/memory 2>/dev/null | tr '\n' ' ')" || echo "psi_memory=unavailable"
  for cmd in unshare mount umount chroot python3 readelf od tar awk; do
    if command -v "$cmd" >/dev/null 2>&1; then
      echo "cmd:$cmd=$(command -v "$cmd")"
    else
      echo "cmd:$cmd=missing"
    fi
  done
  df -h / /storage /roms /mnt/mmc /mnt/sdcard 2>/dev/null | awk 'NR==1 || !seen[$0]++' || df -h 2>/dev/null || true

  echo "--- Display, GPU & Input Nodes ---"
  echo "env DISPLAY=${DISPLAY:-} WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-} XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-} SDL_VIDEODRIVER=${SDL_VIDEODRIVER:-} LD_LIBRARY_PATH=${LD_LIBRARY_PATH:-}"
  ls -la /dev/dri /dev/mali* /dev/pvr* /dev/fb* /dev/input/event* 2>/dev/null || true
  for m in panfrost lima etnaviv mali mali_kbase bifrost midgard pvrsrvkm; do
    [ -d "/sys/module/$m" ] && echo "module_loaded=$m"
  done
  for b in panfrost lima etnaviv mali; do
    [ -d "/sys/bus/platform/drivers/$b" ] && echo "platform_driver=$b"
  done

  echo "--- Host GL & SDL2 Libraries ---"
  elf_cls() {
    command -v od >/dev/null 2>&1 || { echo "?"; return; }
    case "$(od -An -tx1 -N5 "$1" 2>/dev/null | tr -d ' \n')" in
      7f454c4602) echo "ELF64" ;;
      7f454c4601) echo "ELF32" ;;
      *) echo "non-ELF" ;;
    esac
  }
  for d in /mnt/vendor/lib64 /mnt/vendor/lib /usr/lib /usr/lib/aarch64-linux-gnu /usr/lib/mali /usr/lib64 /lib /lib/aarch64-linux-gnu /roms/ports/PortMaster/libs.aarch64 /roms/ports/PortMaster/libs /opt/system/Tools/PortMaster/libs.aarch64 /mnt/mmc/Roms/PORTS/PortMaster/libs.aarch64; do
    [ -d "$d" ] || continue
    for pat in "libEGL.so*" "libGLESv2.so*" "libSDL2*.so*" "libmali*.so*" "libMali*.so*" "libPVR*.so*" "libIMG*.so*" "libgbm.so*" "libump.so*" "libion.so*"; do
      for f in "$d"/$pat; do
        [ -e "$f" ] || [ -L "$f" ] || continue
        real="$(readlink -f "$f" 2>/dev/null || echo "$f")"
        cls="missing"
        [ -f "$real" ] && cls="$(elf_cls "$real")"
        echo "lib: $f -> $real ($cls)"
        if [ "$cls" = "ELF64" ] && command -v readelf >/dev/null 2>&1; then
          case "${f##*/}" in
            libEGL.so.1|libGLESv2.so.2|libSDL2-2.0.so.0)
              deps=$(readelf -d "$real" 2>/dev/null | awk -F'[][]' '/NEEDED/ {printf "%s ", $2}')
              [ -n "$deps" ] && echo "  NEEDED: $deps"
              ;;
          esac
        fi
      done
    done
  done

  echo "--- Audio & Controller ---"
  [ -r /proc/asound/cards ] && cat /proc/asound/cards 2>/dev/null || true
  command -v aplay >/dev/null 2>&1 && aplay -l 2>/dev/null | head -n 20 || true
  for f in /roms/ports/PortMaster/control.txt /opt/system/Tools/PortMaster/control.txt /mnt/mmc/Roms/PORTS/PortMaster/control.txt /roms/ports/PortMaster/gamecontrollerdb.txt /opt/system/Tools/PortMaster/gamecontrollerdb.txt /mnt/mmc/Roms/PORTS/PortMaster/gamecontrollerdb.txt /storage/.config/SDL-GameControllerDB/gamecontrollerdb.txt; do
    [ -f "$f" ] && echo "pm_file=$f"
  done

  echo "--- PocketMZ State ---"
  RZ="${POCKETMZ_DATA:-/storage/pocketmz}"
  echo "POCKETMZ_DATA=$RZ POCKETMZ_ROMS=${POCKETMZ_ROMS:-}"
  [ -f "$RZ/VERSION" ] && echo "installed_version=$(cat "$RZ/VERSION" 2>/dev/null)"
  for lg in "$POCKETMZ_PKG/pocketmz-last.log" "$POCKETMZ_LOGDIR/menu.log" "$POCKETMZ_LOGDIR/last-game-run.log"; do
    if [ -n "$lg" ] && [ -f "$lg" ]; then
      echo "--- tail $lg ---"
      tail -n 25 "$lg" 2>/dev/null || true
    fi
  done
}

if [ -n "$OUT" ]; then
  emit_report | tee "$OUT"
else
  emit_report
fi
