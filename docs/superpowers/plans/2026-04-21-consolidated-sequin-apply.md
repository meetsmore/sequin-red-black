# Consolidated Sequin Apply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `srb online apply` invoke `sequin config apply` exactly once per run — against a single consolidated YAML containing every pipeline with declarative changes — instead of once per pipeline.

**Architecture:** Refactor `executor.execute()` from per-plan iteration into phase-based cross-plan execution. Phases: (1) OS index creates, (2) single `sequin config apply` with one YAML for all plans with declarative effects, (3) imperative backfills, (4) imperative sequin deletes, (5) OS swap/delete/reindex mods. `generateSequinYaml` already accepts `Plan[]` — we just stop always passing `[plan]`. Ordering is preserved because each effect kind lands in exactly one phase, and the phases match the dependency order the planner already encodes (CreateIndex(1) → CreateSink(4) → TriggerBackfill(5); DeleteSink → DeleteIndex).

**Tech Stack:** TypeScript, Bun, `bun:test`.

---

## File Structure

**Modified:**
- `srb/src/executor/executor.ts` — Rewrite `execute()` to phase-based. Replace `executeSequinBatch` / `batchEffects` with a single `executeSequinApplyBatch(plansWithDeclarative, desired, opts)`.

**Created:**
- `srb/test/unit/executor.test.ts` — First unit tests for the executor. Uses recording mocks for `SequinCLI`, `SequinAPI`, `OpenSearchClient` to assert call counts and call order.

**No change:**
- `srb/src/sequin/yaml-gen.ts` — Already iterates `plans: Plan[]` correctly.
- `srb/src/online/apply.ts` — Already passes all plans to `execute()`.
- `srb/src/online/drop.ts` — Passes a single plan; new `execute()` handles it identically.

---

## Task 1: Add executor test scaffolding with recording mocks

**Files:**
- Create: `srb/test/unit/executor.test.ts`

- [ ] **Step 1: Create the test file with recording mocks and a smoke test**

