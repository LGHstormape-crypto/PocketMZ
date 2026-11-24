# PocketMZ

在 ROCKNIX / PortMaster 掌机（aarch64，1 GB 内存环境验证）上运行 RPG Maker MV / MZ 游戏的 **PortMaster 独立版**。游戏本体不包含在本仓库中，需要自己放入；原游戏文件夹全程只读、从不被修改。

- **只在 Ports 中运行**：无需修改 EmulationStation 系统配置、无需 SSH 命令行安装。
- **默认使用轻量 β 运行时**（Node 24 + 原生扩展 `pmzrt`）：启动更快、内存峰值更低，同时兼容开源 **panfrost** 与闭源 **libmali** GPU 驱动；遇极少数 `.gif` 动图或特殊浏览器 DOM 插件的游戏，会在 `auto`（默认）模式下自动回退 **NW.js** 兼容兜底。
- **通用手柄控制**：无特定机型物理热键依赖——游戏内 **`Select + X`** 打开 PocketMZ 菜单，**`Select + Start`** 退出游戏。

PocketMZ 是独立的非官方项目，与 KADOKAWA / Gotcha Gotcha Games 无关。RPG Maker 是其商标。

---

## 声明

- **本项目的代码 100% 由 AI 编写**（包括 Anthropic 的 Claude / Claude Code 以及 Google 的 Antigravity）。人类维护者负责提出需求、在真机上试玩和测试、做出取舍决定，但没有手写代码。代码虽经过实机测试，仍可能有 AI 生成代码常见的问题，欢迎通过 Issue 反馈。
- **按现状提供，不做任何担保**（见 MIT 许可证）。使用风险自负：可能出现游戏卡死、掌机重启或存档损坏等情况，请自行备份重要存档（PocketMZ 每次启动游戏前会自动在内存卡滚动保留最近 5 份备份，可在游戏内菜单恢复）。
- **不包含任何游戏**。请只运行你合法拥有的游戏，本项目不支持也不协助任何盗版行为。
- 与 KADOKAWA / Gotcha Gotcha Games（RPG Maker）、ROCKNIX、PortMaster 及 NW.js 项目均无关联，也未获得其认可。
- 补丁针对 RK3566 / 1 GB 内存掌机调优，在其他架构或设备上的表现不做保证。

---

## 版本选择、GPU 驱动与主流掌机 SoC 说明

PocketMZ 对外提供两个 PortMaster 发布包，请按你的掌机芯片和系统选择：

| 发布包 | 包含核心 | 适用场景与特点 |
| --- | --- | --- |
| **`PocketMZ-ports-beta-*.zip`（β 单核心版，推荐多数掌机）** | 仅 **β 原生运行时** | 体积更小（无需 179 MB 的 NW.js 完整容器），**同时支持开源与闭源 GPU 驱动**（Panfrost / libmali / PowerVR 宿主直通），支持流式音频、完整 MZ Effekseer、虚拟鼠标与 `Select + X` 菜单；不含 NW.js 回退。 |
| **`PocketMZ-ports-full-*.zip`（双核心完整版）** | **β 原生运行时 + NW.js** | 默认仍优先使用 β；仅当系统使用开源 **`panfrost`** 驱动时，遇到极少数 `.gif` 或特殊 DOM 插件游戏才可自动/手动回退至 NW.js。 |

### 如何切换 GPU 驱动 / 不能切换的系统怎么选？

- **ROCKNIX 切换 GPU 驱动方法**：主菜单按 **`Start` → 系统设置（System Settings）→ 硬件 / 图形（Hardware / Graphics）→ GPU 驱动（GPU Driver）**，可在 **`panfrost`（开源）** 与 **`libmali`（闭源）** 之间切换，切换后需重启生效。
  - 日常使用 **β 单核心版** 时，两种驱动都可以直接运行；只有需要 **NW.js 回退**时才必须切到 `panfrost`。
