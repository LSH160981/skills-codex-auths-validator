#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

const ARCHIVE = arg('archive', '');
if (!ARCHIVE) {
  console.error('缺少参数：--archive <zip|7z 文件路径>');
  process.exit(1);
}

const DIR_QUOTA = arg('dir-quota', '/home/docker/CLIProxyAPI/auths');
const DIR_NO_QUOTA = arg('dir-no-quota', '/home/docker/CLIProxyAPI/auths_no_quota');
const DIR_INVALID = arg('dir-invalid', `${DIR_QUOTA}_invalid`);
const CONCURRENCY = Number(arg('concurrency', '40')) || 40;
const TIMEOUT_MS = Number(arg('timeout-ms', '12000')) || 12000;

for (const d of [DIR_QUOTA, DIR_NO_QUOTA, DIR_INVALID]) fs.mkdirSync(d, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const base = `/tmp/codex-auths-import-${ts}`;
const extractDir = path.join(base, 'extract');
fs.mkdirSync(extractDir, { recursive: true });

const ext = path.extname(ARCHIVE).toLowerCase();
try {
  if (ext === '.zip') {
    execSync(`unzip -q "${ARCHIVE}" -d "${extractDir}"`, { stdio: 'ignore' });
  } else if (ext === '.7z') {
    execSync(`7z x -y -o"${extractDir}" "${ARCHIVE}"`, { stdio: 'ignore' });
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

  const report = {
    archive: ARCHIVE,
    archiveType: ext,
    filesInArchive: allFiles.length,
    jsonFiles: jsonFiles.length,
    ignoredNonJsonFiles: ignoredFiles,
    importedToAuths,
    importedToNoQuota,
    movedToInvalid,
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