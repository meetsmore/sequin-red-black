# Pipeline Syncs TypeScript Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement sync support in the SRB TypeScript codebase so subordinate webhook sinks follow their parent pipeline's color lifecycle — matching the Quint spec in `docs/spec/quint/`.

**Architecture:** Add `SyncConfig` and `LiveSyncState` types to `config/types.ts`, extend the config loader to read `syncs/` subdirectories, extend effect generation and comparison functions in `planner/effects.ts`, update YAML generation to emit sync sinks/functions, update state discovery to detect live syncs, and update the plan formatter. All pure planner changes are TDD against `test/unit/effects.test.ts` and `test/unit/plan.test.ts`.

**Tech Stack:** TypeScript, Bun (runtime + test runner), js-yaml, Sequin CLI/API, OpenSearch REST API.

**Test commands:**
- Unit tests: `cd srb && bun test test/unit/`
- Typecheck: `cd srb && bun run typecheck`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `srb/src/config/types.ts` | Modify | Add `SyncConfig`, `LiveSyncState`, extend `PipelineConfig` and `LivePipelineState` |
| `srb/src/config/loader.ts` | Modify | Load `syncs/` subdirectories within each pipeline |
| `srb/src/planner/effects.ts` | Modify | Add `syncHasChanges`, extend `pipelineHasChanges`, extend effect generators |
| `srb/src/planner/plan.ts` | No change | Plan generation works unchanged — delegates to effects |
| `srb/src/planner/format.ts` | Modify | Format sync resources in plan output |
| `srb/src/executor/executor.ts` | No change | Already handles Create/Delete effects generically |
| `srb/src/sequin/yaml-gen.ts` | Modify | Generate sync sink + function entries in Sequin YAML |
| `srb/src/state/discover.ts` | Modify | Detect and reconstruct sync live state from Sequin export |
| `srb/test/unit/effects.test.ts` | Modify | Add sync-specific comparison and effect tests |
| `srb/test/unit/plan.test.ts` | Modify | Add sync-aware plan generation tests |

---

### Task 1: Add sync types to config/types.ts

**Files:**
- Modify: `srb/src/config/types.ts`

- [ ] **Step 1: Add SyncConfig interface**

Add after `PipelineConfig`:

```typescript
export interface SyncConfig {
  name: string;
  sink: SinkConfig;
  transform: TransformConfig;
  enrichment: EnrichmentConfig;
}
```

- [ ] **Step 2: Add LiveSyncState interface**

Add after `LivePipelineState`:

```typescript
export interface LiveSyncState {
  sink: SinkState;
  transform: TransformState;
  enrichment: EnrichmentState;
}
```

- [ ] **Step 3: Add `syncs` field to PipelineConfig**

Change:

```typescript
export interface PipelineConfig {
  name: string;
  sink: SinkConfig;
  index: IndexConfig;
  transform: TransformConfig;
  enrichment: EnrichmentConfig;
}
```

to:

```typescript
export interface PipelineConfig {
  name: string;
  sink: SinkConfig;
  index: IndexConfig;
  transform: TransformConfig;
  enrichment: EnrichmentConfig;
  syncs: SyncConfig[];
}
```

- [ ] **Step 4: Add `syncs` field to LivePipelineState**

Change:

```typescript
export interface LivePipelineState {
  sink: SinkState;
  index: IndexState;
  transform: TransformState;
  enrichment: EnrichmentState;
}
```

to:

```typescript
export interface LivePipelineState {
  sink: SinkState;
  index: IndexState;
  transform: TransformState;
  enrichment: EnrichmentState;
  syncs: LiveSyncState[];
}
```

- [ ] **Step 5: Run typecheck to see what breaks**

Run: `cd srb && bun run typecheck 2>&1 | head -50`

Expected: Type errors in loader.ts, effects.ts, plan.test.ts, effects.test.ts, discover.ts, yaml-gen.ts, format.ts — anywhere that constructs PipelineConfig or LivePipelineState without `syncs`.

- [ ] **Step 6: Commit**

```bash
cd srb && git add src/config/types.ts
git commit -m "feat: add SyncConfig and LiveSyncState types"
```

---

### Task 2: Fix all existing code to include `syncs: []`

Every place that constructs a `PipelineConfig` or `LivePipelineState` must include `syncs: []`.

**Files:**
- Modify: `srb/src/config/loader.ts`
- Modify: `srb/src/state/discover.ts`
- Modify: `srb/test/unit/effects.test.ts`
- Modify: `srb/test/unit/plan.test.ts`

- [ ] **Step 1: Fix loader.ts**

In `loadPipeline()`, the return statement constructs a `PipelineConfig`. Add `syncs: []`:

Change the return statement at the end of `loadPipeline` (around line 51) from:

```typescript
  return {
    name,
    sink: {
```

Add `syncs: [],` as the last field before the closing `};` of the return object.

