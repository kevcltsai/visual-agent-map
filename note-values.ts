/** What a managed note section or heading reads back as after Repository writes it; readback checks compare against these. */
export const managedSectionValue = (value: string): string => value.trim();
export const managedHeadingValue = (value: string): string => value.replace(/\n/g, " ").trim();

/** The AI lock (`ai-locked: true`): only the boolean true locks; a missing or any other value reads as unlocked. */
export function readAiLocked(fm: Record<string, unknown>): boolean {
  return fm["ai-locked"] === true;
}
/** The AI card flag (`ai-card: true`): only the boolean true sets it. */
export function readAiCard(fm: Record<string, unknown>): boolean {
  return fm["ai-card"] === true;
}
/** The last "run all" record of an AI card: `ai-run-at` (text), `ai-run-result` (ok, failed or blocked) and `ai-run-input` (text); absent unless the first two are valid. */
export function readAiRun(
  fm: Record<string, unknown>
): { at: string; result: "ok" | "failed" | "blocked"; input?: string } | undefined {
  const at = fm["ai-run-at"];
  const result = fm["ai-run-result"];
  if (typeof at !== "string" || !at) return undefined;
  if (result !== "ok" && result !== "failed" && result !== "blocked") return undefined;
  const input = fm["ai-run-input"];
  return { at, result, ...(typeof input === "string" && input ? { input } : {}) };
}
/** An AI card's "keep old data" switch off (`ai-update-mode: fresh`); any other value keeps the old text (new on top). */
export function readAiUpdateMode(fm: Record<string, unknown>): "fresh" | undefined {
  return fm["ai-update-mode"] === "fresh" ? "fresh" : undefined;
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
