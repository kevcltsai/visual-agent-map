import { NOTE_LANGUAGES, translate, type NoteLanguage } from "../i18n";
import { BUILTIN_BLOCKS, builtinTemplateText } from "../core/blocks/builtin";
import { parseTemplateBlock } from "../core/blocks/template-block";
import {
  sectionLookup,
  standardTemplate,
  validateTemplate,
  withoutConflictingAliases,
  type DetailSection,
  type DetailTemplate
} from "./detail-templates";
import { fencedLines } from "./markdown-blocks";
import { isNewSourcesHeading, sectionAliasesFor } from "./section-aliases";

/**
 * The sections of a note's detail as a template ("AI suggested" style): the `###` headings the note already has, each
 * carrying the built-in description of a section it names. Pure: it reads no setting and writes nothing. A heading is
 * only compared as a string (never built into a pattern).
 */

export type DetailSectionsResult =
  { ok: true; template: DetailTemplate } | { ok: false; reason: "no_sections" | "too_many" | "duplicate" | "invalid" };

/** The id of a template made from a note's sections: not a built-in id, so it takes the custom path. */
export const NOTE_SECTIONS_TEMPLATE_ID = "note-sections";

const HEADING = /^###\s+(.+?)\s*$/;
const key = (value: string): string => value.trim().toLocaleLowerCase();

/** The `###` headings outside code: line index and the heading text. */
function headingLines(detail: string): { index: number; name: string }[] {
  const lines = detail.split("\n");
  const code = fencedLines(lines);
  const found: { index: number; name: string }[] = [];
  lines.forEach((line, index) => {
    if (code[index]) return;
    const match = HEADING.exec(line);
    if (match) found.push({ index, name: match[1].trim() });
  });
  return found;
}

/** The built-in structures a heading is looked up in: Standard first, then the others in registry order. */
function builtinStructures(language: NoteLanguage): DetailTemplate[] {
  const templates: DetailTemplate[] = [standardTemplate(language)];
  for (const block of BUILTIN_BLOCKS) {
    if (block.category !== "template" || block.id === "standard") continue;
    const parsed = parseTemplateBlock(builtinTemplateText(block.id, language), { id: block.id, name: block.id });
    if (parsed.ok) templates.push(parsed.template);
  }
  return templates;
}

const LOG_KEYS = new Set(NOTE_LANGUAGES.map(locale => key(translate(locale, "detail.update_log"))));

/**
 * The template a detail's `###` headings make. A heading a built-in structure names (by name or alias) keeps that
 * section's description, role, count, callouts and aliases and is written as the note has it. Fails when the detail has no
 * section, more than 12, a repeated name, or a name that is empty, has `#`, or is over 40 characters.
 */
export function templateFromDetail(detail: string, language: NoteLanguage): DetailSectionsResult {
  const headings = headingLines(detail);
  if (!headings.length) return { ok: false, reason: "no_sections" };
  const structures = builtinStructures(language).map(template => ({ template, lookup: sectionLookup(template) }));
  const taken = new Set<"sources" | "log">();
  const usedIds = new Set<string>();
  const sections: DetailSection[] = headings.map(({ name }, position) => {
    const heading = key(name);
    let found: DetailSection | undefined;
    for (const { template, lookup } of structures) {
      const at = heading ? lookup.get(heading) : undefined;
      if (at !== undefined) {
        found = template.sections[at];
        break;
      }
    }
    let role: DetailSection["role"];
    let base: Omit<DetailSection, "role" | "id" | "name">;
    if (found) {
      role = found.role;
      base = {
        description: found.description,
        aliases: [...(key(found.name) !== heading ? [found.name] : []), ...found.aliases],
        ...(found.count ? { count: { ...found.count } } : {}),
        ...(found.callouts ? { callouts: found.callouts.map(callout => ({ ...callout })) } : {})
      };
    } else {
      role = isNewSourcesHeading(name) ? "sources" : LOG_KEYS.has(heading) ? "log" : "none";
      base = { description: "", aliases: sectionAliasesFor(name) };
    }
    // Only the first section of a role keeps it.
    if (role !== "none") {
      if (taken.has(role)) role = "none";
      else taken.add(role);
    }
    let id = found?.id ?? `s${position + 1}`;
    for (let n = position + 1; usedIds.has(id); n++) id = `s${n}`;
    usedIds.add(id);
    return { id, name, role, ...base };
  });
  const template: DetailTemplate = {
    id: NOTE_SECTIONS_TEMPLATE_ID,
    name: NOTE_SECTIONS_TEMPLATE_ID,
    sections: withoutConflictingAliases(sections)
  };
  const issues = validateTemplate(template, []);
  if (issues.some(issue => issue.key === "ui.detail_template_error_section_count"))
    return { ok: false, reason: "too_many" };
  if (issues.some(issue => issue.key === "ui.detail_template_error_section_name_taken"))
    return { ok: false, reason: "duplicate" };
  if (issues.length) return { ok: false, reason: "invalid" };
  return { ok: true, template };
}

/**
 * The template with a sources section: as it is when it has one, else the Standard sources section before the log section
 * (or last).
 */
export function withSourcesSection(template: DetailTemplate, language: NoteLanguage): DetailTemplate {
  if (template.sections.some(section => section.role === "sources")) return template;
  const standard = standardTemplate(language).sections.find(section => section.role === "sources");
  if (!standard) return template;
  const names = new Set(template.sections.map(section => key(section.name)));
  // A name the template already has for another section cannot be used twice; the alias spellings stay for lookup.
  if (names.has(key(standard.name))) return template;
  const at = template.sections.findIndex(section => section.role === "log");
  const sections = [...template.sections];
  sections.splice(at < 0 ? sections.length : at, 0, { ...standard, aliases: [...standard.aliases] });
  return { ...template, sections: withoutConflictingAliases(sections) };
}

/**
 * The detail with every `###` heading the template does not know turned into `####`, outside code. Its content then stays
 * in the section before it and the section list does not change.
 */
export function demoteUnknownHeadings(detail: string, template: DetailTemplate): string {
  const lookup = sectionLookup(template);
  const lines = detail.split("\n");
  const code = fencedLines(lines);
  return lines
    .map((line, index) => {
      if (code[index]) return line;
      const match = HEADING.exec(line);
      return match && !lookup.has(key(match[1])) ? `#${line}` : line;
    })
    .join("\n");
}
