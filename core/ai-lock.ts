import type { MapNode } from "../map-graph";
import type { TopicRelation } from "../map-model";

/**
 * AI lock (`ai-locked: true` on a topic note): the one place that decides whether an AI-initiated write may touch a set
 * of topics. Pure: it reads the map tree, the semantic relations and each topic's lock flag, never the vault. Every AI
 * entry asks it before calling the AI and again inside the write (the late-result fence). User edits and the program's
 * own maintenance never ask it.
 *
 * - `write`: change the target topic's note (title, summary, detail, preview, tier, images, charts).
 * - `addChild`: add a child under the target.
 * - `remove`: take the target off the map (delete it, or merge it away). Its subtree goes with it, its parent loses a
 *   direct child, and a topic with a semantic relation to a locked topic may not be removed.
 * - `move`: change the target's parent; `to` is the new parent (null = root).
 */
export type AiLockOp = "write" | "addChild" | "remove" | "move";
/**
 * Why the write is refused: the target itself is locked, its (old or new) parent is locked, a topic in its subtree is
 * locked, or it has a semantic relation with a locked topic.
 */
export type AiLockReason = "locked" | "lockedParent" | "lockedDescendant" | "lockedRelation";

export interface AiLockMap {
  nodes: readonly Pick<MapNode, "id" | "parentId">[];
  topicRelations?: readonly Pick<TopicRelation, "from" | "to">[];
}
/** The lock flag of each topic by node id (the view's `notes`), or a function that answers it. */
export type AiLockNotes = ReadonlyMap<string, { aiLocked?: boolean } | undefined> | ((id: string) => boolean);

export function isAiLocked(notes: AiLockNotes, id: string | null | undefined): boolean {
  if (!id) return false;
  return typeof notes === "function" ? notes(id) : notes.get(id)?.aiLocked === true;
}

/** True when at least one topic of the map is locked (the chat context only marks locks then). */
export function mapHasAiLock(map: AiLockMap | null | undefined, notes: AiLockNotes): boolean {
  return !!map?.nodes.some(node => isAiLocked(notes, node.id));
}

/**
 * The reason the AI may not do `op` on `targets` (node ids), or null when it may. Ids that are not on the map are
 * checked only for their own lock.
 */
export function aiLockBlock(
  op: AiLockOp,
  targets: readonly string[],
  map: AiLockMap | null | undefined,
  notes: AiLockNotes,
  options: { to?: string | null } = {}
): AiLockReason | null {
  const nodes = map?.nodes ?? [];
  const parentOf = (id: string): string | null => nodes.find(node => node.id === id)?.parentId ?? null;
  for (const id of targets) {
    if (isAiLocked(notes, id)) return "locked";
    if (op === "write" || op === "addChild") continue;
    if (isAiLocked(notes, parentOf(id))) return "lockedParent";
    if (op === "move") {
      if (options.to !== undefined && isAiLocked(notes, options.to)) return "lockedParent";
      continue;
    }
    // remove: the whole subtree leaves the map with it.
    const subtree = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const node of nodes)
        if (node.parentId && subtree.has(node.parentId) && !subtree.has(node.id)) {
          subtree.add(node.id);
          grew = true;
        }
    }
    for (const member of subtree) if (member !== id && isAiLocked(notes, member)) return "lockedDescendant";
    for (const relation of map?.topicRelations ?? []) {
      const other = subtree.has(relation.from) ? relation.to : subtree.has(relation.to) ? relation.from : null;
      if (other && !subtree.has(other) && isAiLocked(notes, other)) return "lockedRelation";
    }
  }
  return null;
}

/** The error a write-time AI lock check throws; entries report it with the locked notice, not as a failure. */
export function aiLockedError(): Error {
  const error = new Error("AI lock: the topic is locked");
  error.name = "AiLockedError";
  return error;
}
export function isAiLockedError(error: unknown): boolean {
  return error instanceof Error && error.name === "AiLockedError";
}
