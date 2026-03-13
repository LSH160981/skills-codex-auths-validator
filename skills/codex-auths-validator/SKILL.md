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

## Deduplication rules（去重规则）

在校验之前，先扫描 `auths_dir` + `auths_no_quota_dir` 所有 JSON，对比 `account_id` 字段：
- 扫描顺序：**先扫 `auths_dir`（有额度）再扫 `auths_no_quota_dir`（无额度）**
- 同一 `account_id` 优先保留有额度的那个；其余重复文件移入 `auths_invalid_dir`，原因记为 `INVALID_DUPLICATE`

此逻辑适用于：
- `hourly-reconcile.mjs`（每小时校验前自动去重）
- `import-archive.mjs`（ZIP/7z 导入后、输出报告前自动去重）

## Pre-flight expiry check + 自动续期（Token Refresh）

在调用远程 API 之前，按三层优先级判断 token 是否过期：

```
优先级（高→低）：
  1. JWT id_token 里的 exp 字段（Base64 decode，最权威）
  2. json.expired 字段
  3. json.last_refresh + 7天（兜底推算，假设 codex token 7天有效期）
  无法判断 → 默认未过期，继续走 API
```

**过期后不直接丢弃**，而是先尝试用 `refresh_token` 续期：

```
POST https://auth0.openai.com/oauth/token
{
  grant_type: "refresh_token",
  client_id: "pdlLIX2Y72MIl2rhLhTE9VV9bN905kBh",
  refresh_token: <json.refresh_token>
}

续期成功 → 写回文件（更新 access_token / expired / last_refresh / id_token），继续 API 校验
refresh_token 失效（null / invalid_grant） → ⚠️ 不直接判 INVALID，继续用原 access_token 走 API 校验
  → API 返回 401 才判定 INVALID_EXPIRED（access_token 可能比 expired 字段标注时间更长存活）
网络/5xx → TRANSIENT_KEEP，原位保留，下次重试
```

此逻辑适用于三个脚本：`hourly-reconcile.mjs`、`import-archive.mjs`、`validate-auths.mjs`。

## Report 文件自动清理（reports 目录）

`hourly-reconcile.mjs` 启动时自动清理旧 report 文件：
- 默认保留最近 **72 个**（对应约 3 天），可通过 `--max-report-files <n>` 覆盖
- 按 mtime 升序排列，删除超出数量的最老文件
- 防止 reports 目录无限膨胀

## Invalid 目录积累警告

当 `auths_invalid` 累积超过 **500 个**文件时，hourly-reconcile 会在报告尾部打印：
```
⚠️ auths_invalid 已积累 N 个文件，建议运行清理命令：rm -rf /path/to/auths_invalid/*
```

## Decision rules

### A) codex 类型（可做远程额度验证）
- 过期检测（三层）→ 尝试 refresh_token 续期 → 续期成功则用新 token；续期失败则用原 token 继续走 API → API 返回 401 才判 `INVALID_EXPIRED`
- `200` 且有额度 -> 放在 `auths_dir`
- `200` 但无额度（`limit_reached=true` 或 window `used_percent>=100`）-> 放在 `auths_no_quota_dir`
- `429`（限流/额度耗尽）-> 放在 `auths_no_quota_dir`
- `401/403` -> 判定无效，移入 `auths_invalid_dir`
- `5xx/timeout/network` -> 临时错误，原位保留（不迁移）

### B) 非 codex 类型（先做结构有效性校验）
- 必要字段满足 -> 结构有效，保留原位（可选后续接入 provider 专用远程验证）
- 必要字段缺失 / 坏 JSON / `._*.json` -> 判定无效，移入 `auths_invalid_dir`

## 统一状态输出（用于给用户解释"为什么无效"）

