# Инструкции по запуску backend

Backend (FastAPI, Diffusers, PyTorch) можно развернуть несколькими способами — от
локальной разработки до GPU-сервера с публичным адресом. Выберите подходящий
сценарий ниже.

## Выбор варианта

| Сценарий | Инструкция | Docker | GPU | Генерация |
|---|---|---|---|---|
| Разработка на собственной машине | [01 — Локально](01-local.md) | нет (или лёгкий smoke-стек) | опц. | да (bare) |
| Собственный GPU-сервер / VM / RunPod (есть Docker) | [02 — Docker одной командой](02-docker-server.md) | да | да | да |
| Vast.ai / готовый CUDA-контейнер (без Docker) | [03 — Vast.ai](03-vast-ai.md) | нет | да | да |
| Постоянный сервер с CI/CD | [04 — GHCR + SSH (CD)](04-ghcr-cd.md) | да | опц. | да |

## Краткое описание различий

- **01 — Локально.** Запуск `uvicorn` напрямую из исходного кода; основной режим
  при разработке. Реальная генерация работает при установке полного
  `requirements.txt` (на CPU медленно, на GPU требуется CUDA-torch). Дополнительно
  доступен лёгкий Docker smoke-стек (`compose.yaml`) без AI-runtime — только для
  проверки API и интерфейса.
- **02 — Docker одной командой.** [`deploy/bootstrap.sh`](../deploy/bootstrap.sh)
  (`make up`) устанавливает Docker и NVIDIA Container Toolkit, собирает образы,
  поднимает backend, frontend и Cloudflare Tunnel и выводит публичный адрес
  `https://…trycloudflare.com`. Требуется полноценный Docker-демон с доступом к GPU
  (собственная VM, RunPod в режиме «Docker host»).
- **03 — Vast.ai.** [`deploy/run-vast.sh`](../deploy/run-vast.sh) запускает backend
  напрямую, без вложенного Docker, на готовом CUDA-контейнере; фронтенд выполняется
  на клиентском компьютере ([`deploy/run-client.sh`](../deploy/run-client.sh)).
  Три способа подключения: Cloudflare Tunnel, проброс порта по SSH, нативный порт Vast.ai.
- **04 — GHCR + SSH (CD).** Готовые образы из GitHub Container Registry, развёртывание
  по SSH через `docker compose` (`compose.staging.yaml` / `compose.prod.yaml`).
  Для постоянного сервера с автоматическим развёртыванием из CI.

## Общие сведения

- **Порты:** backend — `8000`, frontend — `3000` (Docker, nginx) или `5173` (Vite dev).
- **Единый источник переменных окружения:** [`deploy/backend.env.example`](../deploy/backend.env.example).
  Полный справочник — в [инструкции «Локально»](01-local.md#переменные-окружения).
- **Модели не встроены** в образы — загружаются из меню «Модели» в редакторе
  (HuggingFace / Civit.ai) после запуска.
- **CORS:** когда фронтенд проксирует API самостоятельно (Docker, same-origin) —
  настройка CORS не требуется. Когда фронтенд на клиенте обращается к удалённому
  backend — по умолчанию разрешён любой origin вида `localhost` (см.
  `CORS_ALLOW_ORIGIN_REGEX`).
