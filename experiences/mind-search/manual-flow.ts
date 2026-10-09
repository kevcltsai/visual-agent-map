import { evidenceCard, EVIDENCE_LOOKUP_RULE } from "./evidence-context";
import { deduplicateMindSearchRequest } from "./request-context";
import { buildFinalDelivery } from "./final-delivery";
import { createHash, randomUUID } from "node:crypto";
import type { AiResult, TaskContext } from "../../ai/types";
import type { MapDocument, MapNode, MindSearchBranchRecord, MindSearchQuestionDraft } from "../../map-model";
import type { Repository } from "../../repository";
import { MindSearchRunStore, type CommitResult } from "../../mindsearch-mve/research-run-store";
import type { CodexWebSearchEvent } from "../../ai/runtime/codex-app-server";
import { effectiveReasoningLevel, normalizeReasoningLevel } from "../../ai/task-policy";
import { estimateTokens } from "../../ai/context-builder";
import { MINDSEARCH_MAX_RESEARCH_TURNS, parseMindSearchPlannerReview, parseMindSearchPlannerReviewWithRecovery, type PlannerReviewRecoveryContext } from "../../mindsearch-mve/planner-review";
import { extractMindSearchFailedReport } from "./retry-targets";

export const MINDSEARCH_UNKNOWN_OPTION_ID = "__mindsearch_unknown__";
export const MINDSEARCH_NO_QUESTION = "__MINDSEARCH_NO_QUESTION__";
export const MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION = 3;
const PLANNER_COVERAGE_RULE = "Before deciding, compare the original topic and current question with the requested outcome and every persisted report. Name the central outcome(s) the user needs, then mark each answered or still open. A relevant side fact does not answer a missing core outcome. If a core outcome is open and one targeted search could plausibly help, choose research_more for that exact gap. Ask_user only for missing user conditions, not missing evidence. If a core outcome remains open at the research-turn limit, keep research_more so the result is saved as partial, not complete.";
const SEARCHER_TARGET_RULE = "Answer the assigned research target first. Treat prior reports and side facts as context, not as a substitute for the target. Do not repeat resolved background facts in place of the requested outcome. If the search does not support the target, say explicitly that the target remains unresolved; do not imply it was answered.";
function phaseTask(phase: string, task: string): string { return `<!-- mindsearch-phase: ${phase} -->\n${task}`; }
export function countMindSearchAnsweredQuestions(map: MapDocument, branchId: string | null): number {
  let count = 0, current = branchId ? map.mindSearch?.branches.find(branch => branch.id === branchId) : undefined;
  while (current) {
    if (map.nodes.find(node => node.id === current!.questionNodeId)?.mindSearchKind === "question") count++;
    current = current.parentBranchId ? map.mindSearch?.branches.find(branch => branch.id === current!.parentBranchId) : undefined;
  }
  return count;
}
const OUTCOME_EXPECTATION_RULE = "Use the original goal, known user conditions and outcome preferences. Resolve important contradictions before concluding. Preserve evidence attribution and uncertainty. Do only the current phase; a research report is not the final deliverable.";
function lineageWithoutRepeatedReports(lineage: string, reportDetail: string): string {
  return lineage.split(/\n\n(?=(?:User answer to |Saved research result v))/g)
    .filter(section => {
      if (!section.startsWith("Saved research result ")) return true;
      const report = section.match(/\nReport:\n([\s\S]*)$/)?.[1]?.trim();
      return !report || !reportDetail.includes(report);
    })
    .join("\n\n");
}
export type MindSearchAskModel = (context: TaskContext, model: string, reasoning?: unknown, signal?: AbortSignal, onWebSearchEvent?: (event: CodexWebSearchEvent) => void) => Promise<AiResult>;

export type PlannerQuestionResult = { status: "question"; node: MapNode; options: { id: string; label: string }[] } | { status: "no-question"; outcome?: ManualResearchResult };
export type ManualResearchResult = { status: "completed" | "partial"; branchId: string; result: CommitResult } | { status: "waiting-user"; branchId: string; result: CommitResult; questionNodeId: string } | { status: "in-progress" | "stale"; branchId: string };
export type MindSearchPersist = <T>(operation: () => Promise<T>) => Promise<T>;

type QuestionPlanEntry = {
  fingerprint: string;
  controller: AbortController;
  promise: Promise<PlannerQuestionResult>;
  subscribers: Set<symbol>;
  settled: boolean;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    throw error;
  }
}

function normalizePersistedAnswerOptions(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((option: unknown) => {
    if (typeof option === "string" && option.trim()) return [option];
    if (option && typeof option === "object" && "value" in option) {
      const value = (option as { value?: unknown }).value;
      if (typeof value === "string" && value.trim()) return [value];
    }
    return [];
  });
}

type MindSearchResearchPlan = NonNullable<MindSearchBranchRecord["researchPlan"]>;

function validateMindSearchResearchPlan(subtopics: unknown): MindSearchResearchPlan {
  if (!Array.isArray(subtopics) || subtopics.length < 2 || subtopics.length > 5 || subtopics.some(item => !item || typeof item !== "object" || ["id", "title", "task", "expectedValue"].some(key => typeof (item as Record<string, unknown>)[key] !== "string" || !(item as Record<string, string>)[key].trim()))) throw new Error("Planner must return 2–5 valid research subtopics before the answer can proceed.");
  const plan = subtopics as MindSearchResearchPlan;
  if (new Set(plan.map(item => item.id)).size !== plan.length || new Set(plan.map(item => item.title.trim().toLowerCase())).size !== plan.length) throw new Error("Planner research subtopics must have unique ids and titles.");
  return plan;
}

function parseMindSearchResearchPlan(result: Pick<AiResult, "detail" | "suggestions">): MindSearchResearchPlan {
  const marked = result.detail.match(/<!--\s*mindsearch-plan\s+([\s\S]*?)\s*-->/);
  const unmarked = marked ? null : result.detail.match(/\{\s*"subtopics"\s*:\s*\[[\s\S]*?\]\s*\}/);
  const payload = marked?.[1] ?? unmarked?.[0];
  if (payload) {
    try {
      const raw: unknown = JSON.parse(payload);
      const subtopics = raw && typeof raw === "object" ? (raw as { subtopics?: unknown }).subtopics : undefined;
      return validateMindSearchResearchPlan(subtopics);
    } catch { /* Use the provider's structured suggestions below when its detail marker is malformed. */ }
  }
  const suggestions = result.suggestions;
  if (Array.isArray(suggestions) && suggestions.length >= 2 && suggestions.length <= 5) {
    const plan = suggestions.map((item, index) => {
      const title = typeof item?.title === "string" ? item.title : "";
      const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "subtopic";
      return { id: `suggestion-${index + 1}-${slug}`, title, task: item?.task, expectedValue: item?.contribution };
    });
    return validateMindSearchResearchPlan(plan);
  }
  throw new Error("Planner must return 2–5 valid research subtopics before the answer can proceed.");
}

type PlannerReview = ReturnType<typeof parseMindSearchPlannerReview>;

type PlannerQualityContext = {
  goal: string;
  goalDetail: string;
  conditions: Record<string, string>;
  currentQuestion: string;
  currentAnswer: string;
  answeredQuestionCount: number;
  questionHistory: string[];
  lineage: string;
  reportSummary: string;
  reportDetail: string;
  evidenceIds?: readonly string[];
};

/** Connects Planner turns, explicit user answers, the existing run store, and existing VAM AI/storage services. */
export class MindSearchManualFlow {
  private readonly evidenceReports = new Map<string, { path: string; hash: string }>();
  private readonly answerRuns = new Map<string, { fingerprint: string; promise: Promise<ManualResearchResult> }>();
  private static readonly questionPlans = new Map<string, QuestionPlanEntry>();
  private static readonly continuationRuns = new Map<string, { fingerprint: string; promise: Promise<ManualResearchResult> }>();
  constructor(private readonly repository: Repository, private readonly runs: MindSearchRunStore, private readonly askModel: MindSearchAskModel, private readonly id: () => string = randomUUID, private readonly persist: MindSearchPersist = operation => operation()) {}

  async prepareClarification(topic: { title: string; detail: string; model: string; reasoning?: unknown }, signal?: AbortSignal): Promise<string[]> {
    const result = await this.askMindSearchModel({ title: topic.title, summary: "", rules: "", detail: topic.detail,
      task: phaseTask("initial-clarification", 'Identify 2–5 short questions about unknown user conditions that materially affect the original goal. Ask all necessary conditions together, not research facts. Never ask anything already stated in the topic/background/outcome contract. Do not force a quota; return an empty list if nothing is needed. Return <!-- mindsearch-intake {"questions":["question"]} --> in detail. Use the output language. Do not research or answer the goal.'),
      ancestors: "", outputLanguage: this.repository.settings.language, mode: "task", researchMode: "local", researchDepth: "fast", visualMode: "off", signal
    }, topic.model, topic.reasoning, signal);
    throwIfAborted(signal);
    const marker = result.detail.match(/<!--\s*mindsearch-intake\s+([\s\S]*?)\s*-->/);
    if (!marker) throw new Error("Could not prepare clarification questions; please try again.");
    const value: unknown = JSON.parse(marker[1]);
    const questions = (value as { questions?: unknown })?.questions;
    if (!Array.isArray(questions) || questions.length > 5 || questions.some(q => typeof q !== "string" || !q.trim())) throw new Error("Invalid clarification questions; please try again.");
    return [...new Set((questions as string[]).map(q => q.trim()))];
  }

  private async askMindSearchModel(context: TaskContext, model: string, reasoning?: unknown, signal?: AbortSignal, onWebSearchEvent?: (event: CodexWebSearchEvent) => void): Promise<AiResult> {
    const visibleEvidence = [context.task, context.detail, context.ancestors].filter((value): value is string => typeof value === "string").join("\n");
    const visibleEvidenceIds = new Set(visibleEvidence.match(/Evidence ID: ([^\s]+)/g)?.map(line => line.slice(13)) ?? []);
    const canLookupEvidence = (context.mindSearchEvidenceIds ?? []).some(id => visibleEvidenceIds.has(id));
    const sharedInstructions = [OUTCOME_EXPECTATION_RULE, ...(canLookupEvidence ? [EVIDENCE_LOOKUP_RULE] : [])].join("\n");
    const prepared = { ...context, promptProfile: "mindsearch" as const, detailFormat: "adaptive" as const, task: `${sharedInstructions}\n\n${context.task ?? ""}` };
    const task = typeof prepared.task === "string" ? prepared.task : "";
    for (const field of ["title", "summary", "rules", "detail", "ancestors"] as const) {
      const value = prepared[field];
      if (typeof value === "string" && value.trim()) {
        const escaped = JSON.stringify(value).slice(1, -1);
        if (task.includes(value.trim()) || (escaped && task.includes(escaped))) prepared[field] = "";
      }
    }
    const deduplicated = deduplicateMindSearchRequest(prepared);
    const requestTokens = [deduplicated.title, deduplicated.summary, deduplicated.rules, deduplicated.detail, deduplicated.task, deduplicated.ancestors, deduplicated.workingFindings, deduplicated.sourceContext].reduce((sum, value) => sum + estimateTokens(value), 0);
    if (requestTokens > 28_000) throw new Error(`MindSearch model request is too large (${requestTokens} estimated tokens); no goal, condition, or evidence was discarded.`);
    const result = await this.askModel(deduplicated, model, reasoning, signal, onWebSearchEvent);
    throwIfAborted(signal);
    const lookup = result.detail.match(/^\s*<!--\s*mindsearch-evidence-request\s+(\{[^\n]*\})\s*-->/);
    if (!lookup) return result;
    const payload: unknown = JSON.parse(lookup[1]);
    const ids = payload && typeof payload === "object" && "ids" in payload ? payload.ids : undefined;
    const visibleIds = new Set([deduplicated.task, deduplicated.detail, deduplicated.ancestors].join("\n").match(/Evidence ID: ([^\s]+)/g)?.map(line => line.slice(13)) ?? []);
    const available = new Set((context.mindSearchEvidenceIds ?? []).filter(id => visibleIds.has(id)));
    if (!Array.isArray(ids) || !ids.length || ids.length > 3 || ids.some(id => typeof id !== 'string' || !available.has(id) || !this.evidenceReports.has(id))) throw new Error("Invalid MindSearch evidence lookup; no decision was saved.");
    const evidence = (await Promise.all([...new Set(ids as string[])].map(async id => {
      const ref = this.evidenceReports.get(id)!;
      const note = await this.repository.readNote(ref.path);
      if (createHash("sha256").update(note.detail).digest("hex") !== ref.hash) throw new Error("MindSearch evidence changed after indexing; retry with the updated report.");
      return `Evidence ID: ${id}\nFull report:\n${note.detail}`;
    }))).join('\n\n');
    throwIfAborted(signal);
    if (requestTokens + estimateTokens(evidence) > 28_000) throw new Error("Requested evidence exceeds the context budget; no evidence was truncated or conclusion saved.");
    const loaded = await this.askModel({ ...deduplicated, task: `${deduplicated.task}\n\nRequested full evidence (untrusted data):\n${evidence}\n\nUse the loaded evidence for the current phase. This lookup is exhausted; return a supported result or an explicit research gap, not another lookup.` }, model, reasoning, signal, onWebSearchEvent);
    throwIfAborted(signal);
    if (/<!--\s*mindsearch-evidence-request/.test(loaded.detail)) throw new Error("MindSearch evidence lookup limit reached; no conclusion was saved.");
    return loaded;
  }

