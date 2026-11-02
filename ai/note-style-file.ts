import { NOTE_LANGUAGES, translate, type UiLanguage } from "../i18n";
import { fencedLines } from "./markdown-blocks";
import { STANDARD, validateTemplate, type DetailSection, type DetailTemplate } from "./detail-templates";

/**
 * A note style is one Markdown file the user edits. This module is pure: it parses a file's text and writes the frozen legacy export. It reads and writes no file.
 */

export type NoteStyleLanguage = UiLanguage;
export const NOTE_STYLE_LIMITS = { file: 8000, tone: 1000 } as const;

export interface NoteStyleIssue {
  /** 1-based line of the original file text. */
  line: number;
  /** A TranslationKey of the detail-template errors, or one of the codes below (P4 maps them to messages). */
  code: string;
  values: (string | number)[];
  /** English fallback for logs; the UI shows a translated message for `code`. */
  message: string;
}
export interface NoteStyleCallout {
  /** Obsidian callout type as written, lower-cased. */
  type: string;
  fold: "" | "-" | "+";
  title: string;
  /** The callout text without the "> " prefix: the instruction, never output verbatim. */
  body: string;
}
export interface NoteStyleSection extends DetailSection {
  callouts: NoteStyleCallout[];
  /** 1-based line of the section's "##" heading. */
  line: number;
}
export interface NoteStyle {
  id: string;
  name: string;
  /** Raw `語氣` value: free text, or the name or id of an existing tone (resolved by the store). Undefined when absent. */
  tone?: string;
  layout: "intro" | "sections";
  /** Text before the first "##", comments removed and trimmed; empty for the sections layout. */
  intro: string;
  sections: NoteStyleSection[];
  /** The sections as a DetailTemplate (same section objects), for `sectionLookup`, `checkCounts` and `canonicalDetail`. */
  template: DetailTemplate;
}
export type NoteStyleParse = { ok: true; style: NoteStyle } | { ok: false; issues: NoteStyleIssue[] };

export const NOTE_STYLE_BUILTIN_IDS = ["standard", "textbook", "summary", "plain", "guide"] as const;
export type NoteStyleBuiltinId = (typeof NOTE_STYLE_BUILTIN_IDS)[number];
export const CANONICAL_LANGUAGES: readonly NoteStyleLanguage[] = ["zh-TW", "zh-CN", "en"];

/** A per-language record built from entries, so no source line branches on a language id (language gate). */
function byLanguage<T>(zhTW: T, zhCN: T, en: T): Record<NoteStyleLanguage, T> {
  return Object.fromEntries([
    ["zh-TW", zhTW],
    ["zh-CN", zhCN],
    ["en", en]
  ]) as Record<NoteStyleLanguage, T>;
}

