# skills-codex-auths-validator

Codex Auth JSON 自动化验证与清理技能库（OpenClaw Skill）。

## 项目简介

这个仓库提供一个可复用的 `codex-auths-validator` 技能，用于在 Linux 环境中批量处理 Codex 认证 JSON：

- 校验 `/home/docker/CLIProxyAPI/auths` 下的 `*.json`
- 使用 `https://chatgpt.com/backend-api/wham/usage` 验证可用性
- 按规则保留/删除无效凭证
- 支持 ZIP 批量导入并只导入通过文件
- 支持每小时自动巡检清理
- 支持每日 00:00 GitHub 定点学习与规则演进

## 核心规则

- `200 / 429`：保留（429 视为限流/额度，不视为 token 失效）
- `401 / 403`：无效，删除
- 坏 JSON / 缺失字段：删除
- `._*.json`（AppleDouble 垃圾文件）：删除

## 技能结构

```text
skills/
  codex-auths-validator/
    SKILL.md
    WORKFLOW.md
    scripts/
      validate-auths.mjs
```

## 快速开始

### 1) 本地批量校验

```bash
node skills/codex-auths-validator/scripts/validate-auths.mjs \
  --dir /home/docker/CLIProxyAPI/auths \
  --concurrency 40 \
  --timeout-ms 12000
```

### 2) ZIP 导入流程

- 解压 ZIP
- 按同一规则校验
- 仅导入通过 JSON 到 `/home/docker/CLIProxyAPI/auths`
- 失败文件按策略删除/隔离并输出报告

## 自动化任务（固定两项）

安装到新机器后应自动确保以下任务存在（缺失自动创建，存在自动更新）：

1. **每小时自动校验清理（上海时区）**
2. **每日 00:00 GitHub 学习巡检（上海时区）**

## GitHub About 推荐文案

### Description（建议直接粘贴）

Codex auth JSON validator skill for OpenClaw: hourly cleanup, ZIP import validation, and daily GitHub learning updates.

### Topics（建议）

`openclaw` `skill` `codex` `auth` `json` `validator` `automation` `cron` `devops`

## 维护说明

- 所有关键规则和学习演进记录在：
  - `skills/codex-auths-validator/SKILL.md`
  - `skills/codex-auths-validator/WORKFLOW.md`
- 提交信息统一中文。