- [ ] **Step 2: Fix discover.ts**

In `discoverLiveState()`, the code constructs a `LivePipelineState` and puts it in the map (around line 192). Add `syncs: []`:

Change:

```typescript
      pipelines.set(key, {
        sink: { config: sinkConfig, lifecycle, backfilling },
        index: {
          config: indexConfig,
          status: indexStatus,
          docCount: osIndex?.docCount ?? 0,
        },
        transform: {
          config: transformConfig,
          status: transformFn ? "active" : "inactive",
        },
        enrichment: {
          config: enrichmentConfig,
          status: enrichmentFn ? "active" : "inactive",
        },
      });
```

to:

```typescript
      pipelines.set(key, {
        sink: { config: sinkConfig, lifecycle, backfilling },
        index: {
          config: indexConfig,
          status: indexStatus,
          docCount: osIndex?.docCount ?? 0,
        },
        transform: {
          config: transformConfig,
          status: transformFn ? "active" : "inactive",
        },
        enrichment: {
          config: enrichmentConfig,
          status: enrichmentFn ? "active" : "inactive",
        },
        syncs: [],
      });
```

- [ ] **Step 3: Fix test fixtures in effects.test.ts**

Add `syncs: [],` to `fixturePipeline()`:

```typescript
function fixturePipeline(overrides?: {
  sink?: Partial<SinkConfig>;
  index?: Partial<IndexConfig>;
  transform?: Partial<TransformConfig>;
  enrichment?: Partial<EnrichmentConfig>;
}): PipelineConfig {
  return {
    name: "jobs",
    sink: fixtureSink(overrides?.sink),
    index: fixtureIndex(overrides?.index),
    transform: fixtureTransform(overrides?.transform),
    enrichment: fixtureEnrichment(overrides?.enrichment),
    syncs: [],
  };
}
```

Add `syncs: [],` to `fixtureLiveState()`:

```typescript
function fixtureLiveState(overrides?: {
  sink?: Partial<SinkConfig>;
  index?: Partial<IndexConfig>;
  transform?: Partial<TransformConfig>;
  enrichment?: Partial<EnrichmentConfig>;
}): LivePipelineState {
  return {
    sink: { config: fixtureSink(overrides?.sink), lifecycle: "active", backfilling: false },
    index: { config: fixtureIndex(overrides?.index), status: "green", docCount: 100 },
    transform: { config: fixtureTransform(overrides?.transform), status: "active" },
    enrichment: { config: fixtureEnrichment(overrides?.enrichment), status: "active" },
    syncs: [],
  };
}
```

- [ ] **Step 4: Fix test fixtures in plan.test.ts**

Search for every `PipelineConfig` and `LivePipelineState` literal in `test/unit/plan.test.ts` and add `syncs: []`. There will be fixture functions similar to effects.test.ts — add the field to each.

- [ ] **Step 5: Run typecheck**

Run: `cd srb && bun run typecheck`

Expected: No errors.

- [ ] **Step 6: Run tests**

Run: `cd srb && bun test test/unit/`

Expected: All existing tests pass.

- [ ] **Step 7: Commit**

```bash
cd srb && git add -A
git commit -m "fix: add syncs: [] to all PipelineConfig and LivePipelineState constructors"
```

---

### Task 3: Add sync change detection and extend effect generation (TDD)

**Files:**
- Modify: `srb/src/planner/effects.ts`
- Modify: `srb/test/unit/effects.test.ts`

- [ ] **Step 1: Add sync fixture helpers to effects.test.ts**

Add after the existing fixture functions (after `fixtureLiveState`):

