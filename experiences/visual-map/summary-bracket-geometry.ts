// Summary brackets (decisions #2, #4): where a curly brace goes around a run of sibling subtrees. Pure geometry — the view
// measures the cards it draws and passes their rectangles in; nothing here reads the map or the DOM, and it does not
// import canvas-items.

export interface BracketRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** The side of the framed subtrees the brace stands on (and the text beyond it). */
export type BracketSide = "right" | "left" | "down" | "up";
export type BracketRefusal = "unsupported" | "cross-side" | "empty";
export interface BracketGeometry {
  side: BracketSide;
  /** SVG path data of the brace, in stage coordinates. */
  path: string;
  /** Where the text starts: the tip of the brace pushed out by a small gap. Which edge of the text sits on it depends on `side`. */
  label: { x: number; y: number };
  /** The framed area (the union of the rectangles). */
  extent: BracketRect;
}
export type BracketResult = ({ ok: true } & BracketGeometry) | { ok: false; reason: BracketRefusal };

/** Gap between the subtrees and the brace, how far the brace stands out, and the gap between the tip and the text. */
export const BRACKET_GAP = 14;
export const BRACKET_DEPTH = 12;
export const BRACKET_LABEL_GAP = 8;

/** Radial, timeline and fishbone have no plain subtree edge to follow (Later, decision #4). */
export const BRACKET_UNSUPPORTED_LAYOUTS: readonly string[] = ["radial", "timeline", "fishbone"];
export function bracketSupported(direction: string): boolean {
  return ["right", "left", "down", "up", "balanced"].includes(direction);
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const round = (n: number): number => Math.round(n * 100) / 100;

/** The union of the rectangles; null when none is usable. */
export function unionRects(rects: readonly BracketRect[]): BracketRect | null {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const r of rects) {
    if (!r || !finite(r.x) || !finite(r.y) || !finite(r.w) || !finite(r.h)) continue;
    left = Math.min(left, r.x);
    top = Math.min(top, r.y);
    right = Math.max(right, r.x + r.w);
    bottom = Math.max(bottom, r.y + r.h);
  }
  return left === Infinity ? null : { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * The brace for one run. `memberRects` are the rectangles of the range's cards and everything shown under them (the
 * subtrees' outer edge decides where the brace stands); `parentRect` is the parent card, used only by a balanced map to tell
 * which half the run is in. A balanced run spread over both halves is refused.
 */
export function bracketGeometry(
  direction: string,
  memberRects: readonly BracketRect[],
  parentRect: BracketRect | null,
  rangeRects: readonly BracketRect[] = memberRects
): BracketResult {
  if (!bracketSupported(direction)) return { ok: false, reason: "unsupported" };
  const extent = unionRects(memberRects);
  if (!extent) return { ok: false, reason: "empty" };
  let side: BracketSide;
  if (direction === "balanced") {
    const middle = parentRect && finite(parentRect.x) && finite(parentRect.w) ? parentRect.x + parentRect.w / 2 : null;
    if (middle === null) return { ok: false, reason: "empty" };
    const halves = new Set(rangeRects.map(r => (r.x + r.w / 2 < middle ? "left" : "right")));
    if (halves.size !== 1) return { ok: false, reason: "cross-side" };
    side = halves.has("left") ? "left" : "right";
  } else side = direction as BracketSide;
  return { ok: true, ...shape(side, extent) };
}

function shape(side: BracketSide, e: BracketRect): BracketGeometry {
  const d = BRACKET_DEPTH;
  // Work along a "run" axis (u, the side of the framed area the brace runs along) and an "out" axis (v, away from it).
  const horizontalRun = side === "down" || side === "up";
  const u1 = horizontalRun ? e.x : e.y,
    u2 = horizontalRun ? e.x + e.w : e.y + e.h;
  const base =
    side === "right"
      ? e.x + e.w + BRACKET_GAP
      : side === "left"
        ? e.x - BRACKET_GAP
        : side === "down"
          ? e.y + e.h + BRACKET_GAP
          : e.y - BRACKET_GAP;
  const sign = side === "right" || side === "down" ? 1 : -1;
  const mid = (u1 + u2) / 2;
  const r = Math.min(d, Math.max(0, (u2 - u1) / 4));
  const at = (u: number, v: number): string => (horizontalRun ? `${round(u)} ${round(v)}` : `${round(v)} ${round(u)}`);
  const v0 = base,
    v1 = base + sign * d,
    v2 = base + sign * 2 * d;
  const path = [
    `M ${at(u1, v0)}`,
    `Q ${at(u1, v1)} ${at(u1 + r, v1)}`,
    `L ${at(mid - r, v1)}`,
    `Q ${at(mid, v1)} ${at(mid, v2)}`,
    `Q ${at(mid, v1)} ${at(mid + r, v1)}`,
    `L ${at(u2 - r, v1)}`,
    `Q ${at(u2, v1)} ${at(u2, v0)}`
  ].join(" ");
  const tip = v2 + sign * BRACKET_LABEL_GAP;
  return {
    side,
    path,
    label: horizontalRun ? { x: round(mid), y: round(tip) } : { x: round(tip), y: round(mid) },
    extent: e
  };
}

/** The box the text covers once the side's CSS transform is applied (fit counts it, so narrow maps do not clip it). */
export function summaryTextBox(side: BracketSide, label: { x: number; y: number }, w: number, h: number): BracketRect {
  if (side === "left") return { x: label.x - w, y: label.y - h / 2, w, h };
  if (side === "down") return { x: label.x - w / 2, y: label.y, w, h };
  if (side === "up") return { x: label.x - w / 2, y: label.y - h, w, h };
  return { x: label.x, y: label.y - h / 2, w, h };
}

/** How far the text may be pushed out at most: three card widths. */
export const BRACKET_TEXT_MAX_PUSH = 3 * 280;

/**
 * Where the text goes once cards that are not part of the run are taken into account (decision: the layout never makes
 * room for a bracket, so the text steps out instead). The text moves along the outward axis of `side` until its box
 * (`size`, as `summaryTextBox` places it) no longer meets any obstacle, at most `maxPush`; if it still meets one there it stays
 * at that last position. With no collision the label comes back unchanged.
 */
export function avoidBracketObstacles(
  side: BracketSide,
  label: { x: number; y: number },
  size: { w: number; h: number },
  obstacles: readonly BracketRect[],
  maxPush: number = BRACKET_TEXT_MAX_PUSH
): { x: number; y: number } {
  const outward = side === "right" || side === "down" ? 1 : -1;
  const horizontal = side === "right" || side === "left";
  let pushed = 0;
  for (let pass = 0; pass <= obstacles.length; pass++) {
    const at = horizontal
      ? { x: label.x + outward * pushed, y: label.y }
      : { x: label.x, y: label.y + outward * pushed };
    const box = summaryTextBox(side, at, size.w, size.h);
    let step = 0;
    for (const o of obstacles) {
      if (![o.x, o.y, o.w, o.h].every(finite)) continue;
      if (!(box.x < o.x + o.w && o.x < box.x + box.w && box.y < o.y + o.h && o.y < box.y + box.h)) continue;
      // How far the box must move outward to sit just past this obstacle.
      const need = horizontal
        ? side === "right"
          ? o.x + o.w + BRACKET_LABEL_GAP - box.x
          : box.x + box.w - (o.x - BRACKET_LABEL_GAP)
        : side === "down"
          ? o.y + o.h + BRACKET_LABEL_GAP - box.y
          : box.y + box.h - (o.y - BRACKET_LABEL_GAP);
      step = Math.max(step, need);
    }
    if (step <= 0) break;
    pushed = Math.min(maxPush, pushed + step);
    if (pushed >= maxPush) break;
  }
  return pushed === 0
    ? label
    : horizontal
      ? { x: round(label.x + outward * pushed), y: label.y }
      : { x: label.x, y: round(label.y + outward * pushed) };
}
