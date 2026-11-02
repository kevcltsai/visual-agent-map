import { LANGUAGES, noteLanguageOf, translate, type ContentLanguage, type UiLanguage } from "../i18n";
import type { TaskContext } from "./types";
import {
  toneChoiceFromText,
  type BlockChoice,
  type BlockIssue,
  type StyleSelection
} from "../core/steps/task/assemble";
import {
  backupName,
  builtinBlockNames,
  builtinBlockText,
  builtinRef,
  cleanBlockName,
  copyBlockName,
  fileRef,
  isUnmodifiedBlock,
  parseBlockRef,
  resolveBlockFolder,
  uniqueBlockName
} from "../core/blocks/block-files";
import { BUILTIN_BLOCKS, findBuiltinBlock, type BlockCategory } from "../core/blocks/builtin";
import { parseTemplateBlock } from "../core/blocks/template-block";
import {
  builtinTemplates,
  isBuiltinTemplateId,
  resolveTemplate,
  sectionKeys,
  STANDARD_TEMPLATE_ID,
  TEXTBOOK_TEMPLATE_ID,
  type DetailTemplate
} from "./detail-templates";
import {
  CANONICAL_LANGUAGES,
  matchCanonical,
  normalizeStyleContent,
  NOTE_STYLE_BUILTIN_IDS,
  parseNoteStyleFile,
  serializeLegacyV1,
  type NoteStyleBuiltinId,
  type NoteStyleIssue
} from "./note-style-file";
import { DEFAULT_TONE_ID, findPreset, listPresets, resolveToneText, type PromptPreset } from "./prompt-presets";
import {
  BUILTIN_PAIRS,
  builtinPairOf,
  builtinStyleFileBase,
  NOTE_STYLE_UPGRADE_VERSION,
  pairAliasKey,
  planNoteStyleUpgrade,
  type NoteStyleAlias,
  type NoteStyleAliases,
  type NoteStyleUpgradeMarker,
  type UpgradePlan
} from "./note-style-upgrade";

import { styleLabel, styleRefOf, type StyleRef } from "./note-style-label";

export { builtinPairOf };

/**
 * Finds the note style of a run: which template (and tone) a topic, map or workspace resolves to, reading the style files
 * once per run into a snapshot. With no style folder and no new settings key every answer equals `resolveTemplate` plus
 * `resolveToneText`, so prompts stay byte-identical.
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
  /** Old ids (style file, old template, built-in style whose file was changed, custom tone preset) -> the blocks that replaced them. */
  noteStyleAliases?: NoteStyleAliases;
  /** Set when the one-time upgrade of the old note style data has finished. */
  noteStyleUpgrade?: NoteStyleUpgradeMarker;
  workspaceFolder: string;
  language: UiLanguage;
}

/** The two stored values of each level the chain looks at, most specific first (run choice, topic, map). */
export interface StyleLevel {
  template?: string;
  tone?: string;
}

/** What a run asks of the store: the levels it knows (most specific first) and the language its output is written in. */
export interface RunStyleRequest {
  /** This run's own choice in the dialog. */
  choice?: StyleLevel;
  /** The topic's stored values. */
  topic?: StyleLevel;
  /** The mind map's stored values. */
  map?: StyleLevel;
  /** The language the note is written in (the interface language is read from the settings). */
  outputLanguage: ContentLanguage;
}

/** The note style one run uses; a value, nothing in it changes after it is returned. */
export interface RunStyle {
  /** In the output language; the built-in stand-in when a block cannot be read. */
  readonly template: DetailTemplate;
  /** Undefined for academic or when no tone is chosen. */
  readonly toneText?: string;
  readonly contextFields: Readonly<{ styleSelection?: StyleSelection }>;
  readonly label: Readonly<{
    /** In the interface language. */
    templateName: string;
    /** The name of the tone that `toneText` really is. */
    toneName: string;
    /** The name inside "Keep current (…)". */
    styleName: string;
    /** "Edit this style". */
    styleRef?: StyleRef;
    /** The file used (with ".md"), for the progress label. */
    fileName?: string;
  }>;
  readonly issues: Readonly<{
    /** Template ids that were asked for but could not be used, most specific level first. */
    missing: readonly string[];
    blockIssues: readonly BlockIssue[];
    /** A style file that was chosen but does not parse: the run must not start. */
    invalid?: Readonly<{ fileName: string; issues: readonly NoteStyleIssue[] }>;
  }>;
}

