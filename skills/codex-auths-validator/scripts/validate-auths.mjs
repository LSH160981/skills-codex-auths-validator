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
const INVALID_ACTION = (arg('invalid-action', 'quarantine') || 'quarantine').toLowerCase(); // delete|quarantine

const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, '-');
const quarantine = path.join(DIR_QUOTA, `_quarantine_${stamp}`);

fs.mkdirSync(DIR_QUOTA, { recursive: true });
fs.mkdirSync(DIR_NO_QUOTA, { recursive: true });
fs.mkdirSync(DIR_INVALID, { recursive: true });
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

const KNOWN = new Set(['qwen', 'kimi', 'gemini', 'gemini-cli', 'aistudio', 'claude', 'codex', 'antigravity', 'iflow', 'vertex']);

function detectProvider(json) {
  const direct = (json.type || json.provider || '').toString().toLowerCase().trim();
  if (KNOWN.has(direct)) return direct;

  if (json.access_token && json.account_id) return 'codex';
  if (typeof json.api_key === 'string' && json.api_key.startsWith('AIza')) return 'gemini';
  if (typeof json.api_key === 'string' && json.api_key.startsWith('sk-ant-')) return 'claude';
  if (json.project_id && json.private_key && json.client_email) return 'vertex';
  if (json.refresh_token && (json.client_id || json.account_id)) return 'qwen';
  if (json.api_key || json.access_token || json.refresh_token) return 'unknown-token-style';
  return 'unknown';
}

function validateSchema(provider, json) {
  const hasAny = (...keys) => keys.some((k) => {
    const v = json[k];
    return typeof v === 'string' ? v.trim().length > 0 : Boolean(v);
  });

  switch (provider) {
    case 'codex':
      return hasAny('access_token') && hasAny('account_id')
        ? { ok: true }
        : { ok: false, reason: 'codex_missing_required_fields' };
    case 'gemini':
    case 'gemini-cli':
    case 'aistudio':
      return hasAny('api_key', 'access_token')
        ? { ok: true }
        : { ok: false, reason: `${provider}_missing_required_fields` };
    case 'claude':
      return hasAny('api_key', 'x_api_key', 'access_token')
        ? { ok: true }
        : { ok: false, reason: 'claude_missing_required_fields' };
    case 'vertex':
      return hasAny('project_id') && hasAny('private_key', 'access_token')
        ? { ok: true }
        : { ok: false, reason: 'vertex_missing_required_fields' };
    case 'qwen':
    case 'kimi':
    case 'iflow':
    case 'antigravity':
      return hasAny('access_token', 'api_key', 'refresh_token')
        ? { ok: true }
        : { ok: false, reason: `${provider}_missing_required_fields` };
    default:
      return hasAny('access_token', 'api_key', 'refresh_token')
        ? { ok: true, schemaOnly: true }
        : { ok: false, reason: 'unknown_provider_missing_required_fields' };
  }
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

async function validateCodexByApi(token, account) {
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
    const full = path.join(dir, file);

    if (file.startsWith('._')) {
      ops.push({ dir, file, provider: 'unknown', action: 'invalid', reason: 'appledouble', status: 'INVALID_APPLEDOUBLE' });
      continue;
    }

    let json;
    try {
      json = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      ops.push({ dir, file, provider: 'unknown', action: 'invalid', reason: 'invalid_json', status: 'INVALID_JSON' });
      continue;
    }

    const provider = detectProvider(json);
    const schema = validateSchema(provider, json);
    if (!schema.ok) {
      ops.push({ dir, file, provider, action: 'invalid', reason: schema.reason, status: 'INVALID_MISSING_FIELDS' });
      continue;
    }

    if (provider !== 'codex') {
      ops.push({ dir, file, provider, action: 'keep', reason: 'schema_valid_provider', status: 'SCHEMA_VALID_PROVIDER' });
      continue;
    }

    const token = (json.access_token || '').toString().trim();
    const account = (json.account_id || '').toString().trim();
    const chk = await validateCodexByApi(token, account);

    if (chk.kind === 'invalid') {
      ops.push({ dir, file, provider, action: 'invalid', reason: chk.reason, status: 'INVALID_AUTH' });
    } else if (chk.kind === 'quota') {
      ops.push({ dir, file, provider, action: 'to_quota', reason: chk.reason, status: 'VALID_QUOTA' });
    } else if (chk.kind === 'no_quota') {
      ops.push({ dir, file, provider, action: 'to_no_quota', reason: chk.reason, status: 'VALID_NO_QUOTA' });
    } else {
      ops.push({ dir, file, provider, action: 'keep', reason: chk.reason, status: 'TRANSIENT_KEEP' });
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

const migration = {};
const reasons = {};
const statusCount = {};
const providerStats = {};
let invalidDeleted = 0;
let invalidQuarantined = 0;
let invalidMovedToInvalidDir = 0;

for (const op of ops) {
  const src = path.join(op.dir, op.file);
  if (!fs.existsSync(src)) continue;

  statusCount[op.status] = (statusCount[op.status] || 0) + 1;
  providerStats[op.provider] = providerStats[op.provider] || { total: 0, statuses: {} };
  providerStats[op.provider].total += 1;
  providerStats[op.provider].statuses[op.status] = (providerStats[op.provider].statuses[op.status] || 0) + 1;

  if (op.action === 'invalid') {
    reasons[op.reason] = (reasons[op.reason] || 0) + 1;
    if (INVALID_ACTION === 'quarantine') {
      safeMove(src, quarantine, op.file);
      invalidQuarantined += 1;
    } else {
      safeMove(src, DIR_INVALID, op.file);
      invalidMovedToInvalidDir += 1;
    }
    continue;
  }

  const targetDir = op.action === 'to_quota' ? DIR_QUOTA : op.action === 'to_no_quota' ? DIR_NO_QUOTA : op.dir;
  if (op.dir !== targetDir) {
    safeMove(src, targetDir, op.file);
    const key = `${op.dir}->${targetDir}`;
    migration[key] = (migration[key] || 0) + 1;
  }
}

const summary = {
  checkedTotal: files.length,
  final: {
    auths: listJson(DIR_QUOTA).length,
    auths_no_quota: listJson(DIR_NO_QUOTA).length,
    auths_invalid: listJson(DIR_INVALID).length,
  },
  invalidDeleted,
  invalidQuarantined,
  invalidMovedToInvalidDir,
  migration,
  reasons,
  statusCount,
  providerStats,
  invalidAction: INVALID_ACTION,
  quarantine: INVALID_ACTION === 'quarantine' ? quarantine : null,
  invalidDir: DIR_INVALID,
};

if (INVALID_ACTION === 'quarantine') {
  fs.writeFileSync(path.join(quarantine, '_validation_report.json'), JSON.stringify(summary, null, 2));
}

console.log(JSON.stringify(summary, null, 2));