// Prompt rules, constants and parsers for the Manual AIM flow; moved from manual-flow.ts unchanged.
import type { UiLanguage } from "../../i18n";
import type { AiResult, TaskContext } from "../../ai/types";
import type { MapDocument, MapNode, AimBranchRecord } from "../../map-model";
import { type CommitResult } from "./research-run-store";
import type { CodexWebSearchEvent } from "../../ai/runtime/codex-app-server";
import { AIM_NO_QUESTION, type AimContract, type AimDecision } from "../../ai/aim-contracts";
import { parseAimPlannerReview } from "./planner-review";
import { DEFAULT_AIM_FLOW_LIMITS, type AimFlowLimits } from "./flow-limits";
import {
  researchUnprovenReuse,
  validateAimResearchPlan,
  type AimResearchPlan,
  type AimResearchTarget
} from "./research-plan";

export const AIM_UNKNOWN_OPTION_ID = "__aim_unknown__";
export { AIM_NO_QUESTION };
export const MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION = DEFAULT_AIM_FLOW_LIMITS.minAnsweredBeforeConclusion;
export {
  PLANNER_COVERAGE_RULE,
  SEARCHER_TARGET_RULE,
  USER_QUESTION_RULE,
  FLOOR_ASK_RULE,
  OUTCOME_EXPECTATION_RULE
} from "./steps/_shared/rules";
/** Below the floor more research never substitutes for the missing user input. */
/** Every question goes to the user, so it must be about their goal, not about this workflow. */
export const ALL_DECISIONS: readonly AimDecision[] = ["research_more", "ask_user", "conclude"];
export const reviewContract = (decisions: readonly AimDecision[]): AimContract => ({
  kind: "review",
  decisions
});
/** Below the answered-question floor the schema does not offer conclude, so the Planner cannot violate it. */
export const floorDecisions = (
  answeredQuestionCount: number,
  limits: Pick<AimFlowLimits, "minAnsweredBeforeConclusion"> = DEFAULT_AIM_FLOW_LIMITS
): readonly AimDecision[] =>
  answeredQuestionCount < limits.minAnsweredBeforeConclusion ? ["research_more", "ask_user"] : ALL_DECISIONS;
export function phaseTask(phase: string, task: string): string {
  return `<!-- aim-phase: ${phase} -->\n${task}`;
}
export function countAimAnsweredQuestions(map: MapDocument, branchId: string | null): number {
  let count = 0,
    current = branchId ? map.aim?.branches.find(branch => branch.id === branchId) : undefined;
  while (current) {
    if (map.nodes.find(node => node.id === current!.questionNodeId)?.aimKind === "question") count++;
    current = current.parentBranchId
      ? map.aim?.branches.find(branch => branch.id === current!.parentBranchId)
      : undefined;
  }
  return count;
}
export function lineageWithoutRepeatedReports(lineage: string, reportDetail: string): string {
  return lineage
    .split(/\n\n(?=(?:User answer to |Saved research result v))/g)
    .filter(section => {
      if (!section.startsWith("Saved research result ")) return true;
      const report = section.match(/\nReport:\n([\s\S]*)$/)?.[1]?.trim();
      return !report || !reportDetail.includes(report);
    })
    .join("\n\n");
}
export type AimAskModel = (
  context: TaskContext,
  model: string,
  reasoning?: unknown,
  signal?: AbortSignal,
  onWebSearchEvent?: (event: CodexWebSearchEvent) => void
) => Promise<AiResult>;

export type PlannerQuestionResult =
  | { status: "question"; node: MapNode; options: { id: string; label: string }[] }
  | { status: "no-question"; outcome?: ManualResearchResult };
export type ManualResearchResult =
  | { status: "completed" | "partial"; branchId: string; result: CommitResult }
  | { status: "waiting-user"; branchId: string; result: CommitResult; questionNodeId: string }
  | { status: "in-progress" | "stale"; branchId: string };
export type AimPersist = <T>(operation: () => Promise<T>) => Promise<T>;

export type QuestionPlanEntry = {
  fingerprint: string;
  controller: AbortController;
  promise: Promise<PlannerQuestionResult>;
  subscribers: Set<symbol>;
  settled: boolean;
};

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("The operation was aborted.");
    error.name = "AbortError";
    throw error;
  }
}

