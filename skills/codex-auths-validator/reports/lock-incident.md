# Codex Auths Incidents & Bug Logs（统一归档）

> 目的：本仓库所有“事故复盘 / bug 记录 / 架构教训”统一记录在这里。
> 
> 规则：
> - **SKILL.md / WORKFLOW.md / README.md 不再保留长篇事故日志**（只保留结论与链接）。
> - 这里按时间顺序追加，尽量写清：现象 → 根因 → 修复 → 预防。

---

## 2026-03-07：hourly 任务反复提示 already-running（锁残留/队列未清空）

### 现象
- hourly cron 一直输出“已有任务在运行，跳过本次”，整体校验停摆。

### 排查与处理
- 检查 `/tmp/codex-auths-hourly.lock`：文件存在但无对应进程（`lsof` 为空/无 `hourly-reconcile` 进程）。
- 手工删除锁后再触发，仍可能提示 already-running：推测旧队列未完全释放。
- 临时禁用 cron，等待 2–3 分钟后再启用。

### 教训
- **先确认无进程再删锁**，避免并发跑导致统计波动/目录迁移错乱。

---

## 2026-03-07：远端接口 500/timeout（临时错误保留策略）

### 现象
- 校验时收到：`Failed to load quota: 500 {"detail":"Request timeout"}`

### 处理
- 按规则判定为瞬时后端超时：`TRANSIENT_KEEP` 原位保留，下轮重试。

---

## 2026-03-09：Hourly Lock Incident（锁文件残留导致整体停摆）

### 影响范围
- `Codex auths 每小时自动校验清理（上海）` cron 任务反复提示“已有任务在运行”，导致整体校验停摆。
- Telegram 无法看到新的巡检结果，脚本执行状态卡在 `already-running`。

### 经过与分析
1. 检查 `/tmp/codex-auths-hourly.lock`，文件存在但没有进程占用（`lsof` 报空），说明上一次执行遗留了锁。
2. 手动删除锁后再次执行仍报“已有任务在运行”，推测旧任务一直在排队或者被 cron 防重复机制限流。
3. 临时禁用 cron、大量等待后再启用，确保下一轮整点不会被旧调度干扰。

### 修复
- `hourly-reconcile.mjs` 写入锁文件格式升级为：`pid
timestamp`。
- 新增 `LOCK_MAX_AGE_MS`（默认 15 分钟），超龄视为陈旧锁。
- 新增 `isProcessAlive(pid)` 检查 PID 是否存活。
- 新增 `cleanStaleLock()`：进程不存活或锁超龄 → 自动清锁并继续。

### 操作指南：清理 + 恢复流程（应急手册）
1. 终止旧执行（若存在）：确认没有 `hourly-reconcile` 进程在跑。
2. 删除老锁：`rm -f /tmp/codex-auths-hourly.lock`
3. 暂时禁用 cron，等待 2–3 分钟
4. 重新启用 cron，观察下一轮是否正常

---

## 2026-03-12：三层过期检测误判（refresh_token 续期失败直接判死）

### 现象
- hourly 跑完后 `auths` 与 `auths_no_quota` 变为 0。
- 131 个文件全部移入 invalid，原因 `INVALID_EXPIRED`。

### 根因
- 过期判断引入三层策略后：当 `refresh_token` 续期失败时，**直接判定 INVALID_EXPIRED**。
- 但 OpenAI 的 `access_token` 实际存活时间可能长于 JSON 中 `expired` 字段标注值：
  - `expired` 可能“看起来过期”
  - 但 API 仍然能 200
- 于是产生误判：把仍可用 token 当死号处理。

### 修复原则（关键）
- **续期失败不直接 INVALID**：`refresh_token` 失效后，继续用原 `access_token` 走 API 校验。
- 只有 API 返回 401/403 才最终判死（`INVALID_EXPIRED`/`INVALID_AUTH`）。

### 恢复
- 将 131 个文件移回 auths，再跑 hourly：
  - 31 有额度、95 无额度、5 真 401 失效

---

## 2026-03-12 ~ 2026-03-13：OpenClaw cron 40 小时未发通知（架构教训）

### 现象
- 用户报告“每小时验证没有发送消息”。
- `cron.runs` 显示 isolated job 连续失败/静默失败，累计约 34–40 小时。

### 时间线（排查分阶段）

阶段1（~20h）：fast-pool isolated agent
- 现象：All models failed / timeout / 502
- 原因：fast-pool agent/provider 侧不可用或无 auth key

阶段2（~10h）：改 agentId=main，但仍是 isolated sessionTarget
- 现象：`No API key found for provider "ak"` x36
- 原因：isolated session 独立初始化，不继承主 session 的 auth；该 agent 目录无 ak/self key

阶段3（~4h）：改 sessionTarget=main + systemEvent
- 现象：status=ok, deliveryStatus=not-requested, durationMs≈14s
- 原因：systemEvent 只是把文字入队到主 session，**不保证执行工具调用**；14 秒只是入队耗时

### 根因总结
> OpenClaw cron 的目标是“让 agent 定时对话/思考”，不是“可靠执行 shell 命令并发通知”。

### 最终解决方案（稳定）
- 放弃 OpenClaw cron delivery 执行“跑脚本+发 TG”。
- 改用：**系统 crontab + shell + curl**。
  - `scripts/hourly-run-and-notify.sh`：node 跑校验 + curl 直发 TG Bot API
  - 典型 crontab：`0 * * * * bash .../hourly-run-and-notify.sh >> /tmp/codex-auths-cron.log 2>&1`

### 预防措施（新机器必做）
1. 安装后立即配置系统 crontab 的 hourly-run-and-notify
2. 禁用/移除对应 OpenClaw cron（避免重复/互相干扰）
3. 手动执行脚本一次确认 TG 能收到后再离开
