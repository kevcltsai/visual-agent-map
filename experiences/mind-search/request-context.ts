import type { TaskContext } from "../../ai/types";

/** Remove identical long passages across fields, keeping one complete copy and explicit references. */
export function deduplicateMindSearchRequest<T extends TaskContext>(context: T): T {
  const prepared = { ...context };
  const passages = new Map<string, number>();
  for (const key of ['task', 'detail', 'ancestors', 'workingFindings', 'summary', 'rules', 'title'] as const) {
    const value = prepared[key];
    if (typeof value !== 'string') continue;
    const chunks = value.split(/(\n\n)/);
    prepared[key] = chunks.map(chunk => {
      if (chunk.length < 512) return chunk;
      const previous = passages.get(chunk);
      if (previous !== undefined) return `[This exact passage already appears elsewhere in this request; reuse that complete copy here.]`;
      passages.set(chunk, passages.size + 1);
      // Embedded lineage headers can differ while the report's long lines are identical.
      return chunk.split('\n').map(line => {
        if (line.length < 512 || line === chunk) return line;
        const earlier = passages.get(line);
        if (earlier !== undefined) return `[This exact passage already appears elsewhere in this request; reuse that complete copy here.]`;
        passages.set(line, passages.size + 1);
        return line;
      }).join('\n');
    }).join('');
  }
  return prepared;
}
