import { noteLanguageOf, translate, type ContentLanguage, type TranslationKey, type UiLanguage } from "../i18n";
import {
  toneChoiceFromText,
  type BlockChoice,
  type BlockIssue,
  type StyleSelection
} from "../core/steps/task/assemble";
import {
  builtinBlockNames,
  builtinBlockText,
  builtinRef,
  cleanBlockName,
  fileRef,
  isUnmodifiedBlock,
  parseBlockRef,
  resolveBlockFolder,
  uniqueBlockName
} from "../core/blocks/block-files";
import {
  academicToneNote,
  BUILTIN_BLOCKS,
  BUILTIN_FORMATS,
  builtinTemplateText,
  findBuiltinBlock,
  lookupBuiltinFormat,
  stripToneComments,
  type BlockCategory
} from "../core/blocks/builtin";
import { parseTemplateBlock, trimFormatBody, type TemplateNotice } from "../core/blocks/template-block";
import { builtinTemplates, isBuiltinTemplateId, type DetailTemplate } from "./detail-templates";
import { NOTE_STYLE_LIMITS, type NoteStyleIssue } from "./note-style-file";
import { DEFAULT_TONE_ID, findPreset, type PromptPreset } from "./prompt-presets";
import {
  AIM_DELIVERY_STRUCTURE,
  BUILTIN_RECIPES,
  KIND_DEFAULT_RECIPE,
  parseRecipeFile,
  parseRecipeRef,
  partNameOfRef,
  recipeFileText,
  STYLE_KINDS,
  updateRecipeFileText,
  validatePartName,
  type PartCategory,
  type RecipeFileParts,
  type StyleKind,
  type UpdateMode
} from "./note-style-recipe";
import { planRecipeMigration } from "./note-style-migrate";

/**
 * Finds the note style of a run: a style (structure, voice, format and update mode) from the run's choice, the topic or the
 * topic's kind, reading the style, structure, voice and format folders once per run into a snapshot. Writes nothing.
 * With no style folder and no setting, general research gives exactly the fields of a run with no style: prompts stay
 * byte-identical.
 */

/** The vault operations the store needs, so tests can use an in-memory vault. Paths are vault paths. */
export interface StyleFilePort {
  /** Names (with ".md") of the markdown files directly in `folder`; empty when the folder does not exist. */
  list(folder: string): Promise<string[]>;
  read(path: string): Promise<string>;
  folderExists(path: string): boolean;
  createFolder(path: string): Promise<void>;
  /** Creates a new file; must not overwrite. */
  create(path: string, content: string): Promise<void>;
  /** Replaces the text of an existing file. Used only for a style file the user is editing, after its text was compared. */
  modify(path: string, content: string): Promise<void>;
  /** Moves the file to the user's trash (recoverable). */
  trash(path: string): Promise<void>;
}

export interface NoteStyleSettings {
  detailTemplates: DetailTemplate[];
  promptPresets?: PromptPreset[];
  defaultDetailTemplateId?: string;
  defaultNoteStyleId?: string;
  noteStylesFolder?: string;
  noteStyleFiles?: Record<string, string>;
  /** The workspace template block: `builtin:<id>` or `file:<name>` (a file in the Templates block folder). Absent = the old default. */
  noteTemplateBlock?: string;
  /** The workspace tone block: `builtin:<id>` or `file:<name>` (a file in the Tones block folder). Absent = the old default. */
  noteToneBlock?: string;
  /** The style each kind uses (a style ref); a kind with no entry uses its built-in style. */
  noteStyleByKind?: Partial<Record<StyleKind, string>>;
  /** The marker of the conversion to this model, and the old id -> new ref table that implicit styles read. */
  noteStyleRecipe?: {
    migrated: 1;
    mapsNotified?: true;
    legacy?: { templates: Record<string, string>; tones: Record<string, string> };
  };
  workspaceFolder: string;
  language: UiLanguage;
}

/** The stored values of one level the chain looks at. */
export interface StyleLevel {
  /** A style ref: `builtin:<id>` or `file:<name>`. */
  style?: string;
  /** An old (0.28.0) detail template id. */
  template?: string;
  /** An old (0.28.0) tone id. */
  tone?: string;
}

/** What a run asks of the store: the levels it knows (most specific first) and the language its output is written in. */
export interface RunStyleRequest {
  /**
   * This run's own choice. `style` is a whole style; `template` and `tone` (the old dialog) only replace the structure or
   * the voice of whatever the lower levels gave.
   */
  choice?: StyleLevel;
  /** The topic's stored values: `note-style`, else the old `detail-template` and `tone` as an implicit style. */
  topic?: StyleLevel;
  /** The kind of the note ("topic" for a note with no type). */
  kind: StyleKind;
  /** The language the note is written in (the interface language is read from the settings). */
  outputLanguage: ContentLanguage;
}

/** The level a run's style came from. */
export type TemplateSource = "run" | "topic" | "kind";

/** A remark about a style part that changes nothing in its use (an old format zone that is not read). */
export type RunStyleNotice = TemplateNotice & { id: string; fileName?: string };

/** The note style one run uses; a value, nothing in it changes after it is returned. */
export interface RunStyle {
  readonly recipe: Readonly<{
    /** `builtin:<id>`, `file:<name>`, or "legacy" for the implicit style of an old topic. */
    ref: string;
    /** In the interface language. */
    name: string;
    source: TemplateSource;
    implicit?: true;
    /** The AIM report: AIM's own delivery structure; `template` is the Standard stand-in. */
    aimDelivery?: true;
  }>;
  /** In the output language; the built-in stand-in when a part cannot be read. */
  readonly template: DetailTemplate;
  /** Undefined for academic or when no voice text is chosen. */
  readonly toneText?: string;
  /** The format rules text; "" adds no format text. */
  readonly formatText: string;
  readonly updateMode: UpdateMode;
  readonly contextFields: Readonly<{ styleSelection?: StyleSelection }>;
  readonly label: Readonly<{
    /** In the interface language. */
    templateName: string;
    templateSource: TemplateSource;
    /** The name of the voice that `toneText` really is. */
    toneName: string;
    /** The name inside "Keep current (…)". */
    styleName: string;
    /** The file used (with ".md"), for the progress label. */
    fileName?: string;
  }>;
  readonly issues: Readonly<{
    /** Refs that were asked for but could not be used, most specific level first. */
    missing: readonly string[];
    blockIssues: readonly BlockIssue[];
    notices: readonly RunStyleNotice[];
  }>;
}

