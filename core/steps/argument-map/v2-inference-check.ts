import type { InferenceItem } from "../../argument-map/machine-v2";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import { ArgumentStepError, languageInstruction, list, overBudget, type ArgumentStepBase } from "./shared";
import { S, asArr, asRec, exact, groundedIn, hasKey, idsOf, maybeText, parseReply, pick, short } from "./v2-shared";
import template from "./v2-inference-check.md";

/** `input` is exactly `prepareInferenceCheck(state)` of machine-v2: the sentences and the conclusion's own input. */
export interface InferenceCheckRequest extends ArgumentStepBase {
  input: Record<string, unknown>;
}

const STATUSES = ["ok", "rewrite", "delete"] as const;
export const INFERENCE_CHECK_SCHEMA = S.obj({
  items: S.arr(S.obj({ id: S.str, status: S.enum(STATUSES), rewrite: S.free }), 1)
});

export function parseInferenceCheck(raw: string, request: InferenceCheckRequest): InferenceItem[] {
  const input = request.input;
  const top = exact(parseReply(raw), ["items"], "The reply");
  const ids = new Set(idsOf(input.sentences, "id"));
  const entries = list(top.items, "items");
  if (entries.length !== ids.size) throw new ArgumentStepError("check every sentence, once");
  const required = new Map<string, string[]>();
  for (const c of asArr(asRec(input.basis).claims).map(asRec))
    required.set(
      String(c.id),
      asArr(asRec(c.comparison).requiredAssumptions).filter((a): a is string => typeof a === "string")
    );
  const seen = new Set<string>();
  const items = entries.map((entry, i): InferenceItem => {
    const one = exact(entry, ["id", "status", "rewrite"], `item ${i + 1}`);
    if (typeof one.id !== "string" || !ids.has(one.id)) throw new ArgumentStepError("id is outside the request");
    if (seen.has(one.id)) throw new ArgumentStepError("a sentence is checked twice");
    seen.add(one.id);
    const status = pick(STATUSES, one.status, "status");
    if (status !== "rewrite") {
      if (maybeText(one.rewrite, "rewrite") !== "") throw new ArgumentStepError("only a rewrite carries a sentence");
      return { id: one.id, status };
    }
    const rewrite = short(one.rewrite, "rewrite");
    for (const a of required.get(one.id) ?? [])
      if (!rewrite.includes(a)) throw new ArgumentStepError("an assumption must be written into the sentence itself");
    return { id: one.id, status, rewrite };
  });
  groundedIn(
    items.flatMap(item => (item.rewrite ? [item.rewrite] : [])),
    input
  );
  return items;
}

/** Check each conclusion sentence against the answers it may state. Text-only; `applyInferenceCheck` still gates the rewrite. */
export const inferenceCheckStep: StepDefinition<InferenceCheckRequest, InferenceItem[]> = {
  id: "argument-map.v2-inference-check",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(
        request.language,
        String(asRec(asRec(asRec(request.input.basis).framing)).original ?? "")
      ),
      input: JSON.stringify(request.input)
    }),
  schema: INFERENCE_CHECK_SCHEMA,
  policy: (prompt, request) => {
    if (!request.input || typeof request.input !== "object") throw new ArgumentStepError("a check needs its input");
    if (hasKey(request.input, "userVerdict")) throw new ArgumentStepError("a user mark never reaches the check");
    if (!Array.isArray(request.input.sentences) || !request.input.sentences.length)
      throw new ArgumentStepError("there is no sentence to check");
    overBudget(prompt, INFERENCE_CHECK_SCHEMA);
  },
  parse: parseInferenceCheck
};
