# OpenSearch-Aware Color Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent srb from targeting colors already occupied by foreign OpenSearch indices (e.g. from pgsync) by adding `os_indices` state to the Quint spec and implementation.

**Architecture:** Add a 5th state variable `os_indices: Set[(PipelineName, Color)]` to track foreign OS indices. Thread it through `pick_target_color` so occupied colors are skipped. Update `cmd_drop` to handle foreign indices. Then implement the same in TypeScript.

**Tech Stack:** Quint (formal spec), TypeScript/Bun (implementation), `bunx kadai run quint/check` (spec verification), `bun test` (TS tests)

**Spec:** `docs/superpowers/specs/2026-04-16-os-aware-color-selection-design.md`

---

### Task 1: Add `os_indices` State Variable and `init`

**Files:**
- Modify: `docs/spec/quint/state.qnt`

- [ ] **Step 1: Add `os_indices` state variable**

In `state.qnt`, add the new state variable after `current_plans`:

```quint
// Foreign OpenSearch indices not managed by Sequin.
// Tracks (pipeline, color) pairs where an OS index exists without a Sequin sink.
var os_indices: Set[(PipelineName, Color)]
```

- [ ] **Step 2: Update `init` to include `os_indices`**

```quint
action init = all {
  desired_pipelines' = Map(),
  live_pipelines' = Map(),
  aliases' = Map(),
  current_plans' = Set(),
  os_indices' = Set(),
}
```

- [ ] **Step 3: Update `available_colors` to exclude `os_indices`**

Change the existing `available_colors` helper to accept `os_indices`:

```quint
pure def available_colors(
  pipeline: PipelineName,
  live: (PipelineName, Color) -> LivePipelineState,
  os_indices: Set[(PipelineName, Color)]
): Set[Color] =
  ALL_COLORS.filter(c => not((pipeline, c).in(live.keys())) and not((pipeline, c).in(os_indices)))
```

Note: `live_colors` does not need to change — it only reports what Sequin manages.

- [ ] **Step 4: Add `discover_os_index` action**

```quint
// Models discovering a foreign OS index during state discovery
action discover_os_index(pipeline: PipelineName, color: Color): bool = all {
  os_indices' = os_indices.union(Set((pipeline, color))),
  desired_pipelines' = desired_pipelines,
  live_pipelines' = live_pipelines,
  aliases' = aliases,
  current_plans' = current_plans,
}
```

- [ ] **Step 5: Update all existing actions to assign `os_indices'`**

Every existing action in `state.qnt` must add `os_indices' = os_indices`:

`load_desired_config`:
```quint
action load_desired_config(pipeline: PipelineName, cfg: PipelineConfig): bool = all {
  desired_pipelines' = desired_pipelines.put(pipeline, cfg),
  live_pipelines' = live_pipelines,
  aliases' = aliases,
  current_plans' = current_plans,
  os_indices' = os_indices,
}
```

`discover_live_state`:
```quint
action discover_live_state(pipeline: PipelineName, color: Color, state: LivePipelineState): bool = all {
  live_pipelines' = live_pipelines.put((pipeline, color), state),
  desired_pipelines' = desired_pipelines,
  aliases' = aliases,
  current_plans' = current_plans,
  os_indices' = os_indices,
}
```

`discover_alias`:
```quint
action discover_alias(pipeline: PipelineName, color: Color): bool = all {
  aliases' = aliases.put(pipeline, color),
  desired_pipelines' = desired_pipelines,
  live_pipelines' = live_pipelines,
  current_plans' = current_plans,
  os_indices' = os_indices,
}
```

- [ ] **Step 6: Typecheck**

Run: `quint typecheck docs/spec/quint/commands_test.qnt`

This will fail because `commands.qnt` and `plan.qnt` reference `os_indices` implicitly through `init` but don't assign it in their actions yet. That's expected — we fix those in Tasks 2 and 3.

- [ ] **Step 7: Commit**

```bash
git add docs/spec/quint/state.qnt
git commit -m "spec: add os_indices state variable for foreign OS indices"
```

---

### Task 2: Update `plan.qnt` — Thread `os_indices` Through Plan Generation

**Files:**
- Modify: `docs/spec/quint/plan.qnt`

- [ ] **Step 1: Update `pick_target_color` signature**

