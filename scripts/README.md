# PocketMZ

在掌机（GKD Mini Plus / ROCKNIX）上运行 RPG Maker MV/MZ 游戏的运行环境：NW.js（arm64，Debian 运行环境）加上针对 1 GB 内存和 RK3566 的运行时补丁。游戏本体不包含在内，需要自己放入；游戏文件从不被修改。MIT 许可证。

（PocketMZ 是独立项目，与 KADOKAWA / Gotcha Gotcha Games 无关；RPG Maker 是其商标。）

## 前提

- 默认运行时（NW.js）要求 GPU 驱动为 **panfrost**：ES → 系统设置 → GPU DRIVER → panfrost，然后重启（libmali 下浏览器拿不到 WebGL）。
- 如果安装了实验性 **β 运行时**并在设置或游戏内 F2 菜单中选择 `β` 或「自动」，则可在闭源 **libmali** 驱动下直接运行（启动器会自动直通宿主 GL 库）。

## 添加游戏

1. 把游戏文件夹放进 `/storage/roms/rpgmaker/`（卡上的 `roms/rpgmaker`）。文件夹里要有 `index.html`（MZ），或者 `package.json` + `www/index.html`（MV）。可以连同外层文件夹一起放，最多 4 层。
2. 扫描：ES → Tools →「Scan PocketMZ Games」（或运行 `/storage/pocketmz/pocketmz-scan.sh`）。
3. 启动：
   - 装了 ES 系统「RPGMZ」（系统已集成，或安装时用了 `--es`）：游戏列在「RPGMZ」下，模拟器是 PocketMZ，名字取游戏标题。
   - 没装：游戏列在 Ports 里。

`/storage/roms/easyrpg/` 也会被扫描；里面的 RPG Maker 2000/2003 游戏（EasyRPG）不受影响。

## 按键

| 掌机 | 游戏 |
|---|---|
| A | 确定 |
| B | 取消 / 菜单 |
| X | D 键 |
| Y / Select | Shift（冲刺） |
| L1 / R1 | 翻页 |
| L2 / R2 | S / A 键（很多游戏的快进 / 自动） |
| 十字键 / 左摇杆 | 方向 |
| 右摇杆（插入式摇杆模块） / R3 / L3（机身侧键） | 鼠标指针 / 左键 / 右键（点击式界面的游戏，例如用图片按钮的 ADV） |
| Start | 取消 / 菜单（同 B） |

以上按键每个游戏都可以在 PocketMZ 菜单 → 按键映射 里改（立即生效，只影响这个游戏）。

### 热键：按住 F2 再按（和本机模拟器同一套）

| 组合 | 作用 |
|---|---|
| F2 + F1 | PocketMZ 菜单（帧率、加速、显示帧数、音量、渲染分辨率、按键映射、存档备份、退出游戏） |
| F2 + Start | 退出游戏 |
| F2 + Select | 回到标题画面 |
| F2 + L3 | 打开存档画面（RPG Maker 没有即时存档） |
| F2 + R3 | 打开读档画面 |
| F2 + L1 | 慢动作（半速）开 / 关 |
| F2 + R1 | 按住快进（3 倍），松开恢复 |
| F2 + A | 暂停 / 继续 |
| F2 + X | 截图（存到 roms/screenshots） |
| F2 + Y | 显示 / 隐藏帧数 |
| F2 + 上 / 下 | 调音量 |

按住 F2 时游戏收不到其他按键（F2 + A 不会同时按到确定）。系统热键照常可用：L1 + Select + Start 强制退出，L1 + X 攻略。

## 存档

- 原游戏文件夹从不写入。每个游戏在 `/storage/pocketmz/games/<id>/game/` 有一份可写的精简副本，存档在里面的 `save/`（MV 为 `www/save/`）。
- `<id>` 取路径里的 DLsite 编号（如 RJxxxxxxxx），没有就用文件夹名 + 校验值。游戏文件夹移动或改名后，编号不变的游戏存档还在；其他游戏会被当成新游戏。
- 第一次启动时，会把原文件夹里已有的存档复制到副本里。

