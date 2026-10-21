import { evidenceCard, EVIDENCE_LOOKUP_FIELD_RULE, EVIDENCE_LOOKUP_RULE } from "./evidence-context";
import { deduplicateAimRequest } from "./request-context";
import { resolveAimContentLanguage } from "./content-language";
import { buildFinalDelivery, type DeliveryEvidence } from "./final-delivery";
import { createHash, randomUUID } from "node:crypto";
import type { AiResult, TaskContext } from "../../ai/types";
import { resolveToneText } from "../../ai/prompt-presets";
import { reportedSearchFailure } from "../../ai/result-utils";
import { createSearchDiagnostic } from "./search-diagnostic";
import { aimTimedOut } from "./failure-hint";
import type { MapDocument, MapNode, AimBranchRecord, AimQuestionDraft } from "../../map-model";
import type { Repository } from "../../repository";
import { AimRunStore, type CommitResult } from "./research-run-store";
import type { CodexWebSearchEvent } from "../../ai/runtime/codex-app-server";
import { effectiveReasoningLevel, normalizeReasoningLevel } from "../../ai/task-policy";
import { estimateTokens } from "../../ai/context-builder";
import { ACTIVE_AIM_FLOW_LIMITS, type AimFlowLimits } from "./flow-limits";
import { AIM_NO_QUESTION, type AimContract, type AimDecision } from "../../ai/aim-contracts";
import {
  extractPlannerQuestionCandidate,
  parseAimPlannerReview,
  parseAimPlannerReviewWithRecovery,
  type PlannerReviewRecoveryContext
} from "./planner-review";
import { extractAimFailedReport } from "./retry-targets";
import {
  researchContentHash,
  validateAimResearchPlan,
  type AimResearchPlan,
  type AimResearchTarget
} from "./research-plan";
import { scheduleAimResearch } from "./research-scheduler";
import {
  EVIDENCE_LOOKUP_UNAVAILABLE,
  renderEvidenceLookupFollowup,
  renderOpenItemsContext,
  REUSE_TARGET_EXPECTED_VALUE,
  REUSE_TARGET_VALIDITY_REASON,
  TOPIC_ROOT_ANSWER
} from "./steps/_shared/rules";
import { renderSavedReportFollowupSearchTask, renderSavedReportReviewTask } from "./steps/saved-report-review/step";
import {
  renderPartialContinuationReviewTask,
  renderPartialContinuationSearchTask
} from "./steps/partial-continuation/step";

import {
  AIM_UNKNOWN_OPTION_ID,
  PLANNER_COVERAGE_RULE,
  SEARCHER_TARGET_RULE,
  USER_QUESTION_RULE,
  FLOOR_ASK_RULE,
  ALL_DECISIONS,
  reviewContract,
  floorDecisions,
  phaseTask,
  countAimAnsweredQuestions,
  OUTCOME_EXPECTATION_RULE,
  lineageWithoutRepeatedReports,
  throwIfAborted,
  normalizePersistedAnswerOptions,
  parseAimResearchPlan,
  ResearchWorkflowInterrupted,
  SubtopicSearchUnavailable,
  type AimProgressEvent,
  ReuseEvidenceRejected,
  type AimAskModel,
  type PlannerQuestionResult,
  type ManualResearchResult,
  type AimPersist,
  type QuestionPlanEntry,
  type PlannerReview,
  type ResearchCandidate,
  type AimTaskContext,
  type PlannerQualityContext,
  type ResearchGapClassification
} from "./manual-flow-support";
import { noteLanguageOf, translateNote, type UiLanguage } from "../../i18n";
import { renderInitialClarificationTask } from "./steps/initial-clarification/step";
import {
  renderInitialQuestionTask,
  renderQuestionCorrectionTask,
  renderSavedTerminalQuestionTask
} from "./steps/initial-question/step";
import { renderEvidenceReuseAuditTask } from "./steps/evidence-reuse-audit/step";
import { FALLBACK_TARGET_VALUE, renderFallbackTargetTask, renderResearchPlanTask } from "./steps/research-plan/step";
import { renderResearchPlanRepairTask } from "./steps/research-plan-repair/step";
import { renderSubtopicResearchTask } from "./steps/subtopic-research/step";
import { renderResearchGapAuditTask } from "./steps/research-gap-audit/step";
import {
  renderAnsweredGoalReviewTask,
  renderBelowFloorReviewTask,
  renderUserConditionReviewTask
} from "./steps/decision-quality-review/step";
import { normalizeDetailHeadings, normalizeMathDelimiters } from "../../ai/markdown-blocks";
import { awaitingAnswerCallout, incompleteResearchWarning, rejectedDeliveryWarning } from "./rejected-warning";
import { renderReportReviewTask } from "./steps/report-review/step";
import { renderTargetedFollowupResearchTask } from "./steps/targeted-followup-research/step";
// Public API kept here for existing importers.
export {
  AIM_NO_QUESTION,
  AIM_UNKNOWN_OPTION_ID,
  MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION,
  countAimAnsweredQuestions,
  parseAimResearchPlan,
  type AimAskModel,
  type PlannerQuestionResult,
  type ManualResearchResult,
  type AimPersist
} from "./manual-flow-support";

/** Estimated tokens one AIM request may carry; larger requests fail whole instead of dropping goal or evidence. */
const AIM_REQUEST_TOKEN_LIMIT = 60_000;
/**
 * Hidden marker on a conclusion note that lists the assumptions the user can correct afterwards. ">" is escaped so a
 * title containing "-->" cannot end the comment early; JSON.parse reads it back unchanged.
 */
export const openItemsMarker = (titles: string[]): string =>
  `<!-- aim-open-items ${JSON.stringify(titles).replace(/>/g, "\\u003e")} -->`;
/** The correctable assumptions of a conclusion note, or none. */
export function readOpenItems(detail: string): string[] {
  const marker = detail.match(/<!--\s*aim-open-items\s+(\[[^\n]*\])\s*-->/);
  if (!marker) return [];
  try {
    const value: unknown = JSON.parse(marker[1]);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && !!item.trim())
      : [];
  } catch {
    return [];
  }
}
/** Marker the visual map appends to the topic detail once the intake clarification is done. */
const AIM_INTAKE_COMPLETE = "<!-- aim-intake-complete -->";
/** With the intake checklist, one answered question can precede a conclusion. */
const CHECKLIST_FLOOR = 1;
/** The runtime's translated "provider did not run web search" error, in either interface language. */
/** At most this many saved reports from other routes of the map are offered for reuse. */
const OTHER_ROUTE_REUSE_LIMIT = 6;
const SEARCH_NOT_PERFORMED = /did not perform web search|沒有實際執行網路搜尋/;
/** With the intake checklist, after this many answers what is still unknown becomes an assumption to confirm. */
const CHECKLIST_QUESTION_LIMIT = 5;

export class AimManualFlow {
  private readonly evidenceReports = new Map<string, { path: string; hash: string }>();
  private readonly answerRuns = new Map<string, { fingerprint: string; promise: Promise<ManualResearchResult> }>();
  /** Reviews whose research_more came from final delivery acceptance rather than from the Planner's report review. */
  /** Final delivery rejections, with the document that was written and the open items it was written with. */
  private readonly deliveryRejections = new WeakMap<
    object,
    { summary: string; detail: string; openItems: NonNullable<PlannerReview["openItems"]> }
  >();
  private static readonly questionPlans = new Map<string, QuestionPlanEntry>();
  private static readonly continuationRuns = new Map<
    string,
    { fingerprint: string; promise: Promise<ManualResearchResult> }
  >();
  constructor(
    private readonly repository: Repository,
    private readonly runs: AimRunStore,
    private readonly askModel: AimAskModel,
    private readonly id: () => string = randomUUID,
    private readonly persist: AimPersist = operation => operation(),
    /** Test-only injection; production never passes it, so the defaults apply. */
    private readonly limits: AimFlowLimits = ACTIVE_AIM_FLOW_LIMITS
  ) {}

  /** The map view's live progress listener; set by the view, absent in tests and recovery flows. */
  onProgress?: (event: AimProgressEvent) => void;

  /** The chart step for a finished conclusion; set by the view (it checks the "Add diagrams" setting). Absent in tests. */
  addDiagrams?: (request: {
    title: string;
    detail: string;
    language: UiLanguage;
    model: string;
    signal?: AbortSignal;
    onStart?: () => void;
  }) => Promise<string>;

  private emitProgress(event: AimProgressEvent): void {
    try {
      this.onProgress?.(event);
    } catch {
      /* Progress display must never stop research. */
    }
  }

  /** Research phases use provider web search unless a test turned it off. */
  private researchMode(): "research" | "local" {
    return this.limits.webSearch ? "research" : "local";
  }

  /** The only exit acceptGapAtBudget changes: a research_more left at the last turn is saved partial unless accepted. */
  private budgetExitStatus(decision: string): "partial" | "completed" {
    return decision === "research_more" && !this.limits.acceptGapAtBudget ? "partial" : "completed";
  }

  /**
   * Answered questions required before a conclusion. Once the intake checklist ran (its marker is in the goal
   * detail), conclusion waits on unresolved decision-changing conditions instead of a question count.
   */
  private floorFor(goalDetail: string, map?: MapDocument): number {
    if (map && this.isUnattended(map)) return 0;
    return goalDetail.includes(AIM_INTAKE_COMPLETE)
      ? Math.min(CHECKLIST_FLOOR, this.limits.minAnsweredBeforeConclusion)
      : this.limits.minAnsweredBeforeConclusion;
  }

  /** An unattended run answers the intake once and never waits for the user again. */
  private isUnattended(map: MapDocument): boolean {
    return map.aim?.interaction === "unattended";
  }

  /** Review decisions the schema allows: an unattended run cannot ask the user, so it researches or concludes. */
  private reviewDecisions(answeredQuestionCount: number, floor: number, map: MapDocument): readonly AimDecision[] {
    return this.isUnattended(map)
      ? ["research_more", "conclude"]
      : floorDecisions(answeredQuestionCount, { minAnsweredBeforeConclusion: floor });
  }

  /**
   * A gap that would not change the advice, or that is still open when the research budget is spent, becomes an
   * open item of a conditional conclusion: the document states it for the user to confirm instead of stopping.
   */
  private withOpenItems(review: PlannerReview, language: UiLanguage): PlannerReview {
    const openItems = [...(review.openItems ?? []), ...(review.researchTarget ? [review.researchTarget] : [])].filter(
      (item, index, all) => all.findIndex(other => other.title === item.title) === index
    );
    return {
      decision: "conclude",
      rationale: review.rationale,
      // Attempt records keep stored (English) stop reasons; notes localize what they show.
      stopReason: `Answered with items for the user to confirm: ${openItems.map(item => item.title).join("; ")}`,
      ...(review.goalAnswered !== undefined ? { goalAnswered: review.goalAnswered } : {}),
      ...(review.unresolvedConditions ? { unresolvedConditions: review.unresolvedConditions } : {}),
      openItems,
      summary: review.summary,
      detail: review.detail
    };
  }

  /** At the research budget a rejected final delivery is published (smoke limits keep their own exits). */
  private atBudget(review: PlannerReview, language: UiLanguage): PlannerReview {
    return review.decision === "research_more" &&
      this.deliveryRejections.has(review) &&
      !this.limits.acceptGapAtBudget &&
      !this.limits.publishDeliveryAtBudget
      ? this.publishRejectedDelivery(review, language)
      : review;
  }

  /**
   * What an interim note says to the reader in place of the reviewer's rationale and the stop reason (both stay in the
   * run records): the evidence still missing, or the question it waits on.
   */
  private interimNotice(review: PlannerReview, language: UiLanguage): string {
    if (review.decision === "ask_user") return review.question ? awaitingAnswerCallout(review.question, language) : "";
    if (review.decision === "research_more")
      return incompleteResearchWarning(review.researchTarget ? [review.researchTarget.title] : [], language);
    return "";
  }

  /** An interim note's parts in order; its headings sit under the note's `## Detail` (nothing parses them later). */
  private interimDetail(parts: readonly string[]): string {
    return normalizeMathDelimiters(normalizeDetailHeadings(parts.filter(part => part.trim()).join("\n\n")));
  }

  /** The document a review stands for: the draft a final review rejected, never the reviewer's critique of it. */
  private readerDetail(review: PlannerReview): string {
    return this.deliveryRejections.get(review)?.detail ?? review.detail;
  }

  /** A conclusion note keeps its open items in a hidden marker, so the user can correct them later. */
  private async concludedDetail(
    review: PlannerReview,
    charts: {
      title: string;
      language: UiLanguage;
      model: string;
      signal?: AbortSignal;
      mapPath: string;
      branchId: string;
    }
  ): Promise<string> {
    // The chart step sees the final conclusion body only (not interim notes, not the hidden marker); it returns the body
    // unchanged when diagrams are off or any check fails, and throws only when the user stopped.
    const { mapPath, branchId, ...request } = charts;
    const body = this.addDiagrams
      ? await this.addDiagrams({
          ...request,
          detail: review.detail,
          // Called only when the step really runs (the setting is on), so the UI never shows a stage that is skipped.
          onStart: () => this.emitProgress({ kind: "stage", mapPath, branchId, stage: "add-diagrams" })
        })
      : review.detail;
    return review.openItems?.length ? `${body}\n\n${openItemsMarker(review.openItems.map(item => item.title))}` : body;
  }

  /**
   * A rejected final delivery given as the answer: the document that was written, opened by a warning that names the
   * rejected gap in reader words, which is also listed as an open item, instead of a draft left pending. The
   * reviewer's rationale stays in the run records; it can name internal IDs and critiques the draft, not the topic.
   */
  private publishRejectedDelivery(review: PlannerReview, language: UiLanguage): PlannerReview {
    const written = this.deliveryRejections.get(review);
    if (!written) return this.withOpenItems(review, language);
    const warning = rejectedDeliveryWarning(review.researchTarget ? [review.researchTarget.title] : [], language);
    return this.withOpenItems(
      {
        ...review,
        summary: written.summary,
        detail: warning ? `${warning}\n\n${written.detail}` : written.detail,
        openItems: written.openItems
      },
      language
    );
  }

  /**
   * Tone text for prose-producing AIM calls (research and final delivery). Structured Planner/review calls carry an
   * aimContract and never get it (askAimModel drops it), so tone cannot disturb their schemas.
   */
  private toneOf(map: MapDocument, language: UiLanguage): string | undefined {
    return resolveToneText(this.repository.settings.promptPresets, [map.toneId], language);
  }

  /** Content language of the map as read now; never cached on the flow, so a UI language switch cannot change it. */
  private languageOf(map: MapDocument): UiLanguage {
    return resolveAimContentLanguage(map, this.repository.settings.language);
  }

  async prepareClarification(
    topic: { title: string; detail: string; model: string; reasoning?: unknown },
    contentLanguage: UiLanguage,
    signal?: AbortSignal
  ): Promise<string[]> {
    const result = await this.askAimModel(
      {
        title: topic.title,
        summary: "",
        rules: "",
        detail: topic.detail,
        task: renderInitialClarificationTask(),
        ancestors: "",
        outputLanguage: contentLanguage,
        mode: "task",
        researchMode: "local",
        researchDepth: "fast",
        visualMode: "off",
        aimContract: { kind: "intake" },
        signal
      },
      topic.model,
      topic.reasoning,
      signal
    );
    throwIfAborted(signal);
    const marker = result.detail.match(/<!--\s*aim-intake\s+([\s\S]*?)\s*-->/);
    if (!marker) throw new Error("Could not prepare clarification questions; please try again.");
    let value: unknown;
    try {
      value = JSON.parse(marker[1]);
    } catch {
      throw new Error("Clarification questions were not valid JSON; please try again.");
    }
    const questions = (value as { questions?: unknown })?.questions;
    if (!Array.isArray(questions) || questions.length > 5 || questions.some(q => typeof q !== "string" || !q.trim()))
      throw new Error("Invalid clarification questions; please try again.");
    return [...new Set((questions as string[]).map(q => q.trim()))];
  }

  private async askAimModel(
    context: AimTaskContext,
    model: string,
    reasoning?: unknown,
    signal?: AbortSignal,
    onWebSearchEvent?: (event: CodexWebSearchEvent) => void
  ): Promise<AiResult> {
    const visibleEvidence = [context.task, context.detail, context.ancestors]
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    const visibleEvidenceIds = new Set(
      visibleEvidence.match(/Evidence ID: ([^\s]+)/g)?.map(line => line.slice(13)) ?? []
    );
    const canLookupEvidence = (context.aimEvidenceIds ?? []).some(id => visibleEvidenceIds.has(id));
    const structuredLookup = canLookupEvidence && !!context.aimContract;
    const sharedInstructions = [
      OUTCOME_EXPECTATION_RULE,
      ...(canLookupEvidence ? [structuredLookup ? EVIDENCE_LOOKUP_FIELD_RULE : EVIDENCE_LOOKUP_RULE] : [])
    ].join("\n");
    const prepared = {
      ...context,
      promptProfile: "aim" as const,
      detailFormat: "adaptive" as const,
      aimEvidenceLookup: structuredLookup,
      task: `${sharedInstructions}\n\n${context.task ?? ""}`
    };
    // Tone shapes prose only; structured (contract) calls never carry it.
    if (context.aimContract) delete prepared.toneText;
    const task = typeof prepared.task === "string" ? prepared.task : "";
    for (const field of ["title", "summary", "rules", "detail", "ancestors"] as const) {
      const value = prepared[field];
      if (typeof value === "string" && value.trim()) {
        const escaped = JSON.stringify(value).slice(1, -1);
        if (task.includes(value.trim()) || (escaped && task.includes(escaped))) prepared[field] = "";
      }
    }
    const deduplicated = deduplicateAimRequest(prepared);
    const requestTokens = [
      deduplicated.title,
      deduplicated.summary,
      deduplicated.rules,
      deduplicated.detail,
      deduplicated.task,
      deduplicated.ancestors,
      deduplicated.workingFindings,
      deduplicated.sourceContext
    ].reduce((sum, value) => sum + estimateTokens(value), 0);
    if (requestTokens > AIM_REQUEST_TOKEN_LIMIT)
      throw new Error(
        `AIM model request is too large (${requestTokens} estimated tokens); no goal, condition, or evidence was discarded.`
      );
    const result = await this.askModel(deduplicated, model, reasoning, signal, onWebSearchEvent);
    throwIfAborted(signal);
    const lookup = result.detail.match(/^\s*<!--\s*aim-evidence-request\s+(\{[^\n]*\})\s*-->/);
    if (!lookup) return result;
    const payload: unknown = JSON.parse(lookup[1]);
    const ids = payload && typeof payload === "object" && "ids" in payload ? payload.ids : undefined;
    const visibleIds = new Set(
      [deduplicated.task, deduplicated.detail, deduplicated.ancestors]
        .join("\n")
        .match(/Evidence ID: ([^\s]+)/g)
        ?.map(line => line.slice(13)) ?? []
    );
    const available = new Set((context.aimEvidenceIds ?? []).filter(id => visibleIds.has(id)));
    // Only IDs this phase may read are loaded (at most three); an unreadable ID is never read, and a lookup that
    // names none gets one answer from the summaries instead of failing the whole run.
    const readable = Array.isArray(ids)
      ? [
          ...new Set(
            ids.filter(
              (id): id is string => typeof id === "string" && available.has(id) && this.evidenceReports.has(id)
            )
          )
        ].slice(0, 3)
      : [];
    const evidence = readable.length
      ? (
          await Promise.all(
            readable.map(async id => {
              const ref = this.evidenceReports.get(id)!;
              const note = await this.repository.readNote(ref.path);
              if (createHash("sha256").update(note.detail).digest("hex") !== ref.hash)
                throw new Error("AIM evidence changed after indexing; retry with the updated report.");
              return `Evidence ID: ${id}\nFull report:\n${note.detail}`;
            })
          )
        ).join("\n\n")
      : EVIDENCE_LOOKUP_UNAVAILABLE;
    throwIfAborted(signal);
    if (requestTokens + estimateTokens(evidence) > AIM_REQUEST_TOKEN_LIMIT)
      throw new Error("Requested evidence exceeds the context budget; no evidence was truncated or conclusion saved.");
    const loaded = await this.askModel(
      {
        ...deduplicated,
        aimEvidenceLookup: false,
        task: renderEvidenceLookupFollowup(deduplicated.task, evidence)
      },
      model,
      reasoning,
      signal,
      onWebSearchEvent
    );
    throwIfAborted(signal);
    // The one lookup is spent: a second request is dropped and the rest of the reply is used. A reply that is only a
    // request has nothing to use.
    if (/<!--\s*aim-evidence-request/.test(loaded.detail)) {
      const detail = loaded.detail.replace(/<!--\s*aim-evidence-request\s+[^\n]*?-->\s*/g, "").trim();
      if (!detail) throw new Error("AIM evidence lookup limit reached; no conclusion was saved.");
      return { ...loaded, detail };
    }
    return loaded;
  }

