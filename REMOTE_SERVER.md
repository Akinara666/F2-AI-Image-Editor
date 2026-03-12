# Инструкция: Backend на удаленном сервере

Этот документ описывает два рабочих сценария:

1. `SSH`-туннель между вашим ПК и удалённым backend.
2. Публичный `https://` URL через `cloudflared` или `ngrok`.

Если используете `SSH`-туннель, CORS обычно не нужен: браузер видит `localhost:8000`.
Если используете публичный URL (`trycloudflare.com`, `ngrok-free.app`), CORS обязателен.

## Где лежат env-переменные

- `backend/.env`
  Backend читает его через `python-dotenv`.
- `frontend/.env`
  Vite читает его при запуске фронтенда.

Новые переменные для удалённого сценария:

- `backend/.env`: `CORS_ALLOW_ORIGINS`, `CORS_ALLOW_ORIGIN_REGEX`
- `frontend/.env`: `VITE_API_BASE_URL`

Их можно задать и через `export`, но для постоянной конфигурации лучше хранить в `.env`.

---

## Шаг 1: Подготовка удаленного сервера

### Вариант А: обычный Linux/VPS

```bash
ssh root@<IP_АДРЕС_СЕРВЕРА>
```

### Вариант Б: Vast.ai

```bash
ssh -p <PORT_С_VAST> root@<IP_С_VAST>
```

### Настройка backend на сервере

```bash
cd path/to/working-title-psd2/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

После этого отредактируйте `backend/.env`.

Минимум для обычного запуска:

```env
USE_CUDA=true
DEFAULT_MODEL_ID=runwayml/stable-diffusion-v1-5
```

Если backend будет доступен через публичный URL, добавьте CORS:

```env
CORS_ALLOW_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
CORS_ALLOW_ORIGIN_REGEX=^https?://(localhost|127\.0\.0\.1)(:\d+)?$
```

Запуск:

```bash
venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Важно: backend должен слушать `127.0.0.1:8000`, а не внешний интерфейс.

---

## Сценарий A: SSH-туннель

Это предпочтительный вариант.

### На вашем ПК

```bash
ssh -N -f -L 8000:127.0.0.1:8000 root@<IP_АДРЕС_СЕРВЕРА>
```

Для Vast.ai:

```bash
ssh -N -f -L 8000:127.0.0.1:8000 -p <PORT_С_VAST> root@<IP_С_VAST>
```

### Настройка frontend

В `frontend/.env`:

```env
VITE_API_BASE_URL=http://localhost:8000
```

Дальше:

```bash
cd path/to/working-title-psd2/frontend
npm install
npm run dev
```

Откройте `http://localhost:5173`.

В этом сценарии CORS обычно не нужен.

---

## Сценарий B: публичный URL через туннель

Используйте этот вариант, если `SSH` недоступен или неудобен.

### Cloudflare Tunnel

На сервере:

```bash
cloudflared tunnel --url http://127.0.0.1:8000
```

Вы получите URL вида:

```text
https://random-words.trycloudflare.com
```

### Ngrok

На сервере:

```bash
ngrok http 8000
```

Вы получите URL вида:

```text
https://a1b2c3d4.ngrok-free.app
```

### Настройка frontend

На вашем ПК в `frontend/.env`:

```env
VITE_API_BASE_URL=https://random-words.trycloudflare.com
```

Потом:

```bash
cd path/to/working-title-psd2/frontend
npm run dev
```

### Настройка backend

На сервере в `backend/.env`:

```env
CORS_ALLOW_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
CORS_ALLOW_ORIGIN_REGEX=^https?://(localhost|127\.0\.0\.1)(:\d+)?$
```

Затем перезапустите backend.

Без этих переменных браузер будет блокировать:

- `POST /generate`
- `GET /models`
- `POST /prompt/transform`
- загрузку картинок из `/outputs/...`

---

## Почему раньше ломалось

Проблема была из двух частей:

1. Backend не отдавал CORS-заголовки, когда фронтенд на `http://localhost:5173` ходил на `https://...trycloudflare.com`.
2. После первой генерации Fabric загружал картинку с другого origin, и canvas становился `tainted`, из-за чего второй `GENERATE` падал на чтении пикселей.

Сейчас код учитывает оба случая:

- backend умеет CORS для `localhost`
- frontend загружает результат генерации CORS-safe способом

---

## Краткая схема

`SSH`-туннель:

- `backend/.env`: без обязательного CORS
- `frontend/.env`: `VITE_API_BASE_URL=http://localhost:8000`

Публичный URL:

- `backend/.env`: добавить `CORS_ALLOW_ORIGINS` и `CORS_ALLOW_ORIGIN_REGEX`
- `frontend/.env`: `VITE_API_BASE_URL=https://...`
