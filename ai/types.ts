import type { ResearchMode, VisualReference } from "../repository";

export interface Suggestion { title: string; task: string; contribution: string }
export type AiTaskKind = "task" | "decompose" | "synthesize";
export interface TaskContext { title: string; summary: string; rules: string; detail: string; task: string; ancestors: string; workingFindings?: string; sourceContext?: string; mode?: AiTaskKind; researchMode?: ResearchMode }
export interface AiResult { summary: string; detail: string; suggestions: Suggestion[]; visualReferences: VisualReference[] }
export interface AiRunMetrics { provider: string; model: string; mode: AiTaskKind | "task"; estimatedInputTokens: number; contextBreakdown: Record<string, number>; contextBuildMs: number; providerMs?: number; totalMs?: number; sessionStrategy: string }
export interface PreparedTaskContext { context: TaskContext; metrics: AiRunMetrics }
