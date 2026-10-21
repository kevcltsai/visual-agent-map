import { renderTemplate } from "../../../../core/step-runner";
import { inLanguage } from "../../../../core/steps/_shared/fragments";
import type { UiLanguage } from "../../../../i18n";
import stateQuestionTemplate from "./task.state-question.md";
import imposedOptionsTemplate from "./task.imposed-options.md";
import missingChoicesTemplate from "./task.missing-choices.md";
import generalTemplate from "./task.general.md";
import answeredWithoutTargetVariant from "./variant.answered-without-target.md";
import preserveDecisionVariant from "./variant.preserve-decision.md";
import noDecisionVariant from "./variant.no-decision.md";
import contextTemplate from "./context.md";
import defaultRationale from "./default-rationale.md";
import defaultRationaleZh from "./default-rationale.zh.md";

/** Task texts of the `aim.format-repair` step. The repair count and rules stay in the Planner review flow. */
export interface ImposedAskRepair {
  requiredDecision: string;
  requiredRationale: string;
  originalSummary: string;
  preservedBody: string;
  originalSuggestions: string;
  formatError: string;
}
/** The imposed ask_user response has no written question: the model must state the one it intended. */
export const renderStateQuestionRepair = (variables: ImposedAskRepair): string =>
  renderTemplate(stateQuestionTemplate, { ...variables });
/** The imposed ask_user response has a question but too few choices: keep the question, add 2–5 choices. */
export const renderImposedOptionsRepair = (variables: ImposedAskRepair & { question: string }): string =>
  renderTemplate(imposedOptionsTemplate, { ...variables });
/** A complete ask_user decision with missing or invalid choices. */
export const renderMissingChoicesRepair = (variables: {
  originalQuestion: string;
  originalRationale: string;
  originalSummary: string;
  originalBody: string;
  formatError: string;
  originalSuggestions: string;
}): string => renderTemplate(missingChoicesTemplate, { ...variables });

export type GeneralRepairVariant =
  { kind: "answered-without-target" } | { kind: "preserve-decision"; decision: string } | { kind: "no-decision" };
export interface GeneralRepair {
  variant: GeneralRepairVariant;
  formatError: string;
  /** Only the variants that do not preserve the original decision re-send the saved report. */
  context?: { question: string; answerSnapshot: string; reportSummary: string; reportDetail: string };
  originalSummary: string;
  originalDetail: string;
  originalSuggestions: string;
}
/** A format repair for a response whose decision block was unusable or malformed. */
export function renderGeneralRepair(repair: GeneralRepair): string {
  const variant =
    repair.variant.kind === "answered-without-target"
      ? renderTemplate(answeredWithoutTargetVariant, {})
      : repair.variant.kind === "preserve-decision"
        ? renderTemplate(preserveDecisionVariant, { decision: repair.variant.decision })
        : renderTemplate(noDecisionVariant, {});
  return renderTemplate(generalTemplate, {
    variant,
    formatError: repair.formatError,
    context: repair.context ? `${renderTemplate(contextTemplate, { ...repair.context })}\n\n` : "",
    originalSummary: repair.originalSummary,
    originalDetail: repair.originalDetail,
    originalSuggestions: repair.originalSuggestions
  });
}

/** Used when the workflow imposed ask_user without supplying its own rationale. */
export const CLARIFICATION_REQUIRED_RATIONALE = renderTemplate(defaultRationale, {});

/** The same rationale in the AIM content language (it is shown to the model and may land in a question note). */
export const clarificationRequiredRationale = (language?: UiLanguage): string =>
  language
    ? renderTemplate(inLanguage({ zh: defaultRationaleZh, en: defaultRationale }, language), {})
    : CLARIFICATION_REQUIRED_RATIONALE;
