import { renderTemplate } from "../../step-runner";
import type { ContentLanguage } from "../../../i18n";
import type { TaskContext } from "../../../ai/types";
import type { AiProviderId } from "../../../ai/providers/provider";
import {
  inLanguage,
  inLanguageNaming,
  LABEL_ANCESTORS,
  LABEL_RULES,
  LABEL_SOURCES,
  LABEL_SUMMARY,
  LABEL_TASK,
  LABEL_TOPIC,
  LOCAL_FIRST,
  OBSIDIAN_FORMAT,
  REFERENCE_CITATIONS,
  ROLE,
  SOURCE_SAFETY,
  toneBlock,
  withProviderOutput,
  type FragmentPair
} from "../_shared/fragments";
import LanguageZH from "./language.zh.md";
import LanguageEN from "./language.en.md";
import JsonContractZH from "./json-contract.zh.md";
import JsonContractEN from "./json-contract.en.md";
import WebSearchOffZH from "./web-search-off.zh.md";
import WebSearchOffEN from "./web-search-off.en.md";
import WebSearchOnZH from "./web-search-on.zh.md";
import WebSearchOnEN from "./web-search-on.en.md";
import LabelDetailZH from "./label-detail.zh.md";
import LabelDetailEN from "./label-detail.en.md";
import LabelFindingsZH from "./label-findings.zh.md";
import LabelFindingsEN from "./label-findings.en.md";
import GuidanceStructuredZH from "./guidance-structured.zh.md";
import GuidanceStructuredEN from "./guidance-structured.en.md";
import GuidanceGapAuditZH from "./guidance-gap-audit.zh.md";
import GuidanceGapAuditEN from "./guidance-gap-audit.en.md";
import GuidancePlainZH from "./guidance-plain.zh.md";
import GuidancePlainEN from "./guidance-plain.en.md";
import PhaseResearchGapAuditZH from "./phase/research-gap-audit.zh.md";
import PhaseResearchGapAuditEN from "./phase/research-gap-audit.en.md";
import PhaseInitialClarificationZH from "./phase/initial-clarification.zh.md";
import PhaseInitialClarificationEN from "./phase/initial-clarification.en.md";
import PhaseInitialQuestionZH from "./phase/initial-question.zh.md";
import PhaseInitialQuestionEN from "./phase/initial-question.en.md";
import PhaseResearchPlanZH from "./phase/research-plan.zh.md";
import PhaseResearchPlanEN from "./phase/research-plan.en.md";
import PhaseResearchPlanRepairZH from "./phase/research-plan-repair.zh.md";
import PhaseResearchPlanRepairEN from "./phase/research-plan-repair.en.md";
import PhaseSubtopicResearchZH from "./phase/subtopic-research.zh.md";
import PhaseSubtopicResearchEN from "./phase/subtopic-research.en.md";
import PhaseTargetedFollowupResearchZH from "./phase/targeted-followup-research.zh.md";
import PhaseTargetedFollowupResearchEN from "./phase/targeted-followup-research.en.md";
import PhaseReportReviewZH from "./phase/report-review.zh.md";
import PhaseReportReviewEN from "./phase/report-review.en.md";
import PhaseDecisionQualityReviewZH from "./phase/decision-quality-review.zh.md";
import PhaseDecisionQualityReviewEN from "./phase/decision-quality-review.en.md";
import PhaseFormatRepairZH from "./phase/format-repair.zh.md";
import PhaseFormatRepairEN from "./phase/format-repair.en.md";
import PhaseDeliveryOutlineZH from "./phase/delivery-outline.zh.md";
import PhaseDeliveryOutlineEN from "./phase/delivery-outline.en.md";
import PhaseDeliveryResearchZH from "./phase/delivery-research.zh.md";
import PhaseDeliveryResearchEN from "./phase/delivery-research.en.md";
import PhaseDeliveryWritingZH from "./phase/delivery-writing.zh.md";
import PhaseDeliveryWritingEN from "./phase/delivery-writing.en.md";
import PhaseDeliveryAcceptanceZH from "./phase/delivery-acceptance.zh.md";
import PhaseDeliveryAcceptanceEN from "./phase/delivery-acceptance.en.md";

/**
 * The AIM prompt shell: the language line, shared rules, response contract, per-phase guidance and context labels.
 * Every text is a Markdown file in this folder (phase rules under phase/); the file's trailing newline is removed so
 * the text equals the string it replaced. The phase task text itself is built by the AIM experience, not here.
 */
const text = (template: string): string => renderTemplate(template, {});
const pair = (zh: string, en: string): FragmentPair => ({ zh: text(zh), en: text(en) });

/** A template, not text: {@link inLanguageNaming} fills `{{language}}` and `{{languagePlain}}` with the output language name. */
const LANGUAGE: FragmentPair = { zh: LanguageZH, en: LanguageEN };
const JSON_CONTRACT = pair(JsonContractZH, JsonContractEN);
const WEB_SEARCH_OFF = pair(WebSearchOffZH, WebSearchOffEN);
const WEB_SEARCH_ON = pair(WebSearchOnZH, WebSearchOnEN);
const LABEL_DETAIL = pair(LabelDetailZH, LabelDetailEN);
const LABEL_FINDINGS = pair(LabelFindingsZH, LabelFindingsEN);
const GUIDANCE_STRUCTURED = pair(GuidanceStructuredZH, GuidanceStructuredEN);
const GUIDANCE_GAP_AUDIT = pair(GuidanceGapAuditZH, GuidanceGapAuditEN);
const GUIDANCE_PLAIN = pair(GuidancePlainZH, GuidancePlainEN);

