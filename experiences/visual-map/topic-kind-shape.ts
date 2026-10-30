import type { TranslationKey } from "../../i18n";
import type { TopicKind } from "../../note-values";

/**
 * How each topic type looks. This table is the only place that knows a type's shape: a new type is one more row (and a
 * geometry entry for a new SVG shape), not a new condition in the renderer.
 * - `rounded` / `rect` are plain CSS rounded rectangles (the card's own frame; `rounded` is the unchanged 12px card).
 * - `ellipse` / `diamond` / `folded` / `hexagon` are drawn as an SVG behind the text, and the card's own frame is hidden.
 */
export type TopicShape = "rounded" | "rect" | "ellipse" | "diamond" | "folded" | "hexagon";

export const TOPIC_KIND_SHAPES: Record<TopicKind, { shape: TopicShape; labelKey: TranslationKey }> = {
  topic: { shape: "rounded", labelKey: "ui.topic_kind_topic" },
  action: { shape: "rect", labelKey: "ui.topic_kind_action" },
  atomic: { shape: "ellipse", labelKey: "ui.topic_kind_atomic" },
  hypothesis: { shape: "diamond", labelKey: "ui.topic_kind_hypothesis" },
  evidence: { shape: "folded", labelKey: "ui.topic_kind_evidence" },
  conclusion: { shape: "hexagon", labelKey: "ui.topic_kind_conclusion" }
};

/** The SVG is drawn in a 100 x 100 box stretched to the card, on the card's own edge; it does not clip, so the stroke can straddle it. */
const EDGE = 0;
const FAR = 100;
/** The hexagon is the AIM conclusion's: the same six points. */
const HEXAGON = `25,${EDGE} 75,${EDGE} ${FAR},50 75,${FAR} 25,${FAR} ${EDGE},50`;
/** Evidence: the top-right corner is folded (a cut of 12% of the width and 24% of the height, plus the fold line). */
const FOLD_X = 88;
const FOLD_Y = 24;
const FOLDED = `${EDGE},${EDGE} ${FOLD_X},${EDGE} ${FAR},${FOLD_Y} ${FAR},${FAR} ${EDGE},${FAR}`;
const FOLD_LINE = `${FOLD_X},${EDGE} ${FOLD_X},${FOLD_Y} ${FAR},${FOLD_Y}`;
const DIAMOND = `50,${EDGE} ${FAR},50 50,${FAR} ${EDGE},50`;

/** Whether a type is drawn as an SVG (its card frame and shadow are hidden). */
export function hasSvgShape(kind: TopicKind): boolean {
  const shape = TOPIC_KIND_SHAPES[kind].shape;
  return shape !== "rounded" && shape !== "rect";
}

/**
 * Adds the shape behind a card's text and returns it; a rounded or rectangular type draws nothing (its CSS frame is the shape).
 * `preserveAspectRatio="none"` lets one drawing follow the card as its height changes with the text.
 */
export function renderShapeBackground(card: HTMLElement, kind: TopicKind): SVGElement | undefined {
  const shape = TOPIC_KIND_SHAPES[kind].shape;
  if (!hasSvgShape(kind)) return undefined;
  const svg = createSvg("svg");
  svg.addClass("vam-kind-shape");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const outline = createSvg(shape === "ellipse" ? "ellipse" : "polygon");
  outline.addClass("vam-kind-outline");
  if (shape === "ellipse") {
    outline.setAttribute("cx", "50");
    outline.setAttribute("cy", "50");
    outline.setAttribute("rx", "50");
    outline.setAttribute("ry", "50");
  } else outline.setAttribute("points", shape === "diamond" ? DIAMOND : shape === "hexagon" ? HEXAGON : FOLDED);
  outline.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(outline);
  if (shape === "folded") {
    const fold = createSvg("polyline");
    fold.addClass("vam-kind-fold");
    fold.setAttribute("points", FOLD_LINE);
    fold.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(fold);
  }
  card.appendChild(svg);
  return svg;
}

export type ShapeInsets = { top: number; right: number; bottom: number; left: number };

/** Where the text block sits in each SVG shape: its width and height as a share of the card's, chosen so every corner of the block is inside the outline. */
const FIT: Record<Exclude<TopicShape, "rounded" | "rect">, { width: number; height: number }> = {
  // Corner on the ellipse needs w^2 + h^2 <= 1.
  ellipse: { width: 0.7, height: 0.7 },
  // Corner on the diamond needs w + h <= 1: half the card's width, so the top and bottom padding is half the text each.
  diamond: { width: 0.5, height: 0.5 },
  // The hexagon's slanted side needs w + h / 2 <= 1.
  hexagon: { width: 0.7, height: 0.58 },
  // The cut corner needs h <= 1 - 4 * (0.94 - 0.88): the top right of the block clears the fold.
  folded: { width: 0.88, height: 0.74 }
};
/** Vertical room on top of the geometry, so the text never touches the stroke. */
const SAFETY = 4;
/** An ordinary card's padding (styles.css `.vam-node`). */
const BASE_PADDING: ShapeInsets = { top: 12, right: 14, bottom: 14, left: 14 };

/**
 * The padding that puts a text block of `content` height inside the type's inscribed safe area.
 * `content.width` is the card's width; `content.height` is the text block's measured height at the width that is left
 * once the side padding is taken away. Left and right depend on the width only; top and bottom grow with the height.
 * A rounded or rectangular type keeps the ordinary card padding.
 */
export function shapeInsets(kind: TopicKind, content: { width: number; height: number }): ShapeInsets {
  const shape = TOPIC_KIND_SHAPES[kind].shape;
  if (shape === "rounded" || shape === "rect") return { ...BASE_PADDING };
  const fit = FIT[shape];
  const side = (content.width * (1 - fit.width)) / 2;
  const vertical = (content.height * (1 / fit.height - 1)) / 2 + SAFETY;
  return { top: vertical, right: side, bottom: vertical, left: side };
}
