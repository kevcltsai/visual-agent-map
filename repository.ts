import { AsyncLocalStorage } from "node:async_hooks";
import { parentPath, baseName } from "./core/repository-paths";
import {
  moveTopicsWithRollback,
  type OrganizeMove,
  type OrganizePlan,
  type MoveProgress,
  type TopicMapWrite,
  type TopicRenameOptions
} from "./core/repository-workspace-move";
import type { Status, ModelSource, TopicState, TopicCollection, Note, NotePatch } from "./core/repository-note-types";
import { relocateFile } from "./core/repository-relocation";
import { managedMapContainers, isManagedMapPath, type Settings } from "./core/repository-settings";
import {
  DETAIL_START,
  REFERENCE_START,
  REFERENCE_END,
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
import {
  hasLivingCommitMetadata,
  livingRewriteIsReformatOnly,
  livingNoteWithoutManaged,
  isLivingNodeNote,
  keepsLivingBodyAndMetadata,
  livingConfigurationStamp,
  livingMarkerState,
  rebaseLivingNoteReferences,
  remapLivingCopyCardReferences,
  resetLivingCopyDiagnostics,
  splitLivingNodeRegion
} from "./core/living-node-region";
import { redactLivingShareText } from "./experiences/sharing/living-node-redaction";
import {
  livingDamageKind,
  readLivingMarkdown,
  renderLivingShareKnowledge
} from "./experiences/visual-map/living-node-markdown";
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
import { duplicatedKnowledgeRefs, type KnowledgeRefIO } from "./experiences/visual-map/knowledge-refs";
import { MapDocument, MapNode, serializeMap, parseMap } from "./map-model";
import type { ReasoningLevel } from "./ai/types";
import { normalizeReasoningLevel } from "./ai/task-policy";
import { resolveTaskModel } from "./ai/model-resolution";
import { standardTemplate, type DetailTemplate } from "./ai/detail-templates";
import { readOnce, type NoteReadContext } from "./core/note-read-context";
import { aiWriteGate } from "./core/ai-write-gate";
import type { VaultWriteRecovery } from "./core/vault-write-recovery";
import { splitFrontmatter } from "./core/link-rewrite";
import { rewriteCopiedLinks } from "./core/copy-links";
import { keepFrontmatterFormatting } from "./core/rename-link-guard";
import { linkSpans, RenameRepairWatch } from "./core/rename-repair";
import { chainRebase, mentionsOldPath, rebasePathList, type RenamePair } from "./core/rename-batch";
import {
  managedHeadingValue,
  readAiLocked,
  readAiCard,
  readAiRun,
  readAiUpdateMode,
  readTopicKind,
  readHypothesisStrength,
  readHypothesisLeaning,
  readRawHypothesisStrength,
  resolveHypothesisWrite,
  type HypothesisStrength,
  type HypothesisLeaning,
  type TopicKind
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
/** The shared AI writer gate refused the bytes being replaced (a Living Node, damaged markers): nothing was written. */
export class AiWriterRefusal extends Error {}
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

/** Everything one read of Map.md gives: the document and its frontmatter values. */
export interface MapMeta {
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

/** Transaction-local guard, evaluated on the actual preimage inside Vault.process. */
export interface NoteWriteGuard {
  (file: TFile, current: string, change: (content: string) => string): string;
  aroundHostMove?: (origin: string, target: string, move: () => Promise<void>) => Promise<void>;
  acceptsHistory?: (file: TFile, current: string) => boolean;
}

/** A view of `target` whose write methods throw once `disposed()` is true; reads and everything else pass through. */
function guardWrites<T extends object>(
  target: T,
  writes: Set<string>,
  disposed: () => boolean,
  message: () => string,
  recovery?: VaultWriteRecovery,
  recoveryErrors?: { conflict: () => Error; backup: () => Error; saveOpenEditors: (file: TFile) => Promise<void> },
  noteGuard?: () => NoteWriteGuard | undefined,
  damagedMarkers?: () => Error
): T {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object) as unknown;
      if (typeof property !== "string" || typeof value !== "function") return value;
      const call = value as (this: object, ...args: unknown[]) => unknown;
      return writes.has(property)
        ? (...args: unknown[]) => {
            if (disposed()) return Promise.reject(new Error(message()));
            if (
              property === "process" &&
              damagedMarkers &&
              args[0] instanceof TFile &&
              args[0].extension === "md" &&
              typeof args[1] === "function"
            ) {
              // Damaged Living Node markers: only a write proven to keep the body and Living Node metadata may pass.
              const change = args[1] as (content: string) => string;
              args[1] = (current: string): string => {
                if (livingMarkerState(current) !== "corrupt") return change(current);
                let next: string;
                try {
                  next = change(current);
                } catch (error) {
                  throw error instanceof Error && error.message === "ambiguous-living-node-region"
                    ? damagedMarkers()
                    : error;
                }
                if (next === current || keepsLivingBodyAndMetadata(current, next, frontmatter)) return next;
                throw damagedMarkers();
              };
            }
            if (property === "process" && args[0] instanceof TFile && typeof args[1] === "function") {
              const guard = noteGuard?.();
              if (guard) {
                const file = args[0];
                const change = args[1] as (content: string) => string;
                args[1] = (current: string) => guard(file, current, change);
              }
            }
            if (
              property === "process" &&
              recovery &&
              recoveryErrors &&
              args[0] instanceof TFile &&
              args[0].extension === "md" &&
              typeof args[1] === "function"
            ) {
              const file = args[0];
              const change = args[1] as (content: string) => string;
              const vault = object as unknown as App["vault"];
              return recovery.process({
                path: () => file.path,
                read: async () => {
                  // Unsaved typing in an open editor is not on disk yet; save it so the snapshot and write include it.
                  await recoveryErrors.saveOpenEditors(file);
                  return vault.read(file);
                },
                process: transform =>
                  Reflect.apply(call, object, [file, transform, ...args.slice(2)]) as Promise<string>,
                change,
                stopped: disposed,
                stoppedError: () => new Error(message()),
                conflictError: recoveryErrors.conflict,
                backupError: recoveryErrors.backup
              });
            }
            // A process callback can run later, after the vault's own file queue releases it.
            if ((property === "process" || property === "processFrontMatter") && typeof args[1] === "function") {
              const change = args[1] as (...values: unknown[]) => unknown;
              args[1] = (...values: unknown[]): unknown => {
                if (disposed()) throw new Error(message());
                return change(...values);
              };
            }
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
  private readonly noteWriteScope = new AsyncLocalStorage<NoteWriteGuard>();
  /** Marks a viewport write: one started before unload still lands after dispose (only that Map.md viewport). */
  private readonly viewportScope = new AsyncLocalStorage<true>();
  /** Per Map.md path: the node coordinates of the last text this plugin wrote there (memory only; see {@link coordinatesChangedOutside}). */
  private readonly writtenCoordinates = new Map<string, string>();

  constructor(
    app: App,
    readonly settings: Settings,
    recovery?: VaultWriteRecovery
  ) {
    const stopped = (): boolean => this.disposed && !this.viewportScope.getStore();
    const message = (): string => this.message("error.unloaded_write_not_performed");
    const recoveryErrors = {
      conflict: () => new Error(this.message("error.recovery_write_conflict")),
      backup: () => new Error(this.message("error.recovery_backup_failed")),
      saveOpenEditors: async (file: TFile) => {
        for (const leaf of app.workspace?.getLeavesOfType?.("markdown") ?? []) {
          const view = leaf.view as unknown as {
            file?: TFile | null;
            getViewData?: () => string;
            save?: () => Promise<void>;
          };
          if (view.file?.path !== file.path || !view.getViewData || !view.save) continue;
          if (view.getViewData() !== (await app.vault.read(file))) await view.save();
        }
      }
    };
    const noteGuard = (): NoteWriteGuard | undefined => this.noteWriteScope.getStore();
    const damagedMarkers = (): Error => new Error(this.message("error.living_node_markers_damaged"));
    this.app = new Proxy(app, {
      get(object, property) {
        const value = Reflect.get(object, property, object) as unknown;
        if (property === "vault")
          return guardWrites(
            value as object,
            VAULT_WRITES,
            stopped,
            message,
            recovery,
            recoveryErrors,
            noteGuard,
            damagedMarkers
          );
        if (property === "fileManager") return guardWrites(value as object, FILE_MANAGER_WRITES, stopped, message);
        return value;
      }
    });
  }

  /** Restrict the guard to this async operation; unrelated concurrent writers do not inherit it. */
  withNoteWriteGuard<T>(guard: NoteWriteGuard, action: () => Promise<T>): Promise<T> {
    const outer = this.noteWriteScope.getStore();
    if (!outer) return this.noteWriteScope.run(guard, action);
    const combined: NoteWriteGuard = (file, current, change) => outer(file, current, text => guard(file, text, change));
    combined.acceptsHistory = outer.acceptsHistory;
    combined.aroundHostMove = (origin, target, move) => {
      const inner = (): Promise<void> => (guard.aroundHostMove ? guard.aroundHostMove(origin, target, move) : move());
      return outer.aroundHostMove ? outer.aroundHostMove(origin, target, inner) : inner();
    };
    return this.noteWriteScope.run(combined, action);
  }

  /** Only a verified grouped-history scope may authorize a newer preimage from an earlier child entry. */
  acceptsNoteHistory(file: TFile, current: string): boolean {
    return this.noteWriteScope.getStore()?.acceptsHistory?.(file, current) ?? false;
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
          ? await readOnce(ctx, path, () => this.app.vault.cachedRead(file))
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
      raw = ctx ? await readOnce(ctx, path, () => this.app.vault.cachedRead(file)) : await this.app.vault.read(file);
    return this.parseNote(path, raw, map, ctx);
  }

  /** The parsed note and the exact same bytes, for a later guarded commit. */
  async readNoteSnapshot(
    path: string,
    map?: MapDocument,
    ctx?: NoteReadContext
  ): Promise<{ note: Note; content: string }> {
    const file = this.file(path);
    const content = ctx ? await readOnce(ctx, path, () => this.app.vault.read(file)) : await this.app.vault.read(file);
    return { note: await this.parseNote(path, content, map, ctx), content };
  }

  /** Parses already-read note content; `readNote` reads the file once and calls this. */
  private async parseNote(path: string, raw: string, map?: MapDocument, ctx?: NoteReadContext): Promise<Note> {
    const file = this.file(path),
      decoded = decodeCalloutSections(upgradeLegacyAimText(raw)),
      fm = frontmatter(decoded),
      // A torn or duplicated region is cut out before sections are read, so it cannot leak into Detail or Prompt; a paired region already ends its section.
      content = livingMarkerState(decoded) === "corrupt" ? livingNoteWithoutManaged(decoded) : decoded;
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
      bookSettings = readBookSettings(fm),
      topicKind = readTopicKind(fm),
      markers = readTopicMarkers(fm),
      links = readTopicLinks(fm),
      color = readTopicColor(fm),
      style = readTopicStyle(fm);
    let livingNode: Note["livingNode"];
    if (
      readAiCard(fm) ||
      fm["living-node-region-hash"] !== undefined ||
      fm["living-node-ownership"] !== undefined ||
      hasLivingCommitMetadata(fm)
    ) {
      let knowledgeRevision = "empty";
      let summary = "";
      let shareSummary = "";
      let damaged = false;
      let damageKind: "rebuildable" | "unrecoverable" | undefined;
      let shareMarkdown = "";
      const base = (this.app.vault.adapter as { getBasePath?: () => unknown }).getBasePath?.();
      const basePath = typeof base === "string" ? base : undefined;
      try {
        const knowledge = readLivingMarkdown(raw);
        shareMarkdown = redactLivingShareText(renderLivingShareKnowledge(knowledge), basePath);
        knowledgeRevision = knowledge.revision;
        const firstLine =
          knowledge.output.text
            .split(/\r?\n/)
            .find(line => line.trim())
            ?.trim() ?? "";
        summary = firstLine.slice(0, 180);
        shareSummary = redactLivingShareText(firstLine, basePath).slice(0, 180);
      } catch {
        damaged = true;
        damageKind = livingDamageKind(raw) ?? "unrecoverable";
      }
      const value = fm["living-node-outcome"];
      const outcome =
        value === "ok" || value === "failed" || value === "blocked" || value === "cancelled" ? value : "never";
      livingNode = {
        summary,
        shareSummary,
        shareMarkdown,
        configRevision: livingConfigurationStamp(section(content, "Prompt"), fm),
        knowledgeRevision,
        successfulKnowledgeRevision: text(fm["living-node-success-knowledge"]) || undefined,
        lastAttempt: text(fm["living-node-last-attempt"]) || undefined,
        lastSuccessfulCheck: text(fm["living-node-last-successful-check"]) || undefined,
        lastContentChange: text(fm["living-node-last-content-change"]) || undefined,
        outcome,
        ...(text(fm["living-node-reason"]) ? { reason: text(fm["living-node-reason"]) } : {}),
        damaged,
        ...(damageKind ? { damageKind } : {})
      };
    }
    return {
      ...(livingNode ? { livingNode } : {}),
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
      ...(readAiLocked(fm) || managedNodeIds(map).has(this.nodeAtPath(path, map, ctx)?.id ?? "")
        ? { aiLocked: true as const }
        : {}),
      ...(readAiCard(fm) ? { aiCard: true as const } : {}),
      ...(readAiRun(fm) ? { aiRun: readAiRun(fm) } : {}),
      ...(readAiUpdateMode(fm) ? { aiUpdateMode: readAiUpdateMode(fm) } : {}),
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
      /** Unintegrated AI writer: refuse even a flag-only card, using the actual bytes at commit. */
      rejectAiCard?: boolean;
      /** AI writer whose write is exempt from the Living Node refusal (a chat rename): refuse only a note locked at commit. */
      rejectAiLock?: boolean;
      /** Gets the file text the callback was given (so a check can look at the text as it is now, not as the caller last read it). */
      authorize?: (current?: string) => boolean;
      finalize?: (content: string) => string | null;
    } = {}
  ): Promise<"written" | "discarded"> {
    const { expectedContent, authorize, finalize, rejectAiCard, rejectAiLock, ...writeOptions } = options;
    let outcome: "written" | "discarded" = "written";
    await this.app.vault.process(this.file(path), content => {
      if (
        rejectAiCard
          ? this.aiWriteBlocked(content, expectedContent, () => !authorize || authorize(content))
          : rejectAiLock
            ? this.aiWriteBlocked(content, expectedContent, () => !authorize || authorize(content))
            : (expectedContent !== undefined && content !== expectedContent) || (authorize && !authorize(content))
      ) {
        outcome = "discarded";
        return content;
      }
      if (rejectAiCard || writeOptions.newVisualReferences) this.admitAiWriter(content);
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
    options: { expectedContent?: string; authorize?: () => boolean; rejectAiCard?: boolean } = {}
  ): Promise<"written" | "discarded"> {
    const { expectedContent, authorize, rejectAiCard } = options;
    let outcome: "written" | "discarded" = "written";
    await this.app.vault.process(this.file(path), content => {
      if (
        rejectAiCard
          ? this.aiWriteBlocked(content, expectedContent, () => !authorize || authorize())
          : (expectedContent !== undefined && content !== expectedContent) || (authorize && !authorize())
      ) {
        outcome = "discarded";
        return content;
      }
      if (rejectAiCard) this.admitAiWriter(content);
      return transform(content);
    });
    return outcome;
  }

  /**
   * The shared AI write gate on the bytes being replaced, for an AI writer only (a manual edit keeps the plain checks): the
   * caller's run still owns the write, the note is not `ai-locked` now, and it is still the text the caller read. The
   * Living Node refusal stays in `admitAiWriter`, which throws its own message.
   */
  private aiWriteBlocked(content: string, expectedContent: string | undefined, owned: () => boolean): boolean {
    // Same order as before: the content check first, so `authorize` only runs on the text the caller read.
    if (
      aiWriteGate({
        owned: true,
        version: expectedContent === undefined ? undefined : { read: expectedContent, now: content }
      }).length
    )
      return true;
    return aiWriteGate({ owned: owned(), aiLocked: readAiLocked(frontmatter(content)) }).length > 0;
  }

  /**
   * The one admission check of every AI writer (formal-outside, trial adopt, chat, book, raw and late callbacks). It reads the
   * bytes being replaced and keys on the Living Node markers and metadata, not only the ai-card flag, so a converted managed
   * region or a flag-only card is covered. Damaged markers get their own message.
   */
  private admitAiWriter(content: string): void {
    const state = livingMarkerState(content);
    if (state === "corrupt") throw new AiWriterRefusal(this.message("error.living_node_markers_damaged"));
    if (isLivingNodeNote(content, frontmatter(content)))
      throw new AiWriterRefusal(this.message("ui.living_node_use_run_card"));
  }

  /** Settle only the still-running managed note, without reverting a status the owner changed meanwhile. */
  async settleRunningNote(path: string, patch: Pick<NotePatch, "status" | "lastError">): Promise<void> {
    await this.updateNoteGuarded(path, patch, {
      authorize: current => {
        if (current === undefined) return false;
        const fm = frontmatter(current);
        return marker(fm["agent-map-node"]) && fm.status === "running";
      }
    });
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

  /** Damaged markers: only a status/error change, written to the frontmatter alone, is possible; the body is never rewritten. */
  private damagedMarkerPatch(content: string, patch: NotePatch): string {
    const keys = Object.keys(patch).filter(key => patch[key as keyof NotePatch] !== undefined);
    if (!keys.length || keys.some(key => key !== "status" && key !== "lastError"))
      throw new Error(this.message("error.living_node_markers_damaged"));
    const values: Record<string, string | null> = {};
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.lastError !== undefined) values["last-error"] = patch.lastError || null;
    else if (patch.status === "completed") values["last-error"] = null;
    return setFrontmatterKeys(content, values);
  }

  private patchedNote(
    path: string,
    content: string,
    patch: NotePatch,
    options: { contentLanguage?: NoteLanguage; detailTemplate?: DetailTemplate; newVisualReferences?: boolean }
  ): string {
    if (livingMarkerState(content) === "corrupt") return this.damagedMarkerPatch(content, patch);
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
    if (patch.researchRetrievedAt !== undefined) fm["research-retrieved-at"] = patch.researchRetrievedAt;
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
    const withoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
    const separated = splitLivingNodeRegion(withoutFrontmatter);
    // Text typed right after the region (before any `## ` heading) is no part of Detail on read, so a Detail write keeps it, after the region.
    let trailing = "";
    if (separated.region) {
      const afterRegion = withoutFrontmatter.slice(
        withoutFrontmatter.indexOf(separated.region) + separated.region.length
      );
      const nextHeading = afterRegion.search(/^## /m);
      const candidate = nextHeading < 0 ? afterRegion : afterRegion.slice(0, nextHeading);
      if (candidate.trim()) {
        trailing = candidate.replace(/\s+$/, "");
        separated.body =
          separated.body.slice(0, separated.body.length - afterRegion.length) + afterRegion.slice(candidate.length);
      }
    }
    let body = decodeCalloutSections(separated.body);
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
    const rendered = localizeHeadings(
      withReferenceLinks(body, fm, language),
      writtenHeadingSet(content, this.headingsFor(textLanguage))
    );
    return `---\n${keepFrontmatterFormatting(content, stringifyYaml(fm))}---\n${rendered}${separated.region ? `\n${separated.region}${trailing ? `${trailing}\n` : "\n"}` : ""}`;
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
    if (
      readAiCard(metadata) ||
      metadata["living-node-region-hash"] !== undefined ||
      metadata["living-node-ownership"] !== undefined ||
      hasLivingCommitMetadata(metadata)
    )
      resetLivingCopyDiagnostics(metadata);
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
   * written for the copy's place, following the copies of this run. Only copies are written.
   * Living Node record bytes and ownership hashes are preserved; persisted card references are remapped separately.
   */
  async rewriteCopiedNoteLinks(
    pairs: Array<{ from: string; to: string }>
  ): Promise<{ rewritten: number; unverified: string[] }> {
    const copies = new Map(pairs.map(pair => [pair.from, pair.to])),
      resolve = (linkPath: string, fromPath: string): string | undefined =>
        linkPath ? this.app.metadataCache.getFirstLinkpathDest(linkPath, fromPath)?.path : undefined,
      unverified: string[] = [];
    let rewritten = 0;
    const copiedIds = new Map<string, string>();
    const identities = new Map<string, { sourceMap: string; destinationMap: string; content: string }>();
    for (const { from, to } of pairs) {
      const source = frontmatter(await this.app.vault.read(this.file(from)));
      const content = await this.app.vault.read(this.file(to));
      const target = frontmatter(content);
      const sourceMap = text(source["agent-map-id"], text(source["topic-id"]));
      const destinationMap = text(target["agent-map-id"], text(target["topic-id"]));
      const sourceId = text(source["node-id"]);
      const targetId = text(target["node-id"]);
      if (sourceMap && sourceId && targetId) {
        const key = JSON.stringify([sourceMap, sourceId]);
        if (copiedIds.has(key)) throw new Error("ambiguous-copied-card-identity");
        copiedIds.set(key, targetId);
      }
      identities.set(to, { sourceMap, destinationMap, content });
    }
    for (const { from, to } of pairs) {
      const file = this.file(to);
      const identity = identities.get(to)!;
      const { body, head } = splitFrontmatter(identity.content);
      const region = splitLivingNodeRegion(body).region;
      const rewrite = (part: string) => rewriteCopiedLinks(part, { sourcePath: from, newPath: to, copies, resolve });
      const at = region ? body.indexOf(region) : body.length;
      const before = rewrite(body.slice(0, at));
      const after = rewrite(body.slice(at + region.length));
      rewritten += before.rewritten + after.rewritten;
      unverified.push(...before.unverified, ...after.unverified);
      let next = head + before.text + region + after.text;
      const refs = frontmatter(identity.content)["living-node-refs"];
      if (Array.isArray(refs) && refs.every(value => typeof value === "string")) {
        const remapped = remapLivingCopyCardReferences(refs, identity.sourceMap, identity.destinationMap, copiedIds);
        // Resolve persisted external note references from the original path, not from the new card.
        const updated = remapped.map(ref => {
          if (!ref.startsWith("note:")) return ref;
          const sourcePath = resolve(ref.slice(5), from);
          if (!sourcePath) return "card:foreign:" + JSON.stringify([identity.sourceMap, ref]);
          const targetPath = copies.get(sourcePath) ?? sourcePath;
          return resolve(targetPath, to) === targetPath
            ? "note:" + targetPath
            : "card:foreign:" + JSON.stringify([identity.sourceMap, ref]);
        });
        if (JSON.stringify(updated) !== JSON.stringify(refs))
          next = setFrontmatterKeys(next, { "living-node-refs": updated });
      }
      if (next === identity.content) continue;
      // A change to a freshly created copy is a conflict, not permission to
      // attach a new card whose stored identities still point to the originals.
      await this.app.vault.process(file, content => {
        if (content !== identity.content) throw new Error("changed-copied-note");
        return next;
      });
    }
    return { rewritten, unverified };
  }

  async readMap(path: string): Promise<MapDocument> {
    return parseMap(await this.app.vault.read(this.file(path)));
  }

  /**
   * The vault as the knowledge-reference resolver reads it (P4.3): only maps that carry the marker, each read fresh, a
   * failure reported as null. Nothing here writes.
   */
  knowledgeRefIO(): KnowledgeRefIO {
    return {
      mapPaths: async () => (await this.mapFiles()).map(file => file.path),
      readMap: async path => {
        try {
          return await this.readMap(path);
        } catch {
          return null;
        }
      },
      noteFrontmatter: async path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return null;
        const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;
        return cached ?? frontmatter(await this.app.vault.cachedRead(file));
      },
      readNote: async path => {
        try {
          const note = await this.readNote(path);
          return { title: note.title, summary: note.summary, detail: note.detail };
        } catch {
          return null;
        }
      }
    };
  }

  /** Map.md read once: the map plus its sources (what hydrate and synchronize need). */
  async readMapMeta(path: string): Promise<MapMeta> {
    const content = await this.app.vault.read(this.file(path));
    const fm = frontmatter(content);
    return {
      map: parseMap(content),
      sources: readMapSources(fm)
    };
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
   * Sets (`ai-card: true`) or removes the AI card flag (and `ai-update-mode`, which only an AI card has). No other key changes and `updated` is not bumped; a note already in the
   * asked state is returned as it is, byte for byte.
   */
  async writeAiCard(path: string, on: boolean): Promise<void> {
    await this.app.vault.process(this.file(path), content =>
      readAiCard(frontmatter(content)) === on ? content : setFrontmatterKeys(content, { "ai-card": on ? true : null })
    );
  }

  /** Removes the Prompt section (an AI card whose question was cleared); other sections and `updated` are left as they are. */
  async clearPrompt(path: string): Promise<void> {
    await this.app.vault.process(this.file(path), content => removeSection(content, "Prompt"));
  }

  /**
   * Sets `ai-update-mode: fresh` (the AI card rewrites its note) or removes the key (keeps the old text, new on top). No other
   * key changes and `updated` is not bumped.
   */
  async writeAiUpdateMode(path: string, mode: "fresh" | "top"): Promise<void> {
    await this.app.vault.process(this.file(path), content =>
      (readAiUpdateMode(frontmatter(content)) ?? "top") === mode
        ? content
        : setFrontmatterKeys(content, { "ai-update-mode": mode === "fresh" ? "fresh" : null })
    );
  }

  /**
   * Records what "run all" did to an AI card: `ai-run-at`, `ai-run-result`, and `ai-run-input` (only when given: a failure or a
   * held-back card keeps the input of its last success). `updated` is not bumped.
   */
  async writeAiRunStamp(
    path: string,
    stamp: { at: string; result: "ok" | "failed" | "blocked"; input?: string }
  ): Promise<void> {
    await this.app.vault.process(this.file(path), content =>
      setFrontmatterKeys(content, {
        "ai-run-at": stamp.at,
        "ai-run-result": stamp.result,
        ...(stamp.input !== undefined ? { "ai-run-input": stamp.input } : {})
      })
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

  async saveMap(
    path: string,
    map: MapDocument,
    options?: {
      authorize?: (current: MapDocument) => void;
      preserveViewport?: boolean;
      recordWrite?: (before: MapDocument, after: MapDocument) => void;
    }
  ): Promise<void> {
    let print = "";
    await this.app.vault.process(this.file(path), content => {
      const current = parseMap(content);
      options?.authorize?.(current);
      const next = options?.preserveViewport ? { ...map, viewport: current.viewport } : map;
      const text = writeMapContent(content, next);
      print = this.printAfterWrite(path, coordinatePrint(current), coordinatePrint(next));
      options?.recordWrite?.(current, next);
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
  /** Pan/zoom: writes only the viewport. Unload sends the last one, which may finish after dispose; no other write may. */
  updateViewport(path: string, viewport: MapDocument["viewport"]): Promise<MapDocument> {
    if (this.disposed) return Promise.reject(new Error(this.message("error.unloaded_write_not_performed")));
    return this.viewportScope.run(true, () =>
      this.updateMap(path, map => {
        map.viewport = viewport;
      })
    );
  }

  async updateMap(
    path: string,
    change: (map: MapDocument) => void,
    recordWrite?: (write: TopicMapWrite) => void
  ): Promise<MapDocument> {
    let updated: MapDocument | undefined;
    let print = "";
    await this.app.vault.process(this.file(path), content => {
      const map = parseMap(content);
      const before = coordinatePrint(map);
      change(map);
      updated = map;
      const text = writeMapContent(content, map);
      print = this.printAfterWrite(path, before, coordinatePrint(map));
      recordWrite?.({ before: content, after: text });
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
      const repairs: { id: string; from: string; to: string }[] = [];
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
        repairs.push({ id: node.id, from: oldPath, to: matches[0] });
        rebaseMapNotePaths(map, moveNotePath(oldPath, matches[0]));
        await this.replaceSourcePath(oldPath, matches[0]);
      }
      if (repairs.length)
        await this.updateMap(file.path, current => {
          // The scan and citation updates may have yielded to an external editor.
          for (const { id, from, to } of repairs) {
            if (
              current.nodes.some(node => node.id === id && node.path === from) &&
              !(this.app.vault.getAbstractFileByPath(from) instanceof TFile) &&
              this.app.vault.getAbstractFileByPath(to) instanceof TFile
            ) {
              rebaseMapNotePaths(current, moveNotePath(from, to));
              repaired++;
            }
          }
        });
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
    // Validate the selected source before moving it, then rebase the actual document after the move.
    await this.readMap(sourcePath);
    const candidates = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(`${root}/Notes/`));
    const byId = new Map<string, string[]>();
    for (const file of candidates) {
      const fm = frontmatter(await this.app.vault.read(file));
      const id = text(fm["node-id"]);
      if (id) byId.set(id, [...(byId.get(id) ?? []), file.path]);
    }
    await this.moveExact(sourcePath, target);
    const map = await this.updateMap(target, current => {
      for (const node of [...current.nodes]) {
        const matches = byId.get(node.id) ?? [];
        if (
          matches.length === 1 &&
          !(this.app.vault.getAbstractFileByPath(node.path) instanceof TFile) &&
          this.app.vault.getAbstractFileByPath(matches[0]) instanceof TFile
        )
          rebaseMapNotePaths(current, moveNotePath(node.path, matches[0]));
      }
    });
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
        markedNotes: () => this.markedFiles("agent-map-node"),
        aroundHostMove: this.noteWriteScope.getStore()?.aroundHostMove
      },
      item,
      target
    );
  }

  /**
   * Obsidian's "Just once" link update can still write a note it collected link positions of before VAM's rename rewrite;
   * the watch recognises exactly that write and puts VAM's version back.
   */
  readonly renameWatch = new RenameRepairWatch({
    read: path => this.app.vault.read(this.file(path)),
    process: (path, change) => this.app.vault.process(this.file(path), change)
  });

  private obsidianMayUpdateLinks(): boolean {
    const vault = this.app.vault as unknown as { getConfig?: (key: string) => unknown };
    return typeof vault.getConfig === "function" && vault.getConfig("alwaysUpdateLinks") !== true;
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
    const rebase = chainRebase(pairs);
    const failures: unknown[] = [];
    for (const file of await this.markedFiles("agent-map-node")) {
      try {
        // Keep the indexed candidate filter. The actual rewrite uses the current file, not the earlier note snapshot.
        const cached = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (
          cached &&
          ![cached["source-notes"], cached["reference-materials"]].some(list => mentionsOldPath(list, pairs)) &&
          !rebaseLivingNoteReferences(cached["living-node-refs"], rebase)
        )
          continue;
        const raw = await this.app.vault.read(file);
        const metadata = frontmatter(raw);
        if (!marker(metadata["agent-map-node"])) continue;
        const note = await this.parseNote(file.path, raw);
        const referencePaths = note.referencePaths && rebasePathList(note.referencePaths, pairs);
        const sourcePaths = rebasePathList(note.sourcePaths, pairs);
        // The Living Node reference list is separate from the legacy citation lists.
        const livingRefs = rebaseLivingNoteReferences(metadata["living-node-refs"], rebase);
        if (!referencePaths && !sourcePaths && !livingRefs) continue;
        await this.app.vault.process(file, content => {
          const fm = frontmatter(content);
          if (!marker(fm["agent-map-node"])) return content;
          const paths = (key: string): string[] => {
            const list = fm[key];
            return Array.isArray(list)
              ? list.filter((value): value is string => typeof value === "string" && Boolean(value))
              : [];
          };
          const references = rebasePathList(paths("reference-materials"), pairs);
          const sources = rebasePathList(paths("source-notes"), pairs);
          const living = rebaseLivingNoteReferences(fm["living-node-refs"], rebase);
          if (!references && !sources && !living) return content;
          const next =
            references || sources
              ? this.patchedNote(
                  file.path,
                  content,
                  {
                    ...(references ? { referencePaths: references } : {}),
                    ...(sources ? { sourcePaths: sources } : {})
                  },
                  {}
                )
              : content;
          const written = living ? setFrontmatterKeys(next, { "living-node-refs": living }) : next;
          if (written !== content && this.obsidianMayUpdateLinks())
            this.renameWatch.remember(file.path, written, pairs, linkSpans(content, pairs));
          return written;
        });
      } catch (error) {
        // One unreadable or unwritable note must not prevent later candidates from following the rename.
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        failures.map(error => (error instanceof Error ? error.message : String(error))).join("; ")
      );
  }

  /** Rebases one managed note's current citation lists and records the exact before/after bytes inside the write. */
  private async rebaseNoteLists(
    file: TFile,
    rebase: (path: string) => string,
    recordPrior: (before: string, after: string) => void
  ): Promise<void> {
    await this.app.vault.process(file, content => {
      const fm = frontmatter(content);
      if (!marker(fm["agent-map-node"])) return content;
      const paths = (key: string): string[] => {
        const list = fm[key];
        return Array.isArray(list)
          ? list.filter((value): value is string => typeof value === "string" && Boolean(value))
          : [];
      };
      const references = paths("reference-materials"),
        sources = paths("source-notes");
      const patch: NotePatch = {};
      if (references.some(path => rebase(path) !== path)) patch.referencePaths = references.map(rebase);
      if (sources.some(path => rebase(path) !== path)) patch.sourcePaths = sources.map(rebase);
      const living = rebaseLivingNoteReferences(fm["living-node-refs"], rebase);
      if (!Object.keys(patch).length && !living) return content;
      const next = Object.keys(patch).length ? this.patchedNote(file.path, content, patch, {}) : content;
      const text = living ? setFrontmatterKeys(next, { "living-node-refs": living }) : next;
      recordPrior(content, text);
      return text;
    });
  }

  /** Rebase a candidate map without overwriting intervening edits; journal the actual replaced bytes before publishing. */
  private async rebaseMapPaths(
    file: TFile,
    rebase: (path: string) => string,
    recordPrior: (before: string, after: string) => void
  ): Promise<void> {
    let print: string | undefined;
    await this.app.vault.process(file, content => {
      const map = parseMap(content);
      const before = coordinatePrint(map);
      if (!rebaseMapNotePaths(map, rebase)) return content;
      const text = writeMapContent(content, map);
      print = this.printAfterWrite(file.path, before, coordinatePrint(map));
      recordPrior(content, text);
      return text;
    });
    if (print !== undefined) this.writtenCoordinates.set(file.path, print);
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
      const moves: RenamePair[] = [];
      let mapRenamed = 0;
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
        moves.push([oldPath, newPath]);
        mapRenamed++;
        renamed++;
        await this.replaceSourcePath(oldPath, newPath);
      }
      if (!moves.length) continue;
      try {
        await this.updateMap(mapFile.path, current => {
          rebaseMapNotePaths(current, chainRebase(moves));
        });
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
  async rebuildDerivedData(
    scope?:
      | {
          roots: string[];
          paths?: Iterable<string>;
          onWrite?: (path: string, before: string, after: string) => void;
        }
      | string
  ): Promise<void> {
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
      if (derived === null || derived === cached || livingRewriteIsReformatOnly(cached, derived, frontmatter)) continue;
      await this.app.vault.process(file, content => {
        const next = this.derivedNoteContent(file, content, ownership, topics) ?? content;
        if (livingRewriteIsReformatOnly(content, next, frontmatter)) return content;
        if (next !== content && typeof scope === "object") scope.onWrite?.(file.path, content, next);
        return next;
      });
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
    // User paragraphs written after the references block are kept byte-identical in place: the rebuild only sees the
    // text up to the block, so they cannot fall into the Preview section once the block is taken out (B26).
    const raw = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
    const referenceStart = raw.indexOf(REFERENCE_START);
    const referenceEnd = referenceStart >= 0 ? raw.indexOf(REFERENCE_END, referenceStart) : -1;
    const trailing = referenceEnd >= 0 ? raw.slice(referenceEnd + REFERENCE_END.length) : "";
    const kept = trailing.trim() ? trailing : "";
    let body = ensurePreview(
      decodeCalloutSections(kept ? raw.slice(0, referenceEnd + REFERENCE_END.length) : raw),
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
    const derived = localizeHeadings(
      withReferenceLinks(body, fm, language),
      writtenHeadingSet(content, this.headingsFor(textLanguage))
    );
    return `---\n${stringifyYaml(fm)}---\n${kept ? `${derived.trimEnd()}${kept}` : derived}`;
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
      // Cross-map references point at other maps and stay as they are; the ones hanging on a copied card hang on its copy.
      const refs = duplicatedKnowledgeRefs(source, new Map([...copies].map(([id, copy]) => [id, copy.id])));
      if (refs) map.knowledgeRefs = refs;
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
        renameTopic: (path, title, target, options) => this.renameTopic(path, title, target, options),
        rebuildDerivedData: scope => this.rebuildDerivedData(scope),
        undoTopicRename: (path, root, write) => this.undoTopicRename(path, root, write),
        markedFiles: key => this.markedFiles(key),
        rebaseNoteLists: (file, rebase, recordPrior) => this.rebaseNoteLists(file, rebase, recordPrior),
        readableMaps: () => this.readableMaps(),
        rebaseMapPaths: (file, rebase, recordPrior) => this.rebaseMapPaths(file, rebase, recordPrior)
      },
      moves,
      onProgress
    );
  }

  async renameTopic(
    mapPath: string,
    title: string,
    targetRoot?: string,
    options: TopicRenameOptions = {}
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
    let write: TopicMapWrite | undefined;
    try {
      if (desired !== originalRoot) {
        await this.relocate(root, desired);
        moved = true;
        if (!(this.app.vault.getAbstractFileByPath(desired) instanceof TFolder))
          throw new Error(this.message("error.move_not_applied"));
      }
      const rebasePath = (path: string): string =>
        path.startsWith(`${originalRoot}/`) ? `${desired}/${path.slice(originalRoot.length + 1)}` : path;
      await this.updateMap(
        next,
        map => {
          map.title = title;
          rebaseMapNotePaths(map, rebasePath);
        },
        entry => {
          write = entry;
          options.recordWrite?.(entry);
        }
      );
      await rebuild();
      return next;
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (moved || write) {
        try {
          await this.undoTopicRename(moved ? next : originalMapPath, originalRoot, write);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        try {
          await rebuild();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length) {
        const describe = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
        throw new Error(
          `Topic rename failed (${describe(error)}); rollback also failed (${rollbackErrors.map(describe).join("; ")}).`
        );
      }
      throw error;
    }
  }

  /** Undo only bytes this rename wrote. A later edit is preserved and reported; folder recovery is still attempted. */
  private async undoTopicRename(
    mapPath: string,
    originalRoot: string,
    write: TopicMapWrite | undefined
  ): Promise<void> {
    const currentRoot = parentPath(mapPath);
    const failures: unknown[] = [];
    if (write) {
      try {
        await this.app.vault.process(this.file(mapPath), current => {
          if (current === write.before) return current;
          if (current !== write.after)
            throw new Error("Topic map changed after rename; rollback would overwrite edits.");
          return write.before;
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (currentRoot !== originalRoot) {
      try {
        const folder = this.app.vault.getAbstractFileByPath(currentRoot);
        if (!(folder instanceof TFolder) || this.app.vault.getAbstractFileByPath(originalRoot))
          throw new Error("Renamed topic folder could not be restored safely.");
        await this.relocate(folder, originalRoot);
        if (
          !(this.app.vault.getAbstractFileByPath(originalRoot) instanceof TFolder) ||
          this.app.vault.getAbstractFileByPath(currentRoot)
        )
          throw new Error(this.message("error.move_not_applied"));
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        failures.map(error => (error instanceof Error ? error.message : String(error))).join("; ")
      );
    if (write) this.noteRestoredMap(`${originalRoot}/Map.md`, write.before);
  }

  async migrate(): Promise<void> {
    /* v0.2 import remains intentionally disabled; the pre-0.4 workspace migration was removed in 0.19. */
  }
}
