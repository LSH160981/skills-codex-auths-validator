#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

const DIR_QUOTA = arg('dir-quota', '/home/docker/CLIProxyAPI/auths');
const DIR_NO_QUOTA = arg('dir-no-quota', '/home/docker/CLIProxyAPI/auths_no_quota');
const DIR_INVALID = arg('dir-invalid', `${DIR_QUOTA}_invalid`);
const CONCURRENCY = Number(arg('concurrency', '40')) || 40;
const TIMEOUT_MS = Number(arg('timeout-ms', '12000')) || 12000;
const LOCK_FILE = arg('lock-file', '/tmp/codex-auths-hourly.lock');
const LOCK_MAX_AGE_MS = Number(arg('lock-max-age-ms', '900000')) || 900000;
const REPORT_DIR = arg('report-dir', '/home/docker/CLIProxyAPI/reports');

// 问题1：限制 reports 目录最大文件数，保留最近3天（72小时=72个文件）
const MAX_REPORT_FILES = Number(arg('max-report-files', '72')) || 72;

fs.mkdirSync(DIR_QUOTA, { recursive: true });
fs.mkdirSync(DIR_NO_QUOTA, { recursive: true });
fs.mkdirSync(DIR_INVALID, { recursive: true });
fs.mkdirSync(REPORT_DIR, { recursive: true });

// 问题1：启动时清理超出限制的旧 report 文件（按修改时间升序，删除最老的）
function pruneReportDir() {
  try {
    const files = fs.readdirSync(REPORT_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const full = path.join(REPORT_DIR, f);
        const mtime = fs.statSync(full).mtimeMs;
        return { file: f, full, mtime };
      })
      .sort((a, b) => a.mtime - b.mtime); // 最老的排最前面

    const excess = files.length - MAX_REPORT_FILES;
    if (excess > 0) {
      const toDelete = files.slice(0, excess);
      for (const { full } of toDelete) {
        try {
          fs.unlinkSync(full);
        } catch {
          // 忽略单个文件删除失败
        }
      }
      console.log(`已清理 ${excess} 个旧 report 文件（保留最近 ${MAX_REPORT_FILES} 个）`);
    }
  } catch {
    // 清理失败不影响主流程
  }
}

pruneReportDir();

let lockFd;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockInfo() {
  try {
    const body = fs.readFileSync(LOCK_FILE, 'utf8');
    const [pidLine, timeLine] = body.split('\n');
    const pid = Number(pidLine?.trim());
    const timestamp = Number(timeLine?.trim()) || 0;
    if (Number.isFinite(pid) && Number.isFinite(timestamp)) {
      return { pid, timestamp };
    }
  } catch {
    // ignore
  }
  return null;
}

function cleanStaleLock() {
  if (!fs.existsSync(LOCK_FILE)) return false;

  const info = readLockInfo();
  if (!info) return false;

  const age = Date.now() - info.timestamp;
  if (!isProcessAlive(info.pid) || age >= LOCK_MAX_AGE_MS) {
    try {
      fs.unlinkSync(LOCK_FILE);
      console.log('检测到过期锁，已清理，继续启动新任务。');
      return true;
    } catch {
      // ignore
    }
  }
  return false;
}

try {
  if (fs.existsSync(LOCK_FILE)) {
    if (!cleanStaleLock()) {
      console.log('已有任务在运行，跳过本次（避免并发导致统计波动）');
      process.exit(0);
    }
  }

  lockFd = fs.openSync(LOCK_FILE, 'wx');
  fs.writeFileSync(lockFd, `${process.pid}\n${Date.now()}\n`);
} catch (err) {
  console.log('已有任务在运行，跳过本次（避免并发导致统计波动）');
  process.exit(0);
}

function releaseLock() {
  try {
    fs.closeSync(lockFd);
  } catch {}
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {}
}

// ─── 公共工具函数 ───────────────────────────────────────────────────────────────

/**
 * 从 JWT id_token 中提取 payload.exp（Unix 秒）。
 * 纯手写 base64 decode，无外部依赖。失败返回 null。
 */