```typescript
import type { SyncConfig, LiveSyncState } from "../../src/config/types.js";

function fixtureSyncSink(overrides?: Partial<SinkConfig>): SinkConfig {
  return {
    id: "sink-addr-to-jobs-red",
    name: "address_to_jobs_red",
    sourceTable: "public.Address",
    destination: "opensearch://localhost:9200/_update_by_query",
    filters: "",
    batchSize: 1,
    transformId: "transform-addr-to-jobs-red",
    enrichmentIds: ["enrichment-addr-to-jobs-red"],
    ...overrides,
  };
}

function fixtureSyncTransform(overrides?: Partial<TransformConfig>): TransformConfig {
  return {
    id: "transform-addr-to-jobs-red",
    name: "address_to_jobs_red-transform",
    functionBody: 'fn(record) { return { query: record.address }; }',
    inputSchema: "public.Address",
    outputSchema: "jobs",
    ...overrides,
  };
}

function fixtureSyncEnrichment(overrides?: Partial<EnrichmentConfig>): EnrichmentConfig {
  return {
    id: "enrichment-addr-to-jobs-red",
    name: "address_to_jobs_red-enrichment",
    source: "public.Address",
    joinColumn: "id",
    enrichmentColumns: "street",
    ...overrides,
  };
}

function fixtureSync(overrides?: {
  sink?: Partial<SinkConfig>;
  transform?: Partial<TransformConfig>;
  enrichment?: Partial<EnrichmentConfig>;
}): SyncConfig {
  return {
    name: "address_to_jobs",
    sink: fixtureSyncSink(overrides?.sink),
    transform: fixtureSyncTransform(overrides?.transform),
    enrichment: fixtureSyncEnrichment(overrides?.enrichment),
  };
}

function fixtureLiveSyncState(overrides?: {
  sink?: Partial<SinkConfig>;
  transform?: Partial<TransformConfig>;
  enrichment?: Partial<EnrichmentConfig>;
}): LiveSyncState {
  return {
    sink: { config: fixtureSyncSink(overrides?.sink), lifecycle: "active", backfilling: false },
    transform: { config: fixtureSyncTransform(overrides?.transform), status: "active" },
    enrichment: { config: fixtureSyncEnrichment(overrides?.enrichment), status: "active" },
  };
}

function fixturePipelineWithSync(overrides?: {
  sink?: Partial<SinkConfig>;
  index?: Partial<IndexConfig>;
  transform?: Partial<TransformConfig>;
  enrichment?: Partial<EnrichmentConfig>;
}): PipelineConfig {
  return {
    ...fixturePipeline(overrides),
    syncs: [fixtureSync()],
  };
}

function fixtureLiveStateWithSync(overrides?: {
  sink?: Partial<SinkConfig>;
  index?: Partial<IndexConfig>;
  transform?: Partial<TransformConfig>;
  enrichment?: Partial<EnrichmentConfig>;
}): LivePipelineState {
  return {
    ...fixtureLiveState(overrides),
    syncs: [fixtureLiveSyncState()],
  };
}
```

- [ ] **Step 2: Write failing tests for syncHasChanges**

Add to effects.test.ts:

```typescript
import {
  syncHasChanges,
  pipelineHasChanges,
} from "../../src/planner/effects.js";

describe("syncHasChanges", () => {
  test("detects sink change", () => {
    const desired = fixtureSync({ sink: { filters: "status = active" } });
    const live = fixtureLiveSyncState();
    expect(syncHasChanges(desired, live)).toBe(true);
  });

  test("detects transform change", () => {
    const desired = fixtureSync({ transform: { functionBody: "fn(r) { return r; }" } });
    const live = fixtureLiveSyncState();
    expect(syncHasChanges(desired, live)).toBe(true);
  });

  test("detects enrichment change", () => {
    const desired = fixtureSync({ enrichment: { source: "public.Contact" } });
    const live = fixtureLiveSyncState();
    expect(syncHasChanges(desired, live)).toBe(true);
  });

  test("returns false when identical", () => {
    const desired = fixtureSync();
    const live = fixtureLiveSyncState();
    expect(syncHasChanges(desired, live)).toBe(false);
  });
});
```

- [ ] **Step 3: Write failing tests for extended pipelineHasChanges**

```typescript
describe("pipelineHasChanges — syncs", () => {
  test("detects sync added", () => {
    const desired = fixturePipelineWithSync();
    const live = fixtureLiveState(); // no syncs
    expect(pipelineHasChanges(desired, live)).toBe(true);
  });

  test("detects sync removed", () => {
    const desired = fixturePipeline(); // no syncs
    const live = fixtureLiveStateWithSync();
    expect(pipelineHasChanges(desired, live)).toBe(true);
  });

  test("detects sync config changed", () => {
    const desired: PipelineConfig = {
      ...fixturePipelineWithSync(),
      syncs: [fixtureSync({ sink: { filters: "new_filter" } })],
    };
    const live = fixtureLiveStateWithSync();
    expect(pipelineHasChanges(desired, live)).toBe(true);
  });

  test("no change when syncs match", () => {
    const desired = fixturePipelineWithSync();
    const live = fixtureLiveStateWithSync();
    expect(pipelineHasChanges(desired, live)).toBe(false);
  });
});
```

- [ ] **Step 4: Write failing tests for sync effects**

