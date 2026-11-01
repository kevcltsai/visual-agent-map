import { LANGUAGES, noteLanguageOf, translate, type UiLanguage } from "../i18n";
import { cleanBlockName, builtinBlockNames, builtinRef, fileRef, stripMd } from "../core/blocks/block-files";
import { BUILTIN_BLOCKS, type BlockCategory } from "../core/blocks/builtin";
import { parseTemplateBlock, templateFormatHeading } from "../core/blocks/template-block";
import { applyFormatPreferences, inLanguage, OBSIDIAN_FORMAT } from "../core/steps/_shared/fragments";
import {
  STANDARD_TEMPLATE_ID,
  TEXTBOOK_TEMPLATE_ID,
  type DetailSection,
  type DetailTemplate
} from "./detail-templates";
import {
  builtinStyleFileName,
  CANONICAL_LANGUAGES,
  CANONICAL_VERSIONS,
  matchCanonical,
  normalizeStyleContent,
  NOTE_STYLE_BUILTIN_IDS,
  parseNoteStyleFile,
  serializeLegacyV1,
  type NoteStyle,
  type NoteStyleBuiltinId
} from "./note-style-file";
import { DEFAULT_TONE_ID, isBuiltinPreset, listPresets, type PromptPreset } from "./prompt-presets";

/**
 * The one-time upgrade of the old note style data into template blocks and tone blocks. This module is pure: it turns what
 * the old settings and style folder hold into a plan (block files to write, old files to back up and trash, the alias
 * table, the new workspace keys); the store carries the plan out. It reads and writes no file.
 *
 * What the old data decided in the prompt is written into the blocks, so the prompt stays what it was in the language of
 * the interface at the time of the upgrade: the old switches (callouts, diagrams, tables, tasks, highlight) and the four
 * callout keys are applied to the built-in format text and the result becomes the format rules zone of the template.
 */

/** Where an old id points now. `template` is a `file:<name>` template block ref, `tone` a tone block ref (`builtin:` or `file:`). */
export interface NoteStyleAlias {
  template?: string;
  tone?: string;
}
export type NoteStyleAliases = Record<string, NoteStyleAlias>;

/** Set when the upgrade has finished; the old sources are not read after it. */
export interface NoteStyleUpgradeMarker {
  version: number;
}
export const NOTE_STYLE_UPGRADE_VERSION = 1;

/** The alias key of an old style file, of a built-in style whose file was changed, and the prefix both share with other ids. */
export const styleAliasKey = (base: string): string => `style:${base}`;
export const pairAliasKey = (id: NoteStyleBuiltinId): string => `pair:${id}`;

/** Ids of the built-in styles as stored pairs (template id plus tone id); the same table the note-style menu uses. */
export const BUILTIN_PAIRS: Record<NoteStyleBuiltinId, { template: string; tone: string }> = {
  standard: { template: STANDARD_TEMPLATE_ID, tone: DEFAULT_TONE_ID },
  textbook: { template: TEXTBOOK_TEMPLATE_ID, tone: DEFAULT_TONE_ID },
  summary: { template: STANDARD_TEMPLATE_ID, tone: "summary" },
  plain: { template: STANDARD_TEMPLATE_ID, tone: "plain" },
  guide: { template: STANDARD_TEMPLATE_ID, tone: "guide" }
};

export function builtinPairOf(
  templateId: string | undefined,
  toneId: string | undefined
): NoteStyleBuiltinId | undefined {
  const template = templateId || STANDARD_TEMPLATE_ID;
  const tone = toneId || DEFAULT_TONE_ID;
  return NOTE_STYLE_BUILTIN_IDS.find(id => BUILTIN_PAIRS[id].template === template && BUILTIN_PAIRS[id].tone === tone);
}

const lower = (value: string): string => value.toLocaleLowerCase();
const has = (object: object, key: string): boolean => Boolean(Object.prototype.hasOwnProperty.call(object, key));
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Load-time check of the saved alias table: entries whose values are not strings are dropped. */
export function normalizeNoteStyleAliases(value: unknown): NoteStyleAliases | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: NoteStyleAliases = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object") continue;
    const { template, tone } = entry as NoteStyleAlias;
    const alias: NoteStyleAlias = {
      ...(typeof template === "string" && template ? { template } : {}),
      ...(typeof tone === "string" && tone ? { tone } : {})
    };
    if (alias.template || alias.tone) result[key] = alias;
  }
  return result;
}

