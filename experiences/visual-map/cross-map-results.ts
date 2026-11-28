/** The result rows of the cross-map search (P4.2): the card title, the name of its map and its buttons. Draws only; every action is the caller's. */
import type { CorpusCard, CorpusHits } from "./cross-map-corpus";
import type { CrossMapState } from "./cross-map-search";

export interface CrossMapResultText {
  loading: string;
  failed: string;
  none: string;
  more: (shown: number, total: number) => string;
  locate: string;
  cite: string;
  toChat: string;
}

export interface CrossMapResultActions {
  locate(card: CorpusCard): void;
  cite(card: CorpusCard): void;
  toChat(card: CorpusCard): void;
}

/** Rebuilds `host`. A card of the map being shown (`currentMapId`) offers only "Locate": it is already here, and a reference to its own map is not allowed. */
export function renderCrossMapResults(
  host: HTMLElement,
  view: { state: CrossMapState; query: string; hits: CorpusHits; currentMapId: string },
  text: CrossMapResultText,
  actions: CrossMapResultActions
): void {
  host.empty();
  host.toggleClass("is-open", view.state !== "idle");
  const say = (message: string): void => {
    host.createDiv({ cls: "vam-map-search-results-note", text: message, attr: { role: "status" } });
  };
  if (view.state === "loading") return say(text.loading);
  if (view.state === "failed") return say(text.failed);
  if (view.state !== "ready" || !view.query.trim()) return;
  if (!view.hits.total) return say(text.none);
  for (const card of view.hits.hits) {
    const row = host.createDiv({ cls: "vam-map-search-result" });
    const label = row.createDiv({ cls: "vam-map-search-result-label" });
    label.createSpan({ cls: "vam-map-search-result-title", text: card.title });
    label.createSpan({ cls: "vam-map-search-result-map", text: card.mapTitle });
    const buttons = row.createDiv({ cls: "vam-map-search-result-actions" });
    const add = (name: string, run: () => void): void => {
      const button = buttons.createEl("button", { text: name, attr: { type: "button" } });
      button.addEventListener("click", event => {
        event.stopPropagation();
        run();
      });
    };
    add(text.locate, () => actions.locate(card));
    if (card.mapId !== view.currentMapId) {
      add(text.cite, () => actions.cite(card));
      add(text.toChat, () => actions.toChat(card));
    }
  }
  if (view.hits.total > view.hits.hits.length) say(text.more(view.hits.hits.length, view.hits.total));
}
