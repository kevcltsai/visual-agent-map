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
/** The AI lock (`ai-locked: true`): only the boolean true locks; a missing or any other value reads as unlocked. */
export function readAiLocked(fm: Record<string, unknown>): boolean {
  return fm["ai-locked"] === true;
}
/**
 * The AI lock of a note given as text (an open editor's content): its frontmatter block is parsed with `parse` (Obsidian's
 * parseYaml) and read with {@link readAiLocked}. No frontmatter, or one that does not parse, reads as unlocked.
 */
export function noteTextAiLocked(text: string, parse: (yaml: string) => unknown): boolean {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (block === undefined || !/ai-locked/.test(block)) return false;
  try {
    const fm = parse(block);
    return !!fm && typeof fm === "object" && readAiLocked(fm as Record<string, unknown>);
  } catch {
    return false;
  }
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

export type TopicKind = "topic" | "action" | "atomic" | "hypothesis" | "evidence" | "conclusion";
export const TOPIC_KINDS: readonly TopicKind[] = ["topic", "action", "atomic", "hypothesis", "evidence", "conclusion"];
export type HypothesisStrength = "none" | "weak" | "medium" | "strong";
export const HYPOTHESIS_STRENGTHS: readonly HypothesisStrength[] = ["none", "weak", "medium", "strong"];
export type HypothesisLeaning = "supported" | "undecided" | "refuted";
export const HYPOTHESIS_LEANINGS: readonly HypothesisLeaning[] = ["supported", "undecided", "refuted"];
/** `topic-kind` is one of the six kinds; a missing or invalid value (wrong case, number, list) is an ordinary topic. */
export function readTopicKind(fm: Record<string, unknown>): TopicKind {
  const value = fm["topic-kind"];
  return typeof value === "string" && (TOPIC_KINDS as readonly string[]).includes(value)
    ? (value as TopicKind)
    : "topic";
}
/** A hypothesis's leaning (which way the evidence points); missing or invalid reads as undecided. A non-hypothesis has none, whatever the key says. */
export function readHypothesisLeaning(fm: Record<string, unknown>): HypothesisLeaning | undefined {
  if (readTopicKind(fm) !== "hypothesis") return undefined;
  const value = fm["hypothesis-leaning"];
  return typeof value === "string" && (HYPOTHESIS_LEANINGS as readonly string[]).includes(value)
    ? (value as HypothesisLeaning)
    : "undecided";
}
/** The stored strength of a hypothesis, leaning not applied: missing or invalid reads as none. A non-hypothesis has none, whatever the key says. */
export function readRawHypothesisStrength(fm: Record<string, unknown>): HypothesisStrength | undefined {
  if (readTopicKind(fm) !== "hypothesis") return undefined;
  const value = fm["hypothesis-strength"];
  return typeof value === "string" && (HYPOTHESIS_STRENGTHS as readonly string[]).includes(value)
    ? (value as HypothesisStrength)
    : "none";
}
/** A leaning of supported or refuted needs at least weak evidence: a none strength under such a leaning reads and is written as weak. */
export function consistentStrength(leaning: HypothesisLeaning, strength: HypothesisStrength): HypothesisStrength {
  return leaning !== "undecided" && strength === "none" ? "weak" : strength;
}
/** The strength to show: the stored one, read as weak when the hypothesis leans one way but the stored strength is none or missing. Reading never writes. */
export function readHypothesisStrength(fm: Record<string, unknown>): HypothesisStrength | undefined {
  const raw = readRawHypothesisStrength(fm),
    leaning = readHypothesisLeaning(fm);
  return raw === undefined || leaning === undefined ? undefined : consistentStrength(leaning, raw);
}
/**
 * What a write leaves in the file: the new leaning and strength (a change omitted keeps the current value), the strength
 * lifted to weak when the leaning is supported or refuted and the strength is none. Pure; both write paths share it.
 */
export function resolveHypothesisWrite(
  current: { leaning: HypothesisLeaning; strength: HypothesisStrength },
  change: { leaning?: HypothesisLeaning; strength?: HypothesisStrength }
): { leaning: HypothesisLeaning; strength: HypothesisStrength } {
  const leaning = change.leaning ?? current.leaning;
  return { leaning, strength: consistentStrength(leaning, change.strength ?? current.strength) };
}
