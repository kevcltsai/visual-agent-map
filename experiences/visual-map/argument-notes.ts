/**
 * Markdown for the notes of a facet-judged argument map (V1 boost). Pure functions: every string that came from a model or the web
 * passes `line` (plain single-line text) or `cell` (also safe inside a table), URLs are http(s) only, and the one chart is built by the
 * program from numbers it parsed itself. A research `detail` is never an input here. Old (non-facet) maps never call this module.
 */
import { neutralizeUnsafeMermaid } from "../../ai/mermaid-safety";
import type { TranslationKey } from "../../i18n";
import {
  foundNeeds,
  type ArgumentMapData,
  type Facet,
  type Hypothesis,
  type InsightKind,
  type SituationDatum,
  type SourceFigure,
  type SourceProof
} from "../../core/argument-map/model";

export type Translate = (key: TranslationKey, ...values: string[]) => string;

/** Model/web text as inert plain single-line text: line breaks become a space, 3+ backtick/tilde runs cannot form a fence, and Markdown inline constructs that load or link things (`![` images/embeds, `[[` `]]` wikilinks, `<` `>` raw HTML) are entity-encoded. Ordinary text is unchanged. */
export function plainLine(text: string): string {
  return text
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/`{3,}|~{3,}/g, m => [...m].join(" "))
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/!\[|\[(?=\[)/g, m => m.replace("[", "&#91;"))
    .replace(/\](?=\])/g, "&#93;");
}
/** Entity for one ASCII character. */
const entity = (c: string): string => `&#${c.charCodeAt(0)};`;
/** Every ASCII punctuation character that Markdown or Obsidian can read as syntax (including `&`, so a literal entity stays literal). */
const MARKDOWN_PUNCT = /[\\`*_~=^#$%[\](){}<>|!:&]/g;
/**
 * Plain single-line text that cannot form anything: every Markdown/Obsidian punctuation character is an entity (so no link, image, wikilink,
 * footnote, tag, inline or block math, comment, highlight, callout or HTML), line breaks become a space, leading whitespace is dropped and a
 * leading list, heading, rule or ordered-list marker is encoded too. Letters, digits, spaces and other text read the same.
 */
const line = (text: string | undefined): string =>
  (text ?? "")
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/^\s+/, "")
    .replace(MARKDOWN_PUNCT, entity)
    .replace(/^(?:[+-]|(\d+)([.)]))/, (m, digits?: string, mark?: string) =>
      digits ? `${digits}${entity(mark!)}` : entity(m)
    );
/** A table cell: one line, `|` cannot split the row. */
const cell = (text: string | undefined): string => line(text).replace(/\|/g, "&#124;") || "-";
const URL_ALLOWED = /^[A-Za-z0-9\-._~:/?#@&+,;=]$/;
const percent = (byte: number): string => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
/** An http(s) URL as inert text: only RFC 3986 characters stay, a `%` that is not a valid escape is `%25`, everything else (`$`, brackets, `=` or `~` runs, quotes, non-ASCII) is percent-encoded. "" for anything not http(s). */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    // A valid escape stays; a lone `%` becomes %25; a run of `=` or `~` (highlight, strikethrough) and any other character outside the whitelist is encoded.
    return parsed.href.replace(/%[0-9A-Fa-f]{2}|[=~]{2,}|[\s\S]/gu, m => {
      if (/^%[0-9A-Fa-f]{2}$/.test(m) || URL_ALLOWED.test(m)) return m;
      return [...new TextEncoder().encode(m)].map(percent).join("");
    });
  } catch {
    return "";
  }
}
const quote = (text: string): string => `"${line(text)}"`;
const table = (head: string[], rows: string[][]): string[] => [
  `| ${head.map(cell).join(" | ")} |`,
  `| ${head.map(() => "---").join(" | ")} |`,
  ...rows.map(r => `| ${r.map(cell).join(" | ")} |`)
];
const callout = (text: string): string[] => ["> [!summary]", `> ${line(text)}`];
/** The stored reason in a collapsed callout: a plain snake_case code stays as is (it cannot form emphasis between letters), any free text after it is encoded. */
const debugCode = (stored: string): string => {
  const [, code = "", rest = ""] = /^([a-z]+(?:_[a-z]+)*)(.*)$/s.exec(stored.trim()) ?? [];
  return `${code}${/^\s/.test(rest) ? " " : ""}${line(rest)}`;
};
const debug = (t: Translate, code: string): string[] => [
  `> [!note]- ${t("ui.argument_note_debug")}`,
  `> ${debugCode(code)}`
];

// ---- chart ---------------------------------------------------------------------------------------------------------------------
const NUMBER = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
/** A figure's number text as a finite number, or null. Only plain digits (thousands commas, a trailing %) are accepted. */
export function figureNumber(figure: SourceFigure | undefined): number | null {
  if (!figure) return null;
  const text = figure.number
    .trim()
    .replace(/\s*%$/, "")
    .replace(/^[$€£¥]/, "");
  if (!NUMBER.test(text)) return null;
  const value = Number(text.replace(/,/g, ""));
  return Number.isFinite(value) && Math.abs(value) <= 1e12 ? value : null;
}
const unitOf = (figure: SourceFigure): string => {
  const unit = figure.unit.trim().toLowerCase();
  return unit || (/%\s*$/.test(figure.number) ? "%" : "");
};
/** A chart label: no quote, bracket, brace, parenthesis, semicolon, angle bracket, backtick, colon or line break; at most 20 characters. */
const chartLabel = (text: string): string =>
  [
    ...text
      .replace(/["[\]{}();<>`:\\\r\n\u2028\u2029]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  ]
    .slice(0, 20)
    .join("")
    .trim();