## 设置（游戏内 选项）

- 「画面フレームレート」：30 / 60。默认 30，省电、发热小；画面动作多的游戏可改 60。

## 单个游戏的设置（可选）

- `/storage/pocketmz/games/<id>/pocketmz.gptk`：这个游戏用自己的按键映射（格式同 `/storage/pocketmz/pocketmz.gptk`）。
- `/storage/pocketmz/games/<id>/env`：启动参数，例如 `POCKETMZ_MEM_MAX=700`（内存上限 MB）、`POCKETMZ_STOP_ES=1`（运行时关掉 ES，多省约 50 MB）、`POCKETMZ_RENDER_SCALE=off`（关闭"按屏幕分辨率渲染"，默认开启：高分辨率游戏按掌机屏幕大小绘制，省 GPU）。

## 选择运行时（NW.js / β / 自动）

- 游戏内：按住 F2 再按 F1 打开 PocketMZ 菜单，「运行时」一项在 NW.js / β / 自动 之间切换（只对这个游戏，写进副本的 `pocketmz.json` 的 `"runtime"`），下次启动游戏生效；菜单下方小字显示「当前：…」。β 没装时选 β 或自动，会提示「β 未安装，将使用 NW.js」，实际仍用 NW.js。
- 全局默认：设置（PocketMZ 选择界面）→「游戏默认设置」→「游戏运行时」，写进 `settings.json` 的 `"runtime"`；没有单独设置的游戏用它。
- 优先级：环境变量 `POCKETMZ_GAME_RUNTIME`（含 `games/<id>/env`）> 游戏的 `pocketmz.json` > 全局 `settings.json` > `nw`。
- `auto` = 用 β，除非游戏被标记为「β 不兼容」（`games/<id>/beta-status.json`），β 启动失败时同一次启动里自动改用 NW.js。

## 维护

- 打包整套运行环境（重刷系统后恢复用）：`/storage/pocketmz/pocketmz-bundle.sh` → `/storage/pocketmz-bundle-<日期>.tar`（约 350 MB）。
- 可选的 β 运行时（实验性，默认仍用 NW.js）：`pocketmz-bundle.sh --beta` 把约 40 MB 的 `beta-runtime.sqfs` 和 `beta/*.sh` 一起打进安装包；在游戏内 F2 菜单的「运行时」或「游戏默认设置」里选 `β` 或「自动」才会用。
- 安装 / 更新：`mkdir /storage/pocketmz-new && tar -xf pocketmz-bundle-<日期>.tar -C /storage/pocketmz-new && sh /storage/pocketmz-new/pocketmz-install.sh`。已有的存档保留。
  在原版 ROCKNIX 上加 `--es`（`sh .../pocketmz-install.sh --es`），会同时在 ES 里加「RPGMZ」系统和 Tools 里的扫描项；系统镜像已集成时不用加。
- 卸载：`/storage/pocketmz/pocketmz-uninstall.sh` 先显示会做什么，加 `--yes` 才执行。所有存档会先复制到 `/storage/pocketmz-saves-<日期>/`。
- 日志：`/storage/pocketmz/games/<id>/run.log`。

## 已知限制

- 使用 NW.js 运行时启动到标题约 27～33 秒（大部分是浏览器本身的启动）；实验性 β 运行时启动约 2～10 秒，内存峰值低约 150～280 MB，但部分使用视频（`<video>`）或特殊浏览器 DOM 特性的游戏会自动退回 NW.js，战斗帧率在复杂场景下可能略低于 NW.js。
- MV 与 MZ 游戏均已有实机测试与运行时优化（渲染缩放、大图缩小缓存、窗口按显示比例绘制、BGM 流式播放、内存泄漏修复、F2 菜单与 β 运行时支持），但部分重负载插件游戏在战斗时仍可能只有 20 帧左右。
- 内存不足时只有游戏会被关掉（会弹出提示），不会拖死整机。
