/**
 * The plugin-level registry of topic AI runs: which topics have a run in flight and the controller that stops each.
 * It imports neither obsidian nor the view; everything it needs from the plugin comes through lazy ports, because the
 * plugin replaces some of those objects after construction.
 */
export type TopicRunKind =
  "research" | "proposeChildren" | "integrateDirection" | "integrateChildren" | "synthesizeSelection";

export interface TopicRunPorts {
  /** Read on every use, never captured at construction. */
  aiTasks(): unknown;
  mutate(): <T>(work: () => Promise<T>) => Promise<T>;
  progress(): unknown;
  repository(): unknown;
  isUnloaded(): boolean;
}

export interface TopicRunHandle {
  readonly path: string;
  readonly kind: TopicRunKind;
  readonly signal: AbortSignal;
  /** Frees the topic. A release from a run that was already replaced does nothing. */
  release(): void;
}

export class TopicRuns {
  /** Topics with a run in flight. The plugin exposes this same object as `running`. */
  readonly running = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private disposed = false;

  constructor(readonly ports: TopicRunPorts) {}

  /** Registers a run for the topic. Returns null when the topic already has one or the module is disposed. */
  begin(path: string, kind: TopicRunKind): TopicRunHandle | null {
    if (this.disposed || this.controllers.has(path)) return null;
    const controller = new AbortController();
    this.controllers.set(path, controller);
    this.running.add(path);
    return {
      path,
      kind,
      signal: controller.signal,
      release: () => {
        if (this.controllers.get(path) !== controller) return;
        this.controllers.delete(path);
        this.running.delete(path);
      }
    };
  }

  isRunning(path: string): boolean {
    return this.controllers.has(path);
  }

  stop(path: string): void {
    this.controllers.get(path)?.abort();
  }

  stopAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
  }

  /** Stops every run and refuses new ones. */
  dispose(): void {
    this.disposed = true;
    this.stopAll();
  }
}
