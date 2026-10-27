import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CARD_URI, CARD_MIME, cardHtml, registerInlineCard } from '../dist/inlineCard.js';

// Exercise the embedded script against the host bridge without adding a DOM dependency.
// This tests message handling, not whether a desktop client renders an iframe.
function cardHarness() {
  const sent = [];
  const elements = Object.fromEntries(['input', 'output', 'status'].map(id => [id, { textContent: '' }]));
  const style = {};
  const listeners = new Map();
  let timeout;
  let disconnected = false;
  let onResize;
  const parent = { postMessage: message => sent.push(message) };
  const window = {
    parent,
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name, callback) => {
      if (listeners.get(name) === callback) listeners.delete(name);
    },
  };
  const script = cardHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    window,
    document: {
      getElementById: id => elements[id],
      body: { getBoundingClientRect: () => ({ height: 160 }) },
      documentElement: { clientWidth: 400, style },
    },
    setTimeout: callback => { timeout = callback; return 1; },
    clearTimeout: () => { timeout = undefined; },
    ResizeObserver: class {
      constructor(callback) { onResize = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
  });
  const receive = (message, source = parent) => listeners.get('message')?.({ source, data: { jsonrpc: '2.0', ...message } });
  return {
    sent, elements, style, receive,
    initialize: () => receive({ id: sent[0].id, result: { protocolVersion: '2026-01-26', hostContext: { theme: 'dark' } } }),
    expire: () => timeout?.(),
    resize: () => onResize?.(),
    disconnected: () => disconnected,
    listening: () => listeners.has('message'),
  };
}

test('card uses inline-only handshake, renders request/result as text, and handles resizing/teardown', () => {
  const h = cardHarness();
  assert.equal(h.sent[0].method, 'ui/initialize');
  assert.deepEqual([...h.sent[0].params.appCapabilities.availableDisplayModes], ['inline']);
  assert.equal((cardHtml.match(/<details>/g) ?? []).length, 2);
  assert.doesNotMatch(cardHtml, /<details\s+open|innerHTML|request-display-mode|https?:\/\//);
  h.initialize();
  assert.equal(h.sent[1].method, 'ui/notifications/initialized');
  assert.equal(h.style.colorScheme, 'dark');
  assert.equal(h.sent[2].method, 'ui/notifications/size-changed');
  const count = h.sent.length;
  h.resize();
  assert.equal(h.sent.length, count, 'same-size observations must not create a resize loop');
  const input = { prompt: '<script>alert("untrusted")</script>\nżółć', cwd: 'C:\\project' };
  h.receive({ method: 'ui/notifications/tool-input', params: { arguments: input } });
  assert.deepEqual(JSON.parse(h.elements.input.textContent), input);
  assert.equal(h.elements.status.textContent, 'Running…');
  const result = { answer: 'Answer\nwith Unicode: żółć', duration_sec: 1.2, warnings: [] };
  h.receive({ method: 'ui/notifications/tool-result', params: { structuredContent: result } });
  assert.deepEqual(JSON.parse(h.elements.output.textContent), result);
  assert.equal(h.elements.status.textContent, 'Complete');
  h.receive({ method: 'ui/notifications/host-context-changed', params: { theme: 'light' } });
  assert.equal(h.style.colorScheme, 'light');
  h.receive({ id: 2, method: 'ping' });
  assert.equal(h.sent.at(-1).id, 2);
  h.receive({ id: 3, method: 'ui/resource-teardown' });
  assert.equal(h.sent.at(-1).id, 3);
  assert.equal(h.disconnected(), true);
  assert.equal(h.listening(), false);
});

test('card rejects non-parent messages and reports initialization failure', () => {
  const h = cardHarness();
  h.receive({ id: h.sent[0].id, result: {} }, {});
  assert.equal(h.sent.length, 1);
  h.expire();
  assert.match(h.elements.status.textContent, /did not initialize/);
  h.receive({ id: h.sent[0].id, error: { code: -32601, message: 'Unsupported' } });
  assert.match(h.elements.status.textContent, /rejected/);
});

test('card restores input from result metadata and displays errors, text fallback, and cancellation', () => {
  const h = cardHarness();
  h.initialize();
  h.receive({ method: 'ui/notifications/tool-result', params: {
    _meta: { bridgeInput: { prompt: 'Restored' } },
    isError: true, content: [{ type: 'text', text: JSON.stringify({ answer: '', error: 'Failed to start' }) }],
  } });
  assert.equal(JSON.parse(h.elements.input.textContent).prompt, 'Restored');
  assert.equal(JSON.parse(h.elements.output.textContent).error, 'Failed to start');
  assert.equal(h.elements.status.textContent, 'Failed');
  h.receive({ method: 'ui/notifications/tool-result', params: { content: [{ type: 'text', text: 'Plain text answer' }] } });
  assert.equal(JSON.parse(h.elements.output.textContent).answer, 'Plain text answer');
  h.receive({ method: 'ui/notifications/tool-result', params: { content: [{ type: 'text', text: 'null' }] } });
  assert.equal(h.elements.output.textContent, 'null');
  h.receive({ method: 'ui/notifications/tool-cancelled', params: { reason: 'User cancelled' } });
  assert.equal(h.elements.status.textContent, 'Cancelled');
  assert.equal(h.elements.output.textContent, 'User cancelled');
});

test('MCP Apps client can discover/read the resource and probe without calling Claude', async t => {
  const server = new McpServer({ name: 'card-test', version: '1' });
  registerInlineCard(server);
  const ui = { mimeTypes: [CARD_MIME] };
  const client = new Client({ name: 'ui-test', version: '1' }, {
    capabilities: { extensions: { 'io.modelcontextprotocol/ui': ui } },
  });
  t.after(async () => { await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  assert.equal(listed.tools[0]._meta.ui.resourceUri, CARD_URI);
  assert.equal(listed.tools[0].annotations.readOnlyHint, true);
  const resource = await client.readResource({ uri: CARD_URI });
  assert.equal(resource.contents[0].text, cardHtml);
  assert.equal(resource.contents[0].mimeType, CARD_MIME);
  assert.deepEqual(resource.contents[0]._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
  const probe = await client.callTool({ name: 'claude_ui_probe', arguments: { message: 'Hello' } });
  assert.equal(probe.structuredContent.answer, 'Hello');
  assert.deepEqual(probe.structuredContent.client_ui_capability, ui);
  assert.deepEqual(probe._meta.bridgeInput, { message: 'Hello' });
});
