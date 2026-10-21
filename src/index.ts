#!/usr/bin/env node
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveClaude } from './claudePath.js';
import { ensureHome, mainClaudeHome, loginCommand } from './home.js';
import { syncConfig } from './configSync.js';
import { readSession, writeSession, type SessionInfo } from './sessions.js';
import { runClaude } from './runner.js';
import { withThreadLock } from './lock.js';
import { checkAuth } from './auth.js';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const shutdown = new AbortController();
const inflight = new Set<Promise<unknown>>();
type Extra = { signal: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification(n: any): Promise<void> };
const permissions = ['manual', 'default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'] as const;
const common = {
  prompt: z.string().min(1).describe('Task or follow-up for Claude. Sent on stdin.'),
  model: z.string().min(1).optional().describe('Claude model alias or full model ID.'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  timeout_sec: z.number().int().min(10).max(3600).default(900),
};
type Input = { prompt: string; model?: string; effort?: string; timeout_sec: number; cwd?: string; session_id?: string; permission_mode?: typeof permissions[number]; allowed_tools?: string[] };
function result(out: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: Boolean(out.error) };
}

async function invoke(input: Input, extra: Extra) {
  const started = Date.now();
  let sessionId = input.session_id?.toLowerCase();
  try {
    if (shutdown.signal.aborted) throw new Error('Bridge is shutting down.');
    const home = await ensureHome();
    const command = resolveClaude();
    const signal = AbortSignal.any([extra.signal, shutdown.signal]);
    let info: SessionInfo;
    if (sessionId) {
      const saved = await readSession(home, sessionId);
      if (!saved) throw new Error('Unknown bridge session. Use a session_id returned by claude_ask.');
      info = saved;
    } else {
      sessionId = randomUUID();
      info = { session_id: sessionId, cwd: path.resolve(input.cwd!), permission_mode: input.permission_mode ?? 'manual', created_at: new Date().toISOString(), model: input.model, effort: input.effort, allowed_tools: input.allowed_tools };
    }
    if (!(await fs.stat(info.cwd).catch(() => undefined))?.isDirectory()) throw new Error(`Session working directory no longer exists: ${info.cwd}`);
    return await withThreadLock(home, sessionId, input.timeout_sec * 1000, async () => {
      // Re-read after taking the cross-process lock: an earlier follow-up may have updated model settings.
      if (input.session_id) info = (await readSession(home, sessionId!))!;
      if (!info) throw new Error('Session metadata disappeared while waiting for its lock.');
      const runsDirectory = path.join(home, '.codex-claude-mcp', 'runs');
      await fs.mkdir(runsDirectory, { recursive: true });
      const dir = await fs.mkdtemp(path.join(runsDirectory, 'run-'));
      let keep = false;
      try {
        // Each subprocess gets its own immutable config snapshot, even across bridge processes.
        const config = await syncConfig(mainClaudeHome(), home, dir);
        const remaining = input.timeout_sec * 1000 - (Date.now() - started);
        if (remaining <= 0) throw new Error('Request timed out while waiting for the session.');
        const model = input.model ?? info.model;
        const effort = input.effort ?? info.effort;
        const args = ['-p', '--output-format', 'stream-json', '--verbose',
          '--permission-mode', info.permission_mode,
          ...(info.allowed_tools?.length ? ['--allowedTools', ...info.allowed_tools] : []),
          '--strict-mcp-config', '--mcp-config', config.mcpConfigPath,
          '--settings', config.settingsPath,
          ...(input.session_id ? [`--resume=${sessionId}`] : [`--session-id=${sessionId}`]),
          ...(model ? [`--model=${model}`] : []), ...(effort ? [`--effort=${effort}`] : [])];
        // Save ownership before starting: a timeout or interrupted turn can still be resumed.
        await writeSession(home, { ...info, model, effort });
        const token = extra._meta?.progressToken;
        const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: home };
        // Parent Claude nesting markers must not make this independently spawned session look nested.
        delete env.CLAUDECODE;
        delete env.CLAUDE_CODE_ENTRYPOINT;
        if (effort) delete env.CLAUDE_CODE_EFFORT_LEVEL;
        const run = await runClaude({ command, args, cwd: info.cwd, env, stdin: input.prompt,
          expectedSessionId: sessionId, outputFile: path.join(dir, 'answer.txt'), timeoutMs: remaining, signal,
          onProgress: token === undefined ? undefined : ({ elapsedSec, lastEvent }) => {
            void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token,
              progress: Math.max(1, Math.round(elapsedSec)), message: `Claude running for ${Math.round(elapsedSec)}s${lastEvent ? ` (${lastEvent})` : ''}` } }).catch(() => {});
          } });
        keep = Boolean(run.answerFile);
        return result({ session_id: sessionId, answer: run.answer, duration_sec: run.durationSec,
          warnings: [...config.warnings, ...run.warnings], activity: run.activity,
          ...(run.answerFile ? { answer_file: run.answerFile } : {}),
          ...(run.error ? { error: `${run.error}${run.stderrTail ? `\n${run.stderrTail}` : ''}${
            /not logged in|invalid api.?key|authentication[_ ](?:failed|error)|oauth token.*(?:expired|invalid)|please run.*\/login/i.test(`${run.error}\n${run.stderrTail}`)
              ? `\nAuthenticate this profile: ${loginCommand(home)}` : ''}` } : {}) });
      } finally {
        // Config can contain MCP credentials; never retain it with a long answer.
        await Promise.all(['settings.json', 'mcp.json'].map(name => fs.rm(path.join(dir, name), { force: true })));
        if (!keep) await fs.rm(dir, { recursive: true, force: true });
      }
    }, signal);
  } catch (e) {
    return result({ session_id: sessionId ?? null, answer: '', duration_sec: (Date.now() - started) / 1000, warnings: [], error: (e as Error).message });
  }
}

