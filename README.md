<div align="center">

# F2 — Локальный AI-редактор изображений

**Бесконечный холст · генеративное заполнение · полностью локальный SD/SDXL-пайплайн**

Редактор изображений с бесконечным холстом и генеративным заполнением. Объединяет
txt2img, img2img, inpainting и outpainting в едином инструменте и работает целиком
на вашем оборудовании.

![Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.104+-009688?logo=fastapi&logoColor=white)
![PyTorch](https://img.shields.io/badge/PyTorch-2.x-EE4C2C?logo=pytorch&logoColor=white)
![Diffusers](https://img.shields.io/badge/Diffusers-SD%20%2F%20SDXL-FFD21E)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-5-646CFF?logo=vite&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)

![Интерфейс](./assets/UI.png)

</div>

## Содержание

- [Возможности](#возможности)
- [Технический стек](#технический-стек)
- [Быстрый старт](#быстрый-старт)
- [Конфигурация](#конфигурация)
- [Использование](#использование)
- [API](#api)
- [Структура проекта](#структура-проекта)
- [Тесты](#тесты)

## Возможности

### Генерация и редактирование
- **Бесконечный холст** — генерация и расширение изображения в произвольном направлении.
- **Txt2Img / Img2Img** — генерация по текстовому описанию или на основе исходного изображения.
- **Outpainting** — достраивание изображения за пределами исходных границ при размещении рамки на прозрачной области или у края.
- **Inpainting** — локальное изменение области по маске; немаскированные пиксели сохраняются без потерь, края смешиваются методом feather-blend.
- **Явный режим генерации** (вся картинка / inpaint) с пресетами-намерениями и живым предпросмотром границы зоны генерации прямо на холсте.
- **Sketch-to-Image** — преобразование наброска, выполненного кистью, в готовое изображение.
- Поддержка **SD и SDXL**; режимы text2img / img2img / inpainting (ControlNet — на стороне backend).

### Контроль качества
- **11 семплеров**: Euler a, Euler, DPM++ 2M / 2S a / SDE Karras, DPM2 a Karras, DDIM, DDPM, Heun, UniPC, LMS.
- **Веса промптов в синтаксисе AUTOMATIC1111** (`(word:1.2)`, `[word]`) через Compel, управление CLIP skip и seed.
- **NSFW-защита** — классификатор проверяет каждую готовую картинку и блокирует NSFW (включена по умолчанию, `NSFW_FILTER_ENABLED=false` — отключить).
- **Предпросмотр в реальном времени** — декодирование промежуточных латентов во время генерации (быстрые методы `approx_nn` и `TAESD`).

### Рабочий процесс
- **Staging и сведение слоёв** — результат отображается как кандидат (зелёная рамка) и сводится на холст по команде **ACCEPT**, что сохраняет однослойную модель холста и его производительность.
- **Менеджер моделей** — загрузка чекпойнтов из **HuggingFace** и **Civit.ai** непосредственно из интерфейса.
- **История генераций** — панель с предыдущими результатами.
- **Prompt Transformer** — опциональная локальная LLM (Qwen GGUF + LoRA), адаптирующая исходный запрос под формат Stable Diffusion перед генерацией.
- **Панель настроек сервера** — правка `backend/.env` (модель, NSFW, движок, LLM, токены) прямо из интерфейса; защищена паролем `SETTINGS_ADMIN_TOKEN`.
- **Один URL = сайт** — backend может отдавать собранный фронт на том же адресе, что и API (`SERVE_FRONTEND`; на vast включено по умолчанию, выключить — `run-vast.sh --no-frontend`), без отдельного запуска фронта и без CORS.

## Технический стек

- **Frontend:** React 18, Fabric.js (логика холста), Vite.
- **Backend:** Python 3.11, FastAPI, Diffusers, PyTorch.
- **Оптимизация загрузки и инференса** (см. [`backend/core/manager.py`](backend/core/manager.py)):
  - LRU-кэш составных моделей (bundle), разделяемых между режимами text2img / img2img / inpainting через `from_pipe`;
  - выгрузка на CPU (offload), VAE slicing/tiling, восстановление после нехватки видеопамяти (CUDA OOM);
  - bf16 на архитектурах Ampere и новее (автоопределение), TF32 для операций в fp32, механизм внимания через torch SDPA (xformers — опционально);
  - офлайн-режим с приоритетной загрузкой локально кэшированных моделей.
- **Развёртывание:** Docker Compose, Cloudflare Tunnel, прямой запуск для Vast.ai / RunPod.

## Быстрый старт

> Подробные пошаговые инструкции по **всем** вариантам запуска приведены в каталоге **[`docs/`](docs/README.md)**.
> Ниже — минимальный набор команд.

### Локально (разработка)

```bash
# Backend
cd backend
python3 -m venv venv && source venv/bin/activate     # Windows: venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn main:app --reload --port 8000

# Frontend (в отдельном терминале)
cd frontend
echo "VITE_API_BASE_URL=http://localhost:8000" > .env.local
npm install && npm run dev                           # http://localhost:5173
```

При отсутствии GPU установите `USE_CUDA=false` (исполнение на CPU медленнее).
Подробнее — [docs/01-local.md](docs/01-local.md).

### На GPU-сервере одной командой

```bash
git clone https://github.com/Akinara666/F2-AI-Image-Editor.git
cd F2-AI-Image-Editor
bash deploy/bootstrap.sh          # автоопределение GPU/CPU, сборка, Cloudflare Tunnel
```

По завершении выводится публичный адрес `https://<random>.trycloudflare.com` —
единый URL для интерфейса и API. Требуется полноценный Docker-демон с доступом к GPU.
Подробнее — [docs/02-docker-server.md](docs/02-docker-server.md).

### На Vast.ai или готовом CUDA-контейнере (без Docker)

```bash
# по умолчанию: один URL = готовый сайт (backend сам собирает и отдаёт фронт):
bash deploy/run-vast.sh           # печатает https://<random>.trycloudflare.com

# либо только API (фронт запускают на клиентском компьютере):
bash deploy/run-vast.sh --no-frontend
bash deploy/run-client.sh https://<random>.trycloudflare.com
```

Запускай под `tmux`, иначе обрыв SSH остановит сервер. Туннель переживает
перезапуск backend — URL не меняется при повторном `run-vast.sh` (остановить —
`--stop`). На GPU-инстансе Qwen сразу получает `LLM_GPU_LAYERS=99`. Подробности и
три способа подключения — [docs/03-vast-ai.md](docs/03-vast-ai.md).

## Конфигурация

Переменные окружения считываются из окружения или из файла `backend/.env`.
Канонический шаблон — [`deploy/backend.env.example`](deploy/backend.env.example);
полный справочник приведён в [docs/01-local.md, раздел «Переменные окружения»](docs/01-local.md#переменные-окружения).

Основные параметры:

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `USE_CUDA` | `true` | GPU (CUDA-torch) или CPU |
| `DEFAULT_MODEL_ID` | `runwayml/stable-diffusion-v1-5` | модель по умолчанию |
| `SD_ENABLE_CPU_OFFLOAD` | `true` | выгрузка модулей в RAM для экономии видеопамяти |
| `SD_TORCH_DTYPE` | `auto` | `auto` — bf16 на Ampere и новее, иначе fp16 |
| `NSFW_FILTER_ENABLED` | `true` | блокирующий NSFW-классификатор (`false` — отключить) |
| `CIVITAI_API_TOKEN` / `HF_TOKEN` | — | токены для загрузки моделей |
| `PROMPT_TRANSFORM_ENABLED` | `false` | включение LLM-трансформера промпта |
| `SERVE_FRONTEND` | `false` | backend отдаёт фронт на том же origin (один URL) |
| `SETTINGS_ADMIN_TOKEN` | — | пароль для правки настроек из панели в UI (пусто = только просмотр) |

## Использование

1. **Навигация.** Удерживая `Пробел`, перемещайте холст мышью; масштабирование — колесом.
2. **Генерация.** Переместите рамку в нужную область, при необходимости нарисуйте набросок или маску, введите промпт и нажмите **GENERATE**.
3. **Результат.** Повторный **GENERATE** заменяет вариант, **ACCEPT** сводит изображение на холст, **DISCARD** удаляет.
4. **Модели.** В меню «Модели» загрузите чекпойнт из HuggingFace или Civit.ai по ссылке либо идентификатору.

**Горячие клавиши:** `Space` — перемещение, `Ctrl+Z` — отмена, `Delete` — удаление объекта, `[` / `]` — размер кисти.

## API

FastAPI публикует интерактивную схему по адресу `/docs` (спецификация OpenAPI — `/openapi.json`). Основные эндпоинты:

| Метод | Путь | Назначение |
|---|---|---|
| `POST` | `/generate` | генерация (txt2img / img2img / inpaint); поля `raw_prompt`, `use_prompt_transform` |
| `POST` | `/cancel` | отмена активной генерации |
| `GET` | `/generate/preview/{request_id}` | предпросмотр прогресса генерации |
| `GET` / `POST` | `/models`, `/models/download` | список и загрузка моделей |
| `POST` | `/prompt/transform` | предпросмотр трансформации промпта без запуска SD |
| `GET` | `/health`, `/prompt/health` | состояние сервиса и prompt-трансформера |

## Структура проекта

```text
.
├── backend/
│   ├── core/
│   │   ├── manager.py                     # менеджер моделей и видеопамяти (LRU-кэш, offload, восстановление после OOM)
│   │   ├── llm_adapter.py                 # адаптер локальной LLM (Qwen GGUF + LoRA)
│   │   ├── prompt_transformer.py          # трансформация промпта в формат Stable Diffusion
│   │   ├── negative_prompt_transformer.py # трансформация негативного промпта
│   │   ├── preview_decoder.py             # предпросмотр латентов (approx_nn / TAESD)
│   │   ├── generation_preview.py          # хранилище прогресса генерации
│   │   ├── model_downloads.py             # загрузка моделей из HuggingFace / Civit.ai
│   │   ├── config.py                      # конфигурация и переменные окружения
│   │   └── utils.py                       # обработка изображений
│   ├── tests/                             # модульные, функциональные и интеграционные тесты
│   └── main.py                            # эндпоинты FastAPI
├── frontend/
│   └── src/
│       ├── components/
│       │   ├── Editor.jsx                 # холст (Fabric.js) и состояние
│       │   ├── Sidebar.jsx                # параметры генерации
│       │   ├── ModelManager.jsx           # загрузка моделей из интерфейса
│       │   └── HistoryPanel.jsx           # история генераций
│       ├── utils/                         # логика холста (экспорт / сведение / отмена)
│       └── constants.js                   # адрес API и эндпоинты
├── deploy/                                # bootstrap.sh, run-vast.sh, compose-файлы
└── docs/                                  # пошаговые инструкции по запуску
```

## Тесты

```bash
# Backend (без torch/diffusers — лёгкие зависимости из requirements-ci.txt)
PYTHONPATH=backend python -m unittest discover -s backend/tests -v

# Frontend
cd frontend && npm test
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) выполняет backend-,
prompt-, API- и frontend-тесты, а также docker-smoke на каждый push и pull request.
</content>
