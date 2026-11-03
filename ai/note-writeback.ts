/**
 * Note style recipe T4: the three ways a research result is written back into a topic's Detail.
 *
 * - merge: the caller already has the rewritten Detail (canonicalDetail); this only fixes the update-log line.
 * - top: the new findings are inserted into the old Detail and nothing else changes. Every insert is recorded by its
 *   offset in the result, and the old Detail must come back byte for byte once the inserts are cut out again.
 * - fresh: the new Detail replaces the old one; the old log lines stay and one line points at the backup.
 *
 * Pure functions (no obsidian import) plus `backupNote`, which talks to a small port.
 */
import { NOTE_LANGUAGES, translate, type NoteLanguage } from "../i18n";
import { fencedLines } from "./markdown-blocks";
import { sectionLookup, type DetailTemplate } from "./detail-templates";

export type WritebackMode = "merge" | "top" | "fresh";

export interface WritebackInsert {
  /** Offset of the inserted text in the written-back Detail. */
  offset: number;
  text: string;
}

export interface WritebackRecord {
  /** Strictly increasing offsets in the result. Empty for merge and fresh. */
  inserts: WritebackInsert[];
  /** The old text between the inserts, in order (inserts.length + 1 pieces, some empty). */
  kept: string[];
}

export interface WritebackInput {
  mode: WritebackMode;
  /** The topic's Detail before the run. */
  oldDetail: string;
  /** merge and fresh: the caller's canonicalDetail of the reply. top: the raw reply (new findings only). */
  aiDetail: string;
  summary: string;
  template: DetailTemplate;
  language: NoteLanguage;
  now: Date;
  /** fresh: where the old note was backed up. */
  backupPath?: string;
  /** Test seam: lets a test damage the assembled top result to prove the invariant check blocks it. */
  afterAssemble?: (detail: string) => string;
}

export type WritebackResult =
  { ok: true; detail: string; record: WritebackRecord } | { ok: false; reason: "top_invariant" };

const LOG_LINE_SUMMARY_LIMIT = 60;
const DATE_PREFIX = /^(?:[-*+][ \t]+)?\d{4}-\d{2}-\d{2}[ \t\u3000:：]*/;
const FOOTNOTE_REF = /\[\^([^\]\s]+)\]/g;
const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:/;