```typescript
describe("effectsForCreate — with syncs", () => {
  test("produces 8 effects (5 primary + 3 sync)", () => {
    const pipeline = fixturePipelineWithSync();
    const effects = effectsForCreate("jobs", pipeline, "red");
    expect(effects).toHaveLength(8);
  });

  test("sync effects follow primary effects", () => {
    const pipeline = fixturePipelineWithSync();
    const effects = effectsForCreate("jobs", pipeline, "red");
    // Primary: CreateIndex(1), CreateTransform(2), CreateEnrichment(3), CreateSink(4), TriggerBackfill(5)
    // Sync: CreateTransform(6), CreateEnrichment(7), CreateSink(8)
    expect(effects[5].effect.kind).toBe("CreateTransform");
    expect(effects[6].effect.kind).toBe("CreateEnrichment");
    expect(effects[7].effect.kind).toBe("CreateSink");
  });

  test("sync sink depends on index creation", () => {
    const pipeline = fixturePipelineWithSync();
    const effects = effectsForCreate("jobs", pipeline, "red");
    expect(effects[7].dependsOn).toContain(1); // depends on CreateIndex (order 1)
  });
});

describe("effectsForDeleteColor — with syncs", () => {
  test("produces 7 effects (3 sync + 4 primary)", () => {
    const live = fixtureLiveStateWithSync();
    const effects = effectsForDeleteColor("jobs", live, "red");
    expect(effects).toHaveLength(7);
  });

  test("sync deletes come before primary deletes", () => {
    const live = fixtureLiveStateWithSync();
    const effects = effectsForDeleteColor("jobs", live, "red");
    // First 3 are sync deletes, last 4 are primary
    expect(effects[0].effect.kind).toBe("DeleteSink");
    expect(effects[3].effect.kind).toBe("DeleteSink"); // primary sink delete
    expect(effects[6].effect.kind).toBe("DeleteIndex"); // index last
  });
});

describe("needsBackfill — sync changes", () => {
  test("sync-only change does NOT trigger backfill", () => {
    const desired = fixturePipelineWithSync();
    const live = fixtureLiveStateWithSync();
    // Primary config matches, only sync count differs would be caught by pipelineHasChanges
    expect(needsBackfill(desired, live)).toBe(false);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `cd srb && bun test test/unit/effects.test.ts`

Expected: FAIL — `syncHasChanges` not exported, `pipelineHasChanges` not exported.

- [ ] **Step 6: Implement syncHasChanges in effects.ts**

Add after `enrichmentConfigChanged`:

```typescript
/** Compare a sync's config against its live state */
export function syncHasChanges(desired: SyncConfig, live: LiveSyncState): boolean {
  return (
    sinkConfigChanged(desired.sink, live.sink.config) ||
    transformConfigChanged(desired.transform, live.transform.config) ||
    enrichmentConfigChanged(desired.enrichment, live.enrichment.config)
  );
}
```

Add the imports at the top:

```typescript
import {
  type SyncConfig,
  type LiveSyncState,
  // ... existing imports
} from "../config/types.js";
```

- [ ] **Step 7: Extend pipelineHasChanges in effects.ts**

Change:

```typescript
export function pipelineHasChanges(desired: PipelineConfig, live: LivePipelineState): boolean {
  return (
    sinkConfigChanged(desired.sink, live.sink.config) ||
    indexConfigChanged(desired.index, live.index.config) ||
    transformConfigChanged(desired.transform, live.transform.config) ||
    enrichmentConfigChanged(desired.enrichment, live.enrichment.config)
  );
}
```

to:

```typescript
export function pipelineHasChanges(desired: PipelineConfig, live: LivePipelineState): boolean {
  return (
    sinkConfigChanged(desired.sink, live.sink.config) ||
    indexConfigChanged(desired.index, live.index.config) ||
    transformConfigChanged(desired.transform, live.transform.config) ||
    enrichmentConfigChanged(desired.enrichment, live.enrichment.config) ||
    desired.syncs.length !== live.syncs.length ||
    desired.syncs.some((sync, i) => i < live.syncs.length && syncHasChanges(sync, live.syncs[i]))
  );
}
```

- [ ] **Step 8: Extend effectsForCreate in effects.ts**

Change:

```typescript
export function effectsForCreate(
  _pipeline: string,
  desired: PipelineConfig,
  _targetColor: Color,
): PlannedEffect[] {
  return [
    { effect: { kind: "CreateIndex", index: desired.index }, status: "pending", dependsOn: [], order: 1 },
    { effect: { kind: "CreateTransform", transform: desired.transform }, status: "pending", dependsOn: [], order: 2 },
    { effect: { kind: "CreateEnrichment", enrichment: desired.enrichment }, status: "pending", dependsOn: [], order: 3 },
    { effect: { kind: "CreateSink", sink: desired.sink }, status: "pending", dependsOn: [1, 2, 3], order: 4 },
    { effect: { kind: "TriggerBackfill", sinkId: desired.sink.id }, status: "pending", dependsOn: [4], order: 5 },
  ];
}
```

to:

```typescript
export function effectsForCreate(
  _pipeline: string,
  desired: PipelineConfig,
  _targetColor: Color,
): PlannedEffect[] {
  const primary: PlannedEffect[] = [
    { effect: { kind: "CreateIndex", index: desired.index }, status: "pending", dependsOn: [], order: 1 },
    { effect: { kind: "CreateTransform", transform: desired.transform }, status: "pending", dependsOn: [], order: 2 },
    { effect: { kind: "CreateEnrichment", enrichment: desired.enrichment }, status: "pending", dependsOn: [], order: 3 },
    { effect: { kind: "CreateSink", sink: desired.sink }, status: "pending", dependsOn: [1, 2, 3], order: 4 },
    { effect: { kind: "TriggerBackfill", sinkId: desired.sink.id }, status: "pending", dependsOn: [4], order: 5 },
  ];
  const syncEffects: PlannedEffect[] = [];
  for (const sync of desired.syncs) {
    const base = 5 + syncEffects.length;
    syncEffects.push(
      { effect: { kind: "CreateTransform", transform: sync.transform }, status: "pending", dependsOn: [], order: base + 1 },
      { effect: { kind: "CreateEnrichment", enrichment: sync.enrichment }, status: "pending", dependsOn: [], order: base + 2 },
      { effect: { kind: "CreateSink", sink: sync.sink }, status: "pending", dependsOn: [1, base + 1, base + 2], order: base + 3 },
    );
  }
  return [...primary, ...syncEffects];
}
```

- [ ] **Step 9: Extend effectsForDeleteColor in effects.ts**

Change:

```typescript
export function effectsForDeleteColor(
  _pipeline: string,
  live: LivePipelineState,
  _color: Color,
): PlannedEffect[] {
  return [
    { effect: { kind: "DeleteSink", id: live.sink.config.id }, status: "pending", dependsOn: [], order: 1 },
    { effect: { kind: "DeleteTransform", id: live.transform.config.id }, status: "pending", dependsOn: [1], order: 2 },
    { effect: { kind: "DeleteEnrichment", id: live.enrichment.config.id }, status: "pending", dependsOn: [1], order: 3 },
    { effect: { kind: "DeleteIndex", id: live.index.config.id }, status: "pending", dependsOn: [1, 2, 3], order: 4 },
  ];
}
```

to:

```typescript
export function effectsForDeleteColor(
  _pipeline: string,
  live: LivePipelineState,
  _color: Color,
): PlannedEffect[] {
  // Delete sync resources first
  const syncDeletes: PlannedEffect[] = [];
  for (const sync of live.syncs) {
    const base = syncDeletes.length;
    syncDeletes.push(
      { effect: { kind: "DeleteSink", id: sync.sink.config.id }, status: "pending", dependsOn: [], order: base + 1 },
      { effect: { kind: "DeleteTransform", id: sync.transform.config.id }, status: "pending", dependsOn: [base + 1], order: base + 2 },
      { effect: { kind: "DeleteEnrichment", id: sync.enrichment.config.id }, status: "pending", dependsOn: [base + 1], order: base + 3 },
    );
  }
  const pBase = syncDeletes.length;
  const primaryDeletes: PlannedEffect[] = [
    { effect: { kind: "DeleteSink", id: live.sink.config.id }, status: "pending", dependsOn: [], order: pBase + 1 },
    { effect: { kind: "DeleteTransform", id: live.transform.config.id }, status: "pending", dependsOn: [pBase + 1], order: pBase + 2 },
    { effect: { kind: "DeleteEnrichment", id: live.enrichment.config.id }, status: "pending", dependsOn: [pBase + 1], order: pBase + 3 },
    { effect: { kind: "DeleteIndex", id: live.index.config.id }, status: "pending", dependsOn: [pBase + 1, pBase + 2, pBase + 3], order: pBase + 4 },
  ];
  return [...syncDeletes, ...primaryDeletes];
}
```

- [ ] **Step 10: Extend effectsForReindex in effects.ts**

Apply the same sync pattern as effectsForCreate (add sync create effects after primary effects). The sync effects are identical — syncs need to be created alongside the new color regardless of whether it's a backfill or reindex:

```typescript
export function effectsForReindex(
  _pipeline: string,
  desired: PipelineConfig,
  sourceIndexId: string,
  _targetColor: Color,
): PlannedEffect[] {
  const primary: PlannedEffect[] = [
    { effect: { kind: "CreateIndex", index: desired.index }, status: "pending", dependsOn: [], order: 1 },
    { effect: { kind: "CreateTransform", transform: desired.transform }, status: "pending", dependsOn: [], order: 2 },
    { effect: { kind: "CreateEnrichment", enrichment: desired.enrichment }, status: "pending", dependsOn: [], order: 3 },
    { effect: { kind: "CreateSink", sink: desired.sink }, status: "pending", dependsOn: [1, 2, 3], order: 4 },
    { effect: { kind: "TriggerReindex", source: sourceIndexId, target: desired.index.id }, status: "pending", dependsOn: [1, 4], order: 5 },
  ];
  const syncEffects: PlannedEffect[] = [];
  for (const sync of desired.syncs) {
    const base = 5 + syncEffects.length;
    syncEffects.push(
      { effect: { kind: "CreateTransform", transform: sync.transform }, status: "pending", dependsOn: [], order: base + 1 },
      { effect: { kind: "CreateEnrichment", enrichment: sync.enrichment }, status: "pending", dependsOn: [], order: base + 2 },
      { effect: { kind: "CreateSink", sink: sync.sink }, status: "pending", dependsOn: [1, base + 1, base + 2], order: base + 3 },
    );
  }
  return [...primary, ...syncEffects];
}
```

- [ ] **Step 11: Run tests**

Run: `cd srb && bun test test/unit/effects.test.ts`

Expected: All tests pass including new sync tests.

- [ ] **Step 12: Run typecheck**

Run: `cd srb && bun run typecheck`

Expected: No errors.

- [ ] **Step 13: Commit**

```bash
cd srb && git add src/planner/effects.ts test/unit/effects.test.ts
git commit -m "feat: add sync change detection and extend effect generation"
```

---

### Task 4: Extend config loader to read syncs/ subdirectories

**Files:**
- Modify: `srb/src/config/loader.ts`

- [ ] **Step 1: Add sync loading logic to loadPipeline**

The loader currently reads `sink.yaml`, `transform.yaml`, `enrichment.yaml`, and `index.ts` from each pipeline directory. Extend it to also check for a `syncs/` subdirectory. Each sync subdirectory has the same structure as a pipeline but without `index.ts`.

Change `loadPipeline` to:

```typescript
export async function loadPipeline(name: string, indexesDir: string): Promise<PipelineConfig> {
  const dir = path.join(indexesDir, name);

  // 1. Import index.ts
  const indexModule = await import(path.resolve(dir, "index.ts"));
  const indexExport = indexModule.default as { mappings: Record<string, unknown>; settings: Record<string, unknown> };

  // 2. Read sink.yaml
  const sinkYaml = yaml.load(await Bun.file(path.join(dir, "sink.yaml")).text()) as RawSinkYaml;

  // 3. Read transform.yaml + inline code file
  const transformYaml = yaml.load(await Bun.file(path.join(dir, "transform.yaml")).text()) as RawFunctionYaml;
  const transformBody = await Bun.file(path.join(dir, transformYaml.code_file)).text();

  // 4. Read enrichment.yaml + inline code file
  const enrichmentYaml = yaml.load(await Bun.file(path.join(dir, "enrichment.yaml")).text()) as RawFunctionYaml;
  const enrichmentSql = await Bun.file(path.join(dir, enrichmentYaml.code_file)).text();

  // 5. Load syncs from syncs/ subdirectory (if it exists)
  const syncs = await loadSyncs(dir);

  return {
    name,
    sink: {
      id: name,
      name: sinkYaml.name,
      sourceTable: sinkYaml.table,
      destination: sinkYaml.destination.endpoint_url,
      filters: "",
      batchSize: sinkYaml.batch_size,
      transformId: transformYaml.name,
      enrichmentIds: [enrichmentYaml.name],
    },
    index: {
      id: name,
      name,
      mappings: indexExport.mappings,
      settings: indexExport.settings,
      alias: name,
    },
    transform: {
      id: transformYaml.name,
      name: transformYaml.name,
      functionBody: transformBody.trim(),
      inputSchema: "{}",
      outputSchema: "{}",
    },
    enrichment: {
      id: enrichmentYaml.name,
      name: enrichmentYaml.name,
      source: enrichmentSql.trim(),
      joinColumn: "",
      enrichmentColumns: "",
    },
    syncs,
  };
}
```

- [ ] **Step 2: Add loadSyncs helper**

Add before `loadPipeline`:

```typescript
import type { PipelineConfig, SyncConfig } from "./types.js";

