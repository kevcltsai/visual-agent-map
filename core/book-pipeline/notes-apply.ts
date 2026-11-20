/**
 * Applying the reader's notes to a picture-book chapter, the pure half. The notes are `==text==%%備註#n：note%%` wrappers (see
 * book-notes). The AI rewrites only the paragraphs that carry a note; links and images are hidden behind placeholder tokens so they come
 * back exactly once, and a reply that holds any syntax the program owns (callout, checkbox, new link, `%%`, `==`, heading) is refused.
 * The program finds each paragraph again by its exact text and replaces it in one pass; a paragraph that changed meanwhile, or that
 * cannot be told from another, is left alone and its note says so. Every replacement is recorded so it can be undone.
 */
import { findNotes } from "./book-notes";
import { chapterTextMask } from "./note-sections";

/** Written inside the note text of a note that was not applied because its paragraph changed; the program reads it back. */
export const SKIP_MARK = " ⚠ 原文已改，這則沒套用";
/** Written the same way when the AI's rewrite of the paragraph was refused (wrong format); the paragraph is untouched. */
export const REFUSED_MARK = " ⚠ AI 改寫不合格式，這則沒套用";
/** A note text without the program's own mark (it is program text and never goes to the model). */
const stripMark = (note: string): string =>
  note.endsWith(SKIP_MARK)
    ? note.slice(0, -SKIP_MARK.length)
    : note.endsWith(REFUSED_MARK)
      ? note.slice(0, -REFUSED_MARK.length)
      : note;

/** A run of consecutive visible, non-blank chapter lines. `[from, to)` is the raw range (without the final `\r`); `text` uses `\n`. */
export interface NoteParagraph {
  from: number;
  to: number;
  text: string;
  crlf: boolean;
}

/** Every visible chapter paragraph of a note's raw text. */
export function chapterParagraphs(raw: string): NoteParagraph[] {
  const lines = raw.split("\n");
  const mask = chapterTextMask(lines);
  const out: NoteParagraph[] = [];
  let at = 0;
  let open: { from: number; to: number } | undefined;
  const close = (): void => {
    if (!open) return;
    const slice = raw.slice(open.from, open.to);
    out.push({ ...open, text: slice.replace(/\r\n/g, "\n"), crlf: slice.includes("\r\n") });
    open = undefined;
  };
  lines.forEach((line, i) => {
    const bare = line.replace(/\r$/, "");
    if (mask[i] && bare.trim()) open = { from: open?.from ?? at, to: at + bare.length };
    else close();
    at += line.length + 1;
  });
  close();
  return out;
}

/** What the model is shown for one paragraph. `links` stay on the program's side. */
export interface EncodedItem {
  id: string;
  text: string;
  links: string[];
  notes: { id: string; note: string }[];
}
export interface NoteItem {
  id: string;
  /** The paragraph as it was read (`\n` line ends, the wrappers still in). */
  text: string;
  numbers: number[];
  /** null: not sent (placeholder-looking text, a table, a link around a note, syntax the program owns); its notes stay. */
  encoded: EncodedItem | null;
}

const LINK =
  /!\[\[[^\]\n]*\]\]|\[\[[^\]\n]*\]\]|!\[[^\]\n]*\]\([^)\n]*\)|\[[^\]\n]*\]\([^)\n]*\)|<https?:\/\/[^>\s]+>|https?:\/\/[^\s<>)\]]+/g;

