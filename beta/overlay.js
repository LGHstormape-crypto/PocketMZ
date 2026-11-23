'use strict';
// overlay.js - draws the few HTML layers PocketMZ patches put on top of the game (PocketMZ_Menu: #pmzMenu panel, fps box, toast, title hint)
// onto a 2D canvas, because pmzrun has no real DOM/CSS. Not a browser: only what PocketMZ_Menu.js builds is understood
// (position:fixed boxes with text; the menu panel with h1 / .row / .ask / .note / .keys / .list children). Window space = 640x480 CSS px.
const FONT = '"Noto Sans CJK JP","Noto Sans CJK SC",sans-serif';

function parseCss(s) {
  const o = {};
  for (const d of String(s || '').split(';')) { const i = d.indexOf(':'); if (i > 0) o[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim(); }
  return o;
}
const px = v => { const m = /^(-?[\d.]+)px/.exec(String(v || '')); return m ? parseFloat(m[1]) : null; };
function color(c, alpha) {   // '#rgb' / '#rrggbb' / 'rgba(r,g,b,.7)' -> 'rgba(r,g,b,a)' with leading zeros (cairo parser)
  c = String(c || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(c); if (m) c = '#' + m[1].split('').map(x => x + x).join('');
  m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) return 'rgba(' + parseInt(m[1].slice(0, 2), 16) + ',' + parseInt(m[1].slice(2, 4), 16) + ',' + parseInt(m[1].slice(4, 6), 16) + ',' + (alpha === undefined ? 1 : alpha) + ')';
  m = /^rgba?\(([^)]*)\)/i.exec(c);
  if (m) { const p = m[1].split(',').map(x => parseFloat(x)); return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + ((p.length > 3 ? p[3] : 1) * (alpha === undefined ? 1 : alpha)) + ')'; }
  const named = { white: '#ffffff', black: '#000000' }; if (named[c]) return color(named[c], alpha);
  return 'rgba(255,255,255,' + (alpha === undefined ? 1 : alpha) + ')';
}
const text = el => { let t = el.textContent || ''; if (!t && el.children) t = el.children.map(text).join(''); return String(t); };
const cls = el => String(el.className || '').split(/\s+/);

