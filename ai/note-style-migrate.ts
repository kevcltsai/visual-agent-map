import { translate, type UiLanguage } from "../i18n";
import { cleanBlockName, fileRef } from "../core/blocks/block-files";
import { findBuiltinBlock, BUILTIN_FORMATS } from "../core/blocks/builtin";
import { parseTemplateBlock } from "../core/blocks/template-block";
import { isBuiltinTemplateId, type DetailSection, type DetailTemplate } from "./detail-templates";
import { normalizeStyleContent, serializeLegacyV1 } from "./note-style-file";
import { validatePartName, type NameCategory, type StyleKind } from "./note-style-recipe";
import { isBuiltinPreset, type PromptPreset } from "./prompt-presets";

/**
 * The conversion of the 0.28.0 note style data (custom detail templates, custom tone presets, the default template) into
 * structure files, voice files and style files of the new model. This module is pure: it turns what the settings and the
 * existing part folders hold into a plan (files to create, the old id -> new ref table, the style for general topics); the
 * store carries the plan out. It reads and writes no file, and it never changes or removes an old key.
 */

export type MigratedCategory = "template" | "tone" | "recipe";

export interface MigratedFile {
  category: MigratedCategory;
  /** The file name without ".md". */
  base: string;
  text: string;
}

export interface RecipeMigrationInput {
  /** The interface language at the time of the conversion: the language of the key names and built-in part names. */
  language: UiLanguage;
  detailTemplates: readonly DetailTemplate[];
  promptPresets: readonly PromptPreset[] | undefined;
  defaultDetailTemplateId?: string;
  noteStyleByKind?: Partial<Record<StyleKind, string>>;
  /** The files that exist now, by base name. */
  existing: {
    recipe: ReadonlyMap<string, string>;
    template: ReadonlyMap<string, string>;
    tone: ReadonlyMap<string, string>;
  };
}

export interface RecipeMigrationPlan {
  /** Files to create, in write order (structures, voices, then the styles that name them). A file that exists with the same text is reused and not listed. */
  files: MigratedFile[];
  /** Old id -> `file:<name>` of the part that replaced it. */
  legacy: { templates: Record<string, string>; tones: Record<string, string> };
  /** The style general topics use now; only when `noteStyleByKind.topic` has no value. */
  topicStyle?: string;
  /** The name of the style the old default template became, for the notice. */
  defaultConverted?: string;
  /** Names of templates whose converted text did not read back the same; they stay read from `detailTemplates`. */
  skipped: string[];
  /** True when there is nothing to write or record. */
  nothing: boolean;
}

const lower = (value: string): string => value.toLocaleLowerCase();

/** A file name made safe: unsafe characters and runs of dots go, so the result passes `validatePartName` apart from a built-in's name. */
const safeName = (name: string): string => cleanBlockName(name.replace(/\.{2,}/g, " "));

/** Hands out file names: a name that holds the same text is reused, a taken or built-in name gets " (n)". */
class Namer {
  private readonly held = new Map<string, { base: string; text: string }>();
  readonly planned: MigratedFile[] = [];

  constructor(
    private readonly category: MigratedCategory,
    private readonly nameCategory: NameCategory,
    existing: ReadonlyMap<string, string>
  ) {
    for (const [base, text] of existing) this.held.set(lower(base), { base, text });
  }

  place(wanted: string, fallback: string, text: string): string {
    const safe = safeName(wanted) || safeName(fallback) || "Style";
    for (let n = 1; ; n++) {
      const name = n === 1 ? safe : `${safe} (${n})`;
      if (!validatePartName(name, this.nameCategory).ok) continue;
      const key = lower(name);
      const held = this.held.get(key);
      if (!held) {
        this.held.set(key, { base: name, text });
        this.planned.push({ category: this.category, base: name, text });
        return name;
      }
      if (normalizeStyleContent(held.text) === normalizeStyleContent(text)) return held.base;
    }
  }
}