```quint
pure def pick_target_color(
  pipeline: PipelineName,
  live: (PipelineName, Color) -> LivePipelineState,
  os_indices: Set[(PipelineName, Color)],
  all_colors: Set[Color]
): Color =
  val available = all_colors.filter(c =>
    not((pipeline, c).in(live.keys())) and not((pipeline, c).in(os_indices))
  )
  available.fold(Red, (acc, c) => c)
```

- [ ] **Step 2: Update `generate_plans` to accept and pass `os_indices`**

```quint
pure def generate_plans(
  desired: PipelineName -> PipelineConfig,
  live: (PipelineName, Color) -> LivePipelineState,
  all_colors: Set[Color],
  os_indices: Set[(PipelineName, Color)]
): Set[Plan] =
  val pipelines = all_pipeline_names(desired, live, all_colors)
  pipelines
    .map(p => {
      val target = pick_target_color(p, live, os_indices, all_colors)
      plan_for_pipeline(p, desired, live, target, all_colors)
    })
    .filter(p => p.effects.length() > 0)
```

- [ ] **Step 3: Typecheck**

Run: `quint typecheck docs/spec/quint/commands_test.qnt`

Will fail — `commands.qnt` calls `generate_plans` with the old signature. Fixed in Task 3.

- [ ] **Step 4: Commit**

```bash
git add docs/spec/quint/plan.qnt
git commit -m "spec: thread os_indices through pick_target_color and generate_plans"
```

---

### Task 3: Update `commands.qnt` — All Commands Assign `os_indices'`

**Files:**
- Modify: `docs/spec/quint/commands.qnt`

- [ ] **Step 1: Update `cmd_plan`**

```quint
action cmd_plan: bool = all {
  desired_pipelines.keys().size() > 0,
  current_plans' = generate_plans(desired_pipelines, live_pipelines, ALL_COLORS, os_indices),
  desired_pipelines' = desired_pipelines,
  live_pipelines' = live_pipelines,
  aliases' = aliases,
  os_indices' = os_indices,
}
```

- [ ] **Step 2: Update `cmd_apply`**

Change the `generate_plans` call and add `os_indices'` assignment:

```quint
action cmd_apply(skip_backfill: bool): bool = all {
  desired_pipelines.keys().size() > 0,
  val plans = generate_plans(desired_pipelines, live_pipelines, ALL_COLORS, os_indices)
  val new_live = plans.fold(live_pipelines, (acc, p) =>
    if (p.effects.length() == 0 or not(p.pipeline.in(desired_pipelines.keys()))) acc
    else if (not(plan_creates_new_color(p))) {
      val cfg = desired_pipelines.get(p.pipeline)
      val existing_color = ALL_COLORS.filter(c => (p.pipeline, c).in(acc.keys())).fold(Red, (a, c) => c)
      val existing = acc.get((p.pipeline, existing_color))
      acc.put((p.pipeline, existing_color), {
        ...existing,
        sink: { ...existing.sink, config: cfg.sink },
      })
    } else {
      val cfg = desired_pipelines.get(p.pipeline)
      val is_reindex = plan_uses_reindex(p)
      acc.put((p.pipeline, p.target_color), {
        sink: { config: cfg.sink, lifecycle: SinkActive, backfilling: if (is_reindex) false else not(skip_backfill) },
        index: { config: cfg.index, status: if (is_reindex) IndexReindexing else IndexGreen, doc_count: 0 },
        transform: { config: cfg.transform, status: TransformActive },
        enrichment: { config: cfg.enrichment, status: EnrichmentActive },
        webhooks: cfg.webhooks.foldl(List(), (a, wh) =>
          a.append({
            sink: { config: wh.sink, lifecycle: SinkActive, backfilling: false },
            transform: { config: wh.transform, status: TransformActive },
            enrichment: { config: wh.enrichment, status: EnrichmentActive },
          })
        ),
      })
    }
  )
  all {
    live_pipelines' = new_live,
    desired_pipelines' = desired_pipelines,
    aliases' = aliases,
    current_plans' = plans,
    os_indices' = os_indices,
  }
}
```

- [ ] **Step 3: Update `cmd_backfill`**

Add `os_indices' = os_indices` at the end of the `all {}` block.

- [ ] **Step 4: Update `cmd_activate`**

