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

/**
 * Columns and cells of a comparison. An attribute whose values carry different units (or some a unit and some none) becomes one column
 * per unit, in the order first seen; a value sits in its own unit's column only and the others show `unknown` (nothing is converted).
 * A null value is `unknown` in every column of its attribute. One unit or none = one column.
 */
export function buildComparisonTable(
  comparison: MapChatComparison,
  options: { titleOf: (nodeId: string) => string | null; unknown: string }
): ComparisonTable {
  const columns: ComparisonColumn[] = [];
  /** null, empty and blank values are all unknown. */
  const given = (cell: MapChatComparisonValue | undefined): string | null =>
    cell && cell.value !== null && cell.value.trim() ? cell.value : null;
  comparison.attributes.forEach((attribute, at) => {
    const units: string[] = [];
    for (const row of comparison.rows) {
      const cell = row.values[at];
      if (given(cell) === null) continue;
      const unit = cell?.unit ?? "";
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
      return (cell?.unit ?? "") === (column.unit ?? "") ? value : options.unknown;
    })
  }));
  return { columns, rows };
}
