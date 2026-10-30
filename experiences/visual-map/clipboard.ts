import { HYPOTHESIS_STRENGTHS, TOPIC_KINDS, type HypothesisStrength, type TopicKind } from "../../note-values";
import { normalizeRelationDescription, type TopicRelation, type TopicRelationKind } from "../../map-model";
import { OUTLINE_TITLE_LIMIT } from "./outline-import";

/**
 * Private clipboard format v1 for copying a branch (`vam-branch`). The clipboard is untrusted input: parsing builds
 * every output object from a fixed list of fields, never copies unknown keys, never reads a path or map id from the
 * payload (decision #17: the plugin keeps the source in memory, matched by `clipId`), and never throws.
 */
export const CLIPBOARD_FORMAT = "vam-branch";
export const CLIPBOARD_VERSION = 1;
export const CLIPBOARD_MAX_CHARS = 2_000_000;
export const CLIPBOARD_MAX_NODES = 500;
export const CLIPBOARD_MAX_BODY = 200_000;
export const CLIPBOARD_MAX_RELATIONS = 2_000;

export interface ClipNode {
  id: string;
  parent: string | null;
  title: string;
  kind: TopicKind;
  body: string;
  strength?: HypothesisStrength;
}
export interface ClipRelation {
  kind: TopicRelationKind;
  from: string;
  to: string;
  description?: string;
}
export interface ClipboardPayload {
  format: typeof CLIPBOARD_FORMAT;
  version: typeof CLIPBOARD_VERSION;
  clipId: string;
  nodes: ClipNode[];
  relations: ClipRelation[];
}
export type ClipboardRejection =
  | "not-text"
  | "too-large"
  | "bad-json"
  | "not-vam"
  | "version"
  | "bad-clip-id"
  | "bad-nodes"
  | "too-many-nodes"
  | "bad-id"
  | "bad-parent"
  | "bad-title"
  | "bad-kind"
  | "bad-body"
  | "bad-relations"
  | "too-many-relations";
export type ClipboardParse =
  { ok: true; payload: ClipboardPayload; droppedRelations: number } | { ok: false; reason: ClipboardRejection };

const CLIP_ID = /^[A-Za-z0-9_-]{8,64}$/;
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
// C0, DEL, C1, and the Unicode line and paragraph separators: nothing that can break a title across lines.
// eslint-disable-next-line no-control-regex -- the control characters are exactly what is being refused
const TITLE_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// A Record keyed by TopicRelationKind makes tsc fail when map-model adds or removes a kind.
const RELATION_KIND_RECORD: Record<TopicRelationKind, true> = {
  supports: true,
  contradicts: true,
  verifies: true,
  derives_from: true,
  related: true,
  prerequisite: true
};
const RELATION_KINDS: readonly string[] = Object.keys(RELATION_KIND_RECORD);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** Own properties only, so an inherited or `__proto__` value is never read as a field. */
const own = (record: Record<string, unknown>, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
const fail = (reason: ClipboardRejection): { ok: false; reason: ClipboardRejection } => ({ ok: false, reason });
const startsWithFrontmatter = (body: string): boolean => /^---[ \t]*(?:\r?\n|$)/.test(body.replace(/^\uFEFF/, ""));

export function parseClipboard(raw: unknown): ClipboardParse {
  try {
    if (typeof raw !== "string") return fail("not-text");
    if (raw.length > CLIPBOARD_MAX_CHARS) return fail("too-large");
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return fail("bad-json");
    }
    if (!isRecord(data) || own(data, "format") !== CLIPBOARD_FORMAT) return fail("not-vam");
    if (own(data, "version") !== CLIPBOARD_VERSION) return fail("version");
    const clipId = own(data, "clipId");
    if (typeof clipId !== "string" || !CLIP_ID.test(clipId)) return fail("bad-clip-id");
    const rawNodes = own(data, "nodes");
    if (!Array.isArray(rawNodes) || rawNodes.length === 0) return fail("bad-nodes");
    if (rawNodes.length > CLIPBOARD_MAX_NODES) return fail("too-many-nodes");

    const nodes: ClipNode[] = [];
    const seen = new Set<string>();
    for (const item of rawNodes as unknown[]) {
      if (!isRecord(item)) return fail("bad-nodes");
      const id = own(item, "id");
      if (typeof id !== "string" || !NODE_ID.test(id) || seen.has(id)) return fail("bad-id");
      const parent = own(item, "parent");
      if (parent !== null && (typeof parent !== "string" || !seen.has(parent))) return fail("bad-parent");
      const title = own(item, "title");
      if (typeof title !== "string") return fail("bad-title");
      const trimmed = title.trim();
      if (!trimmed || [...trimmed].length > OUTLINE_TITLE_LIMIT || TITLE_FORBIDDEN.test(trimmed))
        return fail("bad-title");
      const kind = own(item, "kind");
      if (typeof kind !== "string" || !(TOPIC_KINDS as readonly string[]).includes(kind)) return fail("bad-kind");
      const body = own(item, "body");
      if (
        typeof body !== "string" ||
        body.length > CLIPBOARD_MAX_BODY ||
        body.includes("\u0000") ||
        startsWithFrontmatter(body)
      )
        return fail("bad-body");
      seen.add(id);
      const node: ClipNode = { id, parent, title: trimmed, kind: kind as TopicKind, body };
      const strength = own(item, "strength");
      if (
        kind === "hypothesis" &&
        typeof strength === "string" &&
        (HYPOTHESIS_STRENGTHS as readonly string[]).includes(strength)
      )
        node.strength = strength as HypothesisStrength;
      nodes.push(node);
    }

    const rawRelations = own(data, "relations");
    if (rawRelations !== undefined && !Array.isArray(rawRelations)) return fail("bad-relations");
    const list: unknown[] = Array.isArray(rawRelations) ? (rawRelations as unknown[]) : [];
    if (list.length > CLIPBOARD_MAX_RELATIONS) return fail("too-many-relations");
    const relations: ClipRelation[] = [];
    const pairs = new Set<string>();
    let droppedRelations = 0;
    for (const item of list) {
      if (!isRecord(item)) {
        droppedRelations++;
        continue;
      }
      const kind = own(item, "kind");
      const from = own(item, "from");
      const to = own(item, "to");
      if (
        typeof kind !== "string" ||
        !RELATION_KINDS.includes(kind) ||
        typeof from !== "string" ||
        typeof to !== "string" ||
        !seen.has(from) ||
        !seen.has(to) ||
        from === to
      ) {
        droppedRelations++;
        continue;
      }
      const key = from > to ? `${to}\0${from}` : `${from}\0${to}`;
      if (pairs.has(key)) {
        droppedRelations++;
        continue;
      }
      pairs.add(key);
      const relation: ClipRelation = { kind: kind as TopicRelationKind, from, to };
      const description = own(item, "description");
      const normalized = typeof description === "string" ? normalizeRelationDescription(description) : undefined;
      if (normalized !== undefined) relation.description = normalized;
      relations.push(relation);
    }
    return {
      ok: true,
      payload: { format: CLIPBOARD_FORMAT, version: CLIPBOARD_VERSION, clipId, nodes, relations },
      droppedRelations
    };
  } catch {
    return fail("bad-json");
  }
}

