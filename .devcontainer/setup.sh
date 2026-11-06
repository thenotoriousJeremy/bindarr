#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .devcontainer/data
npm ci
npm ci --prefix backend
npm ci --prefix frontend
npm run build:frontend
node backend/test/openingAccounting.test.js
printf '\nSetup complete. Run: bash .devcontainer/start.sh\n'
