/**
 * Canvas objects stored in the map file (`MapDocument.canvasItems`): free images and boundary frames. Map.md is
 * untrusted input, so `sanitizeCanvasItems` rebuilds each known item from fixed fields and drops malformed ones one
 * by one. Unknown kinds are kept as they are (a newer plugin may have written them). Pure functions, no DOM.
 */
import type { MapNode } from "../../map-graph";

export interface ImageItem {
  id: string;
  kind: "image";
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface BoundaryItem {
  id: string;
  kind: "boundary";
  members: string[];
  label?: string;
}
/** A user-written note without a file. `parentId` hangs it under a topic on the tree; without it (or when that topic is gone) it is free text. */
export interface TextItem {
  id: string;
  kind: "text";
  text: string;
  parentId?: string;
  x: number;
  y: number;
  /** Topic ids this note is drawn a dashed line to (decision #1); deduped, at most {@link LINK_LIMIT}; omitted when empty. */
  links?: string[];
  /** Width the user set with the right-edge handle (px); omitted = as wide as the text (up to {@link TEXT_AUTO_WIDTH_MAX}). */
  width?: number;
}
/**
 * A summary bracket (summary-bracket P1): groups neighbouring children of one topic and carries the user's conclusion text.
 * No coordinates are stored; the drawn range is derived from the tree (see {@link effectiveSummaryRange}).
 */
export interface SummaryItem {
  id: string;
  kind: "summary";
  /** The topic whose children the bracket frames. */
  parentId: string;
  /** Child topic ids the user picked, deduped, 1 to {@link SUMMARY_MEMBER_LIMIT}. */
  members: string[];
  text: string;
}
/** A point on an annotated image. `at` is the position kind plus relative coordinates; unknown kinds are kept as written (never drawn or selectable). */
export interface ImageAnchor {
  id: string;
  at: { kind: "image-2d"; x: number; y: number } | { kind: string; [key: string]: unknown };
  note?: string;
}
/** A relation between one anchor of the image and one topic (either direction). Same kinds as topic relations. */
export interface AnchorRelation {
  kind: AnchorRelationKind;
  from: string;
  to: string;
  description?: string;
}
export type AnchorRelationKind = "supports" | "contradicts" | "verifies" | "derives_from" | "related" | "prerequisite";
/** An image the user turned into an annotated image: it carries anchors (relative 0-1 coordinates) and anchor relations. */
export interface AnnotatedImageItem {
  id: string;
  kind: "annotated-image";
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** What the picture is / what to research, one line, at most {@link NOTE_LIMIT} characters. */
  note?: string;
  anchors: ImageAnchor[];
  relations?: AnchorRelation[];
}
export interface UnknownItem {
  kind: string;
  [key: string]: unknown;
}
export type CanvasItem = ImageItem | BoundaryItem | TextItem | SummaryItem | AnnotatedImageItem | UnknownItem;
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const IMAGE_MIN_SIZE = 24;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what a path must not contain
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- same reason: control characters in a label become spaces
const CONTROL_ALL = /[\u0000-\u001f\u007f]/g;
const LABEL_LIMIT = 200;
const MEMBER_LIMIT = 500;
export const TEXT_LIMIT = 2000;
/** Text block width limits (px): the narrowest (about two characters), the widest an automatic block grows, the widest a set width. */
export const TEXT_WIDTH_MIN = 32;
export const TEXT_AUTO_WIDTH_MAX = 300;
export const TEXT_WIDTH_MAX = 560;
/** A whole-pixel width inside the limits; undefined when the value is not a finite number. */
export function clampTextWidth(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(TEXT_WIDTH_MAX, Math.max(TEXT_WIDTH_MIN, Math.round(value)));
}
const PARENT_ID_LIMIT = 200;
export const LINK_LIMIT = 20;
export const SUMMARY_MEMBER_LIMIT = 50;
export const NOTE_LIMIT = 200;
export const ANCHOR_LIMIT = 200;
export const ANCHOR_RELATION_LIMIT = 2000;
/** Same list as `TOPIC_RELATION_KINDS` in map-model.ts, kept here so this file imports nothing (a test compares the two). */
export const ANCHOR_RELATION_KINDS: readonly AnchorRelationKind[] = [
  "supports",
  "contradicts",
  "verifies",
  "derives_from",
  "related",
  "prerequisite"
];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A vault-relative image path: no URL scheme, no absolute or parent segments, no backslash, whitelisted extension. */
export function isSafeImagePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 1024) return false;
  if (CONTROL.test(path) || path.includes("\\") || SCHEME.test(path) || path.startsWith("/") || path.startsWith("//"))
    return false;
  if (path.split("/").some(part => part === ".." || part === "." || part === "")) return false;
  return IMAGE_EXTENSION.test(path);
}

function cleanImage(raw: Record<string, unknown>): ImageItem | null {
  const { id, path, x, y, w, h } = raw;
  if (typeof id !== "string" || !ID.test(id) || !isSafeImagePath(path)) return null;
  if (!finite(x) || !finite(y) || !finite(w) || !finite(h) || w <= 0 || h <= 0) return null;
  return { id, kind: "image", path, x, y, w, h };
}

