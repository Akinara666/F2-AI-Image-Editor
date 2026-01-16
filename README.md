# LLM fork PSD2

## Описание
Модуль, отвечающий за LLM-часть проекта PSD2.

Используется модель **Qwen3 1.7B**, адаптированная для задачи
преобразования пользовательского запроса на естественном языке
в структурированный prompt для **Stable Diffusion**.

Модель принимает свободный текст и генерирует специализированный
синтаксис, пригодный для использования в diffusion-моделях.

## Кратко
- Base model: Qwen3 1.7B
- Задача: Natural language → Stable Diffusion prompt
- Fine-tuning:  QLoRA
- Инференс:  объединение base модели и LoRA-адаптера

## Цель
Автоматизировать преобразование пользовательских текстовых запросов
в формализованный prompt для Stable Diffusion
с сохранением семантики и улучшением структуры.

## Данные
Данные представлены в виде пар:
- вход: текстовый запрос пользователя на естественном языке
- выход: структурированный prompt для Stable Diffusion

Формат обучения — instruction-style text-to-text.

## Подход
В качестве базовой модели используется **Qwen3 1.7B**.

Адаптация модели выполнена с помощью **QLoRA**:
- базовая модель загружается без изменения весов
- обучается только LoRA-адаптер
- инференс осуществляется через объединение base model + adapter

Обучение конфигурировалось на 8 эпох, однако наилучшие качественные
результаты наблюдались на **4 эпохе**, после чего дальнейшее обучение
приводило к деградации качества. Для инференса используется модель,
сохранённая на 4 эпохе.

## Эксперименты

### Try 1(400)
- Датасет: ~400 примеров  
- Фокус: редактирование изображений, базовые SD-теги и простые настройки
- Обучение: до 10 эпох, early stopping на 4 эпохе
- Используется checkpoint с 4 эпохи

Базовая проверка пайплайна и формата задачи.

---

### Try 2(800)
- Датасет: ~800 примеров  
- Изменения:
  - человеческий промпт смещён в сторону генерации, а не только редактирования
  - переработаны SD-теги и их структура
- Обучение: до 8 эпох, early stopping на 3 эпохе  
- Настройки обучения: _будут указаны позже_

Наиболее удачная попытка по качеству генерации и стабильности поведения модели.

---

### Try 3(1600)
- Датасет: ~1600 примеров  
- Изменения:
  - более сложные и масштабные сцены
  - расширенные описания сцен
  - переработанный блок reasoning / thinking
  - больше самостоятельных ответов модели в SD-тегах
- Обучение: 8 эпох (без early stopping)  
- Настройки обучения: _будут указаны позже_

Обучение проходило стабильно, метрики выглядели хорошо, однако итоговое
качество генерации ухудшилось: модель стала хуже рассуждать и начала
генерировать некорректные SD-теги. Требуется доработка датасета и изменение
настроек обучения.

## Итоги и наблюдения
- Увеличение датасета не гарантирует улучшение качества без корректной
  структуры данных и баланса reasoning.
- Наилучшие результаты получены при умеренном размере датасета и
  контролируемом early stopping.
- Качество данных и формат промпта оказывают большее влияние, чем количество эпох.

## Inference

### 1) Загрузка LoRA-адаптера (например qwen3_1_7b_qlora_lora_800_v2.zip)
### 2) Скачать базовую модель (hugging face)
 ``` python
 from huggingface_hub import snapshot_download 

model_id = "Qwen/Qwen3-1.7B"
local_dir = "qwen3_1_7b"

snapshot_download(
    repo_id=model_id,
    local_dir=local_dir,
    local_dir_use_symlinks=False,
)

print(f"Model downloaded to: {local_dir}")
```
### 3) Инференс(базовая модель+адаптер)
``` python
import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import PeftModel

BASE_MODEL_PATH = "./qwen3_1_7b"
ADAPTER_PATH = "./qwen3_1_7b_qlora_800_v2"

tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL_PATH)
if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token

base_model = AutoModelForCausalLM.from_pretrained(
    BASE_MODEL_PATH,
    device_map="auto",
    torch_dtype=torch.bfloat16,
)

model = PeftModel.from_pretrained(base_model, ADAPTER_PATH)
model.eval()

system_prompt = "<SYSTEM_PROMPT>"
messages = [{"role": "system", "content": system_prompt}]

def chat():
    while True:
        user_input = input("You: ").strip()
        if user_input.lower() in ["exit", "quit"]:
            break

        messages.append({"role": "user", "content": user_input})

        text = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
        inputs = tokenizer(text, return_tensors="pt").to(model.device)

        with torch.inference_mode():
            output = model.generate(
                **inputs,
                max_new_tokens=512,
                temperature=0.8,
                top_p=0.9,
                do_sample=True,
                repetition_penalty=1.05,
            )

        response = tokenizer.decode(output[0], skip_special_tokens=True)
        response = response.split("assistant")[-1].strip()

        print(response)
        messages.append({"role": "assistant", "content": response})

chat()
```


