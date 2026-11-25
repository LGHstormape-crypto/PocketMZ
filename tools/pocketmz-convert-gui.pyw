# SPDX-License-Identifier: MIT
"""PocketMZ 转换器 图形界面：调用 pocketmz-convert.py。"""

import glob
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import tkinter as tk
import tkinter.font as tkfont
from tkinter import filedialog, messagebox, ttk

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "pocketmz-convert.py")
CONFIG_PATH = os.path.join(os.environ.get("APPDATA") or HERE, "PocketMZ", "converter.json")
DEFAULT_HOST = "rocknix.local"
FFMPEG_MISSING = "未找到 ffmpeg（可用 winget install Gyan.FFmpeg 安装后重开本程序）"


def find_ffmpeg_dir():
    """返回 (是否找到, 需要加入子进程 PATH 的目录或 None)。"""
    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        return True, None
    local = os.environ.get("LOCALAPPDATA")
    if local:
        cands = [os.path.join(local, "Microsoft", "WinGet", "Links")]
        cands += glob.glob(os.path.join(local, "Microsoft", "WinGet", "Packages",
                                        "Gyan.FFmpeg*", "*", "bin"))
        for d in cands:
            if (os.path.isfile(os.path.join(d, "ffmpeg.exe"))
                    and os.path.isfile(os.path.join(d, "ffprobe.exe"))):
                return True, d
    return False, None


def child_python():
    exe = sys.executable or "python"
    if os.path.basename(exe).lower() == "pythonw.exe":
        cand = os.path.join(os.path.dirname(exe), "python.exe")
        if os.path.isfile(cand):
            return cand
    return exe


def load_config():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_config(data):
    try:
        os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except OSError:
        pass


