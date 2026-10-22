import { HAN_SIMPLIFIED, HAN_SIMPLIFIED_ONLY, HAN_TRADITIONAL } from "./han-variants";

// Traditional -> Simplified single-character folding built from the generated table (scripts/gen-han-variants.swift).
const TO_SIMPLIFIED = new Map<string, string>();
const SIMPLIFIED_ONLY = new Set<string>(Array.from(HAN_SIMPLIFIED_ONLY));
{
  const traditional = Array.from(HAN_TRADITIONAL);
  const simplified = Array.from(HAN_SIMPLIFIED);
  traditional.forEach((char, index) => {
    TO_SIMPLIFIED.set(char, simplified[index]);
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
 * traditional: characters that have a different Simplified form (keys of the table, e.g. 圖 發 髮 後 灣).
 * simplified: characters ICU "Hans-Hant" changes (so they are not valid Traditional as-is) and that are not Traditional keys,
 *   e.g. 图 发 后 干. Characters valid in both scripts (中 人 台 面 里) count for neither, so 台北 votes {0, 0}.
 * Edge case: 后 votes simplified because ICU maps it to 後, even though 皇后 is valid Traditional.
 * Callers should treat a tie or no votes as "unknown".
 */
export const hanScriptVotes = (text: string): { simplified: number; traditional: number } => {
  let simplified = 0;
  let traditional = 0;
  for (const char of text) {
    if (TO_SIMPLIFIED.has(char)) traditional += 1;
    else if (SIMPLIFIED_ONLY.has(char)) simplified += 1;
  }
  return { simplified, traditional };
};
