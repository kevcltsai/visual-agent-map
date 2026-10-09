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

interface ParsedMarker {
  raw: Record<string, unknown>;
  body: string;
}

function readMarker(detail: string): ParsedMarker | undefined {
  const match = detail.match(marker);
  if (!match) return undefined;
  try {
    const value: unknown = JSON.parse(match[1]);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return { raw: value as Record<string, unknown>, body: detail.slice(match[0].length).trim() };
  } catch {
    return undefined;
  }
}

function isDecision(value: unknown): value is MindSearchReviewDecision {
  return value === "research_more" || value === "ask_user" || value === "conclude";
}

/** Extract only a clearly labeled option list; ordinary report bullets are not answer choices. */
function extractExplicitOptions(body: string, question: string): string[] {
  const onlyQuestionAndChoices = body.startsWith(question) ? body.slice(question.length).trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [];
  if (onlyQuestionAndChoices.length >= 2 && onlyQuestionAndChoices.length <= 5 && onlyQuestionAndChoices.every(line => /^[-*•]\s+\S/.test(line))) {
    const choices = [...new Set(onlyQuestionAndChoices.map(line => line.replace(/^[-*•]\s+/, "")))];
    if (choices.length >= 2) return choices;
  }
  const lines = body.split(/\r?\n/);
  const options: string[] = [];
  let inOptions = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inOptions && options.length) break;
      continue;
    }
    if (/^(?:#{1,6}\s*)?(?:answer\s+options|options|選項|可選答案)\s*[:：]?\s*$/i.test(trimmed)) {
      inOptions = true;
      continue;
    }
    if (!inOptions) continue;
    const option = trimmed.match(/^(?:[-*•]|\d+[.)、])\s+(.+?)\s*$/)?.[1]?.trim();
    if (!option) break;
    options.push(option);
    if (options.length > 5) return [];
  }
  const unique = [...new Set(options)];
  return unique.length >= 2 && unique.length <= 5 ? unique : [];
}

/** Parses the small machine-readable Planner decision embedded in the normal VAM AiResult contract. */
export function parseMindSearchPlannerReview(result: AiResult): MindSearchPlannerReview {
  const match = result.detail.match(marker);
  if (!match) throw new Error("Planner review is missing its machine-readable decision block.");
  let value: unknown;
  try { value = JSON.parse(match[1]); } catch { throw new Error("Planner review decision block is not valid JSON."); }
  if (!value || typeof value !== "object") throw new Error("Planner review decision block must be an object.");
  const raw = value as Record<string, unknown>;
  if (!isDecision(raw.decision)) throw new Error("Planner review decision must be research_more, ask_user, or conclude.");
  const decision = raw.decision;
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
  /** A decision imposed by the current workflow step, such as the minimum-answer floor. */
  requiredDecision?: MindSearchReviewDecision;
  /** Exact question already proposed by the current Planner response; repair must preserve it. */
  preferredQuestion?: string;
  /** Fixed rationale supplied by the workflow when it imposes a decision. */
  requiredDecisionRationale?: string;
}

/** Return an explicitly written interrogative from the current response without deriving one from evidence. */
export function extractPlannerQuestionCandidate(result: Pick<AiResult, "detail" | "summary">): string | undefined {
  const marked = readMarker(result.detail);
  if (marked?.raw.decision === "ask_user" && typeof marked.raw.question === "string" && marked.raw.question.trim()) return marked.raw.question.trim();
  // Prefer an explicitly labeled body question, then a standalone body interrogative;
  // a summary can be rhetorical, so only use it as a last-resort direct question.
  const body = marked?.body ?? result.detail;
  const lines = body.split(/\r?\n/).map(line => line.trim());
  const labeledQuestion = lines.find(line => /^(?:question|問題)\s*[:：]\s*.+[?？]\s*$/i.test(line));
  if (labeledQuestion) return labeledQuestion.replace(/^(?:question|問題)\s*[:：]\s*/i, "").trim();
  const bodyQuestion = lines.map(line => line.replace(/^(?:[-*•]|\d+[.)、])\s+/, ""))
    .find(candidate => candidate && candidate.length <= 500 && /[?？]\s*$/.test(candidate));
  if (bodyQuestion) return bodyQuestion;
  const candidates = [result.summary];
  for (const text of candidates) for (const line of text.split(/\r?\n/)) {
    const candidate = line.trim().replace(/^(?:[-*•]|\d+[.)、])\s+/, "");
    if (candidate && candidate.length <= 500 && /[?？]\s*$/.test(candidate)) return candidate;
  }
  return undefined;
}

