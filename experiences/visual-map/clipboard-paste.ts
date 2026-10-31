import type { HypothesisStrength, TopicKind } from "../../note-values";
import type { TopicRelationKind } from "../../map-model";
import type { ClipboardPayload } from "./clipboard";

export interface PasteItem {
  /** Position in `PastePlan.items`; a parent always has a smaller index than its children. */
  index: number;
  parent: number | null;
  title: string;
  kind: TopicKind;
  body: string;
  strength?: HypothesisStrength;
}
export interface PasteRelation {
  kind: TopicRelationKind;
  from: number;
  to: number;
  description?: string;
}
export type PastePlan =
  | { ok: true; items: PasteItem[]; relations: PasteRelation[]; droppedRelations: number }
  | { ok: false; reason: "bad-tree" };

/**
 * Orders a parsed payload for creation: every parent before its children, siblings in payload order, and only the
 * relations whose two ends are both in the branch, translated to item indexes. A payload with a duplicate id, an
 * unknown parent or a cycle gives `bad-tree` rather than a partial plan. Never throws.
 */
export function planPaste(payload: ClipboardPayload): PastePlan {
  try {
    const nodes = payload.nodes;
    const byId = new Map<string, number>();
    for (let i = 0; i < nodes.length; i++) {
      if (byId.has(nodes[i].id)) return { ok: false, reason: "bad-tree" };
      byId.set(nodes[i].id, i);
    }
    const children = new Map<number | null, number[]>();
    for (let i = 0; i < nodes.length; i++) {
      const parent = nodes[i].parent === null ? null : (byId.get(nodes[i].parent as string) ?? -1);
      if (parent === -1) return { ok: false, reason: "bad-tree" };
      const list = children.get(parent) ?? [];
      list.push(i);
      children.set(parent, list);
    }
    const order: number[] = [];
    const itemOf = new Map<number, number>();
    const visit = (from: number): void => {
      // Iterative so a 500-deep chain cannot exhaust the stack.
      const pending: number[] = [from];
      while (pending.length) {
        const node = pending.pop()!;
        itemOf.set(node, order.length);
        order.push(node);
        const kids = children.get(node) ?? [];
        for (let k = kids.length - 1; k >= 0; k--) pending.push(kids[k]);
      }
    };
    for (const root of children.get(null) ?? []) visit(root);
    if (order.length !== nodes.length) return { ok: false, reason: "bad-tree" };
    const items: PasteItem[] = order.map((nodeIndex, index) => {
      const n = nodes[nodeIndex];
      const item: PasteItem = {
        index,
        parent: n.parent === null ? null : (itemOf.get(byId.get(n.parent) as number) as number),
        title: n.title,
        kind: n.kind,
        body: n.body
      };
      if (n.strength !== undefined) item.strength = n.strength;
      return item;
    });
    const relations: PasteRelation[] = [];
    let droppedRelations = 0;
    for (const r of payload.relations) {
      const from = byId.has(r.from) ? itemOf.get(byId.get(r.from) as number) : undefined;
      const to = byId.has(r.to) ? itemOf.get(byId.get(r.to) as number) : undefined;
      if (from === undefined || to === undefined || from === to) {
        droppedRelations++;
        continue;
      }
      const out: PasteRelation = { kind: r.kind, from, to };
      if (r.description !== undefined) out.description = r.description;
      relations.push(out);
    }
    return { ok: true, items, relations, droppedRelations };
  } catch {
    return { ok: false, reason: "bad-tree" };
  }
}

export type CutCheck = { ok: true } | { ok: false; reason: "into-own-branch" | "unknown-target" | "nothing-selected" };

/**
 * Whether the branches rooted at `rootIds` can be moved under `targetId` (null = to the top level). Moving a branch
 * under itself or under one of its own descendants would cut it off from the map, so it is refused.
 */
export function canPasteCut(
  nodes: readonly { id: string; parentId: string | null }[],
  rootIds: readonly string[],
  targetId: string | null
): CutCheck {
  if (!rootIds.length) return { ok: false, reason: "nothing-selected" };
  if (targetId === null) return { ok: true };
  const parentOf = new Map(nodes.map(n => [n.id, n.parentId] as const));
  if (!parentOf.has(targetId)) return { ok: false, reason: "unknown-target" };
  const roots = new Set(rootIds);
  const visited = new Set<string>();
  let current: string | null = targetId;
  while (current !== null && !visited.has(current)) {
    if (roots.has(current)) return { ok: false, reason: "into-own-branch" };
    visited.add(current);
    current = parentOf.get(current) ?? null;
  }
  return { ok: true };
}

export interface CrossSourceNode {
  id: string;
  path: string;
  parentId: string | null;
}
export interface CrossSource<N extends CrossSourceNode> {
  /** The copied topics in clipboard order (parents first), looked up in the source map. */
  branch: N[];
  /** The top topics of the copied branches, in payload order. */
  roots: N[];
}

/**
 * Checks that the copy recorded in the session is still what the source map holds: same map id, every copied topic
 * present at the recorded note path, and the same parent shape as the payload. Anything else returns null and the
 * paste falls back to the payload's whitelisted fields (nothing is read from the source files). Pure; never throws.
 */
export function resolveCrossSource<N extends CrossSourceNode>(
  payload: ClipboardPayload,
  record: { sourceMapId: string; nodeIds: readonly string[]; notePaths: readonly string[] },
  sourceMap: { id: string; nodes: readonly N[] }
): CrossSource<N> | null {
  try {
    if (sourceMap.id !== record.sourceMapId) return null;
    const count = payload.nodes.length;
    if (!count || record.nodeIds.length !== count || record.notePaths.length !== count) return null;
    const byId = new Map(sourceMap.nodes.map(node => [node.id, node] as const));
    const ids = new Set(record.nodeIds);
    const branch: N[] = [];
    const roots: N[] = [];
    for (let i = 0; i < count; i++) {
      const node = byId.get(record.nodeIds[i]);
      if (!node || node.path !== record.notePaths[i]) return null;
      const clip = payload.nodes[i];
      if (clip.parent === null) {
        if (node.parentId && ids.has(node.parentId)) return null;
        roots.push(node);
      } else {
        const parentIndex = payload.nodes.findIndex(item => item.id === clip.parent);
        if (parentIndex < 0 || node.parentId !== record.nodeIds[parentIndex]) return null;
      }
      branch.push(node);
    }
    return { branch, roots };
  } catch {
    return null;
  }
}
