import type { ExperienceId, ThinkingArtifact } from "./thinking-artifact";

export interface ExperienceHandoff {
  target: ExperienceId;
  artifact: ThinkingArtifact;
  beforeWrite?: () => Promise<void>;
}

export interface ExperienceHandoffResult { paths: string[]; targetPath: string; navigationError?: string }
export class HandoffWriteError extends Error {
  constructor(message: string, readonly paths: string[]) { super(message); this.name = "HandoffWriteError"; }
}
export function isHandoffWriteError(value: unknown): value is HandoffWriteError {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.name === "HandoffWriteError" && typeof item.message === "string" && Array.isArray(item.paths) && item.paths.every(path => typeof path === "string");
}
export type ExperienceHandoffHandler = (artifact: ThinkingArtifact, beforeWrite?: () => Promise<void>) => Promise<ExperienceHandoffResult | void>;

export class ExperienceRouter {
  private readonly handlers = new Map<ExperienceId, ExperienceHandoffHandler>();

  register(target: ExperienceId, handler: ExperienceHandoffHandler): () => void {
    if (this.handlers.has(target)) throw new Error(`Experience already registered: ${target}`);
    this.handlers.set(target, handler);
    return () => {
      if (this.handlers.get(target) === handler) this.handlers.delete(target);
    };
  }

  canHandoff(target: ExperienceId): boolean {
    return this.handlers.has(target);
  }

  async handoff({ target, artifact, beforeWrite }: ExperienceHandoff): Promise<ExperienceHandoffResult | void> {
    const handler = this.handlers.get(target);
    if (!handler) throw new Error(`Experience is not available: ${target}`);
    return await handler(artifact, beforeWrite);
  }
}
