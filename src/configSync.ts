import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

type JsonObject = Record<string, unknown>;
export interface SyncResult {
  warnings: string[];
  mcpConfigPath: string;
  settingsPath: string;
}

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  return normalize(a) === normalize(b);
}

/** Default Claude stores global state beside ~/.claude; custom profiles store it inside. */
export function globalConfigPath(home: string): string {
  const explicitlySelected = process.env.CLAUDE_CONFIG_DIR;
  if ((!explicitlySelected || !samePath(explicitlySelected, home)) && samePath(home, path.join(os.homedir(), '.claude'))) {
    return path.join(os.homedir(), '.claude.json');
  }
  return path.join(home, '.claude.json');
}

async function readObject(file: string): Promise<JsonObject> {
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    // Do not include OS error text or JSON snippets: configuration can contain secrets.
    throw new Error(`Cannot read configuration: ${file}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { throw new Error(`Invalid JSON configuration: ${file}`); }
  if (!object(parsed)) throw new Error(`Configuration must be a JSON object: ${file}`);
  return parsed;
}

async function writeAtomic(file: string, data: unknown): Promise<void> {
  const text = JSON.stringify(data, null, 2) + '\n';
  try { if (await fs.readFile(file, 'utf8') === text) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

/** Refresh before each call. Only generated files are written; Claude-owned state is untouched.
 * Source servers override isolated-profile servers. Deleted source entries disappear on refresh.
 * Authentication, project state, hooks, permissions and settings env are never copied.
 */
export async function syncConfig(sourceHome: string, targetHome: string, outputDirectory?: string): Promise<SyncResult> {
  if (samePath(sourceHome, targetHome)) throw new Error('Source and isolated Claude homes must differ');
  const directory = outputDirectory ?? path.join(targetHome, '.codex-claude-mcp');
  const result: SyncResult = {
    warnings: [],
    mcpConfigPath: path.join(directory, 'mcp.json'),
    settingsPath: path.join(directory, 'settings.json'),
  };
  // Read and validate all inputs before writing either output. Malformed inputs fail the call
  // instead of silently running with stale or unexpectedly unrestricted configuration.
  const [sourceSettings, targetSettings, sourceConfig, targetConfig] = await Promise.all([
    readObject(path.join(sourceHome, 'settings.json')),
    readObject(path.join(targetHome, 'settings.json')),
    readObject(globalConfigPath(sourceHome)),
    readObject(path.join(targetHome, '.claude.json')),
  ]);
  const settings: JsonObject = {};
  for (const key of ['model', 'effortLevel']) {
    const value = sourceSettings[key] ?? targetSettings[key];
    if (typeof value === 'string') settings[key] = value;
  }
  for (const config of [sourceConfig, targetConfig]) {
    if (config.mcpServers !== undefined && !object(config.mcpServers)) throw new Error('mcpServers must be a JSON object');
  }
  const excluded = new Set((process.env.CLAUDE_BRIDGE_MCP_EXCLUDE ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const servers: JsonObject = Object.create(null);
  for (const [name, definition] of Object.entries({ ...(targetConfig.mcpServers as JsonObject ?? {}), ...(sourceConfig.mcpServers as JsonObject ?? {}) })) {
    const launch = object(definition) ? [definition.command, ...(Array.isArray(definition.args) ? definition.args : [])].filter(v => typeof v === 'string').join(' ') : '';
    if (excluded.has(name.toLowerCase()) || /(?:cc-codex-mcp|codex-claude-mcp)/i.test(`${name} ${launch}`)) {
      result.warnings.push(`Excluded MCP server: ${name}`);
      continue;
    }
    if (!object(definition)) throw new Error(`Invalid MCP server definition: ${name}`);
    servers[name] = definition;
  }
  await writeAtomic(result.settingsPath, settings);
  await writeAtomic(result.mcpConfigPath, { mcpServers: servers });
  return result;
}