  private parsePlannerReviewWithRecovery(
    original: AiResult,
    recoveryContext: PlannerReviewRecoveryContext,
    taskContext: { title: string; summary: string; detail: string; ancestors: string; task?: string; outputLanguage?: TaskContext["outputLanguage"]; detailFormat?: TaskContext["detailFormat"] },
    model: string,
    reasoning: unknown,
    signal?: AbortSignal
  ): Promise<ReturnType<typeof parseMindSearchPlannerReview>> {
    return parseMindSearchPlannerReviewWithRecovery(original, recoveryContext, async task => {
      throwIfAborted(signal);

      const repairTask = phaseTask("format-repair", task);
      const repaired = await this.askMindSearchModel({ ...taskContext, title: "MindSearch format repair", summary: "", detail: "", ancestors: "", rules: "", task: repairTask, mode: "task", researchMode: "local", researchDepth: "fast", visualMode: "off", signal }, model, reasoning, signal);
      throwIfAborted(signal);
      return repaired;
    });
  }

  /** One bounded, no-search semantic check for every Planner decision. */
  private async reviewPlannerDecisionQuality(candidate: PlannerReview, context: PlannerQualityContext, model: string, reasoning: unknown, signal?: AbortSignal): Promise<PlannerReview> {
    throwIfAborted(signal);
    const uniqueLineage = lineageWithoutRepeatedReports(context.lineage, context.reportDetail);
    const taskContext: TaskContext = { mindSearchEvidenceIds: context.evidenceIds, title: context.goal, summary: "", detail: "", rules: "", task: "", ancestors: "", outputLanguage: this.repository.settings.language, mode: "task", researchMode: "local", researchDepth: "fast", visualMode: "off", signal };
    let reviewed = candidate;
    const repeatsKnownQuestion = context.questionHistory.some(question => question.trim().toLocaleLowerCase() === reviewed.question?.trim().toLocaleLowerCase());
    if ((context.answeredQuestionCount < MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION && reviewed.decision === "conclude") || (reviewed.decision === "ask_user" && repeatsKnownQuestion)) {
      throwIfAborted(signal);
      const correctionTask = [
        "Correct the candidate decision before it can be saved. This is the single bounded corrective pass; do not search and do not conclude.",
        `HARD RULE: the current answer path has ${context.answeredQuestionCount} answered question node(s), minimum for conclusion is ${MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION}. The candidate either violates that floor or repeats a known question. Return ask_user with one meaningful, decision-relevant question on a genuinely unknown dimension (constraints, goals, current skills, resources, or success criteria). No repeated known condition, no quota filler, exactly one question and 2–5 distinct answer choices.`,
        "Include the useful conditional answer as the response body, and use the standard MindSearch decision marker. If no meaningful new dimension can be asked, still do not conclude: this correction must be rejected by the caller.",
        `Original user goal: ${context.goal}\nGoal background: ${context.goalDetail}`,
        `Known branch conditions (including free text): ${JSON.stringify(context.conditions)}\nCurrent question: ${context.currentQuestion}\nCurrent answer: ${context.currentAnswer}`,
        `Earlier user questions in this path: ${JSON.stringify(context.questionHistory)}\nEarlier answers: ${uniqueLineage || "None."}`,
        `Persisted research summary:\n${context.reportSummary}\n\nPersisted research reports:\n${context.reportDetail}`,
        `Candidate to correct: ${JSON.stringify(reviewed)}`,
        'Return exactly one valid first-line marker: <!-- mindsearch-review {"decision":"ask_user","rationale":"why this new dimension matters","question":"one meaningful new question"} -->.'
      ].join("\n\n");
      const correctionContext: TaskContext = { ...taskContext, task: phaseTask("decision-quality-review", correctionTask) };
      const correctedResult = await this.askMindSearchModel(correctionContext, model, reasoning, signal);
      throwIfAborted(signal);
      reviewed = await this.parsePlannerReviewWithRecovery(
        correctedResult,
        { question: context.goal, answerSnapshot: JSON.stringify({ conditions: context.conditions, currentQuestion: context.currentQuestion, currentAnswer: context.currentAnswer }), reportSummary: context.reportSummary, reportDetail: context.reportDetail },
        correctionContext,
        model,
        reasoning,
        signal
      );
      const repeatsQuestion = context.questionHistory.some(question => question.trim().toLocaleLowerCase() === reviewed.question?.trim().toLocaleLowerCase());
      if (reviewed.decision !== "ask_user" || repeatsQuestion) throw new Error("MindSearch could not produce a compliant meaningful question below the conclusion floor; the result was not committed.");
    }
    if (reviewed.decision === "conclude") {
      const deliveryContext: TaskContext = {
        ...taskContext, title: context.goal, summary: "", task: "", ancestors: "",
        detail: `Original user goal: ${context.goal}\nUser background and requested outcome: ${context.goalDetail}\nKnown conditions: ${JSON.stringify(context.conditions)}\nCurrent answer: ${context.currentAnswer}\nEarlier answers: ${uniqueLineage}\nPrior research:\n${context.reportDetail}`
      };
      const delivery = await buildFinalDelivery(deliveryContext, step => this.askMindSearchModel(step, model, reasoning, signal));
      const final = await this.parsePlannerReviewWithRecovery(delivery.result, {
        question: context.goal, answerSnapshot: JSON.stringify(context.conditions),
        reportSummary: context.reportSummary, reportDetail: `${context.reportDetail}\n\n${delivery.evidence}`
      }, { ...deliveryContext, detail: `${deliveryContext.detail}\n\n${delivery.evidence}` }, model, reasoning, signal);
      if (final.decision === "ask_user") throw new Error("Final delivery review must complete the document or identify a research gap, not restart user clarification.");
      reviewed = final;
    }
    return reviewed;
  }

  private answerCountInLineage(map: MapDocument, branchId: string | null): number {
    return countMindSearchAnsweredQuestions(map, branchId);
  }

  private async savedTerminalResult(mapPath: string, branchId: string): Promise<ManualResearchResult | undefined> {
    const map = await this.repository.readMap(mapPath), branch = map.mindSearch?.branches.find(item => item.id === branchId);
    const resultRef = branch && [...branch.results].reverse().find(item => item.kind === "conclusion" || item.kind === "synthesis");
    if (!branch || !resultRef) return undefined;
    const attempt = map.mindSearch?.runs.find(item => item.id === resultRef.runId)?.attempts.find(item => item.id === resultRef.attemptId);
    const result: CommitResult = { status: "committed", resultId: resultRef.resultId, notePath: resultRef.notePath, ...(attempt?.status === "partial" ? { resultStatus: "partial" } : {}) };
    const question = map.nodes.find(node => node.parentId === resultRef.nodeId && node.mindSearchQuestion?.parentBranchId === branchId);
    if (question) return { status: "waiting-user", branchId, result, questionNodeId: question.id };
    return attempt?.status === "partial" ? { status: "partial", branchId, result } : { status: "completed", branchId, result };
  }

  async recoverQuestionDraft(mapPath: string): Promise<boolean> {
    const map = await this.repository.readMap(mapPath), draft = map.mindSearch?.questionDraft;
    if (!draft) return false;
    await this.persist(() => this.commitQuestionDraft(mapPath, map, draft));
    return true;
  }

  async recoverPostReportQuestions(mapPath: string): Promise<number> {
    let created = 0;
    const initial = await this.repository.readMap(mapPath);
    if (initial.mindSearch?.questionDraft) return 0;
    for (const run of initial.mindSearch?.runs ?? []) {
      const attempt = run.attempts.find(item => item.id === run.currentAttemptId);
      const review = attempt?.plannerReviews?.find(item => item.decision === "ask_user");
      if (!attempt || (attempt.status !== "completed" && attempt.status !== "partial") || !review?.question || !review.answerOptions?.length) continue;
      const latest = await this.repository.readMap(mapPath), branch = latest.mindSearch?.branches.find(item => item.id === run.branchId);
      const result = branch?.results.find(item => item.runId === run.id && item.attemptId === attempt.id);
      if (!branch || !result) continue;
      const existing = latest.nodes.some(node => node.mindSearchQuestion?.parentBranchId === branch.id && (node.parentId === result.nodeId || node.mindSearchConvergesFromNodeIds?.includes(result.nodeId)));
      if (existing) continue;
      const model = attempt.model ?? "gpt-6-luna", reasoning = attempt.reasoningLevel ?? "low";
      const answerOptions = normalizePersistedAnswerOptions(review.answerOptions);
      const saved = await this.saveManualQuestion(mapPath, result.nodeId, branch.id, `post-${run.id}-${attempt.id}`, model, reasoning, review.question, review.rationale, answerOptions, "Recovered from a persisted post-report Planner decision; do not choose the user's answer.");
      if (saved.status === "question") created++;
    }
    return created;
  }

