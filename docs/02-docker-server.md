# 02 — Docker одной командой (GPU-сервер)

Полный стек (backend + frontend + Cloudflare Tunnel) одной командой через
[`deploy/bootstrap.sh`](../deploy/bootstrap.sh). Подходит для **своей GPU-VM,
RunPod «Docker host» или любого хоста с настоящим Docker-демоном**.

> ⚠️ Нужен **реальный Docker-демон с GPU-passthrough**. На типичном Vast.ai-инстансе
> (ты уже внутри контейнера) вложенный Docker не работает — для него см.
> [гайд 03 — Vast.ai](03-vast-ai.md).

---

## Быстрый старт

```bash
git clone https://github.com/Akinara666/working-title-psd2.git
cd working-title-psd2
bash deploy/bootstrap.sh          # или: make up
```

Что делает скрипт:
1. ставит Docker (если нет) и `docker compose` v2;
2. автоопределяет GPU (`nvidia-smi`); при наличии — ставит NVIDIA Container Toolkit
   и проверяет `docker run --gpus all`;
3. создаёт `deploy/backend.env` из шаблона (проставляет `USE_CUDA`);
4. собирает образы **локально** (backend с CUDA-torch `cu121`) и поднимает
   [`deploy/compose.gpu.yaml`](../deploy/compose.gpu.yaml);
5. поднимает `cloudflared` и печатает публичный
   **`https://<random>.trycloudflare.com`** — единый URL для SPA и API
   (nginx фронтенда проксирует backend, поэтому CORS не нужен).

В конце увидишь:
```
==========================================================
  Приложение доступно по адресу:
  https://abcd-efgh-ijkl.trycloudflare.com
==========================================================
```
Открой этот URL в браузере — это весь редактор.

---

## Флаги `bootstrap.sh`

| Флаг | Назначение |
|---|---|
| `--gpu` | форсировать GPU-стек |
| `--cpu` | лёгкий CPU-стек (**без AI-runtime и туннеля**, генерации нет — см. [гайд 01](01-local.md)) |
| `--no-tunnel` | GPU-стек без cloudflared (доступ по SSH-туннелю/локально) |
| `--no-build` | не пересобирать образы |
| `-h`, `--help` | справка |

## Команды управления (`Makefile`)

```bash
make up        # = bootstrap.sh (авто GPU/CPU + туннель)
make url       # показать публичный Cloudflare URL
make logs      # логи всех сервисов
make ps        # статус
make rebuild   # пересобрать и перезапустить
make down      # остановить
```

---

## Доступ без туннеля

`bash deploy/bootstrap.sh --no-tunnel` — backend на `127.0.0.1:8000`,
frontend на `127.0.0.1:3000`. С клиента пробрось порт:
```bash
ssh -L 3000:127.0.0.1:3000 <user>@<host>
# открой http://localhost:3000
```

---

## Структура и данные

Backend монтирует из репозитория (данные переживают пересборку образов):
- `backend/models` → `/app/models` (модели)
- `backend/static/outputs` → `/app/static/outputs` (результаты генерации)

Конфигурация — `deploy/backend.env` (создаётся из
[`deploy/backend.env.example`](../deploy/backend.env.example); разбор переменных —
в [гайде 01](01-local.md#переменные-окружения)).

---

## Заметки

- **Первый запуск долгий**: сборка образа тянет CUDA-torch (несколько ГБ).
  Повторные — быстрее (`--no-build`, кэш слоёв).
- **Модели** не вшиты — качаются из меню «Модели» в редакторе после старта.
- **Туннель trycloudflare** случайный/эфемерный и **без авторизации** — не
  выкладывай ссылку публично, либо используй `--no-tunnel` + SSH.
- Для **постоянного** сервера с автодеплоем — [гайд 04 (GHCR + CD)](04-ghcr-cd.md).
