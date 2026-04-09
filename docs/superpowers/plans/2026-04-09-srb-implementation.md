# `srb` — Red-Black Deployment Orchestrator Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `srb`, a stateless CLI binary that manages red-black deployments of CDC pipelines (Postgres → Sequin → OpenSearch). Directly translates the Quint formal spec in `docs/spec/quint/` into working TypeScript.

**Architecture:** TypeScript/Bun binary with two command groups — `offline` (pure, no network) and `online` (requires Sequin + OpenSearch). Effect-centric plan/apply model mirrors the Quint spec exactly.

**Tech Stack:**
- TypeScript + Bun (compiled to single self-contained binary via `bun build --compile`)
- `commander` for CLI subcommands/flags
- `zod` for runtime validation of Sequin/OpenSearch API responses
- `js-yaml` for parsing `sink.yaml` / `transform.yaml` / `enrichment.yaml`
- Bun's built-in `fetch` for HTTP
- Bun's built-in test runner (`bun test`) for unit + E2E tests
- Docker Compose for E2E tests

**Config files:** `.ts` files (`index.ts`, `_defaults.ts`) are imported directly via Bun's dynamic `import()` — no Deno eval, no subprocess. The compiled `srb` binary can dynamically import user TypeScript config files from the filesystem at runtime.

---

## Directory layout

```
srb/
  src/
    config/
      types.ts          # TypeScript types mirroring types.qnt
      color.ts          # Color enum, parsing, available-color logic
      loader.ts         # Load per-pipeline configs from indexes/ dir
    planner/
      effects.ts        # Pure diff logic — direct translation of effects.qnt
      plan.ts           # generatePlans(), pickTargetColor() — from plan.qnt
    executor/
      executor.ts       # Walk PlannedEffects in dep order, call APIs
    sequin/
      client.ts         # Sequin REST API client
      schemas.ts        # Zod schemas for Sequin API responses
    opensearch/
      client.ts         # OpenSearch REST API client
      schemas.ts        # Zod schemas for OpenSearch API responses
    state/
      discover.ts       # Query Sequin + OpenSearch → live state map
    offline/
      compile.ts        # srb offline compile
    online/
      plan.ts           # srb online plan
      apply.ts          # srb online apply [--skip-backfill]
      activate.ts       # srb online activate <pipeline> <color>
      backfill.ts       # srb online backfill <pipeline> <color>
      drop.ts           # srb online drop <pipeline> <color>
    cli.ts              # Commander tree, entry point
  test/
    unit/
      effects.test.ts   # Pure planner unit tests (no network)
      plan.test.ts      # generatePlans() scenario tests
    e2e/
      docker-compose.yml
      sequin-boot.yml
      init.sql
      helpers.ts        # Stack lifecycle, RunSRB(), waitForHealth()
      apply.test.ts
      activate.test.ts
      drop.test.ts
  package.json
  tsconfig.json
  bunfig.toml
  Makefile
```

---

## Phase 1 — Core types and offline compile

### 1.1 — TypeScript types (`src/config/types.ts`)

Direct translation of `types.qnt`. Use discriminated unions for variant types, plain interfaces for record types.

