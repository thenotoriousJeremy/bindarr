#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DB_PATH="$PWD/.devcontainer/data/bindarr.db"
export PORT=3001
export HTTPS_PORT=
export ALLOW_REGISTRATION=false
mkdir -p .devcontainer/data
if [ ! -f frontend/dist/index.html ]; then
  npm run build:frontend
fi
./node_modules/.bin/concurrently --kill-others \
  "npm run dev:backend" \
  "npm run build --prefix frontend -- --watch"
