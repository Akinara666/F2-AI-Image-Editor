# 01 — Локальный запуск (на своей машине)

Для разработки и правок кода. Здесь два под-варианта:

- **A. Bare (uvicorn напрямую)** — для реальной генерации и отладки кода.
- **B. Docker smoke-стек** — лёгкая проверка API/UI **без** AI-runtime (генерации нет).

---

## A. Bare: uvicorn напрямую

### Требования
- Python 3.11+
- Для GPU — NVIDIA-драйвер (CUDA-колёса torch self-contained, toolkit не нужен).
  Без GPU всё заведётся на CPU, но генерация будет медленной.
- Node.js + npm (для фронтенда).

### 1. Backend
```bash
cd backend
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate

pip install -r requirements.txt   # ставит torch + diffusers + ... (несколько ГБ)
# GPU: если нужен именно CUDA-torch, поставь его до requirements:
#   pip install torch --index-url https://download.pytorch.org/whl/cu121

python -m uvicorn main:app --reload --port 8000
```
Backend поднимется на `http://localhost:8000` (`--reload` — авто-перезапуск при правках).
Проверка: `curl http://localhost:8000/health`.

> Опциональные зависимости (`xformers`, `llama-cpp-python`) — в
> `backend/requirements-optional.txt`, ставь только если нужны.

### 2. Frontend (Vite dev на :5173)
Vite на `5173`, backend на `8000` — это **разные origin**, поэтому укажи адрес API:
```bash
cd frontend
echo "VITE_API_BASE_URL=http://localhost:8000" > .env.local
npm install
npm run dev                       # http://localhost:5173
```
CORS для `localhost` backend разрешает по умолчанию — настраивать ничего не нужно.

### Конфигурация
Переменные читаются из окружения (или из `backend/.env`, см. ниже).
По умолчанию `USE_CUDA=true` → если GPU нет, выстави `USE_CUDA=false`:
```bash
export USE_CUDA=false
```

---

## B. Docker smoke-стек (без AI-runtime)

Корневой [`compose.yaml`](../compose.yaml) собирает backend с
`INSTALL_AI_RUNTIME=false` — **без torch/diffusers**. Это для быстрой проверки
API/плумбинга и CI, **реальная генерация тут не работает**.

```bash
docker compose up --build
# frontend (nginx, same-origin proxy): http://localhost:3000
# backend:                              http://localhost:8000
docker compose down
```

> `make cpu` (он же `bootstrap.sh --cpu`) поднимает этот же стек — то есть тоже
> **без генерации**. Для реальной генерации используй bare-вариант A выше,
> GPU-стек ([гайд 02](02-docker-server.md)) или vast.ai ([гайд 03](03-vast-ai.md)).

---

## Переменные окружения

Канонический шаблон — [`deploy/backend.env.example`](../deploy/backend.env.example).
При bare-запуске можно положить файл `backend/.env` (его читает `python-dotenv`).

### Базовый runtime
| Переменная | По умолч. | Назначение |
|---|---|---|
| `USE_CUDA` | `true` | `true` — GPU (CUDA-torch), `false` — CPU |
| `DEFAULT_MODEL_ID` | `runwayml/stable-diffusion-v1-5` | модель по умолчанию |
| `SD_ENABLE_CPU_OFFLOAD` | `true` | выгрузка модулей в RAM между шагами (экономит VRAM, медленнее) |
| `NSFW_FILTER_ENABLED` | `true` | NSFW-фильтр |
| `CLIP_SKIP` | `1` | clip skip |

### Производительность (см. `backend/core/manager.py`)
| Переменная | По умолч. | Назначение |
|---|---|---|
| `SD_TORCH_DTYPE` | `auto` | `auto` → bf16 на Ampere+ (меньше чёрных/NaN от VAE), иначе fp16; можно `fp16`/`bf16`/`fp32` |
| `SD_ENABLE_XFORMERS` | `false` | xformers опционально; по умолчанию torch SDPA |
| `SD_ALLOW_TF32` | `true` | TF32 для fp32-операций на Ampere+ (быстрее, без потери качества) |
| `SD_WARMUP` | `false` | прогрев модели после загрузки (первая генерация быстрее) |

### Скачивание моделей
| Переменная | Назначение |
|---|---|
| `CIVITAI_API_TOKEN` | токен Civit.ai (для части чекпоинтов) |
| `HF_TOKEN` | токен HuggingFace (приватные/gated репо) |

### CORS
| Переменная | По умолч. | Назначение |
|---|---|---|
| `CORS_ALLOW_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | разрешённые origin'ы (список) |
| `CORS_ALLOW_ORIGIN_REGEX` | `^https?://(localhost\|127\.0\.0\.1)(:\d+)?$` | разрешает любой localhost-порт |

### Prompt-трансформер / LLM (опционально)
`PROMPT_TRANSFORM_ENABLED`, `PROMPT_TRANSFORM_PROVIDER` (`stub`/`qwen_gguf`),
`LLM_MODEL_PATH`, `LLM_GPU_LAYERS`, … — полный список в
[`deploy/backend.env.example`](../deploy/backend.env.example) и `backend/core/config.py`.