- `VALID_QUOTA`：有效且有额度
- `VALID_NO_QUOTA`：有效但无额度/被限流
- `INVALID_AUTH`：认证失败（401/403）
- `INVALID_EXPIRED`：token 过期、refresh_token 失效、且 API 也返回 401（三重确认才丢弃）
- `INVALID_JSON`：JSON 格式损坏
- `INVALID_MISSING_FIELDS`：缺少必要字段
- `INVALID_APPLEDOUBLE`：`._*.json` 垃圾文件
- `SCHEMA_VALID_PROVIDER`：非 codex，结构有效（保留）
- `INVALID_DUPLICATE`：account_id 重复，优先保留有额度的，其余移除
- `TRANSIENT_KEEP`：临时错误（网络/5xx/续期失败），原位保留下次重试
- reason=`refreshed`：token 已过期但通过 refresh_token 成功续期并继续校验

Move invalid files into `auths_invalid_dir` (default: `<auths_dir>_invalid`). Do not hard-delete immediately.

Invalid directory location pattern:
- `/home/docker/CLIProxyAPI/auths_invalid/`

Write report file:
- `_validation_report.json`

Bulk cleanup command (after user confirmation):
```bash
rm -rf /home/docker/CLIProxyAPI/auths_invalid/*
```

## 入口原则（项目主标语）

**OpenClaw 的 Codex 认证 JSON 自动化验证技能：每小时清理、ZIP/7z 导入校验、每日 GitHub 学习巡检。**

**只要告诉我 JSON 文件存放的目录，我就能自己工作。**

如果用户不提供目录：
- 默认视为用户可能安装了 `Cli-Proxy-API-Management-Center`。
- 按源项目配置与 Docker 挂载线索自动探测目录（`auth-dir` 优先）。

## 首次安装引导（降低新用户操作）

如果用户第一次使用本 skill，先走"自动发现 + 最少提问"流程：

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
- 支持无效文件 `delete` 或 `invalid` 两种模式（`invalid` 表示移动到 `auths_invalid_dir`）。

典型命令：

```bash
node skills/codex-auths-validator/scripts/validate-auths.mjs \
  --dir-quota /home/docker/CLIProxyAPI/auths \
  --dir-no-quota /home/docker/CLIProxyAPI/auths_no_quota \
  --invalid-action invalid \
  --concurrency 40 \
  --timeout-ms 12000
```

`--invalid-action`:
- `delete`：无效文件直接删除
- `invalid`：无效文件移入 `auths_invalid_dir`（默认 `<auths_dir>_invalid`）

### 3) `scripts/hourly-run-and-notify.sh`（系统 crontab 专用，直发 TG）

用途：
- 供系统 crontab 每小时调用，**完全不依赖 OpenClaw cron delivery 机制**。
- 直接运行 `hourly-reconcile.mjs`，默认发**精简摘要**；若 `auths` 与 `auths_no_quota` 两个目录都为空（以目录内 `*.json` 文件数判定，避免解析输出误判），则只发**极简通知**；并在异常/无效/临时错误时自动附带详细日志文件。
- 这是最稳定的通知方式：不需要 LLM session，不受 auth-profiles.json 影响。

系统 crontab 条目：
```bash
0 * * * * bash /root/.openclaw/workspace/skills/codex-auths-validator/scripts/hourly-run-and-notify.sh >> /tmp/codex-auths-cron.log 2>&1
```

安装命令：
```bash
(crontab -l 2>/dev/null | grep -v hourly-run-and-notify; echo "0 * * * * bash /root/.openclaw/workspace/skills/codex-auths-validator/scripts/hourly-run-and-notify.sh >> /tmp/codex-auths-cron.log 2>&1") | crontab -
```

### 5) `scripts/hourly-reconcile.mjs`（每小时定时任务专用，稳定版）

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
- invalid directory path
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

After user confirms, delete invalid directory and import temp folders:

```bash
rm -rf /home/docker/CLIProxyAPI/auths_invalid/*
rm -rf /tmp/codex-auths-import-<timestamp>
```

Bulk cleanup command (remove all historical import temp folders):

```bash
for d in /tmp/codex-auths-import-*; do
  [ -e "$d" ] && rm -rf "$d"
done
```

## Hourly scheduled validation & delete workflow

When user asks for hourly auto-clean:

1. Create a cron job (Asia/Shanghai) with `expr: 0 * * * *`.
2. Each run validates all `*.json` in `/home/docker/CLIProxyAPI/auths`.
3. Move all unqualified files into `auths_invalid_dir` (no hard delete) based on rules:
   - unqualified: 401/403, malformed JSON, missing token/account_id, `._*.json`
   - qualified: 200/429