/** One line of at most NOTE_LIMIT characters (control characters become spaces); undefined when nothing is left or it is not a string. */
function cleanNote(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(CONTROL_ALL, " ").trim().slice(0, NOTE_LIMIT).trim();
  return flat ? flat : undefined;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function cleanAnchor(raw: unknown): ImageAnchor | null {
  if (!isRecord(raw)) return null;
  const { id, at } = raw;
  if (typeof id !== "string" || !ID.test(id) || !isRecord(at) || typeof at.kind !== "string") return null;
  let clean: ImageAnchor["at"];
  if (at.kind === "image-2d") {
    if (!finite(at.x) || !finite(at.y)) return null;
    clean = { kind: "image-2d", x: clamp01(at.x), y: clamp01(at.y) };
  } else clean = at as ImageAnchor["at"];
  const anchor: ImageAnchor = { id, at: clean };
  const note = cleanNote(raw.note);
  if (note !== undefined) anchor.note = note;
  return anchor;
}

const relationPair = (r: { from: string; to: string }): string =>
  r.from > r.to ? `${r.to}\0${r.from}` : `${r.from}\0${r.to}`;

/** Kind whitelisted, exactly one end an anchor of this image, the other end a well-formed id; description kept when a string. */
function cleanAnchorRelation(raw: unknown, anchorIds: ReadonlySet<string>): AnchorRelation | null {
  if (!isRecord(raw)) return null;
  const { kind, from, to, description } = raw;
  if (typeof kind !== "string" || !(ANCHOR_RELATION_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof from !== "string" || typeof to !== "string" || !ID.test(from) || !ID.test(to)) return null;
  if (anchorIds.has(from) === anchorIds.has(to)) return null;
  const out: AnchorRelation = { kind: kind as AnchorRelationKind, from, to };
  if (typeof description === "string") out.description = description;
  return out;
}

/** Counts what was dropped while one list is read, so the warning carries a number and never content. */
interface Tally {
  dropped: number;
}
const warnDropped = (tally: Tally): void => {
  if (!tally.dropped) return;
  console.warn(
    `Dropped ${tally.dropped} invalid annotated-image entr${tally.dropped === 1 ? "y" : "ies"} while reading the map.`
  );
};

function cleanAnnotatedImage(raw: Record<string, unknown>, tally: Tally): AnnotatedImageItem | null {
  const base = cleanImage({ ...raw, kind: "image" });
  if (!base) return null;
  const item: AnnotatedImageItem = {
    id: base.id,
    kind: "annotated-image",
    path: base.path,
    x: base.x,
    y: base.y,
    w: base.w,
    h: base.h,
    anchors: []
  };
  const note = cleanNote(raw.note);
  if (note !== undefined) item.note = note;
  const anchors: ImageAnchor[] = [];
  const anchorIds = new Set<string>();
  const rawAnchors = Array.isArray(raw.anchors) ? (raw.anchors as unknown[]) : [];
  if (raw.anchors !== undefined && !Array.isArray(raw.anchors)) tally.dropped++;
  for (const entry of rawAnchors) {
    const anchor = anchors.length >= ANCHOR_LIMIT ? null : cleanAnchor(entry);
    if (!anchor || anchorIds.has(anchor.id)) {
      tally.dropped++;
      continue;
    }
    anchorIds.add(anchor.id);
    anchors.push(anchor);
  }
  item.anchors = anchors;
  const relations: AnchorRelation[] = [];
  const pairs = new Set<string>();
  const rawRelations = Array.isArray(raw.relations) ? (raw.relations as unknown[]) : [];
  if (raw.relations !== undefined && !Array.isArray(raw.relations)) tally.dropped++;
  for (const entry of rawRelations) {
    const relation = relations.length >= ANCHOR_RELATION_LIMIT ? null : cleanAnchorRelation(entry, anchorIds);
    if (!relation || pairs.has(relationPair(relation))) {
      tally.dropped++;
      continue;
    }
    pairs.add(relationPair(relation));
    relations.push(relation);
  }
  if (relations.length) item.relations = relations;
  return item;
}

function cleanBoundary(raw: Record<string, unknown>): BoundaryItem | null {
  const { id, members, label } = raw;
  if (typeof id !== "string" || !ID.test(id) || !Array.isArray(members) || members.length > MEMBER_LIMIT) return null;
  if (!members.every(m => typeof m === "string" && ID.test(m))) return null;
  const item: BoundaryItem = { id, kind: "boundary", members: [...new Set(members as string[])] };
  if (typeof label === "string" && label.trim())
    item.label = label.replace(CONTROL_ALL, " ").trim().slice(0, LABEL_LIMIT);
  return item;
}

/** Trimmed text cut to TEXT_LIMIT characters; null when it is not a string or has nothing but whitespace. */
export function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, TEXT_LIMIT).trim();
  return text ? text : null;
}

/** Keeps the valid, distinct topic ids (not the note's own id), first LINK_LIMIT of them; anything else is dropped one by one. */
function cleanLinks(value: unknown, ownId: string): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const entry of value) {
    if (out.size >= LINK_LIMIT) break;
    if (typeof entry === "string" && ID.test(entry) && entry !== ownId) out.add(entry);
  }
  return [...out];
}

