import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CARD_URI, CARD_MIME, cardHtml, registerInlineCard } from '../dist/inlineCard.js';
import { startLiveRun, readLiveRun } from '../dist/liveRuns.js';
import { MAX_ANSWER_CHARS } from '../dist/runner.js';

function harness(host = {}) {
  const sent = [], listeners = new Map(), timers = new Map();
  let timerId = 0, disconnected = false;
  const elements = Object.fromEntries(['card', 'prompt', 'prompt-toggle', 'output', 'details', 'json', 'status', 'cost', 'request-cost', 'quota', 'run-info', 'cancel', 'notification'].map(id => {
    const handlers = new Map();
    return [id, { textContent: '', open: id === 'card', hidden: false, scrollHeight: 100, clientHeight: 100, scrollTop: 0,
      classList: { toggle() {} }, addEventListener: (name, fn) => handlers.set(name, fn),
      appendChild: node => { elements[id].textContent += node.textContent; }, trigger: name => handlers.get(name)?.() }];
  }));
  const parent = { postMessage: message => sent.push(message) };
  const window = { parent, openai: host.openai, addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name) };
  const script = cardHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, { window,
    document: { getElementById: id => elements[id], createTextNode: text => ({ textContent: text }),
      body: { getBoundingClientRect: () => ({ height: 300 }) }, documentElement: { clientWidth: 400, style: {} } },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    ResizeObserver: class { observe() {} disconnect() { disconnected = true; } },
  });
  const receive = (message, source = parent) => listeners.get('message')?.({ source, data: { jsonrpc: '2.0', ...message } });
  return { sent, elements, receive,
    initialize: () => receive({ id: sent[0].id, result: { protocolVersion: '2026-01-26',
      hostContext: host.context ?? {}, hostCapabilities: host.capabilities ?? {} } }),
    tick(ms) { const entry = [...timers].find(([, v]) => v.ms === ms); if (entry) { timers.delete(entry[0]); entry[1].fn(); } },
    disconnected: () => disconnected,
  };
}