4. Send user summary after each run in Chinese:
   - 总共：<总数> 个
   - 合格的：<合格数> 个
   - 不合格并删除的：<删除数> 个
   - 删除原因统计：<按原因计数>
5. If failed, report error and processed progress.

Recommended cron payload style（结论）：
- **不要用 OpenClaw cron 来做"每小时跑脚本+发TG"**（见 Incident Log 2026-03-13）。
- 该场景必须用**系统 crontab + `scripts/hourly-run-and-notify.sh`**。
- OpenClaw cron 仅保留用于"AI 学习巡检/总结"等纯 agentTurn 任务。

## 对话总结（阶段成果，需持续更新）

以下为本技能从0到1的关键对话沉淀（用于新维护者快速理解）：

1. **基础能力落地**：先实现 codex JSON 批量验证、失效清理、ZIP 导入。
2. **双目录分层**：将"有效有额度/有效无额度"拆分为 `auths_dir` 与 `auths_no_quota_dir`。
3. **稳定性修复**：新增每小时巡检并发锁，避免重叠执行导致统计波动。
4. **无效文件策略升级**：无效文件不直接删，统一入 `auths_invalid_dir` 并附原因，询问用户是否删除。
5. **多 provider 识别**：对齐 Cli-Proxy-API-Management-Center 类型体系，先识别 provider 再选择验证方式。
6. **归档接管能力**：支持 ZIP/7z，自动只处理 JSON，忽略代码和其他非 JSON 文件；新增专用脚本 `import-archive.mjs`。
7. **新手零配置体验**：用户只给 JSON 目录即可自动接管；若未提供则按 CPA 线索自动探测 `auth-dir`。
8. **自动化运维闭环**：固定 3 个定时任务（小时清理/每日学习/每日同步）。
9. **文档与仓库同步纪律**：任何改动必须同步 SKILL + WORKFLOW + README，并立即中文 commit + push。
10. **三层JWT过期检测**：优先级 JWT id_token exp > expired 字段 > last_refresh+7天，无法判断默认未过期继续 API 校验。
11. **refresh_token 自动续期**：过期先尝试续期并写回文件救回可用账号；invalid_grant 才 INVALID_EXPIRED；网络错误 TRANSIENT_KEEP。
12. **account_id 去重**：扫描顺序先有额度后无额度，优先保留有额度账号，重复移入 invalid（INVALID_DUPLICATE）。
13. **reports 目录自动清理**：hourly-reconcile 启动时自动清理旧报告，默认保留最近 72 个，--max-report-files 可配置。
14. **invalid 目录积累警告**：超过 500 个时打印警告，提示 `rm -rf .../auths_invalid/*` 清理命令。
15. **validate-auths.mjs 功能对齐**：加入三层过期检测 + refresh_token 续期 + account_id 去重，与 hourly/import 行为一致。
16. **续期失败不直接 INVALID（关键修复）**：refresh_token 失效时不直接丢弃，继续用原 access_token 走 API 校验——因为 OpenAI access_token 实际存活时间可能长于 `expired` 字段标注值。只有 API 返回 401 才最终判定失效。
17. **cron agentId 必须用 main（运维经验）**：isolated agent（如 fast-pool）需要独立 auth-profiles.json；若未配置则所有 isolated cron job 会静默 auth 失败，无任何运行输出，用户无感知。创建/修复 cron 任务时统一使用 `agentId: "main"`，sessionKey 对应 `agent:main:telegram:direct:<chatId>`。
18. **定时任务通知必须用系统 crontab + shell + curl（架构决策）**：OpenClaw cron 的两种模式（isolated agentTurn / main systemEvent）均不适合"无人值守执行 shell 脚本+发 TG"场景。isolated 模式需独立 auth key；main systemEvent 只入队文字不保证执行。**正确做法**：系统 crontab 直接跑 shell 脚本，curl 调 Telegram Bot API 发通知，完全不依赖 LLM session。新增 `scripts/hourly-run-and-notify.sh` 封装此逻辑。

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
- **Required Codex usage request header**: `Chatgpt-Account-Id` (resolved from auth file `id_token` payload field `chatgpt_account_id` / `chatgptAccountId`).
- Usage payload schema (frontend expectation):
  - `plan_type`
  - `rate_limit` / `code_review_rate_limit` with `primary_window`/`secondary_window` and `used_percent`, plus `limit_reached`.
  - `additional_rate_limits[]` (for extra metered features).