/** An xychart-beta bar chart from the rows whose figure is a number; "" unless at least 2 numbers share one unit. */
export function buildChart(title: string, rows: { label: string; figure?: SourceFigure }[]): string {
  const points: { label: string; value: number; unit: string }[] = [];
  for (const row of rows) {
    const value = figureNumber(row.figure);
    if (value !== null) points.push({ label: chartLabel(row.label) || "n", value, unit: unitOf(row.figure!) });
  }
  if (points.length < 2 || points.length > 12 || new Set(points.map(p => p.unit)).size !== 1) return "";
  const values = points.map(p => p.value);
  const low = Math.min(0, ...values);
  const high = Math.max(0, ...values);
  const chart = [
    "```mermaid",
    "xychart-beta",
    `  title "${chartLabel(title) || "chart"}"`,
    `  x-axis [${points.map(p => `"${p.label}"`).join(", ")}]`,
    `  y-axis "${chartLabel(points[0].unit) || "value"}" ${low} --> ${high === low ? low + 1 : high}`,
    `  bar [${values.join(", ")}]`,
    "```"
  ].join("\n");
  return neutralizeUnsafeMermaid(chart);
}

// ---- readable reasons ----------------------------------------------------------------------------------------------------------
const WHY_KEYS = {
  budget: "ui.argument_why_budget",
  no_answer: "ui.argument_why_no_answer",
  not_found: "ui.argument_why_not_found",
  stance_uncertain: "ui.argument_why_stance_uncertain",
  provider_error: "ui.argument_why_provider_error",
  card_deleted: "ui.argument_why_card_deleted",
  source_rejected_url: "ui.argument_why_source_rejected_url",
  source_bad_quote: "ui.argument_why_source_bad_quote",
  source_bad_claim: "ui.argument_why_source_bad_claim",
  source_network_error: "ui.argument_why_source_network_error",
  source_http_status: "ui.argument_why_source_http_status",
  source_content_type: "ui.argument_why_source_content_type",
  source_no_parser: "ui.argument_why_source_no_parser",
  source_quote_missing: "ui.argument_why_source_quote_missing",
  source_blocked_unverified: "ui.argument_why_source_blocked_unverified",
  round_limit: "ui.argument_why_round_limit"
} as const satisfies Record<string, TranslationKey>;
/** A stored reason code (`code` or `code: free text`) as a readable sentence; an unknown code falls back to "not found". */
export function whyText(t: Translate, stored: string): string {
  const code = stored.split(/[:\s]/, 1)[0];
  return t(Object.hasOwn(WHY_KEYS, code) ? WHY_KEYS[code as keyof typeof WHY_KEYS] : WHY_KEYS.not_found);
}

