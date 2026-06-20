#!/usr/bin/env bash
#
# Запуск BACKEND напрямую (без вложенного Docker) на готовом CUDA-инстансе —
# заточено под Vast.ai / RunPod-pod / любой контейнер, где CUDA и Python уже есть.
#
#   git clone <repo> && cd <repo>
#   bash deploy/run-vast.sh
#
# Что делает:
#   * ставит зависимости backend прямо в окружение инстанса (torch НЕ трогает,
#     если CUDA-torch уже стоит — типично для vast pytorch-образов);
#   * по умолчанию скачивает GGUF-модель Qwen для prompt-трансформации,
#     ставит llama-cpp-python и включает провайдер qwen_gguf (см. --no-llm);
#   * поднимает uvicorn на 0.0.0.0:8000;
#   * (по умолчанию) поднимает Cloudflare quick-tunnel и печатает публичный
#     https://<random>.trycloudflare.com — это адрес API;
#   * ПО УМОЛЧАНИЮ собирает SPA и отдаёт его тем же backend-ом (один URL =
#     полноценный сайт + API, same-origin без CORS) — открыл адрес в браузере и
#     сразу редактор. С --no-frontend поднимается только API, а фронт запускают
#     у себя на клиенте через deploy/run-client.sh <URL>.
#
# Флаги:
#   --no-tunnel      без cloudflared (доступ по проброшенному порту vast / ssh -L)
#   --no-venv        ставить в текущий python, а не в venv deploy/.venv-vast
#   --optional       доустановить xformers (llama-cpp-python ставится сам при LLM)
#   --no-frontend    (=--api-only) только API, без сборки фронта; фронт — на клиенте
#   --with-frontend  (по умолчанию и так включено; флаг оставлен для совместимости)
#   --no-llm         не скачивать Qwen-GGUF и не включать провайдер qwen_gguf
#   --llm-url U      URL GGUF-модели (по умолчанию Qwen3-1.7B-Q8_0)
#   --reinstall      переустановить зависимости и перекачать GGUF, даже если есть
#   --port N         порт backend (по умолчанию 8000)
#   --torch-index U  индекс колёс torch (по умолчанию cu128 — нужен для
#                    Blackwell/sm_120, RTX 50xx; для старых карт можно cu121)
#   --no-follow      не стримить логи backend в консоль (по умолчанию стримятся
#                    в реальном времени; лог-файл пишется всегда)
#   --new-tunnel     поднять НОВЫЙ cloudflared, даже если живой уже есть (сменит URL)
#   --stop           остановить backend и cloudflared-туннель и выйти
#   -h | --help      показать справку
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

WITH_TUNNEL=1
USE_VENV=1
OPTIONAL=0
REINSTALL=0
WITH_LLM=1
WITH_FRONTEND=1
FOLLOW_LOGS=1
NEW_TUNNEL=0
STOP=0
LLM_MODEL_URL="https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf"
PORT=8000
HOST="0.0.0.0"
TORCH_INDEX="https://download.pytorch.org/whl/cu128"

c_blue="\033[1;34m"; c_yellow="\033[1;33m"; c_red="\033[1;31m"; c_green="\033[1;32m"; c_off="\033[0m"
log()  { printf "${c_blue}[vast]${c_off} %s\n" "$*"; }
ok()   { printf "${c_green}[vast]${c_off} %s\n" "$*"; }
warn() { printf "${c_yellow}[vast]${c_off} %s\n" "$*" >&2; }
err()  { printf "${c_red}[vast]${c_off} %s\n" "$*" >&2; }
usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "${BASH_SOURCE[0]}"; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --no-tunnel) WITH_TUNNEL=0 ;;
    --no-venv) USE_VENV=0 ;;
    --optional) OPTIONAL=1 ;;
    --with-frontend) WITH_FRONTEND=1 ;;
    --no-frontend|--api-only) WITH_FRONTEND=0 ;;
    --no-llm) WITH_LLM=0 ;;
    --llm-url) shift; LLM_MODEL_URL="${1:?--llm-url требует значение}" ;;
    --reinstall) REINSTALL=1 ;;
    --no-follow) FOLLOW_LOGS=0 ;;
    --new-tunnel) NEW_TUNNEL=1 ;;
    --stop) STOP=1 ;;
    --port) shift; PORT="${1:?--port требует значение}" ;;
    --torch-index) shift; TORCH_INDEX="${1:?--torch-index требует значение}" ;;
    -h|--help) usage ;;
    *) err "Неизвестный аргумент: $1"; usage ;;
  esac
  shift