- Auth-files status toggle behavior reverted to a dedicated backend endpoint:
  - `PATCH /auth-files/status` with body `{ name, disabled }`.
  - Response contains `{ status, disabled }` and UI uses returned `disabled` to confirm final state.
- Auth-files UI also treats `status_message` or `statusMessage` as the status message source.
- 403/404 are rendered as credential/update hints in UI, but operational cleanup here treats 401/403 as invalid credentials and 429 as pass.

### Mutable inputs (must re-verify when changed)

Always re-check these before running bulk cleanup in a new environment:

1. Auth directory path (default now: `/home/docker/CLIProxyAPI/auths`).
2. Validation endpoint and required headers.
3. JSON field schema (`type`, `access_token`, `account_id`).
4. User policy on invalid archive vs direct delete.
5. User policy on timeout/network handling.

### Learning update protocol

When new evidence appears (new GitHub version, API change, user policy change):

1. Record what changed and why in this section.
2. Update decision rules and execution commands.
3. Re-test with a small sample before full batch.
4. Keep success snapshots (counts + key reasons) for regression comparison.
5. If schedule behavior changes, update cron workflow text too.

### Lock management enhancement (2026-03-09)

`hourly-reconcile.mjs` lock file format was upgraded from `pid\n` to `pid\ntimestamp\n`.

New behavior:
- `LOCK_MAX_AGE_MS` (default 900000 = 15 min): stale threshold
- `cleanStaleLock()`: auto-removes lock if owning PID is dead OR lock age ≥ 15 min
- Prevents permanent cron stall from zombie lock files
- `--lock-max-age-ms` CLI flag allows override

Key: this means a lock surviving more than 15 minutes will be auto-cleared on next startup - no more manual `rm -f /tmp/codex-auths-hourly.lock` needed.

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
- Snapshot E: ZIP import #1 (auths_all---03fa8448...zip)
  - total files: 6302
  - json files: 6301
  - imported to auths (quota): 34
  - imported to auths_no_quota: 99
  - moved to auths_invalid: 6168 (INVALID_AUTH 401)
  - post-action: manually deleted 6168 INVALID_AUTH files
- Snapshot F: ZIP import #2 (auths_all---412a6374...zip)
  - total files: 6302
  - json files: 6301
  - INVALID_EXPIRED: 6300
  - INVALID_MISSING_FIELDS: 1
  - imported to auths: 0
  - imported to auths_no_quota: 0
  - post-action: manually cleaned auths_invalid (6434 files)

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

Recommended cron payload style: `sessionTarget: isolated`, `payload.kind: agentTurn`, `agentId: "main"`（必须用 main，确保 auth 可用）.

## Mandatory auto-provision on new machine (3 cron jobs)

When this skill is installed/used on a new machine, ALWAYS ensure these three cron jobs exist automatically (create if missing, update if exists by name):

### Job A: Hourly auth validation cleanup（系统 crontab）

> 结论：该任务必须用系统 crontab（OpenClaw cron 不可靠，见 Incident Log 2026-03-13）。

- Name（crontab）：`Codex auths hourly-run-and-notify`
- Schedule：`0 * * * *`（Asia/Shanghai 在系统层面按服务器时区；如需严格上海时区请把服务器 TZ 设为 Asia/Shanghai）
- Command：

```bash
0 * * * * bash /root/.openclaw/workspace/skills/codex-auths-validator/scripts/hourly-run-and-notify.sh >> /tmp/codex-auths-cron.log 2>&1
```

