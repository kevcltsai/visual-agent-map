import type { ReasoningLevel } from "./types";

/** The only hard-coded model id. Every other place reads the current model from settings or resolves it here. */
export const FALLBACK_MODEL = "gpt-5.6-luna";

export interface ModelChoice {
  model: string;
  reasoning: ReasoningLevel;
}

export interface ModelResolutionInput {
  /** A model chosen for this one run only. An empty model does not count as chosen. */
  runOnce?: { model: string; reasoning?: ReasoningLevel } | null;
  /** The topic's own manual model, or the nearest manual ancestor's (null when there is none). */
  override?: ModelChoice | null;
  /** The current model from settings. */
  current: ModelChoice;
}

/** Priority: run-once, then topic override (inherited upward), then the current model. */
export function resolveTaskModel(
  input: ModelResolutionInput
): ModelChoice & { origin: "run-once" | "override" | "current" } {
  const once = input.runOnce?.model?.trim();
  if (once) {
    return { model: once, reasoning: input.runOnce?.reasoning ?? input.current.reasoning, origin: "run-once" };
  }
  const own = input.override?.model?.trim();
  if (input.override && own) return { model: own, reasoning: input.override.reasoning, origin: "override" };
  return { model: input.current.model, reasoning: input.current.reasoning, origin: "current" };
}