  /** Reviews a saved diagnostic Searcher report without repeating that already completed research turn. */
  async reviewFailedAttemptReport(mapPath: string, runId: string, diagnosticNotePath: string, signal?: AbortSignal): Promise<ManualResearchResult> {
    throwIfAborted(signal);
    const map = await this.repository.readMap(mapPath), run = map.mindSearch?.runs.find(item => item.id === runId);
    const priorAttempt = run?.attempts.find(item => item.id === run.currentAttemptId);
    if (!run || !priorAttempt || priorAttempt.status !== "failed") throw new Error("A saved failed MindSearch attempt is required to review a diagnostic report.");
    const branch = map.mindSearch?.branches.find(item => item.id === run.branchId), questionNode = branch && map.nodes.find(item => item.id === branch.questionNodeId);
    if (!branch || !questionNode) throw new Error("The failed run's answer branch or question is missing.");
    const expectedFolder = this.repository.topicFolder(mapPath, "Notes");
    if (!diagnosticNotePath.startsWith(`${expectedFolder}/`)) throw new Error("The saved Searcher diagnostic must belong to this map.");
    const diagnostic = await this.repository.readNote(diagnosticNotePath);
    const isWrapped = diagnostic.detail.includes("**Status:** Diagnostic only.");
    const provenance = `**Prior attempt:** ${branch.id} / ${priorAttempt.id}; the persisted attempt remains failed.`;
    const savedReports = extractMindSearchFailedReport(diagnostic, priorAttempt);
    if (!savedReports || (isWrapped && !diagnostic.detail.includes(provenance))) throw new Error("The note is not a retained Searcher report for this failed attempt with completed-search evidence.");
    if (!isWrapped) {
      const sameOrdinalFailures = (map.mindSearch?.runs ?? []).filter(candidate => {
        const current = candidate.attempts.find(item => item.id === candidate.currentAttemptId);
        return current?.id === priorAttempt.id && current.status === "failed";
      });
      if (sameOrdinalFailures.length !== 1 || sameOrdinalFailures[0].id !== run.id) throw new Error("The native diagnostic attempt number is ambiguous across failed runs in this map.");
    }
    const parent = await this.repository.readNote(questionNode.path);
    const topicNode = map.nodes.find(node => node.mindSearchKind === "topic"), topic = topicNode ? await this.repository.readNote(topicNode.path) : parent;
    const lineage = await this.branchLineage(map, branch.parentBranchId);
    const questionHistory = await this.questionHistory(map, branch.id);
    const explorationTarget = map.mindSearch?.minimumAnswersBeforeConclusion ?? 2;
    const answeredQuestionCount = this.answerCountInLineage(map, branch.id);
    const model = diagnostic.model || priorAttempt.model || "gpt-6-luna";
    const taskDefaults: TaskContext = { title: topic.title, summary: topic.summary, rules: "", detail: topic.detail, task: "", ancestors: lineage.context, mode: "task", researchMode: "research", researchDepth: "normal", visualMode: "off", detailFormat: "adaptive" };
    const reasoning = effectiveReasoningLevel(taskDefaults, normalizeReasoningLevel(diagnostic.reasoning ?? priorAttempt.reasoningLevel ?? "low"));
    const handle = await this.persist(() => this.runs.startAttempt(mapPath, branch.id, run.id, { model, reasoning, maxResearchTurns: MINDSEARCH_MAX_RESEARCH_TURNS }));
    if (!handle.dispatch) return { status: "in-progress", branchId: branch.id };
    try {
      // The saved Searcher report is one completed research turn for this new fenced attempt.
      await this.persist(() => this.runs.recordResearchTurn(mapPath, handle));
      let reports: AiResult[] = savedReports;
      const draftResult = await this.persist(() => this.runs.createResultDraft(mapPath, handle, `${parent.summary}・回答研究`, model, reasoning));
      if (draftResult.status === "stale") return { status: "stale", branchId: branch.id };
      const draft = draftResult.draft;
      const saveReports = async (): Promise<boolean> => {
        const summary = reports.map((item, index) => `Report ${index + 1}: ${item.summary}`).join("\n");
        const detail = reports.map((item, index) => `## Searcher report ${index + 1}\n\n${item.detail}`).join("\n\n");
        return this.persist(() => this.runs.updateResultDraftReport(mapPath, handle, draft.id, summary, detail));
      };
      if (!await saveReports()) return { status: "stale", branchId: branch.id };
      const answerDescription = JSON.stringify(branch.answerSnapshot);
      let finalReview: ReturnType<typeof parseMindSearchPlannerReview> | undefined;
      for (let reviewTurn = 1; reviewTurn <= 2; reviewTurn++) {
        throwIfAborted(signal);
        const aggregate = { summary: reports.map((report, index) => `Report ${index + 1}: ${report.summary}`).join("\n"), detail: reports.map((report, index) => `## Searcher report ${index + 1}\n\n${report.detail}`).join("\n\n") };
        const plannerPrompt = [
          "You are the Planner reviewing saved Searcher reports in a Manual MindSearch branch. Return a useful conditional answer and put exactly one explicit decision in the first detail line as an HTML comment: <!-- mindsearch-review {\"decision\":\"research_more|ask_user|conclude\",\"rationale\":\"evidence-based reason\",\"stopReason\":\"why complete, for conclude only\",\"question\":\"user question, for ask_user only\"} -->. Use valid single-line JSON with only fields needed for the selected decision.",
          "Choose research_more only when one specific evidence gap could materially change the answer; add exactly one targeted suggestion with title, search task, and expected uncertainty reduction. Choose ask_user only when a material user condition is absent from all known context and cannot be handled with a conditional answer; include 2–5 choices. Treat supplied values as valid scenario conditions even when synthetic: preserve provenance, do not misattribute them as the real person's preferences, and do not ask the user to confirm test data. Otherwise conclude with the strongest honest conditional answer and its limits.",
          PLANNER_COVERAGE_RULE,
          `Hard floor: ${answeredQuestionCount} answered question node(s) on this branch path; do not conclude before ${MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION}. At the floor, the configured exploration target (${explorationTarget}) is a soft depth preference; do not require reaching 10 or add quota filler. Below the floor, ask one meaningful new question about an unknown decision-relevant dimension.`,
          "Do not search in this Planner turn. Preserve source-reported claims, inference, conditions, contradictions, and uncertainty. VAM does not independently verify sources.",
          `Original user goal: ${topic.title}\nOriginal question: ${parent.summary}\nSynthetic/actual answer snapshot (preserve provenance): ${answerDescription}\nSaved branch conditions: ${JSON.stringify(branch.inputSnapshot.conditions)}\nPrior answers and results: ${lineage.context || "none"}\nQuestions already asked: ${JSON.stringify(questionHistory)}`,
          `Persisted Searcher report(s):\n${aggregate.summary}\n\n${aggregate.detail}`
        ].join("\n\n");
        const plannerContext = { mindSearchEvidenceIds: this.lineageEvidenceIds(map, branch.parentBranchId), title: topic.title, summary: aggregate.summary, rules: "", detail: aggregate.detail, task: plannerPrompt, ancestors: `Topic: ${topic.title}\n\n${topic.detail}\n\n${lineage.context}\n\nBranch conditions: ${JSON.stringify(branch.inputSnapshot.conditions)}`, outputLanguage: this.repository.settings.language, mode: "task" as const, researchMode: "local" as const, researchDepth: "fast" as const, visualMode: "off" as const, detailFormat: "adaptive" as const, signal };
        const planner = await this.askMindSearchModel(plannerContext, model, reasoning, signal);
        throwIfAborted(signal);
        finalReview = await this.parsePlannerReviewWithRecovery(planner, { question: `${topic.title}: ${parent.summary}`, answerSnapshot: answerDescription, reportSummary: aggregate.summary, reportDetail: aggregate.detail }, { title: topic.title, summary: aggregate.summary, detail: aggregate.detail, ancestors: plannerContext.ancestors, outputLanguage: this.repository.settings.language, detailFormat: "adaptive" }, model, reasoning, signal);
        finalReview = await this.reviewPlannerDecisionQuality(finalReview, { goal: topic.title, goalDetail: topic.detail, conditions: branch.inputSnapshot.conditions, currentQuestion: parent.summary, currentAnswer: answerDescription, answeredQuestionCount, questionHistory, lineage: lineage.context, evidenceIds: this.lineageEvidenceIds(map, branch.parentBranchId), reportSummary: aggregate.summary, reportDetail: aggregate.detail }, model, reasoning, signal);
        throwIfAborted(signal);
        if (finalReview.decision !== "research_more" || reviewTurn === MINDSEARCH_MAX_RESEARCH_TURNS) {
          const stopReason = finalReview.decision === "conclude" ? finalReview.stopReason! : finalReview.decision === "ask_user" ? `Awaiting the user's answer to: ${finalReview.question}` : `One bounded follow-up was used; a material gap remains: ${finalReview.rationale}`;
          await this.persist(() => this.runs.recordPlannerReview(mapPath, handle, { decision: finalReview!.decision, rationale: finalReview!.rationale, researchTurn: reviewTurn, ...(finalReview!.decision === "ask_user" ? { question: finalReview!.question, answerOptions: finalReview!.answerOptions } : {}), ...(finalReview!.decision === "research_more" ? { researchTarget: finalReview!.researchTarget } : {}) }, stopReason));
          break;
        }
        await this.persist(() => this.runs.recordPlannerReview(mapPath, handle, { decision: "research_more", rationale: finalReview!.rationale, researchTurn: reviewTurn, researchTarget: finalReview!.researchTarget }));
        await this.persist(() => this.runs.recordResearchTurn(mapPath, handle));
        const target = finalReview.researchTarget!;
        const task = [
          "Use the built-in web search tool available in this Codex turn directly. This is one bounded Planner-directed follow-up search; no VAM-specific research tool is required. Report search status accurately and preserve source attribution and uncertainty.",
          SEARCHER_TARGET_RULE,
          `Planner follow-up target: ${target.title}\nSearch task: ${target.task}\nExpected uncertainty reduction: ${target.expectedValue}`,
          `Question: ${parent.summary}\nAnswer conditions: ${answerDescription}`,
          `Earlier saved report (unverified Agent report; context only):\n${aggregate.detail}`,
          "Return a concise useful report with findings, reasoning, sources when available, and remaining limitations. Keep the answer's synthetic provenance explicit."
        ].join("\n\n");
        const diagnosticEvents = { researchTurn: reviewTurn + 1, startedEvents: 0, completedEvents: 0, completedSearchActions: 0, otherCompletedActions: 0 };
        const onEvent = (event: CodexWebSearchEvent) => {
          const params = event.params as { item?: { action?: { type?: unknown } } } | undefined;
          const action = typeof params?.item?.action?.type === "string" ? params.item.action.type : "unknown";
          if (event.method === "item/started") diagnosticEvents.startedEvents++;
          else { diagnosticEvents.completedEvents++; if (action === "search") diagnosticEvents.completedSearchActions++; else diagnosticEvents.otherCompletedActions++; }
        };
        const followup = await this.askMindSearchModel({ title: parent.summary, summary: parent.summary, rules: "", detail: parent.detail, task, ancestors: `Topic: ${topic.title}\n\n${topic.detail}\n\nConditions: ${JSON.stringify(branch.inputSnapshot.conditions)}`, outputLanguage: this.repository.settings.language, mode: "task", researchMode: "research", researchDepth: "normal", visualMode: "off", signal }, model, reasoning, signal, onEvent);
        await this.persist(() => this.runs.recordSearchDiagnostic(mapPath, handle, diagnosticEvents));
        if (!followup.summary.trim() || !followup.detail.trim() || /^Research status:\s*(?:not searched|search failed|unavailable)\b/im.test(`${followup.summary}\n${followup.detail}`)) throw new Error("The bounded follow-up did not produce a usable searched report; the retry remains incomplete.");
        reports.push(followup);
        if (!await saveReports()) return { status: "stale", branchId: branch.id };
      }
      if (!finalReview) throw new Error("Planner review did not produce a validated decision.");
      const stopReason = finalReview.decision === "conclude" ? finalReview.stopReason! : finalReview.decision === "ask_user" ? `Awaiting the user's answer to: ${finalReview.question}` : `One bounded follow-up was used; a material gap remains: ${finalReview.rationale}`;
      const detail = finalReview.decision === "conclude" ? finalReview.detail : [finalReview.detail, `Rationale: ${finalReview.rationale}`, `Stop reason: ${stopReason}`, "## Supporting research", ...reports.map(report => report.detail), "## Source boundary", "Agent-reported sources are not independently verified by VAM."].join("\n\n");
      const presentation = finalReview.decision === "conclude" ? { title: "研究結論", kind: "conclusion" as const } : { title: finalReview.decision === "research_more" ? "研究待補查" : "研究收斂", kind: "synthesis" as const };
      if (!await this.persist(() => this.runs.updateResultDraftPresentation(mapPath, handle, draft.id, presentation.title, presentation.kind))) return { status: "stale", branchId: branch.id };
      const committed = await this.persist(() => { throwIfAborted(signal); return this.runs.commitResult(mapPath, handle, draft.id, { summary: finalReview.summary, detail }, finalReview.decision === "research_more" ? "partial" : "completed"); });
      if (committed.status !== "committed") return { status: "stale", branchId: branch.id };
      if (finalReview.decision === "ask_user") {
        const latestMap = await this.repository.readMap(mapPath), resultRef = latestMap.mindSearch?.branches.find(item => item.id === branch.id)?.results.find(item => item.runId === handle.runId && item.attemptId === handle.attemptId);
        if (!resultRef) throw new Error("Planner conclusion was committed without a result reference for its follow-up question.");
        const questionResult = await this.saveManualQuestion(mapPath, resultRef.nodeId, branch.id, `post-${handle.runId}-${handle.attemptId}`, model, reasoning, finalReview.question!, finalReview.rationale, finalReview.answerOptions!, "Follow-up selected by the persisted Planner review; do not choose the user's answer.", signal);
        if (questionResult.status !== "question") throw new Error("Planner requested a user condition but the follow-up question was not saved.");
        return { status: "waiting-user", branchId: branch.id, result: committed, questionNodeId: questionResult.node.id };
      }
      return finalReview.decision === "research_more" ? { status: "partial", branchId: branch.id, result: { ...committed, resultStatus: "partial" } } : { status: "completed", branchId: branch.id, result: committed };
    } catch (error) {
      try { if (signal?.aborted) await this.persist(() => this.runs.cancelAttempt(mapPath, handle, "User cancelled saved-report Planner review.").then(() => undefined)); else await this.persist(() => this.runs.failAttempt(mapPath, handle, error instanceof Error ? error.message : String(error)).then(() => undefined)); }
      catch (persistenceError) { if (!(persistenceError instanceof Error && persistenceError.message.includes("A saving attempt must be recovered"))) throw new AggregateError([error, persistenceError], "Planner review failed and its attempt state could not be updated."); }
      throw error;
    } finally { this.runs.releaseAttempt(mapPath, handle); }
  }

  /** Starts a new, user-invoked attempt on a saved partial branch without replacing earlier results. */
  async continuePartial(mapPath: string, runId: string, model?: string, reasoning?: unknown, signal?: AbortSignal): Promise<ManualResearchResult> {
    const key = `${mapPath}\n${runId}`, fingerprint = JSON.stringify({ model, reasoning });
    const existing = MindSearchManualFlow.continuationRuns.get(key);
    if (existing) { if (existing.fingerprint !== fingerprint) throw new Error("This partial continuation is already running with different model settings."); return existing.promise; }
    const promise = this.runPartialContinuation(mapPath, runId, model, reasoning, signal).finally(() => MindSearchManualFlow.continuationRuns.delete(key));
    MindSearchManualFlow.continuationRuns.set(key, { fingerprint, promise });
    return promise;
  }

