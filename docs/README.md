# Гайды по запуску бэкенда

Бэкенд (FastAPI + Diffusers + Torch) можно поднять несколькими способами — от
локальной разработки до GPU-сервера с публичным URL. Выбери свой сценарий ниже.

## Какой вариант мне нужен?

| Сценарий | Гайд | Docker? | GPU | Генерация |
|---|---|---|---|---|
| Разработка/правки на своей машине | [01 — Локально](01-local.md) | нет (или лёгкий smoke-стек) | опц. | да (bare) |
| Свой GPU-сервер / VM / RunPod (есть Docker) | [02 — Docker одной командой](02-docker-server.md) | да | да | да |
| **Vast.ai / готовый CUDA-контейнер (без Docker)** | [03 — Vast.ai](03-vast-ai.md) | нет | да | да |
| Постоянный прод-сервер с CI/CD | [04 — GHCR + SSH (CD)](04-ghcr-cd.md) | да | опц. | да |

## Коротко про различия

- **01 — Локально.** Запуск `uvicorn` напрямую из исходников. Нужен, когда правишь
  код. Реальная генерация работает, если поставить полный `requirements.txt`
  (на CPU — медленно, на GPU — нужен cuda-torch). Есть ещё лёгкий Docker-smoke
  стек (`compose.yaml`) **без AI-runtime** — только для проверки API/UI.
- **02 — Docker одной командой.** [`deploy/bootstrap.sh`](../deploy/bootstrap.sh)
  (`make up`): сам ставит Docker и NVIDIA-toolkit, собирает образы, поднимает
  backend+frontend+Cloudflare Tunnel и печатает публичный `https://…trycloudflare.com`.
  Требует **настоящий Docker-демон с GPU-passthrough** (своя VM, RunPod «Docker host»).
- **03 — Vast.ai.** [`deploy/run-vast.sh`](../deploy/run-vast.sh): backend запускается
  **напрямую без вложенного Docker** на готовом CUDA-контейнере; фронтенд крутится
  у тебя на клиенте ([`deploy/run-client.sh`](../deploy/run-client.sh)). Три способа
  подключения: Cloudflare-туннель, SSH-проброс порта, нативный порт vast.
- **04 — GHCR + SSH (CD).** Готовые образы из GitHub Container Registry, выкладка
  по SSH через `docker compose` (`compose.staging.yaml` / `compose.prod.yaml`).
  Для постоянного сервера с автодеплоем из CI.

## Общие факты

- **Порты:** backend — `8000`, фронтенд — `3000` (Docker, nginx) или `5173` (Vite dev).
- **Единый источник env:** [`deploy/backend.env.example`](../deploy/backend.env.example).
  Полный разбор переменных — [reference в гайде «Локально»](01-local.md#переменные-окружения).
- **Модели не вшиты** в образы — качаются из меню «Модели» в редакторе
  (HuggingFace / Civit.ai) уже после запуска.
- **CORS:** когда фронтенд проксирует API сам (Docker, same-origin) — CORS не нужен.
  Когда фронт у клиента ходит на удалённый backend — по умолчанию разрешён любой
  `localhost`-origin (см. `CORS_ALLOW_ORIGIN_REGEX`).
