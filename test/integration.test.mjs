import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('MCP ask, follow-up, and restart preserve isolated conversation ownership', { timeout: 45000 }, async t => {
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
    const client = new Client({ name: 'bridge-integration-test', version: '1.0.0' }, { capabilities: {
      extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } },
    } });
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
    const send = transport.send.bind(transport);
    transport.send = (message, ...rest) => {
      if (message.method === 'tools/call' && message.params?.name === 'claude_ask' && message.params?.arguments?.prompt === '__live_output__') {
        client.liveRequestId = message.id;
      }
      return send(message, ...rest);
    };
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
  assert.match(client.getInstructions(), /Haiku: haiku \(claude-haiku-5-5\)/);
  assert.match(client.getInstructions(), /never invent a shorthand/);
  assert.match(client.getInstructions(), /interactive sessions with an MCP Apps card/i);
  assert.match(client.getInstructions(), /For CLI, non-interactive, or clients without MCP Apps use claude_ask or claude_followup directly/);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['claude_ask', 'claude_cancel', 'claude_followup', 'claude_get_quota', 'claude_list_models', 'claude_run_status', 'claude_start', 'claude_ui_probe', 'claude_ui_status', 'claude_wait']);
  const cardUri = 'ui://claude/inspector.html';
  for (const tool of listed.tools.filter(tool => ['claude_ask', 'claude_followup', 'claude_start', 'claude_ui_probe'].includes(tool.name))) {
    assert.equal(tool._meta.ui.resourceUri, cardUri);
    assert.equal(tool._meta['openai/outputTemplate'], cardUri);
  }
  assert.match(listed.tools.find(tool => tool.name === 'claude_ask').description, /claude-haiku-5-5/);
  assert.match(listed.tools.find(tool => tool.name === 'claude_ask').inputSchema.properties.model.description, /claude-haiku-5-5/);
  const modelList = await call(client, 'claude_list_models', {});
  assert.equal(modelList.parsed.status, 'available');
  const quota = await call(client, 'claude_get_quota', {});
  assert.equal(quota.parsed.status, 'unavailable');
  assert.equal(quota.parsed.five_hour, null);
  const cachedQuota = await call(client, 'claude_get_quota', {});
  assert.equal(cachedQuota.parsed.checked_at, quota.parsed.checked_at);
  assert.equal(modelList.parsed.models[0].value, 'haiku');
  assert.equal(modelList.parsed.models[0].resolved_model, 'claude-haiku-5-5');
  const refreshedList = await call(client, 'claude_list_models', { refresh: true });
  assert.equal(refreshedList.parsed.status, 'available');
  const resources = await client.listResources();
  assert.equal(resources.resources.find(resource => resource.uri === cardUri)?.mimeType, 'text/html;profile=mcp-app');
  const card = await client.readResource({ uri: cardUri });
  assert.equal(card.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.match(card.contents[0].text, /<div class="label">Prompt<\/div>/);
  assert.match(card.contents[0].text, /<div class="label">Output<\/div>/);
  const probe = await call(client, 'claude_ui_probe', { message: 'No Claude call needed' });
  assert.equal(probe.parsed.answer, 'No Claude call needed');
  assert.deepEqual(probe.parsed.client_ui_capability.mimeTypes, ['text/html;profile=mcp-app']);
  assert.deepEqual(probe.response._meta.bridgeInput, { prompt: 'No Claude call needed' });
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
  assert.equal(ask.parsed.request_cost_usd, 0.0123);
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
  assert.ok(Math.abs(follow.parsed.request_cost_usd - 0.02) < 1e-10);
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
  assert.ok(Math.abs(resumed.parsed.request_cost_usd - 0.01) < 1e-10);
  const third = JSON.parse(resumed.parsed.answer);
  assert.equal(third.session, id);
  assert.equal(third.cwd, project);
  assert.equal(third.resumed, true);
  assert.ok(third.args.includes('--model=opus'));
  assert.ok(third.args.includes('--effort=low'));
  assert.equal(third.args[third.args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assertAllowedTools(third.args);
  assert.equal((await fs.readFile(log, 'utf8')).trim().split('\n').length, 3);

  const lower = await call(client, 'claude_followup', { prompt: 'lower reported total', session_id: id });
  assert.equal(lower.parsed.request_cost_usd, undefined);
  const noCost = await call(client, 'claude_followup', { prompt: '__no_cost__', session_id: id });
  assert.equal(noCost.parsed.request_cost_usd, undefined);
  const afterNoCost = await call(client, 'claude_followup', { prompt: 'after missing total', session_id: id });
  assert.equal(afterNoCost.parsed.request_cost_usd, undefined);
  const afterBaseline = await call(client, 'claude_followup', { prompt: 'after baseline restored', session_id: id });
  assert.equal(afterBaseline.parsed.request_cost_usd, 0);

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

  const shorthand = await call(client, 'claude_ask', { prompt: 'model shorthand', cwd: project, model: 'haiku-5.5' });
  assert.equal(shorthand.response.isError, false);
  assert.ok(JSON.parse(shorthand.parsed.answer).args.includes('--model=claude-haiku-5-5'));
  assert.match(shorthand.parsed.warnings.join('\n'), /haiku-5\.5 resolved to claude-haiku-5-5/);

  const liveInput = { prompt: '__live_output__', cwd: project };
  const liveCall = call(client, 'claude_ask', liveInput);
  const deadline = Date.now() + 6000;
  let streamed;
  while (Date.now() < deadline && !streamed?.text) {
    if (client.liveRequestId !== undefined) {
      const status = await call(client, 'claude_ui_status', { request_id: client.liveRequestId, ...liveInput, offset: 0 });
      streamed = status.parsed;
    }
    if (!streamed?.text) await delay(50);
  }
  assert.equal(streamed?.text, 'live text');
  const mismatch = await call(client, 'claude_ui_status', { request_id: client.liveRequestId, prompt: 'different', cwd: project, offset: 0 });
  assert.equal(mismatch.parsed.available, false);
  const finishedLive = await liveCall;
  assert.equal(finishedLive.response.isError, false);
  const expired = await call(client, 'claude_ui_status', { request_id: client.liveRequestId, ...liveInput, offset: 0 });
  assert.equal(expired.parsed.available, false);

  // Interactive start returns before the fake Claude result, while status and wait share the same run.
  const interactiveInput = { prompt: '__live_output__', cwd: project, model: 'haiku-5.5', effort: 'low',
    timeout_sec: 15, permission_mode: 'acceptEdits', allowed_tools: ['Read'] };
  const started = await call(client, 'claude_start', interactiveInput);
  assert.equal(started.parsed.status, 'working');
  assert.match(started.parsed.run_id, /^[0-9a-f-]{36}$/);
  assert.equal(started.response._meta.bridgeInput.prompt, interactiveInput.prompt);
  let liveStatus;
  const liveDeadline = Date.now() + 6000;
  while (Date.now() < liveDeadline && !liveStatus?.text) {
    liveStatus = (await call(client, 'claude_run_status', { run_id: started.parsed.run_id, offset: 0 })).parsed;
    if (!liveStatus.text) await delay(50);
  }
  assert.equal(liveStatus.text, 'live text');
  assert.equal(liveStatus.status, 'working');
  assert.equal(liveStatus.model, 'claude-haiku-5-5');
  assert.equal(liveStatus.effort, 'low');
  assert.equal(liveStatus.phase, 'Responding');
  assert.ok(liveStatus.elapsed_sec >= 0);
  const waited = await call(client, 'claude_wait', { run_id: started.parsed.run_id });
  assert.equal(waited.response.isError, false);
  const interactiveAnswer = JSON.parse(waited.parsed.answer);
  assert.ok(interactiveAnswer.args.includes('--model=claude-haiku-5-5'));
  assert.ok(interactiveAnswer.args.includes('--effort=low'));
  assert.equal(interactiveAnswer.args[interactiveAnswer.args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(interactiveAnswer.args.includes('Read'));
  const finalStatus = await call(client, 'claude_run_status', { run_id: started.parsed.run_id, offset: 0 });
  assert.equal(finalStatus.parsed.status, 'completed');
  assert.equal(finalStatus.parsed.result.session_id, waited.parsed.session_id);
  assert.equal(finalStatus.parsed.result.total_cost_usd, 0.0123);
  assert.equal(waited.parsed.total_cost_usd, 0.0123);
  assert.equal(finalStatus.parsed.result.usage.output_tokens, 45);
  const followStart = await call(client, 'claude_start', { prompt: 'interactive follow-up', session_id: waited.parsed.session_id, model: 'opus', effort: 'high', timeout_sec: 15 });
  const followWait = await call(client, 'claude_wait', { run_id: followStart.parsed.run_id });
  const followAnswer = JSON.parse(followWait.parsed.answer);
  assert.equal(followAnswer.resumed, true);
  assert.equal(followAnswer.cwd, project);
  assert.equal(followAnswer.session, waited.parsed.session_id);
  assert.ok(followAnswer.args.includes('--model=opus'));
  assert.ok(followAnswer.args.includes('--effort=high'));
  assert.equal(followAnswer.args[followAnswer.args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(followAnswer.args.includes('Read'));
  const invalidFollow = await client.callTool({ name: 'claude_start', arguments: { prompt: 'bad', session_id: waited.parsed.session_id, permission_mode: 'manual' } });
  assert.equal(invalidFollow.isError, true);
  const invalidStart = await client.callTool({ name: 'claude_start', arguments: { prompt: 'bad' } });
  assert.equal(invalidStart.isError, true);
  const unknownWait = await client.callTool({ name: 'claude_wait', arguments: { run_id: randomUUID() } });
  assert.equal(unknownWait.isError, true);
  const cancelStart = await call(client, 'claude_start', { prompt: '__hang_until_cancelled__', cwd: project });
  const cancelled = await call(client, 'claude_cancel', { run_id: cancelStart.parsed.run_id });
  assert.equal(cancelled.parsed.status, 'cancelling');
  const cancelResult = await client.callTool({ name: 'claude_wait', arguments: { run_id: cancelStart.parsed.run_id } });
  assert.equal(cancelResult.isError, true);
  const cancelledStatus = await call(client, 'claude_run_status', { run_id: cancelStart.parsed.run_id, offset: 0 });
  assert.equal(cancelledStatus.parsed.status, 'cancelled');
  const background = await call(client, 'claude_start', { prompt: '__live_output__', cwd: project, background: true });
  assert.equal(background.parsed.background, true);
  assert.match(background.parsed.instruction, /Continue other work/);
  let backgroundStatus;
  const backgroundDeadline = Date.now() + 10000;
  while (Date.now() < backgroundDeadline) {
    backgroundStatus = (await call(client, 'claude_run_status', { run_id: background.parsed.run_id, offset: 0, claim_notification: true })).parsed;
    if (backgroundStatus.status === 'completed') break;
    assert.equal(backgroundStatus.notification_claimed, false);
    await delay(100);
  }
  assert.equal(backgroundStatus.status, 'completed');
  assert.equal(backgroundStatus.notification_claimed, true);
  const duplicate = await call(client, 'claude_run_status', { run_id: background.parsed.run_id, offset: 0, claim_notification: true });
  assert.equal(duplicate.parsed.notification_claimed, false);
  const backgroundResult = await call(client, 'claude_wait', { run_id: background.parsed.run_id });
  assert.equal(backgroundResult.response.isError, false);
  const foreground = await call(client, 'claude_start', { prompt: 'foreground', cwd: project });
  await call(client, 'claude_wait', { run_id: foreground.parsed.run_id });
  const foregroundStatus = await call(client, 'claude_run_status', { run_id: foreground.parsed.run_id, offset: 0, claim_notification: true });
  assert.equal(foregroundStatus.parsed.notification_claimed, false);
  const waitedBackground = await call(client, 'claude_start', { prompt: 'already waited', cwd: project, background: true });
  await call(client, 'claude_wait', { run_id: waitedBackground.parsed.run_id });
  const waitedStatus = await call(client, 'claude_run_status', { run_id: waitedBackground.parsed.run_id, offset: 0, claim_notification: true });
  assert.equal(waitedStatus.parsed.notification_claimed, false);
});

test('startup config controls UI tools, resources, and guidance', { timeout: 30000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-mcp-ui-config-'));
  const home = path.join(temp, 'isolated'), source = path.join(temp, 'primary');
  const configDir = path.join(home, '.codex-claude-mcp');
  const configPath = path.join(configDir, 'config.json');
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); await fs.rm(temp, { recursive: true, force: true }); });
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(source);
  const connect = async (ui = false) => {
    const client = new Client({ name: 'config-test', version: '1' }, { capabilities: ui ? {
      extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } },
    } : {} });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist', 'index.js')], cwd: root,
      env: { CLAUDE_BRIDGE_HOME: home, CLAUDE_BRIDGE_SOURCE_HOME: source, CLAUDE_CONFIG_DIR: source,
        CLAUDE_BRIDGE_CLAUDE_PATH: path.join(root, 'test', 'fixtures', 'integration-claude.mjs'),
        INTEGRATION_CALL_LOG: path.join(temp, 'calls.jsonl') }, stderr: 'pipe' });
    clients.push(client);
    await client.connect(transport);
    return client;
  };
  await fs.writeFile(configPath, JSON.stringify({ ui_enabled: false }));
  const disabled = await connect(true);
  assert.match(disabled.getInstructions(), /Use claude_ask.*claude_followup/);
  assert.doesNotMatch(disabled.getInstructions(), /claude_start|claude_wait/);
  let listed = await disabled.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['claude_ask', 'claude_followup', 'claude_get_quota', 'claude_list_models']);
  for (const tool of listed.tools) {
    assert.doesNotMatch(tool.description, /claude_start|claude_wait/);
    assert.equal(tool._meta?.ui, undefined);
  }
  assert.equal(disabled.getServerCapabilities().resources, undefined);
  const unavailable = await disabled.callTool({ name: 'claude_start', arguments: { prompt: 'hello', cwd: temp } });
  assert.equal(unavailable.isError, true);
  const ask = await disabled.callTool({ name: 'claude_ask', arguments: { prompt: 'hello', cwd: temp } });
  assert.equal(ask.isError, false);
  const follow = await disabled.callTool({ name: 'claude_followup', arguments: { prompt: 'follow', session_id: ask.structuredContent.session_id } });
  assert.equal(follow.isError, false);
  await disabled.callTool({ name: 'claude_list_models', arguments: { refresh: true } });
  listed = await disabled.listTools();
  assert.doesNotMatch(listed.tools.find(tool => tool.name === 'claude_ask').description, /claude_start|claude_wait/);
  await fs.writeFile(configPath, JSON.stringify({ ui_enabled: true }));
  assert.equal((await disabled.listTools()).tools.length, 4, 'config changes apply only on restart');
  const enabled = await connect();
  assert.match(enabled.getInstructions(), /claude_start.*claude_wait/);
  assert.ok((await enabled.listTools()).tools.some(tool => tool.name === 'claude_start'));
  assert.ok((await enabled.listResources()).resources.some(resource => resource.uri === 'ui://claude/inspector.html'));
  for (const setting of [undefined, 'auto', 'true', 'false']) {
    await fs.writeFile(configPath, JSON.stringify(setting === undefined ? {} : { ui_enabled: setting }));
    for (const ui of [false, true]) {
      const current = await connect(ui);
      const expected = setting === 'true' || (setting !== 'false' && ui);
      const tools = (await current.listTools()).tools;
      assert.equal(tools.some(tool => tool.name === 'claude_start'), expected, `setting=${setting}, ui=${ui}`);
      assert.equal(/claude_start/.test(current.getInstructions()), expected);
      await current.close();
    }
  }
});

