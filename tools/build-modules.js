#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

const TARGETS = [
  {
    out: 'patches/PocketMZ_Handheld.js',
    parts: [
      'patches/src/handheld-mz/00-header.js',
      'patches/src/common/viewport-stretch.js',
      'patches/src/handheld-mz/10-input-cache.js',
      'patches/src/handheld-mz/20-render-windows.js',
      'patches/src/handheld-mz/30-img-scale.js',
      'patches/src/common/gc-scheduler.js',
      'patches/src/common/se-cache.js',
      'patches/src/common/map-json-cache.js',
      'patches/src/handheld-mz/40-map-tilemap-audio.js',
      'patches/src/common/skip-branch.js',
      'patches/src/handheld-mz/50-loadimg-battle.js',
      'patches/src/handheld-mz/99-footer.js',
    ],
  },
  {
    out: 'patches/PocketMZ_HandheldMV.js',
    parts: [
      'patches/src/handheld-mv/00-header.js',
      'patches/src/common/viewport-stretch.js',
      'patches/src/handheld-mv/10-input-audio-fps.js',
      'patches/src/handheld-mv/20-img-scale.js',
      'patches/src/handheld-mv/30-windows-gc.js',
      'patches/src/common/gc-scheduler.js',
      'patches/src/common/se-cache.js',
      'patches/src/common/map-json-cache.js',
      'patches/src/handheld-mv/40-window-scale-tilemap.js',
      'patches/src/common/skip-branch.js',
      'patches/src/handheld-mv/50-reqimg-render.js',
      'patches/src/handheld-mv/99-footer.js',
    ],
  },
  {
    out: 'patches/PocketMZ_PluginFixes.js',
    parts: [
      'patches/src/fixes/00-header.js',
      'patches/src/fixes/01-picture-color-change.js',
      'patches/src/fixes/02-filter-selectable-items.js',
      'patches/src/fixes/03-artm-player-sensor.js',
      'patches/src/fixes/04-character-picture-manager.js',
      'patches/src/fixes/05-panda-resource-preload.js',
      'patches/src/fixes/06-apng-picture.js',
      'patches/src/fixes/07-nuun-state-icons.js',
      'patches/src/fixes/08-plugin-common-base.js',
      'patches/src/fixes/09-passive-skill.js',
      'patches/src/fixes/10-phantom-event.js',
      'patches/src/fixes/11-ll-variable-window.js',
      'patches/src/fixes/12-tm-name-pop.js',
      'patches/src/fixes/13-111-input-form.js',
      'patches/src/fixes/14-ftkr-ex-message-window2.js',
      'patches/src/fixes/15-dtext-picture.js',
      'patches/src/fixes/16-generic-ime.js',
      'patches/src/fixes/99-footer.js',
    ],
  },
  {
    out: 'beta/pmzrun.js',
    parts: [
      'beta/src/00-config-mem.js',
      'beta/src/10-window-loop-probe.js',
      'beta/src/20-dom-media.js',
      'beta/src/30-scripts-globals.js',
      'beta/src/40-input-mouse.js',
      'beta/src/50-lifecycle-tests.js',
    ],
  },
];

function assemble(parts) {
  const chunks = [];
  for (let i = 0; i < parts.length; i++) {
    const rel = parts[i];
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
    if (i > 0 && i < parts.length - 1) {
      chunks.push('// --- module: ' + rel + ' ---\n' + text);
    } else {
      chunks.push(text);
    }
  }
  return chunks.join('\n') + '\n';
}

function walkJs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p, out);
    else if (e.name.endsWith('.js')) out.push(path.relative(REPO, p).replace(/\\/g, '/'));
  }
  return out;
}

function main() {
  const check = process.argv.includes('--check');
  const referenced = new Set();
  let dirty = false;

  for (const t of TARGETS) {
    for (const p of t.parts) referenced.add(p);
    const built = assemble(t.parts);
    const outPath = path.join(REPO, t.out);
    if (check) {
      const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n') : '';
      if (current !== built) {
        console.error('[build-modules] MISMATCH: ' + t.out + ' is out of sync with module sources (run: node tools/build-modules.js)');
        dirty = true;
      } else {
        console.log('[build-modules] OK: ' + t.out + ' (' + t.parts.length + ' modules)');
      }
    } else {
      fs.writeFileSync(outPath, built, 'utf8');
      console.log('[build-modules] wrote ' + t.out + ' (' + t.parts.length + ' modules)');
    }
  }

  for (const srcRoot of ['patches/src', 'beta/src']) {
    for (const rel of walkJs(path.join(REPO, srcRoot))) {
      if (!referenced.has(rel)) {
        console.error('[build-modules] UNREFERENCED module: ' + rel);
        dirty = true;
      }
    }
  }

  if (dirty) process.exit(1);
}

main();
