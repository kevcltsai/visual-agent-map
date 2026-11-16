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

/** A short stable hash of a text (line endings normalized), for revision keys. */
export function hashText(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n?/g, "\n")).digest("hex").slice(0, 16);
}
