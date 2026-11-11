import { CLAUDE_MODEL_CHOICES } from "../ai/providers/provider";
import type { ResearchSteer } from "../ai/research-observer";
import { translate, uiLocale } from "../i18n";
import type { AiCalls } from "./ai-calls";
import { providerStepRunner, type ProviderStepHooks, type ProviderStepRunner } from "./provider-step-runner";
import { prepareStep, type PreparedStep } from "./step-runner";
import { renderTaskSteer } from "./steps/task-steer/steer";
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
   *
   * `steer` (the topic chat window) takes user additions while the call runs. Codex takes them into the running turn, and
   * each attempt (the retry below is a new one) binds again. Claude cannot: the outline is plain text, which the stream
   * mode that carries additions would not return as one reply, so `steer.live(false)` is called and every addition waits.
   */
  async generate(
    request: OutlineGenerateRequest,
    signal: AbortSignal,
    steer?: ResearchSteer
  ): Promise<OutlineGenerateResult> {
    const stopped = (): OutlineGenerateError =>
      new OutlineGenerateError("stopped", translate(uiLocale(request.language), "error.outline_generate_stopped"));
    if (signal.aborted) throw stopped();
    const prepared: PreparedStep<OutlineGenerateRequest, OutlineGenerateResult> = prepareStep(
      outlineGenerateStep,
      request
    );
    // A reply with a heading that has no summary, or with a stray non-heading line (such as a `>` line before the root), is
    // asked for once more (one shared retry, at most 2 calls); any other failure goes straight out. The provider runner
    // already parses the reply (a refusal is thrown from `run`), so both calls sit in one guard.
    const claude = CLAUDE_MODEL_CHOICES.some(choice => choice.id === request.model);
    if (steer && claude) steer.live(false);
    let generation = 0;
    for (let attempt = 1; ; attempt++) {
      let raw: string;
      let hooks: ProviderStepHooks | undefined;
      if (steer && !claude) {
        steer.bind(null);
        const mine = ++generation;
        hooks = {
          onSteer: send => {
            // The hook of an earlier attempt must not bind over this one.
            if (signal.aborted || mine !== generation) return;
            steer.bind(async text => {
              if (signal.aborted || mine !== generation) throw stopped();
              await send(renderTaskSteer(text));
            });
          }
        };
      }
      try {
        raw = await this.run(request, signal, prepared, undefined, hooks);
        if (signal.aborted) throw stopped();
        return prepared.parse(raw);
      } catch (error) {
        if (signal.aborted && !(error instanceof OutlineGenerateError)) throw stopped();
        if (error instanceof OutlineGenerateError && error.code === "stopped") throw stopped();
        if (
          !signal.aborted &&
          attempt < 2 &&
          error instanceof OutlineGenerateError &&
          (error.code === "missing_summary" || error.code === "non_heading")
        )
          continue;
        throw error;
      }
    }
  }
}
