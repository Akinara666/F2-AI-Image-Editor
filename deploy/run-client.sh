#!/usr/bin/env bash
#
# Запуск ФРОНТЕНДА на своём компьютере с подключением к удалённому backend
# (который крутится на vast.ai через deploy/run-vast.sh).
#
#   bash deploy/run-client.sh https://<random>.trycloudflare.com
#
# Открой потом http://localhost:5173 в браузере. CORS для localhost backend
# разрешает по умолчанию, так что дополнительная настройка не нужна.
#
# Требуется Node.js + npm на клиенте.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

API_URL="${1:-}"
if [ -z "$API_URL" ]; then
  echo "usage: bash deploy/run-client.sh <BACKEND_URL>" >&2
  echo "  пример: bash deploy/run-client.sh https://abc-def.trycloudflare.com" >&2
  exit 1
fi
API_URL="${API_URL%/}"   # убрать хвостовой слэш

command -v npm >/dev/null 2>&1 || { echo "[client] npm не найден — поставь Node.js." >&2; exit 1; }

cd "$REPO_ROOT/frontend"

# Vite надёжно читает адрес из .env.local (process.env подхватывается не всегда).
echo "VITE_API_BASE_URL=$API_URL" > .env.local
echo "[client] VITE_API_BASE_URL=$API_URL -> frontend/.env.local"

if [ ! -d node_modules ]; then
  echo "[client] npm install ..."
  npm install
fi

echo "[client] Запускаю Vite dev-сервер -> http://localhost:5173"
npm run dev
