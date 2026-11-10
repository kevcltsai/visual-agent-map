import type { EvidenceInput, VerdictInput } from "../../argument-map/machine";
import { VERDICTS, type Verdict } from "../../argument-map/model-v1";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import {
  ArgumentStepError,
  citation,
  grounded,
  languageInstruction,
  overBudget,
  parseObject,
  text,
  type ArgumentStepBase
} from "./shared";
import template from "./verdict.md";

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
