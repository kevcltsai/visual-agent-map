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
  resolveTemplate,
  sectionKeys,
  STANDARD_TEMPLATE_ID,
  TEXTBOOK_TEMPLATE_ID,
  type DetailTemplate
} from "./detail-templates";
import {
  builtinStyleFileName,
  canonicalContent,
  CANONICAL_LANGUAGES,
  CANONICAL_VERSIONS,
  matchCanonical,
  normalizeStyleContent,
  NOTE_STYLE_BUILTIN_IDS,
  parseNoteStyleFile,
  serializeLegacyV1,
  type NoteStyle,
  type NoteStyleBuiltinId,
  type NoteStyleIssue
} from "./note-style-file";
import { DEFAULT_TONE_ID, findPreset, listPresets, resolveToneText, type PromptPreset } from "./prompt-presets";

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
  workspaceFolder: string;
  language: UiLanguage;
}

/** The two stored values of each level the chain looks at, most specific first (run choice, topic, map). */
export interface StyleLevel {
  template?: string;
  tone?: string;
}

export interface StyleResolution {
  template: DetailTemplate;
  /** Template ids that were asked for but could not be used (as `resolveTemplate` reports them). */
  missing: string[];
  toneText?: string;
  /** Set when a style file decided the template; absent for built-in and old paths. */
  noteStyle?: NoteStyle;
  /** The file used (with ".md"), for the progress label. */
  fileName?: string;
  /** A style file that was chosen but does not parse: the run must not start. */
  invalid?: { fileName: string; issues: NoteStyleIssue[] };
  /** Set when the workspace template block was changed or is the user's own: the choice to send as `styleSelection`. */
  block?: BlockChoice;
  /** Set with `block` when its text cannot be read: the built-in template stands in, and these say why. */
  blockIssues?: BlockIssue[];
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

export type RestoreBlockResult =
  | { ok: true; backup: string }
  | { ok: false; reason: "not-builtin" | "no-override" | "read-failed" | "backup-failed" | "trash-failed" };

export type StyleListItem =
  | { kind: "builtin"; id: NoteStyleBuiltinId; fileName: string; issues: NoteStyleIssue[] }
  | { kind: "file"; id: string; name: string; fileName: string; issues: NoteStyleIssue[] }
  | { kind: "legacy"; id: string; name: string; fileName: string; issues: NoteStyleIssue[] };

const stripMd = (name: string) => name.replace(/\.md$/i, "");
const lower = (value: string) => value.toLocaleLowerCase();
const SAFE_NAME = /[\\/:*?"<>|#^[\]]/g;

/** Ids of the built-in styles as stored pairs (template id plus tone id); the same table the note-style menu uses. */
const BUILTIN_PAIRS: Record<NoteStyleBuiltinId, { template: string; tone: string }> = {
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

/**
 * The writing tone of a run: a note style file decides its own (the answer made with the template, `resolution`), else the
 * first of `ids` that names a tone preset. Academic (and nothing chosen) is undefined so prompts stay unchanged.
 */
export function runToneText(
  resolution: StyleResolution | undefined,
  presets: readonly PromptPreset[] | undefined,
  ids: readonly (string | undefined)[],
  language: ContentLanguage
): string | undefined {
  if (resolution?.noteStyle) return resolution.toneText;
  return resolveToneText(presets, ids, language);
}

/** The style fields of a request that names no style of its own (the workspace default), or the style file that stops it. */
export type WorkspaceStyleFields =
  | { invalid: NonNullable<StyleResolution["invalid"]> }
  | ({ invalid?: undefined } & Pick<
      TaskContext,
      "detailTemplate" | "toneText" | "noteStyle" | "styleDiagrams" | "styleSelection"
    >);

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

  /** Reads every style file of the folder once. Call at the start of a run; later calls in the run see this snapshot. */
  async refresh(): Promise<void> {
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

  private builtinNames(id: NoteStyleBuiltinId): string[] {
    const preferred = this.settings.language;
    const languages = [preferred, ...CANONICAL_LANGUAGES.filter(language => language !== preferred)];
    return [...new Set(languages.map(language => builtinStyleFileName(id, language)))];
  }

  /** True when `text` is a built-in's file (canonical, or edited but still carrying its usage comment). */
  private isBuiltinFile(id: NoteStyleBuiltinId, text: string): boolean {
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

  /** The base name of the file that holds a built-in style now, if one is in the folder. */
  private builtinFile(id: NoteStyleBuiltinId): string | undefined {
    for (const name of this.builtinNames(id)) {
      const matches = [...this.files.keys()]
        .filter(
          base =>
            lower(base) === lower(name) || new RegExp(`^${escapeRegExp(lower(name))} \\(\\d+\\)$`).test(lower(base))
        )
        .sort();
      const found = matches.find(base => this.isBuiltinFile(id, this.files.get(base)!));
      if (found) return found;
    }
    return undefined;
  }

  /**
   * The built-in a file base name stands for ("restore default" applies to it). The name alone is not enough: a user's own
   * file that happens to be called "Standard" is a `style:` file. When the snapshot holds the file its content must be a
   * built-in's file; `restoreDefault` checks the live content again.
   */
  builtinIdOfFile(baseName: string): { id: NoteStyleBuiltinId; language: UiLanguage } | undefined {
    const base = stripMd(baseName);
    const key = lower(base);
    for (const id of NOTE_STYLE_BUILTIN_IDS)
      for (const language of CANONICAL_LANGUAGES) {
        const name = lower(builtinStyleFileName(id, language));
        if (key !== name && !new RegExp(`^${escapeRegExp(name)} \\(\\d+\\)$`).test(key)) continue;
        const held = [...this.files.keys()].find(item => lower(item) === key);
        if (held !== undefined && !this.isBuiltinFile(id, this.files.get(held)!)) continue;
        return { id, language };
      }
    return undefined;
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
      const isBlock = index === all.length - 1 && !!settings.noteTemplateBlock && id === settings.noteTemplateBlock;
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
   * Fields to spread into a TaskContext: the style snapshot, `styleDiagrams: false` only when the file turns charts off,
   * and, when the template is the workspace's changed or own block, `styleSelection` (its text, and the tone choice of
   * `toneText`). A call that names no tone and no language gets what it got before.
   */
  contextFields(
    template: DetailTemplate | undefined,
    toneText?: string,
    language?: ContentLanguage
  ): { noteStyle?: NoteStyle; styleDiagrams?: false; styleSelection?: StyleSelection } {
    const resolution = this.resolutionOf(template);
    const style = resolution?.noteStyle;
    const fields: { noteStyle?: NoteStyle; styleDiagrams?: false; styleSelection?: StyleSelection } = style
      ? { noteStyle: style, ...(style.diagrams ? {} : { styleDiagrams: false as const }) }
      : {};
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
    const presets = this.settings.promptPresets;
    if (resolution?.noteStyle) return runToneText(resolution, presets, ids, language);
    const workspace = this.workspaceTone();
    if (!workspace) return resolveToneText(presets, ids, language);
    if ("id" in workspace) return resolveToneText(presets, [...ids, workspace.id], language);
    // The workspace tone is a text: it fills the gap only when no tone preset is named by the run, topic or map.
    if (ids.some(id => findPreset(presets, "tone", id, language))) return resolveToneText(presets, ids, language);
    return workspace.text.trim() || undefined;
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
  private workspaceTone(): { id: string } | { text: string } | undefined {
    const settings = this.settings;
    if (settings.noteToneBlock) {
      const ref = parseBlockRef(settings.noteToneBlock);
      if (ref?.kind === "builtin") {
        if (!this.isBuiltinBlockId("tone", ref.id)) return undefined;
        const base = this.overrideBase("tone", ref.id);
        const text = base === undefined ? undefined : this.blocks.tone.get(base);
        if (text !== undefined && !isUnmodifiedBlock("tone", ref.id, text)) return { text };
        return { id: ref.id };
      }
      if (ref?.kind === "file") {
        const text = this.blocks.tone.get(ref.base);
        return text === undefined ? undefined : { text };
      }
      return undefined;
    }
    const preset = NOTE_STYLE_BUILTIN_IDS.find(id => id === settings.defaultNoteStyleId);
    return preset ? { id: BUILTIN_PAIRS[preset].tone } : undefined;
  }

  private remember(resolution: StyleResolution): StyleResolution {
    if (resolution.noteStyle || resolution.block) this.resolutions.set(resolution.template, resolution);
    return resolution;
  }

  private workspaceLevel(): StyleLevel {
    const settings = this.settings;
    if (settings.noteTemplateBlock) return { template: settings.noteTemplateBlock };
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
    if (id.startsWith("style:")) {
      const base = id.slice("style:".length);
      const text = this.files.get(base);
      if (text === undefined) return undefined;
      return this.fromFile(parseNoteStyleFile(text, { id, name: base }), `${base}.md`, level, toneChain, "user");
    }
    const exported = settings.noteStyleFiles?.[id];
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
      const tone = toneChain.find(toneId => findPreset(settings.promptPresets, "tone", toneId, settings.language));
      const builtin = builtinPairOf(id, tone);
      const base = builtin ? this.builtinFile(builtin) : undefined;
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
    if (kind !== "builtin") {
      // A user file: tones of the same or a more specific level win. An old template's file: the whole chain, as today.
      const chain = kind === "legacy" ? toneChain : toneChain.slice(0, level + 1);
      const known = chain.find(toneId => findPreset(settings.promptPresets, "tone", toneId, settings.language));
      if (known !== undefined) toneText = resolveToneText(settings.promptPresets, chain, settings.language);
      else if (style.tone) toneText = this.toneFromFile(style.tone);
    } else if (style.tone) toneText = this.toneFromFile(style.tone);
    return { template: style.template, missing: [], ...(toneText ? { toneText } : {}), noteStyle: style, fileName };
  }

  /** `語氣` is the name or id of an existing tone (its full text is used), else free text. */
  private toneFromFile(raw: string): string | undefined {
    const settings = this.settings;
    const key = lower(raw.trim());
    const pools = [settings.language, ...LANGUAGES.map(language => language.id)].map(language =>
      listPresets(settings.promptPresets, "tone", language)
    );
    for (const pool of pools) {
      const found = pool.find(item => lower(item.id) === key || lower(item.name) === key);
      if (found) return found.id === DEFAULT_TONE_ID ? undefined : found.text.trim() || undefined;
    }
    return raw.trim() || undefined;
  }

  // ---- lists for the entries ----

  /** Every style in the folder with its parse result, for the pickers (call `refresh()` first). */
  list(): StyleListItem[] {
    const settings = this.settings;
    const exportedBy = new Map<string, string>(
      Object.entries(settings.noteStyleFiles ?? {}).map(([uuid, name]) => [lower(stripMd(name)), uuid])
    );
    const items: StyleListItem[] = [];
    for (const [base, text] of [...this.files].sort(([a], [b]) => a.localeCompare(b))) {
      const builtin = NOTE_STYLE_BUILTIN_IDS.find(id => this.builtinFile(id) === base);
      const uuid = exportedBy.get(lower(base));
      const id = builtin ? builtin : (uuid ?? `style:${base}`);
      const parsed = parseNoteStyleFile(text, { id: typeof id === "string" ? id : base, name: base });
      const issues = parsed.ok ? [] : parsed.issues;
      if (builtin) items.push({ kind: "builtin", id: builtin, fileName: `${base}.md`, issues });
      else if (uuid) items.push({ kind: "legacy", id: uuid, name: base, fileName: `${base}.md`, issues });
      else items.push({ kind: "file", id: `style:${base}`, name: base, fileName: `${base}.md`, issues });
    }
    return items;
  }

  /** Old custom templates that have no style file yet (still pickable as before). */
  unexportedTemplates(): DetailTemplate[] {
    const map = this.settings.noteStyleFiles ?? {};
    return this.settings.detailTemplates.filter(template => !map[template.id]);
  }

  // ---- writing files (only on a user action) ----

  private uniqueName(base: string, taken: Set<string>): string {
    let name = base;
    for (let n = 2; taken.has(lower(name)); n++) name = `${base} (${n})`;
    return name;
  }

  /**
   * Creates the folder and the files that do not exist yet: the five built-ins, and an export of every old custom template.
   * Safe to run again. Never overwrites: a name taken by another file gets a unique name instead.
   */
  async ensureStyleFolder(): Promise<string> {
    const settings = this.settings;
    const { port } = this.deps;
    const folder = this.folder();
    let dirty = false;
    if (!settings.noteStylesFolder) {
      settings.noteStylesFolder = folder;
      dirty = true;
    }
    await port.createFolder(folder);
    await this.refresh();
    const taken = new Set([...this.files.keys()].map(lower));
    const write = async (base: string, content: string) => {
      await port.create(`${folder}/${base}.md`, content);
      this.files.set(base, content);
      taken.add(lower(base));
    };
    for (const id of NOTE_STYLE_BUILTIN_IDS) {
      if (this.builtinFile(id) !== undefined) continue;
      await write(
        this.uniqueName(builtinStyleFileName(id, settings.language), taken),
        canonicalContent(id, settings.language)
      );
    }
    const map = { ...(settings.noteStyleFiles ?? {}) };
    const claimed = new Set(Object.values(map).map(name => lower(stripMd(name))));
    for (const template of settings.detailTemplates) {
      if (map[template.id]) continue;
      const wanted = template.name.replace(SAFE_NAME, " ").replace(/\s+/g, " ").trim() || "Style";
      const existing = [...this.files.keys()].find(base => lower(base) === lower(wanted));
      if (
        existing !== undefined &&
        !claimed.has(lower(existing)) &&
        this.legacyUnchanged(template, this.files.get(existing)!)
      ) {
        map[template.id] = `${existing}.md`;
        claimed.add(lower(existing));
        dirty = true;
        continue;
      }
      const base = this.uniqueName(wanted, taken);
      await write(base, serializeLegacyV1(template, settings.language));
      map[template.id] = `${base}.md`;
      claimed.add(lower(base));
      dirty = true;
    }
    if (Object.keys(map).length && JSON.stringify(map) !== JSON.stringify(settings.noteStyleFiles ?? {})) {
      settings.noteStyleFiles = map;
      dirty = true;
    }
    if (dirty) await this.deps.save();
    return folder;
  }

  /** Moves the built-in's file to the trash, then writes its standard content again. */
  async restoreDefault(path: string): Promise<boolean> {
    const name = path.split("/").pop() ?? path;
    const builtin = this.builtinIdOfFile(name);
    if (!builtin) return false;
    let live: string;
    try {
      live = await this.deps.port.read(path);
    } catch {
      return false;
    }
    if (!this.isBuiltinFile(builtin.id, live)) return false;
    await this.deps.port.trash(path);
    await this.deps.port.create(path, canonicalContent(builtin.id, builtin.language));
    this.files.set(stripMd(name), canonicalContent(builtin.id, builtin.language));
    return true;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
