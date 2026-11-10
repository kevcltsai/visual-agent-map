import {
  MAX_NEEDS,
  MAX_ROUND_NEEDS,
  type ArgumentMapData,
  type Criteria,
  type Definition
} from "../../argument-map/model";
import type { RoundNeedDraft } from "../../argument-map/machine-v2";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import {
  ArgumentStepError,
  grounded,
  languageInstruction,
  list,
  normalized,
  overBudget,
  type ArgumentStepBase
} from "./shared";
import { S, exact, fromRequest, short } from "./v2-shared";
import template from "./v2-needs.md";

export type NeedsMode = "first" | "round";

export interface NeedsPrediction {
  id: string;
  kind: string;
  text: string;
  required: boolean;
}
export interface NeedsV2Request extends ArgumentStepBase {
  claim: { text: string; definitions: Definition[] };
  hypothesis: {
    id: string;
    role: string;
    /** The research round these needs belong to (1 for the first listing). */
    round: number;
    predictions: NeedsPrediction[];
    identification: { strategy: string; assumptions: string[] } | null;
  };
  mode: NeedsMode;
  /** At most this many new needs: `applyNeeds` and `startNextRound`'s per-round and per-hypothesis limits. */
  max: number;
  /** Ids the program reserved for the new needs, in order (at least `max`). */
  ids: string[];
  /** Needs already on the hypothesis (mode round). */
  existing: { id: string; predictionId: string; text: string; state: string }[];
  /** `not_found` needs of earlier rounds that no replacement stands in for yet (mode round). */
  replaceable: { id: string; predictionId: string; text: string; reason: string }[];
}
export interface NeedsV2Result {
  /** Mode first: `applyNeeds` input. Mode round: `startNextRound` input (`replaces` set for a replacement, absent for an exploratory need). */
  needs: RoundNeedDraft[];
}

export const NEEDS_V2_SCHEMA = S.obj({
  needs: S.arr(
    S.obj({
      predictionId: S.str,
      text: S.str,
      criteria: S.obj({ supports: S.str, refutes: S.str, irrelevant: S.str }),
      replaces: { type: ["string", "null"] }
    }),
    1,
    MAX_ROUND_NEEDS
  )
});

/** How many needs may still be added this round: the same limits as the machine. */
export function needsAllowedV2(round: number, needs: { addedRound: number }[]): number {
  const inRound = needs.filter(n => n.addedRound === round).length;
  return Math.max(0, Math.min(MAX_ROUND_NEEDS - inRound, MAX_NEEDS - needs.length));
}

/** The request parts for one hypothesis. First listing: only the hypothesis' own predictions. A later round also sees which needs died. */
export function needsParts(
  state: ArgumentMapData,
  hypothesisId: string,
  mode: NeedsMode,
  ids: string[]
): Omit<NeedsV2Request, keyof ArgumentStepBase> {
  const h = state.hypotheses.find(o => o.id === hypothesisId);
  if (!h) throw new ArgumentStepError("unknown hypothesis");
  const claim = state.claims.find(c => c.id === h.claimId);
  if (!claim) throw new ArgumentStepError("unknown claim");
  if (mode === "first" && h.needs.length) throw new ArgumentStepError("the needs are already listed");
  if (mode === "round" && !h.needs.length) throw new ArgumentStepError("there is no earlier round");
  const round = mode === "first" ? h.round : h.round + 1;
  const replaced = new Set(h.needs.map(n => n.replaces).filter((id): id is string => id !== undefined));
  const max = mode === "first" ? MAX_ROUND_NEEDS : needsAllowedV2(round, h.needs);
  return {
    claim: { text: claim.text, definitions: claim.definitions.map(d => ({ term: d.term, meaning: d.meaning })) },
    hypothesis: {
      id: h.id,
      role: h.role,
      round,
      predictions: h.predictions.map(p => ({ id: p.id, kind: p.kind, text: p.text, required: p.required })),
      identification: h.identification
        ? { strategy: h.identification.strategy, assumptions: [...h.identification.assumptions] }
        : null
    },
    mode,
    max,
    ids: [...ids],
    existing: h.needs.map(n => ({ id: n.id, predictionId: n.predictionId, text: n.text, state: n.state })),
    replaceable:
      mode === "round"
        ? h.needs
            .filter(n => n.state === "not_found" && !replaced.has(n.id))
            .map(n => ({ id: n.id, predictionId: n.predictionId, text: n.text, reason: n.reason ?? "" }))
        : []
  };
}

const sourcesOf = (request: NeedsV2Request): string[] => [
  request.claim.text,
  ...request.claim.definitions.flatMap(d => [d.term, d.meaning]),
  String(request.hypothesis.round),
  ...request.hypothesis.predictions.map(p => p.text),
  ...(request.hypothesis.identification
    ? [request.hypothesis.identification.strategy, ...request.hypothesis.identification.assumptions]
    : []),
  ...request.existing.map(n => n.text),
  ...request.replaceable.flatMap(n => [n.text, n.reason])
];

