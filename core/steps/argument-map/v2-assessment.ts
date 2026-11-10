import type { AssessmentDraft } from "../../argument-map/machine-v2";
import {
  EVIDENCE_STANCES,
  type ArgumentMapData,
  type Claim,
  type Criteria,
  type Definition
} from "../../argument-map/model";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import { ArgumentStepError, grounded, languageInstruction, list, overBudget, type ArgumentStepBase } from "./shared";
import { S, exact, flag, fromRequest, idsFrom, maybeText, pick, short } from "./v2-shared";
import template from "./v2-assessment.md";

/** One found piece of evidence. `criteria` is null for premise data, which have none. `replaces` is the dead need's text, or null. */
export interface AssessmentItem {
  id: string;
  need: string;
  criteria: Criteria | null;
  replaces: string | null;
  claim: string;
  quote: string;
  url: string;
}
export interface AssessmentSibling {
  /** Another hypothesis of the same claim. Only its prediction texts are shown, never its evidence or verdict. */
  id: string;
  predictions: string[];
}
export interface AssessmentRequest extends ArgumentStepBase {
  scope: { claim: string; definitions: Definition[] };
  items: AssessmentItem[];
  siblings: AssessmentSibling[];
}
export interface AssessmentEntry {
  /** A premise datum id or a need id, as in the request. */
  id: string;
  assessment: AssessmentDraft;
  /** Replacement needs only; null otherwise. */
  sameCondition: boolean | null;
}
export interface AssessmentResult {
  assessments: AssessmentEntry[];
}

export const ASSESSMENT_SCHEMA = S.obj({
  assessments: S.arr(
    S.obj({
      id: S.str,
      relevant: S.bool,
      stance: S.enum(EVIDENCE_STANCES),
      scopeFit: S.bool,
      scopeNote: S.free,
      sourceType: S.str,
      underlyingSource: S.str,
      alsoRelevantTo: S.arr(S.str),
      sameCondition: { type: ["boolean", "null"] }
    }),
    1
  )
});

// ---- what the step may see ---------------------------------------------------------------------------------------------------------
const scopeOf = (claim: Claim): AssessmentRequest["scope"] => ({
  claim: claim.text,
  definitions: claim.definitions.map(d => ({ term: d.term, meaning: d.meaning }))
});

/** The premise's data waiting for an assessment (found, with a source, not yet assessed). Refused when there is none. */
export function premiseAssessmentParts(claim: Claim): Pick<AssessmentRequest, "scope" | "items" | "siblings"> {
  const data = claim.data ?? [];
  if (data.some(d => d.state !== "found" || !d.proof))
    throw new ArgumentStepError("every premise datum must be found first");
  const todo = data.filter(d => !d.assessment);
  if (!todo.length) throw new ArgumentStepError("no premise datum is waiting for an assessment");
  return {
    scope: scopeOf(claim),
    items: todo.map(d => ({
      id: d.id,
      need: d.need,
      criteria: null,
      replaces: null,
      claim: d.proof!.claim,
      quote: d.proof!.quote,
      url: d.proof!.url
    })),
    siblings: []
  };
}

/** One hypothesis' found, unassessed needs, plus the other hypotheses' prediction texts of the same claim. Refused when the round is open. */
export function needAssessmentParts(
  state: ArgumentMapData,
  hypothesisId: string
): Pick<AssessmentRequest, "scope" | "items" | "siblings"> {
  const h = state.hypotheses.find(o => o.id === hypothesisId);
  if (!h) throw new ArgumentStepError("unknown hypothesis");
  const claim = state.claims.find(c => c.id === h.claimId);
  if (!claim) throw new ArgumentStepError("unknown claim");
  if (h.needs.some(n => n.state === "pending" || n.state === "searching"))
    throw new ArgumentStepError("the round is still being researched");
  const todo = h.needs.filter(n => n.state === "found" && !n.assessment && n.proof);
  if (!todo.length) throw new ArgumentStepError("no need is waiting for an assessment");
  return {
    scope: scopeOf(claim),
    items: todo.map(n => ({
      id: n.id,
      need: n.text,
      criteria: { ...n.criteria },
      replaces: n.replaces === undefined ? null : (h.needs.find(o => o.id === n.replaces)?.text ?? null),
      claim: n.proof!.claim,
      quote: n.proof!.quote,
      url: n.proof!.url
    })),
    siblings: state.hypotheses
      .filter(o => o.claimId === h.claimId && o.id !== h.id)
      .map(o => ({ id: o.id, predictions: o.predictions.map(p => p.text) }))
  };
}