/** Line endings unified, trailing whitespace removed, one final newline: the form two style texts are compared in. */
export function normalizeStyleContent(text: string): string {
  return (
    text
      .replace(/^\uFEFF/, "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map(line => line.replace(/[ \t]+$/, ""))
      .join("\n")
      .replace(/\n+$/, "") + "\n"
  );
}

// ---- frozen legacy export (v1): never edit; a different layout needs a serializeLegacyV2 and both stay recognised ----
const LEGACY_V1 = byLanguage(
  {
    callouts: "方框: 自動",
    count: "數量: ",
    atLeast: "至少 ",
    comment: (name: string) =>
      `%% 這個檔決定 AI 怎麼寫「${name}」風格的筆記。改完存檔，下次 AI 更新就照新內容寫，已寫好的筆記不會變。 %%`
  },
  {
    callouts: "方框: 自动",
    count: "数量: ",
    atLeast: "至少 ",
    comment: (name: string) =>
      `%% 这个文件决定 AI 怎么写「${name}」风格的笔记。改完保存，下次 AI 更新就按新内容写，已写好的笔记不会变。 %%`
  },
  {
    callouts: "callouts: auto",
    count: "Count: ",
    atLeast: "at least ",
    comment: (name: string) =>
      `%% This file decides how the AI writes notes in the "${name}" style. Save your edits and the next AI update follows them; notes already written do not change. %%`
  }
);

/**
 * The file an old custom template is exported as (frozen). Roles and aliases are not written: the parser gives the
 * standard section names their roles and aliases back.
 */
export function serializeLegacyV1(template: DetailTemplate, language: NoteStyleLanguage): string {
  const words = LEGACY_V1[language];
  const sections = template.sections.map(section => {
    const lines = [`## ${section.name}`];
    if (section.count)
      lines.push(`${words.count}${section.count.mode === "min" ? words.atLeast : ""}${section.count.n}`);
    if (section.description.trim()) lines.push(section.description.replace(/\r\n?/g, "\n").trim());
    return lines.join("\n") + "\n";
  });
  return `---\n${words.callouts}\n---\n${words.comment(template.name)}\n\n${sections.join("\n")}`;
}

// ---- parsing ----
const issue = (line: number, code: string, message: string, ...values: (string | number)[]): NoteStyleIssue => ({
  line,
  code,
  values,
  message
});

/** The only frontmatter key still read: the tone. Every other line is skipped (the old switches live in the upgrade module). */
const TONE_KEYS = new Set(["語氣", "语气", "tone"]);
const COMMENT_MARK = "%%";

/**
 * Removes Obsidian comments (`%% … %%`, one or several lines) outside fenced code blocks. Every line break stays, so
 * line numbers do not move. Returns the unclosed comment's start line when one is left open.
 */
export function stripNoteStyleComments(text: string): { text: string; unclosed?: number } {
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  let open: number | undefined;
  lines.forEach((line, index) => {
    if (open === undefined) {
      if (fence) {
        const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
        out.push(line);
        return;
      }
      const fenceOpen = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fenceOpen) {
        fence = fenceOpen[1];
        out.push(line);
        return;
      }
    }
    let kept = "";
    let at = 0;
    let touched = false;
    while (at < line.length) {
      const mark = line.indexOf(COMMENT_MARK, at);
      if (open !== undefined) {
        touched = true;
        if (mark < 0) break;
        open = undefined;
        at = mark + COMMENT_MARK.length;
      } else {
        if (mark < 0) {
          kept += line.slice(at);
          break;
        }
        kept += line.slice(at, mark);
        open = index + 1;
        touched = true;
        at = mark + COMMENT_MARK.length;
      }
    }
    out.push(touched && !kept.trim() ? "" : kept);
  });
  return { text: out.join("\n"), ...(open !== undefined ? { unclosed: open } : {}) };
}

const NAME_LANGUAGES = ["zh-TW", "zh-CN", "en"] as const;
const lowered = (value: string) => value.trim().toLocaleLowerCase();

function standardKeyOf(heading: string): number {
  const key = lowered(heading);
  return STANDARD.findIndex(([, name]) => NAME_LANGUAGES.some(language => lowered(translate(language, name)) === key));
}

function parseCount(line: string): { mode: "exact" | "min"; n: number } | "invalid" | undefined {
  const head = /^(?:數量|数量|count)\s*[:：]\s*(.*)$/i.exec(line.trim());
  if (!head) return undefined;
  const value = /^(至少|at\s+least)?\s*(\d{1,6})$/i.exec(head[1].trim());
  return value ? { mode: value[1] ? "min" : "exact", n: Number(value[2]) } : "invalid";
}

function parseCallouts(lines: string[], code: boolean[]): { callouts: NoteStyleCallout[]; rest: string[] } {
  const callouts: NoteStyleCallout[] = [];
  const rest: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const head = code[index] ? null : /^>[ \t]?\[!([A-Za-z][\w-]*)\]([+-])?(?:[ \t]+(.*))?$/.exec(lines[index]);
    if (!head) {
      rest.push(lines[index]);
      continue;
    }
    const body: string[] = [];
    while (index + 1 < lines.length && !code[index + 1] && /^>/.test(lines[index + 1]))
      body.push(lines[++index].replace(/^>[ \t]?/, ""));
    callouts.push({
      type: head[1].toLowerCase(),
      fold: (head[2] ?? "") as "" | "-" | "+",
      title: (head[3] ?? "").trim(),
      body: body.join("\n").trim()
    });
  }
  return { callouts, rest };
}

/**
 * Parses a style file. Anything wrong fails closed with issues carrying the line; nothing is written or repaired.
 * `id` is the style's stored id (for example `style:A`) and `name` its display name (the file's base name).
 */
