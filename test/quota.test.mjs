import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getQuota } from '../dist/quota.js';

async function profile(t, oauth) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-quota-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  if (oauth) await fs.writeFile(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
  return home;
}

test('reads both subscription windows and returns sanitized percentages and reset times', async t => {
  const home = await profile(t, { accessToken: 'secret-test-token', expiresAt: Date.now() + 60000 });
  const quota = await getQuota(home, async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(options.headers.authorization, 'Bearer secret-test-token');
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ five_hour: { utilization: 12.5, resets_at: '2026-10-28T10:00:00Z' },
      seven_day: { utilization: 70, resets_at: '2026-10-31T12:00:00Z' }, account: 'secret-account' }));
  });
  assert.equal(quota.status, 'available');
  assert.deepEqual(quota.five_hour, { used_percent: 12.5, remaining_percent: 87.5, resets_at: '2026-10-28T10:00:00.000Z' });
  assert.deepEqual(quota.seven_day, { used_percent: 70, remaining_percent: 30, resets_at: '2026-10-31T12:00:00.000Z' });
  assert.doesNotMatch(JSON.stringify(quota), /secret/);
});

test('handles missing or expired credentials and unavailable upstream responses', async t => {
  const absent = await profile(t);
  assert.equal((await getQuota(absent)).status, 'unavailable');
  const expired = await profile(t, { accessToken: 'secret', expiresAt: 1 });
  assert.match((await getQuota(expired)).error, /expired/);
  const home = await profile(t, { accessToken: 'secret', expiresAt: Date.now() + 60000 });
  assert.match((await getQuota(home, async () => new Response('', { status: 429 }))).error, /rate limited/);
  assert.match((await getQuota(home, async () => new Response('', { status: 401 }))).error, /401/);
  const failed = await getQuota(home, async () => { throw new Error('secret'); });
  assert.equal(failed.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(failed), /secret/);
  assert.equal((await getQuota(home, async () => new Response('{}'))).status, 'unavailable');
  const partial = await getQuota(home, async () => new Response(JSON.stringify({ five_hour: { utilization: 0, resets_at: null } })));
  assert.equal(partial.five_hour.remaining_percent, 100);
  assert.equal(partial.five_hour.resets_at, null);
  assert.equal(partial.seven_day, null);
});
