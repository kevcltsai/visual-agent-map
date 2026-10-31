import { FALLBACK_MODEL } from "./model-resolution";
import { claudeModelChoice } from "./providers/provider";

/** Provider errors an owner can get around by using the other provider. Timeouts, network and format errors are not among them. */
export type ProviderErrorKind = "quota" | "auth" | "model-unavailable";
export type FailedProvider = "codex" | "claude";

// Matched against the raw failure message (the note's `last-error`), never a new log field.
const QUOTA = /usage limit|rate[ -]?limit|quota|額度|额度|用量上限/i;
const AUTH = /not logged in|please (?:run )?\/login|\/login|\b401\b|invalid api key|unauthori[sz]ed/i;
const MODEL_UNAVAILABLE =
  /model[^.]{0,40}(?:not found|not supported|does not exist|unavailable)|(?:unknown|unsupported) model|model_not_found/i;

const providerOf = (model: string): FailedProvider => (claudeModelChoice(model) ? "claude" : "codex");

export function classifyProviderError(reason: string | undefined | null): ProviderErrorKind | null {
  const text = reason?.trim();
  if (!text) return null;
  if (QUOTA.test(text)) return "quota";
  if (AUTH.test(text)) return "auth";
  if (MODEL_UNAVAILABLE.test(text)) return "model-unavailable";
  return null;
}

/** Which provider failed: the message when it names one, otherwise the model the topic resolved to. */
export function providerOfFailure(reason: string | undefined | null, model: string): FailedProvider {
  const text = reason ?? "";
  if (/claude|anthropic/i.test(text)) return "claude";
  if (/codex|openai|chatgpt/i.test(text)) return "codex";
  return providerOf(model);
}

/**
 * The model to retry with on the other provider, or null when there is none to offer.
 * Codex failed: Claude Sonnet, only when Claude is available. Claude failed: the current model if it is a Codex model,
 * then the fallback model if available, then the first available Codex model.
 */
export function otherProviderModel(
  failed: FailedProvider,
  available: readonly string[],
  current: string
): string | null {
  if (failed === "codex") return available.includes("claude:sonnet") ? "claude:sonnet" : null;
  const codex = available.filter(model => providerOf(model) === "codex");
  if (providerOf(current) === "codex" && available.includes(current)) return current;
  if (available.includes(FALLBACK_MODEL)) return FALLBACK_MODEL;
  return codex[0] ?? null;
}
