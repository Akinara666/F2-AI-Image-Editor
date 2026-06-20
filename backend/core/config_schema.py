"""Схема редактируемых из UI настроек backend/.env.

Единый источник правды: и для GET /config (метаданные + группировка для панели),
и для allowlist при записи (PATCH /config пишет ТОЛЬКО эти ключи, с валидацией
типов). Значения в .env — строки; приведение/валидация тоже здесь.
"""
from typing import Any

# Каждая запись: key, group, label, type (+ опц. options/min/max/help).
# type: bool | int | float | text | select | secret
SETTINGS_SCHEMA: list[dict[str, Any]] = [
    # --- Движок ---
    {"key": "SD_TORCH_DTYPE", "group": "Движок", "label": "Точность (dtype)",
     "type": "select", "options": ["auto", "fp16", "bf16", "fp32"]},
    {"key": "SD_ENABLE_CPU_OFFLOAD", "group": "Движок", "label": "CPU offload (экономия VRAM)", "type": "bool"},
    {"key": "SD_ENABLE_XFORMERS", "group": "Движок", "label": "xformers attention", "type": "bool"},
    {"key": "SD_ALLOW_TF32", "group": "Движок", "label": "TF32 на Ampere+", "type": "bool"},
    {"key": "SD_WARMUP", "group": "Движок", "label": "Прогрев после загрузки", "type": "bool"},
    {"key": "CLIP_SKIP", "group": "Движок", "label": "CLIP skip", "type": "int", "min": 1, "max": 12},
    {"key": "USE_CUDA", "group": "Движок", "label": "Использовать CUDA (GPU)", "type": "bool"},

    # --- Безопасность ---
    {"key": "NSFW_FILTER_ENABLED", "group": "Безопасность", "label": "NSFW-фильтр", "type": "bool",
     "help": "Блокирует NSFW-картинки. Выключение — на свой риск."},
    {"key": "NSFW_NEGATIVE_PROMPT", "group": "Безопасность", "label": "NSFW негатив-промпт", "type": "text"},

    # --- Улучшение промпта ---
    {"key": "PROMPT_TRANSFORM_ENABLED", "group": "Улучшение промпта", "label": "Включить улучшение промпта", "type": "bool"},
    {"key": "PROMPT_TRANSFORM_PROVIDER", "group": "Улучшение промпта", "label": "Провайдер",
     "type": "select", "options": ["stub", "qwen_gguf"]},
    {"key": "NEG_PROMPT_TRANSFORM_ENABLED", "group": "Улучшение промпта", "label": "Улучшать негатив-промпт", "type": "bool"},
    {"key": "LLM_MODEL_PATH", "group": "Улучшение промпта", "label": "Путь к GGUF-модели", "type": "text"},
    {"key": "LLM_MAX_NEW_TOKENS", "group": "Улучшение промпта", "label": "LLM max new tokens", "type": "int", "min": 16, "max": 2048},
    {"key": "LLM_TEMPERATURE", "group": "Улучшение промпта", "label": "LLM temperature", "type": "float", "min": 0.0, "max": 2.0},
    {"key": "LLM_GPU_LAYERS", "group": "Улучшение промпта", "label": "LLM слоёв на GPU", "type": "int", "min": 0, "max": 200},

    # --- Превью ---
    {"key": "LIVE_PREVIEW_METHOD", "group": "Превью", "label": "Метод live-preview",
     "type": "select", "options": ["full", "approx_nn", "approx_cheap", "taesd"]},
    {"key": "LIVE_PREVIEW_INTERVAL_STEPS", "group": "Превью", "label": "Интервал превью (шаги)", "type": "int", "min": 1, "max": 50},

    # --- Деплой ---
    {"key": "SERVE_FRONTEND", "group": "Деплой", "label": "Отдавать фронт backend-ом", "type": "bool"},

    # --- Токены (секреты: значение наружу не отдаётся, ставится маской) ---
    {"key": "HF_TOKEN", "group": "Токены", "label": "HuggingFace token", "type": "secret"},
    {"key": "CIVITAI_API_TOKEN", "group": "Токены", "label": "Civitai API token", "type": "secret"},
]

ALLOWLIST: set[str] = {entry["key"] for entry in SETTINGS_SCHEMA}
_BY_KEY: dict[str, dict[str, Any]] = {entry["key"]: entry for entry in SETTINGS_SCHEMA}

_TRUTHY = {"true", "1", "yes", "on"}
_FALSY = {"false", "0", "no", "off", ""}


def is_secret(key: str) -> bool:
    entry = _BY_KEY.get(key)
    return bool(entry and entry["type"] == "secret")


def coerce_value(key: str, raw: Any) -> str:
    """Валидирует и приводит значение к строке для записи в .env.
    Бросает ValueError при недопустимом ключе/значении."""
    entry = _BY_KEY.get(key)
    if entry is None:
        raise ValueError(f"Unknown setting: {key}")
    field_type = entry["type"]

    if field_type == "bool":
        s = str(raw).strip().lower()
        if s in _TRUTHY:
            return "true"
        if s in _FALSY:
            return "false"
        raise ValueError(f"{key}: ожидается bool")

    if field_type in ("int", "float"):
        try:
            num: Any = int(raw) if field_type == "int" else float(raw)
        except (TypeError, ValueError):
            raise ValueError(f"{key}: ожидается число")
        low, high = entry.get("min"), entry.get("max")
        if low is not None and num < low:
            num = low
        if high is not None and num > high:
            num = high
        return str(num)

    if field_type == "select":
        s = str(raw).strip()
        if s not in entry["options"]:
            raise ValueError(f"{key}: недопустимое значение")
        return s

    # text / secret — произвольная строка
    return str(raw)
