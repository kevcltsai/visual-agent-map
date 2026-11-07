import type { AiProviderId } from "../../ai/providers/provider";
import type { TaskContext } from "../../ai/types";
import { translate, type ContentLanguage, type TranslationKey } from "../../i18n";
import { assembledTaskPrompt } from "../steps/task/render";
import type { AssembledPrompt, BlockIssue, PromptSegment } from "../steps/task/assemble";

/** The five steps whose full prompt can be previewed, each with the translation key of its name. */
export type PreviewStep = "research" | "quick" | "decompose" | "synthesize" | "merge";
export const PREVIEW_STEPS: readonly { readonly id: PreviewStep; readonly nameKey: TranslationKey }[] = [
  { id: "research", nameKey: "ui.preview_step_research" },
  { id: "quick", nameKey: "ui.preview_step_quick" },
  { id: "decompose", nameKey: "ui.preview_step_decompose" },
  { id: "synthesize", nameKey: "ui.preview_step_synthesize" },
  { id: "merge", nameKey: "ui.preview_step_merge" }
];

/** The style fields of a request (what the map view spreads into a TaskContext) that the preview takes as they are. */
export type PreviewStyleFields = Pick<TaskContext, "detailTemplate" | "toneText" | "styleSelection" | "aiSections">;

/** Where a part of the prompt belongs in the preview: the group a heading names. */
export type PreviewGroup = "role" | "template" | "tone" | "fixed" | "input";
export interface PreviewSection {
  readonly group: PreviewGroup;
  readonly text: string;
}
export interface PromptPreview {
  readonly text: string;
  readonly sections: readonly PreviewSection[];
  readonly issues: readonly BlockIssue[];
}

/** A task request for `step` with sample inputs (translated), and the given style fields; it is what a real run would send. */
export function sampleTaskContext(
  step: PreviewStep,
  language: ContentLanguage,
  styleFields: PreviewStyleFields
): TaskContext {
  const sample = (suffix: string): string => translate(language, `ui.preview_sample_${suffix}` as TranslationKey);
  const mode = step === "research" || step === "quick" ? "task" : step;
  return {
    title: sample("title"),
    summary: sample("summary"),
    rules: sample("rules"),
    detail: sample("detail"),
    task: sample("task"),
    ancestors: sample("ancestors"),
    workingFindings: sample("findings"),
    sourceContext: sample("sources"),
    outputLanguage: language,
    mode,
    researchMode: step === "research" ? "research" : "local",
    researchDepth: "normal",
    visualMode: step === "research" ? "auto" : "off",
    ...(step === "quick" ? { mapAiMode: "quick" as const } : {}),
    ...styleFields
  };
}

/** The group of one segment. A separator belongs to the part before it (the caller handles it). */
function groupOf(segment: PromptSegment): PreviewGroup {
  const { source } = segment;
  switch (source.kind) {
    case "block":
      return source.category === "template" ? "template" : "tone";
    case "input":
      return "input";
    case "fixed":
      return source.id === "role" || source.id === "step" ? "role" : "fixed";
    default:
      return "fixed";
  }
}

/**
 * The prompt cut into groups in its own order: neighbours of the same group join, a group may come back later, and a
 * separator joins the part before it. The sections joined are exactly `assembled.text`.
 */
export function previewSections(assembled: AssembledPrompt): PreviewSection[] {
  const sections: { group: PreviewGroup; text: string }[] = [];
  for (const segment of assembled.segments) {
    const last = sections[sections.length - 1];
    if (segment.source.kind === "separator" && last) {
      last.text += segment.text;
      continue;
    }
    const group = groupOf(segment);
    if (last && last.group === group) last.text += segment.text;
    else sections.push({ group, text: segment.text });
  }
  return sections;
}

/** The full prompt of `step` as the model would get it for the sample inputs, with its groups and any block that was replaced. */
export function previewPrompt(
  step: PreviewStep,
  language: ContentLanguage,
  provider: AiProviderId,
  styleFields: PreviewStyleFields
): PromptPreview {
  const assembled = assembledTaskPrompt(sampleTaskContext(step, language, styleFields), language, provider);
  return { text: assembled.text, sections: previewSections(assembled), issues: assembled.issues };
}
