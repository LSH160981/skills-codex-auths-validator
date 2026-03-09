# Codex Auths Hourly Lock Incident（2026-03-09）

## 影响范围
- `Codex auths 每小时自动校验清理（上海）` cron 任务反复提示“已有任务在运行”，导致整体校验停摆。
- 用户在 Telegram 上无法看到新的巡检结果，脚本执行状态卡在 `already-running`。

## 经过与分析
1. 检查 `/tmp/codex-auths-hourly.lock`，文件存在但没有进程占用（`lsof` 报空），说明上一次执行遗留了锁。
2. 手动删除 `/tmp/codex-auths-hourly.lock`，再次执行 `hourly-reconcile.mjs` 仍报“已有任务在运行”，推测旧任务一直在排队或者被 cron 防重复机制限流。
3. 临时禁用 cron、大量等待后再启用，确保下一轮的 `cron.run`（小时整点）不会被旧调度干扰。手工尝试跑脚本两次，第一次中途被 kill、第二次直接被 “already-running” 判定，说明新任务还没完全释放；需等几分钟再自动触发。
4. 重启 cron 后，仍保持观察下一轮是否成功；如果卡住，再重复删除锁 + 暂停 cron，待确认自动调度完成后再启用。

## 处理建议
- 继续监控小时 cron 的下一次运行，确保不再报 `already-running`；如果仍报，重复锁清理并提高并发锁超时时间。
- 日志写入 `skills/codex-auths-validator/SKILL.md` 的 Incident Log（已有 3/7 记录，可追加此次 3/9 过程）。
- 以后每次 `already-running` 先检查 `/tmp/codex-auths-hourly.lock`，确认无进程后再删，避免并行执行导致状态错乱。

## 附录
- 相关文件：`/tmp/codex-auths-hourly.lock`
- 脚本：`skills/codex-auths-validator/scripts/hourly-reconcile.mjs`
- Cron ID：`eb8ad007-426f-4061-ba30-5c48c2e7e8da`
