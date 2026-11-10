/**
 * Version 2 argument map card content (methodology 6, mockup "Version 2"). `describeArgumentCardV2` is pure: it turns the flow state and a
 * node id into what the card says. Fixed words come from `t()`; model text (claims, predictions, assumptions, the chosen question) only
 * ever lands in `lines` or `title`, which the renderer writes with `textContent`. The conclusion card never reads the note unless the run
 * is really concluded, so an in-progress, blocked or stopped card cannot show an answer by accident. The version 1 cards
 * (`argument-card.ts`) stay as they are for legacy maps; `describeLegacyArgumentCard` only adds the read-only marker to the conclusion.
 */
import type { TranslationKey } from "../../i18n";
import {
  MAX_ROUND,
  type AnswerKey,
  type ArgumentMapData,
  type Claim,
  type CausalState,
  type Confidence,
  type Hypothesis,
  type HypothesisRole,
  type Need,
  type PremiseDatum,
  type VerdictValue,
  type VetoKind
} from "../../core/argument-map/model";
import type { ArgumentMapData as ArgumentMapDataV1 } from "../../core/argument-map/model-v1";
import { describeArgumentCard, sourceHost, type ArgumentCardView } from "./argument-card";

type Translate = (key: TranslationKey, ...values: unknown[]) => string;
export type ArgumentRoleV2 =
  "proposition" | "group" | "claim" | "datum" | "comparison" | "hypothesis" | "need" | "conclusion";
export type ChipToneV2 = "yes" | "no" | "maybe" | "gap" | "open" | "run";
export interface ArgumentChipV2 {
  tone: ChipToneV2;
  text: string;
}
/** What a card says; `ArgumentCardView` (version 1) fits it structurally, so one renderer serves both. */
export interface ArgumentCardShape {
  role: string;
  kind: string;
  titleFrom: "note" | "summary" | "text";
  title?: string;
  state?: string;
  dashed?: boolean;
  chips: { tone: ChipToneV2; text: string }[];
  lines: string[];
  label: string;
}
export interface ArgumentCardViewV2 extends ArgumentCardShape {
  role: ArgumentRoleV2;
}

const ANSWER_KEY: Record<AnswerKey, TranslationKey> = {
  holds: "ui.argument_v2_answer_holds",
  fails: "ui.argument_v2_answer_fails",
  causal_established: "ui.argument_v2_answer_causal_established",
  causal_conditional: "ui.argument_v2_answer_causal_conditional",
  causal_compatible: "ui.argument_v2_answer_causal_compatible",
  causal_against: "ui.argument_v2_answer_causal_against",
  main_cause_largest: "ui.argument_v2_answer_main_cause_largest",
  main_cause_secondary: "ui.argument_v2_answer_main_cause_secondary",
  main_cause_not: "ui.argument_v2_answer_main_cause_not",
  main_cause_undecidable: "ui.argument_v2_answer_main_cause_undecidable",
  compare_greater: "ui.argument_v2_answer_compare_greater",
  compare_equivalent: "ui.argument_v2_answer_compare_equivalent",
  compare_opposite: "ui.argument_v2_answer_compare_opposite",
  compare_undetermined: "ui.argument_v2_answer_compare_undetermined",
  insufficient: "ui.argument_v2_answer_insufficient"
};
const CLAIM_KIND = {
  fact: "ui.argument_v2_claim_fact",
  causal: "ui.argument_v2_claim_causal",
  main_cause: "ui.argument_v2_claim_main_cause",
  comparison: "ui.argument_v2_claim_comparison"
} as const satisfies Record<Claim["type"], TranslationKey>;
const ROLE_KEY = {
  primary: "ui.argument_v2_role_primary",
  alternative: "ui.argument_v2_role_alternative",
  reverse: "ui.argument_v2_role_reverse",
  common_cause: "ui.argument_v2_role_common_cause",
  measurement: "ui.argument_v2_role_measurement",
  facet: "ui.argument_v2_role_facet",
  side: "ui.argument_v2_role_side"
} as const satisfies Record<HypothesisRole, TranslationKey>;
const VERDICT_KEY = {
  supported: "ui.hypothesis_supported",
  refuted: "ui.hypothesis_refuted",
  undecided: "ui.hypothesis_undecided",
  insufficient: "ui.argument_v2_verdict_insufficient"
} as const satisfies Record<VerdictValue, TranslationKey>;
const VERDICT_TONE = { supported: "yes", refuted: "no", undecided: "maybe", insufficient: "open" } as const;
const CONFIDENCE_KEY = {
  high: "ui.argument_v2_confidence_high",
  medium: "ui.argument_v2_confidence_medium",
  low: "ui.argument_v2_confidence_low"
} as const satisfies Record<Confidence, TranslationKey>;
const VETO_KEY = {
  contradiction: "ui.argument_v2_veto_contradiction",
  double_count: "ui.argument_v2_veto_double_count",
  missed_alternative: "ui.argument_v2_veto_missed_alternative",
  unhandled_counter: "ui.argument_v2_veto_unhandled_counter"
} as const satisfies Record<VetoKind, TranslationKey>;
const CAUSAL_KEY = {
  not_applicable: "ui.argument_v2_causal_not_applicable",
  established: "ui.argument_v2_causal_established",
  conditional: "ui.argument_v2_causal_conditional_0",
  compatible: "ui.argument_v2_causal_compatible"
} as const satisfies Record<CausalState, TranslationKey>;
/** The roles whose hypothesis states a cause, so a "Causation" line applies to it. */
const CAUSE_ROLES: readonly HypothesisRole[] = ["primary", "alternative", "reverse", "common_cause"];

