![codex-auths-validator banner](assets/banner.svg)

# skills-codex-auths-validator

## 一键复制使用（OpenClaw）

> 下面这段可以直接复制给 OpenClaw，让它学习本 skill、立刻执行一次，并创建全部定时任务。

```text
请安装并学习这个 skill：
https://github.com/LSH160981/skills-codex-auths-validator

要求你立即执行：
1) 拉取并学习 skills/codex-auths-validator 全部内容；
2) 自动探测（或让我指定）JSON 认证目录 auths_dir，并创建 auths_no_quota_dir 与 auths_invalid_dir；
3) 立刻执行一次全量校验与分层迁移；
4) 自动创建并启用全部定时任务（上海时区）：
   - 每小时自动校验清理（hourly-reconcile）
   - 每日 00:00 GitHub 学习巡检
   - 每日 00:00 Skill 同步
5) 把执行结果和创建的 cron job id 全部回报给我。
```

项目地址：`https://github.com/LSH160981/skills-codex-auths-validator`

中文 | [English](#english)

---

## 中文

Codex Auth JSON 自动化验证与清理技能库（OpenClaw Skill）。

### 项目简介

这个仓库提供一个可复用的 `codex-auths-validator` 技能，用于批量处理认证 JSON（不只 Codex）。

**通用一条指令能力：**
> 用户只要告诉一个 JSON 文件目录，skill 就会自动接管（自动创建 no_quota/invalid 目录、自动校验分层、自动创建/修复定时任务）。

用于批量处理认证 JSON：

- 支持多 provider 自动识别：
  - `qwen` / `kimi` / `gemini` / `gemini-cli` / `aistudio` / `claude` / `codex` / `antigravity` / `iflow` / `vertex` / `unknown`
- 支持双目录分层：
  - `auths_dir`（有效且有额度）
  - `auths_no_quota_dir`（有效但无额度/429）
- 无效文件单独存放：
  - `auths_invalid_dir`（默认 `<auths_dir>_invalid`）
- 支持 ZIP / 7z 导入并自动分类到对应目录
- 支持每小时自动巡检清理（稳定版：并发锁 + 临时错误保留）
- 支持每日 00:00 GitHub 学习巡检
- 支持每日 00:00 Skill 同步（拉取本仓库最新版本）

### 核心规则

#### codex 类型（远程验证）
- `200` 且有额度：放 `auths_dir`
- `200` 但无额度 或 `429`：放 `auths_no_quota_dir`
- `401/403`：无效，移入 `auths_invalid_dir`
- `timeout/network/5xx`：临时错误保留原位，不强制迁移（防抖动）

#### 非 codex 类型（结构校验）
- 必要字段满足：结构有效（保留）
- 必要字段缺失 / 坏 JSON / `._*.json`：移入 `auths_invalid_dir`

> 无效文件默认不直接删除，会先单独存放，并在结果里给出“无效原因统计 + 是否删除”的确认提示。

### 技能结构

```text
skills/
  codex-auths-validator/
    SKILL.md
    WORKFLOW.md
    scripts/
      discover-auth-dir.mjs
      validate-auths.mjs
      hourly-reconcile.mjs
```

### 脚本映射（谁做什么）

#### 1) discover-auth-dir.mjs（首次安装自动探测）

用于新用户环境自动发现认证目录（优先减少手动输入）。

```bash
node skills/codex-auths-validator/scripts/discover-auth-dir.mjs
```

#### 2) validate-auths.mjs（一次性人工处理）

用于手动全量校验 / 导入前预检，支持删除或隔离模式。

```bash
node skills/codex-auths-validator/scripts/validate-auths.mjs \
  --dir-quota /home/docker/CLIProxyAPI/auths \
  --dir-no-quota /home/docker/CLIProxyAPI/auths_no_quota \
  --dir-invalid /home/docker/CLIProxyAPI/auths_invalid \
  --invalid-action quarantine \
  --concurrency 40 \
  --timeout-ms 12000
```

#### 3) hourly-reconcile.mjs（每小时定时任务专用，稳定版）

用于 cron 自动巡检，含锁文件防并发重叠。

```bash
node skills/codex-auths-validator/scripts/hourly-reconcile.mjs \
  --dir-quota /home/docker/CLIProxyAPI/auths \
  --dir-no-quota /home/docker/CLIProxyAPI/auths_no_quota \
  --dir-invalid /home/docker/CLIProxyAPI/auths_invalid \
  --concurrency 40 \
  --timeout-ms 12000
```

### 导入规则（ZIP / 7z）

压缩包里的 JSON 也按规则自动分层：

- 有额度：导入 `auths_dir`
- 无额度/429：导入 `auths_no_quota_dir`
- 无效：移入 `auths_invalid_dir`（并记录原因）

### 自动化任务（固定三项）

安装到新机器后应自动确保以下任务存在（缺失自动创建，存在自动更新）：

1. **每小时自动校验清理（上海时区）**（调用 `hourly-reconcile.mjs`）
2. **每日 00:00 GitHub 学习巡检（上海时区）**
3. **每日 00:00 Skill 同步（上海时区）**（同步本仓库最新 skill）

### 维护说明

- 核心规则和演进记录：
  - `skills/codex-auths-validator/SKILL.md`
  - `skills/codex-auths-validator/WORKFLOW.md`
- `codex-auths-validator` 相关变更要求：立即更新文档、中文 commit、立即 push GitHub。
- Git 提交信息统一中文。

---

## English

Reusable OpenClaw skill for multi-provider auth JSON validation and cleanup automation.

### Overview

This repo provides `codex-auths-validator` for large-scale auth JSON operations:

- Multi-provider auto-detection:
  - `qwen`, `kimi`, `gemini`, `gemini-cli`, `aistudio`, `claude`, `codex`, `antigravity`, `iflow`, `vertex`, `unknown`
- Dual-directory classification:
  - `auths_dir` (valid with quota)
  - `auths_no_quota_dir` (valid but no quota / 429)
- Invalid files are separated into:
  - `auths_invalid_dir` (default: `<auths_dir>_invalid`)
- ZIP / 7z import with automatic classification
- Hourly stable reconcile (lock + transient-error keep)
- Daily 00:00 GitHub learning check
- Daily 00:00 skill self-sync from this repo

### Validation Rules

#### codex (remote validation)
- `200` with quota -> `auths_dir`
- `200` no quota OR `429` -> `auths_no_quota_dir`
- `401/403` -> invalid -> `auths_invalid_dir`
- `timeout/network/5xx` -> keep in place as transient

#### non-codex (schema validation)
- required fields present -> schema valid (keep)
- malformed/missing fields/`._*.json` -> invalid -> `auths_invalid_dir`

Invalid files are not hard-deleted by default; they are separated and summarized with reason stats for user confirmation.

### Structure

```text
skills/
  codex-auths-validator/
    SKILL.md
    WORKFLOW.md
    scripts/
      discover-auth-dir.mjs
      validate-auths.mjs
      hourly-reconcile.mjs
```

### Script Mapping

#### 1) discover-auth-dir.mjs (first-time auto discovery)

```bash
node skills/codex-auths-validator/scripts/discover-auth-dir.mjs
```

#### 2) validate-auths.mjs (manual one-off / pre-import)

```bash
node skills/codex-auths-validator/scripts/validate-auths.mjs \
  --dir-quota /home/docker/CLIProxyAPI/auths \
  --dir-no-quota /home/docker/CLIProxyAPI/auths_no_quota \
  --dir-invalid /home/docker/CLIProxyAPI/auths_invalid \
  --invalid-action quarantine \
  --concurrency 40 \
  --timeout-ms 12000
```

#### 3) hourly-reconcile.mjs (hourly cron stable runner)

```bash
node skills/codex-auths-validator/scripts/hourly-reconcile.mjs \
  --dir-quota /home/docker/CLIProxyAPI/auths \
  --dir-no-quota /home/docker/CLIProxyAPI/auths_no_quota \
  --dir-invalid /home/docker/CLIProxyAPI/auths_invalid \
  --concurrency 40 \
  --timeout-ms 12000
```

### Required Scheduled Jobs (3)

1. Hourly validation cleanup (Asia/Shanghai)
2. Daily 00:00 GitHub learning check (Asia/Shanghai)
3. Daily 00:00 skill self-sync (Asia/Shanghai)

### One-line onboarding (copy)

```text
我的JSON目录是：<你的目录路径>
请立即接管：自动创建 no_quota/invalid 目录，执行一次全量校验分层，并创建全部定时任务后回报结果。
```

### Maintenance

- Keep `SKILL.md` and `WORKFLOW.md` in sync.
- For any change: document immediately, commit in Chinese, push immediately.