```ts
import { describe, test, expect } from "bun:test";
import { execute } from "../../src/executor/executor.js";
import type { SequinCLI, SequinConfigYaml } from "../../src/sequin/cli.js";
import type { SequinAPI } from "../../src/sequin/api.js";
import type { OpenSearchClient } from "../../src/opensearch/client.js";
import type { Plan, PipelineConfig, PlannedEffect } from "../../src/config/types.js";
import * as fs from "fs/promises";

// ---------------------------------------------------------------------------
// Recording mocks — capture call order via a shared log.
// ---------------------------------------------------------------------------

type CallLog = string[];

function mockSequinCli(log: CallLog): SequinCLI {
  return {
    async plan(_: string) { return { stdout: "", exitCode: 0 }; },
    async apply(yamlPath: string) {
      const body = await fs.readFile(yamlPath, "utf-8");
      log.push(`sequin.apply:${body}`);
    },
    async export_(): Promise<SequinConfigYaml> { return {}; },
  } as unknown as SequinCLI;
}

function mockSequinApi(log: CallLog): SequinAPI {
  return {
    async listSinks() { return []; },
    async deleteSink(id: string) { log.push(`sequin.deleteSink:${id}`); },
    async triggerBackfill(id: string) { log.push(`sequin.triggerBackfill:${id}`); },
  } as unknown as SequinAPI;
}

function mockOpenSearch(log: CallLog): OpenSearchClient {
  return {
    async createIndex(name: string) { log.push(`os.createIndex:${name}`); },
    async deleteIndex(name: string) { log.push(`os.deleteIndex:${name}`); },
    async getAlias(_: string) { return "old-target"; },
    async swapAlias(alias: string, _old: string, next: string) { log.push(`os.swapAlias:${alias}->${next}`); },
    async triggerReindex(src: string, tgt: string) { log.push(`os.reindex:${src}->${tgt}`); },
  } as unknown as OpenSearchClient;
}

function fixturePipelineConfig(name: string): PipelineConfig {
  return {
    name,
    sink: {
      id: `sink-${name}`,
      name,
      database: "source-db",
      sourceTable: "public.T",
      destination: { type: "elasticsearch", endpoint_url: "http://os:9200", auth_type: "none" },
      filters: "",
      batchSize: 100,
      transformId: `transform-${name}`,
      enrichmentIds: [`enrichment-${name}`],
    },
    index: { id: `index-${name}`, name, mappings: {}, settings: {}, alias: name },
    transform: { id: `transform-${name}`, name: `${name}-transform`, functionBody: "return m", inputSchema: "{}", outputSchema: "{}" },
    enrichment: { id: `enrichment-${name}`, name: `${name}-enrichment`, source: "select 1", joinColumn: "id", enrichmentColumns: "" },
    webhooks: [],
  };
}

describe("executor", () => {
  test("empty plans list makes no calls", async () => {
    const log: CallLog = [];
    await execute(
      [],
      new Map(),
      {
        sequinCli: mockSequinCli(log),
        sequinApi: mockSequinApi(log),
        openSearch: mockOpenSearch(log),
        skipBackfill: false,
        dryRun: false,
      },
    );
    expect(log).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the smoke test**

Run: `cd srb && bun test test/unit/executor.test.ts`
Expected: PASS (1 test).

- [ ] **Step 3: Typecheck**

Run: `cd srb && bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add srb/test/unit/executor.test.ts
git commit -m "test(executor): add scaffolding and smoke test"
```

---

## Task 2: Red — failing test for a single consolidated sequin apply

**Files:**
- Modify: `srb/test/unit/executor.test.ts`

- [ ] **Step 1: Add a helper that builds a Plan with `CreateSink` effects**

Append to the test file, above `describe("executor", ...)`:

```ts
function planWithCreate(pipeline: string, color: "red" | "black"): Plan {
  const cfg = fixturePipelineConfig(pipeline);
  const effects: PlannedEffect[] = [
    { effect: { kind: "CreateIndex", index: cfg.index }, status: "pending", dependsOn: [], order: 1 },
    { effect: { kind: "CreateTransform", transform: cfg.transform }, status: "pending", dependsOn: [], order: 2 },
    { effect: { kind: "CreateEnrichment", enrichment: cfg.enrichment }, status: "pending", dependsOn: [], order: 3 },
    { effect: { kind: "CreateSink", sink: cfg.sink }, status: "pending", dependsOn: [1, 2, 3], order: 4 },
  ];
  return { pipeline, targetColor: color, effects };
}
```

- [ ] **Step 2: Add the failing test**

Add inside the `describe("executor", ...)` block:

```ts
test("multiple plans with declarative effects trigger exactly one sequin apply", async () => {
  const log: CallLog = [];
  const desired = new Map<string, PipelineConfig>([
    ["jobs", fixturePipelineConfig("jobs")],
    ["clients", fixturePipelineConfig("clients")],
  ]);
  const plans = [planWithCreate("jobs", "red"), planWithCreate("clients", "black")];

  await execute(plans, desired, {
    sequinCli: mockSequinCli(log),
    sequinApi: mockSequinApi(log),
    openSearch: mockOpenSearch(log),
    skipBackfill: true,
    dryRun: false,
  });

  const applies = log.filter(l => l.startsWith("sequin.apply:"));
  expect(applies).toHaveLength(1);
  expect(applies[0]).toContain("jobs_red");
  expect(applies[0]).toContain("clients_black");
});
```

- [ ] **Step 3: Run the new test and confirm it fails**

Run: `cd srb && bun test test/unit/executor.test.ts -t "exactly one sequin apply"`
Expected: FAIL. `applies` has length 2 (one per plan, current behavior).

- [ ] **Step 4: Do not commit the failing test yet** — continue to Task 3.

---

## Task 3: Green — rewrite `execute()` to phase-based cross-plan execution

**Files:**
- Modify: `srb/src/executor/executor.ts`

- [ ] **Step 1: Replace the bottom half of executor.ts with the phase-based implementation**

Replace `executor.ts` lines 56-264 (everything from `// Group consecutive sequin...` through the end of `execute()`) with:

