// The share viewer's copy of the map's topic-type shapes (experiences/visual-map/topic-kind-shape.ts binds to Obsidian's
// global helpers and cannot be bundled). A unit test runs both on the same inputs and compares the drawn shapes and the table.
// Everything read from a payload here is untrusted: only a whitelisted word ever becomes an attribute or a drawn shape.

export type ViewerKind = "action" | "atomic" | "hypothesis" | "evidence" | "conclusion";
export type ViewerShape = "rect" | "ellipse" | "diamond" | "folded" | "hexagon";

export const VIEWER_KINDS: readonly ViewerKind[] = ["action", "atomic", "hypothesis", "evidence", "conclusion"];
export const VIEWER_SHAPES: readonly ViewerShape[] = ["rect", "ellipse", "diamond", "folded", "hexagon"];

/** The shape of each type in the map (`topic` is the ordinary rounded card, which the file never names). */
export const TOPIC_KIND_SHAPES: Record<ViewerKind | "topic", string> = {
  topic: "rounded",
  action: "rect",
  atomic: "ellipse",
  hypothesis: "diamond",
  evidence: "folded",
  conclusion: "hexagon"
};

export const readViewerKind = (value: unknown): ViewerKind | undefined =>
  typeof value === "string" && (VIEWER_KINDS as readonly string[]).includes(value) ? (value as ViewerKind) : undefined;
export const readViewerShape = (value: unknown): ViewerShape | undefined =>
  typeof value === "string" && (VIEWER_SHAPES as readonly string[]).includes(value) ? (value as ViewerShape) : undefined;

const SVG_NS = "http://www.w3.org/2000/svg";
const EDGE = 0;
const FAR = 100;
const HEXAGON = `25,${EDGE} 75,${EDGE} ${FAR},50 75,${FAR} 25,${FAR} ${EDGE},50`;
const FOLD_X = 88;
const FOLD_Y = 24;
const FOLDED = `${EDGE},${EDGE} ${FOLD_X},${EDGE} ${FAR},${FOLD_Y} ${FAR},${FAR} ${EDGE},${FAR}`;
const FOLD_LINE = `${FOLD_X},${EDGE} ${FOLD_X},${FOLD_Y} ${FAR},${FOLD_Y}`;
const DIAMOND = `50,${EDGE} ${FAR},50 50,${FAR} ${EDGE},50`;

/** Whether a shape is drawn as an SVG behind the text (a rectangle is the card's own frame). */
export const hasSvgShape = (shape: ViewerShape): boolean => shape !== "rect";

/** Adds the shape behind a card's text and returns it; `rect` draws nothing. Same drawing as the map's `renderShapeBackground`. */
export function renderShapeBackground(doc: Document, card: HTMLElement, shape: ViewerShape): SVGElement | undefined {
  if (!hasSvgShape(shape)) return undefined;
  const make = (tag: string): SVGElement => doc.createElementNS(SVG_NS, tag);
  const svg = make("svg");
  svg.setAttribute("class", "vam-kind-shape");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const outline = make(shape === "ellipse" ? "ellipse" : "polygon");
  outline.setAttribute("class", "vam-kind-outline");
  if (shape === "ellipse") {
    outline.setAttribute("cx", "50");
    outline.setAttribute("cy", "50");
    outline.setAttribute("rx", "50");
    outline.setAttribute("ry", "50");
  } else outline.setAttribute("points", shape === "diamond" ? DIAMOND : shape === "hexagon" ? HEXAGON : FOLDED);
  outline.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(outline);
  if (shape === "folded") {
    const fold = make("polyline");
    fold.setAttribute("class", "vam-kind-fold");
    fold.setAttribute("points", FOLD_LINE);
    fold.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(fold);
  }
  card.appendChild(svg);
  return svg;
}

export type ShapeInsets = { top: number; right: number; bottom: number; left: number };

/** Where the text block sits in each SVG shape (share of the card), as in the map. */
const FIT: Record<Exclude<ViewerShape, "rect">, { width: number; height: number }> = {
  ellipse: { width: 0.7, height: 0.7 },
  diamond: { width: 0.5, height: 0.5 },
  hexagon: { width: 0.7, height: 0.58 },
  folded: { width: 0.88, height: 0.74 }
};
const SAFETY = 4;
const BASE_PADDING: ShapeInsets = { top: 12, right: 14, bottom: 14, left: 14 };

/** The padding that puts a text block of `content` height inside the shape's safe area (the map's `shapeInsets`). */
export function shapeInsets(shape: ViewerShape, content: { width: number; height: number }): ShapeInsets {
  if (shape === "rect") return { ...BASE_PADDING };
  const fit = FIT[shape];
  const side = (content.width * (1 - fit.width)) / 2;
  const vertical = (content.height * (1 / fit.height - 1)) / 2 + SAFETY;
  return { top: vertical, right: side, bottom: vertical, left: side };
}

/** Sets the padding of a card whose shape is an SVG from the text's measured height (the map's `fitKindShapePadding`). */
export function fitShapePadding(card: HTMLElement, shape: ViewerShape): void {
  if (!hasSvgShape(shape)) return;
  const width = card.offsetWidth;
  if (!width) return;
  const fixedHeight = card.style.height;
  if (fixedHeight) card.style.removeProperty("height");
  try {
    const sides = shapeInsets(shape, { width, height: 0 });
    card.style.padding = `0 ${sides.right}px 0 ${sides.left}px`;
    const insets = shapeInsets(shape, { width, height: card.clientHeight });
    card.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
  } finally {
    if (fixedHeight) card.style.height = fixedHeight;
  }
}
