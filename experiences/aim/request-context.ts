import type { TaskContext } from "../../ai/types";
import { PASSAGE_REFERENCE } from "./steps/_shared/rules";

/**
 * A paragraph or line at least this long that already appears earlier in the request is replaced by a reference. The
 * reference text is under 100 characters, so a passage of this size is always worth replacing; a saved report's
 * paragraphs are usually a few hundred characters, which the earlier threshold of 512 left in twice.
 */
export const AIM_PASSAGE_MIN_CHARS = 200;

/** Remove identical long passages across fields, keeping one complete copy and explicit references. */
export function deduplicateAimRequest<T extends TaskContext>(context: T): T {
  const prepared = { ...context };
  const passages = new Map<string, number>();
  for (const key of ["task", "detail", "ancestors", "workingFindings", "summary", "rules", "title"] as const) {
    const value = prepared[key];
    if (typeof value !== "string") continue;
    const chunks = value.split(/(\n\n)/);
    prepared[key] = chunks
      .map(chunk => {
        if (chunk.length < AIM_PASSAGE_MIN_CHARS) return chunk;
        const previous = passages.get(chunk);
        if (previous !== undefined) return PASSAGE_REFERENCE;
        passages.set(chunk, passages.size + 1);
        // Embedded lineage headers can differ while the report's long lines are identical.
        return chunk
          .split("\n")
          .map(line => {
            if (line.length < AIM_PASSAGE_MIN_CHARS || line === chunk) return line;
            const earlier = passages.get(line);
            if (earlier !== undefined) return PASSAGE_REFERENCE;
            passages.set(line, passages.size + 1);
            return line;
          })
          .join("\n");
      })
      .join("");
  }
  return prepared;
}
