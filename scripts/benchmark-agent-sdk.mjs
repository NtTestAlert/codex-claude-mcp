// Opt-in live benchmark: uses the isolated Claude login and consumes Claude usage.
// Runs the same short conversation through a fresh CLI process per turn and a
// single persistent SDK session. It never prints prompts, credentials, or output.
import { spawn, execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { claudeHomePath, ensureHome } from '../dist/home.js';
import { resolveClaude } from '../dist/claudePath.js';

const execFileAsync = promisify(execFile);
const home = await ensureHome();
const configPath = path.join(claudeHomePath(), '.codex-claude-mcp', 'config.json');
let config = {};
try { config = JSON.parse(await fs.readFile(configPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const idleSec = config.sdk_idle_timeout_sec ?? 300;
if (!Number.isInteger(idleSec) || idleSec < 1 || idleSec > 86400) throw new Error('sdk_idle_timeout_sec must be an integer from 1 to 86400 for this benchmark');
const command = resolveClaude();
if (command.prefixArgs.length) throw new Error('Benchmark currently requires a native Claude executable, not a JS shim');
const env = { ...process.env, CLAUDE_CONFIG_DIR: home };
delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; delete env.CLAUDE_CODE_EFFORT_LEVEL;
const cwd = process.cwd();
const model = process.env.CLAUDE_BENCHMARK_MODEL || 'haiku';
const samplePid = async pid => {
  if (!pid) return undefined;
  try {
    if (process.platform === 'win32') {
      const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`], { windowsHide: true, timeout: 5000 });
      return Number(result.stdout.trim()) || undefined;
    }
    const result = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 5000 });
    return Number(result.stdout.trim()) * 1024 || undefined;
  } catch { return undefined; }
};
function sampler(pidFn) {
  let peak = 0, stopped = false;
  const loop = async () => {
    const bytes = await samplePid(pidFn());
    if (bytes) peak = Math.max(peak, bytes);
    if (!stopped) { const timer = setTimeout(loop, 700); timer.unref(); }
  };
  void loop();
  return { stop: () => { stopped = true; }, peak: () => peak || null };
}
const round = value => value == null ? null : Math.round(value);
async function cliTurn(sessionId, resume) {
  const start = performance.now();
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--tools', '',
    '--permission-mode', 'plan', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--settings', '{"disableAllHooks":true}', `--model=${model}`, '--effort=low',
    resume ? `--resume=${sessionId}` : `--session-id=${sessionId}`];
  const child = spawn(command.file, [...command.prefixArgs, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const memory = sampler(() => child.pid);
  let buffer = '', initMs, firstTextMs, result, diagnostics = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
  child.stdout.setEncoding('utf8').on('data', chunk => {
    buffer += chunk;
    let pos;
    while ((pos = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
      try {
        const event = JSON.parse(line);
        if (event.type === 'system' && event.subtype === 'init') initMs ??= performance.now() - start;
        if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') firstTextMs ??= performance.now() - start;
        if (event.type === 'result') result = event;
      } catch {}
    }
  });
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0 && result && !result.is_error) return resolve();
      const text = JSON.stringify(result?.errors ?? result?.result ?? '') + diagnostics;
      const reason = /certificate|self.signed|UNABLE_TO_VERIFY/i.test(text) ? 'TLS certificate error'
        : /auth|login|api.?key|credential/i.test(text) ? 'authentication error'
        : /unrecognized.model|model.*(?:unavailable|not found)/i.test(text) ? 'model unavailable'
        : /network|connect|ECONN|fetch failed/i.test(text) ? 'network error' : 'unclassified failure';
      reject(new Error(`CLI benchmark failed (exit ${code}, signal ${signal}, result ${result?.subtype ?? 'none'}, ${reason})`));
    });
  });
  const timeout = setTimeout(() => child.kill(), 120000);
  child.stdin.end(resume ? 'Reply with exactly OK again.' : 'Reply with exactly OK.');
  try { await finished; } finally { clearTimeout(timeout); memory.stop(); }
  return { init_ms: round(initMs), first_text_ms: round(firstTextMs), total_ms: round(performance.now() - start), peak_child_rss_bytes: memory.peak() };
}

const cliSession = randomUUID();
const cliControllerRss = process.memoryUsage().rss;
const cliFirst = await cliTurn(cliSession, false);
const cliFollow = await cliTurn(cliSession, true);
const sdkImportStart = performance.now();
const { WarmSdkSession } = await import('../dist/sdkWarm.js');
const sdkImportMs = performance.now() - sdkImportStart;
let sdkPid;
const sdkMemory = sampler(() => sdkPid);
const sdk = new WarmSdkSession({ cwd, env, model, effort: 'low', permissionMode: 'plan', tools: [], mcpServers: {}, strictMcpConfig: true,
  settings: { disableAllHooks: true }, systemPrompt: { type: 'preset', preset: 'claude_code' }, pathToClaudeCodeExecutable: command.file,
  spawnClaudeCodeProcess: options => {
    const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    sdkPid = child.pid;
    child.stderr.resume();
    return child;
  },
}, idleSec * 1000);
try {
  const sdkFirst = await sdk.turn('Reply with exactly OK.', 120000);
  const warmRss = await samplePid(sdkPid);
  const sdkFollow = await sdk.turn('Reply with exactly OK again.', 120000);
  console.log(JSON.stringify({ model, sdk_idle_timeout_sec: idleSec, sample_count: 1,
    measurements: { cli_first: cliFirst, cli_followup: cliFollow,
      sdk_import_ms: round(sdkImportMs),
      sdk_first: { init_ms: round(sdkFirst.startupMs), first_text_ms: round(sdkFirst.firstTextMs), total_ms: round(sdkFirst.elapsedMs), total_including_import_ms: round(sdkImportMs + sdkFirst.elapsedMs) },
      sdk_followup: { first_text_ms: round(sdkFollow.firstTextMs), total_ms: round(sdkFollow.elapsedMs) },
      sdk_child_idle_rss_bytes: warmRss ?? null, sdk_child_peak_rss_bytes: Math.max(sdkMemory.peak() ?? 0, warmRss ?? 0) || null,
      cli_controller_rss_bytes: cliControllerRss, sdk_controller_rss_bytes: process.memoryUsage().rss },
    note: 'Single sample. Child RSS excludes descendants; controller RSS is this benchmark process, not the MCP server. Tool sets and prompts are intentionally minimal.' }, null, 2));
} finally { sdkMemory.stop(); sdk.close(); }
