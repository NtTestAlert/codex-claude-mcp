// Explicit opt-in: two real Claude calls, billed to the configured Claude account/provider.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { checkAuth } from '../dist/auth.js';
import { claudeHomePath } from '../dist/home.js';
import { resolveClaude } from '../dist/claudePath.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.find(a => a.startsWith('--permission-mode='))?.split('=')[1] ?? 'manual';
const withoutAllowRules = process.argv.includes('--without-allow-rules');
if (!['manual', 'plan'].includes(mode)) throw new Error('Live check supports manual or plan mode.');
const home = claudeHomePath();
const auth = await checkAuth(resolveClaude(), home);
if (auth.status !== 'authenticated') throw new Error(`Isolated Claude authentication: ${auth.status}. Run node dist/index.js --auth-status.`);
const parent = path.join(root, '.tmp');
await fs.mkdir(parent, { recursive: true });
const temp = await fs.mkdtemp(path.join(parent, 'live-review-'));
const project = path.join(temp, 'project');
const source = path.join(temp, 'empty-source');
await Promise.all([fs.mkdir(project), fs.mkdir(source)]);
const git = (...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd: project, windowsHide: true, stdio: 'pipe' });
const client = new Client({ name: 'bridge-live-check', version: '1.0.0' });
let connected = false;
try {
  git('init');
  const file = path.join(project, 'calculator.js');
  await fs.writeFile(file, 'export function add(a, b) { return a + b; }\n');
  git('add', 'calculator.js');
  await fs.writeFile(file, 'export function add(a, b) { return a - b; }\n');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, 'dist', 'index.js')], cwd: root,
    env: { ...process.env, CLAUDE_BRIDGE_HOME: home, CLAUDE_BRIDGE_SOURCE_HOME: source }, stderr: 'pipe' });
  await client.connect(transport);
  connected = true;
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 240_000 });
    const out = response.structuredContent ?? JSON.parse(response.content.find(c => c.type === 'text').text);
    console.log(JSON.stringify({ tool: name, mode, ...out }, null, 2));
    if (out.error) throw new Error(out.error);
    if (!out.activity?.commands) throw new Error('Claude did not execute a shell command; live Git access remains unverified.');
    if ((out.warnings ?? []).some(w => /permission.*denied/i.test(w))) throw new Error('Claude reported a permission denial.');
    return out;
  };
  const first = await call('claude_ask', { cwd: project, permission_mode: mode,
    ...(withoutAllowRules ? {} : { allowed_tools: ['Bash(git diff *)'] }),
    model: process.env.CLAUDE_BRIDGE_LIVE_MODEL || 'sonnet', effort: 'low', timeout_sec: 180,
    prompt: 'Run exactly `git diff --no-ext-diff --no-textconv -- calculator.js` using your shell tool. Review the diff for a correctness regression. Do not edit anything, delegate, or use MCP tools. State the command result and the bug in at most three sentences. If denied, report the denial instead of inferring the diff from file reads.' });
  await fs.writeFile(file, 'export function add(a, b) { return a + b; }\n');
  const followup = await call('claude_followup', { session_id: first.session_id, timeout_sec: 180,
    prompt: 'The change has been fixed. Run exactly `git diff --no-ext-diff --no-textconv -- calculator.js` again using your shell tool, then state whether the previously reviewed regression remains. Do not edit anything or delegate. Keep your answer to two sentences.' });
  if (first.session_id !== followup.session_id) throw new Error('Session ID changed on follow-up.');
  console.log(`Live ${mode} review and follow-up completed on the same session.`);
} finally {
  if (connected) await client.close();
  await fs.rm(temp, { recursive: true, force: true });
}
