---
name: codex-auths-validator
description: OpenClaw 的 Codex 认证 JSON 自动化验证技能：每小时清理、ZIP/7z 导入校验、每日 GitHub 学习巡检。只要告诉我 JSON 文件存放目录我就能自动工作；若未提供则默认按 Cli-Proxy-API-Management-Center 源码线索自动探测目录。
---

# Codex Auths Validator

Validate and clean Codex auth JSON files in a batch.

## Run scope

- Target directories（可配置，适配所有用户）：
  - `auths_dir`：有效且有额度目录（用户提供或自动探测）
  - `auths_no_quota_dir`：有效但无额度/限流目录（默认 `<auths_dir>_no_quota`）
- Target files: `*.json`
- Validation endpoint: `GET https://chatgpt.com/backend-api/wham/usage`
- Required headers:
  - `Authorization: Bearer <access_token>`
  - `Chatgpt-Account-Id: <account_id>`
  - `User-Agent: codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal`

## 自动识别与验证范围（对齐原项目多类型能力）

本 skill 会先自动识别 JSON 所属 provider，再决定验证方式：

- 识别优先级：`type` / `provider` 字段 -> 特征字段推断
- 已覆盖类型（与原项目 `AuthFileType` 对齐）：
  - `qwen` / `kimi` / `gemini` / `gemini-cli` / `aistudio` / `claude` / `codex` / `antigravity` / `iflow` / `vertex`
  - `unknown`（无法明确分类时）

## Decision rules

### A) codex 类型（可做远程额度验证）
- `200` 且有额度 -> 放在 `auths_dir`
- `200` 但无额度（`limit_reached=true` 或 window `used_percent>=100`）-> 放在 `auths_no_quota_dir`
- `429`（限流/额度耗尽）-> 放在 `auths_no_quota_dir`
- `401/403` -> 判定无效，移入 `auths_invalid_dir`
- `5xx/timeout/network` -> 临时错误，原位保留（不迁移）

### B) 非 codex 类型（先做结构有效性校验）
- 必要字段满足 -> 结构有效，保留原位（可选后续接入 provider 专用远程验证）
- 必要字段缺失 / 坏 JSON / `._*.json` -> 判定无效，移入 `auths_invalid_dir`

## 统一状态输出（用于给用户解释“为什么无效”）

- `VALID_QUOTA`：有效且有额度
- `VALID_NO_QUOTA`：有效但无额度/被限流
- `INVALID_AUTH`：认证失败（401/403）
- `INVALID_JSON`：JSON 格式损坏
- `INVALID_MISSING_FIELDS`：缺少必要字段
- `INVALID_APPLEDOUBLE`：`._*.json` 垃圾文件
- `SCHEMA_VALID_PROVIDER`：非 codex，结构有效（保留）
- `TRANSIENT_KEEP`：临时错误保留（timeout/network/5xx）

## Safety mode

Move removable files into a timestamped quarantine folder first. Do not hard-delete immediately.

Quarantine location pattern:
- `/home/docker/CLIProxyAPI/auths/_quarantine_<timestamp>`

Write report file:
- `_validation_report.json`

## 入口原则（项目主标语）

**OpenClaw 的 Codex 认证 JSON 自动化验证技能：每小时清理、ZIP/7z 导入校验、每日 GitHub 学习巡检。**

**只要告诉我 JSON 文件存放的目录，我就能自己工作。**

如果用户不提供目录：
- 默认视为用户可能安装了 `Cli-Proxy-API-Management-Center`。
- 按源项目配置与 Docker 挂载线索自动探测目录（`auth-dir` 优先）。

## 首次安装引导（降低新用户操作）

如果用户第一次使用本 skill，先走“自动发现 + 最少提问”流程：

1. 先自动探测认证目录（不要一上来就问用户）：

```bash
node skills/codex-auths-validator/scripts/discover-auth-dir.mjs
```

