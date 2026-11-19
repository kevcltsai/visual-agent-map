/**
 * Text helpers for what the pipeline writes into notes. Pure. Everything a model produced is collapsed to single lines
 * or has its `#`/`##` heading lines demoted before it is written, so it can never open a section of the note.
 */
import { createHash } from "node:crypto";

/** Lines that would start a note section (`# ` or `## `, up to three leading spaces) become `### `; nothing else changes. */
export function demoteHeadings(text: string): string {
  return text.replace(/^[ \t]{0,3}#{1,2}(?=[ \t]|$)[ \t]*/gm, "### ");
}

/** One line: whitespace collapsed, a leading heading marker demoted, at most `max` characters. */
export function singleLine(value: unknown, max = 400): string {
  if (typeof value !== "string") return "";
  const line = demoteHeadings(value.replace(/\s+/g, " ").trim());
  return Array.from(line).slice(0, max).join("");
}

/**
 * Plain text for a note: an allow-list, not a blacklist. Only letters, digits, marks, punctuation, symbols and single spaces
 * survive (control, format, zero-width and bidi characters go). `<`, `>` and `%` become their full-width forms (so no HTML,
 * callout, `%%` hidden section or `<!-- ... -->` marker can form); every other Markdown or Obsidian syntax character (backslash,
 * backtick, `[]()!*_|~#$`, and a list/quote/ordered-list marker at the line start) gets a backslash, so no image, link, tag,
 * code fence, table or list can form. {@link unescapeMarkdownText} undoes the backslashes (not the full-width forms).
 */
export function escapeMarkdownText(value: unknown, max = 400): string {
  if (typeof value !== "string") return "";
  const kept = value
    .replace(/[^\p{L}\p{N}\p{M}\p{P}\p{S}]+/gu, " ")
    .replace(/ +/g, " ")
    .trim();
  const text = Array.from(kept).slice(0, max).join("");
  return text
    .replace(/</g, "＜")
    .replace(/>/g, "＞")
    .replace(/%/g, "％")
    .replace(/[\\`*_[\]()!|~#$]/g, "\\$&")
    .replace(/^([-+])(?=[ ]|$)/, "\\$1")
    .replace(/^(\d+)([.)])/, "$1\\$2");
}

/** Undoes the backslashes {@link escapeMarkdownText} added. */
export function unescapeMarkdownText(text: string): string {
  return text.replace(/\\([\\`*_[\]()!|~#$.+-])/g, "$1");
}

/** A short stable hash of a text (line endings normalized), for revision keys. */
export function hashText(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n?/g, "\n")).digest("hex").slice(0, 16);
}
