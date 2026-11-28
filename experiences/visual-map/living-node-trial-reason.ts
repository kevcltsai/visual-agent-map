import { isSearchNotPerformed } from "../../ai/search-not-performed";
import { t, type TranslationKey } from "../../i18n";
import { isNetworkFailure } from "./living-node-state";

/** A bare error code such as "required-web-unavailable"; anything longer or free-form may carry private text. */
const CODE = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * The short, localized reason a trial did not finish, and the raw code for a secondary line. The error text itself is
 * never shown: it can carry prompt text or paths, so only a bare code is passed on.
 */
export function livingTrialReason(error: unknown): { key: TranslationKey; reason: string; code: string } {
  const message = String((error as { message?: unknown } | null)?.message ?? error);
  const code = CODE.test(message) ? message : "";
  const key = ((): TranslationKey => {
    // A runtime's own "no search happened" error is a sentence, not a code; it still is a web reason.
    if (isSearchNotPerformed(error)) return "ui.living_node_trial_reason_web";
    if (/required-web|forbidden-web|web-check|web-excerpt|missing-search-decision/.test(code))
      return "ui.living_node_trial_reason_web";
    if (/too-large/.test(code)) return "ui.living_node_reason_range_too_large";
    if (/^(stale-base|changed-knowledge)$/.test(code)) return "ui.living_node_trial_reason_replaced";
    if (/^(ambiguous-living-node-region|invalid-generation|invalid-receipts|unknown-ownership)$/.test(code))
      return "ui.living_node_reason_markers_damaged";
    if (code === "map-file-source") return "ui.living_node_reason_map_file";
    if (/^(unauthorized-source|missing-source|invalid-source)$/.test(code))
      return "ui.living_node_reason_missing_source";
    if (code) return "ui.living_node_trial_reason_validation";
    if (isNetworkFailure(error)) return "ui.living_node_trial_reason_network";
    if (/time.?out|timed out/i.test(message)) return "ui.living_node_trial_reason_timeout";
    return "ui.living_node_trial_reason_provider";
  })();
  return { key, reason: t(key), code };
}

/**
 * The localized reason a configuration save was refused, or null for a code this does not know (the caller then falls
 * back to its generic failure line). Only a bare code is read, as for the trial.
 */
export function livingSaveReason(error: unknown): TranslationKey | null {
  const message = String((error as { message?: unknown } | null)?.message ?? error);
  switch (message) {
    case "empty-prompt":
      return "ui.living_node_save_reason_empty";
    case "self-reference":
      return "ui.living_node_save_reason_self";
    case "living-node-cycle":
      return "ui.living_node_reason_cycle";
    case "map-file-source":
      return "ui.living_node_reason_map_file";
    case "unauthorized-source":
    case "missing-source":
    case "invalid-source":
      return "ui.living_node_reason_missing_source";
    case "ambiguous-source":
      return "ui.living_node_save_reason_ambiguous";
    case "changed-configuration":
    case "changed-target":
    case "changed-target-identity":
    case "changed-source-identity":
    case "changed-source-resolution":
    case "missing-target":
      return "ui.living_node_save_reason_changed";
    case "locked-target":
      return "ui.ai_locked_notice";
    default:
      return null;
  }
}
