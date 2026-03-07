---
name: codex-auths-validator
description: Validate Codex auth JSON files in user-provided directories using the Codex quota/usage endpoint https://chatgpt.com/backend-api/wham/usage. Use when cleaning useless credentials, importing JSONs from a .zip package, running hourly scheduled validation cleanup, running daily 00:00 GitHub learning checks, separating quota/rate-limit cases from truly invalid tokens, and quarantining removable JSON files.
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

## Decision rules

- `200` 且有额度 -> 放在 `/home/docker/CLIProxyAPI/auths`。
- `200` 但无额度（`limit_reached=true` 或 window `used_percent>=100`）-> 放在 `/home/docker/CLIProxyAPI/auths_no_quota`。
- `429`（限流/额度耗尽）-> 放在 `/home/docker/CLIProxyAPI/auths_no_quota`。
- `401/403`、坏 JSON、缺少 `access_token` / `account_id`、`._*.json` -> 无效（删除或隔离，按模式）。
- 非 `200/429/401/403` 默认按无效处理（可通过模式调整）。

## Safety mode

Move removable files into a timestamped quarantine folder first. Do not hard-delete immediately.

Quarantine location pattern:
- `/home/docker/CLIProxyAPI/auths/_quarantine_<timestamp>`

Write report file:
- `_validation_report.json`

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

典型命令：

```bash
node skills/codex-auths-validator/scripts/hourly-reconcile.mjs \
  --dir-quota /home/docker/CLIProxyAPI/auths \
  --dir-no-quota /home/docker/CLIProxyAPI/auths_no_quota \
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

## ZIP import workflow

When user provides a `.zip` file containing JSON auth files:

1. Extract zip into a temporary folder.
2. Validate extracted `*.json` files with the same decision rules in this skill.
3. Classify passed files into target folders:
   - valid + has quota (`200` with available quota) -> `/home/docker/CLIProxyAPI/auths`
   - valid but no quota (`200` no quota or `429`) -> `/home/docker/CLIProxyAPI/auths_no_quota`
4. Handle invalid files (invalid JSON, missing fields, `401/403`, AppleDouble) by configured policy (delete or quarantine).
5. Return import summary:
   - total in zip
   - imported to `auths`
   - imported to `auths_no_quota`
   - failed/deleted or failed/quarantined
   - failure reason histogram
   - imported file list (grouped by target folder)

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

Maintain snapshots so future changes can be compared quickly.

## Required sync policy (codex-auths-validator)

For any change related to `codex-auths-validator` (rules, user path handling, API endpoint, headers, cron behavior, workflow, docs, scripts):

1. Update this skill immediately (`SKILL.md` / `WORKFLOW.md` / `scripts/*` as needed).
2. Commit immediately with a Chinese commit message.
3. Push immediately to GitHub repository `LSH160981/skills-codex-auths-validator`.
4. Reply with commit id(s) after push.

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

## Mandatory auto-provision on new machine (2 cron jobs)

When this skill is installed/used on a new machine, ALWAYS ensure these two cron jobs exist automatically (create if missing, update if exists by name):

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

### Idempotent enforcement rule

Every time this skill runs in a new environment:
1. `cron.list(includeDisabled=true)`
2. find jobs by exact name
3. create missing jobs via `cron.add`
4. patch existing jobs via `cron.update` to keep schedule/payload consistent
5. report ensured job IDs to user

This guarantees both cron jobs auto-appear after skill deployment on any machine.

## Multi-user path policy (important)

This skill must work for any user environment, not only `/home/docker/CLIProxyAPI/auths`.

When user provides a JSON folder path, the skill should:
1. Accept the path directly as `auths_dir`.
2. Derive `auths_no_quota_dir` as `<auths_dir>_no_quota` unless user specifies another path.
3. Create missing target directories automatically.
4. Run the same validation/migration/delete rules without asking extra setup questions.

If no path is provided, run discovery first; only ask user when discovery has low confidence.

