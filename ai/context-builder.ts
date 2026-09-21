import type { AiTaskKind, PreparedTaskContext, TaskContext } from "./types";

export const estimateTokens = (value: string | undefined): number => Math.ceil((value || "").length / 4);
const dedupeRules = (value: string): string => Array.from(new Map(value.split("\n").map(line => line.trim()).filter(Boolean).map(line => [line.replace(/\s+/g, " ").toLowerCase(), line])).values()).join("\n");

export function buildPreparedTaskContext(input: TaskContext, model: string, budget = 32_000): PreparedTaskContext {
  const started = Date.now(), mode: AiTaskKind = input.mode || "task";
  const context: TaskContext = { ...input, rules: dedupeRules(input.rules), ancestors: input.ancestors.replace(/^\s*AI 規則：.*(?:\n|$)/gm, "").trim() };
  if (mode === "decompose") { context.detail = ""; context.workingFindings = ""; }
  const optional: ("sourceContext" | "workingFindings" | "detail" | "ancestors")[] = ["detail", "workingFindings", "ancestors", "sourceContext"];
  const used = (): number => [context.title, context.summary, context.rules, context.detail, context.task, context.ancestors, context.workingFindings, context.sourceContext].reduce((sum, value) => sum + estimateTokens(value), 0);
  for (const key of optional) if (used() > budget && context[key]) context[key] = String(context[key]).slice(0, Math.max(0, (budget - used() + estimateTokens(String(context[key]))) * 4));
  const contextBreakdown = { task: estimateTokens(context.task), currentSummary: estimateTokens(context.summary), currentDetail: estimateTokens(context.detail), effectiveRules: estimateTokens(context.rules), ancestors: estimateTokens(context.ancestors), workingFindings: estimateTokens(context.workingFindings), sourceContext: estimateTokens(context.sourceContext) };
  const estimatedInputTokens = [contextBreakdown.task, contextBreakdown.currentSummary, contextBreakdown.currentDetail, contextBreakdown.effectiveRules, contextBreakdown.ancestors, contextBreakdown.workingFindings, contextBreakdown.sourceContext].reduce((sum, count) => sum + count, 0);
  return { context, metrics: { provider: "codex", model, mode, estimatedInputTokens, contextBreakdown, contextBuildMs: Date.now() - started, sessionStrategy: "fresh-session-per-node-task" } };
}
