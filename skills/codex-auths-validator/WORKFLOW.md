# Codex Auth JSON 批量验证与导入流程（完整封装）

> 目标：把"验证无效 JSON 并清理 + 接收 ZIP 验证后导入"的完整任务流程沉淀为可复用标准。

## 1. 任务背景

- 认证文件目录：默认可为 `/home/docker/CLIProxyAPI/auths`，但应支持任意用户提供路径（`auths_dir`）
- 文件类型：大量 `*.json`（以 Codex 凭证为主）
- 核心诉求：
  1. 自动识别并移除完全无用凭证
  2. 额度耗尽不删除（可保留）
  3. 支持 ZIP 包批量验证并导入通过文件

---

## 2. 验证接口与请求规范

### 验证接口

- `GET https://chatgpt.com/backend-api/wham/usage`

### 请求头

- `Authorization: Bearer <access_token>`
- `Chatgpt-Account-Id: <account_id>`
- `Content-Type: application/json`
- `User-Agent: codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal`

---

## 3. 判定规则（已固化）

### 自动识别 provider

优先读取 `type/provider`，其次按字段特征推断，覆盖：
`qwen/kimi/gemini/gemini-cli/aistudio/claude/codex/antigravity/iflow/vertex/unknown`。

### account_id 去重（在 API 校验之前）

扫描 `auths_dir`（有额度）+ `auths_no_quota_dir`（无额度）所有 JSON，对比 `account_id` 字段：
- **扫描顺序**：先扫 `auths_dir`，再扫 `auths_no_quota_dir`
- 同一 `account_id` 优先保留有额度的那份；其余重复文件移入 `auths_invalid_dir`，原因记为 `INVALID_DUPLICATE`
- 适用脚本：`hourly-reconcile.mjs`、`import-archive.mjs`

### 三层过期检测 + refresh_token 自动续期

在调用远程 API 之前，按三层优先级判断 token 是否过期：

```
优先级（高→低）：
  1. JWT id_token 里的 exp 字段（Base64 decode，最权威）
  2. json.expired 字段
  3. json.last_refresh + 7天（兜底推算，假设 codex token 7天有效期）
  无法判断 → 默认未过期，继续走 API
```

**过期后不直接丢弃**，先尝试 `refresh_token` 续期：

```
POST https://auth0.openai.com/oauth/token
{
  grant_type: "refresh_token",
  client_id: "pdlLIX2Y72MIl2rhLhTE9VV9bN905kBh",
  refresh_token: <json.refresh_token>
}

续期成功 → 写回文件（更新 access_token / expired / last_refresh / id_token），继续 API 校验（reason=refreshed）
refresh_token 失效（null / invalid_grant） → ⚠️ 不直接判 INVALID，继续用原 access_token 走 API 校验
  → API 返回 401 才判定 INVALID_EXPIRED（access_token 可能比 expired 字段标注时间更长存活）
网络/5xx → TRANSIENT_KEEP，原位保留，下次重试
```

适用脚本：`hourly-reconcile.mjs`、`import-archive.mjs`、`validate-auths.mjs`。

hourly summary 新增 `refreshedCount` 字段统计本轮续期成功数量。

### codex 类型

- 三层过期检测 → 尝试续期 → 续期成功用新 token；续期失败用原 token 继续 API → API 401 才判 `INVALID_EXPIRED`
- HTTP `200` 且有额度：保留在 `auths`
- HTTP `200` 但无额度：保留在 `auths_no_quota`
- HTTP `429`：限流/额度问题，不等于 token 失效，放 `auths_no_quota`
- HTTP `401/403`：无效，移入 `auths_invalid`

### 非 codex 类型

- 先做结构有效性校验（必要字段）
- 结构有效：保留（后续可按 provider 扩展远程验证）
- 结构无效：移入 `auths_invalid`

### 无效（INVALID）

- JSON 解析失败（坏文件）
- 缺少必要字段
- `._*.json`（AppleDouble 垃圾文件）
- codex 的 `401/403`
- token 过期且 refresh_token 也失效（`INVALID_EXPIRED`）
- account_id 重复（`INVALID_DUPLICATE`）

处理策略：
- 不直接删，先移动到无效目录（默认 `<auths_dir>_invalid`）
- 汇总时必须告知用户每个原因的数量，并询问是否删除这些无效 JSON
- invalid 目录积累超过 **500 个**时打印警告，提示清理命令：
  ```bash
  rm -rf /home/docker/CLIProxyAPI/auths_invalid/*
  ```

### 暂不删除（可复核）

- 网络超时、临时网络错误、5xx（默认保守处理，不改目录，只计入"临时错误保留"）

---

## 3.1 reports 目录自动清理（hourly-reconcile）