```ts
export type Color = "red" | "black" | "blue" | "green" | "purple" | "orange" | "yellow";
export const ALL_COLORS: Color[] = ["red", "black", "blue", "green", "purple", "orange", "yellow"];

export interface SinkConfig {
  id: string;
  name: string;
  sourceTable: string;
  destination: string;
  filters: string;
  batchSize: number;
  transformId: string;
  enrichmentIds: string[];
}

export interface IndexConfig {
  id: string;
  name: string;
  mappings: Record<string, unknown>;
  settings: Record<string, unknown>;
  alias: string;
}

export interface TransformConfig {
  id: string;
  name: string;
  functionBody: string;  // inlined Elixir source
  inputSchema: string;
  outputSchema: string;
}

export interface EnrichmentConfig {
  id: string;
  name: string;
  source: string;        // inlined SQL
  joinColumn: string;
  enrichmentColumns: string;
}

export interface PipelineConfig {
  name: string;
  sink: SinkConfig;
  index: IndexConfig;
  transform: TransformConfig;
  enrichment: EnrichmentConfig;
}

// Live state (discovered from Sequin + OpenSearch)
export type SinkLifecycle = "active" | "paused" | "disabled";
export type IndexStatus = "green" | "yellow" | "red" | "reindexing" | "not_found";

export interface SinkState { config: SinkConfig; lifecycle: SinkLifecycle; backfilling: boolean; }
export interface IndexState { config: IndexConfig; status: IndexStatus; docCount: number; }
export interface TransformState { config: TransformConfig; status: "active" | "inactive"; }
export interface EnrichmentState { config: EnrichmentConfig; status: "active" | "inactive"; }

export interface LivePipelineState {
  sink: SinkState;
  index: IndexState;
  transform: TransformState;
  enrichment: EnrichmentState;
}

// Keyed by pipeline name + color
export type PipelineKey = `${string}:${Color}`;  // e.g. "jobs:red"
export function pipelineKey(pipeline: string, color: Color): PipelineKey { return `${pipeline}:${color}`; }
export function parseKey(key: PipelineKey): [string, Color] {
  const i = key.lastIndexOf(":");
  return [key.slice(0, i), key.slice(i + 1) as Color];
}
```

**Effects — mirrors `types.qnt` variant type:**

```ts
export type Effect =
  | { kind: "CreateSink";       sink: SinkConfig }
  | { kind: "CreateIndex";      index: IndexConfig }
  | { kind: "CreateTransform";  transform: TransformConfig }
  | { kind: "CreateEnrichment"; enrichment: EnrichmentConfig }
  | { kind: "UpdateSink";       id: string; config: SinkConfig }
  | { kind: "DeleteSink";       id: string }
  | { kind: "DeleteIndex";      id: string }
  | { kind: "DeleteTransform";  id: string }
  | { kind: "DeleteEnrichment"; id: string }
  | { kind: "TriggerBackfill";  sinkId: string }
  | { kind: "TriggerReindex";   source: string; target: string }
  | { kind: "SwapAlias";        pipeline: string; color: Color }

export type EffectStatus = "pending" | "in_progress" | "completed" | { failed: string };

export interface PlannedEffect {
  effect: Effect;
  status: EffectStatus;
  dependsOn: number[];
  order: number;
}

export interface Plan {
  pipeline: string;
  targetColor: Color;
  effects: PlannedEffect[];
}
```

**Tasks:**
- [ ] Write `src/config/types.ts` with all types above
- [ ] Write `src/config/color.ts` — `availableColors(pipeline, live)`, `colorFromString()`, `colorToString()`

### 1.2 — Config loader (`src/config/loader.ts`)

Reads `indexes/<name>/` per-pipeline directory, assembles a color-agnostic `PipelineConfig`.

The loader uses dynamic `import()` for `.ts` config files, `Bun.file` + `js-yaml` for `.yaml` files.

```
indexes/
  _defaults.ts         # shared OpenSearch settings (already exists in example/)
  opensearch/
    _defaults.ts       # (current location — loader resolves relative to indexes dir)
  jobs/
    index.ts           # default export: { settings, mappings } — imported directly
    sink.yaml          # SinkConfig fields
    transform.yaml     # name + code_file reference
    transform.ex       # Elixir source (inlined by loader)
    enrichment.yaml    # name + code_file reference
    enrichment.sql     # SQL source (inlined by loader)
  clients/
    (same)
```

