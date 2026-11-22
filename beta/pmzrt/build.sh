#!/bin/sh
# Runs inside the beta overlay (chroot): builds pmzrt.node next to pmzrt.c
cd "$(dirname "$0")" && gcc -O2 -Wall -Wno-unused-function -Wno-unused-variable -shared -fPIC -I/usr/include/node pmzrt.c $(pkg-config --cflags glesv2) $(pkg-config --cflags --libs sdl2 libpng libjpeg libwebp cairo pangocairo fontconfig freetype2 vorbisfile) -lm -o pmzrt.node
