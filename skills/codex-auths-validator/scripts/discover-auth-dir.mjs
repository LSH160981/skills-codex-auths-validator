#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

function existsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function countJson(p) {
  try {
    return fs.readdirSync(p).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

function pushCandidate(list, p, source, scoreBase = 0) {
  if (!p) return;
  const normalized = path.resolve(p);
  const exists = existsDir(normalized);
  const jsonCount = exists ? countJson(normalized) : 0;
  const score = scoreBase + (exists ? 20 : 0) + Math.min(jsonCount, 1000) / 50;
  list.push({ path: normalized, source, exists, jsonCount, score: Number(score.toFixed(2)) });
}

function parseAuthDirFromText(text) {
  const patterns = [
    /auth-dir\s*[:=]\s*["']?([^"'\n\r#]+)["']?/i,
    /auth_dir\s*[:=]\s*["']?([^"'\n\r#]+)["']?/i,
    /"auth-dir"\s*:\s*"([^"]+)"/i,
    /"auth_dir"\s*:\s*"([^"]+)"/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return '';
}

function tryDockerMountCandidates() {
  const out = [];
  try {
    const ps = execSync("docker ps --format '{{.ID}} {{.Names}}'", { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const line of ps) {
      const [id, name] = line.split(/\s+/, 2);
      if (!id) continue;
      if (!/(cli|proxy|cpa|codex)/i.test(name || '')) continue;
      const raw = execSync(`docker inspect ${id}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const arr = JSON.parse(raw);
      const mounts = arr?.[0]?.Mounts || [];
      for (const m of mounts) {
        const src = (m.Source || '').trim();
        const dst = (m.Destination || '').trim();
        if (!src) continue;
        if (/(auth|credential|token)/i.test(src) || /(auth|credential|token)/i.test(dst)) {
          out.push({ path: src, source: `docker:${name}:${dst}` });
        }
      }
    }
  } catch {
    // docker unavailable is fine
  }
  return out;
}

const hint = arg('hint', '');
const candidates = [];

// 1) explicit hint has highest priority
if (hint) pushCandidate(candidates, hint, 'arg:--hint', 100);

// 2) env hints
for (const [k, v] of Object.entries(process.env)) {
  if (!v) continue;
  if (/AUTH_DIR|AUTH_PATH|CLI_PROXY_AUTH/i.test(k)) {
    pushCandidate(candidates, v, `env:${k}`, 80);
  }
}

// 3) common docker/self-hosted defaults
const common = [
  '/home/docker/CLIProxyAPI/auths',
  '/home/docker/cli-proxy-api/auths',
  '/opt/CLIProxyAPI/auths',
  '/opt/cli-proxy-api/auths',
  '/srv/CLIProxyAPI/auths',
  '/srv/cli-proxy-api/auths',
  '/data/CLIProxyAPI/auths',
  '/data/cli-proxy-api/auths',
  '/var/lib/CLIProxyAPI/auths',
  '/var/lib/cli-proxy-api/auths',
];
for (const p of common) pushCandidate(candidates, p, 'common-default', 30);

// 4) parse possible config files
const cfgFiles = [
  '/home/docker/CLIProxyAPI/config/config.yaml',
  '/home/docker/CLIProxyAPI/config/config.yml',
  '/home/docker/CLIProxyAPI/config/config.json',
  '/etc/cli-proxy/config.yaml',
  '/etc/cli-proxy/config.yml',
  '/etc/cli-proxy/config.json',
  '/opt/CLIProxyAPI/config/config.yaml',
  '/opt/CLIProxyAPI/config/config.yml',
  '/opt/CLIProxyAPI/config/config.json',
];
for (const f of cfgFiles) {
  try {
    if (!fs.existsSync(f)) continue;
    const txt = fs.readFileSync(f, 'utf8');
    const authDir = parseAuthDirFromText(txt);
    if (authDir) pushCandidate(candidates, authDir, `config:${f}`, 90);
  } catch {
    // ignore
  }
}

// 5) docker mount discovery
for (const d of tryDockerMountCandidates()) {
  pushCandidate(candidates, d.path, d.source, 70);
}

// dedupe by path, keep highest score evidence
const best = new Map();
for (const c of candidates) {
  const prev = best.get(c.path);
  if (!prev || c.score > prev.score) best.set(c.path, c);
}

const sorted = [...best.values()].sort((a, b) => b.score - a.score);
const recommended = sorted.find((x) => x.exists && x.jsonCount >= 1) || sorted.find((x) => x.exists) || sorted[0] || null;

const result = {
  recommended: recommended?.path || null,
  recommendedSource: recommended?.source || null,
  candidates: sorted,
  note:
    '首次安装建议：优先使用 recommended；若为空或不可信，再询问用户。可同时初始化 auths_no_quota=auth_dir+"_no_quota"。',
};

console.log(JSON.stringify(result, null, 2));