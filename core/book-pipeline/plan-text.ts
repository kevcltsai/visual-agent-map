/**
 * The text the plan steps write into notes, composed by program from validated fields (never raw model text) and parsed
 * back: the root's `## 全書企劃` section (thread, editorial decisions, material register) and a card's `## Prompt` body
 * (labelled lines plus an acceptance checklist whose items carry a stable id and a type). Pure.
 */
import { instructionLanguageOf, type ContentLanguage } from "../../i18n";
import { composeCoverLine, parseCoverLine, type CoverPlan } from "./cover";
import { cleanSearchTerms, cleanSlotText, MAX_IMAGE_SLOTS, type ImageSlot } from "./image-slots";
import { BOOK_ROLES, BOOK_SETTING_FIELDS, type BookRole, type BookSettings } from "./model";
import { demoteHeadings, escapeMarkdownText, singleLine, unescapeMarkdownText } from "./text";
import { isPlaceholder } from "../note-placeholder";
import type { CardKind } from "./structure";

type Words = { zh: string; en: string };
const pick = (words: Words, language: ContentLanguage): string =>
  instructionLanguageOf(language) === "zh" ? words.zh : words.en;
const matches = (words: Words, value: string): boolean => value === words.zh || value === words.en;

export type ChecklistType = "structure" | "fact";
export interface ChecklistItem {
  /** `C1`, `C2`, ...: assigned by the program in order, stored in the Prompt, stable until the card is planned again. */
  id: string;
  type: ChecklistType;
  text: string;
}

const ROLE_WORDS: Record<BookRole, Words> = {
  intro: { zh: "導讀", en: "Intro" },
  body: { zh: "本文", en: "Body" },
  gallery: { zh: "素材導覽", en: "Gallery" },
  closing: { zh: "收尾", en: "Closing" }
};
const TYPE_WORDS: Record<ChecklistType, Words> = {
  structure: { zh: "結構型", en: "structure" },
  fact: { zh: "事實型", en: "fact" }
};
const SETTING_WORDS: Record<(typeof BOOK_SETTING_FIELDS)[number], Words> = {
  reader: { zh: "讀者", en: "Reader" },
  goal: { zh: "目標", en: "Goal" },
  angle: { zh: "切入角度", en: "Angle" },
  tone: { zh: "語氣", en: "Tone" },
  length: { zh: "篇幅", en: "Length" },
  style: { zh: "風格", en: "Style" }
};
/** The neighbour labels by what the card is: chapters (and the preface) meet chapters, sections meet sections. `old` is the label of Prompts planned before sections existed. */
const NEIGHBOUR_WORDS = {
  chapter: {
    previous: { zh: "上一章", en: "Previous chapter" },
    next: { zh: "下一章", en: "Next chapter" }
  },
  section: {
    parent: { zh: "所屬章", en: "Chapter" },
    previous: { zh: "前一節", en: "Previous section" },
    next: { zh: "後一節", en: "Next section" }
  },
  old: {
    previous: { zh: "前一張", en: "Previous card" },
    next: { zh: "後一張", en: "Next card" }
  }
} satisfies Record<string, Partial<Record<NeighbourKey, Words>>>;
export type NeighbourKey = "previous" | "next" | "parent";
/** Every label a line of this key may carry (new and old). */
const labelsOf = (key: NeighbourKey): Words[] =>
  [
    (NEIGHBOUR_WORDS.chapter as Partial<Record<NeighbourKey, Words>>)[key],
    (NEIGHBOUR_WORDS.section as Partial<Record<NeighbourKey, Words>>)[key],
    (NEIGHBOUR_WORDS.old as Partial<Record<NeighbourKey, Words>>)[key]
  ].filter((w): w is Words => !!w);
const labelFor = (kind: CardKind | undefined, key: NeighbourKey): Words =>
  (kind === "section"
    ? (NEIGHBOUR_WORDS.section as Partial<Record<NeighbourKey, Words>>)[key]
    : (NEIGHBOUR_WORDS.chapter as Partial<Record<NeighbourKey, Words>>)[key]) ?? NEIGHBOUR_WORDS.old.next;
