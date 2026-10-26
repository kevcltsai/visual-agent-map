import { translate, uiLocale } from "../i18n";
import { CLAUDE_MODEL_CHOICES } from "../ai/providers/provider";
import type { AiCallOptions, AiCalls } from "./ai-calls";
import { prepareStep, type PreparedStep } from "./step-runner";
import {
  parseReframeDraft,
  REFRAME_SCHEMA,
  REFRAME_TOKEN_BUDGET,
  reframeStep,
  type ReframeDraft,
  type ReframeRequest
} from "./steps/reframe/step";

export { parseReframeDraft, REFRAME_SCHEMA, REFRAME_TOKEN_BUDGET };
export type { ReframeDraft, ReframeRequest };
export type PreparedReframe = PreparedStep<ReframeRequest, ReframeDraft>;
/**
 * `prompt` and `schema` are those of `prepared`; `prepared` is what a runner that calls a model must send
 * (`StepRunner.send` accepts nothing else).
 */
export type ReframeRunner = (
  request: ReframeRequest,
  prompt: string,
  schema: unknown,
  signal: AbortSignal,
  prepared: PreparedReframe
) => Promise<string>;
export function buildReframePrompt(request: ReframeRequest): string {
  return reframeStep.render(request);
}
export function providerReframeRunner(aiCalls: AiCalls): ReframeRunner {
  return (request, _prompt, _schema, signal, prepared) => {
    const options: AiCallOptions = {
      model: request.model,
      effort: request.reasoning === "auto" ? "low" : request.reasoning,
      topic: `Reframing · ${request.question}`,
      taskName: "reframe",
      signal,
      localCodex: true,
      stopped: () => new Error("Reframing stopped"),
      validate: runtime => {
        if (runtime.capabilities.id === "claude" && !CLAUDE_MODEL_CHOICES.some(choice => choice.id === request.model))
          throw new Error("Unsupported Claude model");
      },
      task: { textOnly: true, searchBudget: 0 }
    };
    // Unlike providerStepRunner, finish has no stop check of its own (a stop before the reply is refused inside AiCalls).
    return aiCalls.run(prepared, options, (raw, exchange) => {
      prepared.parse(raw);
      exchange.parsed();
      return raw;
    });
  };
}
export class ReframingService {
  constructor(private readonly run: ReframeRunner) {}
  async reframe(request: ReframeRequest, signal: AbortSignal): Promise<ReframeDraft> {
    const checkCancelled = (): void => {
      if (signal.aborted) throw new Error(translate(uiLocale(request.language), "error.reframing_stopped"));
    };
    checkCancelled();
    if (request.targetCore !== "understand") throw new Error("Unsupported reframing target");
    const prepared = prepareStep(reframeStep, request);
    const raw = await this.run(request, prepared.prompt, REFRAME_SCHEMA, signal, prepared);
    checkCancelled();
    return prepared.parse(raw);
  }
}
