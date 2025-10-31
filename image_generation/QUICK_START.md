# Быстрый старт

Краткое руководство по использованию модулей `image_generation` для Stable Diffusion 1.5 и SDXL. Ниже описаны требования, настройка окружения и примеры кода для основных режимов: text2img, img2img, inpainting и апскейлинга.

## 1. Требования

- Python 3.10+ (лучше работать в изолированном виртуальном окружении).
- Желательно GPU с поддержкой CUDA 11.8 и выше, но модуль работает и на CPU.
- Интернет нужен только при первом запуске для скачивания весов моделей (после этого всё хранится локально в кэше Hugging Face).

## 2. Установка зависимостей

```bash
python -m venv .venv
source .venv/bin/activate              # Windows: .venv\Scripts\activate
pip install --upgrade pip

# Основной стек
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
pip install diffusers transformers accelerate safetensors pillow xformers

# Дополнительные инструменты при необходимости
pip install opencv-python imageio realesrgan
```

Проверьте, что `diffusers >= 0.27` и `torch >= 2.1`.

## 3. Конфигурация моделей

Файл `image_generation/config/models.yaml` хранит описание доступных пайплайнов:

- ID моделей для text2img/img2img/inpainting/upscale в SD 1.5 и SDXL;
- дефолтные параметры (разрешение, количество шагов, guidance scale, scheduler);
- глобальные флаги оптимизации (`enable_xformers`, `enable_attention_slicing`, offload на CPU);
- режим работы safety checker (`warn | block | off`).

Чтобы переопределить конфиг:

1. Скопируйте `models.yaml` в своё расположение.
2. Передайте путь в `load_settings(Path("my_models.yaml"))`.
3. Измените модели, дефолтные размеры или политику безопасности.

## 4. Минимальный пример

### 4.1 Общая подготовка

```python
from pathlib import Path
from PIL import Image

from image_generation import ImageGenerationService, load_settings
from image_generation.services import (
    Text2ImgRequest,
    Img2ImgRequest,
    InpaintRequest,
    UpscaleRequest,
)

settings = load_settings()                 # читает image_generation/config/models.yaml
service = ImageGenerationService(settings) # модели загрузятся при первом вызове


def save_result(result, filename: str) -> None:
    """Сохраняем первую картинку и выводим краткую статистику."""
    output_path = Path("outputs") / filename
    output_path.parent.mkdir(parents=True, exist_ok=True)
    result.images[0].save(output_path)
    warnings = result.safety.warnings if result.safety else []
    print(f"[{filename}] model={result.model_id} seed={result.seed} "
          f"time={result.elapsed_ms:.0f}ms warnings={warnings}")
```

### 4.2 Text2Img (SDXL + Refiner)

```python
text2img_req = Text2ImgRequest(
    model="sdxl",
    prompt="HDR photo of a futuristic city at sunset",
    negative_prompt="blur, low quality",
    width=768,
    height=768,
    steps=30,
    guidance_scale=7.0,
    seed=1337,
    refine=True,   # второй проход через SDXL Refiner
)
save_result(service.text2img(text2img_req), "sdxl_text2img.png")
```

### 4.3 Img2Img (SD 1.5)

```python
base_img = Image.open("assets/base_character.png").convert("RGB")
img2img_req = Img2ImgRequest(
    model="sd15",
    prompt="Steampunk version of the character, brass details, cinematic lighting",
    negative_prompt="low quality, duplicates",
    image=base_img,
    strength=0.45,          # больше значение => сильнее отличие от исходника
    steps=25,
    guidance_scale=7.5,
    seed=2024,
)
save_result(service.img2img(img2img_req), "sd15_img2img.png")
```

### 4.4 Inpainting (SDXL)

```python
scene_img = Image.open("assets/room.png").convert("RGB")
mask_img = Image.open("assets/room_mask.png").convert("L")  # белые области будут заменены
inpaint_req = InpaintRequest(
    model="sdxl",
    prompt="Snowy mountains and a blue sky outside the window",
    negative_prompt="foggy, low resolution",
    image=scene_img,
    mask_image=mask_img,
    strength=0.6,
    steps=35,
    guidance_scale=7.0,
    seed=77,
)
save_result(service.inpaint(inpaint_req), "sdxl_inpaint.png")
```

### 4.5 Upscale (SD Upscaler, prompt-guided)

```python
thumbnail = Image.open("assets/landscape_small.png").convert("RGB")
upscale_req = UpscaleRequest(
    model="sd15",
    image=thumbnail,
    prompt="Highly detailed landscape photograph, sharp, vibrant colors",
    negative_prompt="oversaturated, noisy",
    steps=50,
    guidance_scale=0.0,     # 0..1 позволяет сохранить исходные детали
    seed=999,
)
save_result(service.upscale(upscale_req), "sd15_upscale.png")
```

## 5. Обзор режимов

- **Img2Img** — `service.img2img(...)`. Принимает базовое изображение, параметр `strength` контролирует силу изменений.
- **Inpainting** — `service.inpaint(...)`. Требуются исходное изображение и маска (в градациях серого). Размеры автоматически подгоняются.
- **Upscaling** — `service.upscale(...)`. Использует SD Upscaler, но можно подключить RealESRGAN или другие апскейлеры через `extra_options`.

## 6. Прогресс генерации

Каждый DTO имеет параметр `progress_cb`, принимающий функцию с объектом `DiffusionProgress`. Это позволяет отображать прогресс в UI или логе.

```python
from image_generation.utils import DiffusionProgress

def on_progress(update: DiffusionProgress) -> None:
    if update.total:
        percent = update.step / update.total * 100
        print(f"{percent:.1f}%")

service.text2img(
    Text2ImgRequest(
        prompt="Cozy cabin in the woods",
        model="sd15",
        progress_cb=on_progress,
    )
)
```

## 7. Управление памятью

Чтобы освободить VRAM, вызовите `service.manager.clear()`. Все загруженные пайплайны будут выгружены на CPU и очищены, следующий запуск вновь прогрузит веса.

## 8. Расширение функциональности

- Поддержка LoRA, ControlNet, IP-Adapter и embeddings добавляется через `extra_options` и расширение бэкендов.
- Внешние апскейлеры подключаются функцией, возвращающей `PIL.Image`, и интеграцией в сервис.
- В `models.yaml` установите `safety_mode: block`, чтобы полностью блокировать NSFW-контент (`warn` оставляет предупреждение, `off` отключает фильтр).

После первого запуска модели кэшируются в `~/.cache/huggingface`, так что повторные генерации не требуют подключения к интернету.
