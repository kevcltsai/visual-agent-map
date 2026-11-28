/**
 * Cross-map read-only knowledge references (P4.3). A map may hold an optional `knowledgeRefs` list: each entry points at one
 * card of another map by `mapId` + `nodeId` (the identity) and hangs on one card of this map (`parentId`) at an offset
 * (`x`, `y`) from that card. `pathHint` only speeds up the lookup; it is file content, so it is never trusted. No title and
 * no body is stored: both are read from the original card when they are shown, and shown only while the original is still
 * usable. parseMap and serializeMap carry the key untouched (like `argumentMap`), so an entry this version cannot read stays
 * in the file exactly as it was; `readKnowledgeRefs` decides which entries are usable. Pure: the vault is reached only
 * through the `KnowledgeRefIO` the caller passes. Imports nothing from obsidian or a view.
 */
import { isArchivedVamNote } from "./archived-note";

export interface KnowledgeRef {
  id: string;
  mapId: string;
  nodeId: string;
  /** The card of this map the reference hangs on. */
  parentId: string;
  /** Offset from the parent card's own position. */
  x: number;
  y: number;
  pathHint: string;
}

const KEYS: readonly string[] = ["id", "mapId", "nodeId", "parentId", "x", "y", "pathHint"];
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface RefHost {
  id: string;
  nodes: readonly { id: string }[];
  knowledgeRefs?: unknown;
}

/** The stored entries, whatever they hold: `[]` when the key is absent or not a list. */
export function rawKnowledgeRefs(map: Pick<RefHost, "knowledgeRefs">): unknown[] {
  return Array.isArray(map.knowledgeRefs) ? (map.knowledgeRefs as unknown[]) : [];
}

/**
 * The usable entries: exactly the seven known fields with the right types; an id that is a card of this map or an earlier
 * reference's id is not usable; a reference to this very map is not usable. A bad entry is skipped, never rewritten.
 */
export function readKnowledgeRefs(map: RefHost): KnowledgeRef[] {
  const taken = new Set(map.nodes.map(node => node.id));
  const out: KnowledgeRef[] = [];
  for (const raw of rawKnowledgeRefs(map)) {
    if (!isRecord(raw)) continue;
    const keys = Object.keys(raw);
    if (keys.length !== KEYS.length || !KEYS.every(key => keys.includes(key))) continue;
    const { id, mapId, nodeId, parentId, x, y, pathHint } = raw;
    if (!isText(id) || !isText(mapId) || !isText(nodeId) || !isText(parentId) || !isText(pathHint)) continue;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (taken.has(id) || mapId === map.id) continue;
    taken.add(id);
    out.push({ id, mapId, nodeId, parentId, x, y, pathHint });
  }
  return out;
}

/** The usable entries whose parent card is in this map: a reference whose parent is gone is kept in the file but not shown. */
export function visibleKnowledgeRefs(map: RefHost): KnowledgeRef[] {
  const alive = new Set(map.nodes.map(node => node.id));
  return readKnowledgeRefs(map).filter(ref => alive.has(ref.parentId));
}

/** How many visible references hang on the given cards (what a branch copy leaves behind). */
export function knowledgeRefsUnder(map: RefHost, nodeIds: Iterable<string>): number {
  const ids = new Set(nodeIds);
  return visibleKnowledgeRefs(map).filter(ref => ids.has(ref.parentId)).length;
}

export type AddCheck = "ok" | "self" | "duplicate" | "no-parent";
/** Whether a reference to `mapId`/`nodeId` may be added under `parentId`: not this map, not twice on the same card. */
export function checkAddKnowledgeRef(
  map: RefHost,
  target: { mapId: string; nodeId: string; parentId: string }
): AddCheck {
  if (target.mapId === map.id) return "self";
  if (!map.nodes.some(node => node.id === target.parentId)) return "no-parent";
  const same = readKnowledgeRefs(map).some(
    ref => ref.parentId === target.parentId && ref.mapId === target.mapId && ref.nodeId === target.nodeId
  );
  return same ? "duplicate" : "ok";
}

