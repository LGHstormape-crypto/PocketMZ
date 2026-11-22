/*:
 * @target MZ
 * @plugindesc PocketMZ in-game menu (F2 + F1) and "hold F2" hotkeys: pause, frame rate, speed, FPS, volume, key mapping, save backups (load last).
 * @author PocketMZ (MIT)
 *
 * @help
 * Runs on RPG Maker MZ and MV (checks Utils.RPGMAKER_NAME itself). Loaded after all other plugins.
 * F2 + F1 (the handheld's unified hotkeys, read by pocketmz-hotkeys.py) opens an HTML layer over the
 * canvas; the game is paused while it is open and gets no keys. Items: frame rate 30/60,
 * speed 1x-3x (this session only), FPS display, master volume, render scale (next start),
 * key mapping of the pad (written to pocketmz.gptk, applied at once), save backups, quit.
 * Settings are saved in pocketmz.json of the thin copy (the original game is never written).
 * Hold F2: F1 menu, Start quit, Select title, L3 save screen, R3 load screen, L1 slow motion,
 * R1 fast forward (held), A pause, X screenshot, Y FPS, up/down volume.
 */

(() => {
    "use strict";
    if (!window.Utils || !(Utils.RPGMAKER_NAME === "MZ" || Utils.RPGMAKER_NAME === "MV")) return;
    const IS_MZ = Utils.RPGMAKER_NAME === "MZ";

    // In-game PocketMZ menu (F2 + F1). An HTML layer
    // over the canvas; the game is paused while it is open (no updates, picture kept) and gets
    // no keys. Live settings: frame rate 30/60, speed 1x-3x (this session only), FPS display,
    // master volume, key mapping. Next-start settings: render scale (read by pocketmz-run.sh).
    // Saved in the thin copy as pocketmz.json (the original game folder is never written).
    const fs = window.require ? require("fs") : null;
    const path = window.require ? require("path") : null;
    const APPDIR = (typeof nw !== "undefined" && nw.__dirname) ||
        (window.process && process.mainModule ? path.dirname(process.mainModule.filename) : null);
    const SETTINGS = fs && APPDIR ? path.join(APPDIR, "pocketmz.json") : null;    // in the thin copy
    const GPTK = fs && APPDIR ? path.join(APPDIR, "pocketmz.gptk") : null;        // gptokeyb map of this game
    const ui = String((window.process && process.env && process.env.POCKETMZ_UI_LANG) || navigator.language || "zh");
    const L = ui.startsWith("ja") ? {
        title: "PocketMZ メニュー", resume: "ゲームに戻る", fps: "フレームレート", speed: "速度",
        showFps: "FPS 表示", volume: "全体音量", scale: "描画解像度", scaleAuto: "画面に合わせる",
        scaleOff: "ゲーム本来", runtime: "実行環境", rtAuto: "自動", rtNow: "現在：", rtNext: "次回ゲーム起動から有効", rtNoBeta: "β 未インストール：NW.js を使います", stopEs: "起動中は ES を閉じる", next: "（次回起動から）", quit: "ゲームを終了", quitAsk: "ゲームを終了しますか？（セーブしていない進行は失われます）",
        yes: "終了", no: "戻る", on: "オン", off: "オフ", hint: "F2 + F1：PocketMZ メニュー",
        keys: "↑↓ 選択 · ←→ 変更 · A 決定 · B 戻る",
        backups: "セーブのバックアップ", noBackups: "バックアップはまだありません（ゲーム起動時に自動で作られます）",
        files: n => n + " ファイル", restoreAsk: t => t + " のセーブに戻しますか？（今のセーブも先にバックアップします）",
        restore: "戻す", restored: "セーブを戻しました。タイトル画面に戻ります。", failed: "失敗しました：", ok: "OK",
        prebuild: "画像の事前処理（一回だけ）", prebuildNote: "大きな画像を画面サイズで保存し、次からの読み込みを速く・軽くします。ゲームは一時停止のまま。", prebuildRun: n => "処理中… " + n, prebuildDone: r => "完了：" + r.built + " 作成、" + r.skipped + " 済み、" + r.failed + " 失敗", prebuildNone: "このゲームには不要です（画像が小さい）",
        keymap: "キー割り当て", note1: "変更はすぐ反映されます（このゲームだけ）。", note2: "F2 + F1 でこのメニューを開きます。",
        stick: "右スティック", dpad: "十字キー / 左スティック", select: "Select", start: "Start",
        stickMouse: "マウスポインタ", stickArrows: "矢印キー", none: "なし", arrows: "矢印キー",
        f2Note: "F2 を押しながら：ホットキー（F2+F1 メニュー、F2+Start 終了）",
        reset: "初期設定に戻す", resetAsk: "キー割り当てを初期設定に戻しますか？", resetYes: "戻す",
        km: { enter: "決定", esc: "キャンセル/メニュー", shift: "ダッシュ", pageup: "前のページ", pagedown: "次のページ",
              z: "決定", x: "キャンセル", space: "決定", mouse_left: "マウス左", mouse_right: "マウス右", nothing: "なし" }
    } : ui.startsWith("en") ? {
        title: "PocketMZ menu", resume: "Resume", fps: "Frame rate", speed: "Speed",
        showFps: "Show FPS", volume: "Master volume", scale: "Render resolution", scaleAuto: "Screen size",
        scaleOff: "Game size", runtime: "Runtime", rtAuto: "Auto", rtNow: "Now: ", rtNext: "Takes effect at the next game start", rtNoBeta: "β is not installed: NW.js will be used", stopEs: "Close ES while playing", next: " (next start)", quit: "Quit game", quitAsk: "Quit the game? (Unsaved progress is lost)",
        yes: "Quit", no: "Back", on: "On", off: "Off", hint: "F2 + F1: PocketMZ menu",
        keys: "↑↓ Select · ←→ Change · A OK · B Back",
        backups: "Save backups", noBackups: "No backups yet (made automatically when the game starts)",
        files: n => n + " files", restoreAsk: t => "Restore the saves from " + t + "? (The current saves are backed up first)",
        restore: "Restore", restored: "Saves restored. Back to the title screen.", failed: "Failed: ", ok: "OK",
        prebuild: "Precompile images (once)", prebuildNote: "Saves big images at screen size so later loads are faster and lighter. The game stays paused.", prebuildRun: n => "Working… " + n, prebuildDone: r => "Done: " + r.built + " made, " + r.skipped + " already there, " + r.failed + " failed", prebuildNone: "Not needed for this game (small images)",
        keymap: "Key mapping", note1: "Changes take effect at once (this game only).", note2: "F2 + F1 opens this menu.",
        stick: "Right stick", dpad: "D-pad / left stick", select: "Select", start: "Start",
        stickMouse: "Mouse pointer", stickArrows: "Arrow keys", none: "Nothing", arrows: "Arrow keys",
        f2Note: "hold F2: hotkeys (F2+F1 menu, F2+Start quit)",
        reset: "Restore defaults", resetAsk: "Restore the default key mapping?", resetYes: "Restore",
        km: { enter: "OK", esc: "Cancel/Menu", shift: "Dash", pageup: "Prev page", pagedown: "Next page",
              z: "OK", x: "Cancel", space: "OK", mouse_left: "Mouse left", mouse_right: "Mouse right", nothing: "Nothing" }
    } : {
        title: "PocketMZ 菜单", resume: "继续游戏", fps: "帧率", speed: "加速",
        showFps: "显示帧数", volume: "总音量", scale: "渲染分辨率", scaleAuto: "按屏幕",
        scaleOff: "游戏原始", runtime: "运行时", rtAuto: "自动", rtNow: "当前：", rtNext: "下次启动游戏生效", rtNoBeta: "β 未安装，将使用 NW.js", stopEs: "运行时关闭 ES（省内存）", next: "（下次启动生效）", quit: "退出游戏", quitAsk: "退出游戏？（没存档的进度会丢失）",
        yes: "退出", no: "返回", on: "开", off: "关", hint: "F2 + F1：PocketMZ 菜单",
        keys: "↑↓ 选择 · ←→ 调整 · A 确定 · B 返回",
        backups: "存档备份", noBackups: "还没有备份（每次启动游戏时自动备份）",
        files: n => n + " 个文件", restoreAsk: t => "恢复到 " + t + " 的存档？（当前存档会先另存一份）",
        restore: "恢复", restored: "存档已恢复，回到标题画面。", failed: "失败：", ok: "好",
        prebuild: "预处理图片（一次性）", prebuildNote: "把大图按屏幕尺寸存下来，以后载入更快、更省内存。处理时游戏保持暂停。", prebuildRun: n => "处理中… " + n, prebuildDone: r => "完成：新建 " + r.built + "，已有 " + r.skipped + "，失败 " + r.failed, prebuildNone: "这个游戏不需要（图片都不大）",
        keymap: "按键映射", note1: "修改立即生效（仅此游戏）。", note2: "F2 + F1 打开本菜单。",
        stick: "右摇杆", dpad: "方向键 / 左摇杆", select: "Select", start: "Start",
        stickMouse: "鼠标指针", stickArrows: "方向键", none: "无", arrows: "方向键",
        f2Note: "按住 F2：热键（F2+F1 菜单，F2+Start 退出）",
        reset: "恢复默认", resetAsk: "恢复默认按键映射？", resetYes: "恢复",
        km: { enter: "确定", esc: "取消/菜单", shift: "冲刺", pageup: "上一页", pagedown: "下一页",
              z: "确定", x: "取消", space: "确定", mouse_left: "鼠标左键", mouse_right: "鼠标右键", nothing: "无" }
    };

    // settings
    const set = { showFps: false, volume: 100, renderScale: "auto" };
    try { if (SETTINGS && fs.existsSync(SETTINGS)) Object.assign(set, JSON.parse(fs.readFileSync(SETTINGS, "utf8"))); } catch (e) {}
    const save = () => {
        if (!SETTINGS) return;
        try { fs.writeFileSync(SETTINGS + ".tmp", JSON.stringify(set, null, 1)); fs.renameSync(SETTINGS + ".tmp", SETTINGS); } catch (e) {}
    };
    let speed = 1;
    // runtime (nw | beta | auto): per game in pocketmz.json ("runtime"), else the global default in settings.json, else nw. The launcher (pocketmz-run.sh) passes
    // POCKETMZ_RT_NOW (the runtime running now), POCKETMZ_RT_GLOBAL (global default) and POCKETMZ_BETA_INST (1 = β installed): /storage is not visible in the game's root.
    const penv = (window.process && process.env) || {};
    const RT_OPTS = ["nw", "beta", "auto"];
    const rtEff = () => RT_OPTS.includes(set.runtime) ? set.runtime : RT_OPTS.includes(penv.POCKETMZ_RT_GLOBAL) ? penv.POCKETMZ_RT_GLOBAL : "nw";
    const rtName = v => v === "beta" ? "β" : v === "auto" ? L.rtAuto : "NW.js";
    let rtChanged = false;
    const rtNote = () => {
        const v = rtEff(), now = penv.POCKETMZ_RT_NOW;
        return [now ? L.rtNow + rtName(now) : "", rtChanged ? L.rtNext : "", v !== "nw" && penv.POCKETMZ_BETA_INST === "0" ? L.rtNoBeta : ""].filter(Boolean).join("  ·  ");
    };

    // pause / speed. MZ: SceneManager.update runs determineRepeatNumber() updates per frame.
    // MV 1.6 has no such function: updateMain calls updateInputData + changeScene + updateScene
    // in a fixed-step loop and then renderScene (so the picture stays); wrap those two instead.
    let open = false;
    // F2 hotkeys (section at the end): F2+A pause, F2+L1 half speed, F2+R1 held = fast forward
    let paused = false, slow = false, ff = false, slowTick = 0;
    const FF_SPEED = 3;
    if (IS_MZ) {
        const _repeat = SceneManager.determineRepeatNumber;
        SceneManager.determineRepeatNumber = function() {
            const n = _repeat.apply(this, arguments);
            if (open || paused) return 0;
            if (slow && (slowTick ^= 1)) return 0;
            const m = ff ? FF_SPEED : speed;
            return m > 1 && n > 0 ? n * m : n;
        };
    } else {
        const _updateScene = SceneManager.updateScene;
        SceneManager.updateScene = function() {
            if (open || paused) return;
            if (slow && (slowTick ^= 1)) return;
            const m = ff ? FF_SPEED : speed;
            for (let i = 0; i < m; i++) _updateScene.apply(this, arguments);
        };
        const _updateInput = SceneManager.updateInputData;
        SceneManager.updateInputData = function() {
            if (open || paused) return;
            return _updateInput.apply(this, arguments);
        };
    }
    // WebAudio.setMasterVolume exists in MZ and MV 1.6 (same code)
    const applyVolume = () => { if (window.WebAudio && WebAudio.setMasterVolume) WebAudio.setMasterVolume(set.volume / 100); };
    const _initAudio = window.WebAudio && WebAudio.initialize;
    if (_initAudio) WebAudio.initialize = function() { const r = _initAudio.apply(this, arguments); applyVolume(); return r; };
    applyVolume();

    // FPS display: drawn frames per second
    let fpsBox = null, drawn = 0;
    const R0 = () => IS_MZ ? (Graphics.app && Graphics.app.renderer) : Graphics._renderer;
    const fpsTick = () => {
        if (!set.showFps) { if (fpsBox) fpsBox.hidden = true; return; }
        if (!fpsBox) {
            fpsBox = document.createElement("div");
            fpsBox.style.cssText = "position:fixed;left:4px;top:4px;z-index:30;padding:1px 6px;font:12px sans-serif;color:#fff;background:rgba(0,0,0,.6);border-radius:3px;pointer-events:none";
            document.body.appendChild(fpsBox);
        }
        fpsBox.hidden = false;
        fpsBox.textContent = drawn + " fps" + (speed > 1 ? "  ×" + speed : "");
        drawn = 0;
    };
    setInterval(fpsTick, 1000);
    const hookRender = () => {
        const R = R0();
        if (!R || R._pmzCount) return !!R;
        const r = R.render;
        R.render = function() { drawn++; return r.apply(this, arguments); };
        R._pmzCount = true;
        return true;
    };
    const hookTimer = setInterval(() => { if (hookRender()) clearInterval(hookTimer); }, 500);

    // the layer
    const css = document.createElement("style");
    css.textContent = "#pmzMenu{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(10,12,16,.72);font-family:'Noto Sans CJK JP','Noto Sans CJK SC',sans-serif;color:#e8eaf0}" +
        "#pmzMenu[hidden]{display:none}#pmzMenu .box{width:min(560px,92vw);max-height:96vh;box-sizing:border-box;display:flex;flex-direction:column;background:#1b1f29;border:1px solid #2e3446;border-radius:8px;padding:12px 14px}" +
        "#pmzMenu h1{margin:0 0 8px;font-size:17px;color:#4f8cff}#pmzMenu .row{display:flex;justify-content:space-between;gap:10px;padding:6px 10px;border-radius:5px;font-size:15px}" +
        "#pmzMenu .row.sel{background:#4f8cff;color:#fff}#pmzMenu .v{color:#9aa3b5;text-align:right}#pmzMenu .row.sel .v{color:#fff}#pmzMenu .keys{margin-top:8px;font-size:12px;color:#9aa3b5}" +
        "#pmzMenu .list{overflow-y:auto;min-height:0;flex:1 1 auto}#pmzMenu .list .row{padding:3px 10px;font-size:14px}#pmzMenu .row.dim{opacity:.45}" +
        "#pmzMenu .note{margin-top:6px;font-size:12px;color:#9aa3b5}" +
        "#pmzMenu .ask{padding:6px 10px;font-size:15px}#pmzHint{position:fixed;right:8px;bottom:8px;z-index:30;padding:3px 8px;font:12px sans-serif;color:#fff;background:rgba(0,0,0,.55);border-radius:4px;pointer-events:none}";

    // save backups: <thin copy>/save-backups/<YYYYmmdd-HHMMSS>/ (pocketmz-run.sh makes one at each
    // start when the saves changed, keeps 5); restoring backs up the current saves first
    const BKDIR = fs && APPDIR ? path.join(APPDIR, "save-backups") : null;
    // MZ: fileDirectoryPath(); MV: localFileDirectoryPath() (nw.js only)
    const saveDir = () => {
        try { return IS_MZ ? StorageManager.fileDirectoryPath() : StorageManager.localFileDirectoryPath(); } catch (e) { return null; }
    };
    const stamp = () => {
        const d = new Date(), p = n => String(n).padStart(2, "0");
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    };
    const listBackups = () => {
        if (!BKDIR || !fs.existsSync(BKDIR)) return [];
        return fs.readdirSync(BKDIR).filter(n => /^\d{8}-\d{6}/.test(n)).sort().reverse().map(n => {
            let files = 0;
            try { files = fs.readdirSync(path.join(BKDIR, n)).length; } catch (e) {}
            const t = n.slice(0, 4) + "-" + n.slice(4, 6) + "-" + n.slice(6, 8) + " " + n.slice(9, 11) + ":" + n.slice(11, 13);
            return { name: n, label: t, files };
        });
    };
    const copyDir = (from, to) => {
        fs.mkdirSync(to, { recursive: true });
        for (const f of fs.readdirSync(from)) {
            const s1 = path.join(from, f);
            if (fs.statSync(s1).isFile()) fs.copyFileSync(s1, path.join(to, f));
        }
    };
    const restoreBackup = b => {
        const dir = saveDir();
        if (!dir) throw new Error("no save folder");
        if (fs.existsSync(dir) && fs.readdirSync(dir).length) copyDir(dir, path.join(BKDIR, stamp() + "-before-restore"));
        fs.mkdirSync(dir, { recursive: true });
        for (const f of fs.readdirSync(dir)) { const p1 = path.join(dir, f); if (fs.statSync(p1).isFile()) fs.unlinkSync(p1); }
        copyDir(path.join(BKDIR, b.name), dir);
        // MZ caches the global info; MV 1.6 reads global.rpgsave on every call (nothing cached)
        if (IS_MZ && DataManager.loadGlobalInfo) DataManager.loadGlobalInfo();
    };

    // key mapping: <thin copy>/pocketmz.gptk, always written complete (gptokeyb .gptk format)
    const GP_ORDER = ["back", "start", "a", "b", "x", "y", "l1", "r1", "l2", "r2", "l3", "r3", "up", "down", "left", "right",
        "left_analog_up", "left_analog_down", "left_analog_left", "left_analog_right",
        "right_analog_up", "right_analog_down", "right_analog_left", "right_analog_right"];
    const GP_DEFAULT = { back: "shift", start: "esc", a: "enter", b: "esc", x: "d", y: "shift", l1: "pageup", r1: "pagedown",
        l2: "s", r2: "a", l3: "mouse_right", r3: "mouse_left", up: "up", down: "down", left: "left", right: "right",
        left_analog_up: "up", left_analog_down: "down", left_analog_left: "left", left_analog_right: "right" };
    const DIRS = ["up", "down", "left", "right"];
    const EDIT = ["a", "b", "x", "y", "l1", "r1", "l2", "r2", "l3", "r3", "back", "start"];   // back = Select
    const BTN_LABEL = { back: "Select", start: "Start" };
    const KEY_CHOICES = ["enter", "esc", "shift", "pageup", "pagedown", "z", "x", "space", "a", "s", "d", "q", "w", "c", "tab", "ctrl",
        "mouse_left", "mouse_right", "nothing"];
    const KEY_NAME = { enter: "Enter", esc: "Esc", shift: "Shift", pageup: "PageUp", pagedown: "PageDown", space: "Space",
        tab: "Tab", ctrl: "Ctrl", mouse_left: "", mouse_right: "", nothing: "" };
    const keyLabel = v => {
        const name = v in KEY_NAME ? KEY_NAME[v] : v.length === 1 ? v.toUpperCase() : v;
        const meaning = L.km[v];
        return name && meaning ? name + " (" + meaning + ")" : (name || meaning || v);
    };
    // value of a key in the browser's KeyboardEvent.key (lower case)
    const DOM_KEY = { enter: "enter", esc: "escape", shift: "shift", pageup: "pageup", pagedown: "pagedown", space: " ", tab: "tab", ctrl: "control" };
    const domKey = v => DOM_KEY[v] || v;

    const gmap = Object.assign({}, GP_DEFAULT, { stick: "mouse" });
    const parseGptk = text => {
        const m = {};
        for (const line of String(text).split(/\r?\n/)) {
            if (/^\s*[#;]/.test(line)) continue;
            const r = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
            if (r) m[r[1].toLowerCase()] = r[2].toLowerCase();
        }
        const noKey = v => v === '\\"' || v === '"' || v === "" || v === "nothing";
        for (const id of EDIT) if (id in m) gmap[id] = noKey(m[id]) ? "nothing" : m[id];
        const s = m.right_analog_up;
        if (s !== undefined) gmap.stick = s.startsWith("mouse_movement") ? "mouse" : noKey(s) ? "none" : DIRS.includes(s) ? "arrows" : "mouse";
    };
    const loadGptk = () => { try { if (GPTK && fs.existsSync(GPTK)) parseGptk(fs.readFileSync(GPTK, "utf8")); } catch (e) {} };
    const serializeGptk = () => {
        const out = [];
        for (const name of GP_ORDER) {
            let v;
            if (name.startsWith("right_analog_")) {
                const d = name.slice(13);
                v = gmap.stick === "none" ? "nothing" : gmap.stick === "arrows" ? d : "mouse_movement_" + d;
            } else v = EDIT.includes(name) ? gmap[name] : GP_DEFAULT[name];
            out.push(name + " = " + (v === "nothing" ? '\\"' : v));
        }
        return out.join("\n") + "\n";
    };
    const writeGptk = () => {
        if (!GPTK) return;
        try { fs.writeFileSync(GPTK + ".tmp", serializeGptk()); fs.renameSync(GPTK + ".tmp", GPTK); } catch (e) {}
    };
    const resetGptk = () => {
        Object.assign(gmap, GP_DEFAULT, { stick: "mouse" });
        try { if (GPTK && fs.existsSync(GPTK)) fs.unlinkSync(GPTK); } catch (e) {}
    };
    loadGptk();
    const cycleKey = (id, d) => {
        const opts = KEY_CHOICES;
        const i = opts.indexOf(gmap[id]);
        gmap[id] = opts[i < 0 ? (d > 0 ? 0 : opts.length - 1) : (i + d + opts.length) % opts.length];
        writeGptk();
    };
    const cycleStick = d => {
        const o = ["mouse", "arrows", "none"];
        gmap.stick = o[(o.indexOf(gmap.stick) + d + 3) % 3];
        writeGptk();
    };

    // pages: main | backups | keymap | askQuit | askRestore | askReset | msg
    let layer = null, sel = 0, page = "main", askYes = false, bsel = 0, ksel = 0, backups = [], pick = null, message = "";
    let r1Held = false;
    const items = () => [
        { k: "resume", label: L.resume },
        { k: "fps", label: L.fps, v: (ConfigManager.gkdFrameRate === 60 ? 60 : 30) + " fps" },
        { k: "speed", label: L.speed, v: "×" + speed },
        { k: "showFps", label: L.showFps, v: set.showFps ? L.on : L.off },
        { k: "volume", label: L.volume, v: set.volume + "%" },
        { k: "runtime", label: L.runtime, v: rtName(rtEff()) },
        { k: "scale", label: L.scale + L.next, v: set.renderScale === "off" ? L.scaleOff : L.scaleAuto },
        { k: "stopES", label: L.stopEs + L.next, v: set.stopES ? L.on : L.off },
        { k: "keymap", label: L.keymap },
        ...(window.PMZ_IMG && PMZ_IMG.prebuild ? [{ k: "prebuild", label: L.prebuild }] : []),
        { k: "backups", label: L.backups },
        { k: "quit", label: L.quit }
    ];
    // key mapping page: selectable rows first, then greyed fixed rows
    const keyItems = () => [
        ...EDIT.map(id => ({ k: id, label: BTN_LABEL[id] || id.toUpperCase(), v: keyLabel(gmap[id]) })),
        { k: "stick", label: L.stick, v: gmap.stick === "mouse" ? L.stickMouse : gmap.stick === "arrows" ? L.stickArrows : L.none },
        { k: "reset", label: L.reset }
    ];
    const fixedItems = () => [
        { label: L.dpad, v: L.arrows },
        { label: "F1 / F2", v: L.f2Note }
    ];
    const row = (box, label, on, value, cls) => {
        const r = document.createElement("div"); r.className = "row" + (on ? " sel" : "") + (cls ? " " + cls : "");
        const a = document.createElement("span"); a.textContent = label; r.appendChild(a);
        if (value !== undefined) { const b = document.createElement("span"); b.className = "v"; b.textContent = value; r.appendChild(b); }
        box.appendChild(r);
    };
    const say = (box, t, cls) => { const q = document.createElement("div"); q.className = cls || "ask"; q.textContent = t; box.appendChild(q); };
    const draw = () => {
        const box = layer.firstChild;
        box.textContent = "";
        const h = document.createElement("h1");
        h.textContent = page === "prebuild" ? L.prebuild : page === "backups" || page === "askRestore" ? L.backups : page === "keymap" || page === "askReset" ? L.keymap : L.title;
        box.appendChild(h);
        if (page === "askQuit" || page === "askRestore" || page === "askReset") {
            say(box, page === "askQuit" ? L.quitAsk : page === "askReset" ? L.resetAsk : L.restoreAsk(pick.label));
            row(box, L.no, !askYes);
            row(box, page === "askQuit" ? L.yes : page === "askReset" ? L.resetYes : L.restore, askYes);
        } else if (page === "msg") {
            say(box, message);
            row(box, L.ok, true);
        } else if (page === "prebuild") {
            say(box, L.prebuildNote, "note");
            say(box, prebuild.text);
            if (prebuild.done) row(box, L.ok, true);
        } else if (page === "backups") {
            if (!backups.length) say(box, L.noBackups);
            backups.slice(0, 7).forEach((b, i) => row(box, b.label + (b.name.includes("before-restore") ? " *" : ""), i === bsel, L.files(b.files)));
        } else if (page === "keymap") {
            const list = document.createElement("div"); list.className = "list"; box.appendChild(list);
            keyItems().forEach((it, i) => row(list, it.label, i === ksel, it.v !== undefined ? "‹ " + it.v + " ›" : undefined));
            fixedItems().forEach(it => row(list, it.label, false, it.v, "dim"));
            say(box, L.note1 + " " + L.note2, "note");
            const s = list.querySelector(".row.sel");
            if (ksel === 0) list.scrollTop = 0;
            else if (s && s.scrollIntoView) s.scrollIntoView({ block: "nearest" });
        } else {
            const list = document.createElement("div"); list.className = "list"; box.appendChild(list);   // compact rows: the main page has too many rows for 480 px otherwise
            items().forEach((it, i) => row(list, it.label, i === sel, it.v !== undefined ? "‹ " + it.v + " ›" : undefined));
            const n = rtNote(); if (n) say(box, n, "note");
            const s = list.querySelector(".row.sel");
            if (sel === 0) list.scrollTop = 0;
            else if (s && s.scrollIntoView) s.scrollIntoView({ block: "nearest" });
        }
        const k = document.createElement("div"); k.className = "keys"; k.textContent = L.keys; box.appendChild(k);
    };
    const show = () => {
        if (!layer) {
            document.head.appendChild(css);
            layer = document.createElement("div"); layer.id = "pmzMenu";
            layer.appendChild(document.createElement("div")).className = "box";
            document.body.appendChild(layer);
        }
        open = true; sel = 0; page = "main"; layer.hidden = false; r1Held = false; draw();
        if (window.Input) Input.clear();
    };
    const hide = () => { open = false; if (layer) layer.hidden = true; if (window.Input) Input.clear(); };
    const change = (k, d) => {
        if (k === "fps") { ConfigManager.gkdFrameRate = ConfigManager.gkdFrameRate === 60 ? 30 : 60; try { ConfigManager.save(); } catch (e) {} }
        else if (k === "speed") speed = ((speed - 1 + (d || 1) + 3) % 3) + 1;          // 1 -> 2 -> 3 -> 1
        else if (k === "showFps") { set.showFps = !set.showFps; save(); fpsTick(); }
        else if (k === "volume") { set.volume = Math.max(0, Math.min(100, set.volume + (d || 1) * 10)); applyVolume(); save(); }
        else if (k === "scale") { set.renderScale = set.renderScale === "off" ? "auto" : "off"; save(); }
        else if (k === "stopES") { set.stopES = !set.stopES; save(); }
        else if (k === "runtime") { set.runtime = RT_OPTS[(RT_OPTS.indexOf(rtEff()) + (d || 1) + 3) % 3]; rtChanged = true; save(); }
    };
    // one-time image precompile (PMZ_IMG.prebuild from PocketMZ_Handheld / HandheldMV): runs while
    // the menu is open (the game is paused), progress shown on its page
    const prebuild = { text: "", done: true };
    const startPrebuild = () => {
        if (!prebuild.done) return;
        prebuild.done = false; prebuild.text = L.prebuildRun("");
        PMZ_IMG.prebuild(undefined, p => {
            prebuild.text = L.prebuildRun(p.done + " / " + p.total);
            if (open && page === "prebuild") draw();
        }).then(r => {
            prebuild.done = true;
            prebuild.text = r.error && !r.total ? L.prebuildNone : L.prebuildDone(r);
            if (open && page === "prebuild") draw();
        }, () => { prebuild.done = true; prebuild.text = L.prebuildDone({ built: 0, skipped: 0, failed: 1 }); });
    };
    const isOk = k => k === "Enter" || k === " ";
    const onKey = e => {
        const k = e.key === "End" ? "Escape" : e.key;   // Start sends End
        if (!open) return;   // the menu is opened with F2 + F1 (hotkey section below)
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.type !== "keydown") return;
        // F2 still held or just released: gptokeyb sends guide's key (Enter) when F2 is released
        // without one of its own combos (F2 + F1 is ours, not gptokeyb's) - that Enter chose
        // "Resume" and closed the menu as soon as F2 was let go
        if (f2Held) return;
        if (page === "askQuit" || page === "askRestore" || page === "askReset") {
            const back = page === "askQuit" ? "main" : page === "askReset" ? "keymap" : "backups";
            if (k.startsWith("Arrow")) askYes = !askYes;
            else if (k === "Escape") page = back;
            else if (isOk(k)) {
                if (!askYes) page = back;
                else if (page === "askQuit") { try { nw.App.quit(); } catch (err) { window.close(); } }
                else if (page === "askReset") { resetGptk(); page = "keymap"; }
                else {
                    try { restoreBackup(pick); message = L.restored; pick = "restored"; }
                    catch (err) { message = L.failed + ((err && err.message) || err); pick = null; }
                    page = "msg";
                }
            }
            draw(); return;
        }
        if (page === "msg") {
            if (isOk(k) || k === "Escape") {
                if (pick === "restored") { pick = null; hide(); SceneManager.goto(Scene_Title); return; }
                page = "backups";
            }
            draw(); return;
        }
        if (page === "prebuild") {
            if (prebuild.done && (isOk(k) || k === "Escape")) page = "main";
            draw(); return;
        }
        if (page === "backups") {
            const n = Math.min(backups.length, 7);
            if (k === "ArrowUp" && n) bsel = (bsel + n - 1) % n;
            else if (k === "ArrowDown" && n) bsel = (bsel + 1) % n;
            else if (k === "Escape") page = "main";
            else if (isOk(k) && n) { pick = backups[bsel]; page = "askRestore"; askYes = false; }
            draw(); return;
        }
        if (page === "keymap") {
            const list = keyItems();
            const act = d => {
                const id = list[ksel].k;
                if (id === "stick") cycleStick(d);
                else if (id !== "reset") cycleKey(id, d);
            };
            if (k === "ArrowUp") ksel = (ksel + list.length - 1) % list.length;
            else if (k === "ArrowDown") ksel = (ksel + 1) % list.length;
            else if (k === "ArrowLeft") act(-1);
            else if (k === "ArrowRight") act(1);
            else if (k === "Escape") page = "main";
            else if (isOk(k)) {
                if (list[ksel].k === "reset") { page = "askReset"; askYes = false; }
                else act(1);
            }
            draw(); return;
        }
        const list = items();
        if (k === "ArrowUp") sel = (sel + list.length - 1) % list.length;
        else if (k === "ArrowDown") sel = (sel + 1) % list.length;
        else if (k === "ArrowLeft" || k === "ArrowRight") change(list[sel].k, k === "ArrowLeft" ? -1 : 1);
        else if (k === "Escape") { hide(); return; }
        else if (isOk(k)) {
            const it = list[sel].k;
            if (it === "resume") { hide(); return; }
            if (it === "quit") { page = "askQuit"; askYes = false; }
            else if (it === "keymap") { ksel = 0; page = "keymap"; }
            else if (it === "prebuild") { startPrebuild(); page = "prebuild"; }
            else if (it === "backups") { try { backups = listBackups(); } catch (err) { backups = []; } bsel = 0; page = "backups"; }
            else change(it, 1);
        }
        draw();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", e => {
        if (!open) { if (String(e.key).toLowerCase() === domKey(gmap.r1)) r1Held = false; return; }
        e.preventDefault(); e.stopImmediatePropagation();
    }, true);
    window.addEventListener("blur", () => { r1Held = false; });

    // one hint on the title screen
    let hinted = false;
    const _titleStart = Scene_Title.prototype.start;
    Scene_Title.prototype.start = function() {
        _titleStart.apply(this, arguments);
        if (hinted) return;
        hinted = true;
        const h = document.createElement("div"); h.id = "pmzHint"; h.textContent = L.hint;
        document.body.appendChild(h);
        setTimeout(() => h.remove(), 5000);
    };
    // "Hold F2" hotkeys, the handheld's unified set (same as its emulators). pocketmz-hotkeys.py
    // (started by pocketmz-run.sh) reads the pad and sends one command per line over
    // 127.0.0.1:9334. While F2 is held the game gets no keys, so F2 + A does not also press OK.
    const net = window.require ? (() => { try { return require("net"); } catch (e) { return null; } })() : null;
    let f2Held = false, f2Timer = null;
    const toast = (() => {
        let box = null, timer = null;
        return text => {
            if (!box) {
                box = document.createElement("div");
                box.style.cssText = "position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:45;padding:4px 12px;font:14px 'Noto Sans CJK JP','Noto Sans CJK SC',sans-serif;color:#fff;background:rgba(0,0,0,.7);border-radius:4px;pointer-events:none";
                document.body.appendChild(box);
            }
            box.textContent = text; box.hidden = false;
            clearTimeout(timer); timer = setTimeout(() => { box.hidden = true; }, 1500);
        };
    })();
    const HK = ui.startsWith("ja") ? { pause: "一時停止", resume: "再開", slowOn: "スロー：オン", slowOff: "スロー：オフ", ff: "早送り", shot: "スクリーンショット保存", shotFail: "スクリーンショット失敗", vol: "音量 " }
        : ui.startsWith("en") ? { pause: "Paused", resume: "Resumed", slowOn: "Slow motion: on", slowOff: "Slow motion: off", ff: "Fast forward", shot: "Screenshot saved", shotFail: "Screenshot failed", vol: "Volume " }
        : { pause: "暂停", resume: "继续", slowOn: "慢动作：开", slowOff: "慢动作：关", ff: "快进", shot: "截图已保存", shotFail: "截图失败", vol: "音量 " };
    const sceneIs = name => { const s = SceneManager._scene; return !!(s && window[name] && s instanceof window[name]); };
    const canPush = () => SceneManager._scene && !SceneManager.isSceneChanging() && !sceneIs("Scene_Boot");
    const hkLog = [];
    const command = line => {
        hkLog.push(line); if (hkLog.length > 40) hkLog.shift();
        const [cmd, arg] = line.split(" ");
        if (cmd === "f2") {
            clearTimeout(f2Timer);
            if (arg === "1") { f2Held = true; if (window.Input) Input.clear(); }
            else f2Timer = setTimeout(() => { f2Held = false; }, 250);   // keys gptokeyb may send on release
            return;
        }
        if (cmd === "menu") { if (open) hide(); else show(); return; }
        if (cmd === "quit") { try { nw.App.quit(); } catch (e) { window.close(); } return; }
        if (cmd === "ff0") { ff = false; return; }
        if (cmd === "shot") { toast(arg ? HK.shot : HK.shotFail); return; }
        if (open) return;                                   // the rest only while playing
        if (cmd === "pause") { paused = !paused; toast(paused ? HK.pause : HK.resume); }
        else if (cmd === "slow") { slow = !slow; toast(slow ? HK.slowOn : HK.slowOff); }
        else if (cmd === "ff1") { ff = true; toast(HK.ff); }
        else if (cmd === "fps") { set.showFps = !set.showFps; save(); fpsTick(); }
        else if (cmd === "vol+" || cmd === "vol-") {
            set.volume = Math.max(0, Math.min(100, set.volume + (cmd === "vol+" ? 10 : -10)));
            applyVolume(); save(); toast(HK.vol + set.volume + "%");
        }
        else if (cmd === "title") { if (canPush() && !sceneIs("Scene_Title")) { paused = false; SceneManager.goto(Scene_Title); } }
        else if (cmd === "save") { if (canPush() && sceneIs("Scene_Map") && !$gameParty.inBattle()) { paused = false; SceneManager.push(Scene_Save); } }
        else if (cmd === "load") { if (canPush() && !sceneIs("Scene_Load")) { paused = false; SceneManager.push(Scene_Load); } }
    };
    if (net) {
        let buf = "";
        const connect = () => {
            const sock = net.connect(9334, "127.0.0.1");
            sock.setEncoding("utf8");
            sock.on("data", d => {
                buf += d;
                let i;
                while ((i = buf.indexOf("\n")) >= 0) {
                    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
                    if (line) try { command(line); } catch (e) { console.error("PocketMZ hotkey", line, e); }
                }
            });
            sock.on("error", () => {});
            sock.on("close", () => { f2Held = false; buf = ""; setTimeout(connect, 2000); });
        };
        connect();
    }
    // F2 held: the game gets no keys (key-ups pass, so nothing stays pressed)
    window.addEventListener("keydown", e => {
        if (f2Held && !open) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);

    window.PMZ_MENU = { show, hide, settings: set, command, state: () => ({ open, paused, slow, ff, f2Held, speed, log: hkLog.join(",") }) };
})();