async function loadSyncs(pipelineDir: string): Promise<SyncConfig[]> {
  const syncsDir = path.join(pipelineDir, "syncs");
  try {
    const entries = await readdir(syncsDir, { withFileTypes: true });
    const syncDirs = entries.filter(e => e.isDirectory() && !e.name.startsWith("_"));
    const syncs = await Promise.all(syncDirs.map(e => loadSync(e.name, syncsDir)));
    return syncs;
  } catch {
    // No syncs/ directory — pipeline has no syncs
    return [];
  }
}

async function loadSync(name: string, syncsDir: string): Promise<SyncConfig> {
  const dir = path.join(syncsDir, name);

  const sinkYaml = yaml.load(await Bun.file(path.join(dir, "sink.yaml")).text()) as RawSinkYaml;
  const transformYaml = yaml.load(await Bun.file(path.join(dir, "transform.yaml")).text()) as RawFunctionYaml;
  const transformBody = await Bun.file(path.join(dir, transformYaml.code_file)).text();
  const enrichmentYaml = yaml.load(await Bun.file(path.join(dir, "enrichment.yaml")).text()) as RawFunctionYaml;
  const enrichmentSql = await Bun.file(path.join(dir, enrichmentYaml.code_file)).text();

  return {
    name,
    sink: {
      id: name,
      name: sinkYaml.name,
      sourceTable: sinkYaml.table ?? "",
      destination: sinkYaml.destination?.endpoint_url ?? "",
      filters: "",
      batchSize: sinkYaml.batch_size ?? 1,
      transformId: transformYaml.name,
      enrichmentIds: [enrichmentYaml.name],
    },
    transform: {
      id: transformYaml.name,
      name: transformYaml.name,
      functionBody: transformBody.trim(),
      inputSchema: "{}",
      outputSchema: "{}",
    },
    enrichment: {
      id: enrichmentYaml.name,
      name: enrichmentYaml.name,
      source: enrichmentSql.trim(),
      joinColumn: "",
      enrichmentColumns: "",
    },
  };
}
```

- [ ] **Step 3: Update the import for SyncConfig**

At the top of loader.ts, update the import:

```typescript
import type { PipelineConfig, SyncConfig } from "./types.js";
```

- [ ] **Step 4: Run typecheck**

Run: `cd srb && bun run typecheck`

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
cd srb && git add src/config/loader.ts
git commit -m "feat: extend config loader to read syncs/ subdirectories"
```

