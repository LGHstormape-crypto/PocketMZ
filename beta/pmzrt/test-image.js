// node test-image.js <dir>: decodes every <name> with a <name>.rgba reference (a.jpg, g.jpg, ll.webp ...) through pmzrt.decodeJpeg/decodeWebp/decodePng and compares
const fs = require('fs'), path = require('path');
const pmz = require('/opt/beta/pmzrt/pmzrt.node'); const dir = process.argv[2];
let bad = 0;
for (const f of fs.readdirSync(dir).filter(f => !f.endsWith('.rgba'))) {
  const b = fs.readFileSync(path.join(dir, f)), ref = fs.readFileSync(path.join(dir, f + '.rgba'));
  const fn = /jpe?g$/.test(f) ? 'decodeJpeg' : /webp$/.test(f) ? 'decodeWebp' : 'decodePng';
  const r = pmz[fn](b); let maxd = 0, nd = 0;
  for (let i = 0; i < ref.length; i++) { const d = Math.abs(r.data[i] - ref[i]); if (d > maxd) maxd = d; if (d) nd++; }
  const ok = r.data.length === ref.length && maxd <= (/ll\.webp$/.test(f) ? 0 : 2);
  if (!ok) bad++;
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + f + ' ' + r.width + 'x' + r.height + ' bytes ' + r.data.length + '/' + ref.length + ' maxdiff ' + maxd + ' differing ' + nd);
}
for (const [fn, bytes] of [['decodeJpeg', Buffer.from('notajpeg')], ['decodeWebp', Buffer.from('RIFFxxxxWEBPjunk')], ['decodeJpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0])]]) { try { pmz[fn](bytes); console.log('FAIL no throw ' + fn); bad++; } catch (e) { console.log('ok   ' + fn + ' garbage throws: ' + e.message); } }
console.log(bad ? 'FAILED ' + bad : 'all ok'); process.exit(bad ? 1 : 0);
