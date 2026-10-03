SHELL := /bin/bash
FORGE ?= $(HOME)/.foundry/bin/forge
.DEFAULT_GOAL := help
.PHONY: help doctor install build test web api local-up local-status local-test local-down fuji-check fuji-preflight fuji-host-check fuji-host-start fuji-host-status fuji-host-stop fuji-api-readonly mainnet-preflight orchestrator-test orchestrator-test-unit orchestrator-test-local
help:
	@printf '%s\n' 'make doctor | install | build | test | web | api | local-up | local-status | local-test | local-down | fuji-check | fuji-preflight | fuji-host-check | fuji-host-start | fuji-host-status | fuji-host-stop | fuji-api-readonly | mainnet-preflight | orchestrator-test-unit | orchestrator-test-local'
doctor:
	@./scripts/doctor.sh
install:
	pnpm install
build:
	pnpm build
	cd contracts && $(FORGE) build
test:
	pnpm test
	cd contracts && $(FORGE) test
web:
	pnpm --filter @shipfun/web dev
api:
	pnpm --filter @shipfun/api dev
local-up:
	@./scripts/local-up.sh
local-status:
	@./scripts/local-status.sh
local-test:
	@./scripts/local-test.sh
local-down:
	@./scripts/local-down.sh
fuji-check:
	@./scripts/fuji-check.sh
fuji-preflight:
	@node ./scripts/fuji-preflight.mjs
fuji-host-check:
	@node ./scripts/fuji-host-control.mjs check
fuji-host-start:
	@node ./scripts/fuji-host-control.mjs start
fuji-host-status:
	@node ./scripts/fuji-host-control.mjs status
fuji-host-stop:
	@node ./scripts/fuji-host-control.mjs stop
fuji-api-readonly:
	@SHIPFUN_ENVIRONMENT=fuji SHIPFUN_FUJI_MUTATION_APPROVED=false SHIPFUN_FUJI_REPOSITORY_PATH="$(CURDIR)/.runtime/fuji-chains.json" pnpm --filter @shipfun/api dev
mainnet-preflight:
	@./scripts/mainnet-preflight.sh
orchestrator-test: orchestrator-test-unit orchestrator-test-local
orchestrator-test-unit:
	pnpm --filter @shipfun/api test
orchestrator-test-local:
	@./scripts/orchestrator-local-test.sh
