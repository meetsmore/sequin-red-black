# `srb` — Red-Black Deployment Orchestrator Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `srb`, a stateless CLI binary that manages red-black deployments of CDC pipelines (Postgres → Sequin → OpenSearch). Directly translates the Quint formal spec in `docs/spec/quint/` into working TypeScript.

**Architecture:** TypeScript/Bun binary with two command groups — `offline` (pure, no network) and `online` (requires Sequin + OpenSearch). Effect-centric plan/apply model mirrors the Quint spec exactly.

**Tech Stack:**
- TypeScript + Bun (compiled to single self-contained binary via `bun build --compile`)
- `commander` for CLI subcommands/flags
- `zod` for runtime validation of OpenSearch + Sequin API responses
- `js-yaml` for parsing `sink.yaml` / `transform.yaml` / `enrichment.yaml` and generating Sequin config YAML
- Sequin CLI (`sequin config plan/apply/export`) for declarative resource management (sinks, transforms, enrichments)
- Sequin REST API for imperative operations the CLI can't do (trigger backfill, query sink status)
- Bun's built-in `fetch` for HTTP (OpenSearch + Sequin API)
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
      cli.ts            # Sequin CLI wrapper (plan, apply, export via subprocess)
      api.ts            # Thin Sequin REST API client (backfill, sink status)
      schemas.ts        # Zod schemas for Sequin API responses
      yaml-gen.ts       # Generate Sequin config YAML from PipelineConfig + color
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
    harness/
      docker-compose.yml  # Test stack (shifted ports)
      sequin-boot.yml     # Boot config (account, DB, token — no sinks)
      init.sql            # Same schema as example/init.sql
      constants.ts        # Ports, URLs, token
      helpers.ts          # resetAll, deployPipeline, setAlias, triggerBackfill
      sequin-api.ts       # Thin Sequin REST client for test queries
      opensearch-api.ts   # OS REST client for test queries
      run-srb.ts          # runSRB() subprocess wrapper
    e2e/
      apply.test.ts
      activate.test.ts
      drop.test.ts
      backfill.test.ts
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

### 3.1 — Sequin CLI wrapper (`src/sequin/cli.ts`)

`srb` delegates declarative Sequin resource management to the Sequin CLI (`sequin config plan/apply/export`). The CLI wrapper shells out to `sequin` as a subprocess.

```ts
export interface SequinCLIOptions {
  context?: string;  // --context flag, or SRB_SEQUIN_CONTEXT env
}

export class SequinCLI {
  constructor(private opts: SequinCLIOptions) {}

  // Run `sequin config plan <yamlPath>` — returns stdout (plan diff)
  async plan(yamlPath: string): Promise<{ stdout: string; exitCode: number }>

  // Run `sequin config apply <yamlPath> --auto-approve`
  async apply(yamlPath: string): Promise<void>

  // Run `sequin config export` — returns parsed YAML
  async export(): Promise<SequinConfigYaml>
}
```

### 3.2 — Sequin YAML generator (`src/sequin/yaml-gen.ts`)

Generates Sequin config YAML from compiled `PipelineConfig` + target color. Output format matches `sequin-init.yml` (sinks + functions). This is the bridge between `srb`'s compiled config and `sequin config apply`.

```ts
// Generate a Sequin config YAML string for a set of colored pipeline plans.
// Each plan stamps color into resource names: jobs_red sink, jobs_red-transform, etc.
export function generateSequinYaml(
  plans: Plan[],
  desired: Map<string, PipelineConfig>,
  existingConfig?: SequinConfigYaml,  // from sequin config export, to preserve unmanaged resources
): string
```

### 3.3 — Sequin REST API client (`src/sequin/api.ts`)

Thin `fetch`-based client for imperative operations the CLI can't do. API token via constructor (read from env `SRB_SEQUIN_TOKEN` or `--sequin-token` flag).

```ts
export class SequinAPI {
  constructor(private baseUrl: string, private token: string) {}

  // Imperative operations
  async triggerBackfill(sinkId: string): Promise<void>

  // Query operations (for state discovery)
  async listSinks(): Promise<SinkInfo[]>
  async getSink(id: string): Promise<SinkInfo>
}
```

Zod schemas in `src/sequin/schemas.ts` validate API responses at runtime — catches API contract drift immediately.

**Tasks:**
- [ ] Write `src/sequin/cli.ts` — CLI subprocess wrapper
- [ ] Write `src/sequin/yaml-gen.ts` — Sequin YAML generation from plans
- [ ] Write `src/sequin/schemas.ts` — Zod schemas for Sequin API responses
- [ ] Write `src/sequin/api.ts` — thin REST client for backfill + sink queries

### 3.4 — OpenSearch client (`src/opensearch/client.ts`)

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

### 3.5 — State discovery (`src/state/discover.ts`)

```ts
export interface LiveState {
  pipelines: Map<PipelineKey, LivePipelineState>;  // (pipeline, color) → state
  aliases: Map<string, Color>;                      // pipeline → active color
}

export async function discover(
  sequinCli: SequinCLI,
  sequinApi: SequinAPI,
  os: OpenSearchClient,
): Promise<LiveState>
```

