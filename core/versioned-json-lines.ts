import { isRecord } from "./is-record";

interface ParsedJsonLines<T> {
  lines: T[];
  skipped: number;
  unrecoverable: boolean;
  cleanEnd: boolean;
}

/** Shared framing only: each record domain owns its payload validation and schema version. */
export function parseVersionedJsonLines<T>(
  text: string,
  version: number,
  validate: (value: Record<string, unknown>) => T | null
): ParsedJsonLines<T> {
  const lines: T[] = [];
  let skipped = 0;
  let unrecoverable = false;
  for (const part of text.split("\n")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      skipped++;
      continue;
    }
    if (!isRecord(value)) {
      skipped++;
      continue;
    }
    if (value.v !== undefined && value.v !== version) {
      unrecoverable = true;
      continue;
    }
    const line = value.v === version ? validate(value) : null;
    if (line !== null) lines.push(line);
    else skipped++;
  }
  return { lines, skipped, unrecoverable, cleanEnd: text === "" || text.endsWith("\n") };
}

/** Keep the version first and never let a supplied version override the writer's version. */
export function serializeVersionedJsonLine(version: number, line: object): string {
  const { v: _ignored, ...rest } = line as { v?: unknown } & Record<string, unknown>;
  void _ignored;
  return `${JSON.stringify({ v: version, ...rest })}\n`;
}
