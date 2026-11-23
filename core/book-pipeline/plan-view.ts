/**
 * Which of the pipeline's hidden `[!vam-book]` callouts the owner may see: the root's book plan and a card's plan block (its Prompt, shown
 * as 提示 / Prompt). Judged by the title text, against the same label tables the notes are written with. Pure.
 */
import { LANGUAGES, type ContentLanguage, type TranslationKey } from "../../i18n";
import { readPipelineStage } from "./model";
import {
  isBookPlanTitle,
  isChecklistLabel,
  isImagePlanLabel,
  planDisplayField,
  type PlanDisplayField
} from "./plan-text";
import type { CardKind } from "./structure";

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

/** The callout metadata of the please-look box (`[!vam-review|vam-attention]`): Obsidian renders it as `data-callout-metadata`, so the rerun button finds the box without reading its title. */
export const ATTENTION_HOOK = "vam-attention";

/** The language the plan view shows its titles and relabelled fields in: always the book's content language, whatever language the note was stored in. */
export type PlanLocale = ContentLanguage;
export const planLocale = (language: ContentLanguage): PlanLocale => language;

/** The callout title of the root's book plan, or of a card's plan by what the card is. */
export function planTitleKey(kind: PlanCalloutKind["kind"], card: CardKind): TranslationKey {
  if (kind === "book") return "ui.book_plan_title_book";
  return card === "preface"
    ? "ui.book_plan_title_preface"
    : card === "section"
      ? "ui.book_plan_title_section"
      : "ui.book_plan_title_chapter";
}

/**
 * Whether a plan callout is shown open: the plan gate, before anything is written. A note whose `pipeline-stage` is absent, `planned` or
 * unreadable has no written chapter yet, so its plan is open; `written`, `checked` and `needs-review` leave Obsidian's own folded rendering.
 */
export function planStartsOpen(stage: unknown): boolean {
  const known = readPipelineStage(stage);
  return known === undefined || known === "planned";
}

const LABEL_LINE = /^(\s*)(.+?)([：:]\s*)(.*)$/s;
const LONE_LABEL = /^\s*(.+?)[：:]\s*$/;

/** A plan line's text with its stored label under its friendlier display name (`接入點：` reads 怎麼開場：); `undefined` when the line is not a relabelled field. Display text only. */
export function relabelLine(data: string, translateLabel: (field: PlanDisplayField) => string): string | undefined {
  const m = LABEL_LINE.exec(data);
  const field = m ? planDisplayField(m[2]) : undefined;
  return m && field ? `${m[1]}${translateLabel(field)}${m[3]}${m[4]}` : undefined;
}

/** What a lone label line (`圖安排：` / `驗收清單：`, nothing after the colon) folds, with the label word; a label with text after it (`圖安排：無`) has nothing to fold. */
export function foldLabelOf(data: string): { word: string; fold: "images" | "checklist" } | undefined {
  const word = LONE_LABEL.exec(data)?.[1].trim();
  if (word === undefined) return undefined;
  if (isImagePlanLabel(word)) return { word, fold: "images" };
  if (isChecklistLabel(word)) return { word, fold: "checklist" };
  return undefined;
}
