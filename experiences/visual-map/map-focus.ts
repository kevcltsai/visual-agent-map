// Focus anchors for the map view: a stable identity for the control that had focus, so a repaint or a closed dialog can
// give focus back to its replacement. Cards go by node id, text blocks by item id, every other control by what it says
// (aria-label, class or text) and its place among controls that say the same. Never by position in the whole view.
export interface MapFocusAnchor {
  nodeId?: string;
  itemId?: string;
  /** The topic a text block hangs from: where focus goes when the block itself is gone. */
  parentId?: string | null;
  key?: string;
  nth?: number;
}

const KEYED = ["button", "input", "textarea", "select", "[tabindex]"].join(",");

const keyOf = (el: HTMLElement): string =>
  `${el.tagName.toLowerCase()}|${el.getAttribute("aria-label") || el.classList.item(0) || (el.textContent ?? "").trim()}`;

/** What to remember about the focused element, or null when it is the view itself or outside it. */
export function describeFocus(
  el: Element | null,
  root: HTMLElement,
  parentOf: (itemId: string) => string | null | undefined
): MapFocusAnchor | null {
  if (!el || el === root || !root.contains(el)) return null;
  const target = el as HTMLElement;
  const text = target.closest<HTMLElement>(".vam-text-node");
  if (text?.dataset.itemId && root.contains(text))
    return { itemId: text.dataset.itemId, parentId: parentOf(text.dataset.itemId) ?? null };
  const card = target.closest<HTMLElement>(".vam-node");
  const scope = card && root.contains(card) && card.dataset.nodeId ? card : root;
  const nodeId = scope === card ? card.dataset.nodeId : undefined;
  if (nodeId && target === card) return { nodeId };
  const key = keyOf(target);
  const same = Array.from(scope.querySelectorAll<HTMLElement>(KEYED)).filter(peer => keyOf(peer) === key);
  const nth = Math.max(0, same.indexOf(target));
  return nodeId ? { nodeId, key, nth } : { key, nth };
}

/** The element that now stands for the anchor, or null when it is gone (the caller picks a fallback). */
export function resolveFocus(
  anchor: MapFocusAnchor,
  root: HTMLElement,
  lookup: { card: (id: string) => HTMLElement | undefined; text: (id: string) => HTMLElement | undefined }
): HTMLElement | null {
  if (anchor.itemId) return lookup.text(anchor.itemId) ?? null;
  const card = anchor.nodeId ? lookup.card(anchor.nodeId) : undefined;
  if (anchor.nodeId && !card) return null;
  if (!anchor.key) return card ?? null;
  const scope = card ?? root;
  const same = Array.from(scope.querySelectorAll<HTMLElement>(KEYED)).filter(peer => keyOf(peer) === anchor.key);
  return same[anchor.nth ?? 0] ?? same[0] ?? card ?? null;
}

/** True when nothing useful has focus: the page body, nothing, or an element that left the document. */
export function focusIsLost(doc: Document, root: HTMLElement): boolean {
  const active = doc.activeElement;
  if (!active || active === doc.body || active.tagName === "BODY") return true;
  if (root.contains(active)) return false;
  return !active.isConnected;
}