done

cd "$REPO_ROOT"

# Состояние процессов/туннеля держим в файлах рядом со скриптом, чтобы cloudflared
# переживал перезапуск backend (см. секцию «публичный доступ» — рестарт без смены URL).
UVICORN_LOG="$SCRIPT_DIR/.uvicorn.log"
CF_LOG="$SCRIPT_DIR/.cloudflared.log"
CF_PID_FILE="$SCRIPT_DIR/.cloudflared.pid"
CF_URL_FILE="$SCRIPT_DIR/.cloudflared.url"

# --stop: погасить backend и туннель и выйти (cleanup-trap туннель не трогает,
# поэтому нужен явный способ остановить его).
if [ "$STOP" -eq 1 ]; then
  if [ -f "$CF_PID_FILE" ]; then
    cf_pid="$(cat "$CF_PID_FILE" 2>/dev/null || true)"
    [ -n "$cf_pid" ] && kill "$cf_pid" 2>/dev/null && ok "Остановлен cloudflared (pid=$cf_pid)." || true
    rm -f "$CF_PID_FILE" "$CF_URL_FILE"
  fi
  if pkill -f "uvicorn main:app .*--port $PORT" 2>/dev/null; then
    ok "Остановлен backend (uvicorn на порту $PORT)."
  else
    log "Активного backend на порту $PORT не найдено."
  fi
  exit 0
fi

# Скрипт работает в foreground и держит uvicorn/туннель. Если запустить его прямо
# в SSH-сессии и потом отключиться — SIGHUP убьёт процессы, а публичный URL
# отвалится (классическая «Cloudflare 1033»). Под tmux/screen сессия переживает
# отключение. Предупреждаем ДО долгой установки, чтобы можно было перезапуститься.
if [ -z "${TMUX:-}" ] && [ -z "${STY:-}" ] && [ -t 1 ]; then
  printf "${c_yellow}┌──────────────────────────────────────────────────────────────┐${c_off}\n"
  printf "${c_yellow}│ Похоже, ты НЕ под tmux/screen.                                │${c_off}\n"
  printf "${c_yellow}│ Закроешь терминал / оборвётся SSH — backend и туннель умрут.  │${c_off}\n"
  printf "${c_yellow}│ Рекомендую запускать так:                                     │${c_off}\n"
  printf "${c_yellow}│     tmux new -s app                                           │${c_off}\n"
  printf "${c_yellow}│     bash deploy/run-vast.sh ...                               │${c_off}\n"
  printf "${c_yellow}│ Отключиться не закрывая: Ctrl+b, затем d. Вернуться: tmux a.   │${c_off}\n"
  printf "${c_yellow}└──────────────────────────────────────────────────────────────┘${c_off}\n"
fi

command -v python3 >/dev/null 2>&1 || { err "python3 не найден в инстансе."; exit 1; }
command -v curl    >/dev/null 2>&1 || { err "curl не найден (нужен для cloudflared/health)."; exit 1; }

# ---------- python окружение ----------
if [ "$USE_VENV" -eq 1 ]; then
  VENV_DIR="$SCRIPT_DIR/.venv-vast"
  if [ ! -d "$VENV_DIR" ]; then
    log "Создаю venv (--system-site-packages, чтобы видеть предустановленный CUDA-torch) ..."
    if ! python3 -m venv --system-site-packages "$VENV_DIR" 2>/dev/null; then
      warn "Не удалось создать venv (нет python3-venv?) — ставлю в текущий python."
      USE_VENV=0
    fi
  fi
fi
if [ "$USE_VENV" -eq 1 ]; then
  PY="$VENV_DIR/bin/python"
else
  PY="$(command -v python3)"
fi

# ---------- зависимости ----------
deps_ready() { "$PY" -c "import fastapi, diffusers, compel, torch" >/dev/null 2>&1; }