/** One entry of a block picker. */
export interface BlockListItem {
  /** `builtin:<id>` or `file:<name>`, as stored in the settings. */
  ref: string;
  kind: "builtin" | "file";
  name: string;
  /** The file (with ".md") that holds it: a built-in's override, or the user's own file; absent for a built-in with no file. */
  fileName?: string;
  /** A built-in whose file differs from the built-in text. */
  modified: boolean;
  /** Template blocks only: why the text cannot be read, with lines. */
  issues: NoteStyleIssue[];
}

/** What the conversion of the 0.28.0 data did. `notify` is set once, when maps carried a style that is no longer used. */
export interface MigrationResult {
  status: "already" | "done" | "failed";
  notify?: { maps: string[]; defaultName?: string };
  /** The message of the error behind `failed`, or of the save that could not record the maps on an `already` result. */
  error?: string;
}

/** One part (structure, voice or format) in the manage list. */
export interface PartListItem {
  /** `builtin:<id>` or `file:<name>`. */
  ref: string;
  kind: "builtin" | "file";
  name: string;
  /** The file (with ".md") of a user's part. */
  fileName?: string;
  /** Why the part cannot be used as it is: lines, a name that is a built-in's (decision #22), a structure that does not parse. */
  issues: NoteStyleIssue[];
  /** The names of the styles that use this part. */
  usedBy: string[];
}

/** One style in the manage list. */
export interface RecipeListItem {
  ref: string;
  kind: "builtin" | "file";
  name: string;
  fileName?: string;
  /** The AIM report: only for the AIM kind, and not a copy source. */
  aimOnly?: true;
  structure: { ref: string; name: string };
  voice: { ref: string; name: string };
  format: { ref: string; name: string };
  update: UpdateMode;
  description: string;
  issues: NoteStyleIssue[];
  /** The kinds that use this style: the saved choice, else the kind's built-in style. */
  usedByKinds: StyleKind[];
}

export interface SaveRecipeInput extends RecipeFileParts {
  /** The name of a new style file; ignored when `original` is a user's file (its name stays). */
  name: string;
  /** The style the editor opened, with the file text it read then. */
  original?: { ref: string; text: string };
}
export type SaveRecipeResult = { ok: true; ref: string } | { ok: false; reason: "name" | "changed" | "write-failed" };

const stripMd = (name: string) => name.replace(/\.md$/i, "");
const lower = (value: string) => value.toLocaleLowerCase();

export function defaultStylesFolderName(language: UiLanguage): string {
  return translate(language, "ui.note_styles_folder_name");
}

interface StructurePart {
  template: DetailTemplate;
  /** Set for a structure file: the text is sent so the assembler reads it as written. */
  choice?: BlockChoice;
  /** In the interface language (a file's name for a file). */
  name: string;
  fileName?: string;
  issues: BlockIssue[];
  notices: RunStyleNotice[];
}
interface VoicePart {
  text?: string;
  name: string;
  issues: BlockIssue[];
}
interface FormatPart {
  /** The format rules text as the prompt carries it; "" adds none. */
  text: string;
  /** Absent for the standard format (the prompt's own default). */
  choice?: BlockChoice;
  name: string;
  issues: BlockIssue[];
}
/** A style found for a run, with its parts already read. */
interface Candidate {
  ref: string;
  name: string;
  update: UpdateMode;
  aimDelivery?: true;
  implicit?: true;
  /** The recipe file (with ".md"), for the progress label. */
  fileName?: string;
  structure: StructurePart;
  voice: VoicePart;
  format: FormatPart;
  /** Problems of the recipe file itself (an unreadable update mode). */
  issues: BlockIssue[];
}

export class NoteStyleStore {
  /** Structure (template) and voice (tone) file text by base name (no ".md"), as of the last `refresh()` or write. */
  private blocks: Record<BlockCategory, Map<string, string>> = { template: new Map(), tone: new Map() };
  /** Format rules file text by base name, as of the last `refresh()`. */
  private formats = new Map<string, string>();
  /** Style (recipe) file text by base name, as of the last `refresh()`. */
  private recipes = new Map<string, string>();
  /** Block writes run one after the other, so two quick clicks cannot pick the same name. */
  private writeQueue: Promise<unknown> = Promise.resolve();
  /** The conversion of the 0.28.0 data that is under way (never rejects); `refresh()` waits for it. */
  private migration?: Promise<unknown>;

  constructor(
    private readonly deps: {
      settings: () => NoteStyleSettings;
      port: StyleFilePort;
      save: () => Promise<void>;
      /** The clock for backup names; tests inject one. */
      now?: () => Date;
    }
  ) {}

  private get settings(): NoteStyleSettings {
    return this.deps.settings();
  }

  /** The style folder: the saved setting, else `<workspace>/<localized name>`. */
  folder(): string {
    const settings = this.settings;
    return settings.noteStylesFolder || `${settings.workspaceFolder}/${defaultStylesFolderName(settings.language)}`;
  }

  /**
   * Reads the four folders (styles, structures, voices, formats) once. Call at the start of a run; later calls in the run
   * see this snapshot. Writes nothing.
   */
  async refresh(): Promise<void> {
    // The conversion of the 0.28.0 data writes files: a run must not read the folders half way through it.
    if (this.migration) await this.migration;
    await this.loadBlocks();
  }

  // ---- block files ----

  /** The part folders: each is the first spelling that exists, else the interface language's (where it would be created). */
  private blockDirectories(): Record<"root" | "recipe" | BlockCategory | "format" | "backup", string> {
    const { port } = this.deps;
    const exists = (path: string): boolean => {
      try {
        return port.folderExists(path);
      } catch {
        return false;
      }
    };
    const language = this.settings.language;
    const root = this.folder();
    return {
      root,
      recipe: resolveBlockFolder(root, "recipe", exists, language),
      template: resolveBlockFolder(root, "template", exists, language),
      tone: resolveBlockFolder(root, "tone", exists, language),
      format: resolveBlockFolder(root, "format", exists, language),
      backup: resolveBlockFolder(root, "backup", exists, language)
    };
  }

