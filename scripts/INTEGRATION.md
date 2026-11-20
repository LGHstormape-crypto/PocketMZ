# 集成说明：PocketMZ（RPG Maker MV/MZ 运行环境，ES 类别「RPGMZ」）→ ROCKNIX 系统镜像

给做系统镜像的人看。两种做法：

- A. 运行环境（约 350 MB）装在 `/storage/pocketmz`（bundle 或 Ports 包安装 / 更新），镜像只提供第 1～3 节的"接入点"。
- C（推荐）. 镜像里只放启动器 `/usr/bin/pocketmz` + Tools 里的「PocketMZ」「PocketMZ 设置」+ ES 系统配置；运行环境仍在 `/storage/pocketmz`，首次使用时启动器自动从 `pocketmz.tar` 安装：见第 7 节。
- B. 运行环境放进镜像（只读程序目录），数据仍在 `/storage/pocketmz`：第 7 节末尾，不推荐。

不改游戏，不改运行环境里的文件。

## 1. ES 系统「RPGMZ」（运行器 PocketMZ）

把 `es_systems_pocketmz.cfg` 里的 `<system>` 段加进镜像的 `es_systems.cfg`（或把整个文件作为 `es_systems_pocketmz.cfg` 放在 ES 的用户配置目录 `/storage/.config/emulationstation/`，ES 会读取同目录下所有 `es_systems_*.cfg`）。

| 项 | 值 |
|---|---|
| name | `rpgmz`（扫描脚本靠这个名字判断系统已安装） |
| path | `/storage/roms/rpgmz`（只放启动文件，ES 不会去遍历游戏文件夹） |
| extension | `.rpgmz` |
| command | `/storage/pocketmz/pocketmz-run.sh %ROM%`（不经 runemu.sh；按键映射、全屏、内存限制由脚本自己处理） |
| theme | `easyrpg`（借用 EasyRPG 的图；主题作者可另加 `rpgmz`） |
| emulator / core | `pocketmz` / `pocketmz`（只作显示；command 不用 %EMULATOR%） |

启动文件格式（由 `pocketmz-scan.sh` 生成，纯文本）：

```
# RPG Maker MZ: <标题> - ...
dir=/storage/roms/rpgmaker/<游戏文件夹>
id=RJxxxxxxxx
```

## 2. Tools 入口

`modules/Scan PocketMZ Games.sh` 放进 Tools（镜像里的 `/usr/config/modules/`，或用户的 `/storage/.config/modules/`）。流程和 "Scan ScummVM Games" 一样：提示 → `pocketmz-scan.sh` → 提示新增数 → 重启 UI。可在 `modules/gamelist.xml` 里加名字 / 说明 / 图标。

## 3. 目录

- `/storage/roms/rpgmaker/`：用户放 MV/MZ 游戏文件夹（任意层级，最多 4 层）。
- `/storage/roms/rpgmz/`：启动文件，由扫描生成。
- 两者都可以像其他 roms 目录一样在开机时创建。

## 4. 依赖

- GPU 驱动必须是 **panfrost**（libmali 下浏览器没有 WebGL）。镜像若默认 libmali，可在 `pocketmz-run.sh` 启动前提示或由系统设置切换。
- 用到：sway（app_id 规则全屏）、gptokeyb（PortMaster 的 control.txt）、systemd、ES 的 HTTP API `127.0.0.1:1234`（`/reloadgames`）、`/usr/bin/sdl2notify`。
- 温控是系统单元 `gkd-thermal`，运行环境不再自带。

## 5. 安装 / 迁移 / 卸载

- 原版 ROCKNIX（镜像没集成）：`sh pocketmz-install.sh --es` 会把第 1、2 项装进用户配置。
- 镜像已集成：`sh pocketmz-install.sh`（不带 `--es`）。
- 扫描脚本发现系统已安装后，会把旧版建在 Ports 里的条目（带 `# pocketmz:` 标记）迁移成启动文件；存档按游戏 id 存在 `/storage/pocketmz/games/<id>/`，不受影响。
- `pocketmz-uninstall.sh --yes`：先把存档复制到 `/storage/pocketmz-saves-<日期>/`，删除启动文件、Ports 条目和用户配置里的第 1、2 项（镜像里的文件不动），再删 `/storage/pocketmz`。

## 6. 验证

1. 重启 ES，系统列表出现「RPGMZ」（有游戏时）。
2. Tools → Scan PocketMZ Games，提示新增数，列表刷新。
3. 从列表启动一个游戏：`/storage/pocketmz/games/<id>/run.log` 有 `nw start`，F2+Start 退回 ES。

## 7. 推荐做法：镜像里只放启动器（做法 C）

