#!/bin/sh
# Runs inside the beta overlay (chroot): builds pmzrt.node next to pmzrt.c
# Uses slim decode-only FFmpeg under /opt/beta/ffmpeg when installed (with $ORIGIN RPATH),
# falling back to system Debian FFmpeg packages otherwise.
cd "$(dirname "$0")" || exit 1
FF_PC=""
FF_RPATH=""
if [ -d /opt/beta/ffmpeg/lib/pkgconfig ]; then
  FF_PC="PKG_CONFIG_PATH=/opt/beta/ffmpeg/lib/pkgconfig"
  FF_RPATH='-Wl,--disable-new-dtags,-rpath,$ORIGIN/../ffmpeg/lib'
fi
FF_FLAGS=$(eval "$FF_PC pkg-config --cflags --libs libavformat libavcodec libswresample libswscale libavutil") || exit 1
gcc -O2 -Wall -Wno-unused-function -Wno-unused-variable -shared -fPIC -I/usr/include/node pmzrt.c \
  $(pkg-config --cflags glesv2) \
  $(pkg-config --cflags --libs sdl2 libpng libjpeg libwebp cairo pangocairo fontconfig freetype2 vorbisfile) \
  $FF_FLAGS $FF_RPATH -lm -o pmzrt.node