/** Phase rules keyed by the `aim-phase` marker; a phase without an entry (evidence-reuse-audit) has no rule. */
const PHASE_RULES: Readonly<Record<string, FragmentPair>> = {
  "research-gap-audit": pair(PhaseResearchGapAuditZH, PhaseResearchGapAuditEN),
  "initial-clarification": pair(PhaseInitialClarificationZH, PhaseInitialClarificationEN),
  "initial-question": pair(PhaseInitialQuestionZH, PhaseInitialQuestionEN),
  "research-plan": pair(PhaseResearchPlanZH, PhaseResearchPlanEN),
  "research-plan-repair": pair(PhaseResearchPlanRepairZH, PhaseResearchPlanRepairEN),
  "subtopic-research": pair(PhaseSubtopicResearchZH, PhaseSubtopicResearchEN),
  "targeted-followup-research": pair(PhaseTargetedFollowupResearchZH, PhaseTargetedFollowupResearchEN),
  "report-review": pair(PhaseReportReviewZH, PhaseReportReviewEN),
  "decision-quality-review": pair(PhaseDecisionQualityReviewZH, PhaseDecisionQualityReviewEN),
  "format-repair": pair(PhaseFormatRepairZH, PhaseFormatRepairEN),
  "delivery-outline": pair(PhaseDeliveryOutlineZH, PhaseDeliveryOutlineEN),
  "delivery-research": pair(PhaseDeliveryResearchZH, PhaseDeliveryResearchEN),
  "delivery-writing": pair(PhaseDeliveryWritingZH, PhaseDeliveryWritingEN),
  "delivery-acceptance": pair(PhaseDeliveryAcceptanceZH, PhaseDeliveryAcceptanceEN)
};

/** Phases whose detail is saved as a note the reader opens: research reports and the final document. */
const READER_FACING_PHASES: ReadonlySet<string> = new Set([
  "subtopic-research",
  "targeted-followup-research",
  "delivery-writing"
]);

/** Whether an AIM request's detail is saved as a note the reader opens. */
export function readerFacingAimPhase(phase: string | undefined): boolean {
  return !!phase && READER_FACING_PHASES.has(phase);
}

export function aimPhase(task: string): string | undefined {
  return task.match(/<!--\s*aim-phase:\s*([a-z-]+)\s*-->/)?.[1];
}

function phaseGuidance(
  phase: string | undefined,
  language: ContentLanguage,
  responseContract?: TaskContext["responseContract"],
  structured = false
): string {
  const gapAuditContract = phase === "research-gap-audit" && responseContract === "aim-gap-audit";
  const common = structured ? GUIDANCE_STRUCTURED : gapAuditContract ? GUIDANCE_GAP_AUDIT : GUIDANCE_PLAIN;
  const rule =
    phase && Object.prototype.hasOwnProperty.call(PHASE_RULES, phase) ? inLanguage(PHASE_RULES[phase], language) : "";
  return [inLanguage(common, language), rule].filter(Boolean).join("\n\n");
}

/** Builds the compact AIM prompt while retaining the regular AiResult JSON contract. */
export function buildAimPrompt(
  context: TaskContext,
  language: ContentLanguage,
  provider: AiProviderId = "codex"
): string {
  const phase = aimPhase(context.task);
  const field = (label: string, value: string | undefined) => (value?.trim() ? `${label}:\n${value}` : "");
  const blocks = [
    inLanguageNaming(LANGUAGE, language, { language: "region", languagePlain: "plain" }),
    inLanguage(ROLE, language),
    inLanguage(SOURCE_SAFETY, language),
    context.sourceContext ? inLanguage(REFERENCE_CITATIONS, language) : "",
    context.sourceContext && context.researchMode !== "local" ? inLanguage(LOCAL_FIRST, language) : "",
    withProviderOutput(inLanguage(JSON_CONTRACT, language), provider, language),
    context.toneText ? toneBlock(context.toneText, language) : "",
    phaseGuidance(phase, language, context.responseContract, !!context.aimContract),
    readerFacingAimPhase(phase) ? inLanguage(OBSIDIAN_FORMAT, language) : "",
    context.researchMode === "local"
      ? inLanguage(WEB_SEARCH_OFF, language)
      : context.researchMode === "research"
        ? inLanguage(WEB_SEARCH_ON, language)
        : "",
    field(inLanguage(LABEL_TOPIC, language), context.title),
    field(inLanguage(LABEL_SUMMARY, language), context.summary),
    context.detail ? `${inLanguage(LABEL_DETAIL, language)}:\n${context.detail}` : "",
    field(inLanguage(LABEL_RULES, language), context.rules),
    context.workingFindings ? `${inLanguage(LABEL_FINDINGS, language)}:\n${context.workingFindings}` : "",
    context.sourceContext ? `${inLanguage(LABEL_SOURCES, language)}:\n${context.sourceContext}` : "",
    field(inLanguage(LABEL_ANCESTORS, language), context.ancestors),
    field(inLanguage(LABEL_TASK, language), context.task)
  ];
  return blocks.filter(Boolean).join("\n\n");
}