if [ "$REINSTALL" -eq 1 ] || ! deps_ready; then
  log "Обновляю pip ..."
  "$PY" -m pip install --upgrade pip >/dev/null

  if "$PY" -c "import torch; assert torch.cuda.is_available()" >/dev/null 2>&1; then
    ok "CUDA-torch уже доступен — установку torch пропускаю."
  else
    warn "Рабочий CUDA-torch не найден — ставлю с индекса $TORCH_INDEX ..."
    "$PY" -m pip install torch --index-url "$TORCH_INDEX"
  fi

  log "Ставлю backend-зависимости (torch уже удовлетворён — не переустанавливается) ..."
  "$PY" -m pip install -r backend/requirements.txt

  if [ "$OPTIONAL" -eq 1 ]; then
    # llama-cpp-python и так ставится автоматически в LLM-секции при включённом
    # qwen_gguf; уникальная польза --optional — xformers (опц. ускорение SD).
    log "Ставлю optional-зависимости (в основном xformers; llama-cpp-python ставится сам при LLM) ..."
    "$PY" -m pip install -r backend/requirements-optional.txt || warn "Часть optional-зависимостей не встала — продолжаю."
  fi
  ok "Зависимости готовы."
else
  ok "Зависимости уже установлены (передай --reinstall, чтобы обновить)."
fi

if "$PY" -c "import torch; assert torch.cuda.is_available()" >/dev/null 2>&1; then
  HAS_CUDA=1
else
  HAS_CUDA=0
  warn "torch.cuda.is_available() == False — backend поднимется, но генерация пойдёт на CPU."
  warn "Проверь, что инстанс реально с GPU и драйвер виден (nvidia-smi)."
fi

# ---------- LLM (Qwen GGUF для prompt-трансформации) ----------
# Путь до файла нужен и для скачивания, и для проброса в env ниже.
LLM_DIR="$REPO_ROOT/backend/models/llm"
LLM_FILE="$LLM_DIR/$(basename "$LLM_MODEL_URL")"
if [ "$WITH_LLM" -eq 1 ]; then
  if [ -f "$LLM_FILE" ] && [ "$REINSTALL" -ne 1 ]; then
    ok "GGUF-модель уже на месте: $LLM_FILE"
  else
    mkdir -p "$LLM_DIR"
    log "Скачиваю GGUF-модель: $LLM_MODEL_URL ..."
    # .part + переименование, чтобы оборванная загрузка не выглядела готовой.
    if curl -fL --retry 3 -o "$LLM_FILE.part" "$LLM_MODEL_URL"; then
      mv "$LLM_FILE.part" "$LLM_FILE"
      ok "GGUF-модель готова: $LLM_FILE"
    else
      rm -f "$LLM_FILE.part"
      err "Не удалось скачать GGUF-модель ($LLM_MODEL_URL)."
      err "Запусти позже вручную или с --llm-url <URL>; пока продолжаю без LLM."
      WITH_LLM=0
    fi
  fi

  # Провайдеру qwen_gguf нужен llama-cpp-python (он в requirements-optional).
  if [ "$WITH_LLM" -eq 1 ] && ! "$PY" -c "import llama_cpp" >/dev/null 2>&1; then
    log "Ставлю llama-cpp-python (нужен для qwen_gguf) ..."
    if ! "$PY" -m pip install "llama-cpp-python>=0.2.56"; then
      warn "llama-cpp-python не встал — провайдер qwen_gguf будет недоступен."
      WITH_LLM=0
    fi
  fi
fi

# ---------- env ----------
ENV_FILE="$SCRIPT_DIR/backend.vast.env"
if [ ! -f "$ENV_FILE" ]; then
  cp "$SCRIPT_DIR/backend.env.example" "$ENV_FILE"
  sed -i 's/^USE_CUDA=.*/USE_CUDA=true/' "$ENV_FILE"
  ok "Создан deploy/backend.vast.env из шаблона (отредактируй при необходимости)."
else
  log "Использую существующий deploy/backend.vast.env"
fi

# Идемпотентно выставить KEY=VALUE в env-файле (| как разделитель — в путях
# и значениях его нет, а в CORS-regex есть слэши, которые ломали бы /.../).
set_env_kv() {
  local key="$1" val="$2" file="$3"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$file"
  else
    printf '%s=%s\n' "$key" "$val" >>"$file"
  fi
}

# Прочитать текущее значение KEY из env-файла (пусто, если ключа нет).
get_env_val() {
  local key="$1" file="$2"
  sed -n "s|^${key}=||p" "$file" 2>/dev/null | tail -n1
}

# Случайный токен для панели настроек (hex, без спецсимволов).
gen_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  else
    "$PY" -c "import secrets; print(secrets.token_hex(16))"
  fi
}