- **系统无法切换 GPU 驱动（ArkOS / muOS / Knulli / 原厂固件等）**：这些系统通常只有闭源 Mali 或 PowerVR 驱动，**请直接下载「β 单核心版」**（NW.js 无法在闭源驱动下启动；β 运行时内置 `POCKETMZ_HOST_GL=auto` 自动直通宿主闭源 GLES 库；极少数老旧/特殊闭源驱动如遇黑屏或报错，可在游戏 `env` 中追加 `PMZ_GLES=2` 强制 ES 2.0）。

### 主流开源掌机 SoC 选型参考（仅支持 64 位 Linux `aarch64`）

| SoC | GPU | 代表机型 | 推荐版本与说明 |
| --- | --- | --- | --- |
| **RK3566** | Mali-G52 | GKD Mini Plus、RGB30、RG353 系列、Powkiddy X55 | **ROCKNIX（可切 `panfrost`）**：双核心完整版或 β 单核心版均可；**ArkOS / 闭源系统**：选 **β 单核心版**。 |
| **RK3326** | Mali-G31 | R36S、RG351 系列、RGB20S | 1 GB 内存 + Cortex-A35 性能较紧，强烈推荐 **β 单核心版**（更省内存与卡空间）。 |
| **全志 H700** | Mali-G31 MP2 | ANBERNIC RG35XX Plus/H/SP、RG40XX、RG CubeXX | 主流系统（muOS / Knulli / 原厂）均采用闭源驱动或轻量化取向，直接选 **β 单核心版**。 |
| **全志 A133P** | PowerVR GE8300 | Trimui Smart Pro、Trimui Brick | 仅闭源 PowerVR 驱动，**必须选 β 单核心版**（已支持 PowerVR 宿主库直通，必要时可设 `PMZ_GLES=2`；更多真实机型适配欢迎反馈）。 |
| **高通骁龙 / RK3588 等高配 aarch64 掌机** | Adreno / Mali-G610 | Odin 2 (Linux)、ROCKNIX 高配机 | 有开源驱动（`freedreno` / `panfrost`）时两个版本均可，按需选双核心完整版或 β 单核心版。 |

> 注意：PocketMZ 仅支持 **64 位 Linux（aarch64）** 掌机系统，不支持 32 位 `armhf` 系统。

---

## 安装步骤（4 步完成，无需 SSH）

1. 从 [GitHub Releases](../../releases) 根据上方说明下载 **`PocketMZ-ports-beta-*.zip`**（β 单核心版）或 **`PocketMZ-ports-full-*.zip`**（双核心完整版）并解压。
2. 解压后会得到**两个条目**，将它们**一起**复制到内存卡的 **`roms/ports/`** 根目录：
   ```text
   roms/ports/
   ├── PocketMZ.sh
   └── PocketMZ/
       ├── pocketmz.tar
       └── VERSION
   ```
   > 注意：不要多套一层 `PocketMZ-ports-xxx/` 文件夹，确保 `PocketMZ.sh` 直接位于 `roms/ports/` 下。
3. 把 RPG Maker MV / MZ 游戏文件夹放到内存卡 **`roms/rpgmaker/`** 下（详见下一节）。
4. 在掌机 **EmulationStation → Ports** 中找到并打开 **PocketMZ**：
   - **首次启动**（以及更新了 `roms/ports/PocketMZ/` 后首次启动）会自动把运行环境解包安装到掌机内部 `/storage/pocketmz`（约需几十秒，屏幕会弹出安装提示，**已有存档和设置会自动保留**）；
   - 安装完成后自动打开 PocketMZ 游戏列表，选游戏按 `A` 即可开始游玩。

---

## 游戏放置方法

把解压好的**游戏文件夹**放入内存卡 **`roms/rpgmaker/`**（完整路径 `/storage/roms/rpgmaker/`）：

- **文件夹层级**：支持直接放入或按子文件夹分类（最多搜索 4 层目录；如果某个一级子文件夹里包含 2 个及以上游戏，PocketMZ 列表会自动把它识别为分类标签）。
- **有效游戏结构**：
  - **RPG Maker MZ**：游戏文件夹内必须直接包含 `index.html` 与 `js/rmmz_core.js`。
  - **RPG Maker MV**：游戏文件夹内必须包含 `package.json`、`www/index.html` 与 `www/js/rpg_core.js`。
