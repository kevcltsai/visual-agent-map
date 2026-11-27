import { LAYOUT_GAP } from "../map-layout";
import { CARD_WIDTH, visibleNodes, type MapNode } from "../map-graph";
import { layoutDirectionFor } from "./compose";

/** A card's drawn box in canvas units. */
export interface PushBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A bracket or frame drawn around `members`; `pad` is how far it sticks out of their union. */
export interface PushDecoration {
  members: string[];
  pad: { l: number; t: number; r: number; b: number };
}

export interface PushOptions {
  /** The drawn box of a card (measured card plus cover, divided by zoom); undefined falls back to node width and `heightOf`. */
  boxOf?: (id: string) => PushBox | undefined;
  heightOf?: (id: string) => number | undefined;
  decorations?: PushDecoration[];
  layout: { direction: string; gap?: number };
}

export interface PushResult {
  nodes: MapNode[];
  /** Cards that were moved, in no particular order. */
  pushed: Set<string>;
  /** The map's arrangement is whole-map only (radial, timeline, fishbone): nothing was moved, the caller re-lays out the whole map. */
  unsupported: boolean;
}

interface Rect {
  l: number;
  t: number;
  r: number;
  b: number;
}
interface Item {
  key: string;
  members: string[];
  rect: (offsets: Map<string, { dx: number; dy: number }>) => Rect;
}

const DEFAULT_HEIGHT = 180;
const cross = (a: Rect, b: Rect): boolean => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

/**
 * Pushes apart the cards that the freshly placed `movingIds` (with their brackets and frames) overlap. For each overlap the
 * sibling subtree that holds the fixed card and the siblings after it (the later of the two, along the sibling axis) move by
 * the overlap plus the gap; cards pushed that way are checked again. Edge to edge is not an overlap. Collapsed descendants
 * are neither obstacles nor moved, and every card outside the pushed subtrees keeps its x and y.
 */