function cleanTextItem(raw: Record<string, unknown>): TextItem | null {
  const { id, text, parentId, x, y } = raw;
  if (typeof id !== "string" || !ID.test(id) || !finite(x) || !finite(y)) return null;
  const clean = cleanText(text);
  if (clean === null) return null;
  const item: TextItem = { id, kind: "text", text: clean, x, y };
  if (parentId !== undefined && parentId !== null) {
    if (typeof parentId !== "string" || !parentId || parentId.length > PARENT_ID_LIMIT) return null;
    item.parentId = parentId;
  }
  const width = clampTextWidth(raw.width);
  if (width !== undefined) item.width = width;
  const links = cleanLinks(raw.links, id);
  if (links.length) item.links = links;
  return item;
}

function cleanSummary(raw: Record<string, unknown>): SummaryItem | null {
  const { id, parentId, members, text } = raw;
  if (typeof id !== "string" || !ID.test(id) || typeof parentId !== "string" || !ID.test(parentId)) return null;
  if (!Array.isArray(members) || members.length === 0 || members.length > SUMMARY_MEMBER_LIMIT) return null;
  if (!members.every(m => typeof m === "string" && ID.test(m))) return null;
  const clean = cleanText(text);
  if (clean === null) return null;
  return { id, kind: "summary", parentId, members: [...new Set(members as string[])], text: clean };
}

/** Parses untrusted JSON. Never throws; a bad item is dropped alone, an unknown kind is kept as is. */
export function sanitizeCanvasItems(raw: unknown): CanvasItem[] {
  if (!Array.isArray(raw)) return [];
  const out: CanvasItem[] = [];
  const seen = new Set<string>();
  const tally: Tally = { dropped: 0 };
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.kind !== "string") continue;
    let item: CanvasItem | null;
    if (entry.kind === "image") item = cleanImage(entry);
    else if (entry.kind === "boundary") item = cleanBoundary(entry);
    else if (entry.kind === "text") item = cleanTextItem(entry);
    else if (entry.kind === "summary") item = cleanSummary(entry);
    else if (entry.kind === "annotated-image") {
      item = cleanAnnotatedImage(entry, tally);
      if (!item) tally.dropped++;
    } else item = entry as UnknownItem;
    if (!item) continue;
    if (
      item.kind === "image" ||
      item.kind === "boundary" ||
      item.kind === "text" ||
      item.kind === "summary" ||
      item.kind === "annotated-image"
    ) {
      const id = (item as ImageItem | BoundaryItem | TextItem | SummaryItem | AnnotatedImageItem).id;
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(item);
  }
  warnDropped(tally);
  return out;
}

export function addImage(items: readonly CanvasItem[], image: Omit<ImageItem, "kind">): CanvasItem[] {
  const clean = cleanImage({ ...image, kind: "image" });
  if (!clean || items.some(i => i.kind === "image" && (i as ImageItem).id === clean.id)) return [...items];
  return [...items, clean];
}

const isImage = (item: CanvasItem, id: string): item is ImageItem | AnnotatedImageItem =>
  (item.kind === "image" || item.kind === "annotated-image") && (item as ImageItem).id === id;

export function moveItem(items: readonly CanvasItem[], id: string, dx: number, dy: number): CanvasItem[] {
  if (!finite(dx) || !finite(dy)) return [...items];
  return items.map(item => (isImage(item, id) ? { ...item, x: item.x + dx, y: item.y + dy } : item));
}

/** Resizes by width and derives the height from the original ratio; neither side goes below 24px. */
export function resizeKeepRatio(items: readonly CanvasItem[], id: string, width: number): CanvasItem[] {
  if (!finite(width)) return [...items];
  return items.map(item => {
    if (!isImage(item, id)) return item;
    const ratio = item.h / item.w;
    const w = Math.max(width, IMAGE_MIN_SIZE, IMAGE_MIN_SIZE / ratio);
    return { ...item, w, h: w * ratio };
  });
}

export function removeItem(items: readonly CanvasItem[], id: string): CanvasItem[] {
  return items.filter(item => !(isRecord(item) && (item as { id?: unknown }).id === id));
}

const isText = (item: CanvasItem): item is TextItem => item.kind === "text";

/* ---- Annotated images (anchors and anchor relations). All pure: a bad request returns the list unchanged. ---- */

export const isAnnotatedImage = (item: CanvasItem): item is AnnotatedImageItem => item.kind === "annotated-image";

/** The annotated image with this id, or undefined. */
export function findAnnotatedImage(items: readonly CanvasItem[], id: string): AnnotatedImageItem | undefined {
  return items.find((i): i is AnnotatedImageItem => isAnnotatedImage(i) && i.id === id);
}

/** Every anchor id of one annotated image (unknown position kinds included). */
export function anchorIdsOf(image: Pick<AnnotatedImageItem, "anchors">): Set<string> {
  return new Set(image.anchors.map(a => a.id));
}

/** A 2D anchor with its coordinates; anchors with an unknown position kind are not selectable and not drawn. */
export const isImage2dAnchor = (
  a: ImageAnchor
): a is ImageAnchor & { at: { kind: "image-2d"; x: number; y: number } } => a.at.kind === "image-2d";

const mapImage = (
  items: readonly CanvasItem[],
  id: string,
  change: (image: AnnotatedImageItem) => AnnotatedImageItem
): CanvasItem[] => items.map(i => (isAnnotatedImage(i) && i.id === id ? change(i) : i));

const withRelations = (image: AnnotatedImageItem, relations: AnchorRelation[]): AnnotatedImageItem => {
  const { relations: _old, ...rest } = image;
  void _old;
  return relations.length ? { ...rest, relations } : rest;
};