# Шаблон backend.env.example прописывает LLM_MODEL_PATH=/app/models/llm/model.gguf
# (путь из Docker) — на vast его надо заменить реальным путём скачанного файла,
# иначе backend не найдёт модель.
if [ "$WITH_LLM" -eq 1 ] && [ -f "$LLM_FILE" ]; then
  set_env_kv LLM_MODEL_PATH "$LLM_FILE" "$ENV_FILE"
  set_env_kv PROMPT_TRANSFORM_ENABLED true "$ENV_FILE"
  set_env_kv PROMPT_TRANSFORM_PROVIDER qwen_gguf "$ENV_FILE"
  # На GPU-инстансе держать Qwen на CPU (дефолт LLM_GPU_LAYERS=0) — абсурд:
  # инференс идёт ~20+ сек, ловит таймаут трансформации и отдаёт мусор. Грузим
  # все слои на GPU — но ТОЛЬКО если значение ещё дефолтное (пусто/0), чтобы не
  # затирать осознанную правку из панели настроек при повторном запуске.
  current_gpu_layers="$(get_env_val LLM_GPU_LAYERS "$ENV_FILE")"
  if [ "$HAS_CUDA" -eq 1 ]; then
    if [ -z "$current_gpu_layers" ] || [ "$current_gpu_layers" = "0" ]; then
      set_env_kv LLM_GPU_LAYERS 99 "$ENV_FILE"
      ok "LLM подключён: provider=qwen_gguf, GPU-слои=99 (на GPU), LLM_MODEL_PATH=$LLM_FILE"
    else
      ok "LLM подключён: provider=qwen_gguf, GPU-слои=$current_gpu_layers (своё значение), LLM_MODEL_PATH=$LLM_FILE"
    fi
  else
    ok "LLM подключён: provider=qwen_gguf, GPU-слои=0 (CPU — медленно), LLM_MODEL_PATH=$LLM_FILE"
  fi
else
  log "LLM не подключён (--no-llm или модель недоступна) — prompt-трансформация как в env."
fi

# ---------- панель настроек ----------
# Без SETTINGS_ADMIN_TOKEN панель в UI открывается только на чтение. На vast это
# выглядит как «сломанная» фича. Генерируем случайный токен (если ещё не задан) и
# печатаем его в баннере — тогда панель сразу редактируема. Свой токен не трогаем.
ADMIN_TOKEN="$(get_env_val SETTINGS_ADMIN_TOKEN "$ENV_FILE")"
if [ -z "$ADMIN_TOKEN" ]; then
  ADMIN_TOKEN="$(gen_token)"
  set_env_kv SETTINGS_ADMIN_TOKEN "$ADMIN_TOKEN" "$ENV_FILE"
  ok "Сгенерирован SETTINGS_ADMIN_TOKEN для панели настроек (показан в баннере ниже)."
fi

# ---------- фронтенд (вариант A: backend отдаёт SPA) ----------
build_frontend() {
  if ! command -v npm >/dev/null 2>&1; then
    log "Node/npm не найдены — ставлю Node 20 (NodeSource) ..."
    if command -v apt-get >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 || true
      apt-get install -y nodejs >/dev/null 2>&1 || true
    fi
  fi
  command -v npm >/dev/null 2>&1 || { warn "npm недоступен — фронт не собран, поднимаю только API."; return 1; }

  log "Собираю фронтенд (same-origin, пустой API-base) ..."
  # .env.production.local имеет высший приоритет у vite → пустой VITE_API_BASE_URL
  # = относительные пути (/generate, /models...), т.е. тот же origin, что и backend.
  printf 'VITE_API_BASE_URL=\n' >"$REPO_ROOT/frontend/.env.production.local"
  # npm ci строгий и падает при дрейфе lock-файла (опц. транзитивные зависимости
  # резолвятся по-разному в разных npm/node) → фолбэк на npm install, который
  # терпим к дрейфу и резолвит под текущее окружение. Для сборки dist этого хватает.
  ( cd "$REPO_ROOT/frontend" \
      && { npm ci --no-audit --no-fund || npm install --no-audit --no-fund; } \
      && npm run build ) \
    || { warn "Сборка фронта упала — поднимаю только API."; return 1; }
  ok "Фронтенд собран: frontend/dist"
}

if [ "$WITH_FRONTEND" -eq 1 ] && build_frontend; then
  set_env_kv SERVE_FRONTEND true "$ENV_FILE"
  ok "Фронт отдаётся backend-ом — публичный URL будет полноценным сайтом."
else
  set_env_kv SERVE_FRONTEND false "$ENV_FILE"
fi

# ---------- запуск backend ----------
UVICORN_PID=""
TAIL_PID=""

