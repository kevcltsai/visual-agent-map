/**
 * The state of the search box's scope switch (P4.2). "This map" is the default and never touches the vault. "All maps" reads the
 * authorised cards once, when the user presses it (one snapshot, no background index); typing only filters that snapshot. Going
 * back to this map, closing the search, leaving the map or closing the view calls `dispose`/`setScope("map")`, which aborts a load
 * in flight; a load that finishes for an older press is dropped.
 */
import { loadAuthorizedCards, searchCorpus, type CorpusCard, type CorpusHits } from "./cross-map-corpus";
import type { KnowledgeRefIO } from "./knowledge-refs";

export type SearchScope = "map" | "all";
export type CrossMapState = "idle" | "loading" | "ready" | "failed";

export class CrossMapSearch {
  scope: SearchScope = "map";
  state: CrossMapState = "idle";
  private cards: CorpusCard[] = [];
  private controller: AbortController | null = null;

  constructor(
    private readonly io: () => KnowledgeRefIO,
    private readonly onChange: () => void
  ) {}

  setScope(scope: SearchScope): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.stop();
    if (scope === "map") {
      this.onChange();
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.state = "loading";
    void Promise.resolve()
      .then(() => loadAuthorizedCards(this.io(), controller.signal))
      .then(
        cards => this.finish(controller, "ready", cards),
        () => this.finish(controller, "failed", [])
      );
    this.onChange();
  }

  /** The snapshot's matches for `query`; nothing outside "All maps" once it is ready. */
  hits(query: string): CorpusHits {
    return this.scope === "all" && this.state === "ready" ? searchCorpus(this.cards, query) : { hits: [], total: 0 };
  }

  dispose(): void {
    this.stop();
    this.scope = "map";
  }

  private stop(): void {
    this.controller?.abort();
    this.controller = null;
    this.cards = [];
    this.state = "idle";
  }

  private finish(controller: AbortController, state: "ready" | "failed", cards: CorpusCard[]): void {
    if (this.controller !== controller || controller.signal.aborted) return;
    this.cards = cards;
    this.state = state;
    this.onChange();
  }
}
