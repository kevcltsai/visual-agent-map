import { CLAUDE_MODEL_CHOICES } from "../ai/providers/provider";
import type { CodexActivity } from "../ai/runtime/codex-app-server";
import type { ReasoningLevel } from "../ai/types";
import type { AiCalls } from "./ai-calls";
import type { PreparedStep } from "./step-runner";

/** The effort a step runs with: the user's `auto` means low. A pre-started process has to be asked for the same value. */
export const stepEffort = (reasoning: ReasoningLevel): string => (reasoning === "auto" ? "low" : reasoning);

/**
 * What the model runtime reports while a step runs, passed straight down to its controls. `onFirstEvent` is Claude's first
 * stream event; `onActivity` is Codex's `started | searching | reading | writing`; `onText` is Codex's visible message text so
 * far (the whole text, not a delta). `onText` is handed to Codex only: Claude streams through `onStructuredJson`.
 */
export interface ProviderStepHooks {
  onFirstEvent?: () => void;
  onActivity?: (activity: CodexActivity) => void;
  onText?: (text: string) => void;
  /** Claude only: whether its output can be watched (`stream-json`) or only arrives at the end (`json`, `json-fallback`). */
  onStreamMode?: (mode: "stream-json" | "json" | "json-fallback") => void;
  /** Receives a function that adds a user message to the running turn (Claude: stdin; Codex: `turn/steer`). It rejects once the turn can no longer take one. */
  onSteer?: (steer: (text: string) => Promise<void>) => void;
}

/**
 * A runner for one prepared step: sends it to the Claude or Codex runtime through `AiCalls`, which registers the
 * call in `activeTasks` so a Stop button can abort it and writes the AI exchange log entry; this runner parses the reply.
 * `schema` is the step's response schema, or undefined for a plain text reply.
 */
export type ProviderStepRunner<Request, Output> = (
  request: Request,
  signal: AbortSignal,
  prepared: PreparedStep<Request, Output>,
  /** Claude stream only: the raw StructuredOutput JSON so far ("" = a new call began, null = the CLI rejected it). */
  onStructuredJson?: (buffer: string | null) => void,
  /** Model events for a progress display (see {@link ProviderStepHooks}). */
  hooks?: ProviderStepHooks
) => Promise<string>;

export function providerStepRunner<
  Request extends { model: string; reasoning: ReasoningLevel; imageDataUrl?: string },
  Output
>(
  aiCalls: AiCalls,
  config: {
    name: string;
    topic: (request: Request) => string;
    stopped: () => Error;
    /** Claude only: read the CLI's stream-json output (keeps a pre-started process usable and records `prespawned`). */
    stream?: boolean;
    /** Codex only: the result is the last message item even while `onText` streams, for a reply that is parsed strictly. */
    lastMessageOnly?: boolean;
    /** The mind map this request works on, for token-usage accounting. Absent: not filed under a map. */
    mapPath?: (request: Request) => string | undefined;
  }
): ProviderStepRunner<Request, Output> {
  return (request, signal, prepared, onStructuredJson, hooks) =>
    aiCalls.run(
      prepared,
      {
        model: request.model,
        effort: stepEffort(request.reasoning),
        topic: config.topic(request),
        taskName: config.name,
        signal,
        localCodex: true,
        usage: { mapPath: config.mapPath?.(request) },
        stopped: config.stopped,
        validate: runtime => {
          if (runtime.capabilities.id === "claude" && !CLAUDE_MODEL_CHOICES.some(choice => choice.id === request.model))
            throw new Error("Unsupported Claude model");
        },
        task: {
          textOnly: true,
          searchBudget: 0,
          ...(request.imageDataUrl ? { imageDataUrl: request.imageDataUrl } : {}),
          ...(config.stream ? { stream: true } : {}),
          ...(config.lastMessageOnly ? { resolveLast: true } : {}),
          ...(config.stream && onStructuredJson ? { onStructuredJson } : {}),
          ...(hooks?.onFirstEvent ? { onFirstEvent: hooks.onFirstEvent } : {}),
          ...(hooks?.onActivity ? { onActivity: hooks.onActivity } : {}),
          ...(hooks?.onStreamMode ? { onStreamMode: hooks.onStreamMode } : {}),
          ...(hooks?.onSteer ? { onSteer: hooks.onSteer } : {}),
          ...(hooks?.onText && !CLAUDE_MODEL_CHOICES.some(choice => choice.id === request.model)
            ? { onText: hooks.onText }
            : {})
        }
      },
      (raw, exchange) => {
        if (exchange.signal.aborted) throw config.stopped();
        prepared.parse(raw);
        exchange.parsed();
        return raw;
      }
    );
}