  /** The text of the markdown files directly in `folder`, by base name. */
  private async readFolder(folder: string): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    let names: string[] = [];
    try {
      names = await this.deps.port.list(folder);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!/\.md$/i.test(name) || name.includes("/")) continue;
      try {
        found.set(stripMd(name), await this.deps.port.read(`${folder}/${name}`));
      } catch {
        /* an unreadable file is simply not a part */
      }
    }
    return found;
  }

  private async loadBlocks(): Promise<void> {
    const dirs = this.blockDirectories();
    const next: Record<BlockCategory, Map<string, string>> = {
      template: await this.readFolder(dirs.template),
      tone: await this.readFolder(dirs.tone)
    };
    this.blocks = next;
    this.formats = await this.readFolder(dirs.format);
    this.recipes = await this.readFolder(dirs.recipe);
  }

  /** The base name of the file that overrides a built-in block, if the block folder holds one (the interface language's name first). */
  private overrideBase(category: BlockCategory, id: string): string | undefined {
    const block = findBuiltinBlock(category, id);
    const names = [translate(this.settings.language, block.nameKey), ...builtinBlockNames(category, id)];
    for (const name of names) {
      const base = [...this.blocks[category].keys()].find(key => lower(key) === lower(name));
      if (base !== undefined) return base;
    }
    return undefined;
  }

  private isBuiltinBlockId(category: BlockCategory, id: string): boolean {
    return BUILTIN_BLOCKS.some(block => block.category === category && block.id === id);
  }

  /** Every block of `category` for the picker: the built-ins first (marked when their file was changed), then the user's own files. */
  listBlocks(category: BlockCategory): BlockListItem[] {
    const language = this.settings.language;
    const map = this.blocks[category];
    const issuesOf = (text: string, id: string, name: string): NoteStyleIssue[] => {
      if (category !== "template") return [];
      const parsed = parseTemplateBlock(text, { id, name });
      return parsed.ok ? [] : parsed.issues;
    };
    const items: BlockListItem[] = [];
    const used = new Set<string>();
    for (const block of BUILTIN_BLOCKS.filter(item => item.category === category)) {
      const base = this.overrideBase(category, block.id);
      const text = base === undefined ? undefined : map.get(base);
      // A tone file is read without its HTML comments, so the note "Edit" writes for academic rigor is no change.
      const modified =
        text !== undefined &&
        !isUnmodifiedBlock(category, block.id, category === "tone" ? stripToneComments(text) : text);
      if (base !== undefined) used.add(base);
      items.push({
        ref: builtinRef(block.id),
        kind: "builtin",
        name: translate(language, block.nameKey),
        ...(base !== undefined ? { fileName: `${base}.md` } : {}),
        modified,
        issues: modified && text !== undefined && base !== undefined ? issuesOf(text, block.id, base) : []
      });
    }
    for (const [base, text] of [...map].sort(([a], [b]) => a.localeCompare(b)))
      if (!used.has(base))
        items.push({
          ref: fileRef(base),
          kind: "file",
          name: base,
          fileName: `${base}.md`,
          modified: false,
          issues: issuesOf(text, fileRef(base), base)
        });
    return items;
  }

  // ---- resolution ----

  /**
   * The note style of a run, as one value: the recipe, the structure, the voice text, the format text, the update mode,
   * the context fields, the names to show and the problems found. Reads only what the last `refresh()` loaded; writes
   * nothing and shows nothing. Never throws: every level that cannot be read is skipped and the kind's built-in style is
   * the last stop.
   */
  runStyle(request: RunStyleRequest): RunStyle {
    const language = request.outputLanguage;
    // A kind this store does not know (a stored value that is not one) counts as the general topic kind.
    const kind: StyleKind = STYLE_KINDS.includes(request.kind) ? request.kind : "topic";
    const missing: string[] = [];
    const miss = (ref: string): void => {
      if (!missing.includes(ref)) missing.push(ref);
    };
    const tryRef = (ref: string | undefined): Candidate | undefined => {
      if (!ref) return undefined;
      const found = this.recipeFromRef(ref, kind, language);
      if (!found) miss(ref);
      return found;
    };
    let source: TemplateSource = "run";
    let chosen = tryRef(request.choice?.style);
    if (!chosen) {
      source = "topic";
      chosen = tryRef(request.topic?.style) ?? this.implicitRecipe(request.topic, kind, language, miss);
    }
    if (!chosen) {
      source = "kind";
      const saved = this.settings.noteStyleByKind;
      const own = saved && Object.prototype.hasOwnProperty.call(saved, kind) ? saved[kind] : undefined;
      chosen =
        tryRef(typeof own === "string" ? own : undefined) ??
        this.recipeFromRef(KIND_DEFAULT_RECIPE[kind], kind, language)!;
    }
    return this.assemble(chosen, source, missing, language, request.choice);
  }

  /**
   * The value of a style from the candidate that was chosen: the old dialog's structure and voice (`choice`) only replace
   * that part of what the lower levels gave. Shared by `runStyle` and `draftStyle`, so both give the same shape.
   */
  private assemble(
    chosen: Candidate,
    sourceOf: TemplateSource,
    missing: string[],
    language: ContentLanguage,
    choice?: StyleLevel
  ): RunStyle {
    let source = sourceOf;
    let { structure, voice } = chosen;
    let aimDelivery = chosen.aimDelivery;
    if (choice?.template) {
      const replaced = this.legacyStructure(choice.template, language, true);
      if (replaced) {
        structure = replaced;
        aimDelivery = undefined;
        source = "run";
      } else if (!missing.includes(choice.template)) missing.push(choice.template);
    }
    if (choice?.tone) {
      const replaced = this.legacyVoice(choice.tone, language, true);
      if (replaced) {
        voice = replaced;
        source = "run";
      }
    }
    const { format } = chosen;
    const needsSelection = structure.choice !== undefined || format.choice !== undefined;
    const contextFields = needsSelection
      ? {
          styleSelection: Object.freeze({
            template: Object.freeze({ ...(structure.choice ?? { id: structure.template.id }) }),
            tone: Object.freeze(toneChoiceFromText(voice.text, language)),
            ...(format.choice ? { format: Object.freeze({ ...format.choice }) } : {})
          })
        }
      : {};
    const fileName = chosen.fileName ?? structure.fileName;
    return Object.freeze({
      recipe: Object.freeze({
        ref: chosen.ref,
        name: chosen.name,
        source,
        ...(chosen.implicit ? { implicit: true as const } : {}),
        ...(aimDelivery ? { aimDelivery: true as const } : {})
      }),
      template: structure.template,
      ...(voice.text ? { toneText: voice.text } : {}),
      formatText: format.text,
      updateMode: chosen.update,
      contextFields: Object.freeze(contextFields),
      label: Object.freeze({
        templateName: aimDelivery ? chosen.name : structure.name,
        templateSource: source,
        toneName: voice.name,
        styleName: chosen.name,
        ...(fileName ? { fileName } : {})
      }),
      issues: Object.freeze({
        missing: Object.freeze([...missing]),
        blockIssues: Object.freeze([...chosen.issues, ...structure.issues, ...voice.issues, ...format.issues]),
        notices: Object.freeze([...structure.notices])
      })
    });
  }

  /** A style ref as a candidate, or undefined when it cannot be read (not a ref, no such file, `builtin:aim` outside AIM). */
  private recipeFromRef(ref: string, kind: StyleKind, language: ContentLanguage): Candidate | undefined {
    const parsed = parseRecipeRef(ref, "recipe");
    if (!parsed) return undefined;
    if (parsed.kind === "builtin") {
      const recipe = BUILTIN_RECIPES.find(item => item.id === parsed.id);
      if (!recipe || (recipe.id === "aim" && kind !== "aim")) return undefined;
      const aim = recipe.structure === AIM_DELIVERY_STRUCTURE;
      return {
        ref,
        name: translate(this.settings.language, recipe.nameKey),
        update: recipe.update,
        ...(aim ? { aimDelivery: true as const } : {}),
        structure: this.structurePart(`builtin:${aim ? "standard" : recipe.structure}`, language)!,
        voice: this.voicePart(`builtin:${recipe.voice}`, language)!,
        format: this.formatPart(`builtin:${recipe.format}`, language)!,
        issues: []
      };
    }
    const text = this.recipes.get(parsed.name);
    if (text === undefined) return undefined;
    const file = parseRecipeFile(text);
    const fileName = `${parsed.name}.md`;
    const issues: BlockIssue[] = file.issues.map((issue): BlockIssue => ({
      ...issue,
      code: issue.code.startsWith("ui.") ? issue.code : `ui.note_style_issue_${issue.code}`,
      category: "template",
      id: ref,
      fileName
    }));
    return {
      ref,
      name: parsed.name,
      update: file.update,
      fileName,
      ...this.fileParts(ref, fileName, file, file.lines, language),
      issues
    };
  }

  /**
   * The three parts a style file names, each read; a part that cannot be found is the built-in stand-in with an issue at
   * the line of its key (`lines`). Shared by a style file and by a draft that is not saved yet.
   */
  private fileParts(
    ref: string,
    fileName: string,
    file: Pick<RecipeFileParts, "structure" | "voice" | "format">,
    lines: Partial<Record<PartCategory | "update", number>>,
    language: ContentLanguage
  ): { structure: StructurePart; voice: VoicePart; format: FormatPart } {
    const missingPart = (category: PartCategory, partRef: string): BlockIssue => ({
      line: lines[category] ?? 1,
      code: "ui.note_style_issue_part_missing",
      values: [partRef.replace(/^(?:file|builtin):/, "")],
      message: `The ${category} "${partRef}" was not found; the built-in one is used.`,
      category: "template",
      id: ref,
      fileName
    });
    const withIssue = <T extends { issues: BlockIssue[] }>(part: T, issue: BlockIssue): T => ({
      ...part,
      issues: [issue, ...part.issues]
    });
    return {
      structure:
        this.structurePart(file.structure, language) ??
        withIssue(this.structurePart("builtin:standard", language)!, missingPart("structure", file.structure)),
      voice:
        this.voicePart(file.voice, language) ??
        withIssue(this.voicePart("builtin:academic", language)!, missingPart("voice", file.voice)),
      format:
        this.formatPart(file.format, language) ??
        withIssue(this.formatPart("builtin:standard", language)!, missingPart("format", file.format))
    };
  }

  /**
   * The style an old topic stands for when it has no `note-style`: its `detail-template` and `tone`. A part with no stored
   * value is the same part of the kind's built-in style; a stored id that names nothing is Standard (structure) or
   * academic rigor (voice). Undefined when the topic has neither key.
   */
  private implicitRecipe(
    topic: StyleLevel | undefined,
    kind: StyleKind,
    language: ContentLanguage,
    miss: (ref: string) => void
  ): Candidate | undefined {
    const templateId = topic?.template || undefined;
    const toneId = topic?.tone || undefined;
    if (!templateId && !toneId) return undefined;
    let structure: StructurePart | undefined;
    if (templateId) {
      structure = this.legacyStructure(templateId, language);
      if (!structure) miss(templateId);
    } else {
      const own = BUILTIN_RECIPES.find(item => `builtin:${item.id}` === KIND_DEFAULT_RECIPE[kind])?.structure;
      structure = this.structurePart(`builtin:${own && own !== AIM_DELIVERY_STRUCTURE ? own : "standard"}`, language);
    }
    const voice =
      (toneId ? this.legacyVoice(toneId, language) : undefined) ?? this.voicePart("builtin:academic", language)!;
    const resolvedStructure = structure ?? this.structurePart("builtin:standard", language)!;
    return {
      ref: "legacy",
      name: translate(this.settings.language, "ui.note_style_legacy_0_1", resolvedStructure.name, voice.name),
      update: "merge",
      implicit: true,
      structure: resolvedStructure,
      voice,
      format: this.formatPart("builtin:standard", language)!,
      issues: []
    };
  }

  /**
   * An old detail template id as a structure: the conversion table, then a built-in id, then a custom template (read only).
   * With `refs` (the old dialog of a run) a part ref such as `file:<name>` is read too.
   */
  private legacyStructure(id: string, language: ContentLanguage, refs = false): StructurePart | undefined {
    const mapped = this.settings.noteStyleRecipe?.legacy?.templates;
    if (mapped && Object.prototype.hasOwnProperty.call(mapped, id)) {
      const part = this.structurePart(mapped[id], language);
      if (part) return part;
    }
    if (BUILTIN_BLOCKS.some(block => block.category === "template" && block.id === id))
      return this.structurePart(`builtin:${id}`, language);
    const custom = this.settings.detailTemplates.find(template => template.id === id);
    if (!custom && refs) return this.structurePart(id, language);
    return custom ? { template: custom, name: custom.name, issues: [], notices: [] } : undefined;
  }

  /**
   * An old tone id as a voice: the conversion table, then a built-in id, then a custom tone preset (read only). With `refs`
   * (the old dialog of a run) a part ref such as `file:<name>` is read too.
   */
  private legacyVoice(id: string, language: ContentLanguage, refs = false): VoicePart | undefined {
    const mapped = this.settings.noteStyleRecipe?.legacy?.tones;
    if (mapped && Object.prototype.hasOwnProperty.call(mapped, id)) {
      const part = this.voicePart(mapped[id], language);
      if (part) return part;
    }
    if (BUILTIN_BLOCKS.some(block => block.category === "tone" && block.id === id))
      return this.voicePart(`builtin:${id}`, language);
    const preset = findPreset(this.settings.promptPresets, "tone", id, language);
    if (!preset && refs) return this.voicePart(id, language);
    return preset
      ? {
          text: preset.id === DEFAULT_TONE_ID ? undefined : preset.text.trim() || undefined,
          name: preset.name,
          issues: []
        }
      : undefined;
  }

  private issueOf(
    ref: string,
    fileName: string,
    code: "file_long",
    values: (string | number)[],
    message: string
  ): BlockIssue {
    return { line: 1, code, values, message, category: "template", id: ref, fileName };
  }

  /** A structure part: a built-in by id, or a structure file. Undefined when the ref or the file cannot be found. */
  private structurePart(ref: string, language: ContentLanguage): StructurePart | undefined {
    const parsed = parseRecipeRef(ref, "structure");
    if (!parsed) return undefined;
    if (parsed.kind === "builtin") {
      const block = BUILTIN_BLOCKS.find(item => item.category === "template" && item.id === parsed.id);
      if (!block) return undefined;
      const name = translate(this.settings.language, block.nameKey);
      if (isBuiltinTemplateId(block.id)) {
        const template = builtinTemplates(noteLanguageOf(language), language).find(item => item.id === block.id)!;
        return { template, name, issues: [], notices: [] };
      }
      const built = parseTemplateBlock(builtinTemplateText(block.id, language), { id: block.id, name });
      if (!built.ok) throw new Error(`Built-in template ${block.id} does not parse`);
      return { template: { ...built.template }, name, issues: [], notices: [] };
    }
    const text = this.blocks.template.get(parsed.name);
    if (text === undefined) return undefined;
    const fileName = `${parsed.name}.md`;
    const choice: BlockChoice = { id: ref, body: text, fileName };
    const read = parseTemplateBlock(text, { id: ref, name: parsed.name });
    if (read.ok)
      return {
        template: { ...read.template },
        choice,
        name: parsed.name,
        fileName,
        issues: [],
        notices: read.notices.map((notice): RunStyleNotice => ({ ...notice, id: ref, fileName }))
      };
    return {
      template: builtinTemplates(noteLanguageOf(language), language)[0],
      choice,
      name: parsed.name,
      fileName,
      issues: read.issues.map((issue): BlockIssue => ({ ...issue, category: "template", id: ref, fileName })),
      notices: []
    };
  }

  /** A voice part: a built-in by id (academic rigor adds no text), or a voice file read without its HTML comments. */
  private voicePart(ref: string, language: ContentLanguage): VoicePart | undefined {
    const parsed = parseRecipeRef(ref, "voice");
    if (!parsed) return undefined;
    if (parsed.kind === "builtin") {
      const block = BUILTIN_BLOCKS.find(item => item.category === "tone" && item.id === parsed.id);
      if (!block) return undefined;
      return {
        text: block.id === DEFAULT_TONE_ID ? undefined : block.body(language).trim() || undefined,
        name: translate(this.settings.language, block.nameKey),
        issues: []
      };
    }
    const raw = this.blocks.tone.get(parsed.name);
    if (raw === undefined) return undefined;
    if (raw.length > NOTE_STYLE_LIMITS.file) {
      const fallback = this.voicePart("builtin:academic", language)!;
      const fileName = `${parsed.name}.md`;
      return {
        ...fallback,
        issues: [
          this.issueOf(
            ref,
            fileName,
            "file_long",
            [NOTE_STYLE_LIMITS.file],
            `The file is over ${NOTE_STYLE_LIMITS.file} characters.`
          )
        ]
      };
    }
    return { text: stripToneComments(raw).trim() || undefined, name: parsed.name, issues: [] };
  }

  /** A format part: a built-in by id, or a format file (blank lines at both ends removed; an empty file adds no text). */
  private formatPart(ref: string, language: ContentLanguage): FormatPart | undefined {
    const parsed = parseRecipeRef(ref, "format");
    if (!parsed) return undefined;
    if (parsed.kind === "builtin") {
      const format = BUILTIN_FORMATS.find(item => item.id === parsed.id);
      if (!format) return undefined;
      return {
        text: lookupBuiltinFormat(format.id, language),
        ...(format.id === "standard" ? {} : { choice: { id: format.id } }),
        name: translate(this.settings.language, format.nameKey),
        issues: []
      };
    }
    const raw = this.formats.get(parsed.name);
    if (raw === undefined) return undefined;
    const fileName = `${parsed.name}.md`;
    if (raw.length > NOTE_STYLE_LIMITS.file)
      return {
        ...this.formatPart("builtin:standard", language)!,
        issues: [
          this.issueOf(
            ref,
            fileName,
            "file_long",
            [NOTE_STYLE_LIMITS.file],
            `The file is over ${NOTE_STYLE_LIMITS.file} characters.`
          )
        ]
      };
    return {
      text: trimFormatBody(raw),
      choice: { id: ref, body: raw, fileName },
      name: parsed.name,
      issues: []
    };
  }

  // ---- the tone choices of the map pickers ----

  /** The tones a map, topic or run can pick: the built-in tones (by tone id) and the tone blocks (`file:<name>`). Call `refresh()` first. */
  toneChoices(): { id: string; name: string }[] {
    return this.listBlocks("tone").map(item => {
      const parsed = parseBlockRef(item.ref);
      return { id: parsed?.kind === "builtin" ? parsed.id : item.ref, name: item.name };
    });
  }

  // ---- writing block files (only on a user action; a file is never overwritten) ----

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private takenNames(category: BlockCategory): Set<string> {
    return new Set([...this.blocks[category].keys()].map(lower));
  }

  /**
   * Remembers the style folder in the settings when it has no saved path, so a later change of interface language does
   * not move it. A saved path is never replaced. Call it before anything is created in the folder.
   */
  private async pinFolder(): Promise<void> {
    if (this.settings.noteStylesFolder) return;
    this.settings.noteStylesFolder = this.folder();
    await this.deps.save();
  }

  /**
   * Creates the block folders (Templates and Tones) when they are missing, and remembers the style folder in the settings
   * so a later change of interface language does not move it. Writes no block file. Returns the block folder.
   */
  ensureBlockFolder(): Promise<string> {
    return this.serial(async () => {
      const { port } = this.deps;
      await this.pinFolder();
      const dirs = this.blockDirectories();
      for (const path of [dirs.root, dirs.template, dirs.tone]) await port.createFolder(path);
      return dirs.root;
    });
  }

  /**
   * The path of the file behind a block, so it can be opened. A built-in with no file gets one, written with its text in
   * the interface language; a file that is there is left as it is. Throws for a file block that no longer exists.
   */
  ensureBlockFile(category: BlockCategory, ref: string): Promise<{ path: string; base: string; created: boolean }> {
    return this.serial(async () => {
      await this.loadBlocks();
      const parsed = parseBlockRef(ref);
      const dir = this.blockDirectories()[category];
      if (parsed?.kind === "file") {
        if (!this.blocks[category].has(parsed.base)) throw new Error(`Block file not found: ${parsed.base}`);
        return { path: `${dir}/${parsed.base}.md`, base: parsed.base, created: false };
      }
      if (parsed?.kind !== "builtin" || !this.isBuiltinBlockId(category, parsed.id))
        throw new Error(`Unknown block: ${ref}`);
      const override = this.overrideBase(category, parsed.id);
      if (override !== undefined) return { path: `${dir}/${override}.md`, base: override, created: false };
      const language = this.settings.language;
      const block = findBuiltinBlock(category, parsed.id);
      const base = uniqueBlockName(
        cleanBlockName(translate(language, block.nameKey)) || parsed.id,
        this.takenNames(category)
      );
      // Academic rigor has no text of its own: its file holds only a note (see academicToneNote).
      const text =
        category === "tone" && parsed.id === "academic"
          ? academicToneNote(language)
          : builtinBlockText(category, parsed.id, language);
      await this.pinFolder();
      await this.deps.port.createFolder(dir);
      await this.deps.port.create(`${dir}/${base}.md`, text);
      this.blocks[category].set(base, text);
      return { path: `${dir}/${base}.md`, base, created: true };
    });
  }

  // ---- the custom note styles: what the manage page and the style editor read and write (note-style-recipe T5) ----

  /** The cache and the folder of a part category. */
  private partStore(category: PartCategory): { files: Map<string, string>; dir: string } {
    const dirs = this.blockDirectories();
    if (category === "structure") return { files: this.blocks.template, dir: dirs.template };
    if (category === "voice") return { files: this.blocks.tone, dir: dirs.tone };
    return { files: this.formats, dir: dirs.format };
  }

  /** The styles (built-in and the user's files) that use `ref` as their part of `category`, by name. */
  private stylesUsing(category: PartCategory, ref: string): string[] {
    const names: string[] = [];
    for (const recipe of BUILTIN_RECIPES) {
      const own =
        recipe.structure === AIM_DELIVERY_STRUCTURE && category === "structure" ? undefined : recipe[category];
      if (own !== undefined && `builtin:${own}` === ref) names.push(translate(this.settings.language, recipe.nameKey));
    }
    for (const [base, text] of [...this.recipes].sort(([a], [b]) => a.localeCompare(b)))
      if (parseRecipeFile(text)[category] === ref) names.push(base);
    return names;
  }

  /**
   * Every part of `category` (structure, voice or format): the built-ins first, then the user's files. A file named like a
   * built-in (any language) is listed as the user's file it is, with an issue: it is not used (decision #22). Reads only
   * what the last `refresh()` loaded.
   */
  listParts(category: PartCategory): PartListItem[] {
    const language = this.settings.language;
    const { files } = this.partStore(category);
    const builtins: { id: string; nameKey: TranslationKey }[] =
      category === "format"
        ? BUILTIN_FORMATS.map(({ id, nameKey }) => ({ id, nameKey }))
        : BUILTIN_BLOCKS.filter(block => block.category === (category === "structure" ? "template" : "tone")).map(
            ({ id, nameKey }) => ({ id, nameKey })
          );
    const items: PartListItem[] = builtins.map(({ id, nameKey }) => ({
      ref: builtinRef(id),
      kind: "builtin",
      name: translate(language, nameKey),
      issues: [],
      usedBy: this.stylesUsing(category, builtinRef(id))
    }));
    for (const [base, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      const issues: NoteStyleIssue[] = [];
      const check = validatePartName(base, category);
      if (!check.ok)
        issues.push({
          line: 1,
          code: check.reason === "builtin" ? "builtin_name" : "part_name_invalid",
          values: [base],
          message:
            check.reason === "builtin"
              ? `"${base}" is a built-in name, so this file is not used. Rename it.`
              : `"${base}" cannot be used as a part name.`
        });
      if (category === "structure") {
        const parsed = parseTemplateBlock(text, { id: fileRef(base), name: base });
        if (!parsed.ok) issues.push(...parsed.issues);
      }
      items.push({
        ref: fileRef(base),
        kind: "file",
        name: base,
        fileName: `${base}.md`,
        issues,
        usedBy: this.stylesUsing(category, fileRef(base))
      });
    }
    return items;
  }

  /** Every style: the built-ins (the AIM report marked `aimOnly`), then the user's style files. */
  listRecipes(): RecipeListItem[] {
    const language = this.settings.language;
    const stored = this.settings.noteStyleByKind;
    const kindsOf = (ref: string): StyleKind[] =>
      STYLE_KINDS.filter(kind => {
        const own = stored && Object.prototype.hasOwnProperty.call(stored, kind) ? stored[kind] : undefined;
        return (typeof own === "string" ? own : KIND_DEFAULT_RECIPE[kind]) === ref;
      });
    const partOf = (category: PartCategory, ref: string): { ref: string; name: string } => {
      try {
        return { ref, name: partNameOfRef(category, ref, language) };
      } catch {
        return { ref, name: ref };
      }
    };
    const items: RecipeListItem[] = BUILTIN_RECIPES.map(recipe => {
      const aim = recipe.structure === AIM_DELIVERY_STRUCTURE;
      const ref = builtinRef(recipe.id);
      return {
        ref,
        kind: "builtin",
        name: translate(language, recipe.nameKey),
        ...(aim ? { aimOnly: true as const } : {}),
        structure: aim
          ? { ref: recipe.structure, name: translate(language, recipe.nameKey) }
          : partOf("structure", builtinRef(recipe.structure)),
        voice: partOf("voice", builtinRef(recipe.voice)),
        format: partOf("format", builtinRef(recipe.format)),
        update: recipe.update,
        description: "",
        issues: [],
        usedByKinds: kindsOf(ref)
      };
    });
    for (const [base, text] of [...this.recipes].sort(([a], [b]) => a.localeCompare(b))) {
      const file = parseRecipeFile(text);
      const issues: NoteStyleIssue[] = [...file.issues];
      const check = validatePartName(base, "recipe");
      if (!check.ok)
        issues.push({
          line: 1,
          code: check.reason === "builtin" ? "builtin_name" : "part_name_invalid",
          values: [base],
          message:
            check.reason === "builtin"
              ? `"${base}" is a built-in name, so this file is not used. Rename it.`
              : `"${base}" cannot be used as a style name.`
        });
      const present: Record<PartCategory, (name: string) => boolean> = {
        structure: name => this.blocks.template.has(name),
        voice: name => this.blocks.tone.has(name),
        format: name => this.formats.has(name)
      };
      for (const category of ["structure", "voice", "format"] as const) {
        const parsed = parseRecipeRef(file[category], category);
        if (parsed?.kind === "file" && !present[category](parsed.name))
          issues.push({
            line: file.lines[category] ?? 1,
            code: "part_missing",
            values: [parsed.name],
            message: `The ${category} "${parsed.name}" was not found; the built-in one is used.`
          });
      }
      const ref = fileRef(base);
      items.push({
        ref,
        kind: "file",
        name: base,
        fileName: `${base}.md`,
        structure: partOf("structure", file.structure),
        voice: partOf("voice", file.voice),
        format: partOf("format", file.format),
        update: file.update,
        description: file.description,
        issues,
        usedByKinds: kindsOf(ref)
      });
    }
    return items;
  }

  /** The text of a user's style file as the last `refresh()` or write left it (what the editor compares before it saves). */
  recipeText(ref: string): string | undefined {
    const parsed = parseRecipeRef(ref, "recipe");
    return parsed?.kind === "file" ? this.recipes.get(parsed.name) : undefined;
  }

  /** The vault path of a user's part file, or undefined for a built-in or a file that is not there. */
  partFilePath(category: PartCategory, ref: string): string | undefined {
    const parsed = parseRecipeRef(ref, category);
    if (parsed?.kind !== "file") return undefined;
    const { files, dir } = this.partStore(category);
    return files.has(parsed.name) ? `${dir}/${parsed.name}.md` : undefined;
  }

  /** The vault path of a user's style file, or undefined for a built-in or a file that is not there. */
  recipeFilePath(ref: string): string | undefined {
    const parsed = parseRecipeRef(ref, "recipe");
    return parsed?.kind === "file" && this.recipes.has(parsed.name)
      ? `${this.blockDirectories().recipe}/${parsed.name}.md`
      : undefined;
  }

  /**
   * The name a new part file gets by default: "My <name>" for a copy of a part (a built-in's name in the interface
   * language, or a file's name), the language's "New structure/voice/format" for a blank one; " (2)", " (3)" ... until it
   * is free and is not a built-in's name. Writes nothing.
   */
  suggestPartName(category: PartCategory, from: string | null): string {
    const language = this.settings.language;
    let base: string;
    if (from === null) base = translate(language, `ui.part_new_name_${category}`);
    else {
      const parsed = parseRecipeRef(from, category);
      const source = parsed?.kind === "file" ? parsed.name : parsed ? partNameOfRef(category, from, language) : from;
      base = translate(language, "ui.block_copy_name_0", cleanBlockName(source));
    }
    base = cleanBlockName(base) || "copy";
    const taken = new Set([...this.partStore(category).files.keys()].map(lower));
    let name = base;
    for (let n = 2; taken.has(lower(name)) || !validatePartName(name, category).ok; n++) {
      if (n > 999) throw new Error("No free name");
      name = `${base} (${n})`;
    }
    return name;
  }

  /**
   * Writes a new part file of `category` and returns its ref (`file:<name>`); no setting changes. `from` is a built-in ref
   * (its text in the interface language; academic rigor starts from its design note), a file ref (a copy of that file) or
   * null (a blank start). Without `name` the file gets `suggestPartName`; with one it must pass `validatePartName`, be free
   * and be a safe file name, else this throws and nothing is written.
   */
  createPart(category: PartCategory, from: string | null, name?: string): Promise<string> {
    return this.serial(async () => {
      await this.loadBlocks();
      const language = this.settings.language;
      let text: string;
      if (from === null) text = category === "structure" ? translate(language, "ui.part_blank_structure") : "";
      else {
        const parsed = parseRecipeRef(from, category);
        if (parsed?.kind === "file") {
          const held = this.partStore(category).files.get(parsed.name);
          if (held === undefined) throw new Error(`Part file not found: ${parsed.name}`);
          text = held;
        } else if (parsed?.kind === "builtin") {
          if (category === "format") text = lookupBuiltinFormat(parsed.id, language);
          else if (category === "voice" && parsed.id === "academic") text = academicToneNote(language);
          else text = builtinBlockText(category === "structure" ? "template" : "tone", parsed.id, language);
        } else throw new Error(`Unknown part: ${from}`);
      }
      const { files, dir } = this.partStore(category);
      let base: string;
      if (name === undefined) base = this.suggestPartName(category, from);
      else {
        base = name;
        if (
          !validatePartName(base, category).ok ||
          cleanBlockName(base) !== base ||
          files.has(base) ||
          [...files.keys()].some(key => lower(key) === lower(base))
        )
          throw new Error(`Part name not available: ${name}`);
      }
      await this.pinFolder();
      await this.deps.port.createFolder(dir);
      await this.deps.port.create(`${dir}/${base}.md`, text);
      files.set(base, text);
      return fileRef(base);
    });
  }

  /**
   * Saves a style. A new style (no `original`, or one whose ref is a built-in) is a new file named `name`. An existing
   * user's style file (`original.ref` a file) is changed in place: its name stays, only the four values change, and nothing
   * is written when the file no longer holds `original.text` (the user changed it meanwhile).
   */
  saveRecipe(input: SaveRecipeInput): Promise<SaveRecipeResult> {
    return this.serial(async (): Promise<SaveRecipeResult> => {
      const parts: RecipeFileParts = {
        structure: input.structure,
        voice: input.voice,
        format: input.format,
        update: input.update
      };
      const language = this.settings.language;
      const { port } = this.deps;
      await this.loadBlocks();
      const dirs = this.blockDirectories();
      const original = input.original ? parseRecipeRef(input.original.ref, "recipe") : undefined;
      if (input.original && original?.kind === "file") {
        const path = `${dirs.recipe}/${original.name}.md`;
        let live: string;
        try {
          if (!this.recipes.has(original.name)) return { ok: false, reason: "write-failed" };
          live = await port.read(path);
        } catch {
          return { ok: false, reason: "write-failed" };
        }
        if (live !== input.original.text) return { ok: false, reason: "changed" };
        try {
          const next = updateRecipeFileText(live, parts, language);
          if (next !== live) await port.modify(path, next);
          this.recipes.set(original.name, next);
        } catch {
          return { ok: false, reason: "write-failed" };
        }
        return { ok: true, ref: fileRef(original.name) };
      }
      const name = input.name;
      if (
        !validatePartName(name, "recipe").ok ||
        cleanBlockName(name) !== name ||
        [...this.recipes.keys()].some(key => lower(key) === lower(name))
      )
        return { ok: false, reason: "name" };
      try {
        const text = recipeFileText(parts, language);
        await this.pinFolder();
        await port.createFolder(dirs.recipe);
        await port.create(`${dirs.recipe}/${name}.md`, text);
        this.recipes.set(name, text);
      } catch {
        return { ok: false, reason: "write-failed" };
      }
      return { ok: true, ref: fileRef(name) };
    });
  }

  /**
   * The style a draft (not saved) would give a run of `kind`, in the same shape as `runStyle` and from the same code: for
   * the same parts, it equals `runStyle` of the style file `saveRecipe` would write. Reads only the loaded cache.
   */
  draftStyle(draft: RecipeFileParts & { name: string }, kind: StyleKind, language: ContentLanguage): RunStyle {
    const ref = fileRef(draft.name);
    const fileName = `${draft.name}.md`;
    const chosen: Candidate = {
      ref,
      name: draft.name,
      update: draft.update,
      fileName,
      ...this.fileParts(ref, fileName, draft, {}, language),
      issues: []
    };
    // A draft is a whole style of its own, like a run's own choice: no lower level applies, whatever the kind.
    void kind;
    return this.assemble(chosen, "run", [], language);
  }

  // ---- the conversion of the 0.28.0 data (the only write that is not a user action) ----

  /**
   * Turns the custom detail templates and tone presets of 0.28.0 into structure, voice and style files, and records the old
   * id -> new ref table, once: the marker `noteStyleRecipe.migrated` ends it. Only new files are created (a file that holds
   * the same text is reused, other text gets " (n)"), no old key is changed, and the files, the folder, the general-topic
   * style and the marker reach data.json in one save. A failure sets no marker and leaves the settings as they were; files
   * already written stay and are reused by the next try. Never rejects. `mapsWithStyle` are the titles of maps that carry a
   * style of their own: they are handed back once (`notify`) because that style is not read any more.
   */
  migrateLegacy(input: { mapsWithStyle: string[] }): Promise<MigrationResult> {
    const run = this.serial(() => this.runMigration(input.mapsWithStyle));
    const fence: Promise<unknown> = run
      .catch(() => undefined)
      .then(() => {
        if (this.migration === fence) this.migration = undefined;
      });
    this.migration = fence;
    return run;
  }

  private async runMigration(mapsWithStyle: string[]): Promise<MigrationResult> {
    const settings = this.settings;
    const maps = [...mapsWithStyle];
    try {
      const marker = settings.noteStyleRecipe;
      if (marker?.migrated) {
        if (marker.mapsNotified) return { status: "already" };
        // The maps are looked at once: this save is that record.
        settings.noteStyleRecipe = { ...marker, mapsNotified: true };
        try {
          await this.deps.save();
        } catch (error) {
          // The conversion itself finished earlier: only the record of the maps is missing, so it is tried again next load.
          settings.noteStyleRecipe = marker;
          return { status: "already", error: error instanceof Error ? error.message : String(error) };
        }
        return { status: "already", ...(maps.length ? { notify: { maps } } : {}) };
      }
      await this.loadBlocks();
      const plan = planRecipeMigration({
        language: settings.language,
        detailTemplates: settings.detailTemplates,
        promptPresets: settings.promptPresets,
        defaultDetailTemplateId: settings.defaultDetailTemplateId,
        noteStyleByKind: settings.noteStyleByKind,
        existing: { recipe: this.recipes, template: this.blocks.template, tone: this.blocks.tone }
      });
      const { port } = this.deps;
      const dirs = this.blockDirectories();
      // The folders are about to be made: the path they get is the one kept, whatever the interface language becomes.
      const pinned = settings.noteStylesFolder ? undefined : this.folder();
      for (const category of ["template", "tone", "recipe"] as const) {
        const items = plan.files.filter(file => file.category === category);
        if (!items.length) continue;
        const dir = dirs[category];
        await port.createFolder(dir);
        // Looked at again right before writing: a file that showed up meanwhile is never written over.
        const present = await this.readFolder(dir);
        for (const item of items) {
          const held = [...present].find(([base]) => lower(base) === lower(item.base));
          if (held) {
            if (held[1] === item.text) continue;
            throw new Error(`File appeared while converting: ${dir}/${item.base}.md`);
          }
          await port.create(`${dir}/${item.base}.md`, item.text);
        }
      }
      // data.json: the folder, the general-topic style and the marker in one save; undone when the save fails.
      const before = {
        noteStylesFolder: settings.noteStylesFolder,
        noteStyleByKind: settings.noteStyleByKind,
        noteStyleRecipe: settings.noteStyleRecipe
      };
      if (pinned !== undefined && plan.files.length) settings.noteStylesFolder = pinned;
      if (plan.topicStyle && !settings.noteStyleByKind?.topic)
        settings.noteStyleByKind = { ...settings.noteStyleByKind, topic: plan.topicStyle };
      const hasLegacy = Object.keys(plan.legacy.templates).length > 0 || Object.keys(plan.legacy.tones).length > 0;
      settings.noteStyleRecipe = { migrated: 1, ...(hasLegacy ? { legacy: plan.legacy } : {}), mapsNotified: true };
      try {
        await this.deps.save();
      } catch (error) {
        for (const [key, value] of Object.entries(before)) {
          if (value === undefined) delete settings[key as keyof typeof before];
          else (settings as unknown as Record<string, unknown>)[key] = value;
        }
        throw error;
      }
      return {
        status: "done",
        ...(maps.length
          ? { notify: { maps, ...(plan.defaultConverted ? { defaultName: plan.defaultConverted } : {}) } }
          : {})
      };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The style folder itself was renamed or moved in Obsidian: follow it. Returns true when the setting changed. */
  async followFolderRename(oldPath: string, newPath: string): Promise<boolean> {
    if (oldPath !== this.folder()) return false;
    this.settings.noteStylesFolder = newPath;
    await this.deps.save();
    return true;
  }

  /** Whether the style folder exists (settings page shows "folder not found" when it does not). */
  folderExists(): boolean {
    return this.deps.port.folderExists(this.folder());
  }
}
/** A store over a vault with no style folder: every answer equals the old template and tone resolution. */
export function emptyNoteStyleStore(settings: () => NoteStyleSettings): NoteStyleStore {
  return new NoteStyleStore({
    settings,
    port: {
      list: async () => [],
      read: () => Promise.reject(new Error("no style files")),
      folderExists: () => false,
      createFolder: async () => undefined,
      create: async () => undefined,
      modify: async () => undefined,
      trash: async () => undefined
    },
    save: async () => undefined
  });
}
