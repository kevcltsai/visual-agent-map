import { NOTE_LANGUAGES, translate, type NoteLanguage, type TranslationKey, type UiLanguage } from "../i18n";
import { fencedLines } from "./markdown-blocks";
import { headingsVerbatim } from "../core/steps/_shared/fragments";
import { customDetailRule, customDetailStructure, textbookDetailStructure } from "../core/steps/task/fragments";

export type DetailSectionRole = "none" | "sources" | "log";
export interface DetailCount {
  mode: "exact" | "min";
  n: number;
}
export interface DetailSection {
  id: string;
  name: string;
  description: string;
  role: DetailSectionRole;
  count?: DetailCount;
  /** Earlier names (and the other language's Standard name) so old notes still map to this section. */
  aliases: string[];
}
export interface DetailTemplate {
  id: string;
  name: string;
  sections: DetailSection[];
}
export interface TemplateIssue {
  key: TranslationKey;
  values: (string | number)[];
  /** 1-based section number the issue belongs to, when it belongs to one. */
  section?: number;
}
export interface CountIssue {
  section: string;
  mode: "exact" | "min";
  n: number;
  actual: number;
}

export const STANDARD_TEMPLATE_ID = "standard";
/** Built-in template: the Standard sections, written as an intro followed by the sections; empty sections are omitted. */
export const TEXTBOOK_TEMPLATE_ID = "textbook";
const STANDARD: readonly [string, TranslationKey, TranslationKey, DetailSectionRole][] = [
  ["core", "detail.core_conclusions", "detail.description_core_conclusions", "none"],
  ["knowledge", "detail.key_knowledge", "detail.description_key_knowledge", "none"],
  ["sources", "detail.evidence_and_sources", "detail.description_evidence_and_sources", "sources"],
  ["tradeoffs", "detail.tradeoffs_and_limitations", "detail.description_tradeoffs_and_limitations", "none"],
  ["questions", "detail.open_questions", "detail.description_open_questions", "none"],
  ["log", "detail.update_log", "detail.description_update_log", "log"]
];

/**
 * `language` is the note language: the section headings and descriptions that notes and prompts carry. `display` is the
 * interface language the template's own name is shown in (it defaults to `language`); a Simplified Chinese interface
 * shows "标准" while the headings stay Traditional Chinese.
 */
export function standardTemplate(language: NoteLanguage, display: UiLanguage = language): DetailTemplate {
  return {
    id: STANDARD_TEMPLATE_ID,
    name: translate(display, "ui.detail_template_standard"),
    sections: STANDARD.map(([id, key, descriptionKey, role]) => {
      const name = translate(language, key);
      return {
        id,
        name,
        description: translate(language, descriptionKey),
        role,
        aliases: NOTE_LANGUAGES.map(locale => translate(locale, key)).filter(alias => alias !== name)
      };
    })
  };
}

export function textbookTemplate(language: NoteLanguage, display: UiLanguage = language): DetailTemplate {
  return {
    ...standardTemplate(language, display),
    id: TEXTBOOK_TEMPLATE_ID,
    name: translate(display, "ui.detail_template_textbook")
  };
}

export function isBuiltinTemplateId(id: string | undefined): boolean {
  return id === STANDARD_TEMPLATE_ID || id === TEXTBOOK_TEMPLATE_ID;
}

/** The built-in templates, in menu order. */
export function builtinTemplates(language: NoteLanguage, display: UiLanguage = language): DetailTemplate[] {
  return [standardTemplate(language, display), textbookTemplate(language, display)];
}

export function copyTemplate(source: DetailTemplate, name: string, id: string): DetailTemplate {
  return {
    id,
    name,
    sections: source.sections.map(section => ({
      ...section,
      ...(section.count ? { count: { ...section.count } } : {}),
      aliases: [...section.aliases]
    }))
  };
}

export function sectionKeys(section: DetailSection): string[] {
  return [section.name, ...section.aliases].map(value => value.trim().toLocaleLowerCase()).filter(Boolean);
}

const headingKey = (value: string) => value.trim().toLocaleLowerCase();

/**
 * Maps a lower-cased `###` heading to its template section index. A section's current name always wins over another
 * section's alias, so aliases are registered first and names last.
 */
export function sectionLookup(template: DetailTemplate): Map<string, number> {
  const lookup = new Map<string, number>();
  template.sections.forEach((section, index) =>
    section.aliases.map(headingKey).forEach(key => key && lookup.set(key, index))
  );
  template.sections.forEach((section, index) => {
    const key = headingKey(section.name);
    if (key) lookup.set(key, index);
  });
  return lookup;
}

