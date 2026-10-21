import { constants as fsConstants, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export class ThreadBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThreadBusyError';
  }
}

/** A held lock's mtime is refreshed this often by its owner (heartbeat). */
const HEARTBEAT_MS = 30_000;
/** A lock whose mtime is older than this has lost its heartbeat (owner hung, crashed, or on another host). */
const STALE_MTIME_MS = 2 * 60 * 1000;
/** A lock file that cannot be parsed is considered abandoned mid-write after this long. */
const UNPARSABLE_GRACE_MS = 10_000;
/** A reclaim guard (held for milliseconds) older than this was left behind by a crashed reclaimer. */
const GUARD_STALE_MS = 10_000;

/** Timing knobs (tests only). */
export interface ThreadLockTimings {
  heartbeatMs?: number;
  staleMs?: number;
}

interface LockContent {
  pid: number;
  host: string;
  startedAt: string;
  token?: string;
}

function lockPath(codexHome: string, threadId: string): string {
  const safe = threadId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(codexHome, '.codex-claude-mcp', 'locks', `${safe}.lock`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function abortError(signal: AbortSignal): Error {
  const r = signal.reason;
  if (r instanceof Error) return r;
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal!));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const HELD_CODES = new Set(['EACCES', 'EPERM', 'EBUSY']);

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.stat(file);
    return true;
  } catch (e) {
    // ENOENT: really gone. Anything else (e.g. EPERM on a file pending deletion on Windows): it is there.
    return (e as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** Try to create the lock file exclusively. false = someone else holds it. */
async function tryCreate(file: string, content: LockContent): Promise<boolean> {
  let fh: import('node:fs/promises').FileHandle | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      fh = await fsp.open(file, 'wx');
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (code === 'EEXIST') return false;
      // EACCES/EPERM/EBUSY mean "held" only if a lock file is actually there (Windows reports them for a file
      // that is being deleted or renamed). Without a file it is a real permission problem: retry briefly, rethrow.
      if (!HELD_CODES.has(code)) throw e;
      if (await exists(file)) return false;
      if (attempt >= 2) throw e;
      await sleep(20);
    }
  }
  try {
    await fh.writeFile(JSON.stringify(content), 'utf8');
  } finally {
    await fh.close();
  }
  return true;
}

interface Snapshot {
  raw: string;
  ino: bigint;
}

async function snapshot(file: string): Promise<Snapshot & { mtimeMs: number }> {
  const st = await fsp.stat(file, { bigint: true });
  const raw = await fsp.readFile(file, 'utf8');
  return { raw, ino: st.ino, mtimeMs: Number(st.mtimeMs) };
}

function isStale(snap: { raw: string; mtimeMs: number }, staleMs: number): boolean {
  const age = Date.now() - snap.mtimeMs;
  if (age > staleMs) return true; // heartbeat lost
  let info: Partial<LockContent> | undefined;
  try {
    info = JSON.parse(snap.raw) as Partial<LockContent>;
  } catch {
    info = undefined;
  }
  if (!info || typeof info.pid !== 'number') return age > UNPARSABLE_GRACE_MS;
  return info.host === os.hostname() && !pidAlive(info.pid);
}

/**
 * Short-lived mutex between reclaimers (`<lock>.reclaim`, held only while renaming a stale lock away). Without it a
 * reclaimer acting on an outdated "stale" snapshot could rename away a lock another reclaimer just created, and a
 * third caller could create a new lock in the gap before it is put back.
 */
async function acquireGuard(guard: string): Promise<boolean> {
  try {
    await (await fsp.open(guard, 'wx')).close();
    return true;
  } catch {
    try {
      const st = await fsp.stat(guard);
      if (Date.now() - st.mtimeMs > GUARD_STALE_MS) await fsp.rm(guard, { force: true });
    } catch {
      /* gone already */
    }
    return false;
  }
}

/**
 * Remove the lock if it is stale. Returns true if it was removed (or vanished) so the caller should retry 'wx'.
 *
 * Atomic: the stale file is renamed to a unique name (only one rename can win), under a reclaim guard and after
 * re-checking staleness. The winner then verifies it took the file it judged stale; if a fresh lock was swapped in
 * meanwhile (its owner released and someone re-acquired), it puts that back only if the lock path is still free,
 * else drops its copy, and reports "not reclaimed".
 */
