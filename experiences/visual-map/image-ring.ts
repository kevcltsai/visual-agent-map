/**
 * The ring of topic cards around an annotated image: pure geometry, no DOM, view or obsidian.
 * Cards sit in slots around a clearance rectangle R (the picture plus a margin); each card is joined to its anchor by a
 * straight line from the anchor to the middle of the card's picture-facing edge. Anchors are matched to slots with the
 * shortest total line length, which gives the guarantees `ringViolations` checks: every line has both ends inside the
 * convex R while all cards lie outside it (no line through a card), and a shortest matching has no crossings.
 * Slot shape is made by `ringSlotsAt` alone, so another shape only has to replace that function.
 */
import { CARD_WIDTH } from "../../map-graph";
import { DEFAULT_CARD_HEIGHT, LAYOUT_GAP } from "../../map-layout";
import { isAnnotatedImage, type CanvasItem } from "./canvas-items";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type RingSide = "top" | "bottom" | "left" | "right";
/** A place for one card: `ax`,`ay` is the middle of the card's picture-facing edge (on the boundary of R). */
export interface RingSlot {
  side: RingSide;
  ax: number;
  ay: number;
}
/** What a card needs to be placed: the anchor it hangs on (0-1 of the picture) and its size (height defaults to a card's default). */
export interface RingCardInput {
  id: string;
  anchorX: number;
  anchorY: number;
  w?: number;
  h?: number;
}
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface RingPlacement extends Rect {
  id: string;
  side: RingSide;
  line: Segment;
}
export interface RingLayout {
  /** The clearance rectangle R the slots were made around. */
  clearance: Rect;
  cards: RingPlacement[];
}
/** A card as it stands now (possibly dragged by hand), for checks and for adding one more. */
export interface RingCardState extends Rect {
  id: string;
  anchorX: number;
  anchorY: number;
}
export interface RingViolation {
  code: "overlap" | "overlap-other" | "line-through-card" | "card-on-image" | "crossing" | "count" | "pairing";
  ids: string[];
}
export interface RingMember {
  imageId: string;
  topicId: string;
  anchorId: string;
  /** Anchor position, 0-1 of the picture. */
  x: number;
  y: number;
}

/** Longest side a picture gets when it first becomes a ring centre. */
export const RING_IMAGE_SIDE = 720;
/** Space kept free around the picture, and the step R grows by when the slots run out. */
export const RING_MARGIN = 64;
export const RING_GROW = 40;
/** Distance kept between neighbouring cards and from a ring to other things. */
export const RING_GAP = LAYOUT_GAP;
export const RING_OBSTACLE_GAP = 80;
const EPS = 1e-6;

const cardW = (c: { w?: number }): number => (c.w !== undefined && c.w > 0 ? c.w : CARD_WIDTH);
const cardH = (c: { h?: number }): number => (c.h !== undefined && c.h > 0 ? c.h : DEFAULT_CARD_HEIGHT);

// --- membership ---------------------------------------------------------------------------------------------------

/**
 * Ring members across all annotated images, in image order then relation order. A member is a topic that exists, has no
 * parent and is joined to an anchor of the image by a relation with `ring: true`; a topic belongs to the first image
 * that claims it and to the first relation of that image; an anchor without a 2D position cannot hold a card.
 */
export function ringMembers(
  items: readonly CanvasItem[],
  nodes: readonly { id: string; parentId: string | null }[]
): RingMember[] {
  const free = new Set(nodes.filter(n => n.parentId == null).map(n => n.id));
  const claimed = new Set<string>();
  const out: RingMember[] = [];
  for (const item of items) {
    if (!isAnnotatedImage(item)) continue;
    const anchors = new Map(item.anchors.map(a => [a.id, a]));
    for (const r of item.relations ?? []) {
      if (r.ring !== true) continue;
      const anchorId = anchors.has(r.from) ? r.from : r.to;
      const topicId = anchorId === r.from ? r.to : r.from;
      const at = anchors.get(anchorId)?.at;
      if (!at || at.kind !== "image-2d" || anchors.has(topicId) || !free.has(topicId) || claimed.has(topicId)) continue;
      claimed.add(topicId);
      out.push({ imageId: item.id, topicId, anchorId, x: at.x as number, y: at.y as number });
    }
  }
  return out;
}