/** Turns a plain image into an annotated image with no anchors. `note` is cleaned (one line, 200 characters); blank means none. */
export function convertToAnnotatedImage(items: readonly CanvasItem[], id: string, note?: string): CanvasItem[] {
  return items.map(i => {
    if (i.kind !== "image" || (i as ImageItem).id !== id) return i;
    const image = i as ImageItem;
    const out: AnnotatedImageItem = {
      id: image.id,
      kind: "annotated-image",
      path: image.path,
      x: image.x,
      y: image.y,
      w: image.w,
      h: image.h,
      anchors: []
    };
    const clean = cleanNote(note);
    if (clean !== undefined) out.note = clean;
    return out;
  });
}

/** Turns an annotated image back into a plain image. Only allowed with no anchors; otherwise (or when it is not one) returns null. */
export function convertToPlainImage(items: readonly CanvasItem[], id: string): CanvasItem[] | null {
  const image = findAnnotatedImage(items, id);
  if (!image || image.anchors.length > 0) return null;
  return items.map(i =>
    i === image ? { id: image.id, kind: "image", path: image.path, x: image.x, y: image.y, w: image.w, h: image.h } : i
  );
}

/** Sets or clears (blank) the image's own note. */
export function setImageNote(items: readonly CanvasItem[], id: string, note: string): CanvasItem[] {
  return mapImage(items, id, image => {
    const { note: _old, ...rest } = image;
    void _old;
    const clean = cleanNote(note);
    return clean === undefined ? rest : { ...rest, note: clean };
  });
}

/** Adds an anchor (id must be new on this image; at most {@link ANCHOR_LIMIT}). Coordinates are clamped to 0-1. */
export function addAnchor(items: readonly CanvasItem[], imageId: string, anchor: ImageAnchor): CanvasItem[] {
  const clean = cleanAnchor(anchor);
  if (!clean) return [...items];
  return mapImage(items, imageId, image =>
    image.anchors.length >= ANCHOR_LIMIT || image.anchors.some(a => a.id === clean.id)
      ? image
      : { ...image, anchors: [...image.anchors, clean] }
  );
}

/** Changes an anchor's note (blank clears it) and/or its 2D position. The id never changes. Unknown position kinds keep `at`. */
export function updateAnchor(
  items: readonly CanvasItem[],
  imageId: string,
  anchorId: string,
  patch: { note?: string; at?: { x: number; y: number } }
): CanvasItem[] {
  if (patch.at && !(finite(patch.at.x) && finite(patch.at.y))) return [...items];
  return mapImage(items, imageId, image => ({
    ...image,
    anchors: image.anchors.map(a => {
      if (a.id !== anchorId) return a;
      let next: ImageAnchor = a;
      if (patch.at && isImage2dAnchor(a))
        next = { ...next, at: { kind: "image-2d", x: clamp01(patch.at.x), y: clamp01(patch.at.y) } };
      if (patch.note !== undefined) {
        const { note: _old, ...rest } = next;
        void _old;
        const clean = cleanNote(patch.note);
        next = clean === undefined ? rest : { ...rest, note: clean };
      }
      return next;
    })
  }));
}

/** Removes an anchor and every relation that ends at it. */
export function removeAnchor(items: readonly CanvasItem[], imageId: string, anchorId: string): CanvasItem[] {
  return mapImage(items, imageId, image => {
    if (!image.anchors.some(a => a.id === anchorId)) return image;
    const next = { ...image, anchors: image.anchors.filter(a => a.id !== anchorId) };
    return withRelations(
      next,
      (image.relations ?? []).filter(r => r.from !== anchorId && r.to !== anchorId)
    );
  });
}

/**
 * Whether `relation` may be added to this image: exactly one end is an anchor of it, the other end is a well-formed id that
 * is not one of its anchors, the kind is known, the list is below the limit and the pair holds no relation yet (any kind,
 * either direction). `replacing` is the existing relation left out of the pair check (when changing or reversing it).
 */
export function anchorRelationAllowed(
  image: AnnotatedImageItem,
  relation: Pick<AnchorRelation, "kind" | "from" | "to">,
  replacing?: Pick<AnchorRelation, "from" | "to">
): boolean {
  const list = image.relations ?? [];
  if (!replacing && list.length >= ANCHOR_RELATION_LIMIT) return false;
  if (!cleanAnchorRelation(relation, anchorIdsOf(image))) return false;
  const key = relationPair(relation);
  return !list.some(r => relationPair(r) === key && !(replacing && relationPair(replacing) === key));
}

/** Adds an anchor relation when {@link anchorRelationAllowed}; otherwise returns the list unchanged. */
export function addAnchorRelation(
  items: readonly CanvasItem[],
  imageId: string,
  relation: AnchorRelation
): CanvasItem[] {
  const image = findAnnotatedImage(items, imageId);
  if (!image || !anchorRelationAllowed(image, relation)) return [...items];
  const clean = cleanAnchorRelation(relation, anchorIdsOf(image)) as AnchorRelation;
  return mapImage(items, imageId, img => withRelations(img, [...(img.relations ?? []), clean]));
}

/** Removes the relation between an anchor and a topic (either direction). The anchor stays. */
export function removeAnchorRelation(
  items: readonly CanvasItem[],
  imageId: string,
  anchorId: string,
  topicId: string
): CanvasItem[] {
  const key = relationPair({ from: anchorId, to: topicId });
  return mapImage(items, imageId, image => {
    const list = image.relations ?? [];
    const rest = list.filter(r => relationPair(r) !== key);
    return rest.length === list.length ? image : withRelations(image, rest);
  });
}

