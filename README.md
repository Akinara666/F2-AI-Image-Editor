# Local AI Image Editor (MVP)

Локальный сервис генерации изображений с веб-интерфейсом (аналог Photoshop в браузере) и нейросетями Stable Diffusion.

## 🚀 Основные возможности
*   **Умный менеджмент VRAM**: Автоматическая выгрузка/загрузка моделей при смене режимов (Text2Img / Inpainting) для экономии видеопамяти.
*   **Редактор холста (Fabric.js)**: Поддержка Zoom, Pan, и выделения областей (Crop) c точным пересчетом координат.
*   **Сохранение метаданных**: Все параметры генерации (Seed, Prompt, Model) сохраняются внутри PNG файла.
*   **Inpainting**: Умное "закрашивание" с размытием краев маски для бесшовной интеграции.
*   **LoRA & Presets**: Поддержка стилей (Anime, Cinematic) и архитектурная готовность к LoRA.

## 🛠 Технический стек
*   **Frontend**: React, Vite, Fabric.js.
*   **Backend**: Python, FastAPI, Uvicorn.
*   **ML**: HuggingFace Diffusers, Torch, Xformers.

## 📦 Установка и Запуск

### Предварительные требования
*   Python 3.10+
*   Node.js (рекомендуется LTS, например v20+)
*   NVIDIA GPU с поддержкой CUDA (рекомендуется)

### 1. Настройка Backend
```bash
cd backend

# Создание виртуального окружения
python3 -m venv venv
source venv/bin/activate  # Для Linux/MacOS
# venv\Scripts\activate   # Для Windows

# Установка зависимостей
pip install -r requirements.txt

# Запуск сервера API (порт 8000)
# Первый запуск может занять время из-за скачивания моделей
python -m uvicorn main:app --reload --port 8000
```
API будет доступно по адресу: http://localhost:8000 (Документация: /docs)

### 2. Настройка Frontend
В новом терминале:
```bash
cd frontend

# Установка зависимостей
npm install

# Запуск режима разработки
npm run dev
```
Интерфейс будет доступен по адресу, указанному в консоли (обычно http://localhost:5173).

## 🎮 Как пользоваться
1.  **Навигация**: Используйте `Alt + Drag` для перемещения холста, колесико мыши для зума.
2.  **Выделение**: Нажмите "Add Selection", чтобы создать область генерации (512x512).
3.  **Экспорт**: Нажмите "Export Selection", чтобы получить кроп изображения (Base64) для отправки на сервер.
    *   *Примечание: В MVP версии кнопка "Export" пока только выводит данные в консоль браузера (F12) для демонстрации работы математики координат.*

## 📂 Структура проекта
```
.
├── backend/
│   ├── core/
│   │   ├── manager.py   # ModelManager (VRAM logic)
│   │   └── utils.py     # Image processing & Metadata
│   ├── static/outputs/  # Сохраненные изображения
│   └── main.py          # FastAPI App
└── frontend/
    ├── src/
    │   └── components/
    │       └── Editor.jsx  # Логика Fabric.js
    └── package.json
```
