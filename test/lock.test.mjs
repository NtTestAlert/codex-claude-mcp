import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withThreadLock, ThreadBusyError } from '../dist/lock.js';

const TID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const distLock = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'lock.js');

async function home() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'cc-codex-mcp-lock-'));
}
const lockFile = (h, id = TID) => path.join(h, '.codex-claude-mcp', 'locks', `${id}.lock`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('lock is created with pid/host/startedAt and released afterwards', async () => {
  const h = await home();
  const r = await withThreadLock(h, TID, 1000, async () => {
    const info = JSON.parse(fs.readFileSync(lockFile(h), 'utf8'));
    assert.equal(info.pid, process.pid);
    assert.equal(info.host, os.hostname());
    assert.ok(!Number.isNaN(Date.parse(info.startedAt)));
    return 42;
  });
  assert.equal(r, 42);
  assert.equal(fs.existsSync(lockFile(h)), false);
});

test('lock is released when fn throws', async () => {
  const h = await home();
  await assert.rejects(withThreadLock(h, TID, 1000, async () => { throw new Error('x'); }), /x/);
  assert.equal(fs.existsSync(lockFile(h)), false);
});

test('second caller waits for the first (serialised)', async () => {
  const h = await home();
  const order = [];
  const a = withThreadLock(h, TID, 5000, async () => {
    order.push('a-start');
    await sleep(600);
    order.push('a-end');
  });
  await sleep(50);
  const b = withThreadLock(h, TID, 5000, async () => {
    order.push('b-start');
  });
  await Promise.all([a, b]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start']);
});

test('ThreadBusyError after timeout; different threads do not block each other', async () => {
  const h = await home();
  let release;
  const held = withThreadLock(h, TID, 1000, () => new Promise((r) => (release = r)));
  await sleep(50);
  const other = await withThreadLock(h, '11111111-1111-1111-1111-111111111111', 500, async () => 'free');
  assert.equal(other, 'free');
  const t0 = Date.now();
  await assert.rejects(withThreadLock(h, TID, 700, async () => 'never'), (e) => {
    assert.ok(e instanceof ThreadBusyError);
    assert.match(e.message, new RegExp(`Claude session ${TID} is busy .*waited \\d+s`));
    return true;
  });
  assert.ok(Date.now() - t0 >= 650);
  release();
  await held;
});

test('stale lock from a dead pid on this host is reclaimed', async () => {
  const h = await home();
  // Spawn and wait for a process to exit so we have a pid that is (almost certainly) dead.
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = child.pid;
  await new Promise((r) => child.on('exit', r));
  fs.mkdirSync(path.dirname(lockFile(h)), { recursive: true });
  fs.writeFileSync(lockFile(h), JSON.stringify({ pid: deadPid, host: os.hostname(), startedAt: new Date().toISOString() }));
  const r = await withThreadLock(h, TID, 500, async () => 'ok');
  assert.equal(r, 'ok');
});

test('lock whose heartbeat stopped (mtime > 2 min) is reclaimed even if the pid is alive', async () => {
  const h = await home();
  fs.mkdirSync(path.dirname(lockFile(h)), { recursive: true });
  fs.writeFileSync(lockFile(h), JSON.stringify({ pid: process.pid, host: 'other-host', startedAt: 'x' }));
  const old = new Date(Date.now() - 3 * 60 * 1000);
  fs.utimesSync(lockFile(h), old, old);
  assert.equal(await withThreadLock(h, TID, 500, async () => 'ok'), 'ok');
  assert.equal(fs.existsSync(lockFile(h)), false);
  assert.deepEqual(fs.readdirSync(path.dirname(lockFile(h))), [], 'no .stale.* leftovers');
});

test('a recently touched lock from another host (live heartbeat) is respected', async () => {
  const h = await home();
  fs.mkdirSync(path.dirname(lockFile(h)), { recursive: true });
  fs.writeFileSync(lockFile(h), JSON.stringify({ pid: process.pid, host: 'other-host', startedAt: 'x' }));
  const recent = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(lockFile(h), recent, recent);
  await assert.rejects(withThreadLock(h, TID, 300, async () => 'x'), ThreadBusyError);
  assert.ok(fs.existsSync(lockFile(h)));
});

test('heartbeat: the owner keeps refreshing the lock mtime while held', async () => {
  const h = await home();
  await withThreadLock(
    h,
    TID,
    1000,
    async () => {
      const old = new Date(Date.now() - 10 * 60 * 1000);
      fs.utimesSync(lockFile(h), old, old);
      // poll (the suite runs files in parallel, so timers can be late under load)
      let age = Infinity;
      for (let i = 0; i < 50 && age >= 5_000; i++) {
        await sleep(100);
        age = Date.now() - fs.statSync(lockFile(h)).mtimeMs;
      }
      assert.ok(age < 5_000, `mtime should have been refreshed, age=${age}ms`);
    },
    undefined,
    { heartbeatMs: 100 },
  );
  assert.equal(fs.existsSync(lockFile(h)), false);
});

test('heartbeat never touches a lock that is no longer ours', async () => {
  const h = await home();
  await withThreadLock(
    h,
    TID,
    1000,
    async () => {
      // someone else replaced our lock file (e.g. reclaimed it while we were stalled)
      fs.writeFileSync(lockFile(h), JSON.stringify({ pid: 1, host: 'other-host', startedAt: 'x', token: 'theirs' }));
      const old = new Date(Date.now() - 10 * 60 * 1000);
      fs.utimesSync(lockFile(h), old, old);
      await sleep(400);
      const age = Date.now() - fs.statSync(lockFile(h)).mtimeMs;
      assert.ok(age > 5 * 60 * 1000, 'foreign lock mtime must not be refreshed');
    },
    undefined,
    { heartbeatMs: 100 },
  );
  assert.ok(fs.existsSync(lockFile(h)), 'release must not delete a lock that is not ours');
});

test('many concurrent waiters reclaiming one stale lock: still mutual exclusion', async () => {
  const h = await home();
  fs.mkdirSync(path.dirname(lockFile(h)), { recursive: true });
  fs.writeFileSync(lockFile(h), JSON.stringify({ pid: process.pid, host: 'other-host', startedAt: 'x' }));
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockFile(h), old, old);
  let active = 0;
  let maxActive = 0;
  let runs = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      withThreadLock(h, TID, 20_000, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(30);
        active--;
        runs++;
      }),
    ),
  );
  assert.equal(runs, 8);
  assert.equal(maxActive, 1);
  assert.equal(fs.existsSync(lockFile(h)), false);
  assert.deepEqual(fs.readdirSync(path.dirname(lockFile(h))), [], 'no .stale.* leftovers');
});

