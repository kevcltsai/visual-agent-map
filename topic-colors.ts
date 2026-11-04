import type { TranslationKey } from "./i18n/en";
import { descendants, type MapNode } from "./map-graph";

/** Topic colours kept in a note's frontmatter (`topic-color`, one string id). Only whitelisted ids are shown. */
export const TOPIC_COLORS = ["red", "orange", "yellow", "green", "blue", "purple"] as const;
export type TopicColor = (typeof TOPIC_COLORS)[number];

/**
 * The colour read from note frontmatter. Only an exact whitelisted string counts; other casing, lists, numbers,
 * unknown ids and injected text all read as no colour.
 */
export function readTopicColor(fm: Record<string, unknown>): TopicColor | undefined {
  const raw = fm["topic-color"];
  return TOPIC_COLORS.find(id => id === raw);
}

/** The i18n key of a colour's name; the caller resolves it. */
export function colorLabelKey(id: TopicColor): TranslationKey {
  return `share.viewer_color_${id}`;
}

/**
 * Card styles kept in a note's frontmatter (`topic-style`, a list of string tokens). Only whitelisted tokens are shown.
 * `text-small` and `text-large` are one choice: when both are present the first one written wins.
 */
export const TOPIC_STYLES = ["bold", "text-small", "text-large", "border-thick", "line-thick"] as const;
export type TopicStyle = (typeof TOPIC_STYLES)[number];
const TEXT_SIZES: readonly TopicStyle[] = ["text-small", "text-large"];

/** The raw `topic-style` value as a list: a hand-written string is a one-item list, anything else non-list is empty. */
function rawStyleList(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : typeof raw === "string" && raw ? [raw] : [];
}

/**
 * The styles read from note frontmatter, in whitelist order. Only exact whitelisted strings count; other casing,
 * numbers, objects, null, injected text, unknown tokens and repeats read as nothing. Reading never rewrites the note.
 */
export function readTopicStyle(fm: Record<string, unknown>): TopicStyle[] {
  const list = rawStyleList(fm["topic-style"]);
  const size = list.find((v): v is TopicStyle => TEXT_SIZES.some(s => s === v));
  return TOPIC_STYLES.filter(id => (TEXT_SIZES.includes(id) ? id === size : list.includes(id)));
}

/**
 * The list to write after toggling `token`, or null when the key should be removed. Values this version does not know
 * (added by a newer version, or non-string items) are kept as they are. A text size is one choice: choosing one drops the
 * other, and choosing the one already shown removes every size token.
 */
export function toggleTopicStyle(raw: unknown, token: TopicStyle): string[] | null {
  const current = rawStyleList(raw);
  const shown = readTopicStyle({ "topic-style": raw });
  const drop = (ids: readonly string[]) => current.filter(v => typeof v !== "string" || !ids.includes(v));
  let next: unknown[];
  if (TEXT_SIZES.includes(token)) next = shown.includes(token) ? drop(TEXT_SIZES) : [...drop(TEXT_SIZES), token];
  else next = shown.includes(token) ? drop([token]) : [...current, token];
  return next.length ? (next as string[]) : null;
}

/**
 * The list to write so the whitelisted styles are exactly `styles` (used by "apply to whole branch"), or null when the key
 * should be removed. Unknown values are kept; whitelisted ones are replaced.
 */
export function setTopicStyle(raw: unknown, styles: readonly TopicStyle[]): string[] | null {
  const wanted = readTopicStyle({ "topic-style": styles });
  const rest = rawStyleList(raw).filter(v => typeof v !== "string" || !TOPIC_STYLES.some(id => id === v));
  const next = [...rest, ...wanted];
  return next.length ? (next as string[]) : null;
}

/**
 * The list to write after turning `add` on and `remove` off, or null when the key should be removed; "all" in `remove` turns
 * every whitelisted style off. Each change is the toggle of the style panel ({@link toggleTopicStyle}), made only when it
 * changes what is shown, so the text size stays one choice and unknown values stay as they are.
 */
export function changeTopicStyles(
  raw: unknown,
  add: readonly TopicStyle[],
  remove: readonly (TopicStyle | "all")[]
): string[] | null {
  let current: unknown = raw;
  const shown = (): TopicStyle[] => readTopicStyle({ "topic-style": current });
  const off = remove.includes("all") ? shown() : remove.filter((id): id is TopicStyle => id !== "all");
  for (const id of off) if (shown().includes(id)) current = toggleTopicStyle(current, id);
  for (const id of add) if (!shown().includes(id)) current = toggleTopicStyle(current, id);
  return rawStyleList(current).length ? (rawStyleList(current) as string[]) : null;
}

const STYLE_LABEL_KEYS: Record<TopicStyle, TranslationKey> = {
  bold: "ui.topic_style_bold",
  "text-small": "ui.topic_style_size_small",
  "text-large": "ui.topic_style_size_large",
  "border-thick": "ui.topic_style_border_thick",
  "line-thick": "ui.topic_style_line_thick"
};

/** The i18n key of a style's name; the caller resolves it. */
export function styleLabelKey(id: TopicStyle): TranslationKey {
  return STYLE_LABEL_KEYS[id];
}

/** The topic and all its descendants (folded ones included): the topic id first, then the rest. */
export function branchNoteIds(nodes: MapNode[], id: string): string[] {
  return [id, ...descendants(nodes, id)];
}
