/**
 * The chief editor's pass over the plans (pure): a card's stored Prompt read back into its brief fields, and a Prompt re-composed from
 * those fields merged with a change. Picture plan, cover, role, place and neighbour lines are carried over as they are.
 */
import { instructionLanguageOf, type ContentLanguage } from "../../i18n";
import { isPlaceholder } from "../note-placeholder";
import { mayRewriteRaw } from "./body-integrity";
import {
  composeCardPrompt,
  parseCardCover,
  parseCardPoints,
  parseCardPrompt,
  parseChecklist,
  parseImageSlots,
  parseRoleWord,
  rewriteNeighbourLine,
  type ChecklistItem,
  type NeighbourCard
} from "./plan-text";
import type { BookRole } from "./model";
import type { BookStructure, CardKind } from "./structure";
import type { CardPlanPlace } from "../steps/book-pipeline/card-plan";
import { changesBrief, type PlanEditCard, type PlanEditChange } from "../steps/book-pipeline/plan-edit";

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

/** A card's place as the plan steps read it. */
export function cardPlanPlaceOf(structure: BookStructure, id: string): CardPlanPlace {
  const place = structure.placeOf(id);
  if (!place || place.kind === "preface") return { kind: "preface" };
  if (place.kind === "chapter") return { kind: "chapter", chapter: place.chapter };
  return {
    kind: "section",
    chapter: structure.placeOf(place.chapterId as string)?.chapter,
    sectionIndex: place.sectionIndex,
    sectionCount: place.sectionCount
  };
}

/** What a neighbour line says of `otherId` on the line of `ownId`: a chapter number (`"preface"` for the root), none beside a section. */
export function neighbourPosition(
  structure: BookStructure,
  ownId: string,
  otherId: string
): number | "preface" | undefined {
  if (structure.placeOf(ownId)?.kind === "section") return undefined;
  const place = structure.placeOf(otherId);
  return place?.kind === "preface" ? "preface" : place?.chapter;
}

/** A card's covers as a neighbour description: the "no conclusion yet" placeholder says nothing, so it is blank. */
const coversText = (summary: string): string => (isPlaceholder(summary.trim()) ? "" : summary);

/**
 * True when the card's plan is not the program's to change: a chapter text that is hand-edited or kept, or a Prompt with no covers
 * (no plan the planner wrote). A text that is clean or empty and not kept is open.
 */
export function planLockedRaw(raw: string, prompt: string): boolean {
  return !mayRewriteRaw(raw) || !readBrief(prompt).covers;
}

/** One card as the chief editor reads it (a card the program may not rewrite is marked locked). */
export function planEditCardOf(
  id: string,
  place: string,
  role: BookRole,
  title: string,
  prompt: string,
  locked: boolean
): PlanEditCard {
  const brief = readBrief(prompt);
  return {
    id,
    place,
    role,
    title,
    covers: brief.covers,
    points: brief.points,
    entry: brief.entry,
    handoff: brief.handoff,
    previous: brief.previous,
    next: brief.next,
    checklist: brief.checklist.map(item => item.text),
    ...(locked || !brief.covers ? { locked: true } : {})
  };
}

/** The card a write reads and changes: the note as it is now. */
export interface PlanEditNote {
  title: string;
  prompt: string;
  detail: string;
  raw: string;
}
/** The note seams {@link writePlanEdits} needs. `mapPathOf`: the card's path while it is still on the map. `cardPathOf`: the path the run knows. */
export interface PlanEditPorts {
  mapPathOf(id: string): Promise<string | undefined>;
  cardPathOf(id: string): string | undefined;
  readCard(path: string): Promise<PlanEditNote>;
  updateNoteGuarded(
    path: string,
    patch: { prompt: string; summary?: string },
    options: { expectedContent: string; authorize: () => boolean }
  ): Promise<"written" | "discarded">;
}
export interface PlanEditWrite {
  changes: readonly PlanEditChange[];
  /** Each card's Prompt, kind and title when the changes were made: a card whose Prompt differs now is left alone. */
  seen: ReadonlyMap<string, { prompt: string; kind: CardKind; title: string }>;
  locked: ReadonlySet<string>;
  structure: BookStructure;
  /** Cards whose Summary is the reader's own (it stays when covers change). */
  ownSummary: ReadonlySet<string>;
  language: ContentLanguage;
  /** False = stop writing at once. */
  authorize: () => boolean;
}
/**
 * Writes the changes card by card (the whole Prompt composed again by {@link editedPrompt}), then updates the `next` line of the card
 * before each card whose covers changed. Returns the ids written, or `cancelled` when `authorize` turned false midway.
 */
export async function writePlanEdits(
  ports: PlanEditPorts,
  write: PlanEditWrite
): Promise<{ written: string[]; cancelled: boolean }> {
  const { authorize, structure } = write;
  const written: string[] = [];
  const moved: string[] = [];
  for (const change of write.changes) {
    if (!authorize()) return { written, cancelled: true };
    const before = write.seen.get(change.id);
    // A card the program may not rewrite (hand-edited chapter, kept) keeps its plan too.
    if (!before || write.locked.has(change.id)) continue;
    const path = await ports.mapPathOf(change.id);
    if (!path) continue;
    const current = await ports.readCard(path);
    // Only the Prompt the planner wrote: one the owner edited meanwhile is left as it is.
    if (current.prompt !== before.prompt) continue;
    // A checklist belongs to a changed covers, points or previous; on its own it is not applied.
    const prompt = editedPrompt(
      before.prompt,
      changesBrief(change) ? change : { ...change, checklist: undefined },
      before.kind,
      write.language
    );
    if (prompt === undefined) continue;
    // The map's summary follows the covers the way the plan step writes it (a reader's own summary stays).
    const patch = write.ownSummary.has(change.id) || !change.covers ? { prompt } : { prompt, summary: change.covers };
    const result = await ports.updateNoteGuarded(path, patch, { expectedContent: current.raw, authorize });
    if (result === "written") {
      written.push(change.id);
      if (change.covers) moved.push(change.id);
    }
  }
  // The card before a card whose covers changed still describes the old subject on its `next` line (the `previous` sentences are the
  // plan's own earlier-ideas text and are kept).
  for (const id of moved) {
    const above = structure.neighboursOf(id).previous;
    const abovePath = above === undefined ? undefined : ports.cardPathOf(above);
    const ownPath = ports.cardPathOf(id);
    if (above === undefined || !abovePath || !ownPath) continue;
    if (!authorize()) return { written, cancelled: true };
    const raw = await ports.readCard(abovePath);
    if (!mayRewriteRaw(raw.raw)) continue;
    const covers = coversText(parseCardPrompt((await ports.readCard(ownPath)).prompt).covers ?? "").trim();
    const prompt = covers
      ? rewriteNeighbourLine(
          raw.prompt,
          "next",
          {
            position: neighbourPosition(structure, above, id),
            title: write.seen.get(id)?.title ?? "",
            summary: covers
          },
          structure.placeOf(above)?.kind
        )
      : undefined;
    if (prompt === undefined) continue;
    await ports.updateNoteGuarded(abovePath, { prompt }, { expectedContent: raw.raw, authorize });
  }
  return { written, cancelled: !authorize() };
}
