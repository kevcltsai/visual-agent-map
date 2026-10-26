import type { TaskContext } from "../../ai/types";
import { PASSAGE_REFERENCE } from "./steps/_shared/rules";

/**
 * A paragraph or line at least this long that already appears earlier in the request is replaced by a reference. The
 * reference text is under 100 characters, so a passage of this size is always worth replacing; a saved report's
 * paragraphs are usually a few hundred characters, which the earlier threshold of 512 left in twice.
 */
export const AIM_PASSAGE_MIN_CHARS = 200;

/** Fields buildPreparedTaskContext may cut when the request is over budget. */
const TRIMMED_FIELDS: ReadonlySet<string> = new Set(["detail", "workingFindings", "ancestors"]);

/** Remove identical long passages across fields, keeping one complete copy and explicit references. */
export function deduplicateAimRequest<T extends TaskContext>(context: T): T {
  const prepared = { ...context };
  // buildPreparedTaskContext later cuts detail, workingFindings and ancestors down from the end when a request is over
  // budget. A reference must never outlive its copy, so a copy that sits in one of those fields is referenced only from
  // the same field (the cut keeps the start of a field, so a reference after its copy survives with it).
  const passages = new Map<string, { id: number; key: string }>();
  const copyFor = (text: string, key: string): boolean => {
    const copy = passages.get(text);
    return copy !== undefined && (!TRIMMED_FIELDS.has(copy.key) || copy.key === key);
  };
  const remember = (text: string, key: string): void => {
    if (!passages.has(text)) passages.set(text, { id: passages.size + 1, key });
  };
  for (const key of ["task", "detail", "ancestors", "workingFindings", "summary", "rules", "title"] as const) {
    const value = prepared[key];
    if (typeof value !== "string") continue;
    const chunks = value.split(/(\n\n)/);
    prepared[key] = chunks
      .map(chunk => {
        if (chunk.length < AIM_PASSAGE_MIN_CHARS) return chunk;
        if (copyFor(chunk, key)) return PASSAGE_REFERENCE;
        remember(chunk, key);
        // Embedded lineage headers can differ while the report's long lines are identical.
        return chunk
          .split("\n")
          .map(line => {
            if (line.length < AIM_PASSAGE_MIN_CHARS || line === chunk) return line;
            if (copyFor(line, key)) return PASSAGE_REFERENCE;
            remember(line, key);
            return line;
          })
          .join("\n");
      })
      .join("");
  }
  return prepared;
}
