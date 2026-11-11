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
  /** `prepareConclusion`'s output: every hypothesis of a facet map with its status and evidence (decision #63); a map without facets lists the verified ones only. */
  input: ConclusionInput;
  /** Statement of each listed hypothesis, by id (exactly the ids in `input`). */
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
  /** Every verified hypothesis a point rests on, for `applyConclusion`; a point may also cite a hypothesis that is not verified, which is never added here. */
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
  stance: e.stance,
  ...(e.core === true ? { core: true as const } : {})
});
/** A hypothesis without a status comes from a map that lists verified hypotheses only. */
const isVerifiedIn = (h: ConclusionInput["hypotheses"][number]): boolean =>
  h.status === undefined || h.status === "verified";
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
  const verified = new Set(request.input.hypotheses.filter(isVerifiedIn).map(h => h.id));
  const basedOn: string[] = [];
  const points = entries.map(entry => {
    const one = parseObject(JSON.stringify(entry), ["text", "hypothesisIds"]);
    const body = text(one.text, "text");
    const hypothesisIds = citation(one.hypothesisIds, allowed, "hypothesisIds");
    for (const id of hypothesisIds) if (verified.has(id) && !basedOn.includes(id)) basedOn.push(id);
    return { text: body, hypothesisIds };
  });
  if (!basedOn.length) throw new ArgumentStepError("at least one point must rest on a verified hypothesis");
  noIds(
    [summary, ...points.map(p => p.text)],
    request.input.hypotheses.flatMap(h => [h.id, ...h.evidence.map(e => e.id)])
  );
  grounded([summary, ...points.map(p => p.text)], sourcesOf(request));
  return { summary, points, basedOn };
}

/** Write the conclusion from the hypotheses and their evidence: compare their strength, rest it on the verified ones. Text-only. */
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
          ...(h.status === undefined ? {} : { status: h.status }),
          statement: statementOf(request, h.id),
          evidence: h.evidence.map(pick)
        }))
      )
    }),
  schema: CONCLUSION_SCHEMA,
  policy: (prompt, request) => {
    if (!request.input.hypotheses.some(isVerifiedIn))
      throw new ArgumentStepError("a conclusion needs at least one verified hypothesis");
    overBudget(prompt, CONCLUSION_SCHEMA);
  },
  parse: parseConclusion
};
