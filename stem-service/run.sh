#!/usr/bin/env bash
# 启动乐器分离 sidecar(常驻热模型)。默认 127.0.0.1:8008,Node 后端通过 STEM_SERVICE_URL 调。
set -euo pipefail
cd "$(dirname "$0")"
PORT="${STEM_PORT:-8008}"
exec .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port "$PORT" --log-level warning
