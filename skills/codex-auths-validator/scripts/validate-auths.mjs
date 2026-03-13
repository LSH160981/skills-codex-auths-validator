#!/usr/bin/env node
// ─── imports 统一放顶部（ESM 静态 import 语义要求） ──────────────────────────────
import fs from 'fs';
import path from 'path';

import { arg, numArg } from './lib/args.mjs';
import { deriveDirsFromAuthDir } from './lib/paths.mjs';
import { validateCodexUsageByApi, safeMove, listJsonFiles, isTokenExpired, tryRefreshToken, writeJsonAtomic } from './lib/codex.mjs';
import { detectProvider, validateSchemaWithReason } from './lib/provider.mjs';

// ─── CLI 参数 ────────────────────────────────────────────────────────────────────
const AUTH_DIR = arg('auth-dir', '');
const derived = AUTH_DIR ? deriveDirsFromAuthDir(AUTH_DIR) : null;

const DIR_QUOTA    = arg('dir-quota',    derived?.quotaDir   || '/home/docker/CLIProxyAPI/auths');
const DIR_NO_QUOTA = arg('dir-no-quota', derived?.noQuotaDir || '/home/docker/CLIProxyAPI/auths_no_quota');
const DIR_INVALID  = arg('dir-invalid',  derived?.invalidDir || `${DIR_QUOTA}_invalid`);
const CONCURRENCY  = numArg('concurrency', 40);
const TIMEOUT_MS   = numArg('timeout-ms', 12000);
// delete: 移到 DIR_INVALID（不硬删）; quarantine: 隔离子目录（默认，更安全）
const INVALID_ACTION = (arg('invalid-action', 'quarantine') || 'quarantine').toLowerCase();

// ─── 初始化目录 ──────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const quarantine = path.join(DIR_QUOTA, `_quarantine_${stamp}`);

fs.mkdirSync(DIR_QUOTA,    { recursive: true });
fs.mkdirSync(DIR_NO_QUOTA, { recursive: true });
fs.mkdirSync(DIR_INVALID,  { recursive: true });
if (INVALID_ACTION === 'quarantine') fs.mkdirSync(quarantine, { recursive: true });

// ─── 主流程 ──────────────────────────────────────────────────────────────────────
const files = [
  ...listJsonFiles(DIR_QUOTA).map((f) => ({ dir: DIR_QUOTA, file: f })),
  ...listJsonFiles(DIR_NO_QUOTA).map((f) => ({ dir: DIR_NO_QUOTA, file: f })),
];

let idx = 0;
const ops = [];
let refreshedCount = 0;

async function worker() {
  while (true) {
    const i = idx++;
    if (i >= files.length) break;

    const { dir, file } = files[i];
    const full = path.join(dir, file);

    // AppleDouble 垃圾文件
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

    // Provider 检测 + schema 校验（非 codex 只做 schema 校验，不走远程 API）
    const provider = detectProvider(json);
    const schema = validateSchemaWithReason(provider, json);
    if (!schema.ok) {
      ops.push({ dir, file, provider, action: 'invalid', reason: schema.reason, status: 'INVALID_MISSING_FIELDS' });
      continue;
    }

    if (provider !== 'codex') {
      // 非 codex：schema 有效则原位保留，与 hourly-reconcile 保持一致
      ops.push({ dir, file, provider, action: 'keep', reason: 'schema_valid_provider', status: 'SCHEMA_VALID_PROVIDER' });
      continue;
    }

    // codex：三层过期检测 + refresh_token 续期 + 远程 API 校验
    let token   = (json.access_token || '').toString().trim();
    const account = (json.account_id  || '').toString().trim();
    let refreshedFlag = false;

    if (isTokenExpired(json)) {
      const refreshed = await tryRefreshToken(json);
      if (refreshed === 'transient') {
        ops.push({ dir, file, provider, action: 'keep', reason: 'refresh_transient', status: 'TRANSIENT_KEEP' });
        continue;
      } else if (refreshed !== null) {
        // 续期成功，原子写回文件
        writeJsonAtomic(full, refreshed);
        json = refreshed;
        token = (refreshed.access_token || '').toString().trim();
        refreshedCount += 1;
        refreshedFlag = true;
      }
      // refreshed===null：refresh_token 失效，继续用原 token 走 API，让 API 决定
    }

    const chk = await validateCodexUsageByApi(token, account, { timeoutMs: TIMEOUT_MS, treat429As: 'no_quota' });

    if (chk.kind === 'invalid') {
      ops.push({ dir, file, provider, action: 'invalid', reason: chk.reason, status: 'INVALID_AUTH' });
    } else if (chk.kind === 'quota') {
      ops.push({ dir, file, provider, action: 'to_quota',    reason: refreshedFlag ? 'refreshed' : chk.reason, status: 'VALID_QUOTA' });
    } else if (chk.kind === 'no_quota') {
      ops.push({ dir, file, provider, action: 'to_no_quota', reason: refreshedFlag ? 'refreshed' : chk.reason, status: 'VALID_NO_QUOTA' });
    } else {
      ops.push({ dir, file, provider, action: 'keep',        reason: chk.reason,                               status: 'TRANSIENT_KEEP' });
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

// ── 去重（在迁移之后做，避免迁移时先移走了"好"的那份）──────────────────────────
let dedupCount = 0;
{
  const seenAccounts = new Map();
  for (const scanDir of [DIR_QUOTA, DIR_NO_QUOTA]) {
    for (const file of listJsonFiles(scanDir).filter((f) => !f.startsWith('._'))) {
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

// ── 执行搬迁/隔离 ─────────────────────────────────────────────────────────────
const migration    = {};
const reasons      = {};
const statusCount  = {};
const providerStats = {};
let invalidQuarantined   = 0;
let invalidMovedToInvalid = 0;

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
      invalidMovedToInvalid += 1;
    }
    continue;
  }

  const targetDir = op.action === 'to_quota'    ? DIR_QUOTA
                  : op.action === 'to_no_quota'  ? DIR_NO_QUOTA
                  : op.dir; // keep → 不动
  if (op.dir !== targetDir) {
    safeMove(src, targetDir, op.file);
    const key = `${op.dir}->${targetDir}`;
    migration[key] = (migration[key] || 0) + 1;
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
const summary = {
  checkedTotal: files.length,
  refreshedCount,
  dedupRemoved: dedupCount,
  final: {
    auths:          listJsonFiles(DIR_QUOTA).length,
    auths_no_quota: listJsonFiles(DIR_NO_QUOTA).length,
    auths_invalid:  listJsonFiles(DIR_INVALID).length,
  },
  invalidQuarantined,
  invalidMovedToInvalid,
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
