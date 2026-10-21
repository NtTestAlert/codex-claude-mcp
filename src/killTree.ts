import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, ms);
    const onExit = () => {
      clearTimeout(t);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function taskkillPath(): string {
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'taskkill.exe');
}

function runTaskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      resolve();
    };
    const guard = setTimeout(finish, 10_000);
    try {
      const tk = spawn(taskkillPath(), ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      tk.once('error', finish);
      tk.once('exit', finish);
    } catch {
      finish();
    }
  });
}

/**
 * Kill a child process and all of its descendants.
 * Windows: `taskkill /PID <pid> /T /F`. POSIX: the child must have been spawned with `detached: true`
 * (process-group leader); the group gets SIGTERM, then SIGKILL after 3s.
 */
export async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    if (hasExited(child)) return; // pid may already be reused
    await runTaskkill(pid);
    if (!hasExited(child)) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    await waitForExit(child, 2000);
    return;
  }
  const signalGroup = (sig: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      try {
        if (!hasExited(child)) child.kill(sig);
      } catch {
        /* ignore */
      }
      return false;
    }
  };
  signalGroup('SIGTERM');
  await waitForExit(child, 3000);
  // Always follow up with SIGKILL on the group so lingering grandchildren die too.
  signalGroup('SIGKILL');
  await waitForExit(child, 2000);
}