Add `os_indices' = os_indices` at the end of the `all {}` block.

- [ ] **Step 5: Update `cmd_drop` to handle foreign OS indices**

Replace the existing `cmd_drop` entirely:

```quint
action cmd_drop(pipeline: PipelineName, color: Color): bool = all {
  // Precondition: color exists in EITHER live_pipelines or os_indices
  or { (pipeline, color).in(live_pipelines.keys()), (pipeline, color).in(os_indices) },
  // Precondition: not dropping the active color (applies to both managed and foreign)
  if (pipeline.in(aliases.keys())) aliases.get(pipeline) != color else true,
  // Remove from whichever set it belongs to
  live_pipelines' = live_pipelines.keys().exclude(Set((pipeline, color))).mapBy(k => live_pipelines.get(k)),
  os_indices' = os_indices.exclude(Set((pipeline, color))),
  desired_pipelines' = desired_pipelines,
  aliases' = aliases,
  current_plans' = current_plans,
}
```

- [ ] **Step 6: Update `backfill_completes`**

Add `os_indices' = os_indices` at the end of the `all {}` block.

- [ ] **Step 7: Update `reindex_completes`**

Add `os_indices' = os_indices` at the end of the `all {}` block.

- [ ] **Step 8: Update `step` action — add `discover_os_index` branch**

Add this new branch inside the `any {}` block in `step`:

```quint
// Model discovering a foreign OS index
all {
  nondet p = Set("jobs", "clients", "users").oneOf()
  nondet c = ALL_COLORS.oneOf()
  discover_os_index(p, c),
},
```

- [ ] **Step 9: Add new invariants**

After the existing invariants, add:

```quint
// 5. Foreign OS indices and Sequin-managed pipelines never overlap
val os_live_disjoint: bool =
  os_indices.forall(k => not(k.in(live_pipelines.keys())))

// 6. Plans never target a color occupied by a foreign OS index
val never_target_occupied_os_color: bool =
  current_plans.forall(p =>
    not((p.pipeline, p.target_color).in(os_indices))
  )
```

- [ ] **Step 10: Add `witness_color_dropped` for os_indices**

Update the existing `witness_color_dropped` to account for `os_indices` drops too. No change needed — the existing witness covers live_pipelines drops, and the new invariant checking covers os_indices behavior through model checking.

- [ ] **Step 11: Typecheck**

Run: `quint typecheck docs/spec/quint/commands_test.qnt`

Expected: PASS (all files now assign all 5 state variables)

- [ ] **Step 12: Commit**

```bash
git add docs/spec/quint/commands.qnt
git commit -m "spec: update all commands to assign os_indices, add invariants"
```

---

### Task 4: Add Quint Tests for `os_indices` Behavior

**Files:**
- Modify: `docs/spec/quint/commands_test.qnt`

- [ ] **Step 1: Add `test_pick_target_color_skips_os_indices`**

```quint
// Test: pick_target_color avoids colors in os_indices
run test_pick_target_color_skips_os_indices = {
  val live: (PipelineName, Color) -> LivePipelineState = Map()
  val os: Set[(PipelineName, Color)] = Set(("jobs", Red))
  val color = pick_target_color("jobs", live, os, ALL_COLORS)
  assert(color != Red)
}
```

- [ ] **Step 2: Add `test_pick_target_color_skips_both_live_and_os`**

```quint
// Test: pick_target_color avoids colors in both live and os_indices
run test_pick_target_color_skips_both_live_and_os = {
  val live: (PipelineName, Color) -> LivePipelineState = Map(("jobs", Red) -> fixture_live_state)
  val os: Set[(PipelineName, Color)] = Set(("jobs", Black))
  val color = pick_target_color("jobs", live, os, ALL_COLORS)
  assert(color != Red and color != Black)
}
```

- [ ] **Step 3: Add `test_drop_foreign_os_index`**

```quint
// Test: cmd_drop removes a foreign OS index
run test_drop_foreign_os_index = {
  init
    .then(discover_os_index("jobs", Red))
    .then(all {
      assert(("jobs", Red).in(os_indices)),
      desired_pipelines' = desired_pipelines,
      live_pipelines' = live_pipelines,
      aliases' = aliases,
      current_plans' = current_plans,
      os_indices' = os_indices,
    })
    .then(cmd_drop("jobs", Red))
    .then(all {
      // OS index removed
      assert(not(("jobs", Red).in(os_indices))),
      // live_pipelines unaffected
      assert(live_pipelines.keys().size() == 0),
      desired_pipelines' = desired_pipelines,
      live_pipelines' = live_pipelines,
      aliases' = aliases,
      current_plans' = current_plans,
      os_indices' = os_indices,
    })
}
```