// --- picture size -------------------------------------------------------------------------------------------------

/** The picture made at least {@link RING_IMAGE_SIDE} on its longer side, scaled about its centre; a bigger picture is returned as is. */
export function ringImageSize(image: Rect): Rect {
  const longest = Math.max(image.w, image.h);
  if (!(longest > 0) || longest >= RING_IMAGE_SIDE) return { ...image };
  const k = RING_IMAGE_SIDE / longest;
  const w = image.w * k;
  const h = image.h * k;
  return { x: image.x + (image.w - w) / 2, y: image.y + (image.h - h) / 2, w, h };
}

// --- slots --------------------------------------------------------------------------------------------------------

const expand = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });

/** The slot shape for one clearance rectangle: a row above, a row below, a column left and a column right, all spaced for cards of `cell` size. */
export function ringSlotsAt(clearance: Rect, cell: { w: number; h: number }): RingSlot[] {
  const { x: L, y: T } = clearance;
  const Rr = L + clearance.w;
  const B = T + clearance.h;
  const out: RingSlot[] = [];
  const perRow = Math.floor(clearance.w / (cell.w + RING_GAP)) + 1;
  const rowSpan = (perRow - 1) * (cell.w + RING_GAP);
  for (const [side, ay] of [
    ["top", T],
    ["bottom", B]
  ] as const)
    for (let i = 0; i < perRow; i++) out.push({ side, ax: (L + Rr) / 2 - rowSpan / 2 + i * (cell.w + RING_GAP), ay });
  // Columns keep a gap from the rows so a corner never has two cards touching.
  const perColumn = Math.max(0, Math.floor((clearance.h - 2 * RING_GAP + RING_GAP) / (cell.h + RING_GAP)));
  const columnSpan = (perColumn - 1) * (cell.h + RING_GAP);
  for (const [side, ax] of [
    ["left", L],
    ["right", Rr]
  ] as const)
    for (let i = 0; i < perColumn; i++)
      out.push({ side, ax, ay: (T + B) / 2 - columnSpan / 2 + i * (cell.h + RING_GAP) });
  return out;
}

/**
 * At least `count` slots around the picture, growing R by {@link RING_GROW} until they fit. `margin` is where R starts.
 * With `fixedLines` (lines of cards that stay where they are) a slot whose card would touch one of them is left out, so R
 * grows until `count` usable slots remain.
 */
export function ringSlots(
  image: Rect,
  count: number,
  cell: { w: number; h: number },
  margin: number = RING_MARGIN,
  fixedLines: readonly Segment[] = []
): { slots: RingSlot[]; clearance: Rect } {
  for (let m = margin; ; m += RING_GROW) {
    const clearance = expand(image, m);
    let slots = ringSlotsAt(clearance, cell);
    if (fixedLines.length)
      slots = slots.filter(slot => {
        const rect = ringCardRect(slot, cell.w, cell.h);
        return !fixedLines.some(line => segmentHitsRect(line, rect));
      });
    if (slots.length >= count) return { slots, clearance };
  }
}

/** Where a card of size `w`×`h` sits in a slot: flush with R on its inner edge, centred on the slot. */
export function ringCardRect(slot: RingSlot, w: number, h: number): Rect {
  switch (slot.side) {
    case "top":
      return { x: slot.ax - w / 2, y: slot.ay - h, w, h };
    case "bottom":
      return { x: slot.ax - w / 2, y: slot.ay, w, h };
    case "left":
      return { x: slot.ax - w, y: slot.ay - h / 2, w, h };
    case "right":
      return { x: slot.ax, y: slot.ay - h / 2, w, h };
  }
}

