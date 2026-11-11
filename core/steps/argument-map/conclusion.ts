import type { ConclusionInput, EvidenceInput } from "../../argument-map/machine";
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
import template from "./conclusion.md";
import premiseRule from "./conclusion-unconfirmed.md";
import partialRule from "./conclusion-partial.md";

export interface ConclusionRequest extends ArgumentStepBase {
  proposition: string;
  /** `prepareConclusion`'s output: verified hypotheses and their evidence only. */
  input: ConclusionInput;
  /** Statement of each verified hypothesis, by id (exactly the ids in `input`). */
  statements: Record<string, string>;
  /** The situation gate ended data_insufficient (decision #58): the premise is unconfirmed; the program writes the first line, the model must not state the situation as fact. */
  unconfirmed?: boolean;
  /** Fewer hypotheses were verified than the target (decision #59): the model must say what these show and not claim a full answer. */
  partial?: boolean;
}
export interface ConclusionPoint {
  text: string;
  hypothesisIds: string[];
}
export interface ConclusionResult {
  summary: string;
  points: ConclusionPoint[];
  /** Every hypothesis a point rests on, for `applyConclusion`. */
  basedOn: string[];
}

export const CONCLUSION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", minLength: 1 },
    points: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string", minLength: 1 }, hypothesisIds: idSchema },
        required: ["text", "hypothesisIds"]
      },
      minItems: 1
    }
  },
  required: ["summary", "points"]
};

const pick = (e: EvidenceInput): EvidenceInput => ({
  id: e.id,
  claim: e.claim,
  quote: e.quote,
  url: e.url,
  stance: e.stance
});
const statementOf = (request: ConclusionRequest, id: string): string => {
  const value = Object.prototype.hasOwnProperty.call(request.statements, id) ? request.statements[id] : undefined;
  if (typeof value !== "string" || !value.trim()) throw new ArgumentStepError(`no statement for hypothesis ${id}`);
  return value;
};
const sourcesOf = (request: ConclusionRequest): string[] => [
  request.proposition,
  ...request.input.hypotheses.flatMap(h => [
    statementOf(request, h.id),
    ...h.evidence.flatMap(e => [e.claim, e.quote, e.url, e.stance])
  ])
];

export function parseConclusion(raw: string, request: ConclusionRequest): ConclusionResult {
  const item = parseObject(raw, ["summary", "points"]);
  const summary = text(item.summary, "summary");
  const entries = list(item.points, "points");
  if (!entries.length) throw new ArgumentStepError("the conclusion needs at least one point");
  const allowed = new Set(request.input.hypotheses.map(h => h.id));
  const basedOn: string[] = [];
  const points = entries.map(entry => {
    const one = parseObject(JSON.stringify(entry), ["text", "hypothesisIds"]);
    const body = text(one.text, "text");
    const hypothesisIds = citation(one.hypothesisIds, allowed, "hypothesisIds");
    for (const id of hypothesisIds) if (!basedOn.includes(id)) basedOn.push(id);
    return { text: body, hypothesisIds };
  });
  noIds(
    [summary, ...points.map(p => p.text)],
    request.input.hypotheses.flatMap(h => [h.id, ...h.evidence.map(e => e.id)])
  );
  grounded([summary, ...points.map(p => p.text)], sourcesOf(request));
  return { summary, points, basedOn };
}

/** Write the conclusion from verified hypotheses and their evidence only. Text-only. */
export const conclusionStep: StepDefinition<ConclusionRequest, ConclusionResult> = {
  id: "argument-map.conclusion",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.proposition),
      premiseRule:
        (request.unconfirmed ? ` ${premiseRule.trim()}` : "") + (request.partial ? ` ${partialRule.trim()}` : ""),
      proposition: JSON.stringify(request.proposition),
      hypotheses: JSON.stringify(
        request.input.hypotheses.map(h => ({
          id: h.id,
          statement: statementOf(request, h.id),
          evidence: h.evidence.map(pick)
        }))
      )
    }),
  schema: CONCLUSION_SCHEMA,
  policy: (prompt, request) => {
    if (!request.input.hypotheses.length)
      throw new ArgumentStepError("a conclusion needs at least one verified hypothesis");
    overBudget(prompt, CONCLUSION_SCHEMA);
  },
  parse: parseConclusion
};
