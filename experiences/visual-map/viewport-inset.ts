/**
 * Canvas inset: the floating `.vam-map-tools` toolbar covers the top of the canvas, so every programmatic viewport
 * (initial, Show all, focus on a card) reserves a top safe area instead of moving the toolbar. Pure math, no DOM.
 */
export interface MapViewport {
  x: number;
  y: number;
  zoom: number;
}

export const INSET_GAP = 8;
/** The viewport a new map is created with (map-model.ts); it is the only one the initial helper replaces. */
export const DEFAULT_VIEWPORT: Readonly<MapViewport> = { x: 40, y: 40, zoom: 1 };

/** Areas of the canvas that floating controls cover. A plain number means the top only (the toolbar). */
export interface CanvasInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
export type CanvasInset = number | CanvasInsets;
export function normalizeInset(inset: CanvasInset): CanvasInsets {
  return typeof inset === "number" ? { top: inset, right: 0, bottom: 0, left: 0 } : inset;
}

/** Bottom safe area: from the zoom bar's top edge to the canvas bottom, plus a gap. 0 when it is not laid out. */
export function bottomInsetFromRects(canvasBottom: number, barRect?: { top: number; bottom: number }): number {
  if (!barRect || !(barRect.bottom > barRect.top)) return 0;
  return Math.max(0, Math.ceil(canvasBottom - barRect.top)) + INSET_GAP;
}

/** Left safe area: an overlay panel's right edge measured from the canvas left. 0 when there is no overlay panel. */
export function leftInsetFromRects(canvasLeft: number, panelRect?: { left: number; right: number }): number {
  if (!panelRect || !(panelRect.right > panelRect.left)) return 0;
  return Math.max(0, Math.ceil(panelRect.right - canvasLeft));
}

/** Safe area height: the toolbar's bottom edge measured from the canvas top, plus a gap. 0 when it is not laid out. */
export function insetFromRects(canvasTop: number, toolsRect?: { top: number; bottom: number }): number {
  if (!toolsRect || !(toolsRect.bottom > toolsRect.top)) return 0;
  return Math.max(0, Math.ceil(toolsRect.bottom - canvasTop)) + INSET_GAP;
}

/** A never-moved default viewport is lifted below the toolbar; any viewport the user has set is left alone. */
export function initialViewport(viewport: MapViewport, inset: number): MapViewport {
  const pristine =
    viewport.x === DEFAULT_VIEWPORT.x && viewport.y === DEFAULT_VIEWPORT.y && viewport.zoom === DEFAULT_VIEWPORT.zoom;
  return pristine && inset > viewport.y ? { ...viewport, y: inset } : viewport;
}

/** Viewport that centres a card point in the area below the inset. */
export function focusViewport(
  viewport: MapViewport,
  point: { x: number; y: number },
  size: { width: number; height: number },
  inset: CanvasInset
): MapViewport {
  const zoom = viewport.zoom;
  const box = normalizeInset(inset);
  return {
    zoom,
    x: box.left + (size.width - box.left - box.right) / 2 - point.x * zoom,
    y: box.top + (size.height - box.top - box.bottom) / 2 - point.y * zoom
  };
}

/** The smallest zoom Show all will use; below it the text can no longer be read. */
export const FIT_MIN_ZOOM = 0.25;

/** True when the bounds need a zoom below the Show-all floor, so `fitViewport` cannot bring all of them on screen. */
export function fitIsClamped(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  size: { width: number; height: number },
  inset: CanvasInset
): boolean {
  const box = normalizeInset(inset);
  const availableWidth = Math.max(1, size.width - box.left - box.right);
  const availableHeight = Math.max(1, size.height - box.top - box.bottom);
  const w = bounds.maxX - bounds.minX,
    h = bounds.maxY - bounds.minY;
  return Math.min((availableWidth - 80) / w, (availableHeight - 80) / h) < FIT_MIN_ZOOM;
}

/**
 * True when some box would be (even partly) outside the real canvas after the viewport is applied. Judged against the
 * whole canvas, not the area left inside the toolbar insets: a card behind a floating toolbar is still on screen.
 */
