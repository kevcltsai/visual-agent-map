import { newArgumentMap, type ClaimDraft } from "../../argument-map/machine-v2";
import {
  CANDIDATE_KINDS,
  CLAIM_ROLES,
  CLAIM_TYPES,
  MAX_FRAMING_CALLS,
  MAX_PREMISE_DATA,
  MAX_PREMISES,
  MAX_TESTABLE,
  type CandidateKind,
  type ClaimRole,
  type ClaimType,
  type Definition,
  type Framing
} from "../../argument-map/model";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import { ArgumentStepError, grounded, languageInstruction, list, overBudget, type ArgumentStepBase } from "./shared";
import { S, exact, flag, label, maybeText, noLinks, pick, short, strings } from "./v2-shared";
import template from "./v2-framing.md";

/** Longest original or note the step accepts. */
export const MAX_FRAMING_TEXT = 800;

export interface FramingRequest extends ArgumentStepBase {
  /** The user's own words, stored verbatim in the map. Untrusted. */
  original: string;
  /** What the user said about an earlier restatement (empty on the first call). Untrusted. */
  note: string;
  /** This call's number, 1 to `MAX_FRAMING_CALLS`; it becomes `framing.attempts` when the user locks the result. */
  attempt: number;
}
export interface FramingCandidate {
  /** A label of this reply (q1, q2); the program gives the stored id. */
  id: string;
  question: string;
  answerShape: string;
  diff: string;
  kind: CandidateKind;
  unanswered: boolean;
}
export interface FramingClaim {
  /** A label of this reply (c1, c2); `dependsOn` uses the same labels. */
  id: string;
  text: string;
  type: ClaimType;
  role: ClaimRole;
  dependsOn: string[];
  definitions: Definition[];
  /** Premises only (1 or 2): what each datum to look up is. Testable claims have none. */
  dataNeeds: string[];
}
export interface FramingResult {
  restatement: string;
  presuppositions: string[];
  loadedTerms: string[];
  vagueTerms: string[];
  outOfScope: string[];
  candidates: FramingCandidate[];
  /** A candidate id: the model's suggestion; the user may pick another before locking. */
  chosen: string;
  claims: FramingClaim[];
  settings: string[];
  /** How the claims' answers combine into an answer to the original; empty means they do not, so the original gets no overall answer. */
  composition: string;
}

const MAX_LIST = 8;
const MAX_CANDIDATES = 3;

export const FRAMING_SCHEMA = S.obj({
  restatement: S.str,
  presuppositions: S.arr(S.str, 0, MAX_LIST),
  loadedTerms: S.arr(S.str, 0, MAX_LIST),
  vagueTerms: S.arr(S.str, 0, MAX_LIST),
  outOfScope: S.arr(S.str, 0, MAX_LIST),
  candidates: S.arr(
    S.obj({
      id: S.str,
      question: S.str,
      answerShape: S.str,
      diff: S.str,
      kind: S.enum(CANDIDATE_KINDS),
      unanswered: S.bool
    }),
    1,
    MAX_CANDIDATES
  ),
  chosen: S.str,
  claims: S.arr(
    S.obj({
      id: S.str,
      text: S.str,
      type: S.enum(CLAIM_TYPES),
      role: S.enum(CLAIM_ROLES),
      dependsOn: S.arr(S.str, 0, MAX_PREMISES),
      definitions: S.arr(S.obj({ term: S.str, meaning: S.str }), 1, 6),
      dataNeeds: S.arr(S.str, 0, MAX_PREMISE_DATA)
    }),
    1,
    MAX_PREMISES + MAX_TESTABLE
  ),
  settings: S.arr(S.str, 0, MAX_LIST),
  composition: S.free
});

/** The map's own ids never look like a reply label, so a dry run cannot collide with one. */
const DRY = (name: string): string => `~${name}`;

