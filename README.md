# PocketMZ

在掌机上运行 RPG Maker MV / MZ 游戏。PocketMZ 把 NW.js（arm64）和一套 Debian 运行环境打包在一起，并通过 RPG Maker 插件的形式加入针对 1 GB 内存和 RK3566 的运行时补丁，让游戏能在 GKD Mini Plus 这类 ROCKNIX 掌机上流畅运行。游戏本体不包含在本仓库中，需要自己放入；原游戏文件夹从不被修改，每个游戏使用一份可写的精简副本（符号链接），所有修复都是运行时补丁。

PocketMZ 是独立的非官方项目，与 KADOKAWA / Gotcha Gotcha Games 无关。RPG Maker 是其商标。

## 声明

- **本项目的代码 100% 由 AI 编写**（Anthropic 的 Claude，通过 Claude Code）。人类维护者负责提出需求、在真机上试玩和测试、做出取舍决定，但没有手写代码。代码虽经过实机测试，仍可能有 AI 生成代码常见的问题，欢迎通过 Issue 反馈。
- **按现状提供，不做任何担保**（见 MIT 许可证）。使用风险自负：可能出现游戏卡死、掌机重启或存档损坏等情况，请自行备份重要存档（PocketMZ 每次启动游戏前会自动备份存档，保留最近 5 份，可在游戏内 PocketMZ 菜单中恢复）。
- **不包含任何游戏**。请只运行你合法拥有的游戏，本项目不支持也不协助任何盗版行为。PocketMZ 不修改原游戏文件。
- 与 KADOKAWA / Gotcha Gotcha Games（RPG Maker）、GameKiddy（GKD 掌机）、ROCKNIX 及 NW.js 项目均无关联，也未获得其认可。
- 补丁针对 GKD Mini Plus（RK3566、1 GB 内存）调整，在其他设备上的表现没有保证。

## 状态

- 已在 GKD Mini Plus 上运行，需要 panfrost GPU 驱动。
- 其他 RK3566 的 ROCKNIX 设备尚未测试。

## 功能

- **ES 集成**：安装后在 EmulationStation 中出现「RPGMZ」系统；没有该系统时，游戏列在 Ports 中。
- **按键**：gptokeyb 手柄映射，每个游戏可在游戏内菜单中单独设置按键映射。
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
- **游戏内 PocketMZ 菜单**：帧率 30 / 60、速度、帧数显示、音量、渲染分辨率、游戏中关闭 ES（按游戏设置）、按键映射、一次性图片预处理、存档备份。
- **性能**：按屏幕分辨率渲染；默认 30 fps；大图在加载时缩小并保存持久缓存；窗口内容按显示比例绘制；跳过屏幕外的角色精灵；菜单和战斗的背景快照预先模糊。
- **内存保护**：cgroup 内存上限；看门狗在掌机因交换分区卡死之前结束游戏；修复了 MV / MZ 引擎中的若干内存泄漏。
- **PC 转换工具**：带图形界面，可选择把视频重新编码为 480p / 720p（`tools/`）。
- **设置界面与游戏菜单**：原生 SDL2 程序，与选择界面风格一致。

## 目录结构

| 路径 | 内容 |
|---|---|
| `patches/` | 运行时插件 `PocketMZ_*.js`，在游戏加载时添加 |
| `scripts/` | 启动器、chroot 脚本、安装 / 卸载脚本、设置界面、热键、开发工具（`pocketmz-autotest`、`pocketmz-test`、`pocketmz-padtest`、各种 `*prof*.js` / `*probe*.js` 探针） |
| `scripts/wpe/` | 实验性的 WPE WebKit 原型（未使用） |
| `tools/` | PC 端转换工具（GUI）、基准游戏生成器 |
| `BUILD.md` | 如何构建运行环境 |
| `scripts/README.md` | 用户手册 |
| `scripts/INTEGRATION.md` | 系统镜像集成说明 |
| `LICENSE` | MIT 许可证 |

