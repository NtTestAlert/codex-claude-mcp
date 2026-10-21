import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isUuid, writeFileAtomic } from './util.js';

export interface SessionInfo {
  session_id: string;
  cwd: string;
  permission_mode: string;
  model?: string;
  effort?: string;
  created_at: string;
}

function sessionPath(home: string, id: string): string {
  if (!isUuid(id)) throw new Error('Invalid Claude session ID: expected a UUID.');
  return path.join(home, '.codex-claude-mcp', 'sessions', `${id.toLowerCase()}.json`);
}

function validate(value: unknown, id: string): asserts value is SessionInfo {
  const s = value as Partial<SessionInfo> | null;
  if (!s || typeof s !== 'object' || typeof s.session_id !== 'string' ||
      s.session_id.toLowerCase() !== id.toLowerCase() ||
      typeof s.cwd !== 'string' || !path.isAbsolute(s.cwd) || s.cwd.includes('\0') ||
      typeof s.permission_mode !== 'string' || !s.permission_mode ||
      typeof s.created_at !== 'string' || !Number.isFinite(Date.parse(s.created_at)) ||
      (s.model !== undefined && (typeof s.model !== 'string' || !s.model)) ||
      (s.effort !== undefined && (typeof s.effort !== 'string' || !s.effort))) {
    throw new Error(`Invalid bridge metadata for Claude session ${id}.`);
  }
}

export async function readSession(home: string, id: string): Promise<SessionInfo | undefined> {
  const file = sessionPath(home, id);
  let data: string;
  try { data = await fs.readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const info: unknown = JSON.parse(data);
  validate(info, id);
  return info;
}

export async function writeSession(home: string, info: SessionInfo): Promise<void> {
  const file = sessionPath(home, info.session_id);
  validate(info, info.session_id);
  const stat = await fs.stat(info.cwd);
  if (!stat.isDirectory()) throw new Error(`Claude session cwd is not a directory: ${info.cwd}`);
  await writeFileAtomic(file, JSON.stringify(info, null, 2) + '\n');
}