# Туннель НЕ убиваем: он запущен detached и должен пережить рестарт backend, чтобы
# публичный URL не менялся. Останавливать его — через `run-vast.sh --stop`.
cleanup() {
  [ -n "$TAIL_PID" ] && kill "$TAIL_PID" 2>/dev/null || true
  [ -n "$UVICORN_PID" ] && kill "$UVICORN_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# Один источник правды: указываем backend читать (через python-dotenv) и писать
# (панель настроек) ОДИН и тот же файл — deploy/backend.vast.env. Никаких копий в
# backend/.env, поэтому правки из панели переживают перезапуск без асимметрии.
# Экспорт наследуется в сабшелл ниже; config.py: load_dotenv(ENV_FILE_PATH).
export ENV_FILE_PATH="$ENV_FILE"
log "Поднимаю backend на $HOST:$PORT (лог: $UVICORN_LOG) ..."
( cd backend && exec "$PY" -m uvicorn main:app --host "$HOST" --port "$PORT" ) >"$UVICORN_LOG" 2>&1 &
UVICORN_PID=$!

log "Жду готовности backend (/health) ..."
healthy=0
for _ in $(seq 1 60); do
  if ! kill -0 "$UVICORN_PID" 2>/dev/null; then
    err "Процесс backend завершился. Последние строки лога:"
    tail -n 30 "$UVICORN_LOG" >&2 || true
    exit 1
  fi
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done
[ "$healthy" -eq 1 ] && ok "Backend готов." || { err "Backend не ответил вовремя. Лог: $UVICORN_LOG"; tail -n 30 "$UVICORN_LOG" >&2 || true; exit 1; }

# ---------- публичный доступ ----------
# Cloudflared запускается DETACHED (setsid: своя сессия, не получает Ctrl+C/SIGHUP
# скрипта) и НЕ убивается в cleanup. Поэтому при повторном запуске скрипта (например
# чтобы применить правки из панели настроек) живой туннель переиспользуется — и
# публичный URL не меняется. Форсировать новый — `--new-tunnel`; погасить — `--stop`.
PUBLIC_API=""
TUNNEL_REUSED=0
if [ "$WITH_TUNNEL" -eq 1 ]; then
  # Переиспользовать существующий туннель, если он жив и у нас есть его URL.
  if [ "$NEW_TUNNEL" -eq 0 ] && [ -f "$CF_PID_FILE" ] && [ -f "$CF_URL_FILE" ]; then
    existing_pid="$(cat "$CF_PID_FILE" 2>/dev/null || true)"
    existing_url="$(cat "$CF_URL_FILE" 2>/dev/null || true)"
    if [ -n "$existing_pid" ] && [ -n "$existing_url" ] && kill -0 "$existing_pid" 2>/dev/null; then
      PUBLIC_API="$existing_url"
      TUNNEL_REUSED=1
      ok "Переиспользую живой cloudflared (pid=$existing_pid) — URL прежний."
    fi
  fi

  if [ "$TUNNEL_REUSED" -eq 0 ]; then
    # Убить прежний туннель, если он был (новый запрошен или старый мёртв/без URL).
    if [ -f "$CF_PID_FILE" ]; then
      old_pid="$(cat "$CF_PID_FILE" 2>/dev/null || true)"
      [ -n "$old_pid" ] && kill "$old_pid" 2>/dev/null || true
      rm -f "$CF_PID_FILE" "$CF_URL_FILE"
    fi
    case "$(uname -m)" in
      x86_64) CF_ARCH=amd64 ;;
      aarch64|arm64) CF_ARCH=arm64 ;;
      *) CF_ARCH=amd64 ;;
    esac
    CF_BIN="$SCRIPT_DIR/.cloudflared-$CF_ARCH"
    if [ ! -x "$CF_BIN" ]; then
      log "Скачиваю cloudflared ($CF_ARCH) ..."
      curl -fsSL -o "$CF_BIN" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$CF_ARCH"
      chmod +x "$CF_BIN"
    fi
    log "Поднимаю Cloudflare quick-tunnel (detached) ..."
    : >"$CF_LOG"
    # setsid отвязывает от управляющего терминала и группы процессов скрипта —
    # туннель не падёт от Ctrl+C/выхода скрипта. </dev/null, чтобы не держать stdin.
    setsid "$CF_BIN" tunnel --no-autoupdate --url "http://localhost:$PORT" >"$CF_LOG" 2>&1 </dev/null &
    disown 2>/dev/null || true
    # $! у setsid ненадёжен — берём реальный pid процесса по командной строке.
    sleep 1
    CF_PID="$(pgrep -f "$CF_BIN tunnel .*localhost:$PORT" 2>/dev/null | head -n1 || true)"
    [ -n "$CF_PID" ] && printf '%s\n' "$CF_PID" >"$CF_PID_FILE"
    for _ in $(seq 1 30); do
      PUBLIC_API="$(grep -Eo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$CF_LOG" 2>/dev/null | tail -n1 || true)"
      [ -n "$PUBLIC_API" ] && break
      sleep 2
    done
    [ -n "$PUBLIC_API" ] && printf '%s\n' "$PUBLIC_API" >"$CF_URL_FILE"
  fi
