import { translate, type ContentLanguage } from "../../i18n";
import { fencedLines } from "../../ai/markdown-blocks";
import { CANONICAL_LANGUAGES, parseNoteStyleFile, type NoteStyleIssue } from "../../ai/note-style-file";
import type { DetailTemplate } from "../../ai/detail-templates";

/**
 * A template block is a markdown text of `##` sections (the same shape as a note style file body). Older texts may carry a
 * format rules zone after a level-one heading line; it is not read any more (the format rules are a part of their own),
 * but the heading is still recognised to cut it off. The heading's name is a translation entry; every canonical
 * language's spelling is accepted, whatever language the block is used in.
 */
const FORMAT_HEADING_KEY = "ui.block_template_format_heading";

/** The format rules heading line in `language`, without the leading "# ". */
export function templateFormatHeading(language: ContentLanguage): string {
  return translate(language, FORMAT_HEADING_KEY);
}

const unify = (text: string): string => text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
const trimBlankLines = (lines: string[]): string => {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end).join("\n");
};

/** A format rules text without leading and trailing blank lines (and with line breaks and the BOM unified). */
export function trimFormatBody(text: string): string {
  return trimBlankLines(unify(text).split("\n"));
}

export interface TemplateZones {
  /** The text before the separator line (all of it when there is none); line numbers stay those of the original text. */
  sections: string;
  /** The text after the separator line without leading and trailing blank lines; undefined when there is no separator. */
  format: string | undefined;
  /** 1-based lines of every separator line outside fenced code. */
  separatorLines: number[];
}

/** Splits the text at the first separator line (the whole line `# <format rules heading>`, outside fenced code). */
export function splitTemplateZones(text: string): TemplateZones {
  const lines = unify(text).split("\n");
  const code = fencedLines(lines);
  const names = new Set(CANONICAL_LANGUAGES.map(templateFormatHeading));
  const separatorLines: number[] = [];
  lines.forEach((line, index) => {
    if (code[index]) return;
    const heading = /^#[ \t]+(.*?)[ \t]*$/.exec(line);
    if (heading && names.has(heading[1])) separatorLines.push(index + 1);
  });
  if (!separatorLines.length) return { sections: lines.join("\n"), format: undefined, separatorLines };
  const first = separatorLines[0] - 1;
  return {
    sections: lines.slice(0, first).join("\n"),
    format: trimBlankLines(lines.slice(first + 1)),
    separatorLines
  };
}

/** A non-fatal remark about a template text: the text is used, with this part left out. */
export interface TemplateNotice {
  /** 1-based line of the original text. */
  line: number;
  code: "format_zone_moved";
}

export type TemplateBlockParse =
  | {
      ok: true;
      /** The sections zone as a template (frontmatter switches of the style file format are ignored). */
      template: DetailTemplate;
      /**
       * The text before the first "##" of the sections zone (comments removed, trimmed), sent as written; empty when
       * there is none. The template itself stays the sections layout.
       */
      lead: string;
      /** A format rules zone found in the text is not read (the format rules are a part of their own); each is noted here. */
      notices: TemplateNotice[];
    }
  | { ok: false; issues: NoteStyleIssue[] };

/**
 * Parses a template block text: the sections are the text before the format rules heading line (when there is one), and
 * what follows that line is not read, only noted. A sections zone the style file parser rejects is an issue.
 */
export function parseTemplateBlock(text: string, options: { id: string; name: string }): TemplateBlockParse {
  const zones = splitTemplateZones(text);
  const parsed = parseNoteStyleFile(zones.sections, options);
  if (!parsed.ok) return parsed;
  const { template, intro } = parsed.style;
  return {
    ok: true,
    template: { ...template, layout: "sections", intro: "" },
    lead: intro,
    notices: zones.separatorLines.length ? [{ line: zones.separatorLines[0], code: "format_zone_moved" }] : []
  };
}
