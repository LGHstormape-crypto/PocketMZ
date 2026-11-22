#!/bin/bash
# SPDX-License-Identifier: MIT
# Cross-compile minimal aarch64 Debian-trixie-ABI dependencies inside a debian:trixie (amd64) container:
#   1) Decode-only FFmpeg 7.1 (0 external codec deps) -> /work/out/ffmpeg (install to /opt/beta/ffmpeg)
#   2) LLVM-free panfrost-only Mesa 25.0.7            -> /work/out/mesa   (install to /storage/pocketmz/mesa-panfrost)
#
# Usage on an x86_64 Linux build host with podman or docker:
#   mkdir -p ~/pmz-slim-build && cp build-slim-deps.sh ~/pmz-slim-build/build.sh
#   podman run --rm -v ~/pmz-slim-build:/work:Z docker.io/library/debian:trixie bash /work/build.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
JOBS=$(nproc)

echo "=== [1/4] Enable deb-src + arm64 multiarch ==="
sed -i 's/^Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/debian.sources
dpkg --add-architecture arm64
apt-get update -qq

echo "=== [2/4] Install cross-toolchain & arm64 build deps ==="
apt-get install -y -qq --no-install-recommends \
  ca-certificates dpkg-dev build-essential crossbuild-essential-arm64 \
  pkg-config pkgconf-bin meson ninja-build python3 python3-mako python3-yaml python3-packaging \
  bison flex libwayland-bin \
  zlib1g-dev:arm64 libzstd-dev:arm64 libexpat1-dev:arm64 \
  libdrm-dev:arm64 libwayland-dev:arm64 libwayland-egl-backend-dev:arm64 \
  wayland-protocols libglvnd-dev:arm64 libelf-dev:arm64

mkdir -p /build /work/out/ffmpeg /work/out/mesa

cat >/build/cross-arm64.ini <<'EOF'
[binaries]
c = 'aarch64-linux-gnu-gcc'
cpp = 'aarch64-linux-gnu-g++'
ar = 'aarch64-linux-gnu-ar'
strip = 'aarch64-linux-gnu-strip'
pkg-config = '/usr/bin/pkg-config'
wayland-scanner = '/usr/bin/wayland-scanner'

[properties]
pkg_config_libdir = ['/usr/lib/aarch64-linux-gnu/pkgconfig', '/usr/share/pkgconfig']

[built-in options]
c_args = ['-O2']
cpp_args = ['-O2']

[host_machine]
system = 'linux'
cpu_family = 'aarch64'
cpu = 'cortex-a55'
endian = 'little'
EOF

echo "=== [3/4] Build decode-only FFmpeg (aarch64) ==="
if [ -f /work/out/ffmpeg/opt/beta/ffmpeg/lib/libavcodec.so.61 ]; then
  echo "(already built, skipping FFmpeg)"
else
  cd /build
  apt-get source -qq ffmpeg
  FFDIR=$(ls -d ffmpeg-* | grep -v '\.tar\|\.dsc' | head -1)
  cd "/build/$FFDIR"
  ./configure \
    --arch=aarch64 --cpu=cortex-a55 --target-os=linux \
    --enable-cross-compile --cross-prefix=aarch64-linux-gnu- \
    --pkg-config=/usr/bin/pkg-config \
    --prefix=/opt/beta/ffmpeg \
    --enable-shared --disable-static \
    --disable-programs --disable-doc --disable-debug \
    --disable-everything --disable-network --disable-autodetect \
    --disable-avdevice --disable-avfilter --disable-postproc \
    --enable-zlib --enable-swresample --enable-swscale \
    --enable-protocol=file \
    --enable-demuxer=mov,matroska,ogg,mp3,wav,aac,flac,avi,mpegts,mpegps \
    --enable-parser=aac,aac_latm,mpegaudio,vorbis,opus,flac,h264,hevc,vp8,vp9,mpeg4video,mpegvideo \
    --enable-decoder=aac,aac_fixed,aac_latm,mp3,mp3float,mp3adu,mp3adufloat,mp2,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s32le,pcm_u8,pcm_f32le,pcm_f64le,adpcm_ms,adpcm_ima_wav,vorbis,opus,flac,alac,h264,hevc,vp8,vp9,mpeg4,mpeg2video,mpeg1video,theora,mjpeg,png
  make -j"$JOBS" -s
  make install DESTDIR=/work/out/ffmpeg
  aarch64-linux-gnu-strip --strip-unneeded /work/out/ffmpeg/opt/beta/ffmpeg/lib/*.so.* || true
fi

echo "=== [4/4] Build LLVM-free panfrost-only Mesa (aarch64) ==="
cd /build
apt-get source -qq mesa
MESADIR=$(ls -d mesa-* | grep -v '\.tar\|\.dsc' | head -1)
cd "/build/$MESADIR"
PKG_CONFIG_LIBDIR=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig \
meson setup build-arm64 --cross-file /build/cross-arm64.ini \
  -Dbuildtype=release -Dstrip=true \
  -Dprefix=/usr -Dlibdir=lib/aarch64-linux-gnu \
  -Dgallium-drivers=panfrost,softpipe \
  -Dvulkan-drivers= \
  -Dplatforms=wayland \
  -Dglx=disabled \
  -Degl=enabled -Dgbm=enabled \
  -Dgles1=disabled -Dgles2=enabled -Dopengl=false \
  -Dshared-glapi=enabled -Dglvnd=enabled \
  -Dllvm=disabled -Dvalgrind=disabled -Dlibunwind=disabled -Dlmsensors=disabled \
  -Dzstd=enabled -Dxmlconfig=enabled \
  -Dgallium-vdpau=disabled -Dgallium-va=disabled -Dgallium-xa=disabled \
  -Dvideo-codecs=
ninja -C build-arm64 -j"$JOBS"
DESTDIR=/work/out/mesa ninja -C build-arm64 install
echo "ALL DONE"
