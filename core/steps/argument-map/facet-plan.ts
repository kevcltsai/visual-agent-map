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
import presetText from "./facet-plan-preset.md";

export interface FacetPlanRequest extends ArgumentStepBase {
  proposition: string;
  /** Rerun from an edited assumption card: these replace whatever the AI proposes (and are shown to it so the facets fit them). */
  presetAssumptions?: { label: string; value: string; reason: string }[];
}
/** Fact needs only: the program assigns every id, and a "cause" need has already moved into `causalQuestions`. */
export interface FacetPlanResult {
  assumptions: { items: { label: string; value: string; reason: string }[] };
  facets: { title: string; needs: { need: string }[] }[];
  causalQuestions: string[];
  /** The proposition restated as the question the situation card is titled with. */
  question: string;
}

/**
 * Words that make a question, facet title or need a CAUSAL one (decisions #36 A1/A2, #38): the situation answers only whether the
 * proposition's fact holds; why it holds belongs to the hypotheses. This is a program guard behind the prompt, so it errs towards
 * refusing. Lists cover zh-TW, zh-CN and en; "由...造成/引起" is caught by 造成/引起.
 */
export const CAUSAL_MARKERS = {
  traditional: ["造成", "導致", "引起", "原因", "因為", "是否由"],
  simplified: ["造成", "导致", "引起", "原因", "因为", "是否由"],
  en: ["cause", "caused", "causes", "causing", "because", "due to", "driven by", "reason", "reasons"]
} as const;
const CAUSAL_RE = new RegExp(
  [
    ...new Set([...CAUSAL_MARKERS.traditional, ...CAUSAL_MARKERS.simplified]),
    ...CAUSAL_MARKERS.en.map(word => `\\b${word}\\b`)
  ].join("|"),
  "i"
);
const isCausal = (value: string): boolean => CAUSAL_RE.test(value);

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
    causalQuestions: { type: "array", items: { type: "string", minLength: 1 } },
    question: { type: "string", minLength: 1 }
  },
  required: ["assumptions", "facets", "causalQuestions", "question"]
};

export function parseFacetPlan(raw: string, request: FacetPlanRequest): FacetPlanResult {
  const item = parseObject(raw, ["assumptions", "facets", "causalQuestions", "question"]);
  const sources = [request.proposition];
  const question = text(item.question, "question");
  if (isCausal(question)) throw new ArgumentStepError("the question must restate only the factual claim, not a cause");
  grounded([question], sources);
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
  const facets: { title: string; needs: { need: string }[] }[] = [];
  for (const entry of entries) {
    const one = parseObject(JSON.stringify(entry), ["title", "needs"]);
    const title = text(one.title, "title");
    const titleKey = normalized(title);
    if (titles.has(titleKey)) throw new ArgumentStepError("a facet title repeats another one");
    titles.add(titleKey);
    grounded([title], sources);
    if (isCausal(title)) continue; // a cause topic is not a facet of the fact
    const needs: { need: string }[] = [];
    for (const raw of list(one.needs, "needs")) {
      const need = parseObject(JSON.stringify(raw), ["need", "kind"]);
      const needText = text(need.need, "need");
      if (!(NEED_KINDS as readonly unknown[]).includes(need.kind)) throw new ArgumentStepError("unknown need kind");
      const key = normalized(needText);
      if (needKeys.has(key)) throw new ArgumentStepError("a situation need repeats another one");
      needKeys.add(key);
      grounded([needText], sources);
      if (need.kind === "cause" || isCausal(needText)) addCausal(needText);
      else needs.push({ need: needText });
    }
    if (needs.length < 1 || needs.length > MAX_FACET_NEEDS)
      throw new ArgumentStepError(`a facet needs 1 to ${MAX_FACET_NEEDS} fact needs`);
    total += needs.length;
    facets.push({ title, needs });
  }
  if (facets.length < MIN_FACETS)
    throw new ArgumentStepError(`expected ${MIN_FACETS} to ${MAX_FACETS} facets that are not about causes`);
  if (total > MAX_SITUATION_NEEDS) throw new ArgumentStepError(`expected at most ${MAX_SITUATION_NEEDS} fact needs`);
  for (const question of list(item.causalQuestions, "causalQuestions")) addCausal(text(question, "causal question"));
  return {
    assumptions: { items: request.presetAssumptions?.length ? request.presetAssumptions.map(a => ({ ...a })) : items },
    facets,
    causalQuestions: causal,
    question
  };
}

const PRESET_KEYS = ["label", "value", "reason"];
/** A preset is a program value read from the owner's note: three non-blank strings per item, nothing else. */
function checkPreset(preset: FacetPlanRequest["presetAssumptions"]): void {
  if (preset === undefined) return;
  if (
    !Array.isArray(preset) ||
    preset.some(
      a =>
        !a ||
        typeof a !== "object" ||
        Object.keys(a).length !== PRESET_KEYS.length ||
        PRESET_KEYS.some(
          key => typeof (a as Record<string, unknown>)[key] !== "string" || !(a as Record<string, string>)[key].trim()
        )
    )
  )
    throw new ArgumentStepError("the preset assumptions are not usable");
}

/** Plan the facets, their fact needs, the assumption card items and the causal questions of one proposition. Text-only; ids are made by the program. */
export const facetPlanStep: StepDefinition<FacetPlanRequest, FacetPlanResult> = {
  id: "argument-map.facet-plan",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.proposition),
      proposition: JSON.stringify(request.proposition),
      preset: request.presetAssumptions?.length
        ? `\n\n${presetText.trim()}\n${JSON.stringify(request.presetAssumptions)}`
        : ""
    }),
  schema: FACET_PLAN_SCHEMA,
  policy: (prompt, request) => {
    checkPreset(request.presetAssumptions);
    overBudget(prompt, FACET_PLAN_SCHEMA);
  },
  parse: parseFacetPlan
};
