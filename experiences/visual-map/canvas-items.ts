/**
 * Canvas objects stored in the map file (`MapDocument.canvasItems`): free images and boundary frames. Map.md is
 * untrusted input, so `sanitizeCanvasItems` rebuilds each known item from fixed fields and drops malformed ones one
 * by one. Unknown kinds are kept as they are (a newer plugin may have written them). Pure functions, no DOM.
 */
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
}
export interface UnknownItem {
  kind: string;
  [key: string]: unknown;
}
export type CanvasItem = ImageItem | BoundaryItem | TextItem | UnknownItem;
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
const PARENT_ID_LIMIT = 200;
export const LINK_LIMIT = 20;

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
  const links = cleanLinks(raw.links, id);
  if (links.length) item.links = links;
  return item;
}

/** Parses untrusted JSON. Never throws; a bad item is dropped alone, an unknown kind is kept as is. */
export function sanitizeCanvasItems(raw: unknown): CanvasItem[] {
  if (!Array.isArray(raw)) return [];
  const out: CanvasItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.kind !== "string") continue;
    let item: CanvasItem | null;
    if (entry.kind === "image") item = cleanImage(entry);
    else if (entry.kind === "boundary") item = cleanBoundary(entry);
    else if (entry.kind === "text") item = cleanTextItem(entry);
    else item = entry as UnknownItem;
    if (!item) continue;
    if (item.kind === "image" || item.kind === "boundary" || item.kind === "text") {
      const id = (item as ImageItem | BoundaryItem | TextItem).id;
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(item);
  }
  return out;
}

export function addImage(items: readonly CanvasItem[], image: Omit<ImageItem, "kind">): CanvasItem[] {
  const clean = cleanImage({ ...image, kind: "image" });
  if (!clean || items.some(i => i.kind === "image" && (i as ImageItem).id === clean.id)) return [...items];
  return [...items, clean];
}

const isImage = (item: CanvasItem, id: string): item is ImageItem =>
  item.kind === "image" && (item as ImageItem).id === id;

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

/** Bounding box of the members that currently have a rect, grown by `pad`. Null when none of them exist. */
export function boundaryBounds(
  nodeIds: readonly string[],
  rectOf: (id: string) => Rect | null | undefined,
  pad: number
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
  return { x: left - margin, y: top - margin, w: right - left + margin * 2, h: bottom - top + margin * 2 };
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
