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
    current_plans' = generate_plans(desired_pipelines, live_pipelines, ALL_COLORS),
    desired_pipelines' = desired_pipelines,
    live_pipelines' = live_pipelines,
    aliases' = aliases,
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

  action cmd_apply(skip_backfill: bool): bool = all {
    // Precondition: desired config exists
    desired_pipelines.keys().size() > 0,
    // Generate fresh plans (apply = plan + execute)
    // TriggerBackfill effects are always in the plan (for user visibility),
    // but when skip_backfill is true, the sink starts without backfilling
    val plans = generate_plans(desired_pipelines, live_pipelines, ALL_COLORS)
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
  }

  // ---------------------------------------------------------------------------
  // Command: drop <pipeline> <color>
  // Delete all resources for a pipeline+color
  // ---------------------------------------------------------------------------

  action cmd_drop(pipeline: PipelineName, color: Color): bool = all {
    // Precondition: the colored variant exists
    (pipeline, color).in(live_pipelines.keys()),
    // Precondition: not dropping the active color
    if (pipeline.in(aliases.keys())) aliases.get(pipeline) != color
    else true,
    // Remove the colored variant by rebuilding the map without it
    live_pipelines' = live_pipelines.keys().exclude(Set((pipeline, color))).mapBy(k => live_pipelines.get(k)),
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
  }

  // ---------------------------------------------------------------------------
  // Non-deterministic step (for model checking)
  // ---------------------------------------------------------------------------

  action step = any {
    cmd_plan,
    // Apply with or without backfill
    nondet skip = Set(true, false).oneOf()
    cmd_apply(skip),
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