export function normalizeNoteStyleUpgradeMarker(value: unknown): NoteStyleUpgradeMarker | undefined {
  const version = value && typeof value === "object" ? (value as NoteStyleUpgradeMarker).version : undefined;
  return typeof version === "number" && Number.isFinite(version) ? { version } : undefined;
}

// ---- which old file is a built-in's file ----

/** True when `text` is a built-in's file (canonical, or edited but still carrying its usage comment). */
export function isBuiltinStyleFileText(id: NoteStyleBuiltinId, text: string): boolean {
  if (matchCanonical(text)?.id === id) return true;
  for (const version of CANONICAL_VERSIONS)
    for (const language of CANONICAL_LANGUAGES) {
      const canonical = version[id][language];
      const comment = /%%[^\n]*/.exec(canonical)?.[0];
      const name = builtinStyleFileName(id, language);
      const at = comment ? comment.indexOf(name) : -1;
      if (comment && at >= 0 && text.includes(comment.slice(0, at + name.length + 1))) return true;
    }
  return false;
}

/** The base name of the file that holds a built-in style among `files`, if one is there (the interface language's name first). */
export function builtinStyleFileBase(
  files: ReadonlyMap<string, string>,
  id: NoteStyleBuiltinId,
  preferred: UiLanguage
): string | undefined {
  const languages = [preferred, ...CANONICAL_LANGUAGES.filter(language => language !== preferred)];
  const names = [...new Set(languages.map(language => builtinStyleFileName(id, language)))];
  for (const name of names) {
    const matches = [...files.keys()]
      .filter(
        base => lower(base) === lower(name) || new RegExp(`^${escapeRegExp(lower(name))} \\(\\d+\\)$`).test(lower(base))
      )
      .sort();
    const found = matches.find(base => isBuiltinStyleFileText(id, files.get(base)!));
    if (found) return found;
  }
  return undefined;
}

// ---- the plan ----

export interface UpgradeInput {
  /** The interface language at the time of the upgrade: the language the format rules zones are written in. */
  language: UiLanguage;
  /** The old style folder's files by base name (no ".md"). */
  files: ReadonlyMap<string, string>;
  detailTemplates: readonly DetailTemplate[];
  promptPresets: readonly PromptPreset[] | undefined;
  noteStyleFiles: Readonly<Record<string, string>> | undefined;
  defaultNoteStyleId?: string;
  defaultDetailTemplateId?: string;
  noteTemplateBlock?: string;
  noteToneBlock?: string;
  /** The block files that exist now, by base name. */
  blocks: Readonly<Record<BlockCategory, ReadonlyMap<string, string>>>;
}

export interface PlannedBlock {
  category: BlockCategory;
  base: string;
  text: string;
}

export interface UpgradePlan {
  /** Block files to create. A block that exists with the same text is reused and not listed. */
  blocks: PlannedBlock[];
  /** Old files that were turned into blocks (or are an unchanged built-in): each is backed up, then trashed. */
  oldFiles: { base: string; text: string }[];
  /** Old style files that do not read; they stay where they are. */
  skipped: string[];
  aliases: NoteStyleAliases;
  /** The new workspace keys to set (only those that have no value yet). */
  keys: { noteTemplateBlock?: string; noteToneBlock?: string };
  /** True when there was nothing to carry over: only the marker is written. */
  nothing: boolean;
}

const reservedNames = (category: BlockCategory): Set<string> =>
  new Set(
    BUILTIN_BLOCKS.filter(block => block.category === category).flatMap(block =>
      builtinBlockNames(category, block.id).map(lower)
    )
  );

/** Hands out block file names: a name that holds the same text is reused, a taken or built-in name gets " (n)". */
class Namer {
  private readonly held = new Map<string, { base: string; text: string }>();
  readonly planned: PlannedBlock[] = [];

