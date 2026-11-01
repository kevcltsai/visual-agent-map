import type { TranslationKey } from "./i18n/en";

/** Topic markers kept in a note's frontmatter (`topic-markers`, a list of string ids). Only whitelisted ids are shown. */
export const TOPIC_MARKERS = [
  "done",
  "warning",
  "star",
  "priority-1",
  "priority-2",
  "priority-3",
  "priority-4",
  "priority-5",
  "progress-0",
  "progress-25",
  "progress-50",
  "progress-75",
  "progress-100",
  "flag-red",
  "flag-yellow",
  "flag-green",
  "flag-blue",
  "smile",
  "neutral",
  "sad",
  "question"
] as const;
export type TopicMarker = (typeof TOPIC_MARKERS)[number];

/** Menu groups in display order. `single` groups hold one value at a time; the others can hold several. */
export type TopicMarkerGroup = "status" | "priority" | "progress" | "flag" | "face";
export const TOPIC_MARKER_GROUPS: readonly { group: TopicMarkerGroup; single: boolean; ids: readonly TopicMarker[] }[] =
  [
    { group: "status", single: false, ids: ["done", "warning", "star"] },
    { group: "priority", single: true, ids: ["priority-1", "priority-2", "priority-3", "priority-4", "priority-5"] },
    {
      group: "progress",
      single: true,
      ids: ["progress-0", "progress-25", "progress-50", "progress-75", "progress-100"]
    },
    { group: "flag", single: false, ids: ["flag-red", "flag-yellow", "flag-green", "flag-blue"] },
    { group: "face", single: false, ids: ["smile", "neutral", "sad", "question"] }
  ];

/** The group a marker belongs to. */
export function markerGroup(id: TopicMarker): TopicMarkerGroup {
  return TOPIC_MARKER_GROUPS.find(g => g.ids.includes(id))!.group;
}

/** True when the marker's group holds one value at a time (priority, progress). */
export function isSingleChoiceMarker(id: TopicMarker): boolean {
  return TOPIC_MARKER_GROUPS.find(g => g.ids.includes(id))!.single;
}

const SYMBOLS: Record<TopicMarker, string> = {
  done: "✓",
  warning: "⚠",
  star: "★",
  "priority-1": "P1",
  "priority-2": "P2",
  "priority-3": "P3",
  "priority-4": "P4",
  "priority-5": "P5",
  "progress-0": "○",
  "progress-25": "◔",
  "progress-50": "◑",
  "progress-75": "◕",
  "progress-100": "●",
  "flag-red": "⚑R",
  "flag-yellow": "⚑Y",
  "flag-green": "⚑G",
  "flag-blue": "⚑B",
  smile: "☺",
  neutral: "-_-",
  sad: "☹",
  question: "?"
};

const LABEL_KEYS: Record<TopicMarker, TranslationKey> = {
  done: "share.viewer_marker_done",
  warning: "share.viewer_marker_warning",
  star: "share.viewer_marker_star",
  "priority-1": "share.viewer_marker_priority_1",
  "priority-2": "share.viewer_marker_priority_2",
  "priority-3": "share.viewer_marker_priority_3",
  "priority-4": "share.viewer_marker_priority_4",
  "priority-5": "share.viewer_marker_priority_5",
  "progress-0": "share.viewer_marker_progress_0",
  "progress-25": "share.viewer_marker_progress_25",
  "progress-50": "share.viewer_marker_progress_50",
  "progress-75": "share.viewer_marker_progress_75",
  "progress-100": "share.viewer_marker_progress_100",
  "flag-red": "share.viewer_marker_flag_red",
  "flag-yellow": "share.viewer_marker_flag_yellow",
  "flag-green": "share.viewer_marker_flag_green",
  "flag-blue": "share.viewer_marker_flag_blue",
  smile: "share.viewer_marker_smile",
  neutral: "share.viewer_marker_neutral",
  sad: "share.viewer_marker_sad",
  question: "share.viewer_marker_question"
};

/**
 * Markers read from note frontmatter. Only exact whitelisted ids count; a non-list value, other casing, numbers,
 * unknown ids and repeats read as nothing. The result follows the whitelist order, so every surface shows the same row.
 */
export function readTopicMarkers(fm: Record<string, unknown>): TopicMarker[] {
  const raw = fm["topic-markers"];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<TopicMarkerGroup>();
  // A single-choice group shows only its first whitelisted value (older versions could write several).
  return TOPIC_MARKERS.filter(id => {
    if (!raw.includes(id)) return false;
    if (!isSingleChoiceMarker(id)) return true;
    const group = markerGroup(id);
    if (seen.has(group)) return false;
    seen.add(group);
    return true;
  });
}

/**
 * The list to write after toggling `id`, or null when the key should be removed. Values this version does not know
 * (added by a newer version) are kept as they are; a single-choice group (priority, progress) holds one value, so adding one drops the others of that group.
 */
export function toggleTopicMarker(raw: unknown, id: TopicMarker): string[] | null {
  // A hand-written string is a one-item list; non-string items stay as they are (the writer quotes strings only).
  const current: unknown[] = Array.isArray(raw) ? raw : typeof raw === "string" && raw ? [raw] : [];
  const group = TOPIC_MARKER_GROUPS.find(g => g.ids.includes(id))!;
  const groupIds: readonly string[] = group.ids;
  let next: unknown[];
  if (group.single) {
    // Compare with the value the surfaces show (the first whitelisted one), not with any stored value.
    const shown = groupIds.find(g => current.includes(g));
    const rest = current.filter(v => typeof v !== "string" || !groupIds.includes(v));
    next = shown === id ? rest : [...rest, id];
  } else if (current.includes(id)) next = current.filter(v => v !== id);
  else next = [...current, id];
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
