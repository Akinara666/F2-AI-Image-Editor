# Структура модуля генерации изображений

Этот документ поясняет устройство пакета `image_generation`, взаимодействие его частей и предназначение каждой составляющей. Модуль построен вокруг идеи единого сервиса, который предоставляет Stable Diffusion 1.5 и SDXL в режимах text2img, img2img, inpainting и апскейлинга. Ниже описаны основные компоненты.

## Корневая точка входа

- `image_generation/__init__.py`  
  Публичный фасад пакета. Экспортирует `ImageGenerationService`, `GenerationSettings` и функцию `load_settings`, чтобы внешние модули могли быстро получить доступ к основному сервису и конфигурации.

## Конфигурация

- `config/models.yaml`  
  YAML-конфиг, описывающий доступные модели, их типы (text2img/img2img/inpaint/upscale), дефолтные параметры (разрешения, шаги, guidance scale), идентификаторы в Hugging Face, а также глобальные флаги оптимизации и режим безопасности.

- `config/settings.py`  
  Содержит dataclass-конфигурации `PipelineConfig`, `ModelConfig`, `GenerationSettings` и функцию `load_settings`. Именно здесь YAML превращается в типизированные объекты. Конфиг используется сервисом и менеджером моделей, чтобы знать, какие пайплайны загружать и как их настраивать.

- `config/__init__.py`  
  Упрощает импорт конфигурационных классов и функций (`from image_generation.config import GenerationSettings`).

## Сервисный слой

- `services/generator.py`  
  Главный фасад — `ImageGenerationService`. Он:
  * загружает настройки (`load_settings`);
  * создаёт `ModelManager` и бэкенды (SD 1.5 и SDXL);
  * предоставляет DTO-запросы (`Text2ImgRequest`, `Img2ImgRequest`, `InpaintRequest`, `UpscaleRequest`);
  * преобразует DTO в параметры бэкенда (dataclass из `pipelines/base.py`);
  * инициирует вызовы `text2img`, `img2img`, `inpaint`, `upscale` на нужном бэкенде и возвращает `GenerationResult`.

- `services/__init__.py`  
  Экспортирует сервис и DTO, чтобы внешние клиенты могли делать `from image_generation.services import ImageGenerationService`.


## Бэкенды и пайплайны

- `pipelines/base.py`  
  Определяет базовые структуры:
  * dataclass-параметры для разных режимов (`Text2ImgParams`, `Img2ImgParams`, `InpaintParams`, `UpscaleParams`);
  * класс результата `GenerationResult`;
  * абстрактный класс `GenerationBackend`, который задаёт интерфейс для конкретных реализаций (text2img/img2img/inpaint/upscale). Также включает вспомогательные методы для подготовки генератора, таймера, шедулера и сборки результата.

- `pipelines/manager.py`  
  `ModelManager` отвечает за ленивую загрузку и кеширование экземпляров diffusers-пайплайнов. Он:
  * хранит пайплайны в кэше по ключу `(backend, task)`;
  * переносит их на нужное устройство и применяет оптимизации (xFormers, attention slicing, offload);
  * умеет сменить шедулер для уже загруженного пайплайна.

- `pipelines/sd15.py`  
  Реализация `GenerationBackend` для Stable Diffusion 1.5. Загружает соответствующие пайплайны (`StableDiffusionPipeline`, `StableDiffusionImg2ImgPipeline`, `StableDiffusionInpaintPipeline`, `StableDiffusionUpscalePipeline`), управляет safety checker, применяет настройки дивайса, запускает генерацию и возвращает `GenerationResult`.

- `pipelines/sdxl.py`  
  Аналогичный бэкенд для SDXL. Помимо базового пайплайна поддерживает опциональный refiner. Работает с `StableDiffusionXLPipeline`, `StableDiffusionXLImg2ImgPipeline`, `StableDiffusionXLInpaintPipeline`, а также может использовать SD Upscaler по конфигу.

- `pipelines/__init__.py`  
  Упрощает импорт бэкендов, менеджера и общих датаклассов внутри пакета.

## Утилиты

Находятся в `image_generation/utils`. Каждая утилита решает отдельную задачу, но все они используются как сервисом, так и бэкендами.

- `device.py`  
  Определяет `DeviceConfig`, функцию `resolve_device` и контекст `autocast_context`. Управляет выбором устройства (CPU/CUDA/MPS), dtype и опциями mixed precision.

- `scheduler.py`  
  Маппинг пользовательских строковых названий шедулеров на соответствующие классы diffusers. Позволяет указывать scheduler в YAML/DTO как `dpmpp_2m_karras` и получать реальный класс `DPMSolverMultistepScheduler`.

- `progress.py`  
  Даёт `DiffusionProgress` и `make_callback`, которые адаптируют diffusers callbacks к единому формату прогресса и позволяют UI/CLI получать уведомления о шагах.

- `seed.py`  
  Утилита `prepare_generator`, создающая `torch.Generator` на нужном устройстве для воспроизводимых результатов.

- `images.py`  
  Функции загрузки/сохранения изображений, нормализации масок, подгонки разрешений к кратности 8/64 — общие операции для img2img/inpainting/upscale.

- `safety.py`  
  Инкапсулирует работу с NSFW флагами. В зависимости от `SafetyMode` (warn/block/off) либо возвращает предупреждения, либо выбрасывает исключение.

- `utils/__init__.py`  
  Собирает все утилиты в одном месте для удобного импорта (`from image_generation.utils import resolve_device, handle_safety`).

## Документация

- `README.md`  
  Общий обзор проекта, целевая аудитория и ключевые возможности (short-form).

- `QUICK_START.md`  
  Пошаговый запуск: требования, настройка окружения, коды примеров для всех режимов, работа с прогрессом и очисткой VRAM.

- `MODULE_STRUCTURE.md` (этот файл)  
  Описание архитектуры, разъяснение ролей подпакетов и взаимосвязей.

## Взаимодействие компонентов

1. Внешний код вызывает `ImageGenerationService`. На старте сервис загружает `GenerationSettings` (из `models.yaml`), создаёт `DeviceConfig` и `ModelManager`.
2. При первом запросе сервис инициализирует бэкенды (`SD15Backend`, `SDXLBackend`) и связывает их с `ModelManager`, передавая настройки и политику безопасности.
3. Когда приходит запрос `Text2ImgRequest`, сервис конвертирует его в `Text2ImgParams` и делегирует вызов соответствующему бэкенду.
4. Бэкенд через `ModelManager` получает или загружает diffusers-пайплайн, устанавливает scheduler по имени и запускает генерацию в контексте `autocast_context`.
5. Бэкенд формирует `GenerationResult`, применяя правила безопасности (`handle_safety`), собирая метаданные и время выполнения.
6. Сервис возвращает результат вызывающему коду. UI/CLI могут использовать `progress_cb`, чтобы получать промежуточные уведомления из `make_callback`.

Такое разделение позволяет легко расширять модуль (добавлять новые бэкенды, интегрировать LoRA, ControlNet) и подключать разные интерфейсы (клиентский UI, CLI, автоматические тесты), переиспользуя единую точку входа.
