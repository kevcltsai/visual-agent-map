import { MAP_CHAT_NEW_PREFIX, type MapChatAction } from "../../core/steps/map-chat/step";
import { pushAffected, type PushBox, type PushDecoration } from "../../layouts/push";
import type { MapNode } from "../../map-graph";

/**
 * The dashed preview of a plan that waits for the user's yes (V3.3 E3): the cards its add_child actions would make, laid out next to
 * their parents. Pure: it reads the actions and the boxes of the cards on the canvas and returns places, never a map node. The
 * preview is drawn only; it is never saved, searched, exported, shared, recorded or undone.
 */

/** One card a pending plan would make: under an existing card (its id), under a card of the same plan (`new:<ref>`), or a root (""). */
export interface PlanGhostSpec {
  parentId: string;
  title: string;
  ref?: string;
}
/** One relation a pending plan would add: its two ends are cards on the canvas (their ids) or cards of the same plan (`new:<ref>`). */
export interface PlanGhostRelation {
  fromId: string;
  toId: string;
}
export interface PlanGhostBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** A drawn dashed card: a planned title, or (`more`) the "… N more" card that stands for the rest of its group. */
export interface PlanGhostCard extends PlanGhostBox {
  title: string;
  more?: number;
}
export interface PlanGhostEdge {
  from: { x: number; y: number };
  to: { x: number; y: number };
}
export interface PlanGhostLayout {
  cards: PlanGhostCard[];
  /** From a parent to each drawn planned card. */
  edges: PlanGhostEdge[];
  /** The planned relations whose two ends are both drawn, from the facing sides of the two cards. */
  relations: PlanGhostEdge[];
}

/** At most this many planned cards are drawn under one parent; the rest are one "… N more" card. */
export const PLAN_GHOST_PER_GROUP = 3;
export const PLAN_GHOST_WIDTH = 200;
export const PLAN_GHOST_HEIGHT = 60;
const GAP_X = 80;
const GAP_Y = 16;

/** The cards a plan would make, in reply order. */
export function planGhostSpecs(actions: readonly MapChatAction[]): PlanGhostSpec[] {
  return actions.flatMap(action =>
    action.kind === "add_child"
      ? [{ parentId: action.parentId, title: action.title, ...(action.ref ? { ref: action.ref } : {}) }]
      : []
  );
}

/** The relations a plan would add, in reply order. */
export function planGhostRelations(actions: readonly MapChatAction[]): PlanGhostRelation[] {
  return actions.flatMap(action =>
    action.kind === "add_relation" ? [{ fromId: action.fromId, toId: action.toId }] : []
  );
}

/**
 * What the dashed cards keep clear of (V3.3 E3-x): the cards on the canvas, measured as the local push (A9) measures them. The
 * dashed cards are new cards to that push and every card on the canvas is fixed, so the dashed cards step past the cards and
 * each other while no card moves. `nodes` are the cards as drawn; they are read, never changed.
 */
export interface PlanGhostAvoid {
  nodes: readonly MapNode[];
  boxOf?: (id: string) => PushBox | undefined;
  decorations?: PushDecoration[];
  direction: string;
  gap?: number;
}

/** The node a drawn dashed card stands for in the push; never a map node (only the push's copy holds it). */
const GHOST_ID = "plan-ghost:";

interface Group {
  key: string;
  parent: PlanGhostBox | null;
  x: number;
  y: number;
  shown: number;
  more: number;
}

/**
 * Places the planned cards: each parent's new cards in a column to its right (below its children already there), at most
 * {@link PLAN_GHOST_PER_GROUP} per parent and one "… N more" card for the rest. New roots go in a column right of everything.
 * A card under a parent that is not on the canvas is not drawn; one under a planned card that is not drawn counts in the "more" of
 * the group that card went to. `boxes`: the cards on the canvas; `children`: the boxes of a card's children on the canvas.
 * A planned relation is a line only when both its ends are drawn (a card on the canvas or a drawn planned card); an end that is not
 * on the canvas or went into a "more" card drops the line. With `avoid`, the drawn cards are then moved clear of the canvas and of
 * each other by the local push; the lines follow them.
 */
