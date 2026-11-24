/**
 * Cleans a note's Markdown before it is rendered and shared: wikilinks become plain text, note embeds become their
 * title only, vault attachments are replaced by `vam-asset:<name>` references (the exporter embeds the files), local
 * reference definitions are dropped. Web images keep their link. Fenced and inline code is left untouched.
 * `%%` and `<!-- -->` comments are NOT removed here: the renderer hides them (live-checked, D-2026-10-110), and what it
 * does not hide shows as plain text the author sees too.
 */
import { NOTE_LANGUAGES, translate } from "../../i18n";
import { youtubeVideoId } from "../../core/video-embeds";
import { commentRanges, markdownCodeRanges, normalizeNewlines } from "./share-code";
import { markAttachment, markNodeLink, stripNodeLinkMarks, VIDEO_MARK } from "./share-node-links";

export interface ShareCleanContext {
  /** Title of the note a link target points at, if known. */
  titleOf(target: string): string | undefined;
  /** The id of the map card a link target points at, if it is one; the link then becomes an in-map link (share-node-links.ts). */
  nodeIdOf?(target: string): string | undefined;
  /**
   * The Markdown a note embed (`![[note]]`, `note#Heading`, `note#^block`; the target as written) shows, if it can be shown
   * (share-embeds.ts, read by the exporter beforehand). Absent or undefined: the embed becomes its title. An embed in the
   * middle of a line is cut out of it into its own block.
   */
  embedOf?(target: string): string | undefined;
  /**
   * A file that is not a note or a picture (pdf, canvas, audio, office file…): the name its card carries (share-node-links.ts),
   * or undefined when the export cannot offer files (the embed then stays the file name as text).
   */
  attachmentOf?(ref: string): string | undefined;
  /** The callout title of an embed box for a note title (default: the title alone). */
  embedTitle?(title: string): string;
  /** Shared across the notes of one export so the same file gets the same asset name. */
  assets: AssetRegistry;
}
export interface ShareAttachment {
  /** The reference as the author wrote it (vault-relative or `../Attachments/x.png`), for the exporter to resolve. */
  ref: string;
  /** Name used as `vam-asset:<name>` and as the key in the payload `assets`. */
  name: string;
}
export interface ShareWebImage {
  url: string;
  alt: string;
}
export interface ShareCleanResult {
  markdown: string;
  attachments: ShareAttachment[];
  webImages: ShareWebImage[];
}
export interface AssetRegistry {
  nameFor(ref: string): string;
  entries(): ShareAttachment[];
}

export const SHARE_ASSET_SCHEME = "vam-asset:";
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
/**
 * What an embed target is, from its path alone. One rule for `![[…]]` and `![](…)` (Diagnostic Reset, share-export-complete):
 * a note (`.md` or no extension) is never shipped as a file, an image becomes an asset, anything else is an attachment.
 */
