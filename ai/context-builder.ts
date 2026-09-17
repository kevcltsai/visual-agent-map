import type { AiTaskKind, PreparedTaskContext, TaskContext } from "./types";

export const estimateTokens = (value: string | undefined): number => Math.ceil((value || "").length / 4);
const dedupeRules = (value: string): string => Array.from(new Map(value.split("\n").map(line => line.trim()).filter(Boolean).map(line => [line.replace(/\s+/g, " ").toLowerCase(), line])).values()).join("\n");

export function buildPreparedTaskContext(input: TaskContext, model: string, budget = 32_000): PreparedTaskContext {
  const started = Date.now(), mode: AiTaskKind = input.mode || "task";
  const context: TaskContext = { ...input, rules: dedupeRules(input.rules), ancestors: input.ancestors.replace(/^\s*AI 規則：.*(?:\n|$)/gm, "").trim() };
  if (mode === "decompose") { context.detail = ""; context.sourceContext = ""; context.workingFindings = ""; }
  if (mode === "task" && context.summary.trim() && !/(延續|修改|既有|原有|更新)/.test(context.task)) context.detail = "";
  const optional: ("sourceContext" | "workingFindings" | "detail" | "ancestors")[] = ["sourceContext", "workingFindings", "detail", "ancestors"];
  const used = (): number => Object.values(context).reduce((sum, value) => sum + (typeof value === "string" ? estimateTokens(value) : 0), 0);
  for (const key of optional) if (used() > budget && context[key]) context[key] = String(context[key]).slice(0, Math.max(0, (budget - used() + estimateTokens(String(context[key]))) * 4));
  const contextBreakdown = { task: estimateTokens(context.task), currentSummary: estimateTokens(context.summary), currentDetail: estimateTokens(context.detail), effectiveRules: estimateTokens(context.rules), ancestors: estimateTokens(context.ancestors), workingFindings: estimateTokens(context.workingFindings), sourceContext: estimateTokens(context.sourceContext) };
  return { context, metrics: { provider: model.startsWith("claude:") ? "claude" : "codex", model, mode, estimatedInputTokens: Object.values(contextBreakdown).reduce((a, b) => a + b, 0), contextBreakdown, contextBuildMs: Date.now() - started, sessionStrategy: "fresh-session-per-node-task" } };
}
