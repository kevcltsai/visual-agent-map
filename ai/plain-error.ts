import { translate, t, type ContentLanguage } from "../i18n";
import { classifyProviderError } from "./provider-error";

/** Raw provider output: JSON, schema text, status codes, stack frames. Never shown in a main message. */
const TECHNICAL = /[{}[\]]|schema|json|required|properties|invalid_request|\$\.|\bat \S+:\d+|\b[45]\d\d\b|<\/?\w+>/i;
const NETWORK = /timed? ?out|timeout|etimedout|econn|enotfound|network|socket|fetch failed|offline|aborted by/i;

export function rawErrorText(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string") return message.trim();
  return typeof error === "string" ? error.trim() : "";
}

/** True when the raw text must stay out of the main message (it goes under "Technical details"). */
export function isTechnicalErrorText(raw: string): boolean {
  return !raw || raw.length > 400 || TECHNICAL.test(raw);
}

/**
 * The message a person reads when an AI step failed: what did not finish, that nothing was changed, and what to
 * do next (with its cost). The raw text is not in it; callers keep that for the log and "Technical details".
 */
export function plainFailure(context: string, error: unknown, locale?: ContentLanguage): string {
  const say = (key: Parameters<typeof t>[0], ...values: unknown[]): string =>
    locale ? translate(locale, key, ...values) : t(key, ...values);
  const raw = rawErrorText(error);
  const kind = classifyProviderError(raw);
  // A sentence the product wrote itself (already says what happened and what to do) passes through unchanged.
  if (!kind && !NETWORK.test(raw) && !isTechnicalErrorText(raw) && raw.length > 60) return raw;
  const reason =
    kind === "quota"
      ? say("error.plain_reason_quota")
      : kind === "auth"
        ? say("error.plain_reason_auth")
        : kind === "model-unavailable"
          ? say("error.plain_reason_model")
          : NETWORK.test(raw)
            ? say("error.plain_reason_network")
            : !isTechnicalErrorText(raw)
              ? raw.replace(/[.。]+$/, "")
              : "";
  const first = reason ? say("error.plain_failed_reason_0_1", context, reason) : say("error.plain_failed_0", context);
  const next = kind === "auth" ? say("error.plain_next_signin") : kind === "quota" ? say("error.plain_next_quota") : say("error.plain_next_retry");
  return `${first} ${say("error.plain_map_unchanged")} ${next}`;
}

/** The card's own wording for a stored failure: plain main text plus the raw text when it is technical. */
export function cardFailure(raw: string, locale?: ContentLanguage): { text: string; technical: string | null } {
  const text = plainFailure(locale ? translate(locale, "error.plain_card_context") : t("error.plain_card_context"), raw, locale);
  return { text, technical: isTechnicalErrorText(raw) || classifyProviderError(raw) || NETWORK.test(raw) ? raw : null };
}
