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
export interface UnknownItem {
  kind: string;
  [key: string]: unknown;
}
export type CanvasItem = ImageItem | BoundaryItem | UnknownItem;
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
    else item = entry as UnknownItem;
    if (!item) continue;
    if (item.kind === "image" || item.kind === "boundary") {
      const id = (item as ImageItem | BoundaryItem).id;
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