/** The lower-cased headings that resolve to the template's sources section (see sectionLookup). */
export function sourcesHeadingKeys(template: DetailTemplate): Set<string> {
  const index = template.sections.findIndex(section => section.role === "sources");
  return new Set([...sectionLookup(template)].filter(([, target]) => target === index).map(([key]) => key));
}

/** Drops aliases that equal any section's current name (case-insensitive); keeps the first of duplicate aliases. */
export function withoutConflictingAliases(sections: DetailSection[]): DetailSection[] {
  const names = new Set(sections.map(section => headingKey(section.name)));
  return sections.map(section => {
    const aliases: string[] = [];
    for (const alias of section.aliases)
      if (
        alias.trim() &&
        !names.has(headingKey(alias)) &&
        !aliases.some(existing => headingKey(existing) === headingKey(alias))
      )
        aliases.push(alias);
    return { ...section, aliases };
  });
}

export function validateTemplate(template: DetailTemplate, others: DetailTemplate[]): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const name = template.name.trim();
  if (!name) issues.push({ key: "ui.detail_template_error_name_required", values: [] });
  else if (name.length > 40) issues.push({ key: "ui.detail_template_error_name_long", values: [] });
  else if (
    others.some(other => other.id !== template.id && other.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())
  )
    issues.push({ key: "ui.detail_template_error_name_taken", values: [name] });
  if (template.sections.length < 1 || template.sections.length > 12)
    issues.push({ key: "ui.detail_template_error_section_count", values: [] });
  const seen = new Set<string>();
  template.sections.forEach((section, index) => {
    const number = index + 1;
    const sectionName = section.name.trim();
    if (!sectionName)
      issues.push({ key: "ui.detail_template_error_section_name_required", values: [number], section: number });
    else if (/[#\r\n]/.test(section.name))
      issues.push({ key: "ui.detail_template_error_section_name_invalid", values: [number], section: number });
    else if (sectionName.length > 40)
      issues.push({ key: "ui.detail_template_error_section_name_long", values: [number], section: number });
    else if (seen.has(sectionName.toLocaleLowerCase()))
      issues.push({ key: "ui.detail_template_error_section_name_taken", values: [number], section: number });
    seen.add(sectionName.toLocaleLowerCase());
    if (section.description.length > 300)
      issues.push({ key: "ui.detail_template_error_description_long", values: [number], section: number });
    if (section.count && (!Number.isInteger(section.count.n) || section.count.n < 1 || section.count.n > 20))
      issues.push({ key: "ui.detail_template_error_count_range", values: [number], section: number });
  });
  for (const role of ["sources", "log"] as const)
    if (template.sections.filter(section => section.role === role).length > 1)
      issues.push({
        key: "ui.detail_template_error_role_taken",
        values: [role === "sources" ? "ui.detail_template_role_sources" : "ui.detail_template_role_log"]
      });
  return issues;
}

function section(value: unknown): DetailSection | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<DetailSection>;
  if (typeof item.id !== "string" || typeof item.name !== "string") return null;
  const role: DetailSectionRole = item.role === "sources" || item.role === "log" ? item.role : "none";
  const count =
    item.count && (item.count.mode === "exact" || item.count.mode === "min") && typeof item.count.n === "number"
      ? { mode: item.count.mode, n: item.count.n }
      : undefined;
  return {
    id: item.id,
    name: item.name,
    description: typeof item.description === "string" ? item.description : "",
    role,
    ...(count ? { count } : {}),
    aliases: Array.isArray(item.aliases)
      ? item.aliases.filter((alias): alias is string => typeof alias === "string")
      : []
  };
}

export function normalizeTemplates(value: unknown): DetailTemplate[] {
  if (!Array.isArray(value)) return [];
  const result: DetailTemplate[] = [];
  const taken = new Set<string>(
    value.flatMap(entry => {
      const id = entry && typeof entry === "object" ? (entry as Partial<DetailTemplate>).id : undefined;
      return typeof id === "string" ? [id] : [];
    })
  );
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Partial<DetailTemplate>;
    if (typeof item.id !== "string" || item.id === STANDARD_TEMPLATE_ID || typeof item.name !== "string") continue;
    if (result.some(existing => existing.id === item.id)) continue;
    let id = item.id;
    // A custom template saved under the built-in Textbook id keeps its content under a new id.
    if (id === TEXTBOOK_TEMPLATE_ID) {
      id = `custom-${TEXTBOOK_TEMPLATE_ID}`;
      for (let n = 2; taken.has(id) || result.some(existing => existing.id === id); n++)
        id = `custom-${TEXTBOOK_TEMPLATE_ID}-${n}`;
    }
    if (!Array.isArray(item.sections)) continue;
    const sections = item.sections.map(section);
    if (sections.some(entry => !entry)) continue;
    const template = { id, name: item.name, sections: withoutConflictingAliases(sections as DetailSection[]) };
    if (validateTemplate(template, result).length) continue;
    result.push(template);
  }
  return result;
}