// --- geometry -----------------------------------------------------------------------------------------------------

const intersects = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Which way a card lies from the picture (the outward direction), by how far its centre is outside the picture on each axis; a tie counts as vertical. */
export function ringSide(image: Rect, card: Rect): RingSide {
  const cx = card.x + card.w / 2;
  const cy = card.y + card.h / 2;
  const ox = Math.max(image.x - cx, cx - (image.x + image.w), 0);
  const oy = Math.max(image.y - cy, cy - (image.y + image.h), 0);
  if (ox > oy) return cx < image.x + image.w / 2 ? "left" : "right";
  return cy < image.y + image.h / 2 ? "top" : "bottom";
}

/** The line of a card: from its anchor on the picture to the middle of the card's edge that faces the picture. */
export function ringLine(image: Rect, anchorX: number, anchorY: number, card: Rect): Segment {
  const side = ringSide(image, card);
  const end =
    side === "top"
      ? [card.x + card.w / 2, card.y + card.h]
      : side === "bottom"
        ? [card.x + card.w / 2, card.y]
        : side === "left"
          ? [card.x + card.w, card.y + card.h / 2]
          : [card.x, card.y + card.h / 2];
  return { x1: image.x + anchorX * image.w, y1: image.y + anchorY * image.h, x2: end[0], y2: end[1] };
}

/** Whether a segment touches a rectangle (borders included), by clipping the segment to it. */
function segmentHitsRect(s: Segment, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  for (const [p, q] of [
    [-dx, s.x1 - r.x],
    [dx, r.x + r.w - s.x1],
    [-dy, s.y1 - r.y],
    [dy, r.y + r.h - s.y1]
  ] as const) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return t0 <= t1;
}

const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number =>
  (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/** Proper crossing: the segments pass through each other. Shared endpoints and touching do not count. */
function segmentsCross(a: Segment, b: Segment): boolean {
  const d1 = orient(a.x1, a.y1, a.x2, a.y2, b.x1, b.y1);
  const d2 = orient(a.x1, a.y1, a.x2, a.y2, b.x2, b.y2);
  const d3 = orient(b.x1, b.y1, b.x2, b.y2, a.x1, a.y1);
  const d4 = orient(b.x1, b.y1, b.x2, b.y2, a.x2, a.y2);
  return d1 * d2 < -EPS && d3 * d4 < -EPS;
}

const lengthOf = (s: Segment): number => Math.hypot(s.x2 - s.x1, s.y2 - s.y1);

/**
 * What is wrong with a ring as it stands (empty when fine): cards overlap each other (or `others`), a line passes through
 * another card, a card sits on the picture, two lines cross, the card count differs from `memberCount`, or swapping the
 * anchors of two cards would give a shorter total. The same function guards production and tests.
 */
export function ringViolations(
  image: Rect,
  cards: readonly RingCardState[],
  options: { memberCount?: number; others?: readonly Rect[]; fixedLines?: readonly Segment[] } = {}
): RingViolation[] {
  const out: RingViolation[] = [];
  const lines = cards.map(c => ringLine(image, c.anchorX, c.anchorY, c));
  if (
    (options.memberCount !== undefined && options.memberCount !== cards.length) ||
    new Set(cards.map(c => c.id)).size !== cards.length
  )
    out.push({ code: "count", ids: [] });
  for (let i = 0; i < cards.length; i++) {
    const a = cards[i];
    if (intersects(a, image)) out.push({ code: "card-on-image", ids: [a.id] });
    for (const o of options.others ?? []) if (intersects(a, o)) out.push({ code: "overlap-other", ids: [a.id] });
    // Lines of cards that stay where they are: neither a card nor a ring line may meet them.
    for (const fixed of options.fixedLines ?? []) {
      if (segmentHitsRect(fixed, a)) out.push({ code: "line-through-card", ids: [a.id] });
      if (segmentsCross(lines[i], fixed)) out.push({ code: "crossing", ids: [a.id] });
    }
    for (let j = 0; j < cards.length; j++) {
      if (j === i) continue;
      const b = cards[j];
      if (j > i && intersects(a, b)) out.push({ code: "overlap", ids: [a.id, b.id] });
      if (segmentHitsRect(lines[i], b)) out.push({ code: "line-through-card", ids: [a.id, b.id] });
      if (j > i && segmentsCross(lines[i], lines[j])) out.push({ code: "crossing", ids: [a.id, b.id] });
      if (j > i) {
        const swapped =
          lengthOf(ringLine(image, a.anchorX, a.anchorY, b)) + lengthOf(ringLine(image, b.anchorX, b.anchorY, a));
        if (swapped < lengthOf(lines[i]) + lengthOf(lines[j]) - 1e-6) out.push({ code: "pairing", ids: [a.id, b.id] });
      }
    }
  }
  return out;
}

// --- matching -----------------------------------------------------------------------------------------------------

/** Minimum-cost assignment of every row to a different column (rows ≤ columns): the Hungarian method, scanning in index order so ties resolve the same way every time. */
function assign(cost: readonly (readonly number[])[]): number[] {
  const n = cost.length;
  const m = n ? cost[0].length : 0;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] = u[p[j]] + delta;
          v[j] = v[j] - delta;
        } else minv[j] = minv[j] - delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0);
  }
  const rows = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) rows[p[j] - 1] = j - 1;
  return rows;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Weight of one crossing with a fixed line against one crossing between two ring lines (a fixed line is the worse one). */
