import { AbstractInputSuggest, setIcon, type App } from "obsidian";
import { t } from "../i18n";

/** One row of the card search list. `none` is the "no match" message, `root` the fixed last row of the parent search. */
export interface CardSearchItem {
  kind: "card" | "root" | "none";
  /** The card id; "" for the root row. */
  id: string;
  title: string;
  /** Titles of the ancestors, nearest last; shown as grey text on the right. */
  trail: string[];
  /** A row that cannot be chosen is greyed and choosing it does nothing. */
  enabled: boolean;
  /** The row is the value the field holds now (shown with a "Current" tag). */
  current?: boolean;
}

export interface CardSearchSource {
  id: string;
  title: string;
  trail: string[];
  enabled: boolean;
}

export interface CardSearchOptions {
  app: App;
  parent: HTMLElement;
  placeholder: string;
  ariaLabel: string;
  /** Every card the field may offer; matching by the typed text happens here in the field. */
  candidates: () => CardSearchSource[];
  onSelect: (item: CardSearchItem) => void;
  /** No list until the user types (the parent search): focusing the field does not expand the hierarchy. */
  typeFirst?: boolean;
  /** Text of the fixed last row shown while the user has typed something (choosing it passes id ""). */
  rootChoice?: string;
  /** Text the field holds at the start; the parent search shows the current parent here. */
  value?: string;
  /** The id of the value held now, for the "Current" tag. */
  currentId?: () => string | null;
  /** Select the whole text on focus, so typing replaces it. */
  selectOnFocus?: boolean;
  /** Text to put back when the field is left without choosing. */
  restoreValue?: () => string;
}

export interface CardSearchField {
  input: HTMLInputElement;
  /** Sets the shown text without opening the list. */
  setValue: (text: string) => void;
  setDisabled: (disabled: boolean, placeholder?: string) => void;
}

const MAX_CARDS = 100;
export const TRAIL_SEPARATOR = " › ";

/** The titles of the ancestors of `id`, root first. Safe on a hierarchy that loops back on itself. */
export function ancestorTrail(
  nodes: readonly { id: string; parentId?: string | null }[],
  id: string,
  titleOf: (id: string) => string
): string[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const trail: string[] = [];
  const seen = new Set<string>([id]);
  let parentId = byId.get(id)?.parentId ?? null;
  while (parentId && byId.has(parentId) && !seen.has(parentId)) {
    seen.add(parentId);
    trail.unshift(titleOf(parentId));
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return trail;
}

/** Title contains the typed text, ignoring case. An empty text matches everything. */
export function matchesTitle(title: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || title.toLowerCase().includes(needle);
}

/** The rows for the typed text: matching cards, then the root row when asked, or the "no match" message. */
export function buildRows(
  sources: readonly CardSearchSource[],
  query: string,
  options: { rootChoice?: string; currentId?: string | null }
): CardSearchItem[] {
  const text = query.trim();
  const rows: CardSearchItem[] = sources
    .filter(source => matchesTitle(source.title, text))
    .slice(0, MAX_CARDS)
    .map(source => ({ kind: "card", ...source, current: options.currentId != null && source.id === options.currentId }));
  if (options.rootChoice !== undefined)
    rows.push({
      kind: "root",
      id: "",
      title: options.rootChoice,
      trail: [],
      enabled: true,
      current: options.currentId === null
    });
  else if (!rows.length) rows.push({ kind: "none", id: "", title: t("ui.card_search_no_match_0", text), trail: [], enabled: false });
  return rows;
}

interface SuggestHost {
  suggestions: (query: string) => CardSearchItem[];
  render: (item: CardSearchItem, el: HTMLElement) => void;
  choose: (item: CardSearchItem, evt: MouseEvent | KeyboardEvent) => void;
}
type SuggestConstructor = new (app: App, input: HTMLInputElement, host: SuggestHost) => unknown;
let suggestClass: SuggestConstructor | null = null;
/** Built on first use so that loading this module never needs the Obsidian class. */
function suggestConstructor(): SuggestConstructor {
  suggestClass ??= class extends AbstractInputSuggest<CardSearchItem> {
    constructor(
      app: App,
      input: HTMLInputElement,
      private readonly host: SuggestHost
    ) {
      super(app, input);
      this.limit = 0;
    }
    protected getSuggestions(query: string): CardSearchItem[] {
      return this.host.suggestions(query);
    }
    renderSuggestion(item: CardSearchItem, el: HTMLElement): void {
      this.host.render(item, el);
    }
    selectSuggestion(item: CardSearchItem, evt: MouseEvent | KeyboardEvent): void {
      this.host.choose(item, evt);
    }
  };
  return suggestClass;
}

function appendHighlighted(parent: HTMLElement, text: string, query: string): void {
  const needle = query.trim().toLowerCase();
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at < 0) {
    parent.createSpan({ text });
    return;
  }
  if (at > 0) parent.createSpan({ text: text.slice(0, at) });
  parent.createEl("mark", { text: text.slice(at, at + needle.length) });
  if (at + needle.length < text.length) parent.createSpan({ text: text.slice(at + needle.length) });
}

