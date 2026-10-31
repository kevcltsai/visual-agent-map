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

/** The topic and all its descendants (folded ones included): the topic id first, then the rest. */
export function branchNoteIds(nodes: MapNode[], id: string): string[] {
  return [id, ...descendants(nodes, id)];
}
