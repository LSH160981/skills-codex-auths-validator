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
const REPORT_DIR = arg('report-dir', '/home/docker/CLIProxyAPI/reports');

fs.mkdirSync(DIR_QUOTA, { recursive: true });
fs.mkdirSync(DIR_NO_QUOTA, { recursive: true });
fs.mkdirSync(DIR_INVALID, { recursive: true });
fs.mkdirSync(REPORT_DIR, { recursive: true });

let lockFd;
try {
  lockFd = fs.openSync(LOCK_FILE, 'wx');
  fs.writeFileSync(lockFd, `${process.pid}\n`);
} catch {
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

const files = [
  ...listJson(DIR_QUOTA).map((f) => ({ dir: DIR_QUOTA, file: f })),
  ...listJson(DIR_NO_QUOTA).map((f) => ({ dir: DIR_NO_QUOTA, file: f })),
];

let idx = 0;
const ops = [];

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

    const token = (json.access_token || '').toString().trim();
    const account = (json.account_id || '').toString().trim();
    if (!token || !account) {
      ops.push({ dir, file, action: 'to_invalid', reason: 'missing_token_or_account' });
      continue;
    }

    const chk = await validateByApi(token, account);
    if (chk.kind === 'invalid') {
      ops.push({ dir, file, action: 'to_invalid', reason: chk.reason });
    } else if (chk.kind === 'quota') {
      ops.push({ dir, file, action: 'to_quota', reason: chk.reason });
    } else if (chk.kind === 'no_quota') {
      ops.push({ dir, file, action: 'to_no_quota', reason: chk.reason });
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
} finally {
  releaseLock();
}