const trimBlankLines = (text: string): string => {
  const lines = text.split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end).join("\n");
};

/** The sections of a template as the text of a structure file (the legacy export's section layout, without its header). */
function templateSectionsText(template: DetailTemplate, language: UiLanguage): string {
  const head = serializeLegacyV1({ ...template, sections: [] }, language);
  const full = serializeLegacyV1(template, language);
  return trimBlankLines(full.startsWith(head) ? full.slice(head.length) : full);
}

const sectionShape = (section: Pick<DetailSection, "name" | "description" | "count"> & { callouts?: unknown }) =>
  JSON.stringify([
    section.name,
    section.description.replace(/\r\n?/g, "\n").trim(),
    section.count ?? null,
    section.callouts ?? []
  ]);

/** The text of a style file that names a structure and the default voice, format and update mode. */
function recipeText(structureBase: string, language: UiLanguage): string {
  const voice = translate(language, findBuiltinBlock("tone", "academic").nameKey);
  const format = translate(language, BUILTIN_FORMATS.find(item => item.id === "standard")!.nameKey);
  return [
    "---",
    `${translate(language, "ui.recipe_key_structure")}: ${structureBase}`,
    `${translate(language, "ui.recipe_key_voice")}: ${voice}`,
    `${translate(language, "ui.recipe_key_format")}: ${format}`,
    `${translate(language, "ui.recipe_key_update")}: merge`,
    "---",
    ""
  ].join("\n");
}

export function planRecipeMigration(input: RecipeMigrationInput): RecipeMigrationPlan {
  const { language } = input;
  const structures = new Namer("template", "structure", input.existing.template);
  const voices = new Namer("tone", "voice", input.existing.tone);
  const recipes = new Namer("recipe", "recipe", input.existing.recipe);
  const legacy: RecipeMigrationPlan["legacy"] = { templates: {}, tones: {} };
  const skipped: string[] = [];
  const recipeOf = new Map<string, string>();

  for (const template of input.detailTemplates) {
    if (isBuiltinTemplateId(template.id)) continue;
    const text = `${templateSectionsText(template, language)}\n`;
    const check = parseTemplateBlock(text, { id: fileRef(template.name), name: template.name });
    if (
      !check.ok ||
      check.lead ||
      check.template.sections.length !== template.sections.length ||
      check.template.sections.some((section, index) => sectionShape(section) !== sectionShape(template.sections[index]))
    ) {
      skipped.push(template.name);
      continue;
    }
    const structure = structures.place(template.name, "Style", text);
    legacy.templates[template.id] = fileRef(structure);
    recipeOf.set(template.id, recipes.place(structure, "Style", recipeText(structure, language)));
  }

  for (const preset of input.promptPresets ?? []) {
    if (preset.kind !== "tone" || isBuiltinPreset(preset.id)) continue;
    legacy.tones[preset.id] = fileRef(voices.place(preset.name, preset.id, preset.text));
  }

  // The old default template becomes the style general topics use, unless the user already chose one for them.
  let topicStyle: string | undefined;
  let defaultConverted: string | undefined;
  const chosen = input.defaultDetailTemplateId;
  if (chosen && !input.noteStyleByKind?.topic) {
    if (chosen === "textbook") {
      topicStyle = "builtin:textbook";
      defaultConverted = translate(language, "ui.recipe_name_textbook");
    } else if (recipeOf.has(chosen)) {
      topicStyle = fileRef(recipeOf.get(chosen)!);
      defaultConverted = recipeOf.get(chosen);
    }
  }

  const files = [...structures.planned, ...voices.planned, ...recipes.planned];
  return {
    files,
    legacy,
    ...(topicStyle ? { topicStyle } : {}),
    ...(defaultConverted ? { defaultConverted } : {}),
    skipped,
    nothing:
      !files.length &&
      !Object.keys(legacy.templates).length &&
      !Object.keys(legacy.tones).length &&
      topicStyle === undefined
  };
}
