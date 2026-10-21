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
  inset: number
): MapViewport {
  const zoom = viewport.zoom;
  return {
    zoom,
    x: size.width / 2 - point.x * zoom,
    y: inset + (size.height - inset) / 2 - point.y * zoom
  };
}

/** Show-all viewport: the bounds are fitted and centred in the area below the inset. */
export function fitViewport(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  size: { width: number; height: number },
  inset: number,
  maxZoom = 1.2
): MapViewport {
  const availableHeight = Math.max(1, size.height - inset);
  const w = bounds.maxX - bounds.minX,
    h = bounds.maxY - bounds.minY;
  const zoom = Math.max(0.25, Math.min(maxZoom, (size.width - 80) / w, (availableHeight - 80) / h));
  return {
    zoom,
    x: (size.width - w * zoom) / 2 - bounds.minX * zoom,
    y: inset + (availableHeight - h * zoom) / 2 - bounds.minY * zoom
  };
}
