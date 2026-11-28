'use strict';

function parseMemInfo(text) {
  const mAvail = /MemAvailable:\s+(\d+)/.exec(text);
  const mSwap = /SwapFree:\s+(\d+)/.exec(text);
  return {
    memAvailableKB: mAvail ? Number(mAvail[1]) : null,
    swapFreeKB: mSwap ? Number(mSwap[1]) : null,
  };
}

function atomicWriteFileSync(fsMod, filePath, data, encoding) {
  const tmp = filePath + '.pmz.tmp';
  try {
    fsMod.writeFileSync(tmp, data, encoding);
    fsMod.renameSync(tmp, filePath);
  } catch (err) {
    try {
      if (fsMod.existsSync(tmp)) fsMod.unlinkSync(tmp);
    } catch (_) {}
    throw err;
  }
}

function createMemGuard(opts) {
  const softMB = opts.softMB !== undefined ? Number(opts.softMB) : 160;
  const hardMB = opts.hardMB !== undefined ? Number(opts.hardMB) : 120;
  const swapHardMB = opts.swapHardMB !== undefined ? Number(opts.swapHardMB) : 120;
  const critMB = opts.critMB !== undefined ? Number(opts.critMB) : 80;
  const hardStreak = opts.hardStreak !== undefined ? Math.max(1, Number(opts.hardStreak)) : 3;
  const shrinkCooldownMs = opts.shrinkCooldownMs !== undefined ? Number(opts.shrinkCooldownMs) : 8000;
  const saveGraceMs = opts.saveGraceMs !== undefined ? Number(opts.saveGraceMs) : 3000;
  const now = opts.now || (() => Date.now());
  const readMemInfo = opts.readMemInfo;
  const onShrink = opts.onShrink || (() => {});
  const getPendingSaves = opts.getPendingSaves || (() => 0);
  const onTerminate = opts.onTerminate || (() => {});
  const log = opts.log || (() => {});

  let lastShrinkAt = -Infinity;
  let streak = 0;
  let graceStartAt = null;
  let terminated = false;

  function tick() {
    if (terminated) return 'terminated';
    const info = readMemInfo();
    if (!info || info.memAvailableKB === null) return 'unknown';
    const availMB = info.memAvailableKB / 1024;
    const swapMB = info.swapFreeKB === null ? Infinity : info.swapFreeKB / 1024;
    const t = now();

    if (availMB < softMB && (t - lastShrinkAt) >= shrinkCooldownMs) {
      lastShrinkAt = t;
      try {
        onShrink({ availMB, swapMB, info });
      } catch (e) {
        log('MEMGUARD shrink error:', e && e.message);
      }
    }

    const isHard = availMB < critMB || (availMB < hardMB && swapMB < swapHardMB);
    if (!isHard) {
      streak = 0;
      graceStartAt = null;
      return availMB < softMB ? 'soft' : 'ok';
    }

    streak += 1;
    if (streak < hardStreak) return 'warn';

    const pending = Number(getPendingSaves()) || 0;
    if (pending > 0) {
      if (graceStartAt === null) {
        graceStartAt = t;
        log('MEMGUARD: low memory with ' + pending + ' save(s) in flight, delaying exit');
      }
      if ((t - graceStartAt) < saveGraceMs) return 'grace';
    }

    terminated = true;
    onTerminate({ availMB, swapMB, streak, pending, info });
    return 'terminated';
  }

  return {
    tick,
    getState() {
      return { streak, graceStartAt, terminated, lastShrinkAt };
    },
  };
}

module.exports = { parseMemInfo, atomicWriteFileSync, createMemGuard };
