/**
 * 从 JWT id_token 中提取 payload.exp（Unix 秒）。
 * 纯 Node.js base64 decode，无外部依赖。失败返回 null。
 */
export function getJwtExp(idToken) {
  try {
    if (typeof idToken !== 'string') return null;
    const parts = idToken.split('.');
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (b64.length % 4)) % 4;
    b64 += '='.repeat(pad);
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const payload = JSON.parse(decoded);
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * 判断 token 是否已过期。
 * 优先级：JWT exp > expired 字段 > last_refresh+7天 > 默认未过期
 */
export function isTokenExpired(json) {
  const nowMs = Date.now();

  const jwtExp = getJwtExp(json.id_token);
  if (jwtExp !== null) return jwtExp * 1000 < nowMs;

  const expiredStr = (json.expired || '').toString().trim();
  if (expiredStr) {
    const expiredTime = new Date(expiredStr).getTime();
    if (!isNaN(expiredTime)) return expiredTime < nowMs;
  }

  const refreshStr = (json.last_refresh || '').toString().trim();
  if (refreshStr) {
    const refreshTime = new Date(refreshStr).getTime();
    if (!isNaN(refreshTime)) return refreshTime + 7 * 24 * 3600 * 1000 < nowMs;
  }

  return false;
}

/**
 * 用 refresh_token 换新的 access_token。
 * 返回：更新后的 json 对象（成功）| null（refresh_token 也失效）| 'transient'（网络/5xx 临时错误）
 */
import { AUTH0_CLIENT_ID, AUTH0_TOKEN_URL } from './constants.mjs';

export async function tryRefreshToken(json) {
  if (!json.refresh_token) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(AUTH0_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: AUTH0_CLIENT_ID,
        refresh_token: json.refresh_token,
      }),
      signal: controller.signal,
    });

    if (resp.status === 401 || resp.status === 403) return null;

    if (resp.status >= 400 && resp.status < 500) {
      try {
        const body = await resp.json();
        if (body.error === 'invalid_grant' || body.error === 'invalid_token') return null;
      } catch {}
      return null;
    }

    if (resp.status >= 500) return 'transient';
    if (resp.status !== 200) return 'transient';

    let data;
    try {
      data = await resp.json();
    } catch {
      return 'transient';
    }

    if (!data.access_token) return null;

    const updated = { ...json };
    updated.access_token = data.access_token;
    updated.last_refresh = new Date().toISOString();
    if (typeof data.expires_in === 'number') {
      updated.expired = new Date(Date.now() + data.expires_in * 1000).toISOString();
    }
    if (data.id_token) updated.id_token = data.id_token;
    return updated;
  } catch (e) {
    const msg = String(e || '');
    if (msg.includes('AbortError')) return 'transient';
    return 'transient';
  } finally {
    clearTimeout(timer);
  }
}
