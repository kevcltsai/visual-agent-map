import type { Claim, Definition, PremiseResult } from "../../argument-map/model";
import { PREMISE_RESULTS } from "../../argument-map/model";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import { ArgumentStepError, grounded, languageInstruction, overBudget, type ArgumentStepBase } from "./shared";
import { S, exact, idsFrom, pick, short } from "./v2-shared";
import template from "./v2-premise.md";

export interface PremiseDatumInput {
  id: string;
  need: string;
  claim: string;
  quote: string;
  url: string;
  /** Computed by the program: checked against the page, assessed relevant and in scope. Only usable data can carry holds or fails. */
  usable: boolean;
  assessment: {
    relevant: boolean;
    stance: string;
    scopeFit: boolean;
    scopeNote: string;
    sourceType: string;
    underlyingSource: string;
  };
}
export interface PremiseVerdictRequest extends ArgumentStepBase {
  premise: { text: string; definitions: Definition[] };
  /** `premiseVerdictData(claim)`: the data of this premise only. */
  data: PremiseDatumInput[];
}
export interface PremiseVerdictResult {
  result: PremiseResult;
  reason: string;
  /** Ids of this premise's data; the machine's `applyPremiseResult` takes the same three fields. */
  citedData: string[];
}

/**
 * The premise's data as the step may see them. Refused (no AI call) unless every datum is found with a source and assessed, the same
 * precondition as `applyPremiseResult`. Nothing else of the map is copied.
 */
export function premiseVerdictData(claim: Claim): PremiseDatumInput[] {
  const data = claim.data ?? [];
  if (!data.length || data.some(d => d.state !== "found" || !d.proof || !d.assessment))
    throw new ArgumentStepError("every premise datum must be found, with a source and an assessment, first");
  return data.map(d => {
    const a = d.assessment!;
    return {
      id: d.id,
      need: d.need,
      claim: d.proof!.claim,
      quote: d.proof!.quote,
      url: d.proof!.url,
      usable: d.proof!.check === "page_match" && a.relevant && a.scopeFit,
      assessment: {
        relevant: a.relevant,
        stance: a.stance,
        scopeFit: a.scopeFit,
        scopeNote: a.scopeNote ?? "",
        sourceType: a.sourceType,
        underlyingSource: a.underlyingSource
      }
    };
  });
}

export const PREMISE_VERDICT_SCHEMA = S.obj({
  result: S.enum(PREMISE_RESULTS),
  reason: S.str,
  citedData: S.arr(S.str)
});

const copy = (d: PremiseDatumInput): PremiseDatumInput => ({
  id: d.id,
  need: d.need,
  claim: d.claim,
  quote: d.quote,
  url: d.url,
  usable: d.usable,
  assessment: {
    relevant: d.assessment.relevant,
    stance: d.assessment.stance,
    scopeFit: d.assessment.scopeFit,
    scopeNote: d.assessment.scopeNote,
    sourceType: d.assessment.sourceType,
    underlyingSource: d.assessment.underlyingSource
  }
});
const premiseOf = (request: PremiseVerdictRequest): { text: string; definitions: Definition[] } => ({
  text: request.premise.text,
  definitions: request.premise.definitions.map(d => ({ term: d.term, meaning: d.meaning }))
});
export const premiseTexts = (request: PremiseVerdictRequest): string[] => [
  request.premise.text,
  ...request.premise.definitions.flatMap(d => [d.term, d.meaning]),
  ...request.data.flatMap(d => [
    d.need,
    d.claim,
    d.quote,
    d.url,
    d.assessment.stance,
    d.assessment.scopeNote,
    d.assessment.sourceType,
    d.assessment.underlyingSource
  ])
];

export function parsePremiseVerdict(raw: string, request: PremiseVerdictRequest): PremiseVerdictResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ArgumentStepError("The reply is not JSON");
  }
  const item = exact(value, ["result", "reason", "citedData"], "The reply");
  const result = pick(PREMISE_RESULTS, item.result, "result");
  const reason = short(item.reason, "reason");
  const byId = new Map(request.data.map(d => [d.id, d]));
  const citedData = idsFrom(item.citedData, new Set(byId.keys()), "citedData");
  if (result !== "insufficient") {
    if (!citedData.length) throw new ArgumentStepError("holds and fails must cite data");
    if (citedData.some(id => !byId.get(id)!.usable))
      throw new ArgumentStepError("holds and fails may only cite usable data");
    const wanted = result === "holds" ? "supports" : "refutes";
    if (!citedData.some(id => byId.get(id)!.assessment.stance === wanted))
      throw new ArgumentStepError(`${result} must cite a datum whose stance is ${wanted}`);
  }
  grounded([reason], premiseTexts(request));
  return { result, reason, citedData };
}

/** Judge one premise from its assessed data. Text-only; `applyPremiseResult` still decides whether the result may stand. */
export const premiseVerdictStep: StepDefinition<PremiseVerdictRequest, PremiseVerdictResult> = {
  id: "argument-map.v2-premise",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.premise.text),
      premise: JSON.stringify(premiseOf(request)),
      data: JSON.stringify(request.data.map(copy))
    }),
  schema: PREMISE_VERDICT_SCHEMA,
  policy: (prompt, request) => {
    if (!request.data.length) throw new ArgumentStepError("a premise verdict needs data");
    overBudget(prompt, PREMISE_VERDICT_SCHEMA);
  },
  parse: parsePremiseVerdict
};
