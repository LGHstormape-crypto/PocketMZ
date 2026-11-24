# 构建 PocketMZ 运行环境

本文说明如何从零构建 PocketMZ 的运行环境（Debian 根文件系统 + NW.js + 脚本和补丁），并打包成可安装的 bundle。命令注释为英文，方便在掌机和 PC 上直接查阅。

## 1. 根文件系统

运行环境的根文件系统是 Debian 13（trixie）arm64。

```sh
# Download the Debian trixie arm64 rootfs tarball from linuxcontainers.org,
# then verify it against the published sha256 before using it.
sha256sum <rootfs-tarball>   # compare with the value published next to the tarball
```

把校验通过的压缩包解压到掌机上的 `/storage/pocketmz/rootfs`。该目录必须位于 ext4 分区，不能是 exFAT。

进入根文件系统：

```sh
# Open a shell inside the runtime rootfs
POCKETMZ_USE_DIR=1 /storage/pocketmz/pocketmz-chroot.sh shell

# Run one command inside the runtime rootfs
POCKETMZ_USE_DIR=1 /storage/pocketmz/pocketmz-chroot.sh run <cmd>
```

apt 源设置为 deb.debian.org 的 `trixie main contrib`、`trixie-updates`、`trixie-security`。

## 2. 安装软件包

在根文件系统内用 apt 安装以下软件包（主要的几个）：

```sh
# Install the runtime packages inside the rootfs
apt-get update
apt-get install -y \
  libgtk-3-0t64 libnss3 libasound2t64 libpulse0 pulseaudio-utils \
  libgbm1 libegl1 libgles2 libgl1-mesa-dri mesa-utils \
  libwayland-client0 libwayland-egl1 libxkbcommon0 libxss1 libxtst6 \
  libatk-bridge2.0-0t64 libdrm2 libu2f-udev \
  fonts-noto-cjk locales tzdata ca-certificates \
  python3-fonttools python3-brotli squashfs-tools curl unzip xz-utils evtest
```

## 3. NW.js

安装 NW.js v0.120.0 linux-arm64（官方构建，来自 dl.nwjs.io 或 dl.node-webkit.org）。

```sh
# Download the NW.js v0.120.0 linux-arm64 build and its SHASUMS256.txt,
# verify the archive checksum, then extract it to /opt/nwjs inside the rootfs.
sha256sum -c SHASUMS256.txt --ignore-missing
```

解压到根文件系统内的 `/opt/nwjs`。NW.js 的启动参数见 `scripts/pocketmz-run.sh` 中的 `NW_ARGS`。以 root 运行时需要 `--no-sandbox`。

## 4. 精简字体（可选）

NotoSerifCJK 可以删除，节省约 54 MB。衬线字体会回退到 Noto Sans CJK JP。

```sh
# Remove the NotoSerifCJK font files (saves about 54 MB); serif text falls back to Noto Sans CJK JP,
# then rebuild the font cache (inside the rootfs)
rm /usr/share/fonts/opentype/noto/NotoSerifCJK-*.ttc
fc-cache -f
```

## 5. 打包只读镜像

把根文件系统目录打包为只读镜像 `rootfs.sqfs`（`zstd -19 -b 256K`）。默认使用**白名单精简模式**：只抽离运行时所需的二进制、`ldd`/`dlopen` 共享库、精简 NW.js（去掉 SwiftShader/Vulkan、`locales/*.pak.info`、`crashpad`、`nw_200_percent.pak`）、`NotoSansCJK-Regular.ttc`（`POCKETMZ_KEEP_BOLD=1` 保留 Bold）、纯 Python `fontTools`（由宿主 `python3` 运行，chroot 不带 `python3.13`）、`xkb`/字体/证书配置，不打包 GTK3/Adwaita、`systemd`/`udev`/`vim`/`perl`/`apt`/`lapack`。

可选进一步瘦身（推荐）：在 x86_64 Linux 构建机上用 `tools/build-slim-deps.sh`（Debian trixie 容器交叉编译）：
- **无 LLVM 纯 panfrost 版 Mesa 25.0.7**：放到掌机 `/storage/pocketmz/mesa-panfrost/`，`pocketmz-pack.sh` 会自动优先采用并甩掉 118 MB `libLLVM` 与 26 MB `libz3`（`rootfs.sqfs` 从约 226 MB 降至约 **179 MB**）；
- **纯解码版 FFmpeg 7.1**：放到 `beta/root24/opt/beta/ffmpeg/`，`beta/pmzrt/build.sh` 与 `beta/beta-image.sh` 自动采用（0 外部编码器库依赖，`beta-runtime.sqfs` 从约 76 MB 降至约 **43 MB**）。

