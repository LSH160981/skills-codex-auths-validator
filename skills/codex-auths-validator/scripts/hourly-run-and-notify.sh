#!/bin/bash
# 每小时运行校验并直接用 curl 发 TG，不依赖 OpenClaw cron delivery

TG_TOKEN="REDACTED_TG_TOKEN"
TG_CHAT="REDACTED_TG_CHAT"

OUTPUT=$(node /root/.openclaw/workspace/skills/codex-auths-validator/scripts/hourly-reconcile.mjs \
  --dir-quota /home/docker/CLIProxyAPI/auths \
  --dir-no-quota /home/docker/CLIProxyAPI/auths_no_quota \
  --dir-invalid /home/docker/CLIProxyAPI/auths_invalid \
  --concurrency 40 --timeout-ms 12000 2>&1)

# 发送到 Telegram
curl -s -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
  -d chat_id="${TG_CHAT}" \
  -d parse_mode="Markdown" \
  --data-urlencode "text=🔄 *Codex auths 每小时校验*

${OUTPUT}" > /dev/null
