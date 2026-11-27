import { t } from "../../i18n";

/** A bare error code such as "required-web-unavailable"; anything longer or free-form may carry private text. */
const CODE = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * The short, localized reason a trial did not finish, and the raw code for a secondary line. The error text itself is
 * never shown: it can carry prompt text or paths, so only a bare code is passed on.
 */
export function livingTrialReason(error: unknown): { reason: string; code: string } {
  const message = String((error as { message?: unknown } | null)?.message ?? error);
  const code = CODE.test(message) ? message : "";
  const key = ((): Parameters<typeof t>[0] => {
    if (/required-web|forbidden-web|web-check|web-excerpt|missing-search-decision/.test(code))
      return "ui.living_node_trial_reason_web";
    if (/too-large/.test(code)) return "ui.living_node_reason_range_too_large";
    if (/^(stale-base|changed-knowledge)$/.test(code)) return "ui.living_node_trial_reason_replaced";
    if (/^(ambiguous-living-node-region|invalid-generation|invalid-receipts|unknown-ownership)$/.test(code))
      return "ui.living_node_reason_markers_damaged";
    if (/^(unauthorized-source|missing-source|invalid-source)$/.test(code))
      return "ui.living_node_reason_missing_source";
    if (code) return "ui.living_node_trial_reason_validation";
    if (/time.?out|timed out/i.test(message)) return "ui.living_node_trial_reason_timeout";
    return "ui.living_node_trial_reason_provider";
  })();
  return { reason: t(key), code };
}