  private parsePlannerReviewWithRecovery(
    original: AiResult,
    recoveryContext: PlannerReviewRecoveryContext,
    taskContext: {
      title: string;
      summary: string;
      detail: string;
      ancestors: string;
      task?: string;
      outputLanguage: UiLanguage;
      detailFormat?: TaskContext["detailFormat"];
      aimContract?: AimContract;
    },
    model: string,
    reasoning: unknown,
    signal?: AbortSignal
  ): Promise<ReturnType<typeof parseAimPlannerReview>> {
    return parseAimPlannerReviewWithRecovery(
      original,
      { ...recoveryContext, outputLanguage: taskContext.outputLanguage },
      async (task, options) => {
        throwIfAborted(signal);

        const repairTask = phaseTask("format-repair", task);
        const step = taskContext.aimContract;
        const allowed: readonly AimDecision[] = recoveryContext.requiredDecision
          ? [recoveryContext.requiredDecision]
          : step?.kind === "review"
            ? step.decisions
            : ALL_DECISIONS;
        const decisions = allowed.filter(decision => !options?.excludeDecisions?.includes(decision));
        if (!decisions.length) throw new Error("AIM format repair has no permitted decision left.");
        const repaired = await this.askAimModel(
          {
            ...taskContext,
            title: "AIM format repair",
            summary: "",
            detail: "",
            ancestors: "",
            rules: "",
            task: repairTask,
            mode: "task",
            researchMode: "local",
            researchDepth: "fast",
            visualMode: "off",
            aimContract: { kind: "review", decisions },
            signal
          },
          model,
          reasoning,
          signal
        );
        throwIfAborted(signal);
        return repaired;
      }
    );
  }

  /** Classifies a proposed search gap without exposing reports outside the current branch or invoking search. */
  private async classifyResearchGap(
    candidate: PlannerReview,
    context: PlannerQualityContext,
    model: string,
    reasoning: unknown,
    signal?: AbortSignal,
    targetOnly = false
  ): Promise<ResearchGapClassification> {
    const task = renderResearchGapAuditTask({
      goal: context.goal,
      currentQuestion: context.currentQuestion,
      currentAnswer: context.currentAnswer,
      conditions: context.conditions,
      targetOnly,
      reportSummary: context.reportSummary,
      candidateGap: { rationale: candidate.rationale, target: candidate.researchTarget, summary: candidate.summary },
      researchTarget: candidate.researchTarget
    });
    await context.setPhase?.("research-gap-audit");
    const result = await this.askAimModel(
      {
        timeoutMs: context.timeoutMs,
        title: context.goal,
        summary: "",
        rules: "",
        detail: "",
        task,
        ancestors: "",
        outputLanguage: context.outputLanguage,
        mode: "task",
        researchMode: "local",
        researchDepth: "fast",
        visualMode: "off",
        responseContract: "aim-gap-audit",
        signal
      },
      model,
      reasoning,
      signal
    );
    throwIfAborted(signal);
    // The gap-audit schema makes summary the exact enum, so the provider has already chosen one class.
    const classification = result.summary.trim();
    if (classification !== "user_condition" && classification !== "external_evidence")
      throw new Error("AIM returned an invalid research-gap classification; no follow-up search was started.");
    const rationale = result.detail.replace(/\s+/g, " ").trim().slice(0, 600);
    if (!rationale) throw new Error("AIM returned an empty research-gap rationale; no follow-up search was started.");
    return { classification, rationale };
  }

  private async requireUserConditionQuestion(
    candidate: PlannerReview,
    context: PlannerQualityContext,
    audit: ResearchGapClassification,
    model: string,
    reasoning: unknown,
    signal?: AbortSignal,
    allowReconciliation = true
  ): Promise<PlannerReview> {
    const task = renderUserConditionReviewTask({
      userQuestionRule: USER_QUESTION_RULE,
      rationale: audit.rationale,
      goal: context.goal,
      currentQuestion: context.currentQuestion,
      currentAnswer: context.currentAnswer,
      conditions: context.conditions,
      questionHistory: context.questionHistory,
      candidateSummary: candidate.summary,
      candidateBody: candidate.detail.replace(/^\s*<!--\s*aim-review\s+[^\n]*?-->\s*/, "").trim(),
      candidateGap: { rationale: candidate.rationale, target: candidate.researchTarget }
    });
    const correctionContext: AimTaskContext = {
      timeoutMs: context.timeoutMs,
      title: context.goal,
      summary: "",
      rules: "",
      detail: "",
      task,
      ancestors: "",
      outputLanguage: context.outputLanguage,
      mode: "task",
      researchMode: "local",
      researchDepth: "fast",
      visualMode: "off",
      aimContract: reviewContract(["ask_user"]),
      signal
    };
    const corrected = await this.askAimModel(correctionContext, model, reasoning, signal);
    throwIfAborted(signal);
    const requiredDecisionRationale = audit.rationale;
    const question = extractPlannerQuestionCandidate(corrected);
    const repaired = await this.parsePlannerReviewWithRecovery(
      corrected,
      {
        question: context.goal,
        answerSnapshot: JSON.stringify({
          conditions: context.conditions,
          currentQuestion: context.currentQuestion,
          currentAnswer: context.currentAnswer
        }),
        reportSummary: context.reportSummary,
        reportDetail:
          "Omitted from this format-only repair. The local gap audit already classified the missing input; do not re-evaluate evidence.",
        requiredDecision: "ask_user",
        preferredQuestion: question,
        requiredDecisionRationale
      },
      correctionContext,
      model,
      reasoning,
      signal
    );
    if (repaired.decision !== "ask_user")
      throw new Error("AIM could not preserve the required user-condition question; no search was started.");
    if (
      context.questionHistory.some(
        question => question.trim().toLocaleLowerCase() === repaired.question?.trim().toLocaleLowerCase()
      )
    ) {
      if (allowReconciliation) {
        // Reconcile the target before rejecting the saved reports. Never turn an invalid
        // question into permission to search for a private scenario value.
        const reconciled = await this.classifyResearchGap(candidate, context, model, reasoning, signal, true);
        if (reconciled.classification === "external_evidence") return candidate;
        return this.requireUserConditionQuestion(candidate, context, reconciled, model, reasoning, signal, false);
      }
      throw new Error(
        "AIM could not ask a new user-condition question without repeating a prior question; no search was started."
      );
    }
    const body = candidate.detail.replace(/^\s*<!--\s*aim-review\s+[^\n]*?-->\s*/, "").trim();
    return { ...repaired, summary: candidate.summary, detail: body };
  }

  /**
   * One bounded, no-search semantic check for every Planner decision. A result that still asks the user past the
   * checklist question limit, or a gap that would not change the advice (including one the final delivery review
   * returns), gets one more pass as a conclusion with that item open for the user to confirm.
   */
  private async reviewPlannerDecisionQuality(
    candidate: PlannerReview,
    context: PlannerQualityContext,
    model: string,
    reasoning: unknown,
    signal?: AbortSignal
  ): Promise<PlannerReview> {
    const reviewed = await this.reviewDecisionOnce(candidate, context, model, reasoning, signal);
    const pastLimit =
      !!context.unattended ||
      (context.goalDetail.includes(AIM_INTAKE_COMPLETE) && context.answeredQuestionCount >= CHECKLIST_QUESTION_LIMIT);
    const asksUser =
      reviewed.decision === "ask_user" || (reviewed.decision === "research_more" && reviewed.gapKind === "user_only");
    if (!(pastLimit && asksUser) && !(reviewed.decision === "research_more" && reviewed.gapKind === "not_decisive"))
      return reviewed;
    throwIfAborted(signal);
    // A rejected delivery's review lacks the assumptions the document was written with; carry them into the next pass.
    const written = this.deliveryRejections.get(reviewed)?.openItems ?? [];
    const carried = written.length ? { ...reviewed, openItems: [...written, ...(reviewed.openItems ?? [])] } : reviewed;
    return this.reviewDecisionOnce(this.limitToOpenItems(carried, context), context, model, reasoning, signal);
  }

  /** A question or a user-only/not-decisive gap becomes a conclusion that lists it for the user to confirm. */
  private limitToOpenItems(review: PlannerReview, context: PlannerQualityContext): PlannerReview {
    return review.decision === "ask_user" && review.question
      ? this.withOpenItems(
          {
            ...review,
            researchTarget: { title: review.question, task: review.rationale, expectedValue: review.question }
          },
          context.outputLanguage
        )
      : this.withOpenItems(review, context.outputLanguage);
  }

  /** Past the question limit (or unattended), a question, user-only gap or unresolved condition becomes an open item. */
  private assumeInsteadOfAsking(review: PlannerReview, context: PlannerQualityContext): PlannerReview {
    const assumed =
      (review.decision === "ask_user" && review.question) ||
      (review.decision === "research_more" && review.gapKind === "user_only")
        ? this.limitToOpenItems(review, context)
        : review;
    if (assumed.decision !== "conclude" || !assumed.unresolvedConditions?.length) return assumed;
    return {
      ...assumed,
      unresolvedConditions: [],
      openItems: [
        ...(assumed.openItems ?? []),
        ...assumed.unresolvedConditions.map(condition => ({
          title: condition,
          task: assumed.rationale,
          expectedValue: condition
        }))
      ]
    };
  }

  private async reviewDecisionOnce(
    candidate: PlannerReview,
    context: PlannerQualityContext,
    model: string,
    reasoning: unknown,
    signal?: AbortSignal
  ): Promise<PlannerReview> {
    throwIfAborted(signal);
    const uniqueLineage = lineageWithoutRepeatedReports(context.lineage, context.reportDetail);
    const taskContext: AimTaskContext = {
      timeoutMs: context.timeoutMs,
      aimEvidenceIds: context.evidenceIds,
      title: context.goal,
      summary: "",
      detail: "",
      rules: "",
      task: "",
      ancestors: "",
      outputLanguage: context.outputLanguage,
      mode: "task",
      researchMode: "local",
      researchDepth: "fast",
      visualMode: "off",
      signal
    };
    let reviewed =
      candidate.decision === "research_more" && candidate.gapKind === "not_decisive"
        ? this.withOpenItems(candidate, context.outputLanguage)
        : candidate;
    // Question limit of the checklist: past it, a new question or a gap only the user can close becomes an
    // assumption the document lists for the user to confirm, so the run ends with an answer instead of more questions.
    const checklist = context.goalDetail.includes(AIM_INTAKE_COMPLETE);
    if (context.unattended || (checklist && context.answeredQuestionCount >= CHECKLIST_QUESTION_LIMIT))
      reviewed = this.assumeInsteadOfAsking(reviewed, context);
    const repeatsKnownQuestion = context.questionHistory.some(
      question => question.trim().toLocaleLowerCase() === reviewed.question?.trim().toLocaleLowerCase()
    );
    const floor = context.unattended ? 0 : this.floorFor(context.goalDetail);
    const belowFloor = context.answeredQuestionCount < floor;
    // Below the floor, research on an already answered goal cannot satisfy the floor; only a user question can.
    const researchesAnsweredGoal =
      belowFloor && reviewed.decision === "research_more" && reviewed.goalAnswered === true;
    if (
      (belowFloor && reviewed.decision === "conclude") ||
      researchesAnsweredGoal ||
      (reviewed.decision === "ask_user" && repeatsKnownQuestion)
    ) {
      throwIfAborted(signal);
      const correctionTask = renderBelowFloorReviewTask({
        userQuestionRule: USER_QUESTION_RULE,
        answeredQuestionCount: context.answeredQuestionCount,
        minimumAnswers: floor,
        goal: context.goal,
        goalDetail: context.goalDetail,
        conditions: context.conditions,
        currentQuestion: context.currentQuestion,
        currentAnswer: context.currentAnswer,
        questionHistory: context.questionHistory,
        lineage: uniqueLineage,
        reportSummary: context.reportSummary,
        reportDetail: context.reportDetail,
        candidate: reviewed
      });
      const correctionContext: AimTaskContext = {
        ...taskContext,
        task: correctionTask,
        aimContract: reviewContract(["ask_user"])
      };
      const correctedResult = await this.askAimModel(correctionContext, model, reasoning, signal);
      throwIfAborted(signal);
      reviewed = await this.parsePlannerReviewWithRecovery(
        correctedResult,
        {
          question: context.goal,
          answerSnapshot: JSON.stringify({
            conditions: context.conditions,
            currentQuestion: context.currentQuestion,
            currentAnswer: context.currentAnswer
          }),
          reportSummary: context.reportSummary,
          reportDetail: context.reportDetail,
          requiredDecision: "ask_user",
          preferredQuestion: extractPlannerQuestionCandidate(correctedResult),
          requiredDecisionRationale: translateNote(
            context.outputLanguage,
            "note.aim_below_floor_rationale_0_1",
            context.answeredQuestionCount,
            floor
          )
        },
        correctionContext,
        model,
        reasoning,
        signal
      );
      const repeatsQuestion = context.questionHistory.some(
        question => question.trim().toLocaleLowerCase() === reviewed.question?.trim().toLocaleLowerCase()
      );
      if (reviewed.decision !== "ask_user" || repeatsQuestion)
        throw new Error(
          "AIM could not produce a compliant meaningful question below the conclusion floor; the result was not committed."
        );
    }
    // At or above the floor, research on a goal the review itself marks answered only pads the run;
    // one bounded no-search pass decides between concluding and asking the user instead.
    if (!belowFloor && reviewed.decision === "research_more" && reviewed.goalAnswered === true) {
      throwIfAborted(signal);
      const correctionTask = renderAnsweredGoalReviewTask({
        userQuestionRule: USER_QUESTION_RULE,
        goal: context.goal,
        goalDetail: context.goalDetail,
        conditions: context.conditions,
        currentQuestion: context.currentQuestion,
        currentAnswer: context.currentAnswer,
        questionHistory: context.questionHistory,
        lineage: uniqueLineage,
        reportSummary: context.reportSummary,
        reportDetail: context.reportDetail,
        candidate: reviewed
      });
      const correctionContext: AimTaskContext = {
        ...taskContext,
        task: correctionTask,
        aimContract: reviewContract(["conclude", "ask_user"])
      };
      const correctedResult = await this.askAimModel(correctionContext, model, reasoning, signal);
      throwIfAborted(signal);
      reviewed = await this.parsePlannerReviewWithRecovery(
        correctedResult,
        {
          question: context.goal,
          answerSnapshot: JSON.stringify({
            conditions: context.conditions,
            currentQuestion: context.currentQuestion,
            currentAnswer: context.currentAnswer
          }),
          reportSummary: context.reportSummary,
          reportDetail: context.reportDetail
        },
        correctionContext,
        model,
        reasoning,
        signal
      );
      const repeatsQuestion = context.questionHistory.some(
        question => question.trim().toLocaleLowerCase() === reviewed.question?.trim().toLocaleLowerCase()
      );
      if (reviewed.decision === "research_more" || repeatsQuestion)
        throw new Error(
          "AIM could not replace research on an already answered goal with a conclusion or a new question; the result was not committed."
        );
      if (context.unattended) reviewed = this.assumeInsteadOfAsking(reviewed, context);
    }
    // The checklist gate: a conclusion that still names an unknown decision-changing condition asks about it first.
    // If that question would repeat one already asked, the user could not settle it, so the conclusion keeps the
    // condition as an assumption to confirm instead.
    const unresolved = checklist && reviewed.decision === "conclude" ? (reviewed.unresolvedConditions ?? []) : [];
    if (unresolved.length) {
      const rationale = translateNote(
        context.outputLanguage,
        "note.aim_unresolved_conditions_0",
        unresolved.join("; ")
      );
      try {
        reviewed = await this.requireUserConditionQuestion(
          reviewed,
          context,
          { classification: "user_condition", rationale },
          model,
          reasoning,
          signal,
          false
        );
      } catch (error) {
        throwIfAborted(signal);
        if (!(error instanceof Error) || !/repeating a prior question/.test(error.message)) throw error;
        reviewed = {
          ...reviewed,
          unresolvedConditions: [],
          openItems: [
            ...(reviewed.openItems ?? []),
            ...unresolved.map(condition => ({ title: condition, task: rationale, expectedValue: condition }))
          ]
        };
      }
    }
    // Unattended never waits for the user: a gap only the user can close keeps the delivered document and lists it.
    // Without a delivered document yet, the gap goes back as user-only so the next pass delivers with it open.
    const assumeGap = (gap: PlannerReview): PlannerReview =>
      this.deliveryRejections.has(gap)
        ? this.publishRejectedDelivery(gap, context.outputLanguage)
        : { ...gap, gapKind: "user_only" };
    if (reviewed.decision === "conclude") {
      const openItems = (reviewed.openItems ?? [])
        .map(item => `- ${item.title}: ${item.task} (${item.expectedValue})`)
        .join("\n");
      const deliveryContext: AimTaskContext = {
        ...taskContext,
        ...(context.toneText ? { toneText: context.toneText } : {}),
        title: context.goal,
        summary: "",
        task: "",
        ancestors: "",
        detail: `Original user goal: ${context.goal}\nUser background and requested outcome: ${context.goalDetail}\nKnown conditions: ${JSON.stringify(context.conditions)}\nCurrent answer: ${context.currentAnswer}\nEarlier answers: ${uniqueLineage}\nPrior research:\n${context.reportDetail}${openItems ? `\n${renderOpenItemsContext(openItems)}` : ""}`
      };
      let checkpoint = context.deliveryRecovery?.checkpoint ?? {};
      let phase = context.deliveryRecovery?.phase;
      const delivery = await buildFinalDelivery(
        deliveryContext,
        step => this.askAimModel({ ...step, outputLanguage: deliveryContext.outputLanguage }, model, reasoning, signal),
        {
          checkpoint,
          timeoutMs: context.timeoutMs,
          webSearch: this.limits.webSearch,
          evidence: context.deliveryEvidence,
          ...(context.lineageEvidence?.length ? { lineageEvidence: context.lineageEvidence } : {}),
          knownConditions: JSON.stringify({
            goal: context.goal,
            background: context.goalDetail,
            conditions: context.conditions,
            currentQuestion: context.currentQuestion,
            currentAnswer: context.currentAnswer,
            earlierAnswers: context.lineage.split("\n").filter(line => line.startsWith("User answer to ")),
            ...(openItems ? { unverifiedItemsToConfirmWithUser: openItems } : {}),
            model,
            reasoning
          }),
          ...(openItems ? { openItems } : {}),
          onPhase: async current => {
            phase = current;
            await context.saveDeliveryRecovery?.(checkpoint, phase);
          },
          onCheckpoint: async saved => {
            checkpoint = saved;
            await context.saveDeliveryRecovery?.(checkpoint, phase);
          }
        }
      );
      const final = await this.parsePlannerReviewWithRecovery(
        delivery.result,
        {
          question: context.goal,
          answerSnapshot: JSON.stringify(context.conditions),
          reportSummary: context.reportSummary,
          reportDetail: `${context.reportDetail}\n\n${delivery.evidence}`
        },
        { ...deliveryContext, detail: `${deliveryContext.detail}\n\n${delivery.evidence}` },
        model,
        reasoning,
        signal
      );
      if (final.decision === "ask_user")
        throw new Error(
          "Final delivery review must complete the document or identify a research gap, not restart user clarification."
        );
      // Remember that this research_more is the final delivery acceptance's own verdict (smoke publication needs it).
      if (final.decision === "research_more")
        this.deliveryRejections.set(final, {
          summary: delivery.draft?.summary ?? final.summary,
          detail: delivery.draft?.detail ?? final.detail,
          openItems: reviewed.openItems ?? []
        });
      // The accepted document keeps the assumptions it was written with, so the user can correct them later.
      reviewed =
        final.decision === "conclude" && reviewed.openItems?.length
          ? { ...final, openItems: reviewed.openItems }
          : final;
    }
    if (context.unattended && reviewed.decision === "research_more" && reviewed.gapKind === "user_only")
      return assumeGap(reviewed);
    if (reviewed.decision === "research_more" && reviewed.gapKind === "user_only")
      return this.requireUserConditionQuestion(
        reviewed,
        context,
        { classification: "user_condition", rationale: reviewed.rationale },
        model,
        reasoning,
        signal
      );
    // The review names who can close the gap; only a legacy response without gapKind still needs the gap audit.
    if (reviewed.decision === "research_more" && !reviewed.gapKind) {
      const alreadyClassified =
        context.preclassifiedResearchTarget &&
        JSON.stringify(context.preclassifiedResearchTarget) === JSON.stringify(reviewed.researchTarget);
      const gap = alreadyClassified
        ? {
            classification: "external_evidence" as const,
            rationale:
              "This exact target was classified as externally verifiable immediately before its bounded search."
          }
        : await this.classifyResearchGap(reviewed, context, model, reasoning, signal);
      if (gap.classification === "user_condition")
        reviewed = context.unattended
          ? assumeGap(reviewed)
          : await this.requireUserConditionQuestion(reviewed, context, gap, model, reasoning, signal);
    }
    return reviewed;
  }