export function serializeClipboard(payload: ClipboardPayload): string {
  return JSON.stringify(payload);
}

/** Plain-text outline, one `- title` line per node, indented by depth. The title is used as is, with no escaping. */
export function clipboardOutline(payload: ClipboardPayload): string {
  const depth = new Map<string, number>();
  const lines: string[] = [];
  for (const node of payload.nodes) {
    const level = node.parent === null ? 0 : (depth.get(node.parent) ?? 0) + 1;
    depth.set(node.id, level);
    lines.push("\t".repeat(level) + "- " + node.title);
  }
  return lines.join("\n");
}

export interface ClipboardBuildInput {
  /** Every node of the map; only `id` and `parentId` are read. */
  nodes: readonly { id: string; parentId: string | null }[];
  /** Node ids in display order; siblings and roots are sorted by their position here. */
  order: readonly string[];
  selectedIds: readonly string[];
  noteOf: (id: string) => { title: string; body: string; kind: TopicKind; strength?: HypothesisStrength };
  relations: readonly TopicRelation[];
  clipId: string;
}

/** Collects the selected branches (a selected node under a selected ancestor joins that ancestor's branch). */
export function buildClipboardPayload(input: ClipboardBuildInput): ClipboardParse {
  try {
    const parentOf = new Map(input.nodes.map(n => [n.id, n.parentId] as const));
    const position = new Map<string, number>();
    input.order.forEach((id, index) => {
      if (!position.has(id)) position.set(id, index);
    });
    input.nodes.forEach(n => {
      if (!position.has(n.id)) position.set(n.id, input.order.length + position.size);
    });
    const rank = (id: string): number => position.get(id) ?? Number.MAX_SAFE_INTEGER;
    const selected = new Set(input.selectedIds.filter(id => parentOf.has(id)));
    const hasSelectedAncestor = (id: string): boolean => {
      const visited = new Set<string>([id]);
      let current = parentOf.get(id) ?? null;
      while (current !== null && !visited.has(current)) {
        if (selected.has(current)) return true;
        visited.add(current);
        current = parentOf.get(current) ?? null;
      }
      return false;
    };
    const roots = [...selected].filter(id => !hasSelectedAncestor(id)).sort((a, b) => rank(a) - rank(b));
    const children = new Map<string, string[]>();
    for (const n of input.nodes) {
      if (n.parentId === null) continue;
      const siblings = children.get(n.parentId) ?? [];
      siblings.push(n.id);
      children.set(n.parentId, siblings);
    }
    const newId = new Map<string, string>();
    const nodes: ClipNode[] = [];
    const visit = (id: string, parent: string | null): void => {
      if (newId.has(id)) return;
      const clipped = `n${newId.size + 1}`;
      newId.set(id, clipped);
      const note = input.noteOf(id);
      const node: ClipNode = { id: clipped, parent, title: note.title, kind: note.kind, body: note.body };
      if (note.strength !== undefined) node.strength = note.strength;
      nodes.push(node);
      for (const child of [...(children.get(id) ?? [])].sort((a, b) => rank(a) - rank(b))) visit(child, clipped);
    };
    for (const root of roots) visit(root, null);
    const relations: ClipRelation[] = [];
    for (const r of input.relations) {
      const from = newId.get(r.from);
      const to = newId.get(r.to);
      if (from === undefined || to === undefined) continue;
      const out: ClipRelation = { kind: r.kind, from, to };
      if (r.description !== undefined) out.description = r.description;
      relations.push(out);
    }
    const raw: ClipboardPayload = {
      format: CLIPBOARD_FORMAT,
      version: CLIPBOARD_VERSION,
      clipId: input.clipId,
      nodes,
      relations
    };
    return parseClipboard(serializeClipboard(raw));
  } catch {
    return fail("bad-nodes");
  }
}
