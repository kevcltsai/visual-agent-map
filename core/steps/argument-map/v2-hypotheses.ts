import type { HypothesisDraft, PredictionDraft } from "../../argument-map/machine-v2";
import {
  MAX_HYPOTHESES,
  OVERLAP_STRENGTHS,
  PREDICTION_KINDS,
  type ArgumentMapData,
  type ClaimType,
  type Definition,
  type HypothesisRole
} from "../../argument-map/model";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import { ArgumentStepError, grounded, languageInstruction, list, overBudget, type ArgumentStepBase } from "./shared";
import { S, exact, flag, fromRequest, maybeText, pick, short, strings } from "./v2-shared";
import template from "./v2-hypotheses.md";
import firstRules from "./v2-hypotheses-first.md";
import alternativeRules from "./v2-hypotheses-alternatives.md";

export type HypothesesMode = "first" | "alternatives";

export interface HypothesesPremise {
  id: string;
  text: string;
  /** holds, fails, insufficient, or "pending" while it is still being checked. */
  result: string;
}
export interface HypothesesExisting {
  id: string;
  role: string;
  /** Prediction texts only: no evidence, no verdict. */
  predictions: { kind: string; text: string }[];
}
export interface HypothesesV2Request extends ArgumentStepBase {
  /** The locked restatement of the chosen question. */
  restatement: string;
  claim: { id: string; text: string; type: ClaimType; definitions: Definition[] };
  premises: HypothesesPremise[];
  mode: HypothesesMode;
  /** Ids the program reserved for the hypotheses of this reply, in order. The reply writes 1 to `ids.length` of them. */
  ids: string[];
  /** The claim's hypotheses already on the map (mode alternatives only). */
  existing: HypothesesExisting[];
  /** The comparison's description of the missed alternative (mode alternatives only), otherwise empty. */
  gap: string;
}
export interface HypothesesV2Result {
  /** `applyHypotheses` (mode first) or `applyAlternativeHypotheses` (mode alternatives) takes this as is. */
  hypotheses: HypothesisDraft[];
}

const CAUSAL_ROLES: readonly HypothesisRole[] = ["primary", "alternative", "reverse", "common_cause"];
/** The roles each claim type may take (the same table as the machine's gate). */
export const ROLES_OF: Record<ClaimType, readonly HypothesisRole[]> = {
  fact: ["facet"],
  causal: CAUSAL_ROLES,
  main_cause: CAUSAL_ROLES,
  comparison: ["primary", "alternative", "measurement"]
};
const MAX_PREDICTIONS = 5;

export const HYPOTHESES_V2_SCHEMA = S.obj({
  hypotheses: S.arr(
    S.obj({
      id: S.str,
      role: S.enum(["primary", "alternative", "reverse", "common_cause", "measurement", "facet"]),
      predictions: S.arr(
        S.obj({
          kind: S.enum(PREDICTION_KINDS),
          text: S.str,
          required: S.bool,
          alsoPredictedBy: S.arr(S.obj({ hypothesisId: S.str, strength: S.enum(OVERLAP_STRENGTHS) })),
          auxiliary: S.arr(S.str),
          reason: S.free
        }),
        2,
        MAX_PREDICTIONS
      ),
      identification: {
        anyOf: [{ type: "null" }, S.obj({ strategy: S.str, assumptions: S.arr(S.str, 1, 6) })]
      }
    }),
    1,
    MAX_HYPOTHESES
  )
});

// ---- what the step may see ---------------------------------------------------------------------------------------------------------
/**
 * The request parts for one claim: its text and definitions, the premises with their results, the claim's own existing hypotheses (their
 * prediction texts only) and `count` fresh ids. Refused when the machine would refuse the action anyway.
 */
export function hypothesesParts(
  state: ArgumentMapData,
  claimId: string,
  mode: HypothesesMode,
  ids: string[],
  gap = ""
): Omit<HypothesesV2Request, keyof ArgumentStepBase | "restatement"> {
  const claim = state.claims.find(c => c.id === claimId);
  if (!claim || claim.role !== "testable") throw new ArgumentStepError("hypotheses belong to a testable claim");
  const own = state.hypotheses.filter(h => h.claimId === claimId);
  if (mode === "first" && own.length) throw new ArgumentStepError("the claim already has hypotheses");
  if (mode === "alternatives" && !own.length) throw new ArgumentStepError("there is nothing to add an alternative to");
  return {
    claim: {
      id: claim.id,
      text: claim.text,
      type: claim.type,
      definitions: claim.definitions.map(d => ({ term: d.term, meaning: d.meaning }))
    },
    premises: state.claims
      .filter(c => c.role === "premise")
      .map(c => ({ id: c.id, text: c.text, result: c.result ?? "pending" })),
    mode,
    ids: [...ids],
    existing: own.map(h => ({
      id: h.id,
      role: h.role,
      predictions: h.predictions.map(p => ({ kind: p.kind, text: p.text }))
    })),
    gap: mode === "alternatives" ? gap : ""
  };
}

