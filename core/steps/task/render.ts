import { aimPhase, buildAimPrompt, readerFacingAimPhase } from "../aim/shell";
import { researchGuidance } from "../../../ai/task-policy";
import type { TaskContext } from "../../../ai/types";
import { visualGuidance } from "../../../ai/visual-guidance";
import { noteLanguageOf, translate, type ContentLanguage, type FollowAnchor } from "../../../i18n";
import type { AiProviderId } from "../../../ai/providers/provider";
import { detailStructurePrompt, standardTemplate } from "../../../ai/detail-templates";
import {
  inLanguage,
  LABEL_ANCESTORS,
  LABEL_RULES,
  LABEL_SOURCES,
  LABEL_SUMMARY,
  LABEL_TASK,
  LABEL_TOPIC,
  LOCAL_FIRST,
  NONE,
  OBSIDIAN_FORMAT,
  REFERENCE_CITATIONS,
  quickKnowledge,
  ROLE,
  SOURCE_SAFETY,
  SOURCE_SAFETY_QUICK,
  toneBlock,
  withProviderOutput
} from "../_shared/fragments";
import {
  ADAPTIVE_DETAIL_STRUCTURE,
  DECOMPOSE,
  DEFAULT_TASK,
  detailStructure,
  GENERAL_TASK,
  JSON_CONTRACT,
  LABEL_DETAIL,
  LABEL_FINDINGS,
  MERGE,
  outputLanguage,
  SYNTHESIZE
} from "./fragments";

/** Whether the request's detail is written for the reader, so it gets the Obsidian syntax rules and heading levels. */
export function readerFacingDetail(context: TaskContext): boolean {
  return context.promptProfile === "aim"
    ? readerFacingAimPhase(aimPhase(context.task))
    : context.mode !== "decompose" && !context.intermediateDetail;
}

/**
 * A Quick map research or expansion (not a helper request, not AIM, not a count repair, not an intermediate extraction):
 * the model may answer from its own knowledge, so the source-safety and local-research texts are swapped for the Quick ones.
 */
export function isQuickTask(context: TaskContext): boolean {
  return (
    context.mapAiMode === "quick" &&
    context.researchMode === "local" &&
    (context.mode ?? "task") === "task" &&
    context.promptProfile !== "aim" &&
    !context.countRepair &&
    !context.intermediateDetail
  );
}

/** `researchGuidance` for a Quick task: the depth sentence as usual, then the Quick knowledge rule instead of `research.local`. */
function quickGuidance(context: TaskContext, language: ContentLanguage): string {
  const depth = translate(
    language,
    context.researchDepth === "fast"
      ? "research.fast"
      : context.researchDepth === "deep"
        ? "research.deep"
        : "research.normal"
  );
  return `${depth} ${quickKnowledge(language)}`;
}

/** The regular (non-AIM) task prompt. Empty blocks are kept, so the blank-line layout matches the original builder. */
export function generalTaskPrompt(
  context: TaskContext,
  language: ContentLanguage,
  provider: AiProviderId = "codex"
): string {
  const modeFragment =
    context.mode === "task"
      ? GENERAL_TASK
      : context.mode === "decompose"
        ? DECOMPOSE
        : context.mode === "synthesize"
          ? SYNTHESIZE
          : context.mode === "merge"
            ? MERGE
            : DEFAULT_TASK;
  const quick = isQuickTask(context);
  const none = inLanguage(NONE, language);
  const topicAnchor: FollowAnchor = { kind: "topic", text: context.title };
  return [
    outputLanguage(language, topicAnchor),
    inLanguage(ROLE, language),
    inLanguage(quick ? SOURCE_SAFETY_QUICK : SOURCE_SAFETY, language),
    context.sourceContext ? inLanguage(REFERENCE_CITATIONS, language) : "",
    context.sourceContext && context.researchMode !== "local" ? inLanguage(LOCAL_FIRST, language) : "",
    withProviderOutput(inLanguage(JSON_CONTRACT, language), provider, language),
    ...(context.toneText ? [toneBlock(context.toneText, language)] : []),
    inLanguage(modeFragment, language),
    context.mode !== "decompose"
      ? [
          context.detailFormat === "adaptive"
            ? inLanguage(ADAPTIVE_DETAIL_STRUCTURE, language)
            : detailStructurePrompt(
                context.detailTemplate ?? standardTemplate(noteLanguageOf(language)),
                language,
                headings => detailStructure(language, headings),
                topicAnchor
              ),
          // A merge keeps the sources' own formatting; the syntax suggestions would invite callouts the sources lack.
          readerFacingDetail(context) && context.mode !== "merge" ? inLanguage(OBSIDIAN_FORMAT, language) : ""
        ]
          .filter(Boolean)
          .join("\n\n")
      : "",
    quick ? quickGuidance(context, language) : researchGuidance(context, language),
    ...visualGuidance(context, language),
    `${inLanguage(LABEL_TOPIC, language)}:\n${context.title}`,
    `${inLanguage(LABEL_SUMMARY, language)}:\n${context.summary}`,
    context.mode !== "decompose" ? `${inLanguage(LABEL_DETAIL, language)}:\n${context.detail || none}` : "",
    `${inLanguage(LABEL_RULES, language)}:\n${context.rules || none}`,
    context.workingFindings ? `${inLanguage(LABEL_FINDINGS, language)}:\n${context.workingFindings}` : "",
    context.sourceContext ? `${inLanguage(LABEL_SOURCES, language)}:\n${context.sourceContext}` : "",
    `${inLanguage(LABEL_ANCESTORS, language)}:\n${context.ancestors || none}`,
    `${inLanguage(LABEL_TASK, language)}:\n${context.task}`
  ].join("\n\n");
}

/** AIM requests use the AIM prompt shell in core/steps/aim; its templates are Markdown files there. */
export function taskPrompt(context: TaskContext, language: ContentLanguage, provider: AiProviderId = "codex"): string {
  return context.promptProfile === "aim"
    ? buildAimPrompt(context, language, provider)
    : generalTaskPrompt(context, language, provider);
}
