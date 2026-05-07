# QA Report — Local AI Gen Service (backend)

**Дата:** 2026-05-07  
**Ревизия:** ветка `dev` (fc08008)  
**Инженер:** Claude Code (QA-сессия)  
**Инструментарий:** pytest 9.0.3, FastAPI TestClient, PIL/NumPy

---

## 1. Scope — что тестировалось

| Модуль | Файл |
|---|---|
| HTTP API | `backend/main.py` |
| Model Manager | `backend/core/manager.py` |
| Config | `backend/core/config.py` |
| Image Utils | `backend/core/utils.py` |
| Prompt Transformer | `backend/core/prompt_transformer.py` |
| Negative Prompt Transformer | `backend/core/negative_prompt_transformer.py` |
| LLM Adapter | `backend/core/llm_adapter.py` |
| Generation Preview Store | `backend/core/generation_preview.py` |
| Preview Decoder | `backend/core/preview_decoder.py` |

---

## 2. Методология — 4 метода тестирования

### Метод 1 — Функциональное тестирование (чёрный ящик)

Тестировались HTTP-эндпоинты через `FastAPI TestClient` без знания внутренней реализации.

**Покрытые эндпоинты:**

| Эндпоинт | Кол-во тест-кейсов | Статус |
|---|---|---|
| `GET /health` | 1 | ✅ Pass |
| `GET /` | 1 | ✅ Pass |
| `GET /models` | 1 | ✅ Pass |
| `GET /prompt/health` | 1 | ✅ Pass |
| `POST /cancel` | 3 | ✅ Pass |
| `POST /history/delete` | 5 | ✅ Pass |
| `POST /history/save` | 5 | ✅ Pass (после исправления BUG-01) |
| `POST /upscale` | 4 | ✅ Pass (после исправления BUG-02) |
| `POST /prompt/transform` | 3 | ✅ Pass (после исправления BUG-03) |
| `GET /generate/preview/{id}` | 1 | ✅ Pass |

**Файл:** `tests/test_qa_functional.py`

---

### Метод 2 — Модульное тестирование (белый ящик)

Тестировались чистые функции напрямую, без HTTP-слоя.

**Покрытые функции:**

| Функция | Кол-во тест-кейсов | Статус |
|---|---|---|
| `save_image_with_metadata` | 7 | ✅ Pass (после исправления BUG-01) |
| `process_mask_for_inpainting` | 7 | ✅ Pass |
| `feather_blend` | 5 | ✅ Pass |
| `merge_generation_masks` | 4 | ✅ Pass |
| `prepare_image_for_outpainting` | 4 | ✅ Pass |

**Файл:** `tests/test_qa_unit.py`

---

### Метод 3 — Негативное тестирование

Граничные значения, некорректные входные данные, попытки path-traversal.

**Тест-группы:**

| Группа | Кол-во тест-кейсов | Статус |
|---|---|---|
| `/tools/spot-heal` — граничные значения | 5 | ✅ Pass |
| `/tools/clone-stamp` — граничные значения | 3 | ✅ Pass |
| `/tools/quick-select/refine` — граничные значения | 5 | ✅ Pass |
| `/upscale` — некорректный файл | 1 | ✅ Pass |
| `/history/delete` — безопасность путей | 2 | ✅ Pass |
| `/cancel` — некорректный request_id | 1 | ✅ Pass |
| `_merge_negative_prompt_terms` — чистые функции | 6 | ✅ Pass |
| `_normalize_active_tool` — чистые функции | 6 | ✅ Pass |

**Файл:** `tests/test_qa_negative.py`

---

### Метод 4 — Интеграционное тестирование

Тестировалось взаимодействие компонентов через их публичный API.

**Тест-группы:**

| Группа | Кол-во тест-кейсов | Статус |
|---|---|---|
| `GenerationPreviewStore` — полный жизненный цикл | 8 | ✅ Pass |
| `PromptTransformer` + `NegativePromptTransformer` — связка | 5 | ✅ Pass |
| `GenerationPreviewStore` + `PromptTransformer` — симуляция генерации | 1 | ✅ Pass |

**Файл:** `tests/test_qa_integration.py`

---

## 3. Итоги запуска тестов

### До исправлений

```
28 passed (pre-existing)  |  7 failed (new QA tests)
```

### После исправлений

```
123 passed  |  0 failed  |  4 warnings (deprecation, не относятся к коду)
```

| Файл тестов | Тестов | Результат |
|---|---|---|
| `test_negative_prompt_transformer.py` | 10 | ✅ 10/10 |
| `test_prompt_transformer.py` | 9 | ✅ 9/9 |
| `test_tool_endpoints.py` | 9 | ✅ 9/9 |
| `test_qa_functional.py` | 25 | ✅ 25/25 |
| `test_qa_unit.py` | 27 | ✅ 27/27 |
| `test_qa_negative.py` | 29 | ✅ 29/29 |
| `test_qa_integration.py` | 14 | ✅ 14/14 |

---

## 4. Найденные дефекты

### BUG-01 — [P1 Critical] `TypeError` при сохранении истории без промпта

| Поле | Значение |
|---|---|
| **ID** | BUG-01 |
| **Приоритет** | P1 — Critical |
| **Файл** | `backend/core/utils.py:24` |
| **Затронутый эндпоинт** | `POST /history/save` |
| **Статус** | ✅ Исправлен |

