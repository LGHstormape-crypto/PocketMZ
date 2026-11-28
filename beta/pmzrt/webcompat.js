'use strict';
const fs = require('fs');
const path = require('path');
const { Worker: NodeWorker } = require('worker_threads');

function createStorage(filePath, opts = {}) {
  const store = Object.create(null);
  const debounceMs = opts.debounceMs != null ? opts.debounceMs : 400;
  let timer = null;
  let dirty = false;

  if (filePath) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const k of Object.keys(parsed)) {
          if (parsed[k] != null) store[k] = String(parsed[k]);
        }
      }
    } catch (_) {}
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!filePath || !dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = filePath + '.tmp.' + (typeof process !== 'undefined' && process && process.pid ? process.pid : 0);
      fs.writeFileSync(tmp, JSON.stringify(store), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (_) {}
  }

  function schedule() {
    if (!filePath) return;
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, debounceMs);
    if (timer.unref) timer.unref();
  }

  const methods = {
    getItem(k) {
      const key = String(k);
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    setItem(k, v) {
      const key = String(k);
      const val = String(v);
      if (store[key] !== val) { store[key] = val; schedule(); }
    },
    removeItem(k) {
      const key = String(k);
      if (Object.prototype.hasOwnProperty.call(store, key)) { delete store[key]; schedule(); }
    },
    clear() {
      const keys = Object.keys(store);
      if (keys.length === 0) return;
      for (const k of keys) delete store[k];
      schedule();
    },
    key(i) {
      const keys = Object.keys(store);
      return i >= 0 && i < keys.length ? keys[i] : null;
    },
    flush,
  };

  return new Proxy(methods, {
    get(target, prop) {
      if (prop === 'length') return Object.keys(store).length;
      if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop];
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(store, prop)) return store[prop];
      return undefined;
    },
    set(target, prop, value) {
      if (typeof prop === 'string' && !Object.prototype.hasOwnProperty.call(target, prop) && prop !== 'length') {
        methods.setItem(prop, value);
        return true;
      }
      return false;
    },
    deleteProperty(target, prop) {
      if (typeof prop === 'string' && !Object.prototype.hasOwnProperty.call(target, prop)) {
        methods.removeItem(prop);
      }
      return true;
    },
    has(target, prop) {
      return Object.prototype.hasOwnProperty.call(target, prop) ||
        (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(store, prop));
    },
    ownKeys() {
      return Object.keys(store);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(store, prop)) {
        return { enumerable: true, configurable: true, writable: true, value: store[prop] };
      }
      return undefined;
    },
  });
}

function createPersistentStorage(filePath, opts) {
  return createStorage(filePath, opts);
}

function createMemoryStorage() {
  return createStorage(null);
}

