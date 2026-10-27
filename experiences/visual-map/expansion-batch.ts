import type { MapNode } from "../../map-model";

export interface ExpansionBatchState {
  parentPath: string;
  controller: AbortController;
  total: number;
  /** Children processed (succeeded, failed, skipped or aborted). */
  completed: number;
  /** Children that finished successfully (accepted, not aborted, not skipped). */
  succeeded: number;
  currentPath?: string;
  /** Children waiting for a free slot, in run order; emptied when the batch stops. */
  queuedPaths: string[];
  failures: string[];
  /** Note paths of children that threw while the batch was not aborted, parallel to `failures`. */
  failedPaths: string[];
  status: "running" | "stopped" | "completed";
}

export class ShallowExpansionCoordinator {
  constructor(
    private readonly activeTasks: Map<string, AbortController>,
    private readonly states: Map<string, ExpansionBatchState>
  ) {}

  async start(
    parentPath: string,
    children: MapNode[],
    startChild: (child: MapNode, signal: AbortSignal, accepted: () => void) => Promise<void | "skipped">,
    changed: () => void,
    externalSignal?: AbortSignal,
    /** Children that run at once; 3 unless the caller says otherwise. */
    limit = 3
  ): Promise<void> {
    if (this.isRunning(parentPath)) throw new Error("Shallow research is already running for this topic.");
    const controller = new AbortController();
    const state: ExpansionBatchState = {
      parentPath,
      controller,
      total: children.length,
      completed: 0,
      succeeded: 0,
      queuedPaths: children.map(child => child.path),
      failures: [],
      failedPaths: [],
      status: "running"
    };
    this.activeTasks.set(parentPath, controller);
    const abortFromOwner = (): void => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", abortFromOwner, { once: true });
    this.states.set(parentPath, state);
    changed();
    let acceptFirst: () => void = () => {};
    let rejectFirst: (error: unknown) => void = () => {};
    const accepted = new Promise<void>((resolve, reject) => {
      acceptFirst = resolve;
      rejectFirst = reject;
    });
    void (async () => {
      let dispatchAccepted = false;
      let nextChild = 0;
      const runningPaths = new Set<string>();
      const updateCurrent = (): void => {
        state.currentPath = [...runningPaths][0];
        changed();
      };
      const worker = async (): Promise<void> => {
        while (nextChild < children.length) {
          const child = children[nextChild++];
          if (controller.signal.aborted) break;
          state.queuedPaths = state.queuedPaths.filter(path => path !== child.path);
          runningPaths.add(child.path);
          updateCurrent();
          let acceptedChild = false;
          try {
            const outcome = await startChild(child, controller.signal, () => {
              acceptedChild = true;
              if (!dispatchAccepted) {
                dispatchAccepted = true;
                externalSignal?.removeEventListener("abort", abortFromOwner);
                acceptFirst();
              }
            });
            if (!acceptedChild) throw new Error("Shallow research did not start.");
            if (outcome !== "skipped" && !controller.signal.aborted) state.succeeded++;
          } catch (error) {
            if (!controller.signal.aborted) {
              const message = error instanceof Error ? error.message : String(error);
              state.failures.push(`${child.path}: ${message}`);
              state.failedPaths.push(child.path);
            }
          } finally {
            state.completed++;
            runningPaths.delete(child.path);
            updateCurrent();
          }
        }
      };
      try {
        await Promise.all(
          Array.from({ length: Math.min(Math.max(1, Math.floor(limit) || 3), children.length) }, () => worker())
        );
      } finally {
        state.status = controller.signal.aborted ? "stopped" : "completed";
        state.currentPath = undefined;
        state.queuedPaths = [];
        if (!dispatchAccepted) rejectFirst(new Error("Shallow research stopped before launch."));
        if (this.activeTasks.get(parentPath) === controller) this.activeTasks.delete(parentPath);
        externalSignal?.removeEventListener("abort", abortFromOwner);
        changed();
      }
    })();
    return accepted;
  }

  stop(parentPath: string): void {
    const state = this.states.get(parentPath);
    if (!state) return;
    state.queuedPaths = [];
    state.controller.abort();
  }
  /** Whether a running batch is still waiting to start this note. */
  isQueued(path: string): boolean {
    for (const state of this.states.values())
      if (state.status === "running" && state.queuedPaths.includes(path)) return true;
    return false;
  }
  isRunning(parentPath: string): boolean {
    return this.states.get(parentPath)?.status === "running";
  }
  stopAll(): void {
    for (const state of this.states.values())
      if (state.status === "running") {
        state.queuedPaths = [];
        state.controller.abort();
      }
  }
}
