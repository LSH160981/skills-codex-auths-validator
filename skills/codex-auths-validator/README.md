# codex-auths-validator（技能内说明）

## 一句话
只要告诉我 JSON 文件目录，我就能自动接管：校验、分层、无效归档、定时任务。

## 默认目录规则
- `auths_dir`：你提供的 JSON 目录
- `auths_no_quota_dir`：`<auths_dir>_no_quota`
- `auths_invalid_dir`：`<auths_dir>_invalid`

## 核心能力
1. 多 provider 自动识别（codex/qwen/kimi/gemini/claude/vertex/...）
2. codex 远程验证（`wham/usage`）+ 状态分层
3. ZIP/7z 自动导入（仅处理 JSON，非 JSON 忽略）
4. 无效文件单独存放并给出原因，提示是否删除
5. 每小时巡检（带并发锁，防波动）
6. 每日学习巡检 + 每日 skill 同步

## 三个脚本
- `scripts/discover-auth-dir.mjs`：首次安装自动探测目录
- `scripts/validate-auths.mjs`：一次性人工批处理
- `scripts/hourly-reconcile.mjs`：每小时定时稳定巡检
- `scripts/import-archive.mjs`：ZIP/7z 导入接管（仅 JSON）

## 固定三项定时任务（上海时区）
1. 每小时自动校验清理
2. 每日 00:00 GitHub 学习巡检
3. 每日 00:00 Skill 同步

## 无效状态说明
- `INVALID_AUTH`：401/403
- `INVALID_JSON`：JSON 损坏
- `INVALID_MISSING_FIELDS`：字段缺失
- `INVALID_APPLEDOUBLE`：`._*.json`

## 重要约束
- 变更时必须同步更新：`SKILL.md`、`WORKFLOW.md`、`README.md`
- 提交信息用中文
- 立即 push 到 GitHub：`LSH160981/skills-codex-auths-validator`