const PREFACE_WORDS: Words = { zh: "前言", en: "Preface" };
const L = {
  role: { zh: "角色", en: "Role" },
  covers: { zh: "本章會講", en: "This chapter covers" },
  entry: { zh: "接入點", en: "Entry point" },
  handoff: { zh: "留給下一張的問題", en: "Question left for the next card" },
  points: { zh: "內容標題", en: "Content headings" },
  checklist: { zh: "驗收清單", en: "Acceptance checklist" },
  images: { zh: "圖安排", en: "Image plan" },
  imageSlot: { zh: "圖位", en: "Image slot" },
  position: { zh: "位置", en: "Position" },
  search: { zh: "英文搜尋詞", en: "Search terms" },
  none: { zh: "無", en: "none" },
  plan: { zh: "全書企劃", en: "Book plan" },
  thread: { zh: "全書主線", en: "Book thread" },
  structure: { zh: "全書結構", en: "Book structure" },
  decisions: { zh: "編輯決定", en: "Editorial decisions" },
  materials: { zh: "素材登記表", en: "Material register" }
} satisfies Record<string, Words>;

/** One safe line of model text for a note: one line, no heading, and no Markdown/Obsidian syntax that could take effect. */
const safe = (value: unknown, max = 400): string => escapeMarkdownText(singleLine(value, max), max);

/** A neighbour's one-sentence description: a model's literal `null` / `undefined` or the "no conclusion yet" placeholder says nothing, so it is blank. */
const neighbourSentence = (value: unknown): string => {
  const text = safe(value, 240);
  return /^(?:null|undefined)$/i.test(text.trim()) || isPlaceholder(text.trim()) ? "" : text;
};

const colon = (language: ContentLanguage): string => (instructionLanguageOf(language) === "zh" ? "：" : ": ");

/** A neighbour line's card: a chapter (number, or the preface) with a sentence, or a section (no number). */
export interface NeighbourCard {
  position?: number | "preface";
  title: string;
  summary: string;
}
export interface CardPlanText {
  role: BookRole;
  /** What the card is: decides the neighbour labels. Absent = a chapter. */
  kind?: CardKind;
  covers: string;
  /** The card's 3 to 6 content headings. Absent (a card planned before they existed) = no line is written. */
  points?: readonly string[];
  entry: string;
  handoff: string;
  /** One sentence about the neighbour (empty when there is none). */
  previous?: NeighbourCard;
  next?: NeighbourCard;
  /** A section's chapter (a section only). */
  parent?: { position: number; title: string };
  checklist: readonly ChecklistItem[];
  /** The card's image plan (0 to 8 slots). Absent = no image plan line is written (a card planned before the image plan existed). */
  images?: readonly ImageSlot[];
  /** The card's cover ask (`封面要找：…｜英文搜尋詞：…`). Absent = no cover line is written (a card planned before covers existed). */
  cover?: CoverPlan;
}

const SLOT_SEPARATOR = "｜";
const TERM_SEPARATOR = ", ";
const searchPart = (slot: ImageSlot, language: ContentLanguage): string => {
  const terms = cleanSearchTerms(slot.search ?? []);
  return terms.length
    ? `${SLOT_SEPARATOR}${pick(L.search, language)}${colon(language)}${terms.map(term => safe(term, 80)).join(TERM_SEPARATOR)}`
    : "";
};
/**
 * The image plan lines: `圖安排：` then one `- 圖位 n｜類型｜要說明的事｜位置：…｜英文搜尋詞：a, b` line per slot (the search part only when
 * the slot has terms); `圖安排：無` when the planner arranged none.
 */
export function composeImageSlots(images: readonly ImageSlot[], language: ContentLanguage): string[] {
  const c = colon(language);
  const head = pick(L.images, language);
  if (!images.length) return [`${head}${c}${pick(L.none, language)}`];
  return [
    `${head}${c.trim()}`,
    ...images
      .slice(0, MAX_IMAGE_SLOTS)
      .map(
        (slot, at) =>
          `- ${pick(L.imageSlot, language)} ${at + 1}${SLOT_SEPARATOR}${safe(cleanSlotText(slot.kind, 40), 40)}${SLOT_SEPARATOR}${safe(cleanSlotText(slot.explains, 200), 200)}${SLOT_SEPARATOR}${pick(L.position, language)}${c}${safe(cleanSlotText(slot.anchor, 120), 120)}${searchPart(slot, language)}`
      )
  ];
}