  private async runPartialContinuation(mapPath: string, runId: string, model?: string, reasoning?: unknown, signal?: AbortSignal): Promise<ManualResearchResult> {
    throwIfAborted(signal);
    const map = await this.repository.readMap(mapPath), run = map.mindSearch?.runs.find(item => item.id === runId);
    const currentAttempt = run?.attempts.find(item => item.id === run.currentAttemptId);
    if (!run || !currentAttempt || ["running", "saving"].includes(currentAttempt.status) || !["partial", "failed", "cancelled"].includes(currentAttempt.status)) throw new Error("Only a saved partial branch without active work can be continued.");
    const priorAttempt = [...run.attempts].reverse().find(item => item.status === "partial");
    if (!priorAttempt) throw new Error("This run has no saved partial attempt to continue.");
    const branch = map.mindSearch!.branches.find(item => item.id === run.branchId), questionNode = branch && map.nodes.find(item => item.id === branch.questionNodeId);
    const priorRef = branch?.results.find(item => item.runId === run.id && item.attemptId === priorAttempt.id);
    if (!branch || !questionNode || !priorRef) throw new Error("The partial result or its answer branch is missing; it cannot be continued safely.");
    const priorNote = await this.repository.readNote(priorRef.notePath), parent = await this.repository.readNote(questionNode.path);
    const topicNode = map.nodes.find(item => item.mindSearchKind === "topic") ?? map.nodes.find(item => item.parentId === null);
    const topicNote = topicNode ? await this.repository.readNote(topicNode.path) : parent;
    const lineage = await this.branchLineage(map, branch.parentBranchId);
    const answeredQuestionCount = this.answerCountInLineage(map, branch.id);
    const explorationTarget = map.mindSearch?.minimumAnswersBeforeConclusion ?? 2;
    const questionsAlreadyAsked = await this.questionHistory(map, branch.id);
    const modelToUse = model?.trim() || priorAttempt.model || "gpt-6-luna";
    const taskDefaults: TaskContext = { title: topicNote.title, summary: topicNote.summary, rules: "", detail: topicNote.detail, task: "", ancestors: lineage.context, mode: "task", researchMode: "research", researchDepth: "normal", visualMode: "off", detailFormat: "adaptive" };
    const reasoningToUse = effectiveReasoningLevel(taskDefaults, normalizeReasoningLevel(reasoning ?? priorAttempt.reasoningLevel ?? "low"));
    const handle = await this.persist(() => this.runs.startAttempt(mapPath, branch.id, run.id, { model: modelToUse, reasoning: reasoningToUse, maxResearchTurns: MINDSEARCH_MAX_RESEARCH_TURNS }));
    if (!handle.dispatch) return { status: "in-progress", branchId: branch.id };
    try {
      let latestReview: { rationale?: string; researchTarget?: { title: string; task: string; expectedValue: string } } = priorAttempt.plannerReviews?.at(-1) ?? {};
      let report = { summary: priorNote.summary, detail: priorNote.detail };
      let draft: import("../../map-model").MindSearchResultDraftRecord | undefined;
      let review: ReturnType<typeof parseMindSearchPlannerReview> | undefined;
      let stopReason = "";
      for (let researchTurn = 1; researchTurn <= MINDSEARCH_MAX_RESEARCH_TURNS; researchTurn++) {
        throwIfAborted(signal);
        await this.persist(() => this.runs.recordResearchTurn(mapPath, handle));
        const diagnostic = { researchTurn, startedEvents: 0, completedEvents: 0, completedSearchActions: 0, otherCompletedActions: 0 };
        const onEvent = (event: CodexWebSearchEvent) => {
          const params = event.params as { item?: { action?: { type?: unknown } } } | undefined;
          const action = typeof params?.item?.action?.type === "string" ? params.item.action.type : "unknown";
          if (event.method === "item/started") diagnostic.startedEvents++;
          else { diagnostic.completedEvents++; if (action === "search") diagnostic.completedSearchActions++; else diagnostic.otherCompletedActions++; }
        };
        const task = [
          "Continue this saved partial Manual MindSearch branch. Preserve the original answer snapshot; do not change or infer the user's answer.",
          SEARCHER_TARGET_RULE,
          latestReview?.researchTarget ? `Planner-directed continuation target: ${latestReview.researchTarget.title}\nSearch instruction: ${latestReview.researchTarget.task}\nExpected uncertainty reduction: ${latestReview.researchTarget.expectedValue}` : `Planner's unresolved gap: ${latestReview?.rationale ?? priorAttempt.stopReason ?? "Continue the incomplete evidence check."}`,
          `Original user goal: ${topicNote.title}\nCurrent answered question: ${parent.summary}\nCurrent answer: ${JSON.stringify(branch.answerSnapshot)}\nAll branch conditions: ${JSON.stringify(branch.inputSnapshot.conditions)}`,
          `Earlier answer path and saved research: ${lineage.context || "None."}`,
          `Original question: ${parent.summary}`,
          `Original user answer snapshot: ${JSON.stringify(branch.answerSnapshot)}`,
          `Prior saved partial result (Agent report, Planner notes, conditions, and limits):\n${report.summary}\n\n${report.detail}`,
          "Report findings, uncertainty, contradictions, and source information when available. Do not claim VAM independently verified sources."
        ].join("\n\n");
        let searcher: AiResult;
        try {
          searcher = await this.askMindSearchModel({ mindSearchEvidenceIds: this.lineageEvidenceIds(map, branch.parentBranchId), title: topicNote.title, summary: report.summary, rules: "", detail: report.detail, task, ancestors: `Original goal: ${topicNote.title}\n\n${topicNote.detail}\n\n${lineage.context}\n\nPersisted answer branch conditions: ${JSON.stringify(branch.inputSnapshot.conditions)}`, outputLanguage: this.repository.settings.language, mode: "task", researchMode: "research", researchDepth: "normal", visualMode: "off", detailFormat: "adaptive", signal }, modelToUse, reasoningToUse, signal, onEvent);
        } catch (error) { await this.persist(() => this.runs.recordSearchDiagnostic(mapPath, handle, diagnostic)); throw error; }
        await this.persist(() => this.runs.recordSearchDiagnostic(mapPath, handle, diagnostic));
        throwIfAborted(signal);
        if (!searcher.summary.trim() || !searcher.detail.trim() || /\bresearch status\s*:\s*(?:not searched|search failed|unavailable)\b/i.test(`${searcher.summary}\n${searcher.detail}`)) throw new Error("Continuation research did not return a usable searched report.");
        report = { summary: `${report.summary}\n\nFollow-up report: ${searcher.summary}`, detail: `${report.detail}\n\n## Continuation Agent report\n\n${searcher.detail}` };
        const savedReport = await this.persist(async () => {
          throwIfAborted(signal);
          if (!draft) { const created = await this.runs.createResultDraft(mapPath, handle, `${parent.summary} · Continued research`, modelToUse, reasoningToUse); if (created.status === "stale") return false; draft = created.draft; }
          return this.runs.updateResultDraftReport(mapPath, handle, draft.id, report.summary, report.detail);
        });
        if (!savedReport) return { status: "stale", branchId: branch.id };
        const plannerPrompt = [
          "Review all evidence for the original user goal and produce a self-contained answer to that goal. Use saved user answers as conditions that personalize the result; the latest question is not the overall goal. Do not expose the internal research log as the answer. Put exactly one JSON decision in the first detail line: <!-- mindsearch-review {\"decision\":\"research_more|ask_user|conclude\",\"rationale\":\"reason\",\"stopReason\":\"why complete, for conclude only\",\"question\":\"user question, for ask_user only\"} -->.",
          PLANNER_COVERAGE_RULE,
          `Hard floor: ${answeredQuestionCount} answered question node(s) on this branch path; do not conclude before ${MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION}. At the floor, the configured exploration target (${explorationTarget}) is a soft depth preference; do not require reaching 10 or add quota filler. Below the floor, ask one meaningful new question about an unknown decision-relevant dimension. Do not repeat known conditions or prior questions. Use research_more for missing evidence. Prior questions: ${JSON.stringify(questionsAlreadyAsked)}.`,
          "Use research_more only for a specific material evidence gap, with one targeted suggestion. Use ask_user only for a material user condition that is absent from all known context and cannot be handled with a useful conditional answer; include 2–5 distinct choices as suggestions[].title (with empty task, contribution, and parentTitle), plus the exact question in the decision JSON. Treat every supplied answer as a valid condition for this branch even when its provenance is labeled synthetic or test data. Such provenance means it is not evidence of the real person's preference; it does not make the supplied scenario value unknown. Do not ask the user to confirm that a test value is real. Phrase the result conditionally and never misattribute synthetic values as the real user's preferences. Otherwise conclude with honest limitations. Do not search in this Planner turn.",
          `Original user goal: ${topicNote.title}\nCurrent answered question: ${parent.summary}\nCurrent answer: ${JSON.stringify(branch.answerSnapshot)}\nAll branch conditions: ${JSON.stringify(branch.inputSnapshot.conditions)}\nEarlier answer path: ${lineage.context || "None."}\nPersisted reports:\n${report.summary}\n\n${report.detail}`
        ].join("\n\n");
        const plannerContext = { mindSearchEvidenceIds: this.lineageEvidenceIds(map, branch.parentBranchId), title: topicNote.title, summary: report.summary, rules: "", detail: report.detail, task: plannerPrompt, ancestors: `Original goal: ${topicNote.title}\n\n${topicNote.detail}\n\n${lineage.context}\n\nConditions: ${JSON.stringify(branch.inputSnapshot.conditions)}`, outputLanguage: this.repository.settings.language, mode: "task" as const, researchMode: "local" as const, researchDepth: "fast" as const, visualMode: "off" as const, detailFormat: "adaptive" as const, signal };
        const planner = await this.askMindSearchModel(plannerContext, modelToUse, reasoningToUse, signal);
        throwIfAborted(signal);
        review = await this.parsePlannerReviewWithRecovery(planner, { question: topicNote.title, answerSnapshot: JSON.stringify(branch.answerSnapshot), reportSummary: report.summary, reportDetail: report.detail }, plannerContext, modelToUse, reasoningToUse, signal);
        review = await this.reviewPlannerDecisionQuality(review, { goal: topicNote.title, goalDetail: topicNote.detail, conditions: branch.inputSnapshot.conditions, currentQuestion: parent.summary, currentAnswer: JSON.stringify(branch.answerSnapshot), answeredQuestionCount, questionHistory: questionsAlreadyAsked, lineage: lineage.context, evidenceIds: this.lineageEvidenceIds(map, branch.parentBranchId), reportSummary: report.summary, reportDetail: report.detail }, modelToUse, reasoningToUse, signal);
        throwIfAborted(signal);
        latestReview = { rationale: review.rationale, researchTarget: review.researchTarget };
        if (review.decision === "research_more" && researchTurn < MINDSEARCH_MAX_RESEARCH_TURNS) {
          await this.persist(() => this.runs.recordPlannerReview(mapPath, handle, { decision: review!.decision, rationale: review!.rationale, researchTurn, researchTarget: review!.researchTarget })); continue;
        }
        stopReason = review.decision === "conclude" ? review.stopReason! : review.decision === "ask_user" ? `Awaiting the user's answer to: ${review.question}` : `Continuation attempt reached its prototype research-turn budget with a material gap remaining: ${review.rationale}`;
        await this.persist(() => this.runs.recordPlannerReview(mapPath, handle, { decision: review!.decision, rationale: review!.rationale, researchTurn, ...(review!.decision === "ask_user" ? { question: review!.question, answerOptions: review!.answerOptions } : {}), ...(review!.decision === "research_more" ? { researchTarget: review!.researchTarget } : {}) }, stopReason));
        break;
      }
      if (!draft || !review) throw new Error("Continuation ended without a persisted Planner decision.");
      const finalDraft = draft, finalReview = review;
      const detail = finalReview.decision === "conclude"
        ? finalReview.detail
        : [finalReview.decision === "research_more" ? "## Research status: partial / continuable" : "## Interim result", finalReview.detail, `Rationale: ${finalReview.rationale}`, `Stop reason: ${stopReason}`, "## Saved evidence", report.detail, ...(finalReview.decision === "research_more" ? [`Still open: ${finalReview.researchTarget?.title ?? finalReview.rationale}`, finalReview.researchTarget?.task ?? "A material evidence gap remains; continue with a targeted search.", "This continuation reached its attempt budget with a material gap still open; it is not complete."] : []), "## Source boundary", "Agent-reported sources were not independently verified by VAM."].join("\n\n");
      const finalKind = finalReview.decision === "conclude" ? "conclusion" as const : "synthesis" as const;
      const finalTitle = finalReview.decision === "conclude" ? "研究結論" : finalReview.decision === "research_more" ? "研究待補查" : "研究收斂";
      if (!await this.persist(() => this.runs.updateResultDraftPresentation(mapPath, handle, finalDraft.id, finalTitle, finalKind))) return { status: "stale", branchId: branch.id };
      const committed = await this.persist(() => { throwIfAborted(signal); return this.runs.commitResult(mapPath, handle, finalDraft.id, { summary: finalReview.decision === "research_more" ? `部分研究，仍待補查：${finalReview.summary}` : finalReview.summary, detail }, finalReview.decision === "research_more" ? "partial" : "completed"); });
      if (committed.status !== "committed") return { status: "stale", branchId: branch.id };
      if (review.decision === "ask_user") {
        const latest = await this.repository.readMap(mapPath), newResult = latest.mindSearch?.branches.find(item => item.id === branch.id)?.results.at(-1);
        if (!newResult) throw new Error("Continuation result was committed without a result parent for the pending question.");
        const answerOptions = normalizePersistedAnswerOptions(review.answerOptions);
        const question = await this.saveManualQuestion(mapPath, newResult.nodeId, branch.id, `post-${handle.runId}-${handle.attemptId}`, modelToUse, reasoningToUse, review.question!, review.rationale, answerOptions, "Question recovered from a persisted Planner decision; do not answer for the user.", signal);
        if (question.status !== "question") throw new Error("Continuation requested user input but no question was saved.");
        return { status: "waiting-user", branchId: branch.id, result: committed, questionNodeId: question.node.id };
      }
      return review.decision === "research_more" ? { status: "partial", branchId: branch.id, result: committed } : { status: "completed", branchId: branch.id, result: committed };
    } catch (error) {
      try { if (signal?.aborted) await this.persist(() => this.runs.cancelAttempt(mapPath, handle, "User cancelled the continuation attempt.").then(() => undefined)); else await this.persist(() => this.runs.failAttempt(mapPath, handle, error instanceof Error ? error.message : String(error)).then(() => undefined)); }
      catch (persistenceError) { if (!(persistenceError instanceof Error && persistenceError.message.includes("A saving attempt must be recovered"))) throw new AggregateError([error, persistenceError], "Continuation failed and its attempt state could not be updated."); }
      throw error;
    } finally { this.runs.releaseAttempt(mapPath, handle); }
  }

