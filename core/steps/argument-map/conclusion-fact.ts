import { FACET_COMPOSITES, type FacetComposite, type FacetVerdict } from "../../argument-map/model";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import {
  ArgumentStepError,
  citation,
  grounded,
  idSchema,
  languageInstruction,
  list,
  noIds,
  overBudget,
  parseObject,
  text,
  type ArgumentStepBase
} from "./shared";
import template from "./conclusion-fact.md";
import premiseRule from "./conclusion-unconfirmed.md";
import outcomeHolds from "./conclusion-fact-holds.md";
import outcomeFails from "./conclusion-fact-fails.md";
import outcomePartial from "./conclusion-fact-partial.md";
import outcomeInsufficient from "./conclusion-fact-insufficient.md";

export interface ConclusionFactDatum {
  claim: string;
  quote: string;
  url: string;
  stance: string;
}
export interface ConclusionFactFacet {
  id: string;
  title: string;
  verdict: FacetVerdict;
  summary: string;
  reason: string;
  data: ConclusionFactDatum[];
}
export interface ConclusionFactRequest extends ArgumentStepBase {
  proposition: string;
  /** What the facets say together, decided by the program (`composeFacets`); the model only writes the words. */
  outcome: FacetComposite;
  facets: ConclusionFactFacet[];
  /** The situation was not confirmed (decision #58): the model must not state it as fact. */
  unconfirmed?: boolean;
}
export interface ConclusionFactResult {
  summary: string;
  points: { text: string; facetIds: string[] }[];
  /** The facet ids the points rest on, for `applyFactConclusion`. */
  basedOn: string[];
}

export const CONCLUSION_FACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", minLength: 1 },
    points: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string", minLength: 1 }, facetIds: idSchema },
        required: ["text", "facetIds"]
      },
      minItems: 1
    }
  },
  required: ["summary", "points"]
};

const OUTCOME_TEXT: Record<FacetComposite, string> = {
  holds: outcomeHolds.trim(),
  fails: outcomeFails.trim(),
  partial: outcomePartial.trim(),
  insufficient: outcomeInsufficient.trim()
};

const checked = (request: ConclusionFactRequest): ConclusionFactFacet[] => {
  if (!(FACET_COMPOSITES as readonly string[]).includes(request.outcome)) throw new ArgumentStepError("unknown outcome");
  if (!Array.isArray(request.facets) || !request.facets.length) throw new ArgumentStepError("a fact conclusion needs facets");
  return request.facets;
};
const sourcesOf = (request: ConclusionFactRequest): string[] => [
  request.proposition,
  ...request.facets.flatMap(f => [
    f.title,
    f.summary,
    f.reason,
    ...f.data.flatMap(d => [d.claim, d.quote, d.url, d.stance])
  ])
];

export function parseConclusionFact(raw: string, request: ConclusionFactRequest): ConclusionFactResult {
  const item = parseObject(raw, ["summary", "points"]);
  const summary = text(item.summary, "summary");
  const entries = list(item.points, "points");
  if (!entries.length) throw new ArgumentStepError("the conclusion needs at least one point");
  const allowed = new Set(checked(request).map(f => f.id));
  const basedOn: string[] = [];
  const points = entries.map(entry => {
    const one = parseObject(JSON.stringify(entry), ["text", "facetIds"]);
    const body = text(one.text, "text");
    const facetIds = citation(one.facetIds, allowed, "facetIds");
    for (const id of facetIds) if (!basedOn.includes(id)) basedOn.push(id);
    return { text: body, facetIds };
  });
  const replyTexts = [summary, ...points.map(p => p.text)];
  noIds(replyTexts, request.facets.map(f => f.id));
  grounded(replyTexts, sourcesOf(request));
  return { summary, points, basedOn };
}

/** Write the conclusion of a fact question. The overall result comes from the program; every point may rest on facets only. Text-only. */
export const conclusionFactStep: StepDefinition<ConclusionFactRequest, ConclusionFactResult> = {
  id: "argument-map.conclusion-fact",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.proposition),
      outcome: OUTCOME_TEXT[request.outcome],
      premiseRule: request.unconfirmed ? ` ${premiseRule.trim()}` : "",
      proposition: JSON.stringify(request.proposition),
      facets: JSON.stringify(
        checked(request).map(f => ({
          id: f.id,
          title: f.title,
          verdict: f.verdict,
          summary: f.summary,
          reason: f.reason,
          data: f.data.map(d => ({ claim: d.claim, quote: d.quote, url: d.url, stance: d.stance }))
        }))
      )
    }),
  schema: CONCLUSION_FACT_SCHEMA,
  policy: (prompt, request) => {
    checked(request);
    overBudget(prompt, CONCLUSION_FACT_SCHEMA);
  },
  parse: parseConclusionFact
};