const server = new McpServer({ name: 'codex-claude-mcp', version }, {
  instructions: 'Use claude_ask for an independent Claude Code opinion or delegated task. Save its session_id and use claude_followup for that conversation. Calls may take minutes. Claude may edit files; this bridge does not enforce read-only access. Do not recursively delegate back through another bridge.',
});
function tracked(input: Input, extra: Extra) {
  const promise = invoke(input, extra);
  inflight.add(promise);
  void promise.finally(() => inflight.delete(promise));
  return promise;
}
server.registerTool('claude_ask', {
  title: 'Ask Claude', description: 'Start an independent Claude Code session in a project. Claude can inspect the project and perform the requested task. Returns session_id for follow-ups. There is no enforced read-only sandbox.',
  inputSchema: { ...common, cwd: z.string().min(1),
    permission_mode: z.enum(permissions).default('manual').describe('Claude permission mode, fixed for this session. default is a legacy alias for manual; auto uses Claude policy. bypassPermissions explicitly skips Claude permission prompts.'),
    allowed_tools: z.array(z.string().min(1).regex(/^[A-Za-z][^\r\n\0]*$/)).max(100).optional().describe('Explicit Claude tool permission rules to pre-approve, preserved on follow-up. Example: ["Bash(git diff *)", "Bash(git status *)"]. These grant permissions, not a sandbox or tool visibility restriction.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, (input, extra) => tracked(input, extra as Extra));
server.registerTool('claude_followup', {
  title: 'Follow up with Claude', description: 'Continue a session returned by claude_ask, preserving its original directory and permission mode. Concurrent follow-ups on one session are serialized across bridge processes.',
  inputSchema: { ...common, session_id: z.string().uuid() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, (input, extra) => tracked(input, extra as Extra));

async function main() {
  if (process.argv.includes('--auth-status')) {
    const home = await ensureHome();
    const authentication = await checkAuth(resolveClaude(), home);
    console.log(JSON.stringify({ home, authentication,
      ...(authentication.status === 'authenticated' ? {} : { login: loginCommand(home) }) }, null, 2));
    process.exitCode = authentication.status === 'authenticated' ? 0 : authentication.status === 'unauthenticated' ? 1 : 2;
    return;
  }
  if (process.argv.includes('--doctor')) {
    const home = await ensureHome();
    const config = await syncConfig(mainClaudeHome(), home);
    const command = resolveClaude();
    const authentication = await checkAuth(command, home);
    console.log(JSON.stringify({ command, home, source_home: mainClaudeHome(), ...config,
      login: loginCommand(home), authentication }, null, 2));
    return;
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    shutdown.abort();
    const timer = setTimeout(() => process.exit(1), 15000);
    timer.unref();
    await Promise.allSettled(inflight);
    await server.close();
    clearTimeout(timer);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  process.stdin.once('end', () => void stop());
  process.stdin.once('close', () => void stop());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const close = transport.onclose;
  transport.onclose = () => { close?.(); void stop(); };
}
main().catch((e) => { console.error((e as Error).message); process.exitCode = 1; });
