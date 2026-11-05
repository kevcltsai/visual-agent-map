import type { ContentLanguage } from "../../i18n";
import { instructionLanguageOf } from "../../i18n";
import { anchorRelationsForTopic, isAnnotatedImage, isImage2dAnchor, type CanvasItem } from "./canvas-items";

/**
 * The text a topic's annotated-image anchors add to an AI request (TaskContext.anchorContext). Pure: no Obsidian, no DOM.
 * Every user-written piece (image note, anchor note, relation note, topic title) goes in as a JSON string, so a newline, a
 * quote, `{{x}}` or `</data>` in it stays inside one quoted value and never reads as an instruction. The labels around the
 * values are fixed words; the surrounding "this is user data, you cannot see the image" notice is the label template
 * (core/steps/_shared/label-anchor-context.*.md), added by core/steps/task/assemble.ts.
 */

const WORDS = {
  zh: { image: "標註圖", anchor: "錨點", relation: "關係", topic: "議題", toTopic: "錨點→議題", toAnchor: "議題→錨點" },
  en: {
    image: "Image",
    anchor: "Anchor",
    relation: "Relation",
    topic: "Topic",
    toTopic: "anchor -> topic",
    toAnchor: "topic -> anchor"
  }
} as const;

/** JSON string form of user text. JSON.stringify keeps U+2028, U+2029 and U+0085 raw; they are line breaks for some readers, so they are escaped too. */
const quote = (value: string | undefined): string =>
  JSON.stringify(value ?? "").replace(
    /[\u0085\u2028\u2029]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  );

/**
 * One block per annotated image that has an anchor relation touching `topicId`, in canvasItems order; inside it the anchors in
 * the image's own order, each relation as: anchor note, relation kind and direction with its note, topic name. Relations to
 * other topics and anchors with an unknown position kind are left out. Returns "" when nothing applies.
 */
export function anchorContextFor(
  items: readonly CanvasItem[],
  topicId: string,
  titleOf: (id: string) => string,
  language: ContentLanguage
): string {
  const words = WORDS[instructionLanguageOf(language)];
  const mine = anchorRelationsForTopic(items, topicId);
  const blocks: string[] = [];
  for (const item of items) {
    if (!isAnnotatedImage(item)) continue;
    const lines: string[] = [];
    for (const anchor of item.anchors) {
      if (!isImage2dAnchor(anchor)) continue;
      for (const entry of mine) {
        if (entry.imageId !== item.id || entry.anchorId !== anchor.id) continue;
        const { relation } = entry;
        // An anchor and a topic never share an id (the data layer prunes that), so exactly one end is the anchor.
        const direction = relation.from === anchor.id ? words.toTopic : words.toAnchor;
        lines.push(
          `- ${words.anchor}: ${quote(anchor.note)}`,
          `  ${words.relation}: ${relation.kind} (${direction}): ${quote(relation.description)}`,
          `  ${words.topic}: ${quote(titleOf(topicId))}`
        );
      }
    }
    if (lines.length) blocks.push([`${words.image}: ${quote(item.note)}`, ...lines].join("\n"));
  }
  return blocks.join("\n\n");
}