`hourly-reconcile.mjs` 启动时自动清理旧 report 文件：
- 默认保留最近 **72 个**（约 3 天），可通过 `--max-report-files <n>` 覆盖
- 按 mtime 排序，删除超出数量的最老文件
- 目的：避免 `reports/` 目录无限膨胀

---

## 4. 安全策略

不直接硬删，先移动到无效目录：

- `/home/docker/CLIProxyAPI/auths_invalid/`

并自动生成报告：

- `_validation_report.json`

用户确认后才可执行硬删除：

```bash
rm -rf /home/docker/CLIProxyAPI/auths_invalid/*
```

---

## 5. Skill 结构与文件

已创建 skill：`skills/codex-auths-validator/`

- `SKILL.md`：任务说明、规则、执行方式（内部标准）
- `scripts/validate-auths.mjs`：一次性人工校验/清理脚本（支持删除或隔离；含三层过期检测+续期+去重）
- `scripts/hourly-reconcile.mjs`：每小时定时任务专用稳定脚本（并发锁 + 三层过期检测 + 续期 + 去重 + report自动清理 + invalid积累警告）
- `scripts/import-archive.mjs`：ZIP/7z 导入接管脚本（仅 JSON，自动分层，含三层过期检测+续期+去重）
- `scripts/discover-auth-dir.mjs`：首次安装自动探测认证目录脚本（优先减少用户手动输入）
- `WORKFLOW.md`：本文件（完整流程说明）
- `README.md`：GitHub 对外说明（必须与 SKILL/WORKFLOW 同步更新）

---

## 6. 标准执行流程 A：目录内全量验证

统一入口参数（只给一个目录就能跑）：
- `--auth-dir <auths_dir>`：只给“有额度目录 auths”即可运行
- 自动推导：`<auths_dir>_no_quota` / `<auths_dir>_invalid` / `reports`（与 auths 同级）
- 仍可用 `--dir-quota/--dir-no-quota/--dir-invalid/--report-dir` 覆盖

流程：
1. 扫描 `<auths_dir>/*.json`
2. 先处理 `._*.json` → 直接隔离
3. 并发调用验证接口（默认并发 40）
4. 按规则判定 PASS/REMOVE
5. 无效文件移动到 invalid 目录（`<auths_dir>_invalid`）
6. 输出统计摘要 + 样本 + 报告 JSON

### 命令

```bash
node skills/codex-auths-validator/scripts/validate-auths.mjs
```

可选参数：

```bash
node skills/codex-auths-validator/scripts/validate-auths.mjs \
  --auth-dir /home/docker/CLIProxyAPI/auths \
  --concurrency 40 \
  --timeout-ms 12000
```

---

## 7. 标准执行流程 B：压缩包导入验证（ZIP/7z）

适用于"我给你一个 zip/7z，里面可能混有 JSON 和代码文件"的场景。

1. 解压压缩包到临时目录
2. 递归扫描全部文件
3. 仅 `*.json` 进入验证流程（自动接管）
4. 非 JSON 文件（代码/文本/二进制等）全部忽略（skill 不处理）
5. JSON 按规则分类落盘：
   - 有额度 -> `auths_dir`
   - 无额度/429 -> `auths_no_quota_dir`
   - 无效 -> `auths_invalid_dir`
6. 生成 `_import_report.json`

### 导入策略

- 目标目录重名时自动改名（`__importedN`）避免覆盖
- 导入结果返回：
  - 压缩包总文件数
  - JSON 处理数
  - 非 JSON 忽略数
  - 导入到有额度目录数量
  - 导入到无额度目录数量
  - 移入无效目录数量
  - 状态与原因分布

### 命令示例

```bash
node skills/codex-auths-validator/scripts/import-archive.mjs \
  --archive /path/to/auths_all---03fa8448.zip \
  --dir-quota /home/docker/CLIProxyAPI/auths \
  --dir-no-quota /home/docker/CLIProxyAPI/auths_no_quota \
  --dir-invalid /home/docker/CLIProxyAPI/auths_invalid
```

---

## 8. 本次实际执行结果（已完成）

### A. 全量目录清理

- 总 JSON：`5125`
- 有效 JSON：`3125`
- 无效 JSON：`2000`（均为 `._*.json`）
- 另有真实无效凭证：`1`（403 无账号权限）
- 共隔离：`2001`
- 保留：`3124`

### B. ZIP 导入（历史样本）

- ZIP 内 JSON：`50`
- 验证通过并导入：`50`
- 隔离失败：`0`
- 命中状态：`ok_200 × 50`

### C. 7z 导入（最新）

- 归档类型：`.7z`
- 总 JSON：`1145`
- 导入到 `auths`（有效有额度）：`1145`
- 导入到 `auths_no_quota`（有效无额度）：`0`
- 移入 `auths_invalid`（无效）：`0`
- 命中状态：`VALID_QUOTA × 1145`

