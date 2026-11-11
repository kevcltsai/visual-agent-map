import { estimateTokens } from "../../../ai/context-builder";
import { translate, uiLocale, type ContentLanguage } from "../../../i18n";
import { inLanguage, inLanguageNaming } from "../_shared/fragments";
import type { ReasoningLevel } from "../../../ai/types";
import {
  cleanOutlineSummary,
  OUTLINE_NODE_LIMIT,
  parseOutline,
  sanitizeOutlineDraft,
  type OutlineLimits,
  type OutlineNode
} from "../../../experiences/visual-map/outline-import";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import languageEn from "./language.en.md";
import languageZh from "./language.zh.md";
import limitsEn from "./limits.en.md";
import limitsZh from "./limits.zh.md";
import expandDirection from "./expand-direction.md";
import expandTemplate from "./expand.md";
import template from "./prompt.md";
import sourceBlock from "./source-block.md";
import sourceChildren from "./source-children.md";
import sourceNote from "./source-note.md";
import summaryBasis from "./summary-basis.md";
import summaryBasisNote from "./summary-basis-note.md";
import topicLineEn from "./topic-line.en.md";
import topicLineZh from "./topic-line.zh.md";

export interface OutlineGenerateRequest {
  /** Trusted: the map file this request belongs to, for token-usage accounting only; never serialized into a prompt. */
  usageMapPath?: string;
  topic: string;
  /** The preset's instruction text; may contain a topic placeholder. */
  presetText: string;
  language: ContentLanguage;
  /** Language of the prompt and model output; defaults to `language`, which stays the interface language for errors. */
  contentLanguage?: ContentLanguage;
  model: string;
  reasoning: ReasoningLevel;
  /** Quick explore's chosen levels and size; they override the preset's own and are enforced after parsing. */
  limits?: OutlineLimits;
  /** Untrusted: the topic's current note body, quoted as data in the prompt (expansion only). Blank = none. */
  noteDetail?: string;
  /** Untrusted: titles of the topic's current subtopics, quoted as data; the outline must not repeat them. */
  existingChildren?: string[];
  /**
   * Expansion from the note (the topic chat's Expand): the note is the main source and the preset is not used. The owner's own
   * words (`direction`, may be blank) come first in the prompt. A blank note is refused (`empty_note`), never made up.
   */
  fromNote?: boolean;
  direction?: string;
}
export interface OutlineGenerateResult {
  /** Heading-only Markdown (fence removed, summary lines taken out), ready for the outline textarea and `parseOutline`. */
  markdown: string;
  /** The headings in order; each carries the AI's one-line `summary` (the reply is refused when any heading lacks one). */
  nodes: OutlineNode[];
}
export type OutlineGenerateErrorCode =
  | "empty_topic"
  | "over_budget"
  /** The request carries a note or existing subtopics and exceeds the budget: refused whole, never truncated. */
  | "note_too_long"
  /** Expansion from the note, and the note is blank: nothing to expand from. */
  | "empty_note"
  | "stopped"
  | "invalid"
  | "no_headings"
  | "non_heading"
  | "too_many"
  | "missing_summary";
/** Typed failure of outline generation; `message` is already localized. */
export class OutlineGenerateError extends Error {
  constructor(
    readonly code: OutlineGenerateErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OutlineGenerateError";
  }
}

/** The topic placeholders a preset may contain (Traditional Chinese and English); the English one is case-insensitive. */
export const OUTLINE_TOPIC_PLACEHOLDERS: readonly string[] = ["{填入研究主題}", "{research topic}"];
export const OUTLINE_GENERATE_TOKEN_BUDGET = 32_000;
const PLACEHOLDER_PATTERN = new RegExp(
  OUTLINE_TOPIC_PLACEHOLDERS.map(item => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "gi"
);

/**
 * Put the topic into the preset. Every placeholder is replaced by the topic as a JSON string, so the model sees it
 * as quoted data; a preset without a placeholder gets a labelled topic line appended.
 */
export function applyTopicToPreset(presetText: string, topic: string, language: ContentLanguage): string {
  const quoted = JSON.stringify(topic.trim());
  PLACEHOLDER_PATTERN.lastIndex = 0;
  if (PLACEHOLDER_PATTERN.test(presetText)) return presetText.replace(PLACEHOLDER_PATTERN, () => quoted);
  const line = renderTemplate(inLanguage({ zh: topicLineZh, en: topicLineEn }, language), { topic: quoted });
  return `${presetText.trimEnd()}\n\n${line}`;
}

/** The note and existing subtopics a request carries (blank note and blank titles dropped). */
function noteInputs(request: OutlineGenerateRequest): { note: string; children: string[] } {
  return {
    note: request.noteDetail?.trim() ? request.noteDetail : "",
    children: (request.existingChildren ?? []).map(item => item.trim()).filter(Boolean)
  };
}
/** The block placed before the preset: the note and subtopics as quoted, untrusted data. Empty when there are neither. */
function noteSection(request: OutlineGenerateRequest): string {
  const { note, children } = noteInputs(request);
  if (!note && !children.length) return "";
  return `${renderTemplate(sourceBlock, {
    note: note ? `\n${renderTemplate(sourceNote, { json: JSON.stringify(note) })}` : "",
    children: children.length ? `\n${renderTemplate(sourceChildren, { json: JSON.stringify(children) })}` : ""
  })}\n\n`;
}

const WRAPPING_FENCE = /^(`{3,}|~{3,})[ \t]*[\w-]*[ \t]*\n([\s\S]*?)\n[ \t]*\1[`~]*[ \t]*$/;
/** Remove one fence that wraps the whole reply; anything else is left for the parser to judge. */
export function stripWrappingFence(raw: string): string {
  const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n?/g, "\n").trim();
  const match = WRAPPING_FENCE.exec(text);
  return match ? match[2] : text;
}

