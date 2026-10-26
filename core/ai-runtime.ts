import type { AiProviderId } from "../ai/providers/provider";
import type { RuntimeTaskControls } from "./runtime-step-provider";

/** Which model runtime a call goes to: the Claude Code CLI or the Codex app server. */
export type AiRuntimeId = AiProviderId;

/** What a runtime can do; callers ask instead of testing the runtime id. */
export interface AiRuntimeCapabilities {
  id: AiRuntimeId;
  imageGeneration: boolean;
  /** Largest image the runtime accepts as input, or absent when it takes none. */
  imageInput?: { maxEdgePx: number; maxBytes: number };
  webSearch: boolean;
  /** True when the runtime can start its process before the prompt is known. */
  prewarm: boolean;
  /** Reasoning efforts the runtime offers as a fixed list, or absent when the model decides. */
  fixedReasoningEfforts?: readonly string[];
}

export const CLAUDE_CAPABILITIES: AiRuntimeCapabilities = {
  id: "claude",
  imageGeneration: false,
  imageInput: { maxEdgePx: 1568, maxBytes: 5 * 1024 * 1024 },
  webSearch: true,
  prewarm: true,
  fixedReasoningEfforts: ["low", "medium", "high"]
};

export const CODEX_CAPABILITIES: AiRuntimeCapabilities = {
  id: "codex",
  imageGeneration: true,
  webSearch: true,
  prewarm: false
};

export interface AiRuntimeRequest {
  prompt: string;
  /** Model id as stored in settings, for example `claude:sonnet`. */
  model: string;
  effort: string;
  schema?: unknown;
  controls: RuntimeTaskControls;
  /** Codex only: use the runtime without web search. */
  localCodex: boolean;
}

/** One model runtime behind a single call. Rejects with the runtime's own error. */
export interface AiRuntime {
  readonly capabilities: AiRuntimeCapabilities;
  run(request: AiRuntimeRequest): Promise<string>;
  /** Whether `model` can run now. Refreshes model discovery (its cache, pickers and saved list); the caller shows any guide, notice or log. */
  readiness(model: string): Promise<AiRuntimeReadinessResult>;
  /** Starts an idle process for a call with these settings; makes no model call. Called only when `capabilities.prewarm`. */
  prewarm(model: string, options: AiRuntimePrewarmOptions): void;
}

/**
 * Whether a model can run: `ready`; `missing` (the CLI is not installed); `model-unavailable` (installed, but the
 * model is not on its list); `error` (the check itself failed).
 */
export type AiRuntimeReadiness = "ready" | "missing" | "model-unavailable" | "error";

/** What {@link AiRuntime.readiness} found. `error` is the check's own failure, for the debug log; an "error" without it has nothing to report. */
export interface AiRuntimeReadinessResult {
  status: AiRuntimeReadiness;
  error?: string;
}

export interface AiRuntimePrewarmOptions {
  effort: string;
  schema?: unknown;
  webSearch: boolean;
}
