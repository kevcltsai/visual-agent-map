import { validateMindSearchResearchPlan, type MindSearchResearchPlan, type MindSearchResearchTarget } from "./research-plan";

function abortError(): Error { const error = new Error("The operation was aborted."); error.name = "AbortError"; return error; }

/** Starts dependents only after persisted predecessor reports; drains siblings before reporting failure. */
export async function scheduleMindSearchResearch<T>(
  plan: MindSearchResearchPlan,
  execute: (target: MindSearchResearchTarget, predecessors: ReadonlyMap<string, T>, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal
): Promise<Map<string, T>> {
  validateMindSearchResearchPlan(plan);
  const parallel = plan.every(item => Array.isArray(item.dependsOn));
  const limit = parallel ? 2 : 1;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const completed = new Map<string, T>(), pending = [...plan];
  type Settled = { id: string; ok: true; value: T } | { id: string; ok: false; error: unknown };
  const active = new Map<string, Promise<Settled>>();
  try {
    while (pending.length || active.size) {
      if (controller.signal.aborted) throw abortError();
      while (active.size < limit) {
        const index = pending.findIndex(target => (target.dependsOn ?? []).every(id => completed.has(id)));
        if (index === -1) break;
        const target = pending.splice(index, 1)[0];
        const predecessors = new Map((target.dependsOn ?? []).map(id => [id, completed.get(id)!]));
        const task: Promise<Settled> = Promise.resolve().then(() => {
          if (controller.signal.aborted) throw abortError();
          return execute(target, predecessors, controller.signal);
        }).then(value => ({ id: target.id, ok: true as const, value }), (error: unknown) => ({ id: target.id, ok: false as const, error }));
        active.set(target.id, task);
      }
      if (!active.size) throw new Error("Research dependencies cannot make progress.");
      const next = await Promise.race(active.values());
      active.delete(next.id);
      if (!next.ok) throw next.error;
      completed.set(next.id, next.value);
    }
    if (controller.signal.aborted) throw abortError();
    return completed;
  } finally {
    // Failure does not cancel successful siblings; user cancellation aborts every task.
    await Promise.all(active.values());
    signal?.removeEventListener("abort", abort);
  }
}
