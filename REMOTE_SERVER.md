# Запуск API на удаленном сервере

Этот гайд описывает рабочий сценарий:

1. На локальной машине создается `ssh`-ключ.
2. Репозиторий клонируется на удаленный сервер по `git@github.com:...`.
3. Backend запускается на сервере только на `127.0.0.1:8000`.
4. Доступ к API дается либо через `SSH`-туннель, либо через `cloudflared`.

Если нужен просто безопасный доступ с твоего компьютера, лучший вариант: `SSH`-туннель.
Если нужен внешний `https://` URL, используй `cloudflared`.

## 1. Что должно быть установлено

На локальной машине:

- `git`
- `ssh`
- `nodejs` и `npm` для фронтенда

На сервере:

- `git`
- `python3`
- `python3-venv`
- `pip`
- `cloudflared` если нужен публичный URL

Пример для Ubuntu:

```bash
sudo apt update
sudo apt install -y git python3 python3-venv python3-pip
```

## 2. Создание SSH-ключа на локальной машине

Если ключа еще нет:

```bash
ssh-keygen -t ed25519 -C "your_email@example.com"
```

По умолчанию ключи будут созданы здесь:

- приватный ключ: `~/.ssh/id_ed25519`
- публичный ключ: `~/.ssh/id_ed25519.pub`

Покажи публичный ключ:

```bash
cat ~/.ssh/id_ed25519.pub
```

## 3. Добавление ключа в GitHub

В GitHub:

1. Открой `Settings`
2. Перейди в `SSH and GPG keys`
3. Нажми `New SSH key`
4. Вставь содержимое `~/.ssh/id_ed25519.pub`

Проверь доступ:

```bash
ssh -T git@github.com
```

Ожидаемое поведение: GitHub пишет, что успешно аутентифицировал тебя по SSH.

## 4. Подключение к серверу

Обычный сервер:

```bash
ssh user@SERVER_IP
```

Если нестандартный порт:

```bash
ssh -p 2222 user@SERVER_IP
```

Если это `Vast.ai`:

```bash
ssh -p PORT root@SERVER_IP
```

## 5. Клонирование репозитория на сервер

На сервере:

```bash
git clone git@github.com:Akinara666/working-title-psd2.git
cd working-title-psd2
```

Если репозиторий уже есть:

```bash
cd working-title-psd2
git pull
```

## 6. Настройка backend на сервере

Перейди в backend:

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
cp .env.example .env
```

## 7. Настройка `backend/.env`

Минимальный пример для GPU-сервера:

```env
USE_CUDA=true
DEFAULT_MODEL_ID=runwayml/stable-diffusion-v1-5
SD_ENABLE_CPU_OFFLOAD=true

PROMPT_TRANSFORM_ENABLED=false

CORS_ALLOW_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
CORS_ALLOW_ORIGIN_REGEX=^https?://(localhost|127\.0\.0\.1)(:\d+)?$
```

Если хочешь использовать CivitAI managed download:

```env
CIVITAI_API_TOKEN=your_civitai_token
```

Если используешь prompt transformer с `GGUF`:

```env
PROMPT_TRANSFORM_ENABLED=true
PROMPT_TRANSFORM_PROVIDER=qwen_gguf
LLM_MODEL_PATH=/abs/path/to/model.gguf
LLM_LORA_PATH=/abs/path/to/adapter.gguf
LLM_GPU_LAYERS=0
```

### Скачивание Qwen GGUF на сервер

Если хочешь использовать встроенный prompt transformer на `Qwen`, скачай модель в `backend/models/llm/`.

Из корня проекта на сервере:

```bash
mkdir -p backend/models/llm
cd backend/models/llm
wget -O model.gguf "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q8_0.gguf?download=true"
```

После этого в `backend/.env` можно использовать простой путь:

```env
PROMPT_TRANSFORM_ENABLED=true
PROMPT_TRANSFORM_PROVIDER=qwen_gguf
LLM_MODEL_PATH=./models/llm/model.gguf
LLM_LORA_PATH=./models/llm/adapter.gguf
```

Если `adapter.gguf` не нужен, укажи пустое значение:

```env
LLM_LORA_PATH=
```

Важно:

- backend должен слушать `127.0.0.1`, а не `0.0.0.0`
- это уменьшает лишнюю внешнюю экспозицию

## 8. Ручной запуск backend

Из каталога `backend`:

```bash
source venv/bin/activate
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Проверка на сервере:

```bash
curl http://127.0.0.1:8000/health
```