/**
 * A search field for picking one card: an input with a type-ahead list (Obsidian's input suggest, so the list hangs
 * on the page and a dialog never clips it). Rows show the title with the typed part marked and the ancestors in grey;
 * greyed rows do nothing when chosen; a Chinese or Japanese composition in progress never chooses a row.
 */
export function createCardSearchField(options: CardSearchOptions): CardSearchField {
  const wrap = options.parent.createDiv("vam-card-search");
  setIcon(wrap.createSpan({ cls: "vam-card-search-icon", attr: { "aria-hidden": "true" } }), "search");
  const input = wrap.createEl("input", {
    cls: "vam-card-search-input",
    type: "text",
    attr: {
      role: "combobox",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: options.placeholder,
      "aria-label": options.ariaLabel
    }
  });
  if (options.value !== undefined) input.value = options.value;
  let typed = !options.typeFirst;
  let composing = false;
  let lastQuery = "";
  // Registered before the suggest attaches its own listeners, so `typed` is current when it asks for rows.
  input.addEventListener("input", () => {
    if (!composing) typed = true;
  });
  input.addEventListener("compositionstart", () => {
    composing = true;
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    typed = true;
    // The composed text arrived as input events while `composing`; ask the list to look again now.
    input.dispatchEvent(new Event("input"));
  });
  input.addEventListener("focus", () => {
    if (options.selectOnFocus) input.select();
  });
  input.addEventListener("blur", () => {
    typed = !options.typeFirst;
    if (options.restoreValue) input.value = options.restoreValue();
  });
  const host: SuggestHost = {
    suggestions: query => {
      lastQuery = query;
      if (options.typeFirst && (!typed || !query.trim())) return [];
      return buildRows(options.candidates(), query, {
        rootChoice: options.rootChoice,
        currentId: options.currentId ? options.currentId() : undefined
      });
    },
    render: (item, el) => {
      el.addClass("vam-card-search-row");
      el.toggleClass("is-disabled", !item.enabled);
      if (item.kind === "none") {
        el.addClass("vam-card-search-none");
        el.setText(item.title);
        return;
      }
      el.setAttr("aria-disabled", String(!item.enabled));
      const title = el.createSpan({ cls: "vam-card-search-title", attr: { dir: "auto" } });
      appendHighlighted(title, item.title, item.kind === "card" ? lastQuery : "");
      if (item.current) el.createSpan({ cls: "vam-card-search-current", text: t("ui.card_search_current") });
      else if (item.trail.length)
        el.createSpan({
          cls: "vam-card-search-trail",
          text: item.trail.join(TRAIL_SEPARATOR),
          attr: { dir: "auto" }
        });
    },
    choose: (item, evt) => {
      if (!item.enabled || item.kind === "none") return;
      if (composing || (evt as KeyboardEvent).isComposing) return;
      typed = !options.typeFirst;
      (suggest as { close: () => void }).close();
      options.onSelect(item);
    }
  };
  const suggest = new (suggestConstructor())(options.app, input, host);
  return {
    input,
    setValue: text => {
      input.value = text;
      typed = !options.typeFirst;
    },
    setDisabled: (disabled, placeholder) => {
      input.disabled = disabled;
      if (placeholder !== undefined) input.setAttr("placeholder", placeholder);
    }
  };
}