export function pushAffected(nodes: MapNode[], movingIds: Iterable<string>, opts: PushOptions): PushResult {
  const mapDirection = opts.layout.direction;
  const gap = opts.layout.gap ?? LAYOUT_GAP;
  if (mapDirection === "radial" || mapDirection === "timeline" || mapDirection === "fishbone")
    return { nodes, pushed: new Set(), unsupported: true };

  const shown = visibleNodes(nodes);
  const shownIds = new Set(shown.map(node => node.id));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const kids = new Map<string, MapNode[]>();
  for (const node of shown) {
    const key = node.parentId && byId.has(node.parentId) ? node.parentId : "";
    kids.set(key, [...(kids.get(key) ?? []), node]);
  }
  const original = new Set([...movingIds].filter(id => shownIds.has(id)));
  const moving = new Set(original);
  const pushed = new Set<string>();
  const offsets = new Map<string, { dx: number; dy: number }>();

  const base = (id: string): PushBox => {
    const node = byId.get(id)!;
    return (
      opts.boxOf?.(id) ?? {
        x: node.x,
        y: node.y,
        w: node.width ?? CARD_WIDTH,
        h: opts.heightOf?.(id) ?? DEFAULT_HEIGHT
      }
    );
  };
  const boxRect = (id: string, moved: Map<string, { dx: number; dy: number }>): Rect => {
    const box = base(id);
    const off = moved.get(id);
    const l = box.x + (off?.dx ?? 0);
    const t = box.y + (off?.dy ?? 0);
    return { l, t, r: l + box.w, b: t + box.h };
  };

  const items: Item[] = shown.map(node => ({
    key: node.id,
    members: [node.id],
    rect: moved => boxRect(node.id, moved)
  }));
  (opts.decorations ?? []).forEach((decoration, index) => {
    const members = decoration.members.filter(id => shownIds.has(id));
    if (!members.length) return;
    items.push({
      key: `decoration:${index}`,
      members,
      rect: moved => {
        const rects = members.map(id => boxRect(id, moved));
        return {
          l: Math.min(...rects.map(r => r.l)) - decoration.pad.l,
          t: Math.min(...rects.map(r => r.t)) - decoration.pad.t,
          r: Math.max(...rects.map(r => r.r)) + decoration.pad.r,
          b: Math.max(...rects.map(r => r.b)) + decoration.pad.b
        };
      }
    });
  });
  const none = new Map<string, { dx: number; dy: number }>();
  const hasAny = (item: Item, set: Set<string>): boolean => item.members.some(id => set.has(id));
  const chain = (id: string): string[] => {
    const out = [id];
    for (let at = byId.get(id)?.parentId; at && byId.has(at) && !out.includes(at); at = byId.get(at)!.parentId)
      out.push(at);
    return out;
  };
  const subtree = (id: string, into: Set<string>): void => {
    into.add(id);
    for (const kid of kids.get(id) ?? []) subtree(kid.id, into);
  };

  const ignored = new Set<string>();
  const limit = nodes.length;
  for (let round = 0; round < limit; round++) {
    let resolved = false;
    search: for (const a of items) {
      if (!hasAny(a, moving)) continue;
      const ra = a.rect(offsets);
      for (const b of items) {
        if (b === a || a.members.some(id => b.members.includes(id))) continue;
        const pair = `${a.key}|${b.key}`;
        if (ignored.has(pair)) continue;
        if (!cross(ra, b.rect(offsets))) continue;
        if (!hasAny(a, original) && !hasAny(b, original) && cross(a.rect(none), b.rect(none))) continue;
        if (hasAny(a, original) && hasAny(b, original)) continue;
        const ma = a.members.find(id => moving.has(id)) ?? a.members[0];
        const mb = b.members[0];
        const chainA = chain(ma);
        const chainB = chain(mb);
        const common = chainA.find(id => chainB.includes(id));
        const lca = common && common !== ma && common !== mb ? common : undefined;
        const ca = lca ? chainA[chainA.indexOf(lca) - 1] : chainA[chainA.length - 1];
        const cb = lca ? chainB[chainB.indexOf(lca) - 1] : chainB[chainB.length - 1];
        if ((common && !lca) || ca === cb) {
          ignored.add(pair);
          continue;
        }
        const direction = lca ? layoutDirectionFor(nodes, lca, mapDirection) : mapDirection;
        const vertical = direction === "down" || direction === "up";
        const rectOf = (id: string) => boxRect(id, offsets);
        const coord = (id: string) => (vertical ? rectOf(id).l : rectOf(id).t);
        const rank = (id: string): [number, number, number] => [
          coord(id),
          original.has(id) ? 0 : 1,
          order.get(id) ?? 0
        ];
        const before = (x: string, y: string): boolean => {
          const rx = rank(x);
          const ry = rank(y);
          return rx[0] !== ry[0] ? rx[0] < ry[0] : rx[1] !== ry[1] ? rx[1] < ry[1] : rx[2] < ry[2];
        };
        const sideOf = (id: string): number => {
          const mid = (r: Rect) => (r.l + r.r) / 2;
          return !lca || mid(rectOf(id)) >= mid(rectOf(lca)) ? 1 : -1;
        };
        const balanced = direction === "balanced";
        if (balanced && sideOf(ca) !== sideOf(cb)) {
          ignored.add(pair);
          continue;
        }
        const aFirst = before(ca, cb);
        const lateChild = aFirst ? cb : ca;
        const early = aFirst ? ra : b.rect(offsets);
        const late = aFirst ? b.rect(offsets) : ra;
        const delta = vertical ? early.r - late.l + gap : early.b - late.t + gap;
        const group = new Set<string>();
        for (const sibling of lca ? (kids.get(lca) ?? []) : (kids.get("") ?? [])) {
          if (sibling.id !== lateChild && !before(lateChild, sibling.id)) continue;
          if (balanced && sideOf(sibling.id) !== sideOf(lateChild)) continue;
          subtree(sibling.id, group);
        }
        for (const id of group) {
          const off = offsets.get(id) ?? { dx: 0, dy: 0 };
          offsets.set(id, vertical ? { dx: off.dx + delta, dy: off.dy } : { dx: off.dx, dy: off.dy + delta });
          pushed.add(id);
          moving.add(id);
        }
        resolved = true;
        break search;
      }
    }
    if (!resolved) break;
  }

  if (!offsets.size) return { nodes, pushed, unsupported: false };
  return {
    nodes: nodes.map(node => {
      const off = offsets.get(node.id);
      return off ? { ...node, x: node.x + off.dx, y: node.y + off.dy } : node;
    }),
    pushed,
    unsupported: false
  };
}