export function formatDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function formatTime(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

const placeholderTexts = (): Set<string> =>
  new Set([
    ...NOTE_LANGUAGES.map(locale => translate(locale, "note.no_new_information").replace(/[.。]$/, "")),
    "No new content this time",
    "本次無新增內容"
  ]);
const isPlaceholder = (text: string): boolean => placeholderTexts().has(text.trim().replace(/[.。]$/, ""));

// ---------------------------------------------------------------------------------------------------------------------
// Scanning

interface Heading {
  line: number;
  /** Heading text as written. */
  text: string;
  /** Section identity: `t<index>` for a template section, `log` for an update-log heading outside the template, else `h:<lower-cased text>`. */
  key: string;
}

interface Scan {
  text: string;
  lines: string[];
  starts: number[];
  code: boolean[];
  headings: Heading[];
}

interface Classifier {
  classify(text: string): string;
  logKey: string;
  sourcesKey: string | null;
}

function classifier(template: DetailTemplate, language: NoteLanguage): Classifier {
  const lookup = sectionLookup(template);
  const logIndex = template.sections.findIndex(section => section.role === "log");
  const sourcesIndex = template.sections.findIndex(section => section.role === "sources");
  const logNames = new Set(
    [...NOTE_LANGUAGES, language].map(locale => translate(locale, "detail.update_log").toLocaleLowerCase())
  );
  return {
    classify(text) {
      const key = text.toLocaleLowerCase();
      const index = lookup.get(key);
      if (index !== undefined) return `t${index}`;
      if (logIndex < 0 && logNames.has(key)) return "log";
      return `h:${key}`;
    },
    logKey: logIndex >= 0 ? `t${logIndex}` : "log",
    sourcesKey: sourcesIndex >= 0 ? `t${sourcesIndex}` : null
  };
}

function scan(text: string, classify: Classifier): Scan {
  const lines = text.split("\n");
  const starts: number[] = [];
  let position = 0;
  for (const line of lines) {
    starts.push(position);
    position += line.length + 1;
  }
  const code = fencedLines(lines);
  const headings: Heading[] = [];
  lines.forEach((line, index) => {
    if (code[index]) return;
    const match = /^###\s+(.+?)\s*$/.exec(line);
    if (match) headings.push({ line: index, text: match[1], key: classify.classify(match[1]) });
  });
  return { text, lines, starts, code, headings };
}

const lineEnd = (view: Scan, line: number): number => view.starts[line] + view.lines[line].length;

/** The first heading of a section and the line range of its body (heading excluded). */
function sectionRange(view: Scan, key: string): { heading: Heading; from: number; to: number } | null {
  const position = view.headings.findIndex(heading => heading.key === key);
  if (position < 0) return null;
  const heading = view.headings[position];
  return { heading, from: heading.line + 1, to: view.headings[position + 1]?.line ?? view.lines.length };
}

interface FootnoteDefinition {
  label: string;
  first: number;
  last: number;
  text: string;
  target: string;
}

/** Footnote definitions outside code, each with its indented continuation lines. */
function definitions(view: { lines: string[]; code: boolean[] }): FootnoteDefinition[] {
  const found: FootnoteDefinition[] = [];
  for (let index = 0; index < view.lines.length; index++) {
    const match = view.code[index] ? null : FOOTNOTE_DEF.exec(view.lines[index]);
    if (!match) continue;
    let last = index;
    while (last + 1 < view.lines.length && !view.code[last + 1] && /^(?: {2,}|\t)\S/.test(view.lines[last + 1])) last++;
    const text = view.lines.slice(index, last + 1).join("\n");
    found.push({
      label: match[1],
      first: index,
      last,
      text,
      target: text.slice(match[0].length).replace(/\s+/g, " ").trim()
    });
    index = last;
  }
  return found;
}

function lastContentLine(view: Scan, from: number, to: number): number {
  const definition = new Set<number>();
  for (const item of definitions(view)) for (let line = item.first; line <= item.last; line++) definition.add(line);
  for (let index = to - 1; index >= from; index--) if (view.lines[index].trim() && !definition.has(index)) return index;
  return -1;
}

// ---------------------------------------------------------------------------------------------------------------------
// Update-log lines

const summaryLine = (now: Date, summary: string): string =>
  `${formatDate(now)}\u3000${Array.from(summary.replace(/\s+/g, " ").trim()).slice(0, LOG_LINE_SUMMARY_LIMIT).join("")}`;

/** The list marker the old log lines use ("- " and the like); empty when the last old line has none (or there is no old line). */
function logMarker(oldLines: string[]): string {
  const last = oldLines.at(-1);
  return last ? (/^\s*[-*+]\s+/.exec(last)?.[0] ?? "") : "";
}

/** The log section's body lines: non-empty, placeholders left out. */
function logLines(view: Scan, key: string): string[] {
  const range = sectionRange(view, key);
  if (!range) return [];
  return view.lines.slice(range.from, range.to).filter(line => line.trim() && !isPlaceholder(line));
}

function logHeadingName(template: DetailTemplate, language: NoteLanguage): string {
  return template.sections.find(section => section.role === "log")?.name ?? translate(language, "detail.update_log");
}

/** Rewrites the log section of a whole Detail with the given lines (placeholder and blank lines go), or adds it at the end. */
function withLogLines(
  detail: string,
  view: Scan,
  key: string,
  heading: string,
  linesFor: (existing: string[]) => string[]
): string {
  const range = sectionRange(view, key);
  const existing = range ? logLines(view, key) : [];
  const body = linesFor(existing).join("\n");
  if (!range) return `${detail.trimEnd()}\n\n### ${heading}\n\n${body}`;
  const before = view.lines.slice(0, range.from).join("\n");
  const after = range.to < view.lines.length ? `\n\n${view.lines.slice(range.to).join("\n")}` : "";
  return `${before}\n\n${body}${after}`;
}

function mergeLogLines(existing: string[], oldLines: string[], summary: string, now: Date): string[] {
  const marker = logMarker(oldLines);
  const old = new Set(oldLines.map(line => line.trim()));
  const added = existing.filter(line => !old.has(line.trim()));
  const kept = existing.filter(line => old.has(line.trim()));
  if (added.length === 1) return [...kept, added[0]];
  if (added.length === 0) return [...kept, `${marker}${summaryLine(now, summary)}`];
  const [first, ...rest] = added;
  return [...kept, [first, ...rest.map(line => line.trim().replace(DATE_PREFIX, "").trim())].join("；")];
}

// ---------------------------------------------------------------------------------------------------------------------
// top

interface PlannedInsert {
  at: number;
  text: string;
  order: number;
}

interface NewSection {
  key: string;
  name: string;
  role: "none" | "sources" | "log";
  body: string;
}

/** Splits a reply into sections by heading (code fences respected); the text before the first heading is not a section. */
function replySections(reply: string, classify: Classifier, template: DetailTemplate): NewSection[] {
  const view = scan(reply, classify);
  const found = new Map<string, NewSection>();
  view.headings.forEach((heading, position) => {
    const to = view.headings[position + 1]?.line ?? view.lines.length;
    const body = view.lines.slice(heading.line + 1, to);
    const existing = found.get(heading.key);
    const part = body.join("\n");
    if (existing) {
      existing.body = `${existing.body}\n\n${part}`;
      return;
    }
    const index = heading.key.startsWith("t") ? Number(heading.key.slice(1)) : -1;
    const section = index >= 0 ? template.sections[index] : undefined;
    found.set(heading.key, {
      key: heading.key,
      name: section?.name ?? heading.text,
      role: section?.role ?? (heading.key === "log" ? "log" : "none"),
      body: part
    });
  });
  const sections = [...found.values()];
  const order = (section: NewSection) => (section.key.startsWith("t") ? Number(section.key.slice(1)) : 1e6);
  return sections
    .map((section, position) => ({ section, position }))
    .sort((a, b) => order(a.section) - order(b.section) || a.position - b.position)
    .map(item => item.section);
}

/** A sub-heading inside inserted content must sit below the `####` date heading. */
function deepenHeadings(body: string): string {
  const lines = body.split("\n");
  const code = fencedLines(lines);
  return lines
    .map((line, index) => {
      const match = code[index] ? null : /^(#{1,6})([ \t]+.*|[ \t]*)$/.exec(line);
      return match && match[1].length < 5 ? `#####${match[2]}` : line;
    })
    .join("\n");
}

function relabel(text: string, map: Map<string, string>): string {
  if (!map.size) return text;
  const lines = text.split("\n");
  const code = fencedLines(lines);
  return lines
    .map((line, index) =>
      code[index]
        ? line
        : line.replace(FOOTNOTE_REF, (whole, label: string) => (map.has(label) ? `[^${map.get(label)}]` : whole))
    )
    .join("\n");
}

function composeTop(input: WritebackInput): WritebackResult {
  const { oldDetail: old, template, language, now } = input;
  const classify = classifier(template, language);
  const oldView = scan(old, classify);
  const date = formatDate(now);
  const sections = replySections(input.aiDetail, classify, template).filter(section => section.key !== classify.logKey);

  // Footnotes: definitions leave the section bodies; labels the reply defines itself are renumbered after the old ones.
  const oldDefinitions = definitions(oldView);
  const oldTargets = new Map(oldDefinitions.map(item => [item.label, item.target]));
  let counter = 0;
  oldView.lines.forEach((line, index) => {
    if (oldView.code[index]) return;
    for (const match of line.matchAll(FOOTNOTE_REF))
      if (/^\d+$/.test(match[1])) counter = Math.max(counter, Number(match[1]));
  });
  const used = new Set([...oldTargets.keys()]);
  const map = new Map<string, string>();
  const newDefinitions: { label: string; text: string }[] = [];
  const seen = new Set<string>();
  const bodies = sections.map(section => {
    const lines = section.body.split("\n");
    const view = { lines, code: fencedLines(lines) };
    const defined = definitions(view);
    const drop = new Set<number>();
    for (const item of defined) {
      for (let line = item.first; line <= item.last; line++) drop.add(line);
      if (seen.has(item.label)) continue;
      seen.add(item.label);
      if (oldTargets.get(item.label) === item.target) continue;
      let label = item.label;
      if (/^\d+$/.test(label)) {
        counter++;
        label = String(counter);
      } else if (used.has(label)) {
        let suffix = 2;
        while (used.has(`${label}-${suffix}`)) suffix++;
        label = `${label}-${suffix}`;
      }
      used.add(label);
      if (label !== item.label) map.set(item.label, label);
      newDefinitions.push({ label: item.label, text: item.text });
    }
    return lines.filter((_line, index) => !drop.has(index)).join("\n");
  });

  const plan: PlannedInsert[] = [];
  const endParts: string[] = [];
  const batch: string[] = [];
  const bodyOf = (index: number, dated: boolean): string => {
    const body = relabel(bodies[index].trim(), map);
    return dated ? deepenHeadings(body) : body;
  };
  const needsBlank = (at: number): boolean => old[at] === "\n" && at + 1 < old.length && old[at + 1] !== "\n";

  sections.forEach((section, index) => {
    const content = bodies[index].trim();
    if (!content || isPlaceholder(content)) return;
    const dated = section.role !== "sources";
    const body = bodyOf(index, dated);
    const range = sectionRange(oldView, section.key);
    if (!range) {
      batch.push(dated ? `### ${section.name}\n\n#### ${date}\n\n${body}` : `### ${section.name}\n\n${body}`);
      return;
    }
    if (dated) {
      const at = lineEnd(oldView, range.heading.line);
      plan.push({ at, text: `\n\n#### ${date}\n\n${body}${needsBlank(at) ? "\n" : ""}`, order: 0 });
      return;
    }
    const last = lastContentLine(oldView, range.from, range.to);
    const existing = new Set(oldView.lines.slice(range.from, range.to).map(line => line.trim()));
    const items = body
      .split("\n")
      .filter(line => !line.trim() || !existing.has(line.trim()))
      .join("\n")
      .trim();
    if (!items) return;
    const at = lineEnd(oldView, last >= 0 ? last : range.heading.line);
    plan.push({
      at,
      text: `${last >= 0 ? "\n" : "\n\n"}${items}${last >= 0 || !needsBlank(at) ? "" : "\n"}`,
      order: 0
    });
  });

  if (batch.length) {
    if (oldView.headings.length) {
      const at = oldView.starts[oldView.headings[0].line];
      const lead = at > 0 && old.slice(at - 2, at) !== "\n\n" ? "\n" : "";
      plan.push({ at, text: `${lead}${batch.join("\n\n")}\n\n`, order: 0 });
    } else endParts.push(batch.join("\n\n"));
  }

  // The plugin's own log line goes last in the log section; a missing section is added at the end.
  const logRange = sectionRange(oldView, classify.logKey);
  // The new line uses the same list marker as the old log lines, so the section stays one list.
  const logLine = `${logMarker(logLines(oldView, classify.logKey))}${summaryLine(now, input.summary)}`;
  if (logRange) {
    const content = lastContentLine(oldView, logRange.from, logRange.to);
    const at = lineEnd(oldView, content >= 0 ? content : logRange.heading.line);
    plan.push({
      at,
      text: `${content >= 0 ? "\n" : "\n\n"}${logLine}${content >= 0 || !needsBlank(at) ? "" : "\n"}`,
      order: 1
    });
  } else endParts.push(`### ${logHeadingName(template, language)}\n\n${logLine}`);

  if (newDefinitions.length) {
    const text = newDefinitions
      .map(item => item.text.replace(/^\[\^([^\]\s]+)\]/, (_whole, label: string) => `[^${map.get(label) ?? label}]`))
      .join("\n");
    const last = oldDefinitions[oldDefinitions.length - 1];
    if (last) plan.push({ at: lineEnd(oldView, last.last), text: `\n${text}`, order: -1 });
    else endParts.push(text);
  }

  if (endParts.length) {
    const separator = !old ? "" : old.endsWith("\n\n") ? "" : old.endsWith("\n") ? "\n" : "\n\n";
    plan.push({ at: old.length, text: `${separator}${endParts.join("\n\n")}`, order: 2 });
  }

  plan.sort((a, b) => a.at - b.at || a.order - b.order);
  let detail = "";
  let cursor = 0;
  const inserts: WritebackInsert[] = [];
  for (const item of plan) {
    detail += old.slice(cursor, item.at);
    inserts.push({ offset: detail.length, text: item.text });
    detail += item.text;
    cursor = item.at;
  }
  detail += old.slice(cursor);
  if (input.afterAssemble) detail = input.afterAssemble(detail);
  const record = recordOf(detail, inserts);
  return verifyInserts(old, detail, inserts) ? { ok: true, detail, record } : { ok: false, reason: "top_invariant" };
}

function recordOf(detail: string, inserts: WritebackInsert[]): WritebackRecord {
  const kept: string[] = [];
  let position = 0;
  for (const insert of inserts) {
    kept.push(detail.slice(position, insert.offset));
    position = insert.offset + insert.text.length;
  }
  kept.push(detail.slice(position));
  return { inserts, kept };
}

/**
 * The top invariant: cut every recorded insert out of the result by its offset and the old Detail must come back exactly.
 * Offsets must increase without overlap and each insert must really sit at its offset. No substring search.
 */
export function verifyInserts(oldDetail: string, detail: string, inserts: WritebackInsert[]): boolean {
  const pieces: string[] = [];
  let position = 0;
  for (const insert of inserts) {
    if (!insert.text || insert.offset < position || insert.offset + insert.text.length > detail.length) return false;
    if (detail.slice(insert.offset, insert.offset + insert.text.length) !== insert.text) return false;
    pieces.push(detail.slice(position, insert.offset));
    position = insert.offset + insert.text.length;
  }
  pieces.push(detail.slice(position));
  return pieces.join("") === oldDetail;
}

/**
 * After background charting: the old text pieces must all still be there, in order and without overlap, and nothing may
 * come before the first of them unless the first insert was at the very start. Only the inserted content may have changed.
 */
export function chartPreserves(record: WritebackRecord, charted: string): boolean {
  let position = 0;
  let first = true;
  for (const piece of record.kept) {
    if (!piece) {
      first = false;
      continue;
    }
    const found =
      first && record.inserts[0]?.offset !== 0
        ? charted.startsWith(piece)
          ? 0
          : -1
        : charted.indexOf(piece, position);
    if (found < 0) return false;
    position = found + piece.length;
    first = false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry point

export function composeWriteback(input: WritebackInput): WritebackResult {
  if (input.mode === "top") return composeTop(input);
  const classify = classifier(input.template, input.language);
  const key = classify.logKey;
  const heading = logHeadingName(input.template, input.language);
  const view = scan(input.aiDetail, classify);
  let detail: string;
  if (input.mode === "merge") {
    const oldLines = logLines(scan(input.oldDetail, classify), key);
    detail = withLogLines(input.aiDetail, view, key, heading, existing =>
      mergeLogLines(existing, oldLines, input.summary, input.now)
    );
  } else {
    const oldLines = logLines(scan(input.oldDetail, classify), key);
    const line = `${logMarker(oldLines)}${formatDate(input.now)}\u3000${translate(input.language, "note.writeback_fresh_replaced_0", input.backupPath ?? "")}`;
    detail = withLogLines(input.aiDetail, view, key, heading, () => [...oldLines, line]);
  }
  return { ok: true, detail, record: { inserts: [], kept: [detail] } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Backup

export interface BackupPort {
  folderExists(path: string): Promise<boolean>;
  /** File names (or paths) in the folder. */
  list(folder: string): Promise<string[]>;
  createFolder(path: string): Promise<void>;
  create(path: string, content: string): Promise<void>;
  read(path: string): Promise<string>;
}

export type BackupResult = { ok: true; path: string } | { ok: false };

/**
 * Copies a note file byte for byte to `<folder>/<note name> YYYY-MM-DD HHmmss.md` (never overwriting: ` (n)` on a clash)
 * and reads it back. Any failure, or a copy that differs, is `{ ok: false }`; it never throws. The folder is created only here.
 */
export async function backupNote(
  port: BackupPort,
  input: { notePath: string; content: string; folder: string; now: Date }
): Promise<BackupResult> {
  try {
    const folder = input.folder.replace(/\/+$/, "");
    const parts = folder.split("/").filter(Boolean);
    let exists = true;
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(0, index + 1).join("/");
      if (await port.folderExists(path)) continue;
      exists = false;
      await port.createFolder(path);
    }
    const taken = new Set(
      exists ? (await port.list(folder)).map(name => (name.split("/").pop() ?? name).toLocaleLowerCase()) : []
    );
    const base = (input.notePath.split("/").pop() ?? input.notePath).replace(/\.md$/i, "");
    const stem = `${base} ${formatDate(input.now)} ${formatTime(input.now)}`;
    let name = `${stem}.md`;
    for (let attempt = 1; taken.has(name.toLocaleLowerCase()); attempt++) name = `${stem} (${attempt}).md`;
    const path = `${folder}/${name}`;
    await port.create(path, input.content);
    return (await port.read(path)) === input.content ? { ok: true, path } : { ok: false };
  } catch {
    return { ok: false };
  }
}
