import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncConfig, globalConfigPath } from '../dist/configSync.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  await Promise.all([fs.mkdir(source), fs.mkdir(target)]);
  const put = (home, name, data) => fs.writeFile(path.join(home, name), JSON.stringify(data));
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  return { source, target, put, read };
}

test('selective sync preserves isolated native state and excludes recursive aliases', async t => {
  const { source, target, put, read } = await fixture(t);
  await put(source, 'settings.json', { model: 'opus', effortLevel: 'high', env: { SECRET: 'private' }, hooks: { dangerous: true }, permissions: {} });
  await put(source, '.claude.json', { oauthAccount: { token: 'private' }, projects: { history: true }, mcpServers: {
    useful: { command: 'source' }, 'cc-codex-mcp': { command: 'node' },
    alias: { command: 'node', args: ['C:\\repo\\codex-claude-mcp\\dist\\index.js'] },
    otherAlias: { command: 'npx', args: ['-y', '@scope/cc-codex-mcp'] },
  } });
  const native = { mcpServers: { useful: { command: 'target' }, local: { command: 'local' } }, token: 'isolated' };
  await put(target, '.claude.json', native);
  const result = await syncConfig(source, target);
  assert.deepEqual(await read(result.settingsPath), { model: 'opus', effortLevel: 'high' });
  assert.deepEqual(await read(result.mcpConfigPath), { mcpServers: { useful: { command: 'source' }, local: { command: 'local' } } });
  assert.deepEqual(await read(path.join(target, '.claude.json')), native);
  assert.equal(result.warnings.length, 3);
  assert.equal((await fs.readdir(target)).includes('history.jsonl'), false);
});

test('sync never copies or overwrites Claude profile login credentials', async t => {
  const { source, target, put } = await fixture(t);
  await put(source, '.credentials.json', { claudeAiOauth: { accessToken: 'source-login' } });
  await put(target, '.credentials.json', { claudeAiOauth: { accessToken: 'review-login' } });
  const targetCredentials = path.join(target, '.credentials.json');
  const before = await fs.readFile(targetCredentials, 'utf8');
  const output = await syncConfig(source, target);
  await syncConfig(source, target);
  assert.equal(await fs.readFile(targetCredentials, 'utf8'), before);
  assert.doesNotMatch(await fs.readFile(output.settingsPath, 'utf8'), /source-login|review-login/);
  assert.doesNotMatch(await fs.readFile(output.mcpConfigPath, 'utf8'), /source-login|review-login/);
  await fs.rm(targetCredentials);
  await syncConfig(source, target);
  await assert.rejects(fs.stat(targetCredentials), { code: 'ENOENT' });
});

test('refresh removes deleted source entries and does not rewrite unchanged files', async t => {
  const { source, target, put, read } = await fixture(t);
  await put(source, '.claude.json', { mcpServers: { server: { command: 'test' } } });
  const result = await syncConfig(source, target);
  const stamp = (await fs.stat(result.mcpConfigPath)).mtimeMs;
  await syncConfig(source, target);
  assert.equal((await fs.stat(result.mcpConfigPath)).mtimeMs, stamp);
  await put(source, '.claude.json', {});
  await syncConfig(source, target);
  assert.deepEqual(await read(result.mcpConfigPath), { mcpServers: {} });
});

test('malformed source fails without modifying generated files or exposing content', async t => {
  const { source, target } = await fixture(t);
  const result = await syncConfig(source, target);
  const before = await fs.readFile(result.mcpConfigPath, 'utf8');
  await fs.writeFile(path.join(source, '.claude.json'), '{"secret":"sensitive",');
  await assert.rejects(syncConfig(source, target), error => /Invalid JSON/.test(error.message) && !error.message.includes('sensitive'));
  assert.equal(await fs.readFile(result.mcpConfigPath, 'utf8'), before);
  await assert.rejects(syncConfig(source, source), /must differ/);
});

test('custom exclusions also apply to isolated operator entries', async t => {
  const { source, target, put, read } = await fixture(t);
  const previous = process.env.CLAUDE_BRIDGE_MCP_EXCLUDE;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_BRIDGE_MCP_EXCLUDE; else process.env.CLAUDE_BRIDGE_MCP_EXCLUDE = previous; });
  process.env.CLAUDE_BRIDGE_MCP_EXCLUDE = 'skip';
  await put(target, '.claude.json', { mcpServers: { Skip: { command: 'test' }, bridge: { command: 'codex-claude-mcp' } } });
  const result = await syncConfig(source, target);
  assert.deepEqual(await read(result.mcpConfigPath), { mcpServers: {} });
  assert.equal(globalConfigPath(source), path.join(source, '.claude.json'));
});