export interface StyleResolution {
  template: DetailTemplate;
  /** Template ids that were asked for but could not be used (as `resolveTemplate` reports them). */
  missing: string[];
  toneText?: string;
  /** The file used (with ".md"), for the progress label. */
  fileName?: string;
  /** A style file that was chosen but does not parse: the run must not start. */
  invalid?: { fileName: string; issues: NoteStyleIssue[] };
  /** Set when the workspace template block was changed or is the user's own: the choice to send as `styleSelection`. */
  block?: BlockChoice;
  /** Set with `block` when its text cannot be read: the built-in template stands in, and these say why. */
  blockIssues?: BlockIssue[];
  /** Set when the answer decided the tone as well (an old style file, or an alias of one): `toneText` is the run's tone, nothing else is asked. */
  toneDecided?: true;
  /** With `toneDecided`: the id or block ref of the tone that `toneText` is (its name is shown), or the free text when it names no tone. */
  toneSource?: string;
  toneFree?: string;
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

/** What the one-time upgrade could not do; each is shown to the user once. */
export type NoteStyleUpgradeEvent =
  { kind: "failed" } | { kind: "trash-failed"; names: string[] } | { kind: "skipped"; names: string[] };

export interface NoteStyleUpgradeResult {
  status: "done" | "already" | "failed";
  /** Old style files that do not read: they were not upgraded and stay where they are. */
  skipped: string[];
  /** Old files that were upgraded but could not be moved to the trash. */
  trashFailed: string[];
}

export type RestoreBlockResult =
  | { ok: true; backup: string }
  | { ok: false; reason: "not-builtin" | "no-override" | "read-failed" | "backup-failed" | "trash-failed" };

/** The first tone a chain names: its text, and the id or block ref that named it (the name shown for the tone is that one's). */
interface NamedTone {
  named: boolean;
  text?: string;
  source?: string;
}

const stripMd = (name: string) => name.replace(/\.md$/i, "");
const lower = (value: string) => value.toLocaleLowerCase();

/**
 * The writing tone of a run: an old style file or an alias of one decides its own (the answer made with the template, `resolution`), else the
 * first of `ids` that names a tone preset. Academic (and nothing chosen) is undefined so prompts stay unchanged.
 */
export function runToneText(
  resolution: StyleResolution | undefined,
  presets: readonly PromptPreset[] | undefined,
  ids: readonly (string | undefined)[],
  language: ContentLanguage
): string | undefined {
  if (resolution?.toneDecided) return resolution.toneText;
  return resolveToneText(presets, ids, language);
}

/** The style fields of a request that names no style of its own (the workspace default), or the style file that stops it. */
export type WorkspaceStyleFields =
  | { invalid: NonNullable<StyleResolution["invalid"]> }
  | ({ invalid?: undefined } & Pick<TaskContext, "detailTemplate" | "toneText" | "styleSelection">);

export function defaultStylesFolderName(language: UiLanguage): string {
  return translate(language, "ui.note_styles_folder_name");
}

export class NoteStyleStore {
  /** File text by base name (no ".md"), as of the last `refresh()`. */
  private files = new Map<string, string>();
  /** Block file text by base name (no ".md") for each category, as of the last `refresh()` or block write. */
  private blocks: Record<BlockCategory, Map<string, string>> = { template: new Map(), tone: new Map() };
  private readonly resolutions = new WeakMap<DetailTemplate, StyleResolution>();
  /** Block writes run one after the other, so two quick clicks cannot pick the same name. */
  private writeQueue: Promise<unknown> = Promise.resolve();
  /** The one upgrade run of this session (started once; later calls get the same answer). */
  private upgradeRun?: Promise<NoteStyleUpgradeResult>;
  /** An upgrade that could not be written out: its blocks, aliases and keys answer in memory until the next load retries it. */
  private pending?: Pick<UpgradePlan, "blocks" | "aliases" | "keys">;