### D（Snapshot E）：ZIP 导入 #1（auths_all---03fa8448...zip）

- 总文件：`6302`，JSON：`6301`
- 导入 auths（有额度）：`34`
- 导入 auths_no_quota：`99`
- 移入 auths_invalid：`6168`（原因：INVALID_AUTH 401）
- 后续手动删除 6168 个 INVALID_AUTH 文件：`rm -rf /home/docker/CLIProxyAPI/auths_invalid/*`

### E（Snapshot F）：ZIP 导入 #2（auths_all---412a6374...zip）

- 总文件：`6302`，JSON：`6301`
- INVALID_EXPIRED：`6300`，INVALID_MISSING_FIELDS：`1`
- 导入 auths：`0`，导入 auths_no_quota：`0`
- 全部移入 auths_invalid，后续手动清空（共 6434 个文件）：`rm -rf /home/docker/CLIProxyAPI/auths_invalid/*`

### Success snapshots（历史对比，用于回归）

- Snapshot A：local auth dir full validation
  - total: 5125 / kept: 3124 / removed: 2001
- Snapshot B：zip import #1
  - total json: 50 / imported: 50
- Snapshot C：zip import #2
  - total json: 1000 / imported: 999 / failed: 1 (auth_403)
- Snapshot D：7z import
  - total json: 1145 / imported to auths: 1145 / moved to invalid: 0
- Snapshot E：ZIP import #1（auths_all---03fa8448...zip）
  - total json: 6301 / imported auths: 34 / imported no_quota: 99 / invalid: 6168 (401)
- Snapshot F：ZIP import #2（auths_all---412a6374...zip）
  - total json: 6301 / INVALID_EXPIRED: 6300 / INVALID_MISSING_FIELDS: 1

---

## 9. 失败原因分类（建议长期沿用）

- `INVALID_JSON`：JSON 格式损坏
- `INVALID_MISSING_FIELDS`：缺少必要字段（access_token / account_id）
- `INVALID_AUTH`：认证失败（401/403）
- `INVALID_EXPIRED`：token 过期、refresh_token 失效、且 API 也返回 401（三重确认才丢弃）
- `INVALID_DUPLICATE`：account_id 重复，优先保留有额度的，其余移入 invalid
- `INVALID_APPLEDOUBLE`：`._*.json` 垃圾文件
- `TRANSIENT_KEEP`：临时错误（网络/5xx/续期失败），原位保留下次重试
- `timeout`：请求超时（属于临时错误，原位保留）
- `status_<code>`：其他非预期 HTTP 状态码

**invalid 目录清理命令：**

```bash
rm -rf /home/docker/CLIProxyAPI/auths_invalid/*
```

---

## 10. 运维建议（已调整）

这个 skill 固定要求有 **三个定时任务**，并且在未来安装到其他机器时要**自动出现**（自动检查并补齐）。

### ⚠️ 重要架构决策：每小时校验通知必须用系统 crontab

**OpenClaw cron 不适合"无人值守执行 shell 脚本 + 发 TG"场景：**
- `isolated agentTurn` 模式：需要独立 agent 有自己的 auth-profiles.json，否则静默失败
- `main systemEvent` 模式：只入队文字，不保证主 session 实际执行工具调用

**正确做法（已落地）：**
```bash
# 新机器安装时执行一次（只配置一个目录即可运行）
(crontab -l 2>/dev/null | grep -v hourly-run-and-notify; \
 echo "0 * * * * AUTH_DIR=/home/docker/CLIProxyAPI/auths bash /root/.openclaw/workspace/skills/codex-auths-validator/scripts/hourly-run-and-notify.sh >> /tmp/codex-auths-cron.log 2>&1") | crontab -
```

`scripts/hourly-run-and-notify.sh` 内置：
- 运行 `hourly-reconcile.mjs`
- TG 先发**精简摘要**（不刷屏）；若 `auths` 与 `auths_no_quota` 两个目录都为空（以目录内 `*.json` 文件数判定，避免解析输出误判），则只发**极简通知**；异常/无效/临时错误时再自动附详细日志文件
- 日志落盘：`/tmp/codex-auths/hourly-reconcile-*.log`（另有 crontab 运行日志 `/tmp/codex-auths-cron.log`）

---

首次安装应先执行自动探测：

```bash
node skills/codex-auths-validator/scripts/discover-auth-dir.mjs
```

若探测到 `recommended` 路径，直接作为认证目录；仅在探测失败时才向用户提问目录路径。

若用户直接给出目录路径，则跳过探测，直接使用用户路径作为 `auths_dir`，并自动创建：
- `<auths_dir>_no_quota`
- `<auths_dir>_invalid`

并立即执行一次全量校验分层，随后自动创建/修复定时任务。

