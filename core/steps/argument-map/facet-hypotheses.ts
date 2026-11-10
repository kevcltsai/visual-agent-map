import { renderTemplate, type StepDefinition } from "../../step-runner";
import type { PropStance } from "../../argument-map/model";
import {
  ArgumentStepError,
  citation,
  grounded,
  languageInstruction,
  list,
  normalized,
  overBudget,
  parseObject,
  text,
  type ArgumentStepBase
} from "./shared";
import type { GateDatum } from "./gate";
import template from "./facet-hypotheses.md";

export interface FacetHypothesesDatum extends GateDatum {
  propStance: PropStance;
}
/** The hypotheses of a facet-judged map (decision #50). The first batch is the one with no existing hypothesis. */
export interface FacetHypothesesRequest extends ArgumentStepBase {
  proposition: string;
  data: FacetHypothesesDatum[];
  count: number;
  existing: string[];
  causalQuestions: string[];
}
export interface FacetHypothesis {
  title: string;
  statement: string;
  basis: string;
  alternative: boolean;
  citedData: string[];
}
export interface FacetHypothesesResult {
  hypotheses: FacetHypothesis[];
}

export const FACET_HYPOTHESES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    hypotheses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", minLength: 1 },
          statement: { type: "string", minLength: 1 },
          basis: { type: "string", minLength: 1 },
          alternative: { type: "boolean" },
          citedData: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 }
        },
        required: ["title", "statement", "basis", "alternative", "citedData"]
      }
    }
  },
  required: ["hypotheses"]
};

const pick = (d: FacetHypothesesDatum): FacetHypothesesDatum => ({
  id: d.id,
  need: d.need,
  claim: d.claim,
  quote: d.quote,
  url: d.url,
  stance: d.stance,
  propStance: d.propStance
});
const sourcesOf = (request: FacetHypothesesRequest): string[] => [
  request.proposition,
  ...request.existing,
  ...request.causalQuestions,
  ...request.data.flatMap(d => [d.need, d.claim, d.quote, d.url, d.stance])
];
const isFirstBatch = (request: FacetHypothesesRequest): boolean => request.existing.length === 0;

export function parseFacetHypotheses(raw: string, request: FacetHypothesesRequest): FacetHypothesesResult {
  const item = parseObject(raw, ["hypotheses"]);
  const entries = list(item.hypotheses, "hypotheses");
  if (entries.length !== request.count) throw new ArgumentStepError(`expected exactly ${request.count} hypotheses`);
  const stances = new Map(request.data.map(d => [d.id, d.propStance]));
  const allowed = new Set(stances.keys());
  const seen = new Set(request.existing.map(normalized));
  const questions = new Set(request.causalQuestions.map(normalized));
  const hypotheses = entries.map(entry => {
    const one = parseObject(JSON.stringify(entry), ["title", "statement", "basis", "alternative", "citedData"]);
    const title = text(one.title, "title");
    const statement = text(one.statement, "statement");
    const basis = text(one.basis, "basis");
    if (typeof one.alternative !== "boolean") throw new ArgumentStepError("alternative must be a boolean");
    const key = normalized(title);
    if (questions.has(key)) throw new ArgumentStepError("a hypothesis title repeats a causal question");
    if (seen.has(key)) throw new ArgumentStepError("a hypothesis repeats another one");
    seen.add(key);
    grounded([title, statement, basis], sourcesOf(request));
    const citedData = citation(one.citedData, allowed, "citedData");
    if (citedData.some(id => stances.get(id) !== "supports"))
      throw new ArgumentStepError("a hypothesis may cite only data that support the proposition");
    return { title, statement, basis, alternative: one.alternative, citedData };
  });
  if (isFirstBatch(request) && !hypotheses.some(h => h.alternative))
    throw new ArgumentStepError("the first batch needs at least one alternative explanation");
  return { hypotheses };
}

/** Propose the hypotheses of a facet map from the supporting situation data. Text-only; the program assigns ids and enforces the limits. */
export const facetHypothesesStep: StepDefinition<FacetHypothesesRequest, FacetHypothesesResult> = {
  id: "argument-map.facet-hypotheses",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.proposition),
      count: String(request.count),
      alternativeRule: isFirstBatch(request)
        ? "At least one hypothesis whose alternative is true is required in this batch."
        : "",
      proposition: JSON.stringify(request.proposition),
      data: JSON.stringify(request.data.map(pick)),
      causal: JSON.stringify(request.causalQuestions),
      existing: JSON.stringify(request.existing)
    }),
  schema: FACET_HYPOTHESES_SCHEMA,
  policy: (prompt, request) => {
    if (!request.data.some(d => d.propStance === "supports"))
      throw new ArgumentStepError("hypotheses need situation data that support the proposition");
    if (!Number.isInteger(request.count) || request.count < 1) throw new ArgumentStepError("nothing to propose");
    overBudget(prompt, FACET_HYPOTHESES_SCHEMA);
  },
  parse: parseFacetHypotheses
};
