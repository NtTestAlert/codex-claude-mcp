import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { samePathOnDisk } from './util.js';

function resolveHome(value: string): string {
  return path.resolve(value === '~' ? os.homedir() : /^~[\\/]/.test(value) ? path.join(os.homedir(), value.slice(2)) : value);
}

export function mainClaudeHome(): string {
  return resolveHome(process.env.CLAUDE_BRIDGE_SOURCE_HOME || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}

export function claudeHomePath(): string {
  return resolveHome(process.env.CLAUDE_BRIDGE_HOME || path.join(os.homedir(), '.claude-reviews'));
}

/** Create isolated state. Credentials are deliberately not copied from the primary installation. */
export async function ensureHome(): Promise<string> {
  const home = claudeHomePath();
  if (await samePathOnDisk(home, mainClaudeHome()) || await samePathOnDisk(home, path.join(os.homedir(), '.claude'))) {
    throw new Error('CLAUDE_BRIDGE_HOME must differ from the primary Claude configuration directory (including symlinks/junctions).');
  }
  await fs.mkdir(home, { recursive: true });
  return home;
}

export function loginCommand(home: string): string {
  if (process.platform === 'win32') {
    return `$env:CLAUDE_CONFIG_DIR='${home.replace(/'/g, "''")}'; claude auth login`;
  }
  return `CLAUDE_CONFIG_DIR='${home.replace(/'/g, "'\\''")}' claude auth login`;
}
