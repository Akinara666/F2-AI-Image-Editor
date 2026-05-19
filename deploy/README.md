# Общий деплой стека

В этой папке лежит единая схема выкладки для всего приложения:

- `compose.staging.yaml` для staging-окружения
- `compose.prod.yaml` для production-окружения
- `backend.env.example` как шаблон runtime-переменных backend

Локальный orchestration для `CI` и ручного smoke-прогона находится в корневом `compose.yaml`.
Файлы из этой папки нужны именно для `CD` и работы на сервере.

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
