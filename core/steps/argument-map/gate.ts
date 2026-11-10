import type { SituationDatum } from "../../argument-map/model";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import {
  ArgumentStepError,
  citation,
  grounded,
  idSchema,
  languageInstruction,
  overBudget,
  parseObject,
  text,
  type ArgumentStepBase
} from "./shared";
import template from "./gate.md";

/** One found situation datum as the gate sees it: its id, the need it answers and the proof. Nothing else. */
export interface GateDatum {
  id: string;
  need: string;
  claim: string;
  quote: string;
  url: string;
  stance: string;
}
export interface GateRequest extends ArgumentStepBase {
  proposition: string;
  data: GateDatum[];
}
export interface GateVerdict {
  matches: boolean;
  reason: string;
  citedData: string[];
}

/** The gate's data: refused (so no AI call) unless every datum is found with a proof. Mirrors `applySituationGate`. */
export function gateData(data: readonly SituationDatum[]): GateDatum[] {
  if (!data.length || data.some(d => d.state !== "found" || !d.proof))
    throw new ArgumentStepError("every situation datum must be found with a source first");
  return data.map(d => ({
    id: d.id,
    need: d.need,
    claim: d.proof!.claim,
    quote: d.proof!.quote,
    url: d.proof!.url,
    stance: d.stance ?? ""
  }));
}

export const GATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { matches: { type: "boolean" }, reason: { type: "string", minLength: 1 }, citedData: idSchema },
  required: ["matches", "reason", "citedData"]
};

const pick = (d: GateDatum): GateDatum => ({
  id: d.id,
  need: d.need,
  claim: d.claim,
  quote: d.quote,
  url: d.url,
  stance: d.stance
});
export const gateTexts = (request: GateRequest): string[] => [
  request.proposition,
  ...request.data.flatMap(d => [d.need, d.claim, d.quote, d.url, d.stance])
];

export function parseGate(raw: string, request: GateRequest): GateVerdict {
  const item = parseObject(raw, ["matches", "reason", "citedData"]);
  if (typeof item.matches !== "boolean") throw new ArgumentStepError("matches must be a boolean");
  const reason = text(item.reason, "reason");
  const citedData = citation(item.citedData, new Set(request.data.map(d => d.id)), "citedData");
  grounded([reason], gateTexts(request));
  return { matches: item.matches, reason, citedData };
}

/** Situation gate judge: does the proposition match the found situation data? Text-only; the machine's gate rules still apply. */
export const situationGateStep: StepDefinition<GateRequest, GateVerdict> = {
  id: "argument-map.situation-gate",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.proposition),
      proposition: JSON.stringify(request.proposition),
      data: JSON.stringify(request.data.map(pick))
    }),
  schema: GATE_SCHEMA,
  policy: (prompt, request) => {
    if (!request.data.length) throw new ArgumentStepError("the gate needs situation data");
    overBudget(prompt, GATE_SCHEMA);
  },
  parse: parseGate
};
