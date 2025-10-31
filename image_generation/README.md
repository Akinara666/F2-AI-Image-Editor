# Пайплайн генерации изображений (Stable Diffusion 1.5 / SDXL)

Модуль предоставляет единый API для работы с **Stable Diffusion 1.5** и **Stable Diffusion XL** (Diffusers). Реализованы режимы:

- текстовая генерация (text2img);
- вариации по изображению (img2img);
- inpainting;
- апскейл (SD Upscaler / SDXL Upscaler; расширяемо для RealESRGAN).

## Структура

- `config/` — конфиги и YAML (`models.yaml`) с идентификаторами моделей.
- `pipelines/` — реализации бекендов (`sd15.py`, `sdxl.py`) и менеджер пайплайнов.
- `services/` — фасад `ImageGenerationService` с DTO-запросами (`Text2ImgRequest`, `Img2ImgRequest`, …).
- `utils/` — общие утилиты (device, scheduler, прогресс, seed, обработка изображений, safety).

## Быстрый старт

```python
from image_generation import ImageGenerationService, load_settings
from PIL import Image

service = ImageGenerationService(load_settings())

result = service.text2img(
    Text2ImgRequest(
        prompt="ultra detailed cinematic portrait",
        model="sdxl",
        steps=30,
        guidance_scale=7.0,
        seed=42,
    )
)

result.images[0].save("output.png")
```

## Настройки

- Конфиг `models.yaml` задаёт ID моделей, вариант (`variant: fp16`), scheduler по умолчанию и прочие параметры.
- Глобальные флаги: `enable_xformers`, `enable_attention_slicing`, `device`, `safety_mode`.
- Поддержка refiner для SDXL (`refine=True` в `Text2ImgRequest`).

## Расширение

- LoRA / embeddings: добавляются через `extra_options` DTO и расширение бекендов.
- RealESRGAN: в `UpscaleRequest.extra_options` можно добавить реализацию, подгрузив собственный апскейлер.