```ts
// src/config/loader.ts

export async function loadPipeline(name: string, indexesDir: string): Promise<PipelineConfig> {
  const dir = path.join(indexesDir, name);

  // 1. Import index.ts directly — Bun resolves and evaluates at runtime
  const indexModule = await import(path.resolve(dir, "index.ts"));
  const indexExport = indexModule.default as { mappings: unknown; settings: unknown };

  // 2. Read sink.yaml
  const sinkYaml = yaml.load(await Bun.file(path.join(dir, "sink.yaml")).text()) as RawSinkYaml;

  // 3. Read transform.yaml + inline .ex file
  const transformYaml = yaml.load(...) as RawTransformYaml;
  const transformBody = await Bun.file(path.join(dir, transformYaml.code_file)).text();

  // 4. Read enrichment.yaml + inline .sql file
  const enrichmentYaml = yaml.load(...) as RawEnrichmentYaml;
  const enrichmentSql = await Bun.file(path.join(dir, enrichmentYaml.code_file)).text();

  return {
    name,
    sink: { ...sinkYaml, id: name, transformId: `${name}-transform`, enrichmentIds: [`${name}-enrichment`] },
    index: { id: name, name, alias: name, mappings: indexExport.mappings, settings: indexExport.settings },
    transform: { id: `${name}-transform`, name: `${name}-transform`, functionBody: transformBody, ... },
    enrichment: { id: `${name}-enrichment`, name: `${name}-enrichment`, source: enrichmentSql, ... },
  };
}

export async function loadAll(indexesDir: string): Promise<Map<string, PipelineConfig>> {
  const entries = await readdir(indexesDir, { withFileTypes: true });
  const pipelines = entries.filter(e => e.isDirectory() && !e.name.startsWith("_") && e.name !== "opensearch");
  const results = await Promise.all(pipelines.map(e => loadPipeline(e.name, indexesDir)));
  return new Map(results.map(p => [p.name, p]));
}
```

**Naming conventions** (colored names stamped at plan time):
- Index + sink: `<pipeline>_<color>` e.g. `jobs_red`
- Transform: `<pipeline>_<color>-transform` e.g. `jobs_red-transform`
- Enrichment: `<pipeline>_<color>-enrichment` e.g. `jobs_red-enrichment`
- Root alias: `<pipeline>` (no color) e.g. `jobs`

**Tasks:**
- [ ] Write `src/config/loader.ts` — `loadPipeline()`, `loadAll()`

### 1.3 — `srb offline compile`

```
srb offline compile [--indexes ./indexes] [--out ./compiled.json]
```

Loads all pipelines, serializes to `compiled.json`. This is the desired-state input for all online commands.

```ts
// src/offline/compile.ts
export async function compile(indexesDir: string, outPath: string): Promise<void> {
  const pipelines = await loadAll(indexesDir);
  const obj = Object.fromEntries(pipelines);
  await Bun.write(outPath, JSON.stringify(obj, null, 2));
  console.log(`Compiled ${pipelines.size} pipeline(s) → ${outPath}`);
}
```

**Tasks:**
- [ ] Write `src/offline/compile.ts`
- [ ] Wire into Commander at `srb offline compile`

---

## Phase 2 — Planner (pure, no network)

Direct translation of `effects.qnt` and `plan.qnt`. All functions are pure — no I/O.

### 2.1 — Effects (`src/planner/effects.ts`)

```ts
// Mirrors effects.qnt — same function names, same logic

export function sinkConfigChanged(desired: SinkConfig, live: SinkConfig): boolean
export function sinkDataChanged(desired: SinkConfig, live: SinkConfig): boolean
export function sinkOperationalChanged(desired: SinkConfig, live: SinkConfig): boolean
export function indexConfigChanged(desired: IndexConfig, live: IndexConfig): boolean
export function transformConfigChanged(desired: TransformConfig, live: TransformConfig): boolean
export function enrichmentConfigChanged(desired: EnrichmentConfig, live: EnrichmentConfig): boolean
export function pipelineHasChanges(desired: PipelineConfig, live: LivePipelineState): boolean
export function needsBackfill(desired: PipelineConfig, live: LivePipelineState): boolean
export function needsReindex(desired: PipelineConfig, live: LivePipelineState): boolean
export function needsInPlaceUpdate(desired: PipelineConfig, live: LivePipelineState): boolean

export function effectsForCreate(pipeline: string, desired: PipelineConfig, targetColor: Color): PlannedEffect[]
export function effectsForDeleteColor(pipeline: string, live: LivePipelineState): PlannedEffect[]
export function effectsForReindex(pipeline: string, desired: PipelineConfig, sourceIndexId: string, targetColor: Color): PlannedEffect[]
export function effectsForInPlaceUpdate(pipeline: string, desired: PipelineConfig, live: LivePipelineState): PlannedEffect[]
export function effectsForUpdate(pipeline: string, desired: PipelineConfig, live: LivePipelineState, targetColor: Color): PlannedEffect[]
```