- [ ] **Step 4: Add `test_e2e_migration_from_pgsync`**

This is the core scenario: foreign OS index at red, alias pointing to it, srb deploys alongside.

```quint
// Scenario: migrate from pgsync — foreign OS index at red, srb picks different color
run test_e2e_migration_from_pgsync = {
  init
    // Simulate existing pgsync state: jobs_red index exists, alias jobs -> red
    .then(discover_os_index("jobs", Red))
    .then(discover_alias("jobs", Red))
    // Load desired config
    .then(load_desired_config("jobs", fixture_pipeline_config))
    // Plan: should create, targeting a color OTHER than red
    .then(cmd_plan)
    .then(all {
      assert(current_plans.size() == 1),
      // Target color must not be Red (occupied by pgsync)
      assert(current_plans.forall(p => p.target_color != Red)),
      // Should still be a Create plan with 5 effects
      assert(current_plans.forall(p => p.effects.length() == 5)),
      desired_pipelines' = desired_pipelines,
      live_pipelines' = live_pipelines,
      aliases' = aliases,
      current_plans' = current_plans,
      os_indices' = os_indices,
    })
    // Apply: creates new color (not red)
    .then(cmd_apply(false))
    .then(
      val managed_colors = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
      all {
        // Exactly one Sequin-managed color
        assert(managed_colors.size() == 1),
        // That color is NOT red
        assert(managed_colors.forall(c => c != Red)),
        // OS index still exists at red
        assert(("jobs", Red).in(os_indices)),
        // Alias still points to red (haven't activated yet)
        assert(aliases.get("jobs") == Red),
        desired_pipelines' = desired_pipelines,
        live_pipelines' = live_pipelines,
        aliases' = aliases,
        current_plans' = current_plans,
        os_indices' = os_indices,
      }
    )
    // Backfill the new color
    .then(
      val new_color = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys())).fold(Red, (a, c) => c)
      backfill_completes("jobs", new_color)
    )
    // Activate: swap alias from red (pgsync) to new color (Sequin)
    .then(
      val new_color = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys())).fold(Red, (a, c) => c)
      cmd_activate("jobs", new_color)
    )
    .then(
      val new_color = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys())).fold(Red, (a, c) => c)
      all {
        // Alias now points to Sequin-managed color
        assert(aliases.get("jobs") == new_color),
        assert(new_color != Red),
        desired_pipelines' = desired_pipelines,
        live_pipelines' = live_pipelines,
        aliases' = aliases,
        current_plans' = current_plans,
        os_indices' = os_indices,
      }
    )
    // Drop the old pgsync index
    .then(cmd_drop("jobs", Red))
    .then(all {
      // Foreign index gone
      assert(not(("jobs", Red).in(os_indices))),
      // Sequin-managed color still exists
      assert(live_pipelines.keys().size() == 1),
      // Alias still valid
      assert("jobs".in(aliases.keys())),
      desired_pipelines' = desired_pipelines,
      live_pipelines' = live_pipelines,
      aliases' = aliases,
      current_plans' = current_plans,
      os_indices' = os_indices,
    })
}
```

- [ ] **Step 5: Add `test_e2e_migration_multi_pipeline`**

```quint
// Scenario: multiple pipelines migrating from pgsync, different colors occupied
run test_e2e_migration_multi_pipeline = {
  init
    // jobs at red, clients at red (both pgsync)
    .then(discover_os_index("jobs", Red))
    .then(discover_os_index("clients", Red))
    .then(discover_alias("jobs", Red))
    .then(discover_alias("clients", Red))
    .then(load_desired_config("jobs", fixture_pipeline_config))
    .then(load_desired_config("clients", fixture_clients_config))
    .then(cmd_apply(false))
    .then(
      val jobs_managed = ALL_COLORS.filter(c => ("jobs", c).in(live_pipelines.keys()))
      val clients_managed = ALL_COLORS.filter(c => ("clients", c).in(live_pipelines.keys()))
      all {
        // Both got new colors, neither is red
        assert(jobs_managed.size() == 1),
        assert(clients_managed.size() == 1),
        assert(jobs_managed.forall(c => c != Red)),
        assert(clients_managed.forall(c => c != Red)),
        // OS indices still at red
        assert(("jobs", Red).in(os_indices)),
        assert(("clients", Red).in(os_indices)),
        desired_pipelines' = desired_pipelines,
        live_pipelines' = live_pipelines,
        aliases' = aliases,
        current_plans' = current_plans,
        os_indices' = os_indices,
      }
    )
}
```

