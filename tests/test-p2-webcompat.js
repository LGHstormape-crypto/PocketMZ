'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createPersistentStorage,
  createMemoryStorage,
  XMLDocument,
  DOMParser,
  createWorkerClass,
} = require('../beta/pmzrt/webcompat.js');

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-p2-'));
  try {
    // 1. Persistent & memory storage
    const lsFile = path.join(tmpDir, 'ls.json');
    const ls1 = createPersistentStorage(lsFile, { debounceMs: 50 });
    ls1.setItem('alpha', '123');
    ls1['beta'] = 'xyz';
    assert.strictEqual(ls1.getItem('alpha'), '123');
    assert.strictEqual(ls1.beta, 'xyz');
    assert.strictEqual(ls1.length, 2);
    assert.deepStrictEqual(Object.keys(ls1).sort(), ['alpha', 'beta']);
    ls1.flush();
    assert.ok(fs.existsSync(lsFile), 'ls.json flushed');

    const ls2 = createPersistentStorage(lsFile);
    assert.strictEqual(ls2.getItem('alpha'), '123');
    assert.strictEqual(ls2.getItem('beta'), 'xyz');
    ls2.removeItem('alpha');
    assert.strictEqual(ls2.length, 1);
    ls2.clear();
    assert.strictEqual(ls2.length, 0);
    ls2.flush();

    const ss = createMemoryStorage();
    ss.setItem('k', 'v');
    assert.strictEqual(ss.getItem('k'), 'v');
    ss.flush();

    // 2. XMLDocument & DOMParser (PIXI BitmapFont XML style)
    const xml = `<?xml version="1.0"?>
<!-- font -->
<font>
  <info face="Test &amp; Co" size="24"/>
  <common lineHeight="28" scaleW="256" scaleH="256"/>
  <pages><page id="0" file="font_0.png"/></pages>
  <chars count="1"><char id="65" x="0" y="0" width="12" height="18"/><![CDATA[ok]]></chars>
</font>`;
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    assert.ok(doc instanceof XMLDocument, 'doc instanceof XMLDocument');
    assert.strictEqual(doc.documentElement.tagName, 'font');
    const info = doc.getElementsByTagName('info')[0];
    assert.strictEqual(info.getAttribute('face'), 'Test & Co');
    assert.strictEqual(info.getAttribute('size'), '24');
    const page = doc.querySelector('pages page[id="0"]');
    assert.ok(page);
    assert.strictEqual(page.getAttribute('file'), 'font_0.png');
    assert.strictEqual(doc.getElementsByTagName('chars')[0].textContent, 'ok');

    // 3. Worker (worker_threads) + concurrency cap
    const wFile = path.join(tmpDir, 'echo-worker.js');
    fs.writeFileSync(wFile, `
      self.onmessage = function(ev) {
        self.postMessage({ echo: ev.data, doubled: (ev.data.n || 0) * 2 });
      };
    `, 'utf8');

    const blobs = new Map();
    const blobCode = Buffer.from('self.onmessage = (e) => self.postMessage("blob:" + e.data);', 'utf8');
    blobs.set('blob:null/1', { _data: blobCode });
    const WorkerCls = createWorkerClass({ baseDir: tmpDir, maxWorkers: 2, blobUrls: blobs });

    const w1 = new WorkerCls('echo-worker.js');
    const w2 = new WorkerCls('blob:null/1');
    const w3 = new WorkerCls('data:application/javascript,self.onmessage=(e)=>self.postMessage("data:"+e.data);');

    const st = WorkerCls._stats();
    assert.strictEqual(st.active, 2, 'active capped at 2');
    assert.strictEqual(st.queued, 1, '3rd worker queued');

    const r1 = await new Promise((res, rej) => {
      w1.onerror = rej;
      w1.onmessage = (ev) => res(ev.data);
      w1.postMessage({ n: 21 });
    });
    assert.deepStrictEqual(r1, { echo: { n: 21 }, doubled: 42 });

    const r2 = await new Promise((res, rej) => {
      w2.onerror = rej;
      w2.onmessage = (ev) => res(ev.data);
      w2.postMessage('hi');
    });
    assert.strictEqual(r2, 'blob:hi');

    await w1.terminate();
    const r3 = await new Promise((res, rej) => {
      w3.onerror = rej;
      w3.onmessage = (ev) => res(ev.data);
      w3.postMessage('ok');
    });
    assert.strictEqual(r3, 'data:ok');

    await WorkerCls.terminateAll();
    const stEnd = WorkerCls._stats();
    assert.strictEqual(stEnd.active, 0);
    assert.strictEqual(stEnd.queued, 0);

    console.log('[test-p2-webcompat] OK');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
