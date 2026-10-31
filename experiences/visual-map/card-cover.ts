/**
 * Card cover resolution (map-images P2). Reads only what the metadata cache already knows (decision D2), never the
 * note body, and never touches the network: URLs are skipped, and a link only counts when `resolve` finds a local
 * image file. Pure functions, no DOM.
 */
import { setFrontmatterKeys } from "../../repository";

export type CoverResult = { path: string } | { off: true } | null;
export interface CoverCache {
  frontmatter?: Record<string, unknown> | null;
  embeds?: Array<{ link?: unknown }> | null;
}
/** Maps a link path to a vault file path, or null when it does not resolve to a local file. */
export type CoverResolve = (linkpath: string) => { path: string } | null | undefined;

export const COVER_KEY = "topic-cover";
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** `[[a/b.png|alias#h]]`, `a/b.png` or a YAML-parsed nested list `[["a/b.png"]]` to the bare link path; null if none. */
function linkpathOf(raw: unknown): string | null {
  let value: unknown = raw;
  while (Array.isArray(value)) value = value[0];
  if (typeof value !== "string") return null;
  const wiki = /^\s*!?\[\[([^\]]*)\]\]\s*$/.exec(value);
  const inner = (wiki ? wiki[1] : value).split("|")[0].split("#")[0].trim();
  if (!inner || SCHEME.test(inner) || inner.startsWith("//")) return null;
  return inner;
}

function localImage(raw: unknown, resolve: CoverResolve): string | null {
  const linkpath = linkpathOf(raw);
  if (!linkpath) return null;
  const file = resolve(linkpath);
  const path = file && typeof file.path === "string" ? file.path : null;
  return path && IMAGE_EXTENSION.test(path) ? path : null;
}

/**
 * Priority: `topic-cover: none` turns the cover off; a `topic-cover` link that resolves to a local image wins; otherwise
 * the first embed that resolves to a local image; otherwise null. URLs and unresolved links are skipped.
 */
export function resolveCover(cache: CoverCache | null | undefined, resolve: CoverResolve): CoverResult {
  const declared = cache?.frontmatter?.[COVER_KEY];
  if (typeof declared === "string" && declared.trim().toLowerCase() === "none") return { off: true };
  if (declared !== undefined && declared !== null) {
    const path = localImage(declared, resolve);
    if (path) return { path };
  }
  for (const embed of cache?.embeds ?? []) {
    const path = localImage(embed?.link, resolve);
    if (path) return { path };
  }
  return null;
}

/** A link path safe inside `[[...]]` and a YAML double-quoted scalar: no brackets, pipe or line breaks. */
function safeLink(link: string): string {
  return link.replace(/[[\]|\r\n]/g, " ").trim();
}

/** Sets `topic-cover: "[[link]]"`; every other line and the body stay as written. */
export function withCover(content: string, link: string): string {
  const safe = safeLink(link);
  return safe ? setFrontmatterKeys(content, { [COVER_KEY]: `[[${safe}]]` }) : content;
}

/** Writes `topic-cover: "none"` (the topic menu's "turn cover off"). */
export function withCoverOff(content: string): string {
  return setFrontmatterKeys(content, { [COVER_KEY]: "none" });
}

/** Removes the `topic-cover` key so the first embedded image is used again. */
export function withoutCover(content: string): string {
  return setFrontmatterKeys(content, { [COVER_KEY]: null });
}

/**
 * Appends `![[link]]` at the end of the note's `## User Notes` section (before the next `## ` heading), or adds that
 * section at the end of the note when there is none. Everything else stays as written.
 */
export function appendImageEmbed(content: string, link: string): string {
  const safe = safeLink(link);
  if (!safe) return content;
  const embed = `![[${safe}]]`;
  const heading = /^## User Notes[ \t]*$/m.exec(content);
  if (!heading) return `${content.replace(/\s+$/, "")}\n\n## User Notes\n\n${embed}\n`;
  const from = heading.index + heading[0].length;
  const next = /^## /m.exec(content.slice(from));
  const end = next ? from + next.index : content.length;
  const at = from + content.slice(from, end).replace(/\s+$/, "").length;
  const tail = content.slice(at);
  // The section may end the file without a final line break.
  return `${content.slice(0, at)}\n\n${embed}${tail.includes("\n") ? tail : `${tail}\n`}`;
}
