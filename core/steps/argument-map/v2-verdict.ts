import {
  ASSUMPTION_STATES,
  CAUSAL_STATES,
  CONFIDENCES,
  REFUTATION_CLASSES,
  VERDICT_VALUES
} from "../../argument-map/model";
import type { AssumptionDraft, RefutationDraft, VerdictDraft } from "../../argument-map/machine-v2";
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
  short
} from "./v2-shared";
import template from "./v2-verdict.md";

/**
 * The verdict of one hypothesis. `input` is exactly `prepareVerdict(state, hypothesisId)` of machine-v2: this hypothesis' needs and the
 * counter-evidence the comparison allocated to it. No page text, no user mark, no other hypothesis.
 */
export interface VerdictV2Request extends ArgumentStepBase {
  input: Record<string, unknown>;
}

const AI_VALUES = VERDICT_VALUES.filter(v => v !== "insufficient");
export const VERDICT_V2_SCHEMA = S.obj({
  value: S.enum(AI_VALUES),
  reason: S.str,
  citedNeeds: S.arr(S.str),
  counterNotes: S.arr(S.str),
  refutations: S.arr(S.obj({ needId: S.str, class: S.enum(REFUTATION_CLASSES), auxiliary: S.arr(S.str) })),
  causal: S.enum(CAUSAL_STATES),
  assumptionStatus: S.arr(S.obj({ assumption: S.str, status: S.enum(ASSUMPTION_STATES), defense: S.free })),
  confidence: S.enum(CONFIDENCES)
});

export function parseVerdictV2(raw: string, request: VerdictV2Request): VerdictDraft {
  const input = request.input;
  const top = exact(
    parseReply(raw),
    ["value", "reason", "citedNeeds", "counterNotes", "refutations", "causal", "assumptionStatus", "confidence"],
    "The reply"
  );
  if (top.value === "insufficient") throw new ArgumentStepError("only the program can give insufficient");
  const value = pick(AI_VALUES, top.value, "value");
  const reason = short(top.reason, "reason");
  const needIds = new Set(idsOf(input.evidence, "needId"));
  const citedNeeds = idsFrom(top.citedNeeds, needIds, "citedNeeds");
  const counter = new Set(asArr(input.counterEvidence).filter((id): id is string => typeof id === "string"));
  const premiseIds = new Set(idsOf(input.premises, "id"));
  const refutations = list(top.refutations, "refutations").map((entry, i): RefutationDraft => {
    const one = exact(entry, ["needId", "class", "auxiliary"], `refutation ${i + 1}`);
    return {
      needId: fromRequest(one.needId, counter, "needId"),
      class: pick(REFUTATION_CLASSES, one.class, "class"),
      auxiliary: idsFrom(one.auxiliary, premiseIds, "auxiliary")
    };
  });
  if (refutations.length !== counter.size || new Set(refutations.map(r => r.needId)).size !== counter.size)
    throw new ArgumentStepError("classify every counter-evidence, once");
  const notes = list(top.counterNotes, "counterNotes").map(n => short(n, "counterNotes"));
  if (notes.length !== refutations.length)
    throw new ArgumentStepError("counterNotes must match the refutations one to one");
  const wanted = asArr(asRec(input.identification).assumptions).filter((a): a is string => typeof a === "string");
  const given = list(top.assumptionStatus, "assumptionStatus").map((entry, i): AssumptionDraft => {
    const one = exact(entry, ["assumption", "status", "defense"], `assumption ${i + 1}`);
    const assumption = fromRequest(one.assumption, new Set(wanted), "assumption");
    const status = pick(ASSUMPTION_STATES, one.status, "status");
    const defense = typeof one.defense === "string" ? one.defense.trim() : null;
    if (defense === null) throw new ArgumentStepError("defense must be a string");
    if (status === "defended") return { assumption, status, defense: short(defense, "defense") };
    if (defense !== "") throw new ArgumentStepError("only a defended assumption has a defense");
    return { assumption, status };
  });
  if (new Set(given.map(a => a.assumption)).size !== given.length)
    throw new ArgumentStepError("an assumption is listed twice");
  const causal = pick(CAUSAL_STATES, top.causal, "causal");
  const confidence = pick(CONFIDENCES, top.confidence, "confidence");
  groundedIn([reason, ...notes, ...given.flatMap(a => (a.defense ? [a.defense] : []))], input);
  return { value, reason, citedNeeds, counterNotes: notes, refutations, causal, assumptionStatus: given, confidence };
}

/** Judge one hypothesis from its own evidence. Text-only; `applyVerdict` still decides whether the verdict may stand. */
export const verdictV2Step: StepDefinition<VerdictV2Request, VerdictDraft> = {
  id: "argument-map.v2-verdict",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, strOf(asRec(request.input.claim).text)),
      input: JSON.stringify(request.input)
    }),
  schema: VERDICT_V2_SCHEMA,
  policy: (prompt, request) => {
    if (!request.input || typeof request.input !== "object") throw new ArgumentStepError("a verdict needs its input");
    if (hasKey(request.input, "userVerdict")) throw new ArgumentStepError("a user mark never reaches a verdict");
    if (!Array.isArray(request.input.evidence) || !Array.isArray(request.input.counterEvidence))
      throw new ArgumentStepError("a verdict needs its evidence");
    overBudget(prompt, VERDICT_V2_SCHEMA);
  },
  parse: parseVerdictV2
};
