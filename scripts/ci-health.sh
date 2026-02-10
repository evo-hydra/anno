#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "[ci-health] Running TypeScript build..."
npm run --silent build

echo "[ci-health] Running lint..."
npm run --silent lint

echo "[ci-health] Running unit tests..."
npm run --silent test:unit

echo "[ci-health] Commands complete."

if git diff --stat -- docs/wiki/PROJECT_HEALTH.md >/dev/null; then
  echo "[ci-health] Wiki changes detected. Review with:\n  git diff docs/wiki/PROJECT_HEALTH.md"
else
  echo "[ci-health] No wiki updates detected."
fi

echo "[ci-health] Health check finished successfully."
