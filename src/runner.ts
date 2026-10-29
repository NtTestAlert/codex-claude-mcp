import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { killTree } from './killTree.js';
import { stripAnsi } from './util.js';

export interface RunOptions {
  command: { file: string; prefixArgs: string[] };
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  outputFile: string;
  timeoutMs: number;
  expectedSessionId?: string;
  signal?: AbortSignal;
  onProgress?: (info: { elapsedSec: number; lastEvent?: string }) => void;
  onTextDelta?: (text: string, newBlock: boolean) => void;
  onActionStart?: (id: string, kind: string) => void;
  onActionEnd?: (id: string, failed: boolean) => void;
  onStatus?: (info: { phase?: string; model?: string }) => void;
}

export interface RunResult {
  sessionId?: string;
  answer: string;
  answerFile?: string;
  durationSec: number;
  warnings: string[];
  error?: string;
  exitCode: number | null;
  timedOut: boolean;
  stderrTail: string;
  activity: { commands: number; mcp_tool_calls: string[]; subagent_events: number };
  totalCostUsd?: number;
  usage?: Record<string, number>;
}

export const MAX_ANSWER_CHARS = 50_000;
type Json = Record<string, unknown>;
const obj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
function message(v: unknown): string {
  if (typeof v === 'string') return v;
  if (obj(v) && typeof v.message === 'string') return v.message;
  return JSON.stringify(v) ?? 'Unknown error';
}

