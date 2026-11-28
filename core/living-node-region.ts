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

/**
 * A note with every managed Living Node part removed: the `living-node-*` frontmatter keys (ownership index, hashes,
 * replay metadata) and any region or lone marker (a torn region is cut from or up to its marker). What may reach a
 * provider when the richer model view is unavailable. A note with none of these is returned unchanged.
 */
export function livingNoteWithoutManaged(content: string): string {
  let out = content;
  const match = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(out);
  if (match && /(^|\n)["']?living-node-/.test(match[2])) {
    let inLiving = false;
    const kept = match[2].split(/\r?\n/).filter(line => {
      if (/^[^\s#-]|^-\S/.test(line) || /^["']/.test(line)) inLiving = /^["']?living-node-/.test(line);
      return !inLiving;
    });
    out = match[1] + kept.join("\n") + match[3] + out.slice(match[0].length);
  }
  for (;;) {
    const start = out.indexOf(LIVING_NODE_BEGIN);
    const end = start < 0 ? -1 : out.indexOf(LIVING_NODE_END, start);
    if (end < 0) break;
    out = out.slice(0, start) + out.slice(end + LIVING_NODE_END.length);
  }
  const lone = out.indexOf(LIVING_NODE_BEGIN);
  if (lone >= 0) out = out.slice(0, lone);
  const loneEnd = out.indexOf(LIVING_NODE_END);
  if (loneEnd >= 0) out = out.slice(loneEnd + LIVING_NODE_END.length);
  return out;
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

export const LIVING_GENERATION_KEY = "living-node-generation";
export const LIVING_RECEIPTS_KEY = "living-node-receipts";
export const LIVING_RECEIPT_LIMIT = 20;

export interface LivingFence {
  generation: number;
  /** The last execution ids that committed, oldest first, at most LIVING_RECEIPT_LIMIT. */
  receipts: string[];
}

/**
 * Replay fence stored with the region metadata. A note written before V1.1 has neither key and migrates forward as
 * generation 0 (its last execution id counts as a receipt). Malformed values fail closed and are never rewritten.
 */
export function readLivingFence(fm: Record<string, unknown>): LivingFence {
  const raw = fm[LIVING_GENERATION_KEY];
  if (raw !== undefined && (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0))
    throw new Error("invalid-generation");
  const stored = fm[LIVING_RECEIPTS_KEY];
  if (stored !== undefined && (!Array.isArray(stored) || stored.some(id => typeof id !== "string")))
    throw new Error("invalid-receipts");
  const receipts = [...((stored as string[] | undefined) ?? [])];
  const last = fm["living-node-last-execution"];
  if (typeof last === "string" && last && !receipts.includes(last)) receipts.push(last);
  return { generation: raw ?? 0, receipts: receipts.slice(-LIVING_RECEIPT_LIMIT) };
}

/** The fence metadata a commit writes: one generation up, this execution recorded, receipts bounded. */
export function livingFenceAfterCommit(fence: LivingFence, executionId: string): Record<string, unknown> {
  return {
    [LIVING_GENERATION_KEY]: fence.generation + 1,
    [LIVING_RECEIPTS_KEY]: [...fence.receipts.filter(id => id !== executionId), executionId].slice(
      -LIVING_RECEIPT_LIMIT
    )
  };
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
    "living-node-last-change",
    "living-node-checked",
    "living-node-outcome",
    "living-node-reason",
    "living-node-input-revision",
    "living-node-success-knowledge",
    "last-error"
  ])
    delete metadata[key];
  // A copy keeps the generation (a number nobody replays against); the original's execution ids stay with the original.
  delete metadata[LIVING_RECEIPTS_KEY];
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

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item
  );

/**
 * Whether `after` is only a re-layout of the Living Node note `before`: same frontmatter values (quoting and key order
 * aside), same managed region, same body text outside the region (blank lines and the place of the region aside). A
 * derived-data rebuild must not rewrite such a note: nothing in it changed, and every rewrite moves the offsets that
 * Obsidian's own pending link updates were collected at.
 */
export function livingRewriteIsReformatOnly(
  before: string,
  after: string,
  readFrontmatter: (content: string) => Record<string, unknown>
): boolean {
  try {
    if (livingMarkerState(before) !== "paired" || livingMarkerState(after) !== "paired") return false;
    const first = splitLivingNodeRegion(before),
      second = splitLivingNodeRegion(after);
    if (first.region !== second.region) return false;
    if (canonicalJson(readFrontmatter(before)) !== canonicalJson(readFrontmatter(after))) return false;
    const bodyOf = (content: string): string =>
      content
        .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
        .replace(/\s+/g, " ")
        .trim();
    return bodyOf(first.body) === bodyOf(second.body);
  } catch {
    return false;
  }
}
