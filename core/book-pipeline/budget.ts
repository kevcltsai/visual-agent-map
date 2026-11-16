/**
 * The pipeline's call budget as an {@link AdmissionContext}. Each reservation runs alone (a queue, so five parallel calls
 * on one map cannot all take the last one), is saved before the provider is asked, and counts even if the process dies right
 * after. One gate per map: another map's gate, or a call without a gate, is never touched.
 */
import { BudgetExhaustedError, type AdmissionContext } from "../admission";
import type { PipelineStore } from "./machine";
import { reserveBudget, type PipelineBudget } from "./model";

export interface BudgetPort {
  /** The current budget, read inside the critical section (an owner's raise is seen at once). */
  get(): PipelineBudget;
  /**
   * Saves `next` and makes `get` return it; a rejection means nothing was reserved. In the pipeline this is always
   * {@link createStoreBudgetPort}: the write goes through `PipelineStore.commit`, never around its queue with an old budget.
   */
  persist(next: PipelineBudget): Promise<void>;
}

export function createBudgetAdmission(port: BudgetPort): AdmissionContext {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    reserve(): Promise<void> {
      const step = queue.then(async () => {
        const next = reserveBudget(port.get());
        if (!next) throw new BudgetExhaustedError();
        await port.persist(next);
      });
      queue = step.catch(() => undefined);
      return step;
    }
  };
}

/**
 * The pipeline's port: reads the store's latest budget and saves through `store.commit`, so a reservation shares the one commit
 * queue with every other state change. The change is applied to the latest state (the limit an owner raised meanwhile is kept,
 * `used` never goes down), so a reservation computed before an interleaved commit cannot overwrite it with an old budget.
 */
export function createStoreBudgetPort(store: PipelineStore): BudgetPort {
  return {
    get: () => store.state.budget,
    async persist(next) {
      const done = await store.commit(data => ({
        state: {
          ...data,
          budget: { used: Math.max(data.budget.used, next.used), limit: data.budget.limit },
          revision: data.revision + 1
        },
        accepted: true
      }));
      if (!done) throw new Error("budget not saved: the run was closed");
    }
  };
}