- **单文件打包 / 大容量视频转换**：如果游戏只有 `index.html` 和一个几十 MB 的 `Game.exe`（没有 `js/` 文件夹，脚本被 Enigma Virtual Box 打包进 exe），PocketMZ 列表会标注为「需要转换」。请先在 Windows 电脑上双击仓库 `tools/PocketMZ转换器.bat` 解包（可选顺便将视频转码为 480p / 720p），再将转换后的文件夹放入 `roms/rpgmaker/`。

---

## 首次进入游戏会很慢（必读）

**每个游戏第一次在 PocketMZ 启动时都会明显比后续启动慢**，这是正常现象：

1. PocketMZ 会为该游戏在 `/storage/pocketmz/games/<游戏ID>/` 建立可写精简副本（仅符号链接，不写入原游戏目录）；
2. 对游戏内较大的字体（`.ttf/.otf/.woff`）做按需裁剪/子集化（几 MB～几十 MB 字体通常只需保留游戏实际用到的字形，减少内存与载入卡顿）；
3. 首次读取超高分辨率立绘/背景或超大 APNG 动图时，会一次性降采样并生成持久缓存（`pmz-cache/`）。

- **耐心等待**：字体多、资源大的游戏在**首次启动时可能黑屏或停在载入界面几十秒到 1～3 分钟**，请勿强行关机或断电。
- **后续极快**：首次预处理完成后，这些缓存和精简字体都会保存下来，**第二次及之后启动通常只需数秒即可进标题画面**；仅当你在卡上覆盖更新了原游戏文件时才会重新触发检查刷新。

---

## 存档与备份位置

- **原游戏目录只读**：游戏文件夹内原有的 `save/` 如果在首次启动时已有存档，会被自动导入，之后游戏运行不再往原游戏目录写入任何内容。
- **统一存档路径**：所有游戏的存档统一保存在内存卡上：
  ```text
  roms/savestates/rpgmz/<游戏ID>/
  ├── save/           # 当前实际存档（β 与 NW.js 共用同一份，可直接与电脑端互通替换）
  └── save-backups/   # 每次启动前发现存档有变动时自动滚动保存最近 5 份快照
  ```
- **`<游戏ID>` 规则**：优先取路径或文件夹名中的 DLsite 编号（`RJ/VJ/BJ` + 数字），没有编号则取文件夹名 + 路径哈希（因此带编号的游戏移动位置或微调名称也不会丢存档）。
- **重刷系统 / 升级不丢档**：重刷系统或更新新版 `PocketMZ` 时，`roms/savestates/rpgmz/` 的存档完全保留；在启动器界面按 **`Start` → 存档 → 导出全部存档** 还可一键备份打包到 `roms/pocketmz-saves/`。

---

## 按键与使用说明

### 通用组合键（Ports 通用）

| 组合键 | 功能 |
| --- | --- |
| **`Select + X`** | **打开 / 关闭 PocketMZ 游戏内菜单**（期间游戏自动暂停，手柄输入不会透传进游戏） |
| **`Select + Start`** | **退出游戏**，返回 PocketMZ 启动器列表（建议重要进度先存档，或使用菜单内退出配合自动保存） |

### 默认游戏按键映射（每个游戏可在 `Select + X` 菜单里独立改键）

| 掌机按键 | 默认对应行为 |
| --- | --- |
| `A` | 确定（`Enter`） |
| `B` / `Start` | 取消 / 游戏内系统菜单（`Esc`） |
| `X` | `D` 键（部分插件扩展键） |
| `Y` / `Select` | 冲刺（`Shift`） |
| `L1` / `R1` | 上一页 / 下一页（`PageUp` / `PageDown`） |
| `L2` / `R2` | `S` / `A` 键（常用作对话快进/自动） |
| 十字键 / 左摇杆 | 方向移动 |
| 右摇杆 | 虚拟鼠标指针（点击式游戏适用，可在按键映射页改成方向键或关闭） |
| `L3` / `R3` | 鼠标右键 / 鼠标左键 |

### 启动器（Ports → PocketMZ）操作