const sourcesOf = (request: HypothesesV2Request): string[] => [
  request.restatement,
  request.claim.text,
  ...request.claim.definitions.flatMap(d => [d.term, d.meaning]),
  ...request.premises.map(p => p.text),
  ...request.existing.flatMap(h => h.predictions.map(p => p.text)),
  request.gap
];

/** The roles and counts a reply must have: the machine's floor for a first batch, any 1+ non-primary roles for a late one. */
function checkRoles(request: HypothesesV2Request, roles: HypothesisRole[]): void {
  const type = request.claim.type;
  const n = (role: HypothesisRole): number => roles.filter(r => r === role).length;
  if (request.mode === "alternatives") {
    if (roles.some(r => r === "primary" || !ROLES_OF[type].includes(r)))
      throw new ArgumentStepError("a late alternative cannot take this role");
    return;
  }
  if (roles.some(r => !ROLES_OF[type].includes(r)))
    throw new ArgumentStepError("a hypothesis role does not fit the claim type");
  if (type === "fact" && n("facet") < 2) throw new ArgumentStepError("a fact needs at least 2 facets");
  if (type === "comparison" && !(n("primary") === 1 && n("alternative") >= 1 && n("measurement") >= 1))
    throw new ArgumentStepError("a comparison needs A, B and a measurement explanation");
  if ((type === "causal" || type === "main_cause") && !(n("primary") === 1 && roles.length >= 3))
    throw new ArgumentStepError("a cause needs H-Y and 2 alternatives");
}

export function parseHypothesesV2(raw: string, request: HypothesesV2Request): HypothesesV2Result {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ArgumentStepError("The reply is not JSON");
  }
  const top = exact(value, ["hypotheses"], "The reply");
  const entries = list(top.hypotheses, "hypotheses");
  if (!entries.length || entries.length > request.ids.length)
    throw new ArgumentStepError(`expected 1 to ${request.ids.length} hypotheses`);
  const batch = request.ids.slice(0, entries.length);
  const premiseIds = new Set(request.premises.map(p => p.id));
  const causalClaim = request.claim.type === "causal" || request.claim.type === "main_cause";
  const texts: string[] = [];
  const drafts = entries.map((entry, index): HypothesisDraft => {
    const one = exact(entry, ["id", "role", "predictions", "identification"], `hypothesis ${index + 1}`);
    if (one.id !== batch[index]) throw new ArgumentStepError("hypothesis ids must be the reserved ids, in order");
    const id = batch[index];
    const role = pick(
      ["primary", "alternative", "reverse", "common_cause", "measurement", "facet"] as const,
      one.role,
      "role"
    );
    // Who may be named as also predicting: the others of this reply and, for a late batch, the claim's earlier hypotheses.
    const known = new Set([...batch, ...(request.mode === "alternatives" ? request.existing.map(h => h.id) : [])]);
    known.delete(id);
    const predictionEntries = list(one.predictions, "predictions");
    if (predictionEntries.length < 2 || predictionEntries.length > MAX_PREDICTIONS)
      throw new ArgumentStepError(`a hypothesis needs 2 to ${MAX_PREDICTIONS} predictions`);
    const predictions = predictionEntries.map((p, at): PredictionDraft => {
      const pr = exact(p, ["kind", "text", "required", "alsoPredictedBy", "auxiliary", "reason"], "a prediction");
      const kind = pick(PREDICTION_KINDS, pr.kind, "kind");
      const text = short(pr.text, "prediction text");
      const required = flag(pr.required, "required");
      const reason = maybeText(pr.reason, "reason");
      const also = list(pr.alsoPredictedBy, "alsoPredictedBy").map(o => {
        const row = exact(o, ["hypothesisId", "strength"], "alsoPredictedBy entry");
        return {
          hypothesisId: fromRequest(row.hypothesisId, known, "alsoPredictedBy"),
          strength: pick(OVERLAP_STRENGTHS, row.strength, "strength")
        };
      });
      const auxiliary = list(pr.auxiliary, "auxiliary").map(a => fromRequest(a, premiseIds, "auxiliary"));
      if (new Set(also.map(o => o.hypothesisId)).size !== also.length)
        throw new ArgumentStepError("alsoPredictedBy repeats a hypothesis");
      if (new Set(auxiliary).size !== auxiliary.length) throw new ArgumentStepError("auxiliary repeats a premise");
      texts.push(text, reason);
      const draft: PredictionDraft = { id: `${id}-p${at + 1}`, kind, text, required };
      if (kind === "support") {
        if (auxiliary.length || reason)
          throw new ArgumentStepError("a support prediction has no auxiliary premises or reason");
        draft.alsoPredictedBy = also;
      } else if (kind === "refute") {
        if (also.length) throw new ArgumentStepError("only a support prediction says who else predicts it");
        if (!auxiliary.length) throw new ArgumentStepError("a refute prediction needs auxiliary premises");
        if (!reason) throw new ArgumentStepError("a refute prediction needs a reason");
        draft.auxiliary = auxiliary;
        draft.reason = reason;
      } else if (also.length || auxiliary.length || reason)
        throw new ArgumentStepError("an identification prediction has no overlap, auxiliary premises or reason");
      return draft;
    });
    if (!predictions.some(p => p.kind === "support") || !predictions.some(p => p.kind === "refute"))
      throw new ArgumentStepError("a hypothesis needs a support and a refute prediction");
    if (!predictions.some(p => p.required)) throw new ArgumentStepError("a hypothesis needs a required test");
    const draft: HypothesisDraft = { id, role, predictions };
    const needsIdentification = causalClaim && CAUSAL_ROLES.includes(role);
    if (one.identification === null) {
      if (needsIdentification)
        throw new ArgumentStepError("a cause needs an identification strategy and its assumptions");
    } else {
      if (!needsIdentification) throw new ArgumentStepError("only a cause carries an identification strategy");
      const ident = exact(one.identification, ["strategy", "assumptions"], "identification");
      const strategy = short(ident.strategy, "strategy");
      const assumptions = strings(ident.assumptions, "assumptions", 1, 6);
      texts.push(strategy, ...assumptions);
      draft.identification = { strategy, assumptions };
    }
    return draft;
  });
  checkRoles(
    request,
    drafts.map(d => d.role)
  );
  grounded(texts, sourcesOf(request));
  return { hypotheses: drafts };
}