---

### Task 5: Extend YAML generation for syncs

**Files:**
- Modify: `srb/src/sequin/yaml-gen.ts`

- [ ] **Step 1: Add sync sink and function generation**

In `generateSequinYaml`, after the primary sink/transform/enrichment generation (after the `functions.push` for enrichment, around line 103), add sync generation:

```typescript
    // Generate sync entries
    for (const sync of cfg.syncs) {
      const syncColoredName = `${sync.name}_${plan.targetColor}`;
      const syncTransformName = `${syncColoredName}-transform`;
      const syncEnrichmentName = `${syncColoredName}-enrichment`;

      managedSinkNames.add(syncColoredName);
      managedFunctionNames.add(syncTransformName);
      managedFunctionNames.add(syncEnrichmentName);

      sinks.push({
        name: syncColoredName,
        database: "source-db",
        table: sync.sink.sourceTable,
        batch_size: sync.sink.batchSize,
        status: "active",
        actions: ["insert", "update", "delete"],
        timestamp_format: "iso8601",
        message_grouping: true,
        load_shedding_policy: "pause_on_full",
        destination: {
          type: "webhook",
          endpoint_url: sync.sink.destination,
          index_name: "",
          auth_type: "none",
          auth_value: "",
          batch_size: sync.sink.batchSize,
        },
        transform: syncTransformName,
        enrichment: syncEnrichmentName,
      });

      functions.push({
        name: syncTransformName,
        type: "transform",
        code: sync.transform.functionBody,
      });

      functions.push({
        name: syncEnrichmentName,
        type: "enrichment",
        code: sync.enrichment.source,
      });
    }
```

