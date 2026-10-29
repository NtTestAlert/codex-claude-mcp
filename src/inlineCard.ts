import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readLiveRun } from './liveRuns.js';

export const CARD_URI = 'ui://claude/inspector.html';
export const CARD_MIME = 'text/html;profile=mcp-app';
export const cardMeta = { ui: { resourceUri: CARD_URI }, 'openai/outputTemplate': CARD_URI };

// All assets are embedded for stdio connections; the host owns the outer tool row.
export const cardHtml = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Claude</title>
  <style>
    :root { color-scheme: light dark; font: 14px/1.5 system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 8px 12px; color: var(--color-text-primary, CanvasText); background: var(--color-background-primary, Canvas); }
    summary, button { cursor: pointer; }
    summary { font-weight: 600; }
    .state { color: var(--color-text-secondary, GrayText); font-weight: 400; font-size: 12px; margin-left: 8px; }
    .run-info { color: var(--color-text-secondary, GrayText); font-size: 12px; margin: 4px 0; overflow-wrap: anywhere; }
    .cancel { margin-left: 8px; font-size: 12px; }
    .quota { color: var(--color-text-secondary, GrayText); font-size: 12px; margin: 4px 0; overflow-wrap: anywhere; }
    .label { font-weight: 600; margin: 10px 0 4px; }
    .prompt { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5em; }
    .prompt.clamped { max-height: 4.5em; overflow: hidden; }
    button { background: none; border: 0; color: inherit; padding: 2px 0; text-decoration: underline; font: inherit; }
    button:focus-visible, summary:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
    .output { height: 220px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 8px; background: var(--color-background-secondary, ButtonFace); border-radius: 5px; }
    .stream-entry + .stream-entry { margin-top: 8px; }
    .stream-actions { color: var(--color-text-secondary, GrayText); font-size: 12px; }
    .details { margin-top: 10px; }
    .cost { float: right; color: var(--color-text-secondary, GrayText); font-weight: 400; font-variant-numeric: tabular-nums; }
    .request-cost { opacity: 0.7; margin-right: 8px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; overflow: auto; max-height: 220px; font: 12px/1.5 ui-monospace, monospace; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <div id="card">
    <div><span class="state" id="status" role="status">Connecting…</span><button id="cancel" class="cancel" type="button" hidden>Cancel</button></div>
    <div id="run-info" class="run-info" hidden></div>
    <div id="notification" class="run-info" role="status" hidden></div>
    <div id="quota" class="quota" hidden></div>
    <div class="label">Prompt</div>
    <div id="prompt" class="prompt clamped">Waiting for input…</div>
    <button id="prompt-toggle" type="button" hidden>Show more</button>
    <div class="label">Output</div>
    <div id="output" class="output" tabindex="0" aria-label="Claude output">Waiting for Claude…</div>
    <details id="details" class="details"><summary>Details <span class="cost"><span id="request-cost" class="request-cost" hidden></span><span id="cost" hidden></span></span></summary><pre id="json">Waiting for result…</pre></details>
  </div>
  <script>
    (() => {
      const el = id => document.getElementById(id);
      const prompt = el('prompt'), promptToggle = el('prompt-toggle');
      const output = el('output'), detail = el('details'), json = el('json'), status = el('status');
      const cost = el('cost'), requestCost = el('request-cost');
      const quota = el('quota');
      const cancel = el('cancel'), runInfo = el('run-info'), notification = el('notification');
      const initId = 'claude-inspector-init';
      let ready = false, finished = false, observer, lastSize = '', callId, runId, input, offset = 0, canCallTools = false;
      let polling = false, timer, pollRequest, quotaRequest, cancelRequest, cancelTimer, messageRequest, messageTimer, requestSeq = 0, follow = true, hostContext;
      let canNotify = false, backgroundMode = false;
      let promptExpanded = false, haveOutput = false, restoredScrollTop, widgetTimer, missingPolls = 0;
      let lastModel, lastEffort;
      let streamRevision = -1, streamNodes = [], streamSegments;
      const send = message => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
      const format = value => JSON.stringify(value, null, 2);
      const showCost = result => {
        const value = result?.total_cost_usd;
        cost.hidden = typeof value !== 'number' || !Number.isFinite(value) || value < 0;
        cost.textContent = cost.hidden ? '' : '$' + value.toFixed(3);
        cost.title = 'Session total';
        const request = result?.request_cost_usd;
        requestCost.hidden = cost.hidden || typeof request !== 'number' || !Number.isFinite(request) || request < 0;
        requestCost.textContent = requestCost.hidden ? '' : '$' + request.toFixed(3);
        requestCost.title = 'This request';
      };
      const showRunInfo = data => {
        const parts = [];
        if (typeof data?.model === 'string' && data.model) lastModel = data.model;
        if (typeof data?.effort === 'string' && data.effort) lastEffort = data.effort;
        if (typeof data?.phase === 'string' && !finished) parts.push(data.phase);
        if (typeof data?.elapsed_sec === 'number' && Number.isFinite(data.elapsed_sec) && data.elapsed_sec >= 0) {
          const seconds = Math.floor(data.elapsed_sec);
          parts.push(Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'));
        }
        parts.push('Model: ' + (lastModel ?? 'default'));
        parts.push('Effort: ' + (lastEffort ?? 'default'));
        runInfo.textContent = parts.join(' · '); runInfo.hidden = false;
      };
      const hideCancel = () => { cancel.hidden = true; cancel.disabled = false; clearTimeout(cancelTimer); cancelRequest = undefined; };
      const showNotification = text => { notification.textContent = text; notification.hidden = false; resize(); };
      const notifyCompletion = (id, state) => {
        messageRequest = 'claude-message-' + (++requestSeq);
        const outcome = state === 'cancelled' ? 'cancelled' : state === 'failed' ? 'failed' : 'completed';
        send({ id: messageRequest, method: 'ui/message', params: { role: 'user', content: [{ type: 'text',
          text: 'Claude background run ' + outcome + ' (run_id: ' + id + '). Call claude_wait with this run_id to retrieve the result.' }] } });
        showNotification('Sending completion notification…');
        messageTimer = setTimeout(() => { if (messageRequest) { messageRequest = undefined; showNotification('Notification not confirmed; use claude_wait to retrieve the result.'); } }, 5000);
      };
      const resize = () => {
        if (!ready) return;
        const width = Math.ceil(document.documentElement.clientWidth);
        const height = Math.ceil(document.body.getBoundingClientRect().height);
        const size = width + ':' + height;
        if (size !== lastSize) { lastSize = size; send({ method: 'ui/notifications/size-changed', params: { width, height } }); }
      };
      const context = value => {
        hostContext = { ...hostContext, ...value };
        if (value?.theme === 'light' || value?.theme === 'dark') document.documentElement.style.colorScheme = value.theme;
      };
      const showQuota = data => {
        const describe = (label, value) => {
          if (!value) return label + ': unavailable';
          const used = typeof value.used_percent === 'number' && Number.isFinite(value.used_percent)
            ? value.used_percent.toLocaleString(undefined, { maximumFractionDigits: 1 }) + '% used' : 'usage unavailable';
          let reset = 'reset unavailable';
          if (typeof value.resets_at === 'string') {
            const date = new Date(value.resets_at);
            if (Number.isFinite(date.getTime())) {
              try { reset = 'resets ' + new Intl.DateTimeFormat(hostContext?.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: hostContext?.timeZone }).format(date); }
              catch { reset = 'resets ' + date.toLocaleString(); }
            }
          }
          return label + ': ' + used + ', ' + reset;
        };
        quota.textContent = data?.status === 'available'
          ? describe('5h', data.five_hour) + ' · ' + describe('Weekly', data.seven_day)
          : 'Quota unavailable';
        if (data?.checked_at) quota.title = 'Quota checked at ' + data.checked_at;
        quota.hidden = false;
        resize();
      };
      const requestQuota = () => {
        if (!canCallTools || quotaRequest) return;
        quotaRequest = 'claude-quota-' + (++requestSeq);
        send({ id: quotaRequest, method: 'tools/call', params: { name: 'claude_get_quota', arguments: {} } });
      };
      const persist = () => {
        try { window.openai?.setWidgetState?.({ detailsOpen: detail.open, promptExpanded, follow, scrollTop: restoredScrollTop ?? output.scrollTop }); } catch { /* optional host API */ }
      };
      const save = () => {
        if (typeof window.openai?.setWidgetState !== 'function') return;
        clearTimeout(widgetTimer); widgetTimer = setTimeout(persist, 250);
      };
      const restore = () => {
        try {
          const state = window.openai?.widgetState;
          if (!state || typeof state !== 'object') return;
          if (typeof state.detailsOpen === 'boolean') detail.open = state.detailsOpen;
          if (state.promptExpanded === true) promptExpanded = true;
          if (state.follow === false) follow = false;
          if (typeof state.scrollTop === 'number' && state.scrollTop >= 0 && !follow) restoredScrollTop = state.scrollTop;
        } catch { /* optional host API */ }
      };
      const showPrompt = value => {
        prompt.textContent = typeof value === 'string' ? value : 'No prompt provided';
        prompt.classList.toggle('clamped', !promptExpanded);
        promptToggle.textContent = promptExpanded ? 'Show less' : 'Show more';
        promptToggle.hidden = !promptExpanded && prompt.scrollHeight <= prompt.clientHeight + 1;
      };
      const setOutput = (text, append) => {
        if (!haveOutput || !append) output.textContent = text;
        else output.appendChild(document.createTextNode(text));
        haveOutput = true;
        if (follow) output.scrollTop = output.scrollHeight;
        else if (restoredScrollTop !== undefined && (finished || output.scrollHeight - output.clientHeight >= restoredScrollTop)) {
          output.scrollTop = restoredScrollTop; restoredScrollTop = undefined;
        }
      };
      const actionSummary = actions => {
        const labels = { command: ['command', 'commands', 'Running a command', 'Ran'], read: ['file operation', 'file operations', 'Reading files', 'Read'],
          edit: ['edit', 'edits', 'Editing files', 'Made'], agent: ['agent', 'agents', 'Working with an agent', 'Used'], tool: ['tool', 'tools', 'Using a tool', 'Used'] };
        const parts = [];
        for (const kind of Object.keys(labels)) {
          const list = actions.filter(action => action.kind === kind), names = labels[kind];
          const done = list.filter(action => action.state === 'done').length;
          const failed = list.filter(action => action.state === 'failed').length;
          const stopped = list.filter(action => action.state === 'stopped').length;
          const active = list.filter(action => action.state === 'running').length;
          if (done) parts.push(names[3] + ' ' + done + ' ' + (done === 1 ? names[0] : names[1]));
          if (failed) parts.push(failed + ' failed ' + (failed === 1 ? names[0] : names[1]));
          if (stopped) parts.push(stopped + ' unfinished ' + (stopped === 1 ? names[0] : names[1]));
          if (active) parts.push(active === 1 ? names[2] : names[2] + ' (' + active + ')');
        }
        return parts.join(' · ');
      };
      const renderStream = data => {
        if (!Array.isArray(data?.segments) || !Number.isSafeInteger(data.revision) || data.revision === streamRevision) return false;
        streamRevision = data.revision; streamSegments = data.segments;
        if (!data.segments.length && !streamNodes.length) return false;
        if (!streamNodes.length) { output.textContent = ''; haveOutput = true; }
        data.segments.forEach((segment, index) => {
          let node = streamNodes[index];
          if (!node) { node = document.createElement('div'); node.className = 'stream-entry' + (segment.type === 'actions' ? ' stream-actions' : '');
            streamNodes.push(node); output.appendChild(node); }
          const value = segment.type === 'text' ? segment.text : actionSummary(Array.isArray(segment.actions) ? segment.actions : []);
          if (node.textContent !== value) node.textContent = value;
        });
        if (follow) output.scrollTop = output.scrollHeight;
        else if (restoredScrollTop !== undefined && (finished || output.scrollHeight - output.clientHeight >= restoredScrollTop)) {
          output.scrollTop = restoredScrollTop; restoredScrollTop = undefined;
        }
        return true;
      };
      const finishOutput = result => {
        const answer = typeof result.answer === 'string' && result.answer ? result.answer : (result.error || 'No output');
        if (!streamNodes.length) { setOutput(answer, false); return; }
        streamSegments?.forEach((segment, index) => {
          if (segment.type === 'actions' && segment.actions?.some(action => action.state === 'running')) {
            streamNodes[index].textContent = actionSummary(segment.actions.map(action => action.state === 'running' ? { ...action, state: 'stopped' } : action));
          }
        });
        const last = streamSegments?.at(-1);
        if (last?.type === 'text') streamNodes[streamNodes.length - 1].textContent = answer;
        else { const node = document.createElement('div'); node.className = 'stream-entry'; node.textContent = answer; output.appendChild(node); streamNodes.push(node); }
        if (follow) output.scrollTop = output.scrollHeight;
      };
      promptToggle.addEventListener('click', () => { promptExpanded = !promptExpanded; showPrompt(input?.prompt); save(); resize(); });
      output.addEventListener('scroll', () => { follow = output.scrollHeight - output.scrollTop - output.clientHeight < 24; save(); });
      detail.addEventListener('toggle', () => { save(); resize(); });
      cancel.addEventListener('click', () => {
        if (!canCallTools || !runId || finished || cancelRequest || cancel.disabled) return;
        cancel.disabled = true; cancel.textContent = 'Cancelling…';
        cancelRequest = 'claude-cancel-' + (++requestSeq);
        send({ id: cancelRequest, method: 'tools/call', params: { name: 'claude_cancel', arguments: { run_id: runId } } });
        cancelTimer = setTimeout(() => {
          if (!cancelRequest || finished) return;
          cancelRequest = undefined; cancel.disabled = false; cancel.textContent = 'Retry cancel';
          status.textContent = 'Cancellation not confirmed';
        }, 5000);
      });
      const stopPolling = () => { polling = false; clearTimeout(timer); pollRequest = undefined; };
      const schedule = () => { if (polling && !finished) timer = setTimeout(poll, 700); };
      const poll = () => {
        if (!polling || finished || !input || (runId === undefined && callId === undefined)) return;
        pollRequest = 'claude-live-' + (++requestSeq);
        const revision = streamRevision < 0 ? {} : { stream_revision: streamRevision };
        const args = runId !== undefined ? { run_id: runId, offset, ...revision, ...(backgroundMode && canNotify ? { claim_notification: true } : {}) } : {
          request_id: callId, prompt: input.prompt, ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.session_id === undefined ? {} : { session_id: input.session_id }), offset, ...revision,
        };
        send({ id: pollRequest, method: 'tools/call', params: { name: runId !== undefined ? 'claude_run_status' : 'claude_ui_status', arguments: args } });
        timer = setTimeout(() => { if (pollRequest) { stopPolling(); status.textContent = 'Running · live output unavailable';
          if (backgroundMode) showNotification('Live status unavailable; use claude_wait to retrieve the result.'); } }, 5000);
      };
      const timeout = setTimeout(() => { if (!ready) status.textContent = 'Host did not initialize card'; }, 5000);
      const receive = event => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== '2.0') return;
        if (message.id === initId && !message.method) {
          clearTimeout(timeout);
          if (message.error || !message.result) { status.textContent = 'Host rejected card'; return; }
          if (ready) return;
          ready = true; context(message.result.hostContext); restore();
          callId = message.result.hostContext?.toolInfo?.id;
          canCallTools = Boolean(message.result.hostCapabilities?.serverTools);
          // The 2026-01-26 host capabilities did not advertise ui/message.
          // Try it for that legacy version unless the host explicitly lists modalities without text.
          const messageCapability = message.result.hostCapabilities?.message;
          canNotify = messageCapability === undefined
            ? message.result.protocolVersion === '2026-01-26'
            : Boolean(messageCapability?.text);
          polling = callId !== undefined && canCallTools;
          send({ method: 'ui/notifications/initialized', params: {} });
          requestQuota();
          status.textContent = 'Waiting for input';
          if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(() => { showPrompt(input?.prompt); resize(); }); observer.observe(document.body); }
          resize(); return;
        }
        if (!ready) return;
        if (messageRequest && message.id === messageRequest && !message.method) {
          clearTimeout(messageTimer); messageRequest = undefined;
          if (message.error || !message.result || message.result.isError) showNotification('Notification rejected; use claude_wait to retrieve the result.');
          else showNotification('Completion notification sent; use claude_wait if no follow-up occurs.');
          return;
        }
        if (cancelRequest && message.id === cancelRequest && !message.method) {
          clearTimeout(cancelTimer); cancelRequest = undefined;
          if (finished) return;
          if (message.error || message.result?.isError) {
            cancel.disabled = false; cancel.textContent = 'Retry cancel'; status.textContent = 'Cancellation failed';
          } else { cancel.disabled = true; cancel.textContent = 'Cancelling…'; status.textContent = 'Cancelling'; }
          resize(); return;
        }
        if (quotaRequest && message.id === quotaRequest && !message.method) {
          quotaRequest = undefined;
          const response = message.result;
          let data = response?.structuredContent;
          if (!data && response?.content?.[0]?.type === 'text') { try { data = JSON.parse(response.content[0].text); } catch {} }
          showQuota(message.error || response?.isError ? undefined : data);
          return;
        }
        if (pollRequest && message.id === pollRequest && !message.method) {
          clearTimeout(timer); pollRequest = undefined;
          if (finished) return;
          const response = message.result;
          let data = response?.structuredContent;
          if (!data && response?.content?.[0]?.type === 'text') { try { data = JSON.parse(response.content[0].text); } catch {} }
          if (message.error || response?.isError) { stopPolling(); status.textContent = 'Running · live output unavailable';
            if (backgroundMode) showNotification('Live status unavailable; use claude_wait to retrieve the result.'); return; }
          if (data?.available) {
            missingPolls = 0;
            showRunInfo(data);
            renderStream(data);
            if (!Number.isSafeInteger(data.revision) && typeof data.text === 'string' && data.text) setOutput(data.text, true);
            if (Number.isSafeInteger(data.next_offset) && data.next_offset >= offset) offset = data.next_offset;
            if (data.truncated) status.textContent = 'Running · live output truncated';
            if (data.status === 'cancelling') status.textContent = 'Cancelling';
            if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
              finished = true; stopPolling();
              hideCancel(); showRunInfo(data);
              const result = data.result ?? {};
              json.textContent = format({ input, result });
              showCost(result);
              requestQuota();
              finishOutput(result);
              status.textContent = data.status === 'cancelled' ? 'Cancelled' : data.status === 'failed' ? 'Failed' : 'Complete';
              if (data.notification_claimed && runId && canNotify) notifyCompletion(runId, data.status);
              else if (data.background) showNotification('Completion notification unavailable or already attempted; use claude_wait if needed.');
              save(); resize(); return;
            }
          } else if (++missingPolls >= 8) {
            stopPolling(); status.textContent = 'Running · live output unavailable';
            if (backgroundMode) showNotification('Live status unavailable; use claude_wait to retrieve the result.'); return;
          }
          schedule(); return;
        }
        const params = message.params ?? {};
        switch (message.method) {
          case 'ui/notifications/tool-input-partial':
          case 'ui/notifications/tool-input':
            input = params.arguments ?? {}; showPrompt(input.prompt);
            if (!finished && runId === undefined) json.textContent = format({ input });
            if (!finished) status.textContent = polling ? 'Running' : 'Running · live output unavailable';
            if (message.method === 'ui/notifications/tool-input' && polling && !timer) schedule();
            break;
          case 'ui/notifications/tool-result': {
            if (params._meta?.bridgeInput) { input = params._meta.bridgeInput; showPrompt(input.prompt); }
            let result = params.structuredContent;
            if (!result) {
              const text = (params.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
              try { result = JSON.parse(text); } catch { result = { answer: text }; }
            }
            if (typeof result?.run_id === 'string' && result.status === 'working') {
              if (finished || runId === result.run_id) break;
              stopPolling(); runId = result.run_id; offset = 0; streamRevision = -1;
              backgroundMode = result.background === true || input?.background === true;
              json.textContent = format({ input, start: result });
              polling = canCallTools;
              if (backgroundMode && (!canNotify || !canCallTools)) showNotification('Background notification unavailable in this host; use claude_wait to retrieve the result.');
              cancel.hidden = !canCallTools; cancel.disabled = false; cancel.textContent = 'Cancel';
              showRunInfo({ model: input?.model, effort: input?.effort });
              status.textContent = polling ? 'Running' : 'Running · live output unavailable';
              if (polling) schedule();
              break;
            }
            finished = true; stopPolling();
            hideCancel(); showRunInfo({ elapsed_sec: result?.duration_sec, model: lastModel ?? input?.model, effort: lastEffort ?? input?.effort });
            json.textContent = format({ input, result });
            showCost(result);
            requestQuota();
            const failed = params.isError || result?.error;
            finishOutput(result ?? {});
            status.textContent = failed ? 'Failed' : 'Complete';
            save(); break;
          }
          case 'ui/notifications/tool-cancelled':
            finished = true; stopPolling(); hideCancel(); status.textContent = 'Cancelled';
            setOutput(params.reason ?? 'Tool call cancelled', false); break;
          case 'ui/notifications/host-context-changed': context(params); break;
          case 'ping': if (message.id !== undefined) send({ id: message.id, result: {} }); break;
          case 'ui/resource-teardown':
            stopPolling(); hideCancel(); clearTimeout(timeout); clearTimeout(widgetTimer); clearTimeout(messageTimer); persist(); observer?.disconnect();
            window.removeEventListener('message', receive);
            if (message.id !== undefined) send({ id: message.id, result: {} }); return;
          default:
            if (message.id !== undefined && message.method) send({ id: message.id, error: { code: -32601, message: 'Method not supported' } });
        }
        resize();
      };
      window.addEventListener('message', receive);
      send({ id: initId, method: 'ui/initialize', params: {
        protocolVersion: '2026-01-26', appInfo: { name: 'Claude inspector', version: '1.0.0' },
        appCapabilities: { availableDisplayModes: ['inline'] },
      } });
    })();
  </script>
