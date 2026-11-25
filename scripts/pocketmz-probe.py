#!/usr/bin/env python3
"""PocketMZ continuous + event-driven telemetry recorder and analyzer.

Modes:
  --record  Run alongside a game, sampling system/DRM/GEM/thermal/power every N
            seconds and merging continuous 5s engine windows + stutter/scene
            events from --engine-log into a single JSONL file.
  --report  Summarize a recorded JSONL session (or --latest in telemetry/).
"""

import argparse
import glob
import json
import os
import signal
import sys
import time

TELEMETRY_DIR = "/storage/pocketmz/telemetry"
CGROUP_DIR = "/sys/fs/cgroup/unified/pocketmz"
DRI_GEMS_PATH = "/sys/kernel/debug/dri/128/gems"
CLK_TCK = os.sysconf(os.sysconf_names.get("SC_CLK_TCK", "SC_CLK_TCK")) if hasattr(os, "sysconf") else 100
MAX_FILES = 30
MAX_TOTAL_BYTES = 50 * 1024 * 1024


def read_text(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read().strip()
    except OSError:
        return None


def read_int(path):
    s = read_text(path)
    if s is None:
        return None
    try:
        return int(s.split()[0])
    except ValueError:
        return None


def read_meminfo():
    txt = read_text("/proc/meminfo")
    if not txt:
        return {}
    want = ("MemTotal", "MemAvailable", "Shmem", "SwapTotal", "SwapFree")
    kv = {}
    for line in txt.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            k = parts[0].rstrip(":")
            if k in want:
                try:
                    kv[k] = int(parts[1]) / 1024.0
                except ValueError:
                    pass
    out = {}
    if "MemAvailable" in kv:
        out["memAvailMB"] = round(kv["MemAvailable"], 1)
    if "Shmem" in kv:
        out["shmemMB"] = round(kv["Shmem"], 1)
    if "SwapTotal" in kv and "SwapFree" in kv:
        out["swapUsedMB"] = round(kv["SwapTotal"] - kv["SwapFree"], 1)
    return out


def read_vmstat():
    txt = read_text("/proc/vmstat")
    out = {}
    if not txt:
        return out
    for line in txt.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] in ("pswpin", "pswpout"):
            try:
                out[parts[0]] = int(parts[1])
            except ValueError:
                pass
    return out


def read_cgroup():
    if not os.path.isdir(CGROUP_DIR):
        return {}
    out = {}
    for name, key in (("memory.current", "cgCurMB"), ("memory.swap.current", "cgSwapMB"), ("memory.peak", "cgPeakMB")):
        v = read_int(os.path.join(CGROUP_DIR, name))
        if v is not None:
            out[key] = round(v / 1048576.0, 1)
    stat = read_text(os.path.join(CGROUP_DIR, "memory.stat"))
    if stat:
        for line in stat.splitlines():
            parts = line.split()
            if len(parts) == 2:
                k, val = parts[0], int(parts[1])
                if k == "anon":
                    out["cgAnonMB"] = round(val / 1048576.0, 1)
                elif k == "shmem":
                    out["cgShmemMB"] = round(val / 1048576.0, 1)
                elif k == "pgmajfault":
                    out["_pgmaj"] = val
    return out


def find_game_pid():
    procs_txt = read_text(os.path.join(CGROUP_DIR, "cgroup.procs"))
    if procs_txt:
        for line in procs_txt.splitlines():
            pid_s = line.strip()
            if not pid_s.isdigit():
                continue
            comm = read_text(f"/proc/{pid_s}/comm") or ""
            if comm in ("node", "MainThread", "nw"):
                return int(pid_s)
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        comm = read_text(f"/proc/{entry}/comm") or ""
        if comm in ("MainThread", "node", "nw"):
            cmd = read_text(f"/proc/{entry}/cmdline") or ""
            if "pmzrun.js" in cmd or "/opt/nwjs/nw" in cmd:
                return int(entry)
    return None