/** Parse a Planner decision and allow one local format-repair turn on the same evidence. */
export async function parseMindSearchPlannerReviewWithRecovery(
  original: AiResult,
  context: PlannerReviewRecoveryContext,
  recover: (task: string) => Promise<AiResult>
): Promise<MindSearchPlannerReview> {
  try {
    const parsed = parseMindSearchPlannerReview(original);
    if (context.requiredDecision && parsed.decision !== context.requiredDecision) {
      throw new Error(`Planner response violated the required ${context.requiredDecision} decision.`);
    }
    return parsed;
  } catch (formatError) {
    const originalMarker = readMarker(original.detail);
    const originalDecision = originalMarker?.raw.decision;
    const originalRationale = typeof originalMarker?.raw.rationale === "string" ? originalMarker.raw.rationale.trim() : "";
    const originalQuestion = typeof originalMarker?.raw.question === "string" ? originalMarker.raw.question.trim() : "";
    const originalSummary = typeof original.summary === "string" ? original.summary.trim() : "";
    const originalBody = originalMarker?.body ?? "";

    // Some workflow steps impose a decision (for example, the minimum answered-question floor).
    // In that path the repairer is a formatter only: it cannot revisit evidence or choose another decision.
    if (context.requiredDecision) {
      if (originalDecision && originalDecision !== context.requiredDecision) {
        throw new Error(`Planner response violated the required ${context.requiredDecision} decision.`);
      }
      if (context.requiredDecision !== "ask_user") {
        throw new Error(`Format recovery does not support an imposed ${context.requiredDecision} decision.`);
      }
      const question = context.preferredQuestion?.trim() || originalQuestion;
      if (!question) throw new Error("Planner format repair cannot invent a question that was absent from the original response.");
      const preservedBody = originalMarker?.body ?? original.detail.replace(/^\s*<!--\s*mindsearch-review\s+[^\n]*?-->\s*/, "").trim();
      const existingOptions = [...new Set(original.suggestions.map(item => item.title.trim()).filter(Boolean))];
      const explicitOptions = extractExplicitOptions(preservedBody, question);
      let answerOptions = existingOptions.length >= 2 && existingOptions.length <= 5 ? existingOptions : explicitOptions;
      if (answerOptions.length < 2 || answerOptions.length > 5) {
        const task = [
          "Complete the format of this already-required ask_user Planner response. The workflow has imposed decision=ask_user; you have no authority to reconsider the decision or research evidence.",
          "Preserve the exact original question below. Return 2–5 distinct answer choices in suggestions[].title. Do not change the summary or answer body, infer a new question, add facts, search, or reinterpret evidence. If the original question cannot be formatted, repeat it exactly in the decision marker.",
          `Required decision: ${context.requiredDecision}`,
          `Required rationale: ${context.requiredDecisionRationale ?? "The workflow requires a clarification question at this step."}`,
          `Exact original question to preserve: ${question}`,
          `Original summary (preserve): ${originalSummary}`,
          `Original response body (preserve; not research evidence):\n${preservedBody}`,
          `Original suggestions: ${JSON.stringify(original.suggestions)}`,
          `Format validation error: ${formatError instanceof Error ? formatError.message : String(formatError)}`,
          'Return the ordinary VAM structured response with this exact decision marker: <!-- mindsearch-review {"decision":"ask_user","rationale":"required rationale","question":"exact original question"} -->.'
        ].join("\n\n");
        const repaired = await recover(task);
        const repairedMarker = readMarker(repaired.detail);
        if (!repairedMarker || repairedMarker.raw.decision !== "ask_user") {
          throw new Error("Planner format repair changed or omitted the required ask_user decision.");
        }
        answerOptions = [...new Set(repaired.suggestions.map(item => item.title.trim()).filter(Boolean))];
        if (answerOptions.length < 2 || answerOptions.length > 5) throw new Error("Planner format repair did not provide 2–5 distinct answer choices.");
      }
      const rationale = context.requiredDecisionRationale ?? originalRationale ?? "A clarification is required before the workflow can continue.";
      const constrained = {
        ...original,
        summary: originalSummary || original.summary,
        detail: `<!-- mindsearch-review ${JSON.stringify({ decision: "ask_user", rationale, question })} -->\n${preservedBody}`,
        suggestions: answerOptions.map(title => ({ title, task: "", contribution: "" }))
      };
      const parsed = parseMindSearchPlannerReview(constrained);
      if (parsed.decision !== "ask_user" || parsed.question !== question) throw new Error("Planner recovery did not preserve the required decision and question.");
      return parsed;
    }

    // A complete ask_user decision with only missing/invalid choices can be repaired
    // without asking a model to reinterpret the decision or touching report evidence.
    if (originalDecision === "ask_user" && originalRationale && originalQuestion && originalSummary && originalBody) {
      const options = extractExplicitOptions(originalBody, originalQuestion);
      if (options.length) {
        const recovered = {
          ...original,
          detail: `${original.detail.match(marker)?.[0] ?? ""}${originalBody}`,
          suggestions: options.map(title => ({ title, task: "", contribution: "" }))
        };
        return parseMindSearchPlannerReview(recovered);
      }

      const task = [
        "Repair only the missing answer choices in this already valid ask_user Planner decision.",
        "Keep decision=ask_user. Do not change the question, rationale, summary, answer body, or any evidence. Return the ordinary VAM structured response with the same decision marker and 2–5 distinct choices in suggestions[].title. Do not infer choices from prose or add facts.",
        `Original question: ${originalQuestion}`,
        `Original rationale: ${originalRationale}`,
        `Original summary: ${originalSummary}`,
        `Original answer body (preserve exactly):\n${originalBody}`,
        `Format validation error: ${formatError instanceof Error ? formatError.message : String(formatError)}`,
        `Original suggestions: ${JSON.stringify(original.suggestions)}`
      ].join("\n\n");
      const repaired = await recover(task);
      const repairedMarker = readMarker(repaired.detail);
      if (!repairedMarker || repairedMarker.raw.decision !== "ask_user") {
        throw new Error("Planner format repair changed or omitted the original ask_user decision.");
      }
      const answerOptions = [...new Set(repaired.suggestions.map(item => item.title.trim()).filter(Boolean))];
      if (answerOptions.length < 2 || answerOptions.length > 5) {
        throw new Error("Planner format repair did not provide 2–5 distinct answer choices.");
      }
      return parseMindSearchPlannerReview({
        ...original,
        detail: `${original.detail.match(marker)?.[0] ?? ""}${originalBody}`,
        suggestions: answerOptions.map(title => ({ title, task: "", contribution: "" }))
      });
    }

    const preserveDecision = isDecision(originalDecision) ? originalDecision : undefined;
    const task = [
      "The preceding Planner response did not satisfy the required machine-readable decision contract.",
      preserveDecision
        ? `Repair only the malformed fields in the original ${preserveDecision} decision. Preserve that decision and every valid original field; do not switch to another decision.`
        : "Make one local format-repair review using only the same saved report and answer snapshot below. Do not search, repeat research, add evidence, or invent facts. The original decision marker is unusable, so determine a decision from the supplied evidence; do not claim the original decision is known.",
      "Do not search, repeat research, add evidence, or invent facts. Do not default to any decision merely to repair the format.",
      "Return the ordinary VAM structured response with a useful conditional answer in summary/detail and exactly one valid decision marker as the first line of detail: <!-- mindsearch-review {\"decision\":\"research_more|ask_user|conclude\",\"rationale\":\"evidence-based reason\",\"stopReason\":\"why research stops, for conclude only\",\"question\":\"user question, for ask_user only\"} -->. Use valid single-line JSON and only fields needed for the selected decision.",
      "For research_more, provide exactly one targeted suggestion with title, search task, and expected uncertainty reduction. For ask_user, provide 2–5 distinct choices in suggestions[].title. For conclude, include a stopReason. Preserve supplied values and provenance; never answer for the user or ask whether synthetic test data is real. Keep source claims, inference, uncertainty, and limits distinct.",
      `Format validation error: ${formatError instanceof Error ? formatError.message : String(formatError)}`,
      ...(preserveDecision ? [] : [
        `Original question: ${context.question}`,
        `Answer snapshot (including provenance): ${context.answerSnapshot}`,
        `Already completed report summary:\n${context.reportSummary}`,
        `Already completed report detail:\n${context.reportDetail}`
      ]),
      `Original Planner response to review:\nSummary: ${original.summary}\n\nDetail:\n${original.detail}\n\nSuggestions: ${JSON.stringify(original.suggestions)}`
    ].join("\n\n");
    const repaired = await recover(task);
    const parsed = parseMindSearchPlannerReview(repaired);
    if (preserveDecision && parsed.decision !== preserveDecision) {
      throw new Error(`Planner format repair changed the original ${preserveDecision} decision to ${parsed.decision}.`);
    }
    if (!preserveDecision || !originalMarker) return parsed;

    const mergedMarker: Record<string, unknown> = { ...readMarker(repaired.detail)?.raw, decision: preserveDecision };
    for (const key of ["rationale", "question", "stopReason"] as const) {
      const value = originalMarker.raw[key];
      if (typeof value === "string" && value.trim()) mergedMarker[key] = value.trim();
    }
    const mergedBody = originalBody || readMarker(repaired.detail)?.body || parsed.detail;
    return parseMindSearchPlannerReview({
      ...repaired,
      summary: originalSummary || repaired.summary,
      detail: `<!-- mindsearch-review ${JSON.stringify(mergedMarker)} -->\n${mergedBody}`
    });
  }
}
