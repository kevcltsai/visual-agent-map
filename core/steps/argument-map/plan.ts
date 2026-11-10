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
import template from "./plan.md";
import { MAX_SITUATION_DATA } from "../../argument-map/model-v1";

export interface PlanSituationRequest extends ArgumentStepBase {
  proposition: string;
  /** At most this many data needs (the machine's `MAX_SITUATION_DATA`). */
  max: number;
}
/** The needs only: the program, not the model, assigns the ids when it applies them with `applySituationData`. */
export interface PlanSituationResult {
  data: { need: string }[];
}

export const PLAN_SITUATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    data: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { need: { type: "string", minLength: 1 } },
        required: ["need"]
      },
      minItems: 1
    }
  },
  required: ["data"]
};

export function parsePlanSituation(raw: string, request: PlanSituationRequest): PlanSituationResult {
  const item = parseObject(raw, ["data"]);
  const entries = list(item.data, "data");
  if (!entries.length || entries.length > request.max)
    throw new ArgumentStepError(`expected 1 to ${request.max} situation data`);
  const seen = new Set<string>();
  const data = entries.map(entry => {
    const one = parseObject(JSON.stringify(entry), ["need"]);
    const need = text(one.need, "need");
    const key = normalized(need);
    if (seen.has(key)) throw new ArgumentStepError("a situation need repeats another one");
    seen.add(key);
    grounded([need], [request.proposition]);
    return { need };
  });
  return { data };
}

/** List the situation data to look up before judging the proposition. Text-only; ids are made by the program. */
export const planSituationStep: StepDefinition<PlanSituationRequest, PlanSituationResult> = {
  id: "argument-map.plan-situation",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.proposition),
      max: String(request.max),
      proposition: JSON.stringify(request.proposition)
    }),
  schema: PLAN_SITUATION_SCHEMA,
  policy: (prompt, request) => {
    if (!Number.isInteger(request.max) || request.max < 1 || request.max > MAX_SITUATION_DATA)
      throw new ArgumentStepError("the number of situation data is out of range");
    overBudget(prompt, PLAN_SITUATION_SCHEMA);
  },
  parse: parsePlanSituation
};
