![codex-auths-validator banner](assets/banner.svg)

# skills-codex-auths-validator

中文 | [English](#english)

---

## 中文

Codex Auth JSON 自动化验证与清理技能库（OpenClaw Skill）。

### 项目简介

这个仓库提供一个可复用的 `codex-auths-validator` 技能，用于在 Linux 环境中批量处理 Codex 认证 JSON：

- 双目录分层管理：
  - `/home/docker/CLIProxyAPI/auths`（有效且有额度）
  - `/home/docker/CLIProxyAPI/auths_no_quota`（有效但无额度/429）
- 使用 `https://chatgpt.com/backend-api/wham/usage` 验证可用性
- 按规则自动迁移/删除无效凭证
- 支持 ZIP 批量导入并按额度落到对应目录
- 支持每小时自动巡检清理（稳定版：并发锁 + 临时错误保留）
- 支持每日 00:00 GitHub 定点学习与规则演进

### 核心规则

- `200` 且有额度：放 `auths`
- `200` 但无额度 或 `429`：放 `auths_no_quota`
- `401 / 403`：无效，删除
- 坏 JSON / 缺失字段 / `._*.json`：删除
- `timeout/network/5xx`：临时错误保留原位，不强制迁移（防抖动）

### 技能结构

```text
skills/
  codex-auths-validator/
    SKILL.md
    WORKFLOW.md
    scripts/
      validate-auths.mjs
      hourly-reconcile.mjs
```

### 两个脚本怎么用（重点）

#### 1) validate-auths.mjs（一次性人工清理/导入前预检）

适合手动全量处理，支持删除或隔离。

```bash
node skills/codex-auths-validator/scripts/validate-auths.mjs \
  --dir-quota /home/docker/CLIProxyAPI/auths \
  --dir-no-quota /home/docker/CLIProxyAPI/auths_no_quota \
  --invalid-action quarantine \
  --concurrency 40 \
  --timeout-ms 12000
```

#### 2) hourly-reconcile.mjs（每小时定时任务专用，稳定版）

用于 cron 自动巡检，含锁文件防并发重叠。

```bash
node skills/codex-auths-validator/scripts/hourly-reconcile.mjs \
  --dir-quota /home/docker/CLIProxyAPI/auths \
  --dir-no-quota /home/docker/CLIProxyAPI/auths_no_quota \
  --concurrency 40 \
  --timeout-ms 12000
```

### ZIP 导入规则

ZIP 里的 JSON 也必须按额度分层落盘：

- 有额度：导入 `auths`
- 无额度/429：导入 `auths_no_quota`
- 无效（401/403/坏JSON/缺字段/._*.json）：按策略删除或隔离

### 自动化任务（固定两项）

安装到新机器后应自动确保以下任务存在（缺失自动创建，存在自动更新）：

1. **每小时自动校验清理（上海时区）**（调用 `hourly-reconcile.mjs`）
2. **每日 00:00 GitHub 学习巡检（上海时区）**

### 维护说明

- 所有关键规则和学习演进记录在：
  - `skills/codex-auths-validator/SKILL.md`
  - `skills/codex-auths-validator/WORKFLOW.md`
- `codex-auths-validator` 相关变更要求：立即更新 skill、中文提交、立即 push GitHub。
- Git 提交信息统一中文。

---

## English

Reusable OpenClaw skill for Codex auth JSON validation and cleanup automation.

### Overview

This repository provides the `codex-auths-validator` skill for batch processing Codex auth JSON files in Linux:

- Dual-directory classification:
  - `/home/docker/CLIProxyAPI/auths` (valid with quota)
  - `/home/docker/CLIProxyAPI/auths_no_quota` (valid but no quota / 429)
- Verify credentials via `https://chatgpt.com/backend-api/wham/usage`
- Auto move/delete based on strict rules
- ZIP import with quota-aware destination folders
- Hourly auto-reconcile (stable mode: lock + transient-error keep)
- Daily 00:00 GitHub learning checks and rule evolution

### Validation Rules

- `200` with quota -> keep/move to `auths`
- `200` without quota OR `429` -> keep/move to `auths_no_quota`
- `401 / 403` -> invalid, delete
- malformed JSON / missing required fields / `._*.json` -> delete
- `timeout/network/5xx` -> keep in place as transient (avoid oscillation)

### Skill Structure

```text
skills/
  codex-auths-validator/
    SKILL.md
    WORKFLOW.md
    scripts/
      validate-auths.mjs
      hourly-reconcile.mjs
```

### Script Mapping

#### 1) validate-auths.mjs (manual one-off cleanup / pre-import validation)

```bash
node skills/codex-auths-validator/scripts/validate-auths.mjs \
  --dir-quota /home/docker/CLIProxyAPI/auths \
  --dir-no-quota /home/docker/CLIProxyAPI/auths_no_quota \
  --invalid-action quarantine \
  --concurrency 40 \
  --timeout-ms 12000
```

#### 2) hourly-reconcile.mjs (hourly cron stable runner)

```bash
node skills/codex-auths-validator/scripts/hourly-reconcile.mjs \
  --dir-quota /home/docker/CLIProxyAPI/auths \
  --dir-no-quota /home/docker/CLIProxyAPI/auths_no_quota \
  --concurrency 40 \
  --timeout-ms 12000
```

### ZIP Import Rule

ZIP JSON files are also quota-classified:

- with quota -> `auths`
- no quota / 429 -> `auths_no_quota`
- invalid -> delete or quarantine

### Required Scheduled Jobs (2)

On a new machine, this skill must auto-provision and keep these jobs consistent:

1. **Hourly auth validation cleanup (Asia/Shanghai)** using `hourly-reconcile.mjs`
2. **Daily 00:00 GitHub learning check (Asia/Shanghai)**

### Maintenance

- Core rules and evolution notes live in:
  - `skills/codex-auths-validator/SKILL.md`
  - `skills/codex-auths-validator/WORKFLOW.md`
- Any `codex-auths-validator` change must be immediately documented, committed (Chinese), and pushed.
