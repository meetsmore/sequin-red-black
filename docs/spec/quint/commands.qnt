// The 4 commands: plan, apply, activate, drop
module commands {

  import types.* from "./types"
  import effects.* from "./effects"
  import plan.* from "./plan"
  import state.* from "./state"

  // ---------------------------------------------------------------------------
  // Command: plan
  // Pure computation — compares desired vs live, produces plans
  // ---------------------------------------------------------------------------

  action cmd_plan: bool = all {
    // Precondition: there is desired config loaded
    desired_pipelines.keys().size() > 0,
    // Generate plans for all changed pipelines
    current_plans' = generate_plans(desired_pipelines, live_pipelines, ALL_COLORS, os_indices),
    desired_pipelines' = desired_pipelines,
    live_pipelines' = live_pipelines,
    aliases' = aliases,
    os_indices' = os_indices,
  }

  // ---------------------------------------------------------------------------
  // Command: plan --in-place
  // Like cmd_plan, but for kind=Update pipelines, targets the currently-deployed
  // color and forces a full-update path (no new color rolled, no backfill,
  // no reindex). kind=Create pipelines still fall through to fresh allocation.
  // ---------------------------------------------------------------------------

  action cmd_plan_in_place: bool = all {
    desired_pipelines.keys().size() > 0,
    current_plans' = generate_plans_with_options(desired_pipelines, live_pipelines, ALL_COLORS, os_indices, true),
    desired_pipelines' = desired_pipelines,
    live_pipelines' = live_pipelines,
    aliases' = aliases,
    os_indices' = os_indices,
  }

  // ---------------------------------------------------------------------------
  // Command: apply
  // Same as plan, then execute effects (create resources, trigger backfills)
  // ---------------------------------------------------------------------------

  // Check if a plan creates a new colored variant (vs in-place update)
  pure def plan_creates_new_color(p: Plan): bool =
    p.effects.indices().exists(i => match p.effects[i].effect {
      | CreateIndex(_) => true
      | _ => false
    })

  // Check if a plan uses the reindex path (new color, but no backfill)
  pure def plan_uses_reindex(p: Plan): bool =
    p.effects.indices().exists(i => match p.effects[i].effect {
      | TriggerReindex(_) => true
      | _ => false
    })

  // ---------------------------------------------------------------------------
  // Command: apply --in-place
  // Plan + execute in in-place mode: never roll a new color for an existing
  // pipeline; just refresh transform / enrichment / sink against the
  // currently-deployed color. Pipelines that don't yet exist are created
  // fresh (same as normal apply, since there's nothing to update in place).
  //
  // Skip-backfill is irrelevant here: in-place updates don't trigger a
  // backfill at all (the existing index is reused, document content lineage
  // is preserved). For pipelines created fresh in this same run, backfill
  // follows the normal rule.
  // ---------------------------------------------------------------------------

