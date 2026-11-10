import { ANSWER_KEYS, COMPARISON_BASES, VETO_KINDS } from "../../argument-map/model";
import type { ComparisonDraft, VetoDraft } from "../../argument-map/machine-v2";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import { ArgumentStepError, languageInstruction, list, overBudget, type ArgumentStepBase } from "./shared";
import {
  S,
  asArr,
  asRec,
  exact,
  fromRequest,
  groundedIn,
  hasKey,
  idsFrom,
  idsOf,
  parseReply,
  pick,
  short,
  strOf
} from "./v2-shared";
import template from "./v2-comparison.md";

/** `input` is exactly `prepareComparison(state, claimId)` of machine-v2: verdicts, confidence, assessed evidence and shared sources. No page text, no user mark. */
export interface ComparisonRequest extends ArgumentStepBase {
  input: Record<string, unknown>;
}

const DECISIONS = ["complete", "rejudge", "add_alternative", "undecidable"] as const;
/** `unhandled_counter` is the program's own veto; the model writes the other three. */
const AI_VETOES = VETO_KINDS.filter(k => k !== "unhandled_counter");
/** The strict "does not apply" form: the property is always there, `null` when it does not apply. */
const orNull = {
  str: { type: ["string", "null"] },
  strings: { type: ["array", "null"], items: { type: "string", minLength: 1 } },
  enum: (values: readonly string[]): Record<string, unknown> => ({ type: ["string", "null"], enum: [...values, null] })
};
export const COMPARISON_SCHEMA = S.obj({
  decision: S.enum(DECISIONS),
  vetoes: S.arr(S.obj({ kind: S.enum(AI_VETOES), detail: S.str })),
  allocations: S.arr(S.obj({ needId: S.str, hypothesisId: S.str })),
  rejudge: S.arr(S.str),
  answer: orNull.enum(ANSWER_KEYS),
  contributors: orNull.strings,
  largest: orNull.str,
  basis: orNull.enum(COMPARISON_BASES)
});

export function parseComparison(raw: string, request: ComparisonRequest): ComparisonDraft {
  const input = request.input;
  const top = exact(
    parseReply(raw),
    ["decision", "vetoes", "allocations", "rejudge", "answer", "contributors", "largest", "basis"],
    "The reply"
  );
  const decision = pick(DECISIONS, top.decision, "decision");
  const hypothesisIds = new Set(idsOf(input.hypotheses, "id"));
  const needIds = new Set(asArr(input.hypotheses).flatMap(h => idsOf(asRec(h).evidence, "needId")));
  const room = asRec(asRec(input.comparison).room);
  const vetoes = list(top.vetoes, "vetoes").map((entry, i): VetoDraft => {
    const one = exact(entry, ["kind", "detail"], `veto ${i + 1}`);
    return { kind: pick(AI_VETOES, one.kind, "kind"), detail: short(one.detail, "detail") };
  });
  const allocations = list(top.allocations, "allocations").map((entry, i) => {
    const one = exact(entry, ["needId", "hypothesisId"], `allocation ${i + 1}`);
    return {
      needId: fromRequest(one.needId, needIds, "needId"),
      hypothesisId: fromRequest(one.hypothesisId, hypothesisIds, "hypothesisId")
    };
  });
  const rejudge = idsFrom(top.rejudge, hypothesisIds, "rejudge");
  const sendBack = new Set(asArr(room.canSendBack).filter((id): id is string => typeof id === "string"));
  if (rejudge.some(id => !sendBack.has(id)))
    throw new ArgumentStepError("a hypothesis can be sent back once, and only if the AI judged it");
  if (decision === "complete" ? vetoes.length : !vetoes.length)
    throw new ArgumentStepError("a complete comparison has no veto, and every remedy needs one");
  if (decision === "rejudge" ? !rejudge.length : rejudge.length)
    throw new ArgumentStepError("only a rejudge names hypotheses to send back");
  if (decision === "add_alternative" && (!room.canAddAlternative || !vetoes.some(v => v.kind === "missed_alternative")))
    throw new ArgumentStepError("add_alternative needs a missed_alternative veto and room for one");

  const type = asRec(input.claim).type;
  const draft: ComparisonDraft = { decision, vetoes, allocations };
  if (rejudge.length) draft.rejudge = rejudge;
  const answerGiven = top.answer !== null;
  if (decision === "complete") {
    if (!answerGiven) throw new ArgumentStepError("a complete comparison gives an answer");
    draft.answer = pick(ANSWER_KEYS, top.answer, "answer");
  } else if (answerGiven) throw new ArgumentStepError("only a complete comparison gives an answer");
  const extras = [top.contributors, top.largest, top.basis];
  if (decision !== "complete" || type !== "main_cause") {
    if (extras.some(x => x !== null))
      throw new ArgumentStepError("contributors, largest and basis belong to a complete main-cause answer");
  } else {
    if (top.contributors !== null) draft.contributors = idsFrom(top.contributors, hypothesisIds, "contributors");
    if (top.largest !== null) {
      draft.largest = fromRequest(top.largest, new Set(draft.contributors ?? []), "largest");
    }
    if (top.basis !== null) draft.basis = pick(COMPARISON_BASES, top.basis, "basis");
  }
  groundedIn(
    vetoes.map(v => v.detail),
    input
  );
  return draft;
}

/** Compare the hypotheses of one claim once each has a verdict. Text-only; `applyComparison` still decides whether the answer may stand. */
export const comparisonStep: StepDefinition<ComparisonRequest, ComparisonDraft> = {
  id: "argument-map.v2-comparison",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, strOf(asRec(asRec(request.input).claim).text)),
      input: JSON.stringify(request.input)
    }),
  schema: COMPARISON_SCHEMA,
  policy: (prompt, request) => {
    if (!request.input || typeof request.input !== "object")
      throw new ArgumentStepError("a comparison needs its input");
    if (hasKey(request.input, "userVerdict")) throw new ArgumentStepError("a user mark never reaches a comparison");
    if (!Array.isArray(request.input.hypotheses) || !request.input.hypotheses.length)
      throw new ArgumentStepError("a comparison needs hypotheses");
    overBudget(prompt, COMPARISON_SCHEMA);
  },
  parse: parseComparison
};
