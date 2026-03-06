# Codex Auth JSON 批量验证与导入流程（完整封装）

> 目标：把“验证无效 JSON 并清理 + 接收 ZIP 验证后导入”的完整任务流程沉淀为可复用标准。

## 1. 任务背景

- 认证文件目录：`/home/docker/CLIProxyAPI/auths`
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

### 保留（PASS）

- HTTP `200`：凭证可用
- HTTP `429`：限流/额度问题，不等于 token 失效，保留

### 移除（REMOVE）

- HTTP `401` / `403`：token 或账号权限无效，判定“完全无用”
- JSON 解析失败（坏文件）
- 缺少 `access_token` 或 `account_id`
- `._*.json`（AppleDouble 垃圾文件）

### 暂不删除（可复核）

- 网络超时、临时网络错误（默认保守处理）

---

## 4. 安全策略

不直接硬删，先隔离到 quarantine 目录：

- `/home/docker/CLIProxyAPI/auths/_quarantine_<timestamp>`

并自动生成报告：

- `_validation_report.json`

用户确认后才可执行硬删除。

---

## 5. Skill 结构与文件

已创建 skill：`skills/codex-auths-validator/`

- `SKILL.md`：任务说明、规则、执行方式
- `scripts/validate-auths.mjs`：批量校验与隔离脚本
- `WORKFLOW.md`：本文件（完整流程说明）

---

## 6. 标准执行流程 A：目录内全量验证

1. 扫描 `/home/docker/CLIProxyAPI/auths/*.json`
2. 先处理 `._*.json` → 直接隔离
3. 并发调用验证接口（默认并发 40）
4. 按规则判定 PASS/REMOVE
5. REMOVE 文件移动到 quarantine
6. 输出统计摘要 + 样本 + 报告 JSON

### 命令

```bash
node skills/codex-auths-validator/scripts/validate-auths.mjs
```

可选参数：

```bash
node skills/codex-auths-validator/scripts/validate-auths.mjs \
  --dir /home/docker/CLIProxyAPI/auths \
  --concurrency 40 \
  --timeout-ms 12000
```

---

## 7. 标准执行流程 B：ZIP 导入验证

适用于“我给你一个 zip，里面全是 JSON，先验证，再导入通过文件”的场景。

1. 解压 zip 到临时目录
2. 递归收集 zip 内 `*.json`
3. 按同一验证规则逐个请求接口
4. 通过文件复制到 `/home/docker/CLIProxyAPI/auths`
5. 失败文件放临时 quarantine
6. 生成 `_import_report.json`

### 导入策略

- 目标目录重名时自动改名（`__importedN`）避免覆盖
- 导入结果返回：总数、通过数、失败数、失败原因分布、样本清单

---

## 8. 本次实际执行结果（已完成）

### A. 全量目录清理

- 总 JSON：`5125`
- 有效 JSON：`3125`
- 无效 JSON：`2000`（均为 `._*.json`）
- 另有真实无效凭证：`1`（403 无账号权限）
- 共隔离：`2001`
- 保留：`3124`

### B. ZIP 导入

- ZIP 内 JSON：`50`
- 验证通过并导入：`50`
- 隔离失败：`0`
- 命中状态：`ok_200 × 50`

---

## 9. 失败原因分类（建议长期沿用）

- `invalid_json`
- `missing_token_or_account`
- `auth_401:<message>`
- `auth_403:<message>`
- `appledouble`
- `timeout`
- `network_error`
- `status_<code>`

---

## 10. 运维建议

1. 每日或每 6 小时跑一次验证任务
2. 失败先隔离、延迟硬删（降低误删风险）
3. 定期清理历史 quarantine
4. 对 429 维持保留策略，避免误伤可恢复凭证
5. 保持统一请求头与接口，避免判定偏差

---

## 11. 一句话总结

这套流程已经实现：**可批量验证、可追踪、可回滚、可导入、可复用**，并且严格遵守“额度耗尽保留、token失效移除”的业务规则。