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
  type Facet,
  type Need,
  type SituationDatum,
  type SourceFigure
} from "../../core/argument-map/model";
import { safeUrl, whyText } from "./argument-notes";

type Translate = (key: TranslationKey, ...values: unknown[]) => string;
export type ArgumentRole =
  "proposition" | "situation" | "datum" | "conclusion" | "group" | "hypothesis" | "need" | "facet" | "assumptions";
export type ChipTone = "yes" | "no" | "maybe" | "gap" | "open" | "run";

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
  /** The definitions card: the items as a term/description list. */
  definitions?: { label: string; value: string }[];
  /** The definitions card: the re-run button. */
  action?: { text: string; ariaLabel: string };
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
const isFacetMap = (state: ArgumentMapData): boolean => state.situation.facets !== undefined;
/** A stored reason code as a readable sentence (facet maps only; an old map keeps the V1 text). */
const why = (t: Translate, stored: string): string => whyText(t, stored);
const PROP_CHIP = {
  supports: { tone: "yes", key: "ui.argument_note_prop_supports" },
  refutes: { tone: "no", key: "ui.argument_data_prop_refutes" },
  irrelevant: { tone: "gap", key: "ui.argument_note_prop_irrelevant" }
} as const satisfies Record<string, { tone: ChipTone; key: TranslationKey }>;
const FACET_CHIP = {
  supports: { tone: "yes", key: "ui.argument_facet_supports" },
  refutes: { tone: "no", key: "ui.argument_facet_refutes" },
  insufficient: { tone: "maybe", key: "ui.argument_facet_insufficient" },
  pending: { tone: "open", key: "ui.argument_facet_pending" }
} as const satisfies Record<string, { tone: ChipTone; key: TranslationKey }>;
/** "9.1%（2026 年 7 月）": the number with its unit (a "%" sticks to the number), then the period. */
function figureLine(figure: SourceFigure | undefined): string {
  if (!figure) return "";
  const number = figure.number.trim();
  const unit = figure.unit.trim();
  const value = !unit || number.endsWith(unit) ? number : unit === "%" ? `${number}%` : `${number} ${unit}`;
  return figure.period.trim() ? `${value}（${figure.period.trim()}）` : value;
}
function shortQuote(text: string): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return `「${chars.length > 120 ? `${chars.slice(0, 120).join("")}…` : chars.join("")}」`;
}
const lacking = (state: ArgumentMapData): Facet[] =>
  (state.situation.facets ?? []).filter(f => f.verdict === "insufficient");

/** The host of a proof's URL, or "" when it is not a URL. */
export function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
function missingChip(item: Need | SituationDatum, t: Translate): ArgumentChip {
  if (item.state === "searching") return { tone: "run", text: t("ui.argument_missing_searching") };
  const key: TranslationKey =
    item.state === "not_found" ? "ui.argument_missing_not_found" : "ui.argument_missing_pending";
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
  if (view === "stopped_mismatch" && isFacetMap(state)) return facetStopCard(state, base, t);
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

/** A stopped facet map: not enough data (dashed yellow, what is missing) or a refuted facet (the facet, the datum, its quote and plain-text URL). */
function facetStopCard(state: ArgumentMapData, base: ArgumentCardView, t: Translate): ArgumentCardView {
  const facets = state.situation.facets ?? [];
  if (state.situation.gate.kind === "data_insufficient") {
    const missing = lacking(state);
    const kind = t("ui.argument_conclusion_state_insufficient");
    return {
      ...base,
      kind,
      label: kind,
      state: "stopped_insufficient",
      title: t("ui.argument_conclusion_insufficient_title"),
      lines: [
        t("ui.argument_conclusion_insufficient_hint_0_1", facets.length - missing.length, facets.length),
        t("ui.argument_missing_facets_0", missing.map(f => f.title).join(t("ui.argument_list_sep")))
      ]
    };
  }
  const refuted = facets.find(f => f.verdict === "refutes");
  const cited = refuted?.citedData.map(id => state.situation.data.find(d => d.id === id)).find(d => d?.proof);
  const lines = refuted ? [t("ui.argument_refuted_facet_0", refuted.title)] : [t("ui.argument_mismatch_hint")];
  if (cited?.proof) {
    lines.push(t("ui.argument_refuted_data_0", cited.proof.claim), shortQuote(cited.proof.quote));
    const url = safeUrl(cited.proof.url);
    if (url) lines.push(url);
  }
  return { ...base, title: t("ui.argument_stopped_mismatch"), lines };
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
    lines.push(
      t(
        "ui.argument_eliminated_0",
        isFacetMap(state) && h.eliminationReason.startsWith("round_limit") ? why(t, "round_limit") : h.eliminationReason
      )
    );
  const status = chips.map(chip => chip.text).join(" ");
  return { role: "hypothesis", kind, titleFrom: "note", chips, lines, label: `${kind}, ${status}, ${progress}` };
}

function needCard(need: Need, t: Translate, readable = false): ArgumentCardView {
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
    lines: need.reason ? [readable ? why(t, need.reason) : need.reason] : [],
    label: `${kind}, ${chip.text}`
  };
}

