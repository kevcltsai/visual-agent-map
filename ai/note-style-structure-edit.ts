import { fencedLines } from "./markdown-blocks";
import { stripNoteStyleComments } from "./note-style-file";

/**
 * Editing the sections of a structure part in place (settings-redesign A4): the text is cut at its `##` headings, the
 * sections are added, removed, moved and renamed as chunks, and everything else (the lines before the first heading, every
 * section's description line, its `數量:` line and its `%%` comments) travels with its chunk untouched. Pure; reads and
 * writes no file.
 */

export interface StructureChunk {
  name: string;
  /** The raw lines of the section: its heading line and everything up to the next heading. */
  lines: string[];
}

export interface StructureChunks {
  /** The raw lines before the first heading (frontmatter, comments, an intro). */
  head: string[];
  sections: StructureChunk[];
  /** The line ending the text used. */
  eol: "\n" | "\r\n";
}

/** One row of the editor's section list: an original section (by position in the text read) or a new one (`origin` null). */
export interface SectionRow {
  origin: number | null;
  name: string;
}

/** Cuts a structure text at its headings; headings inside fenced code or `%%` comments do not count. */
export function splitStructure(text: string): StructureChunks {
  const bom = text.startsWith("﻿");
  const body = bom ? text.slice(1) : text;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const stripped = stripNoteStyleComments(lines.join("\n")).text.split("\n");
  const code = fencedLines(stripped);
  const at: { index: number; name: string }[] = [];
  stripped.forEach((line, index) => {
    if (code[index]) return;
    const heading = /^##(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (heading) at.push({ index, name: (heading[1] ?? "").trim() });
  });
  const first = at.length ? at[0].index : lines.length;
  return {
    head: lines.slice(0, first),
    sections: at.map((item, position) => ({
      name: item.name,
      lines: lines.slice(item.index, position + 1 < at.length ? at[position + 1].index : lines.length)
    })),
    eol
  };
}

/** The names of a list of rows. */
export const rowNames = (rows: readonly SectionRow[]): string[] => rows.map(row => row.name);

/** The rows of the text as read: every section, in order, with its position as `origin`. */
export function rowsOf(chunks: StructureChunks): SectionRow[] {
  return chunks.sections.map((section, origin) => ({ origin, name: section.name }));
}

/** Whether `rows` are the sections of `chunks` exactly as they were: same sections, same order, same names. */
export function sameRows(chunks: StructureChunks, rows: readonly SectionRow[]): boolean {
  return (
    rows.length === chunks.sections.length &&
    rows.every((row, index) => row.origin === index && row.name === chunks.sections[index].name)
  );
}

const trimTrailingBlank = (lines: string[]): string[] => {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  return lines.slice(0, end);
};

/**
 * The text of `rows` over `chunks`: the lines before the first heading, then the sections in the order of the rows. An
 * original section keeps all its lines (a renamed one changes only the name on its heading line, and a comment after the
 * name stays); a new section is a heading and nothing else (its description line is empty). Sections are separated by one
 * blank line; the text ends with one line break.
 */
export function composeStructure(chunks: StructureChunks, rows: readonly SectionRow[]): string {
  const pieces: string[][] = [];
  const head = trimTrailingBlank(chunks.head);
  if (head.length) pieces.push(head);
  for (const row of rows) {
    const original = row.origin === null ? undefined : chunks.sections[row.origin];
    if (!original) {
      pieces.push([`## ${row.name}`]);
      continue;
    }
    const lines = trimTrailingBlank(original.lines);
    if (row.name !== original.name) {
      const comment = lines[0].indexOf("%%");
      lines[0] = `## ${row.name}${comment >= 0 ? ` ${lines[0].slice(comment)}` : ""}`;
    }
    pieces.push(lines);
  }
  const text = pieces.map(piece => piece.join("\n")).join("\n\n");
  return `${chunks.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text}${chunks.eol}`;
}
