# Удобные команды для деплоя GPU-стека.
# Быстрый старт: make up   (или сразу bash deploy/bootstrap.sh)

COMPOSE ?= docker compose -f deploy/compose.gpu.yaml

.PHONY: up cpu down logs url ps rebuild

## up: поднять весь стек одной командой (авто GPU/CPU + Cloudflare Tunnel)
up:
	bash deploy/bootstrap.sh

## cpu: лёгкий CPU-стек без туннеля
cpu:
	bash deploy/bootstrap.sh --cpu

## down: остановить GPU-стек
down:
	$(COMPOSE) down

## logs: логи всех сервисов (Ctrl+C для выхода)
logs:
	$(COMPOSE) logs -f

## url: показать публичный Cloudflare URL
url:
	@$(COMPOSE) logs cloudflared 2>&1 | grep -Eo 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' | tail -n1

## ps: статус сервисов
ps:
	$(COMPOSE) ps

## rebuild: пересобрать и перезапустить
rebuild:
	$(COMPOSE) up -d --build
