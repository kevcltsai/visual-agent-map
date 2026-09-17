import type { AiProvider } from "./providers/provider";

export class ProviderRegistry {
  constructor(private readonly codex: AiProvider, private readonly claude: AiProvider) {}

  select(model: string): AiProvider { return model.startsWith("claude:") ? this.claude : this.codex; }
  modelFor(provider: AiProvider, model: string): string { return provider.id === "claude" ? model.slice("claude:".length) : model; }
}