export function planGhostLayout(
  specs: readonly PlanGhostSpec[],
  boxes: ReadonlyMap<string, PlanGhostBox>,
  children: (parentId: string) => readonly PlanGhostBox[],
  relations: readonly PlanGhostRelation[] = [],
  avoid?: PlanGhostAvoid
): PlanGhostLayout {
  const cards: PlanGhostCard[] = [];
  /** The parent each drawn card hangs under: a card's id, a drawn planned card, or none (a root). */
  const parents = new Map<PlanGhostCard, string | PlanGhostCard | null>();
  const groups = new Map<string, Group>();
  /** A planned ref: the box it was drawn in, or the group whose "more" it went to. */
  const refs = new Map<string, { box: PlanGhostCard } | { group: Group }>();
  const all = [...boxes.values()];
  const rootGroup = (): Group => ({
    key: "",
    parent: null,
    x: all.length ? Math.max(...all.map(box => box.x + box.width)) + GAP_X : 0,
    y: all.length ? Math.min(...all.map(box => box.y)) : 0,
    shown: 0,
    more: 0
  });
  const groupUnder = (key: string, parent: PlanGhostBox, existing: readonly PlanGhostBox[]): Group => ({
    key,
    parent,
    x: existing.length ? Math.min(...existing.map(box => box.x)) : parent.x + parent.width + GAP_X,
    y: existing.length ? Math.max(...existing.map(box => box.y + box.height)) + GAP_Y : parent.y,
    shown: 0,
    more: 0
  });
  const parentOf = (group: Group): string | PlanGhostCard | null => {
    if (!group.parent) return null;
    return group.key.startsWith(MAP_CHAT_NEW_PREFIX) ? (group.parent as PlanGhostCard) : group.key;
  };
  const place = (group: Group): PlanGhostBox => {
    const box = { x: group.x, y: group.y, width: PLAN_GHOST_WIDTH, height: PLAN_GHOST_HEIGHT };
    group.y += PLAN_GHOST_HEIGHT + GAP_Y;
    return box;
  };
  for (const spec of specs) {
    let group: Group | undefined;
    if (spec.parentId.startsWith(MAP_CHAT_NEW_PREFIX)) {
      const parent = refs.get(spec.parentId.slice(MAP_CHAT_NEW_PREFIX.length));
      if (!parent) continue;
      if ("group" in parent) {
        parent.group.more++;
        if (spec.ref) refs.set(spec.ref, parent);
        continue;
      }
      group = groups.get(spec.parentId);
      if (!group) groups.set(spec.parentId, (group = groupUnder(spec.parentId, parent.box, [])));
    } else if (spec.parentId === "") {
      group = groups.get("");
      if (!group) groups.set("", (group = rootGroup()));
    } else {
      const parent = boxes.get(spec.parentId);
      if (!parent) continue;
      group = groups.get(spec.parentId);
      if (!group) groups.set(spec.parentId, (group = groupUnder(spec.parentId, parent, children(spec.parentId))));
    }
    if (group.shown >= PLAN_GHOST_PER_GROUP) {
      group.more++;
      if (spec.ref) refs.set(spec.ref, { group });
      continue;
    }
    group.shown++;
    const card: PlanGhostCard = { ...place(group), title: spec.title };
    cards.push(card);
    parents.set(card, parentOf(group));
    if (spec.ref) refs.set(spec.ref, { box: card });
  }
  for (const group of groups.values()) {
    if (!group.more) continue;
    const card: PlanGhostCard = { ...place(group), title: "", more: group.more };
    cards.push(card);
    parents.set(card, parentOf(group));
  }
  if (avoid && cards.length) stepClear(cards, parents, avoid);
  const boxOf = (parent: string | PlanGhostCard | null): PlanGhostBox | undefined =>
    parent === null ? undefined : typeof parent === "string" ? boxes.get(parent) : parent;
  const edges = cards.flatMap(card => {
    const parent = boxOf(parents.get(card) ?? null);
    return parent
      ? [
          {
            from: { x: parent.x + parent.width, y: parent.y + parent.height / 2 },
            to: { x: card.x, y: card.y + card.height / 2 }
          }
        ]
      : [];
  });
  const end = (id: string): PlanGhostBox | undefined => {
    if (!id.startsWith(MAP_CHAT_NEW_PREFIX)) return boxes.get(id);
    const ref = refs.get(id.slice(MAP_CHAT_NEW_PREFIX.length));
    return ref && "box" in ref ? ref.box : undefined;
  };
  // From the side of one end that faces the other, so the line does not cross either card.
  const side = (box: PlanGhostBox, right: boolean): { x: number; y: number } => ({
    x: right ? box.x + box.width : box.x,
    y: box.y + box.height / 2
  });
  const lines = relations.flatMap(relation => {
    const from = end(relation.fromId),
      to = end(relation.toId);
    if (!from || !to || from === to) return [];
    const rightward = from.x + from.width / 2 <= to.x + to.width / 2;
    return [{ from: side(from, rightward), to: side(to, !rightward) }];
  });
  return { cards, edges, relations: lines };
}