  private answerCountInLineage(map: MapDocument, branchId: string | null): number {
    return countAimAnsweredQuestions(map, branchId);
  }

  private async savedTerminalResult(mapPath: string, branchId: string): Promise<ManualResearchResult | undefined> {
    const map = await this.repository.readMap(mapPath),
      branch = map.aim?.branches.find(item => item.id === branchId);
    const resultRef =
      branch && [...branch.results].reverse().find(item => item.kind === "conclusion" || item.kind === "synthesis");
    if (!branch || !resultRef) return undefined;
    const attempt = map.aim?.runs
      .find(item => item.id === resultRef.runId)
      ?.attempts.find(item => item.id === resultRef.attemptId);
    const result: CommitResult = {
      status: "committed",
      resultId: resultRef.resultId,
      notePath: resultRef.notePath,
      ...(attempt?.status === "partial" ? { resultStatus: "partial" } : {})
    };
    const question = map.nodes.find(
      node => node.parentId === resultRef.nodeId && node.aimQuestion?.parentBranchId === branchId
    );
    if (question) return { status: "waiting-user", branchId, result, questionNodeId: question.id };
    return attempt?.status === "partial"
      ? { status: "partial", branchId, result }
      : { status: "completed", branchId, result };
  }

  async recoverQuestionDraft(mapPath: string): Promise<boolean> {
    const map = await this.repository.readMap(mapPath),
      draft = map.aim?.questionDraft;
    if (!draft) return false;
    await this.persist(() => this.commitQuestionDraft(mapPath, map, draft));
    return true;
  }

  async recoverPostReportQuestions(mapPath: string): Promise<number> {
    let created = 0;
    const initial = await this.repository.readMap(mapPath);
    const language = this.languageOf(initial);
    if (initial.aim?.questionDraft) return 0;
    for (const run of initial.aim?.runs ?? []) {
      const attempt = run.attempts.find(item => item.id === run.currentAttemptId);
      const review = attempt?.plannerReviews?.find(item => item.decision === "ask_user");
      if (
        !attempt ||
        (attempt.status !== "completed" && attempt.status !== "partial") ||
        !review?.question ||
        !review.answerOptions?.length
      )
        continue;
      const latest = await this.repository.readMap(mapPath),
        branch = latest.aim?.branches.find(item => item.id === run.branchId);
      const result = branch?.results.find(item => item.runId === run.id && item.attemptId === attempt.id);
      if (!branch || !result) continue;
      const resultNode = latest.nodes.find(node => node.id === result.nodeId);
      if (resultNode?.aimDismissedQuestionRequestIds?.includes(`post-${run.id}-${attempt.id}`)) continue;
      const existing = latest.nodes.some(
        node =>
          node.aimQuestion?.parentBranchId === branch.id &&
          (node.parentId === result.nodeId || node.aimConvergesFromNodeIds?.includes(result.nodeId))
      );
      if (existing) continue;
      const model = attempt.model ?? "gpt-6-luna",
        reasoning = attempt.reasoningLevel ?? "low";
      const answerOptions = normalizePersistedAnswerOptions(review.answerOptions);
      const saved = await this.saveManualQuestion(
        mapPath,
        result.nodeId,
        branch.id,
        `post-${run.id}-${attempt.id}`,
        model,
        reasoning,
        review.question,
        review.rationale,
        answerOptions,
        translateNote(language, "note.aim_prompt_recovered_post_report")
      );
      if (saved.status === "question") created++;
    }
    return created;
  }

  /** Reviews a saved diagnostic Searcher report without repeating that already completed research turn. */
  async reviewFailedAttemptReport(
    mapPath: string,
    runId: string,
    diagnosticNotePath: string,
    signal?: AbortSignal
  ): Promise<ManualResearchResult> {
    throwIfAborted(signal);
    const map = await this.repository.readMap(mapPath),
      run = map.aim?.runs.find(item => item.id === runId);
    const language = this.languageOf(map);
    const priorAttempt = run?.attempts.find(item => item.id === run.currentAttemptId);
    if (!run || !priorAttempt || priorAttempt.status !== "failed")
      throw new Error("A saved failed AIM attempt is required to review a diagnostic report.");
    const branch = map.aim?.branches.find(item => item.id === run.branchId),
      questionNode = branch && map.nodes.find(item => item.id === branch.questionNodeId);
    if (!branch || !questionNode) throw new Error("The failed run's answer branch or question is missing.");
    const expectedFolder = this.repository.topicFolder(mapPath, "Notes");
    if (!diagnosticNotePath.startsWith(`${expectedFolder}/`))
      throw new Error("The saved Searcher diagnostic must belong to this map.");
    const diagnostic = await this.repository.readNote(diagnosticNotePath);
    const isWrapped = diagnostic.detail.includes("**Status:** Diagnostic only.");
    const provenance = `**Prior attempt:** ${branch.id} / ${priorAttempt.id}; the persisted attempt remains failed.`;
    const structured = priorAttempt.retainedReports !== undefined;
    const savedReports = extractAimFailedReport(diagnostic, priorAttempt, diagnosticNotePath);
    if (!savedReports || (!structured && isWrapped && !diagnostic.detail.includes(provenance)))
      throw new Error(
        "The note is not a retained Searcher report for this failed attempt with completed-search evidence."
      );
    if (!structured && !isWrapped) {
      const sameOrdinalFailures = (map.aim?.runs ?? []).filter(candidate => {
        const current = candidate.attempts.find(item => item.id === candidate.currentAttemptId);
        return current?.id === priorAttempt.id && current.status === "failed";
      });
      if (sameOrdinalFailures.length !== 1 || sameOrdinalFailures[0].id !== run.id)
        throw new Error("The native diagnostic attempt number is ambiguous across failed runs in this map.");
    }
    const parent = await this.repository.readNote(questionNode.path, map);
    const topicNode = map.nodes.find(node => node.aimKind === "topic"),
      topic = topicNode ? await this.repository.readNote(topicNode.path, map) : parent;
    const lineage = await this.branchLineage(map, branch.parentBranchId);
    const questionHistory = await this.questionHistory(map, branch.id);
    const explorationTarget = map.aim?.minimumAnswersBeforeConclusion ?? 2;
    const answeredQuestionCount = this.answerCountInLineage(map, branch.id);
    const floor = this.floorFor(topic.detail, map);
    // The attempt's own model wins: readNote().model is always filled (it follows the workspace model).
    const model = priorAttempt.model || diagnostic.model || "gpt-6-luna";
    const taskDefaults: TaskContext = {
      timeoutMs: branch.retryTimeoutMs,
      title: topic.title,
      summary: topic.summary,
      rules: "",
      detail: topic.detail,
      task: "",
      ancestors: lineage.context,
      mode: "task",
      researchMode: this.researchMode(),
      researchDepth: "normal",
      visualMode: "off",
      detailFormat: "adaptive"
    };
    const reasoning = effectiveReasoningLevel(
      taskDefaults,
      normalizeReasoningLevel(priorAttempt.reasoningLevel ?? diagnostic.reasoning ?? "low")
    );
    const handle = await this.persist(() =>
      this.runs.startAttempt(mapPath, branch.id, run.id, {
        model,
        reasoning,
        maxResearchTurns: this.limits.maxResearchTurns
      })
    );
    if (!handle.dispatch) return { status: "in-progress", branchId: branch.id };
    try {
      // The saved Searcher report is one completed research turn for this new fenced attempt.
      await this.persist(() => this.runs.recordResearchTurn(mapPath, handle));
      let reports: AiResult[] = savedReports;
      const draftResult = await this.persist(() =>
        this.runs.createResultDraft(
          mapPath,
          handle,
          translateNote(language, "note.aim_answer_research_0", parent.summary),
          model,
          reasoning
        )
      );
      if (draftResult.status === "stale") return { status: "stale", branchId: branch.id };
      const draft = draftResult.draft;
      const saveReports = async (): Promise<boolean> => {
        const summary = reports.map((item, index) => `Report ${index + 1}: ${item.summary}`).join("\n");
        const detail = reports.map((item, index) => `## Searcher report ${index + 1}\n\n${item.detail}`).join("\n\n");
        return this.persist(() =>
          this.runs.updateResultDraftReport(mapPath, handle, draft.id, summary, detail, reports)
        );
      };
      if (!(await saveReports())) return { status: "stale", branchId: branch.id };
      const answerDescription = JSON.stringify(branch.answerSnapshot);
      let finalReview: ReturnType<typeof parseAimPlannerReview> | undefined;
      for (let reviewTurn = 1; reviewTurn <= 2; reviewTurn++) {
        throwIfAborted(signal);
        const aggregate = {
          summary: reports.map((report, index) => `Report ${index + 1}: ${report.summary}`).join("\n"),
          detail: reports.map((report, index) => `## Searcher report ${index + 1}\n\n${report.detail}`).join("\n\n")
        };
        const plannerPrompt = renderSavedReportReviewTask({
          plannerCoverageRule: PLANNER_COVERAGE_RULE,
          floorAskRule: FLOOR_ASK_RULE,
          userQuestionRule: USER_QUESTION_RULE,
          answeredQuestionCount,
          minimumAnswers: floor,
          explorationTarget,
          goal: topic.title,
          question: parent.summary,
          answerDescription,
          conditions: JSON.stringify(branch.inputSnapshot.conditions),
          lineage: lineage.context || "none",
          questionHistory,
          reportSummary: aggregate.summary,
          reportDetail: aggregate.detail
        });
        const plannerContext = {
          aimEvidenceIds: this.lineageEvidenceIds(map, branch.parentBranchId),
          title: topic.title,
          summary: aggregate.summary,
          rules: "",
          detail: aggregate.detail,
          task: plannerPrompt,
          ancestors: `Topic: ${topic.title}\n\n${topic.detail}\n\n${lineage.context}\n\nBranch conditions: ${JSON.stringify(branch.inputSnapshot.conditions)}`,
          outputLanguage: language,
          mode: "task" as const,
          researchMode: "local" as const,
          researchDepth: "fast" as const,
          visualMode: "off" as const,
          detailFormat: "adaptive" as const,
          aimContract: reviewContract(this.reviewDecisions(answeredQuestionCount, floor, map)),
          signal
        };
        const planner = await this.askAimModel(plannerContext, model, reasoning, signal);
        throwIfAborted(signal);
        finalReview = await this.parsePlannerReviewWithRecovery(
          planner,
          {
            question: `${topic.title}: ${parent.summary}`,
            answerSnapshot: answerDescription,
            reportSummary: aggregate.summary,
            reportDetail: aggregate.detail
          },
          {
            title: topic.title,
            summary: aggregate.summary,
            detail: aggregate.detail,
            ancestors: plannerContext.ancestors,
            outputLanguage: language,
            detailFormat: "adaptive",
            aimContract: plannerContext.aimContract
          },
          model,
          reasoning,
          signal
        );
        finalReview = await this.reviewPlannerDecisionQuality(
          finalReview,
          {
            goal: topic.title,
            goalDetail: topic.detail,
            unattended: this.isUnattended(map),
            outputLanguage: language,
            toneText: this.toneOf(map, language),
            conditions: branch.inputSnapshot.conditions,
            currentQuestion: parent.summary,
            currentAnswer: answerDescription,
            answeredQuestionCount,
            questionHistory,
            lineage: lineage.context,
            evidenceIds: this.lineageEvidenceIds(map, branch.parentBranchId),
            reportSummary: aggregate.summary,
            reportDetail: aggregate.detail
          },
          model,
          reasoning,
          signal
        );
        throwIfAborted(signal);
        if (reviewTurn === this.limits.maxResearchTurns) finalReview = this.atBudget(finalReview, language);
        if (finalReview.decision !== "research_more" || reviewTurn === this.limits.maxResearchTurns) {
          const stopReason =
            finalReview.decision === "conclude"
              ? finalReview.stopReason!
              : finalReview.decision === "ask_user"
                ? `Awaiting the user's answer to: ${finalReview.question}`
                : `One bounded follow-up was used; a material gap remains: ${finalReview.rationale}`;
          await this.persist(() =>
            this.runs.recordPlannerReview(
              mapPath,
              handle,
              {
                decision: finalReview!.decision,
                rationale: finalReview!.rationale,
                researchTurn: reviewTurn,
                ...(finalReview!.decision === "ask_user"
                  ? { question: finalReview!.question, answerOptions: finalReview!.answerOptions }
                  : {}),
                ...(finalReview!.decision === "research_more" ? { researchTarget: finalReview!.researchTarget } : {})
              },
              stopReason
            )
          );
          break;
        }
        await this.persist(() =>
          this.runs.recordPlannerReview(mapPath, handle, {
            decision: "research_more",
            rationale: finalReview!.rationale,
            researchTurn: reviewTurn,
            researchTarget: finalReview!.researchTarget
          })
        );
        await this.persist(() => this.runs.recordResearchTurn(mapPath, handle));
        const target = finalReview.researchTarget!;
        const task = renderSavedReportFollowupSearchTask({
          searcherTargetRule: SEARCHER_TARGET_RULE,
          title: target.title,
          task: target.task,
          expectedValue: target.expectedValue,
          question: parent.summary,
          answerDescription,
          reportDetail: aggregate.detail
        });
        const { diagnostic: diagnosticEvents, onEvent } = createSearchDiagnostic(reviewTurn + 1);
        const followup = await this.askAimModel(
          {
            title: parent.summary,
            summary: parent.summary,
            rules: "",
            detail: parent.detail,
            task,
            ancestors: `Topic: ${topic.title}\n\n${topic.detail}\n\nConditions: ${JSON.stringify(branch.inputSnapshot.conditions)}`,
            outputLanguage: language,
            ...(this.toneOf(map, language) ? { toneText: this.toneOf(map, language) } : {}),
            mode: "task",
            researchMode: this.researchMode(),
            researchDepth: "normal",
            visualMode: "off",
            aimIsolatedResearch: true,
            signal
          },
          model,
          reasoning,
          signal,
          onEvent
        );
        await this.persist(() => this.runs.recordSearchDiagnostic(mapPath, handle, diagnosticEvents));
        if (!followup.summary.trim() || !followup.detail.trim() || reportedSearchFailure(followup))
          throw new Error(
            "The bounded follow-up did not produce a usable searched report; the retry remains incomplete."
          );
        reports.push(followup);
        if (!(await saveReports())) return { status: "stale", branchId: branch.id };
      }
      if (!finalReview) throw new Error("Planner review did not produce a validated decision.");
      const detail =
        finalReview.decision === "conclude"
          ? await this.concludedDetail(finalReview, {
              title: topic.title,
              language,
              model,
              signal,
              mapPath,
              branchId: branch.id
            })
          : this.interimDetail([
              this.interimNotice(finalReview, language),
              this.readerDetail(finalReview),
              translateNote(language, "note.aim_supporting_research"),
              ...reports.map(report => report.detail),
              translateNote(language, "note.aim_source_boundary"),
              translateNote(language, "note.aim_source_boundary_not_verified")
            ]);
      const presentation =
        finalReview.decision === "conclude"
          ? {
              title: translateNote(language, "note.aim_conclusion"),
              kind: "conclusion" as const
            }
          : {
              title: translateNote(
                language,
                finalReview.decision === "research_more" ? "note.aim_needs_followup" : "note.aim_synthesis"
              ),
              kind: "synthesis" as const
            };
      if (
        !(await this.persist(() =>
          this.runs.updateResultDraftPresentation(mapPath, handle, draft.id, presentation.title, presentation.kind)
        ))
      )
        return { status: "stale", branchId: branch.id };
      const committed = await this.persist(() => {
        throwIfAborted(signal);
        return this.runs.commitResult(
          mapPath,
          handle,
          draft.id,
          { summary: finalReview.summary, detail },
          this.budgetExitStatus(finalReview.decision)
        );
      });
      if (committed.status !== "committed") return { status: "stale", branchId: branch.id };
      if (finalReview.decision === "ask_user") {
        const latestMap = await this.repository.readMap(mapPath),
          resultRef = latestMap.aim?.branches
            .find(item => item.id === branch.id)
            ?.results.find(item => item.runId === handle.runId && item.attemptId === handle.attemptId);
        if (!resultRef)
          throw new Error("Planner conclusion was committed without a result reference for its follow-up question.");
        const questionResult = await this.saveManualQuestion(
          mapPath,
          resultRef.nodeId,
          branch.id,
          `post-${handle.runId}-${handle.attemptId}`,
          model,
          reasoning,
          finalReview.question!,
          finalReview.rationale,
          finalReview.answerOptions!,
          translateNote(language, "note.aim_prompt_followup_selected"),
          signal
        );
        if (questionResult.status !== "question")
          throw new Error("Planner requested a user condition but the follow-up question was not saved.");
        return {
          status: "waiting-user",
          branchId: branch.id,
          result: committed,
          questionNodeId: questionResult.node.id
        };
      }
      return this.budgetExitStatus(finalReview.decision) === "partial"
        ? { status: "partial", branchId: branch.id, result: { ...committed, resultStatus: "partial" } }
        : { status: "completed", branchId: branch.id, result: committed };
    } catch (error) {
      try {
        if (signal?.aborted)
          await this.persist(() =>
            this.runs
              .cancelAttempt(mapPath, handle, "User cancelled saved-report Planner review.")
              .then(() => undefined)
          );
        else
          await this.persist(() =>
            this.runs
              .failAttempt(mapPath, handle, error instanceof Error ? error.message : String(error))
              .then(() => undefined)
          );
      } catch (persistenceError) {
        if (!(
          persistenceError instanceof Error && persistenceError.message.includes("A saving attempt must be recovered")
        ))
          throw new AggregateError(
            [error, persistenceError],
            "Planner review failed and its attempt state could not be updated."
          );
      }
      throw error;
    } finally {
      this.runs.releaseAttempt(mapPath, handle);
    }
  }

