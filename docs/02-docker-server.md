# 02 — Docker одной командой (GPU-сервер)

Полный стек (backend, frontend, Cloudflare Tunnel) запускается одной командой через
[`deploy/bootstrap.sh`](../deploy/bootstrap.sh). Подходит для собственной GPU-VM,
RunPod в режиме «Docker host» или любого хоста с полноценным Docker-демоном.

Этот путь требует Docker-демона с доступом к GPU. На типичном инстансе Vast.ai
(где вы уже находитесь внутри контейнера) вложенный Docker не работает — для этого
случая см. [инструкцию 03 — Vast.ai](03-vast-ai.md).

---

## Быстрый старт

```bash
git clone https://github.com/Akinara666/F2-AI-Image-Editor.git
cd F2-AI-Image-Editor
bash deploy/bootstrap.sh          # или: make up
```

Действия скрипта:
1. устанавливает Docker (при отсутствии) и `docker compose` v2;
2. определяет наличие GPU (`nvidia-smi`); при его наличии устанавливает NVIDIA
   Container Toolkit и проверяет `docker run --gpus all`;
3. создаёт `deploy/backend.env` из шаблона (устанавливает `USE_CUDA`);
4. собирает образы локально (backend с CUDA-torch `cu121`) и поднимает
   [`deploy/compose.gpu.yaml`](../deploy/compose.gpu.yaml);
5. запускает `cloudflared` и выводит публичный адрес
   `https://<random>.trycloudflare.com` — единый URL для интерфейса и API
   (nginx фронтенда проксирует backend, поэтому настройка CORS не требуется).

По завершении выводится:
```
==========================================================
  Приложение доступно по адресу:
  https://abcd-efgh-ijkl.trycloudflare.com
==========================================================
```
Откройте этот адрес в браузере — это весь редактор.

---

## Флаги `bootstrap.sh`

| Флаг | Назначение |
|---|---|
| `--gpu` | принудительно использовать GPU-стек |
| `--cpu` | лёгкий CPU-стек (без AI-runtime и без туннеля, генерация недоступна — см. [инструкцию 01](01-local.md)) |
| `--no-tunnel` | GPU-стек без cloudflared (доступ по SSH-туннелю или локально) |
| `--no-build` | не пересобирать образы |
| `-h`, `--help` | справка |

## Команды управления (`Makefile`)

```bash
make up        # = bootstrap.sh (автоопределение GPU/CPU и туннель)
make url       # вывести публичный адрес Cloudflare
make logs      # логи всех сервисов
make ps        # статус
make rebuild   # пересборка и перезапуск
make down      # остановка
```

---

## Доступ без туннеля

`bash deploy/bootstrap.sh --no-tunnel` поднимает backend на `127.0.0.1:8000`,
frontend на `127.0.0.1:3000`. С клиента пробросьте порт:
```bash
ssh -L 3000:127.0.0.1:3000 <user>@<host>
# откройте http://localhost:3000
```

---

## Структура и данные

Backend монтирует каталоги из репозитория (данные сохраняются при пересборке образов):
- `backend/models` -> `/app/models` (модели);
- `backend/static/outputs` -> `/app/static/outputs` (результаты генерации).

Конфигурация — `deploy/backend.env` (создаётся из
[`deploy/backend.env.example`](../deploy/backend.env.example); справочник переменных —
в [инструкции 01](01-local.md#переменные-окружения)).

---

## Примечания

- **Первый запуск длительный**: сборка образа загружает CUDA-torch (несколько ГБ).
  Повторные запуски быстрее (`--no-build`, кэш слоёв).
- **Модели** не встроены — загружаются из меню «Модели» в редакторе после запуска.
- **Туннель trycloudflare** случайный и эфемерный, без аутентификации — не публикуйте
  ссылку открыто либо используйте `--no-tunnel` и доступ по SSH.
- Для постоянного сервера с автоматическим развёртыванием — [инструкция 04 (GHCR + CD)](04-ghcr-cd.md).