def read_proc_stats(pid):
    out = {"pid": pid}
    st = read_text(f"/proc/{pid}/status")
    if st:
        for line in st.splitlines():
            for src, dst in (("VmRSS:", "rssMB"), ("RssAnon:", "anonMB"), ("VmSwap:", "swapMB"), ("Threads:", "threads")):
                if line.startswith(src):
                    parts = line.split()
                    if len(parts) >= 2 and parts[1].isdigit():
                        v = int(parts[1])
                        out[dst] = v if dst == "threads" else round(v / 1024.0, 1)
    stat_txt = read_text(f"/proc/{pid}/stat")
    if stat_txt:
        rparen = stat_txt.rfind(")")
        if rparen != -1:
            fields = stat_txt[rparen + 2:].split()
            if len(fields) > 13:
                try:
                    out["_cpuTicks"] = int(fields[11]) + int(fields[12])
                except ValueError:
                    pass
    try:
        out["fds"] = len(os.listdir(f"/proc/{pid}/fd"))
    except OSError:
        pass
    # Panfrost / DRM fdinfo
    drm_tot = drm_res = drm_pur = 0.0
    found_drm = False
    for fp in glob.glob(f"/proc/{pid}/fdinfo/*"):
        txt = read_text(fp)
        if not txt or "drm-total-memory:" not in txt:
            continue
        found_drm = True
        cur_tot = cur_res = cur_pur = 0.0
        for line in txt.splitlines():
            if line.startswith("drm-total-memory:"):
                cur_tot = int(line.split()[1]) / 1024.0
            elif line.startswith("drm-resident-memory:"):
                cur_res = int(line.split()[1]) / 1024.0
            elif line.startswith("drm-purgeable-memory:"):
                cur_pur = int(line.split()[1]) / 1024.0
        if cur_tot > drm_tot:
            drm_tot, drm_res, drm_pur = cur_tot, cur_res, cur_pur
    if found_drm:
        out["drmTotalMB"] = round(drm_tot, 1)
        out["drmResMB"] = round(drm_res, 1)
        out["drmPurgeMB"] = round(drm_pur, 1)
    return out


def read_gems_top(pid, top_n=8):
    txt = read_text(DRI_GEMS_PATH)
    if not txt:
        return None
    pid_s = str(pid)
    by_size = {}
    for line in txt.splitlines():
        cols = line.split()
        if len(cols) < 5 or cols[0].rsplit("/", 1)[-1] != pid_s:
            continue
        try:
            sz = int(cols[3])
            res = int(cols[4])
        except ValueError:
            continue
        cur = by_size.get(sz)
        if cur:
            cur[0] += 1
            cur[1] += res
        else:
            by_size[sz] = [1, res]
    if not by_size:
        return None
    ranked = sorted(by_size.items(), key=lambda kv: kv[1][1], reverse=True)[:top_n]
    return [[sz, cnt, round(res_sum / 1048576.0, 2)] for sz, (cnt, res_sum) in ranked]


def read_hw():
    out = {}
    on = read_text("/sys/devices/system/cpu/online")
    if on is not None:
        out["cpuOnline"] = on
    cf = read_int("/sys/devices/system/cpu/cpufreq/policy0/scaling_cur_freq")
    if cf is not None:
        out["cpuMhz"] = round(cf / 1000.0)
    gf = read_int("/sys/class/devfreq/fde60000.gpu/cur_freq")
    if gf is None:
        for p in glob.glob("/sys/class/devfreq/*.gpu/cur_freq"):
            gf = read_int(p)
            if gf is not None:
                break
    if gf is not None:
        out["gpuMhz"] = round(gf / 1e6)
    ct = read_int("/sys/class/thermal/thermal_zone0/temp")
    gt = read_int("/sys/class/thermal/thermal_zone1/temp")
    if ct is not None:
        out["cpuTempC"] = round(ct / 1000.0, 1)
    if gt is not None:
        out["gpuTempC"] = round(gt / 1000.0, 1)
    bp = read_int("/sys/class/power_supply/battery/capacity")
    bv = read_int("/sys/class/power_supply/battery/voltage_avg")
    ba = read_int("/sys/class/power_supply/battery/current_avg")
    bs = read_text("/sys/class/power_supply/battery/status")
    if bp is not None:
        out["battPct"] = bp
    if bv is not None:
        out["battV"] = round(bv / 1e6, 3)
    if ba is not None:
        out["battMa"] = round(ba / 1e3, 1)
    if bs is not None:
        out["battStatus"] = bs
    return out