- [ ] **Step 2: Run typecheck**

Run: `cd srb && bun run typecheck`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd srb && git add src/sequin/yaml-gen.ts
git commit -m "feat: extend YAML generation to include sync sinks and functions"
```

---

### Task 6: Extend state discovery to detect live syncs

**Files:**
- Modify: `srb/src/state/discover.ts`

- [ ] **Step 1: Detect sync sinks from exported config**

The current logic in `discoverLiveState` iterates over exported sinks and parses `<pipeline>_<color>` names. Sync sinks have names like `<sync_name>_<color>` (e.g., `address_to_jobs_red`). We need to recognize these as children of their parent pipeline.

The approach: after building the primary pipeline states, make a second pass over sinks to find syncs. A sync is a sink whose name matches `<known_sync_name>_<color>` where `<known_sync_name>` is a sync name from the desired config.

Add after the existing sink processing loop (after the `}` of `if (Array.isArray(exportedConfig.sinks))`) and before alias resolution:

```typescript
  // Second pass: detect sync sinks and attach them to their parent pipeline
  if (desired && Array.isArray(exportedConfig.sinks)) {
    for (const sinkEntry of exportedConfig.sinks) {
      const s = sinkEntry as Record<string, unknown>;
      const sinkName = s.name as string;
      if (!sinkName) continue;

      const parsed = parseColoredName(sinkName);
      if (!parsed) continue;

      // Check if this is a known sync name
      for (const [pipelineName, pipelineCfg] of desired) {
        for (const syncCfg of pipelineCfg.syncs) {
          if (parsed.pipeline !== syncCfg.name) continue;

          const parentKey = pipelineKey(pipelineName, parsed.color);
          const parentState = pipelines.get(parentKey);
          if (!parentState) continue;

          // Build sync live state
          const sinkInfo = sinkInfoByName.get(sinkName);
          const colorPrefix = `${syncCfg.name}_${parsed.color}`;
          const transformRef = (s.transform as string) ?? "";
          const enrichmentRef = s.enrichment ? (s.enrichment as string) : "";

          const baseTransformId = transformRef.startsWith(colorPrefix)
            ? syncCfg.name + transformRef.slice(colorPrefix.length)
            : transformRef;
          const baseEnrichmentId = enrichmentRef.startsWith(colorPrefix)
            ? syncCfg.name + enrichmentRef.slice(colorPrefix.length)
            : enrichmentRef;

          const syncSinkConfig: SinkConfig = {
            id: sinkInfo?.id ?? sinkName,
            name: syncCfg.name,
            sourceTable: (s.table as string) ?? "",
            destination: ((s.destination as Record<string, unknown>)?.endpoint_url as string) ?? "",
            filters: "",
            batchSize: (s.batch_size as number) ?? 1,
            transformId: baseTransformId,
            enrichmentIds: baseEnrichmentId ? [baseEnrichmentId] : [],
          };

          const syncTransformName = `${syncCfg.name}_${parsed.color}-transform`;
          const syncTransformFn = functionsByName.get(syncTransformName);
          const syncTransformConfig: TransformConfig = {
            id: syncTransformName,
            name: `${syncCfg.name}-transform`,
            functionBody: ((syncTransformFn?.code as string) ?? "").trim(),
            inputSchema: "{}",
            outputSchema: "{}",
          };

          const syncEnrichmentName = `${syncCfg.name}_${parsed.color}-enrichment`;
          const syncEnrichmentFn = functionsByName.get(syncEnrichmentName);
          const syncEnrichmentConfig: EnrichmentConfig = {
            id: syncEnrichmentName,
            name: `${syncCfg.name}-enrichment`,
            source: ((syncEnrichmentFn?.code as string) ?? "").trim(),
            joinColumn: "",
            enrichmentColumns: "",
          };

          const syncLifecycle: SinkLifecycle = sinkInfo?.status ?? "active";
          const syncBackfilling = sinkInfo ? isBackfilling(sinkInfo) : false;

          parentState.syncs.push({
            sink: { config: syncSinkConfig, lifecycle: syncLifecycle, backfilling: syncBackfilling },
            transform: { config: syncTransformConfig, status: syncTransformFn ? "active" : "inactive" },
            enrichment: { config: syncEnrichmentConfig, status: syncEnrichmentFn ? "active" : "inactive" },
          });
        }
      }
    }
  }
