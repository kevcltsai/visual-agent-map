import type { ContentLanguage } from "../../i18n";
import type { AiResult } from "../../ai/types";
import { DEFAULT_AIM_FLOW_LIMITS } from "./flow-limits";
import {
  clarificationRequiredRationale,
  renderGeneralRepair,
  renderImposedOptionsRepair,
  renderMissingChoicesRepair,
  renderStateQuestionRepair
} from "./steps/format-repair/step";

export const AIM_MAX_RESEARCH_TURNS = DEFAULT_AIM_FLOW_LIMITS.maxResearchTurns;
export type AimReviewDecision = "research_more" | "ask_user" | "conclude";
/** Who can close a research_more gap: the web, only the user, or nobody needs to because the advice would not change. */
export type AimGapKind = "searchable" | "user_only" | "not_decisive";
const GAP_KINDS: readonly string[] = ["searchable", "user_only", "not_decisive"];
export interface AimPlannerReview {
  decision: AimReviewDecision;
  rationale: string;
  stopReason?: string;
  /** The Planner's own judgement that the reports already answer the goal; absent in legacy responses. */
  goalAnswered?: boolean;
  question?: string;
  researchTarget?: { title: string; task: string; expectedValue: string };
  /** research_more only; absent in legacy responses, which the gap audit then classifies. */
  gapKind?: AimGapKind;
  /** Decision-changing user conditions the review still sees as unknown; a conclusion must have none. */
  unresolvedConditions?: string[];
  /** Unverified gaps a conclusion carries into the document as items for the user to confirm. */
  openItems?: { title: string; task: string; expectedValue: string }[];
  answerOptions?: string[];
  summary: string;
  detail: string;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const marker = /^\s*<!--\s*aim-review\s+(\{[^\n]*\})\s*-->\s*/;

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

function isDecision(value: unknown): value is AimReviewDecision {
  return value === "research_more" || value === "ask_user" || value === "conclude";
}

/** Extract only a clearly labeled option list; ordinary report bullets are not answer choices. */
function extractExplicitOptions(body: string, question: string): string[] {
  const onlyQuestionAndChoices = body.startsWith(question)
    ? body
        .slice(question.length)
        .trim()
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
    : [];
  if (
    onlyQuestionAndChoices.length >= 2 &&
    onlyQuestionAndChoices.length <= 5 &&
    onlyQuestionAndChoices.every(line => /^[-*•]\s+\S/.test(line))
  ) {
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
export function parseAimPlannerReview(result: AiResult): AimPlannerReview {
  const match = result.detail.match(marker);
  if (!match) throw new Error("Planner review is missing its machine-readable decision block.");
  let value: unknown;
  try {
    value = JSON.parse(match[1]);
  } catch {
    throw new Error("Planner review decision block is not valid JSON.");
  }
  if (!value || typeof value !== "object") throw new Error("Planner review decision block must be an object.");
  const raw = value as Record<string, unknown>;
  if (!isDecision(raw.decision))
    throw new Error("Planner review decision must be research_more, ask_user, or conclude.");
  const decision = raw.decision;
  const rationale = typeof raw.rationale === "string" ? raw.rationale.trim() : "";
  if (!rationale) throw new Error("Planner review must explain the evidence-based reason for its decision.");
  const summary = result.summary.trim();
  const detail = result.detail.slice(match[0].length).trim();
  if (!summary || !detail)
    throw new Error("Planner review must include a useful supported answer or interim conclusion.");
  const unresolvedConditions = Array.isArray(raw.unresolvedConditions)
    ? raw.unresolvedConditions.filter((item): item is string => typeof item === "string" && !!item.trim())
    : [];
  const answered = {
    ...(typeof raw.goalAnswered === "boolean" ? { goalAnswered: raw.goalAnswered } : {}),
    ...(unresolvedConditions.length ? { unresolvedConditions } : {})
  };
  if (decision === "conclude") {
    const stopReason = typeof raw.stopReason === "string" ? raw.stopReason.trim() : "";
    if (!stopReason) throw new Error("A conclude decision must record why research should stop.");
    return { decision, rationale, stopReason, summary, detail, ...answered };
  }
  if (decision === "research_more") {
    const target = result.suggestions[0];
    if (!target?.title.trim() || !target.task.trim() || !target.contribution.trim())
      throw new Error(
        "research_more requires one targeted question, a search instruction, and the uncertainty it should reduce."
      );
    return {
      decision,
      rationale,
      researchTarget: {
        title: target.title.trim(),
        task: target.task.trim(),
        expectedValue: target.contribution.trim()
      },
      ...(typeof raw.gapKind === "string" && GAP_KINDS.includes(raw.gapKind)
        ? { gapKind: raw.gapKind as AimGapKind }
        : {}),
      summary,
      detail,
      ...answered
    };
  }
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  const answerOptions = [...new Set(result.suggestions.map(item => item.title.trim()).filter(Boolean))];
  if (!question || answerOptions.length < 2 || answerOptions.length > 5)
    throw new Error("ask_user requires one material question and 2–5 distinct answer options.");
  return { decision, rationale, question, answerOptions, summary, detail, ...answered };
}

export interface PlannerReviewRecoveryContext {
  question: string;
  answerSnapshot: string;
  reportSummary: string;
  reportDetail: string;
  /** A decision imposed by the current workflow step, such as the minimum-answer floor. */
  requiredDecision?: AimReviewDecision;
  /** Exact question already proposed by the current Planner response; repair must preserve it. */
  preferredQuestion?: string;
  /** Fixed rationale supplied by the workflow when it imposes a decision. */
  requiredDecisionRationale?: string;
  /** AIM content language, used only for fixed fallback wording. */
  outputLanguage?: ContentLanguage;
}

/** Return an explicitly written interrogative from the current response without deriving one from evidence. */
export function extractPlannerQuestionCandidate(result: Pick<AiResult, "detail" | "summary">): string | undefined {
  const marked = readMarker(result.detail);
  if (marked?.raw.decision === "ask_user" && typeof marked.raw.question === "string" && marked.raw.question.trim())
    return marked.raw.question.trim();
  // Prefer an explicitly labeled body question, then a standalone body interrogative;
  // a summary can be rhetorical, so only use it as a last-resort direct question.
  const body = marked?.body ?? result.detail;
  const lines = body.split(/\r?\n/).map(line => line.trim());
  // The label may be emphasised ("**問題：**…"); the emphasis is formatting, not part of the question.
  const label = /^(?:\*\*|__)?(?:question|問題)\s*[:：]\s*(?:\*\*|__)?\s*/i;
  const labeledQuestion = lines.find(line => label.test(line) && /[?？]\s*$/.test(line.replace(label, "")));
  if (labeledQuestion) return labeledQuestion.replace(label, "").trim();
  const bodyQuestion = lines
    .map(line => line.replace(/^(?:[-*•]|\d+[.)、])\s+/, ""))
    .find(candidate => candidate && candidate.length <= 500 && /[?？]\s*$/.test(candidate));
  if (bodyQuestion) return bodyQuestion;
  const candidates = [result.summary];
  for (const text of candidates)
    for (const line of text.split(/\r?\n/)) {
      const candidate = line.trim().replace(/^(?:[-*•]|\d+[.)、])\s+/, "");
      if (candidate && candidate.length <= 500 && /[?？]\s*$/.test(candidate)) return candidate;
    }
  return undefined;
}

export interface PlannerRepairOptions {
  /** Decisions the repair response schema must not offer. */
  excludeDecisions?: readonly AimReviewDecision[];
}

/** Parse a Planner decision and allow one local format-repair turn on the same evidence. */
export async function parseAimPlannerReviewWithRecovery(
  original: AiResult,
  context: PlannerReviewRecoveryContext,
  recover: (task: string, options?: PlannerRepairOptions) => Promise<AiResult>
): Promise<AimPlannerReview> {
  try {
    const parsed = parseAimPlannerReview(original);
    if (context.requiredDecision && parsed.decision !== context.requiredDecision) {
      throw new Error(`Planner response violated the required ${context.requiredDecision} decision.`);
    }
    return parsed;
  } catch (formatError) {
    const originalMarker = readMarker(original.detail);
    const originalDecision = originalMarker?.raw.decision;
    const originalRationale =
      typeof originalMarker?.raw.rationale === "string" ? originalMarker.raw.rationale.trim() : "";
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
      let question = context.preferredQuestion?.trim() || originalQuestion;
      const preservedBody =
        originalMarker?.body ?? original.detail.replace(/^\s*<!--\s*aim-review\s+[^\n]*?-->\s*/, "").trim();
      let stated: AiResult | undefined;
      if (!question) {
        // The response chose to clarify but phrased it without a written question (for example as an
        // instruction). The model, not VAM, must author the question, so ask it once to state it.
        const task = renderStateQuestionRepair({
          requiredDecision: context.requiredDecision,
          requiredRationale:
            context.requiredDecisionRationale ?? clarificationRequiredRationale(context.outputLanguage),
          originalSummary,
          preservedBody,
          originalSuggestions: JSON.stringify(original.suggestions),
          formatError: errorText(formatError)
        });
        stated = await recover(task);
        const statedMarker = readMarker(stated.detail);
        question =
          statedMarker?.raw.decision === "ask_user" && typeof statedMarker.raw.question === "string"
            ? statedMarker.raw.question.trim()
            : "";
      }
      if (!question)
        throw new Error("Planner format repair cannot invent a question that was absent from the original response.");
      const statedOptions = [...new Set((stated?.suggestions ?? []).map(item => item.title.trim()).filter(Boolean))];
      const originalOptions = [...new Set(original.suggestions.map(item => item.title.trim()).filter(Boolean))];
      const existingOptions = statedOptions.length >= 2 && statedOptions.length <= 5 ? statedOptions : originalOptions;
      const explicitOptions = extractExplicitOptions(preservedBody, question);
      let answerOptions =
        existingOptions.length >= 2 && existingOptions.length <= 5 ? existingOptions : explicitOptions;
      if (answerOptions.length < 2 || answerOptions.length > 5) {
        const task = renderImposedOptionsRepair({
          requiredDecision: context.requiredDecision,
          requiredRationale:
            context.requiredDecisionRationale ?? clarificationRequiredRationale(context.outputLanguage),
          question,
          originalSummary,
          preservedBody,
          originalSuggestions: JSON.stringify(original.suggestions),
          formatError: errorText(formatError)
        });
        const repaired = await recover(task);
        const repairedMarker = readMarker(repaired.detail);
        if (!repairedMarker || repairedMarker.raw.decision !== "ask_user") {
          throw new Error("Planner format repair changed or omitted the required ask_user decision.");
        }
        answerOptions = [...new Set(repaired.suggestions.map(item => item.title.trim()).filter(Boolean))];
        if (answerOptions.length < 2 || answerOptions.length > 5)
          throw new Error("Planner format repair did not provide 2–5 distinct answer choices.");
      }
      const rationale =
        context.requiredDecisionRationale ??
        originalRationale ??
        "A clarification is required before the workflow can continue.";
      const constrained = {
        ...original,
        summary: originalSummary || original.summary,
        detail: `<!-- aim-review ${JSON.stringify({ decision: "ask_user", rationale, question })} -->\n${preservedBody}`,
        suggestions: answerOptions.map(title => ({ title, task: "", contribution: "" }))
      };
      const parsed = parseAimPlannerReview(constrained);
      if (parsed.decision !== "ask_user" || parsed.question !== question)
        throw new Error("Planner recovery did not preserve the required decision and question.");
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
        return parseAimPlannerReview(recovered);
      }

      const task = renderMissingChoicesRepair({
        originalQuestion,
        originalRationale,
        originalSummary,
        originalBody,
        formatError: errorText(formatError),
        originalSuggestions: JSON.stringify(original.suggestions)
      });
      const repaired = await recover(task);
      const repairedMarker = readMarker(repaired.detail);
      if (!repairedMarker || repairedMarker.raw.decision !== "ask_user") {
        throw new Error("Planner format repair changed or omitted the original ask_user decision.");
      }
      const answerOptions = [...new Set(repaired.suggestions.map(item => item.title.trim()).filter(Boolean))];
      if (answerOptions.length < 2 || answerOptions.length > 5) {
        throw new Error("Planner format repair did not provide 2–5 distinct answer choices.");
      }
      return parseAimPlannerReview({
        ...original,
        detail: `${original.detail.match(marker)?.[0] ?? ""}${originalBody}`,
        suggestions: answerOptions.map(title => ({ title, task: "", contribution: "" }))
      });
    }

