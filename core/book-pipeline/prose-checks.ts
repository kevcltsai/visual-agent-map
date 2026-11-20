/**
 * The three whole-book checks the proofread adds to every chapter's own checklist (person names as the chapter titles spell them,
 * no research or process voice, no re-teaching of what another chapter covers), and the two of them a program can see without a
 * model: research-voice phrases and a person name spelled differently from a chapter title. A program hit makes the item unmet
 * whatever the model said; the model can still find more. Pure.
 */
import type { ChecklistItem } from "./plan-text";
import { BOOK_CHECK_IDS, proofVerdict, type ProofResult } from "./proof";

/** The added items, appended to the chapter's checklist for the proofread only (the Prompt and the proof key keep the plan's own list). */
export const BOOK_CHECKS: readonly ChecklistItem[] = [
  {
    id: BOOK_CHECK_IDS.names,
    type: "structure",
    text: "Every person who is the title of a chapter in the chapter list is written exactly as that chapter title spells the name (same transliteration, every time)."
  },
  {
    id: BOOK_CHECK_IDS.voice,
    type: "structure",
    text: "The chapter reads as a finished book: no research or process voice (no mention of searches, search results, what was or was not found, or what a source or this research could not confirm)."
  },
  {
    id: BOOK_CHECK_IDS.repeat,
    type: "structure",
    text: "The chapter does not re-teach at length an explanation, exercise or diagram that another chapter's covers line says that chapter covers; a short reference is fine."
  }
];

/** Research-voice phrases (Traditional and Simplified Chinese, English); matched case-insensitively in the chapter text. */
export const RESEARCH_VOICE_PHRASES: readonly string[] = [
  "本次搜尋",
  "本次檢索",
  "這次搜尋",
  "搜尋未取得",
  "搜尋未找到",
  "搜尋結果",
  "檢索結果",
  "未能檢索",
  "根據搜尋",
  "本次研究未",
  "本次搜索",
  "本次检索",
  "这次搜索",
  "搜索未取得",
  "搜索未找到",
  "搜索结果",
  "检索结果",
  "根据搜索",
  "my search",
  "search results",
  "based on my research",
  "i could not find",
  "i was unable to find",
  "this research could not"
];

/**
 * Research-voice patterns beyond the fixed phrases: a "data is insufficient" note about this book's own material, "not found" in a
 * search sense, this search/query/research. A bare 資料不足 is left alone (「當時資料不足，天文學家誤判」 is history, not process voice):
 * it needs a qualifier that points at the writer's own material (現有, 目前, 手邊, 本次…) or the label form 「資料不足：」.
 */
export const RESEARCH_VOICE_PATTERNS: readonly RegExp[] = [
  /(?:現有|目前|現階段|手邊|可得|可用|本次|這次|此次|现有|现阶段|手边|这次)的?(?:資料|資訊|文獻|资料|资讯|信息|数据|文献)仍?不足/gu,
  /(?:資料|資訊|资料|资讯|信息)不足[：:]/gu,
  /本次(?:搜尋|查詢|研究|檢索|搜索|查询|检索)/gu,
  /這次(?:搜尋|查詢|檢索)|这次(?:搜索|查询|检索)/gu,
  /未能?查(?:到|得|詢到|询到)/gu,
  /沒有?查到|没有?查到/gu,
  /查無|查无/gu,
  /\bno (?:data|information|sources?|results?|records?) (?:was |were )?found\b/gu,
  /\b(?:available|existing|current) (?:data|information|sources?) (?:is|are|was|were) insufficient\b/gu,
  /\b(?:i|we) (?:did not|didn't|could not|couldn't|was unable to|were unable to) find\b/gu,
  /\b(?:this|my|our) (?:search|query|lookup)\b/gu
];

/** The research-voice phrases the text holds, in list order, each once; then what the patterns matched (each text once, not one already listed). */
export function researchVoiceHits(body: string): string[] {
  const text = body.toLowerCase();
  const hits = RESEARCH_VOICE_PHRASES.filter(phrase => text.includes(phrase));
  for (const pattern of RESEARCH_VOICE_PATTERNS)
    for (const match of text.matchAll(pattern)) {
      const found = match[0];
      if (!hits.some(hit => hit.includes(found) || found.includes(hit))) hits.push(found);
    }
  return hits;
}