然后再创建并启用两个任务：

1. **每小时自动校验清理任务**（上海时区，双目录流转）
   - 同时扫描：
     - `/home/docker/CLIProxyAPI/auths`（有效且有额度）
     - `/home/docker/CLIProxyAPI/auths_no_quota`（有效但无额度/限流）
   - 启动时动作：
     - account_id 去重（先 auths 后 auths_no_quota，重复 → `INVALID_DUPLICATE` 移入 invalid）
     - reports 目录自动清理（默认保留最近 72 个，可 `--max-report-files` 配置）
   - 判定与动作：
     - 三层过期检测 → 过期先尝试 refresh_token 续期（成功写回文件，reason=refreshed）
     - `200` 且有额度 -> 放回/保留在 `auths`
     - `200` 但无额度 或 `429` -> 放到 `auths_no_quota`
     - `401/403`、坏 JSON、缺字段、`._*.json`、`INVALID_EXPIRED` -> 移入 `auths_invalid`
     - `timeout/network/5xx` 等临时错误 -> `TRANSIENT_KEEP` 原位保留，下次重试
   - 下次每小时继续双目录复检，额度恢复则自动移回 `auths`
   - invalid 目录积累超过 500 个时打印清理警告
   - 完成后给用户发送统计汇总（总检查/有额度/无额度/invalid迁移/迁移统计/原因统计/refreshedCount/临时错误保留）

2. **每日 00:00 GitHub 学习巡检任务**（上海时区）
   - 定点学习相关仓库和代码变化
   - 检查可变项：路径、JSON 结构、接口、请求头、状态码语义
   - 如有变化，更新 skill 并发送学习总结

3. **每日 00:00 技能同步任务**（上海时区）
   - 同步仓库：`https://github.com/LSH160981/skills-codex-auths-validator.git`
   - 拉取最新 skill 内容并覆盖本地 `skills/codex-auths-validator/*`
   - 如有更新，立即告知用户同步结果

自动化要求（新机器必做）：
- 启动时先 `cron.list(includeDisabled=true)`
- 按任务名查找是否存在
- 缺失就 `cron.add`
- 已存在就 `cron.update` 保持规则一致
- 每小时任务统一调用 `hourly-reconcile.mjs`（含并发锁与临时错误保留策略）
- **⚠️ 所有 cron 任务必须设置 `agentId: "main"`**，不可使用 fast-pool 等 isolated agent（isolated agent 无 auth key 时会静默失败，用户无感知）
- sessionKey 统一为 `agent:main:telegram:direct:<chatId>`
- 最终向用户报告这两个任务的 job id

---

## 11. 运行截图使用原则

- 运行截图用于 README 展示"真实执行效果"。
- 不需要在技能流程里加入 OCR 识别能力。
- 如需展示，直接把原图放入仓库 `assets/` 并在 README 以图片方式引用。

## 12. 一句话总结

这套流程已经实现：**可批量验证、可追踪、可回滚、可导入、可复用**，并且严格遵守"额度耗尽保留、token失效移除"的业务规则。

---

## 13. 事故复盘与架构教训

### 事故：OpenClaw cron 40小时未发通知（2026-03-12 ~ 2026-03-13）

**时间线：**

```
阶段1（~20h）：fast-pool isolated agent
  → 错误：All models failed: 502/timeout
  → 原因：fast-pool provider（self）全部不可用

阶段2（~10h）：改 agentId=main，仍是 isolated sessionTarget
  → 错误：No API key found for provider "ak"（x36次）
  → 原因：isolated session 独立初始化，不继承主 session auth key
           auth-profiles.json 只有 qwen/minimax，无 ak/self

阶段3（~4h）：改 sessionTarget=main + systemEvent
  → 状态：status=ok，deliveryStatus=not-requested，durationMs≈14s
  → 原因：systemEvent 只是把文字推入主 session 消息队列
           主 session 未必在线，即使在线也不保证处理工具调用
           14秒是入队耗时，脚本从未被执行

阶段4（修复）：系统 crontab + shell + curl
  → 彻底绕开 OpenClaw cron delivery 机制
  → node 脚本直接跑，curl 直接发 TG Bot API
  → 100% 可靠，不依赖任何 LLM session 或 auth key
```

**根因总结：**
> OpenClaw cron 的设计目标是"让 AI agent 定时执行任务"，不是"定时执行 shell 命令"。对于需要稳定执行 shell 脚本 + 发通知的场景，系统 crontab 是唯一可靠选择。

**预防措施（新机器必做）：**
1. 安装后立即用系统 crontab 设置 `hourly-run-and-notify.sh`
2. 禁用对应的 OpenClaw cron 任务，避免重复/干扰
3. 验证方法：手动执行脚本一次，确认 TG 收到消息后再离开