# Развёртывание стека

Подробные пошаговые инструкции по всем вариантам запуска приведены в каталоге
[`docs/`](../docs/README.md): [локально](../docs/01-local.md),
[Docker одной командой](../docs/02-docker-server.md),
[Vast.ai](../docs/03-vast-ai.md), [GHCR + CD](../docs/04-ghcr-cd.md).
Ниже — справка по содержимому этого каталога и по сценарию CI/CD.

## Быстрый старт одной командой

На свежем GPU-сервере (Vast.ai, RunPod или любой хост с NVIDIA-драйвером):

```bash
git clone https://github.com/Akinara666/F2-AI-Image-Editor.git
cd F2-AI-Image-Editor
bash deploy/bootstrap.sh
```

Скрипт устанавливает Docker и (при наличии GPU) NVIDIA Container Toolkit, создаёт
`deploy/backend.env`, собирает образы локально, поднимает `deploy/compose.gpu.yaml`
и Cloudflare Tunnel. По завершении выводится публичный адрес
`https://<random>.trycloudflare.com` — единый URL для интерфейса и API (фронтенд
проксирует backend через nginx, поэтому настройка CORS не требуется).

Команды управления (`Makefile` в корне): `make up`, `make down`, `make logs`,
`make url`, `make ps`, `make rebuild`. Флаги скрипта: `--cpu`, `--gpu`,
`--no-tunnel`, `--no-build` (см. `bash deploy/bootstrap.sh --help`).

Модели не загружаются на этапе развёртывания — их можно скачать из HuggingFace
или Civit.ai непосредственно из меню «Модели» в интерфейсе редактора.

Этот путь требует полноценного Docker-демона с доступом к GPU (собственная GPU-VM,
RunPod в режиме «Docker host» и т. п.). На типичном инстансе Vast.ai вы уже
находитесь внутри контейнера с готовым CUDA, где вложенный Docker не нужен и
зачастую недоступен; для этого случая используйте путь, описанный ниже.

## Vast.ai или готовый CUDA-контейнер (без Docker)

Когда инстанс — это уже контейнер с CUDA и Python (Vast.ai, RunPod-pod и подобные),
backend запускается напрямую, без вложенного Docker. Вычислительная нагрузка
(backend) выполняется на сервере, лёгкий фронтенд — на клиентском компьютере.

На сервере:

```bash
git clone https://github.com/Akinara666/F2-AI-Image-Editor.git
cd F2-AI-Image-Editor
bash deploy/run-vast.sh
```

[`deploy/run-vast.sh`](run-vast.sh) устанавливает зависимости backend прямо в
окружение инстанса (предустановленный CUDA-torch не затрагивается — это типично
для PyTorch-образов Vast.ai), запускает `uvicorn` на `0.0.0.0:8000` и Cloudflare
Tunnel, после чего выводит публичный адрес API `https://<random>.trycloudflare.com`.

На клиентском компьютере:

```bash
bash deploy/run-client.sh https://<random>.trycloudflare.com
# затем откройте http://localhost:5173
```

[`deploy/run-client.sh`](run-client.sh) записывает адрес backend в
`frontend/.env.local` и запускает dev-сервер Vite. CORS для `localhost`
разрешён по умолчанию, дополнительная настройка не требуется.

Полная инструкция и три способа подключения (Cloudflare Tunnel, проброс порта по
SSH, нативный порт Vast.ai) — в [docs/03-vast-ai.md](../docs/03-vast-ai.md).

## Файлы каталога

- `bootstrap.sh` — запуск всего стека одной командой (Docker, GPU, Cloudflare Tunnel).
- `run-vast.sh` — запуск backend напрямую без Docker (Vast.ai, готовый CUDA-контейнер).
- `run-client.sh` — запуск фронтенда на клиенте с подключением к удалённому backend.
- `compose.gpu.yaml` — боевой стек: GPU (CUDA-torch) и Cloudflare Tunnel, сборка локально.
- `compose.staging.yaml` / `compose.prod.yaml` — развёртывание через готовые образы из GHCR.
- `backend.env.example` — канонический шаблон runtime-переменных backend.

Локальная оркестрация для CI и ручного smoke-прогона находится в корневом `compose.yaml`.

## Развёртывание через GHCR и SSH (CI/CD)

Второй путь — автоматическая выкладка через GitHub Actions: сборка образов, push
в GHCR и развёртывание на сервере по SSH через `docker compose`. Он сложнее
(требуется около десяти секретов на окружение), без них deploy-job получает
статус `skipped`. Используйте его для постоянного сервера с полноценным CI/CD.

Пока целевой сервер не подключён, в репозитории действует workflow
`.github/workflows/cd-validation.yml`. Он проверяет сценарий релиза и корректность
конфигурации развёртывания:

- валидирует compose-файлы каталога `deploy`;
- собирает release-образы;
- поднимает staging-стек локально в GitHub runner;
- проверяет состояние (health) backend и frontend.

### Состав релиза

Один релиз состоит из двух образов от одного commit SHA:

- `ghcr.io/akinara666/working-title-psd2-backend`
- `ghcr.io/akinara666/working-title-psd2-frontend`

Workflow собирает оба образа, публикует их в GHCR, затем по SSH разворачивает их
через `docker compose`. Пока секреты не заданы, deploy-job получает статус
`skipped`, а не `failed`.

### Структура на сервере

```text
~/F2-AI-Image-Editor
├── backend/
│   ├── models/
│   └── static/outputs/
└── deploy/
```

Backend хранит модели и результаты генерации в volume-монтах из репозитория:

- `./backend/models`
- `./backend/static/outputs`

### Runtime env-файлы backend

На сервере workflow создаёт один из файлов:

- `deploy/backend.staging.env`
- `deploy/backend.prod.env`

Шаблон значений — `deploy/backend.env.example`. Если переменная `BACKEND_ENV_FILE`
не задана, compose использует сам example-файл.

### Адрес API для frontend

`frontend` получает `VITE_API_BASE_URL` на этапе сборки образа. Для staging и
production необходимо передавать адрес, реально доступный браузеру пользователя:

- публичный URL backend, либо
- URL reverse proxy, если backend публикуется через него.

`http://127.0.0.1:8000` подходит только для локального smoke-режима.

### GitHub Secrets

Staging:

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

Production:

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

### Команды на сервере

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

### Запуск на GPU

Если backend должен выполнять inference на GPU-хосте:

1. установите NVIDIA Container Toolkit;
2. раскомментируйте `gpus: all` в нужном compose-файле;
3. при необходимости включите установку optional runtime-зависимостей в CD workflow.
