import { MAX_ANSWER_CHARS } from './runner.js';

type RequestId = string | number;
export type RunIdentity = { prompt: string; cwd?: string; session_id?: string };
type Action = { id: string; kind: string; state: 'running' | 'done' | 'failed' | 'stopped' };
type Segment = { type: 'text'; text: string } | { type: 'actions'; actions: Action[] };
type LiveRun = { identity: RunIdentity; text: string; truncated: boolean; startedAt: number; finishedAt?: number; segments: Segment[]; revision: number; actionCount: number;
  phase: string; model?: string; effort?: string };
const runs = new Map<RequestId, LiveRun>();

// Request IDs are unique within an MCP connection. Match the tool input too, so
// a host that rewrites IDs cannot accidentally attach a card to a different run.
export function startLiveRun(id: RequestId | undefined, identity: RunIdentity) {
  if (id === undefined || runs.has(id)) return undefined;
  const run: LiveRun = { identity, text: '', truncated: false, startedAt: Date.now(), phase: 'Waiting', segments: [], revision: 0, actionCount: 0 };
  runs.set(id, run);
  return {
    append(text: string, newBlock = false) {
      if (run.truncated) return;
      const last = run.segments.at(-1);
      const newSegment = newBlock || last?.type !== 'text';
      const separator = newSegment && run.text && !run.text.endsWith('\n') && !text.startsWith('\n') ? '\n' : '';
      const available = MAX_ANSWER_CHARS - run.text.length - separator.length;
      if (text.length > available) run.truncated = true;
      if (available > 0) {
        let chunk = text.slice(0, available);
        if (chunk.length < text.length && /[\uD800-\uDBFF]$/.test(chunk)) chunk = chunk.slice(0, -1);
        if (!chunk) return;
        run.text += separator + chunk;
        if (newSegment) run.segments.push({ type: 'text', text: chunk });
        else if (last?.type === 'text') last.text += chunk;
        run.revision++;
      }
    },
    actionStart(id: string, kind: string) {
      if (run.actionCount >= 200) return;
      let last = run.segments.at(-1);
      if (last?.type !== 'actions') { last = { type: 'actions', actions: [] }; run.segments.push(last); }
      last.actions.push({ id, kind, state: 'running' }); run.actionCount++; run.revision++;
    },
    actionEnd(id: string, failed: boolean) {
      for (const segment of run.segments) if (segment.type === 'actions') {
        const action = segment.actions.find(value => value.id === id && value.state === 'running');
        if (action) { action.state = failed ? 'failed' : 'done'; run.revision++; return; }
      }
    },
    update(info: { phase?: string; model?: string; effort?: string }) { Object.assign(run, info); },
    finish() { run.finishedAt ??= Date.now(); for (const segment of run.segments) if (segment.type === 'actions') for (const action of segment.actions) {
      if (action.state === 'running') { action.state = 'stopped'; run.revision++; }
    } },
    close() { if (runs.get(id) === run) runs.delete(id); },
  };
}

export function readLiveRun(id: RequestId, identity: RunIdentity, offset: number, knownRevision?: number) {
  const run = runs.get(id);
  if (!run || run.identity.prompt !== identity.prompt || run.identity.cwd !== identity.cwd ||
      run.identity.session_id !== identity.session_id) return { available: false };
  if (offset > run.text.length) return { available: false };
  return { available: true, text: run.text.slice(offset), next_offset: run.text.length, truncated: run.truncated,
    elapsed_sec: Math.max(0, (run.finishedAt ?? Date.now()) - run.startedAt) / 1000,
    phase: run.phase, ...(knownRevision === run.revision ? {} : { segments: run.segments }), revision: run.revision,
    ...(run.model ? { model: run.model } : {}), ...(run.effort ? { effort: run.effort } : {}) };
}