```ts
function log(msg: string): void {
  console.log(`[executor] ${msg}`);
}

async function executeOpenSearchEffect(
  effect: Effect,
  os: OpenSearchClient,
  plan: Plan,
  dryRun: boolean,
): Promise<void> {
  switch (effect.kind) {
    case "CreateIndex": {
      const name = coloredIndexName(plan.pipeline, plan.targetColor);
      if (dryRun) { log(`[dry-run] Would create index: ${name}`); return; }
      log(`Creating index: ${name}`);
      await os.createIndex(name, { mappings: effect.index.mappings, settings: effect.index.settings });
      break;
    }
    case "DeleteIndex": {
      if (dryRun) { log(`[dry-run] Would delete index: ${effect.id}`); return; }
      log(`Deleting index: ${effect.id}`);
      await os.deleteIndex(effect.id);
      break;
    }
    case "SwapAlias": {
      const indexName = coloredIndexName(effect.pipeline, effect.color);
      if (dryRun) { log(`[dry-run] Would swap alias for ${effect.pipeline} -> ${indexName}`); return; }
      log(`Swapping alias for ${effect.pipeline} -> ${indexName}`);
      const currentTarget = await os.getAlias(effect.pipeline);
      await os.swapAlias(effect.pipeline, currentTarget, indexName);
      break;
    }
    case "TriggerReindex": {
      if (dryRun) { log(`[dry-run] Would reindex ${effect.source} -> ${effect.target}`); return; }
      log(`Triggering reindex: ${effect.source} -> ${effect.target}`);
      await os.triggerReindex(effect.source, effect.target);
      break;
    }
    default:
      throw new Error(`Not an OpenSearch effect: ${(effect as Effect).kind}`);
  }
}

async function executeSequinApplyBatch(
  plansWithDeclarative: Plan[],
  effectCount: number,
  desired: Map<string, PipelineConfig>,
  opts: ExecutorOptions,
): Promise<void> {
  if (opts.dryRun) {
    log(`[dry-run] Would apply consolidated Sequin config for ${plansWithDeclarative.length} pipeline(s) (${effectCount} effects)`);
    return;
  }
  const yaml = generateSequinYaml(plansWithDeclarative, desired);
  const tmpFile = path.join(tmpdir(), `srb-sequin-${Date.now()}.yaml`);
  await fs.writeFile(tmpFile, yaml, "utf-8");
  log(`Applying consolidated Sequin config for ${plansWithDeclarative.length} pipeline(s) (${effectCount} effects): ${tmpFile}`);
  try {
    await opts.sequinCli.apply(tmpFile);
  } catch (err) {
    log(`Sequin config YAML that failed:\n${yaml}`);
    throw err;
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
}

async function executeSequinDelete(
  effect: Effect,
  plan: Plan,
  opts: ExecutorOptions,
): Promise<void> {
  if (effect.kind === "DeleteSink") {
    if (opts.dryRun) { log(`[dry-run] Would delete sink: ${effect.id}`); return; }
    log(`Deleting sink: ${coloredSinkName(plan.pipeline, plan.targetColor)} (${effect.id})`);
    await opts.sequinApi.deleteSink(effect.id);
  } else if (effect.kind === "DeleteTransform" || effect.kind === "DeleteEnrichment") {
    if (opts.dryRun) { log(`[dry-run] Would delete function: ${effect.id}`); return; }
    log(`Function ${effect.id} will be cleaned up by Sequin`);
  }
}

async function executeImperativeEffect(
  effect: Effect,
  plan: Plan,
  opts: ExecutorOptions,
): Promise<void> {
  if (effect.kind !== "TriggerBackfill") {
    throw new Error(`Not an imperative effect: ${effect.kind}`);
  }
  if (opts.skipBackfill) { log(`Skipping backfill for sink: ${effect.sinkId} (--skip-backfill)`); return; }
  if (opts.dryRun) { log(`[dry-run] Would trigger backfill for sink: ${effect.sinkId}`); return; }

  const coloredName = coloredSinkName(plan.pipeline, plan.targetColor);
  const sinks = await opts.sequinApi.listSinks();
  const sink = sinks.find(s => s.name === coloredName);
  if (!sink) {
    throw new Error(`Cannot trigger backfill: sink "${coloredName}" not found in Sequin`);
  }
  log(`Triggering backfill for sink: ${coloredName} (${sink.id})`);
  await opts.sequinApi.triggerBackfill(sink.id);
}

type PhaseKind = "os_create" | "sequin_declarative" | "backfill" | "sequin_delete" | "os_mod";

function phaseFor(effect: Effect): PhaseKind {
  switch (effect.kind) {
    case "CreateIndex": return "os_create";
    case "CreateSink":
    case "CreateTransform":
    case "CreateEnrichment":
    case "UpdateSink": return "sequin_declarative";
    case "TriggerBackfill": return "backfill";
    case "DeleteSink":
    case "DeleteTransform":
    case "DeleteEnrichment": return "sequin_delete";
    case "SwapAlias":
    case "DeleteIndex":
    case "TriggerReindex": return "os_mod";
  }
}

export async function execute(
  plans: Plan[],
  desired: Map<string, PipelineConfig>,
  opts: ExecutorOptions,
): Promise<void> {
  // Summary per plan
  for (const plan of plans) {
    if (plan.effects.length === 0) {
      log(`Pipeline ${plan.pipeline} (${plan.targetColor}): no changes`);
    } else {
      log(`Pipeline ${plan.pipeline} (${plan.targetColor}): ${plan.effects.length} effects`);
    }
  }

  // Collect effects by phase, preserving insertion order (plan-by-plan, effect-by-effect)
  type Item = { plan: Plan; pe: PlannedEffect };
  const byPhase: Record<PhaseKind, Item[]> = {
    os_create: [],
    sequin_declarative: [],
    backfill: [],
    sequin_delete: [],
    os_mod: [],
  };
  for (const plan of plans) {
    const sorted = [...plan.effects].sort((a, b) => a.order - b.order);
    for (const pe of sorted) byPhase[phaseFor(pe.effect)].push({ plan, pe });
  }

  // Phase 1: OS index creates (must exist before sinks reference them)
  for (const { pe, plan } of byPhase.os_create) {
    await executeOpenSearchEffect(pe.effect, opts.openSearch, plan, opts.dryRun);
  }

  // Phase 2: one consolidated sequin config apply
  if (byPhase.sequin_declarative.length > 0) {
    const plansWithDeclarative = plans.filter(p =>
      p.effects.some(e => phaseFor(e.effect) === "sequin_declarative"),
    );
    await executeSequinApplyBatch(
      plansWithDeclarative,
      byPhase.sequin_declarative.length,
      desired,
      opts,
    );
  }

  // Phase 3: imperative backfills
  for (const { pe, plan } of byPhase.backfill) {
    await executeImperativeEffect(pe.effect, plan, opts);
  }

  // Phase 4: imperative sequin deletes (by UUID)
  for (const { pe, plan } of byPhase.sequin_delete) {
    await executeSequinDelete(pe.effect, plan, opts);
  }

  // Phase 5: OS alias swaps / index deletes / reindex
  for (const { pe, plan } of byPhase.os_mod) {
    await executeOpenSearchEffect(pe.effect, opts.openSearch, plan, opts.dryRun);
  }
}
```

