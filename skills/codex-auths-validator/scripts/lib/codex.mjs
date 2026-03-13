import fs from 'fs';
import path from 'path';
/**
 * 从 JWT id_token 中提取 payload.exp（Unix 秒）。失败返回 null。
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

  const jwtExp = getJwtExp(json?.id_token);
  if (jwtExp !== null) return jwtExp * 1000 < nowMs;

  const expiredStr = (json?.expired || '').toString().trim();
  if (expiredStr) {
    const t = new Date(expiredStr).getTime();
    if (!isNaN(t)) return t < nowMs;
  }

  const refreshStr = (json?.last_refresh || '').toString().trim();
  if (refreshStr) {
    const t = new Date(refreshStr).getTime();
    if (!isNaN(t)) return t + 7 * 24 * 3600 * 1000 < nowMs;
  }

  return false;
}

/**
 * 原子写 JSON：写临时文件再 rename，避免写一半崩溃导致文件损坏。
 */
export function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

/**
 * 跨文件系统安全移动：优先 rename，EXDEV 时 fallback copy+unlink。
 * 返回目标文件名（basename），目标存在时自动加后缀避免覆盖。
 */
export function safeMove(src, dstDir, basename) {
  let name = basename;
  const ext = path.extname(name);
  const stem = ext ? path.basename(name, ext) : name;
  let dst = path.join(dstDir, name);
  let n = 1;
  while (fs.existsSync(dst)) {
    name = `${stem}__moved${n}${ext}`;
    dst = path.join(dstDir, name);
    n += 1;
  }
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (err.code === 'EXDEV') {
      // 跨设备（如 /tmp → /home/docker），rename 不支持，fallback copy+unlink
      fs.copyFileSync(src, dst);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
  return name;
}

/**
 * 安全列出目录下所有 *.json 文件（排除目录和符号链接，只返回真实普通文件）。
 */
export function listJsonFiles(dir) {
  return fs.readdirSync(dir).filter((f) => {
    if (!f.endsWith('.json')) return false;
    try {
      const stat = fs.lstatSync(path.join(dir, f));
      return stat.isFile(); // 排除目录、symlink 等
    } catch {
      return false;
    }
  });
}

/**
 * 用 refresh_token 换新的 access_token。
 * 返回：更新后的 json 对象（成功）| null（refresh_token 也失效）| 'transient'（网络/5xx 临时错误）
 */
export async function tryRefreshToken(json, { timeoutMs = 15000 } = {}) {
  if (!json?.refresh_token) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch('https://auth0.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: 'pdlLIX2Y72MIl2rhLhTE9VV9bN905kBh',
        refresh_token: json.refresh_token,
      }),
      signal: controller.signal,
    });

    if (resp.status === 401 || resp.status === 403) return null;
    if (resp.status >= 400 && resp.status < 500) {
      try {
        const body = await resp.json();
        if (body?.error === 'invalid_grant' || body?.error === 'invalid_token') return null;
      } catch {}
      return null;
    }
    if (resp.status >= 500) return 'transient';
    if (resp.status !== 200) return 'transient';

    let data;
    try { data = await resp.json(); } catch { return 'transient'; }
    if (!data?.access_token) return null;

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

export function getUsedPercents(payload) {
  const rl = payload?.rate_limit || {};
  const cr = payload?.code_review_rate_limit || {};
  const windows = [rl.primary_window, rl.secondary_window, cr.primary_window, cr.secondary_window].filter(Boolean);
  return windows
    .map((w) => (typeof w.used_percent === 'number' ? w.used_percent : null))
    .filter((v) => v !== null);
}

export function hasQuota(payload) {
  const rl = payload?.rate_limit || {};
  const cr = payload?.code_review_rate_limit || {};
  const used = getUsedPercents(payload);

  const noQuota =
    rl.limit_reached === true ||
    cr.limit_reached === true ||
    used.some((v) => v >= 100);

  return !noQuota;
}

/**
 * 调用 codex usage API 校验。
 * treat429As: 'no_quota' | 'transient'
 */
export async function validateCodexUsageByApi(token, account, { timeoutMs = 12000, treat429As = 'no_quota' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal',
        'Chatgpt-Account-Id': account,
      },
      signal: controller.signal,
    });

    const body = await resp.text();

    if (resp.status === 401 || resp.status === 403) {
      return { kind: 'invalid', reason: `auth_${resp.status}` };
    }
    if (resp.status === 429) {
      return treat429As === 'transient'
        ? { kind: 'transient', reason: 'rate_limit_429' }
        : { kind: 'no_quota', reason: 'rate_or_quota_429' };
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
