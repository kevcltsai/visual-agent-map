import { isPlaceholder } from "./note-placeholder";
import {
  isNoteLanguage,
  NOTE_HEADING_SETS,
  translate,
  uiLanguageOfHeadings,
  type NoteHeadingName,
  type NoteHeadings,
  type NoteLanguage,
  type UiLanguage
} from "../i18n";
import { sourcesHeadingKeys, standardTemplate, type DetailTemplate } from "../ai/detail-templates";
import { fencedLines } from "../ai/markdown-blocks";
import { contentHash } from "./content-hash";
import { managedSectionValue } from "../note-values";
import { dedupeImageEmbeds, imageKey, imageKeysIn } from "./image-keys";
import { readCoverBlock, stripCoverBlock } from "./book-pipeline/cover-block";
import { LIVING_NODE_BEGIN, LIVING_NODE_END } from "./living-node-region";

export const REFERENCE_START = "<!-- visual-agent-map:references:start -->";
export const REFERENCE_END = "<!-- visual-agent-map:references:end -->";
export const DETAIL_START = "<!-- visual-agent-map:detail:start -->";
const DETAIL_END = "<!-- visual-agent-map:detail:end -->";
/**
 * The AIM open-items marker of a conclusion note. It is saved right after the Detail block, so Detail holds only what
 * the reader reads; `readNote` hands it back at the end of `detail`, where the AIM code and older notes keep it.
 */
const OPEN_ITEMS_MARKER = /\n*^<!--\s*aim-open-items\s+\[[^\n]*\]\s*-->[ \t]*$/m;
export function splitOpenItems(value: string): { text: string; marker: string } {
  const match = OPEN_ITEMS_MARKER.exec(value);
  return match
    ? {
        text: (value.slice(0, match.index) + value.slice(match.index + match[0].length)).trim(),
        marker: match[0].trim()
      }
    : { text: value, marker: "" };
}
type NoteSection =
  | "Thinking Origin"
  | "Current Summary"
  | "Prompt"
  | "Rules"
  | "Detail"
  | "Visual References"
  | "Working Findings"
  | "New Findings"
  | "預覽"
  | "Preview"
  | "User Notes";
export const noteContentLanguage = (fm: Record<string, unknown>): NoteLanguage | undefined =>
  isNoteLanguage(fm["content-language"]) ? fm["content-language"] : undefined;
export const placeholder = (language: NoteLanguage): string => translate(language, "detail.no_conclusion_yet");
export const previewHeading = (language: NoteLanguage): NoteSection =>
  translate(language, "detail.preview") as NoteSection;

/**
 * Managed section headings in the note's own language (C8). Every function of this module works with the English
 * names; `decodeCalloutSections` turns a localized heading back into its English name when it reads a note, and
 * `localizeHeadings` writes it in the note's heading set again. The sets live in the language registry
 * (`noteHeadings`), not in the dictionaries: they are note format, and every registered set is always read.
 */
export const CANONICAL_HEADINGS: NoteHeadings = Object.freeze(
  Object.fromEntries(Object.keys(NOTE_HEADING_SETS[0]).map(name => [name, name])) as Record<NoteHeadingName, string>
);
export const isCanonical = (set: NoteHeadings): boolean => set.Detail === CANONICAL_HEADINGS.Detail;
/**
 * The heading set a note is already written with, read from its managed Detail heading (the `## ` heading right
 * before the Detail start marker) alone; undefined when it has no marker, unless the user (or a tool) removed the
 * markers of a localized note: then a localized set whose Detail and Current Summary headings are both there (outside
 * fenced code) and no English managed heading is adopted, so such a note keeps decoding and does not gain a second pair. Any other heading there reads as English, so
 * a user's own heading that happens to read like a localized one is never taken for a managed section in older notes.
 */
