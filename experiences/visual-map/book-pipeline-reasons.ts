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
