#!/usr/bin/env bash
#
# Запуск всего стека (backend + frontend + Cloudflare Tunnel) одной командой.
#
#   git clone <repo> && cd <repo>
#   bash deploy/bootstrap.sh
#
# По умолчанию автоопределяет GPU: если есть nvidia-smi — поднимает GPU-стек
# (deploy/compose.gpu.yaml) с CUDA-torch и публичным URL от Cloudflare.
# Иначе — лёгкий CPU-стек (corневой compose.yaml).
#
# Флаги:
#   --gpu         форсировать GPU-стек
#   --cpu         форсировать CPU-стек (без GPU и без туннеля)
#   --no-tunnel   GPU-стек без cloudflared (доступ только по SSH-туннелю)
#   --no-build    не пересобирать образы (docker compose up без --build)
#   -h | --help   показать справку
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

MODE="auto"        # auto | gpu | cpu
WITH_TUNNEL=1
BUILD=1

# ---------- логирование ----------
c_blue="\033[1;34m"; c_yellow="\033[1;33m"; c_red="\033[1;31m"; c_green="\033[1;32m"; c_off="\033[0m"
log()  { printf "${c_blue}[bootstrap]${c_off} %s\n" "$*"; }
ok()   { printf "${c_green}[bootstrap]${c_off} %s\n" "$*"; }
warn() { printf "${c_yellow}[bootstrap]${c_off} %s\n" "$*" >&2; }
err()  { printf "${c_red}[bootstrap]${c_off} %s\n" "$*" >&2; }

usage() { sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

# ---------- разбор аргументов ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --gpu) MODE="gpu" ;;
    --cpu) MODE="cpu" ;;
    --no-tunnel) WITH_TUNNEL=0 ;;
    --no-build) BUILD=0 ;;
    -h|--help) usage ;;
    *) err "Неизвестный аргумент: $1"; usage ;;
  esac
  shift
done

# ---------- sudo ----------
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    warn "Не root и нет sudo — установка системных пакетов может не сработать."
  fi
fi

# ---------- docker ----------
ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    return
  fi
  log "Docker не найден — ставлю через get.docker.com ..."
  curl -fsSL https://get.docker.com | $SUDO sh
  if command -v systemctl >/dev/null 2>&1; then
    $SUDO systemctl enable --now docker || true
  fi
  ok "Docker установлен."
}

ensure_compose() {
  if docker compose version >/dev/null 2>&1; then
    return
  fi
  err "Не найден плагин 'docker compose' (v2). Установи Docker посвежее и повтори."
  exit 1
}

gpu_present() { command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; }

docker_sees_gpu() {
  docker run --rm --gpus all nvidia/cuda:12.1.1-base-ubuntu22.04 nvidia-smi >/dev/null 2>&1
}

ensure_nvidia_toolkit() {
  if docker_sees_gpu; then
    ok "Docker уже видит GPU (--gpus all работает)."
    return
  fi
  if ! command -v apt-get >/dev/null 2>&1; then
    warn "Не Debian/Ubuntu — пропускаю авто-установку NVIDIA Container Toolkit."
    warn "Поставь его вручную: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/"
    return
  fi
  log "Ставлю NVIDIA Container Toolkit ..."
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
    | $SUDO gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    | $SUDO tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
  $SUDO apt-get update
  $SUDO apt-get install -y nvidia-container-toolkit
  $SUDO nvidia-ctk runtime configure --runtime=docker
  if command -v systemctl >/dev/null 2>&1; then
    $SUDO systemctl restart docker || true
  fi
  if docker_sees_gpu; then
    ok "GPU доступен из контейнеров."
  else
    warn "GPU всё ещё не виден из Docker — проверь драйвер NVIDIA на хосте."
  fi
}

# ---------- env ----------
ensure_env() {
  local target="$SCRIPT_DIR/backend.env"
  if [ -f "$target" ]; then
    log "Использую существующий deploy/backend.env"
    return
  fi
  cp "$SCRIPT_DIR/backend.env.example" "$target"
  if [ "$MODE" = "gpu" ]; then
    # На GPU-стеке включаем CUDA в runtime-конфиге.
    sed -i 's/^USE_CUDA=.*/USE_CUDA=true/' "$target"
  else
    sed -i 's/^USE_CUDA=.*/USE_CUDA=false/' "$target"
  fi
  ok "Создан deploy/backend.env из шаблона (отредактируй при необходимости)."
}

# ---------- ожидание health ----------
wait_health() {
  local url="$1" name="$2"
  log "Жду готовности $name ($url) ..."
  for _ in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      ok "$name готов."
      return 0
    fi
    sleep 3
  done
  err "$name не ответил вовремя."
  return 1
}

# ---------- публичный URL ----------
print_tunnel_url() {
  log "Жду публичный URL от Cloudflare ..."
  local url=""
  for _ in $(seq 1 30); do
    url="$("${COMPOSE[@]}" logs cloudflared 2>&1 \
      | grep -Eo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' | tail -n1 || true)"
    [ -n "$url" ] && break
    sleep 2
  done
  if [ -n "$url" ]; then
    printf "\n${c_green}==========================================================${c_off}\n"
    printf   "${c_green}  Приложение доступно по адресу:${c_off}\n  %s\n" "$url"
    printf   "${c_green}==========================================================${c_off}\n\n"
  else
    warn "Не удалось извлечь URL. Посмотри логи: ${COMPOSE[*]} logs cloudflared"
  fi
}

# ---------- main ----------
cd "$REPO_ROOT"

ensure_docker
ensure_compose

if [ "$MODE" = "auto" ]; then
  if gpu_present; then MODE="gpu"; ok "Обнаружен GPU — режим gpu."; else MODE="cpu"; warn "GPU не найден — режим cpu."; fi
fi

if [ "$MODE" = "gpu" ]; then
  ensure_nvidia_toolkit
  COMPOSE=(docker compose -f deploy/compose.gpu.yaml)
  # Путь относительно каталога compose-файла (deploy/).
  export BACKEND_ENV_FILE="./backend.env"
else
  WITH_TUNNEL=0
  COMPOSE=(docker compose -f compose.yaml)
fi

ensure_env

UP_ARGS=(up -d)
[ "$BUILD" -eq 1 ] && UP_ARGS+=(--build)

SERVICES=()
if [ "$MODE" = "gpu" ] && [ "$WITH_TUNNEL" -eq 0 ]; then
  SERVICES=(backend frontend)   # без cloudflared
fi

log "Поднимаю стек (режим: $MODE, туннель: $WITH_TUNNEL) ..."
"${COMPOSE[@]}" "${UP_ARGS[@]}" "${SERVICES[@]}"

wait_health "http://127.0.0.1:8000/health" "backend"
wait_health "http://127.0.0.1:3000/health" "frontend (reverse-proxy)"

if [ "$MODE" = "gpu" ] && [ "$WITH_TUNNEL" -eq 1 ]; then
  print_tunnel_url
else
  ok "Локально: фронтенд http://127.0.0.1:3000  |  backend http://127.0.0.1:8000"
  [ "$MODE" = "gpu" ] && log "Туннель отключён (--no-tunnel): пробрось порт через ssh -L 3000:127.0.0.1:3000 user@host"
fi

ok "Готово."
