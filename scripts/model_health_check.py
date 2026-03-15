#!/usr/bin/env python3
"""
model_health_check.py
每6小时检查所有模型健康状态，失败则从配置中移除，并发 TG 通知汇报。
"""
import json
import subprocess
import sys
import re
import os
from datetime import datetime

CONFIG_PATH = "/root/.openclaw/openclaw.json"

# Telegram 凭证不要写死在仓库里：从环境变量或本机 secrets 文件读取
SECRETS_FILE_DEFAULT = "/root/.openclaw/secrets/model-health-check.env"

def _load_secrets(path: str):
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and v and k not in os.environ:
                    os.environ[k] = v
    except FileNotFoundError:
        pass

# 允许用 MODEL_HEALTH_SECRETS_FILE 指定路径
_load_secrets(os.environ.get("MODEL_HEALTH_SECRETS_FILE", SECRETS_FILE_DEFAULT))

TG_TOKEN = os.environ.get("TG_TOKEN", "")
TG_CHAT_ID = os.environ.get("TG_CHAT_ID", "")

if not TG_TOKEN or not TG_CHAT_ID:
    raise SystemExit(
        "缺少 TG_TOKEN/TG_CHAT_ID。请设置环境变量，或创建 secrets 文件：\n"
        f"  {SECRETS_FILE_DEFAULT}\n"
        "格式示例：\n"
        "  TG_TOKEN='xxx'\n  TG_CHAT_ID='你的chat_id'\n"
    )

def send_tg(msg):
    import urllib.request, urllib.parse
    data = urllib.parse.urlencode({"chat_id": TG_CHAT_ID, "text": msg}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage", data=data)
    urllib.request.urlopen(req, timeout=10)

def load_config():
    with open(CONFIG_PATH, "r") as f:
        return json.load(f)

def save_config(cfg):
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)

def test_model(provider_id, model_id, provider_cfg):
    """向模型发送"你好"测3次，返回 (success: bool, error: str)"""
    base_url = provider_cfg.get("baseUrl", "")
    api_key = provider_cfg.get("apiKey", "")
    api = provider_cfg.get("api", "openai-completions")

    for attempt in range(3):
        try:
            if api == "openai-completions":
                import urllib.request, json as _json
                payload = _json.dumps({
                    "model": model_id,
                    "messages": [{"role": "user", "content": "你好"}],
                    "max_tokens": 10
                }).encode()
                req = urllib.request.Request(
                    f"{base_url}/chat/completions",
                    data=payload,
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json"
                    }
                )
                resp = urllib.request.urlopen(req, timeout=15)
                data = _json.loads(resp.read())
                if data.get("choices"):
                    return True, ""
            elif api == "anthropic-messages":
                import urllib.request, json as _json
                payload = _json.dumps({
                    "model": model_id,
                    "max_tokens": 10,
                    "messages": [{"role": "user", "content": "你好"}]
                }).encode()
                req = urllib.request.Request(
                    f"{base_url}/messages",
                    data=payload,
                    headers={
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01",
                        "Content-Type": "application/json"
                    }
                )
                resp = urllib.request.urlopen(req, timeout=15)
                data = _json.loads(resp.read())
                if data.get("content"):
                    return True, ""
        except Exception as e:
            last_err = str(e)
    return False, last_err

def run():
    cfg = load_config()
    providers = cfg.get("models", {}).get("providers", {})
    removed_models = []
    removed_providers = []

    for pid in list(providers.keys()):
        pcfg = providers[pid]
        models = pcfg.get("models", [])
        all_failed = True
        for model in list(models):
            mid = model["id"]
            ok, err = test_model(pid, mid, pcfg)
            if not ok:
                print(f"[FAIL] {pid}/{mid}: {err}")
                models.remove(model)
                removed_models.append(f"{pid}/{mid}")
            else:
                print(f"[OK]   {pid}/{mid}")
                all_failed = False

        if all_failed and len(models) == 0:
            del providers[pid]
            removed_providers.append(pid)
            print(f"[REMOVED PROVIDER] {pid}")

    save_config(cfg)

    if removed_models or removed_providers:
        lines = ["🔴 模型健康检查报告"]
        lines.append(f"时间：{datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}")
        if removed_models:
            lines.append("\n已移除模型（3次测试全部失败）：")
            for m in removed_models:
                lines.append(f"  ✗ {m}")
        if removed_providers:
            lines.append("\n已移除 Provider（所有模型均失败）：")
            for p in removed_providers:
                lines.append(f"  ✗ {p}")
        send_tg("\n".join(lines))

if __name__ == "__main__":
    run()