Note: `JSON.stringify` compares are fine for `mappings`/`settings` since they come from the same loader path. For transform `functionBody` and enrichment `source`, string equality is exact.

**Tasks:**
- [ ] Write `src/planner/effects.ts`

### 2.2 — Plan generator (`src/planner/plan.ts`)

```ts
export function pickTargetColor(
  pipeline: string,
  live: Map<PipelineKey, LivePipelineState>
): Color  // first Color in ALL_COLORS not in live

export function generatePlans(
  desired: Map<string, PipelineConfig>,
  live: Map<PipelineKey, LivePipelineState>,
  allColors: Color[]
): Plan[]
```

**Tasks:**
- [ ] Write `src/planner/plan.ts`

---

## Phase 3 — State discovery

### 3.1 — Sequin client (`src/sequin/client.ts`)

Thin `fetch`-based client. API token via constructor (read from env `SRB_SEQUIN_TOKEN` or `--sequin-token` flag).

```ts
export class SequinClient {
  constructor(private baseUrl: string, private token: string) {}

  async listSinks(): Promise<SinkState[]>
  async createSink(cfg: SinkConfig): Promise<SinkState>
  async updateSink(id: string, cfg: SinkConfig): Promise<SinkState>
  async deleteSink(id: string): Promise<void>
  async triggerBackfill(sinkId: string): Promise<void>

  async listTransforms(): Promise<TransformState[]>
  async createTransform(cfg: TransformConfig): Promise<TransformState>
  async deleteTransform(id: string): Promise<void>

  async listEnrichments(): Promise<EnrichmentState[]>
  async createEnrichment(cfg: EnrichmentConfig): Promise<EnrichmentState>
  async deleteEnrichment(id: string): Promise<void>
}
```

Zod schemas in `src/sequin/schemas.ts` validate API responses at runtime — catches API contract drift immediately.

**Tasks:**
- [ ] Write `src/sequin/schemas.ts` — Zod schemas for each API response shape
- [ ] Write `src/sequin/client.ts`

### 3.2 — OpenSearch client (`src/opensearch/client.ts`)

```ts
export class OpenSearchClient {
  constructor(private baseUrl: string, private auth: { user: string; password: string }) {}

  async listIndices(): Promise<IndexState[]>
  async createIndex(cfg: IndexConfig): Promise<void>
  async deleteIndex(name: string): Promise<void>
  async getAlias(pipeline: string): Promise<Color | null>
  async swapAlias(pipeline: string, from: Color | null, to: Color): Promise<void>  // atomic _aliases
  async triggerReindex(source: string, target: string): Promise<void>
}
```

**Tasks:**
- [ ] Write `src/opensearch/schemas.ts`
- [ ] Write `src/opensearch/client.ts`

### 3.3 — State discovery (`src/state/discover.ts`)

```ts
export interface LiveState {
  pipelines: Map<PipelineKey, LivePipelineState>;  // (pipeline, color) → state
  aliases: Map<string, Color>;                      // pipeline → active color
}

export async function discover(
  sequin: SequinClient,
  os: OpenSearchClient,
): Promise<LiveState>
```

Logic:
1. `sequin.listSinks()` → parse `<pipeline>_<color>` names → group by pipeline+color
2. `sequin.listTransforms()` + `listEnrichments()` → same grouping
3. `os.listIndices()` → same grouping
4. `os` alias API → build `aliases` map
5. Join all four per `(pipeline, color)` key

**Tasks:**
- [ ] Write `src/state/discover.ts`

---

## Phase 4 — Executor

### 4.1 — Executor (`src/executor/executor.ts`)

Walks `PlannedEffect[]` respecting `dependsOn` order (effects are already ordered 1..N in the spec — execute sequentially in order).

```ts
export interface ExecutorOptions {
  sequin: SequinClient;
  openSearch: OpenSearchClient;
  skipBackfill: boolean;
  dryRun: boolean;
}

export async function execute(plans: Plan[], opts: ExecutorOptions): Promise<void>
```

