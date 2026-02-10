#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "[deps] Checking for outdated packages..."
npm outdated || echo "[deps] npm outdated requires network access; captured exit status $?."

echo "[deps] Running npm audit (json)..."
npm audit --json || echo "[deps] npm audit requires network access; captured exit status $?."

echo "[deps] Dependency check complete. Review output above."