def rotate_telemetry():
    files = sorted(glob.glob(os.path.join(TELEMETRY_DIR, "*.jsonl")), key=lambda p: os.path.getmtime(p))
    while len(files) > MAX_FILES:
        old = files.pop(0)
        try:
            os.remove(old)
        except OSError:
            pass
    total = sum(os.path.getsize(p) for p in files if os.path.exists(p))
    while total > MAX_TOTAL_BYTES and len(files) > 1:
        old = files.pop(0)
        try:
            sz = os.path.getsize(old)
            os.remove(old)
            total -= sz
        except OSError:
            pass


def drain_engine_log(path, offset, out_f):
    if not path or not os.path.exists(path):
        return offset
    try:
        sz = os.path.getsize(path)
        if sz < offset:
            offset = 0
        if sz == offset:
            return offset
        with open(path, "r", encoding="utf-8", errors="replace") as ef:
            ef.seek(offset)
            chunk = ef.read()
            new_off = ef.tell()
        for line in chunk.splitlines():
            s = line.strip()
            if s:
                out_f.write(s + "\n")
        return new_off
    except OSError:
        return offset


def run_record(args):
    os.makedirs(os.path.dirname(args.out) or TELEMETRY_DIR, exist_ok=True)
    stop = False

    def on_sig(signum, frame):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, on_sig)
    signal.signal(signal.SIGINT, on_sig)

    t0 = time.time()
    eng_off = 0
    prev_vm = read_vmstat()
    prev_pgmaj = None
    prev_pid = None
    prev_ticks = None
    prev_tick_t = None
    last_gem_t = 0.0
    last_gem_drm = -100.0

    with open(args.out, "w", encoding="utf-8") as out_f:
        start_ev = {
            "ev": "start",
            "ts": round(t0, 2),
            "iso": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t0)),
            "game": args.game,
            "title": args.title,
            "rt": args.rt,
            "interval": args.interval,
        }
        out_f.write(json.dumps(start_ev, ensure_ascii=False) + "\n")
        out_f.flush()

        next_sample = time.monotonic()
        while not stop:
            now_m = time.monotonic()
            if now_m < next_sample:
                time.sleep(min(0.5, next_sample - now_m))
                if args.watch_pid and not os.path.exists(f"/proc/{args.watch_pid}"):
                    break
                continue
            next_sample = now_m + args.interval

            eng_off = drain_engine_log(args.engine_log, eng_off, out_f)

            now_wall = time.time()
            rec = {"ev": "sys", "ts": round(now_wall, 2), "up": round(now_wall - t0, 1)}
            rec.update(read_meminfo())

            cg = read_cgroup()
            pgmaj = cg.pop("_pgmaj", None)
            if pgmaj is not None and prev_pgmaj is not None:
                rec["dPgmaj"] = max(0, pgmaj - prev_pgmaj)
            prev_pgmaj = pgmaj
            rec.update(cg)

            vm = read_vmstat()
            if "pswpin" in vm and "pswpin" in prev_vm:
                rec["dPswpin"] = max(0, vm["pswpin"] - prev_vm["pswpin"])
            if "pswpout" in vm and "pswpout" in prev_vm:
                rec["dPswpout"] = max(0, vm["pswpout"] - prev_vm["pswpout"])
            prev_vm = vm

            pid = find_game_pid()
            if pid is not None:
                ps = read_proc_stats(pid)
                ticks = ps.pop("_cpuTicks", None)
                if pid == prev_pid and ticks is not None and prev_ticks is not None and prev_tick_t is not None:
                    dt_wall = now_m - prev_tick_t
                    if dt_wall > 0.1:
                        rec["cpuPct"] = round(((ticks - prev_ticks) / float(CLK_TCK)) / dt_wall * 100.0, 1)
                prev_pid = pid
                prev_ticks = ticks
                prev_tick_t = now_m
                rec.update(ps)

                drm_now = rec.get("drmTotalMB", 0.0)
                if (now_m - last_gem_t >= 60.0) or (drm_now - last_gem_drm >= 4.0) or last_gem_t == 0.0:
                    gems = read_gems_top(pid)
                    if gems is not None:
                        rec["gemsTop"] = gems
                        last_gem_t = now_m
                        last_gem_drm = drm_now

            rec.update(read_hw())
            out_f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            out_f.flush()

        eng_off = drain_engine_log(args.engine_log, eng_off, out_f)
        end_t = time.time()
        out_f.write(json.dumps({"ev": "end", "ts": round(end_t, 2), "durSec": round(end_t - t0, 1)}, ensure_ascii=False) + "\n")
        out_f.flush()

    rotate_telemetry()
    return 0


