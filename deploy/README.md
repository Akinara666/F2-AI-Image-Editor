# Общий деплой стека

> 📚 Подробные пошаговые гайды по всем вариантам запуска — в [`docs/`](../docs/README.md):
> [локально](../docs/01-local.md) · [Docker одной командой](../docs/02-docker-server.md) ·
> [Vast.ai](../docs/03-vast-ai.md) · [GHCR + CD](../docs/04-ghcr-cd.md).

## 🚀 Быстрый старт одной командой (рекомендуется)

На свежем GPU-сервере (Vast.ai / RunPod / любой хост с NVIDIA-драйвером):

```bash
git clone git@github.com:Akinara666/working-title-psd2.git
cd working-title-psd2
bash deploy/bootstrap.sh
```

Скрипт сам: поставит Docker и (при наличии GPU) NVIDIA Container Toolkit,
создаст `deploy/backend.env`, соберёт образы локально, поднимет
`deploy/compose.gpu.yaml` и поднимет Cloudflare Tunnel. В конце он напечатает
публичный `https://<random>.trycloudflare.com` — это единый URL и для SPA, и
для API (фронтенд проксирует backend через nginx, поэтому CORS не нужен).

Полезные команды (`Makefile` в корне): `make up`, `make down`, `make logs`,
`make url`, `make ps`, `make rebuild`. Флаги скрипта: `--cpu`, `--gpu`,
`--no-tunnel`, `--no-build` (см. `deploy/bootstrap.sh --help`).

Модели **не** качаются на этапе деплоя — их можно скачать с HuggingFace / Civit.ai
прямо из меню «Модели» в интерфейсе редактора.

> Путь выше требует **настоящего Docker-демона с GPU-passthrough** (своя GPU-VM,
> RunPod «Docker host» и т.п.). На типичном **Vast.ai**-инстансе ты уже внутри
> контейнера с готовым CUDA — там вложенный Docker не нужен и часто не работает.
> Для этого случая есть отдельный путь ниже.

---

## 🟢 Vast.ai / готовый CUDA-контейнер (без Docker)

Когда инстанс — это уже контейнер с CUDA и Python (Vast.ai, RunPod-pod, Colab-подобное),
backend запускается напрямую, без вложенного Docker. GPU-нагрузка (backend) живёт
на сервере, лёгкий фронтенд — у тебя на клиенте.

**На сервере (vast.ai-инстанс):**

```bash
git clone https://github.com/Akinara666/working-title-psd2.git
cd working-title-psd2
bash deploy/run-vast.sh
```

Скрипт ([deploy/run-vast.sh](run-vast.sh)) ставит зависимости backend прямо в
окружение инстанса (**предустановленный CUDA-torch не трогает** — типично для
vast pytorch-образов), поднимает `uvicorn` на `0.0.0.0:8000` и Cloudflare
quick-tunnel, затем печатает публичный `https://<random>.trycloudflare.com` —
это адрес **API**.

**На своём компьютере (клиент):**

```bash
bash deploy/run-client.sh https://<random>.trycloudflare.com
# затем открой http://localhost:5173
```

Скрипт ([deploy/run-client.sh](run-client.sh)) прописывает адрес backend в
`frontend/.env.local` и поднимает Vite dev-сервер. CORS для `localhost` backend
разрешает по умолчанию, поэтому ничего больше настраивать не нужно.

Флаги `run-vast.sh`: `--no-tunnel` (доступ через проброшенный порт vast / `ssh -L`),
`--optional` (xformers + llama-cpp-python), `--no-venv`, `--reinstall`,
`--port N`, `--torch-index URL` (см. `bash deploy/run-vast.sh --help`).

**Заметки по vast.ai:**

- Хранилище инстанса эфемерно — чтобы не перекачивать модели каждую аренду,
  держи `backend/models` на persistent-томе (например симлинк/монт на `/workspace`).
- Публичный URL trycloudflare случайный и **без авторизации** — любой со ссылкой
  жжёт твою GPU. Не выкладывай его публично; для приватного доступа используй
  `--no-tunnel` + `ssh -L`.
- `--no-tunnel` удобен, если у инстанса уже проброшен внешний порт на 8000.

---

## Файлы этой папки

