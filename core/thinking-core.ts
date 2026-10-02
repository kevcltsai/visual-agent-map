import { ExperienceRouter } from "./experience-router";
import type { AiRuntimeService } from "./ai-runtime-service";
import type { AiTaskService } from "./ai-task-service";
import { ReframingLayer } from "./reframing-layer";

export class ThinkingCore {
  readonly experiences = new ExperienceRouter();
  readonly reframing: ReframingLayer;
  constructor(
    readonly ai: AiRuntimeService,
    readonly tasks: AiTaskService
  ) { this.reframing = new ReframingLayer(tasks); }
}
