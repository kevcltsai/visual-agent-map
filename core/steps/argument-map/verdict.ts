import type { EvidenceInput, VerdictInput } from "../../argument-map/machine";
import { VERDICTS, type Verdict } from "../../argument-map/model";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import {
  ArgumentStepError,
  citation,
  grounded,
  languageInstruction,
  list,
  overBudget,
  parseObject,
  text,
  type ArgumentStepBase
} from "./shared";
import template from "./verdict.md";
import facetTemplate from "./facet-verdict.md";

export interface VerdictRequest extends ArgumentStepBase {
  /** The hypothesis statement being judged. */
  hypothesis: string;
  /** `prepareVerdict`'s output: that hypothesis' found needs (claim, quote, url, stance) and nothing else. */
  input: VerdictInput;
}
export interface VerdictResult {
  verdict: Verdict;
  citedNeeds: string[];
  reason: string;
}

export const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: [...VERDICTS] },
    citedNeeds: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
    reason: { type: "string", minLength: 1 }
  },
  required: ["verdict", "citedNeeds", "reason"]
};

/** Insights of a facet map's verdict (V1 boost): how the evidence agrees, pulls against itself, or is still missing. */
export const INSIGHT_KINDS = ["consistent", "tension", "missing"] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];
export const MAX_INSIGHTS = 3;
export interface VerdictInsight {
  kind: InsightKind;
  text: string;
}
export interface FacetVerdictResult extends VerdictResult {
  insights: VerdictInsight[];
}

export const FACET_VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...VERDICT_SCHEMA.properties,
    insights: {
      type: "array",
      minItems: 1,
      maxItems: MAX_INSIGHTS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { kind: { type: "string", enum: [...INSIGHT_KINDS] }, text: { type: "string", minLength: 1 } },
        required: ["kind", "text"]
      }
    }
  },
  required: [...VERDICT_SCHEMA.required, "insights"]
};

const pick = (e: EvidenceInput): EvidenceInput => ({
  id: e.id,
  claim: e.claim,
  quote: e.quote,
  url: e.url,
  stance: e.stance
});
export const verdictTexts = (request: VerdictRequest): string[] => [
  request.hypothesis,
  ...request.input.evidence.flatMap(e => [e.claim, e.quote, e.url, e.stance])
];

export function parseVerdict(raw: string, request: VerdictRequest): VerdictResult {
  const item = parseObject(raw, ["verdict", "citedNeeds", "reason"]);
  if (!(VERDICTS as readonly string[]).includes(item.verdict as string)) throw new ArgumentStepError("unknown verdict");
  const reason = text(item.reason, "reason");
  const citedNeeds = citation(item.citedNeeds, new Set(request.input.evidence.map(e => e.id)), "citedNeeds");
  grounded([reason], verdictTexts(request));
  return { verdict: item.verdict as Verdict, citedNeeds, reason };
}

export function parseFacetVerdict(raw: string, request: VerdictRequest): FacetVerdictResult {
  const item = parseObject(raw, ["verdict", "citedNeeds", "reason", "insights"]);
  const { insights: rawInsights, ...rest } = item;
  const base = parseVerdict(JSON.stringify(rest), request);
  const entries = list(rawInsights, "insights");
  if (entries.length < 1 || entries.length > MAX_INSIGHTS)
    throw new ArgumentStepError(`insights must have 1 to ${MAX_INSIGHTS} entries`);
  const insights = entries.map(entry => {
    const one = parseObject(JSON.stringify(entry), ["kind", "text"]);
    if (!(INSIGHT_KINDS as readonly unknown[]).includes(one.kind)) throw new ArgumentStepError("unknown insight kind");
    return { kind: one.kind as InsightKind, text: text(one.text, "insight") };
  });
  grounded(
    insights.map(i => i.text),
    verdictTexts(request)
  );
  return { ...base, insights };
}

/** Judge one hypothesis from its own found evidence. Text-only. */
export const verdictStep: StepDefinition<VerdictRequest, VerdictResult> = {
  id: "argument-map.verdict",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.hypothesis),
      hypothesis: JSON.stringify(request.hypothesis),
      evidence: JSON.stringify(request.input.evidence.map(pick))
    }),
  schema: VERDICT_SCHEMA,
  policy: (prompt, request) => {
    if (!request.input.evidence.length) throw new ArgumentStepError("a verdict needs evidence");
    overBudget(prompt, VERDICT_SCHEMA);
  },
  parse: parseVerdict
};

/** The verdict of a facet-judged map: the same judgement plus 1 to 3 insights. The V1 `verdictStep` above is unchanged for older maps. */
export const facetVerdictStep: StepDefinition<VerdictRequest, FacetVerdictResult> = {
  id: "argument-map.facet-verdict",
  version: 1,
  render: request =>
    renderTemplate(facetTemplate, {
      languageInstruction: languageInstruction(request.language, request.hypothesis),
      hypothesis: JSON.stringify(request.hypothesis),
      evidence: JSON.stringify(request.input.evidence.map(pick))
    }),
  schema: FACET_VERDICT_SCHEMA,
  policy: (prompt, request) => {
    if (!request.input.evidence.length) throw new ArgumentStepError("a verdict needs evidence");
    overBudget(prompt, FACET_VERDICT_SCHEMA);
  },
  parse: parseFacetVerdict
};