/** The cover ask with model text made safe for a note line (the same escape every Prompt line gets); {@link parseCardCover} undoes it. */
const coverForNote = (cover: CoverPlan): CoverPlan => ({
  explains: safe(cleanSlotText(cover.explains, 200), 200),
  search: cleanSearchTerms(cover.search).map(term => safe(term, 80))
});

/**
 * The card's cover ask (the `封面要找：…` line, placed before the image plan so it is never a slot line). `undefined` = the Prompt has none:
 * the card is from before covers existed (or the owner took the line out), so no cover is searched for and none is written.
 */
export function parseCardCover(prompt: string): CoverPlan | undefined {
  for (const line of prompt.split(/\r?\n/)) {
    const plan = parseCoverLine(line);
    if (plan)
      return {
        explains: unescapeMarkdownText(plan.explains),
        search: cleanSearchTerms(plan.search.map(term => unescapeMarkdownText(term)))
      };
  }
  return undefined;
}

const POINT_SEPARATOR = " · ";
/** The content headings as one line `a · b · c` (a `·` inside a heading is written `・`, so the line splits back exactly). */
const pointsText = (points: readonly string[]): string =>
  points
    .map(point => safe(point, 40).replace(/·/g, "・"))
    .filter(Boolean)
    .join(POINT_SEPARATOR);
/** The text after a neighbour label: `(3) Title — sentence` for a chapter, `(前言) Title — sentence` for the preface, `Title — sentence` for a section. */
function neighbourText(n: NeighbourCard, language: "zh" | "en"): string {
  const where = n.position === undefined ? "" : `(${n.position === "preface" ? PREFACE_WORDS[language] : n.position}) `;
  const sentence = neighbourSentence(n.summary);
  return `${where}${safe(n.title, 120)}${sentence ? ` — ${sentence}` : ""}`;
}

/** The card's `## Prompt` body. Every field is one line, so no model text can start a heading. */
export function composeCardPrompt(plan: CardPlanText, language: ContentLanguage): string {
  const c = colon(language);
  const neighbour = (key: NeighbourKey, n: NeighbourCard | undefined): string =>
    `${pick(labelFor(plan.kind, key), language)}${c}${n ? neighbourText(n, instructionLanguageOf(language)) : pick(L.none, language)}`;
  const lines = [
    `${pick(L.role, language)}${c}${pick(ROLE_WORDS[plan.role], language)}`,
    `${pick(L.covers, language)}${c}${safe(plan.covers)}`,
    ...(plan.points?.length ? [`${pick(L.points, language)}${c}${pointsText(plan.points)}`] : []),
    `${pick(L.entry, language)}${c}${safe(plan.entry)}`,
    `${pick(L.handoff, language)}${c}${safe(plan.handoff)}`,
    ...(plan.kind === "section"
      ? [
          `${pick(labelFor("section", "parent"), language)}${c}${plan.parent ? `(${plan.parent.position}) ${safe(plan.parent.title, 120)}` : pick(L.none, language)}`
        ]
      : []),
    neighbour("previous", plan.previous),
    neighbour("next", plan.next),
    ...(plan.cover ? [composeCoverLine(coverForNote(plan.cover), instructionLanguageOf(language))] : []),
    ...(plan.images ? composeImageSlots(plan.images, language) : []),
    `${pick(L.checklist, language)}${c.trim()}`,
    ...plan.checklist.map(item => `- ${item.id} [${pick(TYPE_WORDS[item.type], language)}] ${safe(item.text)}`)
  ];
  return demoteHeadings(lines.join("\n"));
}