2. 优先采用探测结果里的 `recommended` 目录。
3. 若探测不到可靠目录，才询问用户认证目录路径（用户说一个路径就直接支持，不要求固定目录）。
4. 若用户安装了 `Cli-Proxy-API-Management-Center`，优先检查其 `auth-dir` 配置与 Docker 挂载路径。
5. 自动创建无额度目录：`<auth_dir>_no_quota`。
6. 首次引导时用中文给用户明确说明：
   - 你识别到的认证目录
   - 双目录规则（有额度/无额度）
   - 接下来会自动创建的每小时与每日任务

> 目标：尽量少让新用户手动配置，能自动发现就自动发现。

## Scripts mapping（两个脚本分别做什么）

### 1) `scripts/validate-auths.mjs`（一次性人工清理/导入前筛选）

用途：
- 手动全量校验、一次性清理、导入前预检。
- 支持无效文件 `delete` 或 `quarantine` 两种模式。

典型命令：

```bash
node skills/codex-auths-validator/scripts/validate-auths.mjs \
  --dir-quota /home/docker/CLIProxyAPI/auths \
  --dir-no-quota /home/docker/CLIProxyAPI/auths_no_quota \
  --invalid-action quarantine \
  --concurrency 40 \
  --timeout-ms 12000
```

`--invalid-action`:
- `delete`：无效文件直接删除（默认）
- `quarantine`：无效文件移入 `_quarantine_<timestamp>`

### 2) `scripts/hourly-reconcile.mjs`（每小时定时任务专用，稳定版）

用途：
- 供 cron 每小时自动任务调用。
- 内置并发锁（`/tmp/codex-auths-hourly.lock`）防止重叠执行。
- 临时错误（timeout/network/5xx）保留原位，避免统计抖动。
- 无效 JSON 不直接删除，移动到无效目录（默认 `<auths_dir>_invalid`）并输出原因，提示用户是否删除。

典型命令：

```bash
node skills/codex-auths-validator/scripts/hourly-reconcile.mjs \
  --dir-quota /home/docker/CLIProxyAPI/auths \
  --dir-no-quota /home/docker/CLIProxyAPI/auths_no_quota \
  --dir-invalid /home/docker/CLIProxyAPI/auths_invalid \
  --concurrency 40 \
  --timeout-ms 12000
```

## Output contract

Return a JSON summary including:
- total files
- moved files
- moved AppleDouble count
- kept count
- moved-by-validation count
- reason histogram
- quarantine path
- moved samples

## Archive import workflow（zip/7z 自动接管）

When user provides `.zip` or `.7z` package:

1. Auto-extract archive to temp workspace.
2. Auto-scan all files; only `*.json` enters validation pipeline.
3. Non-JSON files (code, scripts, docs, binaries, etc.) are ignored and never imported.
4. Validate JSON files with this skill rules.
5. Classify to target folders:
   - valid + has quota -> `auths_dir`
   - valid but no quota / 429 -> `auths_no_quota_dir`
   - invalid -> `auths_invalid_dir`
6. Return summary:
   - total files in archive
   - json files processed
   - non-json files ignored
   - imported to `auths`
   - imported to `auths_no_quota`
   - moved to `auths_invalid`
   - status/reason histogram

Recommended command:

```bash
node skills/codex-auths-validator/scripts/import-archive.mjs \
  --archive <package.zip|package.7z> \
  --dir-quota <auths_dir> \
  --dir-no-quota <auths_no_quota_dir> \
  --dir-invalid <auths_invalid_dir>
```

Suggested command sequence:

```bash
mkdir -p /tmp/codex-auths-import
unzip <package.zip> -d /tmp/codex-auths-import
# validate extracted files (same endpoint/rules), then copy passed ones:
cp <passed-json-files> /home/docker/CLIProxyAPI/auths/
```

## Hard delete (only after confirmation)

After user confirms, delete quarantine and import temp folders:

