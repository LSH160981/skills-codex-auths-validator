#!/bin/bash
# 每小时检查 OpenClaw 更新（系统 crontab 版）
# 规则：只有“确实有更新且更新成功（Before!=After）”才发 TG；否则静默
# 设计：先 openclaw update status（快），只有检测到可更新才跑 openclaw update（慢）；全程加超时+防重入
set -euo pipefail

TG_TOKEN="REDACTED_TG_TOKEN"
TG_CHAT="REDACTED_TG_CHAT"

LOG_DIR="/root/.openclaw/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/openclaw_update_cron.log"

TS_UTC="$(date -u +"%Y-%m-%d %H:%M:%S UTC")"
TS_SH="$(TZ=Asia/Shanghai date +"%Y-%m-%d %H:%M:%S Asia/Shanghai")"
START_S=$(date +%s)

log() { echo "[$TS_UTC] $*" >> "$LOG_FILE"; }

# 防重复（避免两次 update 同时跑）
LOCK_FILE="$LOG_DIR/openclaw_update.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  exit 0
fi

get_version() {
  openclaw --version 2>/dev/null | tr -d '\r' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true
}

before="$(get_version)"
log "before=$before"

# 先 status（快）
status_out=$(timeout 60s openclaw update status 2>&1 || true)
log "update_status_begin"
log "$status_out"
log "update_status_end"

# 判断是否存在更新：匹配常见关键词（若 OpenClaw 输出变化也不致命，最坏是多跑一次 update）
if ! echo "$status_out" | grep -Eiq 'update available|updates available|out of date|new version|upgrade available|can be updated'; then
  # 无更新：静默
  exit 0
fi

# 有更新：执行 update（加超时 + 非交互）
update_out=$(timeout 900s openclaw update --yes 2>&1 || true)
log "update_run_begin"
log "$update_out"
log "update_run_end"

after="$(get_version)"
log "after=$after"

END_S=$(date +%s)
TOTAL_S=$((END_S-START_S))

# 只有版本发生变化才通知
if [ -n "$before" ] && [ -n "$after" ] && [ "$before" != "$after" ]; then
  text=$(printf "OpenClaw 已更新 ✅\nBefore: %s\nAfter: %s\nTotal time: %ss\nUTC: %s\n上海: %s\n" "$before" "$after" "$TOTAL_S" "$TS_UTC" "$TS_SH")
  curl -fsS -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
    -d chat_id="${TG_CHAT}" \
    --data-urlencode "text=${text}" > /dev/null || true
fi