打包前 `pocketmz-licenses.sh` 会把所有软件包的版权与许可证声明、软件包清单（含源码包版本）和源码获取说明汇总到镜像内的 `/usr/share/pocketmz/third-party/`，摘要另存为 `THIRD-PARTY.txt` 随安装包发布。

```sh
# Pack the rootfs into a read-only squashfs image (slim whitelist + zstd-19 256K)
/storage/pocketmz/pocketmz-pack.sh          # -> rootfs.sqfs, ~179 MB with slim Mesa (~226 MB with Debian Mesa)

# Full legacy image, with nothing whitelisted out
POCKETMZ_PACK_FULL=1 /storage/pocketmz/pocketmz-pack.sh
```

## 6. 生成 PortMaster 安装包

```sh
# Build the PortMaster release package (β runtime default + NW.js fallback)
/storage/pocketmz/pocketmz-bundle.sh /storage/PocketMZ-ports-$(cat /storage/pocketmz/VERSION)
```

生成目录下包含 `PocketMZ.sh` 与 `PocketMZ/`（`pocketmz.tar`、`VERSION`），打包为 `.zip` 即可分发；玩家复制进 `roms/ports/` 后首次从 Ports 启动会自动安装。

### β 运行时镜像（默认集成）

β（原生轻量运行时：Node 24 + `pmzrt` + SDL2 / GLES2 / Cairo / Pango / libvorbisfile / libjpeg-turbo / libwebp / 纯解码 FFmpeg）打包为约 43 MB 的只读层 `beta-runtime.sqfs`，叠在 `rootfs.sqfs` 之上。

准备开发叠加层与打包步骤：
1. 以 `/storage/pocketmz/rootfs` 为底层建叠加层 `beta/root`，安装编译依赖（`gcc`、`pkg-config`、`libsdl2-dev`、`libcairo2-dev`、`libpango1.0-dev`、`libvorbis-dev`、`libpng-dev`、`libjpeg62-turbo-dev`、`libwebp-dev`、`libavformat-dev`、`libavcodec-dev`、`libswresample-dev`、`libswscale-dev` 等）。
2. 在其上建叠加层 `beta/root24`，安装 `nodejs` 与 `libnode-dev`（Node 24）。
3. 运行 `sh beta/pmzrt/deploy.sh` 编译 `pmzrt.node`，再运行 `sh beta/beta-image.sh` 生成 `beta-runtime.sqfs`。
4. 最后执行 `/storage/pocketmz/pocketmz-bundle.sh` 即可打出完整 Port 安装包。

## 7. 发布前核对

1. **实机验证**：从 **Ports → PocketMZ** 启动后自动安装正常、游戏列表与启动正常；MZ 与 MV 游戏各测一轮，确认 `Select + X` 菜单、开关平滑/帧率、存档备份与 `Select + Start` 退出均正常。
2. **驱动与媒体**：β 运行时在 `panfrost` 与 `libmali` 下均正常；`.m4a/.mp3/.wav` 音频与 `.mp4/.webm` 视频播放正常。
3. **合规检查**：确认包内 `THIRD-PARTY.txt` 与镜像内 `/usr/share/pocketmz/third-party/` 完整。

卸载：

```sh
# Show what uninstall would do (no changes)
/storage/pocketmz/pocketmz-uninstall.sh

# Uninstall; keeps saves under /storage/roms/savestates/rpgmz/
/storage/pocketmz/pocketmz-uninstall.sh --yes
```

## 8. 注意事项

- `/storage/pocketmz` 运行目录必须位于 ext4，不能是 exFAT；游戏本体与存档则位于 `roms/`（支持 exFAT）。
- **默认采用 β 运行时（`auto` 优先 β）**，同时支持 `panfrost` 与闭源 `libmali` 驱动；仅回退 NW.js（α）时需要 `panfrost` GPU 驱动。
- 游戏本体不进入运行环境，原游戏文件夹不被修改。
