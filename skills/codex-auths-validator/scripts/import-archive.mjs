#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { arg, numArg } from './lib/args.mjs';
import { deriveDirsFromAuthDir } from './lib/paths.mjs';
import { isTokenExpired, tryRefreshToken, validateCodexUsageByApi } from './lib/codex.mjs';
import { detectProvider, schemaValid } from './lib/provider.mjs';

// ─── 公共工具函数 ───────────────────────────────────────────────────────────────
// 已迁移到 ./lib/codex.mjs（避免脚本之间重复实现）
// ─── 工具函数结束 ────────────────────────────────────────────────────────────────

const ARCHIVE = arg('archive', '');
if (!ARCHIVE) {
  console.error('缺少参数：--archive <zip|7z 文件路径>');
  process.exit(1);
}

const AUTH_DIR = arg('auth-dir', '');
const derived = AUTH_DIR ? deriveDirsFromAuthDir(AUTH_DIR) : null;

const DIR_QUOTA = arg('dir-quota', derived?.quotaDir || '/home/docker/CLIProxyAPI/auths');
const DIR_NO_QUOTA = arg('dir-no-quota', derived?.noQuotaDir || '/home/docker/CLIProxyAPI/auths_no_quota');
const DIR_INVALID = arg('dir-invalid', derived?.invalidDir || `${DIR_QUOTA}_invalid`);
const CONCURRENCY = numArg('concurrency', 40);
const TIMEOUT_MS = numArg('timeout-ms', 12000);