const CHECK_LINE = /^[-*]\s+(C\d+)\s+\[([^\]]+)\]\s+(.+?)\s*$/;
/** The acceptance checklist of a Prompt body (the owner may have edited it); lines that are not items are skipped. */
export function parseChecklist(prompt: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (const line of prompt.split(/\r?\n/)) {
    const m = CHECK_LINE.exec(line);
    if (!m) continue;
    const type = (Object.keys(TYPE_WORDS) as ChecklistType[]).find(key => matches(TYPE_WORDS[key], m[2].trim()));
    if (type) items.push({ id: m[1], type, text: unescapeMarkdownText(m[3]) });
  }
  return items;
}

const IMAGES_HEAD = /^(\S[^:：]*)[:：]\s*(.*)$/;
const SLOT_LINE = /^[-*]\s+(?:圖位|Image slot)\s+(\d+)\s*｜(.*)$/;
/**
 * The image plan of a Prompt body (the owner may have edited it). `undefined` = the Prompt has no image plan line (an older card):
 * the pipeline then searches for no picture, leaves no marker and keeps the card's pictures. `[]` = the planner arranged none.
 * Lines that are not valid slot lines end the list; a repeated or non-positive index is skipped; at most 8 slots.
 */
export function parseImageSlots(prompt: string): ImageSlot[] | undefined {
  const lines = prompt.split(/\r?\n/);
  const at = lines.findIndex(line => {
    const m = IMAGES_HEAD.exec(line);
    return !!m && matches(L.images, m[1].trim());
  });
  if (at < 0) return undefined;
  const slots: ImageSlot[] = [];
  for (const line of lines.slice(at + 1)) {
    const m = SLOT_LINE.exec(line);
    if (!m) break;
    const index = Number(m[1]);
    const parts = m[2].split(SLOT_SEPARATOR);
    // The optional last part `英文搜尋詞：a, b` (a slot planned before search terms existed has none).
    const tail = /^([^:：]*)[:：]\s*(.*)$/.exec(parts[parts.length - 1] ?? "");
    const search = tail && matches(L.search, tail[1].trim()) ? tail[2] : undefined;
    if (search !== undefined) parts.pop();
    if (parts.length < 3 || index < 1 || slots.some(slot => slot.index === index) || slots.length >= MAX_IMAGE_SLOTS)
      continue;
    const place = /^[^:：]*[:：]\s*(.*)$/.exec(parts[parts.length - 1]);
    if (!place) continue;
    const terms = search === undefined ? [] : cleanSearchTerms(unescapeMarkdownText(search).split(","));
    slots.push({
      index,
      kind: unescapeMarkdownText(parts[0].trim()),
      explains: unescapeMarkdownText(parts.slice(1, -1).join(SLOT_SEPARATOR).trim()),
      anchor: unescapeMarkdownText(place[1].trim()),
      ...(terms.length ? { search: terms } : {})
    });
  }
  return slots;
}

/** The labelled lines of a Prompt body for the gate panel; a label it cannot find is absent (the panel shows the raw lines then). `previous`, `next` and `parent` accept the old and the new labels. */
export function parseCardPrompt(
  prompt: string
): Partial<Record<"role" | "covers" | "entry" | "handoff" | NeighbourKey, string>> {
  const out: Partial<Record<"role" | "covers" | "entry" | "handoff" | NeighbourKey, string>> = {};
  const fields: Record<string, Words[]> = {
    role: [L.role],
    covers: [L.covers],
    entry: [L.entry],
    handoff: [L.handoff],
    previous: labelsOf("previous"),
    next: labelsOf("next"),
    parent: labelsOf("parent")
  };
  for (const line of prompt.split(/\r?\n/)) {
    const m = /^([^:：]+)[:：]\s*(.*)$/.exec(line);
    if (!m) continue;
    const label = m[1].trim();
    for (const [key, words] of Object.entries(fields))
      if (words.some(w => matches(w, label)) && out[key as keyof typeof out] === undefined)
        out[key as keyof typeof out] = unescapeMarkdownText(m[2].trim());
  }
  return out;
}