- [ ] **Step 6: Run typecheck**

Run: `quint typecheck docs/spec/quint/commands_test.qnt`
Expected: PASS

- [ ] **Step 7: Run tests**

Run: `quint test docs/spec/quint/commands_test.qnt --main=commands_test --match=test_`
Expected: All tests pass (existing + new)

- [ ] **Step 8: Commit**

```bash
git add docs/spec/quint/commands_test.qnt
git commit -m "spec: add tests for os_indices — migration from pgsync scenarios"
```

---

### Task 5: Update Kadai Check Script and Run Full Verification

**Files:**
- Modify: `.kadai/actions/quint/check.sh`

- [ ] **Step 1: Add new invariants to the check script**

In the invariants loop, add the two new invariant names:

```bash
for inv in never_drop_active alias_integrity no_partial_pipelines disabled_not_backfilling os_live_disjoint never_target_occupied_os_color; do
```

- [ ] **Step 2: Run full check**

Run: `bunx kadai run quint/check`
Expected: All typechecks, tests, invariants (SATISFIED), and witnesses (VIOLATED) pass.

- [ ] **Step 3: Commit**

```bash
git add .kadai/actions/quint/check.sh
git commit -m "spec: add os_indices invariants to quint check script"
```

---

### Task 6: TypeScript Implementation — `LiveState` and `discoverLiveState`

**Files:**
- Modify: `srb/src/state/discover.ts`
- Create: `srb/test/unit/discover-os.test.ts`

- [ ] **Step 1: Write failing test for OS index discovery**

Create `srb/test/unit/discover-os.test.ts`:

```typescript
import { test, expect, describe } from "bun:test";
import { parseColoredName, findOccupiedOsColors } from "../../src/state/discover.js";

describe("findOccupiedOsColors", () => {
  test("detects OS indices not in Sequin-managed pipelines", () => {
    const osIndices = [
      { name: "jobs_red", health: "green", docCount: 1000 },
      { name: "clients_red", health: "green", docCount: 500 },
      { name: ".kibana", health: "green", docCount: 10 },
    ];
    const managedKeys = new Set<string>(); // no Sequin sinks

    const occupied = findOccupiedOsColors(osIndices, managedKeys);

    expect(occupied.get("jobs")).toEqual(new Set(["red"]));
    expect(occupied.get("clients")).toEqual(new Set(["red"]));
    expect(occupied.has(".kibana")).toBe(false);
  });

  test("excludes indices already managed by Sequin", () => {
    const osIndices = [
      { name: "jobs_red", health: "green", docCount: 1000 },
      { name: "jobs_black", health: "green", docCount: 0 },
    ];
    const managedKeys = new Set(["jobs:red"]); // red is Sequin-managed

    const occupied = findOccupiedOsColors(osIndices, managedKeys);

    // red is managed, not foreign
    expect(occupied.get("jobs")).toEqual(new Set(["black"]));
  });

  test("returns empty map when no foreign indices exist", () => {
    const osIndices = [
      { name: "jobs_red", health: "green", docCount: 1000 },
    ];
    const managedKeys = new Set(["jobs:red"]);

    const occupied = findOccupiedOsColors(osIndices, managedKeys);

    expect(occupied.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd srb && bun test test/unit/discover-os.test.ts`
Expected: FAIL — `findOccupiedOsColors` not exported

- [ ] **Step 3: Implement `findOccupiedOsColors` and export `parseColoredName`**

In `srb/src/state/discover.ts`, export `parseColoredName` (change from non-exported to exported):

```typescript
export function parseColoredName(name: string): { pipeline: string; color: Color } | null {
```

Add the new function before `discoverLiveState`:

