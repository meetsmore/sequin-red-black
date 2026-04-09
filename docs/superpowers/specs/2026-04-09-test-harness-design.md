# Test Harness Design — `srb` E2E Tests

## Overview

E2E test harness for `srb` that runs against real Sequin + OpenSearch in Docker. Tests seed state using the same tools `srb` uses (Sequin CLI for declarative resources, Sequin REST API for imperative operations, OpenSearch REST API for indices/aliases), then run `srb` as a subprocess and verify results.

## Infrastructure

### Docker stack

Test-specific `docker-compose.yml` with shifted ports to avoid conflicts with the example stack:

| Service    | Image                              | Test Port | Internal Port |
|------------|------------------------------------|-----------|---------------|
| Postgres   | postgres:16                        | 17377     | 5432          |
| Redis      | redis:7                            | 17378     | 6379          |
| Sequin     | sequin/sequin:latest               | 17376     | 7376          |
| OpenSearch | opensearchproject/opensearch:2.11.0| 19200     | 9200          |

Postgres boots with the same `init.sql` as `example/` (Job + Client tables, replication slot, seed data).

Sequin boots with a minimal `sequin-boot.yml` — account, DB connection, API token. No sinks or functions (tests create those).

### Sequin CLI context

Tests configure a `sequin context` named `srb-test` pointing at `localhost:17376` with the test API token. All CLI calls use `--context=srb-test`.

### Lifecycle

- `beforeAll` — `docker compose up -d`, poll Sequin `/health` + OpenSearch `/_cluster/health` until ready, configure sequin context
- `afterEach` — `resetAll()` wipes Sequin config + all OS indices
- `afterAll` — `docker compose down -v`

## Hybrid approach: CLI + API + REST

`srb` itself uses three interfaces to manage infrastructure:

1. **Sequin CLI** (`sequin config plan/apply`) — declarative resource management (sinks, transforms, enrichments)
2. **Sequin REST API** — imperative operations the CLI can't do (trigger backfill, query sink status)
3. **OpenSearch REST API** — index CRUD, alias management, reindex

The test harness mirrors this. Seed helpers use the same tools to set up state, so tests exercise realistic conditions.

## Helper API

### Constants (`harness/constants.ts`)

```ts
export const TEST_SEQUIN_URL = "http://localhost:17376";
export const TEST_SEQUIN_TOKEN = "srb-dev-token-secret";
export const TEST_OS_URL = "http://localhost:19200";
export const TEST_PG_PORT = 17377;
export const SEQUIN_CONTEXT = "srb-test";
export const COMPILED_PATH = "/tmp/srb-test-compiled.json";
```

### Seed helpers (`harness/helpers.ts`)

```ts
// Wipe all state: sequin config apply with empty YAML + delete all OS test indices
resetAll(): Promise<void>

// Deploy a fully provisioned colored pipeline:
// 1. Generate colored Sequin YAML (e.g. jobs_red sink + jobs_red-transform function)
// 2. sequin config apply --auto-approve --context=srb-test
// 3. Create colored OS index with mappings
// Does NOT set alias, does NOT trigger backfill (unless opts say so)
deployPipeline(pipeline: string, color: string, config: PipelineConfig, opts?: {
  backfill?: boolean;  // default false — sink created without backfilling
}): Promise<void>

// Set OS alias to point pipeline -> colored index
setAlias(pipeline: string, color: string): Promise<void>

// Sequin API: trigger backfill on a sink (puts it in backfilling state)
triggerBackfill(pipeline: string, color: string): Promise<void>
```

### Run helper (`harness/run-srb.ts`)

```ts
interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Execute srb as subprocess with connection flags pre-filled
runSRB(...args: string[]): Promise<RunResult>
```

### Assert/query helpers (`harness/sequin-api.ts`, `harness/opensearch-api.ts`)

```ts
// Sequin API queries
getSinkState(pipeline: string, color: string): Promise<SinkInfo | null>
listSinks(): Promise<SinkInfo[]>
exportSequinConfig(): Promise<SequinYaml>  // sequin config export --context=srb-test

// OpenSearch queries
getIndexState(pipeline: string, color: string): Promise<IndexInfo | null>
listIndices(): Promise<IndexInfo[]>
getAliasColor(pipeline: string): Promise<string | null>
```

## File layout

```
srb/test/
  harness/
    docker-compose.yml      # Test stack (shifted ports)
    sequin-boot.yml         # Boot config (account, DB, token — no sinks)
    init.sql                # Same schema as example/init.sql
    constants.ts            # Ports, URLs, token
    helpers.ts              # resetAll, deployPipeline, setAlias, triggerBackfill
    sequin-api.ts           # Thin Sequin REST client (backfill, sink status)
    opensearch-api.ts       # OS REST client (indices, aliases, reindex)
    run-srb.ts              # runSRB() subprocess wrapper
  e2e/
    apply.test.ts
    activate.test.ts
    drop.test.ts
    backfill.test.ts
```

