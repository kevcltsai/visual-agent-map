import { ANSWER_KEYS } from "../../argument-map/model";
import type { ConclusionDraft } from "../../argument-map/machine-v2";
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
  maybeText,
  parseReply,
  pick,
  short,
  strOf
} from "./v2-shared";
import template from "./v2-conclusion.md";

/** `input` is exactly `prepareConclusion(state)` of machine-v2: the locked framing, each claim's comparison result and verdict summaries. No evidence text, no user mark. */
export interface ConclusionV2Request extends ArgumentStepBase {
  input: Record<string, unknown>;
}

export const CONCLUSION_V2_SCHEMA = S.obj({
  answers: S.arr(S.obj({ claimId: S.str, answer: S.enum(ANSWER_KEYS), sentence: S.str, assumptions: S.arr(S.str) }), 1),
  overall: S.free
});

/** The testable claims that were evaluated: each gets exactly one answer. */
const evaluated = (input: Record<string, unknown>): Record<string, unknown>[] =>
  asArr(input.claims)
    .map(asRec)
    .filter(c => c.evaluated === true);

export function parseConclusionV2(raw: string, request: ConclusionV2Request): ConclusionDraft {
  const input = request.input;
  const top = exact(parseReply(raw), ["answers", "overall"], "The reply");
  const claims = new Map(evaluated(input).map(c => [String(c.id), c]));
  const entries = list(top.answers, "answers");
  if (entries.length !== claims.size) throw new ArgumentStepError("answer every evaluated claim, once");
  const seen = new Set<string>();
  const answers = entries.map((entry, i) => {
    const one = exact(entry, ["claimId", "answer", "sentence", "assumptions"], `answer ${i + 1}`);
    const claimId = fromRequest(one.claimId, new Set(claims.keys()), "claimId");
    if (seen.has(claimId)) throw new ArgumentStepError("a claim is answered twice");
    seen.add(claimId);
    const answer = pick(ANSWER_KEYS, one.answer, "answer");
    const comparison = asRec(claims.get(claimId)?.comparison);
    if (answer !== comparison.answer) throw new ArgumentStepError("the answer must be the comparison's");
    const sentence = short(one.sentence, "sentence");
    const need = asArr(comparison.requiredAssumptions).filter((a): a is string => typeof a === "string");
    const assumptions = list(one.assumptions, "assumptions").map(a => fromRequest(a, new Set(need), "assumptions"));
    if (assumptions.length !== need.length || new Set(assumptions).size !== need.length)
      throw new ArgumentStepError("list exactly the assumptions the answer rests on");
    for (const a of need)
      if (!sentence.includes(a)) throw new ArgumentStepError("an assumption must be written into the sentence itself");
    if (comparison.answer === "main_cause_undecidable" && comparison.largest !== null)
      for (const id of asArr(comparison.contributors))
        if (typeof id === "string" && !sentence.includes(id))
          throw new ArgumentStepError("a subset result must name every compared candidate");
    return { claimId, answer, sentence, assumptions };
  });
  const draft: ConclusionDraft = { answers };
  const overall = maybeText(top.overall, "overall");
  if (overall) {
    const composition = asRec(input.framing).composition;
    if (typeof composition !== "string" || !composition.trim())
      throw new ArgumentStepError(
        "the breakdown has no composition rule: report the claims, not a whole-sentence answer"
      );
    draft.overall = overall;
  }
  groundedIn([...answers.map(a => a.sentence), ...(draft.overall ? [draft.overall] : [])], input);
  return draft;
}

/** Write the conclusion: one answer and sentence per evaluated claim, equal to its comparison's. Text-only; `applyConclusion` still gates it. */
export const conclusionV2Step: StepDefinition<ConclusionV2Request, ConclusionDraft> = {
  id: "argument-map.v2-conclusion",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(
        request.language,
        strOf(asRec(asRec(request.input).framing).original) || strOf(asRec(asRec(request.input).framing).restatement)
      ),
      input: JSON.stringify(request.input)
    }),
  schema: CONCLUSION_V2_SCHEMA,
  policy: (prompt, request) => {
    if (!request.input || typeof request.input !== "object")
      throw new ArgumentStepError("a conclusion needs its input");
    if (hasKey(request.input, "userVerdict")) throw new ArgumentStepError("a user mark never reaches a conclusion");
    if (!evaluated(request.input).length) throw new ArgumentStepError("a conclusion needs an evaluated claim");
    overBudget(prompt, CONCLUSION_V2_SCHEMA);
  },
  parse: parseConclusionV2
};
