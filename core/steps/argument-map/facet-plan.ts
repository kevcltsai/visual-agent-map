import { renderTemplate, type StepDefinition } from "../../step-runner";
import { MAX_FACET_NEEDS, MAX_FACETS, MAX_SITUATION_NEEDS, MIN_FACETS } from "../../argument-map/model";
import {
  ArgumentStepError,
  grounded,
  groundedLinks,
  languageInstruction,
  list,
  normalized,
  overBudget,
  parseObject,
  text,
  type ArgumentStepBase
} from "./shared";
import template from "./facet-plan.md";

export interface FacetPlanRequest extends ArgumentStepBase {
  proposition: string;
}
/** Fact needs only: the program assigns every id, and a "cause" need has already moved into `causalQuestions`. */
export interface FacetPlanResult {
  assumptions: { items: { label: string; value: string; reason: string }[] };
  facets: { title: string; needs: { need: string }[] }[];
  causalQuestions: string[];
}

export const NEED_KINDS = ["fact", "cause"] as const;

export const FACET_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    assumptions: {
      type: "object",
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: { type: "string", minLength: 1 },
              value: { type: "string", minLength: 1 },
              reason: { type: "string", minLength: 1 }
            },
            required: ["label", "value", "reason"]
          }
        }
      },
      required: ["items"]
    },
    facets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", minLength: 1 },
          needs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { need: { type: "string", minLength: 1 }, kind: { type: "string", enum: [...NEED_KINDS] } },
              required: ["need", "kind"]
            }
          }
        },
        required: ["title", "needs"]
      },
      minItems: MIN_FACETS
    },
    causalQuestions: { type: "array", items: { type: "string", minLength: 1 } }
  },
  required: ["assumptions", "facets", "causalQuestions"]
};

export function parseFacetPlan(raw: string, request: FacetPlanRequest): FacetPlanResult {
  const item = parseObject(raw, ["assumptions", "facets", "causalQuestions"]);
  const sources = [request.proposition];
  const assumptionList = parseObject(JSON.stringify(item.assumptions), ["items"]);
  const items = list(assumptionList.items, "assumptions.items").map(entry => {
    const one = parseObject(JSON.stringify(entry), ["label", "value", "reason"]);
    const label = text(one.label, "label");
    const value = text(one.value, "value");
    const reason = text(one.reason, "reason");
    grounded([label, reason], sources);
    groundedLinks([value], sources);
    return { label, value, reason };
  });
  const entries = list(item.facets, "facets");
  if (entries.length < MIN_FACETS || entries.length > MAX_FACETS)
    throw new ArgumentStepError(`expected ${MIN_FACETS} to ${MAX_FACETS} facets`);
  const titles = new Set<string>();
  const needKeys = new Set<string>();
  const causal: string[] = [];
  const causalKeys = new Set<string>();
  const addCausal = (question: string): void => {
    const key = normalized(question);
    if (causalKeys.has(key)) return;
    causalKeys.add(key);
    grounded([question], sources);
    causal.push(question);
  };
  let total = 0;
  const facets = entries.map(entry => {
    const one = parseObject(JSON.stringify(entry), ["title", "needs"]);
    const title = text(one.title, "title");
    const titleKey = normalized(title);
    if (titles.has(titleKey)) throw new ArgumentStepError("a facet title repeats another one");
    titles.add(titleKey);
    grounded([title], sources);
    const needs: { need: string }[] = [];
    for (const raw of list(one.needs, "needs")) {
      const need = parseObject(JSON.stringify(raw), ["need", "kind"]);
      const needText = text(need.need, "need");
      if (!(NEED_KINDS as readonly unknown[]).includes(need.kind)) throw new ArgumentStepError("unknown need kind");
      const key = normalized(needText);
      if (needKeys.has(key)) throw new ArgumentStepError("a situation need repeats another one");
      needKeys.add(key);
      grounded([needText], sources);
      if (need.kind === "cause") addCausal(needText);
      else needs.push({ need: needText });
    }
    if (needs.length < 1 || needs.length > MAX_FACET_NEEDS)
      throw new ArgumentStepError(`a facet needs 1 to ${MAX_FACET_NEEDS} fact needs`);
    total += needs.length;
    return { title, needs };
  });
  if (total > MAX_SITUATION_NEEDS) throw new ArgumentStepError(`expected at most ${MAX_SITUATION_NEEDS} fact needs`);
  for (const question of list(item.causalQuestions, "causalQuestions")) addCausal(text(question, "causal question"));
  return { assumptions: { items }, facets, causalQuestions: causal };
}

/** Plan the facets, their fact needs, the assumption card items and the causal questions of one proposition. Text-only; ids are made by the program. */
export const facetPlanStep: StepDefinition<FacetPlanRequest, FacetPlanResult> = {
  id: "argument-map.facet-plan",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.proposition),
      proposition: JSON.stringify(request.proposition)
    }),
  schema: FACET_PLAN_SCHEMA,
  policy: prompt => overBudget(prompt, FACET_PLAN_SCHEMA),
  parse: parseFacetPlan
};