  constructor(
    private readonly deps: {
      settings: () => NoteStyleSettings;
      port: StyleFilePort;
      save: () => Promise<void>;
      /** The clock for backup names; tests inject one. */
      now?: () => Date;
      /** Told what the upgrade could not do, so the plugin can say so once. */
      report?: (event: NoteStyleUpgradeEvent) => void;
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

  /** Reads every style file of the folder once. Call at the start of a run; later calls in the run see this snapshot. */
  async refresh(): Promise<void> {
    // A run waits for an upgrade that is under way: it must not see half of it.
    if (this.upgradeRun) await this.upgradeRun;
    await this.load();
  }

  private async load(): Promise<void> {
    const folder = this.folder();
    const next = new Map<string, string>();
    let names: string[] = [];
    try {
      names = await this.deps.port.list(folder);
    } catch {
      names = [];
    }
    for (const name of names) {
      try {
        next.set(stripMd(name), await this.deps.port.read(`${folder}/${name}`));
      } catch {
        /* an unreadable file is simply not a style */
      }
    }
    this.files = next;
    await this.loadBlocks();
  }

  // ---- block files ----

  /** The block folders: each is the first spelling that exists, else the interface language's (where it would be created). */
  private blockDirectories(): Record<"root" | BlockCategory | "backup", string> {
    const { port } = this.deps;
    const exists = (path: string): boolean => {
      try {
        return port.folderExists(path);
      } catch {
        return false;
      }
    };
    const language = this.settings.language;
    const root = resolveBlockFolder(this.folder(), "root", exists, language);
    return {
      root,
      template: resolveBlockFolder(root, "template", exists, language),
      tone: resolveBlockFolder(root, "tone", exists, language),
      backup: resolveBlockFolder(root, "backup", exists, language)
    };
  }

  private async loadBlocks(): Promise<void> {
    const dirs = this.blockDirectories();
    const next: Record<BlockCategory, Map<string, string>> = { template: new Map(), tone: new Map() };
    for (const category of ["template", "tone"] as const) {
      let names: string[] = [];
      try {
        names = await this.deps.port.list(dirs[category]);
      } catch {
        names = [];
      }
      for (const name of names) {
        if (!/\.md$/i.test(name) || name.includes("/")) continue;
        try {
          next[category].set(stripMd(name), await this.deps.port.read(`${dirs[category]}/${name}`));
        } catch {
          /* an unreadable file is simply not a block */
        }
      }
    }
    // An upgrade that was not written out still answers from memory.
    for (const block of this.pending?.blocks ?? [])
      if (![...next[block.category].keys()].some(base => lower(base) === lower(block.base)))
        next[block.category].set(block.base, block.text);
    this.blocks = next;
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
      const modified = text !== undefined && !isUnmodifiedBlock(category, block.id, text);
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

  // ---- identification of files ----

  /** The base name of the file that holds a built-in style now, if one is in the folder. */
  private builtinFile(id: NoteStyleBuiltinId): string | undefined {
    return builtinStyleFileBase(this.files, id, this.settings.language);
  }

  private legacyUnchanged(template: DetailTemplate | undefined, text: string): boolean {
    if (!template) return false;
    const normalized = normalizeStyleContent(text);
    return CANONICAL_LANGUAGES.some(
      language => normalizeStyleContent(serializeLegacyV1(template, language)) === normalized
    );
  }

  // ---- resolution ----

  /**
   * The note style of a run, as one value: the template, the writing tone text, the context fields, the names to show and
   * the problems found. Reads only what the last `refresh()` loaded; writes nothing and shows nothing.
   */
  runStyle(request: RunStyleRequest): RunStyle {
    const settings = this.settings;
    const language = request.outputLanguage;
    // The run's own tone takes no part in finding the template (only in the tone text); the other levels bring both.
    const levels: StyleLevel[] = [{ template: request.choice?.template }];
    if (request.topic) levels.push(request.topic);
    if (request.map) levels.push(request.map);
    const found = this.resolve(levels);
    // A template read from a block is used as it is; the built-in stand-in for an unreadable block follows the output language.
    const template =
      isBuiltinTemplateId(found.template.id) && !(found.block && !found.blockIssues)
        ? builtinTemplates(noteLanguageOf(language), language).find(item => item.id === found.template.id)!
        : found.template;
    const uiTemplates = [
      ...builtinTemplates(noteLanguageOf(settings.language), settings.language),
      ...settings.detailTemplates
    ];
    const isFileId = (id: string): boolean => id.startsWith("style:") || id.startsWith("file:");
    const templateName = (id: string): string =>
      isFileId(id) ? id.replace(/^(?:style|file):/, "") : (uiTemplates.find(item => item.id === id)?.name ?? id);
    const chain = [request.choice?.tone, request.topic?.tone, request.map?.tone];
    // An old style file, or the alias of one, decided the tone together with the template; else the chain, then the workspace.
    const tone: { text?: string; source?: string; free?: string } = found.toneDecided
      ? { text: found.toneText, source: found.toneSource, free: found.toneFree }
      : this.plainTone(chain, language);
    // Free text names no tone; it stands for itself, so the style is a custom pair.
    const toneId = tone.free ?? tone.source ?? DEFAULT_TONE_ID;
    const toneName = (id: string): string => this.toneName(id) ?? id;
    const styleRef = styleRefOf(template.id, toneId, settings.noteStyleAliases);
    const label = Object.freeze({
      templateName: templateName(template.id),
      toneName: tone.free ?? toneName(toneId),
      styleName: isFileId(template.id)
        ? templateName(template.id)
        : styleLabel(template.id, toneId, { template: templateName, tone: toneName }, settings.language),
      ...(styleRef ? { styleRef } : {}),
      ...(found.fileName ? { fileName: found.fileName } : {})
    });
    return Object.freeze({
      template,
      ...(tone.text ? { toneText: tone.text } : {}),
      contextFields: Object.freeze(
        found.block
          ? {
              styleSelection: Object.freeze({
                template: Object.freeze({ ...found.block }),
                tone: Object.freeze(toneChoiceFromText(tone.text, language))
              })
            }
          : {}
      ),
      label,
      issues: Object.freeze({
        missing: Object.freeze([...found.missing]),
        blockIssues: Object.freeze([...(found.blockIssues ?? [])]),
        ...(found.invalid ? { invalid: Object.freeze({ ...found.invalid }) } : {})
      })
    });
  }

  /**
   * `levels`: the run's choice, the topic and the map (most specific first, any may be absent). The workspace default is
   * added here. Records the answer for `resolutionOf(template)` so tone and context fields follow the same choice.
   */
  resolve(levels: StyleLevel[]): StyleResolution {
    const settings = this.settings;
    const noteLanguage = noteLanguageOf(settings.language);
    const all = [...levels, this.workspaceLevel()];
    const toneChain = all.map(level => level.tone);
    const missing: string[] = [];
    for (let index = 0; index < all.length; index++) {
      const id = all[index].template;
      if (!id) continue;
      const isBlock = index === all.length - 1 && !!this.templateKey() && id === this.templateKey();
      const found = isBlock
        ? this.tryBlock(id, toneChain, noteLanguage)
        : this.tryId(id, index, all, toneChain, noteLanguage);
      if (found) return this.remember({ ...found, missing });
      missing.push(id);
    }
    const standard =
      this.tryId(STANDARD_TEMPLATE_ID, all.length, all, toneChain, noteLanguage) ??
      this.legacyResult(STANDARD_TEMPLATE_ID, toneChain, noteLanguage)!;
    return this.remember({ ...standard, missing });
  }

  /** The resolution made for a template object returned by `resolve` (only style-file templates keep their identity). */
  resolutionOf(template: DetailTemplate | undefined): StyleResolution | undefined {
    return template ? this.resolutions.get(template) : undefined;
  }

  /**
   * `to` takes the place of `from` in the answer `resolve` gave for it (the built-in template that stands in for an
   * unreadable block, put into the run's language), so block, issues and context fields still follow it. `to` is copied:
   * the answer is remembered under the object's identity and a shared object must not carry one run's block into another.
   */
  rebind(from: DetailTemplate, to: DetailTemplate): DetailTemplate {
    const resolution = this.resolutions.get(from);
    if (!resolution) return to;
    const copy = { ...to };
    this.resolutions.set(copy, { ...resolution, template: copy });
    return copy;
  }

  /**
   * Fields to spread into a TaskContext: when the template is the workspace's changed or own block, `styleSelection`
   * (its text, and the tone choice of `toneText`). A call that names no tone and no language gets what it got before.
   */
  contextFields(
    template: DetailTemplate | undefined,
    toneText?: string,
    language?: ContentLanguage
  ): { styleSelection?: StyleSelection } {
    const resolution = this.resolutionOf(template);
    const fields: { styleSelection?: StyleSelection } = {};
    if (resolution?.block)
      fields.styleSelection = {
        template: resolution.block,
        tone: toneChoiceFromText(toneText, language ?? this.settings.language)
      };
    return fields;
  }

  /**
   * The writing tone of a run on `template`: a note style file decides its own; else the first of `ids` that names a tone
   * preset (academic is nothing); else the workspace tone, which sits at the end of the chain. Academic (and nothing
   * chosen) is undefined so prompts stay unchanged.
   */
  toneTextFor(
    template: DetailTemplate | undefined,
    ids: readonly (string | undefined)[],
    language: ContentLanguage
  ): string | undefined {
    const resolution = this.resolutionOf(template);
    // An old style file, or the alias of one, decided the tone together with the template.
    if (resolution?.toneDecided) return resolution.toneText;
    return this.plainTone(ids, language).text;
  }

  /**
   * The tone of the first of `ids` that names a tone (a custom tone preset's id goes through its alias to the tone block;
   * academic is no text), else the workspace tone: a built-in tone by id, or a text that fills the gap only when no tone
   * is named by the run, topic or map.
   */
  private plainTone(ids: readonly (string | undefined)[], language: ContentLanguage): NamedTone {
    const own = this.namedTone(ids, language);
    if (own.named) return own;
    const workspace = this.workspaceTone();
    if (!workspace) return own;
    if ("id" in workspace) return this.namedTone([workspace.id], language);
    return { named: true, text: workspace.text.trim() || undefined, source: workspace.source };
  }

  /** The first of `ids` that names a tone decides: `named`, and its text (undefined for academic or an empty text). */
  private namedTone(ids: readonly (string | undefined)[], language: ContentLanguage): NamedTone {
    const presets = this.settings.promptPresets;
    for (const id of ids) {
      if (!id) continue;
      if (parseBlockRef(id)?.kind === "file") {
        // A tone block the map, topic or run picked; the file being gone means the id names nothing any more.
        const target = this.toneByRef(id);
        if (target) return { named: true, text: this.toneTargetText(target, language), source: id };
        continue;
      }
      const alias = this.aliasOf(id);
      if (alias?.tone && !alias.template) {
        // A tone block the id was moved to; the file being gone means the id names nothing any more.
        const target = this.toneByRef(alias.tone);
        if (target) return { named: true, text: this.toneTargetText(target, language), source: id };
        continue;
      }
      const found = findPreset(presets, "tone", id, language);
      if (found)
        return {
          named: true,
          text: found.id === DEFAULT_TONE_ID ? undefined : found.text.trim() || undefined,
          source: id
        };
    }
    return { named: false };
  }

  private toneTargetText(
    target: { id: string } | { text: string; source: string },
    language: ContentLanguage
  ): string | undefined {
    return "id" in target
      ? resolveToneText(this.settings.promptPresets, [target.id], language)
      : target.text.trim() || undefined;
  }

  /**
   * The style fields a run with no choice of its own gets: the same resolution, tone and context fields the map view
   * spreads into a TaskContext. A default style file that does not parse is returned as `invalid` (the run would not start).
   */
  workspaceStyleFields(language: ContentLanguage): WorkspaceStyleFields {
    const resolved = this.resolve([{}, {}]);
    if (resolved.invalid) return { invalid: resolved.invalid };
    const toneText = this.toneTextFor(resolved.template, [], language);
    return {
      detailTemplate: resolved.template,
      ...(toneText ? { toneText } : {}),
      ...this.contextFields(resolved.template, toneText, language)
    };
  }

  /**
   * The workspace tone: a built-in tone by id (so the run's chain can apply it), or a text (a changed built-in's file or
   * the user's own file). With no `noteToneBlock` it comes from the tone of a built-in `defaultNoteStyleId`.
   */
  private workspaceTone(): { id: string } | { text: string; source: string } | undefined {
    const settings = this.settings;
    const key = this.toneKey();
    if (key) return this.toneByRef(key);
    const preset = NOTE_STYLE_BUILTIN_IDS.find(id => id === settings.defaultNoteStyleId);
    return preset ? { id: BUILTIN_PAIRS[preset].tone } : undefined;
  }

  /** A tone block ref as a tone: a built-in by id (so the run's chain can apply it), or the text of a changed built-in or own file. */
  private toneByRef(ref: string): { id: string } | { text: string; source: string } | undefined {
    const parsed = parseBlockRef(ref);
    if (parsed?.kind === "builtin") {
      if (!this.isBuiltinBlockId("tone", parsed.id)) return undefined;
      const base = this.overrideBase("tone", parsed.id);
      const text = base === undefined ? undefined : this.blocks.tone.get(base);
      if (text !== undefined && !isUnmodifiedBlock("tone", parsed.id, text)) return { text, source: parsed.id };
      return { id: parsed.id };
    }
    if (parsed?.kind === "file") {
      const text = this.blocks.tone.get(parsed.base);
      return text === undefined ? undefined : { text, source: ref };
    }
    return undefined;
  }

  // ---- upgrade state the resolution reads: what is saved, else what an unfinished upgrade holds in memory ----

  private templateKey(): string | undefined {
    return this.settings.noteTemplateBlock || this.pending?.keys.noteTemplateBlock;
  }

  private toneKey(): string | undefined {
    return this.settings.noteToneBlock || this.pending?.keys.noteToneBlock;
  }

  /**
   * The template and tone blocks the runs use: what is saved, else what an unfinished upgrade holds in memory. Read-only;
   * the settings page shows these, so a failed or unfinished upgrade does not show the standard template over the result.
   */
  effectiveBlockKeys(): { template?: string; tone?: string; pending: boolean } {
    return { template: this.templateKey(), tone: this.toneKey(), pending: this.pending !== undefined };
  }

  private aliasOf(key: string): NoteStyleAlias | undefined {
    const saved = this.settings.noteStyleAliases;
    if (saved && Object.prototype.hasOwnProperty.call(saved, key)) return saved[key];
    const held = this.pending?.aliases;
    return held && Object.prototype.hasOwnProperty.call(held, key) ? held[key] : undefined;
  }

  /** Until the upgrade has finished, the old sources (style files, exported files) are still read. */
  private legacyReads(): boolean {
    return !this.settings.noteStyleUpgrade;
  }

  private remember(resolution: StyleResolution): StyleResolution {
    if (resolution.toneDecided || resolution.block) this.resolutions.set(resolution.template, resolution);
    return resolution;
  }

  private workspaceLevel(): StyleLevel {
    const settings = this.settings;
    const block = this.templateKey();
    if (block) return { template: block };
    const chosen = settings.defaultNoteStyleId;
    if (chosen) {
      const preset = NOTE_STYLE_BUILTIN_IDS.find(id => id === chosen);
      if (preset) return { template: BUILTIN_PAIRS[preset].template, tone: BUILTIN_PAIRS[preset].tone };
      return { template: chosen };
    }
    return { template: settings.defaultDetailTemplateId };
  }

  private legacyResult(id: string, toneChain: (string | undefined)[], noteLanguage: ReturnType<typeof noteLanguageOf>) {
    const settings = this.settings;
    const { template, missing } = resolveTemplate(settings.detailTemplates, [id], noteLanguage);
    if (missing.length) return undefined;
    return {
      template,
      missing: [] as string[],
      toneText: resolveToneText(settings.promptPresets, toneChain, settings.language)
    } as StyleResolution;
  }

  /**
   * The workspace template block `ref`. An unmodified built-in (no file, or a file equal to a built-in text) is today's
   * template. A changed or own block that parses gives the parsed template and the block to send; one that does not parse
   * gives the built-in template (the same id when it is a built-in, else Standard) with the block and its issues. A file
   * that is gone is not found (the caller falls back to Standard).
   */
  private tryBlock(
    ref: string,
    toneChain: (string | undefined)[],
    noteLanguage: ReturnType<typeof noteLanguageOf>
  ): StyleResolution | undefined {
    const parsedRef = parseBlockRef(ref);
    if (!parsedRef) return undefined;
    const map = this.blocks.template;
    let id: string;
    let base: string;
    if (parsedRef.kind === "builtin") {
      if (!this.isBuiltinBlockId("template", parsedRef.id)) return undefined;
      id = parsedRef.id;
      const override = this.overrideBase("template", id);
      if (override === undefined || isUnmodifiedBlock("template", id, map.get(override)!))
        return this.legacyResult(id, toneChain, noteLanguage);
      base = override;
    } else {
      if (!map.has(parsedRef.base)) return undefined;
      id = ref;
      base = parsedRef.base;
    }
    const text = map.get(base)!;
    const fileName = `${base}.md`;
    const block: BlockChoice = { id, body: text, fileName };
    const parsed = parseTemplateBlock(text, { id, name: base });
    // A fresh object per answer: the answer is remembered under the template object's identity.
    if (parsed.ok) return { template: { ...parsed.template }, missing: [], block };
    const fallbackId = this.isBuiltinBlockId("template", id) ? id : STANDARD_TEMPLATE_ID;
    const fallback = resolveTemplate(this.settings.detailTemplates, [fallbackId], noteLanguage).template;
    return {
      template: { ...fallback },
      missing: [],
      block,
      blockIssues: parsed.issues.map((issue): BlockIssue => ({ ...issue, category: "template", id, fileName }))
    };
  }

  private tryId(
    id: string,
    level: number,
    all: StyleLevel[],
    toneChain: (string | undefined)[],
    noteLanguage: ReturnType<typeof noteLanguageOf>
  ): StyleResolution | undefined {
    const settings = this.settings;
    // A template block the user wrote, picked at the map, topic or run level (the map file stores `file:<name>`).
    if (parseBlockRef(id)?.kind === "file") return this.tryBlock(id, toneChain, noteLanguage);
    if (id.startsWith("style:")) {
      const aliased = this.tryAlias(id, "user", level, toneChain, noteLanguage);
      if (aliased) return aliased;
      if (!this.legacyReads()) return undefined;
      const base = id.slice("style:".length);
      const text = this.files.get(base);
      if (text === undefined) return undefined;
      return this.fromFile(parseNoteStyleFile(text, { id, name: base }), `${base}.md`, level, toneChain, "user");
    }
    const aliasedOld = this.tryAlias(id, "legacy", level, toneChain, noteLanguage);
    if (aliasedOld) return aliasedOld;
    const exported = this.legacyReads() ? settings.noteStyleFiles?.[id] : undefined;
    if (exported) {
      const base = stripMd(exported);
      const text = this.files.get(base);
      const original = settings.detailTemplates.find(template => template.id === id);
      if (text !== undefined && !this.legacyUnchanged(original, text)) {
        const parsed = parseNoteStyleFile(text, { id, name: original?.name ?? base });
        if (parsed.ok && original) inheritRoles(parsed.style.template, original);
        return this.fromFile(parsed, `${base}.md`, level, toneChain, "legacy");
      }
    }
    if (id === STANDARD_TEMPLATE_ID || id === TEXTBOOK_TEMPLATE_ID) {
      const tone = toneChain.find(toneId => this.namedTone([toneId], settings.language).named);
      const builtin = builtinPairOf(id, tone);
      const aliasedPair = builtin
        ? this.tryAlias(pairAliasKey(builtin), "pair", level, toneChain, noteLanguage)
        : undefined;
      if (aliasedPair) return aliasedPair;
      const base = builtin && this.legacyReads() ? this.builtinFile(builtin) : undefined;
      if (builtin && base !== undefined) {
        const text = this.files.get(base)!;
        if (matchCanonical(text)?.id !== builtin)
          return this.fromFile(
            parseNoteStyleFile(text, { id: `style:${base}`, name: base }),
            `${base}.md`,
            level,
            toneChain,
            "builtin"
          );
      }
    }
    return this.legacyResult(id, toneChain, noteLanguage);
  }

  /**
   * An old id that the upgrade moved to a template block (`alias.template`), answered as the old file was: the block, and
   * the tone the file decided. A style file's tone is its own unless the same or a more specific level names one; an old
   * template's whole chain (and the workspace tone) is asked first; a built-in style's file always decides its own.
   * Absent when the id has no alias or its block file is gone (the caller goes on as for a file that is missing).
   */
  private tryAlias(
    key: string,
    kind: "user" | "legacy" | "pair",
    level: number,
    toneChain: (string | undefined)[],
    noteLanguage: ReturnType<typeof noteLanguageOf>
  ): StyleResolution | undefined {
    const alias = this.aliasOf(key);
    if (!alias?.template) return undefined;
    const found = this.tryBlock(alias.template, toneChain, noteLanguage);
    if (!found) return undefined;
    const language = this.settings.language;
    const target = alias.tone ? this.toneByRef(alias.tone) : undefined;
    const own = target ? this.toneTargetText(target, language) : undefined;
    const ownSource = target && alias.tone ? alias.tone : undefined;
    let toneText: string | undefined;
    let toneSource: string | undefined;
    if (kind === "pair") {
      toneText = own;
      toneSource = ownSource;
    } else if (kind === "user") {
      const named = this.namedTone(toneChain.slice(0, level + 1), language);
      toneText = named.named ? named.text : own;
      toneSource = named.named ? named.source : ownSource;
    } else {
      // An old template had no tone of its own: the usual chain decides.
      if (!alias.tone) return found;
      const named = this.plainTone(toneChain, language);
      toneText = named.named ? named.text : own;
      toneSource = named.named ? named.source : ownSource;
    }
    return { ...found, ...(toneText ? { toneText } : {}), ...(toneSource ? { toneSource } : {}), toneDecided: true };
  }

  private fromFile(
    parsed: ReturnType<typeof parseNoteStyleFile>,
    fileName: string,
    level: number,
    toneChain: (string | undefined)[],
    kind: "user" | "builtin" | "legacy"
  ): StyleResolution {
    const settings = this.settings;
    if (!parsed.ok)
      return {
        template: resolveTemplate(settings.detailTemplates, [], noteLanguageOf(settings.language)).template,
        missing: [],
        invalid: { fileName, issues: parsed.issues }
      };
    const style = parsed.style;
    let toneText: string | undefined;
    let toneSource: string | undefined;
    let toneFree: string | undefined;
    const fromStyle = (raw: string) => {
      const file = this.toneFromFile(raw);
      toneText = file.text;
      toneSource = file.source;
      toneFree = file.free;
    };
    if (kind !== "builtin") {
      // A user file: tones of the same or a more specific level win. An old template's file: the whole chain, as today.
      const chain = kind === "legacy" ? toneChain : toneChain.slice(0, level + 1);
      const known = chain.find(toneId => findPreset(settings.promptPresets, "tone", toneId, settings.language));
      if (known !== undefined) {
        toneText = resolveToneText(settings.promptPresets, chain, settings.language);
        toneSource = known;
      } else if (style.tone) fromStyle(style.tone);
    } else if (style.tone) fromStyle(style.tone);
    return {
      template: style.template,
      missing: [],
      ...(toneText ? { toneText } : {}),
      ...(toneSource ? { toneSource } : {}),
      ...(toneFree ? { toneFree } : {}),
      toneDecided: true,
      fileName
    };
  }

  /**
   * `語氣` is the name or id of an existing tone (its full text is used), else free text. `source` is the tone's id when it
   * names one; `free` is the written text when it names none (it is then also the name shown).
   */
  private toneFromFile(raw: string): { text?: string; source?: string; free?: string } {
    const settings = this.settings;
    const key = lower(raw.trim());
    const pools = [settings.language, ...LANGUAGES.map(language => language.id)].map(language =>
      listPresets(settings.promptPresets, "tone", language)
    );
    for (const pool of pools) {
      const found = pool.find(item => lower(item.id) === key || lower(item.name) === key);
      if (found)
        return {
          text: found.id === DEFAULT_TONE_ID ? undefined : found.text.trim() || undefined,
          source: found.id
        };
    }
    const free = raw.trim() || undefined;
    return { text: free, ...(free ? { free } : {}) };
  }

  // ---- the tone choices of the map pickers ----

  /** The tones a map, topic or run can pick: the built-in tones (by tone id) and the tone blocks (`file:<name>`). Call `refresh()` first. */
  toneChoices(): { id: string; name: string }[] {
    return this.listBlocks("tone").map(item => {
      const parsed = parseBlockRef(item.ref);
      return { id: parsed?.kind === "builtin" ? parsed.id : item.ref, name: item.name };
    });
  }

  /** The name of a stored tone id: a built-in tone, a tone block, a custom preset moved to a block (its alias), or an old preset not moved. */
  toneName(id: string | undefined): string | undefined {
    if (!id) return undefined;
    const alias = this.aliasOf(id);
    let ref: string | undefined;
    if (alias?.tone && !alias.template) ref = alias.tone;
    else if (parseBlockRef(id)?.kind === "file") ref = id;
    else if (this.isBuiltinBlockId("tone", id)) ref = builtinRef(id);
    const named = ref ? this.listBlocks("tone").find(item => item.ref === ref)?.name : undefined;
    return named ?? findPreset(this.settings.promptPresets, "tone", id, this.settings.language)?.name;
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
  ensureBlockFile(category: BlockCategory, ref: string): Promise<{ path: string; base: string }> {
    return this.serial(async () => {
      await this.loadBlocks();
      const parsed = parseBlockRef(ref);
      const dir = this.blockDirectories()[category];
      if (parsed?.kind === "file") {
        if (!this.blocks[category].has(parsed.base)) throw new Error(`Block file not found: ${parsed.base}`);
        return { path: `${dir}/${parsed.base}.md`, base: parsed.base };
      }
      if (parsed?.kind !== "builtin" || !this.isBuiltinBlockId(category, parsed.id))
        throw new Error(`Unknown block: ${ref}`);
      const override = this.overrideBase(category, parsed.id);
      if (override !== undefined) return { path: `${dir}/${override}.md`, base: override };
      const language = this.settings.language;
      const block = findBuiltinBlock(category, parsed.id);
      const base = uniqueBlockName(
        cleanBlockName(translate(language, block.nameKey)) || parsed.id,
        this.takenNames(category)
      );
      const text = builtinBlockText(category, parsed.id, language);
      await this.pinFolder();
      await this.deps.port.createFolder(dir);
      await this.deps.port.create(`${dir}/${base}.md`, text);
      this.blocks[category].set(base, text);
      return { path: `${dir}/${base}.md`, base };
    });
  }

  /**
   * Copies a block into a new file of the category, named "<name> copy" (unique, never a built-in's name), and makes it
   * the workspace's choice. Returns the new ref. The text copied is the block's file when it has one, else its built-in text.
   */
  copyBlock(category: BlockCategory, ref: string): Promise<string> {
    return this.serial(async () => {
      await this.loadBlocks();
      const parsed = parseBlockRef(ref);
      const language = this.settings.language;
      let name: string;
      let text: string;
      if (parsed?.kind === "file") {
        const held = this.blocks[category].get(parsed.base);
        if (held === undefined) throw new Error(`Block file not found: ${parsed.base}`);
        name = parsed.base;
        text = held;
      } else if (parsed?.kind === "builtin" && this.isBuiltinBlockId(category, parsed.id)) {
        const override = this.overrideBase(category, parsed.id);
        name = translate(language, findBuiltinBlock(category, parsed.id).nameKey);
        text =
          override === undefined
            ? builtinBlockText(category, parsed.id, language)
            : this.blocks[category].get(override)!;
      } else throw new Error(`Unknown block: ${ref}`);
      const dir = this.blockDirectories()[category];
      const base = copyBlockName(category, name, language, this.takenNames(category));
      await this.pinFolder();
      await this.deps.port.createFolder(dir);
      await this.deps.port.create(`${dir}/${base}.md`, text);
      this.blocks[category].set(base, text);
      const created = fileRef(base);
      if (category === "template") this.settings.noteTemplateBlock = created;
      else this.settings.noteToneBlock = created;
      await this.deps.save();
      return created;
    });
  }

  /**
   * Restores a built-in block: its file is saved to the backup folder first, then moved to the trash, so the built-in
   * text applies again. Refused for an own block and for a built-in with no file. If the backup cannot be written the
   * file stays as it is.
   */
  restoreBlock(category: BlockCategory, ref: string): Promise<RestoreBlockResult> {
    return this.serial(async (): Promise<RestoreBlockResult> => {
      await this.loadBlocks();
      const parsed = parseBlockRef(ref);
      if (parsed?.kind !== "builtin" || !this.isBuiltinBlockId(category, parsed.id))
        return { ok: false, reason: "not-builtin" };
      const base = this.overrideBase(category, parsed.id);
      if (base === undefined) return { ok: false, reason: "no-override" };
      const { port } = this.deps;
      const dirs = this.blockDirectories();
      const path = `${dirs[category]}/${base}.md`;
      let live: string;
      try {
        live = await port.read(path);
      } catch {
        return { ok: false, reason: "read-failed" };
      }
      let backup: string;
      try {
        let present: string[] = [];
        try {
          present = await port.list(dirs.backup);
        } catch {
          present = [];
        }
        await this.pinFolder();
        await port.createFolder(dirs.backup);
        backup = `${dirs.backup}/${backupName(base, this.deps.now?.() ?? new Date(), new Set(present.map(lower)))}`;
        await port.create(backup, live);
      } catch {
        return { ok: false, reason: "backup-failed" };
      }
      try {
        await port.trash(path);
      } catch {
        return { ok: false, reason: "trash-failed" };
      }
      this.blocks[category].delete(base);
      return { ok: true, backup };
    });
  }

  // ---- the one-time upgrade of the old note style data (the only write that is not a user action) ----

  /**
   * Starts the upgrade once (`after` is awaited first, for example the plugin's start-up); later calls get the same
   * promise. It never rejects: a failure is reported once, the unfinished upgrade answers from memory this session, and
   * the next load tries again. `refresh()` waits for it.
   */
  startUpgrade(after?: Promise<unknown>): Promise<NoteStyleUpgradeResult> {
    this.upgradeRun ??= (async (): Promise<NoteStyleUpgradeResult> => {
      try {
        if (after) await after.catch(() => undefined);
        return await this.runUpgrade();
      } catch {
        this.deps.report?.({ kind: "failed" });
        return { status: "failed", skipped: [], trashFailed: [] };
      }
    })();
    return this.upgradeRun;
  }

  upgradeLegacy(): Promise<NoteStyleUpgradeResult> {
    return this.startUpgrade();
  }

  /**
   * Order: the plan is applied in memory, then backups of the old files, the block files, data.json (new keys, aliases,
   * marker), and only then the old files go to the trash. A failure before the marker leaves the marker, the keys and the
   * old files alone. Nothing is ever overwritten: a name taken by other text was given a new name by the plan.
   */
  private async runUpgrade(): Promise<NoteStyleUpgradeResult> {
    const settings = this.settings;
    if (settings.noteStyleUpgrade) return { status: "already", skipped: [], trashFailed: [] };
    await this.load();
    const plan = planNoteStyleUpgrade({
      language: settings.language,
      files: this.files,
      detailTemplates: settings.detailTemplates,
      promptPresets: settings.promptPresets,
      noteStyleFiles: settings.noteStyleFiles,
      defaultNoteStyleId: settings.defaultNoteStyleId,
      defaultDetailTemplateId: settings.defaultDetailTemplateId,
      noteTemplateBlock: settings.noteTemplateBlock,
      noteToneBlock: settings.noteToneBlock,
      blocks: this.blocks
    });
    // From here the plan answers in memory, whatever happens to the writes.
    if (!plan.nothing) {
      this.pending = { blocks: plan.blocks, aliases: plan.aliases, keys: plan.keys };
      for (const block of plan.blocks) this.blocks[block.category].set(block.base, block.text);
    }
    try {
      // Block actions of the user wait behind the upgrade's writes, as they wait behind each other.
      await this.serial(() => this.writeUpgrade(plan));
    } catch {
      this.deps.report?.({ kind: "failed" });
      return { status: "failed", skipped: plan.skipped, trashFailed: [] };
    }
    this.pending = undefined;
    const trashFailed = await this.trashUpgraded(plan);
    if (plan.skipped.length) this.deps.report?.({ kind: "skipped", names: plan.skipped });
    if (trashFailed.length) this.deps.report?.({ kind: "trash-failed", names: trashFailed });
    return { status: "done", skipped: plan.skipped, trashFailed };
  }

  private async writeUpgrade(plan: UpgradePlan): Promise<void> {
    const { port } = this.deps;
    const settings = this.settings;
    const dirs = this.blockDirectories();
    // The folders are about to be made: the path they get is the one kept, whatever the interface language becomes.
    const pinned = settings.noteStylesFolder ? undefined : this.folder();
    if (plan.oldFiles.length) {
      let present: string[] = [];
      try {
        present = await port.list(dirs.backup);
      } catch {
        present = [];
      }
      await port.createFolder(dirs.backup);
      const taken = new Set(present.map(lower));
      const now = this.deps.now?.() ?? new Date();
      for (const old of plan.oldFiles) {
        const name = backupName(old.base, now, taken);
        taken.add(lower(name));
        await port.create(`${dirs.backup}/${name}`, old.text);
      }
    }
    for (const category of ["tone", "template"] as const) {
      const items = plan.blocks.filter(block => block.category === category);
      if (!items.length) continue;
      await port.createFolder(dirs[category]);
      for (const item of items) await port.create(`${dirs[category]}/${item.base}.md`, item.text);
    }
    // data.json: the new keys only where they have no value, the aliases, then the marker; undone when the save fails.
    const before = {
      noteStylesFolder: settings.noteStylesFolder,
      noteTemplateBlock: settings.noteTemplateBlock,
      noteToneBlock: settings.noteToneBlock,
      noteStyleAliases: settings.noteStyleAliases,
      noteStyleUpgrade: settings.noteStyleUpgrade
    };
    if (pinned !== undefined && (plan.oldFiles.length || plan.blocks.length)) settings.noteStylesFolder = pinned;
    if (plan.keys.noteTemplateBlock && !settings.noteTemplateBlock)
      settings.noteTemplateBlock = plan.keys.noteTemplateBlock;
    if (plan.keys.noteToneBlock && !settings.noteToneBlock) settings.noteToneBlock = plan.keys.noteToneBlock;
    if (Object.keys(plan.aliases).length) settings.noteStyleAliases = { ...plan.aliases, ...settings.noteStyleAliases };
    settings.noteStyleUpgrade = { version: NOTE_STYLE_UPGRADE_VERSION };
    try {
      await this.deps.save();
    } catch (error) {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete settings[key as keyof typeof before];
        else (settings as unknown as Record<string, unknown>)[key] = value;
      }
      throw error;
    }
  }

  /** The old files that became blocks go to the trash, each only while it still holds the text that was backed up. */
  private async trashUpgraded(plan: UpgradePlan): Promise<string[]> {
    const { port } = this.deps;
    const folder = this.folder();
    const failed: string[] = [];
    for (const old of plan.oldFiles) {
      const path = `${folder}/${old.base}.md`;
      try {
        if ((await port.read(path)) !== old.text) throw new Error("changed");
        await port.trash(path);
        this.files.delete(old.base);
      } catch {
        failed.push(old.base);
      }
    }
    return failed;
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

/** An exported file's sections take the role and old names of the same-named section of the original template. */
function inheritRoles(parsed: DetailTemplate, original: DetailTemplate): void {
  for (const section of parsed.sections) {
    const key = lower(section.name.trim());
    const match = original.sections.find(item => sectionKeys(item).includes(key));
    if (!match) continue;
    if (section.role === "none" && match.role !== "none" && !parsed.sections.some(other => other.role === match.role))
      section.role = match.role;
    const names = new Set(parsed.sections.map(item => lower(item.name.trim())));
    for (const alias of [match.name, ...match.aliases]) {
      if (!alias.trim() || names.has(lower(alias.trim())) || section.aliases.some(a => lower(a) === lower(alias)))
        continue;
      section.aliases.push(alias);
    }
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
      trash: async () => undefined
    },
    save: async () => undefined
  });
}