The `coloredIndexName` / `coloredSinkName` / `coloredTransformName` / `coloredEnrichmentName` exports at the top of the file (lines 18-30) stay as they are. The imports stay as they are.

- [ ] **Step 2: Run the failing test — it should now pass**

Run: `cd srb && bun test test/unit/executor.test.ts -t "exactly one sequin apply"`
Expected: PASS.

- [ ] **Step 3: Run all unit tests**

Run: `cd srb && bun test test/unit/`
Expected: all tests pass.

- [ ] **Step 4: Typecheck**

Run: `cd srb && bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add srb/src/executor/executor.ts srb/test/unit/executor.test.ts
git commit -m "refactor(executor): consolidate sequin apply into a single call"
```

---

## Task 4: Preserve ordering — OS index creates run before sequin apply

**Files:**
- Modify: `srb/test/unit/executor.test.ts`

- [ ] **Step 1: Add ordering assertion test**

Append inside `describe("executor", ...)`:

```ts
test("OS index creates run before the sequin apply", async () => {
  const log: CallLog = [];
  const desired = new Map<string, PipelineConfig>([["jobs", fixturePipelineConfig("jobs")]]);
  const plans = [planWithCreate("jobs", "red")];

  await execute(plans, desired, {
    sequinCli: mockSequinCli(log),
    sequinApi: mockSequinApi(log),
    openSearch: mockOpenSearch(log),
    skipBackfill: true,
    dryRun: false,
  });

  const osIdx = log.findIndex(l => l.startsWith("os.createIndex:jobs_red"));
  const applyIdx = log.findIndex(l => l.startsWith("sequin.apply:"));
  expect(osIdx).toBeGreaterThanOrEqual(0);
  expect(applyIdx).toBeGreaterThan(osIdx);
});
```

