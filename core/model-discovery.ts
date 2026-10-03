import { CLAUDE_MODEL_CHOICES, type AiProviderId } from "../ai/providers/provider";

export type ModelDiscoveryStatus = "idle" | "loading" | "ready" | "missing" | "error";
export interface ModelDiscoveryState {
  provider: AiProviderId;
  status: ModelDiscoveryStatus;
  models: string[];
  error?: string;
  reasoningEfforts?: Record<string, string[]>;
}
export interface CodexModelCatalog { models: string[]; reasoningEfforts: Record<string, string[]> }

export function syncModelSelect(select: HTMLSelectElement, models: string[], label: (id: string) => string, missingLabel: string): void {
  const selected = select.value;
  select.replaceChildren();
  const unique = [...new Set(models)];
  for (const id of unique) select.add(new Option(label(id), id));
  if (selected && !unique.includes(selected)) {
    const unavailable = new Option(`${label(selected)} (${missingLabel})`, selected);
    unavailable.disabled = true;
    select.add(unavailable);
  }
  select.value = selected;
}

/** Shares in-flight discovery and keeps provider availability separate from model selection. */
export class ModelDiscovery {
  private generation: Record<AiProviderId, number> = { codex: 0, claude: 0 };
  private inFlight = new Map<AiProviderId, Promise<ModelDiscoveryState>>();
  private listeners = new Set<(state: ModelDiscoveryState) => void>();
  private states: Record<AiProviderId, ModelDiscoveryState> = {
    codex: { provider: "codex", status: "idle", models: [] },
    claude: { provider: "claude", status: "idle", models: [] }
  };

  constructor(private readonly codexInstalled: () => boolean, private readonly loadCodex: () => Promise<string[] | CodexModelCatalog>, private readonly claudeInstalled: () => boolean) {}
  state(provider: AiProviderId): ModelDiscoveryState { const state = this.states[provider]; return { ...state, models: [...state.models], ...(state.reasoningEfforts ? { reasoningEfforts: Object.fromEntries(Object.entries(state.reasoningEfforts).map(([id, efforts]) => [id, [...efforts]])) } : {}) }; }
  subscribe(listener: (state: ModelDiscoveryState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  invalidate(provider: AiProviderId): void {
    this.generation[provider]++;
    this.inFlight.delete(provider);
    this.publish(provider, { provider, status: "missing", models: [] });
  }
  async refresh(provider: AiProviderId): Promise<ModelDiscoveryState> {
    const running = this.inFlight.get(provider);
    if (running) return running;
    const generation = ++this.generation[provider];
    if (provider === "claude") {
      const state: ModelDiscoveryState = this.claudeInstalled()
        ? { provider, status: "ready", models: CLAUDE_MODEL_CHOICES.map(choice => choice.id) }
        : { provider, status: "missing", models: [] };
      this.publish(provider, state);
      return state;
    }
    if (!this.codexInstalled()) {
      const state = { provider, status: "missing" as const, models: [] };
      this.publish(provider, state);
      return state;
    }
    this.publish(provider, { provider, status: "loading", models: this.states[provider].models, reasoningEfforts: this.states[provider].reasoningEfforts });
    const request = this.loadCodex().then(catalog => {
      const models = Array.isArray(catalog) ? catalog : catalog.models;
      const state = { provider, status: "ready" as const, models: [...new Set(models)], ...(!Array.isArray(catalog) ? { reasoningEfforts: catalog.reasoningEfforts } : {}) };
      if (this.generation[provider] !== generation) return this.state(provider);
      this.publish(provider, state);
      return this.state(provider);
    }).catch(error => {
      const state = { provider, status: "error" as const, models: this.states[provider].models, reasoningEfforts: this.states[provider].reasoningEfforts, error: error instanceof Error ? error.message : String(error) };
      if (this.generation[provider] !== generation) return this.state(provider);
      this.publish(provider, state);
      return this.state(provider);
    }).finally(() => { if (this.inFlight.get(provider) === request) this.inFlight.delete(provider); });
    this.inFlight.set(provider, request);
    return request;
  }
  private publish(provider: AiProviderId, state: ModelDiscoveryState): void {
    this.states[provider] = { ...state, models: [...state.models] };
    for (const listener of this.listeners) listener(this.state(provider));
  }
}
