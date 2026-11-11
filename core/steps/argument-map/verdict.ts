import type { EvidenceInput, VerdictInput } from "../../argument-map/machine";
import {
  INSIGHT_KINDS,
  MAX_INSIGHTS,
  VERDICTS,
  type InsightKind,
  type HypothesisInsight,
  type Verdict
} from "../../argument-map/model";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import {
  ArgumentStepError,
  citation,
  grounded,
  languageInstruction,
  list,
  noIds,
  overBudget,
  parseObject,
  text,
  type ArgumentStepBase
} from "./shared";
import template from "./verdict.md";
import facetTemplate from "./facet-verdict.md";
import noReplacedRule from "./verdict-no-replaced.md";
import replacedRule from "./verdict-replaced.md";
import replacedLabel from "./verdict-replaced-label.md";

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

/** Insights of a facet map's verdict (V1 boost); the kinds and the cap live in the data contract (model.ts). */
export { INSIGHT_KINDS, MAX_INSIGHTS, type InsightKind };
export type VerdictInsight = HypothesisInsight;
export interface FacetVerdictResult extends VerdictResult {
  insights: VerdictInsight[];
  /** Always asked (strict schema); only kept when the request carries a replaced core (decision #62): whether the new core asks the same question as the one nobody found. */
  sameQuestion?: boolean;
}

export const FACET_VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...VERDICT_SCHEMA.properties,
    sameQuestion: { type: "boolean" },
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
  required: [...VERDICT_SCHEMA.required, "sameQuestion", "insights"]
};

const pick = (e: EvidenceInput): EvidenceInput => ({
  id: e.id,
  claim: e.claim,
  quote: e.quote,
  url: e.url,
  stance: e.stance
});
const facetPick = (e: EvidenceInput): EvidenceInput => ({ ...pick(e), ...(e.core === true ? { core: true } : {}) });
export const verdictTexts = (request: VerdictRequest): string[] => [
  request.hypothesis,
  ...request.input.evidence.flatMap(e => [e.claim, e.quote, e.url, e.stance]),
  request.input.replacedCore?.text ?? ""
];

export function parseVerdict(raw: string, request: VerdictRequest): VerdictResult {
  const item = parseObject(raw, ["verdict", "citedNeeds", "reason"]);
  if (!(VERDICTS as readonly string[]).includes(item.verdict as string)) throw new ArgumentStepError("unknown verdict");
  const reason = text(item.reason, "reason");
  const citedNeeds = citation(item.citedNeeds, new Set(request.input.evidence.map(e => e.id)), "citedNeeds");
  const ids = request.input.evidence.map(e => e.id);
  noIds([reason], ids);
  grounded([reason], verdictTexts(request));
  return { verdict: item.verdict as Verdict, citedNeeds, reason };
}

export function parseFacetVerdict(raw: string, request: VerdictRequest): FacetVerdictResult {
  const asked = request.input.replacedCore !== undefined;
  let keys = ["verdict", "citedNeeds", "reason", "insights"];
  try {
    const probe: unknown = JSON.parse(raw);
    if (probe && typeof probe === "object" && "sameQuestion" in probe) keys = [...keys, "sameQuestion"];
  } catch {
    // parseObject below reports the unreadable reply
  }
  const item = parseObject(raw, keys);
  const { insights: rawInsights, sameQuestion, ...rest } = item;
  if (asked && typeof sameQuestion !== "boolean") throw new ArgumentStepError("sameQuestion must be a boolean");
  const base = parseVerdict(JSON.stringify(rest), request);
  const entries = list(rawInsights, "insights");
  if (entries.length < 1 || entries.length > MAX_INSIGHTS)
    throw new ArgumentStepError(`insights must have 1 to ${MAX_INSIGHTS} entries`);
  const insights = entries.map(entry => {
    const one = parseObject(JSON.stringify(entry), ["kind", "text"]);
    if (!(INSIGHT_KINDS as readonly unknown[]).includes(one.kind)) throw new ArgumentStepError("unknown insight kind");
    return { kind: one.kind as InsightKind, text: text(one.text, "insight") };
  });
  noIds(
    insights.map(i => i.text),
    request.input.evidence.map(e => e.id)
  );
  grounded(
    insights.map(i => i.text),
    verdictTexts(request)
  );
  return { ...base, insights, ...(asked ? { sameQuestion: sameQuestion as boolean } : {}) };
}

const NO_REPLACED_RULE = noReplacedRule.trim();
const REPLACED_RULE = replacedRule.trim();

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
      evidence: JSON.stringify(request.input.evidence.map(facetPick)),
      sameQuestionField: '"sameQuestion":true|false,',
      replacedRule: ` ${request.input.replacedCore ? REPLACED_RULE : NO_REPLACED_RULE}`,
      replaced: request.input.replacedCore
        ? `\n\n${replacedLabel.trim()}\n${JSON.stringify(request.input.replacedCore.text)}`
        : ""
    }),
  schema: FACET_VERDICT_SCHEMA,
  policy: (prompt, request) => {
    if (!request.input.evidence.length) throw new ArgumentStepError("a verdict needs evidence");
    overBudget(prompt, FACET_VERDICT_SCHEMA);
  },
  parse: parseFacetVerdict
};
