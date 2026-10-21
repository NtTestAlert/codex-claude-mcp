import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ClaudeCommand { file: string; prefixArgs: string[]; source: string }
export interface ResolveContext {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  execPath: string;
  homedir: string;
}

export function defaultContext(): ResolveContext {
  return { env: process.env, platform: process.platform, execPath: process.execPath, homedir: os.homedir() };
}

function isFile(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function getEnv(ctx: ResolveContext, key: string): string | undefined {
  const actual = ctx.platform === 'win32' ? Object.keys(ctx.env).find(k => k.toLowerCase() === key.toLowerCase()) : key;
  return actual ? ctx.env[actual] : undefined;
}

/** Resolve standard npm shims without invoking cmd.exe, PowerShell, or a shell. */
export function unwrapShim(file: string, ctx: ResolveContext): ClaudeCommand | undefined {
  const p = ctx.platform === 'win32' ? path.win32 : path.posix;
  const dir = p.dirname(file);
  const candidates = [p.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    p.resolve(dir, '..', '@anthropic-ai', 'claude-code', 'cli.js')];
  let content: string;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  for (const re of [/%~?dp0%?[\\/]([^"%\r\n*?<>|]+?\.(?:c|m)?js)\b/i, /\$basedir[\\/]([^"'\r\n]+?\.(?:c|m)?js)\b/i]) {
    const match = re.exec(content);
    if (match) candidates.push(p.resolve(dir, match[1]));
  }
  const js = candidates.find(isFile);
  return js ? { file: ctx.execPath, prefixArgs: [js], source: `npm shim ${file}` } : undefined;
}

function command(file: string, ctx: ResolveContext): ClaudeCommand | undefined {
  if (!isFile(file)) return undefined;
  const ext = path.extname(file).toLowerCase();
  if (['.cmd', '.bat', '.ps1'].includes(ext)) return unwrapShim(file, ctx);
  if (['.js', '.mjs', '.cjs'].includes(ext)) return { file: ctx.execPath, prefixArgs: [file], source: file };
  // POSIX npm normally installs a symlink to cli.js; run its target with this Node executable.
  if (ctx.platform !== 'win32') {
    const real = fs.realpathSync(file);
    if (/\.(?:c|m)?js$/i.test(real)) return { file: ctx.execPath, prefixArgs: [real], source: file };
  }
  return { file, prefixArgs: [], source: file };
}

export function resolveClaudeFrom(ctx: ResolveContext): ClaudeCommand {
  const p = ctx.platform === 'win32' ? path.win32 : path.posix;
  const override = getEnv(ctx, 'CLAUDE_BRIDGE_CLAUDE_PATH')?.trim().replace(/^"(.*)"$/, '$1');
  if (override) {
    const found = command(override, ctx);
    if (found) return found;
    throw new Error(`CLAUDE_BRIDGE_CLAUDE_PATH is missing or cannot be resolved without a shell: ${override}`);
  }
  const extensions = ctx.platform === 'win32' ? ['.exe', '.com', '.cmd', '.bat', '.ps1'] : [''];
  const dirs = (getEnv(ctx, 'PATH') || '').split(ctx.platform === 'win32' ? ';' : ':').map(s => s.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of extensions) {
      const found = command(p.join(dir, `claude${ext}`), ctx);
      if (found) return found;
    }
  }
  const fallback = command(p.join(ctx.homedir, '.local', 'bin', ctx.platform === 'win32' ? 'claude.exe' : 'claude'), ctx);
  if (fallback) return fallback;
  throw new Error('Could not find Claude Code. Install the Claude CLI or set CLAUDE_BRIDGE_CLAUDE_PATH to its executable or cli.js.');
}

export function resolveClaude(): ClaudeCommand { return resolveClaudeFrom(defaultContext()); }
