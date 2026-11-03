import { translate, type TranslationKey, type UiLanguage } from "../i18n";
import type { TopicKind } from "../note-values";
import { BUILTIN_BLOCKS, BUILTIN_FORMATS } from "../core/blocks/builtin";
import type { NoteStyleIssue } from "./note-style-file";

/**
 * A note style (recipe) is a structure, a voice, a format and an update mode. This module is pure: the model's constants,
 * the built-in recipes, reference and name rules, and the parse of a recipe file's text. It reads and writes no file.
 */

/** How a research result is written back to a note that already has a detail. */
export type UpdateMode = "merge" | "top" | "fresh";
export const UPDATE_MODES: readonly UpdateMode[] = ["merge", "top", "fresh"];
export const UPDATE_MODE_KEYS: Record<UpdateMode, TranslationKey> = {
  merge: "ui.update_mode_merge",
  top: "ui.update_mode_top",
  fresh: "ui.update_mode_fresh"
};

/** The kinds a default style is set for: the six topic kinds and the AIM conclusion note. */
export type StyleKind = TopicKind | "aim";
export const STYLE_KINDS: readonly StyleKind[] = [
  "topic",
  "atomic",
  "hypothesis",
  "evidence",
  "conclusion",
  "action",
  "aim"
];

/** The built-in recipe each kind starts from. */
export const KIND_DEFAULT_RECIPE: Record<StyleKind, string> = {
  topic: "builtin:general",
  atomic: "builtin:atomic",
  hypothesis: "builtin:hypothesis",
  evidence: "builtin:evidence",
  conclusion: "builtin:conclusion",
  action: "builtin:action",
  aim: "builtin:aim"
};

/** The structure value of the AIM report: AIM's own delivery structure, not a structure part. */
export const AIM_DELIVERY_STRUCTURE = "aim-delivery";

export interface BuiltinRecipe {
  readonly id: string;
  readonly nameKey: TranslationKey;
  /** A built-in structure id, or `aim-delivery`. */
  readonly structure: string;
  /** A built-in voice id. */
  readonly voice: string;
  /** A built-in format id. */
  readonly format: string;
  /** Not applied for the AIM report. */
  readonly update: UpdateMode;
}

export const BUILTIN_RECIPES: readonly BuiltinRecipe[] = [
  {
    id: "general",
    nameKey: "ui.recipe_name_general",
    structure: "standard",
    voice: "academic",
    format: "standard",
    update: "merge"
  },
  {
    id: "atomic",
    nameKey: "ui.recipe_name_atomic",
    structure: "atomic",
    voice: "academic",
    format: "standard",
    update: "merge"
  },
  {
    id: "hypothesis",
    nameKey: "ui.recipe_name_hypothesis",
    structure: "hypothesis",
    voice: "academic",
    format: "standard",
    update: "top"
  },
  {
    id: "evidence",
    nameKey: "ui.recipe_name_evidence",
    structure: "evidence",
    voice: "academic",
    format: "standard",
    update: "merge"
  },
  {
    id: "conclusion",
    nameKey: "ui.recipe_name_conclusion",
    structure: "conclusion",
    voice: "academic",
    format: "standard",
    update: "merge"
  },
  {
    id: "action",
    nameKey: "ui.recipe_name_action",
    structure: "action",
    voice: "academic",
    format: "standard",
    update: "merge"
  },
  {
    id: "aim",
    nameKey: "ui.recipe_name_aim",
    structure: AIM_DELIVERY_STRUCTURE,
    voice: "academic",
    format: "standard",
    update: "merge"
  },
  {
    id: "textbook",
    nameKey: "ui.recipe_name_textbook",
    structure: "textbook",
    voice: "academic",
    format: "standard",
    update: "merge"
  }
];

export type PartCategory = "structure" | "voice" | "format";
/** What a name is checked in: a part category, or the recipes themselves. */
export type NameCategory = PartCategory | "recipe";
const LANGUAGES: readonly UiLanguage[] = ["zh-TW", "zh-CN", "en"];

/** The built-in names of a category: id and translation key. */
function builtinNames(category: NameCategory): { id: string; nameKey: TranslationKey }[] {
  if (category === "recipe") return BUILTIN_RECIPES.map(({ id, nameKey }) => ({ id, nameKey }));
  if (category === "format") return BUILTIN_FORMATS.map(({ id, nameKey }) => ({ id, nameKey }));
  const wanted = category === "structure" ? "template" : "tone";
  return BUILTIN_BLOCKS.filter(block => block.category === wanted).map(({ id, nameKey }) => ({ id, nameKey }));
}

const folded = (text: string): string => text.toLocaleLowerCase();

/** The built-in part of `category` that `name` spells in any language (case-insensitive), or the id spelled as it is. */
export function builtinPartIdOf(category: NameCategory, name: string): string | undefined {
  const key = folded(name);
  return builtinNames(category).find(
    ({ id, nameKey }) => id === name || LANGUAGES.some(language => folded(translate(language, nameKey)) === key)
  )?.id;
}