- [ ] **Step 2: Run the test**

Run: `cd srb && bun test test/unit/executor.test.ts -t "OS index creates run before"`
Expected: PASS (phase 1 runs before phase 2).

- [ ] **Step 3: Commit**

```bash
git add srb/test/unit/executor.test.ts
git commit -m "test(executor): assert OS creates run before sequin apply"
```

---

## Task 5: Preserve ordering — backfills run after sequin apply

**Files:**
- Modify: `srb/test/unit/executor.test.ts`

- [ ] **Step 1: Add a helper for a plan that also includes TriggerBackfill, and a test**

Add near `planWithCreate`:

```ts
function planWithCreateAndBackfill(pipeline: string, color: "red" | "black"): Plan {
  const cfg = fixturePipelineConfig(pipeline);
  return {
    pipeline,
    targetColor: color,
    effects: [
      { effect: { kind: "CreateIndex", index: cfg.index }, status: "pending", dependsOn: [], order: 1 },
      { effect: { kind: "CreateTransform", transform: cfg.transform }, status: "pending", dependsOn: [], order: 2 },
      { effect: { kind: "CreateEnrichment", enrichment: cfg.enrichment }, status: "pending", dependsOn: [], order: 3 },
      { effect: { kind: "CreateSink", sink: cfg.sink }, status: "pending", dependsOn: [1, 2, 3], order: 4 },
      { effect: { kind: "TriggerBackfill", sinkId: cfg.sink.id }, status: "pending", dependsOn: [4], order: 5 },
    ],
  };
}
```

Add the test inside `describe("executor", ...)`. Note: since the mock `listSinks` returns `[]`, the real `executeImperativeEffect` would throw on lookup. Use `skipBackfill: false` to test ordering means we need `listSinks` to return the sink. Update the mock:

```ts
test("backfills run after the sequin apply", async () => {
  const log: CallLog = [];
  const desired = new Map<string, PipelineConfig>([["jobs", fixturePipelineConfig("jobs")]]);
  const plans = [planWithCreateAndBackfill("jobs", "red")];

  const sequinApi = {
    async listSinks() { return [{ id: "sink-uuid-1", name: "jobs_red" }]; },
    async deleteSink(id: string) { log.push(`sequin.deleteSink:${id}`); },
    async triggerBackfill(id: string) { log.push(`sequin.triggerBackfill:${id}`); },
  } as unknown as SequinAPI;

  await execute(plans, desired, {
    sequinCli: mockSequinCli(log),
    sequinApi,
    openSearch: mockOpenSearch(log),
    skipBackfill: false,
    dryRun: false,
  });

  const applyIdx = log.findIndex(l => l.startsWith("sequin.apply:"));
  const backfillIdx = log.findIndex(l => l.startsWith("sequin.triggerBackfill:"));
  expect(applyIdx).toBeGreaterThanOrEqual(0);
  expect(backfillIdx).toBeGreaterThan(applyIdx);
});
```

