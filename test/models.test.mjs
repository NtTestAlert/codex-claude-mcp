import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { discoverModels, modelGuidance, resolveModelShorthand } from '../dist/models.js';

const fixture = fileURLToPath(new URL('./fixtures/model-discovery.mjs', import.meta.url));
const command = { file: process.execPath, prefixArgs: [fixture], source: fixture };

test('discovers model values and IDs without exposing account fields or unsafe metadata', async () => {
  const result = await discoverModels(command, 'isolated-home', { timeoutMs: 5000 });
  assert.equal(result.status, 'available');
  assert.deepEqual(result.models, [
    { value: 'haiku', display_name: 'Haiku', resolved_model: 'claude-haiku-5-5', supported_effort_levels: ['low', 'medium'] },
    { value: 'sonnet', display_name: 'Sonnet', resolved_model: 'claude-sonnet-5-5' },
  ]);
  assert.match(modelGuidance(result), /Haiku: haiku \(claude-haiku-5-5\)/);
  assert.doesNotMatch(JSON.stringify(result), /private@example|ignore instructions/);
});

test('resolves a versioned shorthand only against a unique discovered exact ID', () => {
  const catalog = { status: 'available', checked_at: '', models: [
    { value: 'haiku', display_name: 'Haiku 5.5', resolved_model: 'claude-haiku-5-5' },
    { value: 'sonnet', display_name: 'Sonnet 5.5', resolved_model: 'claude-sonnet-5-5' },
  ] };
  assert.equal(resolveModelShorthand('haiku-5.5', catalog), 'claude-haiku-5-5');
  assert.equal(resolveModelShorthand('haiku', catalog), 'haiku');
  assert.equal(resolveModelShorthand('haiku-5.6', catalog), 'haiku-5.6');
  assert.equal(resolveModelShorthand('claude-haiku-5-5', catalog), 'claude-haiku-5-5');
  assert.equal(resolveModelShorthand('haiku-5.5', { ...catalog, status: 'unavailable' }), 'haiku-5.5');
  assert.equal(resolveModelShorthand('haiku-5.5', { ...catalog, models: [...catalog.models,
    { value: 'aws', display_name: 'Haiku AWS', resolved_model: 'anthropic.claude-haiku-5-5' }] }), 'haiku-5.5');
});

test('discovery failure and timeout return an unavailable catalogue without leaking stderr', async () => {
  const failure = await discoverModels(command, 'isolated-home', { env: { ...process.env, FAKE_MODEL_DISCOVERY: 'error' }, timeoutMs: 5000 });
  assert.equal(failure.status, 'unavailable');
  assert.deepEqual(failure.models, []);
  assert.doesNotMatch(JSON.stringify(failure), /SECRET_TOKEN/);
  assert.match(modelGuidance(failure), /claude_list_models/);
  const timeout = await discoverModels(command, 'isolated-home', { env: { ...process.env, FAKE_MODEL_DISCOVERY: 'hang' }, timeoutMs: 500 });
  assert.equal(timeout.status, 'unavailable');
  assert.match(timeout.warning, /timed out/);
});
