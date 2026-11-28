'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');

function testGenericIme() {
  const code = fs.readFileSync(path.join(REPO, 'patches/src/fixes/16-generic-ime.js'), 'utf8');
  let pushed = null, popped = 0;
  function Scene_Name() { this._editWindow = { name: () => 'Hero' }; }
  Scene_Name.prototype.create = function () {};
  Scene_Name.prototype.onInputOk = function () {};
  Scene_Name.prototype.terminate = function () {};
  const ctx = {
    window: null,
    process: { env: {} },
    SceneManager: {
      _scene: null,
      push(s) { pushed = new s(); this._scene = pushed; pushed.create(); },
      prepareNextScene() {},
    },
    Scene_Name,
    $gameActors: { actor: () => null },
    Graphics: { boxHeight: 400 },
    Window_NameEdit: { prototype: { initialize() {}, windowHeight: () => 100, faceWidth: () => 144, standardPadding: () => 18, lineHeight: () => 36, itemRect: () => ({ x: 0, y: 0, width: 32, height: 32 }), contentsHeight: () => 44, refresh() {} } },
    Window_NameInput: { prototype: { initialize() {}, standardPadding: () => 18, standardFontSize: () => 28, lineHeight: () => 36, refresh() {}, updateCursor() {} } },
  };
  ctx.window = ctx;
  Scene_Name.prototype.popScene = () => { popped++; ctx.SceneManager._scene = null; };
  vm.runInNewContext(code, ctx);
  assert.strictEqual(typeof ctx.window.__pmzOpenIme, 'function');

  const events = [];
  let blurred = 0;
  const inputEl = {
    value: 'Old',
    maxLength: 10,
    dispatchEvent(ev) { events.push(ev.type); },
    blur() { blurred++; },
  };
  assert.strictEqual(ctx.window.__pmzOpenIme(inputEl), true);
  assert.ok(pushed);
  pushed.onInputOk();
  assert.strictEqual(inputEl.value, 'Hero');
  assert.deepStrictEqual(events, ['input', 'change', 'keydown']);
  assert.strictEqual(popped, 1);
  assert.strictEqual(blurred, 1);

  // Cancel flow
  pushed = null; blurred = 0;
  assert.strictEqual(ctx.window.__pmzOpenIme(inputEl), true);
  pushed.terminate();
  assert.strictEqual(blurred, 1);
}

function testOverlayDom() {
  const overlayMod = require(path.join(REPO, 'beta/overlay.js'));
  const drawnImages = [];
  const drawnTexts = [];
  const fakeCtx = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: '', textBaseline: '', globalAlpha: 1,
    beginPath() {}, roundRect() {}, fill() {}, stroke() {}, rect() {}, clip() {},
    save() {}, restore() {}, translate() {}, moveTo() {}, lineTo() {}, closePath() {},
    clearRect() {}, fillRect() {},
    measureText: (t) => ({ width: String(t).length * 8 }),
    fillText(t) { drawnTexts.push(String(t)); },
    drawImage(el, x, y, w, h) { drawnImages.push({ el, x, y, w, h }); },
  };
  function makeEl(tag) {
    return {
      tagName: tag.toUpperCase(),
      style: {},
      children: [],
      textContent: '',
      hidden: false,
      _ls: {},
      addEventListener(t, f) { (this._ls[t] || (this._ls[t] = [])).push(f); },
      click() { for (const f of this._ls.click || []) f({ target: this }); },
      getContext: () => fakeCtx,
    };
  }
  const body = makeEl('body');
  const doc = {
    body,
    createElement: (t) => makeEl(t),
  };
  const ov = overlayMod.create({ doc });

  const div = makeEl('div');
  div.style.cssText = 'position:fixed;left:10px;top:20px;width:120px;height:40px;opacity:0.5;z-index:1';
  const span = makeEl('span');
  span.textContent = 'HUD';
  div.children.push(span);

  const img = makeEl('img');
  img.style.position = 'absolute';
  img.style.left = '30px';
  img.style.top = '40px';
  img.complete = true;
  img.naturalWidth = 64;
  img.naturalHeight = 32;
  img.width = 64;
  img.height = 32;

  let clicked = 0;
  const btn = makeEl('button');
  btn.style.cssText = 'position:fixed;right:10px;bottom:10px;width:80px;height:30px;z-index:5';
  btn.textContent = 'OK';
  btn.addEventListener('click', () => { clicked++; });

  const hiddenDiv = makeEl('div');
  hiddenDiv.style.cssText = 'position:fixed;left:0;top:0;display:none';
  hiddenDiv.textContent = 'HIDDEN';

  body.children.push(div, img, btn, hiddenDiv);
  assert.strictEqual(ov.update(), 'draw');
  assert.ok(drawnTexts.includes('HUD'));
  assert.ok(drawnTexts.includes('OK'));
  assert.ok(!drawnTexts.includes('HIDDEN'));
  assert.strictEqual(drawnImages.length, 1);
  assert.strictEqual(ov.hitTargets.length, 1);
  ov.hitTargets[0].el.click();
  assert.strictEqual(clicked, 1);
}

