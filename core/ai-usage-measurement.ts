/** Provider token facts. An absent field is unavailable, not a reported zero. Cache fields are subsets/components of input, never added twice. */
export interface ReportedAiUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function facts(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Keep only valid numeric facts; do not manufacture missing values or retain arbitrary provider fields. */
export function normalizeReportedUsage(value: unknown): ReportedAiUsage | undefined {
  const row = facts(value);
  const result: ReportedAiUsage = {};
  for (const key of ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheWriteInputTokens"] as const) {
    const count = row[key];
    if (isTokenCount(count)) result[key] = count;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Claude's uncached input and separately reported cache read/write tokens make up its total input. */
export function claudeReportedUsage(value: unknown): ReportedAiUsage | undefined {
  const row = facts(value);
  const input = row.input_tokens;
  const read = row.cache_read_input_tokens;
  const write = row.cache_creation_input_tokens;
  const validOptional = (count: unknown): boolean => count === undefined || isTokenCount(count);
  const total =
    isTokenCount(input) && validOptional(read) && validOptional(write)
      ? input + (isTokenCount(read) ? read : 0) + (isTokenCount(write) ? write : 0)
      : undefined;
  return normalizeReportedUsage({
    inputTokens: total,
    outputTokens: row.output_tokens,
    cacheReadInputTokens: read,
    cacheWriteInputTokens: write
  });
}

/** Codex's cumulative inputTokens already includes cached input. */
export function codexReportedUsage(value: unknown): ReportedAiUsage | undefined {
  const row = facts(value);
  return normalizeReportedUsage({
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadInputTokens: row.cachedInputTokens,
    cacheWriteInputTokens: row.cacheWriteInputTokens
  });
}

/** Compatibility with the numeric usage-store totals: missing sides contribute no known tokens, with an explicit incompleteness flag. */
export function reportedUsageSubtotal(
  usage: ReportedAiUsage | undefined
): { inputTokens: number; outputTokens: number; incomplete?: true } | undefined {
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  if (!isTokenCount(input) && !isTokenCount(output)) return undefined;
  return {
    inputTokens: isTokenCount(input) ? input : 0,
    outputTokens: isTokenCount(output) ? output : 0,
    ...(!isTokenCount(input) || !isTokenCount(output) ? { incomplete: true as const } : {})
  };
}
