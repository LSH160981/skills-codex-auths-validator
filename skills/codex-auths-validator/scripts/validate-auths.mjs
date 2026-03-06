#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

const DIR = arg('dir', '/home/docker/CLIProxyAPI/auths');
const CONCURRENCY = Number(arg('concurrency', '40')) || 40;
const TIMEOUT_MS = Number(arg('timeout-ms', '12000')) || 12000;

const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, '-');
const quarantine = path.join(DIR, `_quarantine_${stamp}`);
fs.mkdirSync(quarantine, { recursive: true });

const all = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
const apple = all.filter((f) => f.startsWith('._'));
for (const f of apple) {
  fs.renameSync(path.join(DIR, f), path.join(quarantine, f));
}

const validCandidates = all.filter((f) => !f.startsWith('._'));

async function testFile(file) {
  const full = path.join(DIR, file);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch {
    return { file, action: 'move', reason: 'invalid_json' };
  }

  if ((json.type || '').toString() !== 'codex') {
    return { file, action: 'keep', reason: 'non_codex' };
  }

  const token = (json.access_token || '').toString().trim();
  const account = (json.account_id || '').toString().trim();
  if (!token || !account) {
    return { file, action: 'move', reason: 'missing_token_or_account' };
  }

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
    if (resp.status === 200) return { file, action: 'keep', reason: 'ok_200' };
    if (resp.status === 429) return { file, action: 'keep', reason: 'rate_or_quota_429' };
    if (resp.status === 401 || resp.status === 403) {
      return {
        file,
        action: 'move',
        reason: `auth_${resp.status}:${(body || '').slice(0, 120).replace(/\s+/g, ' ')}`,
      };
    }
    return { file, action: 'keep', reason: `status_${resp.status}` };
  } catch (e) {
    const msg = String(e || '');
    if (msg.includes('AbortError')) return { file, action: 'keep', reason: 'timeout' };
    return { file, action: 'keep', reason: 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

let idx = 0;
const results = [];

async function worker() {
  while (true) {
    const i = idx++;
    if (i >= validCandidates.length) break;
    const f = validCandidates[i];
    const r = await testFile(f);
    results.push(r);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

let moved = apple.length;
for (const r of results) {
  if (r.action !== 'move') continue;
  const src = path.join(DIR, r.file);
  const dst = path.join(quarantine, r.file);
  if (fs.existsSync(src)) {
    fs.renameSync(src, dst);
    moved++;
  }
}

const summary = {
  totalJson: all.length,
  movedTotal: moved,
  movedAppleDouble: apple.length,
  testedValid: validCandidates.length,
  kept: results.filter((r) => r.action === 'keep').length,
  movedByValidation: results.filter((r) => r.action === 'move').length,
  reasons: {},
  quarantine,
};

for (const r of results) {
  summary.reasons[r.reason] = (summary.reasons[r.reason] || 0) + 1;
}

const movedSamples = results.filter((r) => r.action === 'move').slice(0, 100);
const report = { summary, movedSamples };

fs.writeFileSync(path.join(quarantine, '_validation_report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));