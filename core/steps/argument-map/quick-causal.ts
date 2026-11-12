import { renderTemplate, type StepDefinition } from "../../step-runner";
import { MAX_ROUND_NEEDS, MIN_VERIFIED } from "../../argument-map/model";
import { ArgumentStepError, grounded, languageInstruction, list, normalized, overBudget, parseObject, text } from "./shared";
import {
  FACET_PLAN_SCHEMA,
  checkPreset,
  parseFacetPlan,
  type FacetPlanRequest,
  type FacetPlanResult
} from "./facet-plan";
import template from "./quick-causal.md";
import presetText from "./facet-plan-preset.md";

/** The quick causal run asks for exactly this many hypotheses in its single call (the machine's MIN_VERIFIED). */
export const QUICK_HYPOTHESES = MIN_VERIFIED;
/** The plan facets of the single call; the facet plan's own bounds apply on top. */
export const QUICK_FACETS = 3;

export type QuickCausalRequest = FacetPlanRequest;
export interface QuickCausalHypothesis {
  title: string;
  statement: string;
  alternative: boolean;
  needs: { text: string; core?: true }[];
}
/** The plan of the facet plan step plus, for a causal question only, the first hypotheses with their needs (core need included). */
export interface QuickCausalResult extends FacetPlanResult {
  hypotheses: QuickCausalHypothesis[];
}

const planProperties = FACET_PLAN_SCHEMA.properties;
export const QUICK_CAUSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...planProperties,
    facets: { ...planProperties.facets, minItems: QUICK_FACETS, maxItems: QUICK_FACETS },
    hypotheses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", minLength: 1 },
          statement: { type: "string", minLength: 1 },
          alternative: { type: "boolean" },
          needs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { text: { type: "string", minLength: 1 }, core: { type: "boolean" } },
              required: ["text", "core"]
            },
            minItems: 1,
            maxItems: MAX_ROUND_NEEDS
          }
        },
        required: ["title", "statement", "alternative", "needs"]
      },
      maxItems: QUICK_HYPOTHESES
    }
  },
  required: [...FACET_PLAN_SCHEMA.required, "hypotheses"]
};

export function parseQuickCausal(raw: string, request: QuickCausalRequest): QuickCausalResult {
  const item = parseObject(raw, [...FACET_PLAN_SCHEMA.required, "hypotheses"]);
  const { hypotheses: entries, ...planned } = item;
  // The plan part is the facet plan's own reply: the same validation, grounding and caps.
  const plan = parseFacetPlan(JSON.stringify(planned), request);
  if (plan.facets.length !== QUICK_FACETS) throw new ArgumentStepError(`expected exactly ${QUICK_FACETS} facets`);
  const given = list(entries, "hypotheses");
  if (plan.questionType !== "causal") {
    // A fact question is planned by the ordinary plan step afterwards; whatever came back with it is dropped unread.
    return { ...plan, hypotheses: [] };
  }
  if (given.length !== QUICK_HYPOTHESES) throw new ArgumentStepError(`expected exactly ${QUICK_HYPOTHESES} hypotheses`);
  const sources = [
    request.proposition,
    ...(request.today ? [request.today] : []),
    ...plan.assumptions.items.map(a => a.value),
    ...plan.causalQuestions
  ];
  const questions = new Set(plan.causalQuestions.map(normalized));
  const seen = new Set<string>();
  const hypotheses = given.map(entry => {
    const one = parseObject(JSON.stringify(entry), ["title", "statement", "alternative", "needs"]);
    const title = text(one.title, "title");
    const statement = text(one.statement, "statement");
    if (typeof one.alternative !== "boolean") throw new ArgumentStepError("alternative must be a boolean");
    const key = normalized(title);
    if (questions.has(key)) throw new ArgumentStepError("a hypothesis title repeats a causal question");
    if (seen.has(key)) throw new ArgumentStepError("a hypothesis repeats another one");
    seen.add(key);
    grounded([title, statement], sources);
    const rawNeeds = list(one.needs, "needs");
    if (!rawNeeds.length || rawNeeds.length > MAX_ROUND_NEEDS)
      throw new ArgumentStepError(`a hypothesis needs 1 to ${MAX_ROUND_NEEDS} evidence needs`);
    const needKeys = new Set<string>();
    const needs = rawNeeds.map(raw => {
      const need = parseObject(JSON.stringify(raw), ["text", "core"]);
      if (typeof need.core !== "boolean") throw new ArgumentStepError("core must be a boolean");
      const body = text(need.text, "text");
      const needKey = normalized(body);
      if (needKeys.has(needKey)) throw new ArgumentStepError("a need repeats another one");
      needKeys.add(needKey);
      grounded([body], [...sources, title, statement]);
      return need.core ? { text: body, core: true as const } : { text: body };
    });
    if (needs.filter(n => n.core).length !== 1) throw new ArgumentStepError("exactly one need must be the core");
    return { title, statement, alternative: one.alternative, needs };
  });
  if (!hypotheses.some(h => h.alternative))
    throw new ArgumentStepError("the first batch needs at least one alternative explanation");
  return { ...plan, hypotheses };
}

/** One text-only call for the quick causal run: the plan, and for a causal question the hypotheses and their needs. The program assigns ids and enforces the machine's limits. */
export const quickCausalStep: StepDefinition<QuickCausalRequest, QuickCausalResult> = {
  id: "argument-map.quick-causal",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.proposition),
      proposition: JSON.stringify(request.proposition),
      today: request.today ? `\n\nToday's date: ${request.today}.` : "",
      preset: request.presetAssumptions?.length
        ? `\n\n${presetText.trim()}\n${JSON.stringify(request.presetAssumptions)}`
        : ""
    }),
  schema: QUICK_CAUSAL_SCHEMA,
  policy: (prompt, request) => {
    checkPreset(request.presetAssumptions, request.presetQuestionType);
    overBudget(prompt, QUICK_CAUSAL_SCHEMA);
  },
  parse: parseQuickCausal
};