const labelOf = (kind: string, chips: readonly { text: string }[], lines: readonly string[]): string =>
  [kind, ...chips.map(chip => chip.text), ...lines].join(", ");

// ---- data and evidence --------------------------------------------------------------------------------------------------------------
function missingChip(item: { state: string }, t: Translate): ArgumentChipV2 {
  if (item.state === "searching") return { tone: "run", text: t("ui.argument_missing_searching") };
  return {
    tone: "gap",
    text: t(item.state === "not_found" ? "ui.argument_missing_not_found" : "ui.argument_missing_pending")
  };
}
const checkedText = (check: string | undefined, t: Translate): string =>
  t(check === "page_match" ? "ui.argument_v2_checked" : "ui.argument_v2_unchecked");

function datumCard(datum: PremiseDatum, t: Translate): ArgumentCardViewV2 {
  const kind = t("ui.argument_data_item");
  if (datum.state !== "found") {
    const chip = missingChip(datum, t);
    const lines = datum.reason ? [datum.reason] : [];
    return {
      role: "datum",
      kind,
      titleFrom: "note",
      dashed: true,
      chips: [chip],
      lines,
      label: labelOf(kind, [chip], [])
    };
  }
  const host = datum.proof ? sourceHost(datum.proof.url) : "";
  const shown = [host, checkedText(datum.proof?.check, t)].filter(Boolean).join(" · ");
  const chips: ArgumentChipV2[] = [
    datum.stance === "opposes"
      ? { tone: "no", text: t("ui.argument_data_opposes") }
      : { tone: "yes", text: t("ui.argument_stance_supports") }
  ];
  if (datum.assessment && !datum.assessment.scopeFit)
    chips.push({ tone: "gap", text: t("ui.argument_v2_scope_mismatch") });
  const kindLine = `${kind} · ${shown}`;
  return {
    role: "datum",
    kind: kindLine,
    titleFrom: "note",
    chips,
    lines: datum.proof ? [datum.proof.claim] : [],
    label: labelOf(kindLine, chips, [])
  };
}