function getJwtExp(idToken) {
  try {
    if (typeof idToken !== 'string') return null;
    const parts = idToken.split('.');
    if (parts.length < 2) return null;
    // base64url → base64 → Buffer
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
function isTokenExpired(json) {
  const nowMs = Date.now();

  // 方法1：解 JWT exp（最权威）
  const jwtExp = getJwtExp(json.id_token);
  if (jwtExp !== null) {
    return jwtExp * 1000 < nowMs;
  }

  // 方法2：用 expired 字段
  const expiredStr = (json.expired || '').toString().trim();
  if (expiredStr) {
    const expiredTime = new Date(expiredStr).getTime();
    if (!isNaN(expiredTime)) return expiredTime < nowMs;
  }

  // 方法3：用 last_refresh 推算（假设 token 7天有效期）
  const refreshStr = (json.last_refresh || '').toString().trim();
  if (refreshStr) {
    const refreshTime = new Date(refreshStr).getTime();
    if (!isNaN(refreshTime)) return refreshTime + 7 * 24 * 3600 * 1000 < nowMs;
  }

  // 无法判断，默认未过期，走 API
  return false;
}

/**
 * 用 refresh_token 换新的 access_token。
 * 返回：更新后的 json 对象（成功）| null（refresh_token 也失效）| 'transient'（网络/5xx 临时错误）
 */
async function tryRefreshToken(json) {
  if (!json.refresh_token) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
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
      // 尝试解析 error 字段
      try {
        const body = await resp.json();
        if (body.error === 'invalid_grant' || body.error === 'invalid_token') return null;
      } catch {}
      return null;
    }
    if (resp.status >= 500) return 'transient';
    if (resp.status !== 200) return 'transient';

    let data;
    try { data = await resp.json(); } catch { return 'transient'; }

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

// ─── 工具函数结束 ────────────────────────────────────────────────────────────────

function listJson(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
}

function safeMove(src, dstDir, basename) {
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
  fs.renameSync(src, dst);
  return name;
}

function getUsedPercents(payload) {
  const rl = payload?.rate_limit || {};
  const cr = payload?.code_review_rate_limit || {};
  const windows = [rl.primary_window, rl.secondary_window, cr.primary_window, cr.secondary_window].filter(Boolean);
  return windows
    .map((w) => (typeof w.used_percent === 'number' ? w.used_percent : null))
    .filter((v) => v !== null);
}

function hasQuota(payload) {
  const rl = payload?.rate_limit || {};
  const cr = payload?.code_review_rate_limit || {};
  const used = getUsedPercents(payload);

  const noQuota =
    rl.limit_reached === true ||
    cr.limit_reached === true ||
    used.some((v) => v >= 100);

  return !noQuota;
}

async function validateByApi(token, account) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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

/**
 * 去重：扫描多个目录，对比 account_id 字段，保留每个 account 的第一个文件，其余移入 DIR_INVALID。
 * 返回去重删除数。
 *
 * 问题4：优先级原则 ——
 *   dirs 数组传入顺序为 [DIR_QUOTA, DIR_NO_QUOTA]，先扫 DIR_QUOTA 再扫 DIR_NO_QUOTA。
 *   因此当同一 account 在两个目录都有文件时，保留有额度（DIR_QUOTA）的那个，
 *   DIR_NO_QUOTA 中的重复项会被移入 DIR_INVALID。
 */
function deduplicateByAccount(dirs) {
  const seen = new Map(); // account_id -> { dir, file }
  const toRemove = [];

  for (const dir of dirs) {
    for (const file of listJson(dir)) {
      const full = path.join(dir, file);
      let json;
      try {
        json = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch {
        continue; // 格式错误的在后续流程处理
      }
      const account = (json.account_id || '').toString().trim();
      if (!account) continue;

      if (seen.has(account)) {
        toRemove.push({ dir, file, account });
      } else {
        seen.set(account, { dir, file });
      }
    }
  }

  let removed = 0;
  for (const { dir, file } of toRemove) {
    const src = path.join(dir, file);
    if (fs.existsSync(src)) {
      safeMove(src, DIR_INVALID, file);
      removed += 1;
    }
  }
  return removed;
}

const dedupRemoved = deduplicateByAccount([DIR_QUOTA, DIR_NO_QUOTA]);

const files = [
  ...listJson(DIR_QUOTA).map((f) => ({ dir: DIR_QUOTA, file: f })),
  ...listJson(DIR_NO_QUOTA).map((f) => ({ dir: DIR_NO_QUOTA, file: f })),
];

let idx = 0;
const ops = [];
let refreshedCount = 0;

async function worker() {
  while (true) {
    const i = idx++;
    if (i >= files.length) break;

    const { dir, file } = files[i];

    if (file.startsWith('._')) {
      ops.push({ dir, file, action: 'to_invalid', reason: 'appledouble' });
      continue;
    }

    const full = path.join(dir, file);
    let json;
    try {
      json = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      ops.push({ dir, file, action: 'to_invalid', reason: 'invalid_json' });
      continue;
    }

    if ((json.type || '').toString().toLowerCase() !== 'codex') {
      ops.push({ dir, file, action: 'to_invalid', reason: 'non_codex' });
      continue;
    }

    let token = (json.access_token || '').toString().trim();
    const account = (json.account_id || '').toString().trim();
    if (!token || !account) {
      ops.push({ dir, file, action: 'to_invalid', reason: 'missing_token_or_account' });
      continue;
    }

    let refreshedFlag = false;

    // 优化A+B：用 isTokenExpired 检查（JWT exp > expired > last_refresh+7天）
    // 如果过期：先尝试 tryRefreshToken 续期
    if (isTokenExpired(json)) {
      const refreshed = await tryRefreshToken(json);
      if (refreshed === 'transient') {
        ops.push({ dir, file, action: 'keep', reason: 'refresh_transient' });
        continue;
      } else if (refreshed === null) {
        ops.push({ dir, file, action: 'to_invalid', reason: 'INVALID_EXPIRED' });
        continue;
      } else {
        // 续期成功，写回文件，用新 token 继续走 API 校验
        fs.writeFileSync(full, JSON.stringify(refreshed, null, 2));
        json = refreshed;
        token = (refreshed.access_token || '').toString().trim();
        refreshedCount += 1;
        refreshedFlag = true;
      }
    }

    const chk = await validateByApi(token, account);
    if (chk.kind === 'invalid') {
      ops.push({ dir, file, action: 'to_invalid', reason: chk.reason });
    } else if (chk.kind === 'quota') {
      ops.push({ dir, file, action: 'to_quota', reason: refreshedFlag ? 'refreshed' : chk.reason });
    } else if (chk.kind === 'no_quota') {
      ops.push({ dir, file, action: 'to_no_quota', reason: refreshedFlag ? 'refreshed' : chk.reason });
    } else {
      ops.push({ dir, file, action: 'keep', reason: chk.reason });
    }
  }
}

try {
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const migration = {};
  const invalidReasons = {};
  const transientReasons = {};
  const invalidDetails = [];
  let invalidMoved = 0;
  let keptTransient = 0;

  for (const op of ops) {
    const src = path.join(op.dir, op.file);
    if (!fs.existsSync(src)) continue;

    if (op.action === 'to_invalid') {
      const movedName = safeMove(src, DIR_INVALID, op.file);
      invalidMoved += 1;
      invalidReasons[op.reason] = (invalidReasons[op.reason] || 0) + 1;
      invalidDetails.push({ from: op.dir, file: op.file, movedAs: movedName, reason: op.reason });
      const key = `${op.dir}->${DIR_INVALID}`;
      migration[key] = (migration[key] || 0) + 1;
      continue;
    }

    if (op.action === 'keep') {
      keptTransient += 1;
      transientReasons[op.reason] = (transientReasons[op.reason] || 0) + 1;
      continue;
    }

    const targetDir = op.action === 'to_quota' ? DIR_QUOTA : DIR_NO_QUOTA;
    if (op.dir !== targetDir) {
      safeMove(src, targetDir, op.file);
      const key = `${op.dir}->${targetDir}`;
      migration[key] = (migration[key] || 0) + 1;
    }
  }

  const finalQuota = listJson(DIR_QUOTA).length;
  const finalNoQuota = listJson(DIR_NO_QUOTA).length;
  const finalInvalid = listJson(DIR_INVALID).length;

  const summary = {
    checkedTotal: files.length,
    finalQuota,
    finalNoQuota,
    finalInvalid,
    invalidMoved,
    refreshedCount,
    migration,
    invalidReasons,
    keptTransient,
    transientReasons,
    invalidDir: DIR_INVALID,
    invalidDetails,
  };

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(REPORT_DIR, `hourly-reconcile-${ts}.json`), JSON.stringify(summary, null, 2));

  const migrationText = Object.keys(migration).length
    ? Object.entries(migration)
        .map(([k, v]) => `${k}: ${v}`)
        .join('，')
    : '无';
  const invalidReasonText = Object.keys(invalidReasons).length
    ? Object.entries(invalidReasons)
        .map(([k, v]) => `${k}: ${v}`)
        .join('，')
    : '无';
  const transientText = Object.keys(transientReasons).length
    ? Object.entries(transientReasons)
        .map(([k, v]) => `${k}: ${v}`)
        .join('，')
    : '无';

  console.log(`重复账户去重删除：${dedupRemoved} 个`);
  console.log(`总共检查：${summary.checkedTotal} 个`);
  console.log(`有效有额度（最终在 auths）：${summary.finalQuota}`);
  console.log(`有效无额度（最终在 auths_no_quota）：${summary.finalNoQuota}`);
  console.log(`无效已移入（最终在 auths_invalid）：${summary.invalidMoved}（当前库存 ${summary.finalInvalid}）`);
  console.log(`无效目录：${summary.invalidDir}`);
  console.log(`目录迁移统计：${migrationText}`);
  console.log(`无效原因统计：${invalidReasonText}`);
  console.log(`临时错误保留：${summary.keptTransient}（${transientText}）`);
  if (summary.invalidMoved > 0) {
    console.log('是否删除这些无效JSON？如需删除请回复：删除无效JSON');
  }
  // 问题5：invalid 目录积累超过500个时打印警告
  if (finalInvalid > 500) {
    console.log(`⚠️ auths_invalid 已积累 ${finalInvalid} 个文件，建议运行清理命令：rm -rf ${DIR_INVALID}/*`);
  }
} finally {
  releaseLock();
}
