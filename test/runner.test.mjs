import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runClaude, MAX_ANSWER_CHARS } from '../dist/runner.js';

const fixture = fileURLToPath(new URL('./fixtures/runner/fake-claude.mjs', import.meta.url));
const command = { file: process.execPath, prefixArgs: [fixture] };
const sid = '12345678-1234-4234-8234-123456789abc';
const init = { type: 'system', subtype: 'init', session_id: sid };
const result = (text = 'done') => ({ type: 'result', subtype: 'success', session_id: sid, result: text, is_error: false });
const assistant = text => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
async function run(t, events, extra = {}, opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-runner-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return runClaude({ command, args: [], cwd: dir, env: { ...process.env, FAKE_EVENTS: JSON.stringify(events), ...extra },
    stdin: 'hello', outputFile: path.join(dir, 'answer.txt'), timeoutMs: 20_000, ...opts });
}

test('stream result, stdin, multibyte boundaries and throwing progress callback', async t => {
  const r = await run(t, [init, assistant('intermediate'), result('Résumé 日本語 $STDIN')], { FAKE_CHUNKED: '1' }, { onProgress() { throw Error('ignored'); } });
  assert.equal(r.error, undefined);
  assert.equal(r.answer, 'Résumé 日本語 hello');
  assert.equal(r.sessionId, sid);
  assert.equal(r.exitCode, 0);
});
test('error result retains partial answer and permission diagnostics', async t => {
  const r = await run(t, [init, assistant('partial'), { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['turn limit'], permission_denials: [{ tool_name: 'Bash' }] }]);
  assert.equal(r.error, 'turn limit');
  assert.equal(r.answer, 'partial');
  assert.deepEqual(r.warnings, ['Permission denied: Bash']);
});
test('reports init MCP failures and authentication requirements without leaking details', async t => {
  const r = await run(t, [{ ...init, mcp_servers: [
    { name: 'working', status: 'connected' },
    { name: 'broken', status: 'failed', error: 'SECRET_TOKEN', config: { token: 'SECRET_TOKEN' } },
    { name: 'login', status: 'needs-auth' },
    { name: 'login2', status: 'auth_required' },
  ], mcp_server_errors: [{ name: 'broken', error: 'SECRET_TOKEN' }, { server_name: 'other', error: 'SECRET_TOKEN' }, 'SECRET_TOKEN'] }, result()]);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.warnings, [
    'MCP server broken startup failed', 'MCP server login requires authentication',
    'MCP server login2 requires authentication', 'MCP server other startup failed',
    'MCP server (unknown server) startup failed',
  ]);
  assert.ok(!JSON.stringify(r).includes('SECRET_TOKEN'));
});
test('supports map and single-record MCP startup errors', async t => {
  for (const errors of [
    { search: { message: 'SECRET_TOKEN' }, storage: 'SECRET_TOKEN' },
    { server: 'search', error: 'SECRET_TOKEN' },
    'SECRET_TOKEN',
  ]) {
    const r = await run(t, [{ ...init, mcp_server_errors: errors }, result()]);
    assert.ok(r.warnings.length > 0);
    assert.ok(r.warnings.every(w => w.includes('startup failed')));
    assert.ok(!JSON.stringify(r).includes('SECRET_TOKEN'));
  }
});
test('counts PowerShell tool calls as commands', async t => {
  const r = await run(t, [init, { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'ps', name: 'PowerShell' }, { type: 'tool_use', id: 'sh', name: 'Bash' },
  ] } }, result()]);
  assert.equal(r.activity.commands, 2);
});
test('tracks tool calls once and ignores subagent answer text', async t => {
  const tool = { type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'a', name: 'Bash' }, { type: 'tool_use', id: 'b', name: 'mcp__example__lookup' },
    { type: 'tool_use', id: 'c', name: 'Agent' }] } };
  const r = await run(t, [init, tool, tool, assistant('parent'), { ...assistant('child'), parent_tool_use_id: 'c' }, { ...result(), result: '' }]);
  assert.equal(r.answer, 'parent');
  assert.deepEqual(r.activity, { commands: 1, mcp_tool_calls: ['mcp__example__lookup'], subagent_events: 1 });
});
test('rejects unexpected resume session ID', async t => {
  const r = await run(t, [init, result()], {}, { expectedSessionId: 'another-session' });
  assert.match(r.error, /session mismatch/);
  assert.equal(r.sessionId, undefined);
});
test('rejects changing session identity within one run', async t => {
  const r = await run(t, [init, { ...result(), session_id: 'other' }]);
  assert.match(r.error, /session mismatch/);
});
test('zero exit without result is incomplete; retains partial response', async t => {
  const r = await run(t, [init, assistant('partial')]);
  assert.match(r.error, /without a result/);
  assert.equal(r.answer, 'partial');
});
test('reports nonzero exit and bounded clean stderr', async t => {
  const r = await run(t, [], { FAKE_EXIT: '7', FAKE_STDERR: Array.from({ length: 60 }, (_, i) => `\x1b[31mline ${i}\x1b[0m`).join('\n') });
  assert.match(r.error, /code 7/);
  assert.equal(r.stderrTail.split('\n').length, 40);
  assert.ok(r.stderrTail.startsWith('line 20'));
});
test('saves oversized response in full and caps inline answer', async t => {
  // Environment variables have a size ceiling on Windows; repeat stdin in fixture output instead.
  const text = 'z'.repeat(MAX_ANSWER_CHARS + 100);
  const r = await run(t, [init, result('$STDIN')], {}, { stdin: text });
  assert.equal(await fs.readFile(r.answerFile, 'utf8'), text);
  assert.match(r.answer, /truncated/);
});
test('spawn failure and pre-aborted signal are returned, not thrown', async t => {
  const r = await run(t, [], {}, { command: { file: 'nonexistent-claude-test-93231', prefixArgs: [] } });
  assert.match(r.error, /Failed to start Claude/);
  assert.equal(r.exitCode, null);
  const c = new AbortController(); c.abort();
  const aborted = await run(t, [], {}, { signal: c.signal });
  assert.match(aborted.error, /cancelled/);
});
test('timeout preserves partial response', async t => {
  const r = await run(t, [init, assistant('partial')], { FAKE_HANG: '1' }, { timeoutMs: 3000 });
  assert.equal(r.timedOut, true);
  assert.match(r.error, /timed out/);
  assert.equal(r.answer, 'partial');
});
test('abort kills process tree including descendant', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-child-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const childFile = path.join(dir, 'pid');
  const c = new AbortController();
  const promise = run(t, [init, assistant('partial')], { FAKE_HANG: '1', FAKE_CHILD_FILE: childFile }, { signal: c.signal });
  let pid;
  for (let i = 0; i < 300; i++) {
    try { pid = Number(await fs.readFile(childFile, 'utf8')); break; } catch { await new Promise(r => setTimeout(r, 30)); }
  }
  c.abort();
  const r = await promise;
  assert.ok(pid, 'fixture child started');
  assert.match(r.error, /cancelled/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
