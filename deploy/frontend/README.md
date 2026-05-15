# Деплой frontend

В этой папке лежат файлы для сборки и выкладки frontend-сервиса в Docker.

## Что находится в папке

- `compose.staging.yaml` — staging-окружение
- `compose.prod.yaml` — production-окружение

## Как устроен frontend-образ

- сборка выполняется в `node`-stage
- готовая статика копируется в `nginx`
- API-адрес задаётся на этапе сборки через `VITE_API_BASE_URL`

## Какие GitHub Secrets нужны

### Для staging

- `FRONTEND_STAGING_SSH_HOST`
- `FRONTEND_STAGING_SSH_PORT`
- `FRONTEND_STAGING_SSH_USER`
- `FRONTEND_STAGING_SSH_PRIVATE_KEY`
- `FRONTEND_STAGING_SSH_KNOWN_HOSTS`
- `FRONTEND_STAGING_APP_DIR`
- `FRONTEND_STAGING_GHCR_USERNAME`
- `FRONTEND_STAGING_GHCR_TOKEN`
- `FRONTEND_STAGING_VITE_API_BASE_URL`

### Для production

- `FRONTEND_PROD_SSH_HOST`
- `FRONTEND_PROD_SSH_PORT`
- `FRONTEND_PROD_SSH_USER`
- `FRONTEND_PROD_SSH_PRIVATE_KEY`
- `FRONTEND_PROD_SSH_KNOWN_HOSTS`
- `FRONTEND_PROD_APP_DIR`
- `FRONTEND_PROD_GHCR_USERNAME`
- `FRONTEND_PROD_GHCR_TOKEN`
- `FRONTEND_PROD_VITE_API_BASE_URL`

## Локальная сборка

```bash
docker build -f frontend/Dockerfile -t working-title-psd2-frontend ./frontend
docker run --rm -p 3000:80 working-title-psd2-frontend
```

## Проверка после деплоя

После старта контейнера приложение должно отвечать по `http://127.0.0.1:3000`.
