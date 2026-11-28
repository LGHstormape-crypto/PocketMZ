# PocketMZ 社区移植与适配指南（Porting Guide）

PocketMZ 以 **1 GB 内存、64 位 Linux（`aarch64`）掌机** 为核心目标。为了避免无实机环境下的盲目试错，欢迎有真机的开发者和玩家按本指南采集环境快照、分层排查，并通过 GitHub Issue 反馈适配需求或提交 PR。

---

## 一、准入红线（先确认设备是否满足底线）

1. **CPU 架构必须是 64 位 `aarch64` Linux**（`uname -m` 为 `aarch64`），不支持 32 位 `armhf` 或安卓。
2. **内核支持 squashfs + loop 挂载（`gzip` 压缩）**：`/proc/filesystems` 中包含 `squashfs`，且允许 `mount -t squashfs -o loop,ro`。
3. **支持 `unshare -m` 与 `chroot`**：PortMaster / 入口脚本需要以 `root`（或无密码 `sudo -n`）执行挂载与 `chroot`。
4. **原游戏目录全程只读**：任何移植适配都不能写入 `roms/rpgmaker/` 下的原游戏文件夹，也不要修改系统固件分区。
5. **不依赖机型专用硬件快捷键**：统一使用 `Select + X`（菜单）与 `Select + Start`（退出）。

---

## 二、一键采集只读环境信息

在提交 Issue 或开始调试前，请先在掌机上运行只读探测脚本 [scripts/pocketmz-sysinfo.sh](scripts/pocketmz-sysinfo.sh)（只读采集，不修改系统也不碰 `i2c-0`）：

```sh
sh pocketmz-sysinfo.sh /tmp/pocketmz-sysinfo.txt
```

如果通过 Ports 入口运行过一次 `PocketMZ.sh`，TF 卡上的 `roms/ports/PocketMZ/pocketmz-last.log` 和 `roms/ports/PocketMZ/logs/` 也会保留完整安装、选单和游戏启动日志。

---

## 三、分层排查表（按启动顺序逐层定位）

| 层级 | 典型现象 | 排查重点与对应开关 |
| --- | --- | --- |
| **L1 入口 / 路径 / 权限** | 点 Ports 图标闪退、找不到游戏或提示不可写 | 检查 `pocketmz-last.log` 的 `POCKETMZ_DATA`、`POCKETMZ_ROMS`、`ESUDO`；exFAT 卡无足够 `/storage` 时需确认 `mkfs.ext4` 或 `/tmp` 空间。 |
| **L2 启动器选单（PySDL2）** | 选单打不开、无文字、无封面 | 检查 `logs/menu.log`；确认 `PYSDL2_DLL_PATH` 下存在 **64 位** `libSDL2-2.0.so.0` 与 `libSDL2_ttf`；字体缺失会回退系统字体。 |
| **L3 镜像挂载 / chroot** | `beta not installed` 或 `mount` 报错 | 确认内核支持 `gzip` squashfs、`unshare -m` 可用；老内核（如 4.9）缺少 cgroup v2/PSI 时已自动降级为 `/proc/meminfo` 轮询。 |
| **L4 GPU / GLES / 视频驱动** | 进游戏黑屏、EGL 初始化失败、无渲染 | 开源驱动（`panfrost`）无需直通；闭源 Mali / PowerVR 走 `POCKETMZ_HOST_GL=auto`。若缺少 GLES 3.0，可在游戏 `env` 设 `PMZ_GLES=2`；若为纯 fbdev/Mali 且无 Wayland/X11/DRM，尝试在游戏 `env` 设 `PMZ_HOST_SDL=1` 启用宿主 64 位 `libSDL2`。 |
| **L5 音频与手柄输入** | 无声、爆音或按键错位 | 核对 `/proc/asound/cards` 与 `SDL_AUDIODRIVER`；按键映射由 `pocketmz-pad.py` 结合 `es_input.cfg` / `gamecontrollerdb.txt` 生成。 |
| **L6 内存与低内存保护** | 进大图或切换场景时被系统杀掉 | 1 GB 内存建议设 swap/zram；可通过 `PMZ_MEM_SOFT_MB`、`PMZ_MEM_HARD_MB`、`PMZ_CS_CACHE_MB` 调整阈值并配合 `pocketmz-probe.py` 观察曲线。 |

---

## 四、基于 `PocketMZ Bench` 的 4 步阶梯冒烟流程

移植新机型或新系统时，请不要直接拿几十 GB 的复杂商业游戏测试，按以下 4 步逐级验收：

1. **第 1 步（环境快照）**：运行 `sh pocketmz-sysinfo.sh`，确认 `aarch64`、64 位 GL/SDL 库路径与设备节点（`/dev/dri` 或 `/dev/mali*` / `/dev/pvr*` / `/dev/fb0`）清晰。
2. **第 2 步（选单与扫描）**：启动 Ports → `PocketMZ`，确认安装成功、中文/英文/日文界面正常渲染、能扫描出 `PocketMZ Bench MV` 与 `PocketMZ Bench MZ`。
3. **第 3 步（基准进入标题与地图）**：运行 `PocketMZ Bench MZ`（以及 MV），确认标题画面、进入地图、声音播放、方向键/确认键、`Select + X` 菜单、`Select + Start` 退出均正常。
4. **第 4 步（存档与长稳）**：保存并读取存档，连续切图/测试压力场景 2～3 分钟，保留 `pocketmz-last.log`、`logs/menu.log`、`logs/last-game-run.log` 和 `pocketmz-sysinfo.txt` 一并反馈。

---

## 五、提交移植报告或 PR

- **提交移植反馈**：请在 GitHub 使用 **Porting Report（新机型/系统移植反馈）** Issue 模板，附上 `pocketmz-sysinfo.txt` 与 `PocketMZ/logs/` 日志。
- **提交代码 PR**：优先修改通用环境探测逻辑（如库搜索路径、驱动识别），避免写死单一机型名称或引入不可逆系统修改；所有 `.sh` 文件必须保持 **LF** 换行并通过 `bash -n` 检查。
