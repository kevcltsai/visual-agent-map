// The cover picture of a card in the share viewer: the same elements, classes and geometry as the map card
// (experiences/visual-map/view.ts paintCoverFrame, cover-layout.ts), written with classList because Obsidian's
// `addClass`/`createDiv` do not exist on a plain page.
import { coverDisplay, coverFrameRatio, coverWindow } from "../../visual-map/cover-layout";
import type { ViewerCover, ViewerCoverFrame, ViewerCoverPosition } from "./image-data";
import { createViewerElement, type ElementFactory } from "./dom";

export interface CoverParts {
  frame: HTMLElement;
  windowEl: HTMLElement | null;
  img: HTMLImageElement;
}

/** Gives the box its share of the content width; beside the text the width is always set (it is the picture column). */
function sizeBox(frame: HTMLElement, size: number, side: boolean): void {
  const { width } = coverDisplay(1, size);
  frame.classList.toggle("is-resized", width < 1 && !side);
  if (width >= 1 && !side) frame.style.removeProperty("width");
  else frame.style.setProperty("width", `${width * 100}%`);
}

/** Lays a picture of this shape (width over height) into its box; same inline percentages as `placeCoverFrame` in cover-layout.ts. */
export function placeCover(parts: CoverParts, shape: number, mask: ViewerCoverFrame | null): void {
  const win = coverWindow(shape, 1, mask, 1);
  if (!win) return;
  parts.frame.style.setProperty("aspect-ratio", String(coverFrameRatio(shape, 1, mask)));
  parts.frame.classList.add("is-sized");
  if (!mask || !parts.windowEl) return;
  const style = parts.windowEl.style;
  style.setProperty("left", `${win.left * 100}%`);
  style.setProperty("width", `${win.width * 100}%`);
  style.setProperty("aspect-ratio", String(win.width / win.height));
  const img = parts.img.style;
  img.setProperty("width", `${100 / mask.w}%`);
  img.setProperty("height", `${100 / mask.h}%`);
  img.setProperty("left", `${(-mask.x / mask.w) * 100}%`);
  img.setProperty("top", `${(-mask.y / mask.h) * 100}%`);
}

/**
 * One cover box. `shapes` remembers a picture's width over height by its asset name, so a card drawn again is sized at once;
 * `onSized` runs when the real shape arrives, `onFailed` when the picture cannot be decoded.
 */
export function buildCover(
  doc: ElementFactory,
  cover: ViewerCover,
  shapes: Map<string, number>,
  onSized: () => void,
  onFailed: () => void
): HTMLElement {
  const side = cover.position === "left" || cover.position === "right";
  const frame = createViewerElement(doc, "div", "vam-card-cover");
  const windowEl = cover.frame ? createViewerElement(doc, "div", "vam-card-cover-window") : null;
  if (windowEl) frame.append(windowEl);
  if (cover.frame) frame.classList.add("is-framed");
  sizeBox(frame, cover.size, side);
  const img = createViewerElement(doc, "img");
  img.alt = "";
  img.draggable = false;
  img.decoding = "async";
  (windowEl ?? frame).append(img);
  const parts: CoverParts = { frame, windowEl, img };
  const known = shapes.get(cover.asset);
  if (known) placeCover(parts, known, cover.frame);
  img.addEventListener("error", onFailed);
  img.addEventListener("load", () => {
    const shape = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 0;
    if (!shape || !coverFrameRatio(img.naturalWidth, img.naturalHeight) || frame.classList.contains("is-sized")) return;
    shapes.set(cover.asset, shape);
    placeCover(parts, shape, cover.frame);
    onSized();
  });
  img.src = cover.src;
  return frame;
}

/**
 * Puts the cover where its position says in a card that has a title (and maybe a summary), as `arrangeCover` does in the map:
 * top before the title, bottom after the summary, left and right in a `.vam-card-side` row with the text beside the picture.
 */
export function placeCardCover(
  doc: ElementFactory,
  card: HTMLElement,
  frame: HTMLElement,
  position: ViewerCoverPosition,
  title: HTMLElement,
  summary: HTMLElement | null
): void {
  if (position === "top") {
    card.insertBefore(frame, title);
    return;
  }
  card.classList.add(`has-cover-${position}`);
  if (position === "bottom") {
    (summary ?? title).after(frame);
    return;
  }
  const row = createViewerElement(doc, "div", "vam-card-side");
  const text = createViewerElement(doc, "div", "vam-card-side-text");
  card.insertBefore(row, title);
  text.append(title);
  if (summary) text.append(summary);
  row.append(frame, text);
}

/** Takes a cover back out of a card (its picture could not be decoded): the card is as if it had none. */
export function removeCardCover(card: HTMLElement, frame: HTMLElement): void {
  frame.remove();
  const row = Array.from(card.children).find(child => child.classList.contains("vam-card-side"));
  if (row) {
    const text = Array.from(row.children).find(child => child.classList.contains("vam-card-side-text"));
    for (const child of Array.from(text?.children ?? [])) row.before(child);
    row.remove();
  }
  card.classList.remove("has-cover-bottom", "has-cover-left", "has-cover-right");
}
