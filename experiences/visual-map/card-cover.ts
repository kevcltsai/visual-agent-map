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
/** `topic-cover-frame: "x y w h"`: the part of the picture a card shows, as 0-1 fractions of the picture. A mask only; the image file is never changed. */
export const COVER_FRAME_KEY = "topic-cover-frame";
export interface CoverFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}
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

const FRAME_NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
const FRAME_EPSILON = 1e-9;

/**
 * Reads `"x y w h"` (four non-negative decimal numbers separated by spaces). Anything else, or a frame that leaves the
 * picture (x+w or y+h above 1) or has no area, is null: the card then shows the whole picture.
 */
export function parseCoverFrame(raw: unknown): CoverFrame | null {
  if (typeof raw !== "string") return null;
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 4 || !parts.every(part => FRAME_NUMBER.test(part))) return null;
  const [x, y, w, h] = parts.map(Number);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0 || x > 1 || y > 1 || w > 1 || h > 1) return null;
  if (x + w > 1 + FRAME_EPSILON || y + h > 1 + FRAME_EPSILON) return null;
  return { x, y, w, h };
}

const round4 = (value: number): number => Math.round(value * 10000) / 10000;
/**
 * The frame as the four-number string written to the note (at most 4 decimals). Edges are rounded, then the sizes are
 * the difference of rounded edges, so a frame that ends at 1 still ends at exactly 1 after rounding.
 */
export function serialiseCoverFrame(frame: CoverFrame): string {
  const x = round4(frame.x);
  const y = round4(frame.y);
  const w = round4(round4(frame.x + frame.w) - x);
  const h = round4(round4(frame.y + frame.h) - y);
  return [x, y, w, h].map(String).join(" ");
}

/** Sets (or, with null, removes) `topic-cover-frame`; every other line and the body stay as written. */
export function withCoverFrame(content: string, frame: CoverFrame | null): string {
  return setFrontmatterKeys(content, { [COVER_FRAME_KEY]: frame ? serialiseCoverFrame(frame) : null });
}

/** `resolveCover` plus the note's valid frame (null: whole picture). Off or no picture stays as `resolveCover` says. */
export function resolveCoverWithFrame(
  cache: CoverCache | null | undefined,
  resolve: CoverResolve
): { path: string; frame: CoverFrame | null } | { off: true } | null {
  const cover = resolveCover(cache, resolve);
  if (!cover || !("path" in cover)) return cover;
  return { path: cover.path, frame: parseCoverFrame(cache?.frontmatter?.[COVER_FRAME_KEY]) };
}

/** A link path safe inside `[[...]]` and a YAML double-quoted scalar: no brackets, pipe or line breaks. */
function safeLink(link: string): string {
  return link.replace(/[[\]|\r\n]/g, " ").trim();
}

/** Sets `topic-cover: "[[link]]"` and drops the old `topic-cover-frame` (it framed another picture); everything else stays as written. */
export function withCover(content: string, link: string): string {
  const safe = safeLink(link);
  return safe ? setFrontmatterKeys(content, { [COVER_KEY]: `[[${safe}]]`, [COVER_FRAME_KEY]: null }) : content;
}

/** The raw `topic-cover` value written in the note's frontmatter, or null when the key is absent. */
function declaredCover(content: string): string | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  const line = block ? /^topic-cover:[ \t]*(.*?)[ \t]*$/m.exec(block[1]) : null;
  return line ? line[1].replace(/^["']|["']$/g, "") : null;
}

/**
 * Writes `topic-cover: "none"` (the topic menu's "turn cover off"). When `topic-cover` was an explicit link, turning
 * the cover on again would show the first embedded image instead, so the frame (made for the linked picture) goes in
 * the same write; when the cover came from the first embed, the frame stays.
 */
export function withCoverOff(content: string): string {
  const declared = declaredCover(content);
  const explicit = declared !== null && declared !== "" && declared.toLowerCase() !== "none";
  return setFrontmatterKeys(
    content,
    explicit ? { [COVER_KEY]: "none", [COVER_FRAME_KEY]: null } : { [COVER_KEY]: "none" }
  );
}

/** Removes the `topic-cover` key and the frame so the first embedded image is used again, whole. */
export function withoutCover(content: string): string {
  return setFrontmatterKeys(content, { [COVER_KEY]: null, [COVER_FRAME_KEY]: null });
}

/** Removes only `topic-cover` (the topic menu's "turn cover on again"): the picture did not change, so its frame stays. */
export function withCoverOn(content: string): string {
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