**Описание:**  
Функция `save_image_with_metadata` падает с `TypeError: 'NoneType' object is not subscriptable`, когда поле `prompt` в `params` явно равно `None` (а не отсутствует).

**Корневая причина:**  
```python
# БЫЛО:
prompt_slug = params.get("prompt", "gen")[:20]
# params.get("prompt", "gen") возвращает None (ключ есть, значение — None)
# None[:20] → TypeError
```

**Воспроизведение:**  
```bash
curl -X POST /history/save -F "image=@snap.png"
# => HTTP 500, TypeError
```

**Исправление (`core/utils.py`):**  
```python
# СТАЛО:
prompt_slug = (params.get("prompt") or "gen")[:20]
```

---

### BUG-02 — [P2 High] `/upscale` не валидирует `scale_factor`

| Поле | Значение |
|---|---|
| **ID** | BUG-02 |
| **Приоритет** | P2 — High |
| **Файл** | `backend/main.py`, эндпоинт `upscale_image` |
| **Затронутый эндпоинт** | `POST /upscale` |
| **Статус** | ✅ Исправлен |

**Описание:**  
Эндпоинт `/upscale` принимает любое значение `scale_factor` без ограничений:
- `0` → `PIL.Image.resize` бросает `ValueError`, возвращается 500
- отрицательные → то же
- `NaN`/`Infinity` → `int()` бросает `ValueError`, возвращается 500
- очень большие (например, 500) → создаёт изображение 32000×32000, OOM-риск

**Воспроизведение:**  
```bash
curl -X POST /upscale -F "scale_factor=0" -F "image=@img.png"
# => HTTP 500 вместо HTTP 422
```

**Исправление (`main.py`):**  
Добавлена явная валидация перед обработкой:
```python
MIN_SCALE_FACTOR = 0.1
MAX_SCALE_FACTOR = 16.0

if not math.isfinite(scale_factor) or scale_factor < MIN_SCALE_FACTOR or scale_factor > MAX_SCALE_FACTOR:
    raise HTTPException(status_code=422, detail=f"scale_factor must be between ...")
```

---

### BUG-03 — [P3 Medium] `/prompt/transform` возвращает 422 для пустого промпта в strict-режиме

| Поле | Значение |
|---|---|
| **ID** | BUG-03 |
| **Приоритет** | P3 — Medium |
| **Файл** | `backend/main.py:767` |
| **Затронутый эндпоинт** | `POST /prompt/transform` |
| **Статус** | ✅ Исправлен |

**Описание:**  
При `PROMPT_TRANSFORM_STRICT=true` и `PROMPT_TRANSFORM_ENABLED=true` (текущий `.env`), отправка пустого промпта `{"prompt": ""}` в preview-эндпоинт возвращает HTTP 422 вместо 200 с `transform_status: "skipped_empty"`. Трансформер корректно помечает пустой промпт как `skipped_empty`, но strict-проверка не делает исключение для этого статуса.

**Воспроизведение:**
```bash
curl -X POST /prompt/transform -H "Content-Type: application/json" \
  -d '{"prompt": ""}'
# => HTTP 422 (ожидается HTTP 200)
```

**Исправление (`main.py`):**
```python
# БЫЛО:
if transform_required and settings.PROMPT_TRANSFORM_STRICT and result.transform_status != "success":

# СТАЛО:
if transform_required and settings.PROMPT_TRANSFORM_STRICT and \
        result.transform_status not in {"success", "skipped_empty", "disabled"}:
```

---

## 5. Наблюдения (не дефекты, рекомендации)

| ID | Файл | Описание |
|---|---|---|
| OBS-01 | `backend/core/preview_decoder.py:161` | `_get_taesd_model` — `TAESD_MODEL_IDS[model_family]` бросит `KeyError` при неизвестном model_family. Рекомендуется использовать `.get()` с fallback. |
| OBS-02 | `backend/main.py:185-198` | `_build_quick_select_mask` — проверка `if right <= left or bottom <= top:` недостижима (после `max(left+1, ...)`). Мёртвый код, можно удалить. |
| OBS-03 | `backend/core/preview_decoder.py:122` | Переменная `latent_channels` в `_infer_latent_channels` содержит объект `.config`, а не число — вводит в заблуждение при чтении. |

---

## 6. Метрики качества

| Метрика | Значение |
|---|---|
| Всего тест-кейсов написано/запущено | 123 |
| Тест-кейсов до QA-сессии | 28 |
| Новых тест-кейсов добавлено | 95 |
| Найдено дефектов | 3 (1×P1, 1×P2, 1×P3) |
| Исправлено дефектов | 3/3 |
| Итоговый результат | 123/123 PASSED |
| Регрессий в pre-existing тестах | 0 |

---

## 7. Изменённые файлы

| Файл | Что изменено |
|---|---|
| `backend/core/utils.py` | Исправление BUG-01: `None`-safe извлечение prompt-slug |
| `backend/main.py` | Исправление BUG-02: валидация `scale_factor`; BUG-03: исключение `skipped_empty` из strict-mode |
| `backend/tests/test_qa_functional.py` | Новый файл — 25 функциональных тестов (чёрный ящик) |
| `backend/tests/test_qa_unit.py` | Новый файл — 27 модульных тестов (белый ящик) |
| `backend/tests/test_qa_negative.py` | Новый файл — 29 негативных тестов |
| `backend/tests/test_qa_integration.py` | Новый файл — 14 интеграционных тестов |
