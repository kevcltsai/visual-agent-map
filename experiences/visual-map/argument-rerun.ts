/**
 * Re-run from the definitions card (V1 boost). The owner edits the definitions table in the card's note; this reads it back (the inverse of
 * `definitionsDetail`) and starts a NEW map (created in the mind-maps folder like any new map) with those items as the assumption card. The original map is never written.
 */
import type { AssumptionItem, QuestionType } from "../../core/argument-map/model";

const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&" };
/** The reverse of a full-width twin (U+FF01..U+FF5E) back to its ASCII character. */
const narrow = (c: string): string => String.fromCharCode(c.charCodeAt(0) - 0xfee0);
const narrowRun = (run: string): string => [...run].map(narrow).join("");
/**
 * The inverse of the builder's `line`: full-width twins go back to ASCII only where the builder made them (always-wide characters, runs of
 * `％％` `＝＝` `～～`, a leading marker, `＆` before an entity, `：` in `：//` or `：：`, `www．`), so native full-width text such as `30％` or `：` stays.
 * Entities from notes written by an earlier build (`&#37;`) are decoded first, in one pass, so a literal `&amp;` survives as characters.
 */
const decode = (text: string): string =>
  text
    .replace(/&(?:#(\d{1,5})|(lt|gt|amp));/g, (_m, code?: string, name?: string) =>
      code ? String.fromCodePoint(Number(code)) : ENTITY[name!]
    )
    .replace(/^(?:([＋－＞])|(\d+)([．）]))/, (_m, mark?: string, digits?: string, ordered?: string) =>
      digits ? `${digits}${ordered === "．" ? "." : ")"}` : narrow(mark!)
    )
    .replace(/[＼｀＊＿＾＃＄［］＜｜]/g, narrow)
    .replace(/％{2,}|＝{2,}|～{2,}/g, narrowRun)
    .replace(/＆(?=#|\w+;)/g, narrow)
    .replace(/：+(?=\/)|：{2,}/g, narrowRun)
    .replace(/\bwww．/gi, m => `${m.slice(0, 3)}.`);

const cells = (row: string): string[] => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
const isSeparator = (row: string): boolean => cells(row).every(cell => /^\s*:?-{3,}:?\s*$/.test(cell));

/**
 * The first Markdown table of a definitions note as assumption items (item, definition, reason), or null when it cannot be read: no table,
 * a row that does not have exactly three cells, or a blank item or definition or reason. Nothing is guessed.
 */
export function parseDefinitionsTable(detail: string): AssumptionItem[] | null {
  const lines = detail.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim().startsWith("|"));
  if (start < 0) return null;
  const block: string[] = [];
  for (const line of lines.slice(start)) {
    if (!line.trim().startsWith("|")) break;
    block.push(line);
  }
  if (block.length < 3 || cells(block[0]).length !== 3 || !isSeparator(block[1])) return null;
  const items: AssumptionItem[] = [];
  for (const row of block.slice(2)) {
    const parts = cells(row);
    if (parts.length !== 3) return null;
    const [label, value, reason] = parts.map(part => decode(part.trim()));
    if (!label || !value || !reason || label === "-" || value === "-") return null;
    items.push({ label, value, reason });
  }
  return items;
}

/** Names the 題型 line may use, in the three languages the note is written in (and the stored words). */
const QUESTION_TYPE_NAMES: Record<string, QuestionType> = {
  事實題: "fact",
  事实题: "fact",
  "fact question": "fact",
  fact: "fact",
  因果題: "causal",
  因果题: "causal",
  "causal question": "causal",
  causal: "causal"
};

/**
 * The question type the owner left on the definitions note's 題型 line (the lines above the table): a type, `undefined` when there is
 * no such line (the AI decides), or `null` when the line is there but its value is not a known type (nothing is guessed).
 */
export function parseQuestionType(detail: string): QuestionType | null | undefined {
  for (const raw of detail.split(/\r?\n/)) {
    if (raw.trim().startsWith("|")) return undefined;
    const m = /^\s*(?:題型|题型|question type)\s*[:：]\s*(.*?)\s*$/i.exec(raw);
    if (m) return QUESTION_TYPE_NAMES[m[1].toLowerCase()] ?? null;
  }
  return undefined;
}

export interface RerunPorts {
  /** The definitions card's note body (what the owner may have edited). */
  readDefinitions(): Promise<string>;
  /** The proposition text of the map being re-run. */
  proposition(): string;
  /** Creates the new map in the mind-maps folder (not necessarily next to the original) and returns its path. Only called after the table was read. */
  createMap(): Promise<string>;
  /** Starts the run on the new map with the assumption card preset. */
  start(
    mapPath: string,
    proposition: string,
    presetAssumptions: AssumptionItem[],
    presetQuestionType?: QuestionType
  ): Promise<void>;
}

/** "unreadable": nothing was created. "started": the new map's path (the run is not awaited by the caller's UI). */
export type RerunResult = { kind: "unreadable" } | { kind: "started"; mapPath: string };

export async function rerunWithAssumptions(ports: RerunPorts): Promise<RerunResult> {
  const detail = await ports.readDefinitions();
  const items = parseDefinitionsTable(detail);
  const questionType = parseQuestionType(detail);
  const proposition = ports.proposition().trim();
  if (!items?.length || !proposition || questionType === null) return { kind: "unreadable" };
  const mapPath = await ports.createMap();
  void ports.start(mapPath, proposition, items, questionType);
  return { kind: "started", mapPath };
}
