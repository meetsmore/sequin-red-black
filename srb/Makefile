build:
	bun build --compile --target=bun src/cli.ts --outfile srb

test-unit:
	bun test test/unit/

test-e2e:
	bun test test/e2e/ --timeout 300000

test: test-unit test-e2e

test-stack-up:
	docker compose -f test/harness/docker-compose.yml up -d

test-stack-down:
	docker compose -f test/harness/docker-compose.yml down -v

typecheck:
	bun run typecheck

.PHONY: build test-unit test-e2e test test-stack-up test-stack-down typecheck