// ---- shared pieces -------------------------------------------------------------------------------------------------------------
const PROP_KEYS = {
  supports: "ui.argument_note_prop_supports",
  refutes: "ui.argument_note_prop_refutes",
  irrelevant: "ui.argument_note_prop_irrelevant"
} as const;
const propText = (t: Translate, d: SituationDatum): string => (d.propStance ? t(PROP_KEYS[d.propStance]) : "-");
const figureText = (f?: SourceFigure): string => (f ? `${f.number}${f.unit ? ` ${f.unit}` : ""}` : "-");
const sourceItems = (items: { claim: string; proof: SourceProof }[]): string[] =>
  items.map(({ claim, proof }) => {
    const url = safeUrl(proof.url);
    return `- ${line(claim)} ${quote(proof.quote)}${url ? ` ${url}` : ""}`;
  });
const sourceLines = (t: Translate, items: { claim: string; proof: SourceProof }[]): string[] =>
  items.length ? ["", `### ${t("ui.argument_sources")}`, ...sourceItems(items)] : [];
/** The sources section of a datum or need note (facet maps): claim, quote and link, all inert. */
export const sourceNote = (t: Translate, proof: SourceProof): string =>
  sourceLines(t, [{ claim: proof.claim, proof }])
    .join("\n")
    .replace(/^\n/, "");
const dataRows = (t: Translate, data: SituationDatum[]): string[][] =>
  data.map(d => [
    d.need,
    figureText(d.proof?.figure),
    d.proof?.figure?.period || "-",
    d.state === "found"
      ? propText(t, d)
      : t(d.state === "not_found" ? "ui.argument_note_need_missing" : "ui.argument_note_need_pending"),
    d.stanceReason ?? d.reason ?? ""
  ]);
const dataHead = (t: Translate): string[] => [
  t("ui.argument_note_col_data"),
  t("ui.argument_note_col_number"),
  t("ui.argument_note_col_period"),
  t("ui.argument_note_col_stance"),
  t("ui.argument_note_col_reason")
];
const chartOf = (title: string, data: SituationDatum[]): string =>
  buildChart(
    title,
    data
      .filter(d => d.state === "found" && d.propStance !== "irrelevant")
      .map(d => ({ label: d.need, figure: d.proof?.figure }))
  );
const chartSection = (t: Translate, chart: string): string[] =>
  chart ? ["", `### ${t("ui.argument_note_chart")}`, chart] : [];
const VERDICT_KEYS = {
  supports: "ui.argument_note_verdict_supports",
  refutes: "ui.argument_note_verdict_refutes",
  insufficient: "ui.argument_note_verdict_insufficient",
  pending: "ui.argument_note_verdict_pending"
} as const;
const join = (parts: string[][]): string => parts.flat().join("\n");

// ---- card notes ----------------------------------------------------------------------------------------------------------------
/** A datum after its facet was judged: the figure, its stance toward the proposition and why, the source. */
export function datumDetail(t: Translate, d: SituationDatum): string {
  return join([
    [`### ${t("ui.argument_note_core")}`],
    callout(`${propText(t, d)}${d.stanceReason ? `: ${d.stanceReason}` : ""}`),
    ["", `### ${t("ui.argument_note_data")}`],
    table(dataHead(t), dataRows(t, [d])),
    sourceLines(t, d.state === "found" && d.proof ? [{ claim: d.proof.claim, proof: d.proof }] : [])
  ]);
}

/** A datum or need that was not found: what was searched and why it was not used (program-recorded); the raw code only in a collapsed callout. */
export function notFoundDetail(
  t: Translate,
  log: { queries: string[]; opened: string[]; why: string } | undefined,
  code: string
): string {
  const why = log?.why || code;
  const note = why.includes(": ") ? why.slice(why.indexOf(": ") + 2) : "";
  const parts: string[][] = [
    [`### ${t("ui.argument_note_core")}`],
    callout(t("ui.argument_not_found_0", whyText(t, why)))
  ];
  const opened = (log?.opened ?? []).map(safeUrl).filter(Boolean);
  if (log?.queries.length || opened.length || note) {
    const out: string[] = ["", `### ${t("ui.argument_note_searched")}`];
    log?.queries.forEach((q, i) => out.push(`- ${t("ui.argument_note_search_n_0", String(i + 1))}: ${quote(q)}`));
    if (opened.length) out.push(`- ${t("ui.argument_note_opened")}: ${opened.join(" ")}`);
    if (note) out.push(`- ${t("ui.argument_note_agent_note")}: ${line(note)}`);
    parts.push(out);
  }
  parts.push([""], debug(t, why));
  return join(parts);
}