function create(opts) {
  const { doc, W = 640, H = 480, getCursor = null } = opts;
  const canvas = doc.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  let lastSig = null, lastDomSig = '', visible = false;
  ctx.font = '15px ' + FONT; ctx.fillStyle = 'rgba(0,0,0,0.01)'; ctx.textBaseline = 'middle'; for (const t of ['PocketMZ 菜单 メニュー 日本語 ←→↑↓ ‹ › ×1 fps', 'bold']) { ctx.font = (t === 'bold' ? 'bold 17px ' : '15px ') + FONT; ctx.fillText('PocketMZ 菜单 メニュー 日本語 ←→↑↓ ‹ › ×1 fps', 0, 20); } ctx.clearRect(0, 0, W, H);   // warm-up: first use of the CJK font costs ~0.7 s; do it at boot, not when the menu opens

  function wrap(ctx2, t, maxW) {   // character-level wrap (CJK friendly), keeps words together when a space is available
    const lines = []; let cur = '';
    for (const ch of String(t)) {
      if (ctx2.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ch === ' ' ? '' : ch; } else cur += ch;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }
  function rrect(x, y, w, h, r, fill, stroke) {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }
  function str(t, x, y, size, col, align, bold) {
    ctx.font = (bold ? 'bold ' : '') + size + 'px ' + FONT; ctx.fillStyle = col; ctx.textAlign = align || 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(t, x, y);
  }
  function fixedBox(el, css) {   // small position:fixed text box (fps counter, toast, title hint)
    const t = text(el); if (!t) return;
    const fm = /([\d.]+)px/.exec(css.font || ''), size = fm ? parseFloat(fm[1]) : 14;
    ctx.font = size + 'px ' + FONT;
    const pad = String(css.padding || '2px 6px').split(/\s+/).map(px), pv = pad[0] || 2, ph = pad.length > 1 ? pad[1] : pv;
    const w = Math.ceil(ctx.measureText(t).width) + ph * 2, h = Math.ceil(size * 1.4) + pv * 2;
    let x, y;
    if (css.left !== undefined && /%$/.test(css.left)) x = W * parseFloat(css.left) / 100 - (/translatex\(-50%\)/i.test(css.transform || '') ? w / 2 : 0);
    else if (css.left !== undefined) x = px(css.left); else if (css.right !== undefined) x = W - px(css.right) - w; else x = 0;
    if (css.top !== undefined) y = px(css.top); else if (css.bottom !== undefined) y = H - px(css.bottom) - h; else y = 0;
    rrect(x, y, w, h, px(css['border-radius']) || 0, color(css.background || 'rgba(0,0,0,.6)'));
    str(t, x + ph, y + h / 2, size, color(css.color || '#fff'));
  }
  function menu(layer) {
    ctx.fillStyle = 'rgba(10,12,16,0.72)'; ctx.fillRect(0, 0, W, H);
    const box = layer.children[0]; if (!box) return;
    const bw = Math.min(560, W * 0.92), maxH = H * 0.96, padX = 14, padY = 12, inner = bw - padX * 2 - 2;
    // pass 1: heights
    const m = [];   // {kind, el, h, lines}
    const measure = (list, out) => {
      for (const el of list) {
        const c = cls(el), tag = el.tagName;
        if (tag === 'H1') { ctx.font = 'bold 17px ' + FONT; out.push({ k: 'h1', el, h: 23 + 8 }); }
        else if (c.includes('row')) {
          const small = el._inList; const fs = small ? 14 : 15, pv = small ? 3 : 6;
          out.push({ k: 'row', el, h: Math.round(fs * 1.45) + pv * 2, fs, pv, sel: c.includes('sel'), dim: c.includes('dim') });
        }
        else if (c.includes('ask') || c.includes('note')) {
          const fs = c.includes('note') ? 12 : 15; ctx.font = fs + 'px ' + FONT;
          const lines = wrap(ctx, text(el), inner - 20), lh = Math.round(fs * 1.45);
          out.push({ k: 'text', el, fs, lines, lh, note: c.includes('note'), h: lines.length * lh + (c.includes('note') ? 6 : 12) + (c.includes('note') ? 0 : 0) });
        }
        else if (c.includes('keys')) { ctx.font = '12px ' + FONT; const lines = wrap(ctx, text(el), inner); out.push({ k: 'keys', el, lines, h: lines.length * 17 + 8 }); }
        else if (c.includes('list')) { for (const r of el.children) r._inList = true; const sub = []; measure(el.children, sub); out.push({ k: 'list', el, sub, h: sub.reduce((a, b) => a + b.h, 0) }); }
      }
    };
    measure(box.children, m);
    let total = m.reduce((a, b) => a + b.h, 0) + padY * 2 + 2;
    let boxH = Math.min(total, maxH);
    const bx = Math.round((W - bw) / 2), by = Math.round((H - boxH) / 2);
    rrect(bx + 0.5, by + 0.5, bw - 1, boxH - 1, 8, color('#1b1f29'), color('#2e3446'));
    ctx.save(); ctx.beginPath(); ctx.rect(bx, by, bw, boxH); ctx.clip();
    const x0 = bx + 1 + padX, w0 = inner;
    let y = by + 1 + padY;
    const drawItem = (it, yy, clipTop) => {
      if (it.k === 'h1') str(text(it.el), x0, yy + 12, 17, color('#4f8cff'), 'left', true);
      else if (it.k === 'row') {
        const a = it.dim ? 0.45 : 1;
        if (it.sel) rrect(x0, yy, w0, it.h, 5, color('#4f8cff', a));
        const ch = it.el.children, lab = ch[0] ? text(ch[0]) : text(it.el), val = ch[1] ? text(ch[1]) : '';
        const cy = yy + it.h / 2;
        str(lab, x0 + 10, cy, it.fs, color(it.sel ? '#ffffff' : '#e8eaf0', a));
        if (val) str(val, x0 + w0 - 10, cy, it.fs, color(it.sel ? '#ffffff' : '#9aa3b5', a), 'right');
      }
      else if (it.k === 'text') it.lines.forEach((l, i) => str(l, x0 + (it.note ? 0 : 10), yy + (it.note ? 6 : 6) + i * it.lh + it.lh / 2, it.fs, color(it.note ? '#9aa3b5' : '#e8eaf0')));
      else if (it.k === 'keys') it.lines.forEach((l, i) => str(l, x0, yy + 8 + i * 17 + 8, 12, color('#9aa3b5')));
    };
    // the list takes the remaining height and scrolls so that the selected row stays visible
    const fixedH = m.filter(i => i.k !== 'list').reduce((a, b) => a + b.h, 0);
    for (const it of m) {
      if (it.k !== 'list') { drawItem(it, y, 0); y += it.h; continue; }
      const avail = Math.max(40, boxH - padY * 2 - 2 - fixedH), viewH = Math.min(it.h, avail);
      let selY = 0, acc = 0; for (const s of it.sub) { if (s.sel) selY = acc; acc += s.h; }
      let scroll = 0; if (it.h > viewH) { const rowH = (it.sub[0] && it.sub[0].h) || 20; scroll = Math.max(0, Math.min(it.h - viewH, selY + rowH - viewH)); }
      ctx.save(); ctx.beginPath(); ctx.rect(x0, y, w0, viewH); ctx.clip();
      let yy = y - scroll; for (const s of it.sub) { if (yy + s.h > y && yy < y + viewH) drawItem(s, yy, y); yy += s.h; }
      ctx.restore(); y += viewH;
    }
    ctx.restore();
  }

  function drawCursor(cur) {
    ctx.save();
    ctx.translate(cur.x + 0.5, cur.y + 0.5);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 17);
    ctx.lineTo(4.5, 13);
    ctx.lineTo(7.5, 19);
    ctx.lineTo(10, 17.8);
    ctx.lineTo(7, 11.8);
    ctx.lineTo(12.5, 11.8);
    ctx.closePath();
    ctx.fillStyle = cur.down ? '#4f8cff' : '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  }

  const api = { canvas, update, W, H, domChanged: false };
  // Returns 'draw' / 'same' / 'hide' / null. api.domChanged distinguishes DOM changes (menu/toast/fps) from cursor-only motion.
  function update() {
    const live = [];
    for (const el of doc.body.children) {
      if (el.hidden) continue;
      if (el.id === 'pmzMenu') live.push({ el, menu: true });
      else { const css = parseCss(el.style && el.style.cssText); if (/fixed/.test(css.position || '')) live.push({ el, css }); }
    }
    const cur = getCursor ? getCursor() : null;
    if (!live.length && !cur) {
      const was = visible;
      api.domChanged = !!lastDomSig;
      visible = false; lastSig = null; lastDomSig = '';
      return was ? 'hide' : null;
    }
    const domSig = live.map(l => l.menu ? 'M' + JSON.stringify((function dump(e) { return [e.className, text(e), (e.children || []).map(dump)]; })(l.el)) : 'F' + text(l.el) + '|' + (l.el.style && l.el.style.cssText)).join('#');
    const curSig = cur ? (cur.x + ',' + cur.y + ',' + (cur.down ? 1 : 0)) : '';
    const sig = domSig + '@@' + curSig;
    api.domChanged = domSig !== lastDomSig;
    visible = true;
    if (sig === lastSig) return 'same';
    lastSig = sig;
    lastDomSig = domSig;
    ctx.clearRect(0, 0, W, H);
    for (const l of live) { try { if (l.menu) menu(l.el); else fixedBox(l.el, l.css); } catch (e) { console.log('overlay draw error', e && e.stack); } }
    if (cur) { try { drawCursor(cur); } catch (e) { console.log('overlay cursor error', e && e.stack); } }
    return 'draw';
  }
  return api;
}
module.exports = { create };
