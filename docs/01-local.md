# 01 — Локальный запуск

Для разработки и внесения изменений в код. Доступны два под-варианта:

- **A. Bare (uvicorn напрямую)** — для реальной генерации и отладки кода.
- **B. Docker smoke-стек** — лёгкая проверка API и интерфейса без AI-runtime
  (генерация недоступна).

---

## A. Bare: uvicorn напрямую

### Требования
- Python 3.11 и новее.
- Для работы на GPU — NVIDIA-драйвер (CUDA-колёса torch self-contained, отдельный
  toolkit не требуется). Без GPU всё запустится на CPU, но генерация будет медленной.
- Node.js и npm (для фронтенда).

### 1. Backend
```bash
cd backend
python3 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate

pip install -r requirements.txt   # torch, diffusers и др. (несколько ГБ)
# GPU: при необходимости поставьте CUDA-torch до установки requirements:
#   pip install torch --index-url https://download.pytorch.org/whl/cu121

python -m uvicorn main:app --reload --port 8000
```
Backend будет доступен на `http://localhost:8000` (`--reload` — автоматический
перезапуск при изменениях). Проверка: `curl http://localhost:8000/health`.

Опциональные зависимости (`xformers`, `llama-cpp-python`) перечислены в
`backend/requirements-optional.txt` — устанавливайте только при необходимости.

### 2. Frontend (Vite dev на порту 5173)
Vite работает на `5173`, backend — на `8000`; это разные origin, поэтому укажите
адрес API:
```bash
cd frontend
echo "VITE_API_BASE_URL=http://localhost:8000" > .env.local
npm install
npm run dev                       # http://localhost:5173
```
CORS для `localhost` разрешён по умолчанию, дополнительная настройка не требуется.

### Конфигурация
Переменные считываются из окружения или из `backend/.env` (см. ниже). По умолчанию
`USE_CUDA=true`; при отсутствии GPU установите `USE_CUDA=false`:
```bash
export USE_CUDA=false
```

---

## B. Docker smoke-стек (без AI-runtime)

Корневой [`compose.yaml`](../compose.yaml) собирает backend с
`INSTALL_AI_RUNTIME=false`, то есть без torch и diffusers. Этот стек предназначен
для быстрой проверки API и интерфейса, а также для CI; реальная генерация в нём
недоступна.

```bash
docker compose up --build
# frontend (nginx, same-origin proxy): http://localhost:3000
# backend:                              http://localhost:8000
docker compose down
```

Команда `make cpu` (то же, что `bootstrap.sh --cpu`) поднимает этот же стек, то
есть тоже без генерации. Для реальной генерации используйте вариант A выше,
GPU-стек ([инструкция 02](02-docker-server.md)) или Vast.ai ([инструкция 03](03-vast-ai.md)).

---

## Переменные окружения

Канонический шаблон — [`deploy/backend.env.example`](../deploy/backend.env.example).
При bare-запуске можно разместить файл `backend/.env` (его читает `python-dotenv`).

### Базовый runtime
| Переменная | По умолчанию | Назначение |
|---|---|---|
| `USE_CUDA` | `true` | `true` — GPU (CUDA-torch), `false` — CPU |
| `DEFAULT_MODEL_ID` | `runwayml/stable-diffusion-v1-5` | модель по умолчанию |
| `SD_ENABLE_CPU_OFFLOAD` | `true` | выгрузка модулей в RAM между шагами (экономит видеопамять, медленнее) |
| `NSFW_FILTER_ENABLED` | `true` | NSFW-защита: негатив-промпт + классификатор, который проверяет каждую готовую картинку и блокирует NSFW. Модель safety-checker (~1.2 ГБ) грузится перед генерацией; при неудаче генерация возвращает ошибку (fail-closed). `false` — выключить (разрешить NSFW) |
| `CLIP_SKIP` | `1` | значение CLIP skip |

### Производительность (см. `backend/core/manager.py`)
| Переменная | По умолчанию | Назначение |
|---|---|---|
| `SD_TORCH_DTYPE` | `auto` | `auto` — bf16 на Ampere и новее (меньше артефактов VAE), иначе fp16; допустимо `fp16` / `bf16` / `fp32` |
| `SD_ENABLE_XFORMERS` | `false` | xformers опционально; по умолчанию используется torch SDPA |
| `SD_ALLOW_TF32` | `true` | TF32 для операций в fp32 на Ampere и новее (быстрее, без заметной потери качества) |
| `SD_WARMUP` | `false` | прогрев модели после загрузки (ускоряет первую генерацию) |
| `MAX_GENERATION_WAITERS` | `8` | сколько запросов на генерацию могут ждать в очереди (генерация идёт по одному); сверх лимита новые получают `429`. `0` — без лимита |

### Загрузка моделей
| Переменная | Назначение |
|---|---|
| `CIVITAI_API_TOKEN` | токен Civit.ai (для части чекпойнтов) |
| `HF_TOKEN` | токен HuggingFace (приватные / gated репозитории) |

### Сайт и панель настроек
| Переменная | По умолчанию | Назначение |
|---|---|---|
| `SERVE_FRONTEND` | `false` | `true` — backend отдаёт собранный фронт на том же origin (один URL = сайт). На vast `run-vast.sh` включает это по умолчанию (выключить — `--no-frontend`); в Docker не нужно (фронт отдаёт nginx) |
| `SETTINGS_ADMIN_TOKEN` | — | пароль для правки настроек из панели (шестерёнка в UI). Пусто → панель только просмотр. Живёт только на сервере; в `frontend/.env` класть нельзя |
| `ENV_FILE_PATH` | `backend/.env` | какой `.env` backend читает И в который пишет панель (один источник). На vast `run-vast.sh` указывает на постоянный `deploy/backend.vast.env` |

Панель настроек (шестерёнка) правит эти переменные из UI и пишет их в `.env`;
изменения применяются после перезапуска backend. Без `SETTINGS_ADMIN_TOKEN`
редактирование выключено (только просмотр).

### CORS
| Переменная | По умолчанию | Назначение |
|---|---|---|
| `CORS_ALLOW_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | список разрешённых origin |
| `CORS_ALLOW_ORIGIN_REGEX` | `^https?://(localhost\|127\.0\.0\.1)(:\d+)?$` | разрешает любой порт localhost |

### Prompt-трансформер и LLM (опционально)
`PROMPT_TRANSFORM_ENABLED`, `PROMPT_TRANSFORM_PROVIDER` (`stub` / `qwen_gguf`),
`LLM_MODEL_PATH`, `LLM_GPU_LAYERS` и др. — полный список в
[`deploy/backend.env.example`](../deploy/backend.env.example) и `backend/core/config.py`.

`LLM_GPU_LAYERS` управляет, сколько слоёв Qwen грузить на GPU: `0` — целиком на
CPU (медленно, ~20+ сек, ловит таймаут трансформации), `99` — всё на видеокарту
(быстро). На vast `run-vast.sh` сам ставит `99` при наличии CUDA.
