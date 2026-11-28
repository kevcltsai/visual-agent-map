import { LAYOUT_GAP } from "../map-layout";
import { CARD_WIDTH, visibleNodes, type MapNode } from "../map-graph";
import { layoutDirectionFor } from "./compose";

/** A card's drawn box in canvas units, as an offset from the node's own x and y (so it never goes stale when the node moves). */
export interface PushBox {
  dx: number;
  dy: number;
  w: number;
  h: number;
}

/** A bracket or frame drawn around `members`; `pad` is how far it sticks out of their union. */
export interface PushDecoration {
  members: string[];
  pad: { l: number; t: number; r: number; b: number };
}

export interface PushOptions {
  /** The drawn box of a card relative to its node (measured card plus cover, divided by zoom); undefined falls back to node width and `heightOf`. */
  boxOf?: (id: string) => PushBox | undefined;
  heightOf?: (id: string) => number | undefined;
  decorations?: PushDecoration[];
  /** Cards (text blocks, ring members) that are obstacles only: they and what hangs under them are never moved. */
  fixed?: ReadonlySet<string>;
  layout: { direction: string; gap?: number };
  /**
   * The moving cards grew or were revealed where they stand (not freshly placed): two of them that overlap are pushed apart in
   * sibling order (the later one with its later siblings), and one that grew over its own child pushes that child's subtree on.
   */
  settleMoving?: boolean;
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
        dx: 0,
        dy: 0,
        w: node.width ?? CARD_WIDTH,
        h: opts.heightOf?.(id) ?? DEFAULT_HEIGHT
      }
    );
  };
  const boxRect = (id: string, moved: Map<string, { dx: number; dy: number }>): Rect => {
    const box = base(id);
    const node = byId.get(id)!;
    const off = moved.get(id);
    const l = node.x + box.dx + (off?.dx ?? 0);
    const t = node.y + box.dy + (off?.dy ?? 0);
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
  let blocked = false;
  const subtree = (id: string, into: Set<string>): void => {
    if (opts.fixed?.has(id)) blocked = true;
    into.add(id);
    for (const kid of kids.get(id) ?? []) subtree(kid.id, into);
  };

  const ignored = new Set<string>();
  const limit = nodes.length;
  const itemsOf = new Map<string, Item[]>();
  for (const item of items) for (const id of item.members) itemsOf.set(id, [...(itemsOf.get(id) ?? []), item]);
  // Rects are computed once and dropped only for the items a push moved: a pass over n cards stays cheap.
  const rects = new Map<Item, Rect>();
  const rectOfItem = (item: Item): Rect => {
    let r = rects.get(item);
    if (!r) {
      r = item.rect(offsets);
      rects.set(item, r);
    }
    return r;
  };
  // The items sorted by top edge, so the ones that can touch a rect are found without reading all of them; rebuilt after a push.
  let byTop: { item: Item; index: number; r: Rect }[] | null = null;
  let tallest = 0;
  const near = (ra: Rect): Item[] => {
    if (!byTop) {
      byTop = items.map((item, index) => ({ item, index, r: rectOfItem(item) })).sort((x, y) => x.r.t - y.r.t);
      tallest = byTop.reduce((most, entry) => Math.max(most, entry.r.b - entry.r.t), 0);
    }
    let lo = 0;
    let hi = byTop.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (byTop[mid].r.t < ra.t - tallest) lo = mid + 1;
      else hi = mid;
    }
    const found: { item: Item; index: number }[] = [];
    for (let at = lo; at < byTop.length && byTop[at].r.t < ra.b; at++)
      if (cross(ra, byTop[at].r)) found.push(byTop[at]);
    return found.sort((x, y) => x.index - y.index).map(entry => entry.item);
  };
  const underFixed = (item: Item): boolean => item.members.some(id => chain(id).some(up => opts.fixed?.has(up)));
  let applied = 0;
  const shove = (group: Set<string>, delta: number, vertical: boolean): void => {
    for (const id of group) {
      const off = offsets.get(id) ?? { dx: 0, dy: 0 };
      offsets.set(id, vertical ? { dx: off.dx + delta, dy: off.dy } : { dx: off.dx, dy: off.dy + delta });
      for (const item of itemsOf.get(id) ?? []) rects.delete(item);
    }
    byTop = null;
    applied++;
  };
  let again = true;
  while (again && applied < limit) {
    again = false;
    for (const a of items) {
      let rescan = true;
      while (rescan && applied < limit) {
        rescan = false;
        if (!hasAny(a, moving)) break;
        const ra = rectOfItem(a);
        for (const b of near(ra)) {
          if (b === a) continue;
          const rb = rectOfItem(b);
          if (a.members.some(id => b.members.includes(id))) continue;
          const pair = `${a.key}|${b.key}`;
          if (ignored.has(pair)) continue;
          if (!hasAny(a, original) && !hasAny(b, original) && cross(a.rect(none), b.rect(none))) continue;
          if (!opts.settleMoving && hasAny(a, original) && hasAny(b, original)) continue;
          const ma = a.members.find(id => moving.has(id)) ?? a.members[0];
          const mb = b.members[0];
          const chainA = chain(ma);
          const chainB = chain(mb);
          const common = chainA.find(id => chainB.includes(id));
          const lca = common && common !== ma && common !== mb ? common : undefined;
          const ca = lca ? chainA[chainA.indexOf(lca) - 1] : chainA[chainA.length - 1];
          const cb = lca ? chainB[chainB.indexOf(lca) - 1] : chainB[chainB.length - 1];
          if (common && !lca && opts.settleMoving) {
            // A moving card over its own descendant: the child's sibling row goes on along the depth of the parent's layout.
            const ancIsA = common === ma;
            const down = ancIsA ? chainB : chainA;
            const child = down[down.indexOf(common) - 1];
            const way = layoutDirectionFor(nodes, common, mapDirection);
            const ancRect = ancIsA ? ra : rb;
            const descRect = ancIsA ? rb : ra;
            const along = way === "right" || way === "left";
            const delta =
              way === "down"
                ? ancRect.b - descRect.t + gap
                : way === "up"
                  ? -(descRect.b - ancRect.t + gap)
                  : way === "right"
                    ? ancRect.r - descRect.l + gap
                    : way === "left"
                      ? -(descRect.r - ancRect.l + gap)
                      : 0;
            const axis = (id: string) => (along ? boxRect(id, offsets).t : boxRect(id, offsets).l);
            const row = new Set<string>();
            blocked = false;
            for (const sibling of kids.get(common) ?? []) {
              if (sibling.id !== child) {
                const x = axis(sibling.id);
                const y = axis(child);
                if (x < y || (x === y && (order.get(sibling.id) ?? 0) < (order.get(child) ?? 0))) continue;
              }
              subtree(sibling.id, row);
            }
            if (!delta || blocked || !child) {
              ignored.add(pair);
              continue;
            }
            shove(row, delta, along);
            for (const id of row) {
              pushed.add(id);
              moving.add(id);
            }
            rescan = true;
            break;
          }
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
          const groupFrom = (first: string): Set<string> => {
            const out = new Set<string>();
            for (const sibling of lca ? (kids.get(lca) ?? []) : (kids.get("") ?? [])) {
              if (sibling.id !== first && !before(first, sibling.id)) continue;
              if (balanced && sideOf(sibling.id) !== sideOf(first)) continue;
              if (!opts.settleMoving && sibling.id !== first && original.has(sibling.id)) continue;
              subtree(sibling.id, out);
            }
            return out;
          };
          const aFirst = before(ca, cb);
          const lateChild = aFirst ? cb : ca;
          const early = aFirst ? ra : rb;
          const late = aFirst ? rb : ra;
          const delta = vertical ? early.r - late.l + gap : early.b - late.t + gap;
          blocked = false;
          const group = groupFrom(lateChild);
          if (blocked) {
            const aIsNew = hasAny(a, original);
            if (aIsNew || hasAny(b, original)) {
              // A text block or ring member would have to move: the new cards step past it instead.
              const moverRect = aIsNew ? ra : rb;
              const otherRect = aIsNew ? rb : ra;
              const step = vertical ? otherRect.r - moverRect.l + gap : otherRect.b - moverRect.t + gap;
              const mine = new Set<string>();
              blocked = false;
              subtree(aIsNew ? ca : cb, mine);
              const own = new Set([...mine].filter(id => original.has(id)));
              if (!own.size) {
                ignored.add(pair);
                continue;
              }
              shove(own, step, vertical);
              for (const id of own) pushed.add(id);
              rescan = true;
              break;
            }
            // An old card meets a fixed obstacle: its sibling group (it and the siblings after it) goes past the obstacle.
            const aFixed = underFixed(a);
            if (aFixed === underFixed(b)) {
              ignored.add(pair);
              continue;
            }
            const obstacle = aFixed ? ra : rb;
            const mover = aFixed ? rb : ra;
            const mm = aFixed ? b.members[0] : (a.members.find(id => moving.has(id)) ?? a.members[0]);
            const up = byId.get(mm)?.parentId;
            const parent = up && byId.has(up) ? up : undefined;
            const way = parent ? layoutDirectionFor(nodes, parent, mapDirection) : mapDirection;
            const down = way === "down" || way === "up";
            const axis = (id: string) => (down ? boxRect(id, offsets).l : boxRect(id, offsets).t);
            const mid = (id: string) => (boxRect(id, offsets).l + boxRect(id, offsets).r) / 2;
            const moved = new Set<string>();
            for (const sibling of kids.get(parent ?? "") ?? []) {
              if (opts.fixed?.has(sibling.id) || (sibling.id !== mm && original.has(sibling.id))) continue;
              if (sibling.id !== mm) {
                const x = axis(sibling.id);
                const y = axis(mm);
                if (x < y || (x === y && (order.get(sibling.id) ?? 0) < (order.get(mm) ?? 0))) continue;
                if (way === "balanced" && parent && mid(sibling.id) >= mid(parent) !== mid(mm) >= mid(parent)) continue;
              }
              subtree(sibling.id, moved);
            }
            blocked = false;
            for (const id of moved) if (opts.fixed?.has(id)) blocked = true;
            if (blocked || !moved.size) {
              ignored.add(pair);
              continue;
            }
            shove(moved, down ? obstacle.r - mover.l + gap : obstacle.b - mover.t + gap, down);
            for (const id of moved) {
              pushed.add(id);
              moving.add(id);
            }
            rescan = true;
            break;
          }
          shove(group, delta, vertical);
          for (const id of group) {
            pushed.add(id);
            moving.add(id);
          }
          rescan = true;
          break;
        }
        if (rescan) again = true;
      }
    }
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
