// Map chat's own token estimate, used by the step's over_budget check (core/steps/map-chat/step.ts) and by the context's total
// budget (core/map-chat-context.ts), so both measure the same way. The shared `estimateTokens` (ai/context-builder.ts) is used by
// other features and stays length / 4.

/**
 * Tokens per CJK character. Calibrated on the real tokenizer (context-engineering inventory, 2026-11-13): 13,000 Chinese
 * characters came to about 16,000 tokens, 1.23 per character, rounded up to 1.25 so Chinese is not under-counted. The shared
 * `estimateTokens` (length / 4) counted the same text as 3,250 tokens, about 5x too few.
 */
export const MAP_CHAT_CJK_TOKENS_PER_CHAR = 1.25;
/** Han (with extensions and compatibility ideographs), kana, Hangul, CJK punctuation and full-width forms: about one token or more each. */
const CJK_CHARS =
  /[\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3190-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]|[\u{20000}-\u{3134f}]/gu;
/**
 * Map chat's own token estimate (the shared `estimateTokens` is used by other features and stays length / 4): CJK characters at
 * {@link MAP_CHAT_CJK_TOKENS_PER_CHAR} each, every other UTF-16 unit at 1/4. Never below `estimateTokens` of the same text.
 */
export function estimateMapChatTokens(text: string): number {
  let cjk = 0;
  let cjkUnits = 0;
  for (const match of text.matchAll(CJK_CHARS)) {
    cjk += 1;
    cjkUnits += match[0].length;
  }
  return Math.ceil(cjk * MAP_CHAT_CJK_TOKENS_PER_CHAR + (text.length - cjkUnits) / 4);
}
