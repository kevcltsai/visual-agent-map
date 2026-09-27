export type AiProviderId = "codex" | "claude";

export const CLAUDE_MODEL_CHOICES = [
  { id: "claude:sonnet", label: "Claude · Sonnet", model: "sonnet" },
  { id: "claude:opus", label: "Claude · Opus", model: "opus" }
] as const;

export function providerForModel(model: string): AiProviderId {
  return model.startsWith("claude:") ? "claude" : "codex";
}

export function providerModelId(model: string): string {
  return providerForModel(model) === "claude" ? model.slice("claude:".length) : model;
}

export function claudeModelChoice(model: string): typeof CLAUDE_MODEL_CHOICES[number] | undefined {
  return CLAUDE_MODEL_CHOICES.find(choice => choice.id === model);
}
