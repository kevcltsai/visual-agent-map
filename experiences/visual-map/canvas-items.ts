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
export interface UnknownItem {
  kind: string;
  [key: string]: unknown;
}
export type CanvasItem = ImageItem | BoundaryItem | TextItem | SummaryItem | UnknownItem;
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
export const SUMMARY_MEMBER_LIMIT = 50;

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
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.kind !== "string") continue;
    let item: CanvasItem | null;
    if (entry.kind === "image") item = cleanImage(entry);
    else if (entry.kind === "boundary") item = cleanBoundary(entry);
    else if (entry.kind === "text") item = cleanTextItem(entry);
    else if (entry.kind === "summary") item = cleanSummary(entry);
    else item = entry as UnknownItem;
    if (!item) continue;
    if (item.kind === "image" || item.kind === "boundary" || item.kind === "text" || item.kind === "summary") {
      const id = (item as ImageItem | BoundaryItem | TextItem | SummaryItem).id;
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
}
export type SummaryRefusal =
  "invalid" | "duplicate" | "root" | "cross-parent" | "not-adjacent" | "too-many" | "unknown";
export type SummaryResult =
  { ok: true; items: CanvasItem[] } | { ok: false; reason: SummaryRefusal; items: CanvasItem[] };

const isSummary = (item: CanvasItem): item is SummaryItem => item.kind === "summary";
const childIds = (nodes: readonly SummaryNode[], parentId: string): string[] =>
  nodes.filter(n => n.parentId === parentId).map(n => n.id);

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