Logic:
1. `sequinCli.export()` → parse sinks/functions from exported YAML → parse `<pipeline>_<color>` names → group by pipeline+color
2. `sequinApi.listSinks()` → get runtime state (lifecycle, backfilling) not available in YAML export
3. `os.listIndices()` → same `<pipeline>_<color>` grouping
4. `os` alias API → build `aliases` map
5. Join all per `(pipeline, color)` key, merging config from CLI export with runtime state from API

**Tasks:**
- [ ] Write `src/state/discover.ts`

---

## Phase 4 — Executor

### 4.1 — Executor (`src/executor/executor.ts`)

Walks `PlannedEffect[]` respecting `dependsOn` order (effects are already ordered 1..N in the spec — execute sequentially in order).

The executor uses a two-phase approach:
1. **Sequin resources** (sinks, transforms, enrichments): Generate colored YAML via `yaml-gen.ts`, apply via `sequin config apply`. The CLI handles create/update/delete declaratively.
2. **OpenSearch resources** (indices, aliases, reindex): Direct REST API calls.
3. **Imperative operations** (backfill): Sequin REST API.

```ts
export interface ExecutorOptions {
  sequinCli: SequinCLI;
  sequinApi: SequinAPI;
  openSearch: OpenSearchClient;
  skipBackfill: boolean;
  dryRun: boolean;
}

export async function execute(
  plans: Plan[],
  desired: Map<string, PipelineConfig>,
  opts: ExecutorOptions
): Promise<void>
```

Execution flow per plan:
1. `CreateIndex` → `os.createIndex(coloredIndexConfig(effect.index, targetColor))`
2. `CreateTransform` + `CreateEnrichment` + `CreateSink` / `UpdateSink` / `Delete*` → batched into a single `sequin config apply` call via generated YAML
3. `TriggerBackfill` → skip if `skipBackfill`, else `sequinApi.triggerBackfill(sinkId)`
4. `TriggerReindex` → `os.triggerReindex(source, target)`
5. `SwapAlias` → `os.swapAlias(pipeline, currentColor, targetColor)` — atomic add+remove
6. `DeleteIndex` → `os.deleteIndex(name)` (after Sequin resources removed)

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

Persistent flags on `online`: `--compiled`, `--sequin-context` (for CLI commands), `--sequin-url`, `--sequin-token` (for API calls), `--opensearch-url`, `--opensearch-user`, `--opensearch-password`. Env var fallbacks: `SRB_SEQUIN_CONTEXT`, `SRB_SEQUIN_URL`, `SRB_SEQUIN_TOKEN`, `SRB_OPENSEARCH_URL`, etc.

**Tasks:**
- [ ] Write `src/cli.ts` with full Commander tree
- [ ] Write `package.json`, `tsconfig.json`, `bunfig.toml`
- [ ] `Makefile` target: `build: bun build --compile --target=bun src/cli.ts --outfile srb`

---

## Phase 6 — Test harness

> See `docs/superpowers/specs/2026-04-09-test-harness-design.md` for the full design spec.

E2E tests run against real Sequin + OpenSearch in Docker. The harness uses a hybrid approach: Sequin CLI for declarative state setup, Sequin REST API for imperative operations (backfill, status queries), OpenSearch REST API for indices/aliases.

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

### 6.2 — E2E test infrastructure (`test/harness/`)

**Docker stack** — port-shifted to avoid conflicts with the example stack:

| Service    | Image                              | Test Port | Internal Port |
|------------|------------------------------------|-----------|---------------|
| Postgres   | postgres:16                        | 17377     | 5432          |
| Redis      | redis:7                            | 17378     | 6379          |
| Sequin     | sequin/sequin:latest               | 17376     | 7376          |
| OpenSearch | opensearchproject/opensearch:2.11.0| 19200     | 9200          |

Postgres boots with same `init.sql` as `example/` (Job + Client tables, replication slot, seed data). Sequin boots with minimal `sequin-boot.yml` (account, DB connection, API token — no sinks/functions).

**Lifecycle:**
- `beforeAll` — `docker compose up -d`, poll Sequin `/health` + OpenSearch `/_cluster/health` until ready, configure `sequin context` named `srb-test`
- `afterEach` — `resetAll()` wipes Sequin config (empty `sequin config apply`) + deletes all OS test indices
- `afterAll` — `docker compose down -v`

**Tasks:**
- [ ] Write `test/harness/docker-compose.yml`
- [ ] Write `test/harness/sequin-boot.yml` (test-specific boot config)
- [ ] Write `test/harness/init.sql` (same schema as example)
- [ ] Write `test/harness/constants.ts` — ports, URLs, token, compiled path

### 6.3 — Test helper API (`test/harness/`)

**Seed helpers** (`test/harness/helpers.ts`) — put the system into a known starting state:

