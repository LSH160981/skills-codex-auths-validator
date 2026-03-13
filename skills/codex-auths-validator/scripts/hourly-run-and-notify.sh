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
OUTPUT=$(node /root/.openclaw/workspace/skills/codex-auths-validator/scripts/hourly-reconcile.mjs \
  --dir-quota /home/docker/CLIProxyAPI/auths \
  --dir-no-quota /home/docker/CLIProxyAPI/auths_no_quota \
  --dir-invalid /home/docker/CLIProxyAPI/auths_invalid \
  --concurrency 40 --timeout-ms 12000 2>&1)
RC=$?
set -e

printf "[%s] exit=%s\n\n%s\n" "$TS_UTC" "$RC" "$OUTPUT" > "$OUT_FILE"

# 生成精简摘要（避免 TG 消息一堆\n / 大段输出）
# 从 OUTPUT 中提取关键统计（输出格式由 hourly-reconcile.mjs 固定）
get_num_after_colon() {
  # usage: get_num_after_colon "前缀文字"
  # e.g. get_num_after_colon "总共检查"
  echo "$OUTPUT" | awk -v k="$1" -F'：' '$0 ~ "^"k"：" {gsub(/[^0-9]/,"",$2); print $2; exit}'
}

get_stock_in_paren() {
  # 从形如：无效已移入...：2（当前库存 34） 提取 34
  echo "$OUTPUT" | awk '/当前库存/ { if (match($0, /当前库存[[:space:]]*([0-9]+)/, a)) { print a[1]; exit } }'
}

REPORT_PRUNE=$(echo "$OUTPUT" | awk '/^已清理[[:space:]]*[0-9]+[[:space:]]*个旧 report 文件/ { if (match($0, /已清理[[:space:]]*([0-9]+)/, a)) print a[1]; exit }')
DEDUP=$(get_num_after_colon "重复账户去重删除")
CHECKED=$(get_num_after_colon "总共检查")
FINAL_QUOTA=$(get_num_after_colon "有效有额度")
FINAL_NO_QUOTA=$(get_num_after_colon "有效无额度")
INVALID_MOVED=$(get_num_after_colon "无效已移入")
INVALID_STOCK=$(get_stock_in_paren)
TRANSIENT=$(get_num_after_colon "临时错误保留")
INVALID_REASONS=$(echo "$OUTPUT" | awk -F'：' '/^无效原因统计：/ {print $2; exit}')

: "${REPORT_PRUNE:=0}"
: "${DEDUP:=0}"
: "${CHECKED:=0}"
: "${FINAL_QUOTA:=0}"
: "${FINAL_NO_QUOTA:=0}"
: "${INVALID_MOVED:=0}"
: "${INVALID_STOCK:=0}"
: "${TRANSIENT:=0}"
: "${INVALID_REASONS:=无}"

STATUS="OK"
if [ "$RC" -ne 0 ]; then STATUS="ERROR"; fi

SUMMARY=$(printf "Codex auths 每小时校验\nUTC: %s\n上海: %s\n结果: %s (exit=%s)\n\n检查:%s | 有额:%s | 无额:%s | 无效移入:%s(库存%s)\n去重:%s | 临时:%s | report清理:%s\n无效原因:%s\n\n如需删除无效JSON：回复 删除无效JSON\n日志文件:%s\n" \
  "$TS_UTC" "$TS_SH" "$STATUS" "$RC" \
  "$CHECKED" "$FINAL_QUOTA" "$FINAL_NO_QUOTA" "$INVALID_MOVED" "$INVALID_STOCK" \
  "$DEDUP" "$TRANSIENT" "$REPORT_PRUNE" \
  "$INVALID_REASONS" \
  "$OUT_FILE")

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
