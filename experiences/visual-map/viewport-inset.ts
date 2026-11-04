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