```ts
// Wipe all state: sequin config apply with empty YAML + delete all OS test indices
resetAll(): Promise<void>

// Deploy a fully provisioned colored pipeline:
// 1. Generate colored Sequin YAML (e.g. jobs_red sink + jobs_red-transform function)
// 2. sequin config apply --auto-approve --context=srb-test
// 3. Create colored OS index with mappings
// Does NOT set alias, does NOT trigger backfill (unless opts say so)
deployPipeline(pipeline: string, color: string, config: PipelineConfig, opts?: {
  backfill?: boolean;  // default false
}): Promise<void>

// Set OS alias to point pipeline -> colored index
setAlias(pipeline: string, color: string): Promise<void>

// Sequin API: trigger backfill on a sink (puts it in backfilling state)
triggerBackfill(pipeline: string, color: string): Promise<void>
```

**Run helper** (`test/harness/run-srb.ts`):

```ts
interface RunResult { stdout: string; stderr: string; exitCode: number }
runSRB(...args: string[]): Promise<RunResult>
```

**Query helpers** (`test/harness/sequin-api.ts`, `test/harness/opensearch-api.ts`):

```ts
// Sequin API queries
getSinkState(pipeline: string, color: string): Promise<SinkInfo | null>
listSinks(): Promise<SinkInfo[]>

// OpenSearch queries
getIndexState(pipeline: string, color: string): Promise<IndexInfo | null>
listIndices(): Promise<IndexInfo[]>
getAliasColor(pipeline: string): Promise<string | null>
```

Key design point: `deployPipeline` uses `sequin config apply` + OS REST directly — it does NOT call `srb`. This lets tests set up "a pipeline already exists at red" without depending on `srb` working correctly.

**Tasks:**
- [ ] Write `test/harness/helpers.ts` — resetAll, deployPipeline, setAlias, triggerBackfill
- [ ] Write `test/harness/sequin-api.ts` — Sequin REST client for test queries
- [ ] Write `test/harness/opensearch-api.ts` — OpenSearch REST client for test queries
- [ ] Write `test/harness/run-srb.ts` — subprocess wrapper

### 6.4 — E2E plan/apply tests (`test/e2e/apply.test.ts`)

Each test calls `resetAll()` in setup.

**Fresh setup** — compile → plan (exit 2) → apply → verify sinks + indices created → plan again (exit 0)

**No change** — `deployPipeline("jobs", "red")` → compile matching config → plan → exit 0

**Transform change (backfill path)** — `deployPipeline("jobs", "red")` → compile with modified transform → apply --skip-backfill → verify jobs_black created, jobs_red untouched → activate jobs black → drop jobs red

**Batch size change (in-place)** — `deployPipeline("jobs", "red")` → compile with modified batch_size → apply → verify existing sink updated, no new color

**Index mappings change (reindex path)** — `deployPipeline("jobs", "red")` → compile with modified mappings → apply → verify new color created, reindex triggered

**Multi-pipeline** — compile jobs + clients → apply → verify both created independently

**Tasks:**
- [ ] Write `test/e2e/apply.test.ts` with all scenarios

### 6.5 — E2E activate tests (`test/e2e/activate.test.ts`)

**Activate succeeds** — `deployPipeline("jobs", "red")` → activate → alias points to jobs_red

**Activate while backfilling → error** — `deployPipeline` + `triggerBackfill` → activate → non-zero exit, no alias

**Activate already active → idempotent** — `deployPipeline` + `setAlias("jobs", "red")` → activate jobs red → exit 0, alias unchanged

**Tasks:**
- [ ] Write `test/e2e/activate.test.ts`

### 6.6 — E2E drop tests (`test/e2e/drop.test.ts`)

**Drop inactive color** — deploy red + black, `setAlias("jobs", "red")` → drop black → black deleted, red untouched

**Drop active color → error** — deploy red, `setAlias("jobs", "red")` → drop red → error, nothing deleted

**Tasks:**
- [ ] Write `test/e2e/drop.test.ts`

### 6.7 — E2E backfill tests (`test/e2e/backfill.test.ts`)

**Manual backfill** — `deployPipeline("jobs", "red")` (no backfill) → `srb online backfill jobs red` → sink is backfilling

**Backfill already running → error** — `deployPipeline` + `triggerBackfill` → `srb online backfill` → error

**Tasks:**
- [ ] Write `test/e2e/backfill.test.ts`

### 6.8 — Makefile targets

```makefile
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
```

**Tasks:**
- [ ] Write `Makefile` with all targets

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

### Sequin CLI as dependency
`srb` delegates declarative resource management (create/update/delete sinks, transforms, enrichments) to the Sequin CLI (`sequin config plan/apply`). This avoids reimplementing Sequin's diffing logic and keeps `srb` focused on orchestrating the red-black flow. The Sequin REST API is only used for imperative operations the CLI can't do (trigger backfill, query sink runtime status like backfilling state).

### E2E tests hit the real stack
Tests bring up actual Postgres + Redis + Sequin + OpenSearch in Docker. No mocks. The test harness seeds state using the same tools `srb` uses (Sequin CLI + REST API + OpenSearch REST). Catches API contract drift that unit tests miss. Unit tests remain pure with no network dependency.

### State discovery is convention-based
`srb` uses `sequin config export` + `sequin` API + OpenSearch API, parses `<pipeline>_<color>` names to reconstruct live state. No external state store. The tool is stateless.
