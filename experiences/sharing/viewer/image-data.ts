// What the share viewer takes from the payload's cover and annotated-image fields. Everything here is untrusted input:
// numbers are checked again, pictures must be `data:image/` entries of `assets`, and text is kept as plain strings.
// No DOM and no imports of plugin modules, so a unit test can load it directly.

const IMAGE_PREFIX = "data:image/";
const COORDINATE_LIMIT = 1e6;
const IMAGE_LIMIT = 200;
const ANCHOR_LIMIT = 500;
const NOTE_LIMIT = 500;
const FRAME_EPSILON = 1e-9;
const COVER_SIZE_MIN = 0.3;

export type ViewerCoverPosition = "top" | "bottom" | "left" | "right";
export interface ViewerCoverFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface ViewerCover {
  /** The `assets` key; the viewer remembers a picture's shape by it. */
  asset: string;
  src: string;
  /** Null: the whole picture. */
  frame: ViewerCoverFrame | null;
  size: number;
  position: ViewerCoverPosition;
}
export interface ViewerAnchor {
  id: string;
  /** 0-1 fractions of the picture. */
  x: number;
  y: number;
  note: string;
  linked: boolean;
}
export interface ViewerImageLink {
  anchor: string;
  topic: string;
  ring: boolean;
}
export interface ViewerImage {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** A `data:image/` source, or undefined: the viewer draws a placeholder. */
  src: string | undefined;
  note: string;
  anchors: ViewerAnchor[];
  links: ViewerImageLink[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The `data:image/` source of an `assets` entry, or undefined for a missing key, a non-string, or any other kind of address. */
export function assetSource(assets: Record<string, unknown>, key: unknown): string | undefined {
  if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(assets, key)) return undefined;
  const value = assets[key];
  return typeof value === "string" && value.startsWith(IMAGE_PREFIX) ? value : undefined;
}

/** `[x, y, w, h]` as 0-1 fractions of the picture, or null (the whole picture) when it is not a frame inside the picture. */
export function readCoverFrame(raw: unknown): ViewerCoverFrame | null {
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every(isNumber)) return null;
  const [x, y, w, h] = raw;
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x > 1 || y > 1 || w > 1 || h > 1) return null;
  if (x + w > 1 + FRAME_EPSILON || y + h > 1 + FRAME_EPSILON) return null;
  return { x, y, w, h };
}

/** A node's cover, or undefined when it has none or its picture is not a usable `data:image/` entry. */
export function readCover(raw: unknown, assets: Record<string, unknown>): ViewerCover | undefined {
  if (!isRecord(raw)) return undefined;
  const src = assetSource(assets, raw.asset);
  if (src === undefined) return undefined;
  const size = isNumber(raw.size) && raw.size >= COVER_SIZE_MIN && raw.size <= 1 ? raw.size : 1;
  const position: ViewerCoverPosition =
    raw.position === "bottom" || raw.position === "left" || raw.position === "right" ? raw.position : "top";
  return { asset: raw.asset as string, src, frame: readCoverFrame(raw.frame), size, position };
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const plainNote = (value: unknown): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, NOTE_LIMIT) : "";

/**
 * The annotated images of a payload. A picture needs finite numbers, a positive size and a unique id; an anchor needs finite
 * numbers (they are clamped to 0-1) and a unique id; a link needs an anchor of its picture and a topic that is in the file.
 */
export function readImages(
  raw: unknown,
  topicIds: ReadonlySet<string>,
  assets: Record<string, unknown>
): ViewerImage[] {
  if (!Array.isArray(raw)) return [];
  const out: ViewerImage[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, IMAGE_LIMIT)) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id || seen.has(item.id)) continue;
    const { x, y, w, h } = item;
    if (![x, y, w, h].every(isNumber)) continue;
    const box = { x: x as number, y: y as number, w: w as number, h: h as number };
    if (box.w <= 0 || box.h <= 0 || Object.values(box).some(value => Math.abs(value) > COORDINATE_LIMIT)) continue;
    seen.add(item.id);
    const anchors: ViewerAnchor[] = [];
    const anchorIds = new Set<string>();
    for (const entry of Array.isArray(item.anchors) ? item.anchors.slice(0, ANCHOR_LIMIT) : []) {
      if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id || anchorIds.has(entry.id)) continue;
      if (!isNumber(entry.x) || !isNumber(entry.y)) continue;
      anchorIds.add(entry.id);
      anchors.push({
        id: entry.id,
        x: clamp01(entry.x),
        y: clamp01(entry.y),
        note: plainNote(entry.note),
        linked: false
      });
    }
    const links: ViewerImageLink[] = [];
    const seenLinks = new Set<string>();
    for (const link of Array.isArray(item.links) ? item.links : []) {
      if (!isRecord(link) || typeof link.anchor !== "string" || typeof link.topic !== "string") continue;
      const anchor = anchors.find(each => each.id === link.anchor);
      const key = `${link.anchor}\u0000${link.topic}`;
      if (!anchor || !topicIds.has(link.topic) || seenLinks.has(key)) continue;
      seenLinks.add(key);
      anchor.linked = true;
      links.push({ anchor: link.anchor, topic: link.topic, ring: link.ring === true });
    }
    out.push({ id: item.id, ...box, src: assetSource(assets, item.asset), note: plainNote(item.note), anchors, links });
  }
  return out;
}
