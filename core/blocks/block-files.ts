import { translate, type TranslationKey, type UiLanguage } from "../../i18n";
import { CANONICAL_LANGUAGES, normalizeStyleContent } from "../../ai/note-style-file";
import { BUILTIN_BLOCKS, builtinTemplateText, findBuiltinBlock, type BlockCategory } from "./builtin";

/**
 * Pure rules for the part files of the note style folder: `<style folder>/<Styles|Structures|Voices|Formats>/<name>.md`,
 * and backups in `<style folder>/<Backups>/`. No vault access here; the store passes in what exists. Each folder name
 * has a spelling per registered language; the first spelling that exists is used.
 */
export type BlockFolderRole = "recipe" | "template" | "tone" | "format" | "backup";

const FOLDER_KEYS: Record<BlockFolderRole, TranslationKey> = {
  recipe: "ui.style_folder_recipe",
  template: "ui.style_folder_template",
  tone: "ui.style_folder_tone",
  format: "ui.style_folder_format",
  backup: "ui.style_folder_backup"
};

/** A stored choice of a block: a built-in by id (`builtin:<id>`) or a file by base name (`file:<name>`). */
export type BlockRef = { kind: "builtin"; id: string } | { kind: "file"; base: string };

export function parseBlockRef(ref: string | undefined): BlockRef | undefined {
  if (!ref) return undefined;
  if (ref.startsWith("builtin:") && ref.length > "builtin:".length) return { kind: "builtin", id: ref.slice(8) };
  if (ref.startsWith("file:") && ref.length > "file:".length) return { kind: "file", base: ref.slice(5) };
  return undefined;
}
export const builtinRef = (id: string): string => `builtin:${id}`;
export const fileRef = (base: string): string => `file:${base}`;

const lower = (value: string): string => value.toLocaleLowerCase();
export const stripMd = (name: string): string => name.replace(/\.md$/i, "");

/** Characters a vault file name cannot carry (and the ones that break links), as the style files already clean them. */
const UNSAFE_NAME = /[\\/:*?"<>|#^[\]]/g;
/** Windows device names (any case), alone or before a dot: Windows cannot create a file with such a base name. */
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
/**
 * A file base name made safe: unsafe characters become spaces, runs of spaces collapse, dots-only names are dropped,
 * and a Windows reserved name gets a leading "_" ("NUL" becomes "_NUL").
 */
export function cleanBlockName(name: string): string {
  const cleaned = name.replace(UNSAFE_NAME, " ").replace(/\s+/g, " ").trim();
  if (/^\.+$/.test(cleaned)) return "";
  return RESERVED_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** Every distinct spelling of a folder's name, in the order of the registered languages. */
export function blockFolderNames(role: BlockFolderRole): string[] {
  return [...new Set(CANONICAL_LANGUAGES.map(language => translate(language, FOLDER_KEYS[role])))];
}

/**
 * The folder of `role` inside `parent`: the first spelling that already exists (so a vault keeps the folders it has),
 * else the spelling of the interface language, which is where a new folder is created.
 */
export function resolveBlockFolder(
  parent: string,
  role: BlockFolderRole,
  exists: (path: string) => boolean,
  language: UiLanguage
): string {
  const found = blockFolderNames(role).find(name => exists(`${parent}/${name}`));
  return `${parent}/${found ?? translate(language, FOLDER_KEYS[role])}`;
}

/** The names a built-in block goes by (one per registered language, distinct), the earlier names of a renamed block included. */
export function builtinBlockNames(category: BlockCategory, id: string): string[] {
  const block = findBuiltinBlock(category, id);
  const keys = [block.nameKey, ...(block.legacyNameKeys ?? [])];
  return [...new Set(keys.flatMap(key => CANONICAL_LANGUAGES.map(language => translate(language, key))))];
}

/** The built-in a file base name stands for: equal to a name in any registered language, ignoring case, no "(n)" suffix. */
export function builtinBlockIdOfName(category: BlockCategory, base: string): string | undefined {
  const key = lower(base);
  return BUILTIN_BLOCKS.find(
    block => block.category === category && builtinBlockNames(category, block.id).some(name => lower(name) === key)
  )?.id;
}

/** The text a built-in block has in `language`: a template's whole text, a tone's preset text (academic is empty). */
export function builtinBlockText(category: BlockCategory, id: string, language: UiLanguage): string {
  return category === "template" ? builtinTemplateText(id, language) : findBuiltinBlock(category, id).body(language);
}

/** True when `text` equals the built-in's text in any registered language (line endings and trailing blanks aside). */
export function isUnmodifiedBlock(category: BlockCategory, id: string, text: string): boolean {
  const normalized = normalizeStyleContent(text);
  return CANONICAL_LANGUAGES.some(
    language => normalizeStyleContent(builtinBlockText(category, id, language)) === normalized
  );
}

/** `base` made unique among `taken` (lower-case names) with " (2)", " (3)" ... */
export function uniqueBlockName(base: string, taken: ReadonlySet<string>): string {
  let name = base;
  for (let n = 2; taken.has(lower(name)); n++) name = `${base} (${n})`;
  return name;
}

/** The name of a copy of `sourceName`: "<name> copy" in the language, unique, never a built-in's name. */
export function copyBlockName(
  category: BlockCategory,
  sourceName: string,
  language: UiLanguage,
  taken: ReadonlySet<string>
): string {
  const reserved = new Set(taken);
  for (const block of BUILTIN_BLOCKS)
    if (block.category === category)
      for (const name of builtinBlockNames(category, block.id)) reserved.add(lower(name));
  const base = cleanBlockName(translate(language, "ui.block_copy_name_0", cleanBlockName(sourceName))) || "copy";
  return uniqueBlockName(base, reserved);
}

const two = (value: number): string => String(value).padStart(2, "0");

/** The file name (with ".md") of a backup of `name` made at `now` (local time): "<name> YYYY-MM-DD HHmmss.md", unique. */
export function backupName(name: string, now: Date, taken: ReadonlySet<string>): string {
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  const takenBases = new Set([...taken].map(item => stripMd(item)));
  return `${uniqueBlockName(`${name} ${stamp}`, takenBases)}.md`;
}
