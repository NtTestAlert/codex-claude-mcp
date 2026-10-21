import { spawn } from 'node:child_process';
import { killTree } from './killTree.js';

export interface AuthStatus {
  status: 'authenticated' | 'unauthenticated' | 'unknown';
  auth_method?: string;
  error?: string;
}

/** Query CLI authentication without invoking a model or returning account details. */
export async function checkAuth(
  command: { file: string; prefixArgs: string[] },
  home: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cwd?: string } = {},
): Promise<AuthStatus> {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), CLAUDE_CONFIG_DIR: home };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const requested = options.timeoutMs ?? 10_000;
  const timeoutMs = Number.isFinite(requested) ? Math.max(1, Math.min(60_000, requested)) : 10_000;
  let output = '';
  let error: string | undefined;
  let exitCode: number | null = null;
  try {
    const child = spawn(command.file, [...command.prefixArgs, 'auth', 'status', '--json'], {
      cwd: options.cwd, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'],
    });
    await new Promise<void>(resolve => {
      let settled = false;
      let killing: Promise<void> | undefined;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        (killing ?? Promise.resolve()).then(() => resolve(), () => resolve());
      };
      const stop = (reason: string) => {
        if (killing || settled) return;
        error = reason;
        killing = killTree(child).catch(() => {});
        void killing.then(() => { child.stdout.destroy(); settle(); });
      };
      const timer = setTimeout(() => stop('Claude authentication check timed out.'), timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (error) return;
        if (output.length + chunk.length > 65_536) stop('Claude authentication status exceeded the output limit.');
        else output += chunk;
      });
      child.stdout.on('error', () => {});
      child.once('error', () => { error = 'Could not start Claude authentication check.'; settle(); });
      child.once('exit', code => { exitCode = code; });
      child.once('close', () => settle());
    });
  } catch { error = 'Could not start Claude authentication check.'; }
  if (error) return { status: 'unknown', error };
  let value: unknown;
  try { value = JSON.parse(output.replace(/^\uFEFF/, '')); }
  catch { return { status: 'unknown', error: 'Claude returned an unsupported authentication status response.' }; }
  if (!value || typeof value !== 'object' || !('loggedIn' in value) || typeof value.loggedIn !== 'boolean') {
    return { status: 'unknown', error: 'Claude returned an unsupported authentication status response.' };
  }
  if (value.loggedIn && exitCode !== 0) return { status: 'unknown', error: 'Claude authentication status command failed.' };
  const authMethod = 'authMethod' in value && typeof value.authMethod === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value.authMethod)
    ? value.authMethod : undefined;
  return { status: value.loggedIn ? 'authenticated' : 'unauthenticated', ...(authMethod ? { auth_method: authMethod } : {}) };
}
