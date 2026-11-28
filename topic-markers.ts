import type { TranslationKey } from "./i18n/en";

/** Topic markers kept in a note's frontmatter (`topic-markers`, a list of string ids). Only whitelisted ids are shown. */
export const TOPIC_MARKERS = ["done", "warning", "star"] as const;
export type TopicMarker = (typeof TOPIC_MARKERS)[number];

/** True for a whitelisted marker id; retired ids (priority, progress, flag, face) and anything else are not. */
export function isTopicMarker(value: unknown): value is TopicMarker {
  return typeof value === "string" && (TOPIC_MARKERS as readonly string[]).includes(value);
}

const SYMBOLS: Record<TopicMarker, string> = {
  done: "✓",
  warning: "⚠",
  star: "★"
};

const LABEL_KEYS: Record<TopicMarker, TranslationKey> = {
  done: "share.viewer_marker_done",
  warning: "share.viewer_marker_warning",
  star: "share.viewer_marker_star"
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
 * (added by a newer version, or the priority, progress, flag and face markers older versions wrote) are kept as they are.
 */
export function toggleTopicMarker(raw: unknown, id: TopicMarker): string[] | null {
  // A hand-written string is a one-item list; non-string items stay as they are (the writer quotes strings only).
  const current: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" && raw ? [raw] : [];
  const next = current.includes(id) ? current.filter(v => v !== id) : [...current, id];
  return next.length ? (next as string[]) : null;
}

/** The plain-text symbol shown on cards, the outline and shared pages (never an image). */
export function markerSymbol(id: TopicMarker): string {
  return SYMBOLS[id];
}

/** The i18n key of a marker's name, shared by cards, the outline, the panel and the shared page; the caller resolves it. */
export function markerLabelKey(id: TopicMarker): TranslationKey {
  return LABEL_KEYS[id];
}

/**
 * The list to write after turning `add` on and `remove` off, or null when the key should be removed; "all" in `remove` turns
 * every whitelisted marker off. Each change is the toggle of the marker panel ({@link toggleTopicMarker}), made only when it
 * changes what is shown, so unknown values stay as they are.
 */
export function changeTopicMarkers(
  raw: unknown,
  add: readonly TopicMarker[],
  remove: readonly (TopicMarker | "all")[]
): string[] | null {
  let current: unknown = raw;
  const shown = (): TopicMarker[] => readTopicMarkers({ "topic-markers": current });
  const off = remove.includes("all") ? shown() : remove.filter((id): id is TopicMarker => id !== "all");
  for (const id of off) if (shown().includes(id)) current = toggleTopicMarker(current, id);
  for (const id of add) if (!shown().includes(id)) current = toggleTopicMarker(current, id);
  const list: unknown[] = Array.isArray(current) ? current : typeof current === "string" && current ? [current] : [];
  return list.length ? (list as string[]) : null;
}
