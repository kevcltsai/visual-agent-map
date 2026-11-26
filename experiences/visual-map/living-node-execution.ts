import { shouldRunLivingNode, type LivingNodePlan } from "./living-node-plan";

export type LivingValidity = "none" | "valid" | "stale";
export type LivingSettlement = "changed" | "no-change" | "reused" | "failed" | "blocked" | "cancelled" | "not-run";

export interface LivingDispatchState {
  validity: LivingValidity;
  locked: boolean;
  /** False when the original execution snapshot is no longer applicable. */
  current: boolean;
}

export interface LivingExecutionPort {
  signal: AbortSignal;
  /** Re-read after upstream settlement; must evaluate derived staleness against actual output revisions. */
  inspect(id: string): Promise<LivingDispatchState>;
  /** Must validate the frozen execution snapshot and commit atomically, or throw without writing. */
  execute(id: string, signal: AbortSignal): Promise<"changed" | "no-change">;
  /** A read-only observation of progress; never a knowledge write. */
  onSettled?(id: string, result: LivingSettlement): void;
}

const usable = (state: LivingSettlement | undefined): boolean =>
  state === "changed" || state === "no-change" || state === "reused";

/** Sequential dispatch. The port owns snapshots, provider cancellation and the atomic commit boundary. */
export async function executeLivingPlan(plan: LivingNodePlan, port: LivingExecutionPort) {
  const results = new Map<string, LivingSettlement>();
  const settle = (id: string, result: LivingSettlement): void => {
    results.set(id, result);
    try {
      port.onSettled?.(id, result);
    } catch {
      // A repaint failure cannot turn a committed result into a failed AI run.
    }
  };
  for (const id of plan.blocked.keys()) settle(id, "blocked");
  for (const id of plan.lockedTargets) settle(id, "not-run");
  const frozen = new Set(plan.frozen);
  for (const item of plan.order) {
    if (port.signal.aborted) {
      settle(item.id, "not-run");
      continue;
    }
    try {
      let blocked = false;
      for (const dep of plan.dependencies.get(item.id) ?? []) {
        if (frozen.has(dep)) {
          const state = await port.inspect(dep);
          if (!state.current || !state.locked || state.validity === "none") {
            blocked = true;
            break;
          }
        } else if (!usable(results.get(dep))) {
          blocked = true;
          break;
        }
      }
      if (port.signal.aborted) {
        settle(item.id, "not-run");
        continue;
      }
      if (blocked) {
        settle(item.id, "blocked");
        continue;
      }
      const state = await port.inspect(item.id);
      if (port.signal.aborted) {
        settle(item.id, "not-run");
        continue;
      }
      if (!state.current || state.locked) {
        settle(item.id, "blocked");
        continue;
      }
      if (!shouldRunLivingNode(item.forced, state.validity)) {
        settle(item.id, "reused");
        continue;
      }
      // A returned success denotes an already committed result. Stop cannot undo that commit.
      const result = await port.execute(item.id, port.signal);
      settle(item.id, result);
    } catch {
      settle(item.id, port.signal.aborted ? "cancelled" : "failed");
    }
  }
  return results;
}