## Test scenarios

Each test calls `resetAll()` in setup.

### Plan/Apply tests (`e2e/apply.test.ts`)

**Fresh setup (no prior state)**
1. `runSRB("offline", "compile", ...)` to produce compiled.json
2. `runSRB("online", "plan", ...)` → assert exit code 2 (changes pending)
3. `runSRB("online", "apply", "--auto-approve", ...)` → exit 0
4. Assert: one colored sink + index exists per pipeline
5. `runSRB("online", "plan", ...)` again → assert exit code 0 (no changes)

**No change (desired == live)**
1. `deployPipeline("jobs", "red", jobsConfig)`
2. Compile with matching config
3. `runSRB("online", "plan", ...)` → exit 0

**Transform change (backfill path)**
1. `deployPipeline("jobs", "red", jobsConfig)`
2. Compile with modified transform function_body
3. `runSRB("online", "plan", ...)` → exit 2, shows create effects for new color
4. `runSRB("online", "apply", "--skip-backfill", "--auto-approve", ...)`
5. Assert: jobs_black sink + index created, jobs_red still exists
6. `runSRB("online", "activate", "jobs", "black", ...)` → alias swaps
7. `runSRB("online", "drop", "jobs", "red", ...)` → old color deleted

**Batch size change (in-place update)**
1. `deployPipeline("jobs", "red", jobsConfig)`
2. Compile with modified batch_size
3. `runSRB("online", "apply", "--auto-approve", ...)`
4. Assert: existing sink updated (new batch_size), no new color, no new index

**Index mappings change (reindex path)**
1. `deployPipeline("jobs", "red", jobsConfig)`
2. Compile with modified index mappings
3. `runSRB("online", "apply", "--auto-approve", ...)`
4. Assert: new color created, reindex triggered (no backfill)

**Multi-pipeline**
1. Compile with jobs + clients configs
2. `runSRB("online", "apply", "--auto-approve", ...)`
3. Assert: both pipelines created independently, correct colored resources

### Activate tests (`e2e/activate.test.ts`)

**Activate succeeds**
1. `deployPipeline("jobs", "red", jobsConfig)`
2. `runSRB("online", "activate", "jobs", "red", ...)` → exit 0
3. Assert: alias points to jobs_red

**Activate while backfilling → error**
1. `deployPipeline("jobs", "red", jobsConfig)`
2. `triggerBackfill("jobs", "red")`
3. `runSRB("online", "activate", "jobs", "red", ...)` → non-zero exit
4. Assert: no alias set

**Activate already active → idempotent**
1. `deployPipeline("jobs", "red", jobsConfig)`
2. `setAlias("jobs", "red")`
3. `runSRB("online", "activate", "jobs", "red", ...)` → exit 0
4. Assert: alias still points to jobs_red

### Drop tests (`e2e/drop.test.ts`)

**Drop inactive color**
1. `deployPipeline("jobs", "red", jobsConfig)`, `deployPipeline("jobs", "black", jobsConfig)`
2. `setAlias("jobs", "red")`
3. `runSRB("online", "drop", "jobs", "black", ...)` → exit 0
4. Assert: black resources deleted, red untouched, alias intact

**Drop active color → error**
1. `deployPipeline("jobs", "red", jobsConfig)`, `setAlias("jobs", "red")`
2. `runSRB("online", "drop", "jobs", "red", ...)` → non-zero exit
3. Assert: nothing deleted

### Backfill tests (`e2e/backfill.test.ts`)

**Manual backfill**
1. `deployPipeline("jobs", "red", jobsConfig)` (no backfill)
2. `runSRB("online", "backfill", "jobs", "red", ...)` → exit 0
3. Assert: sink is in backfilling state

**Backfill already running → error**
1. `deployPipeline("jobs", "red", jobsConfig)`
2. `triggerBackfill("jobs", "red")`
3. `runSRB("online", "backfill", "jobs", "red", ...)` → non-zero exit

## Quint spec alignment

All test scenarios correspond to behaviors modeled in the Quint spec (`commands_test.qnt`). No new invariants or behaviors are introduced:

- **Activate-idempotent**: The Quint spec's `cmd_activate` sets `aliases' = aliases.put(pipeline, color)`. Putting the same key-value is a no-op in the spec's map model, so idempotent activate is already consistent with the spec.
- **Effect escalation** (backfill > reindex > in-place): Directly modeled in `effects.qnt` via `needs_backfill`, `needs_reindex`, `needs_in_place_update`.
- **Drop-active guard**: Modeled in `cmd_drop` precondition `aliases.get(pipeline) != color`.
- **Backfill-while-backfilling guard**: Modeled in `cmd_backfill` precondition `not(live.sink.backfilling)`.
