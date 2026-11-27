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

export type LivingMarkerState = "none" | "paired" | "corrupt";

/** Marker presence, not the ai-card flag: exactly one begin then one end is paired; any other use of either marker is corrupt. */
export function livingMarkerState(content: string): LivingMarkerState {
  const start = content.indexOf(LIVING_NODE_BEGIN);
  const end = content.indexOf(LIVING_NODE_END);
  if (start < 0 && end < 0) return "none";
  const damaged =
    start < 0 ||
    end < start ||
    content.indexOf(LIVING_NODE_BEGIN, start + LIVING_NODE_BEGIN.length) >= 0 ||
    content.indexOf(LIVING_NODE_END, end + LIVING_NODE_END.length) >= 0;
  return damaged ? "corrupt" : "paired";
}

/** True when the note is a Living Node: the markers, the ownership/commit metadata or the AI-card flag, whichever is present. */
export function isLivingNodeNote(content: string, fm: Record<string, unknown>): boolean {
  return (
    fm["ai-card"] === true ||
    fm["ai-card"] === "true" ||
    livingMarkerState(content) !== "none" ||
    fm["living-node-region-hash"] !== undefined ||
    fm["living-node-ownership"] !== undefined ||
    hasLivingCommitMetadata(fm)
  );
}

/**
 * The refusal an editor-side AI writer (selection panel, image translate) must honour on the text it is about to replace:
 * damaged markers first, then any Living Node (markers, metadata or the flag). Null means the write may go ahead.
 */
export function livingEditorRefusal(content: string, parse: (yaml: string) => unknown): "damaged" | "living" | null {
  if (livingMarkerState(content) === "corrupt") return "damaged";
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1] ?? "";
  let fm: Record<string, unknown> = {};
  try {
    const parsed = block ? parse(block) : {};
    if (parsed && typeof parsed === "object") fm = parsed as Record<string, unknown>;
  } catch {
    // Unreadable frontmatter: fail closed when it names a Living Node key.
    return /(?:ai-card|living-node-[\w-]+)["']?\s*:/.test(block) ? "living" : null;
  }
  return isLivingNodeNote(content, fm) ? "living" : null;
}

const withoutFrontmatter = (content: string): string => content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");

/** The frontmatter lines of every `living-node-*` key, with their continuation lines, compared as raw text. */
function livingMetadata(content: string): string {
  const yaml = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1] ?? "";
  const kept: string[] = [];
  let inLiving = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^[^\s#-]|^-\S/.test(line) || /^["']/.test(line)) inLiving = /^["']?living-node-/.test(line);
    if (inLiving) kept.push(line);
  }
  return kept.join("\n");
}

/** Proof that a write left the body bytes and every `living-node-*` metadata value as they were (frontmatter-only). */
export function keepsLivingBodyAndMetadata(
  before: string,
  after: string,
  readFrontmatter: (content: string) => Record<string, unknown>
): boolean {
  if (withoutFrontmatter(before) !== withoutFrontmatter(after) || livingMetadata(before) !== livingMetadata(after))
    return false;
  // The byte check can be fooled by quoted/escaped keys or reordered continuation lines; the parsed values must match too.
  try {
    const parsed = (content: string): string => {
      const fm = readFrontmatter(content);
      return JSON.stringify(
        Object.keys(fm)
          .filter(key => key.startsWith("living-node-"))
          .sort()
          .map(key => [key, fm[key]])
      );
    };
    return parsed(before) === parsed(after);
  } catch {
    return false;
  }
}

/** A successful formal commit leaves evidence distinct from a failed first attempt or V2 stamps. */
export function hasLivingCommitMetadata(metadata: Record<string, unknown>): boolean {
  return (
    metadata["living-node-outcome"] === "ok" ||
    [
      "living-node-last-execution",
      "living-node-success-knowledge",
      "living-node-last-successful-check",
      "living-node-last-content-change"
    ].some(key => metadata[key] !== undefined)
  );
}

/** Copy only formal knowledge and configuration. Run diagnostics belong to the original node. */
export function resetLivingCopyDiagnostics(metadata: Record<string, unknown>): void {
  // Resetting diagnostics must not erase the only evidence of damaged ownership.
  if (
    hasLivingCommitMetadata(metadata) &&
    metadata["living-node-region-hash"] === undefined &&
    metadata["living-node-ownership"] === undefined
  )
    throw new Error("unknown-ownership");
  if (metadata["ai-run-result"] === "ok" || metadata["living-node-copy-snapshot"] === true)
    metadata["living-node-copy-snapshot"] = true;
  for (const key of [
    "ai-run-at",
    "ai-run-result",
    "ai-run-input",
    "living-node-last-execution",
    "living-node-last-attempt",
    "living-node-last-successful-check",
    "living-node-last-content-change",
    "living-node-outcome",
    "living-node-input-revision",
    "living-node-success-knowledge",
    "last-error"
  ])
    delete metadata[key];
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
  const next = refs.map(ref => (ref.startsWith("note-path:") ? "note-path:" + rebase(ref.slice(10)) : ref));
  return next.some((ref, index) => ref !== refs[index]) ? next : null;
}
