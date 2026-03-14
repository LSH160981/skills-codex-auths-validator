![codex-auths-validator banner](assets/banner.svg)

# skills-codex-auths-validator (English)

Chinese README: [README.md](./README.md)

---

**OpenClaw skill for auth JSON automation: hourly cleanup, ZIP/7z import validation, and daily GitHub interface learning checks.**

**Just provide the JSON directory path, and the skill handles everything automatically.**

If path is not provided, it assumes possible `Cli-Proxy-API-Management-Center` deployment and auto-discovers via `auth-dir` + Docker mount hints.

## Core capabilities

1. Multi-provider auto detection (qwen/kimi/gemini/claude/codex/vertex/...)
2. Codex remote validation + unified status model
3. **3-layer expiry detection**: JWT `exp` → `expired` field → `last_refresh`+7d; never discards blindly
4. **Auto token refresh**: uses `refresh_token` to renew expired tokens in-place (atomic write), saving recoverable accounts
5. Dual-directory classification + invalid directory archive
6. **account_id deduplication**: keeps the quota-bearing account when duplicates exist
7. ZIP/7z import auto takeover (JSON only, non-JSON ignored)
8. Stable hourly reconcile (lock + transient keep + auto dedup + report auto-prune)
9. Daily interface learning check + daily skill self-sync
10. **Shared core library `lib/codex.mjs`**: token expiry/refresh/atomic-write/cross-device-move/safe-list unified across all scripts

## Directory model

- `auths_dir` — valid with quota
- `auths_no_quota_dir` — valid but no quota / 429
- `auths_invalid_dir` — invalid files (reason logged; user confirms before hard-delete)

## Script mapping

All scripts support `--auth-dir <auths_dir>` as a single-directory entry point; sibling dirs (`_no_quota`, `_invalid`, `reports`) are derived automatically.

- `scripts/discover-auth-dir.mjs` — first-time path auto-discovery
- `scripts/validate-auths.mjs` — manual one-off full batch
- `scripts/hourly-reconcile.mjs` — hourly stable runner (with lock)
- `scripts/import-archive.mjs` — ZIP/7z JSON-only import takeover
- `scripts/hourly-run-and-notify.sh` — system crontab wrapper (runs reconcile + sends TG summary via curl, no LLM dependency)

## Required scheduled jobs (Asia/Shanghai)

1. **Hourly validation cleanup (system crontab)**
   ```bash
   0 * * * * AUTH_DIR=/path/to/auths bash /root/.openclaw/workspace/skills/codex-auths-validator/scripts/hourly-run-and-notify.sh >> /tmp/codex-auths-cron.log 2>&1
   ```
   - Sends compact TG summary (reads from `reports/*.json`, no text parsing)
   - Sends full log only on error (`exit != 0`) or when `SEND_DETAIL=1`

2. **Daily 01:00 GitHub interface learning check** (OpenClaw cron, agentTurn, Asia/Shanghai)
   - Tracks 6 dimensions: Auth API / Token refresh flow / Account fields / provider enum / JSON schema / HTTP status semantics
   - Compares upstream commits + local grep; updates skill only when real changes found
   - Fixed output format: each dimension explicitly reports changed / unchanged

3. **Daily 01:00 skill self-sync** (OpenClaw cron, agentTurn, Asia/Shanghai)

## Status codes

| Status | Meaning |
|--------|---------|
| `VALID_QUOTA` | Valid with quota |
| `VALID_NO_QUOTA` | Valid but no quota / rate-limited |
| `INVALID_AUTH` | 401/403 — credential rejected |
| `INVALID_EXPIRED` | Expired + refresh failed + API 401 (triple-confirmed) |
| `INVALID_JSON` | Corrupt JSON |
| `INVALID_MISSING_FIELDS` | Missing required fields |
| `INVALID_APPLEDOUBLE` | `._*.json` macOS artifact |
| `INVALID_DUPLICATE` | Duplicate account_id (quota copy kept) |
| `SCHEMA_VALID_PROVIDER` | Non-codex, schema valid (kept in place) |
| `TRANSIENT_KEEP` | Network/5xx/refresh error — kept for retry |

## Changelog highlights

- Multi-provider detection (qwen/kimi/gemini/claude/codex/vertex/...)
- Invalid files archived (not deleted) with reason; user confirms before cleanup
- ZIP/7z auto import with JSON-only filtering
- Hourly concurrency lock + transient error keep
- 3-layer JWT expiry detection + `refresh_token` auto-renewal
- account_id deduplication (quota copy wins)
- reports directory auto-prune (default: keep latest 72)
- System crontab for hourly notify (no LLM session dependency)
- Shared `lib/codex.mjs`: eliminates duplicate logic across 3 scripts; EXDEV-safe move / atomic write / safe dir-list
- Non-codex files no longer wrongly flagged as invalid
- TG message auto-split: >4000 chars → sent as file
- Report JSON parsing uses node (no python3 required)
- `.tmp-PID-TS` stale file cleanup on startup
- Report pruning uses filename sort (stable, no mtime ambiguity)
- **Learning check upgraded**: 6-dimension interface tracking, 01:00 Shanghai, fixed output format