test('card displays prompt and output without an inner collapsed wrapper and retains JSON details', () => {
  const h = harness();
  assert.equal(h.sent[0].method, 'ui/initialize');
  assert.deepEqual([...h.sent[0].params.appCapabilities.availableDisplayModes], ['inline']);
  assert.match(cardHtml, /max-height:\s*4\.5em/);
  assert.doesNotMatch(cardHtml, /<details id="card"/);
  assert.doesNotMatch(cardHtml, /innerHTML|request-display-mode|https?:\/\//);
  h.initialize();
  const input = { prompt: '<script>unsafe</script>\nżółć', cwd: 'C:\\project' };
  h.elements.prompt.scrollHeight = 160;
  h.receive({ method: 'ui/notifications/tool-input', params: { arguments: input } });
  assert.equal(h.elements.prompt.textContent, input.prompt);
  assert.equal(h.elements['prompt-toggle'].hidden, false);
  h.elements['prompt-toggle'].trigger('click');
  assert.equal(h.elements['prompt-toggle'].textContent, 'Show less');
  h.receive({ method: 'ui/notifications/tool-result', params: { structuredContent: { answer: 'Hello', duration_sec: 3 } } });
  assert.equal(h.elements.output.textContent, 'Hello');
  assert.equal(h.elements.status.textContent, 'Complete');
  assert.equal(JSON.parse(h.elements.json.textContent).result.duration_sec, 3);
  assert.equal(h.elements.cost.hidden, true);
  h.receive({ id: 7, method: 'ui/resource-teardown' });
  assert.equal(h.sent.at(-1).id, 7);
  assert.equal(h.disconnected(), true);
});

test('card loads quota independently of live output and formats both reset times', () => {
  const h = harness({ capabilities: { serverTools: {} }, context: { locale: 'en-US', timeZone: 'UTC' } });
  h.initialize();
  const request = h.sent.find(message => message.params?.name === 'claude_get_quota');
  assert.ok(request);
  h.receive({ method: 'ui/notifications/tool-input', params: { arguments: { prompt: 'hello' } } });
  h.receive({ method: 'ui/notifications/tool-result', params: { structuredContent: { status: 'working', run_id: 'run-id' } } });
  h.receive({ id: request.id, result: { structuredContent: { status: 'available', checked_at: '2026-10-28T00:00:00Z',
    five_hour: { used_percent: 19, resets_at: '2026-10-28T02:00:00Z' },
    seven_day: { used_percent: 30, resets_at: '2026-11-02T14:00:00Z' } } } });
  assert.equal(h.elements.quota.hidden, false);
  assert.match(h.elements.quota.textContent, /5h: 19% used, resets Oct 28, 2026/);
  assert.match(h.elements.quota.textContent, /Weekly: 30% used, resets Nov 2, 2026/);
  assert.match(h.elements.quota.title, /2026-10-28/);
  assert.equal(h.elements.status.textContent, 'Running');
  h.tick(700);
  const poll = h.sent.at(-1);
  assert.equal(poll.params.name, 'claude_run_status');
  h.receive({ id: poll.id, result: { structuredContent: { available: true, status: 'completed', text: '', next_offset: 0, result: { answer: 'done' } } } });
  assert.equal(h.sent.filter(message => message.params?.name === 'claude_get_quota').length, 2);
});

test('quota failures and missing values do not affect the card', () => {
  const h = harness({ capabilities: { serverTools: {} } });
  h.initialize();
  const request = h.sent.find(message => message.params?.name === 'claude_get_quota');
  h.receive({ id: request.id, error: { code: -32601, message: 'Unsupported' } });
  assert.equal(h.elements.quota.textContent, 'Quota unavailable');
  const second = harness({ capabilities: { serverTools: {} } });
  second.initialize();
  const secondRequest = second.sent.find(message => message.params?.name === 'claude_get_quota');
  second.receive({ id: secondRequest.id, result: { structuredContent: { status: 'available', five_hour: null,
    seven_day: { used_percent: null, resets_at: null } } } });
  assert.match(second.elements.quota.textContent, /5h: unavailable/);
  assert.match(second.elements.quota.textContent, /Weekly: usage unavailable, reset unavailable/);
});

test('card polls incremental output and stops on completion; user scrolling pauses following', () => {
  const h = harness({ context: { toolInfo: { id: 17 } }, capabilities: { serverTools: {} } });
  h.initialize();
  h.receive({ method: 'ui/notifications/tool-input', params: { arguments: { prompt: 'hello', cwd: 'C:\\p' } } });
  h.tick(700);
  let poll = h.sent.at(-1);
  assert.equal(poll.method, 'tools/call');
  assert.equal(poll.params.arguments.request_id, 17);
  h.receive({ id: poll.id, result: { structuredContent: { available: true, text: 'first ', next_offset: 6 } } });
  assert.equal(h.elements.output.textContent, 'first ');
  h.elements.output.scrollHeight = 500; h.elements.output.scrollTop = 0;
  h.elements.output.trigger('scroll');
  h.tick(700);
  poll = h.sent.at(-1);
  assert.equal(poll.params.arguments.offset, 6);
  h.receive({ id: poll.id, result: { structuredContent: { available: true, text: 'second', next_offset: 12 } } });
  assert.equal(h.elements.output.textContent, 'first second');
  assert.equal(h.elements.output.scrollTop, 0);
  h.receive({ method: 'ui/notifications/tool-result', params: { structuredContent: { answer: 'authoritative' } } });
  assert.equal(h.elements.output.textContent, 'authoritative');
  const count = h.sent.length;
  h.tick(700);
  assert.equal(h.sent.length, count);
});

test('immediate start result activates run-id polling and displays the final answer', () => {
  const h = harness({ capabilities: { serverTools: {} } });
  h.initialize();
  h.receive({ method: 'ui/notifications/tool-input', params: { arguments: { prompt: 'hello', cwd: 'C:\\p' } } });
  h.receive({ method: 'ui/notifications/tool-result', params: { structuredContent: { status: 'working', run_id: 'run-id' } } });
  assert.equal(h.elements.status.textContent, 'Running');
  h.tick(700);
  const poll = h.sent.at(-1);
  assert.equal(poll.params.name, 'claude_run_status');
  assert.equal(poll.params.arguments.run_id, 'run-id');
  h.receive({ id: poll.id, result: { structuredContent: { available: true, status: 'working', text: 'partial', next_offset: 7 } } });
  assert.equal(h.elements.output.textContent, 'partial');
  h.receive({ method: 'ui/notifications/tool-result', params: { structuredContent: { status: 'working', run_id: 'run-id' } } });
  h.tick(700);
  const finalPoll = h.sent.at(-1);
  assert.equal(finalPoll.params.arguments.offset, 7);
  h.receive({ id: finalPoll.id, result: { structuredContent: { available: true, status: 'completed', text: '', next_offset: 7, result: { answer: 'final', total_cost_usd: 0.0123, usage: { output_tokens: 45 } } } } });
  assert.equal(h.elements.output.textContent, 'final');
  assert.equal(h.elements.status.textContent, 'Complete');
  assert.equal(JSON.parse(h.elements.json.textContent).result.total_cost_usd, 0.0123);
  assert.equal(h.elements.cost.textContent, '$0.012');
  assert.equal(h.elements.cost.hidden, false);
  assert.equal(h.elements.details.open, false);
  assert.equal(JSON.parse(h.elements.json.textContent).result.usage.output_tokens, 45);
  h.receive({ method: 'ui/notifications/tool-input', params: { arguments: { prompt: 'hello', cwd: 'C:\\p' } } });
  h.receive({ method: 'ui/notifications/tool-result', params: { structuredContent: { status: 'working', run_id: 'run-id' } } });
  assert.equal(JSON.parse(h.elements.json.textContent).result.total_cost_usd, 0.0123);
  assert.equal(h.elements.status.textContent, 'Complete');
});

test('interactive card displays live run details and cancels through the host', () => {
  const h = harness({ capabilities: { serverTools: {} } });
  h.initialize();
  h.receive({ method: 'ui/notifications/tool-input', params: { arguments: { prompt: 'hello', model: 'opus', effort: 'high' } } });
  h.receive({ method: 'ui/notifications/tool-result', params: { structuredContent: { status: 'working', run_id: 'run-id' } } });
  assert.equal(h.elements.cancel.hidden, false);
  h.tick(700);
  const poll = h.sent.at(-1);
  h.receive({ id: poll.id, result: { structuredContent: { available: true, status: 'working', text: '', next_offset: 0,
    phase: 'Reading files', elapsed_sec: 62, model: 'claude-opus', effort: 'high' } } });
  assert.equal(h.elements['run-info'].textContent, 'Reading files · 1:02 · Model: claude-opus · Effort: high');
  h.elements.cancel.trigger('click');
  const cancel = h.sent.at(-1);
  assert.equal(cancel.params.name, 'claude_cancel');
  assert.equal(cancel.params.arguments.run_id, 'run-id');
  assert.equal(h.elements.cancel.disabled, true);
  h.receive({ id: cancel.id, result: { structuredContent: { status: 'cancelling' } } });
  assert.equal(h.elements.status.textContent, 'Cancelling');
  h.tick(700);
  h.receive({ id: h.sent.at(-1).id, result: { structuredContent: { available: true, status: 'cancelled', text: '', next_offset: 0,
    elapsed_sec: 63, model: 'claude-opus', effort: 'high', result: { error: 'Cancelled' } } } });
  assert.equal(h.elements.status.textContent, 'Cancelled');
  assert.equal(h.elements.cancel.hidden, true);
  assert.equal(h.elements['run-info'].textContent, '1:03 · Model: claude-opus · Effort: high');
  assert.equal(JSON.parse(h.elements.json.textContent).result.error, 'Cancelled');
});

test('cancel is unavailable without host tool calls and can be retried after an error', () => {
  const noTools = harness();
  noTools.initialize();
  noTools.receive({ method: 'ui/notifications/tool-result', params: { structuredContent: { status: 'working', run_id: 'run-id' } } });
  assert.equal(noTools.elements.cancel.hidden, true);
  const h = harness({ capabilities: { serverTools: {} } });
  h.initialize();
  h.receive({ method: 'ui/notifications/tool-result', params: { structuredContent: { status: 'working', run_id: 'run-id' } } });
  h.elements.cancel.trigger('click');
  h.receive({ id: h.sent.at(-1).id, error: { code: -32601, message: 'Unsupported' } });
  assert.equal(h.elements.cancel.disabled, false);
  assert.equal(h.elements.cancel.textContent, 'Retry cancel');
  assert.equal(h.elements.status.textContent, 'Cancellation failed');
});

test('background completion sends one message containing only the run ID and handles rejection', () => {
  const h = harness({ capabilities: { serverTools: {}, message: { text: {} } } });
  h.initialize();
  h.receive({ method: 'ui/notifications/tool-input', params: { arguments: { prompt: 'secret prompt', background: true } } });
  h.receive({ method: 'ui/notifications/tool-result', params: { structuredContent: { status: 'working', run_id: 'run-id', background: true } } });
  h.tick(700);
  const poll = h.sent.at(-1);
  assert.equal(poll.params.arguments.claim_notification, true);
  h.receive({ id: poll.id, result: { structuredContent: { available: true, status: 'completed', background: true, notification_claimed: true,
    text: '', next_offset: 0, result: { answer: 'private answer' } } } });
  const message = h.sent.find(item => item.method === 'ui/message');
  assert.equal(message.params.role, 'user');
  assert.match(message.params.content[0].text, /run-id.*claude_wait/);
  assert.doesNotMatch(message.params.content[0].text, /secret prompt|private answer/);
  h.receive({ id: message.id, error: { code: -32601, message: 'Unsupported' } });
  assert.match(h.elements.notification.textContent, /rejected.*claude_wait/);
  h.tick(700);
  assert.equal(h.sent.filter(item => item.method === 'ui/message').length, 1);
});

test('background mode falls back when host cannot send messages and accepts success responses', () => {
  const noMessages = harness({ capabilities: { serverTools: {}, message: {} } });
  noMessages.initialize();
  noMessages.receive({ method: 'ui/notifications/tool-result', params: { _meta: { bridgeInput: { prompt: 'hello', background: true } },
    structuredContent: { status: 'working', run_id: 'run-id', background: true } } });
  assert.match(noMessages.elements.notification.textContent, /unavailable.*claude_wait/);
  noMessages.tick(700);
  assert.equal(noMessages.sent.at(-1).params.arguments.claim_notification, undefined);
  const legacy = harness({ capabilities: { serverTools: {} } });
  legacy.initialize();
  legacy.receive({ method: 'ui/notifications/tool-result', params: { _meta: { bridgeInput: { prompt: 'hello', background: true } },
    structuredContent: { status: 'working', run_id: 'run-id', background: true } } });
  legacy.tick(700);
  assert.equal(legacy.sent.at(-1).params.arguments.claim_notification, true);
  const h = harness({ capabilities: { serverTools: {}, message: { text: {} } } });
  h.initialize();
  h.receive({ method: 'ui/notifications/tool-result', params: { _meta: { bridgeInput: { prompt: 'hello', background: true } },
    structuredContent: { status: 'working', run_id: 'run-id', background: true } } });
  h.tick(700);
  h.receive({ id: h.sent.at(-1).id, result: { structuredContent: { available: true, status: 'failed', background: true,
    notification_claimed: true, text: '', next_offset: 0, result: { error: 'failed' } } } });
  const message = h.sent.find(item => item.method === 'ui/message');
  assert.match(message.params.content[0].text, /failed/);
  h.receive({ id: message.id, result: {} });
  assert.match(h.elements.notification.textContent, /sent/);
});

test('a recreated card retrieves the completed run and its details', () => {
  const h = harness({ capabilities: { serverTools: {} } });
  h.initialize();
  h.receive({ method: 'ui/notifications/tool-result', params: { _meta: { bridgeInput: { prompt: 'hello' } },
    structuredContent: { status: 'working', run_id: 'run-id' } } });
  h.tick(700);
  h.receive({ id: h.sent.at(-1).id, result: { structuredContent: { available: true, status: 'completed', text: 'streamed', next_offset: 8,
    result: { answer: 'complete', total_cost_usd: 0.25 } } } });
  assert.equal(h.elements.prompt.textContent, 'hello');
  assert.equal(h.elements.output.textContent, 'complete');
  assert.equal(JSON.parse(h.elements.json.textContent).result.total_cost_usd, 0.25);
  assert.equal(h.elements.cost.textContent, '$0.250');
});

test('card displays zero cost and hides invalid cost in a final result', () => {
  for (const [value, expected] of [[0, '$0.000'], [0.0126, '$0.013'], [-1, ''], ['0.5', '']]) {
    const h = harness();
    h.initialize();
    h.receive({ method: 'ui/notifications/tool-result', params: { structuredContent: { answer: 'done', total_cost_usd: value } } });
    assert.equal(h.elements.cost.textContent, expected);
    assert.equal(h.elements.cost.hidden, expected === '');
  }
});

test('card shows request cost beside the session total only when both are available', () => {
  for (const [request, total, expected] of [[0.0048, 0.025, '$0.005'], [0, 0.01, '$0.000'], [undefined, 0.01, ''], [-1, 0.01, ''], [0.01, undefined, '']]) {
    const h = harness();
    h.initialize();
    h.receive({ method: 'ui/notifications/tool-result', params: { structuredContent: { answer: 'done', total_cost_usd: total, request_cost_usd: request } } });
    assert.equal(h.elements['request-cost'].textContent, expected);
    assert.equal(h.elements['request-cost'].hidden, expected === '');
    assert.equal(h.elements['request-cost'].title, 'This request');
    assert.equal(h.elements.cost.title, 'Session total');
  }
});

test('card falls back when host lacks live calls or rejects polling, and errors stay open', () => {
  const h = harness();
  h.initialize();
  h.receive({ method: 'ui/notifications/tool-input', params: { arguments: { prompt: 'hello' } } });
  assert.match(h.elements.status.textContent, /live output unavailable/);
  h.receive({ method: 'ui/notifications/tool-result', params: { isError: true,
    content: [{ type: 'text', text: JSON.stringify({ answer: '', error: 'Failed to start' }) }] } });
  assert.doesNotMatch(cardHtml, /<details id="card"/);
  assert.equal(h.elements.output.textContent, 'Failed to start');
  const h2 = harness({ context: { toolInfo: { id: 42 } }, capabilities: { serverTools: {} } });
  h2.initialize();
  h2.receive({ method: 'ui/notifications/tool-input', params: { arguments: { prompt: 'hello' } } });
  h2.tick(700);
  h2.receive({ id: h2.sent.at(-1).id, error: { code: -32601, message: 'Unsupported' } });
  assert.match(h2.elements.status.textContent, /live output unavailable/);
});

test('live buffers isolate simultaneous runs, enforce bounds, and expire on close', () => {
  const a = { prompt: 'one', cwd: 'x' }, b = { prompt: 'two', session_id: 's' };
  const first = startLiveRun(1, a), second = startLiveRun(2, b);
  assert.equal(startLiveRun(1, b), undefined);
  first.append('hello'); second.append('other');
  assert.equal(readLiveRun(1, b, 0).available, false);
  assert.equal(readLiveRun(2, a, 0).available, false);
  assert.equal(readLiveRun(1, a, 0).text, 'hello');
  assert.equal(readLiveRun(1, a, 2).text, 'llo');
  assert.equal(readLiveRun(1, a, 6).available, false);
  first.append('x'.repeat(MAX_ANSWER_CHARS));
  assert.equal(readLiveRun(1, a, 0).next_offset, MAX_ANSWER_CHARS);
  assert.equal(readLiveRun(1, a, 0).truncated, true);
  first.close(); second.close();
  assert.equal(readLiveRun(1, a, 0).available, false);
});

test('MCP client discovers card and app-only status; probe needs no Claude', async t => {
  const server = new McpServer({ name: 'card-test', version: '1' });
  registerInlineCard(server);
  const ui = { mimeTypes: [CARD_MIME] };
  const client = new Client({ name: 'ui-test', version: '1' }, { capabilities: { extensions: { 'io.modelcontextprotocol/ui': ui } } });
  t.after(async () => { await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  assert.equal(listed.tools.find(t => t.name === 'claude_ui_probe')._meta.ui.resourceUri, CARD_URI);
  assert.deepEqual(listed.tools.find(t => t.name === 'claude_ui_status')._meta.ui.visibility, ['app']);
  const resource = await client.readResource({ uri: CARD_URI });
  assert.equal(resource.contents[0].text, cardHtml);
  assert.equal(resource.contents[0].mimeType, CARD_MIME);
  const probe = await client.callTool({ name: 'claude_ui_probe', arguments: { message: 'Hello' } });
  assert.equal(probe.structuredContent.answer, 'Hello');
  assert.deepEqual(probe._meta.bridgeInput, { prompt: 'Hello' });
  assert.equal(probe.structuredContent.client_ui_capability.mimeTypes[0], CARD_MIME);
});