/** Replaces the relation between an anchor and a topic with `next` (new kind, reversed direction, description). Refused changes return the list unchanged. */
export function updateAnchorRelation(
  items: readonly CanvasItem[],
  imageId: string,
  anchorId: string,
  topicId: string,
  next: AnchorRelation
): CanvasItem[] {
  const image = findAnnotatedImage(items, imageId);
  if (!image) return [...items];
  const key = relationPair({ from: anchorId, to: topicId });
  const index = (image.relations ?? []).findIndex(r => relationPair(r) === key);
  if (index < 0 || relationPair(next) !== key) return [...items];
  const old = (image.relations as AnchorRelation[])[index];
  if (!anchorRelationAllowed(image, next, old)) return [...items];
  const clean = cleanAnchorRelation(next, anchorIdsOf(image)) as AnchorRelation;
  return mapImage(items, imageId, img =>
    withRelations(
      img,
      (img.relations as AnchorRelation[]).map((r, i) => (i === index ? clean : r))
    )
  );
}

/** Every anchor relation that touches `topicId`, with the image and anchor it belongs to. Unknown-position anchors are included. */
export function anchorRelationsForTopic(
  items: readonly CanvasItem[],
  topicId: string
): { imageId: string; anchorId: string; relation: AnchorRelation }[] {
  const out: { imageId: string; anchorId: string; relation: AnchorRelation }[] = [];
  for (const item of items) {
    if (!isAnnotatedImage(item)) continue;
    const anchors = anchorIdsOf(item);
    for (const relation of item.relations ?? []) {
      if (relation.from !== topicId && relation.to !== topicId) continue;
      out.push({ imageId: item.id, anchorId: anchors.has(relation.from) ? relation.from : relation.to, relation });
    }
  }
  return out;
}

/**
 * Cleanup that needs the topic ids (sanitizeCanvasItems reads canvasItems before the nodes are checked): removes anchors whose
 * id equals a topic id (with their relations) and relations whose topic end does not exist. Returns the same array when
 * nothing changes, so a map without annotated images (or with clean ones) stays byte for byte.
 */
export function pruneAnnotatedImages(
  items: readonly CanvasItem[],
  nodeIds: ReadonlySet<string>
): { items: CanvasItem[]; dropped: number } {
  let dropped = 0;
  const out = items.map(item => {
    if (!isAnnotatedImage(item)) return item;
    const anchors = item.anchors.filter(a => !nodeIds.has(a.id));
    const anchorIds = new Set(anchors.map(a => a.id));
    const relations = (item.relations ?? []).filter(r => {
      const topic = anchorIds.has(r.from) ? r.to : anchorIds.has(r.to) ? r.from : null;
      return topic !== null && nodeIds.has(topic);
    });
    const lost = item.anchors.length - anchors.length + (item.relations ?? []).length - relations.length;
    if (!lost) return item;
    dropped += lost;
    return withRelations({ ...item, anchors }, relations);
  });
  return dropped ? { items: out, dropped } : { items: [...items], dropped: 0 };
}

/**
 * Drops a topic's `afterTextId` unless it names an attached text block (not free, its topic exists) that hangs on the same
 * parent as the topic, so `parentId` stays the one real parent. Changes the nodes in place and returns how many fields it
 * dropped. Never throws; nodes without the field are not touched, so such a map stays byte for byte.
 */
export function pruneAfterText(
  map: { nodes?: MapNode[]; canvasItems?: readonly CanvasItem[] },
  log?: (level: "warn", message: string) => void
): number {
  let dropped = 0;
  try {
    const nodes = Array.isArray(map.nodes) ? map.nodes : [];
    if (!nodes.some(node => node && typeof node === "object" && "afterTextId" in node)) return 0;
    const items = Array.isArray(map.canvasItems) ? map.canvasItems : [];
    const parentOf = new Map(
      treeTextNodes(
        items,
        nodes.flatMap(node => (node && typeof node.id === "string" ? [node.id] : []))
      ).attached.map(text => [text.id, text.parentId])
    );
    for (const node of nodes) {
      if (!node || typeof node !== "object" || !("afterTextId" in node)) continue;
      const value: unknown = node.afterTextId;
      if (typeof value === "string" && parentOf.has(value) && parentOf.get(value) === node.parentId) continue;
      delete node.afterTextId;
      dropped++;
    }
    if (dropped)
      log?.("warn", `Dropped ${dropped} dangling after-text link${dropped === 1 ? "" : "s"} while reading the map.`);
  } catch {
    // Cleanup must never stop a map from opening.
  }
  return dropped;
}

/** Drops every anchor relation that touches one of `topicIds`. Returns the new list and how many were dropped (same array contents when 0). */
export function removeAnchorRelationsForTopics(
  items: readonly CanvasItem[],
  topicIds: ReadonlySet<string>
): { items: CanvasItem[]; dropped: number } {
  let dropped = 0;
  const out = items.map(item => {
    if (!isAnnotatedImage(item) || !item.relations) return item;
    const rest = item.relations.filter(r => !topicIds.has(r.from) && !topicIds.has(r.to));
    if (rest.length === item.relations.length) return item;
    dropped += item.relations.length - rest.length;
    return withRelations(item, rest);
  });
  return { items: out, dropped };
}

