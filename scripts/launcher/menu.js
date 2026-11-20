// SPDX-License-Identifier: MIT
// PocketMZ game menu: reads library/library.json, writes library/choice.json, then quits.
(() => {
"use strict";

const BASE = (typeof nw !== "undefined" && nw.__dirname) || null;
const fs = BASE ? require("fs") : null;
const path = BASE ? require("path") : null;
const params = new URLSearchParams(location.search);
// Library folder, relative to the page. ?lib=... is meant for desktop browser preview.
const LIBREL = (params.get("lib") || "library").replace(/\/+$/, "");
const COLS = 3;
const RECENT_MAX = 12;

// ---------- i18n ----------
const I18N = {
  zh: {
    recent: "最近", all: "全部", fav: "收藏",
    hints: "A 启动 · X 收藏 · L1/R1 分类 · B 退出",
    convBadge: "需要转换",
    convWarn: "此游戏的脚本被打包在 Game.exe 里，需要先在电脑上用 PocketMZ 转换器处理",
    convMsg: "此游戏需要先在电脑上用 PocketMZ 转换器处理，才能在这里运行。",
    today: "今天", yesterday: "昨天", daysAgo: n => n + " 天前", never: "从未",
    launching: t => "正在启动「" + t + "」…",
    quit: "退出 PocketMZ？", no: "否", yes: "是", ok: "好",
    empty: "没有找到游戏。把 RPG Maker MV/MZ 游戏文件夹放进 roms/rpgmaker，再打开 PocketMZ。",
    err: "读取游戏列表失败：",
    scanning: "正在查找游戏…"
  },
  ja: {
    recent: "最近遊んだ", all: "すべて", fav: "お気に入り",
    hints: "A 起動 · X お気に入り · L1/R1 分類 · B 終了",
    convBadge: "変換が必要",
    convWarn: "このゲームのスクリプトは Game.exe に埋め込まれています。先にパソコンで PocketMZ コンバーターを実行してください",
    convMsg: "このゲームは、先にパソコンで PocketMZ コンバーターを実行しないと起動できません。",
    today: "今日", yesterday: "昨日", daysAgo: n => n + " 日前", never: "未プレイ",
    launching: t => "「" + t + "」を起動中…",
    quit: "PocketMZ を終了しますか？", no: "いいえ", yes: "はい", ok: "OK",
    empty: "ゲームが見つかりません。RPG Maker MV/MZ のゲームフォルダを roms/rpgmaker に入れてから、PocketMZ を開いてください。",
    err: "ゲーム一覧の読み込みに失敗しました：",
    scanning: "ゲームを探しています…"
  },
  en: {
    recent: "Recent", all: "All", fav: "Favorites",
    hints: "A Play · X Favorite · L1/R1 Tabs · B Exit",
    convBadge: "Needs conversion",
    convWarn: "This game's scripts are packed inside Game.exe. Process it on a PC with the PocketMZ converter first.",
    convMsg: "This game must be processed on a PC with the PocketMZ converter before it can run here.",
    today: "Today", yesterday: "Yesterday", daysAgo: n => n + " days ago", never: "Never",
    launching: t => "Starting \"" + t + "\"…",
    quit: "Exit PocketMZ?", no: "No", yes: "Yes", ok: "OK",
    empty: "No games found. Put RPG Maker MV/MZ game folders into roms/rpgmaker, then open PocketMZ again.",
    err: "Failed to read the game list: ",
    scanning: "Looking for games…"
  }
};
function pickLang() {
  const q = params.get("lang");
  if (q && I18N[q]) return q;
  const nl = String(navigator.language || "").toLowerCase();
  if (nl.startsWith("ja")) return "ja";
  if (nl.startsWith("zh") || !nl) return "zh";
  return "en";
}
const LANG = pickLang();
const T = I18N[LANG];
document.documentElement.lang = LANG === "zh" ? "zh-CN" : LANG;

// ---------- file access ----------
function libPath(name) { return path.join(BASE, LIBREL, name); }

// Resolves to parsed JSON, or null when the file does not exist. Rejects on parse/read errors.
async function readJSON(name) {
  if (fs) {
    let txt;
    try { txt = fs.readFileSync(libPath(name), "utf8"); }
    catch (e) { if (e && e.code === "ENOENT") return null; throw e; }
    return JSON.parse(txt.replace(/^﻿/, ""));
  }
  const r = await fetch(LIBREL + "/" + name, { cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("HTTP " + r.status + " " + name);
  return JSON.parse((await r.text()).replace(/^﻿/, ""));
}

// Atomic write (tmp + rename). In a desktop browser it only logs.
function writeJSON(name, obj) {
  const txt = JSON.stringify(obj);
  if (!fs) { console.log("[write " + name + "] " + txt); return; }
  try {
    const dst = libPath(name), tmp = dst + ".tmp";
    fs.writeFileSync(tmp, txt);
    fs.renameSync(tmp, dst);
  } catch (e) { console.error("write " + name + " failed", e); }
}

function quitApp() {
  if (typeof nw !== "undefined" && nw.App) nw.App.quit();
  else console.log("[quit]");
}

// ---------- state ----------
let games = [];
let loadError = null;
let st = { favorites: [], tab: "", selected: {} };
let tabs = [];          // [{key,label}]
let tabKey = "all";
let list = [];          // games shown in the current tab
let idx = 0;            // selected index in list
let topRow = 0;
let VIS = 2;            // fully visible rows, re-measured after render
let cards = [];
let mode = "grid";      // grid | confirm | msg | launching
let confirmYes = false;

const $ = id => document.getElementById(id);

function saveState() { writeJSON("state.json", st); }
function isFav(id) { return st.favorites.indexOf(id) >= 0; }

// ---------- tabs / lists ----------
function buildTabs() {
  const out = [];
  if (games.some(g => g.lastPlayed > 0)) out.push({ key: "recent", label: T.recent });
  out.push({ key: "all", label: T.all });
  const cats = [];
  for (const g of games) if (g.category && cats.indexOf(g.category) < 0) cats.push(g.category);
  cats.sort((a, b) => a.localeCompare(b));
  for (const c of cats) out.push({ key: "cat:" + c, label: c });
  if (games.some(g => isFav(g.id))) out.push({ key: "fav", label: T.fav });
  return out;
}

function listFor(key) {
  if (key === "recent")
    return games.filter(g => g.lastPlayed > 0).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, RECENT_MAX);
  if (key === "fav") return games.filter(g => isFav(g.id));
  if (key.startsWith("cat:")) { const c = key.slice(4); return games.filter(g => g.category === c); }
  return games.slice();
}

function dayDiff(ts) {
  const a = new Date(); a.setHours(0, 0, 0, 0);
  const b = new Date(ts * 1000); b.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((a - b) / 86400000));
}
function lastPlayedText(ts) {
  if (!(ts > 0)) return T.never;
  const d = dayDiff(ts);
  return d === 0 ? T.today : d === 1 ? T.yesterday : T.daysAgo(d);
}

// ---------- rendering ----------
function hueOf(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
function coverUrl(f) { return LIBREL + "/covers/" + encodeURIComponent(f); }

function makeCard(g, i) {
  const c = document.createElement("div");
  c.className = "card" + (i === idx ? " sel" : "");
  const cv = document.createElement("div");
  cv.className = "cover";
  if (g.cover1 || g.cover2) {
    for (const f of [g.cover1, g.cover2]) {
      if (!f) continue;
      const im = document.createElement("img");
      im.loading = "lazy"; im.decoding = "async"; im.alt = ""; im.draggable = false;
      im.src = coverUrl(f);
      cv.appendChild(im);
    }
  } else {
    cv.style.background = "hsl(" + hueOf(String(g.id)) + ",35%,30%)";
    const ph = document.createElement("div");
    ph.className = "ph"; ph.textContent = g.title || g.id;
    cv.appendChild(ph);
  }
  c.appendChild(cv);
  if (isFav(g.id)) {
    const s = document.createElement("div");
    s.className = "star"; s.textContent = "★";
    c.appendChild(s);
  }
  const t = document.createElement("div");
  t.className = "ctitle"; t.textContent = g.title || g.id;
  c.appendChild(t);
  c.addEventListener("click", () => { if (mode === "grid") { select(i); activate(); } });
  return c;
}

let measured = false;
function renderGrid() {
  const g = $("grid");
  g.textContent = "";
  cards = [];
  const start = topRow * COLS, end = Math.min(list.length, (topRow + VIS + 1) * COLS);
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) { cards[i] = makeCard(list[i], i); frag.appendChild(cards[i]); }
  g.appendChild(frag);
  if (!measured && cards[start]) {
    // Fit the row count to the real card height; re-render once if it differs.
    measured = true;
    const h = cards[start].getBoundingClientRect().height;
    const gap = parseFloat(getComputedStyle(g).rowGap) || 0;
    if (h > 0) {
      const v = Math.max(1, Math.min(6, Math.floor((g.clientHeight + gap) / (h + gap))));
      if (v !== VIS) { VIS = v; ensureVisible(); renderGrid(); }
    }
  }
}

function ensureVisible() {
  const row = Math.floor(idx / COLS);
  if (row < topRow) topRow = row;
  else if (row >= topRow + VIS) topRow = row - VIS + 1;
  const maxTop = Math.max(0, Math.ceil(list.length / COLS) - VIS);
  if (topRow > maxTop) topRow = maxTop;
  if (topRow < 0) topRow = 0;
}

function renderTabs() {
  const el = $("tabs");
  el.textContent = "";
  let on = null;
  for (const t of tabs) {
    const d = document.createElement("div");
    d.className = "tab" + (t.key === tabKey ? " on" : "");
    d.textContent = t.label;
    d.addEventListener("click", () => { if (mode === "grid") setTab(t.key); });
    el.appendChild(d);
    if (t.key === tabKey) on = d;
  }
  if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function renderInfo() {
  const g = list[idx];
  const title = $("ititle"), badges = $("ibadges"), warn = $("iwarn");
  $("ihints").textContent = T.hints;
  badges.textContent = ""; warn.textContent = "";
  if (!g) { title.textContent = ""; return; }
  title.textContent = g.title || g.id;
  const add = (txt, cls) => {
    const b = document.createElement("span");
    b.className = "badge" + (cls ? " " + cls : "");
    b.textContent = txt;
    badges.appendChild(b);
  };
  if (g.needsConversion) add(T.convBadge, "warn");
  else add(g.kind || "?", "kind");
  if (g.width && g.height) add(g.width + "×" + g.height);
  add(lastPlayedText(g.lastPlayed));
  const cat = g.category || g.folder;
  if (cat) add(cat);
  if (isFav(g.id)) add("★");
  if (g.needsConversion) warn.textContent = T.convWarn;
}

function showEmpty(show) {
  const e = $("empty");
  e.hidden = !show;
  $("grid").hidden = show;
  $("info").hidden = show;
  if (!show) return;
  e.textContent = "";
  if (loadError) {
    const p = document.createElement("div");
    p.className = "err"; p.textContent = T.err + loadError;
    e.appendChild(p);
  }
  const h = document.createElement("div");
  h.textContent = T.empty;
  e.appendChild(h);
}

function renderAll() {
  renderTabs();
  renderGrid();
  renderInfo();
}

// ---------- selection ----------
function remember() {
  const g = list[idx];
  if (g) st.selected[tabKey] = g.id;
}

function select(n) {
  if (!list.length) return;
  n = Math.max(0, Math.min(list.length - 1, n));
  if (n === idx) return;
  const old = idx, oldTop = topRow;
  idx = n;
  ensureVisible();
  remember();
  if (topRow !== oldTop) renderGrid();
  else {
    if (cards[old]) cards[old].classList.remove("sel");
    if (cards[idx]) cards[idx].classList.add("sel");
  }
  renderInfo();
}

function setTab(key) {
  if (!tabs.some(t => t.key === key)) key = "all";
  tabKey = key;
  st.tab = key;
  list = listFor(key);
  const sid = st.selected[key];
  const at = list.findIndex(g => g.id === sid);
  idx = at >= 0 ? at : 0;
  topRow = 0;
  ensureVisible();
  remember();
  renderAll();
  saveState();
}

function stepTab(d) {
  if (tabs.length < 2) return;
  let i = tabs.findIndex(t => t.key === tabKey);
  i = (i + d + tabs.length) % tabs.length;
  setTab(tabs[i].key);
}

function toggleFav() {
  const g = list[idx];
  if (!g) return;
  const at = st.favorites.indexOf(g.id);
  if (at >= 0) st.favorites.splice(at, 1); else st.favorites.push(g.id);
  tabs = buildTabs();
  if (!tabs.some(t => t.key === tabKey)) { setTab("all"); return; }
  list = listFor(tabKey);
  idx = Math.max(0, Math.min(list.length - 1, idx));
  ensureVisible();
  remember();
  renderAll();
  saveState();
}

// ---------- overlay / actions ----------
function showOverlay(node, dim) {
  const o = $("overlay");
  o.textContent = "";
  o.className = dim ? "dim" : "";
  o.appendChild(node);
  o.hidden = false;
}
function hideOverlay() { $("overlay").hidden = true; mode = "grid"; }

function dlg(text, buttons) {
  const d = document.createElement("div");
  d.className = "dlg";
  const p = document.createElement("div");
  p.textContent = text;
  d.appendChild(p);
  const b = document.createElement("div");
  b.className = "btns";
  for (const x of buttons) {
    const e = document.createElement("div");
    e.className = "btn" + (x.on ? " on" : "");
    e.textContent = x.label;
    if (x.click) e.addEventListener("click", x.click);
    b.appendChild(e);
  }
  d.appendChild(b);
  return d;
}

function openConfirm() {
  mode = "confirm";
  confirmYes = false;
  drawConfirm();
}
function drawConfirm() {
  showOverlay(dlg(T.quit, [
    { label: T.no, on: !confirmYes, click: () => { confirmYes = false; acceptConfirm(); } },
    { label: T.yes, on: confirmYes, click: () => { confirmYes = true; acceptConfirm(); } }
  ]), true);
}
function acceptConfirm() {
  if (!confirmYes) { hideOverlay(); return; }
  mode = "launching";
  saveState();
  writeJSON("choice.json", { action: "exit" });
  setTimeout(quitApp, 100);
}

function activate() {
  const g = list[idx];
  if (!g) return;
  if (g.needsConversion) {
    mode = "msg";
    showOverlay(dlg(T.convMsg, [{ label: T.ok, on: true, click: hideOverlay }]), true);
    return;
  }
  mode = "launching";
  const d = document.createElement("div");
  d.className = "launch";
  d.textContent = T.launching(g.title || g.id);
  showOverlay(d, false);
  remember();
  saveState();
  writeJSON("choice.json", { action: "play", id: g.id, dir: g.dir });
  setTimeout(quitApp, 200);
}

// ---------- input ----------
function move(dx, dy) {
  if (!list.length) return;
  if (dx) { select(idx + dx); return; }
  const n = idx + dy * COLS;
  if (n >= 0 && n < list.length) select(n);
  else if (dy > 0 && Math.floor(idx / COLS) < Math.floor((list.length - 1) / COLS)) select(list.length - 1);
}

window.addEventListener("keydown", e => {
  const k = e.key === "End" ? "Escape" : e.key;   // Start sends End (pocketmz.gptk)
  if (mode === "launching") { e.preventDefault(); return; }
  if (mode === "confirm") {
    if (k === "ArrowLeft" || k === "ArrowRight") { confirmYes = k === "ArrowRight"; drawConfirm(); }
    else if (k === "Enter" && !e.repeat) acceptConfirm();
    else if (k === "Escape" && !e.repeat) hideOverlay();
    else return;
    e.preventDefault();
    return;
  }
  if (mode === "msg") {
    if ((k === "Enter" || k === "Escape") && !e.repeat) hideOverlay();
    e.preventDefault();
    return;
  }
  switch (k) {
    case "ArrowLeft": move(-1, 0); break;
    case "ArrowRight": move(1, 0); break;
    case "ArrowUp": move(0, -1); break;
    case "ArrowDown": move(0, 1); break;
    case "PageUp": if (!e.repeat) stepTab(-1); break;
    case "PageDown": if (!e.repeat) stepTab(1); break;
    case "Enter": if (!e.repeat) activate(); break;
    case "Escape": if (!e.repeat) openConfirm(); break;
    case "d": case "D": if (!e.repeat) toggleFav(); break;
    default: return;
  }
  e.preventDefault();
});

let rz = 0;
window.addEventListener("resize", () => {
  clearTimeout(rz);
  rz = setTimeout(() => {
    if (!list.length) return;
    measured = false; VIS = 2; ensureVisible(); renderGrid(); ensureVisible(); renderGrid();
  }, 100);
});

// ---------- live refresh ----------
// The game list is rebuilt in the background while the menu starts (pocketmz-menu.sh): the menu
// shows the previous list at once and takes the new one when library.json changes.
let libMtime = 0, libPending = false;
function libStat() { try { return fs.statSync(libPath("library.json")).mtimeMs; } catch (e) { return 0; } }
function applyLibrary(lib) {
  const sel = list[idx] && list[idx].id;
  games = lib.games.filter(g => g && g.id != null);
  loadError = null;
  $("tabbar").hidden = games.length === 0;
  if (!games.length) { showEmpty(true); return; }
  showEmpty(false);
  tabs = buildTabs();
  const key = tabs.some(t => t.key === tabKey) && list.length ? tabKey
    : (tabs.some(t => t.key === st.tab) ? st.tab : (tabs.some(t => t.key === "recent") ? "recent" : "all"));
  if (sel) st.selected[key] = sel;
  setTab(key);
}
function watchLibrary() {
  if (!BASE) return;
  libMtime = libStat();
  let ticks = 0;
  const timer = setInterval(() => {
    if (++ticks > 180) { clearInterval(timer); return; }   // the background scan is done by then
    const m = libStat();
    if (m && m !== libMtime) { libMtime = m; libPending = true; }
    if (!libPending || mode !== "grid") return;            // not while a dialog is open
    libPending = false;
    try {
      const lib = JSON.parse(fs.readFileSync(libPath("library.json"), "utf8"));
      if (lib && Array.isArray(lib.games)) applyLibrary(lib);
    } catch (e) { libPending = true; }                     // half-written: try again next tick
  }, 1000);
}

// ---------- start ----------
async function init() {
  $("ihints").textContent = T.hints;
  watchLibrary();
  try {
    const s = await readJSON("state.json");
    if (s && typeof s === "object") {
      st.favorites = Array.isArray(s.favorites) ? s.favorites.slice() : [];
      st.tab = typeof s.tab === "string" ? s.tab : "";
      st.selected = s.selected && typeof s.selected === "object" ? s.selected : {};
    }
  } catch (e) { console.warn("state.json ignored:", e); }
  if (BASE && !fs.existsSync(libPath("library.json"))) {   // first start: the scan is still running
    $("tabbar").hidden = true;
    showEmpty(true);
    $("empty").textContent = T.scanning;
    return;
  }
  try {
    const lib = await readJSON("library.json");
    if (!lib || !Array.isArray(lib.games)) throw new Error("library.json: missing or no games array");
    games = lib.games.filter(g => g && g.id != null);
  } catch (e) {
    loadError = String((e && e.message) || e);
    games = [];
  }

  $("tabbar").hidden = games.length === 0;
  if (!games.length) { showEmpty(true); return; }
  showEmpty(false);
  tabs = buildTabs();
  let key = st.tab;
  if (!tabs.some(t => t.key === key)) key = tabs.some(t => t.key === "recent") ? "recent" : "all";
  setTab(key);
}
init().finally(() => {
  // time stamp of the first screen (tests measure game exit -> menu shown with it)
  if (BASE) requestAnimationFrame(() => requestAnimationFrame(() => writeJSON("shown.json", { t: Date.now() })));
});
})();