```bash
rm -rf /home/docker/CLIProxyAPI/auths/_quarantine_<timestamp>
rm -rf /tmp/codex-auths-import-<timestamp>
```

Bulk cleanup command (remove all historical quarantine/import temp folders):

```bash
for d in /home/docker/CLIProxyAPI/auths/_quarantine_* /tmp/codex-auths-import-*; do
  [ -e "$d" ] && rm -rf "$d"
done
```

## Hourly scheduled validation & delete workflow

When user asks for hourly auto-clean:

1. Create a cron job (Asia/Shanghai) with `expr: 0 * * * *`.
2. Each run validates all `*.json` in `/home/docker/CLIProxyAPI/auths`.
3. Delete all unqualified files directly (no quarantine) based on rules:
   - unqualified: 401/403, malformed JSON, missing token/account_id, `._*.json`
   - qualified: 200/429
4. Send user summary after each run in Chinese:
   - 总共：<总数> 个
   - 合格的：<合格数> 个
   - 不合格并删除的：<删除数> 个
   - 删除原因统计：<按原因计数>
5. If failed, report error and processed progress.

Recommended cron payload style: `sessionTarget: main`, `payload.kind: systemEvent`.

## 对话总结（阶段成果，需持续更新）

以下为本技能从0到1的关键对话沉淀（用于新维护者快速理解）：

1. **基础能力落地**：先实现 codex JSON 批量验证、失效清理、ZIP 导入。
2. **双目录分层**：将“有效有额度/有效无额度”拆分为 `auths_dir` 与 `auths_no_quota_dir`。
3. **稳定性修复**：新增每小时巡检并发锁，避免重叠执行导致统计波动。
4. **无效文件策略升级**：无效文件不直接删，统一入 `auths_invalid_dir` 并附原因，询问用户是否删除。
5. **多 provider 识别**：对齐 Cli-Proxy-API-Management-Center 类型体系，先识别 provider 再选择验证方式。
6. **归档接管能力**：支持 ZIP/7z，自动只处理 JSON，忽略代码和其他非 JSON 文件。
7. **新手零配置体验**：用户只给 JSON 目录即可自动接管；若未提供则按 CPA 线索自动探测 `auth-dir`。
8. **自动化运维闭环**：固定 3 个定时任务（小时清理/每日学习/每日同步）。
9. **文档与仓库同步纪律**：任何改动必须同步 SKILL + WORKFLOW + README，并立即中文 commit + push。

## Learning rationale and evolution notes (must maintain)

Keep this section updated when environment, upstream API behavior, or source project logic changes.

### Why these rules were chosen

- `200` means credential is usable now, so keep.
- `429` usually means rate/usage exhaustion, not token death, so keep.
- `401/403` indicates invalid/unauthorized token/account context, so remove as useless.
- malformed JSON / missing `access_token` / missing `account_id` cannot pass API auth, so remove.
- `._*.json` are AppleDouble artifacts, not real auth files, so remove.

### What was learned from project analysis (CLI Proxy API Management Center)

From `router-for-me/Cli-Proxy-API-Management-Center`, codex quota UI and logic map to:

- Auth-files page quota refresh action uses quota loader flow.
- Codex quota backend endpoint: `https://chatgpt.com/backend-api/wham/usage`.
- UI labels such as 套餐/Free/周限额/代码审查周限额 are rendered from codex quota config and i18n.
- 403/404 are rendered as credential/update hints in UI, but operational cleanup here treats 401/403 as invalid credentials and 429 as pass.

### Mutable inputs (must re-verify when changed)

Always re-check these before running bulk cleanup in a new environment:

1. Auth directory path (default now: `/home/docker/CLIProxyAPI/auths`).
2. Validation endpoint and required headers.
3. JSON field schema (`type`, `access_token`, `account_id`).
4. User policy on quarantine vs direct delete.
5. User policy on timeout/network handling.