function unescapeXml(s) {
  if (!s || s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, ent) => {
    if (ent === 'amp') return '&';
    if (ent === 'lt') return '<';
    if (ent === 'gt') return '>';
    if (ent === 'quot') return '"';
    if (ent === 'apos') return "'";
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}

class XMLNode {
  constructor(nodeType, nodeName, nodeValue = null) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.nodeValue = nodeValue;
    this.parentNode = null;
    this.childNodes = [];
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get textContent() {
    if (this.nodeType === 3 || this.nodeType === 4) return this.nodeValue || '';
    let out = '';
    for (const c of this.childNodes) out += c.textContent;
    return out;
  }
  set textContent(v) {
    this.childNodes = v ? [new XMLNode(3, '#text', String(v))] : [];
    if (this.childNodes[0]) this.childNodes[0].parentNode = this;
  }
  appendChild(child) {
    if (child) { child.parentNode = this; this.childNodes.push(child); }
    return child;
  }
}

function matchSelector(el, sel) {
  const s = sel.trim();
  if (!s) return false;
  if (s === '*') return true;
  if (s.startsWith('#')) return el.getAttribute('id') === s.slice(1);
  if (s.startsWith('.')) {
    const cls = el.getAttribute('class') || '';
    return cls.split(/\s+/).includes(s.slice(1));
  }
  const attrM = s.match(/^([A-Za-z0-9_:-]+)?\[([A-Za-z0-9_:-]+)(?:=["']?([^"'\]]*)["']?)?\]$/);
  if (attrM) {
    if (attrM[1] && el.tagName !== attrM[1]) return false;
    if (!el.hasAttribute(attrM[2])) return false;
    return attrM[3] === undefined || el.getAttribute(attrM[2]) === attrM[3];
  }
  return el.tagName === s;
}

class XMLElement extends XMLNode {
  constructor(tagName, attrs = Object.create(null)) {
    super(1, tagName, null);
    this.tagName = tagName;
    this._attrs = attrs;
  }
  get attributes() {
    return Object.keys(this._attrs).map((name) => ({ name, value: this._attrs[name] }));
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
  }
  setAttribute(name, val) { this._attrs[String(name)] = String(val); }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name); }
  getElementsByTagName(name) {
    const out = [];
    const wild = name === '*';
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 1) {
          if (wild || c.tagName === name) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelectorAll(sel) {
    const parts = String(sel).trim().split(/\s+/);
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 1) {
          if (parts.length === 1) {
            if (matchSelector(c, parts[0])) out.push(c);
          } else if (matchSelector(c, parts[parts.length - 1])) {
            let p = c.parentNode;
            let idx = parts.length - 2;
            while (p && p.nodeType === 1 && idx >= 0) {
              if (matchSelector(p, parts[idx])) idx--;
              p = p.parentNode;
            }
            if (idx < 0) out.push(c);
          }
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

class XMLDocument extends XMLNode {
  constructor() {
    super(9, '#document', null);
    this.documentElement = null;
  }
  createElement(tag) { return new XMLElement(String(tag)); }
  getElementsByTagName(name) {
    if (!this.documentElement) return [];
    const res = [];
    if (name === '*' || this.documentElement.tagName === name) res.push(this.documentElement);
    return res.concat(this.documentElement.getElementsByTagName(name));
  }
  getElementById(id) { return this.querySelector('#' + id); }
  querySelectorAll(sel) {
    if (!this.documentElement) return [];
    const res = [];
    if (matchSelector(this.documentElement, sel)) res.push(this.documentElement);
    return res.concat(this.documentElement.querySelectorAll(sel));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function parseXmlString(src) {
  const doc = new XMLDocument();
  const s = String(src || '');
  const stack = [doc];
  let i = 0;
  const n = s.length;

  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) {
      const txt = unescapeXml(s.slice(i));
      if (txt && stack.length > 1) stack[stack.length - 1].appendChild(new XMLNode(3, '#text', txt));
      break;
    }
    if (lt > i) {
      const txt = unescapeXml(s.slice(i, lt));
      if (txt && stack.length > 1) stack[stack.length - 1].appendChild(new XMLNode(3, '#text', txt));
    }
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const end = s.indexOf(']]>', lt + 9);
      const val = end < 0 ? s.slice(lt + 9) : s.slice(lt + 9, end);
      if (stack.length > 1) stack[stack.length - 1].appendChild(new XMLNode(4, '#cdata-section', val));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (s.startsWith('<?', lt)) {
      const end = s.indexOf('?>', lt + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (s.startsWith('<!', lt)) {
      const end = s.indexOf('>', lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const gt = s.indexOf('>', lt + 1);
    if (gt < 0) break;
    const raw = s.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (!raw) continue;
    if (raw[0] === '/') {
      const closeTag = raw.slice(1).trim();
      while (stack.length > 1) {
        const top = stack.pop();
        if (top.tagName === closeTag) break;
      }
      continue;
    }
    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1).trim() : raw;
    const sp = body.search(/[\s/]/);
    const tagName = sp < 0 ? body : body.slice(0, sp);
    const attrStr = sp < 0 ? '' : body.slice(sp + 1);
    const attrs = Object.create(null);
    const attrRe = /([A-Za-z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = attrRe.exec(attrStr)) !== null) {
      attrs[m[1]] = unescapeXml(m[2] !== undefined ? m[2] : m[3]);
    }
    const el = new XMLElement(tagName, attrs);
    const parent = stack[stack.length - 1];
    parent.appendChild(el);
    if (parent === doc && !doc.documentElement) doc.documentElement = el;
    if (!selfClose) stack.push(el);
  }
  return doc;
}

class DOMParser {
  parseFromString(str) {
    return parseXmlString(str);
  }
}

const WORKER_BOOTSTRAP = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const listeners = new Map();
globalThis.self = globalThis;
globalThis.postMessage = (data, transfer) => {
  try { parentPort.postMessage(data, transfer); } catch (_) { parentPort.postMessage(data); }
};
globalThis.close = () => { process.exit(0); };
globalThis.addEventListener = (type, fn) => {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
};
globalThis.removeEventListener = (type, fn) => {
  const s = listeners.get(type); if (s) s.delete(fn);
};
globalThis.importScripts = (...urls) => {
  for (const u of urls) {
    const p = path.isAbsolute(u) ? u : path.resolve(workerData.scriptDir, u);
    const code = fs.readFileSync(p, 'utf8');
    vm.runInThisContext(code, { filename: p });
  }
};
parentPort.on('message', (data) => {
  const ev = { data };
  if (typeof globalThis.onmessage === 'function') globalThis.onmessage(ev);
  const s = listeners.get('message');
  if (s) for (const fn of s) fn(ev);
});
try {
  vm.runInThisContext(workerData.code, { filename: workerData.filename });
} catch (err) {
  if (typeof globalThis.onerror === 'function') globalThis.onerror(err);
  throw err;
}
`;

function createWorkerClass(opts = {}) {
  const baseDir = opts.baseDir || process.cwd();
  const maxWorkers = Math.max(1, Number(opts.maxWorkers || (typeof process !== 'undefined' && process && process.env && process.env.PMZ_MAX_WORKERS) || 2) || 2);
  const blobUrls = opts.blobUrls || null;
  const active = new Set();
  const queue = [];

  function resolveCode(url) {
    const s = String(url);
    if (s.startsWith('blob:') && blobUrls && blobUrls.has(s)) {
      const b = blobUrls.get(s);
      const buf = b && (b._data || b._buf);
      return { code: buf ? Buffer.from(buf).toString('utf8') : String(b || ''), filename: s, scriptDir: baseDir };
    }
    if (s.startsWith('data:')) {
      const comma = s.indexOf(',');
      const meta = s.slice(5, comma);
      const body = s.slice(comma + 1);
      const code = meta.includes(';base64') ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body);
      return { code, filename: 'data-worker.js', scriptDir: baseDir };
    }
    let filePath = s;
    if (s.startsWith('file://')) {
      try { filePath = new URL(s).pathname; } catch (_) {}
      if (typeof process !== 'undefined' && process && process.platform === 'win32' && /^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1);
    } else if (!path.isAbsolute(s)) {
      filePath = path.resolve(baseDir, s);
    }
    return { code: fs.readFileSync(filePath, 'utf8'), filename: filePath, scriptDir: path.dirname(filePath) };
  }

  function pump() {
    while (active.size < maxWorkers && queue.length > 0) {
      const w = queue.shift();
      if (!w._terminated) w._start();
    }
  }

  class PMZWorker {
    constructor(url) {
      this._url = url;
      this._terminated = false;
      this._pending = [];
      this._nw = null;
      this._listeners = new Map();
      this.onmessage = null;
      this.onerror = null;
      this._resolved = resolveCode(url);
      if (active.size < maxWorkers) {
        this._start();
      } else {
        queue.push(this);
      }
    }
    _start() {
      if (this._terminated) return;
      const nw = new NodeWorker(WORKER_BOOTSTRAP, {
        eval: true,
        workerData: this._resolved,
      });
      this._nw = nw;
      active.add(this);
      nw.on('message', (data) => {
        const ev = { data };
        if (typeof this.onmessage === 'function') this.onmessage(ev);
        const s = this._listeners.get('message');
        if (s) for (const fn of s) fn(ev);
      });
      nw.on('error', (err) => {
        if (typeof this.onerror === 'function') this.onerror(err);
        const s = this._listeners.get('error');
        if (s) for (const fn of s) fn(err);
      });
      nw.on('exit', () => {
        active.delete(this);
        this._nw = null;
        pump();
      });
      while (this._pending.length > 0) {
        const [data, transfer] = this._pending.shift();
        try { nw.postMessage(data, transfer); } catch (_) { nw.postMessage(data); }
      }
    }
    postMessage(data, transfer) {
      if (this._terminated) return;
      if (this._nw) {
        try { this._nw.postMessage(data, transfer); } catch (_) { this._nw.postMessage(data); }
      } else {
        this._pending.push([data, transfer]);
      }
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) {
      const s = this._listeners.get(type); if (s) s.delete(fn);
    }
    terminate() {
      if (this._terminated) return Promise.resolve(0);
      this._terminated = true;
      this._pending.length = 0;
      const idx = queue.indexOf(this);
      if (idx >= 0) queue.splice(idx, 1);
      if (this._nw) {
        const nw = this._nw;
        this._nw = null;
        active.delete(this);
        pump();
        return nw.terminate();
      }
      return Promise.resolve(0);
    }
  }

  PMZWorker.terminateAll = () => {
    const jobs = [];
    for (const w of Array.from(queue)) jobs.push(w.terminate());
    for (const w of Array.from(active)) jobs.push(w.terminate());
    return Promise.all(jobs);
  };
  PMZWorker._stats = () => ({ active: active.size, queued: queue.length, maxWorkers });
  return PMZWorker;
}

module.exports = {
  createPersistentStorage,
  createMemoryStorage,
  XMLDocument,
  DOMParser,
  createWorkerClass,
};