- `A`：启动游戏 · `X`：收藏 · `Y`：删除游戏（可选保留存档或彻底删除） · `Start`：全局设置（刷新列表 / 默认帧率与运行时 / 导出存档 / 清理副本缓存 / 更新与卸载） · `L1 / R1`：切换分类 · `B`：退出回 ES

### 游戏内菜单（`Select + X`）功能

- **帧率（30 / 60）**：默认 30 fps（更省电流畅）；动作类可切 60。
- **加速（1x / 2x / 3x）**、**显示帧数**、**总音量**。
- **渲染分辨率 / 平滑画面**：默认按掌机屏幕缩放绘制并关闭多余开销，可随时切换双线性平滑与原生尺寸。
- **自动保存/加载**：开启后从菜单退出游戏会自动保存当前进度到 `pmz-autosave.json`，下次启动到标题时自动续玩。
- **运行时切换（自动默认 β / β / NW.js）**：默认优先跑 **β**；若遇到个别不支持的游戏可切 `NW.js`（需系统 GPU 驱动为 `panfrost`）。
- **存档备份恢复**：一键回退至任意一次启动前自动备份的快照。

---

## 更新与卸载

- **更新**：将新版解压后的 `PocketMZ.sh` 和 `PocketMZ/` 覆盖进 `roms/ports/`，下次打开 **Ports → PocketMZ** 会自动升级并保留所有游戏存档；也可在启动器 `Start → 运行环境 → 检查更新包` 手动更新。
- **卸载**：启动器 `Start → 运行环境 → 卸载 PocketMZ`（会先保留全部 `roms/savestates/rpgmz/` 存档，仅删除 `/storage/pocketmz` 运行时）。

---

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `patches/` | 运行时插件 `PocketMZ_*.js`（渲染优化、内存管控、第三方插件性能与兼容性修复、游戏内菜单） |
| `scripts/` | 启动器 UI、PortMaster 入口 `ports/PocketMZ.sh`、运行与 chroot 包装、安装/维护/打包脚本 |
| `beta/` | 默认无浏览器轻量运行时（`pmzrun.js`、`overlay.js`、原生 C 扩展 `pmzrt/`、打包脚本） |
| `tools/` | PC 端游戏转换与视频压制工具（`PocketMZ转换器.bat`）、精简依赖交叉编译脚本 |
| `BUILD.md` | 从零构建与重新打包说明 |
| `scripts/README.md` | 简明运行手册 |
| `LICENSE` | MIT 许可证 |

---

## 许可证

MIT，见 [LICENSE](LICENSE)。

第三方组件：NW.js（MIT）；Debian 软件包（各自许可证）；FFmpeg 7.1（LGPL/GPL 见打包内 `THIRD-PARTY.txt`）；Noto CJK（SIL Open Font License）。本仓库不包含二进制分发镜像。

---

## English

PocketMZ runs **RPG Maker MV and MZ** games on ROCKNIX / PortMaster handhelds (aarch64, tuned for 1 GB RAM / RK3566). **PortMaster-only release** — no EmulationStation `es_systems` edits or SSH setup required. Original game folders are always read-only and never modified.

- **Default β runtime** (Node 24 + custom N-API `pmzrt` addon): faster startup, ~150–280 MB lower peak RAM, works on both **panfrost** and **libmali** GPU drivers. In default `auto` mode, games that fail β compatibility fall back automatically to **NW.js** (`panfrost` required for NW.js).
- **Universal handheld controls**: no device-specific hardware buttons required — press **`Select + X`** for the in-game PocketMZ menu, **`Select + Start`** to quit.

**Disclaimer:** 100% AI-written code (Claude / Claude Code and Google Antigravity) guided and hardware-tested by the maintainer. Provided as-is under the MIT license without warranty; no games are included.

### Which Edition Should I Download? (Core, GPU Driver & SoC Guide)

| Edition | Runtimes Included | Best For |
| --- | --- | --- |
| **`PocketMZ-ports-beta-*.zip` (β-Only Standalone — Recommended)** | **β native runtime only** | Much smaller download, supports **both open-source and closed-source GPU drivers** (`panfrost`, `libmali`, PowerVR host GL passthrough), streaming Ogg Vorbis audio, full MZ Effekseer, virtual mouse, and `Select + X` menu. No NW.js fallback. |
| **`PocketMZ-ports-full-*.zip` (Dual-Core Full)** | **β + NW.js fallback** | Still defaults to β, with NW.js available for rare `.gif` or special-DOM plugins when running on open-source **`panfrost`**. |