- `bootstrap.sh` — запуск всего стека одной командой (Docker + GPU + Cloudflare Tunnel)
- `run-vast.sh` — backend напрямую без Docker (Vast.ai / готовый CUDA-контейнер)
- `run-client.sh` — фронтенд на клиенте с подключением к удалённому backend
- `compose.gpu.yaml` — боевой стек: GPU (CUDA-torch) + Cloudflare Tunnel, сборка локально
- `compose.staging.yaml` / `compose.prod.yaml` — альтернативный CD через готовые образы из GHCR
- `backend.env.example` — канонический шаблон runtime-переменных backend

Локальный orchestration для `CI` и ручного smoke-прогона находится в корневом `compose.yaml`.

## Альтернатива: CD через GHCR + SSH

Ниже описан второй путь — автоматическая выкладка через GitHub Actions
(собирает образы, пушит в GHCR, по SSH разворачивает на сервере). Он сложнее
(нужны ~10 секретов на окружение) и без них job просто `skipped`. Используй его,
если нужен полноценный CI/CD на постоянный сервер.

Пока целевой сервер ещё не подключён, в репозитории есть workflow
`.github/workflows/cd-validation.yml`.
Он проверяет release-сценарий и корректность deploy-конфигурации:

- валидирует `deploy`-compose-файлы
- собирает release-образы для проверки
- поднимает staging-стек локально в GitHub runner
- проверяет health backend и frontend

## Что выкатывается

Один релиз всегда состоит из двух образов от одного и того же commit SHA:

- `ghcr.io/akinara666/working-title-psd2-backend`
- `ghcr.io/akinara666/working-title-psd2-frontend`

Workflow собирает оба образа, пушит их в `GHCR`, потом по `SSH` выкладывает их вместе через `docker compose`.
Пока нужные secrets не заведены, deploy-job в GitHub Actions будет автоматически `skipped`, а не `failed`.

## Структура на сервере

Ожидаемая структура репозитория на сервере:

```text
~/working-title-psd2
├── backend/
│   ├── models/
│   └── static/outputs/
└── deploy/
```

Backend хранит модели и результаты генерации в volume-монтах из репозитория:

- `./backend/models`
- `./backend/static/outputs`

## Runtime env-файлы backend

На сервере workflow создаёт один из этих файлов:

- `deploy/backend.staging.env`
- `deploy/backend.prod.env`

Шаблон значений лежит в `deploy/backend.env.example`.
Если переменная `BACKEND_ENV_FILE` не задана, compose по умолчанию использует именно этот example-файл.

## Важный момент по frontend API

`frontend` получает `VITE_API_BASE_URL` на этапе сборки образа.
Для staging и production нужно передавать адрес, который реально доступен браузеру пользователя.

Обычно это:

- либо публичный URL backend
- либо URL reverse proxy, если backend публикуется через него

`http://127.0.0.1:8000` подходит только для локального smoke-режима.

## GitHub Secrets

### Staging

- `STAGING_SSH_HOST`
- `STAGING_SSH_PORT`
- `STAGING_SSH_USER`
- `STAGING_SSH_PRIVATE_KEY`
- `STAGING_SSH_KNOWN_HOSTS`
- `STAGING_APP_DIR`
- `STAGING_BACKEND_ENV_FILE`
- `STAGING_GHCR_USERNAME`
- `STAGING_GHCR_TOKEN`
- `STAGING_FRONTEND_VITE_API_BASE_URL`

### Production

- `PROD_SSH_HOST`
- `PROD_SSH_PORT`
- `PROD_SSH_USER`
- `PROD_SSH_PRIVATE_KEY`
- `PROD_SSH_KNOWN_HOSTS`
- `PROD_APP_DIR`
- `PROD_BACKEND_ENV_FILE`
- `PROD_GHCR_USERNAME`
- `PROD_GHCR_TOKEN`
- `PROD_FRONTEND_VITE_API_BASE_URL`

## Команды на сервере

Staging:

```bash
docker compose -f deploy/compose.staging.yaml pull
docker compose -f deploy/compose.staging.yaml up -d
```

Production:

```bash
docker compose -f deploy/compose.prod.yaml pull
docker compose -f deploy/compose.prod.yaml up -d
```

## Примечание по GPU

Если backend должен реально выполнять inference на GPU-хосте:

1. установи на сервер `NVIDIA Container Toolkit`
2. раскомментируй `gpus: all` в нужном compose-файле
3. при необходимости включи установку optional runtime-зависимостей в `CD` workflow
