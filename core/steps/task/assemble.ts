import { researchGuidance } from "../../../ai/task-policy";
import type { TaskContext } from "../../../ai/types";
import { visualGuidance } from "../../../ai/visual-guidance";
import { detailStructurePrompt, standardTemplate, textbookTemplate } from "../../../ai/detail-templates";
import { noteLanguageOf, type ContentLanguage, type FollowAnchor } from "../../../i18n";
import type { AiProviderId } from "../../../ai/providers/provider";
import { findBuiltinBlock, lookupBuiltinBlock, type BlockCategory } from "../../blocks/builtin";
import {
  applyFormatPreferences,
  inLanguage,
  LABEL_ANCESTORS,
  LABEL_RULES,
  LABEL_SOURCES,
  LABEL_SUMMARY,
  LABEL_SUMMARY_DIRECTION,
  LABEL_TASK,
  LABEL_TOPIC,
  LABEL_USER_TEXT,
  LOCAL_FIRST,
  NONE,
  REFERENCE_CITATIONS,
  ROLE,
  ROLE_QUICK,
  SOURCE_SAFETY,
  SOURCE_SAFETY_QUICK,
  toneBlock,
  withProviderOutput,
  type FormatPreferences
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
import { isQuickTask, quickGuidance, readerFacingDetail } from "./render";

/** Which task step a prompt is for; `default` is a request without a mode. */
export type PromptStep = "research" | "quick" | "decompose" | "synthesize" | "merge" | "default";

/** Where a piece of the prompt comes from: a style block, a fixed plugin part, the task's own input, or the blank line between parts. */
export type SegmentSource =
  | { kind: "block"; category: BlockCategory; id: string }
  | { kind: "fixed"; id: string }
  | { kind: "input"; id: string }
  | { kind: "separator" };
export interface PromptSegment {
  readonly text: string;
  readonly source: SegmentSource;
}
/** The assembled prompt: `segments` joined are exactly `text`. */
export interface AssembledPrompt {
  readonly text: string;
  readonly segments: readonly PromptSegment[];
}

/** One chosen block. `body` is an inline text for a block outside the registry (a tone text from an old style file). */
export interface BlockChoice {
  readonly id: string;
  readonly body?: string;
}
export interface StyleSelection {
  /** `adaptive`: the detail has no fixed sections, the plugin's adaptive structure text stands in for the template. */
  readonly template: BlockChoice & { readonly adaptive?: boolean };
  readonly tone?: BlockChoice;
  /** `preferences`: the old note style file switches, applied to the format body (moves into real blocks later). */
  readonly format: BlockChoice & { readonly legacyPreferences?: FormatPreferences };
}
export interface AssembleOptions {
  /** Test injection: block bodies by `category/id`; the real path uses the built-in registry only. */
  readonly blocks?: Readonly<Record<string, (language: ContentLanguage) => string>>;
}

const CUSTOM_LEGACY_TONE = "custom-legacy";
const TONE_MARKER = "\u0000tone\u0000";

export function promptStepOf(context: TaskContext): PromptStep {
  if (isQuickTask(context)) return "quick";
  switch (context.mode) {
    case "task":
      return "research";
    case "decompose":
    case "synthesize":
    case "merge":
      return context.mode;
    default:
      return "default";
  }
}

/** The choice today's request fields stand for: template, tone and format blocks, with the old style switches riding on the format. */
export function selectionFromContext(context: TaskContext, language: ContentLanguage): StyleSelection {
  const templateId = context.detailTemplate?.id ?? standardTemplate(noteLanguageOf(language)).id;
  const toneText = context.toneText;
  const builtinTone = toneText
    ? ["plain", "magazine", "summary", "guide", "auto"].find(
        id => lookupBuiltinBlock("tone", id, language) === toneText
      )
    : undefined;
  return {
    template: { id: templateId, ...(context.detailFormat === "adaptive" ? { adaptive: true } : {}) },
    ...(toneText ? { tone: builtinTone ? { id: builtinTone } : { id: CUSTOM_LEGACY_TONE, body: toneText } } : {}),
    format: { id: "standard-obsidian", ...(context.noteStyle ? { legacyPreferences: context.noteStyle } : {}) }
  };
}

type Piece = readonly [string, SegmentSource];
const fixed = (text: string, id: string): Piece => [text, { kind: "fixed", id }];
const input = (text: string, id: string): Piece => [text, { kind: "input", id }];

/**
 * Builds the regular task prompt from a style selection and the task's inputs. The parts and the empty-part layout are the
 * original builder's, so the default selection reproduces its text exactly; every part is also returned with its source.
 */
export function assembleTaskPrompt(
  selection: StyleSelection,
  step: PromptStep,
  context: TaskContext,
  language: ContentLanguage,
  provider: AiProviderId = "codex",
  options: AssembleOptions = {}
): AssembledPrompt {
  const bodyOf = (category: BlockCategory, id: string): string => {
    findBuiltinBlock(category, id);
    return options.blocks?.[`${category}/${id}`]?.(language) ?? lookupBuiltinBlock(category, id, language);
  };
  const modeFragment =
    step === "research" || (step === "quick" && context.mode === "task")
      ? GENERAL_TASK
      : step === "decompose"
        ? DECOMPOSE
        : step === "synthesize"
          ? SYNTHESIZE
          : step === "merge"
            ? MERGE
            : DEFAULT_TASK;
  const quick = step === "quick";
  const none = inLanguage(NONE, language);
  const topicAnchor: FollowAnchor = { kind: "topic", text: context.title };
  // Each element is a list of pieces; elements are joined by a blank line, and an empty element still takes its place.
  const elements: Piece[][] = [];
  const add = (...pieces: Piece[]) => elements.push(pieces);
  add(fixed(outputLanguage(language, topicAnchor), "output-language"));
  add(fixed(inLanguage(quick ? ROLE_QUICK : ROLE, language), "role"));
  add(fixed(inLanguage(quick ? SOURCE_SAFETY_QUICK : SOURCE_SAFETY, language), "source-safety"));
  add(fixed(context.sourceContext ? inLanguage(REFERENCE_CITATIONS, language) : "", "reference-citations"));
  add(
    fixed(
      context.sourceContext && context.researchMode !== "local" ? inLanguage(LOCAL_FIRST, language) : "",
      "local-first"
    )
  );
  add(fixed(withProviderOutput(inLanguage(JSON_CONTRACT, language), provider, language), "json-contract"));
  if (selection.tone) {
    const body = selection.tone.body ?? bodyOf("tone", selection.tone.id);
    // An empty tone body (academic rigor) adds nothing, not even the tone rule sentence.
    if (body) {
      const block: SegmentSource = { kind: "block", category: "tone", id: selection.tone.id };
      const [before, after] = toneBlock(TONE_MARKER, language).split(TONE_MARKER);
      add(fixed(before ?? "", "tone-rule"), [body, block], fixed(after ?? "", "tone-rule"));
    }
  }
  add(fixed(inLanguage(modeFragment, language), "step"));
  if (step === "decompose") add(fixed("", "template"));
  else {
    const pieces: Piece[] = [];
    if (selection.template.adaptive)
      pieces.push(fixed(inLanguage(ADAPTIVE_DETAIL_STRUCTURE, language), "adaptive-detail-structure"));
    else {
      const template =
        context.detailTemplate ??
        (selection.template.id === "textbook" ? textbookTemplate : standardTemplate)(noteLanguageOf(language));
      pieces.push([
        detailStructurePrompt(template, language, headings => detailStructure(language, headings), topicAnchor),
        { kind: "block", category: "template", id: selection.template.id }
      ]);
    }
    // A merge keeps the sources' own formatting; the syntax suggestions would invite callouts the sources lack.
    if (readerFacingDetail(context) && step !== "merge") {
      const text = applyFormatPreferences(
        bodyOf("format", selection.format.id),
        language,
        selection.format.legacyPreferences
      );
      if (text) pieces.push([text, { kind: "block", category: "format", id: selection.format.id }]);
    }
    add(...withSeparators(pieces));
  }
  add(fixed(quick ? quickGuidance(context, language) : researchGuidance(context, language), "research-guidance"));
  for (const guidance of visualGuidance(context, language)) add(fixed(guidance, "visual-guidance"));
  add(input(`${inLanguage(LABEL_TOPIC, language)}:\n${context.title}`, "topic"));
  add(input(`${inLanguage(LABEL_SUMMARY, language)}:\n${context.summary}`, "summary"));
  add(input(step !== "decompose" ? `${inLanguage(LABEL_DETAIL, language)}:\n${context.detail || none}` : "", "detail"));
  add(input(`${inLanguage(LABEL_RULES, language)}:\n${context.rules || none}`, "rules"));
  add(
    input(
      context.workingFindings ? `${inLanguage(LABEL_FINDINGS, language)}:\n${context.workingFindings}` : "",
      "findings"
    )
  );
  add(
    input(context.sourceContext ? `${inLanguage(LABEL_SOURCES, language)}:\n${context.sourceContext}` : "", "sources")
  );
  if (context.userTexts) add(input(`${inLanguage(LABEL_USER_TEXT, language)}:\n${context.userTexts}`, "user-texts"));
  if (context.summaryDirections)
    add(input(`${inLanguage(LABEL_SUMMARY_DIRECTION, language)}:\n${context.summaryDirections}`, "summary-directions"));
  add(input(`${inLanguage(LABEL_ANCESTORS, language)}:\n${context.ancestors || none}`, "ancestors"));
  add(input(`${inLanguage(LABEL_TASK, language)}:\n${context.task}`, "task"));

  const segments: PromptSegment[] = [];
  elements.forEach((pieces, index) => {
    if (index > 0) segments.push({ text: "\n\n", source: { kind: "separator" } });
    for (const [text, source] of pieces) if (text) segments.push({ text, source });
  });
  return { text: segments.map(segment => segment.text).join(""), segments };
}

/** The pieces of one element joined by the template-to-format blank line. */
function withSeparators(pieces: Piece[]): Piece[] {
  return pieces.flatMap((piece, index): Piece[] => (index > 0 ? [["\n\n", { kind: "separator" }], piece] : [piece]));
}
