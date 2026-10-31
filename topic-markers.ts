import type { TranslationKey } from "./i18n/en";

/** Topic markers kept in a note's frontmatter (`topic-markers`, a list of string ids). Only whitelisted ids are shown. */
export const TOPIC_MARKERS = ["done", "warning", "star", "priority-1", "priority-2", "priority-3"] as const;
export type TopicMarker = (typeof TOPIC_MARKERS)[number];

const PRIORITIES: readonly string[] = ["priority-1", "priority-2", "priority-3"];
const SYMBOLS: Record<TopicMarker, string> = {
  done: "✓",
  warning: "⚠",
  star: "★",
  "priority-1": "P1",
  "priority-2": "P2",
  "priority-3": "P3"
};

/**
 * Markers read from note frontmatter. Only exact whitelisted ids count; a non-list value, other casing, numbers,
 * unknown ids and repeats read as nothing. The result follows the whitelist order, so every surface shows the same row.
 */
export function readTopicMarkers(fm: Record<string, unknown>): TopicMarker[] {
  const raw = fm["topic-markers"];
  if (!Array.isArray(raw)) return [];
  return TOPIC_MARKERS.filter(id => raw.includes(id));
}

/**
 * The list to write after toggling `id`, or null when the key should be removed. Values this version does not know
 * (added by a newer version) are kept as they are; `priority-*` is one-of-three, so adding one drops the others.
 */
export function toggleTopicMarker(raw: unknown, id: TopicMarker): string[] | null {
  // A hand-written string is a one-item list; non-string items stay as they are (the writer quotes strings only).
  const current: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" && raw ? [raw] : [];
  let next: unknown[];
  if (current.includes(id)) next = current.filter(v => v !== id);
  else {
    next = PRIORITIES.includes(id) ? current.filter(v => typeof v !== "string" || !PRIORITIES.includes(v)) : current.slice();
    next.push(id);
  }
  return next.length ? (next as string[]) : null;
}

/** The plain-text symbol shown on cards, the outline and shared pages (never an image). */
export function markerSymbol(id: TopicMarker): string {
  return SYMBOLS[id];
}

/** The i18n key of a marker's name, shared by cards, the outline, the panel and the shared page; the caller resolves it. */
export function markerLabelKey(id: TopicMarker): TranslationKey {
  return `share.viewer_marker_${id.replace("-", "_") as "done" | "warning" | "star" | "priority_1" | "priority_2" | "priority_3"}`;
}
