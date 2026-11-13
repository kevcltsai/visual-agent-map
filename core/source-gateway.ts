import { contextTokens, estimateTokens, SOURCE_CONTEXT_TOKEN_BUDGET } from "../ai/context-builder";
import {
  REFERENCE_BATCH_CHARACTER_LIMIT,
  referenceBatches,
  referenceCatalog,
  type ReferenceGroup
} from "../ai/reference-materials";
import type { TaskContext } from "../ai/types";
import { sourceRegistry } from "./steps/task/fragments";

/**
 * The one exit every AI feature uses to get the map's data sources (pure: no Obsidian, no I/O of its own).
 * It reads the sources (a stop is not swallowed), scrubs them, and decides between sending the documents as they are
 * and condensing them first, by whether the FULL request fits the downstream budget.
 */

/** The request parts the downstream budget step counts (everything except the sources themselves). */
export type SourceRequestParts = Pick<
  TaskContext,
  | "title"
  | "summary"
  | "rules"
  | "detail"
  | "task"
  | "ancestors"
  | "workingFindings"
  | "sourceContext"
  | "anchorContext"
  | "subtreeOutline"
>;

/** Most model requests one condensing may send (extract + reduce), checked before sending and again while running. */
export const MAX_CONDENSE_CALLS = 16;
/** The condensed evidence is final once it is at most this many characters; longer is reduced again. */
export const CONDENSED_FINDINGS_CHARACTER_LIMIT = 18_000;

export type SourceDelivery = { kind: "none" } | { kind: "direct"; text: string } | { kind: "condense" };

/** The tokens the service lets the request use: the source budget minus the outline that is counted separately. */
export function requestBudget(parts: Pick<SourceRequestParts, "subtreeOutline">): number {
  return SOURCE_CONTEXT_TOKEN_BUDGET - estimateTokens(parts.subtreeOutline);
}

/**
 * The parts the budget step cannot give up. It cuts the old detail, the working findings and the ancestors before it touches
 * the source context (a designed order that keeps the sources whole), so those three do not count against sending the documents.
 */
function fixedParts(parts: SourceRequestParts): SourceRequestParts {
  return { ...parts, detail: "", workingFindings: "", ancestors: "" };
}

/**
 * Direct when the whole request (cards, rules, task, the caller's own source text, the source documents and the source
 * catalog; not the three parts the budget step cuts first) fits the budget the service applies; otherwise condense. The source characters alone decide
 * nothing: a small source can still overflow next to large cards.
 */
export function planSourceDelivery(
  groups: readonly ReferenceGroup[],
  parts: SourceRequestParts,
  allowDirect = true
): SourceDelivery {
  if (!groups.some(group => group.documents.length)) return { kind: "none" };
  if (!allowDirect) return { kind: "condense" };
  const text = referenceBatches([...groups]).join("\n\n");
  const full = [parts.sourceContext, text, sourceRegistry(referenceCatalog([...groups]))].filter(Boolean).join("\n\n");
  const total = contextTokens({ ...fixedParts(parts), sourceContext: full });
  return total <= requestBudget(parts) ? { kind: "direct", text } : { kind: "condense" };
}

/**
 * Worst-case request count of condensing: one extract request per batch, then reduce rounds while the findings
 * (each assumed as long as the final limit allows) would still not fit the final limit.
 */
export function estimateCondenseCalls(groups: readonly ReferenceGroup[]): number {
  let findings = referenceBatches([...groups]).length;
  let calls = findings;
  while (findings > 1) {
    findings = Math.max(
      1,
      Math.ceil((findings * CONDENSED_FINDINGS_CHARACTER_LIMIT) / REFERENCE_BATCH_CHARACTER_LIMIT)
    );
    calls += findings;
    if (calls > MAX_CONDENSE_CALLS) break;
  }
  return calls;
}

/** The source text a request carries: direct documents or condensed findings, then the catalog. */
export function sourceText(groups: readonly ReferenceGroup[], body: string, extra?: string): string {
  return [extra, body, sourceRegistry(referenceCatalog([...groups]))].filter(Boolean).join("\n\n");
}

export interface ResolveSourcesInput {
  groups: readonly ReferenceGroup[];
  parts: SourceRequestParts;
  /** Callers that must send the documents themselves when they fit (merge, synthesize). Others always condense. */
  allowDirect: boolean;
  /** Findings a caller already condensed; used as they are. */
  prepared?: string;
  /** Condenses the groups (one extraction run); called at most once, after the call estimate is under the cap. */
  condense: () => Promise<string>;
  /** Thrown when the estimate is over the cap, before anything is sent. */
  overBudget: () => Error;
}

/** Returns the text to put in the request's source context before the catalog, or "" when there are no sources. */
export async function resolveSourceDelivery(input: ResolveSourcesInput): Promise<string> {
  const plan = planSourceDelivery(input.groups, input.parts, input.allowDirect && input.prepared === undefined);
  if (plan.kind === "none") return "";
  if (input.prepared !== undefined) return input.prepared;
  if (plan.kind === "direct") return plan.text;
  if (estimateCondenseCalls(input.groups) > MAX_CONDENSE_CALLS) throw input.overBudget();
  return input.condense();
}

/** Applies `scrub` to the body of every document of every group (vault and external alike). */
export function scrubReferenceGroups(groups: ReferenceGroup[], scrub: (text: string) => string): ReferenceGroup[] {
  return groups.map(group => ({
    ...group,
    documents: group.documents.map(document => ({ ...document, content: scrub(document.content) }))
  }));
}

/** An aborted read must stay an abort; any other read failure means no sources. */
export async function readSourceGroups(
  read: (signal: AbortSignal) => Promise<ReferenceGroup[]>,
  signal: AbortSignal
): Promise<ReferenceGroup[]> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  try {
    return await read(signal);
  } catch (error) {
    if (signal.aborted || (error as { name?: string } | null)?.name === "AbortError") throw error;
    return [];
  }
}

/** The map's groups first, then the caller's own; a group whose id the map's groups already carry is not added twice. */
export function withMapSources(
  mapGroups: readonly ReferenceGroup[],
  own: readonly ReferenceGroup[] = []
): ReferenceGroup[] {
  const ids = new Set(mapGroups.map(group => group.id));
  return [...mapGroups, ...own.filter(group => !ids.has(group.id))];
}

/**
 * One condensing for a whole batch. Every child still decides for itself, with its own full request (cards, rules, task), whether
 * the documents go in whole; the children that must condense all call the returned function, the first starts the condensing and
 * the others wait for it (a failure fails each of them, nothing is sent again). `undefined` for a single child.
 */
export function sharedSourceFindings(
  childCount: number,
  condense: (signal: AbortSignal) => Promise<string>
): ((signal: AbortSignal) => Promise<string>) | undefined {
  if (childCount <= 1) return undefined;
  let shared: Promise<string> | undefined;
  return signal => (shared ??= condense(signal));
}
