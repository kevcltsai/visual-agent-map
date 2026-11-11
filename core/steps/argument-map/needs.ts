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
  existing: { text: string; state: string; claim?: string; period?: string; reason?: string }[];
  /** Decision #62. `first`: the first round of a facet-judged hypothesis, exactly one need is the core. `replace`: a later round; at most one need, a new core standing in for one nobody found. Absent: the V1 behaviour, no core. */
  core?: "first" | "replace";
  /** At most this many new needs (see {@link needsAllowed}). */
  max: number;
}
export interface NeedsResult {
  needs: { text: string; core?: true }[];
}

const NO_CORE_RULE = 'No need is the core here: set "core": false on every need.';
const CORE_RULES = {
  first:
    'Exactly one of the needs is the core need: the single piece of evidence that decides whether the hypothesis holds. Mark it with "core": true and set "core": false on every other need.',
  replace:
    'The earlier core need was not found. You may list at most one new core need, marked with "core": true, only if it asks for something that can decide the hypothesis and can be found; set "core": false on every other need.'
} as const;

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
        properties: { text: { type: "string", minLength: 1 }, core: { type: "boolean" } },
        required: ["text", "core"]
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
  ...request.existing.flatMap(n => [n.text, n.claim ?? "", n.period ?? "", n.reason ?? ""]),
  ...request.data.flatMap(d => [d.need, d.claim, d.quote, d.url, d.stance])
];

export function parseNeeds(raw: string, request: NeedsRequest): NeedsResult {
  const item = parseObject(raw, ["needs"]);
  const entries = list(item.needs, "needs");
  if (!entries.length || entries.length > request.max)
    throw new ArgumentStepError(`expected 1 to ${request.max} needs`);
  const seen = new Set(request.existing.map(n => normalized(n.text)));
  const needs = entries.map(entry => {
    const one = parseObject(JSON.stringify(entry), entry && typeof entry === "object" && "core" in entry ? ["text", "core"] : ["text"]);
    if (one.core !== undefined && typeof one.core !== "boolean") throw new ArgumentStepError("core must be a boolean");
    if (one.core === true && !request.core) throw new ArgumentStepError("no core need is asked for");
    const body = text(one.text, "text");
    const key = normalized(body);
    if (seen.has(key)) throw new ArgumentStepError("a need repeats another one");
    seen.add(key);
    grounded([body], sourcesOf(request));
    return one.core === true ? { text: body, core: true as const } : { text: body };
  });
  const cores = needs.filter(n => n.core).length;
  if (request.core === "first" && cores !== 1) throw new ArgumentStepError("exactly one need must be the core");
  if (request.core === "replace" && cores > 1) throw new ArgumentStepError("at most one need may be the core");
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
      coreRule: ` ${request.core ? CORE_RULES[request.core] : NO_CORE_RULE}`,
      existing: JSON.stringify(
        request.existing.map(n => ({ text: n.text, state: n.state, claim: n.claim, period: n.period, reason: n.reason }))
      )
    }),
  schema: NEEDS_SCHEMA,
  policy: (prompt, request) => {
    if (request.core !== undefined && request.core !== "first" && request.core !== "replace")
      throw new ArgumentStepError("unknown core mode");
    if (!Number.isInteger(request.max) || request.max < 1) throw new ArgumentStepError("no needs may be added");
    overBudget(prompt, NEEDS_SCHEMA);
  },
  parse: parseNeeds
};
