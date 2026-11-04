/**
 * Where a card's cover picture and its mask window sit (card editor). Shared by the map card, the "Edit card" dialog and
 * the export, so all three show the same thing. The math is pure; `placeCoverFrame` only writes inline styles.
 *
 * Display rule: the whole picture is shown D wide (D = k × the card's content width, k = `topic-cover-size`, 0.3-1;
 * a smaller picture is centred in the content). A mask `x y w h` (fractions of the
 * picture) is a window `w·D` wide and `h·D·(picture height / picture width)` tall, placed `x·D` from the content's left
 * edge, that shows exactly that region at that scale (no stretching). Hiding the left or right side therefore leaves the
 * rest where it was; hiding the top or bottom makes the window, and the card, shorter. The window always starts at the
 * top of the cover.
 */
import type { CoverFrame } from "./card-cover";

/** A cover is at most this many times as tall as D. */
export const COVER_MAX_HEIGHT_RATIO = 1.5;

export interface CoverWindow {
  /** The window's left edge, from the left of the D-wide cover box. */
  left: number;
  width: number;
  height: number;
  /** 1, or less when the height cap scales the window down. The picture is then shown `scale·D` wide. */
  scale: number;
}

const WHOLE: CoverFrame = { x: 0, y: 0, w: 1, h: 1 };

/**
 * The mask window for a picture of `pictureWidth` x `pictureHeight` shown `displayWidth` (D) wide; null for a picture
 * that cannot be measured. Same unit as `displayWidth` (pass 1 for fractions of D).
 *
 * Height cap: a window taller than COVER_MAX_HEIGHT_RATIO·D is scaled down whole (region and picture together, never
 * stretched) to exactly that height and stays centred on where its unscaled middle was. For the whole picture this is
 * the familiar letterbox: a very tall picture is shown 1.5·D tall and centred with space at the sides.
 */
export function coverWindow(
  pictureWidth: number,
  pictureHeight: number,
  frame: CoverFrame | null | undefined,
  displayWidth: number
): CoverWindow | null {
  if (!(pictureWidth > 0 && pictureHeight > 0 && Number.isFinite(pictureWidth) && Number.isFinite(pictureHeight)))
    return null;
  if (!(displayWidth > 0 && Number.isFinite(displayWidth))) return null;
  const mask = frame ?? WHOLE;
  const tall = pictureHeight / pictureWidth;
  const natural = mask.h * displayWidth * tall;
  const cap = COVER_MAX_HEIGHT_RATIO * displayWidth;
  const scale = natural > cap ? cap / natural : 1;
  const unscaledWidth = mask.w * displayWidth;
  return {
    left: mask.x * displayWidth + (unscaledWidth * (1 - scale)) / 2,
    width: unscaledWidth * scale,
    height: natural * scale,
    scale
  };
}

/**
 * Width over height of the cover box: D wide, as tall as the window (whole picture: the picture's shape, held at
 * 1 / COVER_MAX_HEIGHT_RATIO). Null when the picture cannot be measured.
 */
export function coverFrameRatio(width: number, height: number, frame?: CoverFrame | null): number | null {
  if (!coverWindow(width, height, frame, 1)) return null;
  // Computed from the picture's own numbers (not 1 / window height) so a plain shape stays exact.
  return Math.max(width / (height * (frame?.h ?? 1)), 1 / COVER_MAX_HEIGHT_RATIO);
}

/**
 * D for a card whose content is `contentWidth` wide and a picture size `size` (k), and where the D-wide cover box starts
 * (centred in the content). The size never changes which region a mask shows: it only scales D.
 */
export function coverDisplay(contentWidth: number, size: number): { left: number; width: number } {
  const k = Number.isFinite(size) ? Math.min(1, Math.max(0.3, size)) : 1;
  const width = contentWidth * k;
  return { left: (contentWidth - width) / 2, width };
}

/** Gives the cover box its share of the content width (k), centred by `.is-resized`; the default leaves the full width. */
export function sizeCoverBox(frame: HTMLElement, size: number): void {
  const { width } = coverDisplay(1, size);
  frame.toggleClass("is-resized", width < 1);
  if (width >= 1) frame.style.removeProperty("width");
  else frame.style.setProperty("width", `${width * 100}%`);
}

export interface CoverParts {
  frame: HTMLElement;
  window: HTMLElement | null;
  img: HTMLImageElement;
}

/**
 * Lays a picture (width over height = `shape`) into its cover box. Whole picture: the box takes the picture's shape and
 * CSS contains the picture. With a mask: the box is D wide and as tall as the window; the window gets its place and
 * shape (left and width as percentages of D, height from its own aspect-ratio) and the picture is sized and shifted
 * inside it so only the region shows. Inline percentages, no CSS variables. Returns the window, or null.
 */
export function placeCoverFrame(parts: CoverParts, shape: number, mask: CoverFrame | null): CoverWindow | null {
  const win = coverWindow(shape, 1, mask, 1);
  if (!win) return null;
  parts.frame.style.setProperty("aspect-ratio", String(coverFrameRatio(shape, 1, mask)));
  parts.frame.addClass("is-sized");
  if (!mask || !parts.window) return win;
  const style = parts.window.style;
  style.setProperty("left", `${win.left * 100}%`);
  style.setProperty("width", `${win.width * 100}%`);
  // Height follows the width, not the box: a card clipped short cuts the window from its bottom like any other content.
  style.setProperty("aspect-ratio", String(win.width / win.height));
  const img = parts.img.style;
  img.setProperty("width", `${100 / mask.w}%`);
  img.setProperty("height", `${100 / mask.h}%`);
  img.setProperty("left", `${(-mask.x / mask.w) * 100}%`);
  img.setProperty("top", `${(-mask.y / mask.h) * 100}%`);
  return win;
}