- Behavior（双目录流转 + 稳定通知）：
  - 调用 `scripts/hourly-reconcile.mjs` 扫描并迁移：
    - `/home/docker/CLIProxyAPI/auths`
    - `/home/docker/CLIProxyAPI/auths_no_quota`
    - `/home/docker/CLIProxyAPI/auths_invalid`
  - 输出通过 Telegram Bot API 发送给用户（超长自动改发文件）
  - 失败重试 3 次（TG sendMessage/sendDocument）
  - 本地日志：`/tmp/codex-auths-cron.log` + `/tmp/codex-auths/hourly-reconcile-*.log`

- 依赖：
  - TG token/chatId 已硬编码在脚本内（按用户要求“关键信息直接体现在代码上”）
  - 不依赖 OpenClaw agent session / auth-profiles.json

> OpenClaw cron 里的同名 job（如果存在）应禁用，避免重复跑。

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

- 2026-03-07 05:20 UTC：检测到 hourly cron 一直输出"已有任务在运行，跳过本次"，说明 `/tmp/codex-auths-hourly.lock` 可能残留导致新一轮被阻止。
  - 采取：查找 `/tmp/codex-auths-hourly.lock`，确认无对应进程后手动删除锁，避免脚本误判。
  - 结果：再次调用 `cron.run` 仍被判"already-running"，推测旧执行尚未结束，因此先暂停任务。
- 2026-03-07 05:24 UTC：确认无正在运行的 `hourly-reconcile` 进程后，删除锁文件并重新 `cron.run`。
  - 观察：又被调度拒绝，说明旧队列还在空转，最终选择禁用 cron 以彻底结束这次事故。
- 2026-03-07 05:25 UTC：按照指示重新启用并再次尝试重跑，依旧依赖锁判断。最终将任务停用、锁清理和事故日志记录在 SKILL.md，确保后续恢复时可以快速回溯。

记录来源：OpenClaw 日志 + cron.runs + 审查 `/tmp/codex-auths-hourly.lock`。

- 2026-03-07 08:24 UTC：脚本在验证 JSON 时收到 `Failed to load quota: 500 {"detail":"Request timeout"}`。
  - 采取：确认与调度的 500/timeout 属于瞬时后端超时，按流程把文件保留原位（transient keep），不移出。
  - 结果：在日志中记录该状态以便后面观察是否重复发生；若持续 500 则需要检查网络/接口稳定性。

- 2026-03-09 10:53~11:13 UTC：hourly-reconcile 锁故障事件（对应上海时间 2026-03-09 傍晚）。
  - 现象：cron 任务反复提示"已有任务在运行，跳过本次"，整体校验停摆，Telegram 不再收到巡检结果。
  - 原因：`/tmp/codex-auths-hourly.lock` 残留（上次执行遗留），锁文件存在但无进程占用。旧版只写 `PID` 无时间戳，无法判断是否为陈旧锁。
  - 修复（commit 6a3f41d "增强锁管理"）：
    - `hourly-reconcile.mjs` 现在写入 `pid\ntimestamp` 格式到锁文件。
    - 新增 `LOCK_MAX_AGE_MS`（默认 900000ms = 15分钟），超龄即视为陈旧锁。
    - 新增 `isProcessAlive(pid)` 检查锁 PID 是否存活。
    - 新增 `cleanStaleLock()`：进程不存活 OR 锁年龄 >= 15min，自动清除陈旧锁并继续启动。
    - 恢复指南文档已归档为 `reports/lock-incident.md`。
  - 恢复流程要点：检查锁 -> `lsof`/`pgrep` 确认无进程 -> `rm -f /tmp/codex-auths-hourly.lock` -> 禁用 cron -> 等 2-3 分钟 -> 重新启用。
  - 影响评估：锁增强后，陈旧锁（进程已死或超 15 分钟）会被自动清理，不再阻塞后续执行。

