/**
 * The text the plan steps write into notes, composed by program from validated fields (never raw model text) and parsed
 * back: the root's `## 全書企劃` section (thread, editorial decisions, material register) and a card's `## Prompt` body
 * (labelled lines plus an acceptance checklist whose items carry a stable id and a type). Pure.
 */
import { instructionLanguageOf, type ContentLanguage } from "../../i18n";
import { BOOK_ROLES, BOOK_SETTING_FIELDS, type BookRole, type BookSettings } from "./model";
import { demoteHeadings, singleLine } from "./text";

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
  none: { zh: "無", en: "none" },
  plan: { zh: "全書企劃", en: "Book plan" },
  thread: { zh: "全書主線", en: "Book thread" },
  decisions: { zh: "編輯決定", en: "Editorial decisions" },
  materials: { zh: "素材登記表", en: "Material register" }
} satisfies Record<string, Words>;

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
}

/** The card's `## Prompt` body. Every field is one line, so no model text can start a heading. */
export function composeCardPrompt(plan: CardPlanText, language: ContentLanguage): string {
  const c = colon(language);
  const neighbour = (label: Words, n: CardPlanText["previous"]): string =>
    n
      ? `${pick(label, language)}${c}(${n.position}) ${singleLine(n.title, 120)} — ${singleLine(n.summary, 240)}`
      : `${pick(label, language)}${c}${pick(L.none, language)}`;
  const lines = [
    `${pick(L.role, language)}${c}${pick(ROLE_WORDS[plan.role], language)}`,
    `${pick(L.covers, language)}${c}${singleLine(plan.covers)}`,
    `${pick(L.entry, language)}${c}${singleLine(plan.entry)}`,
    `${pick(L.handoff, language)}${c}${singleLine(plan.handoff)}`,
    neighbour(L.previous, plan.previous),
    neighbour(L.next, plan.next),
    `${pick(L.checklist, language)}${c.trim()}`,
    ...plan.checklist.map(item => `- ${item.id} [${pick(TYPE_WORDS[item.type], language)}] ${singleLine(item.text)}`)
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
    if (type) items.push({ id: m[1], type, text: m[3] });
  }
  return items;
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
      if (matches(L[key], label) && out[key] === undefined) out[key] = m[2].trim();
  }
  return out;
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

/** The root's `## 全書企劃` section, ending with a newline. Sub-headings are `###`, so the section stays one section. */
export function composeBookPlan(plan: BookPlanText, language: ContentLanguage): string {
  const c = colon(language);
  const decisions = BOOK_SETTING_FIELDS.filter(field => plan.decisions[field]?.trim()).map(
    field => `- ${pick(SETTING_WORDS[field], language)}${c}${singleLine(plan.decisions[field])}`
  );
  const materials = plan.materials.map(m => `- ${singleLine(m.name, 120)}${c}${singleLine(m.use, 240)}`);
  return [
    `## ${pick(L.plan, language)}`,
    "",
    `### ${pick(L.thread, language)}`,
    singleLine(plan.thread, 1200),
    "",
    `### ${pick(L.decisions, language)}`,
    ...decisions,
    "",
    `### ${pick(L.materials, language)}`,
    ...materials,
    ""
  ].join("\n");
}

/** The saved editorial decisions of a `## 全書企劃` section found anywhere in the root's body ({} when there is none). */
export function parseBookPlanDecisions(markdown: string): BookSettings {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => {
    const m = /^##[ \t]+(.+?)\s*$/.exec(line);
    return !!m && matches(L.plan, m[1]);
  });
  if (start < 0) return {};
  const out: BookSettings = {};
  let inDecisions = false;
  for (const line of lines.slice(start + 1)) {
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
    if (field && out[field] === undefined) out[field] = m[2];
  }
  return out;
}