/** Appends a reference (the caller ran `checkAddKnowledgeRef`). Entries already stored are left exactly as they are. */
export function appendKnowledgeRef(map: { knowledgeRefs?: unknown }, ref: KnowledgeRef): void {
  map.knowledgeRefs = [...rawKnowledgeRefs(map), { ...ref }];
}

/** Takes one entry out by id (and the relations that end at it, V3.3 P4.4); the key goes when the list is left empty. Returns whether an entry was removed. */
export function removeKnowledgeRef(
  map: { knowledgeRefs?: unknown; topicRelations?: { from: string; to: string }[] },
  id: string
): boolean {
  const list = rawKnowledgeRefs(map);
  const next = list.filter(entry => !(isRecord(entry) && entry.id === id));
  if (next.length === list.length) return false;
  if (next.length) map.knowledgeRefs = next;
  else delete map.knowledgeRefs;
  if (Array.isArray(map.topicRelations)) {
    const left = map.topicRelations.filter(link => link.from !== id && link.to !== id);
    if (left.length) map.topicRelations = left;
    else delete map.topicRelations;
  }
  return true;
}

/** Sets the offset of one reference (a drag, an arrow key). Returns whether anything changed. */
export function moveKnowledgeRef(map: { knowledgeRefs?: unknown }, id: string, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  let changed = false;
  map.knowledgeRefs = rawKnowledgeRefs(map).map(entry => {
    if (!isRecord(entry) || entry.id !== id || (entry.x === x && entry.y === y)) return entry;
    changed = true;
    return { ...entry, x, y };
  });
  return changed;
}

/**
 * The one place `pathHint` is written, used only by the user's own reference transactions (paste, remove): every usable
 * entry whose resolved path is known and differs gets the new hint. An ordinary save never calls this.
 */
export function refreshPathHints(map: { knowledgeRefs?: unknown }, paths: ReadonlyMap<string, string>): void {
  if (!paths.size || !Array.isArray(map.knowledgeRefs)) return;
  map.knowledgeRefs = rawKnowledgeRefs(map).map(entry => {
    if (!isRecord(entry) || typeof entry.id !== "string") return entry;
    const path = paths.get(entry.id);
    return path && typeof entry.pathHint === "string" && entry.pathHint !== path ? { ...entry, pathHint: path } : entry;
  });
}

/**
 * The references of a copy of a map (duplicateMap): every entry is copied as it is, and a parent that was copied now names the
 * new card. An entry whose parent was not copied (or that is not readable) keeps its data and stays hidden. Undefined when
 * the source has none.
 */
export function duplicatedKnowledgeRefs(
  map: Pick<RefHost, "knowledgeRefs">,
  freshParent: ReadonlyMap<string, string>
): unknown[] | undefined {
  const list = rawKnowledgeRefs(map);
  if (!list.length) return undefined;
  return list.map(entry => {
    const copy = JSON.parse(JSON.stringify(entry)) as unknown;
    if (isRecord(copy) && typeof copy.parentId === "string" && freshParent.has(copy.parentId))
      copy.parentId = freshParent.get(copy.parentId);
    return copy;
  });
}

/** What a reference could not be resolved to; none of them carries any content of the original. */
export type RefUnavailable = "missing" | "ambiguous" | "node-missing" | "archived" | "note-unreadable";
export type RefResolution =
  | {
      ok: true;
      mapPath: string;
      mapTitle: string;
      notePath: string;
      title: string;
      /** Only when the resolution was asked for the body. */
      summary?: string;
      detail?: string;
    }
  | { ok: false; reason: RefUnavailable };

/** The vault, as the resolver needs it. Every call reads the current state. */
export interface KnowledgeRefIO {
  /** Paths of the notes that carry the map marker (`mapFiles()`); the only files a reference may be read from. */
  mapPaths(): Promise<readonly string[]>;
  /** The parsed map, or null when the file cannot be read or is not a map. Never throws. */
  readMap(path: string): Promise<{ id: string; title: string; nodes: readonly { id: string; path: string }[] } | null>;
  /** Frontmatter of a note, for the archive check. */
  noteFrontmatter(path: string): Promise<Record<string, unknown> | null | undefined>;
  /** The note's title and text, or null when it cannot be read. */
  readNote(path: string): Promise<{ title: string; summary: string; detail: string } | null>;
}