  async planNextQuestion(mapPath: string, parentNodeId: string, model: string, reasoning: unknown, requestId: string, parentBranchId: string | null = null, signal?: AbortSignal): Promise<PlannerQuestionResult> {
    throwIfAborted(signal);
    const key = `${mapPath}\n${requestId}`, fingerprint = JSON.stringify({ parentNodeId, parentBranchId, model, reasoning });
    const active = MindSearchManualFlow.questionPlans.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint) throw new Error("This Planner question identity is already running with different input.");
      return this.subscribeToQuestionPlan(key, active, signal);
    }
    const controller = new AbortController();
    const entry: QuestionPlanEntry = { fingerprint, controller, promise: Promise.resolve({ status: "no-question" }), subscribers: new Set(), settled: false };
    entry.promise = this.createPlannerQuestion(mapPath, parentNodeId, model, reasoning, requestId, parentBranchId, controller.signal).finally(() => {
      entry.settled = true;
      if (MindSearchManualFlow.questionPlans.get(key) === entry) MindSearchManualFlow.questionPlans.delete(key);
    });
    MindSearchManualFlow.questionPlans.set(key, entry);
    return this.subscribeToQuestionPlan(key, entry, signal);
  }

  private subscribeToQuestionPlan(key: string, entry: QuestionPlanEntry, signal?: AbortSignal): Promise<PlannerQuestionResult> {
    throwIfAborted(signal);
    const subscriber = Symbol("Planner request owner");
    entry.subscribers.add(subscriber);
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        entry.subscribers.delete(subscriber);
        if (!entry.settled && entry.subscribers.size === 0) {
          if (MindSearchManualFlow.questionPlans.get(key) === entry) MindSearchManualFlow.questionPlans.delete(key);
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
      entry.promise.then(value => {
        if (settled) return;
        settled = true; cleanup(); resolve(value);
      }, error => {
        if (settled) return;
        settled = true; cleanup(); reject(error instanceof Error ? error : new Error(String(error)));
      });
      if (signal?.aborted) onAbort();
    });
  }

  private async createPlannerQuestion(mapPath: string, parentNodeId: string, model: string, reasoning: unknown, requestId: string, parentBranchId: string | null, signal?: AbortSignal): Promise<PlannerQuestionResult> {
    throwIfAborted(signal);
    if (!requestId.trim()) throw new Error("Planner question request identity is required.");
    const map = await this.repository.readMap(mapPath), state = map.mindSearch;
    if (!state) throw new Error("MindSearch map data is missing.");
    const existingQuestion = map.nodes.find(node => node.mindSearchQuestion?.requestId === requestId);
    if (existingQuestion?.mindSearchQuestion) {
      if (existingQuestion.parentId !== parentNodeId || (existingQuestion.mindSearchQuestion.parentBranchId ?? null) !== parentBranchId) throw new Error("This Planner question identity was already used for another parent node or branch.");
      return { status: "question", node: existingQuestion, options: existingQuestion.mindSearchQuestion.options };
    }
    if (state.questionDraft) {
      if (state.questionDraft.requestId !== requestId) throw new Error("A previous Planner question save must be recovered before planning another question.");
      throwIfAborted(signal);
      await this.persist(() => this.commitQuestionDraft(mapPath, map, state.questionDraft!));
      const recovered = await this.repository.readMap(mapPath), node = recovered.nodes.find(item => item.id === state.questionDraft!.nodeId)!;
      return { status: "question", node, options: node.mindSearchQuestion!.options };
    }
    const parentNode = map.nodes.find(item => item.id === parentNodeId);
    if (!parentNode) throw new Error("MindSearch question parent does not exist.");
    if (parentBranchId) {
      const parentBranch = state.branches.find(branch => branch.id === parentBranchId);
      if (!parentBranch || !parentBranch.results.some(result => result.nodeId === parentNodeId)) throw new Error("A follow-up Planner question must attach to a result in its parent answer branch.");
    }
    const parent = await this.repository.readNote(parentNode.path);
    const motherNode = map.nodes.find(node => node.mindSearchKind === "topic");
    const mother = motherNode && motherNode.id !== parentNode.id ? await this.repository.readNote(motherNode.path) : parent;
    const lineage = await this.branchLineage(map, parentBranchId);
    const explorationTarget = state.minimumAnswersBeforeConclusion ?? 2;
    const answeredQuestionCount = this.answerCountInLineage(map, parentBranchId);
    const language = this.repository.settings.language;
    const prompt = phaseTask("initial-question", [
      "Plan the next Manual MindSearch interaction for this user's research. Do not answer on the user's behalf and do not search the web in this Planner turn.",
      "Decide whether one missing user condition could materially change the recommendation. Never re-ask a condition supplied in initial clarification. A question must ask for a NEW decision-relevant unknown, not restate the mother topic or known goals. Put the actual interrogative question in summary, not a background statement with the question buried in detail. If yes, return exactly one concise question in summary and 2–5 distinct answer choices in suggestions[].title. Put an empty string in each suggestion task, contribution, and parentTitle. The application will add an explicit Unknown / no preference choice and free-text input.",
      `If at least ${MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION} questions on this answer path have already been answered and no user input could materially change the next useful result, set summary exactly to ${MINDSEARCH_NO_QUESTION} and explain briefly in detail. Below that floor, ask the next meaningful new question.`,
      "Preserve uncertainty. Never select an option or infer the user's preference.",
      `Hard floor: this path has ${answeredQuestionCount} answered question node(s); do not conclude before ${MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION}. Below the floor, ask one meaningful new question about an unknown dimension such as constraints, goals, current skills, resources, or success criteria. At the floor, the configured exploration target (${explorationTarget}) remains a soft preference; do not require reaching 10 or add quota filler.`,
      `Current topic: ${JSON.stringify({ title: parent.title, summary: parent.summary, detail: parent.detail })}`,
      ...(motherNode && motherNode.id !== parentNode.id ? [`Original goal and user outcome expectations: ${JSON.stringify({ title: mother.title, detail: mother.detail })}`] : []),
      `Prior user answers and saved research in this branch lineage (preserve all conditions; do not ask again unless a material contradiction requires clarification):\n${lineage.context || "None yet."}`
    ].join("\n\n"));
    const context: TaskContext = { mindSearchEvidenceIds: this.lineageEvidenceIds(map, parentBranchId), title: parent.title, summary: parent.summary, rules: "", detail: parentNode.mindSearchKind === "topic" ? parent.detail : "", task: prompt, ancestors: lineage.context, outputLanguage: language, mode: "task", researchMode: "local", researchDepth: "fast", visualMode: "off", signal };
    throwIfAborted(signal);
    let result = await this.askMindSearchModel(context, model, reasoning, signal);
    throwIfAborted(signal);
    if (result.summary.trim() === MINDSEARCH_NO_QUESTION && answeredQuestionCount < MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION) {
      const previousQuestions = await this.questionHistory(map, parentBranchId);
      const correctionPrompt = phaseTask("initial-question", [
        "The candidate skipped user input, but this answer path has a hard minimum of three answered question nodes before conclusion. Create the next meaningful question now; do not answer the goal or search.",
        `This path currently has ${answeredQuestionCount} answered question node(s), so ask_user is mandatory until it reaches ${MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION}. Ask about one genuinely unknown, decision-relevant dimension such as constraints, goals, current skills, resources, or success criteria. No quota filler and no repeated known condition.`,
        "Return one concise question in summary and 2–5 distinct answer choices in suggestions[].title. Leave each suggestion task, contribution, and parentTitle empty. If you still cannot provide a compliant meaningful question, return the no-question marker; the caller will reject the attempt rather than conclude.",
        `Original topic: ${JSON.stringify({ title: parent.title, summary: parent.summary, detail: parent.detail })}`,
        ...(motherNode && motherNode.id !== parentNode.id ? [`Original goal and user outcome expectations: ${JSON.stringify({ title: mother.title, detail: mother.detail })}`] : []),
        `Known prior questions: ${JSON.stringify(previousQuestions)}\nPrior user answers and saved research in this branch lineage:\n${lineage.context || "None yet."}`
      ].join("\n\n"));
      result = await this.askMindSearchModel({ ...context, task: correctionPrompt }, model, reasoning, signal);
      throwIfAborted(signal);
      if (result.summary.trim() === MINDSEARCH_NO_QUESTION) throw new Error("MindSearch could not produce a meaningful question below the conclusion floor; no root conclusion was created.");
      if (previousQuestions.some(question => question.trim().toLocaleLowerCase() === result.summary.trim().toLocaleLowerCase())) throw new Error("MindSearch repeated a prior question instead of meeting the conclusion floor; no root conclusion was created.");
    }
    if (answeredQuestionCount < MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION) {
      const previousQuestions = await this.questionHistory(map, parentBranchId);
      if (previousQuestions.some(question => question.trim().toLocaleLowerCase() === result.summary.trim().toLocaleLowerCase())) throw new Error("MindSearch repeated a prior question instead of meeting the conclusion floor; no root conclusion was created.");
    }
    if (result.summary.trim() === MINDSEARCH_NO_QUESTION) {
      if (parentNode.mindSearchKind !== "topic" || parentBranchId) return { status: "no-question" };
      const topic = await this.repository.readNote(parentNode.path);
      const branch = await this.persist(() => this.runs.createAnswerBranch(mapPath, {
        requestId: `initial-${parentNode.id}`,
        questionNodeId: parentNode.id,
        parentBranchId: null,
        answerSnapshot: { selections: [], freeText: "" },
        inputSnapshot: { topic: map.title, conditions: {}, upstreamResults: [] }
      }));
      const outcome = await this.runSubtopicWorkflow(mapPath, branch.id, topic, topic, [], "", "", model, reasoning, signal);
      return { status: "no-question", outcome };
    }
    const labels = [...new Set(result.suggestions.map(item => item.title.trim()).filter(Boolean))];
    if (!result.summary.trim() || labels.length < 2 || labels.length > 5) throw new Error("Planner must return one question and 2–5 distinct answer options before it can be saved.");
    return this.saveManualQuestion(mapPath, parentNodeId, parentBranchId, requestId, model, effectiveReasoningLevel(context, normalizeReasoningLevel(reasoning)), result.summary.trim(), result.detail.trim(), labels, prompt, signal);
  }

  private async saveManualQuestion(mapPath: string, parentNodeId: string, parentBranchId: string | null, requestId: string, model: string, reasoning: "low" | "medium" | "high", questionText: string, plannerDetail: string, labels: string[], prompt: string, signal?: AbortSignal): Promise<PlannerQuestionResult> {
    throwIfAborted(signal);
    const map = await this.repository.readMap(mapPath), language = this.repository.settings.language;
    if (!map.mindSearch || !map.nodes.some(node => node.id === parentNodeId)) throw new Error("The Manual question parent is no longer available.");
    if (parentBranchId && !map.mindSearch.branches.some(branch => branch.id === parentBranchId && branch.results.some(result => result.nodeId === parentNodeId))) throw new Error("A follow-up Manual question must attach to a saved result in its answer branch.");
    const options = labels.map(label => ({ id: this.id(), label }));
    options.push({ id: MINDSEARCH_UNKNOWN_OPTION_ID, label: language === "en" ? "Unknown / no preference" : "未知／無偏好" });
    const noteTitle = language === "en" ? `Question · ${questionText}` : `問題 · ${questionText}`;
    const notePath = this.repository.unique(this.repository.topicFolder(mapPath, "Notes"), noteTitle);
    const questionNodeId = this.id();
    const detail = [plannerDetail.trim(), language === "en" ? "## Answer options" : "## 回答選項", ...options.map(option => `- ${option.label}`), language === "en" ? "Select any applicable choices, add free text, or choose Unknown / no preference." : "可複選、補充自由文字，或選擇「未知／無偏好」。"].filter(Boolean).join("\n\n");
    const draft: MindSearchQuestionDraft = { requestId, nodeId: questionNodeId, parentId: parentNodeId, parentBranchId, notePath, title: noteTitle, summary: questionText, detail, prompt, model, reasoning, options };
    const latest = await this.repository.readMap(mapPath);
    throwIfAborted(signal);
    if (latest.nodes.some(node => node.id === questionNodeId) || latest.nodes.every(node => node.id !== parentNodeId)) throw new Error("The question parent changed while Planner was running; the generated question was not saved.");
    if (!latest.mindSearch) throw new Error("MindSearch map data is missing.");
    if (latest.mindSearch.questionDraft) throw new Error("Another Planner question was saved while this turn was running.");
    const committedQuestionId = await this.persist(async () => {
      throwIfAborted(signal);
      const current = await this.repository.readMap(mapPath);
      throwIfAborted(signal);
      if (!current.mindSearch) throw new Error("MindSearch map data is missing.");
      const concurrentlyCommitted = current.nodes.find(node => node.mindSearchQuestion?.requestId === requestId);
      if (concurrentlyCommitted?.mindSearchQuestion) {
        if (concurrentlyCommitted.parentId !== parentNodeId || (concurrentlyCommitted.mindSearchQuestion.parentBranchId ?? null) !== parentBranchId) throw new Error("This Planner question identity was concurrently used for another parent node or branch.");
        return concurrentlyCommitted.id;
      }
      if (current.mindSearch.questionDraft) throw new Error("Another Planner question was saved while this turn was running.");
      current.mindSearch.questionDraft = draft; await this.repository.saveMap(mapPath, current);
      await this.commitQuestionDraft(mapPath, current, draft);
      return questionNodeId;
    });
    const saved = await this.repository.readMap(mapPath), node = saved.nodes.find(item => item.id === committedQuestionId);
    if (!node) throw new Error("Planner question was not committed to the Map.");
    return { status: "question", node, options };
  }

  async answerAndResearch(mapPath: string, questionNodeId: string, input: { requestId: string; selections: string[]; freeText: string }, model: string, reasoning: unknown, signal?: AbortSignal, onBranchStarted?: (questionNodeId: string) => void | Promise<void>): Promise<ManualResearchResult> {
    const key = `${mapPath}\n${input.requestId}`;
    const fingerprint = JSON.stringify({ questionNodeId, selections: [...new Set(input.selections)].sort(), freeText: input.freeText.trim(), model, reasoning });
    const existing = this.answerRuns.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("This answer submission identity is already running with different input.");
      return existing.promise;
    }
    const work = this.runAnswer(mapPath, questionNodeId, input, model, reasoning, signal, onBranchStarted).finally(() => this.answerRuns.delete(key));
    this.answerRuns.set(key, { fingerprint, promise: work });
    return work;
  }

  async retryAnswerResearch(mapPath: string, branchId: string, model: string, reasoning: unknown, signal?: AbortSignal): Promise<ManualResearchResult> {
    throwIfAborted(signal);
    await this.persist(() => this.runs.recoverAnswerBranches(mapPath));
    const map = await this.repository.readMap(mapPath), branch = map.mindSearch?.branches.find(item => item.id === branchId);
    if (!branch || branch.researchPlan || branch.results.length) throw new Error("Only an answered branch without a saved research plan can retry subtopic planning.");
    const question = map.nodes.find(node => node.id === branch.questionNodeId);
    if (!question) throw new Error("The saved answer's question is missing.");
    const topicNode = map.nodes.find(node => node.mindSearchKind === "topic") ?? map.nodes.find(node => node.parentId === null);
    const topicNote = topicNode ? await this.repository.readNote(topicNode.path) : await this.repository.readNote(question.path);
    const lineage = await this.branchLineage(map, branch.parentBranchId);
    const labels = question.mindSearchQuestion?.options.filter(option => branch.answerSnapshot.selections.includes(option.id)).map(option => option.label) ?? branch.answerSnapshot.selections;
    return this.runSubtopicWorkflow(mapPath, branch.id, await this.repository.readNote(question.path), topicNote, labels, branch.answerSnapshot.freeText, lineage.context, model, reasoning, signal);
  }

  /** Resumes a cancelled or incomplete answer branch from its immutable plan and saved reports. */
  async resumeAnswerResearch(mapPath: string, branchId: string, model: string, reasoning: unknown, signal?: AbortSignal): Promise<ManualResearchResult> {
    throwIfAborted(signal);
    await this.persist(() => this.runs.recoverAnswerBranches(mapPath));
    const map = await this.repository.readMap(mapPath), branch = map.mindSearch?.branches.find(item => item.id === branchId);
    if (!branch || (!branch.researchPlan && branch.results.length === 0)) throw new Error("Only an answer branch with a saved research plan or report can resume.");
    const parent = map.nodes.find(node => node.id === branch.questionNodeId);
    if (!parent) throw new Error("The saved answer branch's topic or question is missing.");
    const topicNode = map.nodes.find(node => node.mindSearchKind === "topic") ?? map.nodes.find(node => node.parentId === null);
    const topicNote = topicNode ? await this.repository.readNote(topicNode.path) : await this.repository.readNote(parent.path);
    const parentNote = await this.repository.readNote(parent.path);
    const lineage = await this.branchLineage(map, branch.parentBranchId);
    const labels = parent.mindSearchQuestion?.options.filter(option => branch.answerSnapshot.selections.includes(option.id)).map(option => option.label) ?? branch.answerSnapshot.selections;
    return this.runSubtopicWorkflow(mapPath, branch.id, parentNote, topicNote, labels, branch.answerSnapshot.freeText, lineage.context, model, reasoning, signal);
  }

  private async runAnswer(mapPath: string, questionNodeId: string, input: { requestId: string; selections: string[]; freeText: string }, model: string, reasoning: unknown, signal?: AbortSignal, onBranchStarted?: (questionNodeId: string) => void | Promise<void>): Promise<ManualResearchResult> {
    throwIfAborted(signal);
    const map = await this.repository.readMap(mapPath), questionNode = map.nodes.find(node => node.id === questionNodeId), contract = questionNode?.mindSearchQuestion;
    if (!questionNode || questionNode.mindSearchKind !== "question" || !contract) throw new Error("A saved MindSearch Planner question is required before answering.");
    const freeText = input.freeText.trim(), selections = [...new Set(input.selections)].sort();
    if (!selections.length && !freeText) throw new Error("Choose an answer, add free text, or select Unknown / no preference.");
    const optionById = new Map(contract.options.map(option => [option.id, option]));
    const selectedOptions = selections.map(id => optionById.get(id));
    if (selectedOptions.some(option => !option)) throw new Error("The submitted answer contains an option that was not offered by this question.");
    const answerLabels = selectedOptions.map(option => option!.label);
    if (selections.includes(MINDSEARCH_UNKNOWN_OPTION_ID) && selections.length > 1) throw new Error("Unknown / no preference cannot be combined with another selected option.");
    const parent = await this.repository.readNote(questionNode.path);
    const topicNode = map.nodes.find(node => node.mindSearchKind === "topic") ?? map.nodes.find(node => node.parentId === null);
    const topicNote = topicNode ? await this.repository.readNote(topicNode.path) : parent;
    const parentBranchId = contract.parentBranchId ?? null;
    const lineage = await this.branchLineage(map, parentBranchId);
    const inheritedBranch = parentBranchId ? map.mindSearch?.branches.find(branch => branch.id === parentBranchId) : undefined;
    const condition = [answerLabels.join("; "), freeText].filter(Boolean).join(" — ") || (this.repository.settings.language === "en" ? "Unknown / no preference" : "未知／無偏好");
    const branch = await this.persist(() => this.runs.createAnswerBranch(mapPath, {
      requestId: input.requestId, questionNodeId, parentBranchId,
      answerSnapshot: { selections, freeText },
      inputSnapshot: {
        topic: map.title,
        conditions: { ...(inheritedBranch?.inputSnapshot.conditions ?? {}), [parent.summary]: condition },
        upstreamResults: [...(inheritedBranch?.inputSnapshot.upstreamResults ?? []), ...lineage.resultRefs].filter((item, index, all) => all.findIndex(other => other.notePath === item.notePath && other.version === item.version) === index)
      }
    }));
    await onBranchStarted?.(branch.questionNodeId);
    let refreshed = await this.repository.readMap(mapPath), savedBranch = refreshed.mindSearch?.branches.find(item => item.id === branch.id);
    const completedResult = [...(savedBranch?.results ?? [])].reverse().find(item => item.kind === "conclusion" || item.kind === "synthesis" || item.kind === undefined);
    if (completedResult) {
      let followup = refreshed.nodes.find(node => node.parentId === completedResult.nodeId && node.mindSearchQuestion?.parentBranchId === branch.id);
      const result = { status: "committed" as const, resultId: completedResult.resultId, notePath: completedResult.notePath };
      const attempt = refreshed.mindSearch?.runs.find(run => run.id === completedResult.runId)?.attempts.find(item => item.id === completedResult.attemptId);
      if (!followup && attempt?.plannerReviews?.some(item => item.decision === "ask_user")) {
        await this.recoverPostReportQuestions(mapPath);
        refreshed = await this.repository.readMap(mapPath);
        followup = refreshed.nodes.find(node => node.parentId === completedResult.nodeId && node.mindSearchQuestion?.parentBranchId === branch.id);
      }
      return followup ? { status: "waiting-user", branchId: branch.id, result, questionNodeId: followup.id } : attempt?.status === "partial" ? { status: "partial", branchId: branch.id, result: { ...result, resultStatus: "partial" as const } } : { status: "completed", branchId: branch.id, result };
    }
    const priorRun = refreshed.mindSearch?.runs.find(run => run.branchId === branch.id), priorAttempt = priorRun?.attempts.find(item => item.id === priorRun.currentAttemptId);
    if (priorAttempt?.status === "running" || priorAttempt?.status === "saving") return { status: "in-progress", branchId: branch.id };
    throwIfAborted(signal);
    return this.runSubtopicWorkflow(mapPath, branch.id, parent, topicNote, answerLabels, freeText, lineage.context, model, reasoning, signal);
  }

  private async runSubtopicWorkflow(
    mapPath: string, branchId: string, parent: Awaited<ReturnType<Repository["readNote"]>>,
    topicNote: Awaited<ReturnType<Repository["readNote"]>>, answerLabels: string[], freeText: string, lineageContext: string,
    model: string, reasoning: unknown, signal?: AbortSignal
  ): Promise<ManualResearchResult> {
    try { return await this.executeSubtopicWorkflow(mapPath, branchId, parent, topicNote, answerLabels, freeText, lineageContext, model, reasoning, signal); }
    catch (error) {
      if (!signal?.aborted) {
        try { await this.persist(() => this.runs.saveResearchPlanError(mapPath, branchId, error)); }
        catch { /* Preserve the original failure if diagnostics cannot be saved. */ }
      }
      throw error;
    }
  }

  private async executeSubtopicWorkflow(
    mapPath: string, branchId: string, parent: Awaited<ReturnType<Repository["readNote"]>>,
    topicNote: Awaited<ReturnType<Repository["readNote"]>>, answerLabels: string[], freeText: string, lineageContext: string,
    model: string, reasoning: unknown, signal?: AbortSignal
  ): Promise<ManualResearchResult> {
    let map = await this.repository.readMap(mapPath);
    let branch = map.mindSearch?.branches.find(item => item.id === branchId);
    if (!branch) throw new Error("MindSearch answer branch disappeared before planning its research.");
    const questionNodeId = branch.questionNodeId;
    const answerDescription = map.nodes.find(node => node.id === questionNodeId)?.mindSearchKind === "topic"
      ? "No user answer was requested; use the topic context as user-supplied background only."
      : JSON.stringify({ selectedOptions: answerLabels, freeText: freeText || null });
    const contextBase = { mindSearchEvidenceIds: this.lineageEvidenceIds(map, branch.parentBranchId), title: "MindSearch", summary: "", rules: "", detail: `Known conditions: ${JSON.stringify(branch.inputSnapshot.conditions)}`, task: "", ancestors: `Original goal and background:\n${topicNote.title}\n\n${topicNote.detail}\n\nBranch lineage:\n${lineageContext || "None."}`, outputLanguage: this.repository.settings.language, mode: "task" as const, researchMode: "local" as const, researchDepth: "fast" as const, visualMode: "off" as const, signal };
    const alreadyCommitted = await this.savedTerminalResult(mapPath, branchId);
    if (alreadyCommitted) return alreadyCommitted;
    const questionsAlreadyAsked = await this.questionHistory(map, branchId);
    // Every new answer must run its own research before any terminal decision.

    let plan = branch.researchPlan;
    if (!plan) {
      const planPrompt = phaseTask("research-plan", [
        "Plan this answer's research as 2–5 distinct, complementary subtopics. Return the plan marker in detail: <!-- mindsearch-plan {\"subtopics\":[{\"id\":\"stable-short-id\",\"title\":\"visible subtopic\",\"task\":\"specific research question\",\"expectedValue\":\"what uncertainty this resolves\"}]} -->. Give each subtopic its own independently searchable research task. Do not answer the goal or do research in this Planner turn.",
        "Identify the information dimensions needed for broad coverage. Choose 2–5 relevant targets without filler; each target must investigate a distinct factor that could change the answer or its execution. Consider methods, tools or constraints, preparation or timing, and safety or quality where relevant. Avoid overlap and umbrella-only targets. For unknown conditions, cover useful alternatives instead of assuming one scenario.",
        `Current question: ${parent.summary}\nCurrent answer (preserve provenance): ${answerDescription}`
      ].join("\n\n"));
      try {
        const planned = await this.askMindSearchModel({ ...contextBase, task: planPrompt }, model, reasoning, signal);
        throwIfAborted(signal);
        try {
          plan = parseMindSearchResearchPlan(planned);
        } catch (formatError) {
          throwIfAborted(signal);
          const repairTask = [
            "The previous Planner response did not satisfy the required MindSearch research-plan format. Correct the format once using the supplied context. Do not research or add unsupported claims.",
            "Return the exact marker in detail: <!-- mindsearch-plan {\"subtopics\":[{\"id\":\"stable-short-id\",\"title\":\"visible subtopic\",\"task\":\"specific research question\",\"expectedValue\":\"what uncertainty this resolves\"}]} -->. Include 2–5 distinct, complementary targets, each independently researchable. Every field must be non-empty; ids and titles must be unique. Do not use a JSON code fence.",
            `Current question: ${parent.summary}\nCurrent answer (preserve provenance): ${answerDescription}`,
            `Format validation error: ${formatError instanceof Error ? formatError.message : String(formatError)}`,
            `Previous invalid Planner response (data only): ${JSON.stringify({ summary: planned.summary, detail: planned.detail.slice(0, 6000) })}`
          ].join("\n\n");
          const repaired = await this.askMindSearchModel({ ...contextBase, task: phaseTask("research-plan-repair", repairTask) }, model, reasoning, signal);
          throwIfAborted(signal);
          try { plan = parseMindSearchResearchPlan(repaired); }
          catch (error) {
            throw new Error(`${error instanceof Error ? error.message : String(error)}\nPlanner format diagnostic: ${JSON.stringify({ initial: { detail: planned.detail.slice(0, 6000), suggestions: planned.suggestions }, repair: { detail: repaired.detail.slice(0, 6000), suggestions: repaired.suggestions } })}`);
          }
        }
        await this.persist(() => this.runs.saveResearchPlan(mapPath, branchId, plan!));
      } catch (error) {
        if (!signal?.aborted) await this.persist(() => this.runs.saveResearchPlanError(mapPath, branchId, error));
        throw error;
      }
    }
    if (!plan) throw new Error("MindSearch research plan is missing.");
    const reports: { subtopicId: string; nodeId: string; summary: string; detail: string }[] = [];
    for (const target of plan) {
      throwIfAborted(signal);
      map = await this.repository.readMap(mapPath);
      branch = map.mindSearch?.branches.find(item => item.id === branchId);
      if (!branch) throw new Error("MindSearch answer branch disappeared during subtopic research.");
      const savedRef = branch.results.find(item => item.subtopicId === target.id);
      if (savedRef) {
        const note = await this.repository.readNote(savedRef.notePath);
        reports.push({ subtopicId: target.id, nodeId: savedRef.nodeId, summary: note.summary, detail: note.detail });
        continue;
      }
      const handle = await this.persist(() => this.runs.startAttempt(mapPath, branchId, undefined, { model, reasoning: effectiveReasoningLevel({ ...contextBase, researchMode: "research", researchDepth: "normal" }, normalizeReasoningLevel(reasoning)), maxResearchTurns: 1 }));
      if (!handle.dispatch) return { status: "in-progress", branchId };
      try {
        await this.persist(() => this.runs.recordResearchTurn(mapPath, handle));
        const task = phaseTask("subtopic-research", ["Perform a targeted web search. Return a concise evidence report: findings, supporting URLs, and unresolved gaps. Focus on what the latest answer changes; do not write a full career guide or final deliverable. Report search status accurately.", SEARCHER_TARGET_RULE, `Assigned research subtopic: ${target.title}\nResearch task: ${target.task}\nExpected value: ${target.expectedValue}`, `Current question: ${parent.summary}\nCurrent answer: ${answerDescription}`, `Other planned subtopics: ${plan.filter(item => item.id !== target.id).map(item => item.title).join("; ")}`, "Answer this subtopic itself; do not substitute another subtopic's evidence."].join("\n\n"));
        const diagnostic = { researchTurn: 1, startedEvents: 0, completedEvents: 0, completedSearchActions: 0, otherCompletedActions: 0 };
        const result = await this.askMindSearchModel({ ...contextBase, task, researchMode: "research", researchDepth: "normal" }, model, reasoning, signal, event => { if (event.method === "item/started") diagnostic.startedEvents++; else { diagnostic.completedEvents++; const params = event.params as { item?: { action?: { type?: unknown } } } | undefined; if (params?.item?.action?.type === "search") diagnostic.completedSearchActions++; else diagnostic.otherCompletedActions++; } });
        await this.persist(() => this.runs.recordSearchDiagnostic(mapPath, handle, diagnostic));
        throwIfAborted(signal);
        const draft = await this.persist(() => this.runs.createResultDraft(mapPath, handle, target.title, model, undefined, { kind: "research", subtopicId: target.id }));
        if (draft.status === "stale") return { status: "stale", branchId };
        if (!result.summary.trim() || !result.detail.trim()) throw new Error(`Subtopic research did not produce a usable report: ${target.title}`);
        const savedReport = await this.persist(() => this.runs.updateResultDraftReport(mapPath, handle, draft.draft.id, result.summary, result.detail));
        if (!savedReport) return { status: "stale", branchId };
        if (/\bresearch status\s*:\s*(?:not searched|search failed|unavailable)\b/i.test(`${result.summary}\n${result.detail}`)) throw new Error("The Agent explicitly says no web search succeeded; the report remains an unpublished diagnostic.");
        const committed = await this.persist(() => this.runs.commitResult(mapPath, handle, draft.draft.id, result));
        if (committed.status !== "committed") return { status: "stale", branchId };
        const saved = await this.repository.readNote(committed.notePath);
        reports.push({ subtopicId: target.id, nodeId: draft.draft.nodeId, summary: saved.summary, detail: saved.detail });
      } catch (error) {
        try { if (signal?.aborted) await this.persist(() => this.runs.cancelAttempt(mapPath, handle, "User cancelled a MindSearch subtopic research turn.").then(() => undefined)); else await this.persist(() => this.runs.failAttempt(mapPath, handle, error instanceof Error ? error.message : String(error)).then(() => undefined)); } catch { /* Preserve the original research error. */ }
        throw error;
      } finally { this.runs.releaseAttempt(mapPath, handle); }
    }
    throwIfAborted(signal);
    map = await this.repository.readMap(mapPath);
    branch = map.mindSearch?.branches.find(item => item.id === branchId);
    if (!branch) throw new Error("MindSearch answer branch disappeared before synthesis.");
    const answeredQuestionCount = this.answerCountInLineage(map, branch.id);
    const explorationTarget = map.mindSearch?.minimumAnswersBeforeConclusion ?? 2;
    const existingConclusion = [...branch.results].reverse().find(item => item.kind === "conclusion" || item.kind === "synthesis");
    if (existingConclusion) {
      const savedRun = map.mindSearch?.runs.find(item => item.id === existingConclusion.runId);
      const savedAttempt = savedRun?.attempts.find(item => item.id === existingConclusion.attemptId);
      const result = { status: "committed" as const, resultId: existingConclusion.resultId, notePath: existingConclusion.notePath, ...(savedAttempt?.status === "partial" ? { resultStatus: "partial" as const } : {}) };
      return savedAttempt?.status === "partial" ? { status: "partial", branchId, result } : { status: "completed", branchId, result };
    }
    const synthesisReasoning = effectiveReasoningLevel({ ...contextBase, title: topicNote.title, detailFormat: "adaptive" }, normalizeReasoningLevel(reasoning));
    const synthesisHandle = await this.persist(() => this.runs.startAttempt(mapPath, branchId, undefined, { model, reasoning: synthesisReasoning, maxResearchTurns: MINDSEARCH_MAX_RESEARCH_TURNS }));
    if (!synthesisHandle.dispatch) return { status: "in-progress", branchId };
    try {
      await this.persist(() => this.runs.recordResearchTurn(mapPath, synthesisHandle));
      const supplementalReports: { target: { title: string; task: string; expectedValue: string }; summary: string; detail: string }[] = [];
      const aggregateReports = () => ({
        summary: [...reports.map(item => `${plan.find(target => target.id === item.subtopicId)?.title ?? item.subtopicId}: ${item.summary}`), ...supplementalReports.map(item => `補查：${item.target.title}: ${item.summary}`)].join("\n"),
        detail: [...reports.map(item => `## ${plan.find(target => target.id === item.subtopicId)?.title ?? item.subtopicId}\n\n${item.detail}`), ...supplementalReports.map(item => `## 補查：${item.target.title}\n\n${item.detail}`)].join("\n\n")
      });
      let synthesisDraftId: string | undefined;
      let finalReview: ReturnType<typeof parseMindSearchPlannerReview> | undefined;
      for (let researchTurn = 1; researchTurn <= MINDSEARCH_MAX_RESEARCH_TURNS; researchTurn++) {
        throwIfAborted(signal);
        const currentReports = aggregateReports();
        const plannerPrompt = phaseTask("report-review", ["Review the complete evidence for the original user goal. Return one decision with a brief evidence-based interim answer; do not write the final document yet. Use all known conditions and relevant evidence in this branch lineage. Keep the current question and answer as conditions that personalize the result; they are not the overall goal. Do not expose the internal research log as the answer. Return the standard MindSearch review marker as the first detail line.", PLANNER_COVERAGE_RULE, `Hard floor: ${answeredQuestionCount} answered question node(s) on this branch path; do not conclude before ${MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION}. At the floor, the configured exploration target (${explorationTarget}) is a soft depth preference; do not require reaching 10 or add quota filler. Below the floor, ask one meaningful new question about an unknown decision-relevant dimension.`, `Do not repeat known conditions or prior questions. Ask only for a genuinely missing user condition, never to compensate for missing research. Use research_more for missing evidence. Prior questions: ${JSON.stringify(questionsAlreadyAsked)}.`, "Choose research_more only for one specific material evidence gap that targeted web research can resolve; provide exactly one targeted suggestion with title, search task, and expected uncertainty reduction. Choose ask_user for a missing decision-changing user condition or a genuinely conflicting pair of supplied values. Name the conflict and request one clarification; never defer a material conflict into the final document. Include 2–5 choices in suggestions[].title. Do not use ask_user to compensate for missing research. Choose conclude only when the original goal is adequately supported and the hard floor is met; cite source names or links from reports when available and state remaining uncertainty and limits. Do not search in this Planner turn.", '<!-- mindsearch-review {"decision":"research_more|ask_user|conclude","rationale":"evidence-based reason","stopReason":"why sufficient, for conclude","question":"question, for ask_user"} -->', `Current question: ${parent.summary}\nCurrent answer: ${answerDescription}`, `Research budget: review ${researchTurn} of ${MINDSEARCH_MAX_RESEARCH_TURNS}. One targeted follow-up search remains when this is review 1; if a material gap remains after review 2, return research_more so VAM saves a partial result.`].join("\n\n"));
        const plannerContext = { ...contextBase, summary: "", detail: `${contextBase.detail}\n\nPersisted research reports:\n${currentReports.summary}\n\n${currentReports.detail}`, task: plannerPrompt, detailFormat: "adaptive" as const };
        const synthesis = await this.askMindSearchModel(plannerContext, model, reasoning, signal);
        finalReview = await this.parsePlannerReviewWithRecovery(synthesis, { question: topicNote.title, answerSnapshot: answerDescription, reportSummary: currentReports.summary, reportDetail: currentReports.detail }, plannerContext, model, reasoning, signal);
        finalReview = await this.reviewPlannerDecisionQuality(finalReview, { goal: topicNote.title, goalDetail: topicNote.detail, conditions: branch.inputSnapshot.conditions, currentQuestion: parent.summary, currentAnswer: answerDescription, answeredQuestionCount, questionHistory: questionsAlreadyAsked, lineage: lineageContext, evidenceIds: contextBase.mindSearchEvidenceIds, reportSummary: currentReports.summary, reportDetail: currentReports.detail }, model, reasoning, signal);
        throwIfAborted(signal);

        const reviewStopReason = finalReview.decision === "conclude" ? finalReview.stopReason : finalReview.decision === "ask_user" ? `Awaiting the user's answer to: ${finalReview.question}` : researchTurn === MINDSEARCH_MAX_RESEARCH_TURNS ? `Research-turn limit reached with an unresolved evidence gap: ${finalReview.rationale}` : undefined;
        await this.persist(() => this.runs.recordPlannerReview(mapPath, synthesisHandle, { decision: finalReview!.decision, rationale: finalReview!.rationale, researchTurn, ...(finalReview!.decision === "ask_user" ? { question: finalReview!.question, answerOptions: finalReview!.answerOptions } : {}), ...(finalReview!.decision === "research_more" ? { researchTarget: finalReview!.researchTarget } : {}) }, reviewStopReason));
        if (finalReview.decision !== "research_more") break;

        if (researchTurn === MINDSEARCH_MAX_RESEARCH_TURNS) break;
        const target = finalReview.researchTarget!;
        if (!synthesisDraftId) {
          const lastReport = reports.at(-1);
          if (!lastReport) throw new Error("MindSearch cannot save a follow-up without persisted initial subtopic reports.");
          const draft = await this.persist(() => this.runs.createResultDraft(mapPath, synthesisHandle, "研究補查草稿", model, undefined, { kind: "synthesis", parentNodeId: lastReport.nodeId, convergesFromNodeIds: reports.map(item => item.nodeId) }));
          if (draft.status === "stale") return { status: "stale", branchId };
          synthesisDraftId = draft.draft.id;
        }
        const beforeSearch = aggregateReports();
        if (!await this.persist(() => this.runs.updateResultDraftReport(mapPath, synthesisHandle, synthesisDraftId!, beforeSearch.summary, beforeSearch.detail))) return { status: "stale", branchId };
        await this.persist(() => this.runs.recordResearchTurn(mapPath, synthesisHandle));
        const diagnostic = { researchTurn: researchTurn + 1, startedEvents: 0, completedEvents: 0, completedSearchActions: 0, otherCompletedActions: 0 };
        const onEvent = (event: CodexWebSearchEvent) => {
          const params = event.params as { item?: { action?: { type?: unknown } } } | undefined;
          const action = typeof params?.item?.action?.type === "string" ? params.item.action.type : "unknown";
          if (event.method === "item/started") diagnostic.startedEvents++;
          else { diagnostic.completedEvents++; if (action === "search") diagnostic.completedSearchActions++; else diagnostic.otherCompletedActions++; }
        };
        const followupTask = phaseTask("targeted-followup-research", ["Perform one targeted web search for the Planner's material evidence gap. Report search status accurately and include source attribution, uncertainty, and limitations.", SEARCHER_TARGET_RULE, `Target: ${target.title}\nSearch task: ${target.task}\nExpected uncertainty reduction: ${target.expectedValue}`, `Current question: ${parent.summary}\nCurrent answer: ${answerDescription}`, "Do not ask the user questions. This is an evidence-gathering step, not a Planner review."].join("\n\n"));
        let followup: AiResult;
        try { followup = await this.askMindSearchModel({ ...contextBase, summary: "", detail: `${contextBase.detail}\n\nExisting reports (context only):\n${beforeSearch.detail}`, task: followupTask, researchMode: "research", researchDepth: "normal" }, model, reasoning, signal, onEvent); }
        catch (error) { await this.persist(() => this.runs.recordSearchDiagnostic(mapPath, synthesisHandle, diagnostic)); throw error; }
        await this.persist(() => this.runs.recordSearchDiagnostic(mapPath, synthesisHandle, diagnostic));
        throwIfAborted(signal);
        if (!followup.summary.trim() || !followup.detail.trim() || /\bresearch status\s*:\s*(?:not searched|search failed|unavailable)\b/i.test(`${followup.summary}\n${followup.detail}`)) throw new Error("The targeted follow-up did not produce a usable searched report; the attempt remains incomplete.");
        supplementalReports.push({ target, summary: followup.summary, detail: followup.detail });
        const updatedReports = aggregateReports();
        if (!await this.persist(() => this.runs.updateResultDraftReport(mapPath, synthesisHandle, synthesisDraftId!, updatedReports.summary, updatedReports.detail))) return { status: "stale", branchId };
      }
      if (!finalReview) throw new Error("MindSearch synthesis did not produce a validated Planner decision.");
      const reportDetail = aggregateReports().detail;
      const isQuestion = finalReview.decision === "ask_user";
      const isPartial = finalReview.decision === "research_more";
      const lastReport = reports.at(-1);
      if (!lastReport) throw new Error("MindSearch cannot synthesize without persisted subtopic reports.");
      if (!synthesisDraftId) {
        const draft = await this.persist(() => this.runs.createResultDraft(mapPath, synthesisHandle, isPartial ? "研究待補查" : isQuestion ? "研究收斂" : "研究結論", model, undefined, { kind: isPartial || isQuestion ? "synthesis" : "conclusion", parentNodeId: lastReport.nodeId, convergesFromNodeIds: reports.map(item => item.nodeId) }));
        if (draft.status === "stale") return { status: "stale", branchId };
        synthesisDraftId = draft.draft.id;
      }
      const stopReason = isPartial ? `研究輪數已達上限，仍有重要證據缺口：${finalReview.rationale}` : isQuestion ? `Awaiting the user's answer to: ${finalReview.question}` : finalReview.stopReason!;
      const partialSection = isPartial && finalReview.researchTarget ? ["## 研究狀態：部分完成，可繼續研究", `尚待補查：${finalReview.researchTarget.title}`, `補查任務：${finalReview.researchTarget.task}`, `預期釐清：${finalReview.researchTarget.expectedValue}`].join("\n\n") : "";
      const detail = isPartial || isQuestion
        ? [partialSection || "## Interim result", finalReview.detail, `Rationale: ${finalReview.rationale}`, `Stop reason: ${stopReason}`, "## Supporting research", reportDetail, "## Source boundary", "Sources and claims are reported by the research agent and were not independently verified by VAM."].join("\n\n")
        : finalReview.detail;
      const presentation = isPartial ? { title: "研究待補查", kind: "synthesis" as const } : isQuestion ? { title: "研究收斂", kind: "synthesis" as const } : { title: "研究結論", kind: "conclusion" as const };
      if (!await this.persist(() => this.runs.updateResultDraftPresentation(mapPath, synthesisHandle, synthesisDraftId, presentation.title, presentation.kind))) return { status: "stale", branchId };
      const committed = await this.persist(() => { throwIfAborted(signal); return this.runs.commitResult(mapPath, synthesisHandle, synthesisDraftId, { summary: isPartial ? `部分研究，仍待補查：${finalReview.summary}` : finalReview.summary, detail }, isPartial ? "partial" : "completed"); });
      if (committed.status !== "committed") return { status: "stale", branchId };
      if (isQuestion) {
        const latestMap = await this.repository.readMap(mapPath), resultRef = latestMap.mindSearch?.branches.find(item => item.id === branchId)?.results.find(item => item.runId === synthesisHandle.runId && item.attemptId === synthesisHandle.attemptId);
        if (!resultRef) throw new Error("Planner conclusion was committed without a result reference for its follow-up question.");
        const question = await this.saveManualQuestion(mapPath, resultRef.nodeId, branchId, `post-${synthesisHandle.runId}-${synthesisHandle.attemptId}`, model, synthesisReasoning, finalReview.question!, finalReview.rationale, finalReview.answerOptions!, "Follow-up question after reviewing all saved research, including any targeted evidence follow-up.", signal);
        if (question.status !== "question") throw new Error("Planner requested a user condition but no follow-up question was saved.");
        return { status: "waiting-user", branchId, result: committed, questionNodeId: question.node.id };
      }
      return isPartial ? { status: "partial", branchId, result: committed } : { status: "completed", branchId, result: committed };
    } catch (error) {
      try { if (signal?.aborted) await this.persist(() => this.runs.cancelAttempt(mapPath, synthesisHandle, "User cancelled MindSearch synthesis.").then(() => undefined)); else await this.persist(() => this.runs.failAttempt(mapPath, synthesisHandle, error instanceof Error ? error.message : String(error)).then(() => undefined)); } catch { /* Preserve the original synthesis error. */ }
      throw error;
    } finally { this.runs.releaseAttempt(mapPath, synthesisHandle); }
  }

  private async commitQuestionDraft(mapPath: string, map: MapDocument, draft: MindSearchQuestionDraft): Promise<void> {
    await this.repository.createNoteAt(draft.title, draft.model, map, mapPath, "workspace", draft.notePath, draft.nodeId, { summary: draft.summary, detail: draft.detail, prompt: draft.prompt, reasoning: draft.reasoning });
    const latest = await this.repository.readMap(mapPath), state = latest.mindSearch;
    if (!state?.questionDraft || state.questionDraft.requestId !== draft.requestId || state.questionDraft.nodeId !== draft.nodeId) throw new Error("The saved Planner question draft changed before commit.");
    if (!latest.nodes.some(node => node.id === draft.nodeId)) {
      const parent = latest.nodes.find(node => node.id === draft.parentId);
      if (!parent) throw new Error("The Planner question parent no longer exists; the question draft is retained for recovery.");
      latest.nodes.push({ id: draft.nodeId, path: draft.notePath, parentId: draft.parentId, x: parent.x + 360, y: parent.y + 240, collapsed: false, mindSearchKind: "question", mindSearchQuestion: { requestId: draft.requestId, parentBranchId: draft.parentBranchId, options: draft.options, allowMultiple: true, allowFreeText: true } });
    }
    delete state.questionDraft;
    latest.mindSearch = state;
    await this.repository.saveMap(mapPath, latest);
  }

  private lineageEvidenceIds(map: MapDocument, branchId: string | null): string[] {
    const ids: string[] = [];
    const visited = new Set<string>();
    let current = map.mindSearch?.branches.find(branch => branch.id === branchId);
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      ids.push(...current.results.map(result => `${result.nodeId}-v${result.version}`));
      current = map.mindSearch?.branches.find(branch => branch.id === current!.parentBranchId);
    }
    return ids;
  }

  private async branchLineage(map: MapDocument, branchId: string | null): Promise<{ context: string; resultRefs: { notePath: string; version: number }[]; evidence: Awaited<ReturnType<Repository["readNote"]>>[] }> {
    const data = map.mindSearch;
    if (!branchId || !data) return { context: "", resultRefs: [], evidence: [] };
    const chain = [] as typeof data.branches;
    let current = data.branches.find(branch => branch.id === branchId);
    while (current) { chain.unshift(current); current = current.parentBranchId ? data.branches.find(branch => branch.id === current!.parentBranchId) : undefined; }
    const sections: string[] = [], resultRefs: { notePath: string; version: number }[] = [], evidence: Awaited<ReturnType<Repository["readNote"]>>[] = [];
    for (const branch of chain) {
      const question = map.nodes.find(node => node.id === branch.questionNodeId);
      const questionNote = question ? await this.repository.readNote(question.path) : undefined;
      const choices = question?.mindSearchQuestion?.options.filter(option => branch.answerSnapshot.selections.includes(option.id)).map(option => option.label) ?? branch.answerSnapshot.selections;
      if (question?.mindSearchKind === "question") sections.push(`User answer to ${questionNote?.summary ?? "question"}: ${JSON.stringify({ selections: choices, freeText: branch.answerSnapshot.freeText || null })}`);
      const saved = await Promise.all(branch.results.map(async result => ({ result, note: await this.repository.readNote(result.notePath) })));
      const synthesis = [...saved].reverse().find(item => item.result.kind === "synthesis" || item.result.kind === "conclusion");
      const selected = saved.filter(item => item === synthesis || item.result.kind !== "synthesis" && item.result.kind !== "conclusion" && !synthesis?.note.detail.includes(item.note.detail));
      for (const { result, note } of selected) {
        const evidenceId = `${result.nodeId}-v${result.version}`;
        this.evidenceReports.set(evidenceId, { path: result.notePath, hash: createHash("sha256").update(note.detail).digest("hex") });
        if (this.evidenceReports.size > 512) {
          const oldest = [...this.evidenceReports.keys()][0];
          if (oldest) this.evidenceReports.delete(oldest);
        }
        sections.push(`Saved research result v${result.version} (${note.title}):\n${evidenceCard(evidenceId, note.summary, note.detail)}`);
        evidence.push(note);
      }
      for (const { result } of saved) resultRefs.push({ notePath: result.notePath, version: result.version });
    }
    return { context: sections.join("\n\n"), resultRefs, evidence };
  }

  private async questionHistory(map: MapDocument, branchId: string | null): Promise<string[]> {
    const branches = map.mindSearch?.branches;
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
      if (node?.mindSearchKind === "question") questions.push((await this.repository.readNote(node.path)).summary);
    }
    return questions;
  }
}
