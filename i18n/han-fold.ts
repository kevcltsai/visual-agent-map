import { HAN_SIMPLIFIED, HAN_TRADITIONAL } from "./han-variants";

// Traditional -> Simplified single-character folding built from the generated table (scripts/gen-han-variants.swift).
const TO_SIMPLIFIED = new Map<string, string>();
const SIMPLIFIED_FORMS = new Set<string>();
{
  const traditional = Array.from(HAN_TRADITIONAL);
  const simplified = Array.from(HAN_SIMPLIFIED);
  traditional.forEach((char, index) => {
    TO_SIMPLIFIED.set(char, simplified[index]);
    SIMPLIFIED_FORMS.add(simplified[index]);
  });
}

/** Folds Traditional Chinese characters to their Simplified form so a Simplified query matches Traditional text and vice versa. Other characters pass through. */
export const toSimplifiedFold = (text: string): string => {
  let out = "";
  for (const char of text) out += TO_SIMPLIFIED.get(char) ?? char;
  return out;
};

/**
 * Counts script evidence in text.
 * traditional: characters that have a different Simplified form (keys of the table, e.g. 圖 發 髮 後).
 * simplified: characters that are the Simplified form of some Traditional character AND are not themselves Traditional-only
 *   (not a key), e.g. 图 发 (from both 發 and 髮) 后.
 * Characters shared by both scripts (中 人) count for neither. Edge case: a few Simplified targets (后 里 面 台 干) are
 * also ordinary Traditional characters, so they vote simplified; real Traditional text carries enough Traditional-only
 * characters to outvote them, and callers should treat a tie or no votes as "unknown".
 */
export const hanScriptVotes = (text: string): { simplified: number; traditional: number } => {
  let simplified = 0;
  let traditional = 0;
  for (const char of text) {
    if (TO_SIMPLIFIED.has(char)) traditional += 1;
    else if (SIMPLIFIED_FORMS.has(char)) simplified += 1;
  }
  return { simplified, traditional };
};