    // research_more with no target on a goal the response itself calls answered names no gap to search.
    // Repairing only the target would make the model invent one, so the decision is re-made without research.
    const answeredWithoutTarget =
      originalDecision === "research_more" &&
      originalMarker?.raw.goalAnswered === true &&
      !original.suggestions.some(item => item.title.trim() && item.task.trim() && item.contribution.trim());
    const preserveDecision = !answeredWithoutTarget && isDecision(originalDecision) ? originalDecision : undefined;
    const task = renderGeneralRepair({
      variant: answeredWithoutTarget
        ? { kind: "answered-without-target" }
        : preserveDecision
          ? { kind: "preserve-decision", decision: preserveDecision }
          : { kind: "no-decision" },
      formatError: errorText(formatError),
      ...(preserveDecision
        ? {}
        : {
            context: {
              question: context.question,
              answerSnapshot: context.answerSnapshot,
              reportSummary: context.reportSummary,
              reportDetail: context.reportDetail
            }
          }),
      originalSummary: original.summary,
      originalDetail: original.detail,
      originalSuggestions: JSON.stringify(original.suggestions)
    });
    const repaired = await recover(task, answeredWithoutTarget ? { excludeDecisions: ["research_more"] } : undefined);
    const parsed = parseAimPlannerReview(repaired);
    if (answeredWithoutTarget && parsed.decision === "research_more")
      throw new Error("Planner format repair cannot choose research_more for a goal its response marked as answered.");
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
    return parseAimPlannerReview({
      ...repaired,
      summary: originalSummary || repaired.summary,
      detail: `<!-- aim-review ${JSON.stringify(mergedMarker)} -->\n${mergedBody}`
    });
  }
}
