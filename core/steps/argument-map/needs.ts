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
import type { GateDatum } from "./gate";
import template from "./needs.md";
import { MAX_NEEDS, MAX_ROUND_NEEDS, type Hypothesis } from "../../argument-map/model";

export interface NeedsRequest extends ArgumentStepBase {
  proposition: string;
  hypothesis: { title: string; statement: string; round: number };
  /** Only the situation data this hypothesis cites. */
  data: GateDatum[];
  /** Needs already on this hypothesis; the model must not repeat them. */
  existing: { text: string; state: string }[];
  /** At most this many new needs (see {@link needsAllowed}). */
  max: number;
}
export interface NeedsResult {
  needs: { text: string }[];
}

/** How many needs may still be added to a hypothesis this round; the same limits as the machine's `addNeeds`. */
export function needsAllowed(h: Hypothesis): number {
  const inRound = h.needs.filter(n => n.addedRound === h.round).length;
  return Math.max(0, Math.min(MAX_ROUND_NEEDS - inRound, MAX_NEEDS - h.needs.length));
}

export const NEEDS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    needs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string", minLength: 1 } },
        required: ["text"]
      },
      minItems: 1
    }
  },
  required: ["needs"]
};

const sourcesOf = (request: NeedsRequest): string[] => [
  request.proposition,
  request.hypothesis.title,
  request.hypothesis.statement,
  String(request.hypothesis.round),
  ...request.existing.map(n => n.text),
  ...request.data.flatMap(d => [d.need, d.claim, d.quote, d.url, d.stance])
];

export function parseNeeds(raw: string, request: NeedsRequest): NeedsResult {
  const item = parseObject(raw, ["needs"]);
  const entries = list(item.needs, "needs");
  if (!entries.length || entries.length > request.max)
    throw new ArgumentStepError(`expected 1 to ${request.max} needs`);
  const seen = new Set(request.existing.map(n => normalized(n.text)));
  const needs = entries.map(entry => {
    const one = parseObject(JSON.stringify(entry), ["text"]);
    const body = text(one.text, "text");
    const key = normalized(body);
    if (seen.has(key)) throw new ArgumentStepError("a need repeats another one");
    seen.add(key);
    grounded([body], sourcesOf(request));
    return { text: body };
  });
  return { needs };
}

/** List the evidence needs of one hypothesis. Text-only; add-only: the reply can only add needs. */
export const needsStep: StepDefinition<NeedsRequest, NeedsResult> = {
  id: "argument-map.needs",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.proposition),
      max: String(request.max),
      proposition: JSON.stringify(request.proposition),
      hypothesis: JSON.stringify({
        title: request.hypothesis.title,
        statement: request.hypothesis.statement,
        round: request.hypothesis.round
      }),
      data: JSON.stringify(
        request.data.map(d => ({
          id: d.id,
          need: d.need,
          claim: d.claim,
          quote: d.quote,
          url: d.url,
          stance: d.stance
        }))
      ),
      existing: JSON.stringify(request.existing.map(n => ({ text: n.text, state: n.state })))
    }),
  schema: NEEDS_SCHEMA,
  policy: (prompt, request) => {
    if (!Number.isInteger(request.max) || request.max < 1) throw new ArgumentStepError("no needs may be added");
    overBudget(prompt, NEEDS_SCHEMA);
  },
  parse: parseNeeds
};