运行环境（`rootfs.sqfs` 约 350 MB）和全部程序文件**不进镜像**，放在 `/storage/pocketmz`，用软件包 `pocketmz.tar` 安装和更新。镜像里只放 4 个小文件：

| 镜像里的文件 | 来源（包里的文件） | 作用 |
|---|---|---|
| `/usr/bin/pocketmz`（可执行） | `pocketmz-bootstrap.sh` | 启动器：`pocketmz menu` / `settings` / `scan` / `run <启动项>`。`/storage/pocketmz` 还没装时，自动从下面的位置找 `pocketmz.tar` 安装；找不到就提示放到哪里 |
| Tools 里的 `PocketMZ.sh` | `modules/PocketMZ.sh` | 游戏选择界面（`pocketmz menu`） |
| Tools 里的 `PocketMZ 设置.sh` | `modules/PocketMZ Settings.sh`（文件名可以改成中文） | 设置界面（`pocketmz settings`） |
| ES 系统配置 | `es_systems_pocketmz.cfg` | RPGMZ 类别；command 改成 `/usr/bin/pocketmz run %ROM%` |

原来的 Tools 扫描项（`modules/Scan PocketMZ Games.sh`）可以不放了，扫描已在设置界面里；放着也没关系。

设置界面（原生 SDL2，和选择界面同一套风格、按键）提供：

- 扫描游戏（同 Tools 扫描项）
- 游戏默认设置：默认帧率 30/60、渲染缩放 自动/关闭、运行游戏时关闭 ES。写在 `/storage/pocketmz/settings.json`，只对没有单独设置过的游戏生效（每个游戏仍可在游戏内菜单 F2+F1 单独改）
- 存档：导出全部存档到 `/storage/roms/pocketmz-saves/<日期>/`；清理游戏副本缓存（下次启动自动重建，存档不动）
- 运行环境：版本和占用信息；检查更新包并安装；卸载（两次确认，存档先复制出来）
- 关于：版本、MIT 许可

设置界面背后是 `pocketmz-maint.sh`（`info`、`export-saves`、`clean-copies`、`find-package`、`update`、`uninstall`，最后一行输出 `OK …` 或 `ERROR …`），也可以在命令行直接用。

启动器找安装包的位置（按顺序，`update` 取版本最新的）：`/storage/roms/ports/PocketMZ/pocketmz.tar`、`/storage/downloads/pocketmz.tar`、`/storage/roms/pocketmz.tar`、`/storage/roms/rpgmaker/pocketmz.tar`、`/storage/roms/rpgmz/pocketmz.tar`、`/storage/pocketmz.tar`。

这样系统镜像几乎不变大，PocketMZ 可以单独更新；已装好的 `/storage/pocketmz` 不受影响，启动器直接使用。

（旧的做法 B：把整个运行环境放进镜像只读目录，程序目录和数据目录分开——脚本仍然支持：每个脚本按自己所在目录找程序文件，数据固定在 `POCKETMZ_DATA`，默认 `/storage/pocketmz`。镜像会大约 350 MB，一般不推荐。）

## 8. 选择界面（Ports 包）

选择界面是原生 SDL2 程序（`pocketmz-launcher.py`，约 3 s 打开、退出游戏约 5 s 回到界面；手柄映射用 PortMaster `get_controls` 的设备配置，和游戏一致）；SDL2 加载不了时自动退回 NW.js 网页版（`launcher/`）。字体用系统的 `/usr/share/fonts/truetype/noto-cjk/NotoSansCJKsc-Regular.otf`。

做法 A 下给用户的入口：`roms/ports/PocketMZ.sh` + `roms/ports/PocketMZ/`（`pocketmz.tar`、`VERSION`），由 `pocketmz-bundle.sh --ports` 生成。第一次启动、或 `VERSION` 变了时自动安装到 `/storage/pocketmz`（`pocketmz-install.sh --menu`：不给每个游戏建 Ports 条目），然后打开选择界面：读 `roms/rpgmaker`（子文件夹 = 分类），选中 → 游戏 → 退出游戏回到界面，B → 退出回 ES。注意：GKD 版 ES 开了 DeferredFolderScan——开机 / `/reloadgames` / 重启 ES 时只读各系统的 gamelist.xml，新放进的 `PocketMZ.sh` 要在掌机上第一次打开 Ports 列表时才被扫描出来（ES 随后自己写进 gamelist.xml）；HTTP API 在那之前也看不到它。想立刻显示（带名字 / 说明），可在没有游戏运行时往 `roms/ports/gamelist.xml` 加一项 `<game><path>./PocketMZ.sh</path><name>PocketMZ</name></game>` 再调 `/reloadgames`。

许可证：MIT（`LICENSE`）。
