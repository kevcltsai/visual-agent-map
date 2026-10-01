import type { ExperienceId, ThinkingArtifact } from "./thinking-artifact";

export interface ExperienceHandoff {
  target: ExperienceId;
  artifact: ThinkingArtifact;
}

export type ExperienceHandoffHandler = (artifact: ThinkingArtifact) => Promise<void>;

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

  async handoff({ target, artifact }: ExperienceHandoff): Promise<void> {
    const handler = this.handlers.get(target);
    if (!handler) throw new Error(`Experience is not available: ${target}`);
    await handler(artifact);
  }
}