  constructor(
    private readonly category: BlockCategory,
    existing: ReadonlyMap<string, string>,
    private readonly reserved: ReadonlySet<string>
  ) {
    for (const [base, text] of existing) this.held.set(lower(base), { base, text });
  }

  place(wanted: string, fallback: string, text: string): string {
    const safe = cleanBlockName(wanted) || cleanBlockName(fallback) || "Block";
    for (let n = 1; ; n++) {
      const name = n === 1 ? safe : `${safe} (${n})`;
      const key = lower(name);
      if (this.reserved.has(key)) continue;
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

/** The body of an old style file: the text after its frontmatter (all of it when there is none). */
function styleFileBody(text: string): string {
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  if (lines[0].trimEnd() !== "---") return trimBlankLines(lines.join("\n"));
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  return trimBlankLines(lines.slice(end < 0 ? lines.length : end + 1).join("\n"));
}

/** The old switches applied to the built-in format text: the format rules zone the style's prompt had. */
function formatZone(language: UiLanguage, style?: NoteStyle): string {
  return trimBlankLines(applyFormatPreferences(inLanguage(OBSIDIAN_FORMAT, language), language, style));
}

const templateText = (body: string, format: string, language: UiLanguage): string =>
  `${body}\n\n# ${templateFormatHeading(noteLanguageOf(language))}\n\n${format}\n`;

/** The sections of a template written as a block's sections zone (the frozen legacy export's section layout). */
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

export function planNoteStyleUpgrade(input: UpgradeInput): UpgradePlan {
  const { language } = input;
  const templates = new Namer("template", input.blocks.template, reservedNames("template"));
  const tones = new Namer("tone", input.blocks.tone, reservedNames("tone"));
  const aliases: NoteStyleAliases = {};
  const oldFiles = new Map<string, string>();
  const skipped: string[] = [];
  const toneNameKey = "ui.note_style_upgrade_tone_name_0";

  // Custom tone presets become tone blocks; their ids point at the new files.
  const presetRefs = new Map<string, string>();
  for (const preset of (input.promptPresets ?? []).filter(item => item.kind === "tone")) {
    const base = tones.place(preset.name, preset.id, preset.text);
    presetRefs.set(preset.id, fileRef(base));
    aliases[preset.id] = { tone: fileRef(base) };
  }

  /**
   * The tone block a style file's `語氣` stands for: a built-in tone by name or id (in the words of the interface
   * language), a custom preset's block, else the free text in a block of its own. Absent when the file names no tone.
   */
  const toneRefOf = (raw: string | undefined, fileBase: string): string | undefined => {
    if (!raw) return undefined;
    const key = lower(raw.trim());
    const pools = [language, ...LANGUAGES.map(item => item.id)].map(item =>
      listPresets(input.promptPresets as PromptPreset[] | undefined, "tone", item)
    );
    for (const pool of pools) {
      const found = pool.find(item => lower(item.id) === key || lower(item.name) === key);
      if (!found) continue;
      if (found.id === DEFAULT_TONE_ID) return builtinRef(DEFAULT_TONE_ID);
      if (!isBuiltinPreset(found.id)) return presetRefs.get(found.id);
      // A built-in found in another language's list keeps the words it was found in: its own block.
      const own = pools[0].find(item => item.id === found.id);
      if (own && own.text.trim() === found.text.trim()) return builtinRef(found.id);
      return fileRef(tones.place(translate(language, toneNameKey, fileBase), fileBase, found.text.trim()));
    }
    return fileRef(tones.place(translate(language, toneNameKey, fileBase), fileBase, raw.trim()));
  };

  // Old style files.
  const pairBase = new Map<NoteStyleBuiltinId, string | undefined>(
    NOTE_STYLE_BUILTIN_IDS.map(id => [id, builtinStyleFileBase(input.files, id, language)])
  );
  const blockOfFile = new Map<string, { template: string; tone?: string }>();
  for (const base of [...input.files.keys()].sort()) {
    const text = input.files.get(base)!;
    const pair = NOTE_STYLE_BUILTIN_IDS.find(id => pairBase.get(id) === base);
    if (pair && matchCanonical(text)?.id === pair) {
      oldFiles.set(base, text);
      continue;
    }
    const parsed = parseNoteStyleFile(text, { id: styleAliasKey(base), name: base });
    if (!parsed.ok) {
      skipped.push(base);
      continue;
    }
    const style = parsed.style;
    const format = formatZone(language, style);
    const full = templateText(styleFileBody(text), format, language);
    const check = parseTemplateBlock(full, { id: fileRef(base), name: base });
    if (
      !check.ok ||
      check.lead !== style.intro ||
      check.format !== format ||
      check.template.sections.length !== style.sections.length ||
      check.template.sections.some((section, index) => sectionShape(section) !== sectionShape(style.sections[index]))
    ) {
      skipped.push(base);
      continue;
    }
    const templateRef = fileRef(templates.place(base, base, full));
    const toneRef = toneRefOf(style.tone, base);
    oldFiles.set(base, text);
    blockOfFile.set(base, { template: templateRef, ...(toneRef ? { tone: toneRef } : {}) });
    aliases[styleAliasKey(base)] = { template: templateRef, tone: toneRef ?? builtinRef(DEFAULT_TONE_ID) };
    if (pair) aliases[pairAliasKey(pair)] = { ...aliases[styleAliasKey(base)] };
  }

  // Old custom templates (by id): their exported file when it was read, else the template itself.
  for (const [id, name] of Object.entries(input.noteStyleFiles ?? {})) {
    const converted = blockOfFile.get(stripMd(name));
    if (converted) aliases[id] = { ...converted };
  }
  for (const template of input.detailTemplates) {
    if (has(aliases, template.id)) continue;
    const format = formatZone(language);
    const full = templateText(templateSectionsText(template, language), format, language);
    const check = parseTemplateBlock(full, { id: fileRef(template.name), name: template.name });
    if (
      !check.ok ||
      check.lead ||
      check.format !== format ||
      check.template.sections.length !== template.sections.length ||
      check.template.sections.some((section, index) => sectionShape(section) !== sectionShape(template.sections[index]))
    )
      continue;
    aliases[template.id] = { template: fileRef(templates.place(template.name, "Style", full)) };
  }

  // The old workspace default (what the old resolution would have started from) carried into the new keys.
  const keys: UpgradePlan["keys"] = {};
  const chosen = input.defaultNoteStyleId || input.defaultDetailTemplateId;
  if (chosen) {
    const preset = input.defaultNoteStyleId
      ? NOTE_STYLE_BUILTIN_IDS.find(id => id === input.defaultNoteStyleId)
      : undefined;
    const level = preset
      ? { template: BUILTIN_PAIRS[preset].template, tone: BUILTIN_PAIRS[preset].tone }
      : { template: chosen, tone: undefined as string | undefined };
    let template: string | undefined;
    let tone: string | undefined;
    if (level.template === STANDARD_TEMPLATE_ID || level.template === TEXTBOOK_TEMPLATE_ID) {
      const pair = builtinPairOf(level.template, level.tone);
      const alias = pair ? aliases[pairAliasKey(pair)] : undefined;
      template = alias?.template ?? builtinRef(level.template);
      tone = alias ? alias.tone : level.tone ? builtinRef(level.tone) : undefined;
    } else if (has(aliases, level.template)) {
      template = aliases[level.template].template;
      tone = aliases[level.template].tone;
    }
    if (!input.noteTemplateBlock && template) keys.noteTemplateBlock = template;
    // A workspace template the user already chose keeps working with the tone the old default gave (a built-in style's).
    const toneToSet = input.noteTemplateBlock ? (level.tone ? builtinRef(level.tone) : undefined) : tone;
    if (!input.noteToneBlock && toneToSet) keys.noteToneBlock = toneToSet;
  }

  const blocks = [...templates.planned, ...tones.planned];
  return {
    blocks,
    oldFiles: [...oldFiles].map(([base, text]) => ({ base, text })),
    skipped,
    aliases,
    keys,
    nothing:
      !blocks.length && !oldFiles.size && !Object.keys(aliases).length && !keys.noteTemplateBlock && !keys.noteToneBlock
  };
}