Effect dispatch:
- `CreateIndex` → `os.createIndex(coloredIndexConfig(effect.index, targetColor))`
- `CreateTransform` → `sequin.createTransform(coloredTransformConfig(...))`
- `CreateEnrichment` → `sequin.createEnrichment(coloredEnrichmentConfig(...))`
- `CreateSink` → `sequin.createSink(coloredSinkConfig(...))` (references transform/enrichment by colored ID)
- `UpdateSink` → `sequin.updateSink(id, cfg)`
- `DeleteSink/Transform/Enrichment/Index` → respective delete calls
- `TriggerBackfill` → skip if `skipBackfill`, else `sequin.triggerBackfill(sinkId)`
- `TriggerReindex` → `os.triggerReindex(source, target)`
- `SwapAlias` → `os.swapAlias(pipeline, currentColor, targetColor)` — atomic add+remove

Helper `coloredXxxConfig(cfg, color)` stamps color into resource names, e.g. `jobs_red`, `jobs_red-transform`.

**Tasks:**
- [ ] Write `src/executor/executor.ts`

---

## Phase 5 — Online commands

### 5.1 — `srb online plan`

```
srb online plan [--compiled ./compiled.json] [--sequin-url ...] [--sequin-token ...] [--opensearch-url ...] [--opensearch-user admin] [--opensearch-password admin] [--output text|json]
```

1. Load `compiled.json` → desired `Map<string, PipelineConfig>`
2. `discover()` → live state
3. `generatePlans(desired, live, ALL_COLORS)`
4. Print plan (human-readable table or `--output=json`)
5. Exit `0` = no changes, `2` = changes pending (Terraform convention)

**Tasks:**
- [ ] Write `src/online/plan.ts`

### 5.2 — `srb online apply`

```
srb online apply [--skip-backfill] [--auto-approve] [--compiled ./compiled.json] ...
```

1. Plan (same as above)
2. Exit `0` if no changes
3. Print plan, prompt for confirmation (skip with `--auto-approve`)
4. `execute(plans, opts)`

**Tasks:**
- [ ] Write `src/online/apply.ts`

### 5.3 — `srb online activate`

```
srb online activate <pipeline> <color>
```