export function facetDetail(t: Translate, facet: Facet, data: SituationDatum[]): string {
  return join([
    [`### ${t("ui.argument_note_core")}`],
    callout(`${t(VERDICT_KEYS[facet.verdict])}${facet.reason ? `: ${facet.reason}` : ""}`),
    ["", `### ${t("ui.argument_note_data")}`],
    table(dataHead(t), dataRows(t, data)),
    chartSection(t, chartOf(facet.title, data)),
    sourceLines(
      t,
      data.filter(d => d.state === "found" && d.proof).map(d => ({ claim: d.proof!.claim, proof: d.proof! }))
    )
  ]);
}

export function situationDetail(t: Translate, state: ArgumentMapData): string {
  const facets = state.situation.facets ?? [];
  const supporting = facets.filter(f => f.verdict === "supports").length;
  return join([
    [`### ${t("ui.argument_note_core")}`],
    callout(t("ui.argument_note_facet_count_0_1", String(supporting), String(facets.length))),
    ["", `### ${t("ui.argument_note_facets")}`],
    table(
      [t("ui.argument_note_col_facet"), t("ui.argument_note_col_verdict"), t("ui.argument_note_col_reason")],
      facets.map(f => [f.title, t(VERDICT_KEYS[f.verdict]), f.reason])
    ),
    chartSection(t, chartOf(state.situation.question ?? "", state.situation.data))
  ]);
}

export function definitionsDetail(
  t: Translate,
  items: { label: string; value: string; reason: string }[],
  insights?: string[]
): string {
  return join([
    [`### ${t("ui.argument_definitions")}`],
    table(
      [t("ui.argument_note_col_item"), t("ui.argument_note_col_definition"), t("ui.argument_note_col_reason")],
      items.map(i => [i.label, i.value, i.reason])
    ),
    insights?.length
      ? ["", `### ${t("ui.argument_note_definition_insights")}`, ...insights.map(i => `- ${line(i)}`)]
      : []
  ]);
}

const INSIGHT_KEYS: Record<InsightKind, TranslationKey> = {
  consistent: "ui.argument_note_insight_consistent",
  tension: "ui.argument_note_insight_tension",
  missing: "ui.argument_note_insight_missing"
};
const NEED_KEYS = {
  supports: "ui.argument_note_need_supports",
  contradicts: "ui.argument_note_need_contradicts",
  uncertain: "ui.argument_note_need_uncertain"
} as const;

/** A hypothesis under the conclusion after its verdict: why it holds or not, the insights, the evidence table. */
export function hypothesisDetail(t: Translate, h: Hypothesis, reason: string): string {
  const verdict = h.userVerdict ?? h.aiVerdict;
  const found = foundNeeds(h);
  const verdictKey =
    verdict === "supported"
      ? "ui.argument_note_hyp_supported_0_1"
      : verdict === "refuted"
        ? "ui.argument_note_hyp_refuted_0_1"
        : "ui.argument_note_hyp_undecided_0_1";
  const whyKey =
    verdict === "supported"
      ? "ui.argument_note_why_holds"
      : verdict === "refuted"
        ? "ui.argument_note_why_fails"
        : "ui.argument_note_why_undecided";
  const rows = h.needs.map(n => [
    n.text,
    figureText(n.proof?.figure),
    n.state === "found"
      ? t(NEED_KEYS[n.stance ?? "uncertain"])
      : t(n.state === "not_found" ? "ui.argument_note_need_missing" : "ui.argument_note_need_pending"),
    (n.proof && safeUrl(n.proof.url)) || "-"
  ]);
  return join([
    [`### ${t("ui.argument_note_core")}`],
    callout(t(verdictKey, String(found.length), String(h.needs.length))),
    ["", `### ${t(whyKey)}`, line(reason)],
    h.basis ? ["", `### ${t("ui.argument_note_basis")}`, line(h.basis)] : [],
    h.insights?.length
      ? [
          "",
          `### ${t("ui.argument_note_insights")}`,
          ...h.insights.map(i => `- ${t(INSIGHT_KEYS[i.kind])}: ${line(i.text)}`)
        ]
      : [],
    ["", `### ${t("ui.argument_note_col_evidence")}`],
    table(
      [
        t("ui.argument_note_col_evidence"),
        t("ui.argument_note_col_number"),
        t("ui.argument_note_col_stance"),
        t("ui.argument_note_col_source")
      ],
      rows
    ),
    sourceLines(
      t,
      found.map(n => ({ claim: n.proof!.claim, proof: n.proof! }))
    )
  ]);
}