### Learning update protocol

When new evidence appears (new GitHub version, API change, user policy change):

1. Record what changed and why in this section.
2. Update decision rules and execution commands.
3. Re-test with a small sample before full batch.
4. Keep success snapshots (counts + key reasons) for regression comparison.
5. If schedule behavior changes, update cron workflow text too.

### Success snapshots (historical)

- Snapshot A: local auth dir full validation
  - total: 5125
  - kept: 3124
  - removed: 2001 (2000 AppleDouble + 1 auth_403)
- Snapshot B: zip import #1
  - total in zip: 50
  - imported: 50
  - failed: 0
- Snapshot C: zip import #2
  - total in zip: 1000
  - imported: 999
  - failed: 1 (auth_403)
- Snapshot D: 7z import
  - total in 7z: 1145
  - imported to auths: 1145
  - imported to auths_no_quota: 0
  - moved to auths_invalid: 0
  - status: VALID_QUOTA x1145

Maintain snapshots so future changes can be compared quickly.

## Required sync policy (codex-auths-validator)

For any change related to `codex-auths-validator` (rules, user path handling, API endpoint, headers, cron behavior, workflow, docs, scripts):

1. Update skill files immediately (`SKILL.md` / `WORKFLOW.md` / `scripts/*` as needed).
2. Update GitHub-facing documentation immediately (`README.md`) to keep repo usage guide consistent.
3. Commit immediately with a Chinese commit message.
4. Push immediately to GitHub repository `LSH160981/skills-codex-auths-validator`.
5. Reply with commit id(s) after push.

Do not delay bundling changes for later when they affect behavior or operation.

## Daily 00:00 GitHub learning workflow (Asia/Shanghai)

When user requires scheduled learning and code tracking:

1. Create a cron job with `expr: 0 0 * * *`, `tz: Asia/Shanghai`.
2. Each run searches GitHub for new/changed code around:
   - CLI Proxy API Management Center
   - Codex auth JSON validation
   - `chatgpt.com/backend-api/wham/usage`
   - credential cleanup strategies
3. Extract and compare mutable items:
   - auth file directory conventions
   - JSON schema changes (`type/access_token/account_id/...`)
   - endpoint and required headers
   - status code semantics and handling policy
4. If meaningful changes are found:
   - update this SKILL.md (rules/workflow/evolution notes)
   - append a new success/learning snapshot
5. Send user a Chinese daily learning summary:
   - checked repositories/files
   - key findings and impact
   - whether skill was updated
   - whether manual confirmation is needed

Recommended cron payload style: `sessionTarget: main`, `payload.kind: systemEvent`.

## Mandatory auto-provision on new machine (3 cron jobs)

When this skill is installed/used on a new machine, ALWAYS ensure these three cron jobs exist automatically (create if missing, update if exists by name):

### Job A: Hourly auth validation cleanup

- Name: `Codex auths 每小时自动校验清理（上海）`
- Schedule: `0 * * * *` (`Asia/Shanghai`)
- Behavior (dual-directory flow, stabilized):
  - use script: `skills/codex-auths-validator/scripts/hourly-reconcile.mjs`
  - scan both directories:
    - `/home/docker/CLIProxyAPI/auths` (valid + quota)
    - `/home/docker/CLIProxyAPI/auths_no_quota` (valid but no quota / rate-limited)
  - validate via `GET https://chatgpt.com/backend-api/wham/usage`
  - `200` with positive remaining quota -> move to `/home/docker/CLIProxyAPI/auths`
  - `200` with zero quota OR `429` -> move to `/home/docker/CLIProxyAPI/auths_no_quota`
  - delete invalid (`401/403`, malformed JSON, missing required fields, `._*.json`)
  - transient errors (`timeout/network/5xx/other`) keep in-place, do NOT reclassify as no-quota
  - lock file `/tmp/codex-auths-hourly.lock` prevents concurrent runs and metric oscillation
  - next hourly run re-checks both dirs and auto-moves files back when quota recovers
  - send Chinese summary:
    - 总共检查：<总数> 个
    - 有效有额度（最终在 auths）：<数量>
    - 有效无额度（最终在 auths_no_quota）：<数量>
    - 删除：<数量>
    - 目录迁移统计：<from->to 计数>
    - 删除原因统计：<按原因计数>
    - 临时错误保留：<数量>（<按原因计数>）

