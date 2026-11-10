import { translate, type NoteLanguage } from "../i18n";
import { fencedLines } from "./markdown-blocks";

/**
 * The prompts ask the AI for `> [!type]` callouts but not for a title, so Obsidian shows the English type name. When the
 * note language has titles (the `note.callout_titles_1..4` texts, joined with `|`: `title:type,type|title:type`; English says `none`), bare
 * callout headers get one. NoteLanguage has no zh-CN value (zh-CN notes resolve to zh-TW), so zh-CN titles are
 * in the dictionary but are not reachable from write-back today.
 */
function titleTable(language: NoteLanguage): Map<string, string> {
  const table = new Map<string, string>();
  const text = [
    translate(language, "note.callout_titles_1"),
    translate(language, "note.callout_titles_2"),
    translate(language, "note.callout_titles_3"),
    translate(language, "note.callout_titles_4")
  ].join("|");
  for (const group of text.split("|")) {
    const [title, types] = group.split(":");
    if (!title || !types) continue;
    for (const type of types.split(",")) table.set(type, title);
  }
  return table;
}

const BARE_HEADER = /^((?:[ \t]*>)+[ \t]*\[!([A-Za-z]+)\][+-]?)[ \t]*$/;

/** Adds a title to each bare callout header outside code blocks; headers whose exact line is in `keepLines` are left alone. */
export function titleBareCallouts(text: string, language: NoteLanguage, keepLines: ReadonlySet<string>): string {
  const titles = titleTable(language);
  if (!titles.size) return text;
  const lines = text.split("\n");
  const code = fencedLines(lines);
  return lines
    .map((line, index) => {
      if (code[index] || keepLines.has(line)) return line;
      const match = BARE_HEADER.exec(line.replace(/\r$/, ""));
      const title = match ? titles.get(match[2].toLowerCase()) : undefined;
      return match && title ? `${match[1]} ${title}${line.endsWith("\r") ? "\r" : ""}` : line;
    })
    .join("\n");
}

/** The bare callout header lines of the old Detail, as written (the user's own; never retitled). */
export function bareCalloutLines(text: string): Set<string> {
  return new Set(text.split("\n").filter(line => BARE_HEADER.test(line.replace(/\r$/, ""))));
}