/** The card's content headings (the `內容標題：a · b · c` line); undefined when the Prompt has none (planned before they existed). */
export function parseCardPoints(prompt: string): string[] | undefined {
  for (const line of prompt.split(/\r?\n/)) {
    const m = /^([^:：]+)[:：]\s*(.*)$/.exec(line);
    if (!m || !matches(L.points, m[1].trim())) continue;
    const points = unescapeMarkdownText(m[2].trim())
      .split(/\s·\s/)
      .map(point => point.trim())
      .filter(Boolean);
    return points.length ? points : undefined;
  }
  return undefined;
}

/** The text after a neighbour label of a Prompt line, split into its position (a number or `前言` / `Preface`) and the rest. */
const LINE_POSITION = /^\(([^)]+)\) ([\s\S]*)$/;

/**
 * A card plan's neighbour line (`上一章` / `下一章` / `前一節` / `後一節` / `所屬章`, or the old `前一張` / `後一張`) rewritten to describe
 * `neighbour` (position, title and a sentence) with the label of `kind` (a chapter when absent), keeping the line's colon.
 * `null` writes the no-neighbour form. `undefined` when the Prompt has no such line (the reader took it out) or the line already says exactly this.
 */
export function rewriteNeighbourLine(
  prompt: string,
  key: NeighbourKey,
  neighbour: NeighbourCard | null,
  kind?: CardKind
): string | undefined {
  const lines = prompt.split("\n");
  const words = labelsOf(key);
  const at = lines.findIndex(line => {
    const m = /^([^:：]+)[:：]/.exec(line);
    return !!m && words.some(w => matches(w, m[1].trim()));
  });
  if (at < 0) return undefined;
  const raw = lines[at].replace(/\r$/, "");
  const colonAt = /^[^:：]+([:：])\s*/.exec(raw) as RegExpExecArray;
  const oldLabel = raw.slice(0, colonAt[0].indexOf(colonAt[1])).trim();
  // The line's own language (by its label) is kept: `null` is written as the card plan writes it, in that language.
  const english = words.some(w => w.en === oldLabel);
  const label = labelFor(kind, key);
  const language = english ? "en" : "zh";
  const head = `${label[language]}${colonAt[1]}${colonAt[0].slice(colonAt[0].indexOf(colonAt[1]) + 1)}`;
  const line = neighbour
    ? `${head}${key === "parent" ? neighbourText({ ...neighbour, summary: "" }, language) : neighbourText(neighbour, language)}`
    : `${head}${english ? L.none.en : L.none.zh}`;
  if (raw === line) return undefined;
  lines[at] = lines[at].endsWith("\r") ? `${line}\r` : line;
  return lines.join("\n");
}

/**
 * Like {@link rewriteNeighbourLine}, but leaves a line that already names `neighbour` (same position and title) alone, and keeps the
 * line's own sentence when only the position moved (a chapter before it was removed). Any other line is rewritten with `neighbour.summary`.
 * A section's line has no number. A line that is rewritten gets the label of `kind` (an old `前一張` becomes `上一章`); one left alone keeps its label.
 */
export function retargetNeighbourLine(
  prompt: string,
  key: NeighbourKey,
  neighbour: NeighbourCard | null,
  kind?: CardKind
): string | undefined {
  if (!neighbour) return rewriteNeighbourLine(prompt, key, null, kind);
  const value = parseCardPrompt(prompt)[key];
  if (value === undefined) return undefined;
  const title = unescapeMarkdownText(safe(neighbour.title, 120));
  const m = neighbour.position === undefined ? null : LINE_POSITION.exec(value);
  const body = neighbour.position === undefined ? value : m?.[2];
  const rest =
    body !== undefined && (body === title || body.startsWith(`${title} — `)) ? body.slice(title.length + 3) : undefined;
  const same = (w: string): boolean =>
    neighbour.position === undefined
      ? true
      : neighbour.position === "preface"
        ? matches(PREFACE_WORDS, w)
        : w === String(neighbour.position);
  if (rest !== undefined && (neighbour.position === undefined || (m && same(m[1].trim())))) return undefined;
  return rewriteNeighbourLine(prompt, key, rest === undefined ? neighbour : { ...neighbour, summary: rest }, kind);
}

