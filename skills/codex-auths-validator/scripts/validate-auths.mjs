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
const CONCURRENCY = Number(arg('concurrency', '40')) || 40;
const TIMEOUT_MS = Number(arg('timeout-ms', '12000')) || 12000;
const INVALID_ACTION = (arg('invalid-action', 'delete') || 'delete').toLowerCase(); // delete|quarantine

const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, '-');
const quarantine = path.join(DIR_QUOTA, `_quarantine_${stamp}`);

fs.mkdirSync(DIR_QUOTA, { recursive: true });
fs.mkdirSync(DIR_NO_QUOTA, { recursive: true });
if (INVALID_ACTION === 'quarantine') fs.mkdirSync(quarantine, { recursive: true });

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
      return { ok: false, reason: `auth_${resp.status}` };
    }
    if (resp.status === 429) {
      return { ok: true, quota: false, reason: 'rate_or_quota_429' };
    }
    if (resp.status !== 200) {
      return { ok: false, reason: `status_${resp.status}`, body: body.slice(0, 120) };
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return { ok: false, reason: 'invalid_usage_json' };
    }

    return { ok: true, quota: hasQuota(payload), reason: 'ok_200' };
  } catch (e) {
    const msg = String(e || '');
    if (msg.includes('AbortError')) return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'network_error' };
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
    const full = path.join(dir, file);

    if (file.startsWith('._')) {
      ops.push({ dir, file, action: 'invalid', reason: 'appledouble' });
      continue;
    }

    let json;
    try {
      json = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      ops.push({ dir, file, action: 'invalid', reason: 'invalid_json' });
      continue;
    }

    if ((json.type || '').toString().toLowerCase() !== 'codex') {
      ops.push({ dir, file, action: 'invalid', reason: 'non_codex' });
      continue;
    }

    const token = (json.access_token || '').toString().trim();
    const account = (json.account_id || '').toString().trim();
    if (!token || !account) {
      ops.push({ dir, file, action: 'invalid', reason: 'missing_token_or_account' });
      continue;
    }

    const chk = await validateByApi(token, account);
    if (!chk.ok) {
      ops.push({ dir, file, action: 'invalid', reason: chk.reason });
      continue;
    }

    if (chk.quota) {
      ops.push({ dir, file, action: 'to_quota', reason: chk.reason });
    } else {
      ops.push({ dir, file, action: 'to_no_quota', reason: chk.reason });
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

const migration = {};
const reasons = {};
let invalidDeleted = 0;
let invalidQuarantined = 0;

for (const op of ops) {
  const src = path.join(op.dir, op.file);
  if (!fs.existsSync(src)) continue;

  if (op.action === 'invalid') {
    reasons[op.reason] = (reasons[op.reason] || 0) + 1;
    if (INVALID_ACTION === 'quarantine') {
      safeMove(src, quarantine, op.file);
      invalidQuarantined += 1;
    } else {
      fs.unlinkSync(src);
      invalidDeleted += 1;
    }
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

const summary = {
  checkedTotal: files.length,
  final: {
    auths: finalQuota,
    auths_no_quota: finalNoQuota,
  },
  deleted: invalidDeleted,
  quarantined: invalidQuarantined,
  migration,
  reasons,
  invalidAction: INVALID_ACTION,
  quarantine: INVALID_ACTION === 'quarantine' ? quarantine : null,
};

if (INVALID_ACTION === 'quarantine') {
  fs.writeFileSync(path.join(quarantine, '_validation_report.json'), JSON.stringify(summary, null, 2));
}

console.log(JSON.stringify(summary, null, 2));