export function resolveTemplate(
  templates: DetailTemplate[],
  ids: (string | undefined)[],
  language: NoteLanguage
): { template: DetailTemplate; missing: string[] } {
  const missing: string[] = [];
  for (const id of ids) {
    if (!id) continue;
    if (id === STANDARD_TEMPLATE_ID) return { template: standardTemplate(language), missing };
    if (id === TEXTBOOK_TEMPLATE_ID) return { template: textbookTemplate(language), missing };
    const found = templates.find(template => template.id === id);
    if (found) return { template: found, missing };
    missing.push(id);
  }
  return { template: standardTemplate(language), missing };
}

export function countItems(body: string): number {
  const lines = body.split("\n");
  const code = fencedLines(lines);
  const outside = lines.filter((_, index) => !code[index]);
  const headings = outside.filter(line => /^####\s+\S/.test(line)).length;
  if (headings) return headings;
  return outside.filter(line => /^(?:[-*+]|\d+[.)])\s+\S/.test(line)).length;
}

/** Splits a detail into section bodies keyed by template section index (by name or alias); other text is ignored. */
function sectionBodies(detail: string, template: DetailTemplate): Map<number, string> {
  const lookup = sectionLookup(template);
  const lines = detail.split("\n");
  const code = fencedLines(lines);
  const bodies = new Map<number, string[]>();
  let current: number | undefined;
  lines.forEach((line, index) => {
    const heading = code[index] ? null : /^###\s+(.+?)\s*$/.exec(line);
    const match = heading ? lookup.get(heading[1].toLocaleLowerCase()) : undefined;
    if (match !== undefined) {
      current = match;
      if (!bodies.has(match)) bodies.set(match, []);
      return;
    }
    if (current !== undefined) bodies.get(current)!.push(line);
  });
  return new Map([...bodies].map(([index, body]) => [index, body.join("\n")]));
}

export function checkCounts(detail: string, template: DetailTemplate): CountIssue[] {
  const bodies = sectionBodies(detail, template);
  const issues: CountIssue[] = [];
  template.sections.forEach((section, index) => {
    if (!section.count) return;
    const actual = countItems(bodies.get(index) ?? "");
    const ok = section.count.mode === "exact" ? actual === section.count.n : actual >= section.count.n;
    if (!ok) issues.push({ section: section.name, mode: section.count.mode, n: section.count.n, actual });
  });
  return issues;
}

export function countIssueText(issue: CountIssue, language: UiLanguage): string {
  const key = issue.mode === "exact" ? "ui.detail_count_issue_exact" : "ui.detail_count_issue_min";
  return translate(language, key, issue.section, issue.n, issue.actual);
}

/** The structure text for a template, plus (only when the output language's note language differs, i.e. zh-CN) the clause that keeps the fixed headings verbatim. */
export function detailStructurePrompt(
  template: DetailTemplate,
  language: UiLanguage,
  standardText: (headings: string) => string
): string {
  return [
    structureText(template, language, standardText),
    headingsVerbatim(language, undefined, !isBuiltinTemplateId(template.id))
  ]
    .filter(Boolean)
    .join("\n");
}

function structureText(
  template: DetailTemplate,
  language: UiLanguage,
  standardText: (headings: string) => string
): string {
  const headings = template.sections.map(section => `### ${section.name}`).join(", ");
  const description = (section: DetailSection) =>
    customDetailRule("description", language, {
      heading: `### ${section.name}`,
      description: section.description.trim()
    });
  if (template.id === STANDARD_TEMPLATE_ID)
    return [
      standardText(headings),
      ...template.sections.filter(section => section.description.trim()).map(description)
    ].join("\n");
  if (template.id === TEXTBOOK_TEMPLATE_ID)
    return [
      textbookDetailStructure(language, {
        headings,
        log: `### ${(template.sections.find(section => section.role === "log") ?? template.sections[template.sections.length - 1]).name}`
      }),
      ...template.sections.filter(section => section.description.trim()).map(description)
    ].join("\n");
  const rules: string[] = [];
  for (const section of template.sections) {
    const heading = `### ${section.name}`;
    if (section.role === "log") rules.push(customDetailRule("log", language, { heading }));
    if (section.description.trim()) rules.push(description(section));
    if (section.count)
      rules.push(customDetailRule(section.count.mode, language, { heading, n: String(section.count.n) }));
  }
  return customDetailStructure(language, {
    count: String(template.sections.length),
    headings,
    rules: rules.length ? `\n${rules.join("\n")}` : ""
  });
}