export function anyBoxOffscreen(
  boxes: { x: number; y: number; w: number; h: number }[],
  viewport: MapViewport,
  size: { width: number; height: number }
): boolean {
  const eps = 1;
  return boxes.some(b => {
    const left = b.x * viewport.zoom + viewport.x,
      top = b.y * viewport.zoom + viewport.y;
    return (
      left < -eps ||
      top < -eps ||
      left + b.w * viewport.zoom > size.width + eps ||
      top + b.h * viewport.zoom > size.height + eps
    );
  });
}

/** Show-all viewport: the bounds are fitted and centred in the area left inside the inset. */
export function fitViewport(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  size: { width: number; height: number },
  inset: CanvasInset,
  maxZoom = 1.2
): MapViewport {
  const box = normalizeInset(inset);
  const availableWidth = Math.max(1, size.width - box.left - box.right);
  const availableHeight = Math.max(1, size.height - box.top - box.bottom);
  const w = bounds.maxX - bounds.minX,
    h = bounds.maxY - bounds.minY;
  const zoom = Math.max(FIT_MIN_ZOOM, Math.min(maxZoom, (availableWidth - 80) / w, (availableHeight - 80) / h));
  return {
    zoom,
    x: box.left + (availableWidth - w * zoom) / 2 - bounds.minX * zoom,
    y: box.top + (availableHeight - h * zoom) / 2 - bounds.minY * zoom
  };
}

/**
 * Which side a card's floating tool row hangs from. It is right-aligned to the card (`gap` in from the card's right
 * edge); when it is wider than the card that puts its left end under the chat window or past the canvas edge, so it hangs
 * from the card's left edge instead. All numbers are screen pixels.
 */
export function cardToolsSide(
  cardRight: number,
  toolsWidth: number,
  visibleLeft: number,
  gap: number
): "left" | "right" {
  return cardRight - gap - toolsWidth < visibleLeft ? "left" : "right";
}

/**
 * Where a card's floating tool row goes. Normally `cardToolsSide` decides left or right. A row wider than the visible
 * canvas (minus `margin` each side) cannot fit either way, so it wraps: `maxWidth` is the width it may take, and
 * `shift` moves its left-aligned start so the whole row lies inside the visible canvas. A row that fits keeps its place
 * (a left-aligned one is also kept off the right edge). All numbers are screen pixels; `shift` is 0 for a right-aligned row.
 */
export function cardToolsPlacement(
  card: { left: number; right: number },
  toolsWidth: number,
  visible: { left: number; right: number },
  gap: number,
  margin = 10
): { side: "left" | "right"; maxWidth: number | null; shift: number } {
  const available = visible.right - visible.left - 2 * margin;
  const wraps = toolsWidth > available;
  const side = wraps ? "left" : cardToolsSide(card.right, toolsWidth, visible.left, gap);
  if (side === "right") return { side, maxWidth: null, shift: 0 };
  const width = wraps ? available : toolsWidth;
  const start = card.left + gap;
  const placed = Math.max(visible.left + margin, Math.min(start, visible.right - margin - width));
  // Only a row that wraps or runs off the right edge is moved; one that already fits stays on the card.
  return {
    side,
    maxWidth: wraps ? available : null,
    shift: start >= visible.left + margin && start + width <= visible.right - margin ? 0 : placed - start
  };
}

/**
 * A saved viewport can put cards under the floating toolbar. `overlappingTops` are the screen tops (canvas coordinates)
 * of the cards that intersect the toolbar rectangle; the viewport moves down so the highest of them clears the inset,
 * by at most `inset` (a card far above the canvas must not throw the map away). No overlap returns the same viewport.
 */
