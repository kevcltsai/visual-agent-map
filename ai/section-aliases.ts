import { translate, type TranslationKey } from "../i18n";

/**
 * Section names of the note style structures and the table of old names (0.29.0 and earlier) that still map onto them.
 * Pure data: the parser (`note-style-file.ts`) reads it to give a section its aliases and the new sources role, so an
 * old note whose headings carry the old names still lines up with a structure that uses the new ones (sectionLookup,
 * sourcesHeadingKeys, the top write-back classifier, canonicalDetail). Structure files spell these names in zh-TW or en;
 * only the standard rows and the sources names also have a Simplified Chinese spelling (from the i18n dictionaries).
 */

export interface SectionName {
  /** Traditional Chinese (the zh-TW spelling; structure files of the zh-CN interface use it too). */
  zh: string;
  en: string;
}
const name = (zhTW: string, en: string): SectionName => ({ zh: zhTW, en });

/** The names the structures of the editorial redesign use. The structure files and the alias table below both read this. */
export const SECTION_NAME = {
  // sources role: any one of the three names; a structure uses the one that fits its type
  sources: name("來源", "Sources"),
  source: name("出處", "Source"),
  references: name("參考資料", "References"),
  // log role (unchanged name)
  log: name("更新紀錄", "Update log"),
  // atomic
  oneSentence: name("一句話", "In one sentence"),
  why: name("為什麼", "Why"),
  // hypothesis
  ifTrue: name("如果成立會看到", "If true we would see"),
  evidenceTable: name("證據對照", "Evidence table"),
  // evidence
  summary: name("摘要", "Summary"),
  relatedTopics: name("和哪些議題有關", "Related topics"),
  // conclusion
  confidence: name("信心", "Confidence"),
  scope: name("適用範圍", "Scope"),
  impact: name("影響與下一步", "Impact and next steps"),
  // action
  goalDone: name("目標與完成條件", "Goal and done-when"),
  steps: name("步驟", "Steps")
} as const;

/** The i18n keys of the standard and textbook sections that are new (the old keys stay as the old names' source). */
export const NEW_STANDARD_HEADING_KEYS: readonly TranslationKey[] = [
  "detail.background_and_mechanism",
  "detail.disagreements_and_limits",
  "detail.open_questions_to_check",
  "detail.sources_heading"
];

interface AliasRow {
  /** Current names (any spelling); a section with one of these names takes the aliases. */
  names: string[];
  /** Earlier names, and for the sources row the sibling names too. */
  aliases: string[];
}

const lowered = (value: string) => value.trim().toLocaleLowerCase();
const SPELLINGS = ["zh-TW", "zh-CN", "en"] as const;
const spellings = (key: TranslationKey): string[] => SPELLINGS.map(locale => translate(locale, key));
const both = (value: SectionName): string[] => [value.zh, value.en];

let rows: AliasRow[] | undefined;

/** The table. Built on first use, because the standard rows read the i18n dictionaries. */
export function sectionAliasRows(): readonly AliasRow[] {
  if (rows) return rows;
  const sourcesNames = [
    ...both(SECTION_NAME.sources),
    ...both(SECTION_NAME.source),
    ...both(SECTION_NAME.references),
    ...spellings("detail.sources_heading"),
    "出处",
    "参考资料"
  ];
  const legacySources = spellings("detail.evidence_and_sources");
  rows = [
    // role sources: the old standard name, and the three new names for each other
    { names: sourcesNames, aliases: [...sourcesNames, ...legacySources] },
    // standard / textbook
    { names: spellings("detail.background_and_mechanism"), aliases: spellings("detail.key_knowledge") },
    { names: spellings("detail.disagreements_and_limits"), aliases: spellings("detail.tradeoffs_and_limitations") },
    { names: spellings("detail.open_questions_to_check"), aliases: spellings("detail.open_questions") },
    // atomic
    { names: both(SECTION_NAME.oneSentence), aliases: ["定義", "Definition"] },
    { names: both(SECTION_NAME.why), aliases: ["解釋", "Explanation"] },
    // hypothesis: the old support and counterevidence sections both land on the one table
    { names: both(SECTION_NAME.ifTrue), aliases: ["預測", "Prediction"] },
    { names: both(SECTION_NAME.evidenceTable), aliases: ["支持", "反駁", "Support", "Counterevidence"] },
    // evidence
    { names: both(SECTION_NAME.summary), aliases: ["內容", "Content"] },
    { names: both(SECTION_NAME.relatedTopics), aliases: ["支持或反駁", "Supports or refutes"] },
    // conclusion
    { names: both(SECTION_NAME.confidence), aliases: ["信心程度"] },
    { names: both(SECTION_NAME.scope), aliases: ["適用範圍與限制", "Scope and limits"] },
    { names: both(SECTION_NAME.impact), aliases: ["後續行動", "Next actions"] },
    // action
    { names: both(SECTION_NAME.goalDone), aliases: ["目標", "完成條件", "Goal", "Done when"] },
    { names: both(SECTION_NAME.steps), aliases: ["檢查點", "Checkpoints"] }
  ];
  return rows;
}

/** The earlier names a section with this heading takes (case-insensitive match; the heading itself is not among them). */
export function sectionAliasesFor(heading: string): string[] {
  const key = lowered(heading);
  const result: string[] = [];
  for (const row of sectionAliasRows())
    if (row.names.some(entry => lowered(entry) === key))
      for (const alias of row.aliases)
        if (lowered(alias) !== key && !result.some(existing => lowered(existing) === lowered(alias)))
          result.push(alias);
  return result;
}

/** True for a heading that is one of the new sources names (来源, 出處, References, ...), not the old "證據與來源". */
export function isNewSourcesHeading(heading: string): boolean {
  const key = lowered(heading);
  return sectionAliasRows()[0].names.some(entry => lowered(entry) === key);
}
