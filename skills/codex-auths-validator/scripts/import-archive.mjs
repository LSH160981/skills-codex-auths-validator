#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { arg, numArg } from './lib/args.mjs';
import { deriveDirsFromAuthDir } from './lib/paths.mjs';

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

  const jwtExp = getJwtExp(json.id_token);
  if (jwtExp !== null) {
    return jwtExp * 1000 < nowMs;
  }

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

function hasAny(json, ...keys) {
  return keys.some((k) => {
    const v = json[k];
    return typeof v === 'string' ? v.trim().length > 0 : Boolean(v);
  });
}

function schemaValid(provider, json) {
  switch (provider) {
    case 'codex':
      return hasAny(json, 'access_token') && hasAny(json, 'account_id');
    case 'gemini':
    case 'gemini-cli':
    case 'aistudio':
      return hasAny(json, 'api_key', 'access_token');
    case 'claude':
      return hasAny(json, 'api_key', 'x_api_key', 'access_token');
    case 'vertex':
      return hasAny(json, 'project_id') && hasAny(json, 'private_key', 'access_token');
    case 'qwen':
    case 'kimi':
    case 'iflow':
    case 'antigravity':
      return hasAny(json, 'access_token', 'api_key', 'refresh_token');
    default:
      return hasAny(json, 'access_token', 'api_key', 'refresh_token');
  }
}

function hasQuota(payload) {
  const rl = payload?.rate_limit || {};
  const cr = payload?.code_review_rate_limit || {};
  const windows = [rl.primary_window, rl.secondary_window, cr.primary_window, cr.secondary_window].filter(Boolean);
  const used = windows.map((w) => (typeof w.used_percent === 'number' ? w.used_percent : null)).filter((v) => v !== null);
  const noQuota = rl.limit_reached === true || cr.limit_reached === true || used.some((v) => v >= 100);
  return !noQuota;
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Chatgpt-Account-Id': account,
        'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal',
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    const body = await r.text();
    if (r.status === 401 || r.status === 403) return { status: 'INVALID_AUTH', reason: `auth_${r.status}`, target: 'invalid' };
    if (r.status === 429) return { status: 'VALID_NO_QUOTA', reason: 'rate_or_quota_429', target: 'no_quota' };
    if (r.status >= 500) return { status: 'TRANSIENT_KEEP', reason: `status_${r.status}`, target: 'no_quota' };
    if (r.status !== 200) return { status: 'TRANSIENT_KEEP', reason: `status_${r.status}`, target: 'no_quota' };

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return { status: 'TRANSIENT_KEEP', reason: 'invalid_usage_json', target: 'no_quota' };
    }

    return hasQuota(payload)
      ? { status: 'VALID_QUOTA', reason: 'ok_200', target: 'quota' }
      : { status: 'VALID_NO_QUOTA', reason: 'ok_200_no_quota', target: 'no_quota' };
  } catch (e) {
    const s = String(e || '');
    if (s.includes('AbortError')) return { status: 'TRANSIENT_KEEP', reason: 'timeout', target: 'no_quota' };
    return { status: 'TRANSIENT_KEEP', reason: 'network_error', target: 'no_quota' };
  } finally {
    clearTimeout(timer);
  }
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