export function clearToolbar(viewport: MapViewport, inset: number, overlappingTops: number[]): MapViewport {
  if (!overlappingTops.length || !(inset > 0)) return viewport;
  const shift = Math.min(inset, inset - Math.min(...overlappingTops));
  return shift > 0 ? { ...viewport, y: viewport.y + shift } : viewport;
}

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** True when the rectangles share area (touching edges do not count). */
export function rectsIntersect(a: ScreenRect, b: ScreenRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Every layer that floats over the canvas. One list for the stack layout's watch, for the rects cards avoid, and for the tests,
 * so a new layer is added in one place. The goal bar itself is not in it (it sits in the header row, not over the canvas):
 * `.vam-goal-attachment` is the suggestion list that hangs under it and `.vam-goal-actions` its icons, which
 * float under the goal on a narrow pane; `.vam-map-sources-panel` hangs from the tool group.
 */
export const FLOATING_LAYER_SELECTORS = [
  ".vam-map-tools",
  ".vam-goal-actions",
  ".vam-goal-attachment",
  ".vam-map-sources-panel",
  ".vam-zoom-controls",
  ".vam-canvas-hint"
] as const;

/** A card the user cannot fully see: outside the canvas, or under one of the floating controls (`covers`). */
export function isObscured(rect: ScreenRect, view: ScreenRect, covers: ScreenRect[]): boolean {
  if (rect.left < view.left || rect.right > view.right || rect.top < view.top || rect.bottom > view.bottom) return true;
  return covers.some(cover => rectsIntersect(rect, cover));
}

/**
 * Obsidian's status bar floats over the bottom-right of the window. When it sits over `target` (shares horizontal
 * range and starts above the target's bottom edge) this is how many pixels the target's bottom must rise to clear it;
 * no status bar, an empty one, or one beside the target gives 0.
 */
export function statusBarClearance(
  target: { left: number; right: number; bottom: number },
  status: { left: number; right: number; top: number; bottom: number } | null
): number {
  if (!status || !(status.right > status.left) || !(status.bottom > status.top)) return 0;
  if (status.left >= target.right || status.right <= target.left) return 0;
  return status.top < target.bottom ? Math.max(0, Math.ceil(target.bottom - status.top)) : 0;
}

export type CardToolsSide = "top" | "bottom" | "left" | "right";

export interface CardToolsSpot {
  side: CardToolsSide;
  /** Screen pixels the row reaches into its own card (top and bottom sides), on top of the usual edge overlap. */
  inset: number;
  /** Screen pixels the row slides sideways from its fitted place (top and bottom sides). */
  slide: number;
  /** The row's rectangle after `pan` is applied. */
  rect: ScreenRect;
  /** Screen area shared with other cards, before `pan` (panning moves every card alike, so it does not change). */
  overlap: number;
  /** How far the canvas must move so the row (and its card) clear the floating controls and the canvas edge. */
  pan: { dx: number; dy: number };
}

function overlapArea(a: ScreenRect, b: ScreenRect): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left),
    height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Where a selected card's tool row goes so it does not cover another card: above or below first (it may reach a little
 * into its own card, which is what clears a narrow gap), then beside. `row` is the row's horizontal extent as already
 * fitted for the top and bottom sides, `size` its size. A side that covers no other card, no floating control and lies
 * inside the canvas wins; otherwise the first side that covers no other card (the canvas then pans), otherwise the side
 * that covers the least. A row above or below may slide sideways but always keeps part of its width over its own card.
 * All numbers are screen pixels.
 */