const REPLY_HEADING = /^ {0,3}#{1,6}(?:[ \t]+.*)?$/;
const REPLY_SUMMARY = /^ {0,3}>[ \t]?(.*)$/;
/**
 * Take the summary lines out of a reply: a `>` line directly under a heading line is that heading's summary. Every
 * other `>` line stays in the text, where `parseOutline` counts it as a non-heading line. Returns the heading-only
 * text and, per heading in order, its summary (empty string for a bare `>`, undefined for none).
 */
function splitSummaries(text: string): { text: string; summaries: (string | undefined)[] } {
  const kept: string[] = [];
  const summaries: (string | undefined)[] = [];
  let afterHeading = false;
  let gap = false; // blank line(s) right after a heading line
  for (const line of text.split("\n")) {
    const quote = REPLY_SUMMARY.exec(line);
    if (quote && afterHeading) {
      summaries[summaries.length - 1] = quote[1].trim();
      afterHeading = false;
      continue;
    }
    if (quote && gap) {
      // Heading, blank line, `>`: still rejected, but as a missing summary so the retry runs (the heading stays without one).
      gap = false;
      continue;
    }
    gap = (afterHeading || gap) && line.trim() === "";
    afterHeading = REPLY_HEADING.test(line);
    if (afterHeading) summaries.push(undefined);
    kept.push(line);
  }
  return { text: kept.join("\n"), summaries };
}

const HEADING_LEVEL = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
/**
 * A reply that forgot its root (it starts with the summary line or with `##` headings) or that has several top-level headings
 * gets the topic itself as the root: a leading `> ` line becomes the root's summary, and several top-level headings are
 * moved one level down. A reply with one top-level heading is left exactly as it is. Without a `rootTitle` nothing changes.
 */
