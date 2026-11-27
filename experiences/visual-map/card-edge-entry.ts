/**
 * The selected card's edge entries (V3.3 A6): small buttons that sit on the card's edge, outside its layout box.
 * One container, one button per entry, so a second entry (the AI card, A7) is one more item in `entries`.
 */
export interface CardEdgeEntry {
  /** Modifier class after `vam-card-edge-`, e.g. "add" gives `vam-card-edge-add`. */
  kind: string;
  label: string;
  ariaLabel: string;
  onClick: () => void;
}

/** The side of the card its child cards grow toward; the entries sit there, stacked along the edge. */
export type CardEdgeSide = "right" | "left" | "down" | "up";

/** Draws the edge container on `card` (a `.vam-node`) with one button per entry; returns the container. */
export function paintCardEdge(
  card: HTMLElement,
  entries: CardEdgeEntry[],
  side: CardEdgeSide = "right",
  tabbable = true
): HTMLElement {
  const edge = card.createDiv(`vam-card-edge is-edge-${side}`);
  for (const entry of entries) {
    const button = edge.createEl("button", {
      text: entry.label,
      cls: `vam-card-edge-button vam-card-edge-${entry.kind}`
    });
    button.setAttr("aria-label", entry.ariaLabel);
    if (!tabbable) button.tabIndex = -1;
    button.addEventListener("click", event => {
      event.stopPropagation();
      entry.onClick();
    });
  }
  return edge;
}