function markerlessHeadingSet(content: string): NoteHeadings | undefined {
  const lines = content.split("\n");
  const code = fencedLines(lines);
  const headings = new Set<string>();
  lines.forEach((line, index) => {
    const text = code[index] ? undefined : /^## (.+?)[ \t]*\r?$/.exec(line)?.[1];
    if (text !== undefined) headings.add(text);
  });
  if (headings.has("Current Summary") || headings.has("Detail")) return undefined;
  return NOTE_HEADING_SETS.filter(set => !isCanonical(set)).find(
    set => headings.has(set.Detail) && headings.has(set["Current Summary"])
  );
}
export function noteHeadingSet(content: string): NoteHeadings | undefined {
  const start = content.indexOf(DETAIL_START);
  if (start < 0) return markerlessHeadingSet(content);
  const before = content.slice(0, start);
  const heading = [...before.matchAll(/^## (.+?)[ \t]*\r?$/gm)].at(-1)?.[1];
  const localized = NOTE_HEADING_SETS.filter(set => !isCanonical(set));
  // A Detail heading the user renamed: the summary heading (written right under the title) still names the set.
  const summary = (set: NoteHeadings): boolean =>
    new RegExp(`^## ${set["Current Summary"]}[ \\t]*\\r?$`, "m").test(before) &&
    !/^## Current Summary[ \t]*\r?$/m.test(before);
  return (
    localized.find(set => set.Detail === heading) ??
    (heading === CANONICAL_HEADINGS.Detail ? undefined : localized.find(summary)) ??
    CANONICAL_HEADINGS
  );
}
/**
 * Fenced-code lines of a note body, the Detail block left out: a fence the Detail text opens and never closes must not
 * turn every section after the block into code (it would hide their headings from decoding and encoding).
 */
function fencedOutsideDetail(lines: string[]): boolean[] {
  let inDetail = false;
  const masked = lines.map(line => {
    if (line.trim() === DETAIL_START) inDetail = true;
    const value = inDetail ? "" : line;
    if (line.trim() === DETAIL_END) inDetail = false;
    return value;
  });
  return fencedLines(masked);
}
/** The interface language whose headings a note is written with (for tests and diagnostics); English without a marker. */
export function noteHeadingLanguage(content: string): UiLanguage {
  return uiLanguageOfHeadings(noteHeadingSet(content) ?? CANONICAL_HEADINGS);
}
/**
 * The heading set a write gives a note: the one it is written with; a note with no managed section yet (no Detail
 * marker and no English managed heading, such as a bare stub) gets `fallback`, the set of a new note.
 */
export function writtenHeadingSet(content: string, fallback: NoteHeadings): NoteHeadings {
  const set = noteHeadingSet(content);
  if (set) return set;
  return /^## (?:Current Summary|Detail|Prompt|Rules|Working Findings|Thinking Origin)[ \t]*\r?$/m.test(content)
    ? CANONICAL_HEADINGS
    : fallback;
}
const CALLOUT_TITLE = /^(> \[!(?:info|vam-book)\][+-]? )(.+?)([ \t]*\r?)$/;
/**
 * Walks a note body's lines outside fenced code, the Detail block and the quoted Thinking Origin text (the places
 * where a heading-like line is content), and lets `rename` replace a `## ` heading text or a callout title.
 */
function renameManagedHeadings(
  content: string,
  rename: (text: string, kind: "heading" | "callout") => string | undefined
): string {
  const lines = content.split("\n");
  const code = fencedOutsideDetail(lines);
  let inDetail = false;
  let origin: "none" | "heading" | "quote" = "none";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === DETAIL_START) inDetail = true;
    if (line.trim() === DETAIL_END) inDetail = false;
    if (inDetail || code[index]) continue;
    if (origin === "heading" && line.startsWith(">")) origin = "quote";
    else if (origin === "heading" && line.trim()) origin = "none";
    else if (origin === "quote" && !line.startsWith(">")) origin = "none";
    if (origin === "quote") continue;
    const heading = /^## (.+?)([ \t]*\r?)$/.exec(line);
    const callout = heading ? null : CALLOUT_TITLE.exec(line);
    const current = heading?.[1] ?? callout?.[2];
    const next = current === undefined ? undefined : rename(current, heading ? "heading" : "callout");
    if (next !== undefined && next !== current)
      lines[index] = heading ? `## ${next}${heading[2]}` : `${callout![1]}${next}${callout![3]}`;
    // The English name on either side of the rename: decoding meets it after, encoding before.
    if (heading && (current === "Thinking Origin" || next === "Thinking Origin")) origin = "heading";
  }
  return lines.join("\n");
}
/** Localized managed headings back to their English names (the inverse of localizeHeadings). */
export function canonicalHeadings(content: string, set: NoteHeadings): string {
  if (isCanonical(set)) return content;
  const back = new Map(Object.entries(set).map(([english, local]) => [local, english]));
  // Prompt is written as a callout only (a "## 提示" heading is the user's own); every other name is a "## " heading.
  return renameManagedHeadings(content, (text, kind) => {
    const english = back.get(text);
    return (kind === "callout") === (english === "Prompt") ? english : undefined;
  });
}
/** English managed headings to the names of `set`; the English set leaves the text as it is. */
export function localizeHeadings(content: string, set: NoteHeadings): string {
  if (isCanonical(set)) return content;
  const names = set as Readonly<Record<string, string>>;
  return renameManagedHeadings(content, (text, kind) =>
    Object.hasOwn(names, text) && (kind === "callout") === (text === "Prompt") ? names[text] : undefined
  );
}