/**
 * Points the topic end of every anchor relation at `fromIds` to `toId` (a merge). When several relations of one image land on
 * the same pair (anchor + topic) only the first in list order stays; the rest are counted in `droppedSamePair`.
 */
export function retargetAnchorRelations(
  items: readonly CanvasItem[],
  fromIds: ReadonlySet<string>,
  toId: string
): { items: CanvasItem[]; droppedSamePair: number } {
  let droppedSamePair = 0;
  const out = items.map(item => {
    if (!isAnnotatedImage(item) || !item.relations) return item;
    if (!item.relations.some(r => fromIds.has(r.from) || fromIds.has(r.to))) return item;
    const seen = new Set<string>();
    const next: AnchorRelation[] = [];
    for (const r of item.relations) {
      const moved: AnchorRelation = {
        ...r,
        from: fromIds.has(r.from) ? toId : r.from,
        to: fromIds.has(r.to) ? toId : r.to
      };
      const key = relationPair(moved);
      if (seen.has(key)) {
        droppedSamePair++;
        continue;
      }
      seen.add(key);
      next.push(moved);
    }
    return withRelations(item, next);
  });
  return { items: out, droppedSamePair };
}

/** Adds a text node; a bad or duplicate one (any item with that id) leaves the list unchanged. */
export function addTextNode(items: readonly CanvasItem[], text: Omit<TextItem, "kind">): CanvasItem[] {
  const clean = cleanTextItem({ ...text, kind: "text" });
  if (!clean || items.some(i => (i as { id?: unknown }).id === clean.id)) return [...items];
  return [...items, clean];
}

/** Replaces the text of one text node. Empty or invalid text changes nothing; callers remove the node instead. */
export function updateTextNode(items: readonly CanvasItem[], id: string, text: string): CanvasItem[] {
  const clean = cleanText(text);
  if (clean === null) return [...items];
  return items.map(item => (isText(item) && item.id === id ? { ...item, text: clean } : item));
}

export function removeTextNode(items: readonly CanvasItem[], id: string): CanvasItem[] {
  return items.filter(item => !(isText(item) && item.id === id));
}

/** Text nodes split by whether their parent topic exists. Orphans (no parent, missing parent, parent is itself) are never dropped. */
export function treeTextNodes(
  items: readonly CanvasItem[],
  nodeIds: ReadonlySet<string> | readonly string[]
): { attached: TextItem[]; orphans: TextItem[] } {
  const alive = new Set<string>(nodeIds);
  const attached: TextItem[] = [];
  const orphans: TextItem[] = [];
  for (const item of items) {
    if (!isText(item)) continue;
    if (item.parentId !== undefined && item.parentId !== item.id && alive.has(item.parentId) && !alive.has(item.id))
      attached.push(item);
    else orphans.push(item);
  }
  return { attached, orphans };
}

/**
 * Bounding box of the members that currently have a rect, grown by `pad`. Null when none of them exist.
 * `others` are the rects of cards that are not members: on each side, a neighbour that lies wholly beyond the members'
 * edge (and overlaps them along the other axis) limits the pad to half the gap, so the frame's edge never runs into it.
 */
export function boundaryBounds(
  nodeIds: readonly string[],
  rectOf: (id: string) => Rect | null | undefined,
  pad: number,
  others: readonly Rect[] = []
): Rect | null {
  const margin = finite(pad) && pad > 0 ? pad : 0;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const id of nodeIds) {
    const r = rectOf(id);
    if (!r || !finite(r.x) || !finite(r.y) || !finite(r.w) || !finite(r.h)) continue;
    left = Math.min(left, r.x);
    top = Math.min(top, r.y);
    right = Math.max(right, r.x + r.w);
    bottom = Math.max(bottom, r.y + r.h);
  }
  if (left === Infinity) return null;
  let padLeft = margin;
  let padTop = margin;
  let padRight = margin;
  let padBottom = margin;
  const half = (gap: number): number => Math.max(0, gap / 2);
  for (const o of others) {
    if (!o || !finite(o.x) || !finite(o.y) || !finite(o.w) || !finite(o.h)) continue;
    const oRight = o.x + o.w;
    const oBottom = o.y + o.h;
    const overlapsX = o.x < right && oRight > left;
    const overlapsY = o.y < bottom && oBottom > top;
    if (overlapsX && oBottom <= top) padTop = Math.min(padTop, half(top - oBottom));
    if (overlapsX && o.y >= bottom) padBottom = Math.min(padBottom, half(o.y - bottom));
    if (overlapsY && oRight <= left) padLeft = Math.min(padLeft, half(left - oRight));
    if (overlapsY && o.x >= right) padRight = Math.min(padRight, half(o.x - right));
  }
  return {
    x: left - padLeft,
    y: top - padTop,
    w: right - left + padLeft + padRight,
    h: bottom - top + padTop + padBottom
  };
}

/** Removes boundaries none of whose members still exist; other items and partly-alive boundaries stay untouched. */
export function pruneBoundaries(
  items: readonly CanvasItem[],
  existingIds: ReadonlySet<string> | readonly string[]
): CanvasItem[] {
  const alive = new Set<string>(existingIds);
  return items.filter(item => item.kind !== "boundary" || (item as BoundaryItem).members.some(m => alive.has(m)));
}