fi

printf "\n${c_green}==========================================================${c_off}\n"
if [ -n "$PUBLIC_API" ]; then
  if [ "$WITH_FRONTEND" -eq 1 ]; then
    printf   "${c_green}  Сайт (фронт + API на одном URL):${c_off}\n  %s\n\n" "$PUBLIC_API"
    printf   "  Открой этот адрес в браузере — это готовый редактор.\n"
  else
    printf   "${c_green}  Backend API (публичный):${c_off}\n  %s\n\n" "$PUBLIC_API"
    printf   "  На СВОЁМ компьютере (клиенте) выполни:\n"
    printf   "    bash deploy/run-client.sh %s\n" "$PUBLIC_API"
  fi
elif [ "$WITH_TUNNEL" -eq 1 ]; then
  warn "Не удалось извлечь URL туннеля. Смотри: $CF_LOG"
elif [ "$WITH_FRONTEND" -eq 1 ]; then
  printf   "${c_green}  Сайт:${c_off} http://<host>:%s  (туннель отключён)\n\n" "$PORT"
  printf   "  Пробрось порт и открой в браузере: ssh -L %s:127.0.0.1:%s <user>@<vast-host>\n" "$PORT" "$PORT"
else
  printf   "${c_green}  Backend API:${c_off} http://<host>:%s  (туннель отключён)\n\n" "$PORT"
  printf   "  Пробрось порт с клиента и запусти фронтенд на него, например:\n"
  printf   "    ssh -L %s:127.0.0.1:%s <user>@<vast-host>\n" "$PORT" "$PORT"
  printf   "    bash deploy/run-client.sh http://127.0.0.1:%s\n" "$PORT"
fi
if [ -n "${ADMIN_TOKEN:-}" ]; then
  printf "\n  ${c_green}Токен панели настроек (шестерёнка в UI):${c_off} %s\n" "$ADMIN_TOKEN"
fi
if [ -n "$PUBLIC_API" ] && [ "$WITH_TUNNEL" -eq 1 ]; then
  printf "\n  Туннель живёт отдельно от backend: Ctrl+C и повторный запуск применят\n"
  printf "  правки настроек, НЕ меняя этот URL. Сменить URL — флаг --new-tunnel;\n"
  printf "  полностью остановить (backend + туннель) — %sbash deploy/run-vast.sh --stop%s.\n" "$c_green" "$c_off"
fi
if [ -z "${TMUX:-}" ] && [ -z "${STY:-}" ]; then
  printf "\n  ${c_yellow}Не под tmux: закроешь терминал/оборвёшь SSH — backend остановится${c_off}\n"
  printf "  ${c_yellow}(туннель переживёт). Для фона запусти под: tmux new -s app (выход: Ctrl+b, d).${c_off}\n"
fi
printf "${c_green}==========================================================${c_off}\n\n"

if [ "$FOLLOW_LOGS" -eq 1 ]; then
  log "Стримлю логи backend (файл: $UVICORN_LOG)   |   Ctrl+C — остановить."
  printf "${c_green}---------- логи backend ----------${c_off}\n"
  # -n +1: показать лог с самого начала (включая запуск); -F: переживать
  # ротацию/пересоздание файла. Туннель-лог добавляем, если он есть.
  if [ "$WITH_TUNNEL" -eq 1 ] && [ -f "$CF_LOG" ]; then
    tail -n +1 -F "$UVICORN_LOG" "$CF_LOG" &
  else
    tail -n +1 -F "$UVICORN_LOG" &
  fi
  TAIL_PID=$!
else
  log "Логи backend: $UVICORN_LOG   |   Ctrl+C — остановить."
fi

# Блокируемся до завершения backend; затем гасим tail, чтобы скрипт вышел.
wait "$UVICORN_PID"
[ -n "$TAIL_PID" ] && kill "$TAIL_PID" 2>/dev/null || true
