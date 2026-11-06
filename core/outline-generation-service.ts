import { translate, uiLocale } from "../i18n";
import type { AiCalls } from "./ai-calls";
import { providerStepRunner, type ProviderStepRunner } from "./provider-step-runner";
import { prepareStep, type PreparedStep } from "./step-runner";
import {
  applyTopicToPreset,
  OUTLINE_TOPIC_PLACEHOLDERS,
  OutlineGenerateError,
  outlineGenerateStep,
  parseOutlineReply,
  stripWrappingFence,
  type OutlineGenerateRequest,
  type OutlineGenerateResult
} from "./steps/outline-generate/step";

export { applyTopicToPreset, OUTLINE_TOPIC_PLACEHOLDERS, OutlineGenerateError, parseOutlineReply, stripWrappingFence };
export type { OutlineGenerateRequest, OutlineGenerateResult };
export type OutlineGenerateRunner = ProviderStepRunner<OutlineGenerateRequest, OutlineGenerateResult>;

export function buildOutlineGeneratePrompt(request: OutlineGenerateRequest): string {
  return outlineGenerateStep.render(request);
}
export function providerOutlineRunner(aiCalls: AiCalls): OutlineGenerateRunner {
  return providerStepRunner<OutlineGenerateRequest, OutlineGenerateResult>(aiCalls, {
    name: "outline-generate",
    topic: request => `Outline · ${request.topic.trim().slice(0, 80)}`,
    mapPath: request => request.usageMapPath,
    stopped: () => new OutlineGenerateError("stopped", "Outline generation stopped")
  });
}
export class OutlineGenerationService {
  constructor(private readonly run: OutlineGenerateRunner) {}
  /**
   * Generate a outline (each heading with a one-line summary) for `request.topic`. Throws {@link OutlineGenerateError} (localized message,
   * `code` for the reason) for an empty topic, an over-budget request, a stop, or a reply that is not a valid outline.
   */
  async generate(request: OutlineGenerateRequest, signal: AbortSignal): Promise<OutlineGenerateResult> {
    const stopped = (): OutlineGenerateError =>
      new OutlineGenerateError("stopped", translate(uiLocale(request.language), "error.outline_generate_stopped"));
    if (signal.aborted) throw stopped();
    const prepared: PreparedStep<OutlineGenerateRequest, OutlineGenerateResult> = prepareStep(
      outlineGenerateStep,
      request
    );
    // A reply with a heading that has no summary is asked for once more; any other failure goes straight out. The
    // provider runner already parses the reply (a refusal is thrown from `run`), so both calls sit in one guard.
    for (let attempt = 1; ; attempt++) {
      let raw: string;
      try {
        raw = await this.run(request, signal, prepared);
        if (signal.aborted) throw stopped();
        return prepared.parse(raw);
      } catch (error) {
        if (signal.aborted && !(error instanceof OutlineGenerateError)) throw stopped();
        if (error instanceof OutlineGenerateError && error.code === "stopped") throw stopped();
        if (!signal.aborted && attempt < 2 && error instanceof OutlineGenerateError && error.code === "missing_summary")
          continue;
        throw error;
      }
    }
  }
}
