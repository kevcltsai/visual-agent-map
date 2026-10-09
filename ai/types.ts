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

export interface Suggestion { title: string; task: string; contribution: string; parentTitle?: string; thinkingOriginBaseline?: string }
export type AiTaskKind = "task" | "decompose" | "synthesize";
export type PromptProfile = "mindsearch";
export type AiResponseContract = "mindsearch-gap-audit" | "mindsearch-delivery-acceptance";
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
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  outputLanguage?: UiLanguage;
  mode?: AiTaskKind;
  /** Let a task choose its Markdown structure while retaining the structured result contract. */
  detailFormat?: "adaptive";
  /** Select a phase-aware prompt builder for MindSearch requests. */
  promptProfile?: PromptProfile;
  /** Selects a narrow trusted response schema for the MindSearch gap audit only. */
  responseContract?: AiResponseContract;
  /** Trusted workflow lookup allowlist for MindSearch evidence retrieval; never serialize into prompts. */
  mindSearchEvidenceIds?: readonly string[];
  /** Isolate independent research to supplied context and web tools. */
  mindSearchIsolatedResearch?: boolean;
  /** Bounded timeout override for this task only. */
  timeoutMs?: number;
  researchMode?: ResearchMode;
  researchDepth?: ResearchDepth;
  visualMode?: VisualMode;
}
export interface AiResult { summary: string; detail: string; suggestions: Suggestion[]; visualReferences: VisualReference[] }
export interface AiRunMetrics { provider: string; model: string; mode: AiTaskKind | "task"; estimatedInputTokens: number; contextBreakdown: Record<string, number>; contextBuildMs: number; providerMs?: number; totalMs?: number; sessionStrategy: string }
export interface PreparedTaskContext { context: TaskContext; metrics: AiRunMetrics }
