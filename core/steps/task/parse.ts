import { neutralizeUnsafeMermaid } from "../../../ai/mermaid-safety";
import { truncateSummary } from "../../../ai/result-utils";
import type { AiResult, ArgumentEvidenceFigure, ArgumentEvidenceItem } from "../../../ai/types";
import { foldText, QUOTE_MAX, QUOTE_MIN } from "../../argument-map/source-proof";
import { t, type ContentLanguage, translateNote } from "../../../i18n";

export function extractJsonObject(raw: string): string {
  const candidates: string[] = [];
  let start = -1,
    depth = 0,
    quoted = false,
    escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (start < 0) {
      if (character === "{") {
        start = index;
        depth = 1;
        quoted = false;
        escaped = false;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) {
      candidates.push(raw.slice(start, index + 1));
      start = -1;
    }
  }
  for (const candidate of candidates.reverse()) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      /* Continue to an earlier balanced object. */
    }
  }
  throw new SyntaxError(t("error.codex_reply_no_json"));
}

const EVIDENCE_KEYS = ["need", "status", "stance", "claim", "quote", "url"];
/** Optional reply fields (V1 boost): a malformed one is dropped, the entry itself is kept. */
const EVIDENCE_OPTIONAL_KEYS = ["figure", "note"];
const NOTE_MAX = 200;
const FIGURE_NUMBER_MAX = 40;
const FIGURE_PERIOD_MAX = 60;
const FIGURE_UNIT_MAX = 40;

/** The figure of a found entry, or undefined when it is not exactly three non-blank strings within their limits. */
function readFigure(value: unknown): ArgumentEvidenceFigure | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (keys.length !== 3 || !["number", "period", "unit"].every(key => keys.includes(key))) return undefined;
  const { number, period, unit } = raw;
  if (typeof number !== "string" || typeof period !== "string" || typeof unit !== "string") return undefined;
  const figure = { number: number.trim(), period: period.trim(), unit: unit.trim() };
  if (!figure.number || !figure.period || !figure.unit) return undefined;
  if (
    figure.number.length > FIGURE_NUMBER_MAX ||
    figure.period.length > FIGURE_PERIOD_MAX ||
    figure.unit.length > FIGURE_UNIT_MAX
  )
    return undefined;
  return figure;
}

/** The note of an entry (what was found, why it was not used), trimmed and cut to 200 characters; undefined when not text. */
function readNote(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const note = Array.from(value.trim()).slice(0, NOTE_MAX).join("");
  return note || undefined;
}
const EVIDENCE_STANCES = ["supports", "contradicts", "uncertain"];
/** Same floor as `verifySource`: a quote with fewer folded characters proves nothing. */
const QUOTE_FOLDED_MIN = 8;

/**
 * The argument-evidence entries of a reply. Anything `verifySource` could not use is refused here: a need id outside the
 * request or cited twice, extra or missing fields, a found entry without a claim, with a quote outside 12 to 200 characters
 * or a url that is not http(s); a not-found entry that still carries a quote, url or stance. The optional `figure` and `note` are dropped when malformed. No entry is repaired or dropped.
 * A request need the reply does not mention is simply unanswered (the caller treats it as not found).
 */