export type NameCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether `name` can be the name of a user's part file of `category`: no `/`, `\`, `..`, space at either end, not empty,
 * and not the name of a built-in part (any language, any case).
 */
export function validatePartName(name: string, category: NameCategory): NameCheck {
  if (!name) return { ok: false, reason: "empty" };
  if (name !== name.trim()) return { ok: false, reason: "padded" };
  if (name.includes("/") || name.includes("\\")) return { ok: false, reason: "separator" };
  if (name.includes("..")) return { ok: false, reason: "dots" };
  const key = folded(name);
  const taken = builtinNames(category).some(({ nameKey }) =>
    LANGUAGES.some(language => folded(translate(language, nameKey)) === key)
  );
  return taken ? { ok: false, reason: "builtin" } : { ok: true };
}

export type RecipeRef = { kind: "builtin"; id: string } | { kind: "file"; name: string };

/**
 * `builtin:<id>` or `file:<name>`; anything else, or a file name `validatePartName` rejects in `category` (the recipes
 * unless a part category is given), is undefined.
 */
export function parseRecipeRef(ref: unknown, category: NameCategory = "recipe"): RecipeRef | undefined {
  if (typeof ref !== "string") return undefined;
  const builtin = /^builtin:(.+)$/.exec(ref);
  if (builtin) return { kind: "builtin", id: builtin[1] };
  const file = /^file:(.+)$/.exec(ref);
  if (!file) return undefined;
  const name = file[1];
  if (!validatePartName(name, category).ok) return undefined;
  return { kind: "file", name };
}

export interface RecipeFile {
  /** A reference per part: `builtin:<id>` or `file:<name>`. A missing key is the general research part. */
  structure: string;
  voice: string;
  format: string;
  update: UpdateMode;
  /** The first non-empty line of the text after the frontmatter, or "". */
  description: string;
  /** 1-based line of each key that was read. */
  lines: Partial<Record<PartCategory | "update", number>>;
  issues: NoteStyleIssue[];
}

const KEYS: Record<PartCategory | "update", readonly string[]> = {
  structure: ["段落結構", "structure", "段落结构"],
  voice: ["寫作口吻", "voice", "写作口吻"],
  format: ["格式規則", "format", "格式规则"],
  update: ["更新方式", "update"]
};

const GENERAL = BUILTIN_RECIPES[0];

/** A part name as a reference: a built-in name (any language) is the built-in, anything else is a file. */
function partRef(category: PartCategory, name: string): string {
  const id = builtinPartIdOf(category, name);
  return id !== undefined ? `builtin:${id}` : `file:${name}`;
}

function updateModeOf(value: string): UpdateMode | undefined {
  const key = folded(value.trim());
  return UPDATE_MODES.find(
    mode => mode === key || LANGUAGES.some(language => folded(translate(language, UPDATE_MODE_KEYS[mode])) === key)
  );
}

/**
 * Parses a recipe file. Nothing here fails: a missing key is the general research part, a value that cannot be read is
 * an issue with its line and the same default (an unknown update mode is merge), an unknown key is ignored.
 */
