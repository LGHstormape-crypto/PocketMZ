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

### β 运行时镜像（可选，实验性）

β（不用浏览器的原生运行时：Node 24 + 自写 N-API 扩展 `pmzrt` + SDL2 / GLES2 / Cairo / Pango / libvorbisfile / libjpeg-turbo / libwebp / 纯解码 FFmpeg）的发布形式是一个约 43 MB 的只读镜像 `beta-runtime.sqfs`（使用 Debian 全量 FFmpeg 时约 76 MB），叠在 `rootfs.sqfs` 上，不含编译器、头文件、文档。

准备开发叠加层（在掌机上）：
1. 以 `/storage/pocketmz/rootfs` 为底层建叠加层 `beta/root`，在其中用 Debian trixie apt 安装编译依赖（`gcc`、`pkg-config`、`libsdl2-dev`、`libcairo2-dev`、`libpango1.0-dev`、`libvorbis-dev`、`libpng-dev`、`libjpeg62-turbo-dev`、`libwebp-dev`、`libavformat-dev`、`libavcodec-dev`、`libswresample-dev`、`libswscale-dev` 等）。
2. 在其上建叠加层 `beta/root24`，引入 Debian forky 源（pin 优先级 100）仅安装 `nodejs` 与 `libnode-dev`（Node 24）。
3. 在 PC 上运行 `sh beta/pmzrt/deploy.sh`，在叠加层内编译 `pmzrt.node`。

构建只读镜像并打包（PC 上，需先有 `rootfs.sqfs` 且掌机上无游戏运行）：

```sh
# Push the sources and build /storage/pocketmz/beta-runtime-<date>.sqfs (+ hard link beta-runtime.sqfs) on the handheld
sh beta/beta-image.sh
# Pack it into the bundle (without --beta the bundle is exactly as before)
/storage/pocketmz/pocketmz-bundle.sh --beta          # + beta-runtime.sqfs and beta/{beta-mount,run-pmzrun,beta-version,pocketmz-test-beta}.sh
```

`pocketmz-install.sh` 把镜像装到 `/storage/pocketmz/beta-runtime.sqfs`，`beta/*.sh` 逐个文件合并进 `/storage/pocketmz/beta/`（不动开发叠加层）。用法：把 `"runtime"` 设成 `beta` 或 `auto`（游戏内 F2 菜单的「运行时」、全局 `settings.json` 或环境变量 `POCKETMZ_GAME_RUNTIME`），默认仍是 `nw`。β 的根目录由 `beta/beta-mount.sh` 挂载：`rt` = 发布镜像（只读 overlay：`beta/rt` = `beta/rt-img`（β 镜像）+ `root-sqfs`（α 镜像），β 只往 `/tmp`、`/root`、shots 目录等绑定挂载里写），`auto` = 有发布镜像就用 `rt`，否则用开发叠加层 `root24`（启动器用 `auto`，所以开发中的掌机照常工作），`root` / `root24` = 开发叠加层。开发脚本（`deploy-pmzrun.sh`、`autotest-beta.sh`）默认仍用 `root24`；`PMZ_ROOTDIR=rt` 让它们用发布镜像测试。

## 回归清单（发版 / 大改后）

每次改动核心补丁、启动器或重打镜像后，按以下清单验证（均不得修改原游戏目录与真实存档）：

1. **前置检查**：掌机电量充足、4 个 CPU 核心全部在线（`cat /sys/devices/system/cpu/online` 为 `0-3`）、当前无游戏运行、GPU 驱动为 `panfrost`。
2. **固定种子自动测试（α 与 β）**：至少选 1 款 MZ 与 1 款 MV 游戏，跑 `PMZ_GAME_ID=<id> PMZ_ROOTDIR=rt sh beta/autotest-beta.sh 4 12345`（β 发布镜像）与 `... 4 12345 nw`（α 对照）：
   - 两者 `trace: hash=` 完全一致、无 JS 报错、无 `LOWMEM` / OOM；
   - 对比峰值内存与最低 `MemAvailable`，确认无内存回退。
3. **运行时切换与自动回退**：
   - 默认 `nw` 启动正常；
   - 游戏内 F2+F1 菜单「运行时」可切换 `NW.js / β / 自动`，菜单底部正确显示当前运行时与 β 安装状态；
   - `POCKETMZ_GAME_RUNTIME=auto POCKETMZ_BETA_FORCE_FAIL=test` 触发退出码 3 后，同一次启动自动切回 NW.js 并写入 `beta-status.json`，再次启动直接走 NW.js。
4. **基础功能抽查**：标题与地图画面无花屏/接缝、BGM 循环无缝、按键与 F2 热键正常、存档读写与启动前自动备份正常（α 与 β 存档互通）、退出后正常回到 ES 且不残留 `nw` / `node` 进程；β 运行时另跑 `test-media.js` 验证 `.m4a/.mp3/.wav` 音频与 `<video>` 播放（ES 3.0 与 `PMZ_GLES=2` 均 0 GL 错误）。
5. **发布检查**：`python tools/pocketmz-export-repo.py` 导出无敏感词命中；若打运行环境包，确认 `THIRD-PARTY.txt` 与镜像内 `/usr/share/pocketmz/third-party/` 存在。

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
- 默认运行时 α（NW.js）需要 `panfrost` GPU 驱动（否则浏览器没有 WebGL）；β 运行时支持运行时加载 GLES 与宿主驱动直通（`POCKETMZ_HOST_GL=auto|1|0`、`PMZ_GLES=2`、`PMZ_GPU_WORKAROUNDS`、`SDL_VIDEODRIVER`），可在闭源 `libmali` 驱动下运行。
- 游戏本体不进入运行环境，原游戏文件夹不被修改。