export function parseNeedsV2(raw: string, request: NeedsV2Request): NeedsV2Result {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ArgumentStepError("The reply is not JSON");
  }
  const top = exact(value, ["needs"], "The reply");
  const entries = list(top.needs, "needs");
  if (!entries.length || entries.length > request.max)
    throw new ArgumentStepError(`expected 1 to ${request.max} needs`);
  const predictionIds = new Set(request.hypothesis.predictions.map(p => p.id));
  const dead = new Map(request.replaceable.map(n => [n.id, n]));
  const seen = new Set(request.existing.map(n => normalized(n.text)));
  const replacedNow = new Set<string>();
  const texts: string[] = [];
  const needs = entries.map((entry, index): RoundNeedDraft => {
    const one = exact(entry, ["predictionId", "text", "criteria", "replaces"], `need ${index + 1}`);
    const predictionId = fromRequest(one.predictionId, predictionIds, "predictionId");
    const body = short(one.text, "text");
    const c = exact(one.criteria, ["supports", "refutes", "irrelevant"], "criteria");
    const criteria: Criteria = {
      supports: short(c.supports, "criteria.supports"),
      refutes: short(c.refutes, "criteria.refutes"),
      irrelevant: short(c.irrelevant, "criteria.irrelevant")
    };
    const key = normalized(body);
    if (seen.has(key)) throw new ArgumentStepError("a need repeats another one");
    seen.add(key);
    const draft: RoundNeedDraft = { id: request.ids[index], predictionId, text: body, criteria };
    if (one.replaces !== null) {
      if (request.mode !== "round") throw new ArgumentStepError("only a later round may replace a need");
      const target = dead.get(fromRequest(one.replaces, new Set(dead.keys()), "replaces"));
      if (!target || replacedNow.has(target.id)) throw new ArgumentStepError("a need can be replaced once");
      if (target.predictionId !== predictionId)
        throw new ArgumentStepError("a replacement must test the same prediction");
      replacedNow.add(target.id);
      draft.replaces = target.id;
    }
    texts.push(body, criteria.supports, criteria.refutes, criteria.irrelevant);
    return draft;
  });
  if (request.mode === "first")
    for (const p of request.hypothesis.predictions)
      if (p.required && !needs.some(n => n.predictionId === p.id))
        throw new ArgumentStepError("every required prediction needs a need");
  grounded(texts, sourcesOf(request));
  return { needs };
}

/** List the evidence needs (with the criteria fixed before any search) of one hypothesis. Text-only; add-only; ids are the program's. */
export const needsV2Step: StepDefinition<NeedsV2Request, NeedsV2Result> = {
  id: "argument-map.v2-needs",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.claim.text),
      mode: request.mode,
      modeRules:
        request.mode === "first"
          ? "This is the first listing, written before any search. Every prediction marked required needs at least one need. replaces must be null."
          : "An earlier round left gaps. Add only what the existing needs did not cover. To stand in for a need listed under the needs nobody could find, set replaces to its id and test the same prediction with the same condition (a replacement counts only if a later check confirms it tests the same condition); otherwise replaces is null and the need is exploratory. Each of those can be replaced once.",
      max: String(request.max),
      claim: JSON.stringify({
        text: request.claim.text,
        definitions: request.claim.definitions.map(d => ({ term: d.term, meaning: d.meaning }))
      }),
      hypothesis: JSON.stringify({
        role: request.hypothesis.role,
        round: request.hypothesis.round,
        predictions: request.hypothesis.predictions.map(p => ({
          id: p.id,
          kind: p.kind,
          text: p.text,
          required: p.required
        })),
        identification: request.hypothesis.identification
          ? {
              strategy: request.hypothesis.identification.strategy,
              assumptions: [...request.hypothesis.identification.assumptions]
            }
          : null
      }),
      existing: JSON.stringify(
        request.existing.map(n => ({ id: n.id, predictionId: n.predictionId, text: n.text, state: n.state }))
      ),
      replaceable: JSON.stringify(
        request.replaceable.map(n => ({ id: n.id, predictionId: n.predictionId, text: n.text, reason: n.reason }))
      )
    }),
  schema: NEEDS_V2_SCHEMA,
  policy: (prompt, request) => {
    if (request.mode !== "first" && request.mode !== "round") throw new ArgumentStepError("unknown needs mode");
    if (!Number.isInteger(request.max) || request.max < 1 || request.max > MAX_ROUND_NEEDS)
      throw new ArgumentStepError("no needs may be added");
    if (request.ids.length < request.max || new Set(request.ids).size !== request.ids.length)
      throw new ArgumentStepError("the reserved need ids are too few");
    if (request.mode === "first") {
      if (request.existing.length) throw new ArgumentStepError("the needs are already listed");
      if (request.hypothesis.predictions.filter(p => p.required).length > request.max)
        throw new ArgumentStepError("more required predictions than needs allowed");
    }
    overBudget(prompt, NEEDS_V2_SCHEMA);
  },
  parse: parseNeedsV2
};