  /** Starts a new, user-invoked attempt on a saved partial branch without replacing earlier results. */
  async continuePartial(
    mapPath: string,
    runId: string,
    model?: string,
    reasoning?: unknown,
    signal?: AbortSignal
  ): Promise<ManualResearchResult> {
    const key = `${mapPath}\n${runId}`,
      fingerprint = JSON.stringify({ model, reasoning });
    const existing = AimManualFlow.continuationRuns.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error("This partial continuation is already running with different model settings.");
      return existing.promise;
    }
    const promise = this.runPartialContinuation(mapPath, runId, model, reasoning, signal).finally(() =>
      AimManualFlow.continuationRuns.delete(key)
    );
    AimManualFlow.continuationRuns.set(key, { fingerprint, promise });
    return promise;
  }

  private async runPartialContinuation(
    mapPath: string,
    runId: string,
    model?: string,
    reasoning?: unknown,
    signal?: AbortSignal
  ): Promise<ManualResearchResult> {
    throwIfAborted(signal);
    const map = await this.repository.readMap(mapPath),
      run = map.aim?.runs.find(item => item.id === runId);
    const language = this.languageOf(map);
    const currentAttempt = run?.attempts.find(item => item.id === run.currentAttemptId);
    if (
      !run ||
      !currentAttempt ||
      ["running", "saving"].includes(currentAttempt.status) ||
      !["partial", "failed", "cancelled"].includes(currentAttempt.status)
    )
      throw new Error("Only a saved partial branch without active work can be continued.");
    const priorAttempt = [...run.attempts].reverse().find(item => item.status === "partial");
    if (!priorAttempt) throw new Error("This run has no saved partial attempt to continue.");
    const branch = map.aim!.branches.find(item => item.id === run.branchId),
      questionNode = branch && map.nodes.find(item => item.id === branch.questionNodeId);
    const priorRef = branch?.results.find(item => item.runId === run.id && item.attemptId === priorAttempt.id);
    if (!branch || !questionNode || !priorRef)
      throw new Error("The partial result or its answer branch is missing; it cannot be continued safely.");
    const priorNote = await this.repository.readNote(priorRef.notePath, map),
      parent = await this.repository.readNote(questionNode.path, map);
    const topicNode =
      map.nodes.find(item => item.aimKind === "topic") ?? map.nodes.find(item => item.parentId === null);
    const topicNote = topicNode ? await this.repository.readNote(topicNode.path, map) : parent;
    const lineage = await this.branchLineage(map, branch.parentBranchId);
    const savedResearchNodeIds = [
      ...new Set(
        branch.results
          .filter(
            result =>
              result.kind === "research" &&
              !!result.subtopicId &&
              map.nodes.some(
                node =>
                  node.id === result.nodeId && node.aimKind === "research" && node.parentId === branch.questionNodeId
              )
          )
          .map(result => result.nodeId)
      )
    ];
    const continuationDraftOptions = savedResearchNodeIds.length
      ? {
          kind: "synthesis" as const,
          parentNodeId: savedResearchNodeIds[savedResearchNodeIds.length - 1],
          convergesFromNodeIds: savedResearchNodeIds
        }
      : undefined;
    const answeredQuestionCount = this.answerCountInLineage(map, branch.id);
    const floor = this.floorFor(topicNote.detail, map);
    const explorationTarget = map.aim?.minimumAnswersBeforeConclusion ?? 2;
    const questionsAlreadyAsked = await this.questionHistory(map, branch.id);
    const modelToUse = model?.trim() || priorAttempt.model || "gpt-6-luna";
    const taskDefaults: TaskContext = {
      timeoutMs: branch.retryTimeoutMs,
      title: topicNote.title,
      summary: topicNote.summary,
      rules: "",
      detail: topicNote.detail,
      task: "",
      ancestors: lineage.context,
      mode: "task",
      researchMode: this.researchMode(),
      researchDepth: "normal",
      visualMode: "off",
      detailFormat: "adaptive"
    };
    const reasoningToUse = effectiveReasoningLevel(
      taskDefaults,
      normalizeReasoningLevel(reasoning ?? priorAttempt.reasoningLevel ?? "low")
    );
    const handle = await this.persist(() =>
      this.runs.startAttempt(mapPath, branch.id, run.id, {
        model: modelToUse,
        reasoning: reasoningToUse,
        maxResearchTurns: this.limits.maxResearchTurns
      })
    );
    if (!handle.dispatch) return { status: "in-progress", branchId: branch.id };
    try {
      let latestReview: {
        rationale?: string;
        researchTarget?: { title: string; task: string; expectedValue: string };
      } = priorAttempt.plannerReviews?.at(-1) ?? {};
      let report = { summary: priorNote.summary, detail: priorNote.detail };
      let draft: import("../../map-model").AimResultDraftRecord | undefined;
      let review: ReturnType<typeof parseAimPlannerReview> | undefined;
      let stopReason = "";
      let preclassifiedResearchTarget: PlannerReview["researchTarget"];
      const priorDecision = priorAttempt.plannerReviews?.at(-1);
      // Unattended never stops to ask: a continuation goes straight back to research on the saved target.
      if (priorDecision?.decision === "research_more" && this.isUnattended(map))
        preclassifiedResearchTarget = priorDecision.researchTarget;
      else if (priorDecision?.decision === "research_more") {
        const priorCandidate: PlannerReview = {
          decision: "research_more",
          rationale: priorDecision.rationale,
          researchTarget: priorDecision.researchTarget,
          summary: priorNote.summary,
          detail: priorNote.detail,
          answerOptions: []
        };
        const qualityContext: PlannerQualityContext = {
          goal: topicNote.title,
          goalDetail: topicNote.detail,
          unattended: this.isUnattended(map),
          outputLanguage: language,
          toneText: this.toneOf(map, language),
          conditions: branch.inputSnapshot.conditions,
          currentQuestion: parent.summary,
          currentAnswer: JSON.stringify(branch.answerSnapshot),
          answeredQuestionCount,
          questionHistory: questionsAlreadyAsked,
          lineage: lineage.context,
          evidenceIds: this.lineageEvidenceIds(map, branch.parentBranchId),
          reportSummary: priorNote.summary,
          reportDetail: priorNote.detail
        };
        const gap = await this.classifyResearchGap(priorCandidate, qualityContext, modelToUse, reasoningToUse, signal);
        if (gap.classification === "user_condition") {
          await this.persist(() => this.runs.recordResearchTurn(mapPath, handle));
          const forcedReview = await this.requireUserConditionQuestion(
            priorCandidate,
            qualityContext,
            gap,
            modelToUse,
            reasoningToUse,
            signal
          );
          review = forcedReview;
          stopReason = `Awaiting the user's answer to: ${forcedReview.question}`;
          await this.persist(() =>
            this.runs.recordPlannerReview(
              mapPath,
              handle,
              {
                decision: "ask_user",
                rationale: forcedReview.rationale,
                question: forcedReview.question,
                answerOptions: forcedReview.answerOptions,
                researchTurn: 1
              },
              stopReason
            )
          );
          const earlyOptions = savedResearchNodeIds.length ? continuationDraftOptions : { kind: "synthesis" as const };
          const created = await this.persist(() =>
            this.runs.createResultDraft(
              mapPath,
              handle,
              translateNote(language, "note.aim_title_user_condition_0", parent.summary),
              modelToUse,
              reasoningToUse,
              earlyOptions
            )
          );
          if (created.status === "stale") return { status: "stale", branchId: branch.id };
          draft = created.draft;
          if (
            !(await this.persist(() =>
              this.runs.updateResultDraftReport(mapPath, handle, draft!.id, report.summary, report.detail)
            ))
          )
            return { status: "stale", branchId: branch.id };
        } else preclassifiedResearchTarget = priorDecision.researchTarget;
      }
      for (let researchTurn = 1; !review && researchTurn <= this.limits.maxResearchTurns; researchTurn++) {
        throwIfAborted(signal);
        await this.persist(() => this.runs.recordResearchTurn(mapPath, handle));
        const { diagnostic, onEvent } = createSearchDiagnostic(researchTurn);
        const task = renderPartialContinuationSearchTask({
          searcherTargetRule: SEARCHER_TARGET_RULE,
          gap: latestReview?.researchTarget
            ? { kind: "target", ...latestReview.researchTarget }
            : {
                kind: "unresolved",
                text: latestReview?.rationale ?? priorAttempt.stopReason ?? "Continue the incomplete evidence check."
              },
          goal: topicNote.title,
          question: parent.summary,
          answer: JSON.stringify(branch.answerSnapshot),
          conditions: JSON.stringify(branch.inputSnapshot.conditions),
          lineage: lineage.context || "None.",
          reportSummary: report.summary,
          reportDetail: report.detail
        });
        let searcher: AiResult;
        try {
          searcher = await this.askAimModel(
            {
              timeoutMs: branch.retryTimeoutMs,
              aimEvidenceIds: this.lineageEvidenceIds(map, branch.parentBranchId),
              title: topicNote.title,
              summary: report.summary,
              rules: "",
              detail: report.detail,
              task,
              ancestors: `Original goal: ${topicNote.title}\n\n${topicNote.detail}\n\n${lineage.context}\n\nPersisted answer branch conditions: ${JSON.stringify(branch.inputSnapshot.conditions)}`,
              outputLanguage: language,
              ...(this.toneOf(map, language) ? { toneText: this.toneOf(map, language) } : {}),
              mode: "task",
              researchMode: this.researchMode(),
              researchDepth: "normal",
              visualMode: "off",
              detailFormat: "adaptive",
              aimIsolatedResearch: true,
              signal
            },
            modelToUse,
            reasoningToUse,
            signal,
            onEvent
          );
        } catch (error) {
          await this.persist(() => this.runs.recordSearchDiagnostic(mapPath, handle, diagnostic));
          throw error;
        }
        await this.persist(() => this.runs.recordSearchDiagnostic(mapPath, handle, diagnostic));
        throwIfAborted(signal);
        if (!searcher.summary.trim() || !searcher.detail.trim() || reportedSearchFailure(searcher))
          throw new Error("Continuation research did not return a usable searched report.");
        report = {
          summary: `${report.summary}\n\n${translateNote(language, "note.aim_followup_report_0", searcher.summary)}`,
          detail: `${report.detail}\n\n${translateNote(language, "note.aim_continuation_report")}\n\n${searcher.detail}`
        };
        const savedReport = await this.persist(async () => {
          throwIfAborted(signal);
          if (!draft) {
            const created = await this.runs.createResultDraft(
              mapPath,
              handle,
              translateNote(language, "note.aim_title_continued_research_0", parent.summary),
              modelToUse,
              reasoningToUse,
              continuationDraftOptions
            );
            if (created.status === "stale") return false;
            draft = created.draft;
          }
          return this.runs.updateResultDraftReport(mapPath, handle, draft.id, report.summary, report.detail);
        });
        if (!savedReport) return { status: "stale", branchId: branch.id };
        const plannerPrompt = renderPartialContinuationReviewTask({
          plannerCoverageRule: PLANNER_COVERAGE_RULE,
          floorAskRule: FLOOR_ASK_RULE,
          userQuestionRule: USER_QUESTION_RULE,
          answeredQuestionCount,
          minimumAnswers: floor,
          explorationTarget,
          questionsAlreadyAsked,
          goal: topicNote.title,
          question: parent.summary,
          answer: JSON.stringify(branch.answerSnapshot),
          conditions: JSON.stringify(branch.inputSnapshot.conditions),
          lineage: lineage.context || "None.",
          reportSummary: report.summary,
          reportDetail: report.detail
        });
        const plannerContext = {
          timeoutMs: branch.retryTimeoutMs,
          aimEvidenceIds: this.lineageEvidenceIds(map, branch.parentBranchId),
          title: topicNote.title,
          summary: report.summary,
          rules: "",
          detail: report.detail,
          task: plannerPrompt,
          ancestors: `Original goal: ${topicNote.title}\n\n${topicNote.detail}\n\n${lineage.context}\n\nConditions: ${JSON.stringify(branch.inputSnapshot.conditions)}`,
          outputLanguage: language,
          mode: "task" as const,
          researchMode: "local" as const,
          researchDepth: "fast" as const,
          visualMode: "off" as const,
          detailFormat: "adaptive" as const,
          aimContract: reviewContract(this.reviewDecisions(answeredQuestionCount, floor, map)),
          signal
        };
        const planner = await this.askAimModel(plannerContext, modelToUse, reasoningToUse, signal);
        throwIfAborted(signal);
        review = await this.parsePlannerReviewWithRecovery(
          planner,
          {
            question: topicNote.title,
            answerSnapshot: JSON.stringify(branch.answerSnapshot),
            reportSummary: report.summary,
            reportDetail: report.detail
          },
          plannerContext,
          modelToUse,
          reasoningToUse,
          signal
        );
        review = await this.reviewPlannerDecisionQuality(
          review,
          {
            goal: topicNote.title,
            goalDetail: topicNote.detail,
            unattended: this.isUnattended(map),
            outputLanguage: language,
            toneText: this.toneOf(map, language),
            conditions: branch.inputSnapshot.conditions,
            currentQuestion: parent.summary,
            currentAnswer: JSON.stringify(branch.answerSnapshot),
            answeredQuestionCount,
            questionHistory: questionsAlreadyAsked,
            lineage: lineage.context,
            evidenceIds: this.lineageEvidenceIds(map, branch.parentBranchId),
            timeoutMs: branch.retryTimeoutMs,
            reportSummary: report.summary,
            reportDetail: report.detail,
            ...(preclassifiedResearchTarget ? { preclassifiedResearchTarget } : {})
          },
          modelToUse,
          reasoningToUse,
          signal
        );
        throwIfAborted(signal);
        if (researchTurn === this.limits.maxResearchTurns) review = this.atBudget(review, language);
        latestReview = { rationale: review.rationale, researchTarget: review.researchTarget };
        if (review.decision === "research_more" && researchTurn < this.limits.maxResearchTurns) {
          await this.persist(() =>
            this.runs.recordPlannerReview(mapPath, handle, {
              decision: review!.decision,
              rationale: review!.rationale,
              researchTurn,
              researchTarget: review!.researchTarget
            })
          );
          continue;
        }
        stopReason =
          review.decision === "conclude"
            ? review.stopReason!
            : review.decision === "ask_user"
              ? `Awaiting the user's answer to: ${review.question}`
              : `Continuation attempt reached its prototype research-turn budget with a material gap remaining: ${review.rationale}`;
        await this.persist(() =>
          this.runs.recordPlannerReview(
            mapPath,
            handle,
            {
              decision: review!.decision,
              rationale: review!.rationale,
              researchTurn,
              ...(review!.decision === "ask_user"
                ? { question: review!.question, answerOptions: review!.answerOptions }
                : {}),
              ...(review!.decision === "research_more" ? { researchTarget: review!.researchTarget } : {})
            },
            stopReason
          )
        );
        break;
      }
      if (!draft || !review) throw new Error("Continuation ended without a persisted Planner decision.");
      const finalDraft = draft,
        finalReview = review;
      const detail =
        finalReview.decision === "conclude"
          ? await this.concludedDetail(finalReview, {
              title: topicNote.title,
              language,
              model: modelToUse,
              signal,
              mapPath,
              branchId: branch.id
            })
          : this.interimDetail([
              this.interimNotice(finalReview, language),
              finalReview.decision === "research_more"
                ? translateNote(language, "note.aim_research_status_partial")
                : translateNote(language, "note.aim_interim_result"),
              this.readerDetail(finalReview),
              ...(finalReview.decision === "research_more"
                ? [translateNote(language, "note.aim_attempt_budget_gap")]
                : []),
              translateNote(language, "note.aim_saved_evidence"),
              report.detail,
              translateNote(language, "note.aim_source_boundary"),
              translateNote(language, "note.aim_source_boundary_were_not_verified")
            ]);
      const finalKind = finalReview.decision === "conclude" ? ("conclusion" as const) : ("synthesis" as const);
      const finalTitle =
        finalReview.decision === "conclude"
          ? translateNote(language, "note.aim_conclusion")
          : finalReview.decision === "research_more"
            ? translateNote(language, "note.aim_needs_followup")
            : translateNote(language, "note.aim_synthesis");
      if (
        !(await this.persist(() =>
          this.runs.updateResultDraftPresentation(mapPath, handle, finalDraft.id, finalTitle, finalKind)
        ))
      )
        return { status: "stale", branchId: branch.id };
      const committed = await this.persist(() => {
        throwIfAborted(signal);
        return this.runs.commitResult(
          mapPath,
          handle,
          finalDraft.id,
          {
            summary:
              finalReview.decision === "research_more"
                ? translateNote(language, "note.aim_partial_summary_0", finalReview.summary)
                : finalReview.summary,
            detail
          },
          this.budgetExitStatus(finalReview.decision)
        );
      });
      if (committed.status !== "committed") return { status: "stale", branchId: branch.id };
      if (review.decision === "ask_user") {
        const latest = await this.repository.readMap(mapPath),
          newResult = latest.aim?.branches.find(item => item.id === branch.id)?.results.at(-1);
        if (!newResult)
          throw new Error("Continuation result was committed without a result parent for the pending question.");
        const answerOptions = normalizePersistedAnswerOptions(review.answerOptions);
        const question = await this.saveManualQuestion(
          mapPath,
          newResult.nodeId,
          branch.id,
          `post-${handle.runId}-${handle.attemptId}`,
          modelToUse,
          reasoningToUse,
          review.question!,
          review.rationale,
          answerOptions,
          translateNote(language, "note.aim_prompt_question_recovered"),
          signal
        );
        if (question.status !== "question")
          throw new Error("Continuation requested user input but no question was saved.");
        return { status: "waiting-user", branchId: branch.id, result: committed, questionNodeId: question.node.id };
      }
      return this.budgetExitStatus(review.decision) === "partial"
        ? { status: "partial", branchId: branch.id, result: committed }
        : { status: "completed", branchId: branch.id, result: committed };
    } catch (error) {
      try {
        if (signal?.aborted)
          await this.persist(() =>
            this.runs.cancelAttempt(mapPath, handle, "User cancelled the continuation attempt.").then(() => undefined)
          );
        else
          await this.persist(() =>
            this.runs
              .failAttempt(mapPath, handle, error instanceof Error ? error.message : String(error))
              .then(() => undefined)
          );
      } catch (persistenceError) {
        if (!(
          persistenceError instanceof Error && persistenceError.message.includes("A saving attempt must be recovered")
        ))
          throw new AggregateError(
            [error, persistenceError],
            "Continuation failed and its attempt state could not be updated."
          );
      }
      throw error;
    } finally {
      this.runs.releaseAttempt(mapPath, handle);
    }
  }

  async planNextQuestion(
    mapPath: string,
    parentNodeId: string,
    model: string,
    reasoning: unknown,
    requestId: string,
    parentBranchId: string | null = null,
    signal?: AbortSignal
  ): Promise<PlannerQuestionResult> {
    throwIfAborted(signal);
    const key = `${mapPath}\n${requestId}`,
      fingerprint = JSON.stringify({ parentNodeId, parentBranchId, model, reasoning });
    const active = AimManualFlow.questionPlans.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint)
        throw new Error("This Planner question identity is already running with different input.");
      return this.subscribeToQuestionPlan(key, active, signal);
    }
    const controller = new AbortController();
    const entry: QuestionPlanEntry = {
      fingerprint,
      controller,
      promise: Promise.resolve({ status: "no-question" }),
      subscribers: new Set(),
      settled: false
    };
    entry.promise = this.createPlannerQuestion(
      mapPath,
      parentNodeId,
      model,
      reasoning,
      requestId,
      parentBranchId,
      controller.signal
    ).finally(() => {
      entry.settled = true;
      if (AimManualFlow.questionPlans.get(key) === entry) AimManualFlow.questionPlans.delete(key);
    });
    AimManualFlow.questionPlans.set(key, entry);
    return this.subscribeToQuestionPlan(key, entry, signal);
  }

  private subscribeToQuestionPlan(
    key: string,
    entry: QuestionPlanEntry,
    signal?: AbortSignal
  ): Promise<PlannerQuestionResult> {
    throwIfAborted(signal);
    const subscriber = Symbol("Planner request owner");
    entry.subscribers.add(subscriber);
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        entry.subscribers.delete(subscriber);
        if (!entry.settled && entry.subscribers.size === 0) {
          if (AimManualFlow.questionPlans.get(key) === entry) AimManualFlow.questionPlans.delete(key);
          entry.controller.abort();
        }
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        reject(error);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        value => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        },
        error => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
      if (signal?.aborted) onAbort();
    });
  }

  private async createPlannerQuestion(
    mapPath: string,
    parentNodeId: string,
    model: string,
    reasoning: unknown,
    requestId: string,
    parentBranchId: string | null,
    signal?: AbortSignal
  ): Promise<PlannerQuestionResult> {
    throwIfAborted(signal);
    if (!requestId.trim()) throw new Error("Planner question request identity is required.");
    const map = await this.repository.readMap(mapPath),
      state = map.aim;
    if (!state) throw new Error("AIM map data is missing.");
    const existingQuestion = map.nodes.find(node => node.aimQuestion?.requestId === requestId);
    if (existingQuestion?.aimQuestion) {
      if (
        existingQuestion.parentId !== parentNodeId ||
        (existingQuestion.aimQuestion.parentBranchId ?? null) !== parentBranchId
      )
        throw new Error("This Planner question identity was already used for another parent node or branch.");
      return { status: "question", node: existingQuestion, options: existingQuestion.aimQuestion.options };
    }
    if (state.questionDraft) {
      if (state.questionDraft.requestId !== requestId)
        throw new Error("A previous Planner question save must be recovered before planning another question.");
      if (
        state.questionDraft.parentId !== parentNodeId ||
        (state.questionDraft.parentBranchId ?? null) !== parentBranchId
      )
        throw new Error("This Planner question identity was already saved for another parent node or branch.");
      throwIfAborted(signal);
      await this.persist(() => this.commitQuestionDraft(mapPath, map, state.questionDraft!));
      const recovered = await this.repository.readMap(mapPath),
        node = recovered.nodes.find(item => item.id === state.questionDraft!.nodeId)!;
      return { status: "question", node, options: node.aimQuestion!.options };
    }
    const parentNode = map.nodes.find(item => item.id === parentNodeId);
    if (!parentNode) throw new Error("AIM question parent does not exist.");
    const parentBranch = parentBranchId ? state.branches.find(branch => branch.id === parentBranchId) : undefined;
    const branchResult = parentBranch?.results.find(result => result.nodeId === parentNodeId);
    const isSavedTerminalResult =
      !!branchResult &&
      (parentNode.aimKind === "synthesis" || parentNode.aimKind === "conclusion") &&
      (!branchResult.kind || branchResult.kind === parentNode.aimKind);
    const expectedResultBranchSnapshot =
      isSavedTerminalResult && parentBranch
        ? JSON.stringify({
            inputSnapshot: parentBranch.inputSnapshot,
            results: parentBranch.results.map(({ nodeId, version }) => ({ nodeId, version }))
          })
        : undefined;
    if (parentBranchId) {
      if (!parentBranch || !parentBranch.results.some(result => result.nodeId === parentNodeId))
        throw new Error("A follow-up Planner question must attach to a result in its parent answer branch.");
    }
    if ((parentNode.aimKind === "synthesis" || parentNode.aimKind === "conclusion") && !isSavedTerminalResult)
      throw new Error("A new follow-up question must attach to a saved synthesis or conclusion in its answer branch.");
    const parent = await this.repository.readNote(parentNode.path);
    const motherNode = map.nodes.find(node => node.aimKind === "topic");
    const mother =
      motherNode && motherNode.id !== parentNode.id ? await this.repository.readNote(motherNode.path, map) : parent;
    const lineage = await this.branchLineage(map, parentBranchId);
    const explorationTarget = state.minimumAnswersBeforeConclusion ?? 2;
    const answeredQuestionCount = this.answerCountInLineage(map, parentBranchId);
    const floor = this.floorFor(mother.detail, map);
    const priorQuestions = await this.questionHistory(map, parentBranchId);
    const savedConditions: { branchId: string; conditions: Record<string, string> }[] = [];
    let conditionBranch = parentBranch;
    while (conditionBranch) {
      savedConditions.unshift({ branchId: conditionBranch.id, conditions: conditionBranch.inputSnapshot.conditions });
      conditionBranch = conditionBranch.parentBranchId
        ? state.branches.find(branch => branch.id === conditionBranch!.parentBranchId)
        : undefined;
    }
    const siblingQuestions = isSavedTerminalResult
      ? await Promise.all(
          map.nodes
            .filter(
              node =>
                node.parentId === parentNodeId &&
                node.aimKind === "question" &&
                node.aimQuestion?.parentBranchId === parentBranchId
            )
            .map(async node => (await this.repository.readNote(node.path)).summary)
        )
      : [];
    const dismissedQuestions = isSavedTerminalResult
      ? state.runs.flatMap(run => {
          if (run.branchId !== parentBranchId) return [];
          return run.attempts.flatMap(attempt => {
            if (!parentNode.aimDismissedQuestionRequestIds?.includes(`post-${run.id}-${attempt.id}`)) return [];
            const result = parentBranch?.results.find(
              item => item.runId === run.id && item.attemptId === attempt.id && item.nodeId === parentNodeId
            );
            const review = attempt.plannerReviews?.find(item => item.decision === "ask_user" && item.question);
            return result && review?.question ? [review.question] : [];
          });
        })
      : [];
    const knownQuestions = [
      ...new Set(
        [...priorQuestions, ...siblingQuestions, ...dismissedQuestions].map(question => question.trim()).filter(Boolean)
      )
    ];
    const language = this.languageOf(map);
    const motherGoal =
      motherNode && motherNode.id !== parentNode.id ? { title: mother.title, detail: mother.detail } : undefined;
    const questionVars = {
      userQuestionRule: USER_QUESTION_RULE,
      minimumAnswers: floor,
      answeredQuestionCount,
      explorationTarget,
      currentTopic: { title: parent.title, summary: parent.summary, detail: parent.detail },
      mother: motherGoal,
      lineage: lineage.context
    };
    const prompt = isSavedTerminalResult
      ? renderSavedTerminalQuestionTask({ ...questionVars, savedConditions, knownQuestions })
      : renderInitialQuestionTask(questionVars);
    // Below the floor, or when the user explicitly asked for a new question, the schema itself forbids skipping.
    const requireQuestion = isSavedTerminalResult || answeredQuestionCount < floor;
    const context: AimTaskContext = {
      aimEvidenceIds: this.lineageEvidenceIds(map, parentBranchId),
      title: parent.title,
      summary: parent.summary,
      rules: "",
      detail: parentNode.aimKind === "topic" ? parent.detail : "",
      task: prompt,
      ancestors: lineage.context,
      outputLanguage: language,
      mode: "task",
      researchMode: "local",
      researchDepth: "fast",
      visualMode: "off",
      aimContract: { kind: "question", requireQuestion },
      signal
    };
    throwIfAborted(signal);
    // Unattended: the intake was the only questionnaire, so the first round researches the goal directly.
    // Only until the topic's own research has a document; after that, another route asks the Planner as usual.
    const topicConcluded = map.aim?.branches.some(
      branch =>
        branch.submissionId === `initial-${parentNode.id}` &&
        branch.results.some(result => result.kind === "conclusion")
    );
    if (
      this.isUnattended(map) &&
      parentNode.aimKind === "topic" &&
      !parentBranchId &&
      !isSavedTerminalResult &&
      !topicConcluded
    )
      return this.researchFromTopic(mapPath, map, parentNode, model, reasoning, signal);
    let result = await this.askAimModel(context, model, reasoning, signal);
    throwIfAborted(signal);
    if (isSavedTerminalResult && result.summary.trim() === AIM_NO_QUESTION)
      throw new Error(
        "Planner must create a new question from this saved result; no conclusion or no-question response is allowed."
      );
    if (!isSavedTerminalResult && result.summary.trim() === AIM_NO_QUESTION && answeredQuestionCount < floor) {
      const previousQuestions = await this.questionHistory(map, parentBranchId);
      const correctionPrompt = renderQuestionCorrectionTask({
        answeredQuestionCount,
        minimumAnswers: floor,
        originalTopic: { title: parent.title, summary: parent.summary, detail: parent.detail },
        mother: motherGoal,
        previousQuestions,
        lineage: lineage.context
      });
      result = await this.askAimModel(
        { ...context, task: correctionPrompt, aimContract: { kind: "question", requireQuestion: true } },
        model,
        reasoning,
        signal
      );
      throwIfAborted(signal);
      if (result.summary.trim() === AIM_NO_QUESTION)
        throw new Error(
          "AIM could not produce a meaningful question below the conclusion floor; no root conclusion was created."
        );
      if (
        previousQuestions.some(
          question => question.trim().toLocaleLowerCase() === result.summary.trim().toLocaleLowerCase()
        )
      )
        throw new Error(
          "AIM repeated a prior question instead of meeting the conclusion floor; no root conclusion was created."
        );
    }
    if (
      isSavedTerminalResult &&
      knownQuestions.some(question => question.toLocaleLowerCase() === result.summary.trim().toLocaleLowerCase())
    )
      throw new Error(
        "Planner repeated an existing question instead of creating a new question from the saved result."
      );
    if (!isSavedTerminalResult && answeredQuestionCount < floor) {
      if (
        priorQuestions.some(
          question => question.trim().toLocaleLowerCase() === result.summary.trim().toLocaleLowerCase()
        )
      )
        throw new Error(
          "AIM repeated a prior question instead of meeting the conclusion floor; no root conclusion was created."
        );
    }
    if (result.summary.trim() === AIM_NO_QUESTION) {
      if (parentNode.aimKind !== "topic" || parentBranchId) return { status: "no-question" };
      return this.researchFromTopic(mapPath, map, parentNode, model, reasoning, signal);
    }
    const labels = [...new Set(result.suggestions.map(item => item.title.trim()).filter(Boolean))];
    if (!result.summary.trim() || labels.length < 2 || labels.length > 5)
      throw new Error("Planner must return one question and 2–5 distinct answer options before it can be saved.");
    return this.saveManualQuestion(
      mapPath,
      parentNodeId,
      parentBranchId,
      requestId,
      model,
      effectiveReasoningLevel(context, normalizeReasoningLevel(reasoning)),
      result.summary.trim(),
      result.detail.trim(),
      labels,
      prompt,
      signal,
      expectedResultBranchSnapshot
    );
  }

  /** Researches the goal itself from the topic, with no Planner question in between. */
  private async researchFromTopic(
    mapPath: string,
    map: MapDocument,
    parentNode: MapNode,
    model: string,
    reasoning: unknown,
    signal?: AbortSignal
  ): Promise<PlannerQuestionResult> {
    const topic = await this.repository.readNote(parentNode.path);
    const branch = await this.persist(() =>
      this.runs.createAnswerBranch(mapPath, {
        requestId: `initial-${parentNode.id}`,
        questionNodeId: parentNode.id,
        parentBranchId: null,
        answerSnapshot: { selections: [], freeText: "" },
        inputSnapshot: { topic: map.title, conditions: {}, upstreamResults: [] }
      })
    );
    const outcome = await this.runSubtopicWorkflow(
      mapPath,
      branch.id,
      topic,
      topic,
      [],
      "",
      "",
      model,
      reasoning,
      signal
    );
    return { status: "no-question", outcome };
  }

  private async saveManualQuestion(
    mapPath: string,
    parentNodeId: string,
    parentBranchId: string | null,
    requestId: string,
    model: string,
    reasoning: "low" | "medium" | "high",
    questionText: string,
    plannerDetail: string,
    labels: string[],
    prompt: string,
    signal?: AbortSignal,
    expectedResultBranchSnapshot?: string
  ): Promise<PlannerQuestionResult> {
    throwIfAborted(signal);
    const map = await this.repository.readMap(mapPath),
      language = this.languageOf(map);
    if (!map.aim || !map.nodes.some(node => node.id === parentNodeId))
      throw new Error("The Manual question parent is no longer available.");
    if (
      parentBranchId &&
      !map.aim.branches.some(
        branch => branch.id === parentBranchId && branch.results.some(result => result.nodeId === parentNodeId)
      )
    )
      throw new Error("A follow-up Manual question must attach to a saved result in its answer branch.");
    const matchesExpectedResultBranch = (document: MapDocument): boolean => {
      if (expectedResultBranchSnapshot === undefined || !parentBranchId) return true;
      const branch = document.aim?.branches.find(item => item.id === parentBranchId);
      if (!branch) return false;
      const current = JSON.stringify({
        inputSnapshot: branch.inputSnapshot,
        results: branch.results.map(({ nodeId, version }) => ({ nodeId, version }))
      });
      return current === expectedResultBranchSnapshot;
    };
    if (!matchesExpectedResultBranch(map))
      throw new Error(
        "The saved answer or research changed while Planner was creating a new question; refresh the result and try again."
      );
    const options = labels.map(label => ({ id: this.id(), label }));
    options.push({
      id: AIM_UNKNOWN_OPTION_ID,
      label: translateNote(language, "note.aim_unknown_option")
    });
    const noteTitle = translateNote(language, "note.aim_question_title_0", questionText);
    const notePath = this.repository.unique(this.repository.topicFolder(mapPath, "Notes"), noteTitle);
    const questionNodeId = this.id();
    const detail = [
      plannerDetail.trim(),
      translateNote(language, "note.aim_answer_options_heading"),
      ...options.map(option => `- ${option.label}`),
      translateNote(language, "note.aim_answer_hint")
    ]
      .filter(Boolean)
      .join("\n\n");
    const draft: AimQuestionDraft = {
      requestId,
      nodeId: questionNodeId,
      parentId: parentNodeId,
      parentBranchId,
      notePath,
      title: noteTitle,
      summary: questionText,
      detail,
      prompt,
      model,
      reasoning,
      options
    };
    const latest = await this.repository.readMap(mapPath);
    throwIfAborted(signal);
    if (latest.nodes.some(node => node.id === questionNodeId) || latest.nodes.every(node => node.id !== parentNodeId))
      throw new Error("The question parent changed while Planner was running; the generated question was not saved.");
    if (!latest.aim) throw new Error("AIM map data is missing.");
    if (latest.aim.questionDraft) throw new Error("Another Planner question was saved while this turn was running.");
    const committedQuestionId = await this.persist(async () => {
      throwIfAborted(signal);
      const current = await this.repository.readMap(mapPath);
      throwIfAborted(signal);
      if (!current.aim) throw new Error("AIM map data is missing.");
      if (!matchesExpectedResultBranch(current))
        throw new Error(
          "The saved answer or research changed while Planner was creating a new question; refresh the result and try again."
        );
      const concurrentlyCommitted = current.nodes.find(node => node.aimQuestion?.requestId === requestId);
      if (concurrentlyCommitted?.aimQuestion) {
        if (
          concurrentlyCommitted.parentId !== parentNodeId ||
          (concurrentlyCommitted.aimQuestion.parentBranchId ?? null) !== parentBranchId
        )
          throw new Error("This Planner question identity was concurrently used for another parent node or branch.");
        return concurrentlyCommitted.id;
      }
      if (current.aim.questionDraft) throw new Error("Another Planner question was saved while this turn was running.");
      current.aim.questionDraft = draft;
      await this.repository.saveMap(mapPath, current);
      await this.commitQuestionDraft(mapPath, current, draft);
      return questionNodeId;
    });
    const saved = await this.repository.readMap(mapPath),
      node = saved.nodes.find(item => item.id === committedQuestionId);
    if (!node) throw new Error("Planner question was not committed to the Map.");
    return { status: "question", node, options };
  }

  /**
   * Corrects one assumption of a saved conclusion. The assumption becomes an answered question under the conclusion,
   * so the next round reuses evidence that still holds and rewrites the document with the user's real situation.
   */
  async correctAssumption(
    mapPath: string,
    conclusionNodeId: string,
    assumption: string,
    correction: string,
    model: string,
    reasoning: unknown,
    signal?: AbortSignal
  ): Promise<ManualResearchResult> {
    const map = await this.repository.readMap(mapPath);
    const branch = map.aim?.branches.find(item =>
      item.results.some(result => result.nodeId === conclusionNodeId && result.kind === "conclusion")
    );
    if (!branch) throw new Error("Only a saved AIM conclusion can have its assumptions corrected.");
    if (!assumption.trim() || !correction.trim()) throw new Error("Choose an assumption and describe your situation.");
    const level = normalizeReasoningLevel(reasoning);
    const planned = await this.saveManualQuestion(
      mapPath,
      conclusionNodeId,
      branch.id,
      `assumption-${this.id()}`,
      model,
      level === "medium" || level === "high" ? level : "low",
      assumption.trim(),
      "",
      [translateNote(this.languageOf(map), "note.aim_assumption_corrected")],
      "",
      signal
    );
    if (planned.status !== "question") throw new Error("The assumption could not be saved as a question.");
    return this.answerAndResearch(
      mapPath,
      planned.node.id,
      {
        requestId: `assumption-answer-${planned.node.id}`,
        selections: [planned.options[0].id],
        freeText: correction.trim()
      },
      model,
      reasoning,
      signal
    );
  }

  /**
   * Changes the direction of a run, during it or after its document: the user's new focus becomes an answered
   * question (titled by that focus) on a new route after what is already saved, so finished research is reused and
   * the earlier document stays.
   */
  async steer(
    mapPath: string,
    from: { nodeId?: string | null; branchId?: string | null },
    direction: string,
    model: string,
    reasoning: unknown,
    signal?: AbortSignal
  ): Promise<ManualResearchResult> {
    if (!direction.trim()) throw new Error("Describe the direction to research.");
    const map = await this.repository.readMap(mapPath);
    const anchor = this.steerAnchor(map, from);
    const level = normalizeReasoningLevel(reasoning);
    const planned = await this.saveManualQuestion(
      mapPath,
      anchor.nodeId,
      anchor.branchId,
      `steer-${this.id()}`,
      model,
      level === "medium" || level === "high" ? level : "low",
      direction.trim(),
      "",
      [translateNote(this.languageOf(map), "note.aim_steer_answer")],
      "",
      signal
    );
    if (planned.status !== "question") throw new Error("The new direction could not be saved as a question.");
    return this.answerAndResearch(
      mapPath,
      planned.node.id,
      { requestId: `steer-answer-${planned.node.id}`, selections: [planned.options[0].id], freeText: direction.trim() },
      model,
      reasoning,
      signal
    );
  }

  /** Where a new direction attaches: the chosen saved result, else the latest saved result of the run, else its start. */
  private steerAnchor(
    map: MapDocument,
    from: { nodeId?: string | null; branchId?: string | null }
  ): { nodeId: string; branchId: string | null } {
    const branches = map.aim?.branches ?? [];
    const topic =
      map.nodes.find(node => node.aimKind === "topic" && !node.parentId) ??
      map.nodes.find(node => node.aimKind === "topic");
    if (!topic) throw new Error("This AIM map has no topic to change direction from.");
    const owning = from.nodeId
      ? branches.find(branch => branch.results.some(result => result.nodeId === from.nodeId))
      : undefined;
    if (owning && from.nodeId) return { nodeId: from.nodeId, branchId: owning.id };
    let branch =
      branches.find(item => item.id === from.branchId) ??
      (from.nodeId ? [...branches].reverse().find(item => item.questionNodeId === from.nodeId) : undefined);
    while (branch) {
      const latest = branch.results.at(-1);
      if (latest) return { nodeId: latest.nodeId, branchId: branch.id };
      // Nothing saved on this route yet: start from where it began.
      const parentBranchId = branch.parentBranchId;
      branch = parentBranchId ? branches.find(item => item.id === parentBranchId) : undefined;
    }
    return { nodeId: topic.id, branchId: null };
  }

  async answerAndResearch(
    mapPath: string,
    questionNodeId: string,
    input: { requestId: string; selections: string[]; freeText: string },
    model: string,
    reasoning: unknown,
    signal?: AbortSignal,
    onBranchStarted?: (questionNodeId: string) => void | Promise<void>
  ): Promise<ManualResearchResult> {
    const key = `${mapPath}\n${input.requestId}`;
    const fingerprint = JSON.stringify({
      questionNodeId,
      selections: [...new Set(input.selections)].sort(),
      freeText: input.freeText.trim(),
      model,
      reasoning
    });
    const existing = this.answerRuns.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error("This answer submission identity is already running with different input.");
      return existing.promise;
    }
    const work = this.runAnswer(mapPath, questionNodeId, input, model, reasoning, signal, onBranchStarted).finally(() =>
      this.answerRuns.delete(key)
    );
    this.answerRuns.set(key, { fingerprint, promise: work });
    return work;
  }

  async retryAnswerResearch(
    mapPath: string,
    branchId: string,
    model: string,
    reasoning: unknown,
    signal?: AbortSignal
  ): Promise<ManualResearchResult> {
    throwIfAborted(signal);
    await this.persist(() => this.runs.recoverAnswerBranches(mapPath));
    const map = await this.repository.readMap(mapPath),
      branch = map.aim?.branches.find(item => item.id === branchId);
    if (!branch || branch.researchPlan || branch.results.length)
      throw new Error("Only an answered branch without a saved research plan can retry subtopic planning.");
    const question = map.nodes.find(node => node.id === branch.questionNodeId);
    if (!question) throw new Error("The saved answer's question is missing.");
    const topicNode =
      map.nodes.find(node => node.aimKind === "topic") ?? map.nodes.find(node => node.parentId === null);
    const topicNote = topicNode
      ? await this.repository.readNote(topicNode.path, map)
      : await this.repository.readNote(question.path, map);
    const lineage = await this.branchLineage(map, branch.parentBranchId);
    const labels =
      question.aimQuestion?.options
        .filter(option => branch.answerSnapshot.selections.includes(option.id))
        .map(option => option.label) ?? branch.answerSnapshot.selections;
    return this.runSubtopicWorkflow(
      mapPath,
      branch.id,
      await this.repository.readNote(question.path),
      topicNote,
      labels,
      branch.answerSnapshot.freeText,
      lineage.context,
      model,
      reasoning,
      signal
    );
  }

  /** Resumes a cancelled or incomplete answer branch from its immutable plan and saved reports. */
  async resumeAnswerResearch(
    mapPath: string,
    branchId: string,
    model: string,
    reasoning: unknown,
    signal?: AbortSignal
  ): Promise<ManualResearchResult> {
    throwIfAborted(signal);
    await this.persist(() => this.runs.recoverAnswerBranches(mapPath));
    const map = await this.repository.readMap(mapPath),
      branch = map.aim?.branches.find(item => item.id === branchId);
    if (!branch || (!branch.researchPlan && branch.results.length === 0))
      throw new Error("Only an answer branch with a saved research plan or report can resume.");
    const parent = map.nodes.find(node => node.id === branch.questionNodeId);
    if (!parent) throw new Error("The saved answer branch's topic or question is missing.");
    const topicNode =
      map.nodes.find(node => node.aimKind === "topic") ?? map.nodes.find(node => node.parentId === null);
    const topicNote = topicNode
      ? await this.repository.readNote(topicNode.path, map)
      : await this.repository.readNote(parent.path, map);
    const parentNote = await this.repository.readNote(parent.path, map);
    const lineage = await this.branchLineage(map, branch.parentBranchId);
    const labels =
      parent.aimQuestion?.options
        .filter(option => branch.answerSnapshot.selections.includes(option.id))
        .map(option => option.label) ?? branch.answerSnapshot.selections;
    return this.runSubtopicWorkflow(
      mapPath,
      branch.id,
      parentNote,
      topicNote,
      labels,
      branch.answerSnapshot.freeText,
      lineage.context,
      model,
      reasoning,
      signal
    );
  }

  private async runAnswer(
    mapPath: string,
    questionNodeId: string,
    input: { requestId: string; selections: string[]; freeText: string },
    model: string,
    reasoning: unknown,
    signal?: AbortSignal,
    onBranchStarted?: (questionNodeId: string) => void | Promise<void>
  ): Promise<ManualResearchResult> {
    throwIfAborted(signal);
    const map = await this.repository.readMap(mapPath),
      questionNode = map.nodes.find(node => node.id === questionNodeId),
      contract = questionNode?.aimQuestion;
    const language = this.languageOf(map);
    if (!questionNode || questionNode.aimKind !== "question" || !contract)
      throw new Error("A saved AIM Planner question is required before answering.");
    const freeText = input.freeText.trim(),
      selections = [...new Set(input.selections)].sort();
    if (!selections.length && !freeText)
      throw new Error("Choose an answer, add free text, or select Unknown / no preference.");
    const optionById = new Map(contract.options.map(option => [option.id, option]));
    const selectedOptions = selections.map(id => optionById.get(id));
    if (selectedOptions.some(option => !option))
      throw new Error("The submitted answer contains an option that was not offered by this question.");
    const answerLabels = selectedOptions.map(option => option!.label);
    if (selections.includes(AIM_UNKNOWN_OPTION_ID) && selections.length > 1)
      throw new Error("Unknown / no preference cannot be combined with another selected option.");
    const parent = await this.repository.readNote(questionNode.path, map);
    const topicNode =
      map.nodes.find(node => node.aimKind === "topic") ?? map.nodes.find(node => node.parentId === null);
    const topicNote = topicNode ? await this.repository.readNote(topicNode.path, map) : parent;
    const parentBranchId = contract.parentBranchId ?? null;
    const lineage = await this.branchLineage(map, parentBranchId);
    const inheritedBranch = parentBranchId ? map.aim?.branches.find(branch => branch.id === parentBranchId) : undefined;
    const condition =
      [answerLabels.join("; "), freeText].filter(Boolean).join(" — ") ||
      translateNote(language, "note.aim_unknown_option");
    const branch = await this.persist(() =>
      this.runs.createAnswerBranch(mapPath, {
        requestId: input.requestId,
        questionNodeId,
        parentBranchId,
        answerSnapshot: { selections, freeText },
        inputSnapshot: {
          topic: map.title,
          conditions: { ...(inheritedBranch?.inputSnapshot.conditions ?? {}), [parent.summary]: condition },
          upstreamResults: [...(inheritedBranch?.inputSnapshot.upstreamResults ?? []), ...lineage.resultRefs].filter(
            (item, index, all) =>
              all.findIndex(other => other.notePath === item.notePath && other.version === item.version) === index
          )
        }
      })
    );
    await onBranchStarted?.(branch.questionNodeId);
    let refreshed = await this.repository.readMap(mapPath),
      savedBranch = refreshed.aim?.branches.find(item => item.id === branch.id);
    const completedResult = [...(savedBranch?.results ?? [])]
      .reverse()
      .find(item => item.kind === "conclusion" || item.kind === "synthesis" || item.kind === undefined);
    if (completedResult) {
      let followup = refreshed.nodes.find(
        node => node.parentId === completedResult.nodeId && node.aimQuestion?.parentBranchId === branch.id
      );
      const result = {
        status: "committed" as const,
        resultId: completedResult.resultId,
        notePath: completedResult.notePath
      };
      const attempt = refreshed.aim?.runs
        .find(run => run.id === completedResult.runId)
        ?.attempts.find(item => item.id === completedResult.attemptId);
      if (!followup && attempt?.plannerReviews?.some(item => item.decision === "ask_user")) {
        await this.recoverPostReportQuestions(mapPath);
        refreshed = await this.repository.readMap(mapPath);
        followup = refreshed.nodes.find(
          node => node.parentId === completedResult.nodeId && node.aimQuestion?.parentBranchId === branch.id
        );
      }
      return followup
        ? { status: "waiting-user", branchId: branch.id, result, questionNodeId: followup.id }
        : attempt?.status === "partial"
          ? { status: "partial", branchId: branch.id, result: { ...result, resultStatus: "partial" as const } }
          : { status: "completed", branchId: branch.id, result };
    }
    const priorRun = refreshed.aim?.runs.find(run => run.branchId === branch.id),
      priorAttempt = priorRun?.attempts.find(item => item.id === priorRun.currentAttemptId);
    if (priorAttempt?.status === "running" || priorAttempt?.status === "saving")
      return { status: "in-progress", branchId: branch.id };
    throwIfAborted(signal);
    return this.runSubtopicWorkflow(
      mapPath,
      branch.id,
      parent,
      topicNote,
      answerLabels,
      freeText,
      lineage.context,
      model,
      reasoning,
      signal
    );
  }

  /**
   * Saved research this branch may reuse: its own lineage first, then other routes of the map (for example another
   * answer to the same question), newest first and capped. Every reuse still passes the applicability audit against
   * this branch's conditions, so research tied to a different answer is not carried over.
   */
  private async reusableResearchCandidates(map: MapDocument, branch: AimBranchRecord): Promise<ResearchCandidate[]> {
    const candidates: ResearchCandidate[] = [],
      visited = new Set<string>([branch.id]),
      lineage: AimBranchRecord[] = [];
    let next = map.aim?.branches.find(item => item.id === branch.parentBranchId);
    while (next && !visited.has(next.id)) {
      visited.add(next.id);
      lineage.push(next);
      const parentBranchId = next.parentBranchId;
      next = map.aim?.branches.find(item => item.id === parentBranchId);
    }
    const otherRoutes = [...(map.aim?.branches ?? [])].reverse().filter(item => !visited.has(item.id));
    let fromLineage = 0;
    for (const ancestor of [...lineage, ...otherRoutes]) {
      if (ancestor === otherRoutes[0]) fromLineage = candidates.length;
      if (otherRoutes.includes(ancestor) && candidates.length - fromLineage >= OTHER_ROUTE_REUSE_LIMIT) break;
      for (const result of ancestor.results.filter(item => item.kind === "research")) {
        if (
          !map.nodes.some(
            node => node.id === result.nodeId && node.path === result.notePath && node.aimKind === "research"
          )
        )
          continue;
        if (result.reuse) {
          const origin = map.aim?.branches
            .find(item => item.id === result.reuse!.sourceBranchId)
            ?.results.find(
              item =>
                item.resultId === result.reuse!.sourceResultId &&
                item.notePath === result.reuse!.sourceNotePath &&
                item.version === result.reuse!.sourceVersion
            );
          if (!origin) continue;
          try {
            if (researchContentHash(await this.repository.readNote(origin.notePath)) !== result.reuse.sourceContentHash)
              continue;
          } catch {
            continue;
          }
        }
        let note: Awaited<ReturnType<Repository["readNote"]>>;
        try {
          note = await this.repository.readNote(result.notePath);
        } catch {
          continue; /* Missing ancestor evidence cannot authorize reuse. */
        }
        if (
          !note.summary.trim() ||
          !note.detail.trim() ||
          /\bresearch status\s*:\s*(?:not searched|search failed|unavailable)\b/i.test(
            `${note.summary}\n${note.detail}`
          )
        )
          continue;
        candidates.push({
          source: {
            branchId: ancestor.id,
            resultId: result.resultId,
            notePath: result.notePath,
            version: result.version,
            contentHash: researchContentHash(note)
          },
          evidenceId: `${result.nodeId}-v${result.version}`,
          title: note.title,
          summary: note.summary,
          detail: note.detail,
          conditions: { ...ancestor.inputSnapshot.conditions }
        });
        this.evidenceReports.set(`${result.nodeId}-v${result.version}`, {
          path: result.notePath,
          hash: createHash("sha256").update(note.detail).digest("hex")
        });
        if (this.evidenceReports.size > 512) {
          const oldest = [...this.evidenceReports.keys()][0];
          if (oldest) this.evidenceReports.delete(oldest);
        }
      }
    }
    return candidates;
  }

  private async verifyResearchSource(
    mapPath: string,
    branchId: string,
    target: AimResearchTarget
  ): Promise<ResearchCandidate> {
    const map = await this.repository.readMap(mapPath),
      branch = map.aim?.branches.find(item => item.id === branchId);
    if (!branch || !target.source) throw new ReuseEvidenceRejected("Research source is missing.");
    const candidate = (await this.reusableResearchCandidates(map, branch)).find(
      item =>
        item.source.branchId === target.source!.branchId &&
        item.source.resultId === target.source!.resultId &&
        item.source.notePath === target.source!.notePath &&
        item.source.version === target.source!.version
    );
    if (!candidate || candidate.source.contentHash !== target.source.contentHash)
      throw new ReuseEvidenceRejected(
        "AIM source report is missing or changed; it cannot be reused or updated from this plan."
      );
    return candidate;
  }

  private async assessReusableResearch(
    target: AimResearchTarget,
    candidate: ResearchCandidate,
    conditions: Record<string, string>,
    context: AimTaskContext,
    model: string,
    reasoning: unknown,
    signal?: AbortSignal
  ): Promise<NonNullable<AimBranchRecord["results"][number]["reuse"]>> {
    const keys = target.validity?.conditionKeys ?? [];
    const sameCondition = (key: string) =>
      Object.hasOwn(candidate.conditions, key) &&
      Object.hasOwn(conditions, key) &&
      candidate.conditions[key] === conditions[key];
    if (keys.some(key => !sameCondition(key)))
      throw new ReuseEvidenceRejected(
        "Reusable evidence no longer matches a relevant supplied condition; plan an update instead."
      );
    const checked = await this.askAimModel(
      {
        ...context,
        task: renderEvidenceReuseAuditTask({
          title: target.title,
          task: target.task,
          expectedValue: target.expectedValue,
          plannedValidity: { rationale: target.rationale, validity: target.validity },
          sourceIdentity: candidate.source,
          sourceConditions: candidate.conditions,
          currentConditions: conditions,
          currentDate: new Date().toISOString(),
          summary: candidate.summary,
          detail: candidate.detail
        }),
        researchMode: "local",
        researchDepth: "fast",
        aimContract: { kind: "reuse" },
        signal
      },
      model,
      reasoning,
      signal
    );
    const marker = checked.detail.match(/<!--\s*aim-reuse\s+([\s\S]*?)\s*-->/);
    let audit: { usable?: unknown; rationale?: unknown; conditionKeys?: unknown; validity?: unknown } | undefined;
    try {
      audit = marker ? (JSON.parse(marker[1]) as typeof audit) : undefined;
    } catch {
      throw new ReuseEvidenceRejected("The source applicability assessment was invalid.");
    }
    if (
      !audit ||
      audit.usable !== true ||
      typeof audit.rationale !== "string" ||
      !audit.rationale.trim() ||
      typeof audit.validity !== "string" ||
      !audit.validity.trim() ||
      !Array.isArray(audit.conditionKeys) ||
      audit.conditionKeys.some(key => typeof key !== "string" || !sameCondition(key))
    )
      throw new ReuseEvidenceRejected(
        "The full source report did not pass relevance, condition and freshness assessment; plan an update or new research."
      );
    const applicableConditions = Object.fromEntries(
      [...new Set([...keys, ...(audit.conditionKeys as string[])])].map(key => [key, conditions[key]])
    );
    return {
      sourceBranchId: candidate.source.branchId,
      sourceResultId: candidate.source.resultId,
      sourceNotePath: candidate.source.notePath,
      sourceVersion: candidate.source.version,
      sourceContentHash: candidate.source.contentHash,
      checkedAt: new Date().toISOString(),
      applicableConditions,
      rationale: audit.rationale,
      validityReason: audit.validity
    };
  }

  private async runSubtopicWorkflow(
    mapPath: string,
    branchId: string,
    parent: Awaited<ReturnType<Repository["readNote"]>>,
    topicNote: Awaited<ReturnType<Repository["readNote"]>>,
    answerLabels: string[],
    freeText: string,
    lineageContext: string,
    model: string,
    reasoning: unknown,
    signal?: AbortSignal
  ): Promise<ManualResearchResult> {
    try {
      return await this.executeSubtopicWorkflow(
        mapPath,
        branchId,
        parent,
        topicNote,
        answerLabels,
        freeText,
        lineageContext,
        model,
        reasoning,
        signal
      );
    } catch (error) {
      if (!signal?.aborted) {
        try {
          await this.persist(() => this.runs.saveResearchPlanError(mapPath, branchId, error));
        } catch {
          /* Preserve the original failure if diagnostics cannot be saved. */
        }
      }
      throw error;
    }
  }

  private async executeSubtopicWorkflow(
    mapPath: string,
    branchId: string,
    parent: Awaited<ReturnType<Repository["readNote"]>>,
    topicNote: Awaited<ReturnType<Repository["readNote"]>>,
    answerLabels: string[],
    freeText: string,
    lineageContext: string,
    model: string,
    reasoning: unknown,
    signal?: AbortSignal
  ): Promise<ManualResearchResult> {
    let map = await this.repository.readMap(mapPath);
    const language = this.languageOf(map);
    let branch = map.aim?.branches.find(item => item.id === branchId);
    if (!branch) throw new Error("AIM answer branch disappeared before planning its research.");
    const questionNodeId = branch.questionNodeId;
    const answerDescription =
      map.nodes.find(node => node.id === questionNodeId)?.aimKind === "topic"
        ? TOPIC_ROOT_ANSWER
        : JSON.stringify({ selectedOptions: answerLabels, freeText: freeText || null });
    const contextBase = {
      timeoutMs: branch.retryTimeoutMs,
      aimEvidenceIds: this.lineageEvidenceIds(map, branch.parentBranchId),
      title: "AIM",
      summary: "",
      rules: "",
      detail: `Known conditions: ${JSON.stringify(branch.inputSnapshot.conditions)}`,
      task: "",
      ancestors: `Original goal and background:\n${topicNote.title}\n\n${topicNote.detail}\n\nBranch lineage:\n${lineageContext || "None."}`,
      outputLanguage: language,
      ...(this.toneOf(map, language) ? { toneText: this.toneOf(map, language) } : {}),
      mode: "task" as const,
      researchMode: "local" as const,
      researchDepth: "fast" as const,
      visualMode: "off" as const,
      signal
    };
    const alreadyCommitted = await this.savedTerminalResult(mapPath, branchId);
    if (alreadyCommitted) return alreadyCommitted;
    const questionsAlreadyAsked = await this.questionHistory(map, branchId);
    // Every answer needs usable evidence; unchanged evidence may be reused after validation.
    const candidates = await this.reusableResearchCandidates(map, branch);
    const preparedReuse = new Map<string, NonNullable<AimBranchRecord["results"][number]["reuse"]>>();
    const materializeExistingEvidence = async (): Promise<AimResearchPlan> => {
      const reusable: AimResearchPlan = [],
        titles = new Set<string>();
      for (const candidate of candidates.slice(0, 5)) {
        if (titles.has(candidate.title.trim().toLowerCase())) continue;
        const target: AimResearchTarget = {
          id: `reuse-${candidate.source.resultId}`,
          title: candidate.title,
          task: `Retain supported findings relevant to ${parent.summary || topicNote.title}`,
          expectedValue: REUSE_TARGET_EXPECTED_VALUE,
          action: "reuse",
          dependsOn: [],
          source: candidate.source,
          rationale: "Planner requested no new evidence tasks",
          validity: {
            conditionKeys: [],
            reason: REUSE_TARGET_VALIDITY_REASON
          }
        };
        try {
          const assessment = await this.assessReusableResearch(
            target,
            candidate,
            branch!.inputSnapshot.conditions,
            contextBase,
            model,
            reasoning,
            signal
          );
          target.validity = {
            conditionKeys: Object.keys(assessment.applicableConditions),
            reason: assessment.validityReason
          };
          preparedReuse.set(target.id, assessment);
          reusable.push(target);
          titles.add(target.title.trim().toLowerCase());
        } catch (error) {
          if (!(error instanceof ReuseEvidenceRejected)) throw error;
        }
      }
      // An empty plan with nothing reusable still needs evidence: research the current answer instead of failing.
      if (!reusable.length)
        return validateAimResearchPlan([
          {
            id: "current-answer-evidence",
            title: parent.summary || topicNote.title,
            task: renderFallbackTargetTask(answerDescription),
            expectedValue: FALLBACK_TARGET_VALUE,
            action: "research",
            dependsOn: []
          }
        ]);
      return validateAimResearchPlan(reusable);
    };

    let plan = branch.researchPlan;
    if (!plan) {
      this.emitProgress({ kind: "stage", mapPath, branchId, stage: "research-plan" });
      const planPrompt = renderResearchPlanTask({
        reports: candidates.map(
          candidate =>
            JSON.stringify({ source: candidate.source, conditions: candidate.conditions }) +
            "\n" +
            evidenceCard(candidate.evidenceId, candidate.summary, candidate.detail)
        ),
        currentQuestion: parent.summary,
        currentAnswer: answerDescription
      });
      try {
        const planned = await this.askAimModel(
          // Planning works from the evidence indexes; full reports are not loaded here (update covers doubtful reuse).
          { ...contextBase, aimEvidenceIds: [], task: planPrompt, aimContract: { kind: "plan" } },
          model,
          reasoning,
          signal
        );
        throwIfAborted(signal);
        try {
          plan = parseAimResearchPlan(planned);
        } catch (formatError) {
          throwIfAborted(signal);
          const repairTask = renderResearchPlanRepairTask({
            planPrompt,
            currentQuestion: parent.summary,
            currentAnswer: answerDescription,
            formatError: formatError instanceof Error ? formatError.message : String(formatError),
            previousResponse: { summary: planned.summary, detail: planned.detail }
          });
          const repaired = await this.askAimModel(
            {
              ...contextBase,
              aimEvidenceIds: [],
              task: repairTask,
              aimContract: { kind: "plan" }
            },
            model,
            reasoning,
            signal
          );
          throwIfAborted(signal);
          try {
            plan = parseAimResearchPlan(repaired);
          } catch (error) {
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}\nPlanner format diagnostic: ${JSON.stringify({ initial: { detail: planned.detail.slice(0, 6000), suggestions: planned.suggestions }, repair: { detail: repaired.detail.slice(0, 6000), suggestions: repaired.suggestions } })}`
            );
          }
        }
        if (!plan.length) plan = await materializeExistingEvidence();
        await this.persist(() => this.runs.saveResearchPlan(mapPath, branchId, plan!));
      } catch (error) {
        if (!signal?.aborted) await this.persist(() => this.runs.saveResearchPlanError(mapPath, branchId, error));
        throw error;
      }
    }
    if (!plan) throw new Error("AIM research plan is missing.");
    type SubtopicReport = { subtopicId: string; nodeId: string; summary: string; detail: string; title: string };
    let executionPlan = validateAimResearchPlan(plan);
    // An empty plan can use existing evidence, but cannot skip the evidence gate.
    if (!executionPlan.length) {
      executionPlan = await materializeExistingEvidence();
      await this.persist(() => this.runs.saveResearchPlan(mapPath, branchId, executionPlan));
    }
    this.emitProgress({
      kind: "plan",
      mapPath,
      branchId,
      targets: executionPlan.map(target => ({ id: target.id, title: target.title }))
    });
    // null: that subtopic's web search failed; the round continues on the other reports.
    let scheduled: Map<string, SubtopicReport | null>;
    let searchFailure: Error | undefined;
    try {
      scheduled = await scheduleAimResearch<SubtopicReport | null>(
        executionPlan,
        async (target, predecessors, taskSignal) => {
          throwIfAborted(taskSignal);
          const currentMap = await this.repository.readMap(mapPath),
            currentBranch = currentMap.aim?.branches.find(item => item.id === branchId);
          if (!currentBranch) throw new Error("AIM answer branch disappeared during subtopic research.");
          const savedRef = currentBranch.results.find(
            item => item.subtopicId === target.id && item.kind === "research"
          );
          if (savedRef) {
            if (savedRef.reuse) {
              await this.verifyResearchSource(mapPath, branchId, {
                ...target,
                source: {
                  branchId: savedRef.reuse.sourceBranchId,
                  resultId: savedRef.reuse.sourceResultId,
                  notePath: savedRef.reuse.sourceNotePath,
                  version: savedRef.reuse.sourceVersion,
                  contentHash: savedRef.reuse.sourceContentHash
                }
              });
              if (
                Object.entries(savedRef.reuse.applicableConditions).some(
                  ([key, value]) => currentBranch.inputSnapshot.conditions[key] !== value
                )
              )
                throw new Error("The reused report no longer matches its applicable conditions.");
            }
            const note = await this.repository.readNote(savedRef.notePath);
            if (!note.summary.trim() || !note.detail.trim()) throw new Error("A saved report is no longer usable.");
            if (savedRef.reuse && researchContentHash(note) !== savedRef.reuse.sourceContentHash)
              throw new Error(
                "The copied research report changed after reuse validation; its provenance no longer matches."
              );
            this.emitProgress({ kind: "subtopic", mapPath, branchId, subtopicId: target.id, state: "done" });
            return {
              subtopicId: target.id,
              nodeId: savedRef.nodeId,
              summary: note.summary,
              detail: note.detail,
              title: target.title
            };
          }
          const handle = await this.persist(() =>
            this.runs.startAttempt(mapPath, branchId, undefined, {
              phase: target.action === "reuse" ? "subtopic-reuse" : "subtopic-research",
              subtopicId: target.id,
              model,
              reasoning: effectiveReasoningLevel(
                { ...contextBase, researchMode: this.researchMode(), researchDepth: "normal" },
                normalizeReasoningLevel(reasoning)
              ),
              maxResearchTurns: 1
            })
          );
          if (!handle.dispatch) throw new ResearchWorkflowInterrupted("in-progress");
          try {
            let reuse: NonNullable<AimBranchRecord["results"][number]["reuse"]> | undefined;
            let result: AiResult | undefined;
            let source: ResearchCandidate | undefined,
              rejectedReuse = "";
            if (target.action === "reuse" || target.action === "update") {
              try {
                source = await this.verifyResearchSource(mapPath, branchId, target);
              } catch (error) {
                if (!(error instanceof ReuseEvidenceRejected)) throw error;
                rejectedReuse = error.message;
              }
            }
            const dependencyReports = [...predecessors]
              .filter((entry): entry is [string, SubtopicReport] => entry[1] !== null)
              .map(
                ([id, report]) =>
                  `Prerequisite ${id} (${report.title}), actual completed report:\n${report.summary}\n\n${report.detail}`
              )
              .join("\n\n");
            if (target.action === "reuse" && source) {
              try {
                reuse =
                  preparedReuse.get(target.id) ??
                  (await this.assessReusableResearch(
                    target,
                    source,
                    currentBranch.inputSnapshot.conditions,
                    {
                      ...contextBase,
                      task: "",
                      detail: contextBase.detail + (dependencyReports ? `\n\n${dependencyReports}` : "")
                    },
                    model,
                    reasoning,
                    taskSignal
                  ));
                await this.verifyResearchSource(mapPath, branchId, target);
                result = { summary: source.summary, detail: source.detail, suggestions: [], visualReferences: [] };
              } catch (error) {
                if (!(error instanceof ReuseEvidenceRejected)) throw error;
                rejectedReuse = error.message;
                reuse = undefined;
                source = undefined;
              }
            }
            if (!result) {
              if (rejectedReuse) await this.persist(() => this.runs.recordPhase(mapPath, handle, "subtopic-research"));
              await this.persist(() => this.runs.recordResearchTurn(mapPath, handle));
              const task = renderSubtopicResearchTask({
                searcherTargetRule: SEARCHER_TARGET_RULE,
                title: target.title,
                task: target.task,
                expectedValue: target.expectedValue,
                currentQuestion: parent.summary,
                currentAnswer: answerDescription,
                otherSubtopics: executionPlan.filter(item => item.id !== target.id).map(item => item.title),
                dependencyReports,
                source: source
                  ? {
                      identity: source.source,
                      conditions: source.conditions,
                      summary: source.summary,
                      detail: source.detail
                    }
                  : undefined,
                currentConditions: currentBranch.inputSnapshot.conditions,
                rejectedReuse
              });
              const { diagnostic, onEvent: recordSearchEvent } = createSearchDiagnostic(1);
              const progress = (state: "searching") =>
                this.emitProgress({
                  kind: "subtopic",
                  mapPath,
                  branchId,
                  subtopicId: target.id,
                  state,
                  searches: diagnostic.completedSearchActions
                });
              const onEvent: typeof recordSearchEvent = event => {
                recordSearchEvent(event);
                progress("searching");
              };
              progress("searching");
              result = await this.askAimModel(
                {
                  ...contextBase,
                  task,
                  researchMode: this.researchMode(),
                  researchDepth: "normal",
                  aimIsolatedResearch: true,
                  signal: taskSignal
                },
                model,
                reasoning,
                taskSignal,
                onEvent
              );
              await this.persist(() => this.runs.recordSearchDiagnostic(mapPath, handle, diagnostic));
            }
            throwIfAborted(taskSignal);
            const draft = await this.persist(() =>
              this.runs.createResultDraft(mapPath, handle, target.title, model, undefined, {
                kind: "research",
                subtopicId: target.id,
                ...(reuse ? { reuse } : {})
              })
            );
            if (draft.status === "stale") throw new ResearchWorkflowInterrupted("stale");
            if (!result.summary.trim() || !result.detail.trim())
              throw new Error(`Subtopic research did not produce a usable report: ${target.title}`);
            if (
              !(await this.persist(() =>
                this.runs.updateResultDraftReport(mapPath, handle, draft.draft.id, result.summary, result.detail)
              ))
            )
              throw new ResearchWorkflowInterrupted("stale");
            if (reportedSearchFailure(result))
              throw new SubtopicSearchUnavailable(
                "The Agent explicitly says no web search succeeded; the report remains an unpublished diagnostic."
              );
            if (reuse) await this.verifyResearchSource(mapPath, branchId, target);
            const committed = await this.persist(() => {
              throwIfAborted(taskSignal);
              return this.runs.commitResult(mapPath, handle, draft.draft.id, result);
            });
            if (committed.status !== "committed") throw new ResearchWorkflowInterrupted("stale");
            const saved = await this.repository.readNote(committed.notePath);
            this.emitProgress({ kind: "subtopic", mapPath, branchId, subtopicId: target.id, state: "done" });
            return {
              subtopicId: target.id,
              nodeId: draft.draft.nodeId,
              summary: saved.summary,
              detail: saved.detail,
              title: target.title
            };
          } catch (error) {
            try {
              if (taskSignal.aborted)
                await this.persist(() =>
                  this.runs
                    .cancelAttempt(mapPath, handle, "User cancelled a AIM subtopic research turn.")
                    .then(() => undefined)
                );
              else
                await this.persist(() =>
                  this.runs
                    .failAttempt(mapPath, handle, error instanceof Error ? error.message : String(error))
                    .then(() => undefined)
                );
            } catch {
              /* Preserve the original research error. */
            }
            const searchSkipped =
              error instanceof SubtopicSearchUnavailable ||
              // Read the message without instanceof: the runtime's error may come from another realm. A subtopic
              // that ran past its time limit is skipped the same way, so one slow search cannot end the run.
              SEARCH_NOT_PERFORMED.test(String((error as { message?: unknown } | null)?.message ?? error)) ||
              aimTimedOut(String((error as { message?: unknown } | null)?.message ?? error));
            if (searchSkipped && !taskSignal.aborted) {
              this.emitProgress({ kind: "subtopic", mapPath, branchId, subtopicId: target.id, state: "skipped" });
              searchFailure = error as Error;
              return null;
            }
            throw error;
          } finally {
            this.runs.releaseAttempt(mapPath, handle);
          }
        },
        signal,
        { parallelism: this.limits.researchParallelism }
      );
    } catch (error) {
      if (error instanceof ResearchWorkflowInterrupted) return { status: error.status, branchId };
      throw error;
    }
    const reports = executionPlan
      .map(target => scheduled.get(target.id))
      .filter((report): report is SubtopicReport => !!report);
    // Every search failed: there is no evidence to review, so the round fails with the search error.
    if (!reports.length && searchFailure) throw searchFailure;
    if (!reports.length) throw new Error("AIM requires at least one usable evidence report before terminal review.");
    throwIfAborted(signal);
    map = await this.repository.readMap(mapPath);
    branch = map.aim?.branches.find(item => item.id === branchId);
    if (!branch) throw new Error("AIM answer branch disappeared before synthesis.");
    const answeredQuestionCount = this.answerCountInLineage(map, branch.id);
    const floor = this.floorFor(topicNote.detail, map);
    const explorationTarget = map.aim?.minimumAnswersBeforeConclusion ?? 2;
    const existingConclusion = [...branch.results]
      .reverse()
      .find(item => item.kind === "conclusion" || item.kind === "synthesis");
    if (existingConclusion) {
      const savedRun = map.aim?.runs.find(item => item.id === existingConclusion.runId);
      const savedAttempt = savedRun?.attempts.find(item => item.id === existingConclusion.attemptId);
      const result = {
        status: "committed" as const,
        resultId: existingConclusion.resultId,
        notePath: existingConclusion.notePath,
        ...(savedAttempt?.status === "partial" ? { resultStatus: "partial" as const } : {})
      };
      return savedAttempt?.status === "partial"
        ? { status: "partial", branchId, result }
        : { status: "completed", branchId, result };
    }
    const synthesisReasoning = effectiveReasoningLevel(
      { ...contextBase, title: topicNote.title, detailFormat: "adaptive" },
      normalizeReasoningLevel(reasoning)
    );
    const synthesisHandle = await this.persist(() =>
      this.runs.startAttempt(mapPath, branchId, undefined, {
        phase: "report-review",
        model,
        reasoning: synthesisReasoning,
        maxResearchTurns: this.limits.maxResearchTurns
      })
    );
    if (!synthesisHandle.dispatch) return { status: "in-progress", branchId };
    try {
      await this.persist(() => this.runs.recordResearchTurn(mapPath, synthesisHandle));
      const supplementalReports: {
        target: { title: string; task: string; expectedValue: string };
        summary: string;
        detail: string;
      }[] = [];
      const sourceFingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            detail: contextBase.detail,
            ancestors: contextBase.ancestors,
            language: contextBase.outputLanguage,
            goal: topicNote.detail,
            currentQuestion: parent.summary,
            answerDescription,
            reports,
            model,
            reasoning
          })
        )
        .digest("hex");
      let resumeDelivery =
        branch.deliveryRecovery?.fingerprint === sourceFingerprint ? branch.deliveryRecovery : undefined;
      let sectionRecovery = branch.deliveryRecovery;
      const initialDeliveryEvidence = [
        ...new Map(
          reports.map(report => {
            const ref = branch.results.find(item => item.nodeId === report.nodeId);
            const evidence = {
              id: ref?.reuse?.sourceResultId ?? ref?.resultId ?? report.subtopicId,
              hash: researchContentHash(report),
              detail: `## ${report.title}\n\n${report.summary}\n\n${report.detail}`
            };
            return [evidence.id, evidence] as const;
          })
        ).values()
      ];
      // Earlier rounds' results the outline can map to by their evidence-card ids; recomputed, never persisted.
      const deliveryLineage = (await this.branchLineage(map, branch.parentBranchId)).sources;
      const resumeReports = resumeDelivery?.reports;
      const deliveryEvidence = () => [
        ...(resumeDelivery?.evidence ?? initialDeliveryEvidence),
        ...supplementalReports.map(item => ({
          id: `followup-${createHash("sha256").update(JSON.stringify(item.target)).digest("hex")}`,
          hash: researchContentHash(item),
          detail: `## ${item.target.title}\n\n${item.detail}`
        }))
      ];
      const aggregateReports = () =>
        resumeReports
          ? {
              summary: [
                resumeReports.summary,
                ...supplementalReports.map(item =>
                  translateNote(language, "note.aim_followup_summary_0_1", item.target.title, item.summary)
                )
              ].join("\n"),
              detail: [
                resumeReports.detail,
                ...supplementalReports.map(
                  item =>
                    `${translateNote(language, "note.aim_followup_heading_0", item.target.title)}\n\n${item.detail}`
                )
              ].join("\n\n")
            }
          : {
              summary: [
                ...reports.map(item => `${item.title}: ${item.summary}`),
                ...supplementalReports.map(item =>
                  translateNote(language, "note.aim_followup_summary_0_1", item.target.title, item.summary)
                )
              ].join("\n"),
              detail: [
                ...reports.map(item => `## ${item.title}\n\n${item.detail}`),
                ...supplementalReports.map(
                  item =>
                    `${translateNote(language, "note.aim_followup_heading_0", item.target.title)}\n\n${item.detail}`
                )
              ].join("\n\n")
            };
      let synthesisDraftId: string | undefined;
      let finalReview: ReturnType<typeof parseAimPlannerReview> | undefined;
      let lastQualityContext: PlannerQualityContext | undefined;
      const resumeTurn = resumeDelivery?.researchTurn ?? 1;
      if (resumeTurn === 2) await this.persist(() => this.runs.recordResearchTurn(mapPath, synthesisHandle));
      for (let researchTurn = resumeTurn; researchTurn <= this.limits.maxResearchTurns; researchTurn++) {
        throwIfAborted(signal);
        const currentReports = aggregateReports();
        const plannerPrompt = renderReportReviewTask({
          plannerCoverageRule: PLANNER_COVERAGE_RULE,
          userQuestionRule: USER_QUESTION_RULE,
          floorAskRule: FLOOR_ASK_RULE,
          answeredQuestionCount,
          minimumAnswers: floor,
          explorationTarget,
          questionsAlreadyAsked,
          currentQuestion: parent.summary,
          currentAnswer: answerDescription,
          researchTurn,
          maxResearchTurns: this.limits.maxResearchTurns
        });
        const plannerContext = {
          ...contextBase,
          summary: "",
          detail: `${contextBase.detail}\n\nPersisted research reports:\n${currentReports.summary}\n\n${currentReports.detail}`,
          task: plannerPrompt,
          detailFormat: "adaptive" as const,
          aimContract: reviewContract(this.reviewDecisions(answeredQuestionCount, floor, map))
        };
        const fingerprint = sourceFingerprint;
        const savedRecovery = resumeDelivery;
        this.emitProgress({ kind: "stage", mapPath, branchId, stage: "report-review" });
        if (!savedRecovery) await this.persist(() => this.runs.recordPhase(mapPath, synthesisHandle, "report-review"));
        const synthesis = savedRecovery?.planner ?? (await this.askAimModel(plannerContext, model, reasoning, signal));
        finalReview = await this.parsePlannerReviewWithRecovery(
          synthesis,
          {
            question: topicNote.title,
            answerSnapshot: answerDescription,
            reportSummary: currentReports.summary,
            reportDetail: currentReports.detail
          },
          plannerContext,
          model,
          reasoning,
          signal
        );
        lastQualityContext = {
          goal: topicNote.title,
          goalDetail: topicNote.detail,
          unattended: this.isUnattended(map),
          outputLanguage: language,
          toneText: this.toneOf(map, language),
          conditions: branch.inputSnapshot.conditions,
          currentQuestion: parent.summary,
          currentAnswer: answerDescription,
          answeredQuestionCount,
          questionHistory: questionsAlreadyAsked,
          lineage: lineageContext,
          evidenceIds: contextBase.aimEvidenceIds,
          reportSummary: currentReports.summary,
          reportDetail: currentReports.detail,
          timeoutMs: branch.retryTimeoutMs,
          deliveryRecovery: savedRecovery ?? sectionRecovery,
          deliveryEvidence: deliveryEvidence(),
          lineageEvidence: deliveryLineage,
          setPhase: phase => this.persist(() => this.runs.recordPhase(mapPath, synthesisHandle, phase)),
          saveDeliveryRecovery: async (checkpoint, phase) => {
            if (phase) this.emitProgress({ kind: "stage", mapPath, branchId, stage: phase });
            throwIfAborted(signal);
            await this.persist(() =>
              this.runs.saveDeliveryRecovery(mapPath, synthesisHandle, {
                fingerprint,
                planner: synthesis,
                checkpoint,
                phase,
                reports: currentReports,
                researchTurn,
                evidence: deliveryEvidence()
              })
            );
          }
        };
        finalReview = await this.reviewPlannerDecisionQuality(
          finalReview,
          lastQualityContext,
          model,
          reasoning,
          signal
        );
        throwIfAborted(signal);
        // Research budget spent with a gap the review still wants searched: give the conditional answer with the gap
        // as an open item (or, below the floor, the next question) instead of stopping. A rejected final delivery is
        // not reviewed again: its written document is the answer, with the gap stated and open.
        if (researchTurn === this.limits.maxResearchTurns && this.deliveryRejections.has(finalReview))
          finalReview = this.atBudget(finalReview, language);
        else if (
          researchTurn === this.limits.maxResearchTurns &&
          finalReview.decision === "research_more" &&
          !this.deliveryRejections.has(finalReview) &&
          !this.limits.acceptGapAtBudget
        ) {
          finalReview = await this.reviewPlannerDecisionQuality(
            this.withOpenItems(finalReview, language),
            lastQualityContext,
            model,
            reasoning,
            signal
          );
          throwIfAborted(signal);
          // That conclusion is written now; if its delivery is rejected, the written document is still the answer.
          finalReview = this.atBudget(finalReview, language);
        }

        const reviewStopReason =
          finalReview.decision === "conclude"
            ? finalReview.stopReason
            : finalReview.decision === "ask_user"
              ? `Awaiting the user's answer to: ${finalReview.question}`
              : researchTurn === this.limits.maxResearchTurns
                ? `Research-turn limit reached with an unresolved evidence gap: ${finalReview.rationale}`
                : undefined;
        await this.persist(() =>
          this.runs.recordPlannerReview(
            mapPath,
            synthesisHandle,
            {
              decision: finalReview!.decision,
              rationale: finalReview!.rationale,
              researchTurn,
              ...(finalReview!.decision === "ask_user"
                ? { question: finalReview!.question, answerOptions: finalReview!.answerOptions }
                : {}),
              ...(finalReview!.decision === "research_more" ? { researchTarget: finalReview!.researchTarget } : {})
            },
            reviewStopReason
          )
        );
        if (finalReview.decision !== "research_more") break;

        if (researchTurn === this.limits.maxResearchTurns) break;
        resumeDelivery = undefined;
        sectionRecovery = undefined;
        const target = finalReview.researchTarget!;
        if (!synthesisDraftId) {
          const lastReport = reports.at(-1);
          if (!lastReport) throw new Error("AIM cannot save a follow-up without persisted initial subtopic reports.");
          const draft = await this.persist(() =>
            this.runs.createResultDraft(
              mapPath,
              synthesisHandle,
              translateNote(language, "note.aim_followup_draft"),
              model,
              undefined,
              {
                kind: "synthesis",
                parentNodeId: lastReport.nodeId,
                convergesFromNodeIds: reports.map(item => item.nodeId)
              }
            )
          );
          if (draft.status === "stale") return { status: "stale", branchId };
          synthesisDraftId = draft.draft.id;
        }
        const beforeSearch = aggregateReports();
        if (
          !(await this.persist(() =>
            this.runs.updateResultDraftReport(
              mapPath,
              synthesisHandle,
              synthesisDraftId!,
              beforeSearch.summary,
              beforeSearch.detail
            )
          ))
        )
          return { status: "stale", branchId };
        await this.persist(() => this.runs.recordResearchTurn(mapPath, synthesisHandle));
        const { diagnostic, onEvent } = createSearchDiagnostic(researchTurn + 1);
        const followupTask = renderTargetedFollowupResearchTask({
          searcherTargetRule: SEARCHER_TARGET_RULE,
          title: target.title,
          task: target.task,
          expectedValue: target.expectedValue,
          currentQuestion: parent.summary,
          currentAnswer: answerDescription
        });
        let followup: AiResult | undefined;
        this.emitProgress({ kind: "stage", mapPath, branchId, stage: "targeted-research" });
        await this.persist(() => this.runs.recordPhase(mapPath, synthesisHandle, "targeted-research"));
        try {
          followup = await this.askAimModel(
            {
              ...contextBase,
              summary: "",
              detail: `${contextBase.detail}\n\nExisting reports (context only):\n${beforeSearch.detail}`,
              task: followupTask,
              researchMode: this.researchMode(),
              researchDepth: "normal",
              aimIsolatedResearch: true
            },
            model,
            reasoning,
            signal,
            onEvent
          );
        } catch (error) {
          await this.persist(() => this.runs.recordSearchDiagnostic(mapPath, synthesisHandle, diagnostic));
          const message = String((error as { message?: unknown } | null)?.message ?? error);
          if (signal?.aborted || !(SEARCH_NOT_PERFORMED.test(message) || aimTimedOut(message))) throw error;
        }
        await this.persist(() => this.runs.recordSearchDiagnostic(mapPath, synthesisHandle, diagnostic));
        throwIfAborted(signal);
        // A follow-up search that finds nothing usable does not end the run: the gap stays open in the answer, as at
        // the research budget, and the saved subtopic reports carry the document.
        if (!followup?.summary.trim() || !followup.detail.trim() || reportedSearchFailure(followup)) {
          finalReview = this.deliveryRejections.has(finalReview)
            ? this.atBudget(finalReview, language)
            : this.atBudget(
                await this.reviewPlannerDecisionQuality(
                  this.withOpenItems(finalReview, language),
                  lastQualityContext,
                  model,
                  reasoning,
                  signal
                ),
                language
              );
          throwIfAborted(signal);
          await this.persist(() =>
            this.runs.recordPlannerReview(
              mapPath,
              synthesisHandle,
              {
                decision: finalReview!.decision,
                rationale: finalReview!.rationale,
                researchTurn: researchTurn + 1,
                ...(finalReview!.decision === "ask_user"
                  ? { question: finalReview!.question, answerOptions: finalReview!.answerOptions }
                  : {}),
                ...(finalReview!.decision === "research_more" ? { researchTarget: finalReview!.researchTarget } : {})
              },
              finalReview!.decision === "conclude"
                ? finalReview!.stopReason
                : `The follow-up search found nothing usable: ${target.title}`
            )
          );
          break;
        }
        supplementalReports.push({ target, summary: followup.summary, detail: followup.detail });
        const updatedReports = aggregateReports();
        if (
          !(await this.persist(() =>
            this.runs.updateResultDraftReport(
              mapPath,
              synthesisHandle,
              synthesisDraftId!,
              updatedReports.summary,
              updatedReports.detail
            )
          ))
        )
          return { status: "stale", branchId };
      }
      if (!finalReview) throw new Error("AIM synthesis did not produce a validated Planner decision.");
      const reportDetail = aggregateReports().detail;
      const isQuestion = finalReview.decision === "ask_user";
      const smokePublish =
        finalReview.decision === "research_more" &&
        this.limits.publishDeliveryAtBudget &&
        this.deliveryRejections.has(finalReview);
      const isPartial = finalReview.decision === "research_more" && !smokePublish;
      const lastReport = reports.at(-1);
      if (!lastReport) throw new Error("AIM cannot synthesize without persisted subtopic reports.");
      if (!synthesisDraftId) {
        const draft = await this.persist(() =>
          this.runs.createResultDraft(
            mapPath,
            synthesisHandle,
            translateNote(
              language,
              isPartial ? "note.aim_needs_followup" : isQuestion ? "note.aim_synthesis" : "note.aim_conclusion"
            ),
            model,
            undefined,
            {
              kind: isPartial || isQuestion ? "synthesis" : "conclusion",
              parentNodeId: lastReport.nodeId,
              convergesFromNodeIds: reports.map(item => item.nodeId)
            }
          )
        );
        if (draft.status === "stale") return { status: "stale", branchId };
        synthesisDraftId = draft.draft.id;
      }
      // The gap's title opens the note in the warning; the heading and the follow-up task follow.
      const partialSection =
        isPartial && finalReview.researchTarget
          ? [
              translateNote(language, "note.aim_partial_heading"),
              translateNote(language, "note.aim_pending_task_0", finalReview.researchTarget.task),
              translateNote(language, "note.aim_pending_value_0", finalReview.researchTarget.expectedValue)
            ].join("\n\n")
          : "";
      const detail = smokePublish
        ? [translateNote(language, "note.aim_smoke_publication_0", finalReview.rationale), finalReview.detail].join(
            "\n\n"
          )
        : isPartial || isQuestion
          ? this.interimDetail([
              this.interimNotice(finalReview, language),
              partialSection || translateNote(language, "note.aim_interim_result"),
              this.readerDetail(finalReview),
              translateNote(language, "note.aim_supporting_research"),
              reportDetail,
              translateNote(language, "note.aim_source_boundary"),
              translateNote(language, "note.aim_source_boundary_claims")
            ])
          : await this.concludedDetail(finalReview, {
              title: topicNote.title,
              language,
              model,
              signal,
              mapPath,
              branchId
            });
      const presentation = isPartial
        ? {
            title: translateNote(language, "note.aim_needs_followup"),
            kind: "synthesis" as const
          }
        : isQuestion
          ? {
              title: translateNote(language, "note.aim_synthesis"),
              kind: "synthesis" as const
            }
          : {
              title: translateNote(language, "note.aim_conclusion"),
              kind: "conclusion" as const
            };
      if (
        !(await this.persist(() =>
          this.runs.updateResultDraftPresentation(
            mapPath,
            synthesisHandle,
            synthesisDraftId,
            presentation.title,
            presentation.kind
          )
        ))
      )
        return { status: "stale", branchId };
      const committed = await this.persist(() => {
        throwIfAborted(signal);
        return this.runs.commitResult(
          mapPath,
          synthesisHandle,
          synthesisDraftId,
          {
            summary: isPartial
              ? translateNote(language, "note.aim_partial_summary_0", finalReview.summary)
              : finalReview.summary,
            detail
          },
          isPartial ? this.budgetExitStatus("research_more") : "completed"
        );
      });
      if (committed.status !== "committed") return { status: "stale", branchId };
      if (isQuestion) {
        const latestMap = await this.repository.readMap(mapPath),
          resultRef = latestMap.aim?.branches
            .find(item => item.id === branchId)
            ?.results.find(
              item => item.runId === synthesisHandle.runId && item.attemptId === synthesisHandle.attemptId
            );
        if (!resultRef)
          throw new Error("Planner conclusion was committed without a result reference for its follow-up question.");
        const question = await this.saveManualQuestion(
          mapPath,
          resultRef.nodeId,
          branchId,
          `post-${synthesisHandle.runId}-${synthesisHandle.attemptId}`,
          model,
          synthesisReasoning,
          finalReview.question!,
          finalReview.rationale,
          finalReview.answerOptions!,
          translateNote(language, "note.aim_followup_question_prompt"),
          signal
        );
        if (question.status !== "question")
          throw new Error("Planner requested a user condition but no follow-up question was saved.");
        return { status: "waiting-user", branchId, result: committed, questionNodeId: question.node.id };
      }
      return isPartial && this.budgetExitStatus("research_more") === "partial"
        ? { status: "partial", branchId, result: committed }
        : { status: "completed", branchId, result: committed };
    } catch (error) {
      try {
        if (signal?.aborted)
          await this.persist(() =>
            this.runs.cancelAttempt(mapPath, synthesisHandle, "User cancelled AIM synthesis.").then(() => undefined)
          );
        else
          await this.persist(() =>
            this.runs
              .failAttempt(mapPath, synthesisHandle, error instanceof Error ? error.message : String(error))
              .then(() => undefined)
          );
      } catch {
        /* Preserve the original synthesis error. */
      }
      throw error;
    } finally {
      this.runs.releaseAttempt(mapPath, synthesisHandle);
    }
  }

  private async commitQuestionDraft(mapPath: string, map: MapDocument, draft: AimQuestionDraft): Promise<void> {
    await this.repository.createNoteAt(
      draft.title,
      draft.model,
      map,
      mapPath,
      "inherited",
      draft.notePath,
      draft.nodeId,
      {
        summary: draft.summary,
        detail: draft.detail,
        prompt: draft.prompt,
        reasoning: draft.reasoning,
        contentLanguage: noteLanguageOf(this.languageOf(map))
      }
    );
    const latest = await this.repository.readMap(mapPath),
      state = latest.aim;
    if (
      !state?.questionDraft ||
      state.questionDraft.requestId !== draft.requestId ||
      state.questionDraft.nodeId !== draft.nodeId
    )
      throw new Error("The saved Planner question draft changed before commit.");
    if (!latest.nodes.some(node => node.id === draft.nodeId)) {
      const parent = latest.nodes.find(node => node.id === draft.parentId);
      if (!parent)
        throw new Error("The Planner question parent no longer exists; the question draft is retained for recovery.");
      latest.nodes.push({
        id: draft.nodeId,
        path: draft.notePath,
        parentId: draft.parentId,
        x: parent.x + 360,
        y: parent.y + 240,
        collapsed: false,
        aimKind: "question",
        aimQuestion: {
          requestId: draft.requestId,
          parentBranchId: draft.parentBranchId,
          options: draft.options,
          allowMultiple: true,
          allowFreeText: true
        }
      });
    }
    delete state.questionDraft;
    latest.aim = state;
    await this.repository.saveMap(mapPath, latest);
  }

  private lineageEvidenceIds(map: MapDocument, branchId: string | null): string[] {
    const ids: string[] = [];
    const visited = new Set<string>();
    let current = map.aim?.branches.find(branch => branch.id === branchId);
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      ids.push(...current.results.map(result => `${result.nodeId}-v${result.version}`));
      current = map.aim?.branches.find(branch => branch.id === current!.parentBranchId);
    }
    return ids;
  }

  private async branchLineage(
    map: MapDocument,
    branchId: string | null
  ): Promise<{
    context: string;
    resultRefs: { notePath: string; version: number }[];
    evidence: Awaited<ReturnType<Repository["readNote"]>>[];
    /** The same selected results as delivery sources, under the ids the evidence cards use. */
    sources: DeliveryEvidence[];
  }> {
    const data = map.aim;
    if (!branchId || !data) return { context: "", resultRefs: [], evidence: [], sources: [] };
    const chain = [] as typeof data.branches;
    let current = data.branches.find(branch => branch.id === branchId);
    while (current) {
      chain.unshift(current);
      current = current.parentBranchId
        ? data.branches.find(branch => branch.id === current!.parentBranchId)
        : undefined;
    }
    const sections: string[] = [],
      resultRefs: { notePath: string; version: number }[] = [],
      evidence: Awaited<ReturnType<Repository["readNote"]>>[] = [],
      sources: DeliveryEvidence[] = [];
    for (const branch of chain) {
      const question = map.nodes.find(node => node.id === branch.questionNodeId);
      const questionNote = question ? await this.repository.readNote(question.path) : undefined;
      const choices =
        question?.aimQuestion?.options
          .filter(option => branch.answerSnapshot.selections.includes(option.id))
          .map(option => option.label) ?? branch.answerSnapshot.selections;
      if (question?.aimKind === "question")
        sections.push(
          `User answer to ${questionNote?.summary ?? "question"}: ${JSON.stringify({ selections: choices, freeText: branch.answerSnapshot.freeText || null })}`
        );
      const saved = (
        await Promise.all(
          branch.results.map(async result => {
            try {
              return { result, note: await this.repository.readNote(result.notePath) };
            } catch (error) {
              if (result.kind !== "research") throw error;
              sections.push(`Unavailable saved research source (${result.notePath}); its claims cannot be reused.`);
              return undefined;
            }
          })
        )
      ).filter((item): item is NonNullable<typeof item> => item !== undefined);
      const synthesis = [...saved]
        .reverse()
        .find(item => item.result.kind === "synthesis" || item.result.kind === "conclusion");
      const selected = saved.filter(
        item =>
          item === synthesis ||
          (item.result.kind !== "synthesis" &&
            item.result.kind !== "conclusion" &&
            !synthesis?.note.detail.includes(item.note.detail))
      );
      for (const { result, note } of selected) {
        const evidenceId = `${result.nodeId}-v${result.version}`;
        this.evidenceReports.set(evidenceId, {
          path: result.notePath,
          hash: createHash("sha256").update(note.detail).digest("hex")
        });
        if (this.evidenceReports.size > 512) {
          const oldest = [...this.evidenceReports.keys()][0];
          if (oldest) this.evidenceReports.delete(oldest);
        }
        sections.push(
          `Saved research result v${result.version} (${note.title}):\n${evidenceCard(evidenceId, note.summary, note.detail)}`
        );
        evidence.push(note);
        sources.push({
          id: evidenceId,
          hash: createHash("sha256").update(note.detail).digest("hex"),
          detail: `## ${note.title}\n\n${note.summary}\n\n${note.detail}`
        });
      }
      for (const { result } of saved) resultRefs.push({ notePath: result.notePath, version: result.version });
    }
    return { context: sections.join("\n\n"), resultRefs, evidence, sources };
  }

  private async questionHistory(map: MapDocument, branchId: string | null): Promise<string[]> {
    const branches = map.aim?.branches;
    if (!branches || !branchId) return [];
    const chain = [] as typeof branches;
    let current = branches.find(branch => branch.id === branchId);
    while (current) {
      chain.unshift(current);
      current = current.parentBranchId ? branches.find(branch => branch.id === current!.parentBranchId) : undefined;
    }
    const questions: string[] = [];
    for (const branch of chain) {
      const node = map.nodes.find(item => item.id === branch.questionNodeId);
      if (node?.aimKind === "question") questions.push((await this.repository.readNote(node.path)).summary);
    }
    return questions;
  }
}
