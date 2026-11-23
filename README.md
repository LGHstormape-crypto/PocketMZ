# PocketMZ

在掌机上运行 RPG Maker MV / MZ 游戏。PocketMZ 把 NW.js（arm64）和一套 Debian 运行环境打包在一起，并通过 RPG Maker 插件的形式加入针对 1 GB 内存和 RK3566 的运行时补丁，让游戏能在 GKD Mini Plus 这类 ROCKNIX 掌机上流畅运行。游戏本体不包含在本仓库中，需要自己放入；原游戏文件夹从不被修改，每个游戏使用一份可写的精简副本（符号链接），所有修复都是运行时补丁。

PocketMZ 是独立的非官方项目，与 KADOKAWA / Gotcha Gotcha Games 无关。RPG Maker 是其商标。

## 声明

- **本项目的代码 100% 由 AI 编写**（包括 Anthropic 的 Claude / Claude Code 以及 Google 的 Antigravity）。人类维护者负责提出需求、在真机上试玩和测试、做出取舍决定，但没有手写代码。代码虽经过实机测试，仍可能有 AI 生成代码常见的问题，欢迎通过 Issue 反馈。
- **按现状提供，不做任何担保**（见 MIT 许可证）。使用风险自负：可能出现游戏卡死、掌机重启或存档损坏等情况，请自行备份重要存档（PocketMZ 每次启动游戏前会自动备份存档，保留最近 5 份，可在游戏内 PocketMZ 菜单中恢复）。
- **不包含任何游戏**。请只运行你合法拥有的游戏，本项目不支持也不协助任何盗版行为。PocketMZ 不修改原游戏文件。
- 与 KADOKAWA / Gotcha Gotcha Games（RPG Maker）、GameKiddy（GKD 掌机）、ROCKNIX 及 NW.js 项目均无关联，也未获得其认可。
- 补丁针对 GKD Mini Plus（RK3566、1 GB 内存）调整，在其他设备上的表现没有保证。

## 状态

- 已在 GKD Mini Plus（ROCKNIX）上运行：默认采用 `auto` 模式（优先使用无浏览器 **β 运行时**，遇不兼容游戏自动退回 **α / NW.js**）。
- β 运行时同时支持开源 **panfrost** 与闭源 **libmali** 驱动及纯 OpenGL ES 2.0 环境；α（NW.js）需要 **panfrost** GPU 驱动。
- 其他 RK3566 / 闭源驱动的 Linux 掌机尚未逐台测试，但 β 运行时已去掉 `libGLESv2` 静态链接并支持宿主 GL 驱动直通与显示后端自动选择（Wayland / X11 / KMSDRM）。

## 功能

- **ES 集成与高级设置**：安装后在 EmulationStation 中出现「RPGMZ」系统（没有该系统时列在 Ports 中），并接入 ES「高级系统设置 / 高级游戏设置」（CPU/GPU 调速器、线程数、核心策略、渲染分辨率、平滑画面、自动保存/加载、画面帧率、显示帧数、运行时内核、运行时关闭 ES）。ES 选「自动」时沿用游戏自身设置；显式选择仅作用于当前会话并同步到 F2 菜单，不改写磁盘配置。
- **按键与虚拟鼠标**：统一 α / β 手柄映射（支持 `pocketmz.gptk` 热重载，可在游戏内菜单单独设置）；右摇杆控制虚拟鼠标指针、L3/R3 模拟鼠标右键/左键，并在 F2 菜单提供鼠标速度（慢 / 标准 / 快）调节。
- **热键**（按住 F2 再按）：
  - F2 + F1：PocketMZ 菜单
  - F2 + Start：退出游戏
  - F2 + Select：回到标题画面
  - F2 + L3 / R3：存档 / 读档画面
  - F2 + L1：慢动作（半速）开关
  - F2 + R1：按住快进（3 倍），松开恢复
  - F2 + A：暂停 / 继续
  - F2 + X：截图
  - F2 + Y：显示 / 隐藏帧数
  - F2 + 上 / 下：调节音量
