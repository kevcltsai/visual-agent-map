import { parentPath, baseName } from "./core/repository-paths";
import { moveTopicsWithRollback, type OrganizeMove, type OrganizePlan, type MoveProgress } from "./core/repository-workspace-move";
import type { Status, ModelSource, TopicState, TopicCollection, Note, NotePatch } from "./core/repository-note-types";
import { relocateFile } from "./core/repository-relocation";
import { managedMapContainers, isManagedMapPath, type Settings } from "./core/repository-settings";
import {
  DETAIL_START,
  splitOpenItems,
  noteContentLanguage,
  placeholder,
  previewHeading,
  CANONICAL_HEADINGS,
  isCanonical,
  noteHeadingSet,
  writtenHeadingSet,
  canonicalHeadings,
  isBookCardFrontmatter,
  decodeCalloutSections,
  previewSection,
  detailWithOpenItems,
  section,
  replaceSection,
  originMarkdown,
  readThinkingOrigin,
  replaceSummarySection,
  removeSection,
  ensurePreview,
  withoutReference,
  detailWithVisualReferences,
  initialPreview,
  PREVIEW_MANUAL,
  readPreviewAutoHash,
  followedPreview,
  noteBody,
  normalizeBodyOrder,
  localizeHeadings
} from "./core/repository-note-body";
import {
  REFERENCE_TEXT,
  relationReferences,
  derivedLabelLanguage,
  withReferenceLinks,
  noteLink,
  localizeReference
} from "./core/repository-note-references";
import { frontmatter, marker, setFrontmatterKeys } from "./core/repository-frontmatter";
import { rebaseMapNotePaths, moveNotePath, writeMapContent, coordinatePrint } from "./core/repository-map-content";
import { escapeRegExp } from "./core/escape-regexp";
import { foldEntryName, linkAlias, safeName } from "./core/repository-names";
import { App, TAbstractFile, TFile, TFolder, normalizePath, stringifyYaml } from "obsidian";
import { isPlaceholder } from "./core/note-placeholder";
import { resolveMapOutputLanguage } from "./core/content-language";
import { resolveMapTextLanguage, textLanguageOf } from "./experiences/visual-map/map-text-language";
import {
  changeTopicStyles,
  readTopicColor,
  readTopicStyle,
  setTopicStyle,
  toggleTopicStyle,
  type TopicColor,
  type TopicStyle
} from "./topic-colors";
import { addTopicLink, readTopicLinks, removeTopicLink, type AddTopicLinkResult } from "./topic-links";
import { changeTopicMarkers, readTopicMarkers, toggleTopicMarker, type TopicMarker } from "./topic-markers";
import {
  contentLocale,
  noteHeadingsOf,
  noteLanguageOf,
  translate,
  translateNote,
  uiLanguageOfHeadings,
  uiLocale,
  type NoteHeadings,
  type NoteLanguage,
  type TranslationKey
} from "./i18n";
import type { CanvasItem } from "./experiences/visual-map/canvas-items";
import { MapDocument, MapNode, serializeMap, parseMap } from "./map-model";
import type { ReasoningLevel } from "./ai/types";
import { normalizeReasoningLevel } from "./ai/task-policy";
import { resolveTaskModel } from "./ai/model-resolution";
import { standardTemplate, type DetailTemplate } from "./ai/detail-templates";
import { readOnce, type NoteReadContext } from "./core/note-read-context";
import { splitFrontmatter } from "./core/link-rewrite";
import { rewriteCopiedLinks } from "./core/copy-links";
import { mentionsOldPath, rebasePathList, type RenamePair } from "./core/rename-batch";
import {
  managedHeadingValue,
  readRelevance,
  readAiLocked,
  readTopicKind,
  readHypothesisStrength,
  readHypothesisLeaning,
  readRawHypothesisStrength,
  resolveHypothesisWrite,
  type HypothesisStrength,
  type HypothesisLeaning,
  type TopicKind,
  readRelevanceGoal,
  normalizeRelevanceGoal,
  normalizeRelevanceContext,
  readRelevanceContext,
  type NoteRelevance
} from "./note-values";
import {
  MAP_SOURCES_KEY,
  readMapSources,
  serializeMapSources,
  type MapSource
} from "./experiences/visual-map/map-sources";
import { upgradeLegacyAimText } from "./core/legacy-names";
import { managedNodeIds } from "./core/argument-map/model";
import {
  bookSettingsFrontmatter,
  pipelineFrontmatter,
  readBookSettings,
  readPipelineFields,
  type BookRole,
  type BookSettingsPatch,
  type PipelineFieldsPatch
} from "./core/book-pipeline/model";
export type { ReasoningLevel, ResearchDepth, ResearchMode, VisualMode, VisualReference } from "./ai/types";
export { normalizeReasoningLevel } from "./ai/task-policy";
export { linkAlias, safeName } from "./core/repository-names";
export { noteHeadingLanguage, localizeHeadings } from "./core/repository-note-body";
export { setFrontmatterKeys } from "./core/repository-frontmatter";
export { rebaseMapNotePaths, moveNotePath, coordinatePrint } from "./core/repository-map-content";
export { isPlaceholder };
export type { OrganizeMove, OrganizePlan, MoveProgress } from "./core/repository-workspace-move";
export type { Status, ModelSource, TopicState, TopicCollection, Note, NotePatch } from "./core/repository-note-types";
export {
  DEFAULT_SETTINGS,
  defaultProofModel,
  resolveMapFolders,
  managedMapContainers,
  managedMapContainer,
  isManagedMapPath,
  normalizeMapChatWidth,
  normalizeMapChatOpen,
  normalizeMapChatImageMode,
  type Settings
} from "./core/repository-settings";

export interface TopicInfo {
  id: string;
  title: string;
  mapPath: string;
  root: string;
}
/** One map row of the map switcher: what tells maps apart (size, last edit, where it lives). */
export interface MapSwitcherItem {
  title: string;
  mapPath: string;
  /** Topics on the map. */
  topicCount: number;
  /** Map.md's last modification time (ms). */
  modified: number;
  /** The folder that holds the map's topic folder. */
  folder: string;
}
export interface BrokenTopic {
  title: string;
  root: string;
  noteCount: number;
}
const NOTE_CSS_CLASS = "visual-agent-map-node";
/** Longest `last-error` stored in a note. */
export const LAST_ERROR_LIMIT = 300;
/** The failure reason kept on a note: the raw error message, whitespace collapsed, cut to {@link LAST_ERROR_LIMIT}. */
export function failureReason(error: unknown): string {
  const raw = (error as { message?: unknown } | null | undefined)?.message;
  const message = (typeof raw === "string" ? raw : String(error)).replace(/\s+/g, " ").trim();
  const characters = [...message];
  return characters.length > LAST_ERROR_LIMIT ? `${characters.slice(0, LAST_ERROR_LIMIT - 1).join("")}…` : message;
}
function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function ensureNoteCssClass(fm: Record<string, unknown>): boolean {
  const current = Array.isArray(fm.cssclasses)
    ? fm.cssclasses.map(String)
    : typeof fm.cssclasses === "string"
      ? fm.cssclasses.split(/[\s,]+/).filter(Boolean)
      : [];
  if (current.includes(NOTE_CSS_CLASS)) return false;
  fm.cssclasses = [...current, NOTE_CSS_CLASS];
  return true;
}

/** Folder name of a map, used as the link alias when the map title has nothing usable in it. */
function aliasFallback(mapPath: string): string {
  return parentPath(mapPath).split("/").at(-1) || mapPath;
}

/** What a map chat reply changes in a topic's appearance; see {@link Repository.writeTopicAppearance}. */
export interface TopicAppearanceChange {
  /** A colour, null to remove it; absent keeps it. */
  color?: TopicColor | null;
  addMarkers?: readonly TopicMarker[];
  removeMarkers?: readonly (TopicMarker | "all")[];
  addStyles?: readonly TopicStyle[];
  removeStyles?: readonly (TopicStyle | "all")[];
}
/** The frontmatter keys an appearance change writes: only those whose value really changes (null removes a key). */
export function topicAppearanceValues(
  fm: Record<string, unknown>,
  change: TopicAppearanceChange
): Record<string, string | string[] | null> {
  const values: Record<string, string | string[] | null> = {};
  const same = (next: unknown, raw: unknown): boolean =>
    JSON.stringify(next) === JSON.stringify(raw === undefined ? null : raw);
  if (change.color !== undefined && (readTopicColor(fm) ?? null) !== change.color) values["topic-color"] = change.color;
  if (change.addMarkers?.length || change.removeMarkers?.length) {
    const next = changeTopicMarkers(fm["topic-markers"], change.addMarkers ?? [], change.removeMarkers ?? []);
    if (!same(next, fm["topic-markers"])) values["topic-markers"] = next;
  }
  if (change.addStyles?.length || change.removeStyles?.length) {
    const next = changeTopicStyles(fm["topic-style"], change.addStyles ?? [], change.removeStyles ?? []);
    if (!same(next, fm["topic-style"])) values["topic-style"] = next;
  }
  return values;
}

const localDate = (date = new Date()): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
/** What the map file's frontmatter said about the goal before a write; handed back to restore it exactly. */
export interface RelevanceGoalState {
  goal: string | undefined;
  history: string[] | undefined;
  context?: string | undefined;
}
/** The two setup values of a map's relevance grading, as read from the map file. */
export interface RelevanceSetup {
  goal: string | undefined;
  context: string | undefined;
}

/** Everything one read of Map.md gives: the document and its frontmatter values. */
export interface MapMeta extends RelevanceSetup {
  map: MapDocument;
  sources: MapSource[];
}

function noteTitle(content: string, fm: Record<string, unknown>, fallback: string): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  return /^# (.+)$/m.exec(body)?.[1]?.trim() || text(fm.title, fallback);
}

/** Files an OS leaves in a folder; they do not make it non-empty. */
const OS_LITTER = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const VAULT_WRITES = new Set([
  "create",
  "createBinary",
  "createFolder",
  "modify",
  "process",
  "append",
  "delete",
  "trash",
  "rename",
  "copy"
]);
const FILE_MANAGER_WRITES = new Set(["renameFile", "trashFile", "processFrontMatter"]);