const FIXED_CROSSING_WEIGHT = 1000;
/** Most moves one descent of `uncross` makes. */
const UNCROSS_MAX_MOVES = 40;
/** Most nodes the depth-first search of `uncross` visits per ring size. */
const UNCROSS_MAX_NODES = 1000;

/**
 * Crossings of a placement: `fixed` is the number of ring lines that cross a fixed line, `ring` the number of pairs of
 * ring lines that cross each other.
 */
const lineBetween = (p: readonly [number, number] | readonly number[], s: RingSlot): Segment => ({
  x1: p[0],
  y1: p[1],
  x2: s.ax,
  y2: s.ay
});

function countCrossings(
  points: readonly (readonly [number, number])[],
  slots: readonly RingSlot[],
  fixedLines: readonly Segment[],
  picked: readonly number[]
): { fixed: number; ring: number } {
  let fixed = 0;
  let ring = 0;
  const lines = picked.map((j, i): Segment => ({
    x1: points[i][0],
    y1: points[i][1],
    x2: slots[j].ax,
    y2: slots[j].ay
  }));
  for (let a = 0; a < lines.length; a++) {
    for (const f of fixedLines) if (segmentsCross(lines[a], f)) fixed++;
    for (let b = a + 1; b < lines.length; b++) if (segmentsCross(lines[a], lines[b])) ring++;
  }
  return { fixed, ring };
}

/**
 * A fixed line can make the cheapest matching cross two ring lines. Over the same slots, when the matching has a crossing:
 * 1. A depth-first search for a placement with none (every line clear of the fixed lines and of the other lines), the card
 *    with the fewest usable slots first and the nearest slot first, within a fixed number of search nodes.
 * 2. A descent from the placement found (or from the matching when there is none): the best move of one card to another
 *    slot (a swap with that slot's card when it is taken, else a move to the free slot) that lowers the crossings
 *    (fixed-line crossings weigh worst) and then the total line length, repeated until no move helps. From a placement
 *    without crossings it only shortens the lines.
 * Everything is tried in index order, so the same input gives the same result. Edits `picked`.
 */
