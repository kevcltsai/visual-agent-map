import { contentHash } from "./content-hash";

/** Saved configuration baseline shared by editor and chat; no knowledge or diagnostics. */
export function livingConfigurationStamp(prompt: string, fm: Record<string, unknown>): string {
  return contentHash(JSON.stringify([prompt, fm["living-node-refs"], fm["ai-card"], fm["ai-locked"]]));
}

/** Living Node's same-note region is outside the legacy note-section rewriting contract. */
export const LIVING_NODE_BEGIN = "<!-- vam-living-node:begin v1 -->";
export const LIVING_NODE_END = "<!-- vam-living-node:end v1 -->";

export function splitLivingNodeRegion(content: string): { body: string; region: string } {
  const start = content.indexOf(LIVING_NODE_BEGIN);
  const end = content.indexOf(LIVING_NODE_END);
  if (start < 0 && end < 0) return { body: content, region: "" };
  if (
    start < 0 ||
    end < start ||
    content.indexOf(LIVING_NODE_BEGIN, start + LIVING_NODE_BEGIN.length) >= 0 ||
    content.indexOf(LIVING_NODE_END, end + LIVING_NODE_END.length) >= 0
  )
    throw new Error("ambiguous-living-node-region");
  const after = end + LIVING_NODE_END.length;
  return {
    body: content.slice(0, start) + content.slice(after),
    region: content.slice(start, after)
  };
}

/** Copy only formal knowledge and configuration. Run diagnostics belong to the original node. */
export function resetLivingCopyDiagnostics(metadata: Record<string, unknown>): void {
  if (metadata["ai-run-result"] === "ok" || metadata["living-node-copy-snapshot"] === true)
    metadata["living-node-copy-snapshot"] = true;
  for (const key of [
    "ai-run-at", "ai-run-result", "ai-run-input",
    "living-node-last-execution", "living-node-last-attempt", "living-node-last-successful-check",
    "living-node-last-content-change", "living-node-outcome", "living-node-input-revision",
    "living-node-success-knowledge", "last-error"
  ]) delete metadata[key];
  if (metadata.status === "running") metadata.status = "idea";
}

/** Source identities are scoped to their original map. An unresolved cross-map
 * reference remains an explicit missing reference until the user repairs it.
 */
export function remapLivingCopyCardReferences(
  refs: readonly string[],
  sourceMap: string,
  destinationMap: string,
  copies: ReadonlyMap<string, string>
): string[] {
  return refs.map(ref => {
    if (!ref.startsWith("card:")) return ref;
    const id = ref.slice(5);
    if (id.startsWith("foreign:")) return ref;
    const replacement = copies.get(JSON.stringify([sourceMap, id]));
    if (replacement) return "card:" + replacement;
    return sourceMap && sourceMap === destinationMap ? ref : "card:foreign:" + JSON.stringify([sourceMap, id]);
  });
}


/** Canonical file references follow actual Vault renames, never basename guesses.
 * Legacy note aliases and stable card IDs are untouched. Invalid lists are not repaired silently. */
export function rebaseLivingNoteReferences(raw: unknown, rebase: (path: string) => string): string[] | null {
  if (!Array.isArray(raw) || raw.some(value => typeof value !== "string")) return null;
  const refs = raw as string[];
  const next = refs.map(ref => ref.startsWith("note-path:") ? "note-path:" + rebase(ref.slice(10)) : ref);
  return next.some((ref, index) => ref !== refs[index]) ? next : null;
}