/**
 * Preview (right after the summary) and Prompt (after Detail) are written as collapsed callouts (`> [!info]- 預覽`,
 * `> [!info]- Prompt`) so the note opens on the answer. Every read and write first turns these callouts back into the `## ` sections the rest
 * of this module works with; `noteBody` writes them as callouts again. Older notes keep their `## ` sections.
 * A picture-book card (see {@link isBookCardFrontmatter}) writes them as `> [!vam-book]-` callouts, which the stylesheet hides; both types are read.
 */
const CALLOUT_SECTION = /^> \[!(?:info|vam-book)\][+-]? (預覽|Preview|Prompt)[ \t]*\r?$/;
/** A picture-book card: its frontmatter has `pipeline-stage` or `book-role`. */
export const isBookCardFrontmatter = (fm: Record<string, unknown>): boolean =>
  fm["pipeline-stage"] !== undefined || fm["book-role"] !== undefined;
export function decodeCalloutSections(content: string): string {
  const lines = canonicalHeadings(content, noteHeadingSet(content) ?? CANONICAL_HEADINGS).split("\n");
  const code = fencedOutsideDetail(lines);
  const out: string[] = [];
  let inDetail = false;
  // Thinking Origin is quoted source text: a line there that looks like a callout title is still source text.
  let origin: "none" | "heading" | "quote" = "none";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === DETAIL_START) inDetail = true;
    if (line.trim() === DETAIL_END) inDetail = false;
    if (/^## Thinking Origin\s*$/.test(line)) origin = "heading";
    else if (origin === "heading" && line.startsWith(">")) origin = "quote";
    else if (origin === "heading" && line.trim()) origin = "none";
    else if (origin === "quote" && !line.startsWith(">")) origin = "none";
    const callout = inDetail || code[index] || origin !== "none" ? null : CALLOUT_SECTION.exec(line);
    if (!callout) {
      out.push(line);
      continue;
    }
    // A callout ends at the first line without ">" or at the next Preview/Prompt callout title.
    let end = index + 1;
    while (end < lines.length && lines[end].startsWith(">") && !CALLOUT_SECTION.test(lines[end])) end++;
    out.push(
      `## ${callout[1]}`,
      "",
      ...lines.slice(index + 1, end).map(item => item.replace(/^> ?/, "").replace(/\r$/, "")),
      ""
    );
    index = end - 1;
  }
  return out.join("\n");
}
function calloutSection(title: string, value: string, type = "info"): string {
  const lines = value.trim().split("\n");
  return [`> [!${type}]- ${title}`, ...lines.map(line => (line ? `> ${line}` : ">"))].join("\n");
}
export const previewSection = (content: string): string =>
  [...new Set([section(content, "Preview"), section(content, "預覽")].filter(Boolean))].join("\n\n");

