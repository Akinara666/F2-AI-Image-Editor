#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Backend tests"
(
  cd "$ROOT_DIR"
  PYTHONPATH=./backend python3 -m unittest discover -s backend/tests -p "test_*.py"
)

echo
echo "==> Frontend regression tests"
(
  cd "$ROOT_DIR"
  node --experimental-specifier-resolution=node --test frontend/tests/*.test.mjs
)

echo
echo "==> Frontend lint"
if compgen -G "$ROOT_DIR/frontend/.eslintrc*" > /dev/null || [ -f "$ROOT_DIR/frontend/eslint.config.js" ] || [ -f "$ROOT_DIR/frontend/eslint.config.mjs" ] || [ -f "$ROOT_DIR/frontend/eslint.config.cjs" ]; then
  (
    cd "$ROOT_DIR/frontend"
    npm run lint
  )
else
  echo "SKIP: eslint config not found in frontend/"
fi

echo
echo "PASS: all checks are green"
