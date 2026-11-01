import { researchGuidance } from "../../../ai/task-policy";
import type { TaskContext } from "../../../ai/types";
import { visualGuidance } from "../../../ai/visual-guidance";
import {
  detailStructurePrompt,
  standardTemplate,
  textbookTemplate,
  type DetailTemplate
} from "../../../ai/detail-templates";
import { noteLanguageOf, type ContentLanguage, type FollowAnchor } from "../../../i18n";
import type { AiProviderId } from "../../../ai/providers/provider";
import { normalizeStyleContent } from "../../../ai/note-style-file";
import {
  BUILTIN_BLOCKS,
  builtinTemplateText,
  findBuiltinBlock,
  lookupBuiltinBlock,
  type BlockCategory
} from "../../blocks/builtin";
import { parseTemplateBlock } from "../../blocks/template-block";
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
  OBSIDIAN_FORMAT,
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

/** The zone of a template block a segment holds: its sections, or its format rules. */
export type BlockPart = "sections" | "format";

/** Where a piece of the prompt comes from: a style block, a fixed plugin part, the task's own input, or the blank line between parts. */
export type SegmentSource =
  | { kind: "block"; category: BlockCategory; id: string; part?: BlockPart }
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
  /** Whether the template asks for charts: its sections or format rules hold a mermaid code block. */
  readonly charts: boolean;
}

/** One chosen block. `body` is an inline text for a block outside the registry (a tone text from an old style file). */
export interface BlockChoice {
  readonly id: string;
  readonly body?: string;
}
export interface StyleSelection {
  /**
   * `body` is the whole template text (sections zone, then the format rules zone) when the choice is not the unchanged
   * built-in. `adaptive`: the detail has no fixed sections, the plugin's adaptive structure text stands in for the
   * sections. `legacyPreferences`: the old note style file switches, applied to the format rules zone.
   */
  readonly template: BlockChoice & {
    readonly adaptive?: boolean;
    readonly legacyPreferences?: FormatPreferences;
  };
  /** Academic rigor (the empty tone) is the default. */
  readonly tone: BlockChoice;
}
export interface AssembleOptions {
  /** Test injection: block bodies by `category/id` (a template's body is its whole text); the real path uses the built-in registry only. */
  readonly blocks?: Readonly<Record<string, (language: ContentLanguage) => string>>;
}

const CUSTOM_LEGACY_TONE = "custom-legacy";
const DEFAULT_TONE = "academic";
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

/** The choice today's request fields stand for: a template and a tone block, with the old style switches riding on the template. */
export function selectionFromContext(context: TaskContext, language: ContentLanguage): StyleSelection {
  const templateId = context.detailTemplate?.id ?? standardTemplate(noteLanguageOf(language)).id;
  const toneText = context.toneText;
  const builtinTone = toneText
    ? ["plain", "magazine", "summary", "guide", "auto"].find(
        id => lookupBuiltinBlock("tone", id, language) === toneText
      )
    : undefined;
  return {
    template: {
      id: templateId,
      ...(context.detailFormat === "adaptive" ? { adaptive: true } : {}),
      ...(context.noteStyle ? { legacyPreferences: context.noteStyle } : {})
    },
    tone: !toneText
      ? { id: DEFAULT_TONE }
      : builtinTone
        ? { id: builtinTone }
        : { id: CUSTOM_LEGACY_TONE, body: toneText }
  };
}

/** What the template choice contributes: its sections text, and its format rules text (empty when the template has none). */
interface TemplateParts {
  readonly sections: string;
  readonly format: string;
}

/**
 * Resolves the template choice. A built-in template that is not modified (no body, or a body equal to the built-in
 * text) takes today's path: today's template object and format fragment. A modified body goes through the parser.
 */
function templateParts(
  selection: StyleSelection,
  context: TaskContext,
  language: ContentLanguage,
  topicAnchor: FollowAnchor,
  options: AssembleOptions
): TemplateParts {
  const { id } = selection.template;
  const legacy = context.detailTemplate?.id === id;
  const body = selection.template.body ?? options.blocks?.[`template/${id}`]?.(language);
  // Without a body the id must be a built-in (or the request's own old template); a body may belong to any id.
  const builtin =
    legacy || body !== undefined
      ? BUILTIN_BLOCKS.find(block => block.category === "template" && block.id === id)
      : findBuiltinBlock("template", id);
  const unmodified =
    body === undefined ||
    (builtin !== undefined && normalizeStyleContent(body) === normalizeStyleContent(builtinTemplateText(id, language)));
  const structure = (template: DetailTemplate) =>
    detailStructurePrompt(template, language, headings => detailStructure(language, headings), topicAnchor);
  if (unmodified) {
    const today =
      context.detailTemplate ?? (id === "textbook" ? textbookTemplate : standardTemplate)(noteLanguageOf(language));
    return { sections: structure(today), format: inLanguage(OBSIDIAN_FORMAT, language) };
  }
  const parsed = parseTemplateBlock(body, { id, name: id });
  if (!parsed.ok) {
    const issue = parsed.issues[0];
    throw new Error(`Template block ${id}: line ${issue.line}: ${issue.message}`);
  }
  return { sections: structure(parsed.template), format: parsed.format };
}

/** The format rules the prompt carries for the template: the zone with the old note style switches applied. */
const formatText = (parts: TemplateParts, selection: StyleSelection, language: ContentLanguage): string =>
  parts.format ? applyFormatPreferences(parts.format, language, selection.template.legacyPreferences) : "";

const CHART_BLOCK = "```mermaid";

/** Whether the template (sections and format rules, with the old switches applied) asks for a mermaid diagram. */
export function chartsWanted(
  selection: StyleSelection,
  context: TaskContext,
  language: ContentLanguage,
  options: AssembleOptions = {}
): boolean {
  const parts = templateParts(selection, context, language, { kind: "topic", text: context.title }, options);
  // An adaptive detail has no fixed sections: only the format rules can ask for a chart.
  const sections = selection.template.adaptive ? "" : parts.sections;
  return sections.includes(CHART_BLOCK) || formatText(parts, selection, language).includes(CHART_BLOCK);
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
  {
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
    const parts = templateParts(selection, context, language, topicAnchor, options);
    const pieces: Piece[] = [];
    const sections = (text: string): Piece => [
      text,
      { kind: "block", category: "template", id: selection.template.id, part: "sections" }
    ];
    if (selection.template.adaptive)
      pieces.push(fixed(inLanguage(ADAPTIVE_DETAIL_STRUCTURE, language), "adaptive-detail-structure"));
    else pieces.push(sections(parts.sections));
    // A merge keeps the sources' own formatting; the syntax suggestions would invite callouts the sources lack.
    if (readerFacingDetail(context) && step !== "merge") {
      const text = formatText(parts, selection, language);
      if (text) pieces.push([text, { kind: "block", category: "template", id: selection.template.id, part: "format" }]);
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
  return {
    text: segments.map(segment => segment.text).join(""),
    segments,
    charts: chartsWanted(selection, context, language, options)
  };
}

/** The pieces of one element joined by the sections-to-format blank line. */
function withSeparators(pieces: Piece[]): Piece[] {
  return pieces.flatMap((piece, index): Piece[] => (index > 0 ? [["\n\n", { kind: "separator" }], piece] : [piece]));
}
