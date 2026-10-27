import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('MCP ask, follow-up, and restart preserve isolated conversation ownership', { timeout: 30000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-mcp-integration-'));
  const home = path.join(temp, 'isolated');
  const source = path.join(temp, 'primary');
  const project = path.join(temp, 'project with spaces');
  const log = path.join(temp, 'calls.jsonl');
  await fs.mkdir(project);
  await fs.mkdir(source);
  const connections = new Set();
  t.after(async () => {
    for (const client of connections) await client.close();
    await fs.rm(temp, { recursive: true, force: true });
  });
  async function connect() {
    const client = new Client({ name: 'bridge-integration-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, 'dist', 'index.js')],
      cwd: root,
      env: {
        CLAUDE_BRIDGE_HOME: home,
        CLAUDE_BRIDGE_SOURCE_HOME: source,
        CLAUDE_CONFIG_DIR: source,
        CLAUDE_BRIDGE_CLAUDE_PATH: path.join(root, 'test', 'fixtures', 'integration-claude.mjs'),
        CLAUDECODE: 'parent-marker',
        CLAUDE_CODE_ENTRYPOINT: 'parent-entrypoint',
        INTEGRATION_CALL_LOG: log,
      },
      stderr: 'pipe',
    });
    connections.add(client);
    await client.connect(transport);
    return client;
  }
  async function call(client, name, args) {
    const response = await client.callTool({ name, arguments: args });
    const parsed = JSON.parse(response.content[0].text);
    assert.deepEqual(response.structuredContent, parsed);
    return { response, parsed };
  }
  let client = await connect();
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['claude_ask', 'claude_followup', 'claude_ui_probe']);
  const cardUri = 'ui://claude/inspector.html';
  for (const tool of listed.tools) {
    assert.equal(tool._meta.ui.resourceUri, cardUri);
    assert.equal(tool._meta['openai/outputTemplate'], cardUri);
  }
  const resources = await client.listResources();
  assert.equal(resources.resources.find(resource => resource.uri === cardUri)?.mimeType, 'text/html;profile=mcp-app');
  const card = await client.readResource({ uri: cardUri });
  assert.equal(card.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(card.contents[0].text, /<summary>Input<\/summary>/);
  assert.match(card.contents[0].text, /<summary>Output<\/summary>/);
  const probe = await call(client, 'claude_ui_probe', { message: 'No Claude call needed' });
  assert.equal(probe.parsed.answer, 'No Claude call needed');
  assert.equal(probe.parsed.client_ui_capability, null);
  assert.deepEqual(probe.response._meta.bridgeInput, { message: 'No Claude call needed' });
  await assert.rejects(fs.stat(log), { code: 'ENOENT' });
  const prompt = 'Review this\nwith "quotes", $variables, and Unicode: żółć. --model=not-an-option';
  const allowedTools = ['Read', 'Bash(git diff *)'];
  const allowedArgs = ['--allowedTools', ...allowedTools];
  function assertAllowedTools(args) {
    const index = args.indexOf('--allowedTools');
    assert.notEqual(index, -1);
    assert.deepEqual(args.slice(index, index + allowedArgs.length), allowedArgs);
    assert.equal(args.filter(arg => arg === '--allowedTools').length, 1);
  }
  const ask = await call(client, 'claude_ask', { prompt, cwd: project, model: 'sonnet', effort: 'high', permission_mode: 'acceptEdits', allowed_tools: allowedTools });
  assert.equal(ask.response.isError, false, ask.parsed.error);
  assert.equal(ask.response._meta.bridgeInput.prompt, prompt);
  assert.equal(ask.response._meta.bridgeInput.cwd, project);
  const id = ask.parsed.session_id;
  assert.match(id, /^[0-9a-f-]{36}$/);
  const first = JSON.parse(ask.parsed.answer);
  assert.equal(first.prompt, prompt);
  assert.equal(first.cwd, project);
  assert.equal(first.session, id);
  assert.equal(first.resumed, false);
  assert.equal(first.home, home);
  assert.equal(first.nesting, null);
  assert.equal(first.entrypoint, null);
  assert.ok(first.args.includes('--model=sonnet'));
  assert.ok(first.args.includes('--effort=high'));
  assert.equal(first.args[first.args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assertAllowedTools(first.args);
  assert.equal(first.args.some(arg => arg.includes('not-an-option')), false);
  assert.ok(first.args.includes('--strict-mcp-config'));
  for (const flag of ['--mcp-config', '--settings']) {
    await assert.rejects(fs.stat(first.args[first.args.indexOf(flag) + 1]), { code: 'ENOENT' });
  }

  const follow = await call(client, 'claude_followup', { prompt: 'Follow up', session_id: id, model: 'opus', effort: 'low' });
  assert.equal(follow.response.isError, false, follow.parsed.error);
  assert.equal(follow.response._meta.bridgeInput.prompt, 'Follow up');
  assert.equal(follow.response._meta.bridgeInput.session_id, id);
  const second = JSON.parse(follow.parsed.answer);
  assert.equal(second.cwd, project);
  assert.equal(second.session, id);
  assert.equal(second.resumed, true);
  assert.ok(second.args.includes('--model=opus'));
  assert.ok(second.args.includes('--effort=low'));
  assert.equal(second.args[second.args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assertAllowedTools(second.args);

  const unknown = await call(client, 'claude_followup', { prompt: 'Unknown', session_id: randomUUID() });
  assert.equal(unknown.response.isError, true);
  assert.equal(unknown.response._meta.bridgeInput.prompt, 'Unknown');
  assert.match(unknown.parsed.error, /Unknown bridge session/);
  assert.equal((await fs.readFile(log, 'utf8')).trim().split('\n').length, 2);

  await client.close();
  connections.delete(client);
  client = await connect();
  const resumed = await call(client, 'claude_followup', { prompt: 'After restart', session_id: id });
  assert.equal(resumed.response.isError, false, resumed.parsed.error);
  const third = JSON.parse(resumed.parsed.answer);
  assert.equal(third.session, id);
  assert.equal(third.cwd, project);
  assert.equal(third.resumed, true);
  assert.ok(third.args.includes('--model=opus'));
  assert.ok(third.args.includes('--effort=low'));
  assert.equal(third.args[third.args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assertAllowedTools(third.args);
  assert.equal((await fs.readFile(log, 'utf8')).trim().split('\n').length, 3);

  // The default and explicit modes reach Claude unchanged; omitted allow rules grant nothing implicitly.
  for (const permissionMode of [undefined, 'manual', 'auto', 'default']) {
    const modeAsk = await call(client, 'claude_ask', {
      prompt: 'Check permission mode', cwd: project,
      ...(permissionMode === undefined ? {} : { permission_mode: permissionMode }),
    });
    assert.equal(modeAsk.response.isError, false, modeAsk.parsed.error);
    const invocation = JSON.parse(modeAsk.parsed.answer);
    assert.equal(invocation.args[invocation.args.indexOf('--permission-mode') + 1], permissionMode ?? 'manual');
    assert.equal(invocation.args.some(arg => /^--allowedTools(?:=|$)/.test(arg)), false);
  }

  const genericFailure = await call(client, 'claude_ask', { prompt: '__generic_failure__', cwd: project });
  assert.equal(genericFailure.response.isError, true);
  assert.match(genericFailure.parsed.error, /Requested model is unavailable/);
  assert.doesNotMatch(genericFailure.parsed.error, /auth login|authentication failed/i);
  const authenticationFailure = await call(client, 'claude_ask', { prompt: '__authentication_failure__', cwd: project });
  assert.equal(authenticationFailure.response.isError, true);
  assert.match(authenticationFailure.parsed.error, /Invalid API key/);
  assert.match(authenticationFailure.parsed.error, /claude auth login/);
});

test('closing MCP stdin cancels an active Claude process and removes configuration snapshots', { timeout: 20000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-mcp-eof-'));
  const log = path.join(temp, 'calls.jsonl');
  const server = spawn(process.execPath, [path.join(root, 'dist', 'index.js')], {
    cwd: root,
    env: {
      ...process.env,
      CLAUDE_BRIDGE_HOME: path.join(temp, 'isolated'),
      CLAUDE_BRIDGE_SOURCE_HOME: path.join(temp, 'primary'),
      CLAUDE_CONFIG_DIR: path.join(temp, 'primary'),
      CLAUDE_BRIDGE_CLAUDE_PATH: path.join(root, 'test', 'fixtures', 'integration-claude.mjs'),
      INTEGRATION_CALL_LOG: log,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  server.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  server.stdout.resume();
  const exited = new Promise((resolve, reject) => {
    server.once('exit', (code, signal) => resolve({ code, signal }));
    server.once('error', reject);
  });
  let started;
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) server.kill();
    if (started) { try { process.kill(started.pid); } catch {} }
    await exited;
    await fs.rm(temp, { recursive: true, force: true });
  });
  const send = message => server.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eof-test', version: '1' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/call', params: { name: 'claude_ask', arguments: { prompt: '__hang_until_cancelled__', cwd: temp } } });
  const deadline = Date.now() + 8000;
  while (!started && Date.now() < deadline) {
    try { started = JSON.parse((await fs.readFile(log, 'utf8')).trim()); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (!started) await delay(25);
  }
  assert.ok(started, `Fake Claude did not start: ${stderr}`);
  for (const flag of ['--mcp-config', '--settings']) {
    assert.equal((await fs.stat(started.args[started.args.indexOf(flag) + 1])).isFile(), true);
  }
  server.stdin.end();
  let timeout;
  const outcome = await Promise.race([
    exited,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Server failed to exit after stdin EOF: ${stderr}`)), 6000); }),
  ]).finally(() => clearTimeout(timeout));
  assert.equal(outcome.code, 0, stderr);
  assert.throws(() => process.kill(started.pid, 0), { code: 'ESRCH' });
  for (const flag of ['--mcp-config', '--settings']) {
    await assert.rejects(fs.stat(started.args[started.args.indexOf(flag) + 1]), { code: 'ENOENT' });
  }
});