function uncross(
  points: readonly (readonly [number, number])[],
  slots: readonly RingSlot[],
  fixedLines: readonly Segment[],
  picked: number[]
): void {
  const n = picked.length;
  const count = slots.length;
  const lines = points.map(p => slots.map(s => lineBetween(p, s)));
  const length = points.map((p, i) => slots.map((_, j) => Math.hypot(lines[i][j].x2 - p[0], lines[i][j].y2 - p[1])));
  const hitsFixed = lines.map(row => row.map(l => fixedLines.filter(f => segmentsCross(l, f)).length));
  // 0 = not computed yet, 1 = the two lines do not cross, 2 = they cross.
  const cache = new Uint8Array(n * count * n * count);
  const crossing = (a: number, sa: number, b: number, sb: number): boolean => {
    const key = ((a * count + sa) * n + b) * count + sb;
    if (!cache[key]) {
      const value = segmentsCross(lines[a][sa], lines[b][sb]) ? 2 : 1;
      cache[key] = value;
      cache[((b * count + sb) * n + a) * count + sa] = value;
    }
    return cache[key] === 2;
  };
  // Cost of card a's line in the current placement against the fixed lines and the lines of the cards but `skip`.
  const cardCost = (a: number, skip: number): number => {
    let c = hitsFixed[a][picked[a]] * FIXED_CROSSING_WEIGHT;
    for (let b = 0; b < n; b++) if (b !== a && b !== skip && crossing(a, picked[a], b, picked[b])) c++;
    return c;
  };
  const descend = (): void => {
    const owner = new Map<number, number>();
    picked.forEach((j, i) => owner.set(j, i));
    for (let move = 0; move < UNCROSS_MAX_MOVES; move++) {
      let bestCross = 0;
      let bestLength = -1e-9;
      let bestA = -1;
      let bestSlot = -1;
      for (let a = 0; a < n; a++) {
        const from = picked[a];
        for (let to = 0; to < count; to++) {
          if (to === from) continue;
          const b = owner.get(to) ?? -1;
          const before = cardCost(a, -1) + (b >= 0 ? cardCost(b, a) : 0);
          picked[a] = to;
          if (b >= 0) picked[b] = from;
          const after = cardCost(a, -1) + (b >= 0 ? cardCost(b, a) : 0);
          picked[a] = from;
          if (b >= 0) picked[b] = to;
          const dCross = after - before;
          const dLength =
            length[a][to] + (b >= 0 ? length[b][from] : 0) - length[a][from] - (b >= 0 ? length[b][to] : 0);
          if (dCross < bestCross || (dCross === bestCross && dLength < bestLength)) {
            bestCross = dCross;
            bestLength = dLength;
            bestA = a;
            bestSlot = to;
          }
        }
      }
      if (bestA < 0) return;
      const from = picked[bestA];
      const b = owner.get(bestSlot) ?? -1;
      picked[bestA] = bestSlot;
      owner.set(bestSlot, bestA);
      if (b >= 0) {
        picked[b] = from;
        owner.set(from, b);
      } else owner.delete(from);
    }
  };
  const crossings = (): number => {
    let c = 0;
    for (let a = 0; a < n; a++) {
      c += hitsFixed[a][picked[a]] * FIXED_CROSSING_WEIGHT;
      for (let b = a + 1; b < n; b++) if (crossing(a, picked[a], b, picked[b])) c++;
    }
    return c;
  };
  if (crossings() === 0) return;
  // Depth-first search with forward checking.
  let nodes = 0;
  const found = new Array<number>(n).fill(-1);
  const search = (domains: number[][], left: number): boolean => {
    if (!left) return true;
    if (++nodes > UNCROSS_MAX_NODES) return false;
    let a = -1;
    for (let i = 0; i < n; i++) if (found[i] < 0 && (a < 0 || domains[i].length < domains[a].length)) a = i;
    for (const slot of [...domains[a]].sort((x, y) => length[a][x] - length[a][y] || x - y)) {
      const next: number[][] = domains.map((domain, i) =>
        found[i] >= 0 || i === a ? domain : domain.filter(s => s !== slot && !crossing(a, slot, i, s))
      );
      if (next.every((domain, i) => found[i] >= 0 || i === a || domain.length)) {
        found[a] = slot;
        if (search(next, left - 1)) return true;
        found[a] = -1;
      }
      if (nodes > UNCROSS_MAX_NODES) return false;
    }
    return false;
  };
  const domains = lines.map((row, i) => row.map((_, j) => j).filter(j => hitsFixed[i][j] === 0));
  if (domains.every(domain => domain.length) && search(domains, n)) for (let i = 0; i < n; i++) picked[i] = found[i];
  descend();
}

