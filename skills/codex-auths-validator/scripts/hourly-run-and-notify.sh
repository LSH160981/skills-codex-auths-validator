#!/bin/bash
# 每小时运行校验并直接用 curl 发 TG：不依赖 OpenClaw cron delivery / 不依赖 LLM session
set -euo pipefail

TG_TOKEN="REDACTED_TG_TOKEN"
TG_CHAT="REDACTED_TG_CHAT"

TS_UTC="$(date -u +"%Y-%m-%d %H:%M:%S UTC")"
TMP_DIR="/tmp/codex-auths"
mkdir -p "$TMP_DIR"

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

# Telegram sendMessage 最大 4096 字符；超过则改发文件
MSG="Codex auths 每小时校验\n${TS_UTC}\nexit=${RC}\n\n${OUTPUT}"
LEN=${#MSG}

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

if [ "$LEN" -le 3500 ]; then
  send_message "$MSG" || true
else
  send_document "$OUT_FILE" "Codex auths 每小时校验（输出过长，已作为文件发送）\n${TS_UTC}\nexit=${RC}" || true
fi

exit 0