export function parseRecipeFile(text: string): RecipeFile {
  const all = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = all.split("\n");
  const result: RecipeFile = {
    structure: `builtin:${GENERAL.structure}`,
    voice: `builtin:${GENERAL.voice}`,
    format: `builtin:${GENERAL.format}`,
    update: GENERAL.update,
    description: "",
    lines: {},
    issues: []
  };
  let bodyStart = 0;
  if (lines[0].trimEnd() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
    if (end < 0) {
      result.issues.push({
        line: 1,
        code: "frontmatter_unclosed",
        values: [],
        message: "The frontmatter opened by --- on line 1 is never closed."
      });
      bodyStart = lines.length;
    } else {
      bodyStart = end + 1;
      for (let index = 1; index < end; index++) {
        const raw = lines[index];
        if (!raw.trim() || /^\s*#/.test(raw) || /^[\s-]/.test(raw)) continue;
        const pair = /^([^:：]+?)\s*[:：]\s*(.*)$/.exec(raw);
        if (!pair) continue;
        const name = pair[1].trim().toLocaleLowerCase();
        const slot = (Object.keys(KEYS) as (keyof typeof KEYS)[]).find(item => KEYS[item].includes(name));
        if (!slot) continue;
        let value = pair[2].trim();
        if (/^(["']).*\1$/.test(value) && value.length >= 2) value = value.slice(1, -1).trim();
        result.lines[slot] = index + 1;
        if (slot === "update") {
          const mode = updateModeOf(value);
          if (mode) result.update = mode;
          else
            result.issues.push({
              line: index + 1,
              code: "update_invalid",
              values: [],
              message: `Line ${index + 1}: the update mode is not merge, top or fresh.`
            });
          continue;
        }
        if (!value) continue;
        if (!builtinPartIdOf(slot, value) && !validatePartName(value, slot).ok) {
          result.issues.push({
            line: index + 1,
            code: "part_name_invalid",
            values: [value],
            message: `Line ${index + 1}: "${value}" cannot be used as a part name.`
          });
          continue;
        }
        result[slot] = partRef(slot, value);
      }
    }
  }
  result.description =
    lines
      .slice(bodyStart)
      .find(line => line.trim())
      ?.trim() ?? "";
  return result;
}

/** The four values a style file holds: a part ref (`builtin:<id>` or `file:<name>`) per part, and the update mode. */
export interface RecipeFileParts {
  structure: string;
  voice: string;
  format: string;
  update: UpdateMode;
}

const PART_KEY: Record<PartCategory | "update", TranslationKey> = {
  structure: "ui.recipe_key_structure",
  voice: "ui.recipe_key_voice",
  format: "ui.recipe_key_format",
  update: "ui.recipe_key_update"
};
const SLOTS: readonly (PartCategory | "update")[] = ["structure", "voice", "format", "update"];

/** The name a part ref is written under in a style file: a built-in by the interface language's name, a file by its name. */
export function partNameOfRef(category: PartCategory, ref: string, language: UiLanguage): string {
  const parsed = parseRecipeRef(ref, category);
  if (!parsed) throw new Error(`Not a part reference: ${ref}`);
  if (parsed.kind === "file") return parsed.name;
  const found = builtinNames(category).find(item => item.id === parsed.id);
  if (!found) throw new Error(`Unknown built-in ${category}: ${parsed.id}`);
  return translate(language, found.nameKey);
}

function slotValue(slot: PartCategory | "update", parts: RecipeFileParts, language: UiLanguage): string {
  return slot === "update" ? parts.update : partNameOfRef(slot, parts[slot], language);
}

/**
 * The text of a new style file: the frontmatter with the four keys (named in the interface language), then the
 * description line when there is one. `parseRecipeFile` reads it back to the same four values.
 */
export function recipeFileText(input: RecipeFileParts & { description?: string }, language: UiLanguage): string {
  const lines = [
    "---",
    ...SLOTS.map(slot => `${translate(language, PART_KEY[slot])}: ${slotValue(slot, input, language)}`),
    "---"
  ];
  const description = input.description?.trim();
  return `${lines.join("\n")}\n${description ? `${description}\n` : ""}`;
}

/**
 * The text of an existing style file with only the values of the four known keys (a key in any language) changed. A key
 * whose value already means the wanted one keeps its line as written; a missing key is added before the closing `---`;
 * a file with no frontmatter gets one in front. Every other byte (other keys, comments, the body, line endings) stays.
 */
export function updateRecipeFileText(oldText: string, parts: RecipeFileParts, language: UiLanguage): string {
  const bom = oldText.startsWith("﻿") ? "﻿" : "";
  const text = bom ? oldText.slice(1) : oldText;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split("\n");
  const bare = (line: string): string => line.replace(/\r$/, "");
  const closing =
    bare(lines[0]).trimEnd() === "---"
      ? lines.findIndex((line, index) => index > 0 && bare(line).trimEnd() === "---")
      : -1;
  const wanted = (slot: PartCategory | "update"): string => slotValue(slot, parts, language);
  if (closing < 0) {
    const head = ["---", ...SLOTS.map(slot => `${translate(language, PART_KEY[slot])}: ${wanted(slot)}`), "---"];
    return `${bom}${head.join(eol)}${eol}${text}`;
  }
  const seen = new Set<PartCategory | "update">();
  for (let index = 1; index < closing; index++) {
    const raw = bare(lines[index]);
    if (!raw.trim() || /^\s*#/.test(raw) || /^[\s-]/.test(raw)) continue;
    const pair = /^(([^:：]+?)\s*[:：]\s*)(.*)$/.exec(raw);
    if (!pair) continue;
    const key = pair[2].trim().toLocaleLowerCase();
    const slot = SLOTS.find(item => KEYS[item].includes(key));
    if (!slot) continue;
    seen.add(slot);
    let value = pair[3].trim();
    if (/^(["']).*\1$/.test(value) && value.length >= 2) value = value.slice(1, -1).trim();
    const same =
      slot === "update"
        ? updateModeOf(value) === parts.update
        : value !== "" &&
          (builtinPartIdOf(slot, value) !== undefined || validatePartName(value, slot).ok) &&
          partRef(slot, value) === parts[slot];
    if (same) continue;
    lines[index] = `${pair[1]}${wanted(slot)}${lines[index].endsWith("\r") ? "\r" : ""}`;
  }
  const added = SLOTS.filter(slot => !seen.has(slot)).map(
    slot => `${translate(language, PART_KEY[slot])}: ${wanted(slot)}${eol === "\r\n" ? "\r" : ""}`
  );
  lines.splice(closing, 0, ...added);
  return `${bom}${lines.join("\n")}`;
}
