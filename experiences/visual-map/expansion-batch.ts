import type { MapNode } from "../../map-model";

export interface ExpansionBatchState {
  parentPath: string;
  controller: AbortController;
  total: number;
  completed: number;
  currentPath?: string;
  failures: string[];
  status: "running" | "stopped" | "completed";
}

export class ShallowExpansionCoordinator {
  constructor(private readonly activeTasks: Map<string, AbortController>, private readonly states: Map<string, ExpansionBatchState>) {}

  async start(parentPath: string, children: MapNode[], startChild: (child: MapNode, signal: AbortSignal, accepted: () => void) => Promise<void>, changed: () => void, externalSignal?: AbortSignal): Promise<void> {
    if (this.isRunning(parentPath)) throw new Error("Shallow research is already running for this topic.");
    const controller = new AbortController();
    const state: ExpansionBatchState = { parentPath, controller, total: children.length, completed: 0, failures: [], status: "running" };
    this.activeTasks.set(parentPath, controller);
    const abortFromOwner = (): void => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", abortFromOwner, { once: true });
    this.states.set(parentPath, state);
    changed();
    let acceptFirst: () => void = () => {};
    let rejectFirst: (error: unknown) => void = () => {};
    const accepted = new Promise<void>((resolve, reject) => { acceptFirst = resolve; rejectFirst = reject; });
    void (async () => {
      let dispatchAccepted = false;
      let nextChild = 0;
      const runningPaths = new Set<string>();
      const updateCurrent = (): void => { state.currentPath = [...runningPaths][0]; changed(); };
      const worker = async (): Promise<void> => {
        while (nextChild < children.length) {
          const child = children[nextChild++];
          if (controller.signal.aborted) break;
          runningPaths.add(child.path);
          updateCurrent();
          let acceptedChild = false;
          try {
            await startChild(child, controller.signal, () => {
              acceptedChild = true;
              if (!dispatchAccepted) { dispatchAccepted = true; externalSignal?.removeEventListener("abort", abortFromOwner); acceptFirst(); }
            });
            if (!acceptedChild) throw new Error("Shallow research did not start.");
          } catch (error) {
            if (!controller.signal.aborted) {
              const message = error instanceof Error ? error.message : String(error);
              state.failures.push(`${child.path}: ${message}`);
            }
          } finally {
            state.completed++;
            runningPaths.delete(child.path);
            updateCurrent();
          }
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(3, children.length) }, () => worker()));
      } finally {
        state.status = controller.signal.aborted ? "stopped" : "completed";
        state.currentPath = undefined;
        if (!dispatchAccepted) rejectFirst(new Error("Shallow research stopped before launch."));
        if (this.activeTasks.get(parentPath) === controller) this.activeTasks.delete(parentPath);
        externalSignal?.removeEventListener("abort", abortFromOwner);
        changed();
      }
    })();
    return accepted;
  }

  stop(parentPath: string): void { this.states.get(parentPath)?.controller.abort(); }
  isRunning(parentPath: string): boolean { return this.states.get(parentPath)?.status === "running"; }
  stopAll(): void { for (const state of this.states.values()) if (state.status === "running") state.controller.abort(); }
}
