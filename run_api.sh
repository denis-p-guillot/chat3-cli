#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8787}"

free_port() {
  local port=$1
  if ! command -v lsof >/dev/null 2>&1; then
    echo "run_api.sh: lsof not found; cannot free port $port. Stop the old server manually if you see 'Address already in use'." >&2
    return 0
  fi
  local pids
  pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -z "${pids:-}" ]; then
    return 0
  fi
  echo "Stopping listener(s) on 127.0.0.1:$port (PID: $pids)"
  kill $pids 2>/dev/null || true
  sleep 0.4
  pids=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "${pids:-}" ]; then
    echo "Force stopping: $pids"
    kill -9 $pids 2>/dev/null || true
    sleep 0.2
  fi
}

free_port "$PORT"

# SECRET_KEY: set in the environment or in a .env file next to server.py.
# If unset, the server creates data/.local_secret_key (ignored by git) on first run.

exec .venv/bin/uvicorn server:app --host 127.0.0.1 --port "$PORT" --reload
