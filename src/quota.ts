import { promises as fs } from 'node:fs';
import path from 'node:path';

type Window = { used_percent: number | null; remaining_percent: number | null; resets_at: string | null };
export type Quota = { status: 'available' | 'unavailable'; source: 'claude_subscription'; checked_at: string;
  five_hour: Window | null; seven_day: Window | null; error?: string };
type Fetch = typeof fetch;

// This is the undocumented endpoint used by Claude Code's subscription UI.
// Never expose credential contents, upstream bodies, or raw exception messages.
export async function getQuota(home: string, fetcher: Fetch = fetch): Promise<Quota> {
  const checked_at = new Date().toISOString();
  const unavailable = (error: string): Quota => ({ status: 'unavailable', source: 'claude_subscription', checked_at,
    five_hour: null, seven_day: null, error });
  let credentials: unknown;
  try { credentials = JSON.parse(await fs.readFile(path.join(home, '.credentials.json'), 'utf8')); }
  catch { return unavailable('Claude subscription credentials are unavailable in the isolated profile.'); }
  const oauth = (credentials as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } } | null)?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) return unavailable('No Claude subscription access token is available in the isolated profile.');
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= Date.now()) return unavailable('Claude subscription access token has expired; refresh the isolated Claude login.');
  try {
    const response = await fetcher('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET', headers: { authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return unavailable(response.status === 429 ? 'Claude usage endpoint is rate limited.' : `Claude usage endpoint returned HTTP ${response.status}.`);
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return unavailable('Claude usage endpoint returned an unsupported response.');
    const extract = (value: unknown): Window | null => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const data = value as { utilization?: unknown; resets_at?: unknown };
      const used = typeof data.utilization === 'number' && Number.isFinite(data.utilization) && data.utilization >= 0 ? data.utilization : null;
      const reset = typeof data.resets_at === 'string' && Number.isFinite(Date.parse(data.resets_at)) ? new Date(data.resets_at).toISOString() : null;
      return used === null && reset === null ? null : { used_percent: used, remaining_percent: used === null ? null : Math.max(0, 100 - used), resets_at: reset };
    };
    const raw = body as { five_hour?: unknown; seven_day?: unknown };
    const five_hour = extract(raw.five_hour), seven_day = extract(raw.seven_day);
    if (!five_hour && !seven_day) return unavailable('Claude did not report subscription usage windows for this account.');
    return { status: 'available', source: 'claude_subscription', checked_at, five_hour, seven_day };
  } catch { return unavailable('Could not retrieve Claude subscription usage.'); }
}
