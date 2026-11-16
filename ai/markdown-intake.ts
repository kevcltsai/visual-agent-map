import { guardInlineHtmlLinks } from "./markdown-blocks";
import { demoteUnparsableMermaid, neutralizeUnsafeMermaid, type MermaidSyntaxCheck } from "./mermaid-safety";
import { dedupeImageEmbeds } from "../core/image-keys";

/**
 * The one door for AI-written Markdown on its way into a note or file: which cleanup steps run for each destination,
 * and in which order, is defined only here. Destinations without a parser check are `intakeAiMarkdown` (sync);
 * destinations that also need it are `intakeAiMarkdownChecked` (an await), so a caller keeps its stale checks and its
 * write free of an await it did not ask for.
 */
export type AiMarkdownTarget =
  /** guard -> compose (sync business steps of the caller) -> dedupe (images in `seenImages` and earlier in the text). */
  | { kind: "task-detail"; seenImages?: Iterable<string>; compose?: (guarded: string) => string }
  /** guard (frontmatter, inserted range [at, at + insertedLength)) -> dedupe (file, inserted range [at, length - tail)). */
  | { kind: "chat-file-edit"; at: number; insertedLength: number; tail: number }
  /** neutralize. */
  | { kind: "argument-detail" };

export type CheckedAiMarkdownTarget =
  /** guard -> dedupe -> neutralize -> parser demote. */
  | { kind: "chat-topic-detail" }
  /** guard (frontmatter) -> dedupe (file) -> neutralize -> parser demote. */
  | { kind: "chat-new-file" }
  /** Only when the text mentions mermaid: neutralize -> parser demote; any other text is returned as it is. */
  | { kind: "selection-insert" };

export function intakeAiMarkdown(text: string, target: AiMarkdownTarget): string {
  switch (target.kind) {
    case "task-detail": {
      const guarded = guardInlineHtmlLinks(text);
      const composed = target.compose ? target.compose(guarded) : guarded;
      return target.seenImages ? dedupeImageEmbeds(composed, { seen: target.seenImages }) : dedupeImageEmbeds(composed);
    }
    case "chat-file-edit": {
      const guarded = guardInlineHtmlLinks(text, {
        frontmatter: true,
        range: { start: target.at, end: target.at + target.insertedLength }
      });
      return dedupeImageEmbeds(guarded, { file: true, range: { start: target.at, end: guarded.length - target.tail } });
    }
    case "argument-detail":
      return neutralizeUnsafeMermaid(text);
  }
}

export async function intakeAiMarkdownChecked(
  text: string,
  target: CheckedAiMarkdownTarget,
  check: MermaidSyntaxCheck | undefined
): Promise<string> {
  switch (target.kind) {
    case "chat-topic-detail":
      return demoteUnparsableMermaid(neutralizeUnsafeMermaid(dedupeImageEmbeds(guardInlineHtmlLinks(text))), check);
    case "chat-new-file":
      return demoteUnparsableMermaid(
        neutralizeUnsafeMermaid(dedupeImageEmbeds(guardInlineHtmlLinks(text, { frontmatter: true }), { file: true })),
        check
      );
    case "selection-insert":
      return /mermaid/i.test(text) ? await demoteUnparsableMermaid(neutralizeUnsafeMermaid(text), check) : text;
  }
}
