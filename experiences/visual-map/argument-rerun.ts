/**
 * Re-run from the definitions card (V1 boost). The owner edits the definitions table in the card's note; this reads it back (the inverse of
 * `definitionsDetail`) and starts a NEW map (created in the mind-maps folder like any new map) with those items as the assumption card. The original map is never written.
 */
import type { AssumptionItem } from "../../core/argument-map/model";

const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&" };
/** The builder's entity encoding (`&#NN;` for every Markdown punctuation character), decoded in one pass so a literal `&amp;` survives read back as characters. */
const decode = (text: string): string =>
  text.replace(/&(?:#(\d{1,5})|(lt|gt|amp));/g, (_m, code?: string, name?: string) =>
    code ? String.fromCodePoint(Number(code)) : ENTITY[name!]
  );

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
    const [label, value, reason] = parts.map(part => decode(part).trim());
    if (!label || !value || !reason || label === "-" || value === "-") return null;
    items.push({ label, value, reason });
  }
  return items;
}

export interface RerunPorts {
  /** The definitions card's note body (what the owner may have edited). */
  readDefinitions(): Promise<string>;
  /** The proposition text of the map being re-run. */
  proposition(): string;
  /** Creates the new map in the mind-maps folder (not necessarily next to the original) and returns its path. Only called after the table was read. */
  createMap(): Promise<string>;
  /** Starts the run on the new map with the assumption card preset. */
  start(mapPath: string, proposition: string, presetAssumptions: AssumptionItem[]): Promise<void>;
}

/** "unreadable": nothing was created. "started": the new map's path (the run is not awaited by the caller's UI). */
export type RerunResult = { kind: "unreadable" } | { kind: "started"; mapPath: string };

export async function rerunWithAssumptions(ports: RerunPorts): Promise<RerunResult> {
  const items = parseDefinitionsTable(await ports.readDefinitions());
  const proposition = ports.proposition().trim();
  if (!items?.length || !proposition) return { kind: "unreadable" };
  const mapPath = await ports.createMap();
  void ports.start(mapPath, proposition, items);
  return { kind: "started", mapPath };
}
