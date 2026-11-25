import { translate, uiLocale } from "../i18n";
import type { AiCalls } from "./ai-calls";
import { providerStepRunner, type ProviderStepRunner } from "./provider-step-runner";
import { prepareStep } from "./step-runner";
import {
  buildStructureReviewNodes,
  isSuggestionStale,
  parseStructureReview,
  STRUCTURE_REVIEW_MAX_SUGGESTIONS,
  STRUCTURE_REVIEW_SCHEMA,
  StructureReviewError,
  structureReviewStep,
  type StructureNode,
  type StructureRejection,
  type StructureReviewRequest,
  type StructureReviewResult,
  type StructureSuggestion,
  type StructureSuggestionKind
} from "./steps/structure-review/step";

export {
  buildStructureReviewNodes,
  isSuggestionStale,
  parseStructureReview,
  STRUCTURE_REVIEW_MAX_SUGGESTIONS,
  STRUCTURE_REVIEW_SCHEMA,
  StructureReviewError
};
export type {
  StructureNode,
  StructureRejection,
  StructureReviewRequest,
  StructureReviewResult,
  StructureSuggestion,
  StructureSuggestionKind
};
export type StructureReviewRunner = ProviderStepRunner<StructureReviewRequest, StructureReviewResult>;

export function buildStructureReviewPrompt(request: StructureReviewRequest): string {
  return structureReviewStep.render(request);
}
export function providerStructureReviewRunner(aiCalls: AiCalls): StructureReviewRunner {
  return providerStepRunner<StructureReviewRequest, StructureReviewResult>(aiCalls, {
    name: "structure-review",
    topic: request => `Structure review · ${request.rootQuestion.trim().slice(0, 80)}`,
    stopped: () => new StructureReviewError("stopped", "Structure review stopped")
  });
}
export class StructureReviewService {
  constructor(private readonly run: StructureReviewRunner) {}
  /**
   * Review a map or branch. Throws {@link StructureReviewError} (localized message, `code` for the reason) for an
   * empty or over-budget tree, a stop, or a malformed reply. Individually unusable suggestions come back in `rejected`.
   */
  async review(request: StructureReviewRequest, signal: AbortSignal): Promise<StructureReviewResult> {
    const stopped = (): StructureReviewError =>
      new StructureReviewError("stopped", translate(uiLocale(request.language), "error.structure_review_stopped"));
    if (signal.aborted) throw stopped();
    const prepared = prepareStep(structureReviewStep, request);
    let raw: string;
    try {
      raw = await this.run(request, signal, prepared);
    } catch (error) {
      if (signal.aborted && !(error instanceof StructureReviewError)) throw stopped();
      if (error instanceof StructureReviewError && error.code === "stopped") throw stopped();
      throw error;
    }
    if (signal.aborted) throw stopped();
    return prepared.parse(raw);
  }
}
