import { MAX_FACET_NEEDS, MAX_FACETS, MAX_RETRY_NEEDS, PROP_STANCES, type PropStance } from "../../argument-map/model";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import {
  ArgumentStepError,
  grounded,
  languageInstruction,
  list,
  normalized,
  overBudget,
  parseObject,
  text,
  type ArgumentStepBase
} from "./shared";
import template from "./facet-judge.md";
import retryOnce from "./facet-judge-retry1.md";
import retryNone from "./facet-judge-retry2.md";
import assumptionsBlock from "./facet-judge-assumptions.md";

/** One found datum as the facet judge sees it. `fixedStance` is set when its stance toward the proposition is already decided and cannot change. */
export interface FacetJudgeDatum {
  id: string;
  need: string;
  claim: string;
  quote: string;
  url: string;
  stance: string;
  fixedStance?: PropStance;
}
export interface FacetJudgeFacet {
  id: string;
  title: string;
  data: FacetJudgeDatum[];
  /** Texts of the needs of this facet that were searched and not found; a retry need may not repeat them. */
  notFoundNeeds?: string[];
}
/** `facets` holds only the facets waiting for a judgement (all of them in round 1, the insufficient ones that got new data in round 2). */
export interface FacetJudgeRequest extends ArgumentStepBase {
  proposition: string;
  round: 1 | 2;
  facets: FacetJudgeFacet[];
  /** The assumption card of the map, when it has one: the judge writes up to 3 insights about how it bears on the data. */
  assumptions?: { label: string; value: string; reason: string }[];
}
export const MAX_ASSUMPTION_INSIGHTS = 3;
export interface FacetJudgeResult {
  data: { id: string; propStance: PropStance; reason: string }[];
  facets: {
    id: string;
    verdict: "supports" | "refutes" | "insufficient";
    reason: string;
    summary: string;
    citedData: string[];
    retryNeeds: string[];
  }[];
  /** 0 to 3 plain sentences about the assumption card; always empty when the request has none. */
  assumptionInsights: string[];
}

const VERDICTS = ["supports", "refutes", "insufficient"] as const;
const strings = { type: "array", items: { type: "string", minLength: 1 } };

export const FACET_JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    data: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          propStance: { type: "string", enum: [...PROP_STANCES] },
          reason: { type: "string", minLength: 1 }
        },
        required: ["id", "propStance", "reason"]
      }
    },
    facets: {
      type: "array",
      maxItems: MAX_FACETS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          verdict: { type: "string", enum: [...VERDICTS] },
          reason: { type: "string", minLength: 1 },
          summary: { type: "string", minLength: 1 },
          citedData: strings,
          retryNeeds: { ...strings, maxItems: MAX_FACET_NEEDS }
        },
        required: ["id", "verdict", "reason", "summary", "citedData", "retryNeeds"]
      }
    },
    assumptionInsights: { ...strings, maxItems: MAX_ASSUMPTION_INSIGHTS }
  },
  required: ["data", "facets", "assumptionInsights"]
};

const pick = (d: FacetJudgeDatum): FacetJudgeDatum => ({
  id: d.id,
  need: d.need,
  claim: d.claim,
  quote: d.quote,
  url: d.url,
  stance: d.stance,
  ...(d.fixedStance ? { fixedStance: d.fixedStance } : {})
});
const sourcesOf = (request: FacetJudgeRequest): string[] => [
  request.proposition,
  ...(request.assumptions ?? []).flatMap(a => [a.label, a.value, a.reason]),
  ...request.facets.flatMap(f => [
    f.title,
    ...(f.notFoundNeeds ?? []),
    ...f.data.flatMap(d => [d.need, d.claim, d.quote, d.url, d.stance])
  ])
];
const RETRY_ROUND_1 = retryOnce.trim();
const RETRY_ROUND_2 = retryNone.trim();

const ids = (values: string[]): string => [...values].sort().join("\n");

