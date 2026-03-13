#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

import { arg, numArg } from './lib/args.mjs';
import { deriveDirsFromAuthDir } from './lib/paths.mjs';

const AUTH_DIR = arg('auth-dir', '');
const derived = AUTH_DIR ? deriveDirsFromAuthDir(AUTH_DIR) : null;

const DIR_QUOTA = arg('dir-quota', derived?.quotaDir || '/home/docker/CLIProxyAPI/auths');
const DIR_NO_QUOTA = arg('dir-no-quota', derived?.noQuotaDir || '/home/docker/CLIProxyAPI/auths_no_quota');
const DIR_INVALID = arg('dir-invalid', derived?.invalidDir || `${DIR_QUOTA}_invalid`);
const CONCURRENCY = numArg('concurrency', 40);
const TIMEOUT_MS = numArg('timeout-ms', 12000);
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

import { validateCodexUsageByApi } from './lib/codex.mjs';
import { detectProvider, validateSchemaWithReason } from './lib/provider.mjs';


async function validateCodexByApi(token, account) {
  return validateCodexUsageByApi(token, account, { timeoutMs: TIMEOUT_MS, treat429As: 'no_quota' });
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
    const schema = validateSchemaWithReason(provider, json);
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

// ── 去重：先扫 DIR_QUOTA（有额度优先），再扫 DIR_NO_QUOTA，同一 account_id 保留有额度的 ──
{
  const seenAccounts = new Map();
  let dedupCount = 0;
  for (const scanDir of [DIR_QUOTA, DIR_NO_QUOTA]) {
    for (const file of fs.readdirSync(scanDir).filter((f) => f.endsWith('.json') && !f.startsWith('._'))) {
      const full = path.join(scanDir, file);
      let j;
      try { j = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
      const acc = (j.account_id || '').toString().trim();
      if (!acc) continue;
      if (seenAccounts.has(acc)) {
        safeMove(full, DIR_INVALID, file);
        dedupCount += 1;
      } else {
        seenAccounts.set(acc, full);
      }
    }
  }
  if (dedupCount > 0) console.error(`[dedup] 去重移除 ${dedupCount} 个重复 account_id 文件`);
}

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