/** A view of `target` whose write methods throw once `disposed()` is true; reads and everything else pass through. */
function guardWrites<T extends object>(
  target: T,
  writes: Set<string>,
  disposed: () => boolean,
  message: () => string
): T {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object) as unknown;
      if (typeof property !== "string" || typeof value !== "function") return value;
      const call = value as (this: object, ...args: unknown[]) => unknown;
      return writes.has(property)
        ? (...args: unknown[]) => {
            if (disposed()) return Promise.reject(new Error(message()));
            return Reflect.apply(call, object, args);
          }
        : (...args: unknown[]): unknown => Reflect.apply(call, object, args);
    }
  });
}

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class Repository {
  readonly app: App;
  /** Set when the plugin unloads: from then on no Repository write point does anything (in-flight work stops at its next write). */
  private disposed = false;
  /** Per Map.md path: the node coordinates of the last text this plugin wrote there (memory only; see {@link coordinatesChangedOutside}). */
  private readonly writtenCoordinates = new Map<string, string>();

  constructor(
    app: App,
    readonly settings: Settings
  ) {
    const stopped = (): boolean => this.disposed;
    const message = (): string => this.message("error.unloaded_write_not_performed");
    this.app = new Proxy(app, {
      get(object, property) {
        const value = Reflect.get(object, property, object) as unknown;
        if (property === "vault") return guardWrites(value as object, VAULT_WRITES, stopped, message);
        if (property === "fileManager") return guardWrites(value as object, FILE_MANAGER_WRITES, stopped, message);
        return value;
      }
    });
  }

  /**
   * The single decision of which language a note's derived scaffolding (relationship labels, Preview heading, summary
   * placeholder, Reference Links) is written in: the language it already has, else the current UI language. Every writer
   * of such text uses this, so no write path can relabel a note just because the UI language differs.
   */
  scaffoldLanguage(content: string, fm: Record<string, unknown>): NoteLanguage {
    const headings = noteHeadingSet(content) ?? CANONICAL_HEADINGS;
    return (
      derivedLabelLanguage(canonicalHeadings(content, headings), fm) ??
      (isCanonical(headings) ? undefined : noteLanguageOf(uiLanguageOfHeadings(headings))) ??
      this.noteLanguage
    );
  }

  /** Called from onunload: no later write (including a rollback) may happen. */
  dispose(): void {
    this.disposed = true;
  }
  isDisposed(): boolean {
    return this.disposed;
  }

  /** Containers that temporarily count as managed while a folder-setting change moves topics into them. */
  private pendingContainers: string[] = [];
  /** Called once per vault-wide scan that skipped unreadable maps. */
  onUnreadableMaps?: (failures: { path: string; error: string }[]) => void;

  /** The language fixed note text is written in for the current interface language (always "zh-TW" or "en"). */
  private get noteLanguage(): NoteLanguage {
    return noteLanguageOf(this.settings.language);
  }

  /**
   * The language a new note's section headings are written in (C8): the interface language, unless the note's fixed
   * text is in another language (an AIM note in English under a Chinese interface keeps English headings).
   */
  private headingsFor(textLanguage: NoteLanguage): NoteHeadings {
    return noteHeadingsOf(contentLocale(textLanguage, uiLocale(this.settings.language)));
  }

  private message(key: TranslationKey): string {
    return translate(this.settings.language, key);
  }

  file(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`${this.message("error.file_not_found")}: ${path}`);
    return file;
  }

  hasNote(path: string): boolean {
    return this.app.vault.getAbstractFileByPath(path) instanceof TFile;
  }

  async folder(path: string): Promise<void> {
    let current = "";
    for (const part of normalizePath(path).split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }

  /** The first part of `path` that is a file rather than a folder (it blocks the folder), or null when none does. */
  blockingFile(path: string): string | null {
    let current = "";
    for (const part of normalizePath(path).split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      const entry = this.app.vault.getAbstractFileByPath(current);
      if (entry && !(entry instanceof TFolder)) return current;
    }
    return null;
  }

  workspaceExists(): boolean {
    return this.app.vault.getAbstractFileByPath(this.settings.workspaceFolder) instanceof TFolder;
  }

  async workspaceCandidates(): Promise<string[]> {
    const candidates = new Set<string>();
    // The folder names are the configured ones (relative to the workspace folder) plus the defaults and legacy Topics.
    const workspace = `${this.settings.workspaceFolder}/`;
    const names = new Set(["Topics", "Mind Maps", "AIM"]);
    for (const folder of managedMapContainers(this.settings))
      names.add(folder.startsWith(workspace) ? folder.slice(workspace.length) : (folder.split("/").at(-1) ?? folder));
    const containerPattern = new RegExp(`^(.*)/(?:${[...names].map(escapeRegExp).join("|")})/[^/]+/Map\\.md$`);
    for (const file of this.app.vault.getMarkdownFiles()) {
      const match = file.path.match(containerPattern);
      if (!match?.[1]) continue;
      try {
        parseMap(await this.app.vault.read(file));
        candidates.add(match[1]);
      } catch {
        /* Ignore unrelated files named Map.md. */
      }
    }
    return [...candidates].sort((left, right) => left.localeCompare(right));
  }

  async ensureWorkspace(): Promise<void> {
    await this.folder(this.settings.mindMapsFolder);
  }

  unique(folder: string, name: string, avoid?: ReadonlySet<string>): string {
    const base = normalizePath(`${folder}/${safeName(name)}`);
    let path = `${base}.md`,
      number = 2;
    while (avoid?.has(path) || this.pathTaken(path)) path = `${base} ${number++}.md`;
    return path;
  }

  /** `folder/<title>.md` when that exact name is free (no number added), else null. */
  exactFreePath(folder: string, title: string): string | null {
    const path = normalizePath(`${folder}/${safeName(title)}.md`);
    return this.pathTaken(path) ? null : path;
  }

  /** Taken when the path exists, or when a sibling has the same name once case and Unicode form are folded. */
  private pathTaken(path: string): boolean {
    return !!this.app.vault.getAbstractFileByPath(path) || !!this.foldedSibling(path, "");
  }

  /** A child of `path`'s folder whose folded name equals `path`'s, other than `exclude`. */
  private foldedSibling(path: string, exclude: string): TAbstractFile | null {
    const folder = this.app.vault.getAbstractFileByPath(parentPath(path));
    if (!(folder instanceof TFolder)) return null;
    const wanted = foldEntryName(path.split("/").at(-1) ?? path, /\.md$/i.test(path));
    return (
      folder.children.find(
        child => child.path !== exclude && foldEntryName(child.name, child instanceof TFile) === wanted
      ) ?? null
    );
  }

  uniqueFolder(folder: string, name: string): string {
    const base = normalizePath(`${folder}/${safeName(name)}`);
    let path = base,
      number = 2;
    while (this.app.vault.getAbstractFileByPath(path) || this.foldedSibling(path, "")) path = `${base} ${number++}`;
    return path;
  }

  topicRoot(mapPath: string): string {
    return parentPath(mapPath);
  }
  topicFolder(mapPath: string, collection: TopicCollection): string {
    return `${this.topicRoot(mapPath)}/${collection}`;
  }

  async ensureTopicFolders(root: string): Promise<void> {
    await this.folder(root);
    for (const name of ["Notes", "Unassigned", "Archive"]) await this.folder(`${root}/${name}`);
  }

  /**
   * The model a topic actually runs on. The stored `model:` is a creation-time snapshot and is never rewritten:
   * manual keeps it, workspace follows the current setting, inherited uses the nearest manual ancestor's stored model
   * and otherwise the current setting. `overridden` is true when the model comes from a manual topic or ancestor.
   */
  private async effectiveModel(
    path: string,
    stored: string | undefined,
    source: ModelSource,
    map?: MapDocument,
    storedReasoning?: string,
    ctx?: NoteReadContext
  ): Promise<{ model: string; overridden: boolean; reasoning?: string }> {
    if (source === "manual")
      return {
        model: stored || this.settings.cliModel,
        overridden: Boolean(stored),
        reasoning: storedReasoning || undefined
      };
    if (source === "workspace") return { model: this.settings.cliModel, overridden: false };
    let node = this.nodeAtPath(path, map, ctx);
    let owner = node ? map : undefined;
    if (!owner) {
      for (const file of await this.mapFiles()) {
        if (!path.startsWith(`${this.topicRoot(file.path)}/`)) continue;
        try {
          const candidate = await this.readMap(file.path);
          node = candidate.nodes.find(item => item.path === path);
          if (node) {
            owner = candidate;
            break;
          }
        } catch {
          /* An unreadable map cannot supply ancestors. */
        }
      }
    }
    const seen = new Set<string>();
    const byId = ctx && owner && ctx.map === owner ? ctx.nodesById : undefined;
    while (node && node.parentId && !seen.has(node.id)) {
      seen.add(node.id);
      const parentId = node.parentId;
      const parent = byId ? byId.get(parentId) : owner!.nodes.find(item => item.id === parentId);
      if (!parent) break;
      const fm = await this.ancestorFrontmatter(parent.path, ctx);
      if (fm && fm["model-source"] === "manual" && text(fm.model))
        return { model: text(fm.model), overridden: true, reasoning: text(fm["reasoning-level"]) || undefined };
      node = parent;
    }
    return { model: this.settings.cliModel, overridden: false };
  }

  /** Reuse the hydrate's path index only for the map it was built from. */
  private nodeAtPath(path: string, map?: MapDocument, ctx?: NoteReadContext): MapNode | undefined {
    return map && ctx?.map === map ? ctx.nodesByPath.get(path) : map?.nodes.find(item => item.path === path);
  }

  /**
   * An ancestor note's frontmatter, or null when it is missing or unreadable (the walk skips it). With a context the
   * file is read once per hydrate; an existing file whose read throws is recorded in `ctx.failedPaths`.
   */
  private async ancestorFrontmatter(path: string, ctx?: NoteReadContext): Promise<Record<string, unknown> | null> {
    const load = async (): Promise<Record<string, unknown> | null> => {
      try {
        const file = this.file(path);
        const content = ctx
          ? await readOnce(ctx, path, () => this.app.vault.read(file))
          : await this.app.vault.read(file);
        return frontmatter(content);
      } catch {
        /* A missing ancestor note is skipped (a read that threw is already in ctx.failedPaths). */
        return null;
      }
    };
    if (!ctx) return load();
    let pending = ctx.ancestorFm.get(path);
    if (!pending) {
      pending = load();
      ctx.ancestorFm.set(path, pending);
    }
    return pending;
  }

  /**
   * Resolve the model for a topic: run-once choice, then the topic's override (inherited upward), then the current
   * model. Reasoning is resolved together with the model.
   */
  async resolveTopicModel(
    path: string,
    map?: MapDocument,
    runOnce?: { model: string; reasoning?: ReasoningLevel } | null
  ): Promise<ReturnType<typeof resolveTaskModel>> {
    const fm = frontmatter(await this.app.vault.read(this.file(path)));
    const source = this.modelSourceOf(fm);
    const effective = await this.effectiveModel(path, text(fm.model), source, map, text(fm["reasoning-level"]));
    return this.chooseModel(effective, runOnce);
  }

  private modelSourceOf(fm: Record<string, unknown>): ModelSource {
    const raw = text(fm["model-source"], "workspace");
    return raw === "manual" || raw === "inherited" ? raw : "workspace";
  }

  /**
   * One resolveTaskModel over an effective lookup, shared by readNote and resolveTopicModel. Only an override brings
   * its own reasoning (the manual topic's, or its manual ancestor's); a stored value on a workspace or inherited topic
   * is ignored and never rewritten.
   */
  private chooseModel(
    effective: { model: string; overridden: boolean; reasoning?: string },
    runOnce?: { model: string; reasoning?: ReasoningLevel } | null
  ): ReturnType<typeof resolveTaskModel> {
    const current = { model: this.settings.cliModel, reasoning: normalizeReasoningLevel(this.settings.cliReasoning) };
    const overrideReasoning = normalizeReasoningLevel(effective.reasoning ?? this.settings.cliReasoning);
    return resolveTaskModel({
      runOnce,
      override: effective.overridden ? { model: effective.model, reasoning: overrideReasoning } : null,
      current
    });
  }

  /**
   * What "follow the default" resolves to for a topic: a root follows the workspace model, a child follows its upper
   * topic (nearest manual ancestor, else the workspace model; `overridden` tells which).
   */
  async followDefaultModel(
    path: string,
    map?: MapDocument
  ): Promise<{ source: Exclude<ModelSource, "manual">; model: string; overridden: boolean }> {
    const node = map?.nodes.find(item => item.path === path);
    if (!node?.parentId) return { source: "workspace", model: this.settings.cliModel, overridden: false };
    const effective = await this.effectiveModel(path, undefined, "inherited", map);
    // `overridden` is true only when a manual ancestor supplies the model; the menu then says "upper topic", not "current model".
    return { source: "inherited", model: effective.model, overridden: effective.overridden };
  }

  /** True when `path` is a card note an argument map owns (found through the map in its topic folder); an unreadable map names nothing. */
  async isArgumentManagedNote(path: string): Promise<boolean> {
    for (const file of await this.mapFiles()) {
      if (!path.startsWith(`${this.topicRoot(file.path)}/`)) continue;
      try {
        const map = await this.readMap(file.path);
        const node = map.nodes.find(item => item.path === path);
        if (node && managedNodeIds(map).has(node.id)) return true;
      } catch {
        /* An unreadable map cannot supply cards. */
      }
    }
    return false;
  }

  async readNote(path: string, map?: MapDocument, ctx?: NoteReadContext): Promise<Note> {
    const file = this.file(path),
      raw = ctx ? await readOnce(ctx, path, () => this.app.vault.read(file)) : await this.app.vault.read(file);
    return this.parseNote(path, raw, map, ctx);
  }

  /** Parses already-read note content; `readNote` reads the file once and calls this. */
  private async parseNote(path: string, raw: string, map?: MapDocument, ctx?: NoteReadContext): Promise<Note> {
    const file = this.file(path),
      content = decodeCalloutSections(upgradeLegacyAimText(raw)),
      fm = frontmatter(content);
    const status = text(fm.status, "idea");
    const normalized = status === "review" || status === "accepted" ? "completed" : status;
    const modelSource = this.modelSourceOf(fm);
    const effective = await this.effectiveModel(
      path,
      text(fm.model),
      modelSource,
      map,
      text(fm["reasoning-level"]),
      ctx
    );
    const { model, reasoning } = this.chooseModel(effective);
    const state = text(
      fm["topic-state"],
      path.includes("/Archive/") ? "archived" : path.includes("/Unassigned/") ? "unassigned" : "active"
    );
    const preview = previewSection(content),
      contentLanguage = noteContentLanguage(fm),
      relevance = readRelevance(fm),
      bookSettings = readBookSettings(fm),
      topicKind = readTopicKind(fm),
      markers = readTopicMarkers(fm),
      links = readTopicLinks(fm),
      color = readTopicColor(fm),
      style = readTopicStyle(fm);
    return {
      title: noteTitle(content, fm, file.basename),
      summary: section(content, "Current Summary") || text(fm.summary, placeholder(this.noteLanguage)),
      prompt: section(content, "Prompt"),
      rules: section(content, "Rules"),
      detail: detailWithOpenItems(content),
      thinkingOrigin: readThinkingOrigin(content),
      visualReferences: section(content, "Visual References"),
      newFindings: section(content, "Working Findings") || section(content, "New Findings"),
      preview: [preview, section(content, "User Notes")].filter(Boolean).join("\n\n"),
      previewSection: preview,
      previewInitialized: fm["preview-initialized"] === true,
      previewAutoHash: readPreviewAutoHash(fm["preview-auto-hash"]),
      model,
      modelSource,
      ...(effective.overridden ? { modelOverride: true } : {}),
      reasoning,
      researchMode: fm["research-mode"] === "research" ? "research" : "local",
      visualMode: fm["visual-mode"] === "on" || fm["visual-mode"] === "off" ? fm["visual-mode"] : "auto",
      ...(typeof fm["detail-template"] === "string" && fm["detail-template"]
        ? { detailTemplateId: fm["detail-template"] }
        : {}),
      ...(typeof fm.tone === "string" && fm.tone ? { toneId: fm.tone } : {}),
      ...(typeof fm["note-style"] === "string" && fm["note-style"] ? { noteStyle: fm["note-style"] } : {}),
      ...(contentLanguage ? { contentLanguage } : {}),
      ...(relevance ? { relevance } : {}),
      ...(readAiLocked(fm) || managedNodeIds(map).has(this.nodeAtPath(path, map, ctx)?.id ?? "")
        ? { aiLocked: true as const }
        : {}),
      ...readPipelineFields(fm),
      ...(Object.keys(bookSettings).length ? { bookSettings } : {}),
      ...(topicKind !== "topic" ? { topicKind } : {}),
      ...(topicKind === "hypothesis"
        ? { hypothesisLeaning: readHypothesisLeaning(fm), hypothesisStrength: readHypothesisStrength(fm) }
        : {}),
      ...(markers.length ? { markers } : {}),
      ...(links.length ? { links } : {}),
      ...(color ? { color } : {}),
      ...(style.length ? { style } : {}),
      detailFormatIssues: Array.isArray(fm["detail-format-issues"])
        ? fm["detail-format-issues"].filter((v): v is string => typeof v === "string")
        : [],
      lastError: text(fm["last-error"]),
      status: ["idea", "running", "completed", "error"].includes(normalized) ? (normalized as Status) : "idea",
      mapId: text(fm["agent-map-id"]),
      topicId: text(fm["topic-id"], text(fm["agent-map-id"])),
      topicState: ["active", "unassigned", "archived", "inbox"].includes(state) ? (state as TopicState) : "active",
      referencePaths: Array.isArray(fm["reference-materials"])
        ? fm["reference-materials"].filter((value): value is string => typeof value === "string" && Boolean(value))
        : [],
      sourcePaths: Array.isArray(fm["source-notes"])
        ? fm["source-notes"].filter((value): value is string => typeof value === "string" && Boolean(value))
        : []
    };
  }

  /**
   * `options.contentLanguage` is the AIM content language: it only chooses the language of generated placeholder text;
   * headings and the reference frame stay in the interface language. Notes created by AIM remember it in frontmatter.
   */
  async updateNote(
    path: string,
    patch: NotePatch,
    options: {
      contentLanguage?: NoteLanguage;
      detailTemplate?: DetailTemplate;
      /** New AI content: a visual reference whose image the Detail already has keeps its text, without the image line. */
      newVisualReferences?: boolean;
    } = {}
  ): Promise<void> {
    await this.updateNoteGuarded(path, patch, options);
  }

  /**
   * `updateNote` with a guarded commit. Both checks run inside the `vault.process` callback that writes, on the content that
   * callback is given, so nothing the owner typed after the caller's last read is overwritten:
   * - `expectedContent`: the file must still be exactly this text;
   * - `authorize`: called after the content check; false (a stopped run, a removed card) means nothing is written;
   * - `finalize`: called on the text the patch produced, in the same callback; null means the text is refused and nothing is written.
   * Any of them failing leaves the file untouched and returns "discarded". With neither, it is `updateNote`, byte for byte.
   */
  async updateNoteGuarded(
    path: string,
    patch: NotePatch,
    options: {
      contentLanguage?: NoteLanguage;
      detailTemplate?: DetailTemplate;
      newVisualReferences?: boolean;
      expectedContent?: string;
      /** Gets the file text the callback was given (so a check can look at the text as it is now, not as the caller last read it). */
      authorize?: (current?: string) => boolean;
      finalize?: (content: string) => string | null;
    } = {}
  ): Promise<"written" | "discarded"> {
    const { expectedContent, authorize, finalize, ...writeOptions } = options;
    let outcome: "written" | "discarded" = "written";
    await this.app.vault.process(this.file(path), content => {
      if ((expectedContent !== undefined && content !== expectedContent) || (authorize && !authorize(content))) {
        outcome = "discarded";
        return content;
      }
      const next = this.patchedNote(path, content, patch, writeOptions);
      const final = finalize ? finalize(next) : next;
      if (final === null) {
        outcome = "discarded";
        return content;
      }
      return final;
    });
    return outcome;
  }

  /**
   * Rewrites a note's whole text through `transform`, with the same guarded commit as `updateNoteGuarded` (both checks run on
   * the content `vault.process` hands over; `expectedContent` is the text the caller last read, `authorize` false means a
   * stopped run). A transform that returns the text it got writes nothing new. Returns "discarded" when a check failed.
   */
  async updateNoteRawGuarded(
    path: string,
    transform: (content: string) => string,
    options: { expectedContent?: string; authorize?: () => boolean } = {}
  ): Promise<"written" | "discarded"> {
    const { expectedContent, authorize } = options;
    let outcome: "written" | "discarded" = "written";
    await this.app.vault.process(this.file(path), content => {
      if ((expectedContent !== undefined && content !== expectedContent) || (authorize && !authorize())) {
        outcome = "discarded";
        return content;
      }
      return transform(content);
    });
    return outcome;
  }

  /**
   * Marks a note left at `status: running` by a reload as failed. The status and `stillIdle()` are checked inside the same
   * `vault.process` callback that writes, so a task that starts or finishes in between is never overwritten.
   * Returns whether it wrote. Does not take the mutation queue: callers are already inside it.
   */
  async markInterruptedRun(path: string, lastError: string, stillIdle: () => boolean): Promise<boolean> {
    let wrote = false;
    await this.app.vault.process(this.file(path), content => {
      if (frontmatter(content).status !== "running" || !stillIdle()) return content;
      wrote = true;
      return this.patchedNote(path, content, { status: "error", lastError }, {});
    });
    return wrote;
  }

  private patchedNote(
    path: string,
    content: string,
    patch: NotePatch,
    options: { contentLanguage?: NoteLanguage; detailTemplate?: DetailTemplate; newVisualReferences?: boolean }
  ): string {
    const fm = frontmatter(content);
    // One decision for every label this write emits: the note's own scaffolding language (see scaffoldLanguage).
    const language = this.scaffoldLanguage(content, fm);
    ensureNoteCssClass(fm);
    if (Array.isArray(fm["agent-map-references"]))
      fm["agent-map-references"] = fm["agent-map-references"].map(value => localizeReference(String(value), language));
    fm.title = patch.title ?? noteTitle(content, fm, baseName(path).replace(/\.md$/, ""));
    for (const key of ["summary", "model", "status"] as const) if (patch[key] !== undefined) fm[key] = patch[key];
    if (patch.modelSource !== undefined) fm["model-source"] = patch.modelSource;
    if (patch.reasoning !== undefined) fm["reasoning-level"] = normalizeReasoningLevel(patch.reasoning);
    if (patch.researchMode !== undefined) fm["research-mode"] = patch.researchMode;
    if (patch.visualMode !== undefined) fm["visual-mode"] = patch.visualMode;
    if (patch.detailTemplateId !== undefined)
      patch.detailTemplateId ? (fm["detail-template"] = patch.detailTemplateId) : delete fm["detail-template"];
    if (patch.toneId !== undefined) patch.toneId ? (fm.tone = patch.toneId) : delete fm.tone;
    if (patch.noteStyle !== undefined) patch.noteStyle ? (fm["note-style"] = patch.noteStyle) : delete fm["note-style"];
    if (patch.detailFormatIssues !== undefined)
      patch.detailFormatIssues.length
        ? (fm["detail-format-issues"] = patch.detailFormatIssues)
        : delete fm["detail-format-issues"];
    // A completed write ends the failure it follows; running leaves it (a stopped run restores the old status).
    if (patch.lastError !== undefined) patch.lastError ? (fm["last-error"] = patch.lastError) : delete fm["last-error"];
    else if (patch.status === "completed") delete fm["last-error"];
    if (patch.mapId !== undefined) patch.mapId ? (fm["agent-map-id"] = patch.mapId) : delete fm["agent-map-id"];
    if (patch.topicId !== undefined) patch.topicId ? (fm["topic-id"] = patch.topicId) : delete fm["topic-id"];
    if (patch.topicState !== undefined) fm["topic-state"] = patch.topicState;
    if (patch.referencePaths !== undefined)
      patch.referencePaths.length
        ? (fm["reference-materials"] = [...new Set(patch.referencePaths)])
        : delete fm["reference-materials"];
    if (patch.sourcePaths !== undefined)
      patch.sourcePaths.length ? (fm["source-notes"] = patch.sourcePaths) : delete fm["source-notes"];
    fm.updated = new Date().toISOString();
    let body = decodeCalloutSections(content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ""));
    // AIM notes carry their content language; every other note keeps following the interface language.
    const textLanguage = options.contentLanguage ?? noteContentLanguage(fm) ?? language;
    if (options.contentLanguage !== undefined && noteContentLanguage(fm) === undefined)
      fm["content-language"] = options.contentLanguage;
    body = ensurePreview(body, language, textLanguage);
    if (isPlaceholder(text(fm.summary))) fm.summary = placeholder(textLanguage);
    if (patch.title !== undefined) {
      const heading = managedHeadingValue(patch.title);
      body = body.replace(/^# .*$/m, () => `# ${heading}`);
    }
    if (patch.summary !== undefined) body = replaceSummarySection(body, patch.summary);
    if (patch.prompt !== undefined) body = replaceSection(body, "Prompt", patch.prompt);
    if (patch.rules !== undefined) body = replaceSection(body, "Rules", patch.rules);
    // A new detail carries its own open items, if any; the marker of the old one goes with it.
    if (patch.detail !== undefined) body = replaceSection(splitOpenItems(body).text, "Detail", patch.detail);
    if (patch.thinkingOrigin !== undefined)
      body = replaceSection(body, "Thinking Origin", originMarkdown(patch.thinkingOrigin));
    if (patch.visualReferences !== undefined) {
      body = removeSection(body, "Visual References");
      if (patch.visualReferences.trim())
        body = replaceSection(
          body,
          "Detail",
          detailWithVisualReferences(
            section(body, "Detail"),
            patch.visualReferences,
            options.detailTemplate ?? standardTemplate(language),
            options.newVisualReferences === true
          )
        );
    }
    if (patch.newFindings !== undefined) {
      if (patch.newFindings.trim()) body = replaceSection(body, "Working Findings", patch.newFindings);
      else {
        body = removeSection(body, "Working Findings");
        body = removeSection(body, "New Findings");
      }
    }
    if (patch.preview !== undefined) {
      body = replaceSection(body, previewHeading(language), patch.preview);
      fm["preview-initialized"] = true;
      fm["preview-auto-hash"] = PREVIEW_MANUAL;
    } else if (patch.previewSection !== undefined) {
      body = replaceSection(body, previewHeading(language), patch.previewSection);
    } else if (patch.summary !== undefined && patch.summary.trim() && !isPlaceholder(patch.summary)) {
      const result = followedPreview(
        previewSection(body),
        initialPreview(patch.summary, section(body, "Detail")),
        readPreviewAutoHash(fm["preview-auto-hash"]),
        fm["preview-initialized"] === true
      );
      if (result.preview !== null) body = replaceSection(body, previewHeading(language), result.preview);
      fm["preview-auto-hash"] = result.hash;
      fm["preview-initialized"] = true;
    }
    if (patch.previewInitialized !== undefined) fm["preview-initialized"] = patch.previewInitialized;
    if (patch.previewAutoHash !== undefined)
      patch.previewAutoHash ? (fm["preview-auto-hash"] = patch.previewAutoHash) : delete fm["preview-auto-hash"];
    body = normalizeBodyOrder(
      body,
      text(fm.title, path.replace(/\.md$/, "")),
      text(fm.summary, placeholder(textLanguage)),
      language,
      textLanguage,
      isBookCardFrontmatter(fm)
    );
    // Headings stay in the language the note was written in: a language switch never relabels an existing note.
    return `---\n${stringifyYaml(fm)}---\n${localizeHeadings(withReferenceLinks(body, fm, language), writtenHeadingSet(content, this.headingsFor(textLanguage)))}`;
  }

  async createNote(
    title: string,
    model: string,
    map: MapDocument,
    mapPath: string,
    modelSource: ModelSource,
    initial: Pick<NotePatch, "detail" | "thinkingOrigin" | "summary" | "reasoning" | "researchMode"> & {
      topicKind?: TopicKind;
      /** Deprecated alias of `topicKind: "hypothesis"`, kept per decision #30. */
      hypothesis?: true;
      /** A hypothesis's starting leaning and strength (default undecided and none); ignored for other kinds. */
      hypothesisLeaning?: HypothesisLeaning;
      hypothesisStrength?: HypothesisStrength;
    } = {},
    onCreate?: (path: string) => void
  ): Promise<MapNode> {
    const folder = this.topicFolder(mapPath, "Notes");
    await this.ensureTopicFolders(this.topicRoot(mapPath));
    const id = crypto.randomUUID();
    const kind: TopicKind = initial.topicKind ?? (initial.hypothesis ? "hypothesis" : "topic");
    const hypothesisValues =
      kind === "hypothesis"
        ? resolveHypothesisWrite(
            { leaning: "undecided", strength: "none" },
            { leaning: initial.hypothesisLeaning, strength: initial.hypothesisStrength }
          )
        : undefined;
    const metadata = {
      "agent-map-node": true,
      "node-id": id,
      "topic-id": map.id,
      "topic-state": "active",
      "agent-map-id": map.id,
      title,
      summary: placeholder(this.noteLanguage),
      "preview-initialized": false,
      model,
      "model-source": modelSource,
      ...(modelSource === "manual" ? { "reasoning-level": initial.reasoning ?? this.settings.cliReasoning } : {}),
      ...(initial.researchMode ? { "research-mode": initial.researchMode } : {}),
      ...(kind !== "topic" ? { "topic-kind": kind } : {}),
      ...(hypothesisValues
        ? { "hypothesis-leaning": hypothesisValues.leaning, "hypothesis-strength": hypothesisValues.strength }
        : {}),
      status: "idea",
      cssclasses: [NOTE_CSS_CLASS]
    };
    const origin = initial.thinkingOrigin ? `## Thinking Origin\n\n${originMarkdown(initial.thinkingOrigin)}` : "";
    const created = await this.createUniqueNote(
      folder,
      title,
      `---\n${stringifyYaml(metadata)}---\n${localizeHeadings(noteBody(title, initial.summary ?? placeholder(this.noteLanguage), this.noteLanguage, "", "", placeholder(this.noteLanguage), initial.detail ?? "", "", "", origin), this.headingsFor(this.noteLanguage))}`,
      onCreate
    );
    return { id, path: created.path, parentId: null, x: 80, y: 80, collapsed: false };
  }

  /**
   * Creates a note at a free name. If the file system still reports "already exists" (a case-insensitive collision
   * `pathTaken` could not see), it tries the next free suffix, at most 5 times. Returns the file actually created.
   */
  private async createUniqueNote(
    folder: string,
    title: string,
    content: string,
    onCreate?: (path: string) => void
  ): Promise<TFile> {
    const failed = new Set<string>();
    for (let attempt = 1; ; attempt++) {
      const path = this.unique(folder, title, failed);
      onCreate?.(path);
      try {
        return await this.app.vault.create(path, content);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= 5 || !/already exists/i.test(message)) throw error;
        failed.add(path);
      }
    }
  }

  /** `keepTitle` keeps the source title as is (a paste); without it the copy gets the translated "copy" suffix. */
  async duplicateNote(
    sourcePath: string,
    map: MapDocument,
    mapPath: string,
    options: { keepTitle?: boolean } = {}
  ): Promise<MapNode> {
    const folder = this.topicFolder(mapPath, "Notes");
    await this.ensureTopicFolders(this.topicRoot(mapPath));
    const source = await this.app.vault.read(this.file(sourcePath));
    const metadata = frontmatter(source);
    const sourceTitle = noteTitle(source, metadata, this.file(sourcePath).basename);
    const suffixLanguage = textLanguageOf(sourceTitle, resolveMapTextLanguage(map, this.settings.language));
    const title = options.keepTitle
      ? sourceTitle
      : `${sourceTitle} ${translateNote(suffixLanguage, "note.copy_suffix")}`;
    const id = crypto.randomUUID();
    metadata["node-id"] = id;
    metadata["topic-id"] = map.id;
    metadata["agent-map-id"] = map.id;
    metadata["topic-state"] = "active";
    metadata.title = title;
    const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").replace(/^# .*$/m, () => `# ${title}`);
    const created = await this.createUniqueNote(folder, title, `---\n${stringifyYaml(metadata)}---\n${body}`);
    return { id, path: created.path, parentId: null, x: 80, y: 80, collapsed: false };
  }

  /**
   * Rewrites the body links of notes just copied for "Copy to…": each link is read from the source note's place and
   * written for the copy's place, following the copies of this run. Only the copies (`to`) are written, and only when
   * their body changes; the sources and the frontmatter are never touched.
   */
  async rewriteCopiedNoteLinks(
    pairs: Array<{ from: string; to: string }>
  ): Promise<{ rewritten: number; unverified: string[] }> {
    const copies = new Map(pairs.map(pair => [pair.from, pair.to])),
      resolve = (linkPath: string, fromPath: string): string | undefined =>
        linkPath ? this.app.metadataCache.getFirstLinkpathDest(linkPath, fromPath)?.path : undefined,
      unverified: string[] = [];
    let rewritten = 0;
    for (const { from, to } of pairs) {
      const file = this.file(to),
        { body } = splitFrontmatter(await this.app.vault.read(file)),
        result = rewriteCopiedLinks(body, { sourcePath: from, newPath: to, copies, resolve });
      rewritten += result.rewritten;
      unverified.push(...result.unverified);
      if (result.text === body) continue;
      // The copy was created a moment ago by this run; rewrite it only if its body is still the one read above.
      await this.app.vault.process(file, content => {
        const current = splitFrontmatter(content);
        return current.body === body ? current.head + result.text : content;
      });
    }
    return { rewritten, unverified };
  }

  async readMap(path: string): Promise<MapDocument> {
    return parseMap(await this.app.vault.read(this.file(path)));
  }

  /** Map.md read once: the map plus its goal, context and sources (what hydrate and synchronize need). */
  async readMapMeta(path: string): Promise<MapMeta> {
    const content = await this.app.vault.read(this.file(path));
    const fm = frontmatter(content);
    return {
      map: parseMap(content),
      goal: readRelevanceGoal(fm),
      context: readRelevanceContext(fm),
      sources: readMapSources(fm)
    };
  }

  /** The map file's `relevance-goal` frontmatter, if any. The map file keeps its frontmatter across saves. */
  async readRelevanceGoal(path: string): Promise<string | undefined> {
    return readRelevanceGoal(frontmatter(await this.app.vault.read(this.file(path))));
  }

  /** The map file's `map-sources` list, tolerantly read (a missing key or a malformed value gives the valid subset). */
  async readMapSources(path: string): Promise<MapSource[]> {
    return readMapSources(frontmatter(await this.app.vault.read(this.file(path))));
  }

  /**
   * Sets the map's `map-sources` only, through `vault.process`. An empty list removes the key; a list that already
   * matches what is stored leaves the file untouched. Nothing else changes and nothing rebuilds.
   */
  async writeMapSources(path: string, sources: readonly MapSource[]): Promise<void> {
    const next = serializeMapSources(sources);
    await this.app.vault.process(this.file(path), content => {
      const current = frontmatter(content)[MAP_SOURCES_KEY];
      if (
        next.length
          ? Array.isArray(current) && current.length === next.length && current.every((item, i) => item === next[i])
          : current === undefined
      )
        return content;
      return setFrontmatterKeys(content, { [MAP_SOURCES_KEY]: next.length ? next : null });
    });
  }

  /** The goal and context keys of the map file in one read (an old `relevance-level` key is ignored). */
  async readRelevanceSetup(path: string): Promise<RelevanceSetup> {
    const fm = frontmatter(await this.app.vault.read(this.file(path)));
    return { goal: readRelevanceGoal(fm), context: readRelevanceContext(fm) };
  }

  /**
   * Sets the picture-book pipeline fields of a note (`undefined` keeps a key, `null` removes it) with `setFrontmatterKeys`:
   * every other line and the body keep their bytes, `updated` is not bumped and `status` is not touched.
   */
  async writePipelineFields(path: string, patch: PipelineFieldsPatch): Promise<void> {
    const values = pipelineFrontmatter(patch);
    if (!Object.keys(values).length) return;
    await this.app.vault.process(this.file(path), content => setFrontmatterKeys(content, values));
  }

  /**
   * Writes the pipeline's role choice (`book-role` and `pipeline-role` together) only while the card's role is still the pipeline's:
   * decided inside the same file transaction. A `book-role` that differs from a present `pipeline-role` was changed by hand and stays.
   * Returns whether it wrote. A note without `pipeline-role` (older data) is written as before.
   */
  async writePipelineRole(path: string, role: BookRole): Promise<boolean> {
    let wrote = false;
    await this.app.vault.process(this.file(path), content => {
      const fm = readPipelineFields(frontmatter(content));
      const byHand = !!fm.pipelineRole && !!fm.bookRole && fm.bookRole !== fm.pipelineRole;
      // An owner choice (even the same value as the pipeline's) and a hand edit both keep the role; a hand edit is recorded as the owner's.
      if (fm.bookRoleBy === "owner" || byHand) {
        return byHand && fm.bookRoleBy !== "owner"
          ? setFrontmatterKeys(content, pipelineFrontmatter({ bookRoleBy: "owner" }))
          : content;
      }
      wrote = true;
      return setFrontmatterKeys(content, pipelineFrontmatter({ bookRole: role, pipelineRole: role }));
    });
    return wrote;
  }

  /**
   * The owner's chapter-role choice from the card menu, in one guarded file transaction: a role writes `book-role` and
   * `book-role-by: owner` (also when the value is unchanged); "ai" writes `book-role-by: ai` and sets `pipeline-role` to the
   * current `book-role`, so the next plan may change it and a hand-edit check does not read it as the owner's.
   */
  async writeBookRoleChoice(
    path: string,
    choice: BookRole | "ai",
    options: { authorize?: () => boolean } = {}
  ): Promise<"written" | "discarded"> {
    return this.updateNoteRawGuarded(
      path,
      content => {
        if (choice !== "ai")
          return setFrontmatterKeys(content, pipelineFrontmatter({ bookRole: choice, bookRoleBy: "owner" }));
        const role = readPipelineFields(frontmatter(content)).bookRole;
        return setFrontmatterKeys(
          content,
          pipelineFrontmatter({ bookRoleBy: "ai", ...(role ? { pipelineRole: role } : {}) })
        );
      },
      options
    );
  }

  /** Sets or removes the root topic's `book-*` settings only (same contract as {@link writePipelineFields}). */
  async writeBookSettings(path: string, patch: BookSettingsPatch): Promise<void> {
    const values = bookSettingsFrontmatter(patch);
    if (!Object.keys(values).length) return;
    await this.app.vault.process(this.file(path), content => setFrontmatterKeys(content, values));
  }

  /**
   * Sets a note's `topic-kind` only (an ordinary topic removes the key): `hypothesis-leaning` and `hypothesis-strength`
   * stay (and are not added), `updated` is not bumped, nothing rebuilds.
   */
  async writeTopicKind(path: string, kind: TopicKind): Promise<void> {
    await this.app.vault.process(this.file(path), content =>
      setFrontmatterKeys(content, { "topic-kind": kind === "topic" ? null : kind })
    );
  }

  /**
   * Sets a note's own note style. A ref writes `note-style` only (the 0.28.0 `detail-template` and `tone` stay as they are);
   * null is "follow the topic type" and removes all three keys. Other lines and the body keep their bytes, `updated` is not
   * bumped, nothing rebuilds.
   */
  async writeNoteStyle(path: string, ref: string | null): Promise<void> {
    await this.app.vault.process(this.file(path), content =>
      setFrontmatterKeys(
        content,
        ref === null ? { "note-style": null, "detail-template": null, tone: null } : { "note-style": ref }
      )
    );
  }

  /**
   * Renames the style a note names: `note-style: <from>` becomes `<to>`, and only when the note still names `from` when the
   * file is processed (a note changed meanwhile is left alone and false is returned). Other lines and the body keep their
   * bytes, `updated` is not bumped, nothing rebuilds.
   */
  async renameNoteStyleRef(path: string, from: string, to: string): Promise<boolean> {
    let wrote = false;
    await this.app.vault.process(this.file(path), content => {
      if (frontmatter(content)["note-style"] !== from) return content;
      wrote = true;
      return setFrontmatterKeys(content, { "note-style": to });
    });
    return wrote;
  }

  /**
   * Toggles one marker in `topic-markers`, reading the current list inside the same `vault.process` call. Values this
   * version does not know are kept, an emptied list removes the key, and `updated` is not bumped.
   */
  async writeTopicMarkers(path: string, id: TopicMarker): Promise<void> {
    await this.app.vault.process(this.file(path), content =>
      setFrontmatterKeys(content, { "topic-markers": toggleTopicMarker(frontmatter(content)["topic-markers"], id) })
    );
  }

  /**
   * Sets (`ai-locked: true`) or removes the AI lock. No other key changes and `updated` is not bumped; a note already in
   * the asked state is returned as it is, byte for byte.
   */
  async writeAiLocked(path: string, locked: boolean): Promise<void> {
    await this.app.vault.process(this.file(path), content =>
      readAiLocked(frontmatter(content)) === locked
        ? content
        : setFrontmatterKeys(content, { "ai-locked": locked ? true : null })
    );
  }

  /**
   * Adds (`{ add }`) or removes (`{ remove: { href } }`) one `topic-links` item, reading the current list inside the
   * same `vault.process` call. An invalid, duplicate or over-limit address writes nothing and returns the reason; values
   * this version does not understand are kept, an emptied list removes the key, and `updated` is not bumped.
   */
  async writeTopicLinks(
    path: string,
    change: { add: string } | { remove: { href: string } }
  ): Promise<AddTopicLinkResult> {
    let result: AddTopicLinkResult = { ok: true, next: [] };
    await this.app.vault.process(this.file(path), content => {
      const raw = frontmatter(content)["topic-links"];
      if ("add" in change) {
        result = addTopicLink(raw, change.add);
        return result.ok ? setFrontmatterKeys(content, { "topic-links": result.next }) : content;
      }
      const next = removeTopicLink(raw, change.remove.href);
      result = { ok: true, next: next ?? [] };
      return setFrontmatterKeys(content, { "topic-links": next });
    });
    return result;
  }

  /**
   * Sets `topic-color` to one id, or removes the key for null. An unreadable old value is overwritten because the choice
   * is explicit; no other key changes and `updated` is not bumped.
   */
  async writeTopicColor(path: string, id: TopicColor | null): Promise<void> {
    await this.app.vault.process(this.file(path), content => setFrontmatterKeys(content, { "topic-color": id }));
  }

  /**
   * Changes `topic-style`, reading the current list inside the same `vault.process` call: `{ toggle }` flips one token,
   * `{ set }` makes the whitelisted tokens exactly that list. Values this version does not know are kept, no whitelisted
   * token left removes only those (the key goes when nothing is left), and `updated` is not bumped. A note whose style
   * would not change is returned as it is, byte for byte.
   */
  async writeTopicStyle(path: string, change: { toggle: TopicStyle } | { set: readonly TopicStyle[] }): Promise<void> {
    await this.app.vault.process(this.file(path), content => {
      const raw = frontmatter(content)["topic-style"];
      const next = "toggle" in change ? toggleTopicStyle(raw, change.toggle) : setTopicStyle(raw, change.set);
      const same = JSON.stringify(next) === JSON.stringify(raw === undefined ? null : raw);
      return same ? content : setFrontmatterKeys(content, { "topic-style": next });
    });
  }

  /**
   * The appearance change of a map chat reply, in one `vault.process` call that reads the current values: `color` (null
   * removes it, absent keeps it), markers and styles turned on or off with the same rules as the topic panel
   * ({@link changeTopicMarkers}, {@link changeTopicStyles}). Only keys whose value changes are written, values this version
   * does not know are kept, `updated` is not bumped, and a note that would not change is returned byte for byte.
   */
  async writeTopicAppearance(path: string, change: TopicAppearanceChange): Promise<void> {
    await this.app.vault.process(this.file(path), content => {
      const values = topicAppearanceValues(frontmatter(content), change);
      return Object.keys(values).length ? setFrontmatterKeys(content, values) : content;
    });
  }

  /**
   * Sets a hypothesis note's `hypothesis-strength`: no other key changes, `updated` is not bumped, nothing rebuilds. A none
   * under a supported or refuted leaning is written as weak (the strength is at least weak when the evidence leans).
   */
  async writeHypothesisStrength(path: string, strength: HypothesisStrength): Promise<void> {
    await this.app.vault.process(this.file(path), content => {
      const fm = frontmatter(content),
        current = {
          leaning: readHypothesisLeaning(fm) ?? "undecided",
          strength: readRawHypothesisStrength(fm) ?? "none"
        };
      return setFrontmatterKeys(content, {
        "hypothesis-strength": resolveHypothesisWrite(current, { strength }).strength
      });
    });
  }

  /**
   * Sets a hypothesis note's `hypothesis-leaning`; when the new leaning is supported or refuted and the stored strength is
   * none or missing, the same write sets the strength to weak. No other key changes, `updated` is not bumped, nothing rebuilds.
   */
  async writeHypothesisLeaning(path: string, leaning: HypothesisLeaning): Promise<void> {
    await this.app.vault.process(this.file(path), content => {
      const fm = frontmatter(content),
        current = {
          leaning: readHypothesisLeaning(fm) ?? "undecided",
          strength: readRawHypothesisStrength(fm) ?? "none"
        },
        next = resolveHypothesisWrite(current, { leaning });
      return setFrontmatterKeys(content, {
        "hypothesis-leaning": next.leaning,
        ...(next.strength !== current.strength ? { "hypothesis-strength": next.strength } : {})
      });
    });
  }

  /**
   * Sets or removes only the relevance keys of a note's frontmatter (`relevance-tier`, `relevance-manual`, and the
   * `relevance-reason` that older versions wrote). An AI grade writes the tier and removes the manual flag; a tier set by
   * hand (`manual`) writes the tier and `relevance-manual: true`; null removes the keys. Every write removes
   * `relevance-reason`. The body
   * and every other key stay as they were, and `updated` is not bumped: grading is not an edit of the note.
   */
  async writeRelevance(path: string, value: NoteRelevance | null): Promise<void> {
    await this.app.vault.process(this.file(path), content =>
      setFrontmatterKeys(content, {
        "relevance-tier": value ? value.tier : null,
        "relevance-reason": null,
        "relevance-manual": value?.manual ? true : null
      })
    );
  }

  /**
   * Sets the map's `relevance-goal` and `relevance-context` (a missing context removes its key) in one write and, when the goal differs from the current goal (or there was none), appends
   * `"YYYY-MM-DD: <goal>"` (local date) to `relevance-goal-history`. Only those keys change; the history records the
   * goal alone. `changed` is about the goal (the history); `setupChanged` is true when the goal or context
   * differs. An old `relevance-level` key is never read, written or removed. Resolves with what was there before, for {@link restoreRelevanceGoal}.
   */
  async writeRelevanceGoal(
    mapPath: string,
    goal: string,
    context?: string
  ): Promise<{ previous: RelevanceGoalState; next: RelevanceGoalState; changed: boolean; setupChanged: boolean }> {
    const next = normalizeRelevanceGoal(goal);
    if (!next) throw new Error("A relevance goal is required.");
    const nextContext = context === undefined ? undefined : normalizeRelevanceContext(context);
    let previous: RelevanceGoalState = { goal: undefined, history: undefined };
    let nextState: RelevanceGoalState = { goal: next, history: undefined, context: nextContext };
    let changed = false;
    let setupChanged = false;
    await this.app.vault.process(this.file(mapPath), content => {
      const fm = frontmatter(content);
      previous = {
        goal: typeof fm["relevance-goal"] === "string" ? fm["relevance-goal"] : undefined,
        history: Array.isArray(fm["relevance-goal-history"])
          ? fm["relevance-goal-history"].filter((item): item is string => typeof item === "string")
          : undefined,
        context: typeof fm["relevance-context"] === "string" ? fm["relevance-context"] : undefined
      };
      changed = previous.goal?.trim() !== next;
      setupChanged = changed || readRelevanceContext(fm) !== nextContext;
      nextState = {
        goal: next,
        history: changed ? [...(previous.history ?? []), `${localDate()}: ${next}`] : previous.history,
        context: nextContext
      };
      return setFrontmatterKeys(content, {
        "relevance-goal": next,
        "relevance-context": nextContext ?? null,
        ...(changed ? { "relevance-goal-history": nextState.history ?? null } : {})
      });
    });
    return { previous, next: nextState, changed, setupChanged };
  }

  /** Puts the goal, context and history keys back exactly as {@link writeRelevanceGoal} found them (a missing value removes the key). */
  async restoreRelevanceGoal(mapPath: string, state: RelevanceGoalState): Promise<void> {
    await this.app.vault.process(this.file(mapPath), content =>
      setFrontmatterKeys(content, {
        "relevance-goal": state.goal ?? null,
        "relevance-context": state.context ?? null,
        "relevance-goal-history": state.history ?? null
      })
    );
  }

  async saveMap(path: string, map: MapDocument): Promise<void> {
    let print = "";
    await this.app.vault.process(this.file(path), content => {
      const text = writeMapContent(content, map);
      print = this.printAfterWrite(path, coordinatePrint(parseMap(content)), coordinatePrint(map));
      return text;
    });
    this.writtenCoordinates.set(path, print);
  }

  /**
   * The signature to remember after a write. When the file's coordinates were not the ones this plugin last wrote
   * (something else moved a node) and this write only carries them through unchanged, the old signature stays, so a
   * background write cannot make the outside change look like the plugin's own.
   */
  private printAfterWrite(path: string, before: string, after: string): string {
    const recorded = this.writtenCoordinates.get(path);
    return recorded !== undefined && before !== recorded && after === before ? recorded : after;
  }

  /**
   * True when Map.md's node coordinates are not the ones this plugin last wrote there (something else moved a node).
   * A map this plugin has not written since it started has nothing to compare with, so it is never reported.
   * Viewport is not part of the comparison.
   */
  async coordinatesChangedOutside(path: string): Promise<boolean> {
    const written = this.writtenCoordinates.get(path);
    return written !== undefined && coordinatePrint(await this.readMap(path)) !== written;
  }

  /** Records the coordinates of a Map.md text this plugin put back byte for byte (rollbacks). */
  private noteRestoredMap(path: string, text: string): void {
    try {
      this.writtenCoordinates.set(path, coordinatePrint(parseMap(text)));
    } catch {
      this.writtenCoordinates.delete(path);
    }
  }

  /**
   * Read-modify-write on the current file content in one vault.process call, so a caller holding an older copy of
   * the map cannot overwrite fields it did not change (for example, research state saved meanwhile).
   */
  async updateMap(path: string, change: (map: MapDocument) => void): Promise<MapDocument> {
    let updated: MapDocument | undefined;
    let print = "";
    await this.app.vault.process(this.file(path), content => {
      const map = parseMap(content);
      const before = coordinatePrint(map);
      change(map);
      updated = map;
      const text = writeMapContent(content, map);
      print = this.printAfterWrite(path, before, coordinatePrint(map));
      return text;
    });
    this.writtenCoordinates.set(path, print);
    return updated!;
  }

  /**
   * Markdown files whose frontmatter sets `key`. Indexed files are judged from the metadata cache; only files the
   * cache has not indexed yet (for example, created moments ago) are read, so a large vault is not read in full.
   */
  async markedFiles(key: "visual-agent-map" | "agent-map-node"): Promise<TFile[]> {
    const files: TFile[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache ? marker(cache.frontmatter?.[key]) : marker(frontmatter(await this.app.vault.cachedRead(file))[key]))
        files.push(file);
    }
    return files;
  }

  async mapFiles(): Promise<TFile[]> {
    return (await this.markedFiles("visual-agent-map")).sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Vault-wide scans read every map through here: a map that cannot be parsed is skipped (never written) and
   * reported once per scan, so one broken Map.md does not stop the scan or leave later maps stale. Opening or editing
   * one specific map keeps using readMap and still surfaces its error.
   */
  async readableMaps(): Promise<{ file: TFile; map: MapDocument }[]> {
    return (await this.scanMaps()).readable;
  }

  /**
   * Only for scans that tolerate a missing map; destructive planners (migration) must use readMap so a broken map
   * fails them loudly instead of being skipped.
   */
  private async scanMaps(): Promise<{
    readable: { file: TFile; map: MapDocument }[];
    skippedRoots: string[];
  }> {
    const readable: { file: TFile; map: MapDocument }[] = [],
      failures: { path: string; error: string }[] = [];
    for (const file of await this.mapFiles()) {
      try {
        readable.push({ file, map: await this.readMap(file.path) });
      } catch (error) {
        failures.push({ path: file.path, error: error instanceof Error ? error.message : String(error) });
      }
    }
    failures.push(...(await this.unreadableFrontmatterMaps()));
    if (failures.length) this.onUnreadableMaps?.(failures);
    return { readable, skippedRoots: failures.map(item => this.topicRoot(item.path)) };
  }

  /**
   * Maps whose frontmatter does not parse. Obsidian keeps no `frontmatter` for such a note, so markedFiles never sees it,
   * but it still reports where the block is: only those notes are read, and only the ones that name the marker.
   */
  private async unreadableFrontmatterMaps(): Promise<{ path: string; error: string }[]> {
    const failures: { path: string; error: string }[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache?.frontmatterPosition || cache.frontmatter) continue;
      const content = await this.app.vault.cachedRead(file);
      const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
      if (!/^["']?visual-agent-map["']?\s*:/m.test(block)) continue;
      try {
        frontmatter(content);
      } catch (error) {
        failures.push({ path: file.path, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return failures;
  }

  /**
   * Whether a rename of `file` (previously at `oldPath`) can affect VAM data, decided from the metadata cache without
   * reading notes: the file is a VAM note or map, or a VAM note cites the old path. Uncached files count as relevant.
   */
  renameAffectsVam(file: TFile, oldPath: string): boolean {
    const own = this.app.metadataCache.getFileCache(file);
    if (!own || marker(own.frontmatter?.["agent-map-node"]) || marker(own.frontmatter?.["visual-agent-map"]))
      return true;
    for (const note of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(note)?.frontmatter;
      if (!fm || !marker(fm["agent-map-node"])) continue;
      if ([fm["source-notes"], fm["reference-materials"]].some(list => Array.isArray(list) && list.includes(oldPath)))
        return true;
    }
    return false;
  }

  /**
   * A map node's note was renamed: when its title was the old file name (the default), the title becomes the new file name; a title the
   * owner chose is kept. A pure folder move (same name), a note that is not a map node and a note edited while this runs are left alone
   * (the write is guarded against the text read here). Returns whether the title was changed.
   */
  async followRenamedTitle(
    oldPath: string,
    newPath: string,
    mapNodePaths?: ReadonlySet<string>,
    onRefused?: (reason: string) => void
  ): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(newPath);
    if (!(file instanceof TFile) || file.extension !== "md") return false;
    const oldName = baseName(oldPath).replace(/\.md$/, "");
    if (oldName === file.basename) return false;
    if (!(mapNodePaths ? mapNodePaths.has(newPath) : await this.isMapNodePath(newPath))) return false;
    const raw = await this.app.vault.read(file);
    const content = decodeCalloutSections(upgradeLegacyAimText(raw));
    if (noteTitle(content, frontmatter(content), file.basename) !== oldName) return false;
    const result = await this.updateNoteGuarded(newPath, { title: file.basename }, { expectedContent: raw });
    if (result !== "written") onRefused?.("changed_meanwhile");
    return result === "written";
  }

  /** Whether any map lists `path` as a node; only map files are read. */
  async isMapNodePath(path: string): Promise<boolean> {
    return this.anyMapNodePath([path]);
  }

  /** Whether any map lists any of `paths` as a node; all maps are scanned once however many paths are given. */
  async anyMapNodePath(paths: string[]): Promise<boolean> {
    if (!paths.length) return false;
    const wanted = new Set(paths);
    for (const { map } of await this.readableMaps()) if (map.nodes.some(node => wanted.has(node.path))) return true;
    return false;
  }

  async reconcileMissingNodePaths(): Promise<number> {
    let candidates: Map<string, string[]> | undefined;
    let repaired = 0;
    for (const { file, map } of await this.readableMaps()) {
      let changed = false;
      for (const node of [...map.nodes]) {
        if (this.app.vault.getAbstractFileByPath(node.path) instanceof TFile) continue;
        // Healthy maps need no candidate index; share one index across all missing nodes.
        if (!candidates) {
          candidates = new Map();
          for (const file of await this.markedFiles("agent-map-node")) {
            const fm =
              this.app.metadataCache.getFileCache(file)?.frontmatter ?? frontmatter(await this.app.vault.read(file));
            const id = text(fm["node-id"]);
            if (id) candidates.set(id, [...(candidates.get(id) ?? []), file.path]);
          }
        }
        const matches = candidates.get(node.id) ?? [];
        if (matches.length !== 1) continue;
        const oldPath = node.path;
        rebaseMapNotePaths(map, moveNotePath(oldPath, matches[0]));
        changed = true;
        repaired++;
        await this.replaceSourcePath(oldPath, matches[0]);
      }
      if (changed) await this.saveMap(file.path, map);
    }
    return repaired;
  }

  async topics(): Promise<TopicInfo[]> {
    const topics: TopicInfo[] = [];
    for (const { file, map } of await this.readableMaps()) {
      topics.push({ id: map.id, title: map.title, mapPath: file.path, root: this.topicRoot(file.path) });
    }
    return topics;
  }

  /** The map switcher's rows: each readable map with its topic count, last edit and the folder its topic folder is in. */
  async mapSwitcherItems(): Promise<MapSwitcherItem[]> {
    return (await this.readableMaps()).map(({ file, map }) => {
      const root = this.topicRoot(file.path);
      return {
        title: map.title,
        mapPath: file.path,
        topicCount: map.nodes.length,
        modified: file.stat?.mtime ?? 0,
        folder: root.includes("/") ? root.slice(0, root.lastIndexOf("/")) : ""
      };
    });
  }

  async brokenTopics(): Promise<BrokenTopic[]> {
    const broken: BrokenTopic[] = [];
    for (const containerPath of managedMapContainers(this.settings)) {
      const root = this.app.vault.getAbstractFileByPath(containerPath);
      if (!(root instanceof TFolder)) continue;
      for (const child of root.children) {
        if (!(child instanceof TFolder) || this.app.vault.getAbstractFileByPath(`${child.path}/Map.md`)) continue;
        broken.push({ title: child.name, root: child.path, noteCount: 0 });
      }
    }
    // Count notes for every missing map in one vault scan, including nested Notes folders.
    if (broken.length) {
      const counts = new Map(broken.map(item => [`${item.root}/Notes/`, 0]));
      for (const file of this.app.vault.getMarkdownFiles()) {
        for (let i = file.path.indexOf("/Notes/"); i >= 0; i = file.path.indexOf("/Notes/", i + 1)) {
          const prefix = file.path.slice(0, i + "/Notes/".length);
          const count = counts.get(prefix);
          if (count !== undefined) counts.set(prefix, count + 1);
        }
      }
      for (const item of broken) item.noteCount = counts.get(`${item.root}/Notes/`) ?? 0;
    }
    return broken.sort((a, b) => a.title.localeCompare(b.title));
  }

  async rebuildMissingMap(root: string): Promise<string> {
    const path = `${root}/Map.md`;
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error(this.message("error.map_already_exists"));
    const files = this.app.vault
      .getMarkdownFiles()
      .filter(
        file =>
          file.path.startsWith(`${root}/Notes/`) &&
          marker(this.app.metadataCache.getFileCache(file)?.frontmatter?.["agent-map-node"])
      );
    const first = files[0] ? await this.readNote(files[0].path) : null,
      id = first?.topicId || crypto.randomUUID();
    const nodes: MapNode[] = files.map((file, index) => ({
      id: crypto.randomUUID(),
      path: file.path,
      parentId: null,
      x: 80 + Math.floor(index / 6) * 340,
      y: 80 + (index % 6) * 220,
      collapsed: false
    }));
    const map: MapDocument = { version: 1, id, title: baseName(root), nodes, viewport: { x: 40, y: 40, zoom: 1 } };
    await this.app.vault.create(path, serializeMap(map, this.noteLanguage));
    for (const file of files) await this.setLifecycle(file.path, id, id, "active");
    await this.rebuildDerivedData();
    return path;
  }

  async relinkMissingMap(root: string, sourcePath: string): Promise<string> {
    const target = `${root}/Map.md`;
    if (this.app.vault.getAbstractFileByPath(target)) throw new Error(this.message("error.map_already_exists"));
    const map = await this.readMap(sourcePath),
      candidates = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(`${root}/Notes/`));
    const byId = new Map<string, string>();
    for (const file of candidates) {
      const fm = frontmatter(await this.app.vault.read(file));
      const id = text(fm["node-id"]);
      if (id) byId.set(id, file.path);
    }
    for (const node of [...map.nodes])
      if (!(this.app.vault.getAbstractFileByPath(node.path) instanceof TFile) && byId.has(node.id))
        rebaseMapNotePaths(map, moveNotePath(node.path, byId.get(node.id)!));
    await this.moveExact(sourcePath, target);
    await this.saveMap(target, map);
    for (const node of map.nodes)
      if (this.app.vault.getAbstractFileByPath(node.path) instanceof TFile)
        await this.setLifecycle(node.path, map.id, map.id, "active");
    await this.rebuildDerivedData();
    return target;
  }

  async assignedNotePaths(exceptMapId?: string): Promise<Set<string>> {
    const assigned = new Set<string>();
    for (const { map } of await this.readableMaps()) {
      if (map.id === exceptMapId) continue;
      for (const node of map.nodes) assigned.add(node.path);
    }
    return assigned;
  }

  async collectionFiles(mapPath: string, collection: TopicCollection): Promise<TFile[]> {
    const prefix = `${this.topicFolder(mapPath, collection)}/`;
    return this.app.vault
      .getMarkdownFiles()
      .filter(
        file =>
          file.path.startsWith(prefix) &&
          marker(this.app.metadataCache.getFileCache(file)?.frontmatter?.["agent-map-node"])
      )
      .sort((a, b) => a.basename.localeCompare(b.basename));
  }

  async moveUnique(path: string, folder: string): Promise<string> {
    await this.folder(folder);
    const file = this.file(path),
      desired = normalizePath(`${folder}/${baseName(path)}`);
    const target = this.app.vault.getAbstractFileByPath(desired) ? this.unique(folder, file.basename) : desired;
    await this.relocate(file, target);
    await this.replaceSourcePath(path, target);
    return target;
  }

  async moveExact(path: string, target: string): Promise<void> {
    await this.folder(parentPath(target));
    if (this.app.vault.getAbstractFileByPath(target))
      throw new Error(`${this.message("error.target_exists")}: ${target}`);
    await this.relocate(this.file(path), target);
    await this.replaceSourcePath(path, target);
  }

  async renameNote(path: string, title: string, exactTarget?: string): Promise<string> {
    await this.updateNote(path, { title });
    const folder = parentPath(path),
      desired = exactTarget ?? normalizePath(`${folder}/${safeName(title)}.md`);
    if (desired === path) return path;
    const target =
      exactTarget ?? (this.app.vault.getAbstractFileByPath(desired) ? this.unique(folder, title) : desired);
    await this.relocate(this.file(path), target);
    await this.replaceSourcePath(path, target);
    return target;
  }

  private async relocate(item: TFile | TFolder, target: string): Promise<void> {
    return relocateFile(
      {
        app: this.app,
        language: () => this.settings.language,
        message: key => this.message(key),
        markedNotes: () => this.markedFiles("agent-map-node")
      },
      item,
      target
    );
  }

  async replaceSourcePath(oldPath: string, newPath: string): Promise<void> {
    await this.replaceSourcePaths([[oldPath, newPath]]);
  }

  /**
   * Points the `source-notes` and `reference-materials` of every VAM note through the moves `pairs`, applied in event
   * order (see core/rename-batch), in one pass over the notes: a folder rename's moves are rewritten together.
   */
  async replaceSourcePaths(pairs: readonly RenamePair[]): Promise<void> {
    if (!pairs.some(([from, to]) => from !== to)) return;
    for (const file of await this.markedFiles("agent-map-node")) {
      // Skip notes whose indexed frontmatter names none of the old paths.
      const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (cached && ![cached["source-notes"], cached["reference-materials"]].some(list => mentionsOldPath(list, pairs)))
        continue;
      const note = await this.readNoteIfManaged(file);
      if (!note) continue;
      const referencePaths = note.referencePaths && rebasePathList(note.referencePaths, pairs);
      const sourcePaths = rebasePathList(note.sourcePaths, pairs);
      if (referencePaths || sourcePaths)
        await this.updateNote(file.path, {
          ...(referencePaths ? { referencePaths } : {}),
          ...(sourcePaths ? { sourcePaths } : {})
        });
    }
  }

  private async readNoteIfManaged(file: TFile): Promise<Note | null> {
    const content = await this.app.vault.read(file),
      fm = frontmatter(content);
    return marker(fm["agent-map-node"]) ? this.parseNote(file.path, content) : null;
  }

  /**
   * Renames generated subtopic notes to their titles. A note that cannot be renamed (a read-only folder, say) is counted
   * in `failed` and skipped, so the rest still go. When a map cannot be saved, its renames are counted as failed: the
   * files moved but the map still points at the old paths.
   */
  async normalizeGeneratedNoteFilenames(): Promise<{ renamed: number; failed: number }> {
    let renamed = 0,
      failed = 0;
    // Notes that failed in the map pass: the marked-file pass below must not count them a second time.
    const failedPaths = new Set<string>();
    for (const { file: mapFile, map } of await this.readableMaps()) {
      let changed = false,
        mapRenamed = 0;
      for (const node of map.nodes) {
        const file = this.app.vault.getAbstractFileByPath(node.path);
        if (!(file instanceof TFile) || !/^新的子議題(?: \d+)*$/.test(file.basename)) continue;
        const note = await this.readNote(node.path);
        if (!note.title.trim() || safeName(note.title) === file.basename) continue;
        const oldPath = node.path;
        let newPath: string;
        try {
          newPath = await this.renameNote(oldPath, note.title);
        } catch {
          failed++;
          failedPaths.add(oldPath);
          continue;
        }
        rebaseMapNotePaths(map, moveNotePath(oldPath, newPath));
        changed = true;
        mapRenamed++;
        renamed++;
        await this.replaceSourcePath(oldPath, newPath);
      }
      if (!changed) continue;
      try {
        await this.saveMap(mapFile.path, map);
      } catch {
        renamed -= mapRenamed;
        failed += mapRenamed;
      }
    }
    for (const file of await this.markedFiles("agent-map-node")) {
      if (failedPaths.has(file.path) || !/^新的子議題(?: \d+)*$/.test(file.basename)) continue;
      const note = await this.readNoteIfManaged(file);
      if (!note || !note.title.trim() || safeName(note.title) === file.basename) continue;
      const oldPath = file.path;
      let newPath: string;
      try {
        newPath = await this.renameNote(oldPath, note.title);
      } catch {
        failed++;
        failedPaths.add(oldPath);
        continue;
      }
      await this.replaceSourcePath(oldPath, newPath);
      renamed++;
    }
    if (renamed) await this.rebuildDerivedData();
    return { renamed, failed };
  }

  async setLifecycle(path: string, topicId: string, mapId: string, state: TopicState): Promise<void> {
    await this.updateNote(path, { topicId, mapId, topicState: state });
  }

  /**
   * Rebuilds derived note fields. `scope` limits which notes are rewritten (maps are always read in full): a folder
   * prefix, or several roots plus individual note paths (a move rebuilds only the moved topics and their citing notes).
   */
  async rebuildDerivedData(scope?: string | { roots: string[]; paths?: Iterable<string> }): Promise<void> {
    const roots = typeof scope === "string" ? [scope] : (scope?.roots ?? []),
      extra = new Set(typeof scope === "string" ? [] : (scope?.paths ?? []));
    const inScope = (path: string): boolean =>
      !scope || extra.has(path) || roots.some(root => path.startsWith(`${root}/`));
    const ownership = new Map<string, { map: MapDocument; mapPath: string; node: MapNode }>();
    const topics = new Map<string, { map: MapDocument; mapPath: string }>();
    const scan = await this.scanMaps();
    for (const { file: mapFile, map } of scan.readable) {
      topics.set(map.id, { map, mapPath: mapFile.path });
      for (const node of map.nodes) {
        const existing = ownership.get(node.path);
        if (existing && existing.map.id !== map.id)
          throw new Error(`${this.message("error.note_in_multiple_maps")}: ${node.path}`);
        ownership.set(node.path, { map, mapPath: mapFile.path, node });
      }
    }

    // Map-owned paths are included even if the metadata cache has not caught up with a just-written note.
    const nodeFiles = new Map((await this.markedFiles("agent-map-node")).map(file => [file.path, file]));
    for (const path of ownership.keys()) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) nodeFiles.set(path, file);
    }
    for (const file of nodeFiles.values()) {
      if (!inScope(file.path)) continue;
      // Notes inside an unreadable map's folder are not judged without that map: leave them exactly as they are.
      if (scan.skippedRoots.some(root => file.path.startsWith(`${root}/`) && !ownership.has(file.path))) continue;
      // Compare against the in-memory copy, then derive again from the file's current content inside the write,
      // so an edit made after this read is not replaced by stale text.
      const cached = await this.app.vault.cachedRead(file),
        derived = this.derivedNoteContent(file, cached, ownership, topics);
      if (derived === null || derived === cached) continue;
      await this.app.vault.process(
        file,
        content => this.derivedNoteContent(file, content, ownership, topics) ?? content
      );
    }
  }

  /** True when `path` is an existing Markdown file (a topic note a relation line can link to). */
  private isNoteFile(path: string): boolean {
    return path.endsWith(".md") && this.app.vault.getAbstractFileByPath(path) instanceof TFile;
  }

  /** The node note with derived lifecycle fields and references applied, or null when it is not a VAM node note. */
  private derivedNoteContent(
    file: TFile,
    content: string,
    ownership: Map<string, { map: MapDocument; mapPath: string; node: MapNode }>,
    topics: Map<string, { map: MapDocument; mapPath: string }>
  ): string | null {
    const fm = frontmatter(content);
    if (!marker(fm["agent-map-node"])) return null;
    // Existing derived labels keep their language; only a note without any uses the current UI language.
    const language = this.scaffoldLanguage(content, fm);
    ensureNoteCssClass(fm);
    // A frontmatter title is kept in step with the body heading, but a note without one does not get one: a rebuild
    // after a paste or an added card must not write notes the operation did not touch (the copied source, for one).
    const title = noteTitle(content, fm, file.basename);
    if (fm.title !== undefined) fm.title = title;
    const owner = ownership.get(file.path);
    // `topic-state: inbox` is a legacy value (the Inbox concept was removed in 0.19): it is read and kept as written.
    let state: TopicState = file.path.includes("/Archive/")
      ? "archived"
      : file.path.includes("/Unassigned/")
        ? "unassigned"
        : owner
          ? "active"
          : (text(fm["topic-state"], "unassigned") as TopicState);
    if (owner) {
      fm["agent-map-id"] = owner.map.id;
      fm["topic-id"] = owner.map.id;
      fm["topic-state"] = "active";
      state = "active";
      if (fm["model-source"] === undefined) fm["model-source"] = owner.node.parentId ? "inherited" : "workspace";
    } else {
      delete fm["agent-map-id"];
      if (state === "inbox") {
        // Legacy Inbox note: keep topic-id and the state exactly as written.
        fm["topic-state"] = "inbox";
      } else if (
        fm["topic-state"] !== undefined ||
        file.path.includes("/Archive/") ||
        file.path.includes("/Unassigned/")
      )
        fm["topic-state"] = state;
      // else: an unowned note that never had a state keeps none (no rewrite just to say "unassigned").
    }
    // Notes owned by an AIM map write their placeholder text in the map's content language.
    const textLanguage = owner?.map.aim
      ? noteLanguageOf(resolveMapOutputLanguage(owner.map, language))
      : (noteContentLanguage(fm) ?? language);
    let body = ensurePreview(
      decodeCalloutSections(content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")),
      language,
      textLanguage
    );
    if (isPlaceholder(text(fm.summary))) fm.summary = placeholder(textLanguage);
    const topicId = text(fm["topic-id"]),
      topic = topics.get(topicId);
    if (owner) {
      if (!body.includes(DETAIL_START)) body = replaceSection(body, "Detail", section(body, "Detail"));
      const parent = owner.node.parentId ? owner.map.nodes.find(item => item.id === owner.node.parentId) : undefined;
      const children = owner.map.nodes.filter(item => item.parentId === owner.node.id);
      const ref = REFERENCE_TEXT[language];
      const [topicLabel, mapLabel, parentLabel, childLabel] = ref.labels;
      fm["agent-map-references"] = [
        `${topicLabel}${ref.colon}[[${noteLink(owner.mapPath)}|${linkAlias(owner.map.title, aliasFallback(owner.mapPath))}]]`,
        `${mapLabel}${ref.colon}[[${noteLink(owner.mapPath)}]]`,
        `${parentLabel}${ref.colon}${parent ? `[[${noteLink(parent.path)}]]` : ref.none}`,
        `${childLabel}${ref.colon}${
          children.length ? children.map(child => `[[${noteLink(child.path)}]]`).join(ref.listSeparator) : ref.none
        }`,
        ...relationReferences(owner.map, owner.node.id, language, path => this.isNoteFile(path))
      ];
      body = withoutReference(body);
    } else if (topic && (state === "unassigned" || state === "archived")) {
      const ref = REFERENCE_TEXT[language];
      const [topicLabel, , , , , statusLabel] = ref.labels;
      fm["agent-map-references"] = [
        `${topicLabel}${ref.colon}[[${noteLink(topic.mapPath)}|${linkAlias(topic.map.title, aliasFallback(topic.mapPath))}]]`,
        `${statusLabel}${ref.colon}${state === "archived" ? ref.archived : ref.unassigned}`
      ];
      body = withoutReference(body);
    } else {
      delete fm["agent-map-references"];
      body = withoutReference(body);
    }
    body = normalizeBodyOrder(
      body,
      title,
      text(fm.summary, placeholder(textLanguage)),
      language,
      textLanguage,
      isBookCardFrontmatter(fm)
    );
    return `---\n${stringifyYaml(fm)}---\n${localizeHeadings(withReferenceLinks(body, fm, language), writtenHeadingSet(content, this.headingsFor(textLanguage)))}`;
  }

  async ensureNodePresentation(): Promise<void> {
    for (const file of await this.markedFiles("agent-map-node")) {
      const fm = frontmatter(await this.app.vault.cachedRead(file));
      if (!marker(fm["agent-map-node"]) || !ensureNoteCssClass(fm)) continue;
      // Rebuild from the current content so an edit after the check above is kept.
      await this.app.vault.process(file, content => {
        const current = frontmatter(content);
        if (!marker(current["agent-map-node"]) || !ensureNoteCssClass(current)) return content;
        const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
        return `---\n${stringifyYaml(current)}---\n${body}`;
      });
    }
  }

  async createMap(title: string, nodes: MapNode[] = []): Promise<string> {
    const container = this.settings.mindMapsFolder;
    await this.folder(container);
    const root = this.uniqueFolder(container, title);
    await this.app.vault.createFolder(root);
    await this.ensureTopicFolders(root);
    const path = `${root}/Map.md`;
    const map: MapDocument = {
      version: 1,
      id: crypto.randomUUID(),
      title,
      nodes,
      viewport: { x: 40, y: 40, zoom: 1 }
    };
    await this.app.vault.create(path, serializeMap(map, this.noteLanguage));
    return path;
  }

  /**
   * Copies a (non-AIM) map, notes included, to a new map named `title` next to it. The copy is independent: its own
   * map id, its own note files (new node ids, same titles, body links between the copied notes pointing at the copies)
   * and its own Map.md. The source is only read. Returns the new Map.md path.
   */
  async duplicateMap(sourcePath: string, title: string): Promise<string> {
    const source = await this.readMap(sourcePath);
    if (source.aim) throw new Error(this.message("error.duplicate_map_unsupported"));
    const nodes = new Set(source.nodes.map(node => node.id));
    const copies = new Map<string, MapNode>(),
      pairs: Array<{ from: string; to: string }> = [];
    const mapPath = await this.createMap(title);
    const target = await this.readMap(mapPath);
    for (const node of source.nodes) {
      const copy = await this.duplicateNote(node.path, target, mapPath, { keepTitle: true });
      copies.set(node.id, copy);
      pairs.push({ from: node.path, to: copy.path });
    }
    await this.rewriteCopiedNoteLinks(pairs);
    const fresh = (id: string): string => copies.get(id)?.id ?? id;
    const freshIds = (ids: string[]): string[] => ids.map(fresh);
    await this.updateMap(mapPath, map => {
      map.nodes = source.nodes.map(node => {
        const copy = copies.get(node.id)!;
        return {
          ...cloneJson(node),
          id: copy.id,
          path: copy.path,
          parentId: node.parentId && nodes.has(node.parentId) ? fresh(node.parentId) : null
        };
      });
      map.viewport = { ...source.viewport };
      for (const key of ["outputLanguage", "aiMode", "layout", "detailTemplateId", "toneId"] as const)
        if (source[key] !== undefined) (map as unknown as Record<string, unknown>)[key] = cloneJson(source[key]);
      if (source.topicRelations)
        map.topicRelations = source.topicRelations.map(relation => ({
          ...relation,
          from: fresh(relation.from),
          to: fresh(relation.to)
        }));
      if (source.canvasItems)
        map.canvasItems = source.canvasItems.map(item => {
          const next = cloneJson(item) as Record<string, unknown>;
          // Boundaries, summaries and text notes name topics by id; a copy of them names the copied topics.
          if (typeof next.parentId === "string") next.parentId = fresh(next.parentId);
          if (Array.isArray(next.members)) next.members = freshIds(next.members as string[]);
          if (Array.isArray(next.links)) next.links = freshIds(next.links as string[]);
          // An annotated image's anchor relations: the topic end is the copied topic, the anchor id stays.
          if (next.kind === "annotated-image" && Array.isArray(next.relations)) {
            const anchors = new Set(
              (Array.isArray(next.anchors) ? (next.anchors as Array<{ id?: unknown }>) : []).map(anchor => anchor.id)
            );
            next.relations = (next.relations as Array<{ from: string; to: string }>).map(relation => ({
              ...relation,
              from: anchors.has(relation.from) ? relation.from : fresh(relation.from),
              to: anchors.has(relation.to) ? relation.to : fresh(relation.to)
            }));
          }
          return next as unknown as CanvasItem;
        });
    });
    await this.rebuildDerivedData({ roots: [this.topicRoot(mapPath)] });
    return mapPath;
  }

  /** Why `path` cannot be a Mind Maps/AIM folder, or null: empty, inside/around the legacy Topics folder, or clashing with the other one. */
  mapFolderProblem(key: "mindMapsFolder" | "aimFolder", path: string): "error.map_folder_invalid" | null {
    const other = this.settings[key === "mindMapsFolder" ? "aimFolder" : "mindMapsFolder"];
    const related = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    const workspace = this.settings.workspaceFolder;
    if (!path || path === workspace || !path.startsWith(`${workspace}/`)) return "error.map_folder_invalid";
    if (path.split("/").some(part => !part || part === "." || part === "..")) return "error.map_folder_invalid";
    if (related(path, this.settings.topicsFolder) || related(path, other)) return "error.map_folder_invalid";
    return null;
  }

  /**
   * Changes the Mind Maps/AIM folder on the same move engine as Organize: every topic in the old container moves to the
   * new one (links, node paths and cited paths follow; any failure restores everything and the setting is unchanged),
   * then the old folder is removed only if it is empty. Returns old Map.md path -> new Map.md path.
   */
  async changeMapFolder(
    key: "mindMapsFolder" | "aimFolder",
    path: string,
    onProgress?: MoveProgress
  ): Promise<Map<string, string>> {
    const next = normalizePath(path),
      current = this.settings[key];
    if (next === current) return new Map();
    const problem = this.mapFolderProblem(key, next);
    if (problem) throw new Error(this.message(problem));
    const old = this.app.vault.getAbstractFileByPath(current);
    let mapping = new Map<string, string>();
    if (old instanceof TFolder) {
      const moves: OrganizeMove[] = [];
      for (const file of await this.mapFiles()) {
        const root = parentPath(file.path);
        if (file.name !== "Map.md" || parentPath(root) !== current) continue;
        let map: MapDocument;
        try {
          map = await this.readMap(file.path);
        } catch {
          throw new Error(this.message("error.map_folder_unreadable"));
        }
        // An old AIM map stays where it is (the folder keeps it, so it is not removed below).
        if (map.aim) continue;
        const toRoot = normalizePath(`${next}/${root.split("/").at(-1) ?? safeName(map.title)}`);
        if (this.app.vault.getAbstractFileByPath(toRoot)) throw new Error(this.message("error.map_folder_exists"));
        moves.push({ mapPath: file.path, title: map.title, kind: "mind", fromRoot: root, toRoot });
      }
      if (moves.length || !this.app.vault.getAbstractFileByPath(next)) {
        await this.folder(parentPath(next));
        if (!this.app.vault.getAbstractFileByPath(next)) await this.folder(next);
      }
      mapping = await this.runTopicMoves(moves, [next], onProgress);
      const left = this.app.vault.getAbstractFileByPath(current);
      // Never delete a non-empty folder; a failed removal only leaves an empty folder behind.
      if (left instanceof TFolder && left.children.length === 0) {
        try {
          await this.app.fileManager.trashFile(left);
        } catch {
          /* The empty old folder stays. */
        }
      }
    }
    this.settings[key] = next;
    return mapping;
  }

  /** The legacy folders that are cleaned up once empty: the old Topics folder and the old Inbox folder. */
  legacyCleanupFolders(): string[] {
    return [this.settings.topicsFolder, `${this.settings.workspaceFolder}/Inbox`];
  }

  /**
   * Whether `path` holds nothing but OS litter on disk. Obsidian's vault tree hides dot-files and dot-folders, so a
   * folder that looks empty there can still hold user content (.git, .sessions, hidden notes): ask the disk. Folders in
   * `allowed` (topics about to move out) do not count. A failed listing counts as not empty.
   */
  private async emptyOnDisk(path: string, allowed: Set<string> = new Set()): Promise<boolean> {
    try {
      const listing = await this.app.vault.adapter.list(path);
      return (
        listing.folders.every(folder => allowed.has(folder)) &&
        listing.files.every(file => OS_LITTER.has((file.split("/").at(-1) ?? file).toLowerCase()))
      );
    } catch {
      return false;
    }
  }

  /**
   * Which legacy folders are (or, after `plan`'s moves, will be) empty both in Obsidian's vault tree and on disk (OS
   * litter aside). Never lists a folder that still holds anything, hidden content included.
   */
  async emptyLegacyFolders(plan?: OrganizePlan): Promise<string[]> {
    const moving = new Set((plan?.moves ?? []).map(move => move.fromRoot));
    const empty: string[] = [];
    for (const path of this.legacyCleanupFolders()) {
      const folder = this.app.vault.getAbstractFileByPath(path);
      if (!(folder instanceof TFolder) || !folder.children.every(child => moving.has(child.path))) continue;
      if (await this.emptyOnDisk(path, moving)) empty.push(path);
    }
    return empty;
  }

  /** Moves the legacy Topics/Inbox folders to the trash only if empty (re-checked on disk right before); returns what went. */
  async removeEmptyLegacyFolders(): Promise<string[]> {
    const removed: string[] = [];
    for (const path of this.legacyCleanupFolders()) {
      if (this.disposed) break;
      const folder = this.app.vault.getAbstractFileByPath(path);
      if (!(folder instanceof TFolder) || folder.children.length) continue;
      if (!(await this.emptyOnDisk(path))) continue;
      try {
        await this.app.fileManager.trashFile(folder);
        removed.push(path);
      } catch {
        /* The empty folder stays. */
      }
    }
    return removed;
  }

  /**
   * Read-only preview of "Organize workspace folders": every readable topic folder directly inside the legacy Topics
   * folder moves to Mind Maps; an old AIM map (`aim`) stays where it is. Unreadable maps are listed, never moved.
   */
  async planOrganizeWorkspaceFolders(): Promise<OrganizePlan> {
    const plan: OrganizePlan = { moves: [], skipped: [] };
    const reserved = new Set<string>();
    for (const file of await this.mapFiles()) {
      const root = parentPath(file.path);
      if (file.name !== "Map.md" || parentPath(root) !== this.settings.topicsFolder) continue;
      let map: MapDocument;
      try {
        map = await this.readMap(file.path);
      } catch (error) {
        plan.skipped.push({ mapPath: file.path, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      // An old AIM map in the legacy Topics folder stays there; nothing creates or fills the AIM folder.
      if (map.aim) continue;
      const container = this.settings.mindMapsFolder;
      // A misconfigured target equal to the source container would rename every topic on every run.
      if (container === this.settings.topicsFolder) continue;
      const base = normalizePath(`${container}/${root.split("/").at(-1) ?? safeName(map.title)}`);
      let toRoot = base,
        number = 2;
      while (this.app.vault.getAbstractFileByPath(toRoot) || reserved.has(toRoot)) toRoot = `${base} ${number++}`;
      reserved.add(toRoot);
      plan.moves.push({ mapPath: file.path, title: map.title, kind: "mind", fromRoot: root, toRoot });
    }
    return plan;
  }

  /**
   * Moves each planned topic folder with Obsidian's rename (so links update) via renameTopic. Any failure restores every
   * topic already moved (folder, Map.md text, path references). Returns old Map.md path -> new Map.md path.
   */
  async organizeWorkspaceFolders(plan: OrganizePlan, onProgress?: MoveProgress): Promise<Map<string, string>> {
    return this.runTopicMoves(plan.moves, [], onProgress);
  }

  /**
   * The shared move engine (Organize and folder-setting changes): re-checks for AIM work right before the first write,
   * moves each topic, and on any failure restores every topic already moved. `alsoManaged` lists containers that are
   * not yet in the settings but hold topics during the move (so renameTopic and the rollback accept them).
   */
  private async runTopicMoves(
    moves: OrganizeMove[],
    alsoManaged: string[] = [],
    onProgress?: MoveProgress
  ): Promise<Map<string, string>> {
    this.pendingContainers = alsoManaged;
    try {
      return await this.moveTopicsWithRollback(moves, onProgress);
    } finally {
      this.pendingContainers = [];
    }
  }

  private async moveTopicsWithRollback(moves: OrganizeMove[], onProgress?: MoveProgress): Promise<Map<string, string>> {
    return moveTopicsWithRollback(
      {
        app: this.app,
        isDisposed: () => this.disposed,
        message: key => this.message(key),
        folder: path => this.folder(path),
        file: path => this.file(path),
        renameTopic: (path, title, target, options) => this.renameTopic(path, title, target, options),
        rebuildDerivedData: scope => this.rebuildDerivedData(scope),
        noteRestoredMap: (path, text) => this.noteRestoredMap(path, text),
        markedFiles: key => this.markedFiles(key),
        readNoteIfManaged: file => this.readNoteIfManaged(file),
        updateNote: (path, patch) => this.updateNote(path, patch),
        readableMaps: () => this.readableMaps(),
        saveMap: (path, map) => this.saveMap(path, map)
      },
      moves,
      onProgress
    );
  }

  async renameTopic(
    mapPath: string,
    title: string,
    targetRoot?: string,
    options: { rebuild?: boolean } = {}
  ): Promise<string> {
    const file = this.file(mapPath),
      root = file.parent;
    if (
      !(root instanceof TFolder) ||
      !(isManagedMapPath(this.settings, mapPath) || this.pendingContainers.some(c => mapPath.startsWith(`${c}/`)))
    )
      throw new Error(this.message("error.legacy_map_view_only"));
    // A rename keeps the topic in the container it is already in (Mind Maps, AIM or legacy Topics).
    const desired = targetRoot
      ? normalizePath(targetRoot)
      : normalizePath(`${parentPath(root.path)}/${safeName(title)}`);
    if (
      desired !== root.path &&
      (this.app.vault.getAbstractFileByPath(desired) || (!targetRoot && this.foldedSibling(desired, root.path)))
    )
      throw new Error(this.message("error.topic_folder_exists"));
    const originalRoot = root.path;
    const originalMapPath = `${originalRoot}/Map.md`,
      originalContent = await this.app.vault.read(this.file(originalMapPath));
    parseMap(originalContent); // an unreadable map is refused before anything moves
    // A rename only changes this topic's folder: rebuild just it (or nothing, when a batch rebuilds once itself).
    const rebuild = async (): Promise<void> => {
      if (options.rebuild !== false) await this.rebuildDerivedData({ roots: [originalRoot, desired] });
    };
    const next = `${desired}/Map.md`;
    let moved = false;
    try {
      if (desired !== originalRoot) {
        await this.relocate(root, desired);
        moved = true;
        if (!(this.app.vault.getAbstractFileByPath(desired) instanceof TFolder))
          throw new Error(this.message("error.move_not_applied"));
      }
      const map = await this.readMap(next);
      map.title = title;
      const rebasePath = (path: string): string =>
        path.startsWith(`${originalRoot}/`) ? `${desired}/${path.slice(originalRoot.length + 1)}` : path;
      rebaseMapNotePaths(map, rebasePath);
      await this.saveMap(next, map);
      await rebuild();
      return next;
    } catch (error) {
      if (moved) {
        try {
          const movedRoot = this.app.vault.getAbstractFileByPath(desired);
          if (!(movedRoot instanceof TFolder)) throw new Error("Renamed topic folder was not found for rollback.");
          await this.relocate(movedRoot, originalRoot);
          const restoredMap = this.app.vault.getAbstractFileByPath(originalMapPath);
          if (!(restoredMap instanceof TFile))
            throw new Error("Original Map.md was not found after restoring the topic folder.");
          await this.app.vault.modify(restoredMap, originalContent);
          this.noteRestoredMap(originalMapPath, originalContent);
          await rebuild();
        } catch (rollbackError) {
          const originalMessage = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Topic rename failed (${originalMessage}); rollback also failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}).`
          );
        }
      } else if (this.app.vault.getAbstractFileByPath(originalMapPath) instanceof TFile) {
        // A same-folder rename can still fail after the Map.md update; restore its exact source.
        await this.app.vault.modify(this.file(originalMapPath), originalContent);
        this.noteRestoredMap(originalMapPath, originalContent);
        await rebuild();
      }
      throw error;
    }
  }

  async migrate(): Promise<void> {
    /* v0.2 import remains intentionally disabled; the pre-0.4 workspace migration was removed in 0.19. */
  }
}
