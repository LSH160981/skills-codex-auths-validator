export function hasQuota(payload) {
  const rl = payload?.rate_limit || {};
  const cr = payload?.code_review_rate_limit || {};
  const windows = [rl.primary_window, rl.secondary_window, cr.primary_window, cr.secondary_window].filter(Boolean);
  const used = windows
    .map((w) => (typeof w.used_percent === 'number' ? w.used_percent : null))
    .filter((v) => v !== null);

  const noQuota =
    rl.limit_reached === true ||
    cr.limit_reached === true ||
    used.some((v) => v >= 100);

  return !noQuota;
}

import { CODEX_USAGE_URL, CODEX_USER_AGENT } from './constants.mjs';

export async function validateCodexByApi(token, account, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(CODEX_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': CODEX_USER_AGENT,
        'Chatgpt-Account-Id': account,
      },
      signal: controller.signal,
    });

    const body = await resp.text();
    if (resp.status === 401 || resp.status === 403) {
      return { kind: 'invalid', reason: `auth_${resp.status}` };
    }
    if (resp.status === 429) {
      return { kind: 'no_quota', reason: 'rate_or_quota_429' };
    }
    if (resp.status >= 500) {
      return { kind: 'transient', reason: `status_${resp.status}` };
    }
    if (resp.status !== 200) {
      return { kind: 'transient', reason: `status_${resp.status}` };
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return { kind: 'transient', reason: 'invalid_usage_json' };
    }

    return hasQuota(payload)
      ? { kind: 'quota', reason: 'ok_200' }
      : { kind: 'no_quota', reason: 'ok_200_no_quota' };
  } catch (e) {
    const msg = String(e || '');
    if (msg.includes('AbortError')) return { kind: 'transient', reason: 'timeout' };
    return { kind: 'transient', reason: 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}
