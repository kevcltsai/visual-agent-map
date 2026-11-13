import type { AiTaskKind, PreparedTaskContext, TaskContext } from "./types";

/** Estimated tokens allowed for source content (about 192k characters). */
export const SOURCE_CONTEXT_TOKEN_BUDGET = 48_000;
export const estimateTokens = (value: string | undefined): number => Math.ceil((value || "").length / 4);
const dedupeRules = (value: string): string =>
  Array.from(
    new Map(
      value
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => [line.replace(/\s+/g, " ").toLowerCase(), line])
    ).values()
  ).join("\n");

/** Estimated tokens of the parts the budget step counts; the one definition of "the full request" for the budget. */
export function contextTokens(
  context: Pick<
    TaskContext,
    "title" | "summary" | "rules" | "detail" | "task" | "ancestors" | "workingFindings" | "sourceContext" | "anchorContext"
  >
): number {
  return [
    context.title,
    context.summary,
    context.rules,
    context.detail,
    context.task,
    context.ancestors,
    context.workingFindings,
    context.sourceContext,
    context.anchorContext
  ].reduce((sum, value) => sum + estimateTokens(value), 0);
}

export function buildPreparedTaskContext(
  input: TaskContext,
  model: string,
  budget = SOURCE_CONTEXT_TOKEN_BUDGET,
  provider = "codex"
): PreparedTaskContext {
  const started = Date.now(),
    mode: AiTaskKind = input.mode || "task";
  const context: TaskContext = {
    ...input,
    rules: dedupeRules(input.rules),
    ancestors: input.ancestors.replace(/^\s*AI 規則：.*(?:\n|$)/gm, "").trim()
  };
  if (mode === "decompose") {
    context.detail = "";
    context.workingFindings = "";
  }
  // A fresh write-back never shows the old Detail to the model.
  if (input.updateMode === "fresh") context.detail = "";
  // anchorContext is cut last: it is small (the data layer limits it) and it is what the user marked on purpose.
  const optional: ("sourceContext" | "workingFindings" | "detail" | "ancestors" | "anchorContext")[] = [
    "detail",
    "workingFindings",
    "ancestors",
    "sourceContext",
    "anchorContext"
  ];
  const used = (): number => contextTokens(context);
  for (const key of optional)
    if (used() > budget && context[key])
      context[key] = String(context[key]).slice(
        0,
        Math.max(0, (budget - used() + estimateTokens(String(context[key]))) * 4)
      );
  const contextBreakdown = {
    task: estimateTokens(context.task),
    currentSummary: estimateTokens(context.summary),
    currentDetail: estimateTokens(context.detail),
    effectiveRules: estimateTokens(context.rules),
    ancestors: estimateTokens(context.ancestors),
    workingFindings: estimateTokens(context.workingFindings),
    sourceContext: estimateTokens(context.sourceContext),
    anchorContext: estimateTokens(context.anchorContext)
  };
  const estimatedInputTokens = [
    contextBreakdown.task,
    contextBreakdown.currentSummary,
    contextBreakdown.currentDetail,
    contextBreakdown.effectiveRules,
    contextBreakdown.ancestors,
    contextBreakdown.workingFindings,
    contextBreakdown.sourceContext,
    contextBreakdown.anchorContext
  ].reduce((sum, count) => sum + count, 0);
  return {
    context,
    metrics: {
      provider,
      model,
      mode,
      estimatedInputTokens,
      contextBreakdown,
      contextBuildMs: Date.now() - started,
      sessionStrategy: "fresh-session-per-node-task"
    }
  };
}
