import { findMatches, nextMatch, type MapMatchStep } from "./map-search";
import { readingOrder } from "./presentation-order";
import type { MapNode } from "../../map-graph";

/** Search over the map's titles: the reading order (collapsed branches included), the matches and the current one. */
export interface MapSearchResult {
  order: string[];
  matches: string[];
}

/** `skip` holds ids that are not on the canvas (interim AIM results already superseded); `siblingAxis` follows the layout direction. */
export function searchMap(
  nodes: readonly MapNode[],
  skip: ReadonlySet<string>,
  titleOf: (id: string) => string,
  query: string,
  siblingAxis: "y" | "x"
): MapSearchResult {
  const order = readingOrder(
    nodes.filter(node => !skip.has(node.id)),
    { includeHidden: true, siblingAxis }
  );
  return { order, matches: findMatches(order, titleOf, query) };
}

/** The match to jump to from `currentId`, cycling. Null when nothing matches. */
export function stepSearch(result: MapSearchResult, currentId: string | null, delta: 1 | -1): MapMatchStep | null {
  return nextMatch(result.order, result.matches, currentId, delta);
}

export interface MapSearchBarOptions {
  query: string;
  label: string;
  closeLabel: string;
  countText: string;
  onInput(value: string): void;
  onStep(delta: 1 | -1): void;
  onClose(): void;
}

export interface MapSearchBar {
  root: HTMLElement;
  input: HTMLInputElement;
  setCount(text: string): void;
}

/** The search box: role=search, a labelled search field, a visible count and a close button. Keys: Enter / Shift+Enter step, Esc closes. */
export function buildMapSearchBar(parent: HTMLElement, options: MapSearchBarOptions): MapSearchBar {
  const root = parent.createDiv({ cls: "vam-map-search", attr: { role: "search" } });
  const input = root.createEl("input", {
    cls: "vam-map-search-input",
    type: "search",
    attr: { "aria-label": options.label, placeholder: options.label, autocomplete: "off", spellcheck: "false" }
  });
  input.value = options.query;
  const count = root.createSpan({ cls: "vam-map-search-count", text: options.countText });
  const close = root.createEl("button", {
    cls: "vam-map-search-close",
    text: "×",
    attr: { "aria-label": options.closeLabel, type: "button" }
  });
  input.addEventListener("input", () => options.onInput(input.value));
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      // An IME confirms its candidate with Enter; that must not jump.
      if (event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      options.onStep(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      if (event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      options.onClose();
    }
  });
  close.addEventListener("click", event => {
    event.stopPropagation();
    options.onClose();
  });
  return {
    root,
    input,
    setCount: text => {
      count.setText(text);
    }
  };
}