```

- [ ] **Step 2: Add LiveSyncState to imports**

Update the imports at the top of discover.ts:

```typescript
import type {
  Color,
  PipelineKey,
  LivePipelineState,
  LiveSyncState,
  PipelineConfig,
  SinkConfig,
  IndexConfig,
  TransformConfig,
  EnrichmentConfig,
  SinkLifecycle,
} from "../config/types.js";
```

- [ ] **Step 3: Run typecheck**

Run: `cd srb && bun run typecheck`

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
cd srb && git add src/state/discover.ts
git commit -m "feat: extend state discovery to detect live sync sinks"
```

---

### Task 7: Extend plan formatter for syncs

**Files:**
- Modify: `srb/src/planner/format.ts`

- [ ] **Step 1: Add sync resource formatting**

In `formatPlans`, the "Config (new)" section shows resources for create plans. Add sync resources after the enrichment. Find the block (around line 288):

```typescript
      lines.push(formatNewResource("enrichment", desired.enrichment.name, [
        ["source", desired.enrichment.source],
      ], "    "));
```

Add after it:

```typescript
      for (const sync of desired.syncs) {
        lines.push(formatNewResource(`sync sink (${sync.name})`, sync.name, [
          ["sourceTable", sync.sink.sourceTable],
          ["destination", sync.sink.destination],
        ], "    "));
        lines.push(formatNewResource(`sync transform (${sync.name})`, sync.transform.name, [
          ["functionBody", sync.transform.functionBody],
        ], "    "));
        lines.push(formatNewResource(`sync enrichment (${sync.name})`, sync.enrichment.name, [
          ["source", sync.enrichment.source],
        ], "    "));
      }
```

- [ ] **Step 2: Run typecheck**

Run: `cd srb && bun run typecheck`

Expected: No errors.

- [ ] **Step 3: Run all unit tests**

Run: `cd srb && bun test test/unit/`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
cd srb && git add src/planner/format.ts
git commit -m "feat: extend plan formatter to display sync resources"
```

---

### Task 8: Run full test suite and typecheck

**Files:** None (verification only)

- [ ] **Step 1: Run typecheck**

Run: `cd srb && bun run typecheck`

Expected: No errors.

- [ ] **Step 2: Run all unit tests**

Run: `cd srb && bun test test/unit/`

Expected: All tests pass.

- [ ] **Step 3: Run all tests (including E2E if stack is up)**

Run: `cd srb && bun test`

Expected: Unit tests pass. E2E tests may skip if test stack isn't running.

- [ ] **Step 4: Commit if any fixes were needed**

```bash
cd srb && git add -A
git commit -m "fix: resolve issues found during full verification"
```
