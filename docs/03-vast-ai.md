# 03 — Vast.ai / готовый CUDA-контейнер (без Docker)

Когда сервер — это уже контейнер с CUDA и Python (**Vast.ai**, RunPod-pod,
Colab-подобное), backend запускается **напрямую, без вложенного Docker**.
GPU-нагрузка (backend) живёт на сервере, лёгкий фронтенд — у тебя на клиенте.

- Сервер: [`deploy/run-vast.sh`](../deploy/run-vast.sh)
- Клиент: [`deploy/run-client.sh`](../deploy/run-client.sh)

---

## 0. Выбор инстанса

Бери **PyTorch- или CUDA-шаблон** (не «голый» Ubuntu) — тогда гарантированно
есть Python + pip + драйвер/CUDA. torch может быть не предустановлен (зависит от
образа) — скрипт сам докачает `cu121`-колёса, если его нет.

Что должно быть на инстансе:
- Python 3 + pip (на vast PyTorch/CUDA-шаблонах есть);
- NVIDIA-драйвер (`nvidia-smi` работает).

> На совсем минимальном образе без pip сначала: `apt update && apt install -y python3-pip python3-venv curl`.

---

## 1. На сервере (vast-инстанс)

```bash
git clone https://github.com/Akinara666/working-title-psd2.git
cd working-title-psd2
bash deploy/run-vast.sh
```

Скрипт:
- ставит зависимости backend прямо в окружение инстанса (**предустановленный
  CUDA-torch не трогает** — детектит `torch.cuda.is_available()`; докачивает
  `cu121` только если нужно);
- поднимает `uvicorn` на `0.0.0.0:8000`;
- (по умолчанию) поднимает Cloudflare quick-tunnel и печатает публичный
  **`https://<random>.trycloudflare.com`** — это адрес **API**.

> Первый запуск тянет torch + diffusers (несколько ГБ) — это минуты, которые
> тарифицируются. Повторные запуски быстрее.

### Флаги `run-vast.sh`
| Флаг | Назначение |
|---|---|
| `--no-tunnel` | без cloudflared (доступ через SSH-проброс / нативный порт vast) |
| `--no-venv` | ставить в текущий python, а не в venv `deploy/.venv-vast` |
| `--optional` | доустановить `requirements-optional` (xformers, llama-cpp-python) |
| `--reinstall` | переустановить зависимости |
| `--port N` | порт backend (по умолч. 8000) |
| `--torch-index U` | индекс колёс torch (по умолч. cu121) |
| `-h`, `--help` | справка |

---

## 2. Подключение с клиента — 3 варианта

Во всех фронтенд крутится у тебя ([`run-client.sh`](../deploy/run-client.sh)), а
отличается только как браузер достаёт API. CORS для `localhost` разрешён по умолчанию.

### Вариант A — Cloudflare-туннель (дефолт, проще всего)
Порты при создании инстанса открывать не нужно (туннель ходит наружу).

```bash
# сервер:
bash deploy/run-vast.sh                       # печатает https://<random>.trycloudflare.com
# клиент:
bash deploy/run-client.sh https://<random>.trycloudflare.com
# открой http://localhost:5173
```
➕ не нужно открывать порты, HTTPS, работает за NAT.
➖ URL случайный/меняется при перезапуске, **без авторизации**, free-туннель
best-effort (может флапать на больших загрузках).

### Вариант B — SSH-проброс порта (без cloudflared, самый приватный) ⭐
Трафик шифрован, наружу ничего не торчит, порты открывать не нужно.

```bash
# сервер:
bash deploy/run-vast.sh --no-tunnel           # backend на 0.0.0.0:8000
```
```bash
# клиент, терминал 1 — «труба» (host/порт SSH см. раздел 3):
ssh -N -p 10882 root@ssh2281.vast.ai -L 8000:127.0.0.1:8000
#   ^порт SSH (не 8000!)  ^хост vast        ^локальный:цель-на-сервере
# этот терминал не закрывай — пока он открыт, труба жива
```
```bash
# клиент, терминал 2 — фронт на локальный конец трубы:
bash deploy/run-client.sh http://127.0.0.1:8000
# открой http://localhost:5173
```
➕ приватно, шифровано, без публичной экспозиции.
➖ держать SSH-сессию открытой.

Схема:
```
браузер → localhost:5173 (фронт) → localhost:8000 (клиент)
                                        │  труба SSH
                                        ▼
                                  127.0.0.1:8000 на vast (backend)
```
Если локальный `8000` занят — слева возьми другой: `-L 8001:127.0.0.1:8000`,
тогда `run-client.sh http://127.0.0.1:8001`.

### Вариант C — нативный порт vast (без cloudflared, прямой IP:порт)
Порт открывается **только при создании** инстанса — в Docker-опциях шаблона добавь:
```
-p 8000:8000
```
```bash
# сервер:
bash deploy/run-vast.sh --no-tunnel
```
В «IP Port Info» инстанса смотришь маппинг вида `PUBLIC_IP:34567 -> 8000/tcp`.
```bash
# клиент:
bash deploy/run-client.sh http://PUBLIC_IP:34567
```
➕ стабильный адрес на время аренды, без зависимости от Cloudflare.
➖ порт открыть заранее; это **обычный HTTP** (без TLS), публично без авторизации.

### Что выбрать
- **Только для себя** → B (SSH `-L`): приватно, без публичного URL.
- **Быстро показать/потыкать** → A (cloudflared).
- **Нужен стабильный прямой адрес** → C.

---

## 3. Где взять SSH host/port (для варианта B)

Кроме кнопки **Connect** в консоли vast:

**vastai CLI:**
```bash
pip install vastai
vastai set api-key <твой_API_ключ>     # Account → API Key
vastai show instances                  # колонки ssh_host / ssh_port
vastai ssh-url <INSTANCE_ID>           # -> ssh://root@ssh2281.vast.ai:10882
```

**REST API:**
```bash
curl -s https://console.vast.ai/api/v0/instances/ \
  -H "Authorization: Bearer <твой_API_ключ>" \
  | jq -r '.instances[] | "ssh -p \(.ssh_port) root@\(.ssh_host)"'
```

**Изнутри инстанса** (если есть Jupyter/веб-терминал):
```bash
echo "ssh -p $VAST_TCP_PORT_22 root@$PUBLIC_IPADDR"
```

> Два режима SSH: **proxy** (`sshN.vast.ai`, всегда работает) и **direct**
> (`PUBLIC_IPADDR` + `VAST_TCP_PORT_22`, ниже задержка). Для `-L` подходят оба.

---

## 4. Заметки по vast.ai

- **Эфемерное хранилище.** Чтобы не перекачивать модели каждую аренду, держи
  `backend/models` на persistent-томе (например симлинк/монт на `/workspace`).
- **Публичный URL без авторизации** (вариант A/C) — любой со ссылкой жжёт твою
  GPU. Для приватного доступа — вариант B (SSH).
- **`Permission denied (publickey)`** при SSH — добавь свой публичный ключ
  (`~/.ssh/id_ed25519.pub`) в аккаунт vast (Account → SSH Keys) или при создании
  инстанса.
- Переменные окружения backend — [`deploy/backend.env.example`](../deploy/backend.env.example);
  скрипт кладёт их в `backend/.env` (читается `python-dotenv`). Разбор —
  в [гайде 01](01-local.md#переменные-окружения).