/**
 * The facet-map conclusion card. `titles` maps hypothesis ids to their card titles. With an `answer` (the conclude step's summary and
 * points) it is a concluded card; without one it is a stopped card: the refuting facet with its datum quote and link, or the facets
 * that lacked data with the searches that were made.
 */
export function conclusionDetail(
  t: Translate,
  state: ArgumentMapData,
  titles: ReadonlyMap<string, string>,
  answer?: { summary: string; points: string[] },
  stoppedSummary = ""
): string {
  const facets = state.situation.facets ?? [];
  const data = state.situation.data;
  const title = (id: string): string => titles.get(id) ?? id;
  const parts: string[][] = [];
  if (answer) {
    const based = state.hypotheses.filter(h => state.conclusion.basedOn.includes(h.id));
    parts.push([`### ${t("ui.argument_note_core")}`], callout(answer.summary));
    if (answer.points.length)
      parts.push(["", `### ${t("ui.argument_note_insights")}`, ...answer.points.map(p => `- ${line(p)}`)]);
    parts.push(
      ["", `### ${t("ui.argument_note_basis_hypotheses")}`],
      table(
        [
          t("ui.argument_note_col_hypothesis"),
          t("ui.argument_note_col_verdict"),
          t("ui.argument_note_col_key_evidence")
        ],
        based.map(h => [
          title(h.id),
          t("ui.argument_note_need_supports"),
          foundNeeds(h)
            .map(n => n.proof!.claim)
            .slice(0, 2)
            .join("; ")
        ])
      )
    );
    const eliminated = state.hypotheses.filter(h => h.location === "eliminated");
    if (eliminated.length)
      parts.push([
        "",
        `### ${t("ui.argument_note_eliminated")}`,
        ...eliminated.map(
          h =>
            `- ${line(title(h.id))}: ${line(h.eliminationReason?.startsWith("round_limit") ? whyText(t, "round_limit") : (h.eliminationReason ?? ""))}`
        )
      ]);
  } else {
    parts.push([`### ${t("ui.argument_note_core")}`], callout(stoppedSummary));
  }
  parts.push(
    ["", `### ${t("ui.argument_note_situation_basis")}`],
    table(
      [t("ui.argument_note_col_facet"), t("ui.argument_note_col_verdict"), t("ui.argument_note_col_reason")],
      facets.map(f => [f.title, t(VERDICT_KEYS[f.verdict]), f.summary || f.reason])
    )
  );
  if (!answer) {
    for (const f of facets.filter(x => x.verdict === "refutes")) {
      const cited = f.citedData.flatMap(id => {
        const d = data.find(x => x.id === id);
        return d?.proof ? [{ claim: d.proof.claim, proof: d.proof }] : [];
      });
      parts.push([
        "",
        `### ${t("ui.argument_note_refuting")}`,
        `- ${line(f.title)}: ${line(f.reason)}`,
        ...sourceItems(cited)
      ]);
    }
    const lacking = facets.filter(f => f.verdict === "insufficient");
    if (lacking.length) {
      const out = ["", `### ${t("ui.argument_note_insufficient")}`];
      for (const f of lacking) {
        out.push(`- ${line(f.title)}`);
        for (const d of data.filter(x => x.facetId === f.id && x.searchLog))
          d.searchLog!.queries.forEach((q, i) =>
            out.push(`  - ${t("ui.argument_note_search_n_0", String(i + 1))}: ${quote(q)}`)
          );
      }
      parts.push(out);
    }
  }
  return join(parts);
}
