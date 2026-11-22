'use strict';
// Standalone Canvas 2D test/benchmark (no window): node test-canvas.js [out.png]. Registers the game font, draws text/shapes, times drawing.
const pmz = require('/opt/beta/pmzrt/pmzrt.node');
const fs = require('fs');
class El { constructor(t) { this.tagName = String(t).toUpperCase(); this.style = {}; } }
const c2d = require('/opt/beta/pmzrt/canvas2d.js').create({ pmz, FakeElement: El, resolvePath: p => p, createGL: () => null });
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
function bench(name, n, fn) { fn(); const t = nowMs(); for (let i = 0; i < n; i++) fn(); const d = nowMs() - t; console.log(name.padEnd(28), (d / n).toFixed(3), 'ms/call'); }
(async () => {
  const f = new c2d.FontFace('rmmz-mainfont', 'url(/game/fonts/MPLUS1-Regular.ttf)'); await f.load(); console.log('font', f.status, f.real);
  const cv = new c2d.HTMLCanvasElement(); cv.width = 640; cv.height = 96; const ctx = cv.getContext('2d');
  ctx.fillStyle = '#202020'; ctx.fillRect(0, 0, 640, 96);
  ctx.font = '26px rmmz-mainfont, Verdana, sans-serif'; ctx.fillStyle = '#ffffff'; ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)'; ctx.lineWidth = 4; ctx.lineJoin = 'round';
  const txt = 'テスト文字列 Test 123';
  const m = ctx.measureText(txt); console.log('measure', JSON.stringify(m));
  ctx.strokeText(txt, 4, 30); ctx.fillText(txt, 4, 30);
  ctx.textAlign = 'right'; ctx.fillText('100%', 636, 30); ctx.textAlign = 'start';
  bench('fillText', 300, () => ctx.fillText(txt, 4, 30));
  bench('strokeText w4 round', 300, () => ctx.strokeText(txt, 4, 30));
  bench('measureText', 2000, () => ctx.measureText(txt));
  bench('save/font/measure/restore', 2000, () => { ctx.save(); ctx.font = '26px rmmz-mainfont, Verdana, sans-serif'; ctx.measureText(txt); ctx.restore(); });
  bench('fillRect', 2000, () => ctx.fillRect(10, 40, 200, 20));
  bench('clearRect 640x96', 1000, () => ctx.clearRect(0, 0, 640, 96));
  const im = new c2d.HTMLCanvasElement(); im.width = 640; im.height = 96; const ic = im.getContext('2d'); ic.fillStyle = '#4080c0'; ic.fillRect(0, 0, 640, 96);
  bench('drawImage 640x96 1:1', 1000, () => ctx.drawImage(im, 0, 0));
  bench('drawImage scaled sub', 1000, () => ctx.drawImage(im, 10, 10, 96, 48, 100, 50, 200, 40));
  bench('getImageData 1x1', 2000, () => ctx.getImageData(5, 5, 1, 1));
  bench('getImageData 640x96', 200, () => ctx.getImageData(0, 0, 640, 96));
  ctx.fillStyle = '#202020'; ctx.fillRect(0, 0, 640, 96); ctx.fillStyle = '#fff';
  ctx.strokeText(txt, 4, 30); ctx.fillText(txt, 4, 30);
  const g = ctx.createLinearGradient(0, 60, 300, 60); g.addColorStop(0, '#f00'); g.addColorStop(1, 'rgba(0,0,255,0.5)'); ctx.fillStyle = g; ctx.fillRect(0, 60, 300, 20);
  ctx.globalAlpha = 0.5; ctx.fillStyle = 'hsl(120, 100%, 40%)'; ctx.beginPath(); ctx.arc(400, 70, 20, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
  ctx.shadowColor = '#f0f'; ctx.shadowOffsetX = 3; ctx.shadowOffsetY = 3; ctx.shadowBlur = 4; ctx.fillStyle = '#ff0'; ctx.fillRect(500, 50, 40, 30); ctx.shadowColor = 'transparent';
  ctx.filter = 'blur(2px)'; ctx.fillStyle = '#0ff'; ctx.fillRect(560, 50, 40, 30); ctx.filter = 'none';
  const b = pmz.cvToPng(cv._cv); fs.writeFileSync(process.argv[2] || '/opt/beta/shots/canvastest.png', b); console.log('png', b.length);
})();
