#!/bin/bash
# 每小时运行校验并直接用 curl 发 TG：不依赖 OpenClaw cron delivery / 不依赖 LLM session
set -euo pipefail

TG_TOKEN="REDACTED_TG_TOKEN"
TG_CHAT="REDACTED_TG_CHAT"
TMP_DIR="/tmp/codex-auths"
mkdir -p "$TMP_DIR"

# ── 防重复（flock） ─────────────────────────────────────────────────────────────
LOCK_FILE="$TMP_DIR/hourly-run-and-notify.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then exit 0; fi

TS_UTC="$(date -u +"%Y-%m-%d %H:%M:%S UTC")"
TS_SH="$(TZ=Asia/Shanghai date +"%Y-%m-%d %H:%M:%S Asia/Shanghai")"
OUT_FILE="$TMP_DIR/hourly-reconcile-$(date -u +"%Y%m%dT%H%M%SZ").log"

AUTH_DIR="${AUTH_DIR:-/home/docker/CLIProxyAPI/auths}"
# 去掉尾部斜杠，避免 dirname 推导出错（如 /foo/ → dirname=/foo，而非期望的上一级）
AUTH_DIR="${AUTH_DIR%/}"
CONCURRENCY="${CONCURRENCY:-40}"
TIMEOUT_MS="${TIMEOUT_MS:-12000}"
SEND_DETAIL="${SEND_DETAIL:-0}"       # 1 = 异常+有无效/临时时也发详细日志

# ── 清理 writeJsonAtomic 遗留的 .*.tmp-PID-TS 垃圾文件（kill -9 中断时可能遗留）──
for _dir in "$AUTH_DIR" "${AUTH_DIR}_no_quota"; do
  if [ -d "$_dir" ]; then
    find "$_dir" -maxdepth 1 -name '.*\.tmp-[0-9]*-[0-9]*' -type f -delete 2>/dev/null || true
  fi
done

# ── 运行校验脚本 ────────────────────────────────────────────────────────────────
set +e
OUTPUT=$(node /root/.openclaw/workspace/skills/codex-auths-validator/scripts/hourly-reconcile.mjs \
  --auth-dir "$AUTH_DIR" \
  --concurrency "$CONCURRENCY" \
  --timeout-ms "$TIMEOUT_MS" 2>&1)
RC=$?
set -e

printf "[%s] exit=%s\n\n%s\n" "$TS_UTC" "$RC" "$OUTPUT" > "$OUT_FILE"

# ── 从最新 report JSON 读取关键字段（不解析 OUTPUT 文本，避免误判）───────────
# REPORT_DIR 以 AUTH_DIR 的父目录为基础推导，AUTH_DIR 已去除尾部斜杠
REPORT_DIR="${REPORT_DIR:-$(dirname "$AUTH_DIR")/reports}"
LATEST_REPORT=$(ls -t "$REPORT_DIR"/hourly-reconcile-*.json 2>/dev/null | head -1 || true)

# 默认值（report 读不到时不至于炸）
DEDUP=0; CHECKED=0; FINAL_QUOTA=0; FINAL_NO_QUOTA=0
INVALID_MOVED=0; INVALID_STOCK=0; TRANSIENT=0
REFRESHED=0; INVALID_REASONS="无"