function needCard(state: ArgumentMapData, h: Hypothesis, need: Need, t: Translate): ArgumentCardViewV2 {
  const kind = t("ui.argument_evidence");
  if (need.state !== "found") {
    const chip = missingChip(need, t);
    return {
      role: "need",
      kind,
      titleFrom: "note",
      dashed: true,
      chips: [chip],
      lines: need.reason ? [need.reason] : [],
      label: labelOf(kind, [chip], [])
    };
  }
  const host = need.proof ? sourceHost(need.proof.url) : "";
  const kindLine = `${kind} · ${[host, checkedText(need.proof?.check, t)].filter(Boolean).join(" · ")}`;
  const chips: ArgumentChipV2[] = [];
  const assessment = need.assessment;
  if (!assessment) chips.push({ tone: "open", text: t("ui.argument_v2_awaiting_assessment") });
  else if (assessment.stance === "supports") {
    chips.push({ tone: "yes", text: t("ui.argument_stance_supports") });
    const prediction = h.predictions.find(p => p.id === need.predictionId);
    if (prediction && prediction.alsoPredictedBy.every(entry => entry.strength === "weaker"))
      chips.push({ tone: "yes", text: t("ui.argument_v2_distinguishing") });
  } else if (assessment.stance === "refutes") {
    chips.push({ tone: "no", text: t("ui.argument_stance_contradicts") });
    const cls = h.verdict?.refutations.find(entry => entry.needId === need.id)?.class;
    if (cls)
      chips.push({
        tone: "no",
        text: t(
          cls === "decisive"
            ? "ui.argument_v2_decisive"
            : cls === "conditional"
              ? "ui.argument_v2_conditional"
              : "ui.argument_v2_nondecisive"
        )
      });
  } else chips.push({ tone: "gap", text: t("ui.argument_v2_irrelevant") });
  if (assessment && !assessment.scopeFit) chips.push({ tone: "gap", text: t("ui.argument_v2_scope_mismatch") });
  if (need.registered === "post")
    chips.push({
      tone: "open",
      text: t(need.replaces === undefined ? "ui.argument_v2_exploratory" : "ui.argument_v2_post")
    });
  return {
    role: "need",
    kind: kindLine,
    titleFrom: "note",
    chips,
    lines: need.proof ? [need.proof.claim] : [],
    label: labelOf(kindLine, chips, [])
  };
}

// ---- hypotheses ---------------------------------------------------------------------------------------------------------------------
/** A required prediction "has data" when it has pre-registered needs and each is checked, assessed, relevant and in scope (or replaced so). */
function requiredCounts(h: Hypothesis): { met: number; total: number } {
  const qualifies = (need: Need): boolean =>
    need.state === "found" &&
    need.proof?.check === "page_match" &&
    !!need.assessment &&
    need.assessment.relevant &&
    need.assessment.scopeFit;
  const met = (need: Need): boolean =>
    qualifies(need) ||
    h.needs.some(r => r.replaces === need.id && r.sameCondition === true && r.registered === "pre" && qualifies(r));
  const required = h.predictions.filter(p => p.required);
  const ok = required.filter(p => {
    const own = h.needs.filter(n => n.predictionId === p.id && n.registered === "pre" && n.replaces === undefined);
    return own.length > 0 && own.every(met);
  });
  return { met: ok.length, total: required.length };
}