/** Run Claude's stream-json protocol. All mutable state belongs to this invocation. */
export async function runClaude(o: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const elapsedSec = () => Math.round((Date.now() - started) / 100) / 10;
  const warnings: string[] = [];
  const stderr: string[] = [];
  const tools = new Set<string>();
  const streamedTools = new Set<string>();
  let newTextBlock = true;
  const activity: RunResult['activity'] = { commands: 0, mcp_tool_calls: [], subagent_events: 0 };
  let sessionId: string | undefined;
  let answer = '';
  let partialAnswer = '';
  let resultSeen = false;
  let totalCostUsd: number | undefined;
  let usage: Record<string, number> | undefined;
  let failure: string | undefined;
  let mismatch: string | undefined;
  let spawnError: Error | undefined;
  let timedOut = false;
  let cancelled = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let lastEvent: string | undefined;
  let lastProgress = 0;
  const warn = (s: string) => {
    const clean = stripAnsi(s).replace(/\s+/g, ' ').trim().slice(0, 500);
    if (clean && warnings.length < 30 && !warnings.includes(clean)) warnings.push(clean);
  };
  const diagnostic = (s: string) => {
    const clean = stripAnsi(s).replace(/\r$/, '');
    if (!clean.trim()) return;
    stderr.push(clean.slice(-10_000));
    if (stderr.length > 40) stderr.shift();
    if (/mcp.*(fail|error)|permission.*denied|authentication.*(fail|error)/i.test(clean)) warn(clean);
  };
  const progress = (force = false) => {
    if (!o.onProgress || (!force && Date.now() - lastProgress < 5_000)) return;
    lastProgress = Date.now();
    try { o.onProgress({ elapsedSec: elapsedSec(), lastEvent }); } catch { /* advisory callback */ }
  };
  const status = (info: { phase?: string; model?: string }) => { try { o.onStatus?.(info); } catch { /* advisory callback */ } };
  const actionStart = (block: Json) => {
    const id = str(block.id), name = str(block.name);
    if (!id || !name || streamedTools.has(id)) return;
    streamedTools.add(id); newTextBlock = true;
    const kind = name === 'Bash' || name === 'PowerShell' ? 'command'
      : ['Read', 'Glob', 'Grep', 'LS'].includes(name) ? 'read'
      : ['Edit', 'Write', 'NotebookEdit'].includes(name) ? 'edit'
      : name === 'Agent' || name === 'Task' ? 'agent' : 'tool';
    try { o.onActionStart?.(id, kind); } catch { /* advisory callback */ }
  };
  const event = (ev: Json) => {
    lastEvent = str(ev.type) ?? 'unknown';
    if (ev.type === 'stream_event' && !ev.parent_tool_use_id && obj(ev.event)) {
      if (ev.event.type === 'message_start') { partialAnswer = ''; newTextBlock = true; status({ phase: 'Thinking' }); }
      if (ev.event.type === 'content_block_start' && obj(ev.event.content_block)) {
        if (ev.event.content_block.type === 'text') newTextBlock = true;
        if (ev.event.content_block.type === 'tool_use') actionStart(ev.event.content_block);
      }
      if (ev.event.type === 'content_block_delta' && obj(ev.event.delta) &&
          ev.event.delta.type === 'text_delta' && typeof ev.event.delta.text === 'string') {
        partialAnswer += ev.event.delta.text;
        answer = partialAnswer;
        status({ phase: 'Responding' });
        try { o.onTextDelta?.(ev.event.delta.text, newTextBlock); } catch { /* advisory callback */ }
        newTextBlock = false;
      }
    }
    if (ev.type === 'system' && ev.subtype === 'init') {
      status({ phase: 'Thinking', ...(typeof ev.model === 'string' && ev.model ? { model: ev.model } : {}) });
      // Report only server identity and normalized status. Error payloads can
      // contain command arguments, environment values, or authentication URLs.
      const serverLabel = (value: unknown) => {
        const name = str(value);
        return name ? stripAnsi(name).replace(/[\r\n\t]/g, ' ').slice(0, 100) : '(unknown server)';
      };
      const startupError = (name?: unknown) => warn(`MCP server ${serverLabel(name)} startup failed`);
      if (Array.isArray(ev.mcp_servers)) {
        for (const server of ev.mcp_servers) {
          if (!obj(server)) continue;
          const status = (str(server.status) ?? '').toLowerCase().replace(/[_\s]+/g, '-');
          const name = server.name ?? server.server_name;
          if (['failed', 'error', 'errored'].includes(status)) startupError(name);
          else if (['needs-auth', 'auth-required', 'authentication-required', 'unauthenticated'].includes(status)) {
            warn(`MCP server ${serverLabel(name)} requires authentication`);
          }
        }
      }
      const errors = ev.mcp_server_errors;
      if (Array.isArray(errors)) {
        for (const entry of errors) startupError(obj(entry) ? entry.name ?? entry.server_name ?? entry.server : undefined);
      } else if (obj(errors)) {
        // Accept a single named error as well as a server-name -> error map.
        const name = str(errors.name) ?? str(errors.server_name) ?? str(errors.server);
        if (name) startupError(name);
        else for (const name of Object.keys(errors)) startupError(name);
      } else if (typeof errors === 'string' && errors.trim()) startupError();
    }
    // Subagent events can have their own session IDs; only parent init/result owns ours.
    if ((ev.type === 'system' && ev.subtype === 'init') || ev.type === 'result') {
      const id = str(ev.session_id);
      if (id) {
        const expected = o.expectedSessionId ?? sessionId;
        if (expected && expected !== id) mismatch = `Claude session mismatch: expected ${expected}, received ${id}`;
        else sessionId = id;
      }
    }
    if (ev.type === 'assistant' && obj(ev.message) && Array.isArray(ev.message.content)) {
      const text: string[] = [];
      for (const block of ev.message.content) {
        if (!obj(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
        if (block.type === 'tool_use') {
          if (!ev.parent_tool_use_id) actionStart(block);
          const name = str(block.name) ?? 'unknown';
          const id = str(block.id);
          if (id && tools.has(id)) continue;
          if (id) tools.add(id);
          if (name === 'Bash' || name === 'PowerShell') activity.commands++;
          if (name.startsWith('mcp__')) activity.mcp_tool_calls.push(name);
          if (name === 'Agent' || name === 'Task') activity.subagent_events++;
          lastEvent = `tool:${name}`;
          if (!ev.parent_tool_use_id) {
            const phase = name === 'Bash' || name === 'PowerShell' ? 'Running a command'
              : ['Read', 'Glob', 'Grep', 'LS'].includes(name) ? 'Reading files'
              : ['Edit', 'Write', 'NotebookEdit'].includes(name) ? 'Editing files'
              : name === 'Agent' || name === 'Task' ? 'Working with an agent' : 'Using a tool';
            status({ phase });
          }
        }
      }
      if (text.length && !ev.parent_tool_use_id) answer = text.join('\n');
      if (ev.error) failure = message(ev.error);
    }
    if (ev.type === 'user' && !ev.parent_tool_use_id && obj(ev.message) && Array.isArray(ev.message.content)) {
      let completed = false;
      for (const block of ev.message.content) if (obj(block) && block.type === 'tool_result') {
        completed = true;
        const id = str(block.tool_use_id);
        if (id) try { o.onActionEnd?.(id, block.is_error === true); } catch { /* advisory callback */ }
      }
      if (completed) status({ phase: 'Thinking' });
    }
    if (ev.type === 'result') {
      resultSeen = true;
      if (typeof ev.total_cost_usd === 'number' && Number.isFinite(ev.total_cost_usd) && ev.total_cost_usd >= 0) totalCostUsd = ev.total_cost_usd;
      if (obj(ev.usage)) {
        const fields = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
        const values: Record<string, number> = {};
        for (const field of fields) {
          const value = ev.usage[field];
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0) values[field] = value;
        }
        if (Object.keys(values).length) usage = values;
      }
      if (typeof ev.result === 'string' && ev.result.trim()) answer = ev.result;
      if (ev.is_error === true || (typeof ev.subtype === 'string' && ev.subtype !== 'success')) {
        failure = Array.isArray(ev.errors) && ev.errors.length
          ? ev.errors.map(message).join('; ')
          : str(ev.result) || `Claude run failed (${str(ev.subtype) ?? 'error'})`;
      }
      if (Array.isArray(ev.permission_denials)) {
        for (const denial of ev.permission_denials) warn(`Permission denied: ${obj(denial) ? str(denial.tool_name) ?? message(denial) : message(denial)}`);
      }
    }
    if (ev.type === 'error') failure = message(ev.error ?? ev.message ?? 'Claude reported an error');
    progress();
  };
  const stdoutLine = (line: string) => {
    if (!line.trim()) return;
    try { const value: unknown = JSON.parse(line); if (obj(value)) { event(value); return; } } catch { /* diagnostics */ }
    diagnostic(`[stdout] ${line}`);
  };
  const splitter = (consume: (s: string) => void) => {
    let buffer = '';
    return {
      push(chunk: string) {
        buffer += chunk;
        let i: number;
        while ((i = buffer.indexOf('\n')) >= 0) {
          consume(buffer.slice(0, i));
          buffer = buffer.slice(i + 1);
        }
      },
      flush() { if (buffer) consume(buffer); buffer = ''; },
    };
  };

  if (o.signal?.aborted) cancelled = true;
  else {
    try {
      const child = spawn(o.command.file, [...o.command.prefixArgs, ...o.args], {
        cwd: o.cwd, env: o.env, shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      });
      const out = splitter(stdoutLine);
      const err = splitter(diagnostic);
      await new Promise<void>((resolve) => {
        let settled = false;
        let killing: Promise<void> | undefined;
        let exitGrace: NodeJS.Timeout | undefined;
        let killGuard: NodeJS.Timeout | undefined;
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(heartbeat);
          clearTimeout(exitGrace);
          clearTimeout(killGuard);
          o.signal?.removeEventListener('abort', abort);
          out.flush(); err.flush();
          (killing ?? Promise.resolve()).then(resolve, resolve);
        };
        const kill = () => {
          if (killing) return;
          killing = killTree(child).catch((e: unknown) => { warn(`Process cleanup failed: ${message(e)}`); });
          void killing.then(() => {
            if (settled) return;
            killGuard = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); settle(); }, 5_000);
          });
        };
        const abort = () => { cancelled = true; kill(); };
        const timer = setTimeout(() => { timedOut = true; kill(); }, Math.max(1, o.timeoutMs));
        const heartbeat = setInterval(() => progress(true), 15_000);
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', (s: string) => out.push(s));
        child.stderr.on('data', (s: string) => err.push(s));
        child.stdout.on('error', () => {}); child.stderr.on('error', () => {});
        child.stdin.on('error', () => {});
        child.once('error', (e) => { if (child.pid === undefined) { spawnError = e; settle(); } });
        child.once('exit', (code, signal) => {
          exitCode = code; exitSignal = signal;
          exitGrace = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); settle(); }, 3_000);
        });
        child.once('close', (code, signal) => {
          if (!spawnError) { exitCode = code; exitSignal = signal; }
          settle();
        });
        o.signal?.addEventListener('abort', abort, { once: true });
        if (o.signal?.aborted) abort();
        try { child.stdin.end(o.stdin, 'utf8'); } catch { /* process exited */ }
      });
    } catch (e) { spawnError = e as Error; }
  }

  let error = spawnError ? `Failed to start Claude (${o.command.file}): ${spawnError.message}`
    : cancelled ? 'Claude run was cancelled'
    : timedOut ? `Claude timed out after ${Math.round(o.timeoutMs / 1000)}s`
    : mismatch ?? failure;
  if (!error && exitCode !== null && exitCode !== 0) error = `Claude exited with code ${exitCode}`;
  if (!error && exitSignal) error = `Claude was terminated by signal ${exitSignal}`;
  if (!error && !resultSeen) error = 'Claude exited without a result event';
  if (spawnError) exitCode = null;
  answer = stripAnsi(answer).replace(/^\uFEFF/, '');
  let answerFile: string | undefined;
  if (answer.length > MAX_ANSWER_CHARS) {
    try {
      await fs.mkdir(path.dirname(o.outputFile), { recursive: true });
      await fs.writeFile(o.outputFile, answer, 'utf8');
      answerFile = o.outputFile;
    } catch (e) { warn(`Could not save full answer: ${message(e)}`); }
    answer = answer.slice(0, MAX_ANSWER_CHARS) + (answerFile ? `\n\n[truncated — full answer at ${answerFile}]` : '\n\n[truncated]');
  }
  if (!error && !answer.trim()) warn('Claude finished without producing an answer');
  return { sessionId, answer, answerFile, durationSec: elapsedSec(), warnings, error, exitCode, timedOut, stderrTail: stderr.join('\n'), activity,
    ...(totalCostUsd === undefined ? {} : { totalCostUsd }), ...(usage ? { usage } : {}) };
}
