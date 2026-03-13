#!/bin/bash
# 每小时运行校验并直接用 curl 发 TG：不依赖 OpenClaw cron delivery / 不依赖 LLM session
set -euo pipefail

TG_TOKEN="REDACTED_TG_TOKEN"
TG_CHAT="REDACTED_TG_CHAT"

TMP_DIR="/tmp/codex-auths"
mkdir -p "$TMP_DIR"

# 防重复：同一时间段被 cron + 手动触发时，只允许一个实例运行
LOCK_FILE="$TMP_DIR/hourly-run-and-notify.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  exit 0
fi

TS_UTC="$(date -u +"%Y-%m-%d %H:%M:%S UTC")"
TS_SH="$(TZ=Asia/Shanghai date +"%Y-%m-%d %H:%M:%S Asia/Shanghai")"

OUT_FILE="$TMP_DIR/hourly-reconcile-$(date -u +"%Y%m%dT%H%M%SZ").log"

# 运行校验脚本（捕获 stdout+stderr）
set +e
AUTH_DIR="${AUTH_DIR:-/home/docker/CLIProxyAPI/auths}"
CONCURRENCY="${CONCURRENCY:-40}"
TIMEOUT_MS="${TIMEOUT_MS:-12000}"

OUTPUT=$(node /root/.openclaw/workspace/skills/codex-auths-validator/scripts/hourly-reconcile.mjs \
  --auth-dir "$AUTH_DIR" \
  --concurrency "$CONCURRENCY" \
  --timeout-ms "$TIMEOUT_MS" 2>&1)
RC=$?
set -e

printf "[%s] exit=%s\n\n%s\n" "$TS_UTC" "$RC" "$OUTPUT" > "$OUT_FILE"

# 生成精简摘要：从最新 report JSON 读取（避免解析 OUTPUT 文本误判）
REPORT_DIR="${REPORT_DIR:-$(dirname "$AUTH_DIR")/reports}"
LATEST_REPORT=$(ls -t "$REPORT_DIR"/hourly-reconcile-*.json 2>/dev/null | head -1 || true)

REPORT_PRUNE=$(echo "$OUTPUT" | awk '/^已清理[[:space:]]*[0-9]+[[:space:]]*个旧 report 文件/ { if (match($0, /已清理[[:space:]]*([0-9]+)/, a)) print a[1]; exit }')
: "${REPORT_PRUNE:=0}"

# 默认值（report 读不到时不至于炸）
DEDUP=0
CHECKED=0
FINAL_QUOTA=0
FINAL_NO_QUOTA=0
INVALID_MOVED=0
INVALID_STOCK=0
TRANSIENT=0
INVALID_REASONS="无"

if [ -n "$LATEST_REPORT" ] && [ -s "$LATEST_REPORT" ]; then
  PY_OUT=$(python3 - "$LATEST_REPORT" <<'PY'
import json,sys
p=sys.argv[1]
with open(p,'r',encoding='utf-8') as f:
  j=json.load(f)
# 输出 TSV：checked, finalQuota, finalNoQuota, invalidMoved, finalInvalid, keptTransient, invalidReasonsText
checked=j.get('checkedTotal',0)
finalQuota=j.get('finalQuota',0)
finalNoQuota=j.get('finalNoQuota',0)
invalidMoved=j.get('invalidMoved',0)
finalInvalid=j.get('finalInvalid',0)
keptTransient=j.get('keptTransient',0)
reasons=j.get('invalidReasons',{}) or {}
reasonsText='无' if not reasons else '，'.join([f"{k}: {v}" for k,v in reasons.items()])
print(f"{checked}\t{finalQuota}\t{finalNoQuota}\t{invalidMoved}\t{finalInvalid}\t{keptTransient}\t{reasonsText}")
PY
) || PY_OUT=""

  if [ -n "$PY_OUT" ]; then
    CHECKED=$(echo "$PY_OUT" | awk -F'\t' '{print $1}')
    FINAL_QUOTA=$(echo "$PY_OUT" | awk -F'\t' '{print $2}')
    FINAL_NO_QUOTA=$(echo "$PY_OUT" | awk -F'\t' '{print $3}')
    INVALID_MOVED=$(echo "$PY_OUT" | awk -F'\t' '{print $4}')
    INVALID_STOCK=$(echo "$PY_OUT" | awk -F'\t' '{print $5}')
    TRANSIENT=$(echo "$PY_OUT" | awk -F'\t' '{print $6}')
    INVALID_REASONS=$(echo "$PY_OUT" | awk -F'\t' '{print $7}')
  fi
fi

STATUS="OK"
if [ "$RC" -ne 0 ]; then STATUS="ERROR"; fi

# 规则：如果两个目录都空（auths 与 auths_no_quota 目录内 json 文件数都为 0），只发极简通知
# 注意：不能依赖 OUTPUT 文本解析（解析失败会误判为 0）
Q_COUNT=$(find "$AUTH_DIR" -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
NQ_COUNT=$(find "${AUTH_DIR}_no_quota" -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
: "${Q_COUNT:=0}"
: "${NQ_COUNT:=0}"

if [ "$Q_COUNT" -eq 0 ] && [ "$NQ_COUNT" -eq 0 ]; then
  SUMMARY=$(printf "Codex auths 每小时校验：两个目录均为空\nUTC: %s\n上海: %s\nexit=%s\n" "$TS_UTC" "$TS_SH" "$RC")
else
  SUMMARY=$(printf "Codex auths 每小时校验\nUTC: %s\n上海: %s\n结果: %s (exit=%s)\n\n检查:%s | 有额:%s | 无额:%s | 无效移入:%s(库存%s)\n去重:%s | 临时:%s | report清理:%s\n无效原因:%s\n\n如需删除无效JSON：回复 删除无效JSON\n" \
    "$TS_UTC" "$TS_SH" "$STATUS" "$RC" \
    "$CHECKED" "$FINAL_QUOTA" "$FINAL_NO_QUOTA" "$INVALID_MOVED" "$INVALID_STOCK" \
    "$DEDUP" "$TRANSIENT" "$REPORT_PRUNE" \
    "$INVALID_REASONS")
fi

send_message() {
  local text="$1"
  local attempt
  for attempt in 1 2 3; do
    if curl -fsS -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
      -d chat_id="${TG_CHAT}" \
      --data-urlencode "text=${text}" > /dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

send_document() {
  local file="$1"
  local caption="$2"
  local attempt
  for attempt in 1 2 3; do
    if curl -fsS -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendDocument" \
      -F chat_id="${TG_CHAT}" \
      -F caption="${caption}" \
      -F document=@"${file}" > /dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# 先发精简摘要（不会出现一堆 \n）
send_message "$SUMMARY" || true

# 异常/有变化时附详细日志（便于排查）
# 规则：exit!=0 或 无效移入>0 或 临时错误>0 时附带日志
if [ "$RC" -ne 0 ] || [ "$INVALID_MOVED" -gt 0 ] || [ "$TRANSIENT" -gt 0 ]; then
  send_document "$OUT_FILE" "Codex auths 每小时校验：详细日志\n${TS_UTC}\n${TS_SH}\nexit=${RC}" || true
fi

exit 0
