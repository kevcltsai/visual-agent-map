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

export interface Suggestion { title: string; task: string; contribution: string; parentTitle?: string }
export type AiTaskKind = "task" | "decompose" | "synthesize";
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
  researchMode?: ResearchMode;
  researchDepth?: ResearchDepth;
  visualMode?: VisualMode;
}
export interface AiResult { summary: string; detail: string; suggestions: Suggestion[]; visualReferences: VisualReference[] }
export interface AiRunMetrics { provider: string; model: string; mode: AiTaskKind | "task"; estimatedInputTokens: number; contextBreakdown: Record<string, number>; contextBuildMs: number; providerMs?: number; totalMs?: number; sessionStrategy: string }
export interface PreparedTaskContext { context: TaskContext; metrics: AiRunMetrics }