```typescript
/**
 * Find OpenSearch indices that match the {pipeline}_{color} pattern but are NOT
 * managed by Sequin. These are "foreign" indices (e.g. from pgsync) that occupy
 * a color slot.
 */
export function findOccupiedOsColors(
  osIndices: { name: string; health: string; docCount: number }[],
  managedKeys: Set<string>,
): Map<string, Set<Color>> {
  const occupied = new Map<string, Set<Color>>();
  for (const idx of osIndices) {
    const parsed = parseColoredName(idx.name);
    if (!parsed) continue;
    // Skip if this pipeline+color is already managed by Sequin
    const key = `${parsed.pipeline}:${parsed.color}`;
    if (managedKeys.has(key)) continue;
    if (!occupied.has(parsed.pipeline)) {
      occupied.set(parsed.pipeline, new Set());
    }
    occupied.get(parsed.pipeline)!.add(parsed.color);
  }
  return occupied;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd srb && bun test test/unit/discover-os.test.ts`
Expected: PASS

- [ ] **Step 5: Update `LiveState` type and `discoverLiveState` return**

In `discover.ts`, update the `LiveState` interface:

```typescript
export interface LiveState {
  pipelines: Map<PipelineKey, LivePipelineState>;
  aliases: Map<string, Color>;
  /** Foreign OS indices not managed by Sequin — (pipeline → set of occupied colors) */
  occupiedColors: Map<string, Set<Color>>;
}
```

At the end of `discoverLiveState`, before the `return`, add:

```typescript
// Discover foreign OS indices (exist in OpenSearch but not managed by Sequin)
const managedKeys = new Set(Array.from(pipelines.keys()));
const occupiedColors = findOccupiedOsColors(osIndices, managedKeys);

// Warn about unmanaged indices
for (const [pipeline, colors] of occupiedColors) {
  for (const color of colors) {
    const isActive = aliases.get(pipeline) === color;
    const suffix = isActive ? " (active via alias)" : "";
    console.warn(`⚠ ${pipeline}_${color} exists in OpenSearch but is not managed by Sequin${suffix}`);
  }
}

return { pipelines, aliases, occupiedColors };
```

Update the existing `return` at the bottom to include `occupiedColors`:

Replace: `return { pipelines, aliases };`
With the code above (the warn loop + return).

- [ ] **Step 6: Run typecheck**

Run: `cd srb && bun run typecheck`
Expected: Will fail — callers of `discoverLiveState` don't destructure `occupiedColors` yet. Fixed in Task 7.

- [ ] **Step 7: Commit**

```bash
git add srb/src/state/discover.ts srb/test/unit/discover-os.test.ts
git commit -m "feat: discover foreign OS indices not managed by Sequin"
```

---

### Task 7: TypeScript Implementation — Thread `occupiedColors` Through Planner

**Files:**
- Modify: `srb/src/planner/plan.ts`
- Modify: `srb/src/online/plan.ts`
- Modify: `srb/src/online/apply.ts`
- Create: `srb/test/unit/plan-os.test.ts`

- [ ] **Step 1: Write failing test for `pickTargetColor` with occupied colors**

Create `srb/test/unit/plan-os.test.ts`:

```typescript
import { test, expect, describe } from "bun:test";
import { pickTargetColor } from "../../src/planner/plan.js";
import type { PipelineKey, LivePipelineState } from "../../src/config/types.js";

describe("pickTargetColor with occupiedColors", () => {
  test("skips colors occupied by foreign OS indices", () => {
    const live = new Map<PipelineKey, LivePipelineState>();
    const occupied = new Map([["jobs", new Set(["red" as const])]]);

    const color = pickTargetColor("jobs", live, occupied);

    expect(color).not.toBe("red");
  });

  test("skips both live and occupied colors", () => {
    const live = new Map<PipelineKey, LivePipelineState>([
      ["jobs:black" as PipelineKey, {} as LivePipelineState],
    ]);
    const occupied = new Map([["jobs", new Set(["red" as const])]]);

    const color = pickTargetColor("jobs", live, occupied);

    expect(color).not.toBe("red");
    expect(color).not.toBe("black");
  });

  test("works with no occupied colors (backwards compatible)", () => {
    const live = new Map<PipelineKey, LivePipelineState>();

    const color = pickTargetColor("jobs", live);

    expect(color).toBe("red"); // first available
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd srb && bun test test/unit/plan-os.test.ts`
Expected: FAIL — `pickTargetColor` doesn't accept occupied colors

