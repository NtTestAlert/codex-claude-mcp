import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkAuth } from '../dist/auth.js';

const command = { file: process.execPath, prefixArgs: [fileURLToPath(new URL('./fixtures/auth-claude.mjs', import.meta.url))] };

test('authentication status uses isolated home and inherited auth env without leaking account fields', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-auth-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const capture = path.join(root, 'capture.json');
  const status = await checkAuth(command, root, { cwd: root, env: { ...process.env, AUTH_CAPTURE: capture, AUTH_SCENARIO: 'ok', CLAUDE_CONFIG_DIR: 'wrong', CLAUDECODE: 'nested', CLAUDE_CODE_ENTRYPOINT: 'parent', ANTHROPIC_API_KEY: 'test-key' } });
  assert.deepEqual(status, { status: 'authenticated', auth_method: 'claude.ai' });
  const actual = JSON.parse(await fs.readFile(capture, 'utf8'));
  assert.deepEqual(actual.args, ['auth', 'status', '--json']);
  assert.equal(actual.home, root);
  assert.equal(actual.cwd, root);
  assert.equal(actual.nesting, null);
  assert.equal(actual.entrypoint, null);
  assert.equal(actual.key, 'test-key');
});

test('logged-out nonzero status is unauthenticated; failed and unsupported responses are unknown', async () => {
  for (const scenario of ['logged-out', 'failed', 'malformed', 'missing', 'oversize']) {
    const status = await checkAuth(command, os.tmpdir(), { env: { ...process.env, AUTH_SCENARIO: scenario } });
    assert.equal(status.status, scenario === 'logged-out' ? 'unauthenticated' : 'unknown');
    assert.doesNotMatch(JSON.stringify(status), /PRIVATE|SECRET|private@example/);
  }
});

test('authentication timeout kills the child and returns sanitized unknown status', { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-auth-timeout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const capture = path.join(root, 'capture.json');
  const status = await checkAuth(command, root, { timeoutMs: 1000, env: { ...process.env, AUTH_SCENARIO: 'hang', AUTH_CAPTURE: capture } });
  assert.equal(status.status, 'unknown');
  assert.match(status.error, /timed out/);
  const { pid } = JSON.parse(await fs.readFile(capture, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('missing executable returns unknown without exposing executable path', async () => {
  const status = await checkAuth({ file: path.join(os.tmpdir(), 'nonexistent-private-auth-cli'), prefixArgs: [] }, os.tmpdir());
  assert.equal(status.status, 'unknown');
  assert.doesNotMatch(status.error, /private/);
});