- [ ] **Step 2: Run the test**

Run: `cd srb && bun test test/unit/executor.test.ts -t "backfills run after"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add srb/test/unit/executor.test.ts
git commit -m "test(executor): assert backfills run after sequin apply"
```

---

## Task 6: Regression coverage — drop flow deletes sinks before index

**Files:**
- Modify: `srb/test/unit/executor.test.ts`

- [ ] **Step 1: Add a drop-plan helper and a test**

```ts
function planWithDrop(pipeline: string, color: "red" | "black"): Plan {
  return {
    pipeline,
    targetColor: color,
    effects: [
      { effect: { kind: "DeleteSink", id: `sink-uuid-${pipeline}-${color}` }, status: "pending", dependsOn: [], order: 1 },
      { effect: { kind: "DeleteTransform", id: `transform-uuid-${pipeline}-${color}` }, status: "pending", dependsOn: [1], order: 2 },
      { effect: { kind: "DeleteEnrichment", id: `enrichment-uuid-${pipeline}-${color}` }, status: "pending", dependsOn: [1], order: 3 },
      { effect: { kind: "DeleteIndex", id: `${pipeline}_${color}` }, status: "pending", dependsOn: [1, 2, 3], order: 4 },
    ],
  };
}
```

```ts
test("drop flow: sink deleted before OS index, no sequin apply is triggered", async () => {
  const log: CallLog = [];
  const plans = [planWithDrop("jobs", "red")];

  await execute(plans, new Map(), {
    sequinCli: mockSequinCli(log),
    sequinApi: mockSequinApi(log),
    openSearch: mockOpenSearch(log),
    skipBackfill: false,
    dryRun: false,
  });

  const deleteSinkIdx = log.findIndex(l => l.startsWith("sequin.deleteSink:"));
  const deleteIndexIdx = log.findIndex(l => l.startsWith("os.deleteIndex:"));
  const applyCalled = log.some(l => l.startsWith("sequin.apply:"));
  expect(deleteSinkIdx).toBeGreaterThanOrEqual(0);
  expect(deleteIndexIdx).toBeGreaterThan(deleteSinkIdx);
  expect(applyCalled).toBe(false);
});
```

- [ ] **Step 2: Run the test**

Run: `cd srb && bun test test/unit/executor.test.ts -t "drop flow"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add srb/test/unit/executor.test.ts
git commit -m "test(executor): regression coverage for drop phase ordering"
```

---

## Task 7: Full regression — unit suite + typecheck

- [ ] **Step 1: Run full unit suite**

Run: `cd srb && bun test test/unit/`
Expected: all tests pass.

- [ ] **Step 2: Typecheck**

Run: `cd srb && bun run typecheck`
Expected: no errors.

- [ ] **Step 3: If both pass, no new commit needed** — move to Task 8.

---

## Task 8: E2E verification against real Sequin + OpenSearch

**Files:**
- None modified unless E2E exposes a regression.

- [ ] **Step 1: Start the test docker stack**

Run: `cd srb && make test-stack-up`
Expected: Postgres, Sequin, OpenSearch boot. Wait for healthy.

- [ ] **Step 2: Run the E2E suite**

Run: `cd srb && bun test test/e2e/`
Expected: all tests pass. Watch for "Applying consolidated Sequin config" log line — should appear once per apply even across multiple pipelines.

- [ ] **Step 3: Spot-check the example stack**

Run: `bunx kadai run example/setup && bunx kadai run example/apply`
Expected: one `Applying consolidated Sequin config for N pipeline(s)` log line instead of N separate ones.

- [ ] **Step 4: Tear down the test stack**

Run: `cd srb && make test-stack-down`

- [ ] **Step 5: If anything failed in steps 2-3, diagnose, fix, add a regression test, re-run.** If everything passed, no new commit needed.
