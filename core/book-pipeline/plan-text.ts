/**
 * The text the plan steps write into notes, composed by program from validated fields (never raw model text) and parsed
 * back: the root's `## 全書企劃` section (thread, editorial decisions, material register) and a card's `## Prompt` body
 * (labelled lines plus an acceptance checklist whose items carry a stable id and a type). Pure.
 */
import { instructionLanguageOf, type ContentLanguage } from "../../i18n";
import { cleanSlotText, MAX_IMAGE_SLOTS, type ImageSlot } from "./image-slots";
import { BOOK_ROLES, BOOK_SETTING_FIELDS, type BookRole, type BookSettings } from "./model";
import { demoteHeadings, escapeMarkdownText, singleLine, unescapeMarkdownText } from "./text";

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
const L = {
  role: { zh: "角色", en: "Role" },
  covers: { zh: "本章會講", en: "This chapter covers" },
  entry: { zh: "接入點", en: "Entry point" },
  handoff: { zh: "留給下一張的問題", en: "Question left for the next card" },
  previous: { zh: "前一張", en: "Previous card" },
  next: { zh: "後一張", en: "Next card" },
  checklist: { zh: "驗收清單", en: "Acceptance checklist" },
  images: { zh: "圖安排", en: "Image plan" },
  imageSlot: { zh: "圖位", en: "Image slot" },
  position: { zh: "位置", en: "Position" },
  none: { zh: "無", en: "none" },
  plan: { zh: "全書企劃", en: "Book plan" },
  thread: { zh: "全書主線", en: "Book thread" },
  decisions: { zh: "編輯決定", en: "Editorial decisions" },
  materials: { zh: "素材登記表", en: "Material register" }
} satisfies Record<string, Words>;

/** One safe line of model text for a note: one line, no heading, and no Markdown/Obsidian syntax that could take effect. */
const safe = (value: unknown, max = 400): string => escapeMarkdownText(singleLine(value, max), max);

const colon = (language: ContentLanguage): string => (instructionLanguageOf(language) === "zh" ? "：" : ": ");

export interface CardPlanText {
  role: BookRole;
  covers: string;
  entry: string;
  handoff: string;
  /** One sentence about the neighbour (empty when there is none). */
  previous?: { position: number; title: string; summary: string };
  next?: { position: number; title: string; summary: string };
  checklist: readonly ChecklistItem[];
  /** The card's image plan (0 to 8 slots). Absent = no image plan line is written (a card planned before the image plan existed). */
  images?: readonly ImageSlot[];
}

const SLOT_SEPARATOR = "｜";
/** The image plan lines: `圖安排：` then one `- 圖位 n｜類型｜要說明的事｜位置：…` line per slot; `圖安排：無` when the planner arranged none. */
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
          `- ${pick(L.imageSlot, language)} ${at + 1}${SLOT_SEPARATOR}${safe(cleanSlotText(slot.kind, 40), 40)}${SLOT_SEPARATOR}${safe(cleanSlotText(slot.explains, 200), 200)}${SLOT_SEPARATOR}${pick(L.position, language)}${c}${safe(cleanSlotText(slot.anchor, 120), 120)}`
      )
  ];
}

/** The card's `## Prompt` body. Every field is one line, so no model text can start a heading. */
export function composeCardPrompt(plan: CardPlanText, language: ContentLanguage): string {
  const c = colon(language);
  const neighbour = (label: Words, n: CardPlanText["previous"]): string =>
    n
      ? `${pick(label, language)}${c}(${n.position}) ${safe(n.title, 120)}${safe(n.summary, 240) ? ` — ${safe(n.summary, 240)}` : ""}`
      : `${pick(label, language)}${c}${pick(L.none, language)}`;
  const lines = [
    `${pick(L.role, language)}${c}${pick(ROLE_WORDS[plan.role], language)}`,
    `${pick(L.covers, language)}${c}${safe(plan.covers)}`,
    `${pick(L.entry, language)}${c}${safe(plan.entry)}`,
    `${pick(L.handoff, language)}${c}${safe(plan.handoff)}`,
    neighbour(L.previous, plan.previous),
    neighbour(L.next, plan.next),
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
    if (parts.length < 3 || index < 1 || slots.some(slot => slot.index === index) || slots.length >= MAX_IMAGE_SLOTS)
      continue;
    const place = /^[^:：]*[:：]\s*(.*)$/.exec(parts[parts.length - 1]);
    if (!place) continue;
    slots.push({
      index,
      kind: unescapeMarkdownText(parts[0].trim()),
      explains: unescapeMarkdownText(parts.slice(1, -1).join(SLOT_SEPARATOR).trim()),
      anchor: unescapeMarkdownText(place[1].trim())
    });
  }
  return slots;
}

/** The labelled lines of a Prompt body for the gate panel; a label it cannot find is absent (the panel shows the raw lines then). */
export function parseCardPrompt(
  prompt: string
): Partial<Record<"role" | "covers" | "entry" | "handoff" | "previous" | "next", string>> {
  const out: Partial<Record<"role" | "covers" | "entry" | "handoff" | "previous" | "next", string>> = {};
  for (const line of prompt.split(/\r?\n/)) {
    const m = /^([^:：]+)[:：]\s*(.*)$/.exec(line);
    if (!m) continue;
    const label = m[1].trim();
    for (const key of ["role", "covers", "entry", "handoff", "previous", "next"] as const)
      if (matches(L[key], label) && out[key] === undefined) out[key] = unescapeMarkdownText(m[2].trim());
  }
  return out;
}

/**
 * A card plan's `前一張` or `後一張` line rewritten to describe `neighbour` (position, title and a sentence), keeping the line's own label
 * and colon. `null` writes the no-neighbour form. `undefined` when the Prompt has no such line (the reader took it out) or the line already says exactly this.
 */
export function rewriteNeighbourLine(
  prompt: string,
  key: "previous" | "next",
  neighbour: { position: number; title: string; summary: string } | null
): string | undefined {
  const lines = prompt.split("\n");
  const at = lines.findIndex(line => {
    const m = /^([^:：]+)[:：]/.exec(line);
    return !!m && matches(L[key], m[1].trim());
  });
  if (at < 0) return undefined;
  const head = /^([^:：]+[:：]\s*)/.exec(lines[at].replace(/\r$/, ""))?.[1] ?? "";
  // `null`: no such card (the first or last chapter), written as the card plan writes it, in the language of the line's own label.
  const english = !lines[at].startsWith(L[key].zh);
  const summary = neighbour ? safe(neighbour.summary, 240) : "";
  const line = neighbour
    ? `${head}(${neighbour.position}) ${safe(neighbour.title, 120)}${summary ? ` — ${summary}` : ""}`
    : `${head}${english ? L.none.en : L.none.zh}`;
  if (lines[at].replace(/\r$/, "") === line) return undefined;
  lines[at] = lines[at].endsWith("\r") ? `${line}\r` : line;
  return lines.join("\n");
}

export function parseRoleWord(word: string): BookRole | undefined {
  return BOOK_ROLES.find(role => matches(ROLE_WORDS[role], word.trim()) || word.trim().toLowerCase() === role);
}

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
