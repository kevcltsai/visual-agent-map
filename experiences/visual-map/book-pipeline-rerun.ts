import { latestStoredProof, type StoredProofView } from "../../core/book-pipeline/note-sections";
import type { PipelineStage } from "../../core/book-pipeline/model";

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
    const address = match[0].replace(TRAILING, "");
    if (Array.from(address).length > MAX_SOURCE_CHARS) continue;
    try {
      if (new URL(address).protocol !== "https:" || !new URL(address).hostname) continue;
    } catch {
      continue;
    }
    found.push(address);
  }
  return found;
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

/** The addresses a card's proof could not check: sources of the fact items that are unverified or unmet. */
export function unverifiedSourceUrls(proof: StoredProofView | undefined): string[] {
  if (!proof) return [];
  return cleanAvoidSources(
    proof.items
      .filter(item => item.type === "fact" && (item.status === "unverified" || item.status === "unmet"))
      .flatMap(item => item.sources)
  );
}

/**
 * The one line the plan step (and the author) gets for "use other sources". It is built here from constant words and the cleaned
 * addresses (each a JSON string), so no untrusted sentence is ever part of an instruction.
 */
export function avoidSourcesInstruction(addresses: readonly string[]): string {
  const clean = cleanAvoidSources(addresses);
  const head = "Do not rely on sources that could not be opened and checked; use other sources that can be opened and checked.";
  return clean.length ? head + " Not usable: " + clean.map(address => JSON.stringify(address)).join(" ") : head;
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
export function sameReviewResult(before: CardResultSnapshot | undefined, after: CardResultSnapshot | undefined): boolean {
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
