import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// CSI sequences, OSC sequences (terminated by BEL or ST), and other 2-char ESC sequences.
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\u001b\u009b][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]|\u001b[@-Z\\-_]/g;

export function stripAnsi(s: string): string {
  if (!s) return s;
  return s.replace(ANSI_RE, '');
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** Last n lines of s (trailing newline ignored). */
export function tailLines(s: string, n: number): string {
  if (!s || n <= 0) return '';
  const lines = s.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

/** Cap s at max UTF-16 code units, never splitting a surrogate pair (the cut moves back one unit instead). */
export function capText(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  let end = Math.max(0, Math.floor(max));
  if (end > 0) {
    const c = s.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end--; // high surrogate whose low half would be cut off
  }
  return { text: s.slice(0, end), truncated: true };
}

function normPath(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/**
 * Best-effort canonical path: realpath of the deepest existing ancestor, with the non-existing remainder
 * appended. Follows symlinks/junctions even when the leaf does not exist yet.
 */
async function realish(p: string): Promise<string> {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await fsp.realpath(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * True when a and b name the same filesystem location: compared lexically (case-insensitive on win32) and,
 * when that differs, after resolving symlinks/junctions of the existing parts of both paths.
 */
export async function samePathOnDisk(a: string, b: string): Promise<boolean> {
  if (normPath(a) === normPath(b)) return true;
  const [ra, rb] = await Promise.all([realish(a), realish(b)]);
  return normPath(ra) === normPath(rb);
}

export function homeDir(): string {
  return os.homedir();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Write via a temp file in the same directory, then rename over the target (retrying transient Windows errors). */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  await fsp.writeFile(tmp, data, 'utf8');
  const retryable = new Set(['EPERM', 'EBUSY', 'EACCES']);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fsp.rename(tmp, filePath);
      return;
    } catch (e) {
      lastErr = e;
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!retryable.has(code)) break;
      await sleep(25 * (attempt + 1));
    }
  }
  await fsp.rm(tmp, { force: true }).catch(() => {});
  throw lastErr;
}
