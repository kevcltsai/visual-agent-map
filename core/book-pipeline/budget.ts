/**
 * The pipeline's call budget as an {@link AdmissionContext}. Each reservation runs alone (a queue, so five parallel calls
 * on one map cannot all take the last one), is saved before the provider is asked, and counts even if the process dies right
 * after. One gate per map: another map's gate, or a call without a gate, is never touched.
 */
import { BudgetExhaustedError, type AdmissionContext } from "../admission";
import { reserveBudget, type PipelineBudget } from "./model";

export interface BudgetPort {
  /** The current budget, read inside the critical section (an owner's raise is seen at once). */
  get(): PipelineBudget;
  /** Saves `next` and makes `get` return it; a rejection means nothing was reserved. */
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