function hypothesisCard(h: Hypothesis, t: Translate): ArgumentCardViewV2 {
  const kind = t("ui.argument_v2_hypothesis_0", t(ROLE_KEY[h.role]));
  const chips: ArgumentChipV2[] = [];
  const lines: string[] = [];
  const verdict = h.verdict;
  if (verdict) {
    chips.push({ tone: VERDICT_TONE[verdict.value], text: t(VERDICT_KEY[verdict.value]) });
    chips.push({ tone: "open", text: t("ui.argument_v2_confidence_0", t(CONFIDENCE_KEY[verdict.confidence])) });
    if (verdict.refutations.some(entry => entry.class === "conditional"))
      chips.push({ tone: "maybe", text: t("ui.argument_v2_conditional") });
  } else {
    chips.push({ tone: "open", text: t("ui.argument_v2_testing") });
  }
  if (h.userVerdict) chips.push({ tone: "open", text: t("ui.argument_v2_user_mark_0", t(VERDICT_KEY[h.userVerdict])) });
  if (h.addedAfterComparison) chips.push({ tone: "gap", text: t("ui.argument_v2_late") });
  if ((h.reverdicts ?? verdict?.reverdicts ?? 0) > 0)
    chips.push({ tone: "maybe", text: t("ui.argument_v2_reverdict") });
  if (verdict && CAUSE_ROLES.includes(h.role)) {
    const assumptions = verdict.assumptionStatus.map(entry => entry.assumption).join(t("ui.list_separator"));
    lines.push(
      t(
        "ui.argument_v2_causal_line_0",
        verdict.causal === "conditional" ? t(CAUSAL_KEY.conditional, assumptions) : t(CAUSAL_KEY[verdict.causal])
      )
    );
  }
  const counts = requiredCounts(h);
  lines.push(t("ui.argument_v2_required_0_1_2", counts.met, counts.total, Math.min(h.round, MAX_ROUND)));
  return { role: "hypothesis", kind, titleFrom: "note", chips, lines, label: labelOf(kind, chips, lines) };
}

// ---- comparison, claims, premises ---------------------------------------------------------------------------------------------------
function comparisonCard(state: ArgumentMapData, claim: Claim, t: Translate): ArgumentCardViewV2 {
  const c = claim.comparison!;
  const own = state.hypotheses.filter(h => h.claimId === claim.id);
  const ready = own.length > 0 && own.every(h => h.verdict !== undefined);
  const chips: ArgumentChipV2[] = [];
  const lines: string[] = [];
  let kind: string;
  let title: string;
  if (c.state === "done") {
    kind = t("ui.argument_v2_cmp_done");
    title = c.answer ? t(ANSWER_KEY[c.answer]) : t("ui.argument_v2_cmp_done_title");
  } else if (c.state === "vetoed" || c.state === "undecidable") {
    const undecidable = c.state === "undecidable";
    kind = t(undecidable ? "ui.argument_v2_cmp_undecidable" : "ui.argument_v2_cmp_vetoed");
    title = t(undecidable ? "ui.argument_v2_cmp_undecidable_title" : "ui.argument_v2_cmp_vetoed_title");
    chips.push({ tone: "no", text: t(undecidable ? "ui.argument_v2_claim_blocked" : "ui.argument_v2_cmp_blocked") });
    for (const veto of c.vetoes) if (!veto.resolved) lines.push(t(VETO_KEY[veto.kind]));
  } else {
    kind = t(ready ? "ui.argument_v2_cmp_running" : "ui.argument_v2_cmp_waiting");
    title = t(ready ? "ui.argument_v2_cmp_running_title" : "ui.argument_v2_cmp_waiting_title");
  }
  if (own.some(h => (h.reverdicts ?? h.verdict?.reverdicts ?? 0) > 0))
    chips.push({ tone: "maybe", text: t("ui.argument_v2_reverdict") });
  return {
    role: "comparison",
    kind,
    titleFrom: "text",
    title,
    state: c.state,
    chips,
    lines,
    label: labelOf(kind, chips, [title, ...lines])
  };
}

function claimAnswer(state: ArgumentMapData, claim: Claim, t: Translate): string {
  const done = state.run.phase === "concluded" && state.conclusion.state === "concluded";
  const answer = done ? state.conclusion.answers.find(entry => entry.claimId === claim.id)?.answer : undefined;
  if (answer) return t("ui.argument_v2_claim_answer_0", t(ANSWER_KEY[answer]));
  const blocked =
    state.run.phase === "concluded" &&
    state.conclusion.state === "undecidable" &&
    (claim.comparison?.state === "vetoed" || claim.comparison?.state === "undecidable");
  return t("ui.argument_v2_claim_answer_0", t(blocked ? "ui.argument_v2_claim_blocked" : "ui.argument_v2_claim_open"));
}

