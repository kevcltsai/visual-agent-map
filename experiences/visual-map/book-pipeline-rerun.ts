import { latestStoredProof, neutralizeText } from "../../core/book-pipeline/note-sections";
import type { PipelineStage } from "../../core/book-pipeline/model";
import { lengthNeeded, lengthTarget, type LengthReason } from "../../core/book-pipeline/settings";
import { isBookCheckId } from "../../core/book-pipeline/proof";

/**
 * Pure helpers of a single-card rerun at gate 2 (T5): the unverified sources a card names, the one-line instruction "use other
 * sources" (composed by the program, never typed by the model or the owner), and the in-memory comparison that tells whether a
 * rerun changed the result. Nothing here is saved to a note or to the map file.
 */

/** At most this many addresses go into the instruction, each at most {@link MAX_SOURCE_CHARS} characters. */
export const MAX_AVOID_SOURCES = 5;
export const MAX_SOURCE_CHARS = 200;

const ADDRESS = /https:\/\/[^\s<>"'`()[\]\\{}|^]+/g;
const TRAILING = /[.,;:!?，。；：！？、]+$/;

/** Standard https addresses found in some text: parsed, with a host, trailing punctuation cut; anything else is ignored. */
export function httpsAddresses(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(ADDRESS)) {
    // The normal form (a non-ASCII path becomes %XX), so the length limit counts what the instruction really carries.
    let address: string;
    try {
      const url = new URL(match[0].replace(TRAILING, ""));
      if (url.protocol !== "https:" || !url.hostname) continue;
      address = url.href;
    } catch {
      continue;
    }
    if (Array.from(address).length > MAX_SOURCE_CHARS) continue;
    found.push(address);
  }
  return found;
}

/**
 * Why a card's right-click "rerun this card" cannot be used now ("ok" when it can). Order matters: a rerun in progress is named
 * first (this card or another), then the whole book running, then this card busy with something else, then a chat holding the map.
 */
export type BookRerunMenuReason = "ok" | "this" | "other" | "running" | "blocked";
export function bookRerunMenuReason(input: {
  nodeId: string;
  rerunNodeId?: string;
  active: boolean;
  busyCards: readonly string[];
  blocked: boolean;
}): BookRerunMenuReason {
  if (input.rerunNodeId !== undefined) return input.rerunNodeId === input.nodeId ? "this" : "other";
  if (input.active) return "running";
  if (input.busyCards.includes(input.nodeId)) return "this";
  if (input.blocked) return "blocked";
  return "ok";
}

/** Cleans a list of candidate addresses (untrusted): https only, no repeats, each within the limit, at most five. */
export function cleanAvoidSources(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    for (const address of httpsAddresses(value)) {
      if (!out.includes(address)) out.push(address);
      if (out.length >= MAX_AVOID_SOURCES) return out;
    }
  }
  return out;
}

/**
 * The one line the plan step (and the author) gets for "use other sources". It is built here from constant words and the cleaned
 * addresses (each a JSON string), so no untrusted sentence is ever part of an instruction.
 */
export function avoidSourcesInstruction(addresses: readonly string[]): string {
  const clean = cleanAvoidSources(addresses);
  const head =
    "Do not rely on sources that could not be opened and checked; use other sources that can be opened and checked.";
  return clean.length ? head + " Not usable: " + clean.map(address => JSON.stringify(address)).join(" ") : head;
}

const FIX_INSTRUCTION_MAX = 1000;
const FIX_ITEM_MAX = 140;
/** The "do not use these" list never takes more than this, so the unmet points always have room. */
const FIX_AVOID_MAX = 450;
const oneLine = (value: string, max: number): string =>
  Array.from(value.replace(/\s+/g, " ").trim()).slice(0, max).join("");
/**
 * The automatic redo's one line when the proofread did not pass: constant words plus, for each fact point that did not hold, its
 * checklist text and the verifier's note, each as a JSON string cut to a few hundred characters (so a model sentence is data in
 * quotes, never an instruction line), then the `[!vam-book]` callout type neutralized. Only the author gets it; the proofread never does.
 * Unverified sources become the "do not use these" list of {@link avoidSourcesInstruction}.
 */
