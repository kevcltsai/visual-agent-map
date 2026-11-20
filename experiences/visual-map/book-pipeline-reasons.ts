import { t } from "../../i18n";

/**
 * Reasons in one line: the panel's separator between them, none after a piece that already ends a sentence (live v5: 「位置不符。，刪除或改寫…」);
 * a sentence end in a Latin script keeps one space. Its own module: the card view and the review panel both use it (no import cycle).
 */
export function joinReasons(parts: readonly string[]): string {
  const sep = t("ui.book_panel_lead_sep");
  return parts.reduce((out, part, at) => {
    if (!at) return part;
    if (!/[。！？.!?]\s*$/.test(out)) return out + sep + part;
    return /[.!?]\s*$/.test(out) ? `${out.trimEnd()} ${part}` : out.trimEnd() + part;
  }, "");
}

/** `write failed: <code> + <the issue the chapter still had>`: a failed rewrite of a chapter that keeps its text keeps its reasons too (live v6). */
const CARRIED = /^((?:plan|write|proof) failed: \S+) \+ (\S[\s\S]*)$/;
const FAILED_ONLY = /^(?:plan|write|proof) failed: \S+$/;
/** The failure and the reasons it carries, or undefined for an issue that carries none. */
export function splitCarriedIssue(issue: string): { failure: string; carried: string } | undefined {
  const found = CARRIED.exec(issue.trim());
  return found ? { failure: found[1], carried: found[2].trim() } : undefined;
}
/** `failure` with every reason of `previous` it does not replace (an earlier failure in `previous` is dropped, never stacked). */
export function carryIssue(failure: string, previous: string | undefined): string {
  const before = (previous ?? "").trim();
  const carried = splitCarriedIssue(before)?.carried ?? (FAILED_ONLY.test(before) ? "" : before);
  return carried ? `${failure} + ${carried}` : failure;
}