for (const d of [DIR_QUOTA, DIR_NO_QUOTA, DIR_INVALID]) fs.mkdirSync(d, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const base = `/tmp/codex-auths-import-${ts}`;
const extractDir = path.join(base, 'extract');
fs.mkdirSync(extractDir, { recursive: true });

const ext = path.extname(ARCHIVE).toLowerCase();
try {
  if (ext === '.zip') {
    execFileSync('unzip', ['-q', ARCHIVE, '-d', extractDir], { stdio: 'ignore' });
  } else if (ext === '.7z') {
    execFileSync('7z', ['x', '-y', `-o${extractDir}`, ARCHIVE], { stdio: 'ignore' });
  } else {
    console.error(`不支持的压缩包类型：${ext}（仅支持 .zip / .7z）`);
    process.exit(2);
  }
} catch (e) {
  console.error(`解压失败：${String(e)}`);
  process.exit(3);
}

function walkAllFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

function safeCopy(src, dstDir, basename) {
  let name = basename;
  const extName = path.extname(name);
  const stem = extName ? path.basename(name, extName) : name;
  let dst = path.join(dstDir, name);
  let n = 1;
  while (fs.existsSync(dst)) {
    name = `${stem}__imported${n}${extName}`;
    dst = path.join(dstDir, name);
    n += 1;
  }
  fs.copyFileSync(src, dst);
  return name;
}

// 问题3：全局 safeMoveDedup，用于去重时移动（rename 语义），替代原来内嵌的 safeMoveLocal
function safeMoveDedup(src, dstDir, basename) {
  let name = basename;
  const extName = path.extname(name);
  const stem = extName ? path.basename(name, extName) : name;
  let dst = path.join(dstDir, name);
  let n = 1;
  while (fs.existsSync(dst)) {
    name = `${stem}__dup${n}${extName}`;
    dst = path.join(dstDir, name);
    n += 1;
  }
  fs.renameSync(src, dst);
}


async function checkCodex(json) {
  const token = (json.access_token || '').toString().trim();
  const account = (json.account_id || '').toString().trim();
  if (!token || !account) return { status: 'INVALID_MISSING_FIELDS', reason: 'codex_missing_required_fields', target: 'invalid' };

  // 过期检测（三层）+ refresh_token 续期
  // 修复：续期失败不直接 INVALID，继续走 API 校验，让 API 说了算（401 才真正失效）
  if (isTokenExpired(json)) {
    const refreshed = await tryRefreshToken(json);
    if (refreshed === 'transient') {
      return { status: 'TRANSIENT_KEEP', reason: 'refresh_transient', target: 'no_quota' };
    } else if (refreshed === null) {
      // refresh_token 失效，但 access_token 可能仍有效，继续走 API 校验
      return checkCodexWithToken(json);
    } else {
      // 续期成功，用新 json 继续校验
      return checkCodexWithToken(refreshed);
    }
  }

  return checkCodexWithToken(json);
}

async function checkCodexWithToken(json) {
  const token = (json.access_token || '').toString().trim();
  const account = (json.account_id || '').toString().trim();

  const chk = await validateCodexUsageByApi(token, account, { timeoutMs: TIMEOUT_MS, treat429As: 'no_quota' });
  if (chk.kind === 'invalid') return { status: 'INVALID_AUTH', reason: chk.reason, target: 'invalid' };
  if (chk.kind === 'quota') return { status: 'VALID_QUOTA', reason: chk.reason, target: 'quota' };
  if (chk.kind === 'no_quota') return { status: 'VALID_NO_QUOTA', reason: chk.reason, target: 'no_quota' };
  return { status: 'TRANSIENT_KEEP', reason: chk.reason, target: 'no_quota' };
}

const allFiles = walkAllFiles(extractDir);
const jsonFiles = allFiles.filter((f) => f.toLowerCase().endsWith('.json'));
const ignoredFiles = allFiles.length - jsonFiles.length;

let idx = 0;
const results = [];

async function worker() {
  while (true) {
    const i = idx++;
    if (i >= jsonFiles.length) break;

    const full = jsonFiles[i];
    const name = path.basename(full);

    if (name.startsWith('._')) {
      results.push({ name, provider: 'unknown', status: 'INVALID_APPLEDOUBLE', reason: 'appledouble', target: 'invalid' });
      continue;
    }

    let json;
    try {
      json = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      results.push({ name, provider: 'unknown', status: 'INVALID_JSON', reason: 'invalid_json', target: 'invalid' });
      continue;
    }

    const provider = detectProvider(json);
    if (!schemaValid(provider, json)) {
      results.push({ name, provider, status: 'INVALID_MISSING_FIELDS', reason: `${provider}_missing_required_fields`, target: 'invalid' });
      continue;
    }

    if (provider === 'codex' || (json.access_token && json.account_id)) {
      const r = await checkCodex(json);
      results.push({ name, provider: 'codex', ...r });
    } else {
      results.push({ name, provider, status: 'SCHEMA_VALID_PROVIDER', reason: 'schema_valid_provider', target: 'no_quota' });
    }
  }
}

(async () => {
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  let importedToAuths = 0;
  let importedToNoQuota = 0;
  let movedToInvalid = 0;
  const statusHist = {};
  const reasonHist = {};
  const providerHist = {};

  for (const r of results) {
    const src = jsonFiles.find((f) => path.basename(f) === r.name) || path.join(extractDir, r.name);
    if (r.target === 'quota') {
      safeCopy(src, DIR_QUOTA, r.name);
      importedToAuths += 1;
    } else if (r.target === 'no_quota') {
      safeCopy(src, DIR_NO_QUOTA, r.name);
      importedToNoQuota += 1;
    } else {
      safeCopy(src, DIR_INVALID, r.name);
      movedToInvalid += 1;
    }

    statusHist[r.status] = (statusHist[r.status] || 0) + 1;
    reasonHist[r.reason] = (reasonHist[r.reason] || 0) + 1;
    providerHist[r.provider] = (providerHist[r.provider] || 0) + 1;
  }

  // ── 去重：对比 account_id，同一账户只保留第一个，其余移入 invalid ──
  // 问题3：删除原来内嵌的 listJson / safeMoveLocal 局部函数，
  //        改用全局 safeMoveDedup（rename 语义）完成去重移动。
  //        listJson 也已在全局（hourly-reconcile 风格），这里直接内联读取目录。
  const seenAccounts = new Map();
  let dedupRemoved = 0;

  for (const scanDir of [DIR_QUOTA, DIR_NO_QUOTA]) {
    const files = fs.readdirSync(scanDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const full = path.join(scanDir, file);
      let json;
      try { json = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
      const account = (json.account_id || '').toString().trim();
      if (!account) continue;
      if (seenAccounts.has(account)) {
        // 问题3：复用全局 safeMoveDedup 替代局部 safeMoveLocal
        safeMoveDedup(full, DIR_INVALID, file);
        dedupRemoved += 1;
        if (scanDir === DIR_QUOTA) importedToAuths -= 1;
        else importedToNoQuota -= 1;
        movedToInvalid += 1;
        reasonHist['duplicate_account_id'] = (reasonHist['duplicate_account_id'] || 0) + 1;
        statusHist['INVALID_DUPLICATE'] = (statusHist['INVALID_DUPLICATE'] || 0) + 1;
      } else {
        seenAccounts.set(account, full);
      }
    }
  }

  const report = {
    archive: ARCHIVE,
    archiveType: ext,
    filesInArchive: allFiles.length,
    jsonFiles: jsonFiles.length,
    ignoredNonJsonFiles: ignoredFiles,
    importedToAuths,
    importedToNoQuota,
    movedToInvalid,
    dedupRemoved,
    statusHist,
    reasonHist,
    providerHist,
    paths: {
      auths: DIR_QUOTA,
      auths_no_quota: DIR_NO_QUOTA,
      auths_invalid: DIR_INVALID,
    },
  };

  const reportPath = path.join(base, '_import_report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
})();