/** How many steps larger than the first fitting R the ring may grow to get away from a crossing with a fixed line. */
const CROSSING_GROW_STEPS = 20;

/**
 * Places every card in the ring: the smallest R whose slots fit them, anchors matched to slots by shortest total line. Same
 * input, same output. `fixedLines` are the lines of cards that stay where they are (anchor to card): no slot whose card
 * would touch one is used, and when the shortest matching has a line crossing a fixed line or another line, `uncross`
 * searches for a placement without, and R grows a few steps when it finds none. The result with the fewest crossings
 * (a crossing with a fixed line is worse), at the smallest R among equals, is kept.
 */
export function solveRing(
  image: Rect,
  members: readonly RingCardInput[],
  fixedLines: readonly Segment[] = []
): RingLayout {
  const cell = {
    w: members.reduce((m, c) => Math.max(m, cardW(c)), 0) || CARD_WIDTH,
    h: members.reduce((m, c) => Math.max(m, cardH(c)), 0) || DEFAULT_CARD_HEIGHT
  };
  const points = members.map(
    c => [image.x + clamp01(c.anchorX) * image.w, image.y + clamp01(c.anchorY) * image.h] as const
  );
  let { slots, clearance } = ringSlots(image, members.length, cell, RING_MARGIN, fixedLines);
  let best: { slots: RingSlot[]; clearance: Rect; picked: number[]; score: number } | null = null;
  for (let step = 0; ; step++) {
    const cost = points.map(p => slots.map(s => Math.hypot(p[0] - s.ax, p[1] - s.ay)));
    if (!fixedLines.length) {
      best = { slots, clearance, picked: assign(cost), score: 0 };
      break;
    }
    const picked = assign(cost);
    uncross(points, slots, fixedLines, picked);
    const found = countCrossings(points, slots, fixedLines, picked);
    const score = found.fixed * FIXED_CROSSING_WEIGHT + found.ring;
    if (!best || score < best.score) best = { slots, clearance, picked, score };
    if (best.score === 0 || step >= CROSSING_GROW_STEPS) break;
    ({ slots, clearance } = ringSlots(image, members.length, cell, image.x - clearance.x + RING_GROW, fixedLines));
  }
  ({ slots, clearance } = best);
  const picked = best.picked;
  const cards = members.map((c, i): RingPlacement => {
    const slot = slots[picked[i]];
    const rect = ringCardRect(slot, cardW(c), cardH(c));
    return {
      id: c.id,
      ...rect,
      side: slot.side,
      line: { x1: points[i][0], y1: points[i][1], x2: slot.ax, y2: slot.ay }
    };
  });
  return { clearance, cards };
}

/**
 * Where one more card can go without moving anything: the free slot (around R as it is, and a few steps larger) with the
 * shortest line for which the whole ring still has no violation and no `others` is covered; null when there is none and
 * the ring has to be solved again.
 */
