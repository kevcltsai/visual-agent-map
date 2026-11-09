/**
 * Argument map card content (plan section 5, mockup 7th version). `describeArgumentCard` is pure: it turns the flow state and
 * a node id into what the card says, and every string comes from the state or from `t()`, never from the note body, so the
 * in-progress and stopped conclusion cards cannot show an answer by accident. `renderArgumentCardBody` and
 * `renderArgumentKind` write that into the DOM with `textContent` only (model output and web text are plain text).
 */
import type { TranslationKey } from "../../i18n";
import {
  conclusionView,
  displayVerdict,
  foundNeeds,
  isVerified,
  MAX_ROUND,
  MIN_VERIFIED,
  verifiedCount,
  type ArgumentMapData,
  type Hypothesis,
  type Need,
  type SituationDatum
} from "../../core/argument-map/model";

type Translate = (key: TranslationKey, ...values: unknown[]) => string;
export type ArgumentRole = "proposition" | "situation" | "datum" | "conclusion" | "group" | "hypothesis" | "need";
export type ChipTone = "yes" | "no" | "maybe" | "gap" | "open";

export interface ArgumentChip {
  tone: ChipTone;
  text: string;
}
export interface ArgumentCardView {
  role: ArgumentRole;
  /** The quiet type line above the title ("Hypothesis 2", "Conclusion · in progress"). */
  kind: string;
  /** Where the heading comes from: the note's title, the note's summary (a concluded conclusion only), or `title` here. */
  titleFrom: "note" | "summary" | "text";
  title?: string;
  /** The conclusion card's state, or the evidence card's dashed look. */
  state?: string;
  dashed?: boolean;
  chips: ArgumentChip[];
  /** Plain lines under the title (progress, hint, claim, reason). */
  lines: string[];
  /** Words that name the card for assistive tech, after its title. */
  label: string;
}

const STANCE_KEY = {
  supports: "ui.argument_stance_supports",
  contradicts: "ui.argument_stance_contradicts",
  uncertain: "ui.argument_stance_uncertain"
} as const satisfies Record<string, TranslationKey>;
const STANCE_TONE = { supports: "yes", contradicts: "no", uncertain: "maybe" } as const;
const VERDICT_KEY = {
  supported: "ui.hypothesis_supported",
  refuted: "ui.hypothesis_refuted",
  undecided: "ui.hypothesis_undecided"
} as const satisfies Record<string, TranslationKey>;
const CONCLUSION_KIND: Record<ReturnType<typeof conclusionView>, TranslationKey> = {
  in_progress: "ui.argument_conclusion_state_progress",
  concluded: "ui.argument_conclusion_state_concluded",
  stopped_limit: "ui.argument_conclusion_state_limit",
  stopped_mismatch: "ui.argument_conclusion_state_mismatch"
};

/** The host of a proof's URL, or "" when it is not a URL. */
export function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
function missingChip(item: Need | SituationDatum, t: Translate): ArgumentChip {
  const key: TranslationKey =
    item.state === "not_found"
      ? "ui.argument_missing_not_found"
      : item.state === "searching"
        ? "ui.argument_missing_searching"
        : "ui.argument_missing_pending";
  return { tone: "gap", text: t(key) };
}
function datumChip(datum: SituationDatum, t: Translate): ArgumentChip {
  if (datum.state !== "found") return missingChip(datum, t);
  return datum.stance === "opposes"
    ? { tone: "no", text: t("ui.argument_data_opposes") }
    : { tone: "yes", text: t("ui.argument_stance_supports") };
}

function conclusionCard(state: ArgumentMapData, t: Translate): ArgumentCardView {
  const view = conclusionView(state);
  const base: ArgumentCardView = {
    role: "conclusion",
    kind: t(CONCLUSION_KIND[view]),
    titleFrom: "text",
    state: view,
    chips: [],
    lines: [],
    label: t(CONCLUSION_KIND[view])
  };
  const verified = verifiedCount(state);
  if (view === "concluded")
    return { ...base, titleFrom: "summary", lines: [t("ui.argument_conclusion_done_hint", verified)] };
  if (view === "stopped_mismatch")
    return { ...base, title: t("ui.argument_stopped_mismatch"), lines: [t("ui.argument_mismatch_hint")] };
  if (view === "stopped_limit")
    return { ...base, title: t("ui.argument_conclusion_limit"), lines: [t("ui.argument_conclusion_limit_hint")] };
  return {
    ...base,
    title: t("ui.argument_conclusion_pending_0_1", verified, MIN_VERIFIED),
    lines: [t("ui.argument_conclusion_pending_hint_0", Math.max(0, MIN_VERIFIED - verified))]
  };
}

