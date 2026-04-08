// Red-black deployment orchestration
module redblack {

  import types.* from "./types"
  import plan.* from "./plan"

  // ---------------------------------------------------------------------------
  // Deployment phases
  // ---------------------------------------------------------------------------

  type DeployPhase =
    | Idle
    | Planning
    | Awaiting_Approval
    | Deploying_Inactive
    | Verifying
    | Swapping
    | Cleaning_Up
    | Done
    | Rolled_Back

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var phase: DeployPhase
  var active_color: Color

  // ---------------------------------------------------------------------------
  // Phase transitions
  // ---------------------------------------------------------------------------

  action start_planning: bool = all {
    phase == Idle,
    phase' = Planning,
    active_color' = active_color,
  }

  action plan_ready: bool = all {
    phase == Planning,
    phase' = Awaiting_Approval,
    active_color' = active_color,
  }

  action approve_plan: bool = all {
    phase == Awaiting_Approval,
    phase' = Deploying_Inactive,
    active_color' = active_color,
  }

  action reject_plan: bool = all {
    phase == Awaiting_Approval,
    phase' = Idle,
    active_color' = active_color,
  }

  action deploy_to_inactive: bool = all {
    phase == Deploying_Inactive,
    // TODO: apply each effect in order, respecting dependencies
    phase' = Verifying,
    active_color' = active_color,
  }

  action verify_inactive: bool = all {
    phase == Verifying,
    // TODO: health checks pass
    phase' = Swapping,
    active_color' = active_color,
  }

  action verification_failed: bool = all {
    phase == Verifying,
    phase' = Rolled_Back,
    active_color' = active_color,
  }

  // Swap traffic from active to inactive
  action swap_colors: bool = all {
    phase == Swapping,
    phase' = Cleaning_Up,
    active_color' = inactive_color(active_color),
  }

  action cleanup: bool = all {
    phase == Cleaning_Up,
    // TODO: tear down or mark old color resources
    phase' = Done,
    active_color' = active_color,
  }

  action reset: bool = all {
    phase == Done,
    phase' = Idle,
    active_color' = active_color,
  }

  action reset_from_rollback: bool = all {
    phase == Rolled_Back,
    phase' = Idle,
    active_color' = active_color,
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  pure def inactive_color(c: Color): Color =
    match c {
      | Red => Black
      | Black => Red
    }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  action init = all {
    phase' = Idle,
    active_color' = Red,
  }

  // ---------------------------------------------------------------------------
  // Step: non-deterministic choice of next action
  // ---------------------------------------------------------------------------

  action step = any {
    start_planning,
    plan_ready,
    approve_plan,
    reject_plan,
    deploy_to_inactive,
    verify_inactive,
    verification_failed,
    swap_colors,
    cleanup,
    reset,
    reset_from_rollback,
  }

  // ---------------------------------------------------------------------------
  // Invariants
  // ---------------------------------------------------------------------------

  // We never swap without going through verification
  val no_unverified_swap =
    (phase == Swapping) implies true  // TODO: track that verify ran

  // Phase transitions are valid (no skipping phases)
  val valid_phase = or {
    phase == Idle,
    phase == Planning,
    phase == Awaiting_Approval,
    phase == Deploying_Inactive,
    phase == Verifying,
    phase == Swapping,
    phase == Cleaning_Up,
    phase == Done,
    phase == Rolled_Back,
  }
}