export function parseFacetJudge(raw: string, request: FacetJudgeRequest): FacetJudgeResult {
  if (request.facets.length > MAX_FACETS) throw new ArgumentStepError(`at most ${MAX_FACETS} facets can be judged`);
  const item = parseObject(raw, ["data", "facets", "assumptionInsights"]);
  const sources = sourcesOf(request);
  const found = request.facets.flatMap(f => f.data.map(d => ({ ...d, facetId: f.id })));
  const data = list(item.data, "data").map(entry => {
    const one = parseObject(JSON.stringify(entry), ["id", "propStance", "reason"]);
    const id = text(one.id, "data id");
    if (!(PROP_STANCES as readonly unknown[]).includes(one.propStance)) throw new ArgumentStepError("unknown stance");
    const propStance = one.propStance as PropStance;
    const fixed = found.find(d => d.id === id)?.fixedStance;
    if (fixed !== undefined && fixed !== propStance)
      throw new ArgumentStepError("a stance that is already fixed cannot be changed");
    const reason = text(one.reason, "reason");
    grounded([reason], sources);
    return { id, propStance, reason };
  });
  if (ids(data.map(d => d.id)) !== ids(found.map(d => d.id)))
    throw new ArgumentStepError("the data must name every found datum exactly once");
  const stanceOf = new Map(data.map(d => [d.id, d.propStance]));
  const asked = new Set(
    request.facets.flatMap(f => [...f.data.map(d => d.need), ...(f.notFoundNeeds ?? [])].map(normalized))
  );
  let retryTotal = 0;
  const facets = list(item.facets, "facets").map(entry => {
    const one = parseObject(JSON.stringify(entry), ["id", "verdict", "reason", "summary", "citedData", "retryNeeds"]);
    const id = text(one.id, "facet id");
    const facet = request.facets.find(f => f.id === id);
    if (!facet) throw new ArgumentStepError("the facets must be exactly those supplied");
    if (!(VERDICTS as readonly unknown[]).includes(one.verdict)) throw new ArgumentStepError("unknown verdict");
    const verdict = one.verdict as (typeof VERDICTS)[number];
    const reason = text(one.reason, "reason");
    const summary = text(one.summary, "summary");
    grounded([reason, summary], sources);
    const own = new Map(facet.data.map(d => [d.id, stanceOf.get(d.id)]));
    // No found data, or only irrelevant data: the machine forces "insufficient", so the verdict and citations are not checked here.
    const usable = [...own.values()].some(stance => stance !== "irrelevant");
    const citedData = [...new Set(list(one.citedData, "citedData"))].map(cited => {
      if (usable && (typeof cited !== "string" || !own.has(cited) || own.get(cited) === "irrelevant"))
        throw new ArgumentStepError("a facet may cite found, relevant data of its own only");
      return cited as string;
    });
    if (usable && verdict !== "insufficient" && !citedData.some(c => own.get(c) === verdict))
      throw new ArgumentStepError(`a ${verdict} verdict must cite a datum with the same stance`);
    const retryNeeds: string[] = [];
    for (const raw of list(one.retryNeeds, "retryNeeds")) {
      const need = text(raw, "retry need");
      const key = normalized(need);
      if (asked.has(key)) throw new ArgumentStepError("a retry need repeats another need");
      asked.add(key);
      grounded([need], sources);
      retryNeeds.push(need);
    }
    if (retryNeeds.length && (request.round !== 1 || (usable && verdict !== "insufficient")))
      throw new ArgumentStepError("retry needs are only allowed for an insufficient facet in round 1");
    if (retryNeeds.length > MAX_FACET_NEEDS) throw new ArgumentStepError("too many retry needs for one facet");
    retryTotal += retryNeeds.length;
    return { id, verdict, reason, summary, citedData, retryNeeds };
  });
  if (ids(facets.map(f => f.id)) !== ids(request.facets.map(f => f.id)))
    throw new ArgumentStepError("the facets must be exactly those supplied, each once");
  if (retryTotal > MAX_RETRY_NEEDS) throw new ArgumentStepError("too many retry needs");
  const assumptionInsights = list(item.assumptionInsights, "assumptionInsights").map(entry =>
    text(entry, "assumption insight")
  );
  if (assumptionInsights.length > MAX_ASSUMPTION_INSIGHTS) throw new ArgumentStepError("at most 3 assumption insights");
  if (assumptionInsights.length && !request.assumptions?.length)
    throw new ArgumentStepError("assumption insights need an assumption card");
  grounded(assumptionInsights, sources);
  return { data, facets, assumptionInsights };
}

/** Judge the facets: a stance for each found datum, a verdict and summary for each facet, and the retry needs of the insufficient ones (round 1 only). Text-only. */
export const facetJudgeStep: StepDefinition<FacetJudgeRequest, FacetJudgeResult> = {
  id: "argument-map.facet-judge",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.proposition),
      retryRule: request.round === 1 ? RETRY_ROUND_1 : RETRY_ROUND_2,
      proposition: JSON.stringify(request.proposition),
      assumptions: request.assumptions?.length
        ? `\n\n${renderTemplate(assumptionsBlock.trim(), { assumptionsJson: JSON.stringify(request.assumptions) })}`
        : "",
      facets: JSON.stringify(
        request.facets.map(f => ({
          id: f.id,
          title: f.title,
          data: f.data.map(pick),
          ...(f.notFoundNeeds?.length ? { notFoundNeeds: f.notFoundNeeds } : {})
        }))
      )
    }),
  schema: FACET_JUDGE_SCHEMA,
  policy: (prompt, request) => {
    if (!request.facets.length || request.facets.length > MAX_FACETS)
      throw new ArgumentStepError(`the judge needs 1 to ${MAX_FACETS} facets`);
    overBudget(prompt, FACET_JUDGE_SCHEMA);
  },
  parse: parseFacetJudge
};
