/**
 * The chief editor's pass over the plans (pure): a card's stored Prompt read back into its brief fields, and a Prompt re-composed from
 * those fields merged with a change. Picture plan, cover, role, place and neighbour lines are carried over as they are.
 */
import { instructionLanguageOf, type ContentLanguage } from "../../i18n";
import {
  composeCardPrompt,
  parseCardCover,
  parseCardPoints,
  parseCardPrompt,
  parseChecklist,
  parseImageSlots,
  parseRoleWord,
  type ChecklistItem,
  type NeighbourCard
} from "./plan-text";
import type { BookRole } from "./model";
import type { CardKind } from "./structure";

/** The labelled brief fields of a stored Prompt (an absent line reads as empty). */
export interface PromptBrief {
  covers: string;
  points: string[];
  entry: string;
  handoff: string;
  previous: string;
  next: string;
  checklist: ChecklistItem[];
}
export function readBrief(prompt: string): PromptBrief {
  const lines = parseCardPrompt(prompt);
  // A neighbour line shows only its sentence: the position and title are the neighbour's own and are not the plan's to edit.
  const side = (value: string | undefined): string => neighbourOf(value)?.summary ?? "";
  return {
    covers: lines.covers ?? "",
    points: parseCardPoints(prompt) ?? [],
    entry: lines.entry ?? "",
    handoff: lines.handoff ?? "",
    previous: side(lines.previous),
    next: side(lines.next),
    checklist: parseChecklist(prompt)
  };
}

const NONE = /^(?:無|none)$/i;
const POSITION = /^\(([^)]+)\) ([\s\S]*)$/;
/** A neighbour line's value (`(3) Title — sentence`, `(前言) Title`, `Title — sentence`) as a card; undefined for the no-neighbour form. */
function neighbourOf(value: string | undefined, sentence?: string): NeighbourCard | undefined {
  if (value === undefined || NONE.test(value.trim())) return undefined;
  const m = POSITION.exec(value);
  const body = m ? m[2] : value;
  const at = body.indexOf(" — ");
  const title = at < 0 ? body : body.slice(0, at);
  const old = at < 0 ? "" : body.slice(at + 3);
  const where = m ? (/^\d+$/.test(m[1].trim()) ? Number(m[1].trim()) : "preface") : undefined;
  return { ...(where === undefined ? {} : { position: where }), title, summary: sentence ?? old };
}

/**
 * A returned previous sentence without the neighbour's own heading: a model that echoes the whole line (`(1) Title — sentence`,
 * `(前言) Title — sentence`, `Title — sentence`) is read as the sentence only. Only the line's own title is stripped.
 */
function bareSentence(value: string, title: string): string {
  const text = value.trim();
  const body = POSITION.exec(text)?.[2] ?? text;
  return title && body.startsWith(`${title} — `) ? body.slice(title.length + 3).trim() : text;
}

/** The language the Prompt's own labels are written in (an edit never flips them); `fallback` when it cannot tell. */
export function promptLanguage(prompt: string, fallback: ContentLanguage): ContentLanguage {
  const same = (reference: ContentLanguage): boolean =>
    instructionLanguageOf(fallback) === instructionLanguageOf(reference);
  if (/^This chapter covers[:：]/m.test(prompt)) return same("en") ? fallback : "en";
  if (/^本章會講[:：]/m.test(prompt)) return same("zh-TW") ? fallback : "zh-TW";
  return fallback;
}

export interface PlanEditFields {
  covers?: string;
  points?: readonly string[];
  entry?: string;
  handoff?: string;
  previous?: string;
  checklist?: readonly { type: ChecklistItem["type"]; text: string }[];
}
/**
 * The card's Prompt with `change` merged in and composed again by {@link composeCardPrompt}. `undefined` = nothing would change, or the
 * Prompt cannot be read as a plan (no role or no covers line): it is then left alone. A new `previous` sentence only replaces the one on
 * an existing previous line; a card with no previous card gets none.
 */
export function editedPrompt(
  prompt: string,
  change: PlanEditFields,
  kind: CardKind,
  fallback: ContentLanguage
): string | undefined {
  const lines = parseCardPrompt(prompt);
  const role: BookRole | undefined = lines.role ? parseRoleWord(lines.role) : undefined;
  if (!role || lines.covers === undefined) return undefined;
  const brief = readBrief(prompt);
  const points = change.points?.length ? [...change.points] : brief.points;
  const checklist: ChecklistItem[] = change.checklist?.length
    ? change.checklist.map((item, at) => ({ id: `C${at + 1}`, ...item }))
    : brief.checklist;
  const old = neighbourOf(lines.previous);
  const sentence = old && change.previous ? bareSentence(change.previous, old.title) : "";
  const previous = old && sentence ? { ...old, summary: sentence } : old;
  const next = neighbourOf(lines.next);
  const parent = lines.parent === undefined ? undefined : neighbourOf(lines.parent);
  const cover = parseCardCover(prompt);
  const images = parseImageSlots(prompt);
  const language = promptLanguage(prompt, fallback);
  const composed = composeCardPrompt(
    {
      role,
      kind,
      covers: change.covers || brief.covers,
      ...(points.length ? { points } : {}),
      entry: change.entry || brief.entry,
      handoff: change.handoff || brief.handoff,
      ...(parent && typeof parent.position === "number"
        ? { parent: { position: parent.position, title: parent.title } }
        : {}),
      ...(previous ? { previous } : {}),
      ...(next ? { next } : {}),
      checklist,
      ...(images ? { images } : {}),
      ...(cover ? { cover } : {})
    },
    language
  );
  return composed === prompt ? undefined : composed;
}