export function chooseCardToolsSpot(input: {
  card: ScreenRect;
  row: { left: number; right: number };
  size: { width: number; height: number };
  others: ScreenRect[];
  controls: ScreenRect[];
  visible: ScreenRect;
  edge?: number;
  maxInset?: number;
}): CardToolsSpot {
  const { card, row, size, others, controls, visible } = input;
  const edge = input.edge ?? 6,
    maxInset = input.maxInset ?? 14,
    margin = 8;
  const candidates: Array<{ side: CardToolsSide; inset: number; slide: number; rect: ScreenRect }> = [];
  // The row may slide sideways (preferred spot first, then alternately left and right) to clear a neighbour.
  const slides = [0];
  for (let step = 8; step <= 120; step += 8) slides.push(-step, step);
  for (let inset = 0; inset <= maxInset; inset += 4) {
    for (const slide of slides) {
      const bottom = card.top + edge + inset;
      candidates.push({
        side: "top",
        inset,
        slide,
        rect: { left: row.left + slide, right: row.right + slide, top: bottom - size.height, bottom }
      });
    }
  }
  for (let inset = 0; inset <= maxInset; inset += 4) {
    for (const slide of slides) {
      const top = card.bottom - edge - inset;
      candidates.push({
        side: "bottom",
        inset,
        slide,
        rect: { left: row.left + slide, right: row.right + slide, top, bottom: top + size.height }
      });
    }
  }
  const sideTop = card.top + edge;
  candidates.push({
    side: "right",
    inset: 0,
    slide: 0,
    rect: { left: card.right + 4, right: card.right + 4 + size.width, top: sideTop, bottom: sideTop + size.height }
  });
  candidates.push({
    side: "left",
    inset: 0,
    slide: 0,
    rect: { left: card.left - 4 - size.width, right: card.left - 4, top: sideTop, bottom: sideTop + size.height }
  });
  // A row above or below that slid off its card leaves bare canvas between them, and the pointer loses the card on the way.
  const touch = Math.min(32, card.right - card.left, size.width);
  const attached = candidates.filter(
    candidate =>
      candidate.side === "left" ||
      candidate.side === "right" ||
      Math.min(candidate.rect.right, card.right) - Math.max(candidate.rect.left, card.left) >= touch
  );
  const scored = attached.map(candidate => ({
    ...candidate,
    overlap: others.reduce((total, other) => total + overlapArea(candidate.rect, other), 0),
    blocked:
      controls.some(control => rectsIntersect(candidate.rect, control)) ||
      candidate.rect.left < visible.left ||
      candidate.rect.right > visible.right ||
      candidate.rect.top < visible.top ||
      candidate.rect.bottom > visible.bottom
  }));
  const chosen =
    scored.find(item => item.overlap === 0 && !item.blocked) ??
    scored.find(item => item.overlap === 0) ??
    scored.reduce((best, item) => (item.overlap < best.overlap ? item : best));
  // Pan: first so the row is inside the canvas, then so the row and its card clear the floating controls.
  let dx = 0,
    dy = 0;
  const row2 = chosen.rect;
  if (row2.left < visible.left + margin) dx = visible.left + margin - row2.left;
  else if (row2.right > visible.right - margin) dx = visible.right - margin - row2.right;
  if (row2.top < visible.top + margin) dy = visible.top + margin - row2.top;
  else if (row2.bottom > visible.bottom - margin) dy = visible.bottom - margin - row2.bottom;
  const union = () => ({
    left: Math.min(card.left, row2.left) + dx,
    right: Math.max(card.right, row2.right) + dx,
    top: Math.min(card.top, row2.top) + dy,
    bottom: Math.max(card.bottom, row2.bottom) + dy
  });
  for (let round = 0; round < controls.length + 1; round++) {
    const box = union(),
      hit = controls.find(control => rectsIntersect(box, control));
    if (!hit) break;
    const down = hit.bottom + margin - box.top,
      right = hit.right + margin - box.left;
    const up = box.bottom - (hit.top - margin),
      left = box.right - (hit.left - margin);
    const downFits = box.bottom + down <= visible.bottom,
      rightFits = box.right + right <= visible.right,
      upFits = box.top - up >= visible.top,
      leftFits = box.left - left >= visible.left;
    if (downFits && (!rightFits || down <= right)) dy += down;
    else if (rightFits) dx += right;
    else if (upFits) dy -= up;
    else if (leftFits) dx -= left;
    // Nowhere clears it: stay under the control, still on the canvas, rather than pushing the card out of sight.
    else break;
  }
  return {
    side: chosen.side,
    inset: chosen.inset,
    slide: chosen.slide,
    overlap: chosen.overlap,
    rect: {
      left: row2.left + dx,
      right: row2.right + dx,
      top: row2.top + dy,
      bottom: row2.bottom + dy
    },
    pan: { dx, dy }
  };
}