if [ -n "$LATEST_REPORT" ] && [ -s "$LATEST_REPORT" ]; then
  # 用 node 解析 JSON（node 一定存在；python3 在精简环境可能没有）
  PY_OUT=$(node -e "
try {
  const j = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  const reasons = j.invalidReasons || {};
  const rt = Object.entries(reasons).map(([k,v]) => k+':'+v).join('，') || '无';
  const fields = [
    j.checkedTotal||0, j.dedupRemoved||0, j.refreshedCount||0,
    j.finalQuota||0, j.finalNoQuota||0, j.invalidMoved||0,
    j.finalInvalid||0, j.keptTransient||0, rt
  ];
  process.stdout.write(fields.join('\t'));
} catch(e) { process.stdout.write('0\t0\t0\t0\t0\t0\t0\t0\t读取失败:'+e.message); }
" "$LATEST_REPORT" 2>/dev/null) || PY_OUT=""

  if [ -n "$PY_OUT" ]; then
    IFS=$'\t' read -r CHECKED DEDUP REFRESHED FINAL_QUOTA FINAL_NO_QUOTA \
        INVALID_MOVED INVALID_STOCK TRANSIENT INVALID_REASONS <<< "$PY_OUT"
  fi
fi

STATUS="OK"
[ "$RC" -ne 0 ] && STATUS="ERROR"

# ── 构造摘要 ────────────────────────────────────────────────────────────────────
Q_COUNT=$(find "$AUTH_DIR" -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ') || Q_COUNT=0
NQ_DIR="${AUTH_DIR}_no_quota"
NQ_COUNT=$(find "$NQ_DIR" -maxdepth 1 -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ') || NQ_COUNT=0

if [ "${Q_COUNT:-0}" -eq 0 ] && [ "${NQ_COUNT:-0}" -eq 0 ]; then
  SUMMARY="Codex auths 每小时校验：两个目录均为空
UTC: ${TS_UTC}
上海: ${TS_SH}  exit=${RC}"
else
  SUMMARY="Codex auths 每小时校验
UTC: ${TS_UTC}  上海: ${TS_SH}  ${STATUS} (exit=${RC})

检查:${CHECKED}  有额:${FINAL_QUOTA}  无额:${FINAL_NO_QUOTA}
无效移入:${INVALID_MOVED}(库存${INVALID_STOCK})  续期:${REFRESHED}
去重:${DEDUP}  临时保留:${TRANSIENT}
无效原因:${INVALID_REASONS}"
fi

# ── Telegram 发送函数（自动分片：超 4096 字符改发文件）──────────────────────────
tg_send_text() {
  local text="$1"
  local attempt
  # TG 单条消息上限 4096 字节；超限直接改发文件
  if [ "${#text}" -gt 4000 ]; then
    local tmp_txt="$TMP_DIR/tg_msg_$$.txt"
    printf '%s' "$text" > "$tmp_txt"
    tg_send_file "$tmp_txt" "消息超长，以文件发送"
    rm -f "$tmp_txt"
    return
  fi
  for attempt in 1 2 3; do
    if curl -fsS --max-time 10 -X POST \
        "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
        -d chat_id="${TG_CHAT}" \
        --data-urlencode "text=${text}" > /dev/null; then
      return 0
    fi
    sleep $((attempt * 2))
  done
  return 1
}

tg_send_file() {
  local file="$1"
  local caption="${2:-}"
  local attempt
  for attempt in 1 2 3; do
    if curl -fsS --max-time 30 -X POST \
        "https://api.telegram.org/bot${TG_TOKEN}/sendDocument" \
        -F chat_id="${TG_CHAT}" \
        -F "caption=${caption}" \
        -F document=@"${file}" > /dev/null; then
      return 0
    fi
    sleep $((attempt * 2))
  done
  return 1
}

# ── 发送摘要 ────────────────────────────────────────────────────────────────────
tg_send_text "$SUMMARY" || true

# ── 发送详细日志（仅在异常或 SEND_DETAIL=1 时）──────────────────────────────────
if [ "$RC" -ne 0 ]; then
  tg_send_file "$OUT_FILE" "详细日志 ${TS_UTC} exit=${RC}" || true
elif [ "$SEND_DETAIL" = "1" ] && { [ "${INVALID_MOVED:-0}" -gt 0 ] || [ "${TRANSIENT:-0}" -gt 0 ]; }; then
  tg_send_file "$OUT_FILE" "详细日志 ${TS_UTC}" || true
fi

exit 0