function ensureRoot(text: string, rootTitle?: string): string {
  const title = rootTitle?.replace(/\s+/g, " ").trim();
  if (!title) return text;
  const lines = text.split("\n");
  const levels = lines.map(line => HEADING_LEVEL.exec(line)?.[1].length ?? 0);
  const headings = levels.filter(Boolean);
  if (!headings.length) return text;
  const top = Math.min(...headings);
  if (top === 1 && headings.filter(level => level === 1).length === 1) return text;
  const first = levels.findIndex(Boolean);
  let summary = title;
  let rest = lines;
  const lead = lines.slice(0, first).filter(line => line.trim());
  if (lead.length === 1 && REPLY_SUMMARY.test(lead[0])) {
    summary = REPLY_SUMMARY.exec(lead[0])?.[1].trim() || title;
    rest = lines.slice(first);
  }
  const body = top === 1 ? rest.map(line => (HEADING_LEVEL.test(line) ? line.replace(/^( {0,3})#/, "$1##") : line)) : rest;
  return [`# ${title}`, `> ${summary}`, ...body].join("\n");
}

/**
 * Accept only heading Markdown where each heading line is followed by one `> summary` line: wrapping fence removed,
 * summary lines taken out, headings cleaned with `sanitizeOutlineDraft`, then `parseOutline` (not relaxed). Anything the
 * parser reports as an error, any non-heading line (a `>` line anywhere but right under a heading included), comment,
 * fenced block or front matter, no heading at all, more than the 100-heading limit, or a heading (the root too) without
 * a non-empty summary rejects the whole reply.
 */
export function parseOutlineReply(raw: string, language: ContentLanguage, rootTitle?: string): OutlineGenerateResult {
  const locale = uiLocale(language);
  const split = splitSummaries(ensureRoot(stripWrappingFence(raw), rootTitle));
  // A heading title that would break a note (unpaired [[ ]], an escaped fence) is cleaned here, as the outline box does,
  // so one such heading does not fail the whole AI reply; the user's own pasted outline still goes through the strict parser.
  const text = sanitizeOutlineDraft(split.text);
  const parsed = parseOutline(text);
  if (parsed.nodes.length > OUTLINE_NODE_LIMIT)
    throw new OutlineGenerateError(
      "too_many",
      translate(locale, "error.outline_generate_too_many", parsed.nodes.length, OUTLINE_NODE_LIMIT)
    );
  if (!parsed.nodes.length && parsed.headingLines === 0)
    throw new OutlineGenerateError("no_headings", translate(locale, "error.outline_generate_no_headings"));
  const first = parsed.errors[0];
  if (first)
    throw new OutlineGenerateError(
      "invalid",
      translate(locale, "error.outline_generate_invalid", translate(locale, first.key, ...first.values))
    );
  if (parsed.ignoredLines || parsed.skippedLines)
    throw new OutlineGenerateError(
      "non_heading",
      translate(locale, "error.outline_generate_non_heading", parsed.ignoredLines + parsed.skippedLines)
    );
  const summaries = split.summaries.map(summary => cleanOutlineSummary(summary));
  const missing =
    parsed.nodes.length !== summaries.length ? parsed.nodes.length : summaries.filter(item => !item).length;
  if (missing)
    throw new OutlineGenerateError(
      "missing_summary",
      translate(locale, "error.outline_generate_missing_summary", missing)
    );
  const nodes = parsed.nodes.map((node, index) => ({ ...node, summary: summaries[index] }));
  return { markdown: `${text}\n`, nodes };
}

/**
 * Generate an outline (headings, each with a one-line summary) from a topic and a preset. The whole request must fit the token budget; nothing is
 * truncated. Plain text reply (no response schema).
 */
export const outlineGenerateStep: StepDefinition<OutlineGenerateRequest, OutlineGenerateResult> = {
  id: "outline-generate",
  version: 5,
  render: request => {
    const content = request.contentLanguage ?? request.language;
    const hasSource = !!noteSection(request);
    if (request.fromNote) {
      const direction = request.direction?.trim();
      return renderTemplate(expandTemplate, {
        direction: direction ? renderTemplate(expandDirection, { json: JSON.stringify(direction) }) : "",
        topic: JSON.stringify(request.topic.trim()),
        noteSection: noteSection(request),
        limits: request.limits
          ? renderTemplate(inLanguage({ zh: limitsZh, en: limitsEn }, content), {
              levels: String(request.limits.levels),
              maxTopics: String(request.limits.maxTopics)
            })
          : "",
        languageInstruction: inLanguageNaming({ zh: languageZh, en: languageEn }, content, { language: "region" }, "en", {
          kind: "topic",
          text: request.topic
        })
      });
    }
    return renderTemplate(template, {
      noteSection: noteSection(request),
      summaryBasis: hasSource ? summaryBasisNote : summaryBasis,
      languageInstruction: inLanguageNaming({ zh: languageZh, en: languageEn }, content, { language: "region" }, "en", {
        kind: "topic",
        text: request.topic
      }),
      preset: request.limits
        ? `${applyTopicToPreset(request.presetText, request.topic, content)}\n\n${renderTemplate(
            inLanguage({ zh: limitsZh, en: limitsEn }, content),
            { levels: String(request.limits.levels), maxTopics: String(request.limits.maxTopics) }
          )}`
        : applyTopicToPreset(request.presetText, request.topic, content)
    });
  },
  policy: (prompt, request) => {
    const locale = uiLocale(request.language);
    if (!request.topic.trim())
      throw new OutlineGenerateError("empty_topic", translate(locale, "error.outline_generate_empty_topic"));
    if (request.fromNote && !request.noteDetail?.trim())
      throw new OutlineGenerateError("empty_note", translate(locale, "error.outline_generate_empty_note"));
    if (estimateTokens(prompt) > OUTLINE_GENERATE_TOKEN_BUDGET) {
      // A request with a note or subtopics is refused whole (never truncated, never retried with the title only), with its own wording.
      const { note, children } = noteInputs(request);
      if (note || children.length)
        throw new OutlineGenerateError("note_too_long", translate(locale, "error.outline_generate_note_too_long"));
      throw new OutlineGenerateError("over_budget", translate(locale, "error.outline_generate_over_budget"));
    }
  },
  parse: (raw, request) => parseOutlineReply(raw, request.language, request.topic)
};