/**
 * The card plan's `接入點` line taken out when it names one of `titles` (chapters removed from the book): it describes a join that is no
 * longer there. `undefined` when there is no such line or it names none of them. A title shorter than two characters is not looked for.
 */
export function dropEntryNaming(prompt: string, titles: readonly string[]): string | undefined {
  const value = parseCardPrompt(prompt).entry;
  if (value === undefined) return undefined;
  if (!titles.some(title => Array.from(title.trim()).length >= 2 && value.includes(title.trim()))) return undefined;
  return dropEntryLine(prompt);
}

/**
 * The title a card plan's neighbour line names (`(3) Title — sentence`, `(前言) Title`, a section's `Title — sentence`, the old `前一張` line too);
 * undefined when absent or in the no-neighbour form. `kind` says whether the line has a number (a section's previous / next has none).
 */
export function neighbourLineTitle(prompt: string, key: NeighbourKey, kind?: CardKind): string | undefined {
  const value = parseCardPrompt(prompt)[key];
  if (value === undefined) return undefined;
  // A leading `(position) ` is dropped whatever the kind: an old `前一張：(3) X — s` line read for a section still has it.
  const title = value
    .replace(/^\([^)]+\) /, "")
    .split(" — ")[0]
    .trim();
  return title && !matches(L.none, title) ? title : undefined;
}

/** The prompt without its `所屬章` line (a card that is no longer a section); `undefined` when it has none. */
export function dropParentLine(prompt: string): string | undefined {
  const lines = prompt.split("\n");
  const words = labelsOf("parent");
  const at = lines.findIndex(line => {
    const m = /^([^:：]+)[:：]/.exec(line);
    return !!m && words.some(w => matches(w, m[1].trim()));
  });
  if (at < 0) return undefined;
  lines.splice(at, 1);
  return lines.join("\n");
}

/** The prompt without its `接入點` line; `undefined` when it has none. */
export function dropEntryLine(prompt: string): string | undefined {
  const lines = prompt.split("\n");
  const at = lines.findIndex(line => {
    const m = /^([^:：]+)[:：]/.exec(line);
    return !!m && matches(L.entry, m[1].trim());
  });
  if (at < 0) return undefined;
  lines.splice(at, 1);
  return lines.join("\n");
}

export function parseRoleWord(word: string): BookRole | undefined {
  return BOOK_ROLES.find(role => matches(ROLE_WORDS[role], word.trim()) || word.trim().toLowerCase() === role);
}

/** Whether a `###` heading text is the (no longer written) book structure part's, which an older root may still hold (either language). */
export const isBookStructureTitle = (title: string): boolean => matches(L.structure, title.trim());

export interface BookPlanText {
  thread: string;
  /** Only the fields the owner left empty. */
  decisions: BookSettings;
  materials: readonly { name: string; use: string }[];
}

/** The root's `## 全書企劃` section as composed (the pipeline stores its body in a hidden callout, see `replaceBookPlanSection`), ending with a newline. Sub-headings are `###`, so the section stays one section. */
export function composeBookPlan(plan: BookPlanText, language: ContentLanguage): string {
  const c = colon(language);
  const decisions = BOOK_SETTING_FIELDS.filter(field => plan.decisions[field]?.trim()).map(
    field => `- ${pick(SETTING_WORDS[field], language)}${c}${safe(plan.decisions[field])}`
  );
  const materials = plan.materials.map(m => `- ${safe(m.name, 120)}${c}${safe(m.use, 240)}`);
  return [
    `## ${pick(L.plan, language)}`,
    "",
    `### ${pick(L.thread, language)}`,
    safe(plan.thread, 1200),
    "",
    `### ${pick(L.decisions, language)}`,
    ...decisions,
    "",
    `### ${pick(L.materials, language)}`,
    ...materials,
    ""
  ].join("\n");
}

/** Whether a callout or heading title is the book plan's (either language). */
export const isBookPlanTitle = (title: string): boolean => matches(L.plan, title.trim());

/** Whether a rendered text is the (colon-less) label of a card's image plan / acceptance checklist block (either language). */
export const isImagePlanLabel = (label: string): boolean => matches(L.images, label.trim());
export const isChecklistLabel = (label: string): boolean => matches(L.checklist, label.trim());