/** A datum of a facet-judged map: its stance toward the proposition (never "supports" before it was judged), the figure, a readable reason. */
function facetDatumCard(datum: SituationDatum, t: Translate): ArgumentCardView {
  const kind = t("ui.argument_data_item");
  if (datum.state !== "found") {
    const chip = missingChip(datum, t);
    const lines = datum.reason ? [why(t, datum.reason)] : [];
    const tried = datum.searchLog?.queries.length ?? 0;
    if (tried) lines.push(t("ui.argument_searched_0", tried));
    return {
      role: "datum",
      kind,
      titleFrom: "note",
      dashed: true,
      chips: [chip],
      lines,
      label: `${kind}, ${chip.text}`
    };
  }
  const host = datum.proof ? sourceHost(datum.proof.url) : "";
  const chip: ArgumentChip = datum.propStance
    ? { tone: PROP_CHIP[datum.propStance].tone, text: t(PROP_CHIP[datum.propStance].key) }
    : { tone: "open", text: t("ui.argument_data_unjudged") };
  const lines =
    datum.propStance === "irrelevant"
      ? [datum.stanceReason || why(t, "stance_uncertain")]
      : [figureLine(datum.proof?.figure) || datum.proof?.claim || ""].filter(Boolean);
  return {
    role: "datum",
    kind: host ? `${kind} · ${host}` : kind,
    titleFrom: "note",
    chips: [chip],
    lines,
    label: `${kind}, ${chip.text}${host ? `, ${host}` : ""}`
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

function facetSituationCard(state: ArgumentMapData, t: Translate): ArgumentCardView {
  const facets = state.situation.facets ?? [];
  const kind = t("ui.argument_situation");
  const question = state.situation.question;
  const gate = state.situation.gate;
  const base: ArgumentCardView = {
    role: "situation",
    kind,
    titleFrom: question ? "text" : "note",
    ...(question ? { title: question } : {}),
    chips: [],
    lines: [],
    label: kind
  };
  const finish = (chip: ArgumentChip, lines: string[]): ArgumentCardView => ({
    ...base,
    chips: [chip],
    lines,
    label: [kind, chip.text, ...lines].join(", ")
  });
  if (gate.state === "matched")
    return finish({ tone: "yes", text: t("ui.argument_gate_facets_0_1") }, [
      t("ui.argument_gate_facets_line_0_1", facets.filter(f => f.verdict === "supports").length, facets.length)
    ]);
  if (gate.state === "pending") {
    const data = state.situation.data;
    const count = t("ui.argument_data_count_0_1", data.filter(d => d.state === "found").length, data.length);
    return finish({ tone: "open", text: t("ui.argument_gate_pending") }, [count]);
  }
  if (gate.kind === "data_insufficient")
    return finish({ tone: "maybe", text: t("ui.argument_gate_insufficient") }, [
      t(
        "ui.argument_reason_0",
        t("ui.argument_reason_insufficient_0_1", facets.length - lacking(state).length, facets.length)
      )
    ]);
  const refuted = facets.find(f => f.verdict === "refutes");
  return finish(
    { tone: "no", text: t("ui.argument_gate_unmatched") },
    refuted ? [t("ui.argument_reason_0", t("ui.argument_reason_refuted_0_1", refuted.title, refuted.reason))] : []
  );
}

/** The definitions card: the items as a list, the hint and the re-run button. */
function assumptionsCard(state: ArgumentMapData, t: Translate): ArgumentCardView {
  const kind = t("ui.argument_assumption_kind");
  const items = state.situation.assumptions?.items ?? [];
  return {
    role: "assumptions",
    kind,
    titleFrom: "note",
    chips: [],
    lines: [t("ui.argument_definitions_hint")],
    label: kind,
    definitions: items.map(({ label, value }) => ({ label, value })),
    action: { text: t("ui.argument_rerun"), ariaLabel: t("ui.argument_rerun_aria") }
  };
}

function facetCard(state: ArgumentMapData, facet: Facet, t: Translate): ArgumentCardView {
  const kind = t("ui.argument_facet_0", (state.situation.facets ?? []).indexOf(facet) + 1);
  const chip: ArgumentChip = { tone: FACET_CHIP[facet.verdict].tone, text: t(FACET_CHIP[facet.verdict].key) };
  const lines = facet.summary ? [t("ui.argument_facet_summary_0", facet.summary)] : [];
  return { role: "facet", kind, titleFrom: "note", chips: [chip], lines, label: `${kind}, ${chip.text}` };
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
  if (id === roles.situation && isFacetMap(state)) return facetSituationCard(state, t);
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
  if (state.situation.assumptions?.id === id) return assumptionsCard(state, t);
  const facet = state.situation.facets?.find(f => f.id === id);
  if (facet) return facetCard(state, facet, t);
  const datum = state.situation.data.find(item => item.id === id);
  if (datum) return isFacetMap(state) ? facetDatumCard(datum, t) : datumCard(datum, t);
  // A stopped mismatch ran no hypothesis research: the groups carry no "0 / 3" count, only their label.
  if ((id === roles.verified || id === roles.eliminated) && state.run.phase === "stopped_mismatch")
    return plain("group", t("ui.argument_group_label"));
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
    if (need) return needCard(need, t, isFacetMap(state));
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
export function renderArgumentCardBody(
  card: HTMLElement,
  view: ArgumentCardView,
  onAction?: (button: HTMLElement) => void
): HTMLElement {
  card.dataset.argumentRole = view.role;
  if (view.state) card.dataset.argumentState = view.state;
  if (view.dashed) card.dataset.argumentMissing = "true";
  const body = card.createDiv({ cls: "vam-argument-body" });
  if (view.chips.length) {
    const row = body.createDiv({ cls: "vam-argument-chips" });
    for (const chip of view.chips) row.createSpan({ cls: `vam-argument-chip is-${chip.tone}`, text: chip.text });
  }
  if (view.definitions?.length) {
    const list = body.createEl("dl", { cls: "vam-argument-definitions" });
    for (const item of view.definitions) {
      list.createEl("dt", { text: item.label });
      list.createEl("dd", { text: item.value });
    }
  }
  for (const line of view.lines) body.createEl("p", { cls: "vam-argument-line", text: line });
  if (view.action) renderArgumentAction(body, view.action, onAction);
  return body;
}

/**
 * The definitions card's button: a native button (focusable, Enter and Space work). Pointer and key events stop here, so pressing it
 * never starts a card drag or a card shortcut.
 */
function renderArgumentAction(
  body: HTMLElement,
  action: { text: string; ariaLabel: string },
  onAction: ((button: HTMLElement) => void) | undefined
): HTMLElement {
  const button = body.createEl("button", { cls: "vam-argument-action", text: action.text });
  button.setAttr("type", "button");
  button.setAttr("aria-label", action.ariaLabel);
  for (const type of ["pointerdown", "mousedown", "dblclick", "keydown"])
    button.addEventListener(type, event => event.stopPropagation());
  button.addEventListener("click", event => {
    event.stopPropagation();
    onAction?.(button);
  });
  return button;
}