Preconditions (from spec's `cmd_activate`):
- Colored variant exists in live state
- Not mid-backfill
- Index not mid-reindex

Executes atomic `SwapAlias`.

**Tasks:**
- [ ] Write `src/online/activate.ts`

### 5.4 — `srb online backfill`

```
srb online backfill <pipeline> <color>
```

Preconditions: variant exists, not already backfilling. Calls `sequin.triggerBackfill()`.

**Tasks:**
- [ ] Write `src/online/backfill.ts`

### 5.5 — `srb online drop`

```
srb online drop <pipeline> <color>
```

Preconditions: variant exists, not the active color. Runs `effectsForDeleteColor()`, executes immediately.

**Tasks:**
- [ ] Write `src/online/drop.ts`

### 5.6 — Commander wiring (`src/cli.ts`)

```
srb
  offline
    compile [--indexes] [--out]
  online
    plan      [--compiled] [connection flags] [--output]
    apply     [--compiled] [connection flags] [--skip-backfill] [--auto-approve]
    activate  <pipeline> <color> [connection flags]
    backfill  <pipeline> <color> [connection flags]
    drop      <pipeline> <color> [connection flags]
```

Persistent flags on `online`: `--compiled`, `--sequin-url`, `--sequin-token`, `--opensearch-url`, `--opensearch-user`, `--opensearch-password`. Env var fallbacks: `SRB_SEQUIN_URL`, `SRB_SEQUIN_TOKEN`, `SRB_OPENSEARCH_URL`, etc.

**Tasks:**
- [ ] Write `src/cli.ts` with full Commander tree
- [ ] Write `package.json`, `tsconfig.json`, `bunfig.toml`
- [ ] `Makefile` target: `build: bun build --compile --target=bun src/cli.ts --outfile srb`

---

## Phase 6 — Test harness

### 6.1 — Unit tests: effects + planner (`test/unit/`)

No network. Call `generatePlans()` directly with hand-crafted desired/live state.

**`test/unit/effects.test.ts`** — tests for each comparison function:
- `sinkDataChanged` / `sinkOperationalChanged` — field-level assertions
- `needsBackfill`, `needsReindex`, `needsInPlaceUpdate` — escalation logic

**`test/unit/plan.test.ts`** — scenario coverage mirroring `commands_test.qnt`:

| Scenario | Expected effects |
|---|---|
| Fresh setup (no live state) | CreateIndex, CreateTransform, CreateEnrichment, CreateSink, TriggerBackfill |
| No change (desired == live) | (empty) |
| Transform body changed | backfill path — same 5 effects as create |
| Only index mappings changed | reindex path — CreateIndex, …, TriggerReindex (no TriggerBackfill) |
| Only `batchSize` changed | in-place — UpdateSink only |
| Pipeline removed from desired | delete effects in dependency order |
| Two pipelines (jobs + clients) | independent plans, no cross-contamination |

**Tasks:**
- [ ] Write `test/unit/effects.test.ts`
- [ ] Write `test/unit/plan.test.ts` with all scenarios

### 6.2 — E2E test infrastructure (`test/e2e/`)

**`test/e2e/docker-compose.yml`** — same stack as `example/docker-compose.yml`, port-shifted to avoid conflicts:

```yaml
name: srb-test
services:
  postgres:
    image: postgres:16
    environment: { POSTGRES_DB: sequin, POSTGRES_USER: postgres, POSTGRES_PASSWORD: postgres }
    command: ["postgres", "-c", "wal_level=logical"]
    ports: ["17377:5432"]
    volumes:
      - pg_data:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres -d sequin"], interval: 5s, retries: 5 }

  redis:
    image: redis:7
    ports: ["17378:6379"]

  sequin:
    image: sequin/sequin:latest
    pull_policy: always
    ports: ["17376:7376"]
    environment:
      PG_HOSTNAME: postgres
      REDIS_URL: redis://redis:6379
      CONFIG_FILE_PATH: /config/sequin-boot.yml
      # ... (same credentials as example)
    volumes:
      - ./sequin-boot.yml:/config/sequin-boot.yml
    depends_on: { redis: ..., postgres: { condition: service_healthy } }

  opensearch:
    image: opensearchproject/opensearch:2.11.0
    environment: { discovery.type: single-node, DISABLE_SECURITY_PLUGIN: "true" }
    ports: ["19200:9200"]
    healthcheck: { test: ["CMD-SHELL", "curl -sf http://localhost:9200/_cluster/health || exit 1"], interval: 10s }

volumes: { pg_data, redis_data, opensearch_data }
```

**`test/e2e/helpers.ts`:**

```ts
// beforeAll / afterAll hooks for bun test

export async function startStack(): Promise<void>   // docker compose up -d
export async function stopStack(): Promise<void>    // docker compose down -v
export async function waitForStack(): Promise<void> // poll Sequin /health + OS /_cluster/health
export async function resetStack(): Promise<void>   // delete all test indices + sinks between tests

export interface RunResult { stdout: string; stderr: string; exitCode: number }
export async function runSRB(...args: string[]): Promise<RunResult>

export const TEST_SEQUIN_URL = "http://localhost:17376";
export const TEST_OS_URL     = "http://localhost:19200";
export const COMPILED_PATH   = "/tmp/srb-test-compiled.json";
```

**Tasks:**
- [ ] Write `test/e2e/docker-compose.yml`
- [ ] Write `test/e2e/sequin-boot.yml` (test-specific boot config, same shape as example)
- [ ] Write `test/e2e/init.sql` (creates `source` DB + `public.Job` + `public.Client` tables + replication slot + publication)
- [ ] Write `test/e2e/helpers.ts`

### 6.3 — E2E apply tests (`test/e2e/apply.test.ts`)

Each test calls `resetStack()` to start clean.

**`TestApply_FreshSetup`**
1. `runSRB("offline", "compile", "--indexes", "../../example/indexes", "--out", COMPILED_PATH)`
2. `runSRB("online", "plan", "--compiled", COMPILED_PATH, ...connFlags)` → assert exit code `2`
3. `runSRB("online", "apply", "--compiled", COMPILED_PATH, "--auto-approve", ...connFlags)`
4. Assert Sequin: sinks `jobs_red` and `clients_red` created
5. Assert OpenSearch: indices `jobs_red` and `clients_red` created
6. `runSRB("online", "plan", ...)` again → assert exit code `0`

**`TestApply_NoChange`**
1. Apply fresh setup
2. Apply again → exit code `0`, no mutations to Sequin/OS

**`TestApply_BatchSizeChange`** (in-place update)
1. Apply fresh setup
2. Modify compiled.json: change jobs `batchSize` 1000 → 500
3. `plan` → shows `UpdateSink` only
4. `apply` → Sequin sink updated; no new index, no backfill

**`TestApply_TransformChange`** (backfill path)
1. Apply fresh setup
2. Modify compiled.json: change jobs transform `functionBody`
3. `plan` → shows CreateIndex, CreateTransform, CreateEnrichment, CreateSink, TriggerBackfill
4. `apply --skip-backfill --auto-approve`
5. Assert: `jobs_black` sink + index exist; `jobs_red` still exists
6. `srb online activate jobs black` → OS alias `jobs` points to `jobs_black`
7. `srb online drop jobs red` → `jobs_red` sink + index deleted

**`TestActivate_Preconditions`**
1. Apply fresh setup (jobs_red is created but alias not yet set)
2. `activate jobs red` → succeeds (sets alias)
3. `activate jobs red` again → error: already active
4. Simulate backfilling: directly update Sequin sink to backfilling state
5. `activate jobs red` → error: mid-backfill

**`TestDrop_Active`**
1. Apply fresh setup, `activate jobs red`
2. `drop jobs red` → error: cannot drop active color

### 6.4 — Running tests

```makefile
build:
	bun build --compile --target=bun src/cli.ts --outfile srb

test-unit:
	bun test test/unit/

test-e2e:
	bun test test/e2e/ --timeout 300000

test: test-unit test-e2e
```

**Tasks:**
- [ ] Write `test/e2e/apply.test.ts` with all E2E scenarios
- [ ] Write `test/e2e/activate.test.ts`
- [ ] Write `test/e2e/drop.test.ts`
- [ ] Write `Makefile` with `build`, `test-unit`, `test-e2e`, `test` targets

---

## Phase 7 — Polish

- [ ] `srb online plan --output=json` for machine-readable output
- [ ] `--dry-run` flag on apply (print effects, skip execution)
- [ ] Structured logging via `console.error` for diagnostics, `--verbose` for debug detail
- [ ] `srb version` subcommand
- [ ] `strict: true` in `tsconfig.json`, `@typescript-eslint/no-explicit-any` lint rule

---

## Key design decisions

### Why TypeScript/Bun
- Same language as the existing `index.ts` config files and webapp — no context switch
- `await import(configFilePath)` in the compiled binary imports user `.ts` files natively — no Deno subprocess
- JSON diffing and HTTP response handling are idiomatic; no marshal/unmarshal boilerplate
- `bun build --compile` produces a single self-contained binary identical to a Go binary for distribution purposes

### Config files stay as `.ts`
`index.ts` files are imported directly. The `_defaults.ts` spread pattern works exactly as written. Adding `satisfies IndexConfig` gives compile-time validation on the config files themselves. No Deno eval, no subprocess.

### Compiled config is the desired state
`srb offline compile` is run first, producing `compiled.json`. Online commands read this file — they don't re-import `.ts` files or read `indexes/`. This keeps online commands fast, deterministic, and safe to run in CI.

### Exit codes
- `0` — success / no changes
- `1` — error
- `2` — changes pending (plan has effects). Lets CI detect config drift.

### Alias swap atomicity
`SwapAlias` sends `POST /_aliases` with `[{add: {index: "jobs_black", alias: "jobs"}}, {remove: {index: "jobs_red", alias: "jobs"}}]` in a single request. The alias is never undefined.

### `--skip-backfill`
Executor skips `TriggerBackfill` effects when set. The effect still appears in plan output. User runs `srb online backfill <pipeline> <color>` manually when ready.

### E2E tests hit the real stack
Apply tests bring up actual Postgres + Redis + Sequin + OpenSearch in `beforeAll`. No mocks. Catches API contract drift that unit tests miss. Unit tests remain pure with no network dependency.

### State discovery is convention-based
`srb` lists Sequin sinks and OpenSearch indices, parses `<pipeline>_<color>` names to reconstruct live state. No external state store. The tool is stateless.