export function parseArgumentEvidence(value: unknown, needIds: readonly string[]): ArgumentEvidenceItem[] {
  const refuse = (why: string): never => {
    throw new Error(`The argument evidence reply is not usable: ${why}.`);
  };
  if (!Array.isArray(value) || !value.length) return refuse("argumentEvidence is not a list");
  const allowed = new Set(needIds);
  const seen = new Set<string>();
  return value.map((entry: unknown): ArgumentEvidenceItem => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return refuse("an entry is not an object");
    const item = entry as Record<string, unknown>;
    const keys = Object.keys(item);
    if (
      EVIDENCE_KEYS.some(key => !keys.includes(key)) ||
      keys.some(key => !EVIDENCE_KEYS.includes(key) && !EVIDENCE_OPTIONAL_KEYS.includes(key))
    )
      return refuse("an entry has missing or extra fields");
    const { need, status, stance, claim, quote, url } = item;
    const note = readNote(item.note);
    if (typeof need !== "string" || !allowed.has(need)) return refuse("an entry cites an unknown need");
    if (seen.has(need)) return refuse("a need is answered twice");
    seen.add(need);
    if (typeof claim !== "string" || typeof quote !== "string" || typeof url !== "string" || typeof stance !== "string")
      return refuse("an entry field is not a string");
    if (status === "not_found") {
      // A claimed miss may not smuggle in a source; its claim text (a reason) is dropped.
      if (quote.trim() || url.trim() || stance !== "uncertain") return refuse("a not_found entry carries a source");
      return { need, status, ...(note ? { note } : {}) };
    }
    if (status !== "found") return refuse("status must be found or not_found");
    if (!EVIDENCE_STANCES.includes(stance)) return refuse("stance is not an allowed value");
    if (!claim.trim()) return refuse("a found entry has no claim");
    const trimmed = quote.normalize("NFKC").trim();
    const length = Array.from(trimmed).length;
    if (length < QUOTE_MIN || length > QUOTE_MAX || Array.from(foldText(trimmed)).length < QUOTE_FOLDED_MIN)
      return refuse(`a quote must be ${QUOTE_MIN} to ${QUOTE_MAX} characters of real text`);
    let protocol = "";
    try {
      protocol = new URL(url.trim()).protocol;
    } catch {
      return refuse("a url is not valid");
    }
    if (protocol !== "http:" && protocol !== "https:") return refuse("a url is not http or https");
    const figure = readFigure(item.figure);
    return {
      need,
      status: "found",
      stance: stance as "supports" | "contradicts" | "uncertain",
      claim: claim.trim(),
      quote: quote.trim(),
      url: url.trim(),
      ...(figure ? { figure } : {}),
      ...(note ? { note } : {})
    };
  });
}

export function parseAiResult(
  raw: string,
  label: string,
  language: ContentLanguage,
  argumentEvidenceNeedIds?: readonly string[]
): AiResult {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const parsed: {
    summary?: unknown;
    detail?: unknown;
    suggestions?: unknown;
    visualReferences?: unknown;
    argumentEvidence?: unknown;
  } = JSON.parse(extractJsonObject(cleaned)) as {
    summary?: unknown;
    detail?: unknown;
    suggestions?: unknown;
    visualReferences?: unknown;
    argumentEvidence?: unknown;
  };
  if (typeof parsed.summary !== "string" || typeof parsed.detail !== "string")
    throw new Error(t("error.ai_reply_missing_summary_0", label));
  const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
  const suggestions = Array.isArray(parsed.suggestions)
    ? parsed.suggestions
        .filter(
          (item): item is Record<string, unknown> =>
            isRecord(item) && typeof item.title === "string" && typeof item.task === "string"
        )
        .map(item => ({
          title: String(item.title).trim(),
          task: String(item.task).trim(),
          contribution: typeof item.contribution === "string" ? item.contribution.trim() : "",
          parentTitle: typeof item.parentTitle === "string" ? item.parentTitle.trim() : ""
        }))
        .filter(item => item.title)
    : [];
  const visualReferences = Array.isArray(parsed.visualReferences)
    ? parsed.visualReferences
        .filter(
          (item): item is Record<string, unknown> =>
            isRecord(item) && typeof item.imageUrl === "string" && typeof item.sourceUrl === "string"
        )
        .map(item => ({
          title: typeof item.title === "string" ? item.title.trim() : translateNote(language, "note.visual_reference"),
          imageUrl: String(item.imageUrl).trim(),
          sourceUrl: String(item.sourceUrl).trim(),
          description: typeof item.description === "string" ? item.description.trim() : "",
          palette: Array.isArray(item.palette)
            ? item.palette
                .map(String)
                .map(color => color.trim())
                .filter(Boolean)
                .slice(0, 8)
            : [],
          formula: typeof item.formula === "string" ? item.formula.trim() : ""
        }))
        .filter(item => /^https?:\/\//i.test(item.imageUrl) && /^https?:\/\//i.test(item.sourceUrl))
        .slice(0, 6)
    : [];
  const result: AiResult = {
    summary: truncateSummary(parsed.summary),
    // Checked before anything is written: an unsafe mermaid block is kept as plain code, never rendered.
    detail: neutralizeUnsafeMermaid(parsed.detail.trim()),
    suggestions,
    visualReferences,
    ...(argumentEvidenceNeedIds
      ? { argumentEvidence: parseArgumentEvidence(parsed.argumentEvidence, argumentEvidenceNeedIds) }
      : {})
  };
  return result;
}