/**
 * Moves the drawn cards clear of the cards on the canvas and of each other with the local push (A9), one parent's cards at a
 * time, as if each group were added in turn: the group goes in as new cards under its parent, and every card on the canvas and
 * every group placed before it is fixed. Only `cards` change. A map arrangement the push does not handle (radial, timeline,
 * fishbone) is pushed as a right-growing one, so the dashed cards still keep clear.
 */
function stepClear(
  cards: PlanGhostCard[],
  parents: ReadonlyMap<PlanGhostCard, string | PlanGhostCard | null>,
  avoid: PlanGhostAvoid
): void {
  const ids = new Map(cards.map((card, index) => [card, `${GHOST_ID}${index}`]));
  const known = new Set(avoid.nodes.map(node => node.id));
  const ghostBoxes = new Map(cards.map(card => [ids.get(card)!, { dx: 0, dy: 0, w: card.width, h: card.height }]));
  const whole = avoid.direction === "radial" || avoid.direction === "timeline" || avoid.direction === "fishbone";
  const parentIdOf = (card: PlanGhostCard): string | null => {
    const parent = parents.get(card) ?? null;
    if (parent === null) return null;
    return typeof parent === "string" ? (known.has(parent) ? parent : null) : ids.get(parent)!;
  };
  // A planned card's own cards come after it in `cards`, so a group's parent is always placed before the group.
  const groups = new Map<string | null, PlanGhostCard[]>();
  for (const card of cards) {
    const key = parentIdOf(card);
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  const placed: MapNode[] = [];
  const fixed = new Set(known);
  for (const [parentId, group] of groups) {
    const fresh = group.map(
      card => ({ id: ids.get(card)!, parentId, x: card.x, y: card.y, width: card.width }) as MapNode
    );
    const result = pushAffected(
      [...avoid.nodes, ...placed, ...fresh],
      fresh.map(node => node.id),
      {
        fixed,
        boxOf: id => ghostBoxes.get(id) ?? avoid.boxOf?.(id),
        decorations: avoid.decorations,
        layout: { direction: whole ? "right" : avoid.direction, gap: avoid.gap },
        settleMoving: true
      }
    );
    const moved = new Map(result.nodes.map(node => [node.id, node]));
    for (const [index, card] of group.entries()) {
      const node = moved.get(fresh[index].id)!;
      Object.assign(card, { x: node.x, y: node.y });
      placed.push({ ...fresh[index], x: node.x, y: node.y });
      fixed.add(node.id);
    }
  }
}