class App:
    def __init__(self, root, paths):
        self.root = root
        self.proc = None
        self.q = queue.Queue()
        self.running = False
        self.stopped = False
        self.ffmpeg_ok, self.ffmpeg_dir = find_ffmpeg_dir()
        cfg = load_config()

        root.title("PocketMZ 转换器")
        root.geometry("780x600")
        root.minsize(640, 480)

        self.v_out = tk.StringVar(value=str(cfg.get("out", "")))
        self.v_dry = tk.BooleanVar(value=False)
        self.v_keep = tk.BooleanVar(value=bool(cfg.get("keep_runtime", False)))
        self.v_video = tk.BooleanVar(value=bool(cfg.get("video", False)) and self.ffmpeg_ok)
        vh = cfg.get("video_height", "480")
        self.v_vmode = tk.StringVar(value="480" if str(vh) == "480" else "720" if str(vh) == "720" else "custom")
        self.v_vcustom = tk.StringVar(value=str(vh) if self.v_vmode.get() == "custom" else "1080")
        self.v_send = tk.BooleanVar(value=bool(cfg.get("send", False)))
        self.v_host = tk.StringVar(value=str(cfg.get("host", DEFAULT_HOST)) or DEFAULT_HOST)
        self.v_status = tk.StringVar(value="就绪")

        self.build()
        for p in paths:
            self.add_path(p)
        self.update_video_state()
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.poll()

    # ---------- UI ----------
    def build(self):
        main = ttk.Frame(self.root, padding=8)
        main.pack(fill="both", expand=True)
        main.columnconfigure(0, weight=1)
        main.rowconfigure(5, weight=1)

        # 输入列表
        fin = ttk.LabelFrame(main, text="要转换的压缩包 / 文件夹", padding=6)
        fin.grid(row=0, column=0, sticky="ew")
        fin.columnconfigure(0, weight=1)
        self.lb = tk.Listbox(fin, height=5, selectmode="extended")
        self.lb.grid(row=0, column=0, sticky="nsew")
        sb = ttk.Scrollbar(fin, command=self.lb.yview)
        sb.grid(row=0, column=1, sticky="ns")
        self.lb.config(yscrollcommand=sb.set)
        bf = ttk.Frame(fin)
        bf.grid(row=0, column=2, sticky="n", padx=(6, 0))
        for text, cmd in (("添加压缩包…", self.add_files), ("添加文件夹…", self.add_folder),
                          ("移除所选", self.remove_sel), ("清空", self.clear_all)):
            ttk.Button(bf, text=text, command=cmd).pack(fill="x", pady=1)

        # 输出目录
        fo = ttk.Frame(main)
        fo.grid(row=1, column=0, sticky="ew", pady=(6, 0))
        fo.columnconfigure(1, weight=1)
        ttk.Label(fo, text="输出目录：").grid(row=0, column=0)
        ttk.Entry(fo, textvariable=self.v_out).grid(row=0, column=1, sticky="ew")
        ttk.Button(fo, text="浏览…", command=self.browse_out).grid(row=0, column=2, padx=(6, 0))
        ttk.Label(fo, text="留空 = 输入所在目录\\_converted", foreground="gray").grid(
            row=1, column=1, sticky="w")

        # 选项
        fopt = ttk.LabelFrame(main, text="选项", padding=6)
        fopt.grid(row=2, column=0, sticky="ew", pady=(6, 0))
        ttk.Checkbutton(fopt, text="只检查（不解压、不移动、不发送）", variable=self.v_dry).grid(
            row=0, column=0, columnspan=5, sticky="w")
        ttk.Checkbutton(fopt, text="保留 Windows 运行时文件", variable=self.v_keep).grid(
            row=1, column=0, columnspan=5, sticky="w")

        self.cb_video = ttk.Checkbutton(fopt, text="转码视频（需要 ffmpeg）", variable=self.v_video,
                                        command=self.update_video_state)
        self.cb_video.grid(row=2, column=0, sticky="w")
        self.rb480 = ttk.Radiobutton(fopt, text="480p", value="480", variable=self.v_vmode,
                                     command=self.update_video_state)
        self.rb720 = ttk.Radiobutton(fopt, text="720p", value="720", variable=self.v_vmode,
                                     command=self.update_video_state)
        self.rbc = ttk.Radiobutton(fopt, text="自定义", value="custom", variable=self.v_vmode,
                                   command=self.update_video_state)
        self.rb480.grid(row=2, column=1, padx=(10, 0))
        self.rb720.grid(row=2, column=2)
        self.rbc.grid(row=2, column=3)
        self.e_vc = ttk.Entry(fopt, textvariable=self.v_vcustom, width=6)
        self.e_vc.grid(row=2, column=4, sticky="w")
        self.l_vnote = ttk.Label(fopt, text="只转比目标高度大的视频，宽度按原比例", foreground="gray")
        self.l_vnote.grid(row=3, column=0, columnspan=5, sticky="w")
        if not self.ffmpeg_ok:
            ttk.Label(fopt, text=FFMPEG_MISSING, foreground="#b00020").grid(
                row=4, column=0, columnspan=5, sticky="w")

        ttk.Checkbutton(fopt, text="转换后发送到掌机", variable=self.v_send,
                        command=self.update_video_state).grid(row=5, column=0, sticky="w", pady=(4, 0))
        self.e_host = ttk.Entry(fopt, textvariable=self.v_host, width=22)
        self.e_host.grid(row=5, column=1, columnspan=3, sticky="w", pady=(4, 0), padx=(10, 0))
        ttk.Label(fopt, text="需要已配置 ssh 密钥登录", foreground="gray").grid(
            row=6, column=0, columnspan=5, sticky="w")

        # 按钮
        fb = ttk.Frame(main)
        fb.grid(row=3, column=0, sticky="ew", pady=6)
        self.b_start = ttk.Button(fb, text="开始", command=self.start)
        self.b_start.pack(side="left")
        self.b_stop = ttk.Button(fb, text="停止", command=self.stop, state="disabled")
        self.b_stop.pack(side="left", padx=6)
        ttk.Button(fb, text="打开输出目录", command=self.open_out).pack(side="left")

        ttk.Label(main, text="日志").grid(row=4, column=0, sticky="w")
        fl = ttk.Frame(main)
        fl.grid(row=5, column=0, sticky="nsew")
        fl.columnconfigure(0, weight=1)
        fl.rowconfigure(0, weight=1)
        fams = set(tkfont.families())
        fam = next((f for f in ("MS Gothic", "NSimSun", "SimSun") if f in fams), "TkFixedFont")
        self.log = tk.Text(fl, height=10, state="disabled", wrap="none", font=(fam, 10))
        self.log.grid(row=0, column=0, sticky="nsew")
        ys = ttk.Scrollbar(fl, command=self.log.yview)
        ys.grid(row=0, column=1, sticky="ns")
        xs = ttk.Scrollbar(fl, orient="horizontal", command=self.log.xview)
        xs.grid(row=1, column=0, sticky="ew")
        self.log.config(yscrollcommand=ys.set, xscrollcommand=xs.set)

        ttk.Label(main, textvariable=self.v_status, relief="sunken", anchor="w").grid(
            row=6, column=0, sticky="ew", pady=(6, 0))

    def update_video_state(self):
        if not self.ffmpeg_ok:
            self.v_video.set(False)
            for w in (self.cb_video, self.rb480, self.rb720, self.rbc, self.e_vc):
                w.state(["disabled"])
        else:
            on = self.v_video.get()
            for w in (self.rb480, self.rb720, self.rbc):
                w.state(["!disabled"] if on else ["disabled"])
            self.e_vc.state(["!disabled"] if on and self.v_vmode.get() == "custom" else ["disabled"])
        self.e_host.state(["!disabled"] if self.v_send.get() else ["disabled"])

    # ---------- input list ----------
    def add_path(self, p):
        p = os.path.normpath(p)
        if p not in self.lb.get(0, "end"):
            self.lb.insert("end", p)

    def add_files(self):
        fs = filedialog.askopenfilenames(
            title="选择游戏压缩包",
            filetypes=[("压缩包", "*.zip *.7z *.rar"), ("所有文件", "*.*")])
        for f in fs:
            self.add_path(f)

    def add_folder(self):
        d = filedialog.askdirectory(title="选择游戏文件夹或包含它们的文件夹")
        if d:
            self.add_path(d)

    def remove_sel(self):
        for i in reversed(self.lb.curselection()):
            self.lb.delete(i)

    def clear_all(self):
        self.lb.delete(0, "end")

    def browse_out(self):
        d = filedialog.askdirectory(title="选择输出目录")
        if d:
            self.v_out.set(os.path.normpath(d))

    # ---------- args / config ----------
    def video_height(self):
        """返回高度整数；自定义无效时弹窗并返回 None。"""
        m = self.v_vmode.get()
        if m != "custom":
            return int(m)
        s = self.v_vcustom.get().strip()
        try:
            h = int(s)
            if 144 <= h <= 2160:
                return h
        except ValueError:
            pass
        messagebox.showerror("自定义高度无效", "视频高度必须是 144–2160 之间的整数。")
        return None

    def build_args(self, paths):
        args = []
        out = self.v_out.get().strip()
        if out:
            args += ["--out", out]
        if self.v_dry.get():
            args.append("--dry-run")
        if self.v_keep.get():
            args.append("--keep-runtime")
        if self.v_video.get():
            h = self.video_height()
            if h is None:
                return None
            args += ["--video", "--video-height", str(h)]
        if self.v_send.get():
            args += ["--send", self.v_host.get().strip() or DEFAULT_HOST]
        return args + list(paths)

    def save_options(self):
        m = self.v_vmode.get()
        vh = m if m != "custom" else self.v_vcustom.get().strip()
        save_config({"out": self.v_out.get().strip(), "video": self.v_video.get(),
                     "video_height": vh, "send": self.v_send.get(),
                     "host": self.v_host.get().strip() or DEFAULT_HOST,
                     "keep_runtime": self.v_keep.get()})

    # ---------- run ----------
    def put_log(self, text):
        self.log.config(state="normal")
        self.log.insert("end", text)
        self.log.see("end")
        self.log.config(state="disabled")

    def start(self):
        if self.running:
            return
        paths = list(self.lb.get(0, "end"))
        if not paths:
            messagebox.showinfo("没有输入", "请先添加压缩包或文件夹。")
            return
        args = self.build_args(paths)
        if args is None:
            return
        self.save_options()
        cmd = [child_python(), "-u", CLI] + args
        env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
        if self.ffmpeg_dir:
            env["PATH"] = self.ffmpeg_dir + os.pathsep + env.get("PATH", "")
        self.put_log("> " + " ".join(cmd[2:]) + "\n")
        try:
            self.proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                env=env, creationflags=subprocess.CREATE_NO_WINDOW)
        except OSError as e:
            messagebox.showerror("无法启动", str(e))
            return
        self.running = True
        self.stopped = False
        self.b_start.state(["disabled"])
        self.b_stop.state(["!disabled"])
        self.v_status.set("正在运行…")
        threading.Thread(target=self.reader, args=(self.proc,), daemon=True).start()

    def reader(self, proc):
        try:
            for raw in proc.stdout:
                self.q.put(("line", raw.decode("utf-8", errors="replace")))
        except Exception as e:  # noqa: BLE001
            self.q.put(("line", "读取输出出错：%s\n" % e))
        code = proc.wait()
        self.q.put(("done", code))

    def poll(self):
        try:
            while True:
                kind, val = self.q.get_nowait()
                if kind == "line":
                    self.put_log(val)
                else:
                    self.on_done(val)
        except queue.Empty:
            pass
        self.root.after(100, self.poll)

    def on_done(self, code):
        self.put_log("完成（退出码 %s）\n" % code)
        self.running = False
        self.proc = None
        self.b_start.state(["!disabled"])
        self.b_stop.state(["disabled"])
        self.v_status.set("已停止（退出码 %s）" % code if self.stopped else "完成（退出码 %s）" % code)

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.stopped = True
            self.put_log("正在停止…\n")
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(self.proc.pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=subprocess.CREATE_NO_WINDOW)

    def open_out(self):
        d = self.v_out.get().strip()
        if not d:
            first = self.lb.get(0) if self.lb.size() else ""
            if first:
                base = first if os.path.isdir(first) else os.path.dirname(first)
                d = os.path.join(base, "_converted")
        if d and os.path.isdir(d):
            try:
                os.startfile(d)
            except OSError:
                pass

    def on_close(self):
        if self.running:
            if not messagebox.askyesno("正在运行", "转换仍在进行，确定退出并停止吗？"):
                return
            self.stop()
        self.root.destroy()


def main():
    root = tk.Tk()
    app = App(root, sys.argv[1:])
    if os.environ.get("POCKETMZ_GUI_SELFTEST"):
        sample = ["C:\\games\\a.zip"]
        app.v_video.set(app.ffmpeg_ok)
        app.v_vmode.set("720")
        app.v_send.set(True)
        app.v_keep.set(True)
        print("ffmpeg:", app.ffmpeg_ok, app.ffmpeg_dir)
        print("python:", child_python())
        print("args:", app.build_args(sample))
        root.after(1000, root.destroy)
    root.mainloop()


if __name__ == "__main__":
    main()