function claimCard(state: ArgumentMapData, claim: Claim, t: Translate): ArgumentCardViewV2 {
  if (claim.role === "premise") {
    const kind = t("ui.argument_v2_premise_kind");
    const data = claim.data ?? [];
    const found = data.filter(datum => datum.state === "found").length;
    const chip: ArgumentChipV2 =
      claim.result === "holds"
        ? { tone: "yes", text: t("ui.argument_v2_premise_holds") }
        : claim.result === "fails"
          ? { tone: "no", text: t("ui.argument_v2_premise_fails") }
          : claim.result === "insufficient"
            ? { tone: "maybe", text: t("ui.argument_v2_premise_insufficient") }
            : { tone: "open", text: t("ui.argument_v2_premise_checking") };
    const lines = [t("ui.argument_data_count_0_1", found, data.length)];
    return {
      role: "claim",
      kind,
      titleFrom: "note",
      ...(claim.result === "insufficient" ? { dashed: true } : {}),
      state: claim.result ?? "checking",
      chips: [chip],
      lines,
      label: labelOf(kind, [chip], lines)
    };
  }
  const kind = t(CLAIM_KIND[claim.type]);
  if (claim.status === "not_evaluated") {
    const chip: ArgumentChipV2 = { tone: "open", text: t("ui.argument_v2_not_evaluated") };
    const lines = [t("ui.argument_v2_not_evaluated_hint")];
    return {
      role: "claim",
      kind,
      titleFrom: "note",
      dashed: true,
      state: "not_evaluated",
      chips: [chip],
      lines,
      label: labelOf(kind, [chip], lines)
    };
  }
  const lines = [claimAnswer(state, claim, t)];
  const count = state.hypotheses.filter(h => h.claimId === claim.id).length;
  if (count) lines.push(t("ui.argument_v2_claim_hypotheses_0", count));
  return {
    role: "claim",
    kind,
    titleFrom: "note",
    state: claim.status,
    chips: [],
    lines,
    label: labelOf(kind, [], lines)
  };
}

// ---- conclusion ---------------------------------------------------------------------------------------------------------------------
export type ConclusionViewV2 = "pending" | "concluded" | "undecidable" | "stopped_premise";
/** The conclusion card's state, derived from the run and the conclusion; an answer shows only when the run has really concluded. */
export function conclusionViewV2(state: ArgumentMapData): ConclusionViewV2 {
  if (state.run.phase === "stopped_premise") return "stopped_premise";
  if (state.run.phase === "concluded" && state.conclusion.state === "concluded") return "concluded";
  if (state.run.phase === "concluded" && state.conclusion.state === "undecidable") return "undecidable";
  return "pending";
}
const CONCLUSION_KIND: Record<ConclusionViewV2, TranslationKey> = {
  pending: "ui.argument_v2_concl_pending",
  concluded: "ui.argument_v2_concl_concluded",
  undecidable: "ui.argument_v2_concl_undecidable",
  stopped_premise: "ui.argument_v2_concl_stopped_premise"
};

function conclusionCard(state: ArgumentMapData, t: Translate): ArgumentCardViewV2 {
  const view = conclusionViewV2(state);
  const kind = t(CONCLUSION_KIND[view]);
  const card = (
    titleFrom: ArgumentCardShape["titleFrom"],
    title: string | undefined,
    hint: string
  ): ArgumentCardViewV2 => ({
    role: "conclusion",
    kind,
    state: view,
    chips: [],
    titleFrom,
    ...(title === undefined ? {} : { title }),
    lines: [hint],
    label: labelOf(kind, [], [...(title === undefined ? [] : [title]), hint])
  });
  if (view === "concluded") return card("summary", undefined, t("ui.argument_v2_concl_concluded_hint"));
  if (view === "undecidable")
    return card("text", t("ui.argument_v2_concl_undecidable_title"), t("ui.argument_v2_concl_undecidable_hint"));
  if (view === "stopped_premise")
    return card("text", t("ui.argument_v2_concl_stopped_title"), t("ui.argument_v2_concl_stopped_hint"));
  const testable = state.hypotheses;
  const judged = testable.filter(h => h.verdict !== undefined).length;
  return card(
    "text",
    t("ui.argument_v2_concl_pending_title"),
    t("ui.argument_v2_concl_pending_hint_0_1", judged, testable.length)
  );
}