  action cmd_apply_in_place(skip_backfill: bool): bool = all {
    desired_pipelines.keys().size() > 0,
    val plans = generate_plans_with_options(desired_pipelines, live_pipelines, ALL_COLORS, os_indices, true)
    val new_live = plans.fold(live_pipelines, (acc, p) =>
      if (p.effects.length() == 0 or not(p.pipeline.in(desired_pipelines.keys()))) acc
      else if (not(plan_creates_new_color(p))) {
        // In-place: pipeline is deployed at p.target_color; refresh
        // declarative resources but keep index/lifecycle as-is.
        val cfg = desired_pipelines.get(p.pipeline)
        val existing = acc.get((p.pipeline, p.target_color))
        acc.put((p.pipeline, p.target_color), {
          ...existing,
          sink: { ...existing.sink, config: cfg.sink },
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
      } else {
        // Pipeline doesn't exist yet — fall back to fresh create.
        val cfg = desired_pipelines.get(p.pipeline)
        acc.put((p.pipeline, p.target_color), {
          sink: { config: cfg.sink, lifecycle: SinkActive, backfilling: not(skip_backfill) },
          index: { config: cfg.index, status: IndexGreen, doc_count: 0 },
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

  action cmd_apply(skip_backfill: bool): bool = all {
    // Precondition: desired config exists
    desired_pipelines.keys().size() > 0,
    // Generate fresh plans (apply = plan + execute)
    // TriggerBackfill effects are always in the plan (for user visibility),
    // but when skip_backfill is true, the sink starts without backfilling
    val plans = generate_plans(desired_pipelines, live_pipelines, ALL_COLORS, os_indices)
    // For simplicity in the spec, we model apply as creating all target pipelines at once
    val new_live = plans.fold(live_pipelines, (acc, p) =>
      if (p.effects.length() == 0 or not(p.pipeline.in(desired_pipelines.keys()))) acc
      else if (not(plan_creates_new_color(p))) {
        // In-place update: modify existing live pipeline, no new color
        val cfg = desired_pipelines.get(p.pipeline)
        val existing_color = ALL_COLORS.filter(c => (p.pipeline, c).in(acc.keys())).fold(Red, (a, c) => c)
        val existing = acc.get((p.pipeline, existing_color))
        acc.put((p.pipeline, existing_color), {
          ...existing,
          sink: { ...existing.sink, config: cfg.sink },
        })
      } else {
        // New color: reindex or backfill path
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

  // ---------------------------------------------------------------------------
  // Command: backfill <pipeline> <color>
  // Manually trigger a backfill on a specific colored variant
  // ---------------------------------------------------------------------------

  action cmd_backfill(pipeline: PipelineName, color: Color): bool = all {
    // Precondition: the colored variant exists
    (pipeline, color).in(live_pipelines.keys()),
    // Precondition: not already backfilling
    not(live_pipelines.get((pipeline, color)).sink.backfilling),
    // Start backfilling
    live_pipelines' = live_pipelines.put((pipeline, color),
      { ...live_pipelines.get((pipeline, color)),
        sink: { ...live_pipelines.get((pipeline, color)).sink, backfilling: true }
      }
    ),
    desired_pipelines' = desired_pipelines,
    aliases' = aliases,
    current_plans' = current_plans,
    os_indices' = os_indices,
  }

  // ---------------------------------------------------------------------------
  // Command: activate <pipeline> <color>
  // Swap the root alias to point to the specified colored index
  // ---------------------------------------------------------------------------

  action cmd_activate(pipeline: PipelineName, color: Color): bool = all {
    // Precondition: the colored variant exists
    (pipeline, color).in(live_pipelines.keys()),
    // Precondition: the colored variant is not mid-backfill
    not(live_pipelines.get((pipeline, color)).sink.backfilling),
    // Precondition: the index is not mid-reindex
    live_pipelines.get((pipeline, color)).index.status != IndexReindexing,
    // Swap alias
    aliases' = aliases.put(pipeline, color),
    desired_pipelines' = desired_pipelines,
    live_pipelines' = live_pipelines,
    current_plans' = current_plans,
    os_indices' = os_indices,
  }

  // ---------------------------------------------------------------------------
  // Command: drop <pipeline> <color>
  // Delete all resources for a pipeline+color
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // Model backfill completion (environment action)
  // ---------------------------------------------------------------------------

  action backfill_completes(pipeline: PipelineName, color: Color): bool = all {
    (pipeline, color).in(live_pipelines.keys()),
    live_pipelines.get((pipeline, color)).sink.backfilling,
    live_pipelines' = live_pipelines.put((pipeline, color),
      { ...live_pipelines.get((pipeline, color)),
        sink: { ...live_pipelines.get((pipeline, color)).sink, backfilling: false }
      }
    ),
    desired_pipelines' = desired_pipelines,
    aliases' = aliases,
    current_plans' = current_plans,
    os_indices' = os_indices,
  }

  // ---------------------------------------------------------------------------
  // Model reindex completion (environment action)
  // ---------------------------------------------------------------------------

  action reindex_completes(pipeline: PipelineName, color: Color): bool = all {
    (pipeline, color).in(live_pipelines.keys()),
    live_pipelines.get((pipeline, color)).index.status == IndexReindexing,
    live_pipelines' = live_pipelines.put((pipeline, color),
      { ...live_pipelines.get((pipeline, color)),
        index: { ...live_pipelines.get((pipeline, color)).index, status: IndexGreen }
      }
    ),
    desired_pipelines' = desired_pipelines,
    aliases' = aliases,
    current_plans' = current_plans,
    os_indices' = os_indices,
  }

  // ---------------------------------------------------------------------------
  // Non-deterministic step (for model checking)
  // ---------------------------------------------------------------------------

  action step = any {
    cmd_plan,
    cmd_plan_in_place,
    // Apply with or without backfill
    nondet skip = Set(true, false).oneOf()
    cmd_apply(skip),
    // Apply in-place
    nondet skip2 = Set(true, false).oneOf()
    cmd_apply_in_place(skip2),
    // Manually trigger backfill
    all {
      desired_pipelines.keys().size() > 0,
      nondet p = desired_pipelines.keys().oneOf()
      nondet c = ALL_COLORS.oneOf()
      cmd_backfill(p, c),
    },
    // Activate and drop need parameters — model with nondet
    // Guard: only attempt if desired_pipelines is non-empty (oneOf requires non-empty set)
    all {
      desired_pipelines.keys().size() > 0,
      nondet p = desired_pipelines.keys().oneOf()
      nondet c = ALL_COLORS.oneOf()
      cmd_activate(p, c),
    },
    all {
      desired_pipelines.keys().size() > 0,
      nondet p = desired_pipelines.keys().oneOf()
      nondet c = ALL_COLORS.oneOf()
      cmd_drop(p, c),
    },
    all {
      desired_pipelines.keys().size() > 0,
      nondet p = desired_pipelines.keys().oneOf()
      nondet c = ALL_COLORS.oneOf()
      backfill_completes(p, c),
    },
    all {
      desired_pipelines.keys().size() > 0,
      nondet p = desired_pipelines.keys().oneOf()
      nondet c = ALL_COLORS.oneOf()
      reindex_completes(p, c),
    },
    // Model discovering a foreign OS index
    all {
      nondet p = Set("jobs", "clients", "users").oneOf()
      nondet c = ALL_COLORS.oneOf()
      discover_os_index(p, c),
    },
    // Model loading a config (needed to bootstrap the spec for model checking)
    nondet name = Set("jobs", "clients", "users").oneOf()
    load_desired_config(name, {
      name: name,
      sink: { id: Sid(name), name: name, source_table: name, destination: "opensearch", filters: "", batch_size: 100, transform_id: Tid(name), enrichment_ids: Set(Eid(name)) },
      index: { id: Iid(name), name: name, mappings: "{}", settings: "{}", alias: name },
      transform: { id: Tid(name), name: name, function_body: "identity", input_schema: "{}", output_schema: "{}" },
      enrichment: { id: Eid(name), name: name, source: name, join_column: "id", enrichment_columns: "name" },
      webhooks: List(),
    }),
  }

  // ---------------------------------------------------------------------------
  // Invariants
  // ---------------------------------------------------------------------------

  // 1. Never drop the active color — alias always points to existing pipeline
  val never_drop_active: bool =
    aliases.keys().forall(p =>
      (p, aliases.get(p)).in(live_pipelines.keys())
    )

  // 2. Alias always points to an existing index (same as above for now)
  val alias_integrity: bool =
    aliases.keys().forall(p =>
      (p, aliases.get(p)).in(live_pipelines.keys())
    )

  // 3. No partial resource groups — every live pipeline has all 4 resources with non-empty IDs,
  //    and every webhook within each pipeline has all 3 of its resources with non-empty IDs
  val no_partial_pipelines: bool =
    live_pipelines.keys().forall(k =>
      val lp = live_pipelines.get(k)
      and {
        lp.sink.config.id != Sid(""),
        lp.index.config.id != Iid(""),
        lp.transform.config.id != Tid(""),
        lp.enrichment.config.id != Eid(""),
        lp.webhooks.indices().forall(i => and {
          lp.webhooks[i].sink.config.id != Sid(""),
          lp.webhooks[i].transform.config.id != Tid(""),
          lp.webhooks[i].enrichment.config.id != Eid(""),
        }),
      }
    )

  // 4. Disabled sinks cannot be backfilling
  val disabled_not_backfilling: bool =
    live_pipelines.keys().forall(k =>
      val lp = live_pipelines.get(k)
      lp.sink.lifecycle == SinkDisabled implies not(lp.sink.backfilling)
    )

  // 5. Foreign OS indices and Sequin-managed pipelines never overlap
  val os_live_disjoint: bool =
    os_indices.forall(k => not(k.in(live_pipelines.keys())))

  // 6. Plans never target a color occupied by a foreign OS index
  // Note: not model-checked via `step` because discovery and planning can interleave
  // in the nondeterministic model. Verified by unit tests and enforced by pick_target_color.
  val never_target_occupied_os_color: bool =
    current_plans.forall(p =>
      not((p.pipeline, p.target_color).in(os_indices))
    )

  // 7. In-place plans never roll a new color for a pipeline that already has
  //    one deployed. This is a property of generate_plans_with_options(_, _, _, _, true)
  //    — but as a state invariant it doesn't hold, because cmd_apply leaves
  //    its just-executed (now-deployed) plans in current_plans, whose target
  //    color is now part of `deployed`. Verified instead via test scenarios
  //    in commands_test.qnt that assert the property right after
  //    cmd_plan_in_place / cmd_apply_in_place runs.
  pure def in_place_plans_never_create_index_for_existing(
    desired: PipelineName -> PipelineConfig,
    live: (PipelineName, Color) -> LivePipelineState,
    all_colors: Set[Color],
    os_indices: Set[(PipelineName, Color)]
  ): bool =
    generate_plans_with_options(desired, live, all_colors, os_indices, true).forall(p =>
      val kind = pipeline_change_kind(p.pipeline, desired, live, all_colors)
      if (kind == Update) not(plan_creates_new_color(p)) else true
    )

  // ---------------------------------------------------------------------------
  // Witnesses (liveness) — VIOLATED = good, protocol CAN reach this state
  // ---------------------------------------------------------------------------

  // Witness: a pipeline can be deployed (live state created)
  val witness_pipeline_deployed: bool =
    live_pipelines.keys().size() == 0

  // Witness: an alias can be set (activate succeeds)
  val witness_alias_set: bool =
    aliases.keys().size() == 0

  // Witness: a colored variant can be dropped
  val witness_color_dropped: bool =
    // True when no drop has happened — if violated, drop is reachable
    // A drop means: a pipeline exists in desired but has fewer live colors than were created
    live_pipelines.keys().size() == 0 or
    desired_pipelines.keys().forall(p =>
      ALL_COLORS.forall(c =>
        not((p, c).in(live_pipelines.keys())) or p.in(aliases.keys())
      )
    )

  // Witness: backfill can complete
  val witness_backfill_completes: bool =
    not(live_pipelines.keys().exists(k =>
      live_pipelines.get(k).sink.lifecycle == SinkActive and not(live_pipelines.get(k).sink.backfilling)
    ))

  // Witness: a full cycle can complete (deploy, backfill, activate, drop old)
  val witness_full_cycle: bool =
    not(
      aliases.keys().size() > 0 and
      live_pipelines.keys().size() > 0 and
      aliases.keys().exists(p =>
        val alias_color = aliases.get(p)
        ALL_COLORS.exists(c2 => c2 != alias_color and not((p, c2).in(live_pipelines.keys())))
      )
    )
}