export function classifyShareTarget(path: string): "note" | "image" | "attachment" {
  const clean = path.split(/[?#]/)[0].trim();
  if (IMAGE_EXT.test(clean)) return "image";
  const ext = /\.([a-z0-9]{1,5})$/i.exec(clean);
  return !ext || ext[1].toLowerCase() === "md" ? "note" : "attachment";
}
const isWeb = (value: string): boolean => /^https?:\/\//i.test(value);

export function createAssetRegistry(): AssetRegistry {
  const byRef = new Map<string, string>();
  return {
    nameFor(ref) {
      const existing = byRef.get(ref);
      if (existing) return existing;
      const name = `image-${byRef.size + 1}`;
      byRef.set(ref, name);
      return name;
    },
    entries: () => [...byRef].map(([ref, name]) => ({ ref, name }))
  };
}

const basename = (target: string): string => {
  const noAnchor = target.split("#")[0].trim();
  return (noAnchor.split("/").pop() ?? noAnchor).replace(/\.md$/i, "");
};
const decodeRef = (ref: string): string => {
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
};
const escapeMd = (text: string): string => text.replace(/([\\`*_[\]])/g, "\\$1");

function splitWikilink(inner: string): { target: string; alias: string | undefined } {
  const bar = inner.search(/\\?\|/);
  if (bar < 0) return { target: inner.trim(), alias: undefined };
  const target = inner.slice(0, bar).trim();
  const alias = inner
    .slice(bar)
    .replace(/^\\?\|/, "")
    .trim();
  return { target, alias: alias || undefined };
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * The write-back's own "rewritten, old version backed up at <vault path>" log line, exactly as it writes it (any note
 * language, in a quote or callout, as a list item or not): `<date>` U+3000 `<text><folder>/<note> <date> <HHmmss>[ (n)].md<text>`.
 * A line the author changed in any way does not match, so the leak gate still sees it.
 */
const WRITEBACK_BACKUP_LINE = (() => {
  const marker = "\u0000";
  const shapes = NOTE_LANGUAGES.map(language =>
    translate(language, "note.writeback_fresh_replaced_0", marker).split(marker)
  ).filter(parts => parts.length === 2);
  const path = "[^\\n]+ \\d{4}-\\d{2}-\\d{2} \\d{6}(?: \\(\\d+\\))?\\.md";
  const texts = shapes.map(([head, tail]) => `${escapeRegExp(head)}${path}${escapeRegExp(tail)}`).join("|");
  return new RegExp(`^(?:[ \\t]*>[ \\t]?)*(?:[-*+][ \\t]+)?\\d{4}-\\d{2}-\\d{2}\u3000(?:${texts})[ \\t]*$`);
})();

/** Removes the write-back's backup log lines (see WRITEBACK_BACKUP_LINE): they name a vault path and mean nothing to a reader. */
export function dropWritebackBackupLines(text: string): string {
  return text
    .split("\n")
    .filter(line => !WRITEBACK_BACKUP_LINE.test(line))
    .join("\n");
}

/** `> [!vam-embed] title` and the cleaned content quoted under it, as its own block. One level: the content is cleaned without embeds. */
function embedBox(title: string, content: string, ctx: ShareCleanContext, out: ShareCleanResult): string {
  const inner = cleanShareMarkdown(content, { ...ctx, embedOf: undefined });
  for (const item of inner.attachments)
    if (!out.attachments.some(known => known.name === item.name)) out.attachments.push(item);
  out.webImages.push(...inner.webImages);
  const label = escapeMd(ctx.embedTitle ? ctx.embedTitle(title) : title).replace(/\s+/g, " ");
  const quoted = inner.markdown
    .trim()
    .split("\n")
    .map(line => (line ? `> ${line}` : ">"));
  return `\n\n> [!vam-embed] ${label}\n${quoted.join("\n")}\n\n`;
}

/** `hidden`: the text is inside a `%%`/`<!--` comment, which the renderer hides: embeds there are not expanded, read or registered. */
function cleanSegment(text: string, ctx: ShareCleanContext, out: ShareCleanResult, hidden = false): string {
  const attach = (ref: string): string => {
    const decoded = decodeRef(ref.trim());
    const name = ctx.assets.nameFor(decoded);
    if (!out.attachments.some(item => item.name === name)) out.attachments.push({ ref: decoded, name });
    return name;
  };
  const titleFor = (target: string): string => {
    const pathPart = target.split("#")[0].trim();
    if (!pathPart) return target.replace(/^#\^?/, "").trim();
    return ctx.titleOf(pathPart) ?? basename(pathPart);
  };
  // One pass over the original text, so replacement output is never rescanned.
  const pattern = /!\[\[([^\]\n]+)\]\]|\[\[([^\]\n]+)\]\]|!\[([^\]\n]*)\]\(([^)\n]+)\)|\[([^\]\n]*)\]\(([^)\n]+)\)/g;
  return text.replace(
    pattern,
    (
      all: string,
      embed: string | undefined,
      link: string | undefined,
      alt: string | undefined,
      src: string | undefined,
      label: string | undefined,
      href: string | undefined
    ) => {
      if ((embed !== undefined || src !== undefined) && hidden) return all;
      if (embed !== undefined) {
        const { target, alias } = splitWikilink(embed);
        const pathPart = target.split("#")[0].trim();
        const kind = classifyShareTarget(pathPart);
        if (kind === "image") {
          const altText = alias && !/^\d+(x\d+)?$/.test(alias) ? escapeMd(alias) : "";
          return `![${altText}](${SHARE_ASSET_SCHEME}${attach(pathPart)})`;
        }
        if (kind === "attachment") {
          const file = escapeMd(stripNodeLinkMarks(pathPart.split("/").pop() ?? pathPart));
          const card = ctx.attachmentOf?.(decodeRef(pathPart));
          return card ? markAttachment(card, file) : file;
        }
        const content = ctx.embedOf?.(target);
        if (content?.trim()) return embedBox(titleFor(target), content, ctx, out);
        return escapeMd(titleFor(target));
      }
      if (link !== undefined) {
        const { target, alias } = splitWikilink(link);
        const text = escapeMd(stripNodeLinkMarks(alias ?? titleFor(target)));
        const pathPart = target.split("#")[0].trim();
        const nodeId = pathPart ? ctx.nodeIdOf?.(pathPart) : undefined;
        return nodeId && text ? markNodeLink(nodeId, text) : text;
      }
      if (src !== undefined) {
        const raw = src
          .trim()
          .replace(/\s+"[^"]*"$/, "")
          .replace(/^<|>$/g, "");
        // A YouTube embed renders as an iframe, which the shared page does not keep: share it as a plain link instead.
        if (youtubeVideoId(raw)) return `[${VIDEO_MARK}▶ ${alt || escapeMd(raw)}](${raw})`;
        if (isWeb(raw)) {
          out.webImages.push({ url: raw, alt: alt ?? "" });
          return `![${alt ?? ""}](${raw})`;
        }
        const kind = classifyShareTarget(decodeRef(raw));
        // A note in image syntax is never read as bytes: it shows as its title, like an unresolved note embed.
        if (kind === "note") return escapeMd(titleFor(decodeRef(raw)));
        if (kind === "attachment") {
          const file = escapeMd(stripNodeLinkMarks(decodeRef(raw).split("/").pop() ?? raw));
          const card = ctx.attachmentOf?.(decodeRef(raw));
          return card ? markAttachment(card, file) : file;
        }
        return `![${alt ?? ""}](${SHARE_ASSET_SCHEME}${attach(raw)})`;
      }
      // [text](vault/path.md): keep the text only; web, mailto and in-page links stay
      const raw = (href ?? "").trim();
      if (isWeb(raw) || /^(mailto:|#)/i.test(raw)) return all;
      return label ?? "";
    }
  );
}

/**
 * Deletes reference-style link definitions (`[label]: target`, also with the target on the next line) whose target is
 * not a web or mail address: a `[text][label]` that uses one renders as a link to a private path. Lines inside code
 * stay. Footnote definitions (`[^1]: …`) are not link definitions.
 */
function removeLocalReferenceDefinitions(text: string): string {
  const definition = /^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*(?:\n[ \t]*)?(?:<([^>\n]*)>|(\S+))[^\n]*(?:\n|$)/gm;
  const ranges = markdownCodeRanges(text);
  return text.replace(
    definition,
    (all: string, bracketed: string | undefined, bare: string | undefined, at: number) => {
      if (ranges.some(range => at >= range.start && at < range.end)) return all;
      const target = (bracketed ?? bare ?? "").trim();
      return isWeb(target) || /^mailto:/i.test(target) ? all : "";
    }
  );
}

/**
 * Wikilinks, embeds, vault images and local links are rewritten in prose; code (share-code.ts) and local reference
 * definitions are handled as described there. Line endings are normalized first.
 */
export function cleanShareMarkdown(md: string, ctx: ShareCleanContext): ShareCleanResult {
  const out: ShareCleanResult = { markdown: "", attachments: [], webImages: [] };
  // The marks of share-node-links.ts never come from the author: strip them before anything is marked.
  const text = removeLocalReferenceDefinitions(stripNodeLinkMarks(normalizeNewlines(md)));
  const code = markdownCodeRanges(text);
  const comments = commentRanges(text, code);
  const parts = [
    ...code
      .filter(range => !comments.some(comment => range.start >= comment.start && range.start < comment.end))
      .map(range => ({ ...range, comment: false })),
    ...comments.map(range => ({ ...range, comment: true }))
  ].sort((a, b) => a.start - b.start);
  let result = "";
  let from = 0;
  for (const range of parts) {
    result +=
      cleanSegment(dropWritebackBackupLines(text.slice(from, range.start)), ctx, out) +
      (range.comment
        ? cleanSegment(text.slice(range.start, range.end), ctx, out, true)
        : text.slice(range.start, range.end));
    from = range.end;
  }
  out.markdown = result + cleanSegment(dropWritebackBackupLines(text.slice(from)), ctx, out);
  return out;
}

/** includeImages=false: replace each embedded-image reference with a text marker. */
export function replaceAssetImages(md: string, label: string): string {
  return md.replace(new RegExp(`!\\[[^\\]\\n]*\\]\\(${SHARE_ASSET_SCHEME}[^)\\n]*\\)`, "g"), label);
}