export function placeNewMember(
  image: Rect,
  current: readonly RingCardState[],
  member: RingCardInput,
  others: readonly Rect[] = [],
  fixedLines: readonly Segment[] = []
): RingPlacement | null {
  const w = cardW(member);
  const h = cardH(member);
  const px = image.x + clamp01(member.anchorX) * image.w;
  const py = image.y + clamp01(member.anchorY) * image.h;
  let best: RingPlacement | null = null;
  let bestLength = Infinity;
  for (let k = 0; k <= 4; k++) {
    for (const slot of ringSlotsAt(expand(image, RING_MARGIN + k * RING_GROW), { w, h })) {
      const rect = ringCardRect(slot, w, h);
      const length = Math.hypot(px - slot.ax, py - slot.ay);
      if (length >= bestLength) continue;
      if (others.some(o => intersects(rect, o))) continue;
      const state: RingCardState = {
        id: member.id,
        ...rect,
        anchorX: clamp01(member.anchorX),
        anchorY: clamp01(member.anchorY)
      };
      // Next to fixed lines a card may have to take a slot that is not its shortest, so `pairing` does not count there.
      const bad = ringViolations(image, [...current, state], { others, fixedLines }).filter(
        v => !fixedLines.length || v.code !== "pairing"
      );
      if (bad.length) continue;
      best = { id: member.id, ...rect, side: slot.side, line: { x1: px, y1: py, x2: slot.ax, y2: slot.ay } };
      bestLength = length;
    }
  }
  return best;
}

// --- moving -------------------------------------------------------------------------------------------------------

/** The smallest bounding box of the picture and its cards. */
export function ringBounds(image: Rect, cards: readonly Rect[]): Rect {
  let x0 = image.x;
  let y0 = image.y;
  let x1 = image.x + image.w;
  let y1 = image.y + image.h;
  for (const c of cards) {
    x0 = Math.min(x0, c.x);
    y0 = Math.min(y0, c.y);
    x1 = Math.max(x1, c.x + c.w);
    y1 = Math.max(y1, c.y + c.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The shift that takes `footprint` off every obstacle: none when it is already clear, otherwise the smallest of the
 * positions that rest {@link RING_OBSTACLE_GAP} beside an obstacle or just outside all of them together. Earlier
 * candidates win ties, so the result does not change between runs.
 */
export function findFreeOffset(
  footprint: Rect,
  obstacles: readonly Rect[],
  gap: number = RING_OBSTACLE_GAP
): { dx: number; dy: number } {
  const hits = (dx: number, dy: number): boolean =>
    obstacles.some(o => intersects({ x: footprint.x + dx, y: footprint.y + dy, w: footprint.w, h: footprint.h }, o));
  if (!hits(0, 0)) return { dx: 0, dy: 0 };
  const candidates: { dx: number; dy: number }[] = [];
  const around = (box: Rect, g: number): void => {
    candidates.push(
      { dx: box.x - g - footprint.w - footprint.x, dy: 0 },
      { dx: box.x + box.w + g - footprint.x, dy: 0 },
      { dx: 0, dy: box.y - g - footprint.h - footprint.y },
      { dx: 0, dy: box.y + box.h + g - footprint.y }
    );
  };
  for (const o of obstacles) around(o, gap);
  around(ringBounds(obstacles[0], obstacles), gap);
  let best: { dx: number; dy: number } | null = null;
  let bestCost = Infinity;
  for (const c of candidates) {
    const cost = Math.hypot(c.dx, c.dy);
    if (cost < bestCost && !hits(c.dx, c.dy)) {
      best = c;
      bestCost = cost;
    }
  }
  return best ?? { dx: 0, dy: 0 };
}

/** The whole ring (picture and cards) shifted by `dx`,`dy`. */
export function moveRing(
  image: Rect,
  cards: readonly RingPlacement[],
  dx: number,
  dy: number
): { image: Rect; cards: RingPlacement[] } {
  return {
    image: { ...image, x: image.x + dx, y: image.y + dy },
    cards: cards.map(c => ({
      ...c,
      x: c.x + dx,
      y: c.y + dy,
      line: { x1: c.line.x1 + dx, y1: c.line.y1 + dy, x2: c.line.x2 + dx, y2: c.line.y2 + dy }
    }))
  };
}