type ResolveTarget = Pick<KnowledgeRef, "mapId" | "nodeId" | "pathHint">;
type MapRead = Awaited<ReturnType<KnowledgeRefIO["readMap"]>>;

/**
 * Resolves references against the vault now. (i) the hinted file must be in the marker list, else it is not read; (ii) its
 * `map.id` must match, else every marked map is read once (this call only) to find the id: none is missing, more than one is
 * ambiguous and never chosen; (iii) the node must exist in the map as just read; (iv) the node's note must not be an archived
 * VAM note. Anything else is `{ ok: false }` with no content. Nothing is written and nothing outlives the call.
 */
export async function resolveKnowledgeRefs(
  refs: readonly (ResolveTarget & { id: string })[],
  io: KnowledgeRefIO,
  options: { withBody?: boolean } = {}
): Promise<Map<string, RefResolution>> {
  const out = new Map<string, RefResolution>();
  if (!refs.length) return out;
  const marked = new Set(await io.mapPaths());
  const reads = new Map<string, MapRead>();
  const read = async (path: string): Promise<MapRead> => {
    if (!reads.has(path)) reads.set(path, await io.readMap(path).catch(() => null));
    return reads.get(path) ?? null;
  };
  let index: Map<string, string[]> | undefined;
  const byMapId = async (): Promise<Map<string, string[]>> => {
    if (index) return index;
    index = new Map();
    for (const path of marked) {
      const map = await read(path);
      if (map) index.set(map.id, [...(index.get(map.id) ?? []), path]);
    }
    return index;
  };
  for (const ref of refs) {
    let path: string | undefined;
    if (marked.has(ref.pathHint) && (await read(ref.pathHint))?.id === ref.mapId) path = ref.pathHint;
    else {
      const found = (await byMapId()).get(ref.mapId) ?? [];
      if (found.length > 1) {
        out.set(ref.id, { ok: false, reason: "ambiguous" });
        continue;
      }
      path = found[0];
    }
    if (!path) {
      out.set(ref.id, { ok: false, reason: "missing" });
      continue;
    }
    const map = await read(path);
    const node = map?.nodes.find(item => item.id === ref.nodeId);
    if (!map || !node) {
      out.set(ref.id, { ok: false, reason: "node-missing" });
      continue;
    }
    if (isArchivedVamNote(node.path, await io.noteFrontmatter(node.path).catch(() => null))) {
      out.set(ref.id, { ok: false, reason: "archived" });
      continue;
    }
    const note = await io.readNote(node.path).catch(() => null);
    if (!note) {
      out.set(ref.id, { ok: false, reason: "note-unreadable" });
      continue;
    }
    out.set(ref.id, {
      ok: true,
      mapPath: path,
      mapTitle: map.title,
      notePath: node.path,
      title: note.title,
      ...(options.withBody ? { summary: note.summary, detail: note.detail } : {})
    });
  }
  return out;
}

/**
 * The text a share file or an outline export carries for a reference: the title only, never a path or the body. Null when the
 * original cannot be used.
 */
export function referenceTitle(resolution: RefResolution | undefined): string | null {
  if (!resolution?.ok) return null;
  const title = resolution.title.replace(/\s+/g, " ").trim();
  return title || null;
}

/** Reference lines an outline export adds: one virtual child per visible reference, titled "<prefix> <title>". Titles only. */
export interface ReferenceOutline {
  nodes: { id: string; parentId: string }[];
  /** virtual node id -> the line text. */
  titles: Map<string, string>;
}
export function referenceOutline(
  map: RefHost,
  titles: ReadonlyMap<string, string | null>,
  text: { prefix: string; unavailable: string }
): ReferenceOutline {
  const out: ReferenceOutline = { nodes: [], titles: new Map() };
  for (const ref of visibleKnowledgeRefs(map)) {
    const id = `vam-ref:${ref.id}`;
    out.nodes.push({ id, parentId: ref.parentId });
    out.titles.set(id, `${text.prefix} ${titles.get(ref.id) || text.unavailable}`);
  }
  return out;
}
