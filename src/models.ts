import { spawn } from 'node:child_process';
import { killTree } from './killTree.js';
import type { ClaudeCommand } from './claudePath.js';

export interface ClaudeModel { value: string; display_name: string; resolved_model?: string; supported_effort_levels?: string[] }
export interface ModelCatalog { status: 'available' | 'unavailable'; models: ClaudeModel[]; checked_at: string; warning?: string }

// The CLI's control initialization returns the same model list exposed by the
// Agent SDK's supportedModels(). No user message or model request is sent.
export async function discoverModels(command: ClaudeCommand, home: string, options: {
  cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number;
} = {}): Promise<ModelCatalog> {
  const checked_at = new Date().toISOString();
  const unavailable = (warning: string): ModelCatalog => ({ status: 'unavailable', models: [], checked_at, warning });
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), CLAUDE_CONFIG_DIR: home };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  let data = '', failure = '', models: ClaudeModel[] | undefined;
  const clean = (value: unknown, limit: number): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const s = value.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
    return s && s.length <= limit && /^[\p{L}\p{N} ._\-()[\]\/+:]+$/u.test(s) ? s : undefined;
  };
  try {
    const child = spawn(command.file, [...command.prefixArgs, '-p', '--input-format', 'stream-json',
      '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}'], {
      cwd: options.cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'],
    });
    await new Promise<void>(resolve => {
      let done = false, killing: Promise<void> | undefined;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); (killing ?? Promise.resolve()).then(resolve, resolve); };
      const stop = (reason?: string) => {
        if (done || killing) return;
        if (reason) failure = reason;
        killing = killTree(child).catch(() => {});
        void killing.then(() => { child.stdout.destroy(); finish(); });
      };
      const timer = setTimeout(() => stop('Model discovery timed out.'), options.timeoutMs ?? 6000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        data += chunk;
        if (data.length > 1_000_000) { stop('Model discovery response exceeded the size limit.'); return; }
        let newline: number;
        while ((newline = data.indexOf('\n')) >= 0) {
          const line = data.slice(0, newline); data = data.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            if (event?.type !== 'control_response' || event.response?.request_id !== 'model-catalog') continue;
            if (event.response.subtype !== 'success' || !Array.isArray(event.response.response?.models)) {
              stop('Claude did not return a model catalogue.'); return;
            }
            models = event.response.response.models.slice(0, 100).flatMap((entry: any) => {
              const value = clean(entry?.value, 200), display_name = clean(entry?.displayName, 200);
              if (!value || !display_name) return [];
              const resolved_model = clean(entry.resolvedModel, 200);
              const supported_effort_levels = Array.isArray(entry.supportedEffortLevels)
                ? entry.supportedEffortLevels.map((v: unknown) => clean(v, 32)).filter(Boolean).slice(0, 10) : undefined;
              return [{ value, display_name, ...(resolved_model ? { resolved_model } : {}),
                ...(supported_effort_levels ? { supported_effort_levels } : {}) }];
            });
            if (!models?.length) { stop('Claude returned an empty or unsupported model catalogue.'); return; }
            stop(); return;
          } catch { /* Ignore unrelated output, including non-JSON diagnostics. */ }
        }
      });
      child.stdout.on('error', () => {});
      child.stdin.on('error', () => {});
      child.once('error', () => { failure = 'Could not start Claude model discovery.'; finish(); });
      child.once('close', () => { if (!models && !failure) failure = 'Claude did not return a model catalogue.'; finish(); });
      child.stdin.end(JSON.stringify({ type: 'control_request', request_id: 'model-catalog', request: { subtype: 'initialize' } }) + '\n');
    });
  } catch { failure = 'Could not start Claude model discovery.'; }
  return models?.length && !failure ? { status: 'available', models, checked_at } : unavailable(failure || 'Model discovery failed.');
}

export function modelGuidance(catalog: ModelCatalog): string {
  if (catalog.status !== 'available') return 'Model discovery unavailable. Use claude_list_models with refresh=true before selecting a version; never invent a model ID. Pass a known alias or full provider ID if discovery still fails.';
  const lines = catalog.models.slice(0, 20).map(m => `${m.display_name}: ${m.value}${m.resolved_model ? ` (${m.resolved_model})` : ''}`);
  return `Claude Code model names and exact IDs: ${lines.join('; ')}. For a specific version use its exact resolved ID, never invent a shorthand. Availability can vary; call claude_list_models for the complete or refreshed list.`;
}

/** Repair only a versioned shorthand if it uniquely matches a discovered ID. */
export function resolveModelShorthand(model: string | undefined, catalog: ModelCatalog): string | undefined {
  if (!model || catalog.status !== 'available') return model;
  const match = /^([a-z]+)-(\d+)\.(\d+)$/i.exec(model);
  if (!match) return model;
  const suffix = `claude-${match[1]}-${match[2]}-${match[3]}`.toLowerCase();
  const ids = new Set(catalog.models.map(entry => entry.resolved_model).filter((id): id is string =>
    typeof id === 'string' && (id.toLowerCase() === suffix || id.toLowerCase().endsWith(`.${suffix}`))));
  return ids.size === 1 ? [...ids][0] : model;
}
