# 04 — GHCR + SSH (CI/CD на постоянный сервер)

Боевой путь для постоянного сервера: GitHub Actions собирает образы, публикует их
в GitHub Container Registry (GHCR) и разворачивает по SSH через `docker compose`.
Этот вариант сложнее остальных (требуются секреты), но полностью автоматизирован.

Если требуется быстрый разовый запуск, используйте
[инструкцию 02 (Docker одной командой)](02-docker-server.md) или
[инструкцию 03 (Vast.ai)](03-vast-ai.md).

---

## Состав релиза

Один релиз — два образа от одного commit SHA:
- `ghcr.io/akinara666/working-title-psd2-backend`
- `ghcr.io/akinara666/working-title-psd2-frontend`

Compose-файлы: [`deploy/compose.staging.yaml`](../deploy/compose.staging.yaml) и
[`deploy/compose.prod.yaml`](../deploy/compose.prod.yaml). Оба монтируют каталоги
`backend/models` и `backend/static/outputs` из репозитория на сервере.

---

## Структура на сервере

```text
~/F2-AI-Image-Editor
├── backend/
│   ├── models/            # модели (volume)
│   └── static/outputs/    # результаты генерации (volume)
└── deploy/
```

Runtime-переменные окружения на сервере: `deploy/backend.staging.env` или
`deploy/backend.prod.env` (шаблон — [`deploy/backend.env.example`](../deploy/backend.env.example)).
Если переменная `BACKEND_ENV_FILE` не задана, compose использует сам example-файл.

---

## Ручное развёртывание на сервере

```bash
# staging
docker compose -f deploy/compose.staging.yaml pull
docker compose -f deploy/compose.staging.yaml up -d

# production
docker compose -f deploy/compose.prod.yaml pull
docker compose -f deploy/compose.prod.yaml up -d
```

Тег образа задаётся переменными `BACKEND_IMAGE_TAG` / `FRONTEND_IMAGE_TAG`
(по умолчанию `staging-latest` / `prod-latest`).

---

## Запуск на GPU

Если backend должен выполнять inference на GPU:
1. установите NVIDIA Container Toolkit;
2. раскомментируйте `gpus: all` в нужном compose-файле;
3. при необходимости включите установку optional runtime-зависимостей в CD workflow.

---

## Адрес API для frontend

`frontend` получает `VITE_API_BASE_URL` на этапе сборки образа. Для staging и
production передавайте адрес, реально доступный браузеру пользователя (публичный
URL backend или reverse-proxy). `http://127.0.0.1:8000` подходит только для
локального smoke-режима.

---

## GitHub Secrets

Пока секреты не заданы, deploy-job в Actions получает статус `skipped`, а не
`failed`. При этом workflow `.github/workflows/cd-validation.yml` всё равно
валидирует сценарий релиза: проверяет compose-файлы, собирает release-образы,
поднимает staging-стек локально в runner и проверяет состояние backend и frontend.

### Staging
`STAGING_SSH_HOST`, `STAGING_SSH_PORT`, `STAGING_SSH_USER`, `STAGING_SSH_PRIVATE_KEY`,
`STAGING_SSH_KNOWN_HOSTS`, `STAGING_APP_DIR`, `STAGING_BACKEND_ENV_FILE`,
`STAGING_GHCR_USERNAME`, `STAGING_GHCR_TOKEN`, `STAGING_FRONTEND_VITE_API_BASE_URL`

### Production
`PROD_SSH_HOST`, `PROD_SSH_PORT`, `PROD_SSH_USER`, `PROD_SSH_PRIVATE_KEY`,
`PROD_SSH_KNOWN_HOSTS`, `PROD_APP_DIR`, `PROD_BACKEND_ENV_FILE`,
`PROD_GHCR_USERNAME`, `PROD_GHCR_TOKEN`, `PROD_FRONTEND_VITE_API_BASE_URL`

---

Полное описание CI/CD — в [`deploy/README.md`](../deploy/README.md) и `REMOTE_SERVER.md`.