def pick_report_path(path_arg, latest):
    if path_arg and not latest:
        return path_arg
    files = sorted(glob.glob(os.path.join(TELEMETRY_DIR, "*.jsonl")), key=lambda p: os.path.getmtime(p))
    return files[-1] if files else None


def slope_mb_per_hour(series):
    """series: list of (up_sec, val). Uses first vs last and linear regression."""
    if len(series) < 2:
        return None
    dt_h = (series[-1][0] - series[0][0]) / 3600.0
    if dt_h <= 0.001:
        return None
    return round((series[-1][1] - series[0][1]) / dt_h, 2)


def run_report(args):
    path = pick_report_path(args.report, args.latest)
    if not path or not os.path.exists(path):
        print("No telemetry JSONL file found.", file=sys.stderr)
        return 1

    start_ev = None
    end_ev = None
    sys_rows = []
    win_rows = []
    stutters = []
    scenes = []

    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            kind = ev.get("ev")
            if kind == "start":
                start_ev = ev
            elif kind == "end":
                end_ev = ev
            elif kind == "sys":
                sys_rows.append(ev)
            elif kind == "win":
                win_rows.append(ev)
            elif kind == "stutter":
                stutters.append(ev)
            elif kind == "scene":
                scenes.append(ev)

    dur_sec = end_ev["durSec"] if end_ev and "durSec" in end_ev else (
        max([r.get("up", 0) for r in sys_rows + win_rows] or [0])
    )
    print(f"=== PocketMZ Telemetry Report: {os.path.basename(path)} ===")
    if start_ev:
        print(f"Game: {start_ev.get('title', '?')} ({start_ev.get('game', '?')}) | Runtime: {start_ev.get('rt', '?')} | Start: {start_ev.get('iso', '?')}")
    print(f"Duration: {dur_sec:.1f}s ({dur_sec/60:.1f} min) | Sys samples: {len(sys_rows)} | Engine 5s windows: {len(win_rows)} | Scene changes: {len(scenes)} | Stutters (>=100ms): {len(stutters)}")

    # Frame & stutter summary
    wins_with_frames = [r for r in win_rows if isinstance(r.get("win"), dict) and r["win"].get("n", 0) > 0]
    if wins_with_frames:
        tot_n = sum(r["win"]["n"] for r in wins_with_frames)
        w_avg_ms = sum(r["win"]["avgMs"] * r["win"]["n"] for r in wins_with_frames) / tot_n
        p50s = sorted(r["win"]["p50"] for r in wins_with_frames)
        p95_max = max(r["win"]["p95"] for r in wins_with_frames)
        p99_max = max(r["win"]["p99"] for r in wins_with_frames)
        max_ms = max(r["win"]["maxMs"] for r in wins_with_frames)
        js_avg = sum(r["win"]["jsAvg"] * r["win"]["n"] for r in wins_with_frames) / tot_n
        sw_avg = sum(r["win"]["swapAvg"] * r["win"]["n"] for r in wins_with_frames) / tot_n
        o33 = sum(r["win"]["over33"] for r in wins_with_frames)
        o50 = sum(r["win"]["over50"] for r in wins_with_frames)
        o100 = sum(r["win"]["over100"] for r in wins_with_frames)
        print(f"\n[Frames] total={tot_n} | avgFPS={1000.0/w_avg_ms:.1f} ({w_avg_ms:.2f} ms) | medP50={p50s[len(p50s)//2]:.1f} | maxP95={p95_max:.1f} | maxP99={p99_max:.1f} | worstFrame={max_ms:.1f} ms")
        print(f"         jsAvg={js_avg:.2f} ms | swapAvg={sw_avg:.2f} ms | >33ms={o33} | >50ms={o50} | >100ms={o100}")

        by_scene = {}
        for r in wins_with_frames:
            sc = r.get("scene") or "?"
            by_scene.setdefault(sc, []).append(r["win"])
        print("\n[Per-Scene]")
        for sc, lst in sorted(by_scene.items(), key=lambda kv: sum(w["n"] for w in kv[1]), reverse=True):
            sn = sum(w["n"] for w in lst)
            s_avg = sum(w["avgMs"] * w["n"] for w in lst) / sn
            s_p95 = max(w["p95"] for w in lst)
            s_o100 = sum(w["over100"] for w in lst)
            print(f"  {sc:20s}: ~{len(lst)*5:4d}s | avgFPS={1000.0/s_avg:4.1f} | maxP95={s_p95:5.1f} ms | >100ms={s_o100}")

    if stutters:
        print("\n[Top 10 Stutters]")
        for s in sorted(stutters, key=lambda x: x.get("dt", 0), reverse=True)[:10]:
            ts = s.get("ts", 0)
            nearest = min(sys_rows, key=lambda r: abs(r.get("ts", 0) - ts)) if sys_rows else {}
            print(f"  @{s.get('up', 0):6.1f}s dt={s.get('dt', 0):6.1f}ms (js={s.get('js', 0):.1f} swap={s.get('swap', 0):.1f}) {s.get('scene', '?')} map={s.get('mapId', 0)} | memAvail={nearest.get('memAvailMB', '?')}MB dPgmaj={nearest.get('dPgmaj', '?')}")

    # Memory & GPU leak analysis
    print("\n[Memory & GPU]")
    for label, rows, key in (
        ("drmTotalMB", sys_rows, "drmTotalMB"),
        ("drmResMB", sys_rows, "drmResMB"),
        ("rssMB", sys_rows, "rssMB"),
        ("anonMB", sys_rows, "anonMB"),
        ("swapMB", sys_rows, "swapMB"),
        ("memAvailMB", sys_rows, "memAvailMB"),
        ("heapMB", win_rows, "heapMB"),
        ("canvasMB", win_rows, "canvasMB"),
        ("imageMB", win_rows, "imageMB"),
    ):
        pts = [(r.get("up", 0), r[key]) for r in rows if key in r and r[key] is not None]
        if not pts:
            continue
        vals = [p[1] for p in pts]
        sl = slope_mb_per_hour(pts)
        sl_s = f"{sl:+.1f} MB/h" if sl is not None else "n/a"
        print(f"  {label:11s}: start={vals[0]:6.1f}  min={min(vals):6.1f}  peak={max(vals):6.1f}  end={vals[-1]:6.1f}  slope={sl_s}")

    tot_pgmaj = sum(r.get("dPgmaj", 0) for r in sys_rows)
    tot_swpin = sum(r.get("dPswpin", 0) for r in sys_rows)
    tot_swpout = sum(r.get("dPswpout", 0) for r in sys_rows)
    if sys_rows:
        print(f"  paging     : pgmajfault={tot_pgmaj} | pswpin={tot_swpin} | pswpout={tot_swpout}")

    gem_snaps = [r for r in sys_rows if r.get("gemsTop")]
    if gem_snaps:
        first_g = {sz: (cnt, mb) for sz, cnt, mb in gem_snaps[0]["gemsTop"]}
        last_g = {sz: (cnt, mb) for sz, cnt, mb in gem_snaps[-1]["gemsTop"]}
        all_sz = sorted(set(first_g) | set(last_g), key=lambda sz: last_g.get(sz, (0, 0))[1] - first_g.get(sz, (0, 0))[1], reverse=True)
        print("\n[Panfrost GEM Top Sizes (first -> last)]")
        for sz in all_sz[:6]:
            c0, m0 = first_g.get(sz, (0, 0.0))
            c1, m1 = last_g.get(sz, (0, 0.0))
            print(f"  {sz:10d} B ({sz/1048576:.2f} MB): {c0:3d} ({m0:5.1f} MB) -> {c1:3d} ({m1:5.1f} MB)  delta={m1-m0:+.1f} MB")

    # Hardware & battery
    if sys_rows:
        onlines = sorted(set(r["cpuOnline"] for r in sys_rows if "cpuOnline" in r))
        cmhz = [r["cpuMhz"] for r in sys_rows if "cpuMhz" in r]
        gmhz = [r["gpuMhz"] for r in sys_rows if "gpuMhz" in r]
        ctemp = [r["cpuTempC"] for r in sys_rows if "cpuTempC" in r]
        gtemp = [r["gpuTempC"] for r in sys_rows if "gpuTempC" in r]
        bpct = [r["battPct"] for r in sys_rows if "battPct" in r]
        pw_w = [abs(r["battV"] * r["battMa"]) / 1000.0 for r in sys_rows if "battV" in r and "battMa" in r and r["battMa"] != 0]
        print("\n[Hardware & Power]")
        print(f"  cpuOnline={onlines} | cpuMhz={min(cmhz) if cmhz else '?'}..{max(cmhz) if cmhz else '?'} | gpuMhz={min(gmhz) if gmhz else '?'}..{max(gmhz) if gmhz else '?'}")
        print(f"  cpuTemp={max(ctemp) if ctemp else '?'}C max | gpuTemp={max(gtemp) if gtemp else '?'}C max")
        if bpct:
            pw_s = f"{sum(pw_w)/len(pw_w):.2f}W avg" if pw_w else "n/a"
            print(f"  battery={bpct[0]}% -> {bpct[-1]}% | power={pw_s}")

    if win_rows:
        last_w = win_rows[-1]
        print(f"\n[Engine Totals] glErrs={last_w.get('glErrs', 0)} | otherErrs={last_w.get('otherErrs', 0)} | snaps={last_w.get('snaps', 0)} | glGc={last_w.get('glGc')} | auBufMB={last_w.get('auBufMB')} | auOver50={last_w.get('auOver50')}")
    return 0


def main():
    ap = argparse.ArgumentParser(description="PocketMZ telemetry probe")
    ap.add_argument("--record", action="store_true", help="Record telemetry to JSONL")
    ap.add_argument("--out", help="Output JSONL path")
    ap.add_argument("--game", default="", help="Game ID")
    ap.add_argument("--title", default="", help="Game title")
    ap.add_argument("--rt", default="", help="Runtime (beta|nw)")
    ap.add_argument("--engine-log", default="", help="Engine probe JSONL pipe file")
    ap.add_argument("--interval", type=float, default=5.0, help="Sampling interval (s)")
    ap.add_argument("--watch-pid", type=int, default=0, help="Stop when parent PID exits")
    ap.add_argument("--report", nargs="?", const="", default=None, help="Analyze JSONL file")
    ap.add_argument("--latest", action="store_true", help="Analyze latest JSONL in telemetry/")
    args = ap.parse_args()
    if args.record:
        if not args.out:
            ap.error("--record requires --out")
        return run_record(args)
    if args.report is not None or args.latest:
        return run_report(args)
    ap.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
