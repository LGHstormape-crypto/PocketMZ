'use strict';
const fs = require('fs');
const pmz = require('./pmzrt.node');
const rss = () => { const s = fs.readFileSync('/proc/self/status', 'utf8'); const g = k => ((+(new RegExp(k + ':\\s+(\\d+)').exec(s) || [0, 0])[1]) / 1024).toFixed(1); return 'rss ' + g('VmRSS') + ' anon ' + g('RssAnon') + ' file ' + g('RssFile') + ' MB'; };
const now = () => Number(process.hrtime.bigint()) / 1e6;
const DURATION = (parseFloat(process.env.DURATION) || 10) * 1000;

const t0 = now();
const info = pmz.init({ width: 640, height: 480, fullscreen: true, vsync: true, title: 'pmzrt test' });
console.log('init time ms:', (now() - t0).toFixed(1));
console.log('info:', JSON.stringify(info));
console.log('RSS after init:', rss());

const times = []; let dropped = 0, quit = false, last = now(); const start = last;
while (!quit && now() - start < DURATION) {
  const t = (now() - start) / 1000;
  pmz.glViewport(0, 0, info.drawableWidth, info.drawableHeight);
  pmz.glClearColor(0.5 + 0.5 * Math.sin(t), 0.5 + 0.5 * Math.sin(t * 0.7 + 2), 0.5 + 0.5 * Math.sin(t * 1.3 + 4), 1);
  pmz.glClear(pmz.COLOR_BUFFER_BIT);
  pmz.drawTestTriangle(t);
  pmz.swap();
  for (const e of pmz.pollEvents()) {
    if (e.type === 'axis' && Math.abs(e.value) < 20000) continue;
    console.log('event', JSON.stringify(e));
    if (e.type === 'quit' || (e.type === 'buttondown' && (e.button === 'start' || e.button === 'back')) ||
        (e.type === 'keydown' && e.keycode === 27)) quit = true;
  }
  const n = now(); const dt = n - last; last = n; times.push(dt); if (dt > 25) dropped++;
}
times.shift();
const sum = times.reduce((a, b) => a + b, 0);
console.log(`frames ${times.length} avg ${(sum / times.length).toFixed(2)} ms min ${Math.min(...times).toFixed(2)} max ${Math.max(...times).toFixed(2)} fps ${(1000 * times.length / sum).toFixed(1)} dropped(>25ms) ${dropped}`);
console.log('RSS at end:', rss());
pmz.shutdown();
