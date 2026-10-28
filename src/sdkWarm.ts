import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type WarmTurn = { answer: string; sessionId: string; totalCostUsd?: number; startupMs?: number; firstTextMs?: number; elapsedMs: number };
type Pending = { started: number; startupMs?: number; firstTextMs?: number; answer: string;
  resolve: (value: WarmTurn) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type QueryFactory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

/** Experimental single-conversation process. It does not share a process between independent sessions. */
export class WarmSdkSession {
  private readonly controller = new AbortController();
  private readonly queued: SDKUserMessage[] = [];
  private notify?: () => void;
  private active?: Pending;
  private idleTimer?: NodeJS.Timeout;
  private readonly instance: Query;
  private closed = false;
  private readonly started = performance.now();
  private initMs?: number;

  constructor(options: Options, private readonly idleTimeoutMs: number, factory: QueryFactory = query) {
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 0) throw new Error('Invalid idle timeout');
    this.instance = factory({ prompt: this.messages(), options: { ...options, abortController: this.controller, includePartialMessages: true } });
    void this.consume();
    if (idleTimeoutMs) this.armIdleTimer();
  }

  private async *messages(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      if (!this.queued.length) await new Promise<void>(resolve => { this.notify = resolve; });
      while (this.queued.length) yield this.queued.shift()!;
    }
  }

  private async consume() {
    try {
      for await (const message of this.instance) this.receive(message);
      if (!this.closed) this.close(new Error('Claude SDK session ended unexpectedly'));
    } catch (error) {
      if (!this.closed) this.close(error instanceof Error ? error : new Error('Claude SDK session failed'));
    }
  }

  private receive(message: SDKMessage) {
    if (message.type === 'system' && message.subtype === 'init' && this.initMs === undefined) this.initMs = performance.now() - this.started;
    const turn = this.active;
    if (!turn) return;
    if (message.type === 'system' && message.subtype === 'init') turn.startupMs = this.initMs;
    if (message.type === 'stream_event' && !message.parent_tool_use_id && message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta') {
      turn.firstTextMs ??= performance.now() - turn.started;
      turn.answer += message.event.delta.text;
    }
    if (message.type !== 'result') return;
    clearTimeout(turn.timer);
    this.active = undefined;
    if (message.subtype !== 'success' || message.is_error) {
      turn.reject(new Error(`Claude returned ${message.subtype}`));
      this.close();
      return;
    }
    turn.resolve({ answer: message.result || turn.answer, sessionId: message.session_id, totalCostUsd: message.total_cost_usd,
      startupMs: turn.startupMs, firstTextMs: turn.firstTextMs, elapsedMs: performance.now() - turn.started });
    this.armIdleTimer();
  }

  async turn(prompt: string, timeoutMs: number): Promise<WarmTurn> {
    if (this.closed) throw new Error('Claude SDK session is closed');
    if (this.active) throw new Error('Claude SDK session already has an active turn');
    clearTimeout(this.idleTimer);
    return new Promise<WarmTurn>((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error('Claude SDK turn timed out')), timeoutMs);
      this.active = { started: performance.now(), answer: '', resolve, reject, timer };
      this.queued.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });
      this.notify?.(); this.notify = undefined;
    });
  }

  private armIdleTimer() {
    if (!this.idleTimeoutMs) { this.close(); return; }
    this.idleTimer = setTimeout(() => this.close(), this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  get isClosed() { return this.closed; }
  close(reason = new Error('Claude SDK session closed')) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    if (this.active) { clearTimeout(this.active.timer); this.active.reject(reason); this.active = undefined; }
    this.notify?.(); this.notify = undefined;
    this.controller.abort();
    this.instance.close();
  }
}
