import { randomUUID } from "node:crypto";
import { CLAUDE_MODEL_CHOICES } from "../ai/providers/provider";
import type { ReasoningLevel } from "../ai/types";
import type { AiTaskServiceOptions } from "./ai-task-service";
import { runtimeStepProvider, type RuntimeStepControls } from "./runtime-step-provider";
import { StepRunner, type PreparedStep } from "./step-runner";

/** The effort a step runs with: the user's `auto` means low. A pre-started process has to be asked for the same value. */
export const stepEffort = (reasoning: ReasoningLevel): string => (reasoning === "auto" ? "low" : reasoning);

/**
 * A runner for one prepared step: sends it to the Claude or Codex runtime through the step provider, registers the
 * call in `activeTasks` so a Stop button can abort it, and finishes the AI exchange log entry after parsing.
 * `schema` is the step's response schema, or undefined for a plain text reply.
 */
export type ProviderStepRunner<Request, Output> = (
  request: Request,
  signal: AbortSignal,
  prepared: PreparedStep<Request, Output>
) => Promise<string>;

export function providerStepRunner<Request extends { model: string; reasoning: ReasoningLevel }, Output>(
  options: AiTaskServiceOptions,
  activeTasks: Map<string, AbortController>,
  config: {
    name: string;
    topic: (request: Request) => string;
    stopped: () => Error;
    /** Claude only: read the CLI's stream-json output (keeps a pre-started process usable and records `prespawned`). */
    stream?: boolean;
  }
): ProviderStepRunner<Request, Output> {
  return async (request, signal, prepared) => {
    const key = `${config.name}:${randomUUID()}`,
      controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    activeTasks.set(key, controller);
    const effort = stepEffort(request.reasoning);
    const refuseIfStopped = (): void => {
      if (controller.signal.aborted) throw config.stopped();
    };
    const log = (): ReturnType<AiTaskServiceOptions["exchanges"]> =>
      options.exchangeLoggingEnabled() ? options.exchanges() : null;
    const provider = runtimeStepProvider({
      claude: () => ({
        runTask: async (prompt, model, level, schema, controls) => {
          if (!CLAUDE_MODEL_CHOICES.some(choice => choice.id === request.model))
            throw new Error("Unsupported Claude model");
          const raw = await options
            .claudeRuntime(options.pluginDirectory())
            .runTask(prompt, model, level, schema, controls);
          refuseIfStopped();
          return raw;
        }
      }),
      codex: local => ({
        runTask: async (prompt, model, level, schema, controls) => {
          const raw = await options
            .codexRuntime(options.pluginDirectory(), local)
            .runTask(prompt, model, level, schema, controls);
          refuseIfStopped();
          return raw;
        }
      }),
      exchanges: log,
      localCodex: true
    });
    let id: string | undefined;
    const controls: RuntimeStepControls = {
      model: request.model,
      effort,
      topic: config.topic(request),
      finish: "caller",
      onExchange: exchangeId => {
        id = exchangeId;
      },
      task: {
        textOnly: true,
        searchBudget: 0,
        signal: controller.signal,
        ...(config.stream ? { stream: true } : {})
      }
    };
    try {
      const { raw } = await new StepRunner(provider).send(prepared, controls);
      refuseIfStopped();
      prepared.parse(raw);
      if (id) {
        log()?.parsed(id);
        log()?.completed(id);
      }
      return raw;
    } catch (error) {
      if (id) log()?.failed(id, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      activeTasks.delete(key);
    }
  };
}
