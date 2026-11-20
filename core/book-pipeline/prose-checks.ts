/**
 * The three whole-book checks the proofread adds to every chapter's own checklist (person names as the chapter titles spell them,
 * no research or process voice, no re-teaching of what another chapter covers), and the two of them a program can see without a
 * model: research-voice phrases and a person name spelled differently from a chapter title. A program hit makes the item unmet
 * whatever the model said; the model can still find more. Pure.
 */
import { translateNote, type ContentLanguage } from "../../i18n";
import type { BookRole } from "./model";
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
  // Live v6 (a reader-visible box): 「未找到可直接引用的來源」, 「本次未取得台灣在地權威來源」: what this research did not get, said of a source.
  /未能?(?:找到|取得|得到)[^。！？\n]{0,12}?(?:來源|来源|文獻|文献|出處|出处)/gu,
  /\bno (?:data|information|sources?|results?|records?) (?:was |were )?found\b/gu,
  /\b(?:available|existing|current) (?:data|information|sources?) (?:is|are|was|were) insufficient\b/gu,
  /\b(?:i|we) (?:did not|didn't|could not|couldn't|was unable to|were unable to) find\b/gu,
  /\b(?:this|my|our) (?:search|query|lookup)\b/gu
];

/**
 * Citation-style process voice: a fact attributed in the text to a vague source instead of being stated (the 2026-11-20 v4 run's
 * 「美國○○大學推廣單位建議」 seven times in one chapter, 「農業改良場的資料指出」, 「有資料指出」). Decision (2026-11-20, Primary): a
 * finished book states the fact and keeps the source in its Sources section, so these are flagged whether or not an institution is
 * named: 「有(些)…資料/研究/文章指出」, 「…的資料指出/顯示/提到」, 「據資料」, 「根據(現有/相關/網路…)資料」, 「推廣單位…建議」, an unnamed
 * 「研究指出」 (at a sentence or clause start, or after 有/些/項). Not flagged: a named study (「哈佛大學的研究指出」), a named record
 * (「根據氣象局資料」), 資料庫/資料夾, a bare 研究.
 */
export const VAGUE_SOURCE_PATTERNS: readonly RegExp[] = [
  /有(?:些|一些)?[^\s，。、；！？,.]{0,4}?(?:資料|资料|研究|文獻|文献|論文|论文|文章|報告|报告)(?:也|都)?(?:指出|顯示|显示|建議|建议|提到|表示|認為|认为)/gu,
  /(?:資料|资料)(?:也|則|则|都)?(?:指出|顯示|显示|提到|表示)/gu,
  /(?<![根依])據(?:資料|資訊)|(?<![根依])据(?:资料|资讯)/gu,
  /根據(?:現有|相關|網路|網上|一些|部分|手邊|可得|公開)?的?資料|根据(?:现有|相关|网络|网上|一些|部分|手边|可得|公开)?的?资料/gu,
  /推廣(?:單位|中心|部門|處)[^。！？\n]{0,12}?(?:建議|指出|提到|提醒|強調|說明|列為|給)|推广(?:单位|中心|部门|处)[^。！？\n]{0,12}?(?:建议|指出|提到|提醒|强调|说明|列为|给)/gu,
  /(?<=^|[，。；：、！？,;:\s]|有|些|項|项)研究(?:也|都)?(?:指出|顯示|显示|發現|发现)/gmu,
  // Missed in live v5 (each still a vague attribution): 「推廣單位都說過」, 「可以當作旁證」, 「不同來源給的／寫的」, 「不同來源的數字」,
  // 「依園藝資料」, 「以家庭栽培資料為準」, 「農業改良場介紹」. Not flagged: 「前一章說過」, 「不同來源的水質」, 「依資料夾」, 「以實際觀察為準」, 「改良場位於桃園」.
  /(?:單位|单位|大學|大学|機構|机构|專家|专家|學者|学者|來源|来源|網站|网站)(?:都|也|曾|都曾|也曾)?(?:說過|说过)/gu,
  /(?:當作|当作|當成|当成|作為|作为|做為|视为|視為)旁(?:證|证)/gu,
  /不同(?:的)?(?:來源|来源|資料|资料|網站|网站|文獻|文献)(?:給|给|寫|写|列|提供)的|不同(?:的)?(?:來源|来源|資料|资料|網站|网站|文獻|文献)(?:的|對|对)[^，。！？\n]{0,8}?(?:數字|数字|說法|说法|建議|建议|數據|数据|天數|天数)/gu,
  /依(?:照|據|据)?(?:園藝|园艺|栽培|家庭栽培|農業|农业|一般|相關|相关|網路|网络|公開|公开)的?(?:資料|资料)(?![庫库夾夹])/gu,
  /以[^，。！？\n]{0,6}?(?:資料|资料|來源|来源)(?:為準|为准)/gu,
  /(?:改良場|改良场|試驗所|试验所|試驗場|试验场)[^。！？\n]{0,12}?(?:建議|建议|指出|提到|提醒|強調|强调|說明|说明|介紹|介绍|說過|说过|列為|列为)/gu,
  /\b(?:some |available |existing )?sources (?:say|suggest|indicate|show)\b/gu,
  /\baccording to (?:the |some |available |existing )?(?:data|sources|information)\b/gu,
  /(?:^|[.!?]\s+|\bsome )(?:studies|research) (?:shows?|suggests?|indicates?)\b/gmu
];