/**
 * What the program will lock, with the user's choice and edits applied. Used by the parser (a dry run of `newArgumentMap`, so a framing
 * the machine would refuse is refused here and counts as a failed call) and by the runner when the user confirms.
 */
export function lockedFraming(
  original: string,
  result: FramingResult,
  attempts: number,
  lockedAt: string,
  chosen: string = result.chosen
): Framing {
  return {
    original,
    restatement: result.restatement,
    presuppositions: [...result.presuppositions],
    loadedTerms: [...result.loadedTerms],
    vagueTerms: [...result.vagueTerms],
    outOfScope: [...result.outOfScope],
    candidates: result.candidates.map(c => ({ ...c })),
    chosen,
    settings: [...result.settings],
    ...(result.composition ? { composition: result.composition } : {}),
    attempts,
    lockedAt
  };
}

/** `newArgumentMap`'s claim drafts for a framing result, with the reply's labels as ids. The runner swaps in real ids and node ids. */
export function claimDrafts(
  result: FramingResult,
  dataId: (claim: string, index: number) => string,
  nodeId: (claim: string) => string
): ClaimDraft[] {
  return result.claims.map(c => ({
    id: c.id,
    text: c.text,
    type: c.type,
    role: c.role,
    dependsOn: [...c.dependsOn],
    definitions: c.definitions.map(d => ({ ...d })),
    ...(c.role === "premise"
      ? { data: c.dataNeeds.map((need, index) => ({ id: dataId(c.id, index), need })) }
      : { comparisonNodeId: nodeId(c.id) })
  }));
}

function dryRun(request: FramingRequest, result: FramingResult): void {
  try {
    newArgumentMap(lockedFraming(request.original, result, request.attempt, "dry-run"), {
      runId: DRY("run"),
      roles: { proposition: DRY("role-p"), premises: DRY("role-r"), conclusion: DRY("role-c") },
      claims: claimDrafts(
        result,
        (claim, index) => DRY(`${claim}-d${index}`),
        claim => DRY(`${claim}-cmp`)
      )
    });
  } catch (error) {
    throw new ArgumentStepError(
      `The breakdown is not a legal map: ${error instanceof Error ? error.message : "refused"}`
    );
  }
}

