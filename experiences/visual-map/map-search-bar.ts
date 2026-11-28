import { nextMatch, searchMatches, type MapMatchStep, type SearchText } from "./map-search";
import { readingOrder } from "./presentation-order";
import type { MapNode } from "../../map-graph";

/** Search over the map's titles, summaries and details: the reading order (collapsed branches included) and the matches. */
export interface MapSearchResult {
  order: string[];
  matches: string[];
  /** Matches found only in the summary or Detail, not the title. */
  bodyOnly: ReadonlySet<string>;
}

/**
 * `skip` holds ids that are not on the canvas (interim AIM results already superseded); `siblingAxis` follows the layout direction;
 * `balanced` reads a balanced map's right half, then its left half, as the picture book does.
 */
export function searchMap(
  nodes: readonly MapNode[],
  skip: ReadonlySet<string>,
  textOf: (id: string) => SearchText,
  query: string,
  siblingAxis: "y" | "x",
  balanced = false
): MapSearchResult {
  const order = readingOrder(
    nodes.filter(node => !skip.has(node.id)),
    { includeHidden: true, siblingAxis, balanced }
  );
  return { order, ...searchMatches(order, textOf, query) };
}

/** The match to jump to from `currentId`, cycling. Null when nothing matches. */
export function stepSearch(result: MapSearchResult, currentId: string | null, delta: 1 | -1): MapMatchStep | null {
  return nextMatch(result.order, result.matches, currentId, delta);
}

export interface MapSearchBarOptions {
  query: string;
  label: string;
  /** The "This map / All maps" switch: the group's name, the two button texts and the scope now chosen. */
  scope: { value: "map" | "all"; groupLabel: string; mapLabel: string; allLabel: string };
  onScope(scope: "map" | "all"): void;
  closeLabel: string;
  countText: string;
  onInput(value: string): void;
  onStep(delta: 1 | -1): void;
  onClose(): void;
}

export interface MapSearchBar {
  root: HTMLElement;
  input: HTMLInputElement;
  /** Where the cross-map result rows go (empty and hidden while the scope is this map). */
  results: HTMLElement;
  setCount(text: string): void;
  /** Shows which scope is chosen (the buttons stay, so the focus stays). */
  setScope(scope: "map" | "all"): void;
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
  const scopeButtons = new Map<"map" | "all", HTMLElement>();
  // A div around the two scope buttons: the close button stays the first direct button of the box.
  const group = root.createDiv({
    cls: "vam-map-search-scope",
    attr: { role: "radiogroup", "aria-label": options.scope.groupLabel }
  });
  for (const [value, text] of [
    ["map", options.scope.mapLabel],
    ["all", options.scope.allLabel]
  ] as const) {
    const on = options.scope.value === value;
    const button = group.createEl("button", {
      cls: on ? "vam-map-search-scope-btn is-on" : "vam-map-search-scope-btn",
      text,
      attr: { type: "button", role: "radio", "aria-checked": on ? "true" : "false", "data-scope": value }
    });
    button.addEventListener("click", event => {
      event.stopPropagation();
      options.onScope(value);
    });
    scopeButtons.set(value, button);
  }
  const count = root.createSpan({ cls: "vam-map-search-count", text: options.countText });
  const close = root.createEl("button", {
    cls: "vam-map-search-close",
    text: "×",
    attr: { "aria-label": options.closeLabel, type: "button" }
  });
  const results = root.createDiv({ cls: "vam-map-search-results" });
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
    results,
    setCount: text => {
      count.setText(text);
    },
    setScope: scope => {
      for (const [value, button] of scopeButtons) {
        button.toggleClass("is-on", value === scope);
        button.setAttr("aria-checked", value === scope ? "true" : "false");
      }
    }
  };
}