/** The first piece of program-owned syntax in a text, or null. Tokens `⟦..⟧` never match any of these. */
export function forbiddenSyntax(text: string): string | null {
  if (/\[!/.test(text)) return "callout";
  if (/\[[ xX]\]/.test(text)) return "checkbox";
  if (/\]\(|\[\[|!\[|\]\[|https?:\/\/|www\./i.test(text)) return "link";
  if (/<[A-Za-z/!]/.test(text)) return "html";
  if (/%%/.test(text)) return "comment";
  if (/==/.test(text)) return "highlight";
  if (/^\s{0,3}#{1,6}(\s|$)/m.test(text)) return "heading";
  return null;
}

/** The note markers and link tokens for one paragraph, or null when it cannot be sent safely. */
export function encodeParagraph(id: string, text: string): EncodedItem | null {
  if (/[⟦⟧]/.test(text)) return null;
  const found = findNotes(text);
  let marked = "";
  let pos = 0;
  for (const f of found) {
    marked += `${text.slice(pos, f.from)}⟦N${f.n}⟧${f.selected}⟦/N${f.n}⟧`;
    pos = f.to;
  }
  marked += text.slice(pos);
  const links: string[] = [];
  let swallowed = false;
  const encoded = marked.replace(LINK, link => {
    if (/[⟦⟧]/.test(link)) swallowed = true;
    links.push(link);
    return `⟦L${links.length}⟧`;
  });
  if (swallowed || encoded.includes("|") || forbiddenSyntax(encoded)) return null;
  return { id, text: encoded, links, notes: found.map(f => ({ id: `N${f.n}`, note: stripMark(f.note) })) };
}

/** The paragraphs that carry a note, numbered `p1..pn` in order. */
export function snapshotNotes(raw: string): NoteItem[] {
  const items: NoteItem[] = [];
  for (const p of chapterParagraphs(raw)) {
    const found = findNotes(p.text);
    if (!found.length) continue;
    const id = `p${items.length + 1}`;
    items.push({ id, text: p.text, numbers: found.map(f => f.n), encoded: encodeParagraph(id, p.text) });
  }
  return items;
}

const LEAD = /^\s*(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+)?/;

/** A lead with one space after each `>` and after the marker dropped, so only that single space may differ from the original. */
const canonLead = (lead: string): string => lead.replace(/> ?/g, ">").replace(/([-*+]|\d+[.)]) ?$/, "$1");
const leadOf = (line: string): string => LEAD.exec(line)?.[0] ?? "";
/** The reply lead is the original's, give or take one space after `>` or the marker; a tab is never allowed (so no 4-column run appears that the original lacks). */
function sameLead(original: string, reply: string): boolean {
  const lead = leadOf(reply);
  return !lead.includes("\t") && canonLead(lead) === canonLead(leadOf(original));
}

/** Prose punctuation any rewrite may use; every other mark must already be in the original paragraph. */
const BASE_PUNCT = new Set([..." ,.;:!?'\"()，。、；：！？（）「」『』‘’“”…—–/%·《》〈〉～‧・【】-"]);
/** A line body may only start with a letter, a number, a link token or one of these opening marks. */
const OPENERS = new Set([..."'\"(（「『‘“《〈【…"]);
const STARTS_LIKE_PROSE = /^[\p{L}\p{N}]/u;
const TOKEN = /⟦L\d+⟧/g;

/**
 * Whitelist half of the reply check: no line may start a block construct (fence, math block, thematic or setext line, footnote, deep
 * indent, a list mark the original line lacked), and every character is a letter, number, mark, space, a prose mark, or a mark the
 * original paragraph already used. Returns the first breach or null.
 */
function whitelistBreach(original: string, before: string[], lines: string[]): string | null {
  const allowed = new Set([...original.replace(TOKEN, "")].filter(c => !/[\p{L}\p{N}\p{M}\s]/u.test(c)));
  for (const c of BASE_PUNCT) allowed.add(c);
  for (const mark of ["```", "~~~", "$$"])
    if (lines.join("\n").includes(mark) && !original.includes(mark)) return "block syntax";
  for (const [i, line] of lines.entries()) {
    const body = line.slice(LEAD.exec(line)?.[0].length ?? 0);
    const first = body.replace(/^\s+/, "");
    if (!STARTS_LIKE_PROSE.test(first) && !first.startsWith("⟦L") && !OPENERS.has(first[0] ?? ""))
      return "block syntax";
    if (/^\s{0,3}(?:`{3,}|~{3,}|\$\$|\[\^|#)/.test(body)) return "block syntax";
    if (/^\s*(?:[-*+]|\d+[.)])(\s|$)/.test(body)) return "list mark";
    const indent = (t: string): boolean => /^(?: {4,}|\t)/.test(t);
    if (indent(line) && !indent(before[i])) return "indent";
    for (const c of body.replace(TOKEN, "")) if (!/[\p{L}\p{N}\p{M}\s]/u.test(c) && !allowed.has(c)) return "character";
  }
  return null;
}

export type RewriteCheck = { ok: true; text: string } | { ok: false; reason: string };
/** One rewritten paragraph: same lines and list marks, no blank line, every link token once, no note marker, nothing the program owns. */
export function checkRewrite(item: Pick<EncodedItem, "text" | "links">, reply: string): RewriteCheck {
  const no = (reason: string): RewriteCheck => ({ ok: false, reason });
  const text = reply.replace(/\r\n?/g, "\n");
  if (!text.trim()) return no("empty paragraph");
  const lines = text.split("\n");
  const before = item.text.split("\n");
  if (lines.length !== before.length) return no("line count changed");
  if (lines.some(line => !line.trim())) return no("blank line");
  if (lines.some((line, i) => !sameLead(before[i], line))) return no("list or quote mark changed");
  const bad = forbiddenSyntax(text) ?? whitelistBreach(item.text, before, lines);
  if (bad) return no(`new ${bad}`);
  if (/⟦\/?N/.test(text)) return no("note marker left");
  const seen = new Set<number>();
  for (const m of text.matchAll(/⟦L(\d+)⟧/g)) {
    const at = Number(m[1]);
    if (at < 1 || at > item.links.length) return no("unknown link token");
    if (seen.has(at)) return no("link token repeated");
    seen.add(at);
  }
  if (seen.size !== item.links.length) return no("link token missing");
  const restored = text.replace(/⟦L(\d+)⟧/g, (_, at: string) => item.links[Number(at) - 1]);
  if (/[⟦⟧]/.test(restored)) return no("unknown token");
  return { ok: true, text: restored };
}

/** One replaced paragraph; `[from, to)` is its range in the new text. */
export interface AppliedEdit {
  id: string;
  before: string;
  after: string;
  from: number;
  to: number;
}
export interface ApplyOutcome {
  text: string;
  applied: AppliedEdit[];
  /** Paragraphs left alone (edited, repeated or gone). */
  skipped: number;
  /** Notes that got the skip mark in their note text. */
  marked: number;
}

interface Edit {
  from: number;
  to: number;
  insert: string;
  replace?: { id: string; before: string; after: string };
}
const eol = (text: string, crlf: boolean): string => (crlf ? text.replace(/\n/g, "\r\n") : text);

function runEdits(raw: string, edits: Edit[]): { text: string; ranges: Map<Edit, [number, number]> } {
  const sorted = [...edits].sort((a, b) => a.from - b.from);
  const ranges = new Map<Edit, [number, number]>();
  let out = "";
  let pos = 0;
  for (const e of sorted) {
    out += raw.slice(pos, e.from);
    const start = out.length;
    out += e.insert;
    ranges.set(e, [start, out.length]);
    pos = e.to;
  }
  return { text: out + raw.slice(pos), ranges };
}

/**
 * `raw` with each reply paragraph written over its original, in one pass. `replies` hold the paragraph id and the checked text
 * (links already restored). An original that is not found exactly once is not replaced; its notes get {@link SKIP_MARK}; a refused reply gets {@link REFUSED_MARK} (once each).
 */
export function applyReplies(
  raw: string,
  items: readonly NoteItem[],
  replies: readonly { id: string; text: string }[],
  refused: readonly string[] = []
): ApplyOutcome {
  const paragraphs = chapterParagraphs(raw);
  const notes = findNotes(raw);
  const edits: Edit[] = [];
  const marks: Edit[] = [];
  let skipped = 0;
  const skipNotes = (item: NoteItem, mark: string): void => {
    skipped++;
    const other = mark === SKIP_MARK ? REFUSED_MARK : SKIP_MARK;
    for (const n of notes.filter(f => item.numbers.includes(f.n) && !f.note.endsWith(mark))) {
      // The other mark is stale: it is replaced by the current reason.
      const stale = n.note.endsWith(other) ? other.length : 0;
      if (!marks.some(m => m.to === n.to - 2)) marks.push({ from: n.to - 2 - stale, to: n.to - 2, insert: mark });
    }
  };
  for (const id of refused) {
    const item = items.find(i => i.id === id);
    if (item) skipNotes(item, REFUSED_MARK);
  }
  for (const reply of replies) {
    const item = items.find(i => i.id === reply.id);
    if (!item) continue;
    const same = paragraphs.filter(p => p.text === item.text);
    if (same.length === 1) {
      const [p] = same;
      edits.push({
        from: p.from,
        to: p.to,
        insert: eol(reply.text, p.crlf),
        replace: { id: item.id, before: item.text, after: reply.text }
      });
      continue;
    }
    skipNotes(item, SKIP_MARK);
  }
  const free = marks.filter(m => !edits.some(e => m.from >= e.from && m.from <= e.to));
  const { text, ranges } = runEdits(raw, [...edits, ...free]);
  const applied = edits.map((e): AppliedEdit => {
    const [from, to] = ranges.get(e) ?? [0, 0];
    return { ...(e.replace as NonNullable<Edit["replace"]>), from, to };
  });
  return { text, applied: applied.sort((a, b) => a.from - b.from), skipped, marked: free.length };
}

/**
 * Where each applied paragraph (by its `after` text) stands in the note as it is now: the offsets the apply returned went stale when the
 * program stamped the review box after it. Only prose paragraphs are searched (never a callout); one that is not found exactly once is left out.
 */
export function locateApplied(raw: string, afters: readonly string[]): { from: number; to: number }[] {
  const paragraphs = chapterParagraphs(raw);
  const out: { from: number; to: number }[] = [];
  for (const after of afters) {
    const same = paragraphs.filter(p => p.text === after);
    if (same.length === 1) out.push({ from: same[0].from, to: same[0].to });
  }
  return out;
}

/**
 * `raw` with each recorded paragraph put back as it was (its note wrappers with it). A recorded `after` that is not found exactly
 * once is skipped and counted.
 */
export function undoApplied(
  raw: string,
  edits: readonly Pick<AppliedEdit, "before" | "after">[]
): { text: string; restored: number; skipped: number } {
  const paragraphs = chapterParagraphs(raw);
  const run: Edit[] = [];
  let skipped = 0;
  for (const e of edits) {
    const same = paragraphs.filter(p => p.text === e.after);
    if (same.length !== 1) {
      skipped++;
      continue;
    }
    run.push({ from: same[0].from, to: same[0].to, insert: eol(e.before, same[0].crlf) });
  }
  return { text: runEdits(raw, run).text, restored: run.length, skipped };
}

/** `text` with the wrappers of the given notes (all when none given) removed and their annotated text kept. */
export function stripNotes(text: string, numbers?: readonly number[]): string {
  const run = findNotes(text)
    .filter(f => !numbers || numbers.includes(f.n))
    .map((f): Edit => ({ from: f.from, to: f.to, insert: f.selected }));
  return runEdits(text, run).text;
}
