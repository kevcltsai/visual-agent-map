import { foldAimContract, type AimContract } from "../../../ai/aim-contracts";
import { neutralizeUnsafeMermaid } from "../../../ai/mermaid-safety";
import { truncateSummary } from "../../../ai/result-utils";
import { SEARCH_STATUSES, type AiResult, type SearchStatus } from "../../../ai/types";
import { t, type UiLanguage, translateNote } from "../../../i18n";

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

export function parseAiResult(
  raw: string,
  label: string,
  language: UiLanguage,
  strictGapAudit = false,
  webResearch = false,
  contract?: AimContract
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
    searchStatus?: unknown;
    aim?: unknown;
  } = JSON.parse(extractJsonObject(cleaned)) as {
    summary?: unknown;
    detail?: unknown;
    suggestions?: unknown;
    visualReferences?: unknown;
    searchStatus?: unknown;
    aim?: unknown;
  };
  if (typeof parsed.summary !== "string" || typeof parsed.detail !== "string")
    throw new Error(t("error.ai_reply_missing_summary_0", label));
  if (
    strictGapAudit &&
    (!(["user_condition", "external_evidence"] as string[]).includes(parsed.summary) ||
      !parsed.detail.trim() ||
      !Array.isArray(parsed.suggestions) ||
      parsed.suggestions.length !== 0 ||
      !Array.isArray(parsed.visualReferences) ||
      parsed.visualReferences.length !== 0)
  ) {
    throw new Error("AIM research-gap audit returned an invalid structured classification.");
  }
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
  const searchStatus =
    webResearch && (SEARCH_STATUSES as readonly unknown[]).includes(parsed.searchStatus)
      ? (parsed.searchStatus as SearchStatus)
      : undefined;
  const result: AiResult = {
    summary: truncateSummary(parsed.summary),
    // Checked before anything is written: an unsafe mermaid block is kept as plain code, never rendered.
    detail: neutralizeUnsafeMermaid(parsed.detail.trim()),
    suggestions,
    visualReferences,
    ...(searchStatus ? { searchStatus } : {})
  };
  return contract ? foldAimContract(contract, parsed.aim, result) : result;
}
