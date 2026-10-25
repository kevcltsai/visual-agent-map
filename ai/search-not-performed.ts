import { t } from "../i18n";

/** The error name a provider runtime gives to a research that finished without any web retrieval. */
export const SEARCH_NOT_PERFORMED = "SearchNotPerformedError";

/** A research that needed the web finished without one search or page fetch (the model chose not to, or could not). */
export function searchNotPerformedError(): Error {
  const error = new Error(t("ui.context_ai_search_not_performed"));
  error.name = SEARCH_NOT_PERFORMED;
  return error;
}

/** By name, not by class or `instanceof`: the same error can cross a module boundary that has its own copy of this file. */
export function isSearchNotPerformed(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === SEARCH_NOT_PERFORMED;
}