test('invalid startup config fails clearly instead of silently enabling UI', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-mcp-invalid-config-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const configDir = path.join(temp, '.codex-claude-mcp');
  await fs.mkdir(configDir);
  for (const contents of ['{', '{"ui_enabled":"sometimes"}', '{"ui_enabled":42}', '{"ui_enabled":null}', '{"model_refresh_sec":-1}', '{"model_refresh_sec":1.5}', '{"model_refresh_sec":"60"}']) {
    await fs.writeFile(path.join(configDir, 'config.json'), contents);
    const child = spawnSync(process.execPath, [path.join(root, 'dist', 'index.js')], {
      cwd: root, env: { ...process.env, CLAUDE_BRIDGE_HOME: temp }, encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /bridge config/i);
  }
});

test('periodic discovery updates model guidance and retains a stale catalogue on failure', { timeout: 30000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-mcp-refresh-'));
  const home = path.join(temp, 'isolated'), source = path.join(temp, 'primary');
  const configDir = path.join(home, '.codex-claude-mcp'), models = path.join(temp, 'models.json');
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(source);
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({ model_refresh_sec: 1 }));
  await fs.writeFile(models, JSON.stringify({ models: [{ value: 'old', displayName: 'Old', resolvedModel: 'claude-old' }] }));
  const client = new Client({ name: 'refresh-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist', 'index.js')], cwd: root,
    env: { CLAUDE_BRIDGE_HOME: home, CLAUDE_BRIDGE_SOURCE_HOME: source, CLAUDE_CONFIG_DIR: source,
      CLAUDE_BRIDGE_CLAUDE_PATH: path.join(root, 'test', 'fixtures', 'integration-claude.mjs'),
      INTEGRATION_CALL_LOG: path.join(temp, 'calls.jsonl'), INTEGRATION_MODELS_FILE: models }, stderr: 'pipe' });
  t.after(async () => { await client.close(); await fs.rm(temp, { recursive: true, force: true }); });
  await client.connect(transport);
  assert.match(client.getInstructions(), /catalogue at startup.*may change/i);
  assert.match(client.getInstructions(), /claude-old/);
  await fs.writeFile(models, JSON.stringify({ models: [{ value: 'new', displayName: 'New', resolvedModel: 'claude-new' }] }));
  const deadline = Date.now() + 10000;
  let listed;
  while (Date.now() < deadline) {
    listed = await client.listTools();
    if (listed.tools.find(tool => tool.name === 'claude_ask').description.includes('claude-new')) break;
    await delay(100);
  }
  assert.match(listed.tools.find(tool => tool.name === 'claude_ask').description, /claude-new/);
  assert.match(listed.tools.find(tool => tool.name === 'claude_ask').inputSchema.properties.model.description, /claude-new/);
  assert.match(client.getInstructions(), /claude-old/);
  await fs.writeFile(models, JSON.stringify({ fail: true }));
  let cached;
  const failureDeadline = Date.now() + 10000;
  while (Date.now() < failureDeadline) {
    cached = await client.callTool({ name: 'claude_list_models', arguments: {} });
    if (cached.structuredContent.stale) break;
    await delay(100);
  }
  assert.equal(cached.structuredContent.stale, true);
  assert.equal(cached.structuredContent.models[0].resolved_model, 'claude-new');
  const failed = await client.callTool({ name: 'claude_list_models', arguments: { refresh: true } });
  assert.equal(failed.structuredContent.status, 'available');
  assert.equal(failed.structuredContent.models[0].resolved_model, 'claude-new');
  assert.equal(failed.structuredContent.stale, true);
  assert.ok(failed.structuredContent.refresh_warning);
  cached = await client.callTool({ name: 'claude_list_models', arguments: {} });
  assert.equal(cached.structuredContent.stale, true);
  assert.match((await client.listTools()).tools.find(tool => tool.name === 'claude_ask').description, /claude-new/);
  await fs.writeFile(models, JSON.stringify({ models: [{ value: 'new', displayName: 'New', resolvedModel: 'claude-new' }] }));
  const recovered = await client.callTool({ name: 'claude_list_models', arguments: { refresh: true } });
  assert.equal(recovered.structuredContent.stale, undefined);
});

