import type { AiResult } from "../ai/types";

export const MINDSEARCH_MAX_RESEARCH_TURNS = 2;
export type MindSearchReviewDecision = "research_more" | "ask_user" | "conclude";
export interface MindSearchPlannerReview {
  decision: MindSearchReviewDecision;
  rationale: string;
  stopReason?: string;
  question?: string;
  researchTarget?: { title: string; task: string; expectedValue: string };
  answerOptions?: string[];
  summary: string;
  detail: string;
}

const marker = /^\s*<!--\s*mindsearch-review\s+(\{[^\n]*\})\s*-->\s*/;

/** Parses the small machine-readable Planner decision embedded in the normal VAM AiResult contract. */
export function parseMindSearchPlannerReview(result: AiResult): MindSearchPlannerReview {
  const match = result.detail.match(marker);
  if (!match) throw new Error("Planner review is missing its machine-readable decision block.");
  let value: unknown;
  try { value = JSON.parse(match[1]); } catch { throw new Error("Planner review decision block is not valid JSON."); }
  if (!value || typeof value !== "object") throw new Error("Planner review decision block must be an object.");
  const raw = value as Record<string, unknown>;
  if (!["research_more", "ask_user", "conclude"].includes(String(raw.decision))) throw new Error("Planner review decision must be research_more, ask_user, or conclude.");
  const decision = raw.decision as MindSearchReviewDecision;
  const rationale = typeof raw.rationale === "string" ? raw.rationale.trim() : "";
  if (!rationale) throw new Error("Planner review must explain the evidence-based reason for its decision.");
  const summary = result.summary.trim();
  const detail = result.detail.slice(match[0].length).trim();
  if (!summary || !detail) throw new Error("Planner review must include a useful supported answer or interim conclusion.");
  if (decision === "conclude") {
    const stopReason = typeof raw.stopReason === "string" ? raw.stopReason.trim() : "";
    if (!stopReason) throw new Error("A conclude decision must record why research should stop.");
    return { decision, rationale, stopReason, summary, detail };
  }
  if (decision === "research_more") {
    const target = result.suggestions[0];
    if (!target?.title.trim() || !target.task.trim() || !target.contribution.trim()) throw new Error("research_more requires one targeted question, a search instruction, and the uncertainty it should reduce.");
    return { decision, rationale, researchTarget: { title: target.title.trim(), task: target.task.trim(), expectedValue: target.contribution.trim() }, summary, detail };
  }
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  const answerOptions = [...new Set(result.suggestions.map(item => item.title.trim()).filter(Boolean))];
  if (!question || answerOptions.length < 2 || answerOptions.length > 5) throw new Error("ask_user requires one material question and 2–5 distinct answer options.");
  return { decision, rationale, question, answerOptions, summary, detail };
}

export interface PlannerReviewRecoveryContext {
  question: string;
  answerSnapshot: string;
  reportSummary: string;
  reportDetail: string;
}

/** Parse a Planner decision and allow one local format-repair turn on the same evidence. */
export async function parseMindSearchPlannerReviewWithRecovery(
  original: AiResult,
  context: PlannerReviewRecoveryContext,
  recover: (task: string) => Promise<AiResult>
): Promise<MindSearchPlannerReview> {
  try {
    return parseMindSearchPlannerReview(original);
  } catch (formatError) {
    const task = [
      "The preceding Planner response did not satisfy the required machine-readable decision contract.",
      "Make one local format-repair review using only the same saved report and answer snapshot below. Do not search, repeat research, add evidence, or invent facts. Re-evaluate which decision is supported: research_more, ask_user, or conclude. Do not default to any decision merely to repair the format.",
      "Return the ordinary VAM structured response with a useful conditional answer in summary/detail and exactly one valid decision marker as the first line of detail: <!-- mindsearch-review {\"decision\":\"research_more|ask_user|conclude\",\"rationale\":\"evidence-based reason\",\"stopReason\":\"why research stops, for conclude only\",\"question\":\"user question, for ask_user only\"} -->. Use valid single-line JSON and only fields needed for the selected decision.",
      "For research_more, provide exactly one targeted suggestion with title, search task, and expected uncertainty reduction. For ask_user, provide 2–5 distinct choices in suggestions[].title. For conclude, include a stopReason. Preserve supplied values and provenance; never answer for the user or ask whether synthetic test data is real. Keep source claims, inference, uncertainty, and limits distinct.",
      `Format validation error: ${formatError instanceof Error ? formatError.message : String(formatError)}`,
      `Original question: ${context.question}`,
      `Answer snapshot (including provenance): ${context.answerSnapshot}`,
      `Already completed report summary:\n${context.reportSummary}`,
      `Already completed report detail:\n${context.reportDetail}`,
      `Original Planner response to review:\nSummary: ${original.summary}\n\nDetail:\n${original.detail}\n\nSuggestions: ${JSON.stringify(original.suggestions)}`
    ].join("\n\n");
    const repaired = await recover(task);
    return parseMindSearchPlannerReview(repaired);
  }
}
