/** A compact index, never a replacement for the report retained in the Vault. */
export function evidenceCard(id: string, summary: string, detail: string): string {
  const urls = [...new Set(detail.match(/https?:\/\/[^\s)<>\]"']+/g) ?? [])];
  const limits = detail.split(/\n\n/).filter(part => /uncertain|unresolved|limitation|unknown|不足|不確定|限制|缺口|尚未|待確認/i.test(part));
  return [
    `Evidence ID: ${id}`,
    `Summary: ${summary}`,
    `Limitations excerpt (not exhaustive): ${limits.join('\n').slice(0, 600) || 'Consult the full report before inferring that there are no limitations.'}`,
    `Source index (first 6 of ${urls.length}): ${urls.slice(0, 6).join(' ') || 'No source URLs recorded.'}`,
    `Full report retained (${detail.length} characters). This index is incomplete; request the evidence ID when detail is needed.`
  ].join('\n');
}

export const EVIDENCE_LOOKUP_RULE = 'Evidence cards are incomplete indexes, not full verified reports. Do not infer a missing fact is absent from the report. If a decision or claim depends on omitted detail, return only <!-- mindsearch-evidence-request {"ids":["exact evidence ID"]} --> in detail, with a short summary and empty suggestions. Up to 3 indexed reports can be loaded in one bounded lookup; do not invent IDs. Do not conclude from a card when decisive evidence is missing.';