const hitsOf = (
  body: string,
  phrases: readonly string[],
  patterns: readonly RegExp[],
  hits: string[] = []
): string[] => {
  const text = body.toLowerCase();
  for (const phrase of phrases) if (text.includes(phrase) && !hits.includes(phrase)) hits.push(phrase);
  for (const pattern of patterns)
    for (const match of text.matchAll(pattern)) {
      const found = match[0].replace(/^[\s.!?]+/, "");
      if (!hits.some(hit => hit.includes(found) || found.includes(hit))) hits.push(found);
    }
  return hits;
};

/** The research-voice phrases the text holds, in list order, each once; then what the patterns matched (each text once, not one already listed); then the vague-source attributions. */
export function researchVoiceHits(body: string): string[] {
  return hitsOf(body, [], VAGUE_SOURCE_PATTERNS, processVoiceHits(body));
}
/** Only the process notes (searches, what was or was not found, data insufficient), not the vague-source attributions. */
export function processVoiceHits(body: string): string[] {
  return hitsOf(body, RESEARCH_VOICE_PHRASES, RESEARCH_VOICE_PATTERNS);
}

/** The sentences of a text (Chinese and English end marks; each line apart), trimmed, empty ones left out. */
export function sentencesOf(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap(line => line.match(/[^。！？!?]*?(?:[。！？!?]+|\.(?=\s|$)|$)/gu) ?? [])
    .map(sentence => sentence.trim())
    .filter(Boolean);
}
/** The sentences that hold a research-voice hit (each once, in text order): what the fix instruction quotes so the author finds the exact passage. */
export function researchVoiceSentences(body: string): string[] {
  return sentencesOf(body).filter(sentence => researchVoiceHits(sentence).length);
}
/** A sentence that is only a process note: it holds a process hit and no number, link, picture or emphasis (nothing a reader would lose). */
export function isProcessNoteSentence(sentence: string): boolean {
  return processVoiceHits(sentence).length > 0 && !/[\p{Nd}[\]()（）*`]|https?:/u.test(sentence);
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

/** Letters and digits only (NFKC, lower case): how a chapter title is found in a heading or a sentence. */
export const titleKey = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
/**
 * The other chapter a heading names: its whole key holds a title's key, or its lead (before a colon or dash, at least two letters)
 * is part of a title's key (「土壤與容器：預告裡沒講完的小細節」 names 〈土壤與容器準備〉). Undefined when it names none.
 */
export function headingNamesChapter(heading: string, others: readonly string[]): string | undefined {
  const text = heading.replace(/^[ \t]*#{1,6}[ \t]+/, "");
  const key = titleKey(text);
  const lead = titleKey(text.split(/[:：—–]/u)[0]);
  return others.find(title => {
    const t = titleKey(title);
    return !!t && (key.includes(t) || (lead.length >= 2 && t.includes(lead)));
  });
}
/** The other chapter titles a sentence names (whole title, punctuation aside). */
export const sentenceNamesChapters = (sentence: string, others: readonly string[]): string[] => {
  const key = titleKey(sentence);
  return others.filter(title => titleKey(title) && key.includes(titleKey(title)));
};

/** The most sentences an intro may give one later chapter (owner rule 2026-11-20: a guide, one or two sentences of preview each). */
export const INTRO_PREVIEW_MAX = 2;
/**
 * The later chapters an intro previews too much: a heading of its own that names the chapter, or more than {@link INTRO_PREVIEW_MAX}
 * sentences naming its title. Topics without the title are beyond this check (the model's R1 item covers them).
 */
export function introPreviewHits(body: string, others: readonly string[]): string[] {
  const over = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^[ \t]*#{1,6}[ \t]+/.test(line)) {
      const named = headingNamesChapter(line, others);
      if (named) over.add(named);
      continue;
    }
    for (const sentence of sentencesOf(line))
      for (const title of sentenceNamesChapters(sentence, others)) counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  for (const [title, n] of counts) if (n > INTRO_PREVIEW_MAX) over.add(title);
  return others.filter(title => over.has(title));
}

const MAX_NOTE_ITEMS = 4;
/** The longest a quoted sentence in a note is (characters): enough for the author to find the passage. */
const NOTE_SENTENCE_MAX = 60;
const quoteCut = (text: string): string => {
  const chars = Array.from(text);
  return `「${chars.length > NOTE_SENTENCE_MAX ? chars.slice(0, NOTE_SENTENCE_MAX).join("") + "…" : text}」`;
};
/** What the proofread knows about the chapter besides its text: the note language, its role and its own title. */
export interface ProseCheckContext {
  language?: ContentLanguage;
  role?: BookRole;
  title?: string;
  /** The reader-visible callouts outside the chapter text (`readerCallouts`): the research-voice check reads them too. */
  readerNotes?: string;
}
/**
 * The proof result with the program's own findings applied: a research-voice sentence makes V1 unmet, a name variant makes N1 unmet,
 * an intro that previews a later chapter too much makes R1 unmet, each with a note (in the note language) naming what to change; the
 * verdict is judged again. Items the program finds nothing for keep the model's result.
 */
export function applyProseChecks(
  result: ProofResult,
  body: string,
  titles: readonly string[],
  context: ProseCheckContext = {}
): ProofResult {
  const language = context.language ?? "en";
  const voice = researchVoiceSentences(context.readerNotes ? `${body}\n\n${context.readerNotes}` : body).slice(
    0,
    MAX_NOTE_ITEMS
  );
  const names = nameVariantHits(body, titles).slice(0, MAX_NOTE_ITEMS);
  const own = titleKey(context.title ?? "");
  const previews =
    context.role === "intro"
      ? introPreviewHits(
          body,
          titles.filter(title => titleKey(title) !== own)
        )
      : [];
  if (!voice.length && !names.length && !previews.length) return result;
  const items = result.items.map(item => {
    if (item.id === BOOK_CHECK_IDS.voice && voice.length)
      return {
        ...item,
        status: "unmet" as const,
        note: translateNote(language, "detail.book_check_voice_0", voice.map(quoteCut).join(" "))
      };
    if (item.id === BOOK_CHECK_IDS.names && names.length)
      return {
        ...item,
        status: "unmet" as const,
        note: translateNote(
          language,
          "detail.book_check_names_0",
          names.map(hit => `「${hit.variant}」→「${hit.title}」`).join(" ")
        )
      };
    if (item.id === BOOK_CHECK_IDS.repeat && previews.length)
      return {
        ...item,
        status: "unmet" as const,
        note: translateNote(language, "detail.book_check_preview_0", previews.map(title => `〈${title}〉`).join(""))
      };
    return item;
  });
  const next: ProofResult = { ...result, items };
  return { ...next, aggregate: proofVerdict(next) };
}