### Job B: Daily 00:00 GitHub learning check

- Name: `Codex auths 每日00:00 GitHub学习巡检（上海）`
- Schedule: `0 0 * * *` (`Asia/Shanghai`)
- Behavior:
  - search GitHub for related code changes
  - compare mutable items (path/schema/endpoint/headers/status semantics)
  - update this skill when changes are meaningful
  - send daily Chinese learning summary

### Job C: Daily 00:00 skill self-sync (Asia/Shanghai)

- Name: `Codex auths 每日00:00 技能同步（上海）`
- Schedule: `0 0 * * *` (`Asia/Shanghai`)
- Behavior:
  - pull latest updates from `https://github.com/LSH160981/skills-codex-auths-validator.git`
  - sync `skills/codex-auths-validator/*` to local workspace
  - if changed, apply immediately and send update summary to user

### Idempotent enforcement rule

Every time this skill runs in a new environment:
1. `cron.list(includeDisabled=true)`
2. find jobs by exact name
3. create missing jobs via `cron.add`
4. patch existing jobs via `cron.update` to keep schedule/payload consistent
5. report ensured job IDs to user

This guarantees all required cron jobs auto-appear after skill deployment on any machine.

## Multi-user path policy (important)

This skill must work for any user environment, not only `/home/docker/CLIProxyAPI/auths`.

### 通用一条指令能力（新增）

只要用户告诉一个 JSON 存放目录，skill 就必须自动接管并完成工作：

1. 把该目录直接作为 `auths_dir`。
2. 自动派生并创建：
   - `auths_no_quota_dir = <auths_dir>_no_quota`
   - `auths_invalid_dir = <auths_dir>_invalid`
3. 自动执行校验、分层、无效归档、结果汇总。
4. 自动创建/修复定时任务（无需用户额外配置细节）。

When user provides a JSON folder path, the skill should:
1. Accept the path directly as `auths_dir`.
2. Derive `auths_no_quota_dir` as `<auths_dir>_no_quota` unless user specifies another path.
3. Derive `auths_invalid_dir` as `<auths_dir>_invalid` unless user specifies another path.
4. Create missing target directories automatically.
5. Run the same validation/migration/archive rules without asking extra setup questions.

If no path is provided, run discovery first; only ask user when discovery has low confidence.


## Incident Log

- 2026-03-07 05:20 UTC：检测到 hourly cron 一直输出“已有任务在运行，跳过本次”，说明 `/tmp/codex-auths-hourly.lock` 可能残留导致新一轮被阻止。
  - 采取：查找 `/tmp/codex-auths-hourly.lock`，确认无对应进程后手动删除锁，避免脚本误判。
  - 结果：再次调用 `cron.run` 仍被判“already-running”，推测旧执行尚未结束，因此先暂停任务。
- 2026-03-07 05:24 UTC：确认无正在运行的 `hourly-reconcile` 进程后，删除锁文件并重新 `cron.run`。
  - 观察：又被调度拒绝，说明旧队列还在空转，最终选择禁用 cron 以彻底结束这次事故。
- 2026-03-07 05:25 UTC：按照指示重新启用并再次尝试重跑，依旧依赖锁判断。最终将任务停用、锁清理和事故日志记录在 SKILL.md，确保后续恢复时可以快速回溯。

记录来源：OpenClaw 日志 + cron.runs + 审查 `/tmp/codex-auths-hourly.lock`。
