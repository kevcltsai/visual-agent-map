/** What a managed note section or heading reads back as after Repository writes it; readback checks compare against these. */
export const managedSectionValue = (value: string): string => value.trim();
export const managedHeadingValue = (value: string): string => value.replace(/\n/g, " ").trim();

export type RelevanceTier = "core" | "support" | "side";
export interface NoteRelevance {
  tier: RelevanceTier;
  /** True when the owner set this tier by hand (`relevance-manual: true`). */
  manual?: true;
}
const RELEVANCE_TIERS: readonly string[] = ["core", "support", "side"];
/**
 * Relevance read from note frontmatter (`relevance-tier`, `relevance-manual`). A valid tier is a grade; a missing or
 * unrecognised tier reads as no relevance at all, so the map looks exactly as it did without grading. A leftover
 * `relevance-reason` from an older version is ignored.
 */
export function readRelevance(fm: Record<string, unknown>): NoteRelevance | undefined {
  const tier = fm["relevance-tier"];
  if (typeof tier !== "string" || !RELEVANCE_TIERS.includes(tier)) return undefined;
  if (fm["relevance-manual"] === true) return { tier: tier as RelevanceTier, manual: true };
  return { tier: tier as RelevanceTier };
}
/** The learning goal in the map file's frontmatter (`relevance-goal`); absent or blank reads as none. */
export function readRelevanceGoal(fm: Record<string, unknown>): string | undefined {
  const goal = fm["relevance-goal"];
  return typeof goal === "string" && goal.trim() ? goal.trim() : undefined;
}
/** The longest goal the map accepts (characters). */
export const RELEVANCE_GOAL_MAX_LENGTH = 200;
/** A goal as stored: one line, single spaces, trimmed, at most {@link RELEVANCE_GOAL_MAX_LENGTH} characters. */
export function normalizeRelevanceGoal(value: string): string {
  return [...value.replace(/\s+/g, " ").trim()].slice(0, RELEVANCE_GOAL_MAX_LENGTH).join("").trim();
}

export type RelevanceLevel = "beginner" | "intermediate" | "familiar";
export const RELEVANCE_LEVELS: readonly RelevanceLevel[] = ["beginner", "intermediate", "familiar"];
/** The learner's level in the map file's frontmatter (`relevance-level`); anything else reads as not set. */
export function readRelevanceLevel(fm: Record<string, unknown>): RelevanceLevel | undefined {
  const level = fm["relevance-level"];
  return typeof level === "string" && (RELEVANCE_LEVELS as readonly string[]).includes(level)
    ? (level as RelevanceLevel)
    : undefined;
}
/** A level as the select reports it: one of the three, or undefined for "not set" and anything unrecognised. */
export function normalizeRelevanceLevel(value: unknown): RelevanceLevel | undefined {
  return typeof value === "string" && (RELEVANCE_LEVELS as readonly string[]).includes(value)
    ? (value as RelevanceLevel)
    : undefined;
}
/** The longest context line the map accepts (characters). */
export const RELEVANCE_CONTEXT_MAX_LENGTH = 200;
/** Context as stored: one line, single spaces, trimmed, at most {@link RELEVANCE_CONTEXT_MAX_LENGTH} characters; blank is none. */
export function normalizeRelevanceContext(value: string): string | undefined {
  const text = [...value.replace(/\s+/g, " ").trim()].slice(0, RELEVANCE_CONTEXT_MAX_LENGTH).join("").trim();
  return text || undefined;
}
/** The learner's context line in the map file's frontmatter (`relevance-context`); absent or blank reads as none. */
export function readRelevanceContext(fm: Record<string, unknown>): string | undefined {
  const context = fm["relevance-context"];
  return typeof context === "string" ? normalizeRelevanceContext(context) : undefined;
}
