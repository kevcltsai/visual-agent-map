/** The comparison table a map chat reply may carry (V3.3 P4.5): the shape the parser keeps and the pure builder of its columns and cells. */

/** At most this many rows and this many attributes are kept from one reply (the first ones). */
export const MAP_CHAT_COMPARISON_LIMIT = 8;
export interface MapChatComparisonValue {
  /** null = the cards do not say (shown as unknown). */
  value: string | null;
  /** The unit as the model wrote it; absent = none. */
  unit?: string;
}
export interface MapChatComparison {
  attributes: { name: string; unit?: string }[];
  rows: { nodeId: string; values: MapChatComparisonValue[] }[];
  /** How many valid rows / attributes the reply had beyond the limit and were left out; absent = none were. */
  truncated?: { rows: number; attributes: number };
}
export interface ComparisonColumn {
  /** Index into the comparison's attributes. */
  attribute: number;
  name: string;
  /** The unit this column holds; null = values with no unit (or a column whose values are all unknown and the attribute names no unit). */
  unit: string | null;
  /** The attribute was split into several columns because its values carry different units. */
  split: boolean;
}
export interface ComparisonTable {
  columns: ComparisonColumn[];
  rows: { nodeId: string; /** null = the card is no longer on the map. */ title: string | null; cells: string[] }[];
}

const NUMBER = String.raw`[+-]?\d[\d,]*(?:\.\d+)?`;
const PREFIX_UNIT = new RegExp(String.raw`^([A-Z]{2,3}\$|\$|€|£|¥|NT\$|US\$|HK\$)\s*${NUMBER}$`);
const SUFFIX_UNIT = new RegExp(
  String.raw`^${NUMBER}\s*(%|元|円|kg|g|km|m|cm|mm|ms|s|min|h|hr|小時|分鐘|天|日|週|月|年|人|次|GB|MB|TB)$`,
  "i"
);

/** The unit written inside a value that is a single number with a currency prefix or a known suffix; "" for anything else (the value text is never changed). */
function unitInsideValue(value: string): string {
  const text = value.trim();
  return PREFIX_UNIT.exec(text)?.[1] ?? SUFFIX_UNIT.exec(text)?.[1] ?? "";
}

/**
 * Columns and cells of a comparison. An attribute whose values carry different units (or some a unit and some none) becomes one column
 * per unit, in the order first seen; a value sits in its own unit's column only and the others show `unknown` (nothing is converted).
 * A null value is `unknown` in every column of its attribute. One unit or none = one column.
 * A value the model gave no unit for takes the unit written inside it when it is a single number with a currency prefix or a known suffix.
 */
export function buildComparisonTable(
  comparison: MapChatComparison,
  options: { titleOf: (nodeId: string) => string | null; unknown: string }
): ComparisonTable {
  const columns: ComparisonColumn[] = [];
  /** null, empty and blank values are all unknown. */
  const given = (cell: MapChatComparisonValue | undefined): string | null =>
    cell && cell.value !== null && cell.value.trim() ? cell.value : null;
  /** The unit of a cell: the model's own, else the one written inside the value. */
  const unitOf = (cell: MapChatComparisonValue | undefined): string => cell?.unit || unitInsideValue(cell?.value ?? "");
  comparison.attributes.forEach((attribute, at) => {
    const units: string[] = [];
    for (const row of comparison.rows) {
      const cell = row.values[at];
      if (given(cell) === null) continue;
      const unit = unitOf(cell);
      if (!units.includes(unit)) units.push(unit);
    }
    if (units.length === 0)
      columns.push({ attribute: at, name: attribute.name, unit: attribute.unit ?? null, split: false });
    else if (units.length === 1)
      columns.push({ attribute: at, name: attribute.name, unit: units[0] || attribute.unit || null, split: false });
    else
      for (const unit of units) columns.push({ attribute: at, name: attribute.name, unit: unit || null, split: true });
  });
  const rows = comparison.rows.map(row => ({
    nodeId: row.nodeId,
    title: options.titleOf(row.nodeId),
    cells: columns.map(column => {
      const cell = row.values[column.attribute];
      const value = given(cell);
      if (value === null) return options.unknown;
      if (!column.split) return value;
      return unitOf(cell) === (column.unit ?? "") ? value : options.unknown;
    })
  }));
  return { columns, rows };
}

/** The header text of one column: "Name (unit)", "Name (no unit)" for the unitless column of a split attribute, else the name. */
export function comparisonColumnHeader(
  column: ComparisonColumn,
  words: { withUnit: (name: string, unit: string) => string; noUnit: (name: string) => string }
): string {
  return column.unit !== null
    ? words.withUnit(column.name, column.unit)
    : column.split
      ? words.noUnit(column.name)
      : column.name;
}

/**
 * One Markdown table cell, always literal text (the model reads untrusted cards): every ASCII punctuation character except `& < >`
 * is backslash-escaped, then `& < >` become entities, and only then are line breaks written as our own `<br>`.
 * So no marker, link, embed, comment or HTML tag the model wrote can survive in the note.
 */
export function comparisonCell(text: string): string {
  return text
    .trim()
    .replace(/[!"#$%'()*+,\-./:;=?@[\\\]^_`{|}~]/g, "\\$&")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n?|\n/g, "<br>");
}

/**
 * The comparison as a Markdown table exactly as the chat shows it (same columns, headers, unknown cells, row titles), then the cut
 * notes the chat shows under it. The source-card links are not here: the note's `source-notes` makes the repository write them.
 */
export function comparisonMarkdown(
  table: ComparisonTable,
  options: { header: (column: ComparisonColumn) => string; gone: string; notes: string[] }
): string {
  // Not ai/markdown-intake.ts: every cell is one line and escaped to literal text by comparisonCell, so there is nothing left to sanitize.
  const line = (cells: string[]): string => `| ${cells.join(" | ")} |`;
  const row = (cells: string[]): string => line(cells.map(comparisonCell));
  const lines = [
    row(["", ...table.columns.map(options.header)]),
    line(["---", ...table.columns.map(() => "---")]),
    ...table.rows.map(entry => row([entry.title ?? options.gone, ...entry.cells]))
  ];
  return [lines.join("\n"), ...options.notes.map(note => `*${note.replace(/[*\r\n\s]+/g, " ").trim()}*`)].join("\n\n");
}
