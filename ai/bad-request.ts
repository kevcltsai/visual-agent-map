/**
 * An error whose message is the provider's own error text (a Codex turn or JSON-RPC error, a Claude CLI `errors` entry), never the
 * model's reply: only such a message may go to a no-content log.
 */
export class ProviderError extends Error {
  readonly providerError = true;
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}
/** A request the provider refused as malformed (HTTP 400, e.g. an output schema it rejects): sent again unchanged it fails the same way. */
export class BadRequestError extends ProviderError {
  readonly badRequest = true;
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}
/** Marked by shape, so an error from another bundle or realm still counts. */
export const isProviderError = (error: unknown): boolean =>
  (error as { providerError?: unknown } | null)?.providerError === true;
/** An error's message, read by shape (an error from another bundle or realm is no `instanceof Error`). */
const messageOf = (error: unknown): string => {
  const message = typeof error === "string" ? error : (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : "";
};
const BAD_REQUEST = /invalid_request_error|invalid_json_schema|\b400 Bad Request\b/i;
/** True for a provider error that a retry of the same request cannot fix (see {@link BadRequestError}). */
export const isBadRequest = (error: unknown): boolean =>
  (error as { badRequest?: unknown } | null)?.badRequest === true || BAD_REQUEST.test(messageOf(error));

/** A failure's own message as one log line: absolute paths replaced by `<path>`, at most 200 characters. */
export function providerErrorText(error: unknown): string {
  const line = messageOf(error)
    // A quoted path is replaced whole (a vault path often has spaces), then any bare one.
    .replace(/(['"`])(?:[A-Za-z]:\\|~?\/)[^'"`]*\1/g, "<path>")
    .replace(/(?:[A-Za-z]:\\|~?\/)[^\s"'`]*[\\/][^\s"'`]*/g, "<path>")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