/** The card plan fields the plan view shows under a friendlier name (Chinese notes only): the stored label stays as it is. */
export type PlanDisplayField = "entry" | "handoff" | "previous";
/** Which relabelled field a stored Chinese label (no colon) is: the entry point, the question left for the next card, the previous section or chapter. */
export function planDisplayField(label: string): PlanDisplayField | undefined {
  const word = label.trim();
  if (word === L.entry.zh) return "entry";
  if (word === L.handoff.zh) return "handoff";
  if (word === NEIGHBOUR_WORDS.section.previous.zh || word === NEIGHBOUR_WORDS.chapter.previous.zh) return "previous";
  return undefined;
}

const PLAN_CALLOUT = /^[ \t]{0,3}>[ \t]?\[!vam-book\][+-]?[ \t]+(.+?)[ \t]*$/i;
const QUOTE_PREFIX = /^[ \t]{0,3}>[ \t]?/;

/**
 * The lines of the saved book plan: the body of the pipeline's hidden callout `> [!vam-book]- 全書企劃` (quote prefix removed), else the lines after an
 * older root's `## 全書企劃` heading; undefined when there is neither. The callout wins when both exist.
 */
function planLines(markdown: string): string[] | undefined {
  const lines = markdown.split(/\r?\n/);
  const callout = lines.findIndex(line => {
    const m = PLAN_CALLOUT.exec(line);
    return !!m && isBookPlanTitle(m[1]);
  });
  if (callout >= 0) {
    const body: string[] = [];
    for (const line of lines.slice(callout + 1)) {
      if (!QUOTE_PREFIX.test(line)) break;
      body.push(line.replace(QUOTE_PREFIX, ""));
    }
    return body;
  }
  const start = lines.findIndex(line => {
    const m = /^##[ \t]+(.+?)\s*$/.exec(line);
    return !!m && matches(L.plan, m[1]);
  });
  return start < 0 ? undefined : lines.slice(start + 1);
}

/** The saved editorial decisions of a `## 全書企劃` section found anywhere in the root's body ({} when there is none). */
export function parseBookPlanDecisions(markdown: string): BookSettings {
  const plan = planLines(markdown);
  if (!plan) return {};
  const out: BookSettings = {};
  let inDecisions = false;
  for (const line of plan) {
    if (/^##(?!#)/.test(line)) break;
    const sub = /^###[ \t]+(.+?)\s*$/.exec(line);
    if (sub) {
      inDecisions = matches(L.decisions, sub[1]);
      continue;
    }
    if (!inDecisions) continue;
    const m = /^[-*]\s+([^:：]+)[:：]\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const field = BOOK_SETTING_FIELDS.find(key => matches(SETTING_WORDS[key], m[1].trim()));
    if (field && out[field] === undefined) out[field] = unescapeMarkdownText(m[2]);
  }
  return out;
}

/** The saved thread and material register of a `## 全書企劃` section found anywhere in the root's body ('' and [] when there is none). */
export function parseBookPlanBody(markdown: string): { thread: string; materials: { name: string; use: string }[] } {
  const plan = planLines(markdown);
  const thread: string[] = [];
  const materials: { name: string; use: string }[] = [];
  if (!plan) return { thread: "", materials };
  let part: "thread" | "materials" | undefined;
  for (const line of plan) {
    if (/^##(?!#)/.test(line)) break;
    const sub = /^###[ \t]+(.+?)\s*$/.exec(line);
    if (sub) {
      part = matches(L.thread, sub[1]) ? "thread" : matches(L.materials, sub[1]) ? "materials" : undefined;
      continue;
    }
    if (part === "thread" && line.trim()) thread.push(line.trim());
    if (part === "materials") {
      const m = /^[-*]\s+(.+?)[:：]\s*(.+?)\s*$/.exec(line);
      if (m) materials.push({ name: unescapeMarkdownText(m[1]), use: unescapeMarkdownText(m[2]) });
    }
  }
  return { thread: unescapeMarkdownText(thread.join(" ")), materials };
}
