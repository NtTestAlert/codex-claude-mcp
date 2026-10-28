import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { WarmSdkSession } from '../dist/sdkWarm.js';

function fakeFactory(state) {
  return ({ prompt }) => {
    state.created++;
    const stream = (async function* () {
      for await (const message of prompt) {
        state.prompts.push(message.message.content);
        if (state.prompts.length === 1) yield { type: 'system', subtype: 'init' };
        if (state.block) { await new Promise(resolve => { state.release = resolve; }); }
        yield { type: 'stream_event', parent_tool_use_id: null,
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } };
        yield { type: 'result', subtype: 'success', is_error: false, result: `answer ${state.prompts.length}`,
          session_id: 'test-session', total_cost_usd: 0.001 };
      }
    })();
    stream.close = () => { state.closed++; };
    return stream;
  };
}

test('SDK session reuses one process for sequential turns and expires after idle timeout', async () => {
  const state = { created: 0, closed: 0, prompts: [] };
  const session = new WarmSdkSession({}, 80, fakeFactory(state));
  const first = await session.turn('first', 1000);
  const second = await session.turn('second', 1000);
  assert.equal(first.answer, 'answer 1');
  assert.equal(second.answer, 'answer 2');
  assert.equal(first.sessionId, second.sessionId);
  assert.deepEqual(state.prompts, ['first', 'second']);
  assert.equal(state.created, 1);
  assert.equal(session.isClosed, false);
  await delay(130);
  assert.equal(session.isClosed, true);
  assert.equal(state.closed, 1);
  await assert.rejects(session.turn('late', 1000), /closed/);
});

test('SDK session rejects parallel turns and closes on timeout', async () => {
  const state = { created: 0, closed: 0, prompts: [], block: true };
  const session = new WarmSdkSession({}, 1000, fakeFactory(state));
  const first = session.turn('first', 100);
  await assert.rejects(session.turn('second', 100), /active turn/);
  await assert.rejects(first, /timed out/);
  assert.equal(session.isClosed, true);
  state.release?.();
});

test('an unused warm SDK session closes after its configured idle period', async () => {
  const state = { created: 0, closed: 0, prompts: [] };
  const session = new WarmSdkSession({}, 30, fakeFactory(state));
  await delay(70);
  assert.equal(session.isClosed, true);
  assert.equal(state.closed, 1);
});