// Only the sections a book card writes as a callout (Prompt, Preview) end at its hidden callout, and only in the exact `vam-book` spelling: a note
// that is no book card keeps every other section whole (the section text here has no frontmatter, so the card type is not known).
const HIDDEN_AFTER: ReadonlySet<NoteSection> = new Set<NoteSection>(["Prompt", "Preview", "預覽"]);
function sectionBounds(content: string, heading: NoteSection): { start: number; end: number } | null {
  if (heading === "Detail") {
    const managedStart = content.indexOf(DETAIL_START),
      managedEnd = content.indexOf(DETAIL_END);
    if (managedStart >= 0 && managedEnd > managedStart)
      return { start: managedStart + DETAIL_START.length, end: managedEnd };
  }
  const match = new RegExp(`^## ${heading.replace(" ", "\\s+")}\\s*$`, "m").exec(content);
  if (!match) return null;
  const start = match.index + match[0].length;
  const next = /^## .+$/m.exec(content.slice(start));
  const reference = content.indexOf(REFERENCE_START, start);
  const living = [LIVING_NODE_BEGIN, LIVING_NODE_END].map(mark => content.indexOf(mark, start)).filter(i => i >= 0);
  // A hidden work-record callout (`> [!vam-book]- ...`, the proofread result) after a section is no part of it: Preview and Prompt callouts were turned into `## ` sections before.
  const hidden = HIDDEN_AFTER.has(heading) ? /^> \[!vam-book\]/m.exec(content.slice(start)) : null;
  const candidates = [
    next ? start + next.index : content.length,
    reference >= 0 ? reference : content.length,
    ...living,
    hidden ? start + hidden.index : content.length
  ];
  return { start, end: Math.min(...candidates) };
}