const DOT = /[・·•‧･]/gu;
const HAN_NAME = /^[\p{Script=Han}\-－‐]+(?:・[\p{Script=Han}\-－‐]+)+$/u;
const HAN_RUN = /[\p{Script=Han}\-－‐]+(?:・[\p{Script=Han}\-－‐]+)+/gu;
const sameDots = (text: string): string => text.replace(DOT, "・");

/** Characters that end a word of prose before a name (攝影師, 和, 的): dropped from the front of a variant cut to the title's length. */
const PROSE_LEAD = new Set(Array.from("的和與及跟是在由位師家者了被把讓將對"));
const proseTrimmed = (part: string): string => {
  const chars = Array.from(part);
  while (chars.length > 1 && PROSE_LEAD.has(chars[0])) chars.shift();
  return chars.join("");
};

export interface NameVariant {
  /** The spelling in the chapter text (cut to the title's part length, a leading prose character such as 師 or 的 dropped; it may still carry a neighbouring character). */
  variant: string;
  /** The chapter title, the authoritative spelling. */
  title: string;
}

/**
 * Person names written with a middle dot (`名・姓`, Chinese transliterations only) that share the family name of a chapter title but
 * spell the given name differently: `桃樂絲・蘭格` against the chapter `多蘿西婭・蘭格`. A different middle dot is not a difference. A shared
 * given name is not checked (many people share 羅伯特 or 亨利). A name with no dot (`卡什` for `卡許`) is beyond this check (the model's
 * item covers it); two real people sharing a family name are a known false hit, and the redo note asks only for the title's spelling.
 */
export function nameVariantHits(body: string, titles: readonly string[]): NameVariant[] {
  const hits: NameVariant[] = [];
  const seen = new Set<string>();
  const runs = sameDots(body).match(HAN_RUN) ?? [];
  for (const raw of titles) {
    const title = sameDots(raw.trim());
    if (!HAN_NAME.test(title)) continue;
    const parts = title.split("・");
    const given = parts[parts.length - 2];
    const family = parts[parts.length - 1];
    for (const run of runs) {
      const found = run.split("・");
      for (let i = 0; i + 1 < found.length; i++) {
        const left = found[i];
        const right = found[i + 1];
        // Same family name, other given name: compare the end of the left part (prose may run into it).
        if (!right.startsWith(family) || left.endsWith(given)) continue;
        const variant = `${proseTrimmed(left.slice(-given.length))}・${family}`;
        if (seen.has(variant)) continue;
        seen.add(variant);
        hits.push({ variant, title: raw.trim() });
      }
    }
  }
  return hits;
}

const MAX_NOTE_ITEMS = 4;
/**
 * The proof result with the program's own findings applied: a research-voice phrase makes V1 unmet, a name variant makes N1 unmet,
 * each with a note naming what to change; the verdict is judged again. Items the program finds nothing for keep the model's result.
 */
export function applyProseChecks(result: ProofResult, body: string, titles: readonly string[]): ProofResult {
  const voice = researchVoiceHits(body).slice(0, MAX_NOTE_ITEMS);
  const names = nameVariantHits(body, titles).slice(0, MAX_NOTE_ITEMS);
  if (!voice.length && !names.length) return result;
  const items = result.items.map(item => {
    if (item.id === BOOK_CHECK_IDS.voice && voice.length)
      return {
        ...item,
        status: "unmet" as const,
        note: `Remove the research or process wording: ${voice.map(phrase => `「${phrase}」`).join(" ")}`
      };
    if (item.id === BOOK_CHECK_IDS.names && names.length)
      return {
        ...item,
        status: "unmet" as const,
        note: `Write the names as the chapter titles do: ${names.map(hit => `「${hit.variant}」→「${hit.title}」`).join(" ")}`
      };
    return item;
  });
  const next: ProofResult = { ...result, items };
  return { ...next, aggregate: proofVerdict(next) };
}
