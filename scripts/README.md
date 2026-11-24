# PocketMZ Port 版使用手册

面向 PortMaster / ROCKNIX 掌机的 RPG Maker MV / MZ 运行器。**默认采用 β 轻量运行时（`auto` 优先进 β，不兼容游戏自动回退 NW.js）**，原游戏文件夹只读不写。

## 1. 安装方法

1. 解压 `PocketMZ-ports-*.zip`，把 `PocketMZ.sh` 和 `PocketMZ/` 两个文件/文件夹一起放进内存卡 `roms/ports/`。
2. 把游戏文件夹放进内存卡 `roms/rpgmaker/`（可建子文件夹分类，最多 4 层）：
   - **MZ**：目录内须有 `index.html` + `js/rmmz_core.js`。
   - **MV**：目录内须有 `package.json` + `www/index.html` + `www/js/rpg_core.js`。
   - 若游戏为单 `Game.exe` 打包版，先在电脑双击 `tools/PocketMZ转换器.bat` 解包后再拷入掌机。
3. 在掌机 **Ports → PocketMZ** 启动（首次会自动解包安装到 `/storage/pocketmz` 并保留已有存档）。

## 2. 首次启动说明

每个游戏**首次启动**都需要自动生成精简副本、裁剪字体与预处理大图/APNG 缓存，依游戏体积可能需要 **几十秒到 1～3 分钟**，期间请勿强行关机；从**第二次启动开始**即可数秒进入。

## 3. 存档位置

- 全部存档保存在 **`roms/savestates/rpgmz/<游戏ID>/save/`**（β 与 NW.js 通用）。
- 启动前若存档有变化，自动在 **`roms/savestates/rpgmz/<游戏ID>/save-backups/`** 保留最近 5 份备份。
- 在启动器按 `Start → 存档 → 导出全部存档` 可备份到 `roms/pocketmz-saves/`。

## 4. 按键与菜单

- **`Select + X`**：打开 / 关闭游戏内 PocketMZ 菜单（30/60 帧、加速、音量、渲染缩放、平滑画面、自动保存/加载、β/NW.js 切换、按键映射、恢复存档备份、退出）。
- **`Select + Start`**：退出游戏回到列表。

| 掌机 | 游戏 |
|---|---|
| A / B | 确定 / 取消与系统菜单 |
| X / Y | D 键 / Shift（冲刺） |
| Select / Start | Shift（冲刺）/ Esc（系统菜单） |
| L1 / R1 | 上一页 / 下一页 |
| L2 / R2 | S / A 键 |
| 十字键 / 左摇杆 | 方向 |
| 右摇杆 / L3 / R3 | 虚拟鼠标指针 / 右键 / 左键 |

## 5. 日志与单游戏高级配置（可选）

- 运行日志：`/storage/pocketmz/games/<游戏ID>/run.log`
- 可选环境变量文件 `/storage/pocketmz/games/<游戏ID>/env`：例如 `POCKETMZ_MEM_MAX=700`、`POCKETMZ_STOP_ES=1`、`POCKETMZ_RENDER_SCALE=off`、`POCKETMZ_GAME_RUNTIME=nw|beta|auto`。