export function normalizePersistedAnswerOptions(options: unknown): string[] {
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

export function parseAimResearchPlan(result: Pick<AiResult, "detail" | "suggestions">): AimResearchPlan {
  const marked = result.detail.match(/<!--\s*aim-plan\s+([\s\S]*?)\s*-->/);
  const unmarked = marked ? null : result.detail.match(/\{\s*"subtopics"\s*:\s*\[[\s\S]*?\]\s*\}/);
  const payload = marked?.[1] ?? unmarked?.[0];
  let markerError: unknown;
  if (payload) {
    try {
      const raw: unknown = JSON.parse(payload);
      const subtopics = raw && typeof raw === "object" ? (raw as { subtopics?: unknown }).subtopics : undefined;
      return validateAimResearchPlan(researchUnprovenReuse(subtopics));
    } catch (error) {
      markerError = error; /* Use the provider's structured suggestions below when its detail marker is malformed. */
    }
  }
  const suggestions = result.suggestions;
  if (Array.isArray(suggestions) && suggestions.length >= 1 && suggestions.length <= 5) {
    const plan = suggestions.map((item, index) => {
      const title = typeof item?.title === "string" ? item.title : "";
      const slug =
        title
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 32) || "subtopic";
      return { id: `suggestion-${index + 1}-${slug}`, title, task: item?.task, expectedValue: item?.contribution };
    });
    return validateAimResearchPlan(plan);
  }
  // Surface the marker's specific defect so the format repair can correct it.
  if (markerError instanceof Error && !(markerError instanceof SyntaxError)) throw markerError;
  throw new Error("Planner must return 0–5 valid research subtopics before the answer can proceed.");
}

/** Every AIM model call carries the map's content language explicitly; the service-level UI fallback must never apply. */
/** `outputLanguage` is the output content language; fixed note text uses its note language. */
export type AimTaskContext = TaskContext & { outputLanguage: UiLanguage };

export type PlannerReview = ReturnType<typeof parseAimPlannerReview>;

export type ResearchCandidate = {
  source: NonNullable<AimResearchTarget["source"]>;
  evidenceId: string;
  title: string;
  summary: string;
  detail: string;
  conditions: Record<string, string>;
};
export class ResearchWorkflowInterrupted extends Error {
  constructor(readonly status: "stale" | "in-progress") {
    super(`AIM research is ${status}.`);
  }
}
export class ReuseEvidenceRejected extends Error {}
/**
 * Live progress of one answer branch for the map view. It lives in memory only: nothing is saved, and a listener
 * that throws cannot disturb the research.
 */
export type AimProgressEvent =
  | { kind: "plan"; mapPath: string; branchId: string; targets: { id: string; title: string }[] }
  | {
      kind: "subtopic";
      mapPath: string;
      branchId: string;
      subtopicId: string;
      state: "searching" | "done" | "skipped";
      /** Web searches the provider has finished for this subtopic so far. */
      searches?: number;
    }
  | { kind: "stage"; mapPath: string; branchId: string; stage: string };
/** One subtopic's web search failed; its siblings still feed the review. */
export class SubtopicSearchUnavailable extends Error {}

export type PlannerQualityContext = {
  goal: string;
  goalDetail: string;
  /** The map runs unattended: no question may stop it, so what is unknown becomes an assumption to confirm. */
  unattended?: boolean;
  /** AIM content language of the map; every model call in the review pipeline uses it. */
  outputLanguage: UiLanguage;
  /** Writing tone for the final delivery only; review and classification calls are structured and ignore it. */
  toneText?: string;
  conditions: Record<string, string>;
  currentQuestion: string;
  currentAnswer: string;
  answeredQuestionCount: number;
  questionHistory: string[];
  lineage: string;
  reportSummary: string;
  reportDetail: string;
  evidenceIds?: readonly string[];
  deliveryEvidence?: import("./final-delivery").DeliveryEvidence[];
  /** Earlier rounds' results the final document may read when the outline maps to them. */
  lineageEvidence?: import("./final-delivery").DeliveryEvidence[];
  preclassifiedResearchTarget?: PlannerReview["researchTarget"];
  deliveryRecovery?: AimBranchRecord["deliveryRecovery"];
  saveDeliveryRecovery?: (
    checkpoint: import("./final-delivery").FinalDeliveryCheckpoint,
    phase?: string
  ) => Promise<void>;
  timeoutMs?: number;
  setPhase?: (phase: string) => Promise<void>;
};

export type ResearchGapClassification = { classification: "user_condition" | "external_evidence"; rationale: string };

/** Connects Planner turns, explicit user answers, the existing run store, and existing VAM AI/storage services. */