Ожидаемый ответ:

```json
{"status":"ok"}
```

## 9. Как не терять процесс после закрытия SSH

Самый простой вариант: `tmux`

Установка:

```bash
sudo apt install -y tmux
```

Запуск:

```bash
tmux new -s psd2
cd ~/working-title-psd2/backend
source venv/bin/activate
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Отключиться от сессии:

```bash
Ctrl+b
d
```

Вернуться:

```bash
tmux attach -t psd2
```

## 10. Вариант A: доступ через SSH-туннель

Это предпочтительный способ.

На локальной машине открой туннель:

```bash
ssh -N -L 8000:127.0.0.1:8000 user@SERVER_IP
```

Если сервер на нестандартном порту:

```bash
ssh -N -L 8000:127.0.0.1:8000 -p 2222 user@SERVER_IP
```

После этого локальный адрес:

```text
http://127.0.0.1:8000
```

будет проброшен на backend удаленного сервера.

### Настройка frontend для SSH-туннеля

На локальной машине в `frontend/.env`:

```env
VITE_API_BASE_URL=http://127.0.0.1:8000
```

Запуск фронтенда:

```bash
cd frontend
npm install
npm run dev
```

Открой:

```text
http://localhost:5173
```

В этом сценарии браузер фактически общается с `localhost`, поэтому это самый чистый режим.

## 11. Вариант B: публичный URL через cloudflared

Используй этот режим, если frontend не может работать через `SSH`-туннель или нужен внешний `https://` URL.

На сервере:

```bash
cloudflared tunnel --url http://127.0.0.1:8000
```

Ты получишь URL вида:

```text
https://random-name.trycloudflare.com
```

### Настройка frontend для cloudflared

На локальной машине в `frontend/.env`:

```env
VITE_API_BASE_URL=https://random-name.trycloudflare.com
```

Потом:

```bash
cd frontend
npm install
npm run dev
```

### Почему здесь нужен CORS

Потому что frontend работает на:

```text
http://localhost:5173
```

а backend отвечает с другого origin:

```text
https://random-name.trycloudflare.com
```

Поэтому `backend/.env` должен содержать:

```env
CORS_ALLOW_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
CORS_ALLOW_ORIGIN_REGEX=^https?://(localhost|127\.0\.0\.1)(:\d+)?$
```

После правки `.env` backend нужно перезапустить.

## 12. Полный короткий сценарий

### Локальная машина

```bash
ssh-keygen -t ed25519 -C "your_email@example.com"
cat ~/.ssh/id_ed25519.pub
```

Добавляешь ключ в GitHub.

### Сервер

```bash
git clone git@github.com:Akinara666/working-title-psd2.git
cd working-title-psd2/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

### Если нужен публичный URL

```bash
cloudflared tunnel --url http://127.0.0.1:8000
```

## 13. Проверка, что все реально работает

На сервере:

```bash
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/models
```

На локальной машине при SSH-туннеле:

```bash
curl http://127.0.0.1:8000/health
```

Если используется `cloudflared`:

```bash
curl https://random-name.trycloudflare.com/health
```

## 14. Частые проблемы

### `ModuleNotFoundError`

Обычно значит, что ты не активировал `venv`.

Решение:

```bash
cd ~/working-title-psd2/backend
source venv/bin/activate
```

### `Address already in use`

Порт `8000` уже занят.

Проверь:

```bash
ss -ltnp | grep 8000
```

### Браузер пишет CORS error

Значит frontend идет на публичный URL, а backend не отдает нужные CORS-заголовки.

Проверь `backend/.env`:

```env
CORS_ALLOW_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
CORS_ALLOW_ORIGIN_REGEX=^https?://(localhost|127\.0\.0\.1)(:\d+)?$
```

### `GET /outputs/... 404 Not Found`

Это значит, что файла уже нет в `backend/static/outputs`, а frontend еще пытается его показать из истории.

### API работает, но генерация очень медленная

Смотри:

- `USE_CUDA=true`
- `SD_ENABLE_CPU_OFFLOAD=true/false`
- хватает ли VRAM
- не включен ли слишком частый `LIVE_PREVIEW`

## 15. Что я рекомендую

Для обычной удаленной разработки:

1. Поднять backend на сервере на `127.0.0.1:8000`
2. Запускать его в `tmux`
3. Использовать `SSH`-туннель
4. Держать frontend локально на своей машине

`cloudflared` нужен только если тебе реально нужен внешний публичный URL.
