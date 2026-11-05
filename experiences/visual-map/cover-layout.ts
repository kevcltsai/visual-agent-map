/**
 * Where a card's cover picture and its mask window sit (card editor). Shared by the map card, the "Edit card" dialog and
 * the export, so all three show the same thing. The math is pure; `placeCoverFrame` only writes inline styles.
 *
 * Positions (`topic-cover-position`): top (default), bottom (under the summary), left or right (a picture column D
 * wide beside the text; see coverCardLayout and arrangeCover).
 *
 * Display rule: the whole picture is shown D wide (D = k × the card's content width, k = `topic-cover-size`, 0.3-1;
 * a smaller picture is centred in the content). A mask `x y w h` (fractions of the
 * picture) is a window `w·D` wide and `h·D·(picture height / picture width)` tall, placed `x·D` from the content's left
 * edge, that shows exactly that region at that scale (no stretching). Hiding the left or right side therefore leaves the
 * rest where it was; hiding the top or bottom makes the window, and the card, shorter. The window always starts at the
 * top of the cover.
 */
import type { CoverFrame, CoverPosition } from "./card-cover";

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

/**
 * Gives the cover box its share of the content width (k). On top or bottom `.is-resized` centres it and the default
 * leaves the full width; beside the text (`side`) the width is always set, since it is the picture column.
 */
export function sizeCoverBox(frame: HTMLElement, size: number, side = false): void {
  const { width } = coverDisplay(1, size);
  frame.toggleClass("is-resized", width < 1 && !side);
  if (width >= 1 && !side) frame.style.removeProperty("width");
  else frame.style.setProperty("width", `${width * 100}%`);
}

/** The gap between the picture column and the text column of a side layout, in px (the stylesheet's `.vam-card-side`). */
export const COVER_SIDE_GAP = 10;

/**
 * The geometry of a card for each picture position, from its content width, the picture size (k), the picture's cover
 * height for D = k × content (see coverWindow) and the text's height at a given text width. Pure; the map draws the same
 * with CSS (`arrangeCover`), so this states the rule and is what the tests check.
 * - top / bottom: picture D wide and centred, text the full content width, height = picture + text (+ the cover margin).
 * - left / right: the picture column is D wide, the text uses the rest (content - D - gap); height = the taller of the two.
 */
export function coverCardLayout(
  position: CoverPosition,
  contentWidth: number,
  size: number,
  pictureHeight: (displayWidth: number) => number,
  textHeight: (textWidth: number) => number,
  coverMargin = 8
): {
  picture: { x: number; y: number; width: number; height: number };
  text: { x: number; y: number; width: number; height: number };
  height: number;
} {
  const display = coverDisplay(contentWidth, size);
  const D = display.width;
  const ph = pictureHeight(D);
  if (position === "left" || position === "right") {
    const textWidth = Math.max(0, contentWidth - D - COVER_SIDE_GAP);
    const th = textHeight(textWidth);
    const pictureX = position === "left" ? 0 : contentWidth - D;
    const textX = position === "left" ? D + COVER_SIDE_GAP : 0;
    return {
      picture: { x: pictureX, y: coverMargin, width: D, height: ph },
      text: { x: textX, y: coverMargin, width: textWidth, height: th },
      height: coverMargin + Math.max(ph, th)
    };
  }
  const th = textHeight(contentWidth);
  const picture = { x: display.left, width: D, height: ph };
  return position === "bottom"
    ? {
        picture: { ...picture, y: th + coverMargin },
        text: { x: 0, y: 0, width: contentWidth, height: th },
        height: th + coverMargin + ph
      }
    : {
        picture: { ...picture, y: coverMargin },
        text: { x: 0, y: coverMargin + ph, width: contentWidth, height: th },
        height: coverMargin + ph + th
      };
}

/** Card children that stay outside the side layout's text column: they are drawn over or around the card, not in it. */
const SIDE_OUTSIDE = [
  "vam-add-child",
  "vam-card-resize",
  "vam-card-resize-y",
  "vam-card-frame-width",
  "vam-card-fade",
  "vam-card-more"
];
/** What ends a card's text, first match wins: the summary, the open summary field, the add-summary line. */
const SUMMARY_ANCHORS = ["vam-card-summary", "vam-card-summary-input", "vam-card-summary-add"];
/** Siblings that belong to the field just before them while a title or summary is being edited. */
const FIELD_ADJUNCTS = ["vam-card-title-input", "vam-sr-only"];
const POSITION_CLASSES = ["has-cover-bottom", "has-cover-left", "has-cover-right"];

// Only classList and children are read, so lighter stand-in elements (and cards without a cover) are left alone.
const hasCls = (el: Element | null | undefined, cls: string): boolean => el?.classList?.contains?.(cls) ?? false;
const childWith = (parent: HTMLElement, cls: string): HTMLElement | null =>
  (Array.from(parent.children ?? []) as HTMLElement[]).find(child => hasCls(child, cls)) ?? null;

/**
 * Puts the cover box where the position says, and undoes an earlier side layout first, so it is safe to call again
 * (after a repaint of the cover, a summary that appears, or a position change). Without a title yet (the card is still
 * being built) the cover is simply added at the end; the card's builder calls this again when it is complete.
 * - top: before the title (today's layout). bottom: after the summary (or the title).
 * - left / right: a `.vam-card-side` row takes the cover's place, holding the cover and a `.vam-card-side-text` column
 *   with the title, the summary and everything after them that is part of the card's flow.
 * Short (fixed-height) cards: top and bottom keep the usual clip order (summary, then cover, then title). In a side layout
 * the whole row is cut at the card's bottom edge (styles.css `.is-clipped > .vam-card-side`), so each column is cut from
 * its own bottom: the picture from below, and in the text column the summary before the title.
 */
export function arrangeCover(card: HTMLElement, frame: HTMLElement | null, position: CoverPosition): void {
  const row = childWith(card, "vam-card-side");
  if (row) {
    const text = childWith(row, "vam-card-side-text");
    for (const child of Array.from(text?.children ?? []) as HTMLElement[]) {
      child.remove();
      card.insertBefore(child, row);
    }
    row.remove();
  }
  for (const cls of POSITION_CLASSES) if (hasCls(card, cls)) card.classList.remove(cls);
  if (!frame) return;
  frame.remove();
  const title = childWith(card, "vam-card-title");
  if (!title) {
    card.appendChild(frame);
    return;
  }
  if (position === "top") {
    card.insertBefore(frame, title);
    return;
  }
  card.addClass(`has-cover-${position}`);
  if (position === "bottom") {
    // The summary text, its edit field, or the faint add-summary line (a card with none) is the text's end.
    const after = SUMMARY_ANCHORS.map(cls => childWith(card, cls)).find((el): el is HTMLElement => !!el) ?? title;
    const kids = Array.from(card.children);
    let index = kids.indexOf(after);
    // An open title or summary field brings its hint line; the picture goes below them, not between field and hint.
    while (kids[index + 1] && FIELD_ADJUNCTS.some(cls => hasCls(kids[index + 1], cls))) index++;
    card.insertBefore(frame, kids[index + 1] ?? null);
    return;
  }
  const side = card.createDiv({ cls: "vam-card-side" });
  side.remove();
  card.insertBefore(side, title);
  side.appendChild(frame);
  const text = side.createDiv({ cls: "vam-card-side-text" });
  const kids = Array.from(card.children) as HTMLElement[];
  for (const child of kids.slice(kids.indexOf(side) + 1)) {
    if (SIDE_OUTSIDE.some(cls => hasCls(child, cls))) continue;
    child.remove();
    text.appendChild(child);
  }
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
