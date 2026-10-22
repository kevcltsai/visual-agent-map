/**
 * Cleans a note's Markdown before it is rendered and shared: wikilinks become plain text, note embeds become their
 * title only, vault attachments are replaced by `vam-asset:<name>` references (the exporter embeds the files), `%%`
 * comments are dropped. Web images keep their link. Fenced and inline code is left untouched.
 */
import { cutUnclosedPercentComment, markdownCodeRanges, stripHtmlComments } from "./share-code";

export interface ShareCleanContext {
  /** Title of the note a link target points at, if known. */
  titleOf(target: string): string | undefined;
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

function cleanSegment(text: string, ctx: ShareCleanContext, out: ShareCleanResult): string {
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
  const pattern =
    /%%[\s\S]*?%%|!\[\[([^\]\n]+)\]\]|\[\[([^\]\n]+)\]\]|!\[([^\]\n]*)\]\(([^)\n]+)\)|\[([^\]\n]*)\]\(([^)\n]+)\)/g;
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
      if (all.startsWith("%%")) return "";
      if (embed !== undefined) {
        const { target, alias } = splitWikilink(embed);
        const pathPart = target.split("#")[0].trim();
        if (IMAGE_EXT.test(pathPart)) {
          const altText = alias && !/^\d+(x\d+)?$/.test(alias) ? escapeMd(alias) : "";
          return `![${altText}](${SHARE_ASSET_SCHEME}${attach(pathPart)})`;
        }
        if (/\.[a-z0-9]{1,5}$/i.test(pathPart) && !/\.md$/i.test(pathPart))
          return escapeMd(pathPart.split("/").pop() ?? pathPart);
        return escapeMd(titleFor(target));
      }
      if (link !== undefined) {
        const { target, alias } = splitWikilink(link);
        return escapeMd(alias ?? titleFor(target));
      }
      if (src !== undefined) {
        const raw = src
          .trim()
          .replace(/^<|>$/g, "")
          .replace(/\s+"[^"]*"$/, "");
        if (isWeb(raw)) {
          out.webImages.push({ url: raw, alt: alt ?? "" });
          return `![${alt ?? ""}](${raw})`;
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
 * `%%` and `<!-- -->` comments go first, wherever they sit and even when they contain code (a hidden comment is
 * private by intent; an unclosed `%%` or `<!--` outside code hides the rest of the note in a reader, so the rest is cut; a literal `%%` inside code that pairs with another `%%` is removed too, the conservative side).
 * The rest is split on code (share-code.ts, the same definition the leak scanner uses) so only prose is rewritten.
 */
export function cleanShareMarkdown(md: string, ctx: ShareCleanContext): ShareCleanResult {
  const out: ShareCleanResult = { markdown: "", attachments: [], webImages: [] };
  const text = stripHtmlComments(cutUnclosedPercentComment(md.replace(/%%[\s\S]*?%%/g, "")));
  let result = "";
  let from = 0;
  for (const range of markdownCodeRanges(text)) {
    result += cleanSegment(text.slice(from, range.start), ctx, out) + text.slice(range.start, range.end);
    from = range.end;
  }
  out.markdown = result + cleanSegment(text.slice(from), ctx, out);
  return out;
}

/** includeImages=false: replace each embedded-image reference with a text marker. */
export function replaceAssetImages(md: string, label: string): string {
  return md.replace(new RegExp(`!\\[[^\\]\\n]*\\]\\(${SHARE_ASSET_SCHEME}[^)\\n]*\\)`, "g"), label);
}
