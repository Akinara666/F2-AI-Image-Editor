# 04 — GHCR + SSH (CI/CD на постоянный сервер)

Боевой путь для **постоянного сервера**: GitHub Actions собирает образы, пушит в
GitHub Container Registry (GHCR) и по SSH разворачивает их через `docker compose`.
Сложнее остальных (нужны секреты), зато полностью автоматический.

> Если нужен просто быстрый разовый запуск — это, скорее всего, не твой вариант:
> смотри [гайд 02 (Docker одной командой)](02-docker-server.md) или
> [гайд 03 (Vast.ai)](03-vast-ai.md).

---

## Что выкатывается

Один релиз = два образа от одного commit SHA:
- `ghcr.io/akinara666/working-title-psd2-backend`
- `ghcr.io/akinara666/working-title-psd2-frontend`

Compose-файлы: [`deploy/compose.staging.yaml`](../deploy/compose.staging.yaml) и
[`deploy/compose.prod.yaml`](../deploy/compose.prod.yaml). Оба монтируют
`backend/models` и `backend/static/outputs` из репозитория на сервере.

---

## Структура на сервере

```text
~/working-title-psd2
├── backend/
│   ├── models/            # модели (volume)
│   └── static/outputs/    # результаты генерации (volume)
└── deploy/
```

Runtime-env на сервере: `deploy/backend.staging.env` или `deploy/backend.prod.env`
(шаблон — [`deploy/backend.env.example`](../deploy/backend.env.example)). Если
`BACKEND_ENV_FILE` не задан, compose берёт сам example-файл.

---

## Ручная выкладка на сервере

```bash
# staging
docker compose -f deploy/compose.staging.yaml pull
docker compose -f deploy/compose.staging.yaml up -d

# production
docker compose -f deploy/compose.prod.yaml pull
docker compose -f deploy/compose.prod.yaml up -d
```

Тег образа управляется через `BACKEND_IMAGE_TAG` / `FRONTEND_IMAGE_TAG`
(по умолчанию `staging-latest` / `prod-latest`).

---

## GPU на сервере

Если backend должен считать на GPU:
1. поставь на сервер **NVIDIA Container Toolkit**;
2. раскомментируй `gpus: all` в нужном compose-файле;
3. при необходимости включи установку optional runtime-зависимостей в CD workflow.

---

## Frontend API base

`frontend` получает `VITE_API_BASE_URL` **на этапе сборки образа**. Для
staging/prod передавай адрес, реально доступный браузеру пользователя (публичный
URL backend или reverse-proxy). `http://127.0.0.1:8000` годится только для
локального smoke.

---

## GitHub Secrets

Пока секреты не заданы, deploy-job в Actions становится `skipped` (не `failed`).
А `.github/workflows/cd-validation.yml` всё равно валидирует релиз-сценарий:
проверяет compose-файлы, собирает release-образы, поднимает staging локально в
runner и проверяет health backend/frontend.

### Staging
`STAGING_SSH_HOST`, `STAGING_SSH_PORT`, `STAGING_SSH_USER`, `STAGING_SSH_PRIVATE_KEY`,
`STAGING_SSH_KNOWN_HOSTS`, `STAGING_APP_DIR`, `STAGING_BACKEND_ENV_FILE`,
`STAGING_GHCR_USERNAME`, `STAGING_GHCR_TOKEN`, `STAGING_FRONTEND_VITE_API_BASE_URL`

### Production
`PROD_SSH_HOST`, `PROD_SSH_PORT`, `PROD_SSH_USER`, `PROD_SSH_PRIVATE_KEY`,
`PROD_SSH_KNOWN_HOSTS`, `PROD_APP_DIR`, `PROD_BACKEND_ENV_FILE`,
`PROD_GHCR_USERNAME`, `PROD_GHCR_TOKEN`, `PROD_FRONTEND_VITE_API_BASE_URL`

---

Полный разбор CD — в [`deploy/README.md`](../deploy/README.md) и `REMOTE_SERVER.md`.