- **游戏内 PocketMZ 菜单（F2 + F1）**：帧率 30 / 60、速度、帧数显示、音量、渲染分辨率、平滑画面（实时 GPU 双线性/邻近过滤）、自动保存/加载（退出自动存 `pmz-autosave.json`，下次启动自动续玩）、运行时切换（NW.js / β / 自动）、游戏中关闭 ES、按键映射与鼠标速度、一次性图片预处理、存档备份（启动前自动滚动备份 5 份）。
- **β 运行时（Node 24 + `pmzrt`）**：不用浏览器的轻量运行时（Node 24 + 自写 N-API 扩展 `pmzrt` + SDL2 / GLES2 / Cairo / Pango / libvorbisfile / 5.9 MB 纯解码 FFmpeg 7.1），打包为约 43 MB 的只读叠加镜像 `beta-runtime.sqfs`（与瘦身后的约 179 MB α 镜像合包共约 224 MB）。原生支持 Ogg / `.m4a` / `.mp3` / `.wav` / `.rpgmvm` 音频与 `<video>`（`.mp4` / `.webm` 等全屏播放及 WebGL 纹理上传）；内存峰值比 NW.js 低约 150～280 MB、启动更快（约 8～11 秒），与 NW.js 共用同一存档目录。
- **性能**：按屏幕分辨率渲染；默认 30 fps；大图在加载时缩小并保存持久缓存；窗口内容按显示比例绘制；跳过屏幕外的角色精灵；菜单和战斗的背景快照预先模糊。
- **内存保护**：cgroup 内存上限；看门狗在掌机因交换分区卡死之前结束游戏；修复了 MV / MZ 引擎中的若干内存泄漏；BGM / BGS 改为边解码边播放（不再整首解码进内存，循环点精确到采样）；MZ 切换地图时保留上一张地图的图块图；短音效只解码一次；场景切换时主动回收内存。
- **PC 转换工具**：带图形界面，可选择把视频重新编码为 480p / 720p（`tools/`）。
- **设置界面与游戏菜单**：原生 SDL2 程序，与选择界面风格一致。

## 目录结构

| 路径 | 内容 |
|---|---|
| `patches/` | 运行时插件 `PocketMZ_*.js`，在游戏加载时添加 |
| `scripts/` | 启动器、chroot 脚本、安装 / 卸载脚本、设置界面、热键、开发工具（`pocketmz-autotest`、`pocketmz-test`、`pocketmz-padtest`、各种 `*prof*.js` / `*probe*.js` 探针） |
| `scripts/wpe/` | 实验性的 WPE WebKit 原型（未使用）与部分测量脚本 |
| `beta/` | 实验性的无浏览器运行时（`pmzrun.js`、`overlay.js`、原生扩展 `pmzrt/`、打包与挂载脚本） |
| `tools/` | PC 端转换工具（GUI）、基准游戏生成器、仓库导出脚本 |
| `BUILD.md` | 如何构建运行环境与回归清单 |
| `scripts/README.md` | 用户手册 |
| `scripts/INTEGRATION.md` | 系统镜像集成说明 |
| `LICENSE` | MIT 许可证 |

## 安装

从 GitHub Releases 下载预构建的运行环境包（`pocketmz-bundle-*.tar`），或按 [BUILD.md](BUILD.md) 自行构建。

安装运行环境包：

1. 解压安装包。
2. 运行 `sh pocketmz-install.sh`。原版 ROCKNIX 上加 `--es`，可同时加入 EmulationStation 的「RPGMZ」系统和扫描项。

详细说明见 [scripts/README.md](scripts/README.md)。

**前提**：默认运行时 α（NW.js）需要 **panfrost** GPU 驱动（ES → 系统设置 → GPU DRIVER → panfrost，重启；libmali 下浏览器没有 WebGL）。如果使用实验性 **β 运行时**，则同时支持 `panfrost` 与闭源 `libmali` 驱动（自动挂载宿主 GL 库）。

## 开发说明

- 创建开发模式标记文件 `/storage/pocketmz/dev` 后，`PocketMZ_Debug` REPL 插件会监听 `127.0.0.1:9333`。
- `scripts/pocketmz-autotest.sh` 自动游玩一个游戏（包括存档被阻止和恢复的情况），并记录内存和帧率随时间的变化。
- `tools/pocketmz-benchgen.py` 生成两个合成的基准游戏（MV 和 MZ，1920x1080，美术资源为程序生成）。

## 许可证

MIT，见 [LICENSE](LICENSE)。

第三方组件：NW.js（MIT）；Debian 软件包（各自的许可证）；字体 Noto CJK（SIL Open Font License）。本仓库不包含二进制文件。

## English

PocketMZ runs RPG Maker MV and MZ games on handheld devices. It bundles NW.js (arm64) with a Debian runtime, and adds runtime patches (as RPG Maker plugins loaded at game start) for 1 GB of RAM and the RK3566 SoC. It targets the GKD Mini Plus running ROCKNIX. Games are not included. Original game folders are never modified; each game gets a writable thin copy with symlinks, and all fixes are runtime patches.

PocketMZ is an unofficial project, not affiliated with KADOKAWA or Gotcha Gotcha Games. RPG Maker is their trademark.

**Disclaimer:**