test('cross-process: concurrent reclaim of a stale lock admits exactly one holder at a time', async () => {
  const h = await home();
  fs.mkdirSync(path.dirname(lockFile(h)), { recursive: true });
  fs.writeFileSync(lockFile(h), JSON.stringify({ pid: process.pid, host: 'other-host', startedAt: 'x' }));
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockFile(h), old, old);
  const marker = path.join(h, 'inside');
  const script = `
    import fs from 'node:fs';
    import { withThreadLock } from ${JSON.stringify('file:///' + distLock.replace(/\\/g, '/'))};
    for (let i = 0; i < 3; i++) {
      await withThreadLock(${JSON.stringify(h)}, ${JSON.stringify(TID)}, 20000, async () => {
        fs.mkdirSync(${JSON.stringify(marker)}); // throws EEXIST if another holder is inside
        await new Promise((r) => setTimeout(r, 20));
        fs.rmdirSync(${JSON.stringify(marker)});
      });
    }
  `;
  const kids = Array.from({ length: 4 }, () =>
    spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] }),
  );
  const codes = await Promise.all(
    kids.map(
      (c) =>
        new Promise((resolve) => {
          let err = '';
          c.stderr.on('data', (d) => (err += d));
          c.on('exit', (code) => resolve({ code, err }));
        }),
    ),
  );
  for (const { code, err } of codes) assert.equal(code, 0, err);
});

test('EACCES from open without an existing lock file is rethrown, not treated as busy', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
  const h = await home();
  const dir = path.dirname(lockFile(h));
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o555);
  try {
    await assert.rejects(withThreadLock(h, TID, 2000, async () => 'x'), (e) => {
      assert.ok(!(e instanceof ThreadBusyError));
      assert.ok(['EACCES', 'EPERM'].includes(e.code), String(e.code));
      return true;
    });
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

test('a live lock on another host is respected', async () => {
  const h = await home();
  fs.mkdirSync(path.dirname(lockFile(h)), { recursive: true });
  fs.writeFileSync(lockFile(h), JSON.stringify({ pid: 999999, host: 'some-other-host', startedAt: new Date().toISOString() }));
  await assert.rejects(withThreadLock(h, TID, 400, async () => 'x'), ThreadBusyError);
  assert.ok(fs.existsSync(lockFile(h)), 'foreign lock must not be removed');
});

test('abort signal stops waiting', async () => {
  const h = await home();
  let release;
  const held = withThreadLock(h, TID, 1000, () => new Promise((r) => (release = r)));
  await sleep(50);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  await assert.rejects(withThreadLock(h, TID, 10_000, async () => 'x', ac.signal), (e) => !(e instanceof ThreadBusyError));
  release();
  await held;
});

test('cross-process: a lock held by another process blocks us', async () => {
  const h = await home();
  const script = `
    import { withThreadLock } from ${JSON.stringify('file:///' + distLock.replace(/\\/g, '/'))};
    await withThreadLock(${JSON.stringify(h)}, ${JSON.stringify(TID)}, 1000, async () => {
      process.stdout.write('held\\n');
      await new Promise((r) => setTimeout(r, 1500));
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => child.stdout.on('data', (d) => String(d).includes('held') && resolve()));
  await assert.rejects(withThreadLock(h, TID, 300, async () => 'x'), ThreadBusyError);
  // Once the other process releases, we get it.
  assert.equal(await withThreadLock(h, TID, 5000, async () => 'mine'), 'mine');
  await new Promise((r) => (child.exitCode !== null ? r() : child.on('exit', r)));
});