- **Switching GPU Driver (ROCKNIX)**: Press `Start` → *System Settings* → *Hardware / Graphics* → *GPU Driver* (`panfrost` vs `libmali`, reboot required). β works on both; NW.js requires `panfrost`.
- **Systems that cannot switch drivers (ArkOS / muOS / Knulli / stock OS)**: Choose **`PocketMZ-ports-beta-*.zip`**. Closed-source GLES drivers are auto-detected via `POCKETMZ_HOST_GL=auto` (set `PMZ_GLES=2` in per-game `env` if a driver lacks ES 3.0).
- **By SoC (64-bit `aarch64` Linux only; 32-bit `armhf` is not supported)**:
  - **RK3566** (Mali-G52: GKD Mini Plus, RGB30, RG353, X55): Full or β-only on ROCKNIX (`panfrost`); **β-only** on ArkOS / closed-source setups.
  - **RK3326** (Mali-G31: R36S, RG351, RGB20S): **β-only** strongly recommended for 1 GB RAM / A35 headroom.
  - **Allwinner H700** (Mali-G31 MP2: RG35XX Plus/H/SP, RG40XX, RG CubeXX on muOS/Knulli/stock): **β-only**.
  - **Allwinner A133P** (PowerVR GE8300: Trimui Smart Pro / Brick — closed-source PowerVR only): **β-only** required (`PMZ_GLES=2` if needed; further PowerVR device feedback welcome).
  - **Snapdragon / RK3588 Linux handhelds**: Either edition on open-source drivers.

### Installation (4 steps, no SSH)

1. Download **`PocketMZ-ports-beta-*.zip`** or **`PocketMZ-ports-full-*.zip`** from [GitHub Releases](../../releases) and extract it.
2. Copy **both** **`PocketMZ.sh`** and the **`PocketMZ/`** folder directly into **`roms/ports/`** on your SD card (do not wrap them in an extra subfolder).
3. Put your extracted RPG Maker MV / MZ game folders under **`roms/rpgmaker/`** (subfolders up to 4 levels deep become categories; MZ needs `index.html` + `js/rmmz_core.js`, MV needs `package.json` + `www/index.html` + `www/js/rpg_core.js`; single-`Game.exe` Enigma-packed games must be unpacked first on Windows via `tools/PocketMZ转换器.bat`).
4. Launch **Ports → PocketMZ** on the handheld. The first run automatically unpacks the runtime to `/storage/pocketmz` (takes ~30 seconds, keeping any existing saves and settings), then opens the game launcher.

### Expect a Slow First Launch Per Game

The **very first time you start each game**, PocketMZ builds its symlinked thin copy, subsets large fonts to reduce memory pressure, and caches oversized images / APNG animations. Heavy games can sit on a black/loading screen for **30 seconds to 1–3 minutes** on first launch — **please wait and do not power off**. Every subsequent launch starts in just a few seconds.

### Saves & Backups

- Original game folders in `roms/rpgmaker/` are **never modified** (existing saves inside them are imported once on first run).
- All saves live on your SD card at **`roms/savestates/rpgmz/<game-id>/save/`**, shared between β and NW.js and preserved across updates or OS reflashes.
- Up to **5 rolling pre-launch backups** are kept in **`roms/savestates/rpgmz/<game-id>/save-backups/`** and can be restored from the `Select + X` menu.

### Controls

- **`Select + X`**: Open / close the in-game **PocketMZ menu** (pause, 30/60 FPS cap, 1x–3x speed, FPS display, volume, render scale, smooth scaling, auto save/load, β / NW.js switcher, per-game key mapping, save backup restore, quit).
- **`Select + Start`**: Quit game and return to the PocketMZ launcher.
- Right stick acts as a virtual mouse pointer (`L3`/`R3` = right/left click), configurable per game inside `Select + X`.

**License:** MIT (`LICENSE`). No binaries are committed to this repository.