- **100% of the code in this project was written by AI** (including Anthropic's Claude / Claude Code and Google's Antigravity). The human maintainer set the goals, played and tested on real hardware and made the decisions, but wrote no code. It has been tested on the device, but may still contain the kinds of mistakes AI-written code can have; please report them in Issues.
- **Provided as is, without warranty of any kind** (see the MIT license). Use at your own risk: games may hang, the handheld may reboot or saves may be damaged. Back up important saves (PocketMZ also backs up the saves before each start, keeps the 5 newest, and the in-game PocketMZ menu can restore them).
- **No games are included.** Only run games you legally own; this project does not support piracy. PocketMZ never modifies the original game files.
- Not affiliated with or endorsed by KADOKAWA / Gotcha Gotcha Games (RPG Maker), GameKiddy (GKD handhelds), ROCKNIX or the NW.js project.
- The patches are tuned for the GKD Mini Plus (RK3566, 1 GB RAM); behaviour on other devices is not guaranteed.

**Status:** Works on the GKD Mini Plus (ROCKNIX). The default `auto` mode prefers the browser-less **β runtime** (supporting both **panfrost** and closed-source **libmali** drivers, plus pure OpenGL ES 2.0) and falls back to **α (NW.js)** automatically when needed (α requires **panfrost**). Other Linux handhelds are untested.

**Features:**

- EmulationStation integration ("RPGMZ" system, with Ports as a fallback) plus ES Advanced System/Game Options (`cpugovernor`, `gpuperf`, `threads`, `forcepack`, render scale, smooth bilinear filtering, auto save/load, FPS cap, FPS counter, runtime selector, stop ES). Choosing "Auto" in ES respects per-game settings; explicit choices apply to the session without overwriting disk configs.
- Unified α/β controller mapping (`pocketmz.gptk` with 1s hot-reload and per-game key mapping) plus virtual mouse (right stick pointer, L3/R3 right/left click, configurable mouse speed in the F2 menu).
- Hold-F2 hotkeys: menu (F1), quit (Start), title (Select), save and load screens (L3, R3), slow motion (L1), hold fast-forward (R1), pause (A), screenshot (X), FPS display (Y), volume (Up/Down).
- In-game PocketMZ menu (F2 + F1): frame rate (30/60), speed, FPS display, volume, render scale, smooth filtering (live GPU `LINEAR`/`NEAREST`), auto save/load (`pmz-autosave.json` on quit/launch), runtime switch (NW.js / β / auto), close ES while playing, key mapping & mouse speed, one-time image precompile, save backups (rolling 5 backups before launch).
- β runtime (Node 24 + `pmzrt`): lightweight browser-less runtime (Node 24 + custom N-API addon `pmzrt` + SDL2 / GLES2 / Cairo / Pango / libvorbisfile / 5.9 MB decode-only FFmpeg 7.1) shipped as an ~43 MB read-only overlay image (`beta-runtime.sqfs`, ~224 MB total bundle with the slimmed ~179 MB α image). Supports native Ogg / `.m4a` / `.mp3` / `.wav` / `.rpgmvm` audio and `<video>` playback (`.mp4` / `.webm` fullscreen & WebGL texture upload). Uses ~150–280 MB less peak RAM and cold-boots in ~8–11s while sharing saves with NW.js.
- Performance: rendering at screen resolution, 30 fps default, large images downscaled at load with a persistent cache, window contents drawn at the display scale, off-screen sprites skipped, pre-blurred menu backgrounds.
- Memory protection: cgroup limits, and a watchdog that ends the game before the handheld stalls in swap. Leak fixes for the MV and MZ engines; BGM / BGS decoded in small pieces while playing instead of in full (sample-accurate loop points); MZ keeps the previous map's tileset images across a transfer; short sound effects decoded once; a full GC at scene changes.
- PC converter tool with a GUI (in `tools/`), with optional video re-encode to 480p or 720p.
- Settings screen and game menu, native SDL2.

**Layout:** `patches/` (runtime plugins), `scripts/` (launcher, chroot, installer, settings, hotkeys, dev tools), `scripts/wpe/` (experimental, unused), `beta/` (experimental browser-less runtime: `pmzrun.js`, `overlay.js`, native addon `pmzrt/`, packaging scripts), `tools/` (PC converter, benchmark generator, repo exporter), `BUILD.md`, `scripts/README.md` (user manual), `scripts/INTEGRATION.md` (system image integration).

**Install:** Download the prebuilt runtime bundle (`pocketmz-bundle-*.tar`) from GitHub Releases, or build it yourself (see `BUILD.md`). Extract the bundle and run `sh pocketmz-install.sh`. The α runtime (NW.js) requires the `panfrost` GPU driver (EmulationStation: System settings, GPU DRIVER, panfrost, then reboot); the β runtime works on both `panfrost` and closed-source `libmali`.

**Development:** Create the flag file `/storage/pocketmz/dev` to enable the `PocketMZ_Debug` REPL on `127.0.0.1:9333`. `scripts/pocketmz-autotest.sh` plays a game automatically and records memory and FPS timelines. `tools/pocketmz-benchgen.py` generates two synthetic benchmark games (MV and MZ, 1920x1080).

**License:** MIT (`LICENSE`). Third-party: NW.js (MIT), Debian packages (their own licenses), Noto CJK fonts (OFL). Binaries are not in this repository.
