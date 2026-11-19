# llama-chat-standalone lifecycle.
# Every target is documented with a trailing "## comment" so `make help` can list it.

SHELL := /bin/bash
.DEFAULT_GOAL := help

APP_DIR := ui/apps/chat
DIST := $(APP_DIR)/dist
RUN_DIR := .run
PID_FILE := $(RUN_DIR)/server.pid
LOG_FILE := $(RUN_DIR)/server.log
PORT ?= 8080
UPSTREAM ?= http://127.0.0.1:8888
MODEL_ID ?= local-model
N_CTX ?= 8192
LLAMA_CPP_DIR ?= ../llama.cpp

# Container runtime: use docker when installed, otherwise fall back to podman.
# `podman compose` shells out to podman-compose (uv tool install podman-compose).
CONTAINER_CLI ?= $(shell command -v docker >/dev/null 2>&1 && echo docker || echo podman)
COMPOSE := $(CONTAINER_CLI) compose

export PORT UPSTREAM MODEL_ID N_CTX

.PHONY: help install build dev start stop restart status logs test sync-ui \
        deploy docker-down docker-logs clean

help: ## Show this help
	@echo "llama-chat-standalone"
	@echo
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  %-14s %s\n", $$1, $$2}'
	@echo
	@echo "config: PORT=$(PORT) UPSTREAM=$(UPSTREAM) MODEL_ID=$(MODEL_ID) N_CTX=$(N_CTX)"

install: ## Install UI dependencies
	cd $(APP_DIR) && npm ci

build: install ## Build the UI into ui/apps/chat/dist
	cd $(APP_DIR) && npm run build

dev: install ## Run the Vite dev server against UPSTREAM
	cd $(APP_DIR) && VITE_PUBLIC_SERVER_ORIGIN=$(UPSTREAM) npm run dev

start: $(DIST)/index.html ## Start the server in the background
	@mkdir -p $(RUN_DIR)
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "already running (pid $$(cat $(PID_FILE)))"; exit 0; fi
	@nohup node server.mjs > $(LOG_FILE) 2>&1 & echo $$! > $(PID_FILE)
	@sleep 1
	@if kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "started pid $$(cat $(PID_FILE)) on http://localhost:$(PORT)"; \
	else \
		echo "failed to start, see $(LOG_FILE)"; tail -5 $(LOG_FILE); rm -f $(PID_FILE); exit 1; fi

stop: ## Stop the background server
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		kill $$(cat $(PID_FILE)); echo "stopped"; else echo "not running"; fi
	@rm -f $(PID_FILE)

restart: stop start ## Restart the background server

status: ## Show whether the server is running
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "running (pid $$(cat $(PID_FILE))) on http://localhost:$(PORT)"; \
	else echo "not running"; fi

logs: ## Tail the server log
	@tail -f $(LOG_FILE)

test: ## Run the server self-check
	node test.mjs

sync-ui: ## Copy the UI from LLAMA_CPP_DIR into this repo
	./scripts/sync-ui.sh $(LLAMA_CPP_DIR)

deploy: ## Build the image, (re)start the container, drop the old image
	@# .env is authoritative for the container: the exported host defaults
	@# (127.0.0.1) would point the proxy at itself inside the container.
	env -u PORT -u UPSTREAM -u MODEL_ID -u N_CTX $(COMPOSE) up -d --build
	@$(CONTAINER_CLI) image prune -f >/dev/null

docker-down: ## Stop the container and remove its image
	$(COMPOSE) down --rmi local

docker-logs: ## Tail the container log
	$(COMPOSE) logs -f

clean: ## Remove build output and runtime files
	rm -rf $(DIST) $(RUN_DIR) $(APP_DIR)/.svelte-kit

$(DIST)/index.html:
	@echo "no UI build yet, run 'make build'"
	@exit 1
