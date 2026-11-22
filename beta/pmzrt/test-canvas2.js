'use strict';
// Canvas 2D self-checks (no window): node test-canvas2.js -> prints PASS/FAIL per check.
const pmz = require('/opt/beta/pmzrt/pmzrt.node');
class El { constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; } }
const c2d = require('/opt/beta/pmzrt/canvas2d.js').create({ pmz, FakeElement: El, resolvePath: p => p, createGL: () => null });
let fails = 0, n = 0;
const ok = (name, cond, info) => { n++; if (!cond) fails++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + (info === undefined ? '' : JSON.stringify(info)))); };
const mk = (w, h) => { const c = new c2d.HTMLCanvasElement(); c.width = w; c.height = h; return c; };
const px = (ctx, x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
const near = (a, b, t = 2) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= t);
(async () => {
  const f = new c2d.FontFace('tf', 'url(/game/fonts/MPLUS1-Regular.ttf)'); await f.load(); ok('FontFace load', f.status === 'loaded', f.status);
  let c = mk(64, 64), x = c.getContext('2d');
  // colours
  for (const [s, e] of [['#f00', [255, 0, 0, 255]], ['#00ff0080', [0, 255, 0, 128]], ['rgb(10,20,30)', [10, 20, 30, 255]], ['rgba(0,0,255,0.5)', [0, 0, 255, 128]], ['hsl(120,100%,50%)', [0, 255, 0, 255]], ['rebeccapurple', [102, 51, 153, 255]], ['transparent', [0, 0, 0, 0]], ['rgb(100% 0% 0% / 50%)', [255, 0, 0, 128]]]) {
    x.clearRect(0, 0, 64, 64); x.fillStyle = s; x.fillRect(0, 0, 4, 4); ok('color ' + s, near(px(x, 1, 1), e, 1), px(x, 1, 1));
  }
  x.fillStyle = '#123456'; x.fillStyle = 'notacolor'; x.clearRect(0, 0, 64, 64); x.fillRect(0, 0, 4, 4); ok('invalid colour ignored', near(px(x, 1, 1), [0x12, 0x34, 0x56, 255], 1), px(x, 1, 1));
  // alpha / composite
  x.clearRect(0, 0, 64, 64); x.fillStyle = '#fff'; x.globalAlpha = 0.5; x.fillRect(0, 0, 8, 8); x.globalAlpha = 1; ok('globalAlpha', near(px(x, 2, 2), [255, 255, 255, 128], 1), px(x, 2, 2));
  x.fillStyle = '#f00'; x.fillRect(0, 0, 8, 8); x.globalCompositeOperation = 'destination-out'; x.fillRect(0, 0, 4, 8); x.globalCompositeOperation = 'source-over';
  ok('destination-out', px(x, 1, 1)[3] === 0 && px(x, 6, 1)[3] === 255, [px(x, 1, 1), px(x, 6, 1)]);
  x.clearRect(0, 0, 64, 64); x.fillStyle = '#400'; x.fillRect(0, 0, 8, 8); x.globalCompositeOperation = 'lighter'; x.fillStyle = '#040'; x.fillRect(0, 0, 8, 8); x.globalCompositeOperation = 'source-over';
  ok('lighter', near(px(x, 2, 2), [68, 68, 0, 255], 1), px(x, 2, 2));
  x.clearRect(0, 0, 64, 64); x.fillStyle = '#ff0000'; x.fillRect(0, 0, 8, 8); x.globalCompositeOperation = 'source-atop'; x.fillStyle = '#0000ff'; x.fillRect(4, 0, 8, 8); x.globalCompositeOperation = 'source-over';
  ok('source-atop', near(px(x, 6, 2), [0, 0, 255, 255]) && px(x, 10, 2)[3] === 0, [px(x, 6, 2), px(x, 10, 2)]);
  x.clearRect(0, 0, 64, 64); x.fillStyle = '#808080'; x.fillRect(0, 0, 8, 8); x.globalCompositeOperation = 'multiply'; x.fillStyle = '#808080'; x.fillRect(0, 0, 8, 8); x.globalCompositeOperation = 'source-over';
  ok('multiply', near(px(x, 2, 2), [64, 64, 64, 255], 2), px(x, 2, 2));
  ok('comp op invalid ignored', (x.globalCompositeOperation = 'bogus', x.globalCompositeOperation === 'source-over'));
  // clip + transforms + paths
  x.clearRect(0, 0, 64, 64); x.save(); x.beginPath(); x.rect(10, 10, 10, 10); x.clip(); x.fillStyle = '#0f0'; x.fillRect(0, 0, 64, 64); x.restore();
  ok('clip', px(x, 12, 12)[1] === 255 && px(x, 5, 5)[3] === 0 && px(x, 25, 25)[3] === 0, [px(x, 12, 12), px(x, 5, 5)]);
  x.fillStyle = '#00f'; x.fillRect(0, 0, 64, 64); ok('restore resets clip', px(x, 5, 5)[2] === 255);
  x.clearRect(0, 0, 64, 64); x.save(); x.translate(20, 30); x.scale(2, 2); x.fillStyle = '#f0f'; x.fillRect(0, 0, 5, 5); x.restore();
  ok('translate+scale', near(px(x, 25, 35), [255, 0, 255, 255]) && px(x, 19, 29)[3] === 0 && px(x, 31, 41)[3] === 0, [px(x, 25, 35), px(x, 31, 41)]);
  x.clearRect(0, 0, 64, 64); x.save(); x.setTransform(0, 1, -1, 0, 30, 0); x.fillStyle = '#ff0'; x.fillRect(0, 0, 10, 5); x.restore();   // rotated 90deg
  ok('setTransform rotate', px(x, 27, 5)[3] === 255 && px(x, 5, 27)[3] === 0, [px(x, 27, 5), px(x, 5, 27)]);
  x.clearRect(0, 0, 64, 64); x.fillStyle = '#fff'; x.beginPath(); x.rect(0, 0, 20, 20); x.rect(5, 5, 10, 10); x.fill('evenodd'); ok('evenodd', px(x, 10, 10)[3] === 0 && px(x, 2, 2)[3] === 255, [px(x, 10, 10)]);
  x.clearRect(0, 0, 64, 64); x.beginPath(); x.arc(32, 32, 10, 0, Math.PI * 2); x.fill(); ok('arc', px(x, 32, 32)[3] === 255 && px(x, 32, 20)[3] === 0 && px(x, 44, 32)[3] === 0);
  x.clearRect(0, 0, 64, 64); x.strokeStyle = '#f00'; x.lineWidth = 4; x.beginPath(); x.moveTo(0, 10); x.lineTo(40, 10); x.stroke(); ok('stroke line', near(px(x, 20, 10), [255, 0, 0, 255]) && px(x, 20, 13)[3] === 0 && px(x, 20, 7)[3] === 0, [px(x, 20, 10), px(x, 20, 7)]);
  x.clearRect(0, 0, 64, 64); x.beginPath(); x.moveTo(5, 5); x.arcTo(30, 5, 30, 30, 10); x.lineTo(30, 30); x.stroke(); ok('arcTo draws', px(x, 15, 5)[3] > 0 && px(x, 30, 25)[3] > 0, [px(x, 15, 5), px(x, 30, 25)]);
  x.fillStyle = '#fff'; x.clearRect(0, 0, 64, 64); x.beginPath(); x.rect(0, 0, 4, 4); x.fillRect(10, 10, 4, 4); x.fill(); ok('path survives fillRect', px(x, 2, 2)[3] === 255);
  ok('isPointInPath', (x.beginPath(), x.rect(0, 0, 10, 10), x.isPointInPath(5, 5) && !x.isPointInPath(15, 15)));
  // gradients / patterns
  x.clearRect(0, 0, 64, 64); const g = x.createLinearGradient(0, 0, 64, 0); g.addColorStop(0, '#000'); g.addColorStop(1, '#fff'); x.fillStyle = g; x.fillRect(0, 0, 64, 8);
  ok('linear gradient', px(x, 2, 2)[0] < 12 && px(x, 61, 2)[0] > 243 && Math.abs(px(x, 32, 2)[0] - 128) < 8, [px(x, 2, 2), px(x, 32, 2), px(x, 61, 2)]);
  const rg = x.createRadialGradient(32, 32, 0, 32, 32, 16); rg.addColorStop(0, '#f00'); rg.addColorStop(1, 'rgba(255,0,0,0)'); x.clearRect(0, 0, 64, 64); x.fillStyle = rg; x.fillRect(0, 0, 64, 64);
  ok('radial gradient', px(x, 32, 32)[0] === 255 && px(x, 2, 2)[3] === 0, [px(x, 32, 32), px(x, 2, 2)]);
  ok('gradient bad color throws', (() => { try { g.addColorStop(0.5, 'nope'); return false; } catch (e) { return true; } })());
  x.globalAlpha = 0.5; x.clearRect(0, 0, 64, 64); x.fillStyle = g; x.fillRect(0, 0, 64, 8); x.globalAlpha = 1; ok('gradient + globalAlpha', Math.abs(px(x, 61, 2)[3] - 128) <= 2, px(x, 61, 2));
  const tile = mk(4, 4), tx = tile.getContext('2d'); tx.fillStyle = '#f00'; tx.fillRect(0, 0, 2, 4); tx.fillStyle = '#00f'; tx.fillRect(2, 0, 2, 4);
  x.clearRect(0, 0, 64, 64); x.fillStyle = x.createPattern(tile, 'repeat'); x.fillRect(0, 0, 64, 8);
  ok('pattern repeat', near(px(x, 1, 1), [255, 0, 0, 255]) && near(px(x, 3, 1), [0, 0, 255, 255]) && near(px(x, 5, 1), [255, 0, 0, 255]) && near(px(x, 63, 1), [0, 0, 255, 255]), [px(x, 1, 1), px(x, 3, 1), px(x, 5, 1)]);
  x.clearRect(0, 0, 64, 64); x.fillStyle = x.createPattern(tile, 'no-repeat'); x.fillRect(0, 0, 64, 8); ok('pattern no-repeat', px(x, 1, 1)[3] === 255 && px(x, 5, 1)[3] === 0, [px(x, 5, 1)]);
  // drawImage
  const src = mk(8, 8), sx = src.getContext('2d'); sx.fillStyle = '#f00'; sx.fillRect(0, 0, 4, 8); sx.fillStyle = '#0f0'; sx.fillRect(4, 0, 4, 8);
  x.clearRect(0, 0, 64, 64); x.drawImage(src, 10, 10); ok('drawImage 3 args', near(px(x, 11, 11), [255, 0, 0, 255]) && near(px(x, 16, 11), [0, 255, 0, 255]) && px(x, 18, 11)[3] === 0);
  x.clearRect(0, 0, 64, 64); x.drawImage(src, 0, 0, 16, 16); ok('drawImage scaled', near(px(x, 3, 3), [255, 0, 0, 255]) && near(px(x, 12, 3), [0, 255, 0, 255]) && px(x, 17, 3)[3] === 0, [px(x, 3, 3), px(x, 12, 3), px(x, 17, 3)]);
  x.clearRect(0, 0, 64, 64); x.drawImage(src, 4, 0, 4, 8, 20, 20, 4, 8); ok('drawImage sub-rect', near(px(x, 21, 21), [0, 255, 0, 255]) && px(x, 19, 21)[3] === 0 && px(x, 25, 21)[3] === 0, [px(x, 21, 21), px(x, 19, 21), px(x, 25, 21)]);
  x.clearRect(0, 0, 64, 64); x.globalAlpha = 0.5; x.drawImage(src, 0, 0); x.globalAlpha = 1; ok('drawImage globalAlpha', near(px(x, 1, 1), [255, 0, 0, 128], 2), px(x, 1, 1));
  x.clearRect(0, 0, 64, 64); x.imageSmoothingEnabled = false; x.drawImage(src, 3, 0, 2, 2, 0, 0, 16, 16); x.imageSmoothingEnabled = true; ok('imageSmoothing off = hard edge', near(px(x, 7, 5), [255, 0, 0, 255]) && near(px(x, 8, 5), [0, 255, 0, 255]), [px(x, 7, 5), px(x, 8, 5)]);
  // image data
  x.clearRect(0, 0, 64, 64); const id = x.createImageData(4, 4); for (let i = 0; i < 16; i++) { id.data[i * 4] = 200; id.data[i * 4 + 1] = 100; id.data[i * 4 + 2] = 50; id.data[i * 4 + 3] = 255; }
  x.putImageData(id, 10, 10); ok('putImageData', near(px(x, 11, 11), [200, 100, 50, 255]), px(x, 11, 11));
  x.clearRect(0, 0, 64, 64); x.putImageData(id, 10, 10, 1, 1, 2, 2); ok('putImageData dirty rect', px(x, 11, 11)[3] === 255 && px(x, 10, 10)[3] === 0 && px(x, 13, 13)[3] === 0, [px(x, 11, 11), px(x, 10, 10)]);
  const half = x.createImageData(1, 1); half.data.set([255, 128, 0, 128]); x.clearRect(0, 0, 64, 64); x.putImageData(half, 0, 0); ok('premultiply roundtrip', near(px(x, 0, 0), [255, 128, 0, 128], 2), px(x, 0, 0));
  ok('getImageData outside = transparent', px(x, -5, -5).every(v => v === 0));
  // text
  x.clearRect(0, 0, 64, 64); x.font = '20px tf, sans-serif'; const m1 = x.measureText('Test'), m2 = x.measureText('Test Test'); ok('measureText width grows', m1.width > 20 && m2.width > m1.width * 2 - 2, [m1.width, m2.width]);
  const dpx = (al, bl) => { const c2 = mk(200, 60), q = c2.getContext('2d'); q.font = '20px tf'; q.fillStyle = '#fff'; q.textAlign = al; q.textBaseline = bl; q.fillText('HHHH', 100, 30); const d = q.getImageData(0, 0, 200, 60).data; let x0 = 999, x1 = -1, y0 = 999, y1 = -1; for (let yy = 0; yy < 60; yy++) for (let xx = 0; xx < 200; xx++) if (d[(yy * 200 + xx) * 4 + 3] > 128) { x0 = Math.min(x0, xx); x1 = Math.max(x1, xx); y0 = Math.min(y0, yy); y1 = Math.max(y1, yy); } return { x0, x1, y0, y1 }; };
  const L = dpx('left', 'alphabetic'), R = dpx('right', 'alphabetic'), C = dpx('center', 'alphabetic'), T = dpx('left', 'top'), M = dpx('left', 'middle'), B = dpx('left', 'bottom');
  ok('textAlign left starts at x', L.x0 >= 99 && L.x0 <= 103, L); ok('textAlign right ends at x', R.x1 >= 96 && R.x1 <= 100, R); ok('textAlign center', Math.abs((C.x0 + C.x1) / 2 - 100) <= 2, C);
  ok('baseline alphabetic: glyph bottom at y', L.y1 >= 28 && L.y1 <= 30, L); ok('baseline top below y', T.y0 >= 30 && T.y0 <= 45, T); ok('baseline middle', M.y1 > 30 && M.y0 < 30 + 2, M); ok('baseline bottom above y', B.y1 <= 30, B);
  const wide = mk(200, 40), wq = wide.getContext('2d'); wq.font = '20px tf'; wq.fillStyle = '#fff'; wq.fillText('HHHHHHHH', 0, 30, 40); const wd = wq.getImageData(0, 0, 200, 40).data; let maxX = 0; for (let yy = 0; yy < 40; yy++) for (let xx = 0; xx < 200; xx++) if (wd[(yy * 200 + xx) * 4 + 3] > 64) maxX = Math.max(maxX, xx);
  ok('fillText maxWidth squeezes', maxX <= 41, maxX);
  x.font = 'bold italic 12pt "tf", serif'; ok('font shorthand accepted', x.font.includes('12pt')); x.font = 'garbage'; ok('bad font ignored', x.font.includes('12pt'));
  ok('measureText fontBoundingBox', m1.fontBoundingBoxAscent > 10 && m1.fontBoundingBoxDescent > 2, m1);
  x.font = '20px tf'; const jp2 = x.measureText('日本語'); ok('CJK measure ~ 3em', Math.abs(jp2.width - 60) < 4, jp2.width);
  // resize resets
  c.width = 64; ok('width assign clears + resets state', px(x, 5, 5)[3] === 0 && x.font === '10px sans-serif' && x.globalAlpha === 1, [x.font]);
  c.width = 100; c.height = 20; ok('resize', x.getImageData(0, 0, 100, 20).data.length === 8000);
  ok('toDataURL png', c.toDataURL().startsWith('data:image/png;base64,iVBOR'));
  // shadow / filter
  x.clearRect(0, 0, 100, 20); x.shadowColor = '#f00'; x.shadowOffsetX = 6; x.fillStyle = '#00f'; x.fillRect(0, 0, 4, 10); x.shadowColor = 'rgba(0,0,0,0)'; x.shadowOffsetX = 0;
  ok('shadow offset', near(px(x, 8, 3), [255, 0, 0, 255]) && near(px(x, 2, 3), [0, 0, 255, 255]), [px(x, 8, 3), px(x, 2, 3)]);
  x.clearRect(0, 0, 100, 20); x.fillStyle = '#fff'; x.filter = 'blur(2px)'; x.fillRect(40, 5, 10, 10); x.filter = 'none'; ok('filter blur', px(x, 45, 10)[3] > 100 && px(x, 51, 10)[3] > 0 && px(x, 51, 10)[3] < 255, [px(x, 45, 10), px(x, 51, 10)]);
  // stroked-text cache: the mask path must paint what a direct stroke paints (same rasteriser: allow 3 levels), and a hit must equal the miss that built it
  if (pmz.textCacheSet) {
    const strokeImg = (cache, xx, yy, alpha, extra) => { pmz.textCacheSet(cache); const c3 = mk(220, 60), q = c3.getContext('2d'); q.font = '20px tf'; q.lineJoin = 'round'; q.lineWidth = 4; q.strokeStyle = 'rgba(200,0,0,0.8)'; q.globalAlpha = alpha; if (extra) extra(q); q.strokeText('Test 日本語', xx, yy); q.fillStyle = '#fff'; q.fillText('Test 日本語', xx, yy); return q.getImageData(0, 0, 220, 60).data; };
    const mdiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
    for (const [xx, yy, al] of [[10, 30, 1], [10.5, 30.25, 1], [12.3, 31.7, 0.6]]) {
      const direct = strokeImg(false, xx, yy, al), miss = strokeImg(true, xx, yy, al), hit = strokeImg(true, xx, yy, al);
      ok('stroke cache vs direct @' + xx + ',' + yy + ' a' + al, mdiff(direct, miss) <= 3, mdiff(direct, miss)); ok('stroke cache hit == miss @' + xx + ',' + yy, mdiff(miss, hit) === 0, mdiff(miss, hit));
    }
    { const direct = strokeImg(false, 10, 30, 1, q => { q.beginPath(); q.rect(0, 0, 40, 60); q.clip(); }), cached = strokeImg(true, 10, 30, 1, q => { q.beginPath(); q.rect(0, 0, 40, 60); q.clip(); }); ok('stroke cache respects clip', mdiff(direct, cached) <= 3, mdiff(direct, cached)); }
    { const sh = q => { q.shadowColor = '#00f'; q.shadowOffsetX = 3; q.shadowOffsetY = 3; }; const direct = strokeImg(false, 10, 30, 1, sh), cached = strokeImg(true, 10, 30, 1, sh); ok('stroke cache + shadow', mdiff(direct, cached) <= 3, mdiff(direct, cached)); }
    { const sq = q => { q.textAlign = 'center'; }; const direct = strokeImg(false, 100, 30, 1, sq), cached = strokeImg(true, 100, 30, 1, sq); ok('stroke cache + textAlign center', mdiff(direct, cached) <= 3, mdiff(direct, cached)); }
    pmz.textCacheSet(true);
  }
  console.log(fails ? ('FAILED ' + fails + ' of ' + n) : ('ALL ' + n + ' PASSED'));
})().catch(e => { console.log('EXC', e.stack); });
