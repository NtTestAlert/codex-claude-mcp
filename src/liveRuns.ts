import { MAX_ANSWER_CHARS } from './runner.js';

type RequestId = string | number;
export type RunIdentity = { prompt: string; cwd?: string; session_id?: string };
type LiveRun = { identity: RunIdentity; text: string; truncated: boolean; startedAt: number; finishedAt?: number;
  phase: string; model?: string; effort?: string };
const runs = new Map<RequestId, LiveRun>();

// Request IDs are unique within an MCP connection. Match the tool input too, so
// a host that rewrites IDs cannot accidentally attach a card to a different run.
export function startLiveRun(id: RequestId | undefined, identity: RunIdentity) {
  if (id === undefined || runs.has(id)) return undefined;
  const run: LiveRun = { identity, text: '', truncated: false, startedAt: Date.now(), phase: 'Waiting' };
  runs.set(id, run);
  return {
    append(text: string) {
      if (run.truncated) return;
      const available = MAX_ANSWER_CHARS - run.text.length;
      if (text.length > available) run.truncated = true;
      if (available > 0) {
        let chunk = text.slice(0, available);
        if (chunk.length < text.length && /[\uD800-\uDBFF]$/.test(chunk)) chunk = chunk.slice(0, -1);
        run.text += chunk;
      }
    },
    update(info: { phase?: string; model?: string; effort?: string }) { Object.assign(run, info); },
    finish() { run.finishedAt ??= Date.now(); },
    close() { if (runs.get(id) === run) runs.delete(id); },
  };
}

export function readLiveRun(id: RequestId, identity: RunIdentity, offset: number) {
  const run = runs.get(id);
  if (!run || run.identity.prompt !== identity.prompt || run.identity.cwd !== identity.cwd ||
      run.identity.session_id !== identity.session_id) return { available: false };
  if (offset > run.text.length) return { available: false };
  return { available: true, text: run.text.slice(offset), next_offset: run.text.length, truncated: run.truncated,
    elapsed_sec: Math.max(0, (run.finishedAt ?? Date.now()) - run.startedAt) / 1000,
    phase: run.phase, ...(run.model ? { model: run.model } : {}), ...(run.effort ? { effort: run.effort } : {}) };
}
