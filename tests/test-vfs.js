'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createVfs, transformPluginsJs } = require('../beta/pmzrt/vfs.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pmz-vfs-test-'));
try {
  const gameDir = path.join(tmp, 'game');
  const srcDir = path.join(tmp, 'src');
  const patchesDir = path.join(tmp, 'patches');

  fs.mkdirSync(path.join(gameDir, 'pmz-cache'), { recursive: true });
  fs.mkdirSync(path.join(srcDir, 'js', 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(srcDir, 'img', 'Pictures'), { recursive: true });
  fs.mkdirSync(patchesDir, { recursive: true });

  // Original plugins.js includes stale PocketMZ_Old + GKD_Old + game plugin
  fs.writeFileSync(path.join(srcDir, 'js', 'plugins.js'),
    'var $plugins = [\n' +
    '  {"name":"GamePlugin","status":true,"description":"","parameters":{}},\n' +
    '  {"name":"PocketMZ_Old","status":true,"description":"","parameters":{}},\n' +
    '  {"name":"GKD_Old","status":true,"description":"","parameters":{}}\n' +
    '];\n', 'utf8');
  fs.writeFileSync(path.join(srcDir, 'js', 'plugins', 'MyCustomPlugin.js'), '// custom', 'utf8');
  fs.writeFileSync(path.join(srcDir, 'img', 'Pictures', 'HERO.PNG'), 'src-hero', 'utf8');

  // Patches dir
  fs.writeFileSync(path.join(patchesDir, 'PocketMZ_Handheld.js'), '// handheld', 'utf8');
  fs.writeFileSync(path.join(patchesDir, 'PocketMZ_Menu.js'), '// menu', 'utf8');
  fs.writeFileSync(path.join(patchesDir, 'PocketMZ_Debug.js'), '// debug', 'utf8');
  fs.writeFileSync(path.join(patchesDir, 'params.json'),
    JSON.stringify({ _comment: 'ignore', PocketMZ_Handheld: { fps: '30' } }), 'utf8');

  // 1. Test transformPluginsJs
  const outJs = transformPluginsJs(
    fs.readFileSync(path.join(srcDir, 'js', 'plugins.js'), 'utf8'),
    patchesDir,
    ['PocketMZ_Handheld', 'PocketMZ_Menu'],
    fs
  );
  assert.ok(!outJs.includes('PocketMZ_Old') && !outJs.includes('GKD_Old'), 'old patches stripped');
  assert.ok(!outJs.includes('PocketMZ_Debug'), 'debug excluded unless requested');
  assert.ok(outJs.includes('"name":"GamePlugin"'), 'game plugin preserved');
  assert.ok(outJs.includes('"name":"PocketMZ_Handheld"') && outJs.includes('"fps":"30"'), 'params.json applied');
  assert.ok(outJs.indexOf('PocketMZ_Handheld') < outJs.indexOf('PocketMZ_Menu'), 'sorted order');

  // 2. Test 3-layer VFS resolution
  const vfs = createVfs({
    gameDir,
    srcDir,
    patchesDir,
    keepPatches: ['PocketMZ_Handheld', 'PocketMZ_Menu'],
    fsMod: fs,
  });

  // Layer 0: virtual plugins.js + PocketMZ_*.js
  assert.strictEqual(vfs.isVirtualPluginsJs(path.join(gameDir, 'js', 'plugins.js')), true);
  const virtPjs = vfs.readFileSync(path.join(gameDir, 'js', 'plugins.js'), 'utf8');
  assert.ok(virtPjs.includes('PocketMZ_Handheld') && virtPjs.includes('PocketMZ_Menu'));
  assert.strictEqual(vfs.readFileSync(path.join(gameDir, 'js', 'plugins', 'PocketMZ_Handheld.js'), 'utf8'), '// handheld');

  // Layer 2: case-insensitive srcDir lookup
  assert.strictEqual(vfs.existsSync(path.join(gameDir, 'img', 'pictures', 'hero.png')), true);
  assert.strictEqual(vfs.readFileSync(path.join(gameDir, 'img', 'pictures', 'hero.png'), 'utf8'), 'src-hero');
  assert.strictEqual(vfs.readFileSync(path.join(gameDir, 'js', 'plugins', 'mycustomplugin.js'), 'utf8'), '// custom');

  // Layer 1 overrides Layer 2
  fs.mkdirSync(path.join(gameDir, 'img', 'pictures'), { recursive: true });
  fs.writeFileSync(path.join(gameDir, 'img', 'pictures', 'hero.png'), 'game-override', 'utf8');
  assert.strictEqual(vfs.readFileSync(path.join(gameDir, 'img', 'pictures', 'hero.png'), 'utf8'), 'game-override');

  // 3. Test fsProxy: merged readdirSync, IMG_CACHE lstatSync, and EROFS on srcDir
  const vfsFs = vfs.createFsProxy();
  const pluginList = vfsFs.readdirSync(path.join(gameDir, 'js', 'plugins'));
  assert.ok(pluginList.includes('MyCustomPlugin.js'), 'src plugin in readdir');
  assert.ok(pluginList.includes('PocketMZ_Handheld.js'), 'virtual patch in readdir');

  assert.strictEqual(vfsFs.lstatSync(gameDir).isDirectory(), true);
  assert.strictEqual(vfsFs.lstatSync(path.join(gameDir, 'pmz-cache')).isDirectory(), true);

  // Writes to gameDir work
  vfsFs.writeFileSync(path.join(gameDir, 'pocketmz.json'), '{"smooth":true}', 'utf8');
  assert.strictEqual(vfsFs.readFileSync(path.join(gameDir, 'pocketmz.json'), 'utf8'), '{"smooth":true}');

  // Writes to srcDir throw EROFS
  assert.throws(
    () => vfsFs.writeFileSync(path.join(srcDir, 'js', 'evil.txt'), 'nope', 'utf8'),
    err => err && err.code === 'EROFS'
  );
  assert.throws(
    () => vfsFs.mkdirSync(path.join(srcDir, 'newdir')),
    err => err && err.code === 'EROFS'
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('test-vfs ok');
