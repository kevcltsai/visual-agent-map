import { researchGuidance } from "../../../ai/task-policy";
import type { TaskContext } from "../../../ai/types";
import { visualGuidance } from "../../../ai/visual-guidance";
import {
  detailStructurePrompt,
  isBuiltinTemplateId,
  standardTemplate,
  STANDARD_TEMPLATE_ID,
  textbookTemplate,
  TEXTBOOK_TEMPLATE_ID,
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
  headingsVerbatim,
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
  customDetailCallout,
  customDetailStructure,
  customDetailRule,
  DECOMPOSE,
  DEFAULT_TASK,
  detailStructure,
  GENERAL_TASK,
  JSON_CONTRACT,
  LABEL_DETAIL,
  LABEL_FINDINGS,
  MERGE,
  outputLanguage,
  SYNTHESIZE,
  textbookDetailStructure
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

/** A piece of the sections text the template block owns: `rule` is the plugin's sentence that carries `text`, when it wraps it. */
interface OwnedText {
  readonly text: string;
  readonly rule?: string;
}

/** What the template choice contributes: its sections text, and its format rules text (empty when the template has none). */
interface TemplateParts {
  readonly sections: string;
  /** The parts of `sections`, in order, that are the block's own words; the rest is the plugin's wrapper sentences. */
  readonly owned: readonly OwnedText[];
  readonly format: string;
}

const headingOf = (name: string): string => `### ${name}`;
const descriptionRule = (section: DetailTemplate["sections"][number], language: ContentLanguage): OwnedText => ({
  text: section.description.trim(),
  rule: customDetailRule("description", language, {
    heading: headingOf(section.name),
    description: section.description.trim()
  })
});
const describedSections = (template: DetailTemplate, language: ContentLanguage): OwnedText[] =>
  template.sections.filter(section => section.description.trim()).map(section => descriptionRule(section, language));

/**
 * The sections text of a template that opens with its own words (a lead): the lead as written, then the plugin's fixed
 * structure text (heading list, count, update log, description, count and callout rules, heading-language clause), the
 * same as a template without a lead (decision 26). It never takes the Textbook id's own wording, because the lead is
 * the block's own words.
 */
function leadStructure(
  template: DetailTemplate,
  lead: string,
  language: ContentLanguage,
  anchor: FollowAnchor
): { sections: string; owned: OwnedText[] } {
  const rules: string[] = [];
  for (const section of template.sections) {
    const heading = headingOf(section.name);
    if (section.role === "log") rules.push(customDetailRule("log", language, { heading }));
    if (section.description.trim()) rules.push(descriptionRule(section, language).rule!);
    if (section.count)
      rules.push(customDetailRule(section.count.mode, language, { heading, n: String(section.count.n) }));
    for (const callout of section.callouts ?? [])
      rules.push(
        customDetailCallout(language, {
          heading,
          type: callout.type,
          fold: callout.fold,
          body: callout.body.replace(/\s*\n\s*/g, " ").trim()
        })
      );
  }
  const structure = customDetailStructure(language, {
    count: String(template.sections.length),
    headings: template.sections.map(section => headingOf(section.name)).join(", "),
    rules: rules.length ? `\n${rules.join("\n")}` : ""
  });
  const verbatim = headingsVerbatim(language, undefined, !isBuiltinTemplateId(template.id), anchor);
  return {
    sections: [lead, structure, verbatim].filter(Boolean).join("\n"),
    owned: [{ text: lead }, ...describedSections(template, language)]
  };
}

/**
 * Resolves the template choice. A built-in template that is not modified (no body, or a body equal to the built-in
 * text) takes today's path: today's template object and format fragment. A modified body goes through the parser and is
 * put together from what the text holds: a lead, the sections, the format rules; the Textbook id has no part in it.
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
    const owned = describedSections(today, language);
    // Today's Textbook structure text is the text of its template block's lead.
    if (today.id === TEXTBOOK_TEMPLATE_ID && today.layout !== "intro") {
      const log = today.sections.find(section => section.role === "log") ?? today.sections[today.sections.length - 1];
      owned.unshift({
        text: textbookDetailStructure(language, {
          headings: today.sections.map(section => headingOf(section.name)).join(", "),
          log: headingOf(log.name)
        })
      });
    }
    return { sections: structure(today), owned, format: inLanguage(OBSIDIAN_FORMAT, language) };
  }
  const parsed = parseTemplateBlock(body, { id, name: id });
  if (!parsed.ok) {
    const issue = parsed.issues[0];
    throw new Error(`Template block ${id}: line ${issue.line}: ${issue.message}`);
  }
  if (parsed.lead)
    return { ...leadStructure(parsed.template, parsed.lead, language, topicAnchor), format: parsed.format };
  // No lead: the standard wrapper sentence for the standard id, else the generic one. The generic one must not take the
  // Textbook id's fixed structure text, so a Textbook-named block is put together under a neutral id.
  const template =
    parsed.template.id === STANDARD_TEMPLATE_ID ? parsed.template : { ...parsed.template, id: `block-${id}` };
  return { sections: structure(template), owned: describedSections(template, language), format: parsed.format };
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
    const pieces: Piece[][] = [];
    if (selection.template.adaptive)
      pieces.push([fixed(inLanguage(ADAPTIVE_DETAIL_STRUCTURE, language), "adaptive-detail-structure")]);
    else pieces.push(sectionPieces(parts, selection.template.id));
    // A merge keeps the sources' own formatting; the syntax suggestions would invite callouts the sources lack.
    if (readerFacingDetail(context) && step !== "merge") {
      const text = formatText(parts, selection, language);
      if (text)
        pieces.push([[text, { kind: "block", category: "template", id: selection.template.id, part: "format" }]]);
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

/**
 * The sections text as pieces: the block's own words (lead, descriptions) are block segments, the plugin's wrapper
 * sentences between them are fixed segments. The text is the same; only the cut differs.
 */
function sectionPieces(parts: TemplateParts, id: string): Piece[] {
  const text = parts.sections;
  const block = (part: string): Piece => [part, { kind: "block", category: "template", id, part: "sections" }];
  const pieces: Piece[] = [];
  let cursor = 0;
  for (const item of parts.owned) {
    if (!item.text) continue;
    const at = text.indexOf(item.rule ?? item.text, cursor);
    if (at < 0) continue;
    const start = item.rule ? at + item.rule.lastIndexOf(item.text) : at;
    if (start > cursor) pieces.push(fixed(text.slice(cursor, start), "detail-structure"));
    pieces.push(block(item.text));
    cursor = start + item.text.length;
  }
  if (!pieces.length) return [block(text)];
  if (cursor < text.length) pieces.push(fixed(text.slice(cursor), "detail-structure"));
  return pieces;
}

/** The groups of one element joined by the sections-to-format blank line. */
function withSeparators(groups: Piece[][]): Piece[] {
  return groups.flatMap((group, index): Piece[] => (index > 0 ? [["\n\n", { kind: "separator" }], ...group] : group));
}
