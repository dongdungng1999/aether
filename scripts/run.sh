#!/usr/bin/env bash
# Aether — one-shot setup + launch. No Docker required for chat itself.
#
# What this does:
#   1. Creates a local Python venv (.venv) and installs proxy/requirements.txt
#   2. npm install + tsc build for the Node backend
#   3. Starts the Node server, which spawns the Python proxy as a child
#      process (python -m aether_proxy) and serves the chat UI over
#      HTTP+WebSocket.
#
# Env overrides (see README.md):
#   AETHER_HOST=127.0.0.1   AETHER_PORT=8500   AETHER_DATA_DIR=~/.aether/data
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -d .venv ]; then
  echo "[aether] creating venv..."
  python3 -m venv .venv
fi
echo "[aether] installing proxy deps..."
./.venv/bin/pip install -q --disable-pip-version-check -r proxy/requirements.txt
export AETHER_PYTHON="$ROOT/.venv/bin/python3"

if [ ! -d node_modules ]; then
  echo "[aether] npm install..."
  npm install
fi
echo "[aether] building..."
npm run compile

echo "[aether] starting..."
exec node out/core/server.js