- 2026-03-12 14:59 UTC：三层过期检测误判导致 131 个有效 token 被全部移入 invalid。
  - 现象：hourly-reconcile 跑完后 auths 和 auths_no_quota 变为 0，131 个文件全入 invalid，原因 INVALID_EXPIRED。
  - 根因：新增三层过期检测后，`refresh_token` 续期失败时直接判定 `INVALID_EXPIRED`，没有继续走 API 校验。但 OpenAI access_token 实际存活时间可能长于 `expired` 字段标注值，导致过期字段显示过期但 API 仍能返回 200。
  - 修复：`refresh_token` 失效后不再直接 INVALID，继续用原 `access_token` 走 API 校验，只有 API 返回 401 才最终判定 `INVALID_EXPIRED`。适用脚本：`hourly-reconcile.mjs`、`import-archive.mjs`。
  - 恢复：将 131 个文件移回 auths，重新跑 hourly-reconcile，结果：31 有额度、95 无额度、5 真正 401 失效。
  - 教训：**过期字段只能做"提前预判"辅助，不能替代 API 校验做最终决策。API 说了算。**

- 2026-03-13 00:25~01:34 UTC：cron 任务 agent 配置错误，所有 isolated job 连续静默失败约 34 小时。
  - 现象：用户报告"每小时验证没有发送消息"，查 `cron.runs` 发现错误为 `All models failed: ak/claude-sonnet-4-6: No API key found for provider "ak"... (auth)` 连续 34 次。
  - 根因：cron 任务的 `agentId` 为 `fast-pool`（isolated agent），该 agent 目录下 `auth-profiles.json` 无可用 API key，无法启动 LLM session 执行任务，但调度器不抛出运行级别告警，故用户无感知。注意：delivery 目标之前也存在 `@heartbeat` 无法解析的投递错误（Bad Request: chat not found）。
  - 修复：将全部 cron 任务的 `agentId` 改为 `main`，直接使用主 session 的 auth 配置。同步更新 `sessionKey` 为 `agent:main:telegram:direct:REDACTED_TG_CHAT`。
  - 涉及任务：Codex auths 每小时校验 / 模型健康巡检 / GitHub 学习巡检（共 3 个）
  - 教训：**cron isolated job 使用独立 agent 时，必须确认该 agent 目录有有效 auth key，否则会静默失败。优先使用 `agentId: main` 或提前验证 isolated agent 的 auth-profiles.json。**
  - 操作建议：创建/更新 cron 任务时，始终指定 `agentId: "main"` 和对应 `sessionKey: "agent:main:telegram:direct:<chatId>"`，除非明确需要 isolated agent 且已确认其 auth 配置。

- 2026-03-13 01:34~02:27 UTC：OpenClaw cron delivery 机制根本无法可靠执行脚本+发TG，约40小时持续未发通知。

  **事故时间线（三阶段排查）：**

  | 时间 | 阶段 | 现象 | 错误原因 |
  |------|------|------|---------|
  | 最初 | fast-pool isolated | 连续 timeout/auth 失败 | fast-pool agent 无 auth key |
  | 中期 | agentId=main isolated | `No API key found for provider "ak"` x36次 | isolated session 独立创建，读不到主 session auth |
  | 后期 | sessionTarget=main systemEvent | status=ok, deliveryStatus=not-requested | systemEvent 只入队文字，不保证我实际执行工具调用 |

  **根因分析：**
  - OpenClaw cron 的 `sessionTarget: isolated` + `payload: agentTurn` 需要独立 LLM session 有自己的 auth key（不继承主 session）
  - `sessionTarget: main` + `payload: systemEvent` 只是把文字注入主 session 消息队列，但主 session 未必在线处理，durationMs=14秒仅是入队耗时，脚本从未被执行
  - 两种模式都不适合"无人值守、定时执行 shell 脚本 + 发 TG"场景

  **最终解决方案（已落地）：**
  - 放弃 OpenClaw cron delivery，改用**系统 crontab** 直接执行
  - 新增脚本：`scripts/hourly-run-and-notify.sh`（node 跑校验 + curl 直发 TG）
  - 系统 crontab 条目：`0 * * * * bash /root/.openclaw/workspace/skills/codex-auths-validator/scripts/hourly-run-and-notify.sh >> /tmp/codex-auths-cron.log 2>&1`
  - OpenClaw cron 任务 `eb8ad007-426f-4061-ba30-5c48c2e7e8da` 已禁用

  **根本教训：需要"定时执行命令 + 直接发通知"的自动化任务，必须用系统 crontab + shell + curl，不要依赖 OpenClaw cron delivery 机制。**
