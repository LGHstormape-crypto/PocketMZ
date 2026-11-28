#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');

function walk(dir, filterFn, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const rel = path.relative(REPO, full).replace(/\\/g, '/');
      if (rel === 'patches/src' || rel === 'beta/src') continue;
      walk(full, filterFn, out);
    }
    else if (filterFn(full, entry.name)) out.push(full);
  }
  return out;
}

function findPython() {
  const candidates = [process.env.PYTHON, 'python3', 'python'].filter(Boolean);
  for (const cmd of candidates) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore' });
      return cmd;
    } catch (_) {}
  }
  throw new Error('python3/python not found in PATH');
}

function main() {
  // 0. Module assembly consistency check
  execFileSync(process.execPath, [path.join(REPO, 'tools', 'build-modules.js'), '--check'], { stdio: 'inherit' });

  // 1. LF check on all .sh files
  const shFiles = [];
  for (const sub of ['scripts', 'beta', 'tools', 'tests']) {
    walk(path.join(REPO, sub), (_, n) => n.endsWith('.sh'), shFiles);
  }
  for (const f of shFiles.sort()) {
    const raw = fs.readFileSync(f);
    if (raw.includes(Buffer.from('\r\n'))) {
      throw new Error('CRLF line ending found in ' + path.relative(REPO, f));
    }
  }
  console.log('[ci-fast] LF check OK (' + shFiles.length + ' .sh files)');

  // 2. node --check on all .js files in beta/, patches/, tests/
  const jsFiles = [];
  for (const sub of ['beta', 'patches', 'tests']) {
    walk(path.join(REPO, sub), (_, n) => n.endsWith('.js'), jsFiles);
  }
  for (const f of jsFiles.sort()) {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  }
  console.log('[ci-fast] node --check OK (' + jsFiles.length + ' .js files)');

  // 3. Pure-JS unit tests (beta/pmzrt/test-p*.js and tests/test-*.js)
  const unitTests = [
    ...walk(path.join(REPO, 'beta', 'pmzrt'), (_, n) => /^test-p\d+.*\.js$/.test(n)),
    ...walk(path.join(REPO, 'tests'), (_, n) => /^test-.*\.js$/.test(n)),
  ].sort();
  for (const t of unitTests) {
    execFileSync(process.execPath, [t], { stdio: 'inherit', cwd: path.dirname(t) });
  }
  console.log('[ci-fast] JS unit tests OK (' + unitTests.length + ' files)');

  // 4. Python py_compile + --selftest
  const py = findPython();
  const pyFiles = walk(path.join(REPO, 'scripts'), (_, n) => n.endsWith('.py'))
    .concat(walk(path.join(REPO, 'tools'), (_, n) => n.endsWith('.py')))
    .sort();
  execFileSync(py, ['-m', 'py_compile', ...pyFiles], { stdio: 'inherit' });
  console.log('[ci-fast] py_compile OK (' + pyFiles.length + ' .py files)');

  for (const st of ['scripts/pocketmz-cache-trim.py', 'scripts/pocketmz-launcher.py']) {
    execFileSync(py, [path.join(REPO, st), '--selftest'], { stdio: 'inherit' });
  }
  console.log('[ci-fast] Python selftests OK');
}

main();