## 安装

预构建的运行环境包将来会发布在 GitHub Release 中。在此之前，请按 [BUILD.md](BUILD.md) 自行构建。

安装运行环境包：

1. 解压安装包。
2. 运行 `sh pocketmz-install.sh`。原版 ROCKNIX 上加 `--es`，可同时加入 EmulationStation 的「RPGMZ」系统和扫描项。

详细说明见 [scripts/README.md](scripts/README.md)。

**前提**：GPU 驱动必须是 **panfrost**。在 ES 中进入 系统设置 → GPU DRIVER → panfrost，然后重启。libmali 驱动下浏览器没有 WebGL。

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

- **100% of the code in this project was written by AI** (Anthropic's Claude, through Claude Code). The human maintainer set the goals, played and tested on real hardware and made the decisions, but wrote no code. It has been tested on the device, but may still contain the kinds of mistakes AI-written code can have; please report them in Issues.
- **Provided as is, without warranty of any kind** (see the MIT license). Use at your own risk: games may hang, the handheld may reboot or saves may be damaged. Back up important saves (PocketMZ also backs up the saves before each start, keeps the 5 newest, and the in-game PocketMZ menu can restore them).
- **No games are included.** Only run games you legally own; this project does not support piracy. PocketMZ never modifies the original game files.
- Not affiliated with or endorsed by KADOKAWA / Gotcha Gotcha Games (RPG Maker), GameKiddy (GKD handhelds), ROCKNIX or the NW.js project.
- The patches are tuned for the GKD Mini Plus (RK3566, 1 GB RAM); behaviour on other devices is not guaranteed.

**Status:** Works on the GKD Mini Plus with the panfrost GPU driver. Other RK3566 ROCKNIX devices are untested.

**Features:**

- EmulationStation integration (an "RPGMZ" system, with Ports as a fallback).
- gptokeyb button mapping, plus per-game key mapping in the in-game menu.
- Hold-F2 hotkeys: menu (F1), quit (Start), title (Select), save and load screens (L3, R3), slow motion (L1), hold fast-forward (R1), pause (A), screenshot (X), FPS display (Y), volume (Up/Down).
- In-game PocketMZ menu: frame rate (30/60), speed, FPS display, volume, render scale, close ES while playing (per game), key mapping, one-time image precompile, save backups.
- Performance: rendering at screen resolution, 30 fps default, large images downscaled at load with a persistent cache, window contents drawn at the display scale, off-screen sprites skipped, pre-blurred menu backgrounds.
- Memory protection: cgroup limits, and a watchdog that ends the game before the handheld stalls in swap. Leak fixes for the MV and MZ engines.
- PC converter tool with a GUI (in `tools/`), with optional video re-encode to 480p or 720p.
- Settings screen and game menu, native SDL2.

**Layout:** `patches/` (runtime plugins), `scripts/` (launcher, chroot, installer, settings, hotkeys, dev tools), `scripts/wpe/` (experimental, unused), `tools/` (PC converter, benchmark generator), `BUILD.md`, `scripts/README.md` (user manual), `scripts/INTEGRATION.md` (system image integration).

**Install:** A prebuilt runtime bundle will be published as a GitHub Release later. Until then, build it yourself (see `BUILD.md`). Extract the bundle and run `sh pocketmz-install.sh`. Requires the panfrost GPU driver (EmulationStation: System settings, GPU DRIVER, panfrost, then reboot).

**Development:** Create the flag file `/storage/pocketmz/dev` to enable the `PocketMZ_Debug` REPL on `127.0.0.1:9333`. `scripts/pocketmz-autotest.sh` plays a game automatically and records memory and FPS timelines. `tools/pocketmz-benchgen.py` generates two synthetic benchmark games (MV and MZ, 1920x1080).

**License:** MIT (`LICENSE`). Third-party: NW.js (MIT), Debian packages (their own licenses), Noto CJK fonts (OFL). Binaries are not in this repository.