/** Propose a claim's hypotheses with their predictions (first batch), or the one late batch of alternatives. Text-only; ids are the program's. */
export const hypothesesV2Step: StepDefinition<HypothesesV2Request, HypothesesV2Result> = {
  id: "argument-map.v2-hypotheses",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.restatement),
      mode: request.mode,
      type: request.claim.type,
      modeRules: (request.mode === "first" ? firstRules : alternativeRules).trim(),
      ids: request.ids.join(", "),
      max: String(request.ids.length),
      restatement: JSON.stringify(request.restatement),
      claim: JSON.stringify({
        id: request.claim.id,
        text: request.claim.text,
        type: request.claim.type,
        definitions: request.claim.definitions.map(d => ({ term: d.term, meaning: d.meaning }))
      }),
      premises: JSON.stringify(request.premises.map(p => ({ id: p.id, text: p.text, result: p.result }))),
      existing: JSON.stringify(
        request.existing.map(h => ({
          id: h.id,
          role: h.role,
          predictions: h.predictions.map(p => ({ kind: p.kind, text: p.text }))
        }))
      ),
      gap: JSON.stringify(request.gap)
    }),
  schema: HYPOTHESES_V2_SCHEMA,
  policy: (prompt, request) => {
    if (request.mode !== "first" && request.mode !== "alternatives")
      throw new ArgumentStepError("unknown hypotheses mode");
    if (!request.ids.length || request.ids.length > MAX_HYPOTHESES || new Set(request.ids).size !== request.ids.length)
      throw new ArgumentStepError("the reserved hypothesis ids are out of range");
    const floor = request.mode === "first" ? (request.claim.type === "fact" ? 2 : 3) : 1;
    if (request.ids.length < floor) throw new ArgumentStepError("the hypothesis limit leaves no room for this set");
    if (request.mode === "first" && request.existing.length)
      throw new ArgumentStepError("the claim already has hypotheses");
    if (request.mode === "alternatives" && !request.existing.length)
      throw new ArgumentStepError("there is nothing to add an alternative to");
    overBudget(prompt, HYPOTHESES_V2_SCHEMA);
  },
  parse: parseHypothesesV2
};