/** Detail as the app uses it: the Detail block, plus the open-items marker saved after it. */
export function detailWithOpenItems(content: string): string {
  const detail = section(content, "Detail");
  if (splitOpenItems(detail).marker) return detail;
  const end = content.indexOf(DETAIL_END);
  const after = end >= 0 ? content.slice(end + DETAIL_END.length) : "";
  const next = after.search(/^## /m);
  const { marker } = splitOpenItems(next >= 0 ? after.slice(0, next) : after);
  return marker ? `${detail}\n\n${marker}` : detail;
}

export function section(content: string, heading: NoteSection): string {
  const bounds = sectionBounds(content, heading);
  return bounds ? content.slice(bounds.start, bounds.end).trim() : "";
}

export function replaceSection(content: string, heading: NoteSection, value: string): string {
  const bounds = sectionBounds(content, heading);
  if (bounds) {
    if (heading === "Detail" && !content.slice(0, bounds.start).includes(DETAIL_START)) {
      return `${content.slice(0, bounds.start)}\n\n${DETAIL_START}\n${managedSectionValue(value)}\n${DETAIL_END}\n\n${content.slice(bounds.end).replace(/^\s*/, "")}`;
    }
    return `${content.slice(0, bounds.start)}\n${managedSectionValue(value)}\n${content.slice(bounds.end)}`;
  }
  const reference = content.indexOf(REFERENCE_START);
  const at = reference >= 0 ? reference : content.length;
  const managed =
    heading === "Detail" ? `${DETAIL_START}\n${managedSectionValue(value)}\n${DETAIL_END}` : managedSectionValue(value);
  return `${content.slice(0, at).trimEnd()}\n\n## ${heading}\n\n${managed}\n\n${content.slice(at).trimStart()}`;
}

// Blockquoted, escaped source text cannot impersonate managed sections or markers.
export function originMarkdown(value: string): string {
  return value
    .split(/\r?\n/)
    .map(line => `> ${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`)
    .join("\n");
}
export function readThinkingOrigin(content: string): string | undefined {
  const value = section(content, "Thinking Origin");
  if (!value) return undefined;
  return value
    .split("\n")
    .map(line => line.replace(/^> ?/, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"))
    .join("\n");
}

export function replaceSummarySection(content: string, value: string): string {
  if (sectionBounds(content, "Current Summary")) return replaceSection(content, "Current Summary", value);
  const title = /^# .*$/m.exec(content);
  if (!title) return replaceSection(content, "Current Summary", value);
  const at = title.index + title[0].length;
  return `${content.slice(0, at)}\n\n## Current Summary\n\n${managedSectionValue(value)}\n\n${content.slice(at).trimStart()}`;
}

/** Takes the Prompt callout (`> [!info]- Prompt` and its quoted lines) out of a note; outside the Detail only. */
function removePromptCallout(content: string): string {
  // The callout title is in the note's language (`> [!info]- 提示`): scan the canonical text (same lines) and cut the original.
  const original = content.split("\n");
  const lines = canonicalHeadings(content, noteHeadingSet(content) ?? CANONICAL_HEADINGS).split("\n");
  const code = fencedOutsideDetail(lines);
  let inDetail = false;
  let origin: "none" | "heading" | "quote" = "none";
  for (let index = 0; index < lines.length; index++) {
    if (code[index]) continue;
    if (lines[index].trim() === DETAIL_START) inDetail = true;
    if (lines[index].trim() === DETAIL_END) inDetail = false;
    // Quoted Thinking Origin text is source text: a line there that looks like a callout title is not one.
    if (/^## Thinking Origin\s*$/.test(lines[index])) origin = "heading";
    else if (origin === "heading" && lines[index].startsWith(">")) origin = "quote";
    else if (origin === "heading" && lines[index].trim()) origin = "none";
    else if (origin === "quote" && !lines[index].startsWith(">")) origin = "none";
    const callout = inDetail || origin !== "none" ? null : CALLOUT_SECTION.exec(lines[index]);
    if (callout?.[1] !== "Prompt") continue;
    let end = index + 1;
    while (end < lines.length && lines[end].startsWith(">") && !CALLOUT_SECTION.test(lines[end])) end++;
    while (end < lines.length && !lines[end].trim()) end++;
    return `${original.slice(0, index).join("\n").trimEnd()}\n\n${original.slice(end).join("\n")}`;
  }
  return content;
}

export function removeSection(content: string, heading: NoteSection): string {
  if (heading === "Prompt") content = removePromptCallout(content);
  if (heading === "Detail") {
    const managedStart = content.indexOf(DETAIL_START),
      managedEnd = content.indexOf(DETAIL_END);
    if (managedStart >= 0 && managedEnd > managedStart) {
      const headingMatch = /^## Detail\s*$/m.exec(content.slice(0, managedStart));
      const start = headingMatch ? headingMatch.index : managedStart;
      return `${content.slice(0, start).trimEnd()}\n\n${content.slice(managedEnd + DETAIL_END.length).trimStart()}`;
    }
  }
  const bounds = sectionBounds(content, heading);
  if (!bounds) return content;
  const headingMatch = new RegExp(`^## ${heading.replace(" ", "\\s+")}\\s*$`, "m").exec(content.slice(0, bounds.start));
  if (!headingMatch) return content;
  return `${content.slice(0, headingMatch.index).trimEnd()}\n\n${content.slice(bounds.end).trimStart()}`;
}

export function ensurePreview(content: string, language: NoteLanguage, textLanguage: NoteLanguage = language): string {
  const legacy = section(content, "User Notes");
  const preview = previewSection(content);
  const merged = [isPlaceholder(preview) ? placeholder(textLanguage) : preview, legacy].filter(Boolean).join("\n\n");
  const clean = removeSection(removeSection(removeSection(content, "User Notes"), "預覽"), "Preview");
  return replaceSection(clean, previewHeading(language), merged);
}

export function withoutReference(content: string): string {
  const managed = new RegExp(`\\n?${REFERENCE_START}[\\s\\S]*?${REFERENCE_END}\\n?`, "m");
  if (managed.test(content)) return content.replace(managed, "\n");
  const legacy = /\n?^## 關聯議題\s*\n+(?:母議題：[^\n]*\n+)?(?:子議題：[^\n]*\n*)?$/m;
  return legacy.test(content) ? content.replace(legacy, "\n") : content;
}

/**
 * Puts each visual reference block into the Detail. By default a block whose exact image link the Detail already has is left
 * out. With `keepText` (new AI content): a block whose image the Detail already has (same image key, see imageKey) keeps its
 * title and source text and drops only the image line.
 */
export function detailWithVisualReferences(
  detail: string,
  visualReferences: string,
  template: DetailTemplate,
  keepText = false
): string {
  let current = detail.trim();
  const references = visualReferences
    .trim()
    .split(/\n(?=\*\*[^\n]+\*\*\n|### )/)
    .filter(Boolean);
  for (const reference of references) {
    const image = reference.match(/!\[[^\]]*\]\(([^)]+)\)/);
    if (!image) continue;
    const repeated = keepText ? imageKeysIn(current).has(imageKey(image[1])) : current.includes(`](${image[1]})`);
    if (repeated && !keepText) continue;
    const written = repeated ? dedupeImageEmbeds(reference, { seen: [imageKey(image[1])] }) : reference;
    const block = written.replace(/^### (.+)$/gm, "**$1**").trim();
    const title = block.match(/^\*\*(.+)\*\*/)?.[1];
    const paragraphs = current.split("\n\n");
    const related = title ? paragraphs.findIndex(text => !/^#{1,6} /.test(text) && text.includes(title)) : -1;
    if (related >= 0) {
      paragraphs.splice(related + 1, 0, block);
      current = paragraphs.join("\n\n");
    } else {
      const keys = sourcesHeadingKeys(template);
      const lines = current.split("\n");
      const code = fencedLines(lines);
      const at = lines.findIndex((line, index) => {
        const heading = code[index] ? null : /^###\s+(.+?)\s*$/.exec(line);
        return !!heading && keys.has(heading[1].toLocaleLowerCase());
      });
      current =
        at < 0
          ? [current.trimEnd(), block].filter(Boolean).join("\n\n")
          : [lines.slice(0, at).join("\n").trimEnd(), block, lines.slice(at).join("\n").trimStart()]
              .filter(Boolean)
              .join("\n\n");
    }
  }
  return current;
}

export function initialPreview(summary: string, detail: string): string {
  const image = detail.match(/!\[[^\]]*\]\((?:https?:\/\/[^)\s]+)\)/)?.[0];
  return [summary.trim(), image].filter(Boolean).join("\n\n");
}

export const PREVIEW_MANUAL = "manual";
const normalizePreviewText = (value: string): string =>
  value
    .normalize("NFC")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
const previewHash = (value: string): string => `v1:${contentHash(normalizePreviewText(value))}`;
export const readPreviewAutoHash = (value: unknown): string =>
  typeof value === "string" && (value === PREVIEW_MANUAL || /^v1:[0-9a-f]{14}$/.test(value)) ? value : "";
const LEGACY_PREVIEW_BLOCK_START = /^(?:#|>|-|\*|\+|\||<|!|```|\d+[.)])/;
const LEGACY_PREVIEW_IMAGE = /^!\[[^\]]*\]\(https?:\/\/[^)\s]+\)$/;

/** What a new summary does to the preview: the new preview text (null = leave it) and the hash to store. */
export function followedPreview(
  current: string,
  auto: string,
  hash: string,
  initialized: boolean
): { preview: string | null; hash: string } {
  if (hash === PREVIEW_MANUAL) return { preview: null, hash };
  const text = isPlaceholder(current) ? "" : normalizePreviewText(current);
  const paragraphs = text ? text.split("\n\n") : [];
  const replaceFirst = (count: number): { preview: string; hash: string } => ({
    preview: [auto, ...paragraphs.slice(count)].join("\n\n"),
    hash: previewHash(auto)
  });
  if (hash) {
    for (let k = 1; k <= paragraphs.length; k++)
      if (previewHash(paragraphs.slice(0, k).join("\n\n")) === hash) return replaceFirst(k);
    return { preview: null, hash };
  }
  if (!initialized) return text ? { preview: null, hash: PREVIEW_MANUAL } : replaceFirst(0);
  const [first, second] = paragraphs;
  if (!first || first.includes("\n") || LEGACY_PREVIEW_BLOCK_START.test(first))
    return { preview: null, hash: PREVIEW_MANUAL };
  return replaceFirst(second !== undefined && LEGACY_PREVIEW_IMAGE.test(second) ? 2 : 1);
}

export function noteBody(
  title: string,
  summary: string,
  language: NoteLanguage,
  prompt = "",
  rules = "",
  preview = "",
  detail = "",
  visualReferences = "",
  newFindings = "",
  leftover = "",
  layout: "answer-first" | "legacy" = "answer-first",
  calloutType = "info",
  coverBlock = ""
): string {
  if (layout === "legacy") {
    const legacyBlock = `${DETAIL_START}\n${detailWithVisualReferences(detail, visualReferences, standardTemplate(language))}\n${DETAIL_END}`;
    return (
      [
        `# ${title}`,
        coverBlock,
        `## Current Summary\n\n${summary.trim() || placeholder(language)}`,
        `## Prompt\n\n${prompt.trim()}`,
        rules.trim() ? `## Rules\n\n${rules.trim()}` : "",
        `## ${previewHeading(language)}\n\n${preview.trim()}`,
        `## Detail\n\n${legacyBlock}`,
        newFindings.trim() ? `## Working Findings\n\n${newFindings.trim()}` : "",
        leftover.trim()
      ]
        .filter(Boolean)
        .join("\n\n") + "\n"
    );
  }
  const { text: readerDetail, marker } = splitOpenItems(detail);
  const detailBlock = `${DETAIL_START}\n${detailWithVisualReferences(readerDetail, visualReferences, standardTemplate(language))}\n${DETAIL_END}${marker ? `\n\n${marker}` : ""}`;
  // The answer comes first: summary, the Preview callout (it feeds the hover card), then Detail; the task text follows
  // as a collapsed callout, and an empty (or placeholder) Preview and an empty Prompt are left out. Whether Preview was initialized stays in frontmatter.
  return (
    [
      `# ${title}`,
      coverBlock,
      `## Current Summary\n\n${summary.trim() || placeholder(language)}`,
      preview.trim() && !isPlaceholder(preview.trim())
        ? calloutSection(previewHeading(language), preview, calloutType)
        : "",
      `## Detail\n\n${detailBlock}`,
      prompt.trim() ? calloutSection("Prompt", prompt, calloutType) : "",
      rules.trim() ? `## Rules\n\n${rules.trim()}` : "",
      newFindings.trim() ? `## Working Findings\n\n${newFindings.trim()}` : "",
      leftover.trim()
    ]
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
}

export function normalizeBodyOrder(
  content: string,
  title: string,
  summaryFallback: string,
  language: NoteLanguage,
  textLanguage: NoteLanguage = language,
  book = false
): string {
  // The cover block of a picture-book note (see core/book-pipeline/cover-block.ts) stays directly under the title wherever it was found;
  // it is taken out first so its embed never feeds the Preview.
  const cover = readCoverBlock(content);
  const coverBlock = cover ? content.slice(cover.from, cover.to) : "";
  const clean = ensurePreview(withoutReference(cover ? stripCoverBlock(content) : content), language, textLanguage);
  const currentSummary = section(clean, "Current Summary") || summaryFallback;
  const summary = isPlaceholder(currentSummary) ? placeholder(textLanguage) : currentSummary;
  const prompt = section(clean, "Prompt");
  const rules = section(clean, "Rules");
  const preview = previewSection(clean);
  const detail = detailWithVisualReferences(
    section(clean, "Detail"),
    section(clean, "Visual References"),
    standardTemplate(language)
  );
  const newFindings = section(clean, "Working Findings") || section(clean, "New Findings");
  let leftover = clean.replace(/^# .*$(?:\r?\n)*/m, "");
  // An open-items marker saved after the Detail block is left over once Detail is removed; it goes back beside Detail.
  const openItems = splitOpenItems(leftover);
  leftover = openItems.text;
  for (const heading of [
    "Current Summary",
    "Prompt",
    "Rules",
    "預覽",
    "Preview",
    "Detail",
    "Visual References",
    "Working Findings",
    "New Findings"
  ] as NoteSection[])
    leftover = removeSection(leftover, heading);
  const withMarker = openItems.marker && !splitOpenItems(detail).marker ? `${detail}\n\n${openItems.marker}` : detail;
  // A note written before the answer-first layout (its Prompt sits above Detail) keeps its layout, so a write that
  // does not change its content leaves it byte-identical; new notes use the answer-first layout.
  const detailAt = clean.search(/^## Detail\s*$/m);
  const legacy = /^## Prompt\s*$/m.test(detailAt >= 0 ? clean.slice(0, detailAt) : clean);
  return noteBody(
    title,
    summary,
    language,
    prompt,
    rules,
    preview,
    withMarker,
    "",
    newFindings,
    leftover,
    legacy && !book ? "legacy" : "answer-first",
    book ? "vam-book" : "info",
    coverBlock
  );
}