</body>
</html>`;

export function registerInlineCard(server: McpServer) {
  server.registerResource('claude-inspector', CARD_URI, {
    title: 'Claude input and output', mimeType: CARD_MIME,
    description: 'Inline Claude prompt, output, and expandable details.',
  }, async () => ({ contents: [{ uri: CARD_URI, mimeType: CARD_MIME, text: cardHtml,
    _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } } }] }));
  server.registerTool('claude_ui_status', {
    title: 'Read live Claude output',
    description: 'Read the next live text chunk for the matching active tool call. Used by the Claude inline card.',
    inputSchema: { request_id: z.union([z.string(), z.number()]), prompt: z.string(), cwd: z.string().optional(),
      session_id: z.string().optional(), offset: z.number().int().min(0), stream_revision: z.number().int().min(0).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { visibility: ['app'] } },
  }, async ({ request_id, prompt, cwd, session_id, offset, stream_revision }) => {
    const data = readLiveRun(request_id, { prompt, cwd, session_id }, offset, stream_revision);
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  });
  server.registerTool('claude_ui_probe', {
    title: 'Test Claude inline card',
    description: 'Test inline Claude card rendering without starting Claude or making a model call.',
    inputSchema: { message: z.string().default('Inline card test') },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: cardMeta,
  }, async input => {
    const data = { answer: input.message, client_ui_capability: server.server.getClientCapabilities()?.extensions?.['io.modelcontextprotocol/ui'] ?? null,
      note: 'Rendering succeeds only if the inline Claude card appears in the chat.' };
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data,
      _meta: { bridgeInput: { prompt: input.message } } };
  });
}