/** What the card of node `id` says on a usable version 2 map, or null when the node is not one the flow owns. */
export function describeArgumentCardV2(state: ArgumentMapData, id: string, t: Translate): ArgumentCardViewV2 | null {
  const { roles } = state;
  const plain = (
    role: ArgumentRoleV2,
    kind: string,
    lines: string[] = [],
    over: Partial<ArgumentCardViewV2> = {}
  ): ArgumentCardViewV2 => ({
    role,
    kind,
    titleFrom: "note",
    chips: [],
    lines,
    label: labelOf(kind, [], [...(over.title === undefined ? [] : [over.title]), ...lines]),
    ...over
  });
  if (id === roles.proposition) {
    const asked = state.framing.candidates.find(candidate => candidate.id === state.framing.chosen)?.question;
    return plain(
      "proposition",
      t("ui.argument_v2_proposition_kind"),
      asked ? [t("ui.argument_v2_asked_0", asked)] : []
    );
  }
  if (id === roles.conclusion) return conclusionCard(state, t);
  if (id === roles.premises) {
    const premises = state.claims.filter(claim => claim.role === "premise");
    const holds = premises.filter(claim => claim.result === "holds").length;
    return plain(
      "group",
      t("ui.argument_group_label"),
      [t("ui.argument_v2_premises_count_0_1", holds, premises.length)],
      {
        titleFrom: "text",
        title: t("ui.argument_v2_premises_title")
      }
    );
  }
  for (const claim of state.claims) {
    if (claim.id === id) return claimCard(state, claim, t);
    if (claim.comparison?.nodeId === id) return comparisonCard(state, claim, t);
    const datum = claim.data?.find(item => item.id === id);
    if (datum) return datumCard(datum, t);
  }
  for (const h of state.hypotheses) {
    if (h.id === id) return hypothesisCard(h, t);
    const need = h.needs.find(item => item.id === id);
    if (need) return needCard(state, h, need, t);
  }
  return null;
}

/** A legacy (`"v": 1`) map keeps its version 1 cards; its conclusion card says the map is read-only and is not a V2 verdict. */
export function describeLegacyArgumentCard(
  state: ArgumentMapDataV1,
  id: string,
  t: Translate
): ArgumentCardView | null {
  const view = describeArgumentCard(state, id, t);
  if (!view || view.role !== "conclusion") return view;
  const marker = t("ui.argument_legacy_marker");
  return { ...view, lines: [...view.lines, marker], label: `${view.label}, ${marker}` };
}

/** The type line goes into the card header, where an ordinary card shows its type tag. */
export function renderArgumentKindV2(header: HTMLElement, view: ArgumentCardShape): HTMLElement {
  const kind = header.createSpan({ cls: "vam-argument-kind", text: view.kind });
  kind.dataset.role = view.role;
  return kind;
}

/** The body under the title: chips and plain lines. Text only (`textContent`); nothing is read from the note. */
export function renderArgumentCardBodyV2(card: HTMLElement, view: ArgumentCardShape): HTMLElement {
  card.dataset.argumentRole = view.role;
  if (view.state) card.dataset.argumentState = view.state;
  if (view.dashed) card.dataset.argumentMissing = "true";
  const body = card.createDiv({ cls: "vam-argument-body" });
  if (view.chips.length) {
    const row = body.createDiv({ cls: "vam-argument-chips" });
    for (const chip of view.chips) row.createSpan({ cls: `vam-argument-chip is-${chip.tone}`, text: chip.text });
  }
  for (const line of view.lines) body.createEl("p", { cls: "vam-argument-line", text: line });
  return body;
}