const itemCopy = (i: AssessmentItem): AssessmentItem => ({
  id: i.id,
  need: i.need,
  criteria: i.criteria
    ? { supports: i.criteria.supports, refutes: i.criteria.refutes, irrelevant: i.criteria.irrelevant }
    : null,
  replaces: i.replaces,
  claim: i.claim,
  quote: i.quote,
  url: i.url
});
export const assessmentTexts = (request: AssessmentRequest): string[] => [
  request.scope.claim,
  ...request.scope.definitions.flatMap(d => [d.term, d.meaning]),
  ...request.items.flatMap(i => [
    i.need,
    ...(i.criteria ? [i.criteria.supports, i.criteria.refutes, i.criteria.irrelevant] : []),
    ...(i.replaces ? [i.replaces] : []),
    i.claim,
    i.quote,
    i.url
  ])
];

export function parseAssessment(raw: string, request: AssessmentRequest): AssessmentResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ArgumentStepError("The reply is not JSON");
  }
  const top = exact(value, ["assessments"], "The reply");
  const entries = list(top.assessments, "assessments");
  const byId = new Map(request.items.map(i => [i.id, i]));
  if (entries.length !== byId.size) throw new ArgumentStepError("assess every item, once");
  const siblingIds = new Set(request.siblings.map(s => s.id));
  const done = new Map<string, AssessmentEntry>();
  const free: string[] = [];
  for (const entry of entries) {
    const one = exact(
      entry,
      [
        "id",
        "relevant",
        "stance",
        "scopeFit",
        "scopeNote",
        "sourceType",
        "underlyingSource",
        "alsoRelevantTo",
        "sameCondition"
      ],
      "an assessment"
    );
    const id = fromRequest(one.id, new Set(byId.keys()), "id");
    if (done.has(id)) throw new ArgumentStepError("assess every item, once");
    const item = byId.get(id)!;
    const relevant = flag(one.relevant, "relevant");
    const stance = pick(EVIDENCE_STANCES, one.stance, "stance");
    const scopeFit = flag(one.scopeFit, "scopeFit");
    const scopeNote = maybeText(one.scopeNote, "scopeNote");
    if (relevant !== (stance !== "irrelevant")) throw new ArgumentStepError("relevant and stance disagree");
    if (!scopeFit && !scopeNote) throw new ArgumentStepError("a scope miss needs a note");
    const sourceType = short(one.sourceType, "sourceType");
    const underlyingSource = short(one.underlyingSource, "underlyingSource");
    const alsoRelevantTo = idsFrom(one.alsoRelevantTo, siblingIds, "alsoRelevantTo");
    let sameCondition: boolean | null = null;
    if (item.replaces !== null) sameCondition = flag(one.sameCondition, "sameCondition");
    else if (one.sameCondition !== null) throw new ArgumentStepError("sameCondition belongs to a replacement need");
    free.push(scopeNote, sourceType, underlyingSource);
    const assessment: AssessmentDraft = { relevant, stance, scopeFit, sourceType, underlyingSource, alsoRelevantTo };
    if (scopeNote) assessment.scopeNote = scopeNote;
    done.set(id, { id, assessment, sameCondition });
  }
  grounded(free, assessmentTexts(request));
  return { assessments: request.items.map(i => done.get(i.id)!) };
}

/** `applyPremiseAssessments` input. */
export const premiseAssessmentItems = (result: AssessmentResult): { datumId: string; assessment: AssessmentDraft }[] =>
  result.assessments.map(a => ({ datumId: a.id, assessment: a.assessment }));
/** `applyEvidenceAssessment` input: `sameCondition` is left out unless the need is a replacement. */
export const needAssessmentItems = (
  result: AssessmentResult
): { needId: string; assessment: AssessmentDraft; sameCondition?: boolean }[] =>
  result.assessments.map(a => ({
    needId: a.id,
    assessment: a.assessment,
    ...(a.sameCondition === null ? {} : { sameCondition: a.sameCondition })
  }));

/** The independent evidence assessment of a settled round (or of a premise's data). Text-only; sees no verdict and no other evidence. */
export const assessmentStep: StepDefinition<AssessmentRequest, AssessmentResult> = {
  id: "argument-map.v2-assessment",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.scope.claim),
      scope: JSON.stringify({
        claim: request.scope.claim,
        definitions: request.scope.definitions.map(d => ({ term: d.term, meaning: d.meaning }))
      }),
      items: JSON.stringify(request.items.map(itemCopy)),
      others: JSON.stringify(request.siblings.map(s => ({ id: s.id, predictions: [...s.predictions] })))
    }),
  schema: ASSESSMENT_SCHEMA,
  policy: (prompt, request) => {
    if (!request.items.length) throw new ArgumentStepError("nothing to assess");
    if (new Set(request.items.map(i => i.id)).size !== request.items.length)
      throw new ArgumentStepError("an item repeats");
    overBudget(prompt, ASSESSMENT_SCHEMA);
  },
  parse: parseAssessment
};
