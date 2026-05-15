# Деплой Backend

Файлы деплоя backend лежат здесь, чтобы структура репозитория оставалась сервисно-ориентированной:

- `compose.staging.yaml` для staging-деплоя из ветки `dev`
- `compose.prod.yaml` для ручного production-деплоя
- `backend.env.example` как базовый шаблон runtime-переменных

## Структура на сервере

Ожидаемая структура репозитория на целевом сервере:

```text
~/working-title-psd2
├── backend/
│   ├── models/
│   └── static/outputs/
└── deploy/backend/
```

Команды деплоя нужно выполнять из корня репозитория с явным указанием project directory:

```bash
docker compose --project-directory . -f deploy/backend/compose.staging.yaml pull
docker compose --project-directory . -f deploy/backend/compose.staging.yaml up -d
```

## Runtime env-файлы

На сервере нужно создать один из этих файлов:

- `deploy/backend/backend.staging.env`
- `deploy/backend/backend.prod.env`

За основу бери `deploy/backend/backend.env.example`.

## GitHub secrets

Для staging workflow нужны:

- `BACKEND_STAGING_SSH_HOST`
- `BACKEND_STAGING_SSH_PORT`
- `BACKEND_STAGING_SSH_USER`
- `BACKEND_STAGING_SSH_PRIVATE_KEY`
- `BACKEND_STAGING_SSH_KNOWN_HOSTS`
- `BACKEND_STAGING_APP_DIR`
- `BACKEND_STAGING_ENV_FILE`
- `BACKEND_STAGING_GHCR_USERNAME`
- `BACKEND_STAGING_GHCR_TOKEN`

Для production workflow нужен тот же набор, но с префиксом `BACKEND_PROD_...`.

## Примечание по GPU

Если на хосте должен работать GPU-inference, установи на сервер `NVIDIA Container Toolkit`
и раскомментируй `gpus: all` в нужном compose-файле.
