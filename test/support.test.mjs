import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveClaudeFrom } from '../dist/claudePath.js';
import { ensureHome, mainClaudeHome, loginCommand } from '../dist/home.js';
import { readSession, writeSession } from '../dist/sessions.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-bridge-support-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('resolve explicit JS and fail closed on an invalid explicit override', async t => {
  const root = await fixture(t);
  const js = path.join(root, 'cli.js');
  await fs.writeFile(js, '');
  const ctx = { env: { CLAUDE_BRIDGE_CLAUDE_PATH: js }, platform: process.platform, execPath: process.execPath, homedir: root };
  assert.deepEqual(resolveClaudeFrom(ctx).prefixArgs, [js]);
  assert.equal(resolveClaudeFrom(ctx).file, process.execPath);
  ctx.env.CLAUDE_BRIDGE_CLAUDE_PATH = path.join(root, 'absent');
  assert.throws(() => resolveClaudeFrom(ctx), /CLAUDE_BRIDGE_CLAUDE_PATH/);
});

test('resolve npm shim with spaces without a shell', async t => {
  const root = path.join(await fixture(t), 'npm prefix with spaces');
  const shim = path.join(root, 'claude.cmd');
  const js = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  await fs.mkdir(path.dirname(js), { recursive: true });
  await fs.writeFile(js, '');
  await fs.writeFile(shim, '@echo off');
  const ctx = { env: { CLAUDE_BRIDGE_CLAUDE_PATH: shim }, platform: process.platform, execPath: process.execPath, homedir: root };
  assert.deepEqual(resolveClaudeFrom(ctx).prefixArgs, [js]);
});

test('PATH lookup and targeted native fallback', async t => {
  const root = await fixture(t);
  const bin = path.join(root, '.local', 'bin');
  const exe = path.join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(exe, '');
  const ctx = { env: {}, platform: process.platform, execPath: process.execPath, homedir: root };
  assert.equal(resolveClaudeFrom(ctx).file, exe);
  ctx.env.PATH = bin;
  assert.equal(resolveClaudeFrom(ctx).file, exe);
});

test('home isolation rejects lexical and filesystem aliases, and creates separate home', async t => {
  const root = await fixture(t);
  const keys = ['CLAUDE_BRIDGE_HOME', 'CLAUDE_BRIDGE_SOURCE_HOME', 'CLAUDE_CONFIG_DIR'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  t.after(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const source = path.join(root, 'primary');
  await fs.mkdir(source);
  process.env.CLAUDE_CONFIG_DIR = source;
  delete process.env.CLAUDE_BRIDGE_SOURCE_HOME;
  assert.equal(mainClaudeHome(), source);
  process.env.CLAUDE_BRIDGE_HOME = source;
  await assert.rejects(ensureHome(), /must differ/);
  const alias = path.join(root, 'alias');
  await fs.symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  process.env.CLAUDE_BRIDGE_HOME = alias;
  await assert.rejects(ensureHome(), /must differ/);
  process.env.CLAUDE_BRIDGE_HOME = path.join(root, 'isolated');
  const home = await ensureHome();
  assert.equal((await fs.stat(home)).isDirectory(), true);
  assert.deepEqual(await fs.readdir(home), []);
  assert.match(loginCommand(home), /CLAUDE_CONFIG_DIR=.*claude auth login/);
});

test('session metadata round trip, replacement, and absent ID', async t => {
  const root = await fixture(t);
  const info = { session_id: randomUUID(), cwd: root, permission_mode: 'default', created_at: new Date().toISOString() };
  assert.equal(await readSession(root, info.session_id), undefined);
  await writeSession(root, info);
  assert.deepEqual(await readSession(root, info.session_id), info);
  info.model = 'sonnet';
  await writeSession(root, info);
  assert.deepEqual(await readSession(root, info.session_id.toUpperCase()), info);
  assert.equal((await fs.readdir(path.join(root, '.codex-claude-mcp', 'sessions'))).length, 1);
});

test('session metadata rejects traversal, relative cwd, mismatched identity and malformed data', async t => {
  const root = await fixture(t);
  await assert.rejects(readSession(root, '../bad'), /UUID/);
  const info = { session_id: randomUUID(), cwd: 'relative', permission_mode: 'default', created_at: new Date().toISOString() };
  await assert.rejects(writeSession(root, info), /Invalid bridge metadata/);
  info.cwd = root;
  await writeSession(root, info);
  const file = path.join(root, '.codex-claude-mcp', 'sessions', info.session_id + '.json');
  await fs.writeFile(file, JSON.stringify({ ...info, session_id: randomUUID() }));
  await assert.rejects(readSession(root, info.session_id), /Invalid bridge metadata/);
  await fs.writeFile(file, '{');
  await assert.rejects(readSession(root, info.session_id), SyntaxError);
});
