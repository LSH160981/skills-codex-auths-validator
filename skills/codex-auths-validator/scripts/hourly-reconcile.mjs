#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

import { arg, numArg } from './lib/args.mjs';
import { deriveDirsFromAuthDir } from './lib/paths.mjs';
import { isTokenExpired, tryRefreshToken, validateCodexUsageByApi, writeJsonAtomic } from './lib/codex.mjs';

// 统一入口：只给 --auth-dir（有额度目录 auths）即可运行
const AUTH_DIR = arg('auth-dir', '');
const derived = AUTH_DIR ? deriveDirsFromAuthDir(AUTH_DIR) : null;

const DIR_QUOTA = arg('dir-quota', derived?.quotaDir || '/home/docker/CLIProxyAPI/auths');
const DIR_NO_QUOTA = arg('dir-no-quota', derived?.noQuotaDir || '/home/docker/CLIProxyAPI/auths_no_quota');
const DIR_INVALID = arg('dir-invalid', derived?.invalidDir || `${DIR_QUOTA}_invalid`);
const CONCURRENCY = numArg('concurrency', 40);
const TIMEOUT_MS = numArg('timeout-ms', 12000);
const LOCK_FILE = arg('lock-file', '/tmp/codex-auths-hourly.lock');
const LOCK_MAX_AGE_MS = numArg('lock-max-age-ms', 900000);
const REPORT_DIR = arg('report-dir', derived?.reportDir || '/home/docker/CLIProxyAPI/reports');

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
// 已迁移到 ./lib/codex.mjs（避免脚本之间重复实现）
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

// validateByApi/hasQuota 等已迁移到 ./lib/codex.mjs（validateCodexUsageByApi）

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

    // 过期检测（三层）+ refresh_token 续期
    // 修复：续期失败不直接 INVALID，继续走 API 校验，让 API 说了算（401 才真正失效）
    if (isTokenExpired(json)) {
      const refreshed = await tryRefreshToken(json);
      if (refreshed === 'transient') {
        // 网络/5xx，保守保留，下次重试
        ops.push({ dir, file, action: 'keep', reason: 'refresh_transient' });
        continue;
      } else if (refreshed === null) {
        // refresh_token 失效，但 access_token 可能仍有效（OpenAI token 存活时间可能长于 expired 字段）
        // 继续走 API 校验，由 API 结果决定；不在此处直接判 INVALID_EXPIRED
      } else {
        // 续期成功，写回文件，用新 token 继续走 API 校验
        writeJsonAtomic(full, refreshed);
        json = refreshed;
        token = (refreshed.access_token || '').toString().trim();
        refreshedCount += 1;
        refreshedFlag = true;
      }
    }

    const chk = await validateCodexUsageByApi(token, account, { timeoutMs: TIMEOUT_MS, treat429As: 'no_quota' });
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