- [ ] **Step 3: Update `pickTargetColor` in `plan.ts`**

In `srb/src/planner/plan.ts`, update the function signature:

```typescript
/** Pick an available color for a pipeline — first color with no live entry and not occupied by foreign OS index */
export function pickTargetColor(
  pipeline: string,
  live: Map<PipelineKey, LivePipelineState>,
  occupiedColors?: Map<string, Set<Color>>,
): Color {
  const occupied = occupiedColors?.get(pipeline);
  for (const c of ALL_COLORS) {
    if (!live.has(pipelineKey(pipeline, c)) && !occupied?.has(c)) {
      return c;
    }
  }
  return "red";
}
```

- [ ] **Step 4: Update `generatePlans` to accept and pass `occupiedColors`**

```typescript
export function generatePlans(
  desired: Map<string, PipelineConfig>,
  live: Map<PipelineKey, LivePipelineState>,
  _allColors: Color[] = ALL_COLORS,
  aliases?: Map<string, Color>,
  occupiedColors?: Map<string, Set<Color>>,
): Plan[] {
```

Update the `pickTargetColor` call inside:

```typescript
const targetColor = pickTargetColor(pipeline, live, occupiedColors);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd srb && bun test test/unit/plan-os.test.ts`
Expected: PASS

- [ ] **Step 6: Update `srb/src/online/plan.ts` to pass `occupiedColors`**

Read the file first. Update the `planCommand` function to destructure `occupiedColors` from `discoverLiveState` and pass it to `generatePlans`:

Replace:
```typescript
const { pipelines: live, aliases } = await discoverLiveState(sequinCli, sequinApi, os, desired);
const plans = generatePlans(desired, live, ALL_COLORS, aliases);
```

With:
```typescript
const { pipelines: live, aliases, occupiedColors } = await discoverLiveState(sequinCli, sequinApi, os, desired);
const plans = generatePlans(desired, live, ALL_COLORS, aliases, occupiedColors);
```

- [ ] **Step 7: Update `srb/src/online/apply.ts` the same way**

Same change — destructure `occupiedColors` and pass to `generatePlans`.

- [ ] **Step 8: Run typecheck**

Run: `cd srb && bun run typecheck`
Expected: PASS

- [ ] **Step 9: Run all unit tests**

Run: `cd srb && bun test test/unit/`
Expected: All pass

- [ ] **Step 10: Commit**

```bash
git add srb/src/planner/plan.ts srb/src/online/plan.ts srb/src/online/apply.ts srb/test/unit/plan-os.test.ts
git commit -m "feat: pickTargetColor skips colors occupied by foreign OS indices"
```

---

### Task 8: TypeScript Implementation — `cmd_drop` for Foreign OS Indices

**Files:**
- Modify: `srb/src/online/drop.ts` (or wherever `cmd_drop` is implemented)
- Modify: `srb/src/executor/executor.ts` (if drop executor needs changes)

- [ ] **Step 1: Read drop command implementation**

Read `srb/src/online/drop.ts` and `srb/src/executor/executor.ts` to understand how drop currently works. The key change: `cmd_drop` currently requires the pipeline+color to exist in `live_pipelines` (i.e., have a Sequin sink). For foreign OS indices, we need to allow dropping when the index exists in OpenSearch but has no Sequin sink — this means just deleting the OpenSearch index.

- [ ] **Step 2: Update drop to handle foreign-only indices**

After reading the implementation, update the drop command to:
1. Check if the pipeline+color exists in Sequin-managed state OR in `occupiedColors`
2. If Sequin-managed: delete sink + transform + enrichment + index (existing behavior)
3. If foreign-only: delete just the OpenSearch index

The exact code depends on the current structure of `drop.ts` — read it first, then apply the minimal change.

- [ ] **Step 3: Run typecheck**

Run: `cd srb && bun run typecheck`
Expected: PASS

- [ ] **Step 4: Run all unit tests**

Run: `cd srb && bun test test/unit/`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add srb/src/online/drop.ts srb/src/executor/executor.ts
git commit -m "feat: cmd_drop handles foreign OS indices (delete index only)"
```
