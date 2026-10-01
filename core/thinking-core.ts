import { ExperienceRouter } from "./experience-router";
import type { AiRuntimeService } from "./ai-runtime-service";

export class ThinkingCore {
  readonly experiences = new ExperienceRouter();
  constructor(readonly ai: AiRuntimeService) {}
}