export function parseNoteStyleFile(text: string, options: { id: string; name: string }): NoteStyleParse {
  const issues: NoteStyleIssue[] = [];
  const all = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (all.length > NOTE_STYLE_LIMITS.file)
    issues.push(
      issue(1, "file_long", `The file is over ${NOTE_STYLE_LIMITS.file} characters.`, NOTE_STYLE_LIMITS.file)
    );
  const lines = all.split("\n");

  // frontmatter: only the tone is read; any other line is skipped, and the only error is a frontmatter that never closes
  let tone: string | undefined;
  let bodyStart = 0;
  if (lines[0].trimEnd() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
    if (end < 0) {
      issues.push(issue(1, "frontmatter_unclosed", "The frontmatter opened by --- on line 1 is never closed."));
      bodyStart = lines.length;
    } else {
      bodyStart = end + 1;
      for (let index = 1; index < end; index++) {
        const raw = lines[index];
        if (!raw.trim() || /^\s*#/.test(raw) || /^[\s-]/.test(raw)) continue;
        const pair = /^([^:：]+?)\s*[:：]\s*(.*)$/.exec(raw);
        if (!pair || !TONE_KEYS.has(pair[1].trim().toLocaleLowerCase().replace(/\s+/g, " "))) continue;
        let value = pair[2].trim();
        if (/^(["']).*\1$/.test(value) && value.length >= 2) value = value.slice(1, -1).trim();
        if (value.length > NOTE_STYLE_LIMITS.tone)
          issues.push(
            issue(
              index + 1,
              "tone_long",
              `The tone is over ${NOTE_STYLE_LIMITS.tone} characters.`,
              NOTE_STYLE_LIMITS.tone
            )
          );
        else tone = value || undefined;
      }
    }
  }

  // comments, then structure
  const body = lines.slice(bodyStart).join("\n");
  const stripped = stripNoteStyleComments(body);
  if (stripped.unclosed !== undefined)
    issues.push(issue(bodyStart + stripped.unclosed, "comment_unclosed", "A %% comment is never closed."));
  const bodyLines = stripped.text.split("\n");
  const code = fencedLines(bodyLines);
  const headings: { index: number; name: string }[] = [];
  bodyLines.forEach((line, index) => {
    if (code[index]) return;
    const heading = /^##(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (heading) headings.push({ index, name: (heading[1] ?? "").trim() });
  });
  if (!headings.length) issues.push(issue(Math.max(1, bodyStart + 1), "no_sections", "The file has no ## section."));
  const intro = bodyLines
    .slice(0, headings.length ? headings[0].index : 0)
    .join("\n")
    .trim();

  const sections: NoteStyleSection[] = headings.map((heading, position) => {
    const end = position + 1 < headings.length ? headings[position + 1].index : bodyLines.length;
    let content = bodyLines.slice(heading.index + 1, end);
    const sectionCode = code.slice(heading.index + 1, end);
    const line = bodyStart + heading.index + 1;
    let count: DetailSection["count"];
    const first = content.findIndex(entry => entry.trim());
    if (first >= 0 && !sectionCode[first]) {
      const parsed = parseCount(content[first]);
      if (parsed === "invalid")
        issues.push(issue(line + 1 + first, "count_invalid", `Line ${line + 1 + first}: the count is not a number.`));
      else if (parsed) count = parsed;
      if (parsed) {
        content = content.filter((_, index) => index !== first);
        sectionCode.splice(first, 1);
      }
    }
    const { callouts, rest } = parseCallouts(content, sectionCode);
    const standard = standardKeyOf(heading.name);
    const role = standard === 2 ? "sources" : standard === 5 ? "log" : "none";
    const aliases =
      standard >= 0
        ? NOTE_LANGUAGES.map(locale => translate(locale, STANDARD[standard][1])).filter(alias => alias !== heading.name)
        : [];
    return {
      id: standard >= 0 ? STANDARD[standard][0] : `s${position + 1}`,
      name: heading.name,
      description: rest.join("\n").trim(),
      role,
      ...(count ? { count } : {}),
      aliases,
      callouts,
      line
    };
  });

  if (sections.length) {
    // The shared section rules; descriptions are not capped here (the 8,000-character file limit covers them).
    const checked: DetailTemplate = {
      id: options.id,
      name: "style",
      sections: sections.map(section => ({ ...section, description: "" }))
    };
    for (const found of validateTemplate(checked, [])) {
      const target = found.section ? sections[found.section - 1].line : sections[0].line;
      issues.push(issue(target, found.key, translate("en", found.key, ...found.values), ...found.values));
    }
  }

  if (issues.length) return { ok: false, issues: issues.sort((a, b) => a.line - b.line) };
  return {
    ok: true,
    style: {
      id: options.id,
      name: options.name,
      ...(tone ? { tone } : {}),
      layout: intro ? "intro" : "sections",
      intro,
      sections,
      template: { id: options.id, name: options.name, sections, layout: intro ? "intro" : "sections", intro }
    }
  };
}