export function proofFixInstruction(
  items: readonly { id: string; type: string; status: string; note: string; sources: readonly string[] }[],
  checklist: readonly { id: string; text: string }[],
  length?: LengthReason
): string {
  const failed = items.filter(item => item.type === "fact" && item.status === "unmet");
  // The whole-book points (names, research voice, repetition) first: they are short and a long chapter point must not squeeze them out.
  const structure = items
    .filter(item => item.type !== "fact" && item.status === "unmet")
    .sort((a, b) => Number(isBookCheckId(b.id)) - Number(isBookCheckId(a.id)));
  let sources = cleanAvoidSources(
    items.filter(item => item.type === "fact" && item.status !== "met").flatMap(item => item.sources)
  );
  // Whole pieces only: a cut in the middle of a JSON string would leave an unclosed quote, so what does not fit is left out.
  while (sources.length && avoidSourcesInstruction(sources).length > FIX_AVOID_MAX) sources = sources.slice(0, -1);
  const avoid = avoidSourcesInstruction(sources);
  // Every redo edits the chapter in place (`bookExpandRequirements`): its points are fixed with change blocks, never a rewrite.
  const lead =
    "The chapter failed the fact check on these points (JSON strings; correct each with a @@replace block so it is correct and supported): ";
  const leadStructure =
    "The chapter did not meet these structure points of its checklist (JSON strings; cover them in the chapter text with @@insert or @@replace blocks, not in the sources list): ";
  // The length point is short and fixed (numbers and constant words), so it is reserved first and never squeezed out by long notes.
  // Too short: new text in @@insert blocks; too long: shorter passages in @@replace blocks.
  const lengthPiece = length
    ? length.kind === "under"
      ? `The chapter came out at only ${length.measured} ${length.unit}, short of the asked ${length.min} to ${length.max} ${length.unit}: add about ${lengthNeeded(length)} ${length.unit} of new text in @@insert blocks as the expansion rules say; keep every checklist point. `
      : `The chapter is ${length.measured} ${length.unit} long, over the asked ${length.min} to ${length.max} ${length.unit}: shorten it to at most ${length.max} ${length.unit}, about ${lengthTarget(length)} ${length.unit}, with @@replace blocks; keep every checklist point and every picture. `
    : "";
  let room = FIX_INSTRUCTION_MAX - avoid.length - 1 - lengthPiece.length;
  const piece = (list: typeof items, intro: string): string => {
    const before = room;
    room -= intro.length;
    const points: string[] = [];
    for (const item of list) {
      const text = checklist.find(entry => entry.id === item.id)?.text ?? "";
      // A whole-book point's note is the program's or verifier's exact reason (which name, which phrase): it goes first so a cut keeps it.
      const pair = isBookCheckId(item.id) ? `${item.note} / ${text}` : `${text} / ${item.note}`;
      const point = JSON.stringify(oneLine(pair, FIX_ITEM_MAX * 2));
      if (point.length + 1 > room) break;
      points.push(point);
      room -= point.length + 1;
    }
    if (!points.length) room = before;
    return points.length ? intro + points.join(" ") + " " : "";
  };
  const text = piece(failed, lead) + piece(structure, leadStructure) + lengthPiece;
  return neutralizeText(text + avoid);
}
/** What a rerun compares: the stage, the issue code and each proof item's id, status and sources. In memory only. */
export interface CardResultSnapshot {
  stage: PipelineStage | undefined;
  issue: string;
  items: string[];
}
export function cardResultSnapshot(
  stage: PipelineStage | undefined,
  issue: string | undefined,
  detail: string
): CardResultSnapshot {
  const proof = latestStoredProof(detail);
  return {
    stage,
    issue: issue ?? "",
    items: (proof?.items ?? []).map(item => [item.id, item.status, ...item.sources].join("|"))
  };
}
/** A card that needs a person before and after, with the same issue code and the same items, ids, statuses and sources. */
export function sameReviewResult(
  before: CardResultSnapshot | undefined,
  after: CardResultSnapshot | undefined
): boolean {
  return (
    !!before &&
    !!after &&
    before.stage === "needs-review" &&
    after.stage === "needs-review" &&
    before.issue === after.issue &&
    before.items.length === after.items.length &&
    before.items.every((item, at) => item === after.items[at])
  );
}
