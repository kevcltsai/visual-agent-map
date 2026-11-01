import { translate, type ContentLanguage } from "../../i18n";
import { fencedLines } from "../../ai/markdown-blocks";
import { CANONICAL_LANGUAGES, parseNoteStyleFile, type NoteStyleIssue } from "../../ai/note-style-file";
import type { DetailTemplate } from "../../ai/detail-templates";

/**
 * A template block is one markdown text with two zones: the sections zone (the `##` sections, the same shape as a note
 * style file body) and, after a level-one heading line, the format rules zone. The heading's name is a translation
 * entry; every canonical language's spelling is accepted, whatever language the block is used in.
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

export type TemplateBlockParse =
  | {
      ok: true;
      /** The sections zone as a template (frontmatter switches of the style file format are ignored). */
      template: DetailTemplate;
      /** The format rules zone; empty when the text has no separator line. */
      format: string;
    }
  | { ok: false; issues: NoteStyleIssue[] };

/** Parses a template block text; a second separator line, or a sections zone the style file parser rejects, is an issue. */
export function parseTemplateBlock(text: string, options: { id: string; name: string }): TemplateBlockParse {
  const zones = splitTemplateZones(text);
  if (zones.separatorLines.length > 1) {
    const line = zones.separatorLines[1];
    return {
      ok: false,
      issues: [
        {
          line,
          code: "format_heading_repeated",
          values: [line],
          message: `Line ${line}: the format rules heading appears a second time.`
        }
      ]
    };
  }
  const parsed = parseNoteStyleFile(zones.sections, options);
  if (!parsed.ok) return parsed;
  return { ok: true, template: parsed.style.template, format: zones.format ?? "" };
}
