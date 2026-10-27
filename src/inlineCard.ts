import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const CARD_URI = 'ui://claude/inspector.html';
export const CARD_MIME = 'text/html;profile=mcp-app';
export const cardMeta = {
  ui: { resourceUri: CARD_URI },
  // Compatibility alias for OpenAI hosts; the UI uses the standard MCP Apps bridge.
  'openai/outputTemplate': CARD_URI,
};

// Self-contained so stdio users need no web server, build tool, or network access.
export const cardHtml = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Claude input and output</title>
  <style>
    :root { color-scheme: light dark; font: 14px/1.5 system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 12px; color: var(--color-text-primary, CanvasText); background: var(--color-background-primary, Canvas); }
    header { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 12px; margin-bottom: 8px; }
    h1 { font-size: 14px; margin: 0; }
    #status { color: var(--color-text-secondary, GrayText); font-size: 12px; }
    details { border-top: 1px solid var(--color-border-primary, GrayText); padding: 8px 0; }
    summary { cursor: pointer; font-weight: 600; border-radius: 3px; }
    summary:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
    pre { margin: 8px 0 0; padding: 8px; border-radius: 6px; background: var(--color-background-secondary, ButtonFace); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; font: 12px/1.5 ui-monospace, monospace; }
  </style>
</head>
<body>
  <header><h1>Claude</h1><span id="status" role="status">Connecting to host…</span></header>
  <details><summary>Input</summary><pre id="input">Waiting for tool input…</pre></details>
  <details><summary>Output</summary><pre id="output">Waiting for Claude…</pre></details>
  <script>
    (() => {
      const status = document.getElementById('status');
      const input = document.getElementById('input');
      const output = document.getElementById('output');
      const initId = 'claude-inspector-init';
      let ready = false;
      let finished = false;
      let observer;
      let lastSize = '';
      const send = (message) => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
      const format = (value) => JSON.stringify(value, null, 2);
      const resize = () => {
        if (!ready) return;
        const height = Math.ceil(document.body.getBoundingClientRect().height);
        const width = Math.ceil(document.documentElement.clientWidth);
        const size = width + ':' + height;
        if (size === lastSize) return;
        lastSize = size;
        send({ method: 'ui/notifications/size-changed', params: { width, height } });
      };
      const context = (value) => {
        if (value?.theme === 'light' || value?.theme === 'dark') {
          document.documentElement.style.colorScheme = value.theme;
        }
      };
      const handshakeTimeout = setTimeout(() => {
        if (!ready) status.textContent = 'Host did not initialize the MCP Apps card';
      }, 5000);
      const receive = (event) => {
        // Only the parent host/sandbox may provide tool data or lifecycle messages.
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== '2.0') return;
        if (message.id === initId && !message.method) {
          clearTimeout(handshakeTimeout);
          if (message.error) {
            status.textContent = 'Host rejected the MCP Apps card';
            return;
          }
          if (ready || !message.result) return;
          ready = true;
          context(message.result.hostContext);
          send({ method: 'ui/notifications/initialized', params: {} });
          if (!finished) status.textContent = 'Waiting for tool input';
          if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(resize);
            observer.observe(document.body);
          }
          resize();
          return;
        }
        if (!ready) return;
        const params = message.params ?? {};
        switch (message.method) {
          case 'ui/notifications/tool-input-partial':
          case 'ui/notifications/tool-input':
            input.textContent = format(params.arguments ?? {});
            if (!finished) status.textContent = 'Running…';
            break;
          case 'ui/notifications/tool-result': {
            finished = true;
            // Preserve the request when a host restores a card from just its result.
            if (params._meta?.bridgeInput) input.textContent = format(params._meta.bridgeInput);
            let result = params.structuredContent;
            if (!result) {
              const text = (params.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
              try { result = JSON.parse(text); } catch { result = { answer: text }; }
            }
            output.textContent = format(result);
            status.textContent = params.isError || result?.error ? 'Failed' : 'Complete';
            break;
          }
          case 'ui/notifications/tool-cancelled':
            finished = true;
            status.textContent = 'Cancelled';
            output.textContent = params.reason ?? 'Tool call cancelled';
            break;
          case 'ui/notifications/host-context-changed':
            context(params);
            break;
          case 'ping':
            if (message.id !== undefined) send({ id: message.id, result: {} });
            break;
          case 'ui/resource-teardown':
            observer?.disconnect();
            window.removeEventListener('message', receive);
            if (message.id !== undefined) send({ id: message.id, result: {} });
            return;
          default:
            if (message.id !== undefined && message.method) {
              send({ id: message.id, error: { code: -32601, message: 'Method not supported' } });
            }
        }
        resize();
      };
      window.addEventListener('message', receive);
      send({
        id: initId,
        method: 'ui/initialize',
        params: {
          protocolVersion: '2026-01-26',
          appInfo: { name: 'Claude inspector', version: '1.0.0' },
          appCapabilities: { availableDisplayModes: ['inline'] },
        },
      });
    })();
  </script>
</body>
</html>`;

export function registerInlineCard(server: McpServer) {
  server.registerResource('claude-inspector', CARD_URI, {
    title: 'Claude input and output', mimeType: CARD_MIME,
    description: 'Inline expandable input and output for Claude bridge calls.',
  }, async () => ({
    contents: [{ uri: CARD_URI, mimeType: CARD_MIME, text: cardHtml,
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } } }],
  }));
  server.registerTool('claude_ui_probe', {
    title: 'Test Claude inline card',
    description: 'Test inline expandable input/output rendering in this MCP host. Returns sample data without starting Claude, reading files, or making a model call. The client capability report does not prove that rendering occurred.',
    inputSchema: { message: z.string().default('Inline card test') },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: cardMeta,
  }, async (input) => {
    const capabilities = server.server.getClientCapabilities();
    const data = {
      answer: input.message,
      client_ui_capability: capabilities?.extensions?.['io.modelcontextprotocol/ui'] ?? null,
      note: 'Rendering succeeds only if an inline Claude card appears with expandable Input and Output sections.',
    };
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data,
      _meta: { bridgeInput: input } };
  });
}