export function parseFraming(raw: string, request: FramingRequest): FramingResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ArgumentStepError("The reply is not JSON");
  }
  const item = exact(
    value,
    [
      "restatement",
      "presuppositions",
      "loadedTerms",
      "vagueTerms",
      "outOfScope",
      "candidates",
      "chosen",
      "claims",
      "settings",
      "composition"
    ],
    "The reply"
  );
  const restatement = short(item.restatement, "restatement");
  const presuppositions = strings(item.presuppositions, "presuppositions", 0, MAX_LIST);
  const loadedTerms = strings(item.loadedTerms, "loadedTerms", 0, MAX_LIST);
  const vagueTerms = strings(item.vagueTerms, "vagueTerms", 0, MAX_LIST);
  const outOfScope = strings(item.outOfScope, "outOfScope", 0, MAX_LIST);
  const settings = strings(item.settings, "settings", 0, MAX_LIST);
  const composition = maybeText(item.composition, "composition");

  const candidateEntries = list(item.candidates, "candidates");
  if (!candidateEntries.length || candidateEntries.length > MAX_CANDIDATES)
    throw new ArgumentStepError(`expected 1 to ${MAX_CANDIDATES} candidates`);
  const candidates = candidateEntries.map((entry, index): FramingCandidate => {
    const one = exact(entry, ["id", "question", "answerShape", "diff", "kind", "unanswered"], `candidate ${index + 1}`);
    const candidate = {
      id: label(one.id, "candidate id"),
      question: short(one.question, "question"),
      answerShape: short(one.answerShape, "answerShape"),
      diff: short(one.diff, "diff"),
      kind: pick(CANDIDATE_KINDS, one.kind, "kind"),
      unanswered: flag(one.unanswered, "unanswered")
    };
    if (candidate.kind === "related" && !candidate.unanswered)
      throw new ArgumentStepError("a related question leaves part of the original unanswered");
    return candidate;
  });
  if (new Set(candidates.map(c => c.id)).size !== candidates.length)
    throw new ArgumentStepError("a candidate id repeats");
  const chosen = label(item.chosen, "chosen");
  if (!candidates.some(c => c.id === chosen)) throw new ArgumentStepError("chosen is not a candidate");

  const claimEntries = list(item.claims, "claims");
  const claims = claimEntries.map((entry, index): FramingClaim => {
    const one = exact(
      entry,
      ["id", "text", "type", "role", "dependsOn", "definitions", "dataNeeds"],
      `claim ${index + 1}`
    );
    const definitions = list(one.definitions, "definitions").map(d => {
      const def = exact(d, ["term", "meaning"], "definition");
      return { term: short(def.term, "term"), meaning: short(def.meaning, "meaning") };
    });
    if (!definitions.length) throw new ArgumentStepError("every claim needs a definition");
    return {
      id: label(one.id, "claim id"),
      text: short(one.text, "claim text"),
      type: pick(CLAIM_TYPES, one.type, "type"),
      role: pick(CLAIM_ROLES, one.role, "role"),
      dependsOn: strings(one.dependsOn, "dependsOn", 0, MAX_PREMISES),
      definitions,
      dataNeeds: strings(one.dataNeeds, "dataNeeds", 0, MAX_PREMISE_DATA)
    };
  });
  const result: FramingResult = {
    restatement,
    presuppositions,
    loadedTerms,
    vagueTerms,
    outOfScope,
    candidates,
    chosen,
    claims,
    settings,
    composition
  };
  // The machine's own legality (types, roles, dependencies, limits), then the step's extra rules.
  dryRun(request, result);
  for (const claim of claims)
    if (claim.role === "testable" && claim.dataNeeds.length)
      throw new ArgumentStepError("only a premise lists data needs");
  // Numbers and links: the original and the user's note are the only source. Definitions and settings are what the user confirms, so they
  // may carry numbers (a period, a threshold) but never a link; the data needs may reuse what they say.
  const confirmed = [...settings, ...claims.flatMap(c => c.definitions.flatMap(d => [d.term, d.meaning]))];
  noLinks(confirmed);
  const origin = [request.original, request.note];
  grounded(
    [
      restatement,
      ...presuppositions,
      ...loadedTerms,
      ...vagueTerms,
      ...outOfScope,
      composition,
      ...candidates.flatMap(c => [c.question, c.answerShape, c.diff]),
      ...claims.flatMap(c => [c.text, ...c.definitions.map(d => d.term)])
    ],
    origin
  );
  grounded(
    claims.flatMap(c => c.dataNeeds),
    [...origin, ...confirmed]
  );
  return result;
}

/** Restate and break down the original claim; the user confirms (and may re-ask, up to `MAX_FRAMING_CALLS`) before a map exists. Text-only. */
export const framingStep: StepDefinition<FramingRequest, FramingResult> = {
  id: "argument-map.v2-framing",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.original),
      attempt: String(request.attempt),
      maxAttempts: String(MAX_FRAMING_CALLS),
      original: JSON.stringify(request.original),
      note: JSON.stringify(request.note)
    }),
  schema: FRAMING_SCHEMA,
  policy: (prompt, request) => {
    if (!Number.isInteger(request.attempt) || request.attempt < 1 || request.attempt > MAX_FRAMING_CALLS)
      throw new ArgumentStepError("the restatement budget is used up");
    if (!request.original.trim() || request.original.length > MAX_FRAMING_TEXT)
      throw new ArgumentStepError("the original claim is empty or too long");
    if (request.note.length > MAX_FRAMING_TEXT) throw new ArgumentStepError("the note is too long");
    overBudget(prompt, FRAMING_SCHEMA);
  },
  parse: parseFraming
};
