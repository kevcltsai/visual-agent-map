import type { CountIssue, DetailTemplate } from "./detail-templates";
import type { AimContract } from "./aim-contracts";
import type { UiLanguage } from "../i18n";
import type { ReferenceGroup } from "./reference-materials";

export type ReasoningLevel = "auto" | "low" | "medium" | "high";
export type ResearchMode = "local" | "research";
export type ResearchDepth = "fast" | "normal" | "deep";
export type VisualMode = "auto" | "on" | "off";
export interface VisualReference {
  title: string;
  imageUrl: string;
  sourceUrl: string;
  description: string;
  palette: string[];
  formula: string;
}

export interface Suggestion {
  title: string;
  task: string;
  contribution: string;
  parentTitle?: string;
  thinkingOriginBaseline?: string;
}
export type AiTaskKind = "task" | "decompose" | "synthesize" | "merge";
export type PromptProfile = "aim";
export type AiResponseContract = "aim-gap-audit" | "aim-delivery-acceptance";
export interface TaskContext {
  title: string;
  summary: string;
  rules: string;
  detail: string;
  task: string;
  ancestors: string;
  workingFindings?: string;
  sourceContext?: string;
  referenceGroups?: ReferenceGroup[];
  /** "direct" (merge and synthesize): send the reference documents themselves when they fit one batch, instead of extracting findings first. */
  referenceDelivery?: "direct";
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  outputLanguage?: UiLanguage;
  mode?: AiTaskKind;
  /** Let a task choose its Markdown structure while retaining the structured result contract. */
  detailFormat?: "adaptive";
  /** The detail is intermediate evidence for a later call, never shown to the reader: no Obsidian syntax rules. */
  intermediateDetail?: boolean;
  /** Content template for fixed-section details (trusted; Standard when absent). */
  detailTemplate?: DetailTemplate;
  /** Resolved writing-tone text (trusted). Absent for the default academic tone, so prompts stay unchanged. */
  toneText?: string;
  /** Trusted flag: after the note is written, run the chart step once. Never serialized into a prompt. */
  addCharts?: boolean;
  /** internal: this request is the single count repair. */
  countRepair?: boolean;
  /** Select a phase-aware prompt builder for AIM requests. */
  promptProfile?: PromptProfile;
  /** Selects a narrow trusted response schema for the AIM gap audit only. */
  responseContract?: AiResponseContract;
  /** Provider-enforced AIM control payload for this phase; folded back into the canonical marker form. */
  aimContract?: AimContract;
  /** Lets the AIM payload request full evidence reports by ID (trusted workflow flag; never serialized). */
  aimEvidenceLookup?: boolean;
  /** Trusted workflow lookup allowlist for AIM evidence retrieval; never serialize into prompts. */
  aimEvidenceIds?: readonly string[];
  /** Isolate independent research to supplied context and web tools. */
  aimIsolatedResearch?: boolean;
  /** Bounded timeout override for this task only. */
  timeoutMs?: number;
  researchMode?: ResearchMode;
  researchDepth?: ResearchDepth;
  visualMode?: VisualMode;
}
/** Provider-neutral web activity event; Claude events are translated into the Codex App Server shape. */
export interface WebSearchEvent {
  method: "item/started" | "item/completed";
  params: unknown;
}
export type SearchStatus = "completed" | "failed" | "not_attempted";
export const SEARCH_STATUSES: readonly SearchStatus[] = ["completed", "failed", "not_attempted"];
/** searchStatus is present only for isolated web-research tasks, whose schema requires it. */
export interface AiResult {
  summary: string;
  detail: string;
  suggestions: Suggestion[];
  visualReferences: VisualReference[];
  searchStatus?: SearchStatus;
  /** Sections still off their template count after the repair request; present only when the context had counts. */
  formatIssues?: CountIssue[];
}
export interface AiRunMetrics {
  provider: string;
  model: string;
  mode: AiTaskKind | "task";
  estimatedInputTokens: number;
  contextBreakdown: Record<string, number>;
  contextBuildMs: number;
  providerMs?: number;
  totalMs?: number;
  sessionStrategy: string;
}
export interface PreparedTaskContext {
  context: TaskContext;
  metrics: AiRunMetrics;
}