function testMvMenuBackupAndToggles() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-menu-'));
  try {
    const saveDir = path.join(tmp, 'save');
    const bkDir = path.join(tmp, 'save-backups');
    fs.mkdirSync(saveDir, { recursive: true });
    fs.mkdirSync(path.join(bkDir, '20261128-120000'), { recursive: true });
    fs.writeFileSync(path.join(saveDir, 'file1.rpgsave'), 'current-save', 'utf8');
    fs.writeFileSync(path.join(bkDir, '20261128-120000', 'file1.rpgsave'), 'backup-save', 'utf8');

    const listeners = {};
    let gotoScene = null;
    let shaderApplied = null;
    function mkEl(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        style: {},
        children: [],
        textContent: '',
        className: '',
        hidden: false,
        id: '',
        get firstChild() { return this.children[0] || null; },
        appendChild(c) { this.children.push(c); return c; },
        remove() {},
        querySelector() { return null; },
      };
    }
    const ctx = {
      require,
      console,
      setTimeout,
      clearTimeout,
      setInterval: () => 0,
      clearInterval() {},
      process: { env: { POCKETMZ_UI_LANG: 'zh_CN' }, mainModule: { filename: path.join(tmp, 'www', 'index.html') } },
      nw: { __dirname: tmp, App: { quit() {} } },
      Utils: { RPGMAKER_NAME: 'MV' },
      ConfigManager: { gkdFrameRate: 30, save() {} },
      StorageManager: { localFileDirectoryPath: () => saveDir },
      DataManager: {},
      Scene_Title: function Scene_Title() {},
      SceneManager: {
        updateScene() {},
        updateInputData() {},
        goto(s) { gotoScene = s; },
      },
      Input: { clear() {} },
      PMZ_applyShader(m) { shaderApplied = m; },
      document: {
        head: mkEl('head'),
        body: mkEl('body'),
        createElement: mkEl,
      },
      navigator: {},
      addEventListener(t, f) { (listeners[t] || (listeners[t] = [])).push(f); },
      window: null,
    };
    ctx.window = ctx;
    const menuCode = fs.readFileSync(path.join(REPO, 'patches/PocketMZ_Menu.js'), 'utf8');
    vm.runInNewContext(menuCode, ctx);

    const sendKey = (k) => {
      const ev = { type: 'keydown', key: k, preventDefault() {}, stopImmediatePropagation() {} };
      for (const fn of listeners.keydown || []) fn(ev);
    };
    ctx.window.PMZ_MENU.command('menu');
    assert.strictEqual(ctx.window.PMZ_MENU.state().open, true);

    // Navigate to shader (index 8) and toggle to sharp, then compatMode (index 9)
    for (let i = 0; i < 8; i++) sendKey('ArrowDown');
    sendKey('ArrowRight');
    assert.strictEqual(shaderApplied, 'sharp');
    sendKey('ArrowDown');
    sendKey('Enter');
    const pj = JSON.parse(fs.readFileSync(path.join(tmp, 'pocketmz.json'), 'utf8'));
    assert.strictEqual(pj.shader, 'sharp');
    assert.strictEqual(pj.compatMode, true);

    // Navigate to backups (index 12) -> select first backup -> confirm restore
    for (let i = 0; i < 4; i++) sendKey('ArrowDown');
    sendKey('Enter'); // backups page
    sendKey('Enter'); // askRestore page
    sendKey('ArrowDown'); // yes
    sendKey('Enter'); // restore
    sendKey('Enter'); // msg ok -> Scene_Title
    assert.strictEqual(fs.readFileSync(path.join(saveDir, 'file1.rpgsave'), 'utf8'), 'backup-save');
    assert.strictEqual(gotoScene, ctx.Scene_Title);
    const bks = fs.readdirSync(bkDir);
    assert.ok(bks.some((d) => d.endsWith('-before-restore')), 'before-restore backup created');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function testPostProcAndCompat() {
  const postproc = require(path.join(REPO, 'beta/pmzrt/postproc.js'));
  for (const m of ['sharp', 'lcd', 'crt', 'cas']) {
    const src = postproc.fragmentSource(m);
    assert.ok(src && src.includes('precision mediump float'), 'valid glsl ' + m);
  }
  const counts = { fbo: 0, tex: 0, rb: 0, prog: 0, sh: 0, buf: 0, draws: 0 };
  const mockPmz = {
    createFramebuffer: () => ++counts.fbo,
    deleteFramebuffer: () => counts.fbo--,
    createTexture: () => ++counts.tex,
    deleteTexture: () => counts.tex--,
    createRenderbuffer: () => ++counts.rb,
    deleteRenderbuffer: () => counts.rb--,
    createProgram: () => ++counts.prog,
    deleteProgram: () => counts.prog--,
    createShader: () => ++counts.sh,
    deleteShader: () => counts.sh--,
    createBuffer: () => ++counts.buf,
    deleteBuffer: () => counts.buf--,
    bindFramebuffer() {}, bindTexture() {}, bindRenderbuffer() {}, bindBuffer() {},
    texParameteri() {}, texImage2D() {}, renderbufferStorage() {},
    framebufferTexture2D() {}, framebufferRenderbuffer() {},
    bufferData() {}, shaderSource() {}, compileShader() {},
    getShaderParameter: () => 1, getProgramParameter: () => 1,
    attachShader() {}, bindAttribLocation() {}, linkProgram() {},
    getUniformLocation: () => 1, getParameter: () => 0, isEnabled: () => false,
    enable() {}, disable() {}, activeTexture() {}, viewport() {}, clearColor() {}, clear() {},
    useProgram() {}, uniform1i() {}, uniform2f() {}, enableVertexAttribArray() {}, vertexAttribPointer() {},
    drawArrays() { counts.draws++; },
  };
  const mockGl = {
    canvas: { width: 640, height: 480 },
    _fb: null,
    _defaultFboId: 0,
    _map: (x, y, w, h) => [x, y, w, h],
    _applyViewport() {},
    _applyScissor() {},
  };
  const pp = postproc.create({ pmz: mockPmz, getGL: () => mockGl, getDrawable: () => ({ width: 640, height: 480 }) });
  assert.strictEqual(pp.active, false);
  assert.strictEqual(pp.beginFrame(), false);
  assert.strictEqual(counts.fbo, 0, 'zero overhead when off');

  pp.setMode('crt');
  assert.strictEqual(pp.beginFrame(), true);
  assert.strictEqual(mockGl._defaultFboId, 1);
  assert.strictEqual(pp.present(), true);
  assert.strictEqual(counts.draws, 1);
  pp.setMode('off');
  assert.strictEqual(mockGl._defaultFboId, 0);
  assert.strictEqual(counts.fbo, 0);
  assert.strictEqual(counts.tex, 0);
  assert.strictEqual(counts.rb, 0);
  assert.strictEqual(counts.prog, 0);

  // Compatibility mode flags
  const headerCode = fs.readFileSync(path.join(REPO, 'patches/src/handheld-mz/00-header.js'), 'utf8') + '\n})();';
  const compatCtx = {
    window: null,
    process: { env: { POCKETMZ_COMPAT_MODE: '1' } },
    Utils: { RPGMAKER_NAME: 'MZ' },
    Scene_Boot: { prototype: {} },
  };
  compatCtx.window = compatCtx;
  vm.runInNewContext(headerCode, compatCtx);
  assert.strictEqual(compatCtx.process.env.POCKETMZ_MAP_REFRESH_GUARD, 'off');
  assert.strictEqual(compatCtx.process.env.POCKETMZ_CLOSED_WIN_SKIP, 'off');
  assert.strictEqual(compatCtx.process.env.POCKETMZ_EMPTY_CHAR_SKIP, 'off');
  assert.strictEqual(compatCtx.process.env.POCKETMZ_WIN_SCALE, 'off');
}

testGenericIme();
testOverlayDom();
testMvMenuBackupAndToggles();
testPostProcAndCompat();
console.log('[test-p2-p22-p23] OK');