const withLinks = (item: TextItem, links: string[]): TextItem => {
  const { links: _old, ...rest } = item;
  void _old;
  return links.length ? { ...rest, links } : rest;
};

/** Adds a free text block (no parent, no links). A bad or duplicate one leaves the list unchanged. */
export function addFreeTextNode(
  items: readonly CanvasItem[],
  node: { id: string; text: string; x: number; y: number }
): CanvasItem[] {
  return addTextNode(items, { id: node.id, text: node.text, x: node.x, y: node.y });
}

/** Sets one text node's width (clamped), or with undefined removes it (automatic width). An unknown id changes nothing. */
export function setTextNodeWidth(items: readonly CanvasItem[], id: string, width: number | undefined): CanvasItem[] {
  return items.map(item => {
    if (!isText(item) || item.id !== id) return item;
    const { width: _old, ...rest } = item;
    void _old;
    const next = clampTextWidth(width);
    return next === undefined ? rest : { ...rest, width: next };
  });
}

/** Moves one text node by (dx, dy); a non-finite delta or an unknown id changes nothing. */
export function moveTextNode(items: readonly CanvasItem[], id: string, dx: number, dy: number): CanvasItem[] {
  if (!finite(dx) || !finite(dy)) return [...items];
  return items.map(item => (isText(item) && item.id === id ? { ...item, x: item.x + dx, y: item.y + dy } : item));
}

/** Links a text node to a topic. Unknown node, bad or own id, a repeat, or a full list (LINK_LIMIT) changes nothing. */
export function linkTextNode(items: readonly CanvasItem[], id: string, topicId: string): CanvasItem[] {
  if (typeof topicId !== "string" || !ID.test(topicId) || topicId === id) return [...items];
  return items.map(item => {
    if (!isText(item) || item.id !== id) return item;
    const links = item.links ?? [];
    if (links.includes(topicId) || links.length >= LINK_LIMIT) return item;
    return withLinks(item, [...links, topicId]);
  });
}

/** Removes one link; the `links` field disappears when it was the last. */
export function unlinkTextNode(items: readonly CanvasItem[], id: string, topicId: string): CanvasItem[] {
  return items.map(item => {
    if (!isText(item) || item.id !== id || !item.links?.includes(topicId)) return item;
    return withLinks(
      item,
      item.links.filter(l => l !== topicId)
    );
  });
}

/** Drops every link to the given topic ids (used when cards are deleted, in the same transaction). Other items are untouched. */
export function removeLinksTo(
  items: readonly CanvasItem[],
  nodeIds: ReadonlySet<string> | readonly string[]
): CanvasItem[] {
  const gone = new Set<string>(nodeIds);
  return items.map(item => {
    if (!isText(item) || !item.links?.some(l => gone.has(l))) return item;
    return withLinks(
      item,
      item.links.filter(l => !gone.has(l))
    );
  });
}

// ---- summary brackets ----
/** The part of a topic the summary functions read: sibling order is the order in this list (as the layout does). */
export interface SummaryNode {
  id: string;
  parentId: string | null;
  /** A topic that follows a text block is not a sibling a bracket can frame (it hangs after the block, not in the row). */
  afterTextId?: string;
}
export type SummaryRefusal =
  "invalid" | "duplicate" | "root" | "cross-parent" | "not-adjacent" | "too-many" | "unknown";
export type SummaryResult =
  { ok: true; items: CanvasItem[] } | { ok: false; reason: SummaryRefusal; items: CanvasItem[] };

const isSummary = (item: CanvasItem): item is SummaryItem => item.kind === "summary";
const childIds = (nodes: readonly SummaryNode[], parentId: string): string[] =>
  nodes.filter(n => n.parentId === parentId && !n.afterTextId).map(n => n.id);

/**
 * Whether `members` can be framed together: valid ids, none a root, all children of one parent, and (among that parent's
 * children) next to each other with nothing between them. Returns the parent id or the reason it was refused.
 */
export function checkSummaryMembers(
  members: readonly string[],
  nodes: readonly SummaryNode[]
): { ok: true; parentId: string; members: string[] } | { ok: false; reason: SummaryRefusal } {
  if (!Array.isArray(members) || !members.every(m => typeof m === "string" && ID.test(m)))
    return { ok: false, reason: "invalid" };
  const unique: string[] = [...new Set<string>(members)];
  if (unique.length === 0) return { ok: false, reason: "invalid" };
  if (unique.length > SUMMARY_MEMBER_LIMIT) return { ok: false, reason: "too-many" };
  const byId = new Map(nodes.map(n => [n.id, n]));
  let parentId: string | null = null;
  for (const id of unique) {
    const node = byId.get(id);
    if (!node) return { ok: false, reason: "unknown" };
    if (node.parentId === null || !byId.has(node.parentId)) return { ok: false, reason: "root" };
    if (node.afterTextId) return { ok: false, reason: "invalid" };
    if (parentId === null) parentId = node.parentId;
    else if (parentId !== node.parentId) return { ok: false, reason: "cross-parent" };
  }
  if (parentId === null) return { ok: false, reason: "invalid" };
  const siblings = childIds(nodes, parentId);
  const picked = new Set(unique);
  const positions = siblings.flatMap((id, index) => (picked.has(id) ? [index] : []));
  if (positions[positions.length - 1] - positions[0] + 1 !== positions.length)
    return { ok: false, reason: "not-adjacent" };
  return { ok: true, parentId, members: positions.map(i => siblings[i]) };
}

