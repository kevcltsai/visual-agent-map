import { renderTemplate, type StepDefinition } from "../../step-runner";
import {
  ArgumentStepError,
  citation,
  grounded,
  idSchema,
  languageInstruction,
  list,
  normalized,
  overBudget,
  parseObject,
  text,
  type ArgumentStepBase
} from "./shared";
import type { GateDatum } from "./gate";
import template from "./hypotheses.md";
import causalTemplate from "./hypotheses-causal.md";

export interface HypothesesRequest extends ArgumentStepBase {
  proposition: string;
  /** The found situation data (same shape as the gate's). */
  data: GateDatum[];
  /** How many to propose (the machine's `propose_hypotheses.count`). */
  count: number;
  /** Titles of hypotheses already on the map, eliminated ones included. */
  existing: string[];
  /** Cause questions moved out of the situation plan; rendered, and their words reusable, only when non-empty. */
  causalQuestions?: string[];
}
export interface ProposedHypothesis {
  title: string;
  statement: string;
  citedData: string[];
}
export interface HypothesesResult {
  hypotheses: ProposedHypothesis[];
}

export const HYPOTHESES_SCHEMA = {
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
          citedData: idSchema
        },
        required: ["title", "statement", "citedData"]
      }
    }
  },
  required: ["hypotheses"]
};

const pick = (d: GateDatum): GateDatum => ({
  id: d.id,
  need: d.need,
  claim: d.claim,
  quote: d.quote,
  url: d.url,
  stance: d.stance
});
const sourcesOf = (request: HypothesesRequest): string[] => [
  request.proposition,
  ...request.existing,
  ...(request.causalQuestions ?? []),
  ...request.data.flatMap(d => [d.need, d.claim, d.quote, d.url, d.stance])
];

export function parseHypotheses(raw: string, request: HypothesesRequest): HypothesesResult {
  const item = parseObject(raw, ["hypotheses"]);
  const entries = list(item.hypotheses, "hypotheses");
  if (entries.length !== request.count) throw new ArgumentStepError(`expected exactly ${request.count} hypotheses`);
  const allowed = new Set(request.data.map(d => d.id));
  const seen = new Set(request.existing.map(normalized));
  const hypotheses = entries.map(entry => {
    const one = parseObject(JSON.stringify(entry), ["title", "statement", "citedData"]);
    const title = text(one.title, "title");
    const statement = text(one.statement, "statement");
    const key = normalized(title);
    if (seen.has(key)) throw new ArgumentStepError("a hypothesis repeats another one");
    seen.add(key);
    grounded([title, statement], sourcesOf(request));
    return { title, statement, citedData: citation(one.citedData, allowed, "citedData") };
  });
  return { hypotheses };
}

/** Propose hypotheses from the situation data. Text-only; the program, not the model, assigns ids and enforces the limits. */
export const hypothesesStep: StepDefinition<HypothesesRequest, HypothesesResult> = {
  id: "argument-map.hypotheses",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.proposition),
      count: String(request.count),
      proposition: JSON.stringify(request.proposition),
      data: JSON.stringify(request.data.map(pick)),
      existing: JSON.stringify(request.existing),
      causal: request.causalQuestions?.length
        ? renderTemplate(causalTemplate, { questions: JSON.stringify(request.causalQuestions) })
        : ""
    }),
  schema: HYPOTHESES_SCHEMA,
  policy: (prompt, request) => {
    if (!request.data.length) throw new ArgumentStepError("hypotheses need situation data");
    if (!Number.isInteger(request.count) || request.count < 1) throw new ArgumentStepError("nothing to propose");
    overBudget(prompt, HYPOTHESES_SCHEMA);
  },
  parse: parseHypotheses
};
