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

把根文件系统目录打包为只读镜像 `rootfs.sqfs`。默认会排除 locales、文档等内容。

```sh
# Pack the rootfs into a read-only squashfs image (default: excludes locales, docs, etc.)
/storage/pocketmz/pocketmz-pack.sh          # -> rootfs.sqfs, about 330-350 MB

# Full image, with nothing excluded
POCKETMZ_PACK_FULL=1 /storage/pocketmz/pocketmz-pack.sh
```

## 6. 生成安装包

```sh
# Build the installable bundle: rootfs.sqfs + scripts + patches + README in one tar
/storage/pocketmz/pocketmz-bundle.sh        # -> /storage/pocketmz-bundle-<YYYYmmdd>.tar
```

安装或更新：

```sh
# Extract the bundle into a new directory, then run the installer
mkdir /storage/pocketmz-new
tar -xf pocketmz-bundle-<date>.tar -C /storage/pocketmz-new
cd /storage/pocketmz-new && sh pocketmz-install.sh   # --es: also add the ES system "RPGMZ"
```

卸载：

```sh
# Show what uninstall would do (no changes)
/storage/pocketmz/pocketmz-uninstall.sh

# Uninstall; copies saves to /storage/pocketmz-saves-<date>/ first
/storage/pocketmz/pocketmz-uninstall.sh --yes
```

## 7. 开发时同步脚本

`scripts/deploy.sh` 在 PC 端运行，通过 ssh 主机别名把脚本复制到掌机的 `/storage/pocketmz`。

## 8. 注意事项

- 根文件系统必须位于 ext4，不能是 exFAT。
- 运行环境需要 panfrost GPU 驱动，否则浏览器没有 WebGL。
- 游戏本体不进入运行环境，原游戏文件夹不被修改。