/**
 * The siblings a bracket frames: every child of its parent from the first to the last member that is still a child of that
 * parent (so a card between two members belongs to the range). Dangling members and members moved elsewhere are skipped;
 * empty when none remain.
 */
export function effectiveSummaryRange(summary: SummaryItem, nodes: readonly SummaryNode[]): string[] {
  const siblings = childIds(nodes, summary.parentId);
  const picked = new Set(summary.members);
  const positions = siblings.flatMap((id, index) => (picked.has(id) ? [index] : []));
  if (!positions.length) return [];
  return siblings.slice(positions[0], positions[positions.length - 1] + 1);
}

/** Adds a bracket over adjacent children of one parent. A refusal returns the list unchanged with the reason. */
export function addSummary(
  items: readonly CanvasItem[],
  summary: { id: string; members: readonly string[]; text: string },
  nodes: readonly SummaryNode[]
): SummaryResult {
  const unchanged = [...items];
  if (typeof summary.id !== "string" || !ID.test(summary.id) || cleanText(summary.text) === null)
    return { ok: false, reason: "invalid", items: unchanged };
  if (items.some(i => (i as { id?: unknown }).id === summary.id))
    return { ok: false, reason: "duplicate", items: unchanged };
  const checked = checkSummaryMembers(summary.members, nodes);
  if (!checked.ok) return { ok: false, reason: checked.reason, items: unchanged };
  const clean = cleanSummary({
    id: summary.id,
    kind: "summary",
    parentId: checked.parentId,
    members: checked.members,
    text: summary.text
  });
  if (!clean) return { ok: false, reason: "invalid", items: unchanged };
  return { ok: true, items: [...items, clean] };
}

/** Replaces one bracket's text. Empty or invalid text changes nothing; callers remove the bracket instead. */
export function setSummaryText(items: readonly CanvasItem[], id: string, text: string): CanvasItem[] {
  const clean = cleanText(text);
  if (clean === null) return [...items];
  return items.map(item => (isSummary(item) && item.id === id ? { ...item, text: clean } : item));
}

/** Replaces the members of one bracket (same rules as {@link addSummary}); the parent follows the new members. */
export function setSummaryMembers(
  items: readonly CanvasItem[],
  id: string,
  members: readonly string[],
  nodes: readonly SummaryNode[]
): SummaryResult {
  const unchanged = [...items];
  if (!items.some(i => isSummary(i) && i.id === id)) return { ok: false, reason: "unknown", items: unchanged };
  const checked = checkSummaryMembers(members, nodes);
  if (!checked.ok) return { ok: false, reason: checked.reason, items: unchanged };
  return {
    ok: true,
    items: items.map(item =>
      isSummary(item) && item.id === id ? { ...item, parentId: checked.parentId, members: checked.members } : item
    )
  };
}

export function removeSummary(items: readonly CanvasItem[], id: string): CanvasItem[] {
  return items.filter(item => !(isSummary(item) && item.id === id));
}

/**
 * Cleans brackets after cards are removed or moved (call it in the same transaction, like {@link removeLinksTo}): members that
 * no longer exist or are no longer children of the bracket's parent are dropped; a bracket with no member left, or whose parent
 * is gone, is removed. Brackets that need no change keep their identity; other items are untouched.
 */
export function pruneSummaries(items: readonly CanvasItem[], nodes: readonly SummaryNode[]): CanvasItem[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const out: CanvasItem[] = [];
  for (const item of items) {
    if (!isSummary(item)) {
      out.push(item);
      continue;
    }
    if (!byId.has(item.parentId)) continue;
    const members = item.members.filter(m => byId.get(m)?.parentId === item.parentId);
    if (!members.length) continue;
    out.push(members.length === item.members.length ? item : { ...item, members });
  }
  return out;
}

/** Strips the given topic ids from every bracket's members (and removes brackets left empty or whose parent is in `nodeIds`). */
export function removeSummaryMembers(
  items: readonly CanvasItem[],
  nodeIds: ReadonlySet<string> | readonly string[]
): CanvasItem[] {
  const gone = new Set<string>(nodeIds);
  const out: CanvasItem[] = [];
  for (const item of items) {
    if (!isSummary(item)) {
      out.push(item);
      continue;
    }
    if (gone.has(item.parentId)) continue;
    const members = item.members.filter(m => !gone.has(m));
    if (!members.length) continue;
    out.push(members.length === item.members.length ? item : { ...item, members });
  }
  return out;
}

/**
 * The brackets under one parent, ready for the AI: framed titles (the effective range) and the user's text. Empty string when
 * the parent has none, so a prompt without brackets stays byte for byte as before.
 */
export function summaryDirectionContext(
  items: readonly CanvasItem[],
  nodes: readonly SummaryNode[],
  parentId: string,
  titleOf: (id: string) => string
): string {
  return items
    .filter((item): item is SummaryItem => isSummary(item) && item.parentId === parentId)
    .flatMap(summary => {
      const range = effectiveSummaryRange(summary, nodes);
      if (!range.length) return [];
      const titles = range.map(id => titleOf(id).replace(/\s+/g, " ").trim()).join("; ");
      return [`- ${titles}\n  ${summary.text.replace(/\n/g, "\n  ")}`];
    })
    .join("\n");
}
