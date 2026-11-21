/**
 * Which of the pipeline's hidden `[!vam-book]` callouts the owner may see: the root's book plan and a card's plan block (its Prompt, shown
 * as 提示 / Prompt). Judged by the title text, against the same label tables the notes are written with. Pure.
 */
import { LANGUAGES } from "../../i18n";
import { isBookPlanTitle } from "./plan-text";

export interface PlanCalloutKind {
  kind: "book" | "card";
  /** Whether the stored title is the Chinese one (only Chinese notes get the friendlier display labels). */
  zh: boolean;
}

const CARD_TITLES: ReadonlySet<string> = new Set(LANGUAGES.map(language => language.noteHeadings.Prompt));
const CHINESE_TITLES: ReadonlySet<string> = new Set(
  LANGUAGES.filter(language => language.instruction === "zh").map(language => language.noteHeadings.Prompt)
);

/** The plan kind of a callout title, or undefined for every other `[!vam-book]` callout (preview, proofread result, research notes, logs...). */
export function planCalloutKind(title: string): PlanCalloutKind | undefined {
  const text = title.trim();
  if (isBookPlanTitle(text)) return { kind: "book", zh: /[㐀-鿿]/.test(text) };
  if (CARD_TITLES.has(text)) return { kind: "card", zh: CHINESE_TITLES.has(text) };
  return undefined;
}