function hypothesisCard(state: ArgumentMapData, h: Hypothesis, t: Translate): ArgumentCardView {
  const index = state.hypotheses.indexOf(h) + 1;
  const shown = displayVerdict(h);
  const chips: ArgumentChip[] =
    h.location === "eliminated"
      ? [{ tone: "gap", text: t("ui.argument_eliminated_chip") }]
      : [
          shown === "verifying"
            ? { tone: "open", text: t("ui.argument_verifying") }
            : { tone: shown === "supported" ? "yes" : shown === "refuted" ? "no" : "open", text: t(VERDICT_KEY[shown]) }
        ];
  if (isVerified(h)) chips.push({ tone: "yes", text: t("ui.argument_verified_done") });
  const kind = t("ui.argument_hypothesis_0", index);
  const progress = t("ui.argument_progress_0_1_2", foundNeeds(h).length, h.needs.length, Math.min(h.round, MAX_ROUND));
  const lines = [progress];
  if (h.location === "eliminated" && h.eliminationReason)
    lines.push(t("ui.argument_eliminated_0", h.eliminationReason));
  const status = chips.map(chip => chip.text).join(" ");
  return { role: "hypothesis", kind, titleFrom: "note", chips, lines, label: `${kind}, ${status}, ${progress}` };
}

function needCard(need: Need, t: Translate): ArgumentCardView {
  const kind = t("ui.argument_evidence");
  if (need.state === "found") {
    const stance = need.stance ?? "uncertain";
    const chip: ArgumentChip = { tone: STANCE_TONE[stance], text: t(STANCE_KEY[stance]) };
    const host = need.proof ? sourceHost(need.proof.url) : "";
    return {
      role: "need",
      kind: host ? `${kind} · ${host}` : kind,
      titleFrom: "note",
      chips: [chip],
      lines: need.proof ? [need.proof.claim] : [],
      label: `${kind}, ${chip.text}${host ? `, ${host}` : ""}`
    };
  }
  const chip = missingChip(need, t);
  return {
    role: "need",
    kind,
    titleFrom: "note",
    dashed: true,
    chips: [chip],
    lines: need.reason ? [need.reason] : [],
    label: `${kind}, ${chip.text}`
  };
}

function datumCard(datum: SituationDatum, t: Translate): ArgumentCardView {
  const kind = t("ui.argument_data_item");
  const chip = datumChip(datum, t);
  if (datum.state === "found") {
    const host = datum.proof ? sourceHost(datum.proof.url) : "";
    return {
      role: "datum",
      kind: host ? `${kind} · ${host}` : kind,
      titleFrom: "note",
      chips: [chip],
      lines: datum.proof ? [datum.proof.claim] : [],
      label: `${kind}, ${chip.text}${host ? `, ${host}` : ""}`
    };
  }
  return {
    role: "datum",
    kind,
    titleFrom: "note",
    dashed: true,
    chips: [chip],
    lines: datum.reason ? [datum.reason] : [],
    label: `${kind}, ${chip.text}`
  };
}

/** What the card of node `id` says, or null when the node is not one the flow owns (an ordinary card). */
export function describeArgumentCard(state: ArgumentMapData, id: string, t: Translate): ArgumentCardView | null {
  const { roles } = state;
  const plain = (
    role: ArgumentRole,
    kind: string,
    lines: string[] = [],
    chips: ArgumentChip[] = []
  ): ArgumentCardView => ({
    role,
    kind,
    titleFrom: "note",
    chips,
    lines,
    label: [kind, ...chips.map(chip => chip.text), ...lines].join(", ")
  });
  if (id === roles.proposition) return plain("proposition", t("ui.argument_proposition"));
  if (id === roles.conclusion) return conclusionCard(state, t);
  if (id === roles.situation) {
    const data = state.situation.data;
    const found = data.filter(datum => datum.state === "found").length;
    const count = t("ui.argument_data_count_0_1", found, data.length);
    const gate = state.situation.gate.state;
    if (gate === "matched")
      return plain("situation", t("ui.argument_situation"), [t("ui.argument_gate_matched_0_1", found, data.length)]);
    const chip: ArgumentChip =
      gate === "unmatched"
        ? { tone: "no", text: t("ui.argument_gate_unmatched") }
        : { tone: "open", text: t("ui.argument_gate_pending") };
    return plain("situation", t("ui.argument_situation"), [count], [chip]);
  }
  const datum = state.situation.data.find(item => item.id === id);
  if (datum) return datumCard(datum, t);
  if (id === roles.verified) {
    const verifying = state.hypotheses.filter(h => h.location === "verifying").length;
    return plain("group", t("ui.argument_group_label"), [
      t("ui.argument_group_verified_count_0_1", verifiedCount(state), Math.max(verifying, MIN_VERIFIED))
    ]);
  }
  if (id === roles.eliminated) {
    const count = state.hypotheses.filter(h => h.location === "eliminated").length;
    return plain("group", t("ui.argument_group_label"), [t("ui.argument_group_eliminated_count_0", count)]);
  }
  for (const h of state.hypotheses) {
    if (h.id === id) return hypothesisCard(state, h, t);
    const need = h.needs.find(item => item.id === id);
    if (need) return needCard(need, t);
  }
  return null;
}

/** The type line goes into the card header, where an ordinary card shows its type tag. */
export function renderArgumentKind(header: HTMLElement, view: ArgumentCardView): HTMLElement {
  const kind = header.createSpan({ cls: "vam-argument-kind", text: view.kind });
  kind.dataset.role = view.role;
  return kind;
}

/** The body under the title: chips and plain lines. Text only; nothing is read from the note. */
export function renderArgumentCardBody(card: HTMLElement, view: ArgumentCardView): HTMLElement {
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