test('failed startup model discovery leaves the MCP bridge usable', { timeout: 20000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-mcp-no-models-'));
  const client = new Client({ name: 'unavailable-models-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist', 'index.js')], cwd: root,
    env: { CLAUDE_BRIDGE_HOME: path.join(temp, 'isolated'), CLAUDE_BRIDGE_SOURCE_HOME: path.join(temp, 'primary'),
      CLAUDE_CONFIG_DIR: path.join(temp, 'primary'), CLAUDE_BRIDGE_CLAUDE_PATH: path.join(root, 'test', 'fixtures', 'integration-claude.mjs'),
      INTEGRATION_CALL_LOG: path.join(temp, 'calls.jsonl'), INTEGRATION_MODELS_FAIL: '1' }, stderr: 'pipe' });
  t.after(async () => { await client.close(); await fs.rm(temp, { recursive: true, force: true }); });
  await fs.mkdir(path.join(temp, 'primary'));
  await client.connect(transport);
  assert.match(client.getInstructions(), /Model discovery unavailable/);
  const listed = await client.listTools();
  assert.match(listed.tools.find(tool => tool.name === 'claude_ask').description, /Model discovery unavailable/);
  const models = await client.callTool({ name: 'claude_list_models', arguments: {} });
  assert.equal(models.structuredContent.status, 'unavailable');
  assert.deepEqual(models.structuredContent.models, []);
  const ask = await client.callTool({ name: 'claude_ask', arguments: { prompt: 'still works', cwd: temp, model: 'claude-haiku-5-5' } });
  assert.equal(ask.isError, false);
  assert.equal(JSON.parse(ask.structuredContent.answer).prompt, 'still works');
});

for (const toolName of ['claude_ask', 'claude_start']) test(`closing MCP stdin cancels an active ${toolName} process and removes configuration snapshots`, { timeout: 20000 }, async t => {
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
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } }, clientInfo: { name: 'eof-test', version: '1' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/call', params: { name: toolName, arguments: { prompt: '__hang_until_cancelled__', cwd: temp } } });
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
