import { ExperienceRouter } from "./experience-router";
import type { AiRuntimeService } from "./ai-runtime-service";
import type { AiTaskService } from "./ai-task-service";

export class ThinkingCore {
  readonly experiences = new ExperienceRouter();
  constructor(
    readonly ai: AiRuntimeService,
    readonly tasks: AiTaskService
  ) {}
}