async function reclaimIfStale(file: string, staleMs: number): Promise<boolean> {
  let snap: Snapshot & { mtimeMs: number };
  try {
    snap = await snapshot(file);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT';
  }
  if (!isStale(snap, staleMs)) return false;

  const guard = `${file}.reclaim`;
  if (!(await acquireGuard(guard))) return false; // someone else is reclaiming; poll again
  try {
    // Re-check under the guard: an earlier reclaimer may already have replaced the stale lock.
    try {
      snap = await snapshot(file);
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT';
    }
    if (!isStale(snap, staleMs)) return false;

    const grave = `${file}.stale.${randomBytes(6).toString('hex')}`;
    try {
      await fsp.rename(file, grave);
    } catch (e) {
      // ENOENT: the owner released meanwhile: just retry. Anything else (e.g. Windows sharing error): later.
      return (e as NodeJS.ErrnoException).code === 'ENOENT';
    }

    let taken: Snapshot | undefined;
    try {
      taken = await snapshot(grave);
    } catch {
      taken = undefined;
    }
    if (taken && (taken.raw !== snap.raw || taken.ino !== snap.ino)) {
      await restore(grave, file);
      return false;
    }
    await fsp.rm(grave, { force: true }).catch(() => {});
    return true;
  } finally {
    await fsp.rm(guard, { force: true }).catch(() => {});
  }
}

/** Put a wrongly reclaimed lock back at `file` only if that path is free; otherwise drop our copy. */
async function restore(grave: string, file: string): Promise<void> {
  try {
    await fsp.link(grave, file); // fails with EEXIST if a new lock appeared
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      // No hard links on this filesystem: exclusive copy instead (still never overwrites).
      await fsp.copyFile(grave, file, fsConstants.COPYFILE_EXCL).catch(() => {});
    }
  }
  await fsp.rm(grave, { force: true }).catch(() => {});
}

async function readToken(file: string): Promise<string | undefined> {
  try {
    const info = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<LockContent>;
    return typeof info.token === 'string' ? info.token : undefined;
  } catch {
    return undefined;
  }
}

/** Refresh the lock's mtime while we own it, so waiters can tell a live lock from an abandoned one. */
function startHeartbeat(file: string, token: string, everyMs: number): () => void {
  let busy = false;
  const t = setInterval(() => {
    if (busy) return;
    busy = true;
    (async () => {
      if ((await readToken(file)) !== token) return; // not ours (any more): never keep someone else's lock alive
      const now = new Date();
      await fsp.utimes(file, now, now);
    })()
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  }, everyMs);
  t.unref?.();
  return () => clearInterval(t);
}

async function release(file: string, token: string): Promise<void> {
  try {
    if ((await readToken(file)) !== token) return;
    await fsp.unlink(file);
  } catch {
    /* already gone or not ours */
  }
}

/**
 * Run fn while holding a cross-process lock for (codexHome, threadId).
 * Waits up to timeoutMs for a lock held by someone else, then throws ThreadBusyError.
 */
export async function withThreadLock<T>(
  codexHome: string,
  threadId: string,
  timeoutMs: number,
  fn: () => Promise<T>,
  signal?: AbortSignal,
  timings: ThreadLockTimings = {},
): Promise<T> {
  const heartbeatMs = timings.heartbeatMs ?? HEARTBEAT_MS;
  const staleMs = timings.staleMs ?? STALE_MTIME_MS;
  const file = lockPath(codexHome, threadId);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const token = randomBytes(12).toString('hex');
  const content: LockContent = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), token };
  const start = Date.now();
  for (;;) {
    if (signal?.aborted) throw abortError(signal);
    content.startedAt = new Date().toISOString();
    if (await tryCreate(file, content)) break;
    if (await reclaimIfStale(file, staleMs)) continue;
    if (Date.now() - start >= timeoutMs) {
      const waited = Math.round((Date.now() - start) / 1000);
      throw new ThreadBusyError(
         `Claude session ${threadId} is busy (another follow-up is running on it); waited ${waited}s`,
      );
    }
    const remaining = timeoutMs - (Date.now() - start);
    await sleep(Math.max(10, Math.min(remaining, 200 + Math.floor(Math.random() * 100))), signal);
  }
  const stopHeartbeat = startHeartbeat(file, token, heartbeatMs);
  try {
    return await fn();
  } finally {
    stopHeartbeat();
    await release(file, token);
  }
}
