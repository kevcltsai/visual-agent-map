import { createBookStructurePort } from "./experiences/visual-map/book-structure-port";
import type { TopicMarker } from "./topic-markers";
import { registerInternalMarkerPresentation } from "./experiences/markdown-context/internal-markers";
import { upgradeSocialVideoLinks } from "./experiences/markdown-context/social-video-cards";
import { markPictureParagraphs } from "./experiences/markdown-context/picture-paragraphs";
import { registerBookPlanView } from "./experiences/visual-map/book-plan-view";
import { registerBookFigures } from "./experiences/book-figures/register";
import { registerMermaidZoom, type MermaidZoomHandle } from "./experiences/mermaid-zoom/register";
import { KnowledgeIndex } from "./experiences/visual-map/knowledge-retrieval";
import { VisualAgentMapView, VIEW_TYPE } from "./experiences/visual-map/view";
import { CARD_COMMANDS, commandTitleKey } from "./experiences/visual-map/card-actions";
import { NodeDetailsSidebar } from "./experiences/visual-map/node-details-sidebar";
import { LIVING_READER_VIEW, LivingReaderView } from "./experiences/visual-map/living-node-reader";
import type { LivingChangeSummary } from "./experiences/visual-map/living-node-changes";
import { livingCoordinator } from "./experiences/visual-map/living-node-runtime";
import { LivingIdentityStore, setLivingIdentityStore } from "./experiences/visual-map/living-node-sources";
import { plainFailure } from "./ai/plain-error";
import { actionNotice, errorNotice } from "./experiences/visual-map/note-style-picker";
import { planMathRepair, applyMathRepair } from "./experiences/visual-map/math-repair";
import type { TaskOptions } from "./experiences/visual-map/modals";
import { attachmentPath } from "./experiences/visual-map/attachment-store";
import { selectionOutputLanguage } from "./core/content-language";
import { isLivingNodeNote } from "./core/living-node-region";
import {
  BookPipelineRunError,
  BookPipelineRuns,
  type BookPipelineProgress,
  type PipelineCard,
  type BookRerunResult,
  type NotesApplyResult,
  type RefindResult
} from "./experiences/visual-map/book-pipeline-run";
import type { StructureNode, StructureOp } from "./core/book-pipeline/structure-edit";
import { bookErrorReason, bookRefusalText, lockedSkippedNotice } from "./experiences/visual-map/book-pipeline-ui";
import { backupNoteFile } from "./experiences/visual-map/note-backup";
import { writeOpenIssuesFile } from "./experiences/visual-map/book-open-issues-file";
import {
  BookCallouts,
  createNoteWriter,
  editorViewsOf,
  rerenderReadingViewsWhenLoaded,
  shownText,
  type OpenNoteView
} from "./experiences/visual-map/book-pipeline-callouts";
import { BookHandEdits } from "./experiences/visual-map/book-pipeline-handedit";
import {
  BookNoteModal,
  BookNotes,
  type NotesEditor,
  type NotesLeaf
} from "./experiences/visual-map/book-pipeline-notes-ui";
import { BookNotesApply } from "./experiences/visual-map/book-pipeline-notes-apply";
import { BookRefindSlot } from "./experiences/visual-map/book-pipeline-refind-slot";
import { figureUrlAt } from "./core/book-pipeline/refind-slot";
import { locateAppliedShown } from "./core/book-pipeline/notes-apply";
import { showAppliedNotice } from "./experiences/visual-map/book-applied-notice";
import {
  AppliedHighlights,
  appliedExtension,
  ReadingHighlight,
  rerenderReadingViews,
  sectionSource,
  setApplied,
  type HighlightTarget
} from "./experiences/visual-map/book-applied-highlight";
import type { EditorView } from "@codemirror/view";
import { countNotes } from "./core/book-pipeline/book-notes";
import { effectiveOrder, readBookPipeline } from "./core/book-pipeline/model";
import { runPlanStep } from "./core/steps/book-pipeline/run";
import { runProofread } from "./core/steps/book-pipeline/proofread";
import { runFindImages } from "./core/steps/book-pipeline/find-images";
import { downloadPicture, runImageFitCheck } from "./core/steps/book-pipeline/image-fit-check";
import { createPictureFetch } from "./experiences/visual-map/picture-transport";
import { runDrawDiagrams } from "./core/steps/book-pipeline/draw-diagrams";
import { runAiBookProof, runAiProof } from "./core/steps/book-pipeline/ai-proof";
import { runAiFix } from "./core/steps/book-pipeline/ai-fix";
import { COMMONS_API } from "./core/book-pipeline/commons-search";
import { downloadCover, saveCover } from "./core/book-pipeline/cover-download";
import { withCover } from "./experiences/visual-map/card-cover";
import { runSuggestSettings } from "./core/steps/book-pipeline/suggest-settings";
import { runEditSettings, type EditSettingsResult } from "./core/steps/book-pipeline/edit-settings";
import type { BookSettings } from "./core/book-pipeline/model";
import { t, setUiLanguage, translate, languagePromptName, uiLocale, type TranslationKey } from "./i18n";
import {
  addIcon,
  FileSystemAdapter,
  getLanguage,
  loadMermaid,
  MarkdownView,
  type Editor,
  normalizePath,
  requestUrl,
  arrayBufferToBase64,
  Notice,
  Plugin,
  TFile,
  TFolder,
  WorkspaceLeaf,
  type Command,
  type TAbstractFile
} from "obsidian";
import { readAiLocked, TOPIC_KINDS } from "./note-values";
import { frontmatter } from "./core/repository-frontmatter";
import { kindIconId, kindIconSvg } from "./experiences/visual-map/topic-kind-shape";
import {
  NoteStyleStore,
  type RunStyle,
  type SaveRecipeInput,
  type SaveRecipeResult,
  type StyleCategory,
  type StyleFilePort
} from "./ai/note-style-store";
import type { PartCategory, StyleKind } from "./ai/note-style-recipe";
import {
  clearKindStyles,
  deleteStyleReferences,
  renameStyleReferences,
  setGlobalPart,
  setKindStyle,
  type NoteStylePorts
} from "./ai/note-style-references";
import { ChoiceModal } from "./ui/modals/choice-modal";
import { turnMapChatRecordsOff, type MapChatRecordsSwitch } from "./ui/modals/map-chat-records-off-modal";
import { PromptPreviewModal } from "./ui/modals/prompt-preview-modal";
import { DebugLogModal } from "./ui/modals/debug-log-modal";
import {
  AiUsageModal,
  ClaudeSetupModal,
  CodexSetupModal,
  VisualAgentMapSettingTab,
  CLAUDE_INSTALL_URL
} from "./ui/settings-tab";
import { join } from "node:path";
import { type MapDocument } from "./map-model";
import { chainRebase, touchedPaths, type RenamePair } from "./core/rename-batch";
import {
  DEFAULT_SETTINGS,
  isManagedMapPath,
  normalizeReasoningLevel,
  rebaseMapNotePaths,
  type Note,
  Repository,
  type Settings
} from "./repository";
import { effectiveReasoningLevel } from "./ai/task-policy";
import { resolveTaskModel, type ModelChoice } from "./ai/model-resolution";
import type { AiResult, AiTaskKind, Suggestion, TaskContext } from "./ai/types";
import { fitImageForInput } from "./ui/fit-image-input";
import { debugLog, LogManager } from "./log-manager";
import { AiExchangeLog } from "./ai-exchange-log";
import { AiUsageStore } from "./core/ai-usage-store";
import { VaultWriteRecovery } from "./core/vault-write-recovery";
import { PendingSuggestions } from "./pending-suggestions";
import { OutlineView, OUTLINE_VIEW_TYPE } from "./ui/outline-view";
import { chooseAndImportExchange } from "./experiences/visual-map/outline-exchange-io";
import { ShareModal } from "./experiences/sharing/share-modal";
import { releaseMermaidCapture } from "./experiences/sharing/share-exporter";
import { ShareTranslationCache } from "./experiences/sharing/share-translate-plan";
import { obsidianTranslateDom } from "./experiences/sharing/share-translate-dom";
import { providerShareTranslateRunner, ShareTranslateService } from "./experiences/sharing/share-translate-service";
import { groupRibbonIcons } from "./ui/ribbon-group";
import { CodexAppServerRuntime, type CodexWebSearchEvent } from "./ai/runtime/codex-app-server";
import { ClaudeCodeCliRuntime } from "./ai/runtime/claude-code-cli";
import { CLAUDE_MODEL_CHOICES } from "./ai/providers/provider";
import { prepareStep, type PreparedStep } from "./core/step-runner";
import type { ImageCandidate } from "./core/image-candidates";
import { imageSearchStep } from "./core/steps/image-search/step";
import { AiCalls } from "./core/ai-calls";
import type { AiRuntimeId } from "./core/ai-runtime";
import { AiRuntimeService } from "./core/ai-runtime-service";
import { ModelDiscovery, type ModelDiscoveryState } from "./core/model-discovery";
import { ShallowExpansionCoordinator, type ExpansionBatchState } from "./experiences/visual-map/expansion-batch";
import { ResearchProgressStore } from "./experiences/visual-map/research-progress";
import { TopicRuns, type ChartJob } from "./experiences/visual-map/topic-run";
import { ArgumentRuns, topicKindOfNote } from "./experiences/visual-map/argument-run";
import { inertHtmlText } from "./core/argument-map/source-proof";
import { askArgumentStep, providerArgumentRunner } from "./core/steps/argument-map/runner";
import type { ResearchObserver } from "./ai/research-observer";
import { AiTaskService } from "./core/ai-task-service";
import { mermaidSyntaxCheck } from "./ai/mermaid-safety";
import { localizedResponseSchema } from "./core/steps/task/schemas";
import { OutlineGenerationService, providerOutlineRunner } from "./core/outline-generation-service";
import { StructureReviewService, providerStructureReviewRunner } from "./core/structure-review-service";
import { MapChatService, providerMapChatRunner } from "./core/map-chat-service";
import { MarkdownSelectionAi } from "./experiences/markdown-context/selection-ai";
import { noticeInWindowOf } from "./ui/modals/notice-in-window";
import { openInWindowOf } from "./ui/modals/open-in-window";
import { hasLegacyChatModel, settingsFromSaved } from "./settings-from-saved";

export {
  hasLegacyChatModel,
  normalizeNoteStyleByKind,
  normalizeNoteStyleDefaults,
  normalizeNoteStyleRecipeMarker,
  settingsFromSaved
} from "./settings-from-saved";
export { buildPreparedTaskContext } from "./ai/context-builder";
export { extractJsonObject } from "./core/ai-task-service";
export { executableCandidates } from "./core/ai-runtime-service";
export { canonicalDetail, visualReferencesMarkdown } from "./ai/result-utils";
export { VisualAgentMapView } from "./experiences/visual-map/view";
export { ChildProposalModal, DraftReviewModal, NextStepModal } from "./experiences/visual-map/modals";
export { VisualAgentMapSettingTab } from "./ui/settings-tab";
export { firstMarkdownImage, firstMarkdownTable, markdownImages } from "./ui/preview-utils";
export type { AiRunMetrics, PreparedTaskContext } from "./ai/types";

/** Obsidian's interface language code ("en" when it cannot be read). */
export function obsidianAppLanguage(): string {
  try {
    return typeof getLanguage === "function" ? getLanguage() : "en";
  } catch {
    return "en";
  }
}
/** The ports of ai/note-style-references.ts; lazy closures, so the settings and the topics are read when a call runs. A function, not a method, so a stand-in plugin that borrows the facade methods needs no extra member. */
function noteStylePorts(plugin: VisualAgentMapPlugin): NoteStylePorts {
  return {
    settings: () => plugin.settings,
    save: () => plugin.saveSettings(),
    files: {
      renameFile: (category, ref, name) => plugin.noteStyles.renameFile(category, ref, name),
      rewritePartRefs: (category, oldName, newName) => plugin.noteStyles.rewritePartRefs(category, oldName, newName),
      trashFile: (category, ref) => plugin.noteStyles.trashFile(category, ref)
    },
    topics: {
      list: () => plugin.topicNoteStyleRefs(),
      rename: (path, from, to) => plugin.repo.renameNoteStyleRef(path, from, to)
    }
  };
}

/** A rename event waiting in a batch: the move, the file, and whether it came while VAM was not writing. */
interface PendingRename {
  pair: RenamePair;
  file: TFile;
  external: boolean;
}
/** The plugin's public repository page (the README's address): the contact part of the Wikimedia User-Agent. */
const PUBLIC_REPO_URL = "https://github.com/kevcltsai/visual-agent-map";

/** One transport for every picture look: Node https, no automatic redirect, no private address (see picture-transport.ts). */
const pictureFetch = createPictureFetch({ userAgent: `VisualAgentMap-Obsidian-plugin (${PUBLIC_REPO_URL})` });

export default class VisualAgentMapPlugin extends Plugin {
  /** Diagnostics for the mermaid zoom viewer (observer count); read by UI checks only. */
  mermaidZoom: MermaidZoomHandle | null = null;
  settings: Settings = { ...DEFAULT_SETTINGS };
  repo!: Repository;
  /** Past cards a chat message can find (P4.1), in memory only; any vault change drops it. */
  readonly knowledgeIndex = new KnowledgeIndex(() => this.repo.knowledgeRefIO());
  /** Reads the note style files once per run and resolves a topic's style; writes files only on a user action. */
  readonly noteStyles = new NoteStyleStore({
    settings: () => this.settings,
    port: this.noteStylePort(),
    save: () => this.saveSettings()
  });
  ready: Promise<void> = Promise.resolve();
  /** Settles once startup adoption of crash-orphaned card notes is done; a chat batch waits for it before staging cards. */
  orphansAdopted: Promise<void> = Promise.resolve();
  /** The topics with a run in flight; {@link topicRuns} reads this same Set. */
  readonly running = new Set<string>();
  readonly quickExpandPending = new Set<string>();
  readonly aiCalls = new AiCalls({
    runtimeFor: model => this.aiRuntime.runtimeFor(model),
    exchanges: () => (this.settings.aiExchangeLoggingEnabled ? this.exchanges : null),
    releaseWarm: () => this.aiRuntime.releaseWarm(),
    usage: () => this.usage
  });
  readonly activeTasks = this.aiCalls.activeTasks;
  /** Background chart steps (running and queued), keyed by note path; owned by {@link topicRuns}. */
  get chartJobs(): ReadonlyMap<string, AbortController> {
    return this.topicRuns.chartJobs;
  }
  /** Set by onunload; a late dialog event must not start a pre-warmed process after it. */
  private unloaded = false;
  /** Stage, elapsed time and the unsaved answer preview of research and chart steps in flight, keyed by note path. */
  /** Map views with a pan or zoom not yet written (waiting for the debounce or queued); unload sends them at once. */
  readonly viewportsPending = new Set<{ flushViewportOnUnload(): void }>();
  readonly researchProgress = new ResearchProgressStore();
  /** Owns the background chart queue. Every port is read on use: tests and onload replace these objects after construction. */
  readonly topicRuns = new TopicRuns({
    aiTasks: () => this.aiTasks,
    mutate: () => work => this.mutate(work),
    progress: () => this.researchProgress,
    repository: () => this.repo,
    running: () => this.running,
    pendingSuggestions: () => this.pendingSuggestions,
    activeTasks: () => this.activeTasks,
    askModel: (...args) => this.askModel(...args),
    settings: () => this.settings,
    exchanges: () => this.exchanges,
    recordFailure: (context, error) => this.recordFailure(context, error),
    runStyle: ({ note, outputLanguage, rewrite }) =>
      this.noteStyles.runStyle({
        topic: { style: note.noteStyle, template: note.detailTemplateId, tone: note.toneId },
        kind: note.topicKind ?? "topic",
        outputLanguage,
        detail: note.detail,
        ...(rewrite ? { rewrite } : {})
      }),
    resolveModel: (path, map, runOnce) => this.repo.resolveTopicModel(path, map, runOnce),
    clearOtherHistory: origin => {
      for (const view of this.views()) if (view !== origin) view.clearUndoHistory();
    },
    refreshViews: () => {
      for (const view of this.views()) view.reloadAfterAiRun();
    }
  });
  readonly expansionBatches = new Map<string, ExpansionBatchState>();
  readonly expansionCoordinator = new ShallowExpansionCoordinator(this.activeTasks, this.expansionBatches);
  /**
   * Hypothesis research runner, keyed by map path. Started by sending from the opening screen's "Hypothesis research"
   * tab (the map view, `startArgumentFromTab`); the map chat cannot start it. Also reachable from
   * `app.plugins.plugins[id].argumentRuns` over CDP. Ports are lazy getters, so `repo` may be built later.
   */
  readonly argumentRuns = new ArgumentRuns({
    mutate: work => this.mutate(work),
    readMap: path => this.repo.readMap(path),
    updateMap: (path, change) => this.repo.updateMap(path, change),
    createNote: (input, map, mapPath) =>
      this.repo.createNote(input.title, this.currentModelChoice().model, map, mapPath, "workspace", {
        summary: input.summary,
        detail: input.detail,
        topicKind: topicKindOfNote(input.kind)
      }),
    readNote: async path => {
      const note = await this.repo.readNote(path);
      return { title: note.title, summary: note.summary };
    },
    updateNote: (path, patch) => this.repo.updateNoteGuarded(path, patch, { rejectAiCard: true }),
    askModel: (context, model, reasoning, signal) => this.askModel(context, model, reasoning, signal),
    runStep: (step, request, signal) => askArgumentStep(step, request, providerArgumentRunner(this.aiCalls), signal),
    // requestUrl has no abort: verifySource races its own 15 s timeout and the runner's fence drops a late result.
    fetch: async request => {
      const response = await requestUrl(request);
      return {
        status: response.status,
        headers: response.headers,
        text: response.text,
        arrayBuffer: response.arrayBuffer
      };
    },
    parseHtml: html => inertHtmlText(html),
    now: () => new Date().toISOString(),
    newId: () => crypto.randomUUID(),
    config: () => ({
      ...this.currentModelChoice(),
      language: selectionOutputLanguage(this.settings.language, "")
    }),
    begin: path => this.topicRuns.begin(path, "research"),
    clearUndo: path => {
      for (const view of this.views()) if (view.mapPath === path) view.clearUndoHistory();
    },
    log: line => this.logs.appendLog("info", line),
    t: (key, ...values) => t(key, ...values),
    confirmUsage: () => this.confirmAiUsage(this.currentModelChoice().model, async () => {})
  });
  /**
   * Picture-book pipeline runner, keyed by map path. Entries: {@link startBookPipeline} and friends (the screen and the
   * commands call those). The map's open view supplies the author call and the image probe; without one they fail.
   */
  /** The picture-book chapter notes' callouts (trial hint, review box); every program write to a chapter note goes through its writer. */
  /** The write coordinator of the chapter notes: the callouts, the reader's notes and (T6) the rewrite all go through it. */
  private readonly bookNoteWriter = createNoteWriter({
    openViews: path => this.openMarkdownViews(path),
    canWrite: content => !isLivingNodeNote(content, frontmatter(content)),
    rawGuarded: (path, transform, options) => this.repo.updateNoteRawGuarded(path, transform, options),
    rerender: path =>
      rerenderReadingViewsWhenLoaded(
        this.app.workspace
          .getLeavesOfType("markdown")
          .flatMap(leaf => (leaf.view instanceof MarkdownView ? [leaf.view] : []))
          .map(view => ({
            path: view.file?.path,
            reading: view.getMode() === "preview",
            data: () => view.getViewData(),
            rerender: () => view.previewMode.rerender(true)
          })),
        path,
        async () => {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile)) throw new Error("missing");
          return this.app.vault.read(file);
        },
        ms => new Promise(done => window.setTimeout(done, ms))
      )
  });
  readonly bookCallouts = new BookCallouts({
    readMap: path => this.repo.readMap(path),
    readCard: path => this.readBookCard(path),
    readText: async path => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error("missing");
      return this.app.vault.read(file);
    },
    write: (path, transform) => this.bookNoteWriter(path, transform),
    log: line => this.logs.appendLog("info", line),
    newId: () => crypto.randomUUID()
  });
  /** The reader's two answers on a hand-edited chapter's box (keep; rewrite now or queued behind a running book). */
  readonly bookHandEdits = new BookHandEdits({
    readMap: path => this.repo.readMap(path),
    readCard: path => this.readBookCard(path),
    write: (path, transform) => this.bookNoteWriter(path, transform),
    writeFields: (path, patch) => this.repo.writePipelineFields(path, patch),
    rerunCard: (mapPath, nodeId, options) => this.bookPipelineRuns.rerunCard(mapPath, nodeId, options),
    isRunning: mapPath => this.bookPipelineRuns.isRunning(mapPath),
    newId: () => crypto.randomUUID(),
    log: line => this.logs.appendLog("info", line)
  });
  /** The reader's notes of a picture-book chapter: editor-menu item, commands, input dialog and the header action. */
  private readonly bookNotes = new BookNotes({
    leaves: () => this.bookNoteLeaves(),
    chapterPaths: paths => this.bookChapterPaths(paths),
    write: (path, transform) => this.bookNoteWriter(path, transform),
    askNote: (selected, submit) => new BookNoteModal(this.app, selected, submit).open(),
    notice: message => void new Notice(message),
    applyNotes: path => this.applyBookNotes(path),
    addBlocked: path => {
      const map = this.bookChapterMaps.get(path);
      return map && this.bookPipelineRuns.isRunning(map) ? t("ui.book_refused_drive_running") : null;
    },
    applyStatus: path => {
      const running = this.bookNotesApply.isRunning(path);
      const disabled = this.bookNotesApply.disabledReason(path);
      return {
        running,
        ...(running ? { elapsed: this.bookNotesApply.elapsed(path) ?? "0:00" } : {}),
        ...(disabled ? { disabled } : {})
      };
    }
  });
  private bookNotesTimer: number | null = null;
  /** Chapter note path to its map path, filled when the chapters are looked up (the header action needs the map synchronously). */
  private readonly bookChapterMaps = new Map<string, string>();
  /** The apply job of a chapter (clock, cancel, messages) and the undo of the last apply. */
  private readonly bookNotesApply = new BookNotesApply({
    run: (path, signal) => this.runBookNotes(path, signal),
    cancel: path => {
      const map = this.bookChapterMaps.get(path);
      if (map) this.bookPipelineRuns.cancelNotes(map);
    },
    mapBusy: path => {
      const map = this.bookChapterMaps.get(path);
      if (!map) return null;
      if (this.bookPipelineRuns.isRunning(map)) return "drive";
      return this.bookPipelineRuns.isApplyingNotes(map) ? "notes" : null;
    },
    codeOf: error => (error instanceof BookPipelineRunError ? error.code : undefined),
    refusalText: error => bookRefusalText(error),
    reasonText: error => bookErrorReason(error),
    write: (path, transform) => this.bookNoteWriter(path, transform),
    notice: message => void new Notice(message),
    noticeAction: (message, label, onClick, ms) =>
      showAppliedNotice(
        document.body,
        { set: (run, delay) => window.setTimeout(run, delay), clear: handle => window.clearTimeout(handle as number) },
        message,
        label,
        onClick,
        ms
      ),
    highlight: (path, ranges, afters) => void this.showBookHighlight(path, ranges, afters),
    releaseHighlight: () => {
      this.bookHighlights.release();
      this.readingHighlight.release();
    },
    flush: async path => {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown"))
        if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) await leaf.view.save();
    },
    undone: path => {
      rerenderReadingViews(
        this.app.workspace
          .getLeavesOfType("markdown")
          .flatMap(leaf => (leaf.view instanceof MarkdownView ? [leaf.view] : []))
          .map(view => ({
            path: view.file?.path,
            reading: view.getMode() === "preview",
            rerender: () => view.previewMode.rerender(true)
          })),
        path
      );
      const map = this.bookChapterMaps.get(path);
      if (map) void this.bookCallouts.reconcile(map);
    },
    changed: () => this.bookNotes.paint(),
    now: () => Date.now(),
    setTimer: (run, ms) => window.setTimeout(run, ms),
    clearTimer: handle => window.clearTimeout(handle as number),
    setTick: (run, ms) => window.setInterval(run, ms),
    clearTick: handle => window.clearInterval(handle as number)
  });
  /** "Find another picture" for one picture of a chapter (V3.3 P5.1b): the job, cancel, messages and the undo of the last swap. */
  private readonly bookRefindSlot = new BookRefindSlot({
    run: (path, url, signal) => this.runBookRefind(path, url, signal),
    cancel: path => {
      const map = this.bookChapterMaps.get(path);
      if (map) this.bookPipelineRuns.cancelNotes(map);
    },
    mapBusy: path => {
      const map = this.bookChapterMaps.get(path);
      if (!map) return null;
      if (this.bookPipelineRuns.isRunning(map)) return "drive";
      return this.bookPipelineRuns.isApplyingNotes(map) ? "notes" : null;
    },
    codeOf: error => (error instanceof BookPipelineRunError ? error.code : undefined),
    refusalText: error => bookRefusalText(error),
    reasonText: error => bookErrorReason(error),
    write: (path, transform) => this.bookNoteWriter(path, transform),
    notice: message => void new Notice(message),
    noticeAction: (message, label, onClick, ms) =>
      showAppliedNotice(
        document.body,
        { set: (run, delay) => window.setTimeout(run, delay), clear: handle => window.clearTimeout(handle as number) },
        message,
        label,
        onClick,
        ms
      ),
    changed: () => this.bookNotes.paint(),
    setTimer: (run, ms) => window.setTimeout(run, ms),
    clearTimer: handle => window.clearTimeout(handle as number)
  });
  /** The light-green mark on the paragraphs just rewritten, in every open editor of the note (10 s). */
  private readonly bookHighlights = new AppliedHighlights({
    targets: () => this.bookHighlightTargets(),
    setTimer: (run, ms) => window.setTimeout(run, ms),
    clearTimer: handle => window.clearTimeout(handle as number)
  });
  /** The reading view's mark: the rendered sections of the applied paragraphs wear the same light-green class for 10 s (post-processor + a re-render). */
  private readonly readingHighlight = new ReadingHighlight({
    views: () =>
      this.app.workspace.getLeavesOfType("markdown").flatMap(leaf => {
        const view = leaf.view;
        if (!(view instanceof MarkdownView)) return [];
        return [
          {
            path: view.file?.path,
            reading: view.getMode() === "preview",
            rerender: () => view.previewMode.rerender(true),
            unmark: () =>
              view.previewMode?.containerEl
                ?.querySelectorAll(".vam-book-applied")
                .forEach(el => el.removeClass("vam-book-applied"))
          }
        ];
      }),
    setTimer: (run, ms) => window.setTimeout(run, ms),
    clearTimer: handle => window.clearTimeout(handle as number)
  });
  /** The marks follow the paragraphs' text in the note as it is now (the offsets of the apply are stale once the review box is stamped), never a callout. */
  private async showBookHighlight(
    path: string,
    ranges: readonly { from: number; to: number }[],
    afters: readonly string[]
  ): Promise<void> {
    let found = ranges;
    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile)
        found = await locateAppliedShown(
          { editor: () => this.openMarkdownViews(path)[0]?.text(), file: () => this.app.vault.read(file) },
          afters
        );
    } catch {
      found = [];
    }
    this.bookHighlights.show(path, found);
    this.readingHighlight.show(path, afters);
  }
  private bookHighlightTargets(): HighlightTarget[] {
    const out: HighlightTarget[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      const cm = (view.editor as unknown as { cm?: EditorView }).cm;
      if (!cm) continue;
      out.push({
        key: view,
        path: () => view.file?.path,
        set: ranges => cm.dispatch({ effects: setApplied.of(ranges) })
      });
    }
    return out;
  }
  /** The header action, the menu item and the command end here. */
  private applyBookNotes(path: string): void {
    this.bookNotesApply.press(path);
  }
  /** Finds the chapter's map and card, then runs the runner's notes job (a refusal or failure is thrown to the controller). */
  private async runBookNotes(path: string, signal: AbortSignal): Promise<NotesApplyResult> {
    for (const { file, map } of await this.repo.readableMaps()) {
      const node = map.nodes.find(item => item.path === path);
      const read = readBookPipeline(map);
      if (node && read.kind === "usable" && effectiveOrder(read.data).includes(node.id))
        return await this.bookPipelineRuns.applyNotes(file.path, node.id, { signal });
    }
    throw new BookPipelineRunError("missing");
  }
  /** Finds the chapter's map and card, then runs the runner's picture job (a refusal or failure is thrown to the controller). */
  private async runBookRefind(path: string, url: string, signal: AbortSignal): Promise<RefindResult> {
    for (const { file, map } of await this.repo.readableMaps()) {
      const node = map.nodes.find(item => item.path === path);
      const read = readBookPipeline(map);
      if (node && read.kind === "usable" && effectiveOrder(read.data).includes(node.id))
        return await this.bookPipelineRuns.refindSlot(file.path, node.id, url, { signal });
    }
    throw new BookPipelineRunError("missing");
  }
  /** The note backup service: works with no map tab open (the runner, the notes apply and the map view all use it). */
  backupBookNote(path: string, content: string): Promise<{ ok: true; path: string } | { ok: false }> {
    return backupNoteFile(this.app.vault, {
      styleFolder: this.noteStyles.folder(),
      language: this.settings.language,
      path,
      content
    });
  }
  /** Every markdown tab as the notes controller sees it. */
  private bookNoteLeaves(): NotesLeaf[] {
    const out: NotesLeaf[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      out.push({
        key: view,
        path: () => view.file?.path,
        text: () => shownText(view),
        addAction: (label, run) => {
          const el = view.addAction("pencil", label, run);
          el.addClass("vam-book-apply-notes");
          const span = el.createSpan({ cls: "vam-book-apply-label", text: label });
          return {
            setLabel: next => {
              el.setAttr("aria-label", next);
              span.setText(next);
            },
            setDisabled: reason => {
              el.toggleClass("is-disabled", !!reason);
              if (reason) el.setAttr("aria-disabled", "true");
              else el.removeAttribute("aria-disabled");
              el.setAttr("title", reason ?? "");
            },
            remove: () => el.remove()
          };
        }
      });
    }
    return out;
  }
  /** Of the notes shown, the ones that are chapters of a usable picture book. Maps are read only when a shown note says it is a map node. */
  private async bookChapterPaths(paths: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    const candidates = new Set(
      paths.filter(path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile && this.app.metadataCache.getFileCache(file)?.frontmatter?.["agent-map-node"];
      })
    );
    if (!candidates.size) return found;
    const maps = await this.repo.readableMaps();
    for (const { file, map } of maps) {
      const read = readBookPipeline(map);
      if (read.kind !== "usable") continue;
      for (const node of map.nodes)
        if (candidates.has(node.path) && effectiveOrder(read.data).includes(node.id)) {
          found.add(node.path);
          this.bookChapterMaps.set(node.path, file.path);
        }
    }
    // A closed, renamed or deleted map, or a chapter that left the book, no longer points anywhere.
    const live = new Set(maps.map(({ file }) => file.path));
    for (const [chapter, mapPath] of this.bookChapterMaps)
      if (!live.has(mapPath) || (candidates.has(chapter) && !found.has(chapter))) this.bookChapterMaps.delete(chapter);
    return found;
  }
  private bookPaintTimer: number | null = null;
  private paintBookNotesSoon(): void {
    if (this.bookPaintTimer !== null) return;
    this.bookPaintTimer = window.setTimeout(() => {
      this.bookPaintTimer = null;
      this.bookNotes.paint();
    }, 50);
  }
  private refreshBookNotesSoon(): void {
    if (this.bookNotesTimer !== null) window.clearTimeout(this.bookNotesTimer);
    this.bookNotesTimer = window.setTimeout(() => {
      this.bookNotesTimer = null;
      void this.bookNotes.refresh();
    }, 300);
  }
  /** The active markdown editor as the notes controller reads it (source and live preview; reading mode has no editor). */
  private bookNotesEditor(editor: Editor, file: TFile | null): NotesEditor {
    return {
      path: file?.path,
      text: () => editor.getValue(),
      selection: () => ({
        from: editor.posToOffset(editor.getCursor("from")),
        to: editor.posToOffset(editor.getCursor("to"))
      })
    };
  }
  /** The picture at the cursor of a chapter in an editor (the image line, its caption or its source line); undefined elsewhere. */
  private bookFigureAt(editor: Editor, path: string | undefined): { path: string; url: string } | undefined {
    if (!path || !this.bookNotes.isChapter(path)) return undefined;
    const url = figureUrlAt(editor.getValue(), editor.getCursor().line);
    return url ? { path, url } : undefined;
  }
  /** The editor menu item and the command of "find another picture" (no public API for a picture's menu in reading mode). */
  private registerBookRefind(): void {
    const refind = this.bookRefindSlot;
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        const at = this.bookFigureAt(editor, view.file?.path);
        if (!at) return;
        const running = refind.isRunning(at.path);
        menu.addItem(item =>
          item
            .setTitle(t(running ? "ui.book_refind_cancel" : "ui.book_refind_menu"))
            .setIcon("image")
            .onClick(() => refind.press(at.path, at.url))
        );
      })
    );
    this.localizedCommands.push({
      command: this.addCommand({
        id: "book-refind-image",
        name: t("ui.command_book_refind_image"),
        editorCheckCallback: (checking, editor, ctx) => {
          const at = this.bookFigureAt(editor, ctx.file?.path);
          if (!at) return false;
          if (!checking) refind.press(at.path, at.url);
          return true;
        }
      }),
      key: "ui.command_book_refind_image"
    });
  }
  private registerBookNotes(): void {
    const notes = this.bookNotes;
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, view) => {
        const plan = notes.menu(this.bookNotesEditor(editor, view.file));
        if (!plan) return;
        menu.addItem(item =>
          item
            .setTitle(plan.add.title)
            .setIcon("pencil")
            .setDisabled(plan.add.disabled)
            .onClick(() => notes.add(this.bookNotesEditor(editor, view.file)))
        );
        const apply = plan.apply;
        if (apply)
          menu.addItem(item =>
            item
              .setTitle(apply.title)
              .setIcon("pencil")
              .onClick(() => notes.apply(view.file?.path))
          );
      })
    );
    this.localizedCommands.push({
      command: this.addCommand({
        id: "book-note-add",
        name: t("ui.command_book_note_add"),
        editorCheckCallback: (checking, editor, ctx) => {
          if (!notes.isChapter(ctx.file?.path)) return false;
          if (!checking) notes.add(this.bookNotesEditor(editor, ctx.file));
          return true;
        }
      }),
      key: "ui.command_book_note_add"
    });
    this.localizedCommands.push({
      command: this.addCommand({
        id: "book-note-apply",
        name: t("ui.command_book_note_apply"),
        checkCallback: checking => {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          const path = view?.file?.path;
          const running = !!path && this.bookNotesApply.isRunning(path);
          if (!view || !notes.isChapter(path) || (!running && !countNotes(shownText(view)))) return false;
          if (!checking) notes.apply(path);
          return true;
        }
      }),
      key: "ui.command_book_note_apply"
    });
    this.localizedCommands.push({
      command: this.addCommand({
        id: "book-note-undo",
        name: t("ui.command_book_note_undo"),
        checkCallback: checking => {
          if (!this.bookNotesApply.canUndo()) return false;
          if (!checking) void this.bookNotesApply.undo();
          return true;
        }
      }),
      key: "ui.command_book_note_undo"
    });
    this.registerBookRefind();
    this.registerEditorExtension(appliedExtension);
    this.registerMarkdownPostProcessor((el, ctx) => {
      const info = ctx.getSectionInfo(el);
      if (
        info &&
        this.readingHighlight.marks.wears(ctx.sourcePath, sectionSource(info.text, info.lineStart, info.lineEnd))
      )
        el.addClass("vam-book-applied");
      // A reading view of a chapter shows new text (an apply or undo written to the file): the header action follows it now.
      if (this.bookChapterMaps.has(ctx.sourcePath)) this.paintBookNotesSoon();
    });
    this.registerEvent(this.app.workspace.on("file-open", () => this.bookHighlights.sync()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.bookHighlights.sync()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.bookHighlights.sync()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshBookNotesSoon()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshBookNotesSoon()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshBookNotesSoon()));
    this.registerEvent(this.app.workspace.on("editor-change", () => notes.paint()));
    this.registerEvent(
      this.app.vault.on("modify", file => {
        if (file instanceof TFile && this.isMap(file)) {
          this.refreshBookNotesSoon();
          void this.bookPipelineRuns.mapModified(file.path);
        } else notes.paint();
      })
    );
    this.app.workspace.onLayoutReady(() => this.refreshBookNotesSoon());
  }
  readonly bookPipelineRuns = new BookPipelineRuns({
    mutate: work => this.mutate(work),
    readMap: path => this.repo.readMap(path),
    updateMap: (path, change) => this.repo.updateMap(path, change),
    readCard: path => this.readBookCard(path),
    writePipelineFields: (path, patch) => this.repo.writePipelineFields(path, patch),
    writePipelineRole: (path, role) => this.repo.writePipelineRole(path, role),
    updateNoteGuarded: (path, patch, options) =>
      this.repo.updateNoteGuarded(path, patch, { ...options, rejectAiCard: true }),
    updateNoteRawGuarded: (path, transform, options) =>
      this.repo.updateNoteRawGuarded(path, transform, { ...options, rejectAiCard: true }),
    editBookStructure: (mapPath, work) =>
      createBookStructurePort({ repo: this.repo, rebuildDerivedData: () => this.rebuildDerivedData() })(mapPath, work),
    runPlan: (step, request, run) => runPlanStep(this.aiCalls, step, request, run),
    runProofread: (request, run) => runProofread(this.aiCalls, request, run),
    aiProof: (request, run) => runAiProof(this.aiCalls, request, run),
    aiFix: (request, run) => runAiFix(this.aiCalls, request, run),
    aiBookProof: (request, run) => runAiBookProof(this.aiCalls, request, run),
    findImages: (request, run) => runFindImages(this.aiCalls, request, run),
    lookAtImage: (request, run) => runImageFitCheck(this.aiCalls, request, run),
    // A candidate picture for the model to look at: https over Node (no silent redirect, no private address), 8 MB cap while streaming, PNG/JPEG/GIF/WebP, 15 s, shrunk to the model's image input. Held in memory only, never written to the vault.
    fetchPicture: async (url, model, signal) => {
      const picture = await downloadPicture(url, pictureFetch, { signal });
      if (!picture.ok) return undefined;
      try {
        return await fitImageForInput(
          `data:${picture.mime};base64,${arrayBufferToBase64(picture.bytes.buffer as ArrayBuffer)}`,
          this.aiCalls.capabilitiesFor(model).imageInput,
          signal
        );
      } catch {
        return undefined;
      }
    },
    drawDiagrams: (request, run) => runDrawDiagrams(this.aiCalls, request, run),
    diagramsOn: () => this.settings.addDiagramsAfterResearch,
    mermaidSyntax: (code: string) => this.mermaidSyntax(code),
    // requestUrl has no abort: searchCommons races its own timeout. Only the Commons API is asked (the address is built by the program).
    fetchCommons: async url => {
      if (!url.startsWith(`${COMMONS_API}?`)) throw new Error("refused");
      // Wikimedia asks API clients to name themselves; only the plugin name and version (no user data).
      const response = await requestUrl({
        url,
        method: "GET",
        headers: { "Api-User-Agent": `VisualAgentMap-Obsidian-plugin/${this.manifest.version}` },
        throw: false
      });
      return { status: response.status, text: response.text, headers: response.headers };
    },
    // The cover picture: only upload.wikimedia.org (downloadCover refuses every other address before any request). requestUrl cannot
    // be aborted, so downloadCover drops an answer that arrives late. Wikimedia's policy asks for the client name, version and a contact
    // address; the plugin's public repository page is that address (no user data is sent).
    fetchCoverImage: (url, signal) =>
      downloadCover(
        url,
        async (address, init) => {
          const response = await requestUrl({
            url: address,
            method: init.method ?? "GET",
            headers: init.headers,
            throw: false
          });
          return {
            status: response.status,
            headers: response.headers,
            bytes: init.method ? new ArrayBuffer(0) : response.arrayBuffer
          };
        },
        { signal, userAgent: `VisualAgentMap-Obsidian-plugin/${this.manifest.version} (${PUBLIC_REPO_URL})` }
      ),
    setCoverLink: (content, link) => withCover(content, link),
    saveCover: (folder, title, sourceUrl, download, signal) =>
      saveCover(
        {
          exists: path => this.app.vault.adapter.exists(normalizePath(path)),
          createBinary: (path, data) => this.app.vault.createBinary(normalizePath(path), data),
          ensureFolder: async path => {
            let current = "";
            for (const part of normalizePath(path).split("/")) {
              current = current ? `${current}/${part}` : part;
              if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
            }
          }
        },
        folder,
        title,
        sourceUrl,
        download,
        signal
      ),
    author: async input => {
      const view = this.views().find(item => item.mapPath === input.mapPath);
      if (view) return view.runBookAuthor(input);
      // No view of this map (it was switched away or closed): not a failure; the run ends for this map.
      void this.bookPipelineRuns.stop(input.mapPath).catch(() => undefined);
      return { outcome: "cancelled" };
    },
    probeImage: async (url, signal) => {
      const view = this.views()[0];
      return view ? view.probeBookImage(url, signal) : { ok: false, reason: "no_view" };
    },
    backupNote: (path, raw) => this.backupBookNote(path, raw),
    writeOpenIssues: (folder, language, content, existingOnly) =>
      writeOpenIssuesFile(
        {
          read: async path => {
            const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
            return file instanceof TFile ? this.app.vault.read(file) : undefined;
          },
          create: async (path, text) => {
            await this.app.vault.create(normalizePath(path), text);
          },
          modify: async (path, text) => {
            const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
            if (!(file instanceof TFile)) throw new Error(path);
            await this.app.vault.modify(file, text);
          }
        },
        folder,
        language,
        content,
        existingOnly
      ),
    lockedSkipped: titles => void new Notice(lockedSkippedNotice(titles)),
    notes: {
      readText: async path => {
        const open = this.openMarkdownViews(path)[0];
        if (open) return open.text();
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error("missing");
        return this.app.vault.read(file);
      },
      write: (path, transform) => this.bookNoteWriter(path, transform)
    },
    blocked: path => this.views().some(view => view.mapPath === path && view.bookPipelineBlocked()),
    config: () => ({
      planModel: this.settings.bookPlanModel,
      authorModel: this.settings.bookWriteModel,
      imageModel: this.settings.bookImageModel,
      proofModel: this.settings.bookProofModel,
      reasoning: this.currentModelChoice().reasoning,
      language: selectionOutputLanguage(this.settings.language, "")
    }),
    modelLabel: model => this.modelLabel(model),
    now: () => new Date().toISOString(),
    newId: () => crypto.randomUUID(),
    log: line => this.logs.appendLog("info", line),
    progressed: mapPath => {
      this.views()
        .find(view => view.mapPath === mapPath)
        ?.refreshBookProgress();
      this.bookNotes.paint();
    },
    callouts: {
      reconcile: path => this.bookCallouts.reconcile(path),
      clear: path => this.bookCallouts.clear(path),
      clearNotes: (path, runId, cards) => this.bookCallouts.clearNotes(path, runId, cards)
    },
    // A drive is over: a rewrite the reader queued behind it may run now.
    settled: mapPath => void this.bookHandEdits.drain(mapPath)
  });
  /** A card note as the picture-book runner reads it (fields, text and the raw file); the chat's chief editor reads cards the same way. */
  async readBookCardForChat(path: string): Promise<PipelineCard> {
    return this.readBookCard(path);
  }
  /** A card note as the picture-book runner reads it (fields, text and the raw file). */
  private async readBookCard(path: string): Promise<PipelineCard> {
    const note = await this.repo.readNote(path);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error("missing");
    const raw = await this.app.vault.read(file);
    return {
      path,
      title: note.title,
      summary: note.summary,
      prompt: note.prompt,
      detail: note.detail,
      raw,
      // The write fence's own read (the file's bytes): the runner calls no AI for a locked note.
      ...(readAiLocked(frontmatter(raw)) ? { aiLocked: true } : {}),
      settings: note.bookSettings ?? {},
      fields: {
        ...(note.pipelineStage ? { pipelineStage: note.pipelineStage } : {}),
        ...(note.bookRole ? { bookRole: note.bookRole } : {}),
        ...(note.pipelineRole ? { pipelineRole: note.pipelineRole } : {}),
        ...(note.bookRoleBy ? { bookRoleBy: note.bookRoleBy } : {}),
        ...(note.pipelineIssue ? { pipelineIssue: note.pipelineIssue } : {}),
        ...(note.pipelineSeam ? { pipelineSeam: note.pipelineSeam } : {})
      }
    };
  }
  /** Every markdown view that has this note open (any mode), as the write coordinator edits it. */
  private openMarkdownViews(path: string): OpenNoteView[] {
    const views: MarkdownView[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType("markdown"))
      if (leaf.view instanceof MarkdownView) views.push(leaf.view);
    return editorViewsOf(path, views);
  }
  /** Suggestions awaiting a decision; onload replaces it with the persisted store, {@link topicRuns} reads whichever is current. */
  pendingSuggestions: Map<string, Suggestion[]> = new Map();
  readonly pendingResearchOptions = new Map<string, TaskOptions>();
  readonly logs: LogManager = debugLog;
  readonly aiRuntime = new AiRuntimeService({
    codexPath: () => this.settings.codexPath,
    claudePath: () => this.settings.claudePath,
    clientVersion: () => this.manifest.version || "0.0.0",
    pluginDirectory: () => this.pluginDirectory(),
    readLocalFile: path => FileSystemAdapter.readLocalFile(path),
    onLog: (level, message) => this.logs.appendLog(level, message),
    checks: {
      refresh: id => this.refreshModelDiscovery(id),
      codexInstalled: () => this.codexDiagnostic().installed
    }
  });
  /** Syntax check against the runtime parser of Obsidian's `loadMermaid`; shared by AI task results and map chat note edits. */
  readonly mermaidSyntax = mermaidSyntaxCheck(loadMermaid);
  private readonly aiTaskOptions = {
    activeTasks: this.activeTasks,
    pluginDirectory: () => this.pluginDirectory(),
    language: () => this.settings.language,
    defaultReasoning: () => this.settings.cliReasoning,
    exchangeLoggingEnabled: () => this.settings.aiExchangeLoggingEnabled,
    exchanges: () => this.exchanges,
    usage: () => this.usage,
    diagramsEnabled: () => this.settings.addDiagramsAfterResearch,
    codexRuntime: (directory: string, local: boolean) => this.runtime(directory, local),
    claudeRuntime: (directory: string) => this.claudeCli(directory),
    mermaidSyntax: this.mermaidSyntax,
    // Full-text requests: core/full-text.ts only asks for raw GitHub file addresses and caps size and time itself.
    fetchPage: async (request: { url: string; method: "GET"; throw: false; headers: Record<string, string> }) => {
      const response = await requestUrl(request);
      return {
        status: response.status,
        headers: response.headers,
        text: response.text,
        arrayBuffer: response.arrayBuffer
      };
    },
    // YouTube oEmbed: only the video address goes to youtube.com. 401/403/404 = private, embedding off or deleted; anything else cannot be told.
    videoPlayable: async (id: string, signal?: AbortSignal): Promise<boolean | null> => {
      if (signal?.aborted) return null;
      try {
        const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`;
        const response = await Promise.race([
          requestUrl({ url, method: "GET", throw: false }),
          new Promise<null>(resolve => window.setTimeout(() => resolve(null), 5000))
        ]);
        if (!response) return null;
        if (response.status === 401 || response.status === 403 || response.status === 404) return false;
        return response.status === 200 ? true : null;
      } catch {
        return null;
      }
    },
    mermaidParses: async (code: string): Promise<boolean> => {
      // The same mermaid Obsidian renders with; a missing or failing parser refuses the diagram rather than trusting it.
      try {
        const mermaid = (await loadMermaid()) as { parse: (text: string) => Promise<unknown> };
        await mermaid.parse(code);
        return true;
      } catch {
        return false;
      }
    }
  };
  readonly aiTasks = new AiTaskService(this.aiTaskOptions);
  readonly outlineGeneration = new OutlineGenerationService(providerOutlineRunner(this.aiCalls));
  readonly structureReview = new StructureReviewService(providerStructureReviewRunner(this.aiCalls));
  readonly mapChat = new MapChatService(providerMapChatRunner(this.aiCalls));
  /** Translated share text kept for this Obsidian session only (never written to disk); emptied on unload. */
  readonly shareTranslationCache = new ShareTranslationCache();
  readonly shareTranslate = new ShareTranslateService(providerShareTranslateRunner(this.aiCalls));
  exchanges: AiExchangeLog | null = null;
  /** Token usage of every provider call (`ai-usage.json`); null until onload has the plugin folder. Views query and subscribe to it. */
  usage: AiUsageStore | null = null;
  private readonly currentModelListeners = new Set<(model: string) => void>();
  readonly modelDiscovery = new ModelDiscovery(
    () => this.codexDiagnostic().installed,
    () => this.loadCodexModels(),
    () => this.claudeDiagnostic().installed
  );
  private outlineSourceView: VisualAgentMapView | null = null;
  private settingTab!: VisualAgentMapSettingTab;
  private readonly nodeDetailsSidebar = new NodeDetailsSidebar(
    () => this.app,
    leaf => this.styleNodeLeaf(leaf)
  );
  private ribbonIcon: HTMLElement | null = null;
  private localizedCommands: { command: Command; key: TranslationKey }[] = [];
  private queue: Promise<void> = Promise.resolve();
  private writing = 0;
  /** Rename events waiting for the batch queued by the first of them; null once that batch has started (ticket 10). */
  private pendingRenames: PendingRename[] | null = null;
  /** Numbers the vault events collected while VAM writes (see collectUnsynced); only ever grows. */
  private syncSeq = 0;
  private externalReconcileTimer: number | null = null;
  private readonly externalReconcilePaths = new Set<string>();
  private workspaceRecoveryCandidates: string[] = [];
  /** The blank map made on first install; finishStartup opens it. Null on every other start. */
  private firstInstallMapPath: string | null = null;
  languageSwitchPending = false;
  /** The floating "Use AI on selection" button; its text follows the interface language. */
  private markdownSelectionAi: MarkdownSelectionAi | null = null;
  recordFailure(context: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    this.logs.appendLog("error", `${context}：${message}`);
    // The notice gets plain words; the raw text above stays in the log.
    return plainFailure(context, error);
  }
  /**
   * Runs a write after every earlier one. Afterwards each view re-reads its map and notes when a file it shows changed
   * while VAM was writing (collectUnsynced), unless the caller states the write only touches the viewport
   * (`sync: false`), which changes nothing another view could need to reload; what was collected then waits for the next
   * write. `sync: "full"` makes every view re-read its whole map.
   */
  async mutate(work: () => Promise<void>, options: { sync?: boolean | "full" } = {}): Promise<void> {
    const result = this.queue.then(async () => {
      if (this.unloaded) throw new Error(t("error.unloaded_write_not_performed"));
      this.writing++;
      try {
        await work();
        if (!this.unloaded && options.sync !== false) await this.readBackViews(options.sync === "full");
      } finally {
        this.writing--;
      }
    });
    this.queue = result.catch(error => {
      // Unload deliberately refuses queued work; do not show a notice from an obsolete plugin instance.
      if (this.unloaded) return;
      const message = error instanceof Error ? error.message : String(error);
      this.logs.appendLog("error", t("log.operation_failed_0", message));
      console.error("Visual Agent Map", error);
      // A picture-book refusal is shown by its caller in the owner's words; a second, raw notice would only repeat it.
      if (!(error instanceof BookPipelineRunError)) errorNotice(error);
    });
    return result;
  }
  /**
   * The end of a write: each view not held by a chat batch reads back what it collected. A file that changed while the
   * views were read is collected too; one more (empty) write is queued for it, never awaited here. A read that failed
   * stays collected for the next write and does not queue one, so a broken file cannot loop.
   */
  private async readBackViews(full: boolean): Promise<void> {
    const views = this.views();
    if (full) for (const view of views) view.unsynced.markFull(this.syncSeq);
    const start = this.syncSeq;
    for (const view of views) {
      if (this.unloaded) return;
      await view.synchronize({ seq: start });
    }
    if (!this.unloaded && this.syncSeq !== start) this.runMutation(async () => {});
  }
  /**
   * A setting that a note read resolves (the current model and reasoning level) changed, with no file written: the next
   * write reads every open map back, as every write did before reads were limited to changed files. It takes a new event
   * number, so a read-back already running (its snapshot taken before the change) cannot consume the mark.
   */
  rereadAllViews(): void {
    const seq = ++this.syncSeq;
    for (const view of this.views()) view.unsynced.markFull(seq);
  }
  /** A vault event while VAM writes: every open view collects the paths (a rename gives both) under one new number. */
  private collectUnsynced(...paths: string[]): void {
    if (!this.writing) return;
    const seq = ++this.syncSeq;
    for (const view of this.views()) for (const path of paths) view.unsynced.add(path, seq);
  }
  /** Fire-and-forget mutation for event and command handlers; mutate() has already logged any failure. */
  runMutation(work: () => Promise<void>): void {
    this.mutate(work).catch(() => {
      /* Logged by mutate(). */
    });
  }
  /** The "rerun this chapter" button in a chapter note: the open map view of that book does the rerun; none open, the reader is told to open it. */
  rerunBookChapterFromNote(notePath: string): void {
    let why: string | undefined;
    for (const view of this.views()) {
      const result = view.rerunBookChapterFromNote(notePath);
      if (result === null) continue;
      if (result === "") {
        void this.app.workspace.revealLeaf(view.leaf);
        return;
      }
      why ??= result;
    }
    new Notice(why ?? t("ui.book_note_attention_open_map"));
  }
  views(): VisualAgentMapView[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE)
      .map(leaf => leaf.view)
      .filter((view): view is VisualAgentMapView => view instanceof VisualAgentMapView);
  }
  /** A map view passes itself as `source`; only the outline's source view may update it, so background tabs never win. */
  syncOutline(map: MapDocument | null, notes: Map<string, Note>, source?: VisualAgentMapView): void {
    if (source) {
      if (this.outlineSourceView && this.outlineSourceView !== source) return;
      this.outlineSourceView = source;
    }
    const titles = new Map([...notes].map(([id, note]) => [id, note.title]));
    const markers = new Map<string, TopicMarker[]>();
    for (const [id, note] of notes) if (note.markers?.length) markers.set(id, note.markers);
    const links = new Map<string, string[]>();
    for (const [id, note] of notes) if (note.links?.length) links.set(id, note.links);
    const bodies = new Map<string, string>();
    for (const [id, note] of notes) if (note.summary || note.detail) bodies.set(id, `${note.summary}\n${note.detail}`);
    for (const leaf of this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE))
      if (leaf.view instanceof OutlineView) leaf.view.setMap(map, titles, markers, links, bodies);
  }
  /** Marks the active outline row without rebuilding the outline. */
  setOutlineActive(path: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE))
      if (leaf.view instanceof OutlineView) leaf.view.setActive(path);
  }
  /** Called when a map view closes: the outline falls back to another open map, or empties. */
  releaseOutline(view: VisualAgentMapView): void {
    if (this.outlineSourceView !== view) return;
    this.outlineSourceView = null;
    const views = this.views().filter(other => other !== view);
    const next = views.find(other => other === this.app.workspace.getActiveViewOfType(VisualAgentMapView)) ?? views[0];
    if (next) this.useOutlineSource(next);
    else this.syncOutline(null, new Map());
  }
  private useOutlineSource(view: VisualAgentMapView): void {
    this.outlineSourceView = view;
    view.syncOutline();
  }
  /** Opens the share dialog for a map view (the active one by default), or says why this map cannot be shared. */
  private sharePreparing = false;
  async openShare(source?: VisualAgentMapView): Promise<void> {
    if (this.sharePreparing) return;
    const view = source ?? this.app.workspace.getActiveViewOfType(VisualAgentMapView) ?? this.views()[0];
    // Covers load first so the ring heights are the real ones; the snapshot is taken after, never before.
    this.sharePreparing = true;
    try {
      await view?.prepareShare();
    } finally {
      this.sharePreparing = false;
    }
    const snapshot = view?.shareSnapshot();
    if (!snapshot || snapshot === "none") return void new Notice(t("share.unavailable_no_map"));
    if (snapshot === "empty") return void new Notice(t("share.unavailable_empty"));
    new ShareModal(this.app, {
      source: snapshot,
      vamVersion: this.manifest.version || "0.0.0",
      language: this.settings.language,
      internalFolders: [this.settings.workspaceFolder, this.settings.mindMapsFolder, this.noteStyles.folder()],
      translation: {
        service: this.shareTranslate,
        cache: this.shareTranslationCache,
        dom: obsidianTranslateDom(),
        models: () => this.availableModels(),
        modelLabel: model => this.modelLabel(model),
        defaultModel: () => this.currentModelChoice().model,
        reasoning: () => this.currentModelChoice().reasoning,
        confirmAiUsage: (model, run) => this.confirmAiUsage(model, run)
      }
    }).open();
  }
  async activateOutline(source?: VisualAgentMapView): Promise<void> {
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE)[0] ?? null;
    if (!leaf) leaf = this.app.workspace.getLeftLeaf(true);
    if (!leaf) throw new Error(t("ui.could_not_open_the_left_sidebar"));
    await leaf.setViewState({ type: OUTLINE_VIEW_TYPE, active: true });
    const mapView =
      source ?? this.app.workspace.getActiveViewOfType(VisualAgentMapView) ?? this.outlineSourceView ?? this.views()[0];
    if (mapView) this.useOutlineSource(mapView);
    await this.app.workspace.revealLeaf(leaf);
  }
  onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
    this.styleNodeLeaf(leaf);
    if (leaf?.view instanceof OutlineView) return;
    if (leaf?.view instanceof VisualAgentMapView) {
      this.useOutlineSource(leaf.view);
      return;
    }
    if (!(leaf?.view instanceof MarkdownView) || !leaf.view.file || !this.isMap(leaf.view.file)) return;
    const path = leaf.view.file.path;
    void leaf
      .setViewState({ type: VIEW_TYPE, state: { file: path }, active: true })
      .catch(error => new Notice(error instanceof Error ? error.message : String(error)));
  }
  async onload(): Promise<void> {
    const saved = (await this.loadData()) as Partial<Settings> | null;
    this.settings = settingsFromSaved(saved, obsidianAppLanguage());
    // The removed chat-model key is migrated into cliModel above; write the data back at once so it runs only once.
    if (hasLegacyChatModel(saved)) await this.saveSettings();
    setUiLanguage(this.settings.language);
    registerInternalMarkerPresentation(this);
    // Facebook and Instagram videos in notes and card previews play in a card (Obsidian itself embeds only YouTube).
    this.registerMarkdownPostProcessor(element => {
      upgradeSocialVideoLinks(element, {
        play: site => t("share.viewer_video_play_site").replace("{0}", site),
        note: site => t("share.viewer_video_note_site").replace("{0}", site),
        open: site => t("share.viewer_video_open_site").replace("{0}", site)
      });
    });
    for (const kind of TOPIC_KINDS) addIcon(kindIconId(kind), kindIconSvg(kind));
    this.mermaidZoom = registerMermaidZoom(this);
    registerBookFigures(this);
    registerBookPlanView(
      this,
      () => this.settings.language,
      notePath => this.rerunBookChapterFromNote(notePath)
    );
    const markdownSelectionAi = (this.markdownSelectionAi = new MarkdownSelectionAi(this.app, {
      model: () => this.currentModelChoice().model,
      imageNeedsCodex: () => this.runtimeIdFor(this.currentModelChoice().model) === "claude",
      modelLabel: model => this.modelLabel(model),
      autoOpen: () => this.settings.markdownSelectionAiAutoOpen,
      language: selected =>
        languagePromptName(selectionOutputLanguage(this.settings.language, selected), "en", "plain", {
          kind: "selection",
          text: selected
        }),
      translateTarget: () => languagePromptName(this.settings.language, "en", "plain"),
      run: (prepared, model, signal, image, webSearch, generateImage) =>
        this.runConfirmedMarkdownContextAi(prepared, model, signal, image, webSearch, generateImage),
      isManagedNote: notePath => this.repo.isArgumentManagedNote(notePath),
      saveImage: (dataUrl, notePath, name) => this.saveGeneratedImage(dataUrl, notePath, name),
      processNote: (file, edit) => this.repo.app.vault.process(file, edit)
    }));
    this.addChild(markdownSelectionAi);
    // Tag reading-view blocks with their source lines so an action on a rendered image finds its embed.
    this.registerMarkdownPostProcessor(element => markPictureParagraphs(element));
    this.registerMarkdownPostProcessor((element, context) => {
      const section = context.getSectionInfo(element);
      if (!section || !element.querySelector("img, .internal-embed")) return;
      element.dataset.vamLineStart = String(section.lineStart);
      element.dataset.vamLineEnd = String(section.lineEnd);
    });
    this.localizedCommands.push({
      command: this.addCommand({
        id: "markdown-selection-ai",
        name: t("ui.command_selection_ai"),
        checkCallback: checking => markdownSelectionAi.openForSelection(checking)
      }),
      key: "ui.command_selection_ai"
    });
    this.addLocalizedCommand("book-pipeline", "ui.command_book_pipeline", () => {
      const view = this.app.workspace.getActiveViewOfType(VisualAgentMapView) ?? this.views()[0];
      if (view) void view.startBookPipelineFromUi();
      else new Notice(t("ui.book_no_map"));
    });
    this.addLocalizedCommand("preview-full-prompt", "ui.command_preview_prompt", () => this.openPromptPreview());
    this.logs.appendLog("info", t("log.plugin_loaded_0", this.manifest.version || "unknown"));
    if (this.app.vault.adapter instanceof FileSystemAdapter && this.manifest.dir) {
      const adapter = this.app.vault.adapter;
      this.exchanges = new AiExchangeLog(adapter, normalizePath(`${this.manifest.dir}/ai-exchanges.json`), error =>
        this.logs.appendLog(
          "error",
          t("log.exchange_log_save_failed_0", error instanceof Error ? error.message : String(error))
        )
      );
      await this.exchanges.load();
      this.usage = new AiUsageStore(adapter, normalizePath(`${this.manifest.dir}/ai-usage.json`), error =>
        this.logs.appendLog("error", `ai-usage.json: ${error instanceof Error ? error.message : String(error)}`)
      );
      await this.usage.load();
      this.pendingSuggestions = new PendingSuggestions(
        adapter,
        normalizePath(`${this.manifest.dir}/pending-suggestions.json`),
        error =>
          this.logs.appendLog(
            "error",
            t("log.pending_suggestions_save_failed_0", error instanceof Error ? error.message : String(error))
          )
      );
      await (this.pendingSuggestions as PendingSuggestions).load();
    }
    const recovery =
      this.app.vault.adapter instanceof FileSystemAdapter && this.manifest.dir
        ? new VaultWriteRecovery(this.app.vault.adapter, normalizePath(`${this.manifest.dir}/write-recovery`), path =>
            this.logs.appendLog("warn", t("log.recovery_snapshot_retained_0", path))
          )
        : undefined;
    if (recovery) {
      try {
        const { notify, fingerprint } = await recovery.unreported(this.settings.reportedRecoveryFiles);
        if (notify) {
          this.logs.appendLog("warn", t("ui.recovery_snapshots_found_0", recovery.folder));
          new Notice(t("ui.recovery_snapshots_found_0", recovery.folder));
        }
        if (fingerprint !== this.settings.reportedRecoveryFiles) {
          if (fingerprint === undefined) delete this.settings.reportedRecoveryFiles;
          else this.settings.reportedRecoveryFiles = fingerprint;
          await this.saveSettings();
        }
      } catch {
        this.logs.appendLog("warn", t("log.recovery_scan_failed"));
      }
    }
    this.repo = new Repository(this.app, this.settings, recovery);
    this.repo.onUnreadableMaps = failures => this.reportUnreadableMaps(failures);
    // Takes back card notes whose Map.md write a crash cut off, before any rebuildDerivedData strips their map id and
    // before a chat batch stages cards (the view awaits `orphansAdopted` first). `ready` does not wait for the layout:
    // Obsidian sets layoutReady only after every visible VAM tab opened, and a tab's onOpen awaits `ready`. So a vault
    // already migrated adopts on layout ready, when Obsidian has finished scanning the vault folder (a note added while VAM
    // was closed is not in the file list before that). An unmigrated vault adopts at once, ahead of its migrate and rebuild,
    // inside `ready`. A failure is logged by mutate, not fatal; views open meanwhile re-read the map through mutate.
    const adopt = (): Promise<void> =>
      this.mutate(async () => {
        const adopted = await this.repo.adoptOrphanNodeNotes({
          skipped: path => this.logs.appendLog("warn", t("log.orphan_note_skipped_duplicate_id_0", path)),
          failed: (mapPath, error) =>
            this.logs.appendLog("warn", `${mapPath}: ${error instanceof Error ? error.message : String(error)}`)
        });
        if (adopted) this.logs.appendLog("warn", t("log.adopted_orphan_notes_0", String(adopted)));
      }).catch(() => undefined);
    // An unmigrated vault adopts once inside `ready` (ahead of its migrate rebuild) and again after the layout, which
    // catches notes Obsidian had not scanned yet; adoption is idempotent. `orphansAdopted` is the last of these.
    const firstAdopt = this.settings.migrated ? Promise.resolve() : adopt();
    const layoutReady = new Promise<void>(resolve => this.app.workspace.onLayoutReady(resolve));
    this.orphansAdopted = firstAdopt.then(() => layoutReady).then(adopt);
    const initialize = (
      this.settings.migrated
        ? Promise.resolve()
        : firstAdopt
            .then(() => this.repo.migrate())
            .then(async () => {
              await this.repo.rebuildDerivedData();
              this.settings.migrated = true;
            })
    ).then(async () => {
      await this.initializeFirstInstall(!!saved);
      if (this.settings.structureVersion < 2) {
        // A failure here (a read-only folder, EACCES) must not reject `ready`: other maps keep opening, and structureVersion
        // stays below 2 so the next start tries again.
        try {
          const { renamed, failed } = await this.repo.normalizeGeneratedNoteFilenames();
          // A note that could not be renamed keeps the version below 2, so the next start tries it again.
          if (!failed) {
            this.settings.structureVersion = 2;
            await this.saveSettings();
          } else this.logs.appendLog("warn", `${t("ui.subtopic_filename_sync_failed_will_retry")} ${failed}`);
          if (renamed) new Notice(t("ui.synced_0_subtopic_filenames_with_their_names", renamed));
          if (failed) new Notice(t("ui.subtopic_filename_sync_failed_will_retry"));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.logs.appendLog("warn", `${t("ui.subtopic_filename_sync_failed_will_retry")} ${detail}`);
          new Notice(t("ui.subtopic_filename_sync_failed_will_retry"));
        }
      }
    });
    this.ready = initialize;
    this.registerView(VIEW_TYPE, leaf => new VisualAgentMapView(leaf, this));
    this.registerView(LIVING_READER_VIEW, leaf => new LivingReaderView(leaf));
    this.app.workspace.onLayoutReady(() => this.nodeDetailsSidebar.closeEmptyReaders());
    this.registerView(
      OUTLINE_VIEW_TYPE,
      leaf =>
        new OutlineView(
          leaf,
          path => this.revealFromOutline(path),
          // Drag and Alt+arrow in the outline move topics of the map it shows, through that view.
          async (id, to) => (await this.outlineSourceView?.outlineMove(id, to)) ?? null
        )
    );
    this.ribbonIcon = this.addRibbonIcon("brain-circuit", t("ui.open_map"), () => {
      void this.activateView().catch(error => new Notice(String(error)));
    });
    const mapRibbonIcon = this.ribbonIcon;
    this.app.workspace.onLayoutReady(() => this.register(groupRibbonIcons(mapRibbonIcon)));
    // Opens or closes the map's AI chat and leaves the keyboard in its message field. No default hotkey: the user picks one in
    // Obsidian's hotkey settings, so it can never collide with a built-in one.
    this.localizedCommands.push({
      command: this.addCommand({
        id: "toggle-map-chat",
        name: t("ui.map_chat_toggle_command"),
        checkCallback: checking => {
          const view = this.app.workspace.getActiveViewOfType(VisualAgentMapView);
          if (!view) return false;
          if (!checking) view.toggleMapChat();
          return true;
        }
      }),
      key: "ui.map_chat_toggle_command"
    });
    this.addLocalizedCommand("open-map", "ui.command_open_map", () => {
      void this.activateView().catch(error => new Notice(String(error)));
    });
    this.addLocalizedCommand("import-outline", "ui.command_import_outline", () => {
      void this.activateView()
        .then(() => this.views()[0]?.openOutlineImport())
        .catch(error => new Notice(String(error)));
    });
    this.addLocalizedCommand("import-outline-exchange", "ui.command_import_exchange", () => {
      void this.activateView()
        .then(() => {
          const view = this.views()[0];
          if (view) chooseAndImportExchange(view);
        })
        .catch(error => new Notice(String(error)));
    });
    this.localizedCommands.push({
      command: this.addCommand({
        id: "add-text-node",
        name: t("ui.command_add_text_node"),
        checkCallback: checking => {
          const view = this.app.workspace.getActiveViewOfType(VisualAgentMapView);
          // Selection mode still reaches addTextNodeUnder, which says why it adds nothing.
          if (!view || view.textAddLocked()) return false;
          if (!checking) view.addTextNodeUnder();
          return true;
        }
      }),
      key: "ui.command_add_text_node"
    });
    this.localizedCommands.push({
      command: this.addCommand({
        id: "add-summary-bracket",
        name: t("ui.command_add_summary_bracket"),
        checkCallback: checking => {
          const view = this.app.workspace.getActiveViewOfType(VisualAgentMapView);
          if (!view) return false;
          if (!checking) view.addSummaryOver();
          return true;
        }
      }),
      key: "ui.command_add_summary_bracket"
    });
    // Map actions with no default hotkey (the user binds one in Obsidian's hotkey settings); each applies only while a
    // map view is active, and the topic ones only with a selected card.
    // The palette commands come from the card action list (their ids stay, so the user's hotkeys keep working).
    for (const { commandId, mapAction, action } of CARD_COMMANDS) {
      const key = commandTitleKey(action);
      this.localizedCommands.push({
        command: this.addCommand({
          id: commandId,
          name: t(key),
          checkCallback: checking =>
            this.app.workspace.getActiveViewOfType(VisualAgentMapView)?.mapCommand(mapAction, checking) ?? false
        }),
        key
      });
    }
    this.addLocalizedCommand("share-map", "ui.command_share_map", () => void this.openShare());
    this.addLocalizedCommand("open-topic-outline", "ui.command_open_topic_outline", () => {
      void this.activateOutline().catch(error => new Notice(String(error)));
    });
    this.addLocalizedCommand("rebuild-references", "ui.command_refresh_data", () => {
      this.runMutation(() => this.fullRebuild());
    });
    this.addLocalizedCommand("normalize-note-filenames", "ui.command_sync_filenames", () => {
      this.runMutation(async () => {
        const { renamed, failed } = await this.repo.normalizeGeneratedNoteFilenames();
        new Notice(
          failed
            ? t("ui.synced_0_topic_filenames_failed_1", renamed, failed)
            : renamed
              ? t("ui.synced_0_topic_filenames", renamed)
              : t("ui.topic_filenames_are_up_to_date")
        );
      });
    });
    this.addLocalizedCommand("repair-note-presentation", "ui.command_repair_note_display", () => {
      this.runMutation(async () => {
        await this.repo.ensureNodePresentation();
        new Notice(t("ui.topic_note_display_repaired"));
      });
    });
    this.addLocalizedCommand("fix-math-formulas", "ui.command_fix_math", () => {
      void this.offerFixMathFormulas().catch(
        error => new Notice(error instanceof Error ? error.message : String(error))
      );
    });
    this.addLocalizedCommand("organize-workspace-folders", "ui.command_organize_folders", () => {
      void this.offerOrganizeWorkspaceFolders().catch(
        error => new Notice(error instanceof Error ? error.message : String(error))
      );
    });
    this.addLocalizedCommand("repair-workspace", "ui.command_repair_workspace", () => {
      this.runMutation(() => this.repairWorkspace());
    });
    this.addLocalizedCommand("reconnect-workspace", "ui.command_reconnect_workspace", () => {
      void this.offerWorkspaceReconnect();
    });
    this.addLocalizedCommand("open-prompt-monitor", "ui.command_prompt_monitor", () =>
      new DebugLogModal(
        this.app,
        this.logs,
        this.exchanges,
        () => this.settings.aiExchangeLoggingEnabled,
        async enabled => {
          this.settings.aiExchangeLoggingEnabled = enabled;
          await this.saveSettings();
        }
      ).open()
    );
    this.addLocalizedCommand("open-debug-log", "ui.command_debug_log", () =>
      new DebugLogModal(this.app, this.logs, this.exchanges, () => this.settings.aiExchangeLoggingEnabled).open()
    );
    this.settingTab = new VisualAgentMapSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerNoteStyleEntrypoints();
    this.registerBookNotes();
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && this.isMap(file))
          menu.addItem(item =>
            item
              .setTitle(t("ui.open_as_mind_map"))
              .setIcon("brain-circuit")
              .onClick(() => {
                void this.activateView(file.path);
              })
          );
      })
    );
    this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => this.onActiveLeafChange(leaf)));
    this.registerEvent(
      this.app.workspace.on("file-open", file => {
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) this.styleNodeLeaf(leaf);
        for (const leaf of this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE))
          if (leaf.view instanceof OutlineView) leaf.view.setActive(file?.path ?? "");
      })
    );
    this.app.workspace.onLayoutReady(() => {
      void this.finishStartup();
    });
    // Its own callback, not part of finishStartup: the conversion writes files and must stay apart from the start-up
    // checks that call finishStartup on a bare plugin.
    this.app.workspace.onLayoutReady(() => {
      void this.migrateNoteStyles().then(() => this.refreshNoteStyles());
    });
    this.registerVaultEvents();
    this.registerLivingIdentity();
    this.registerAppExitStop();
  }
  /**
   * Keeps the identity state of the notes AI cards reference. Vault events are reduced into it as they happen and it is
   * saved with the settings; after a restart it is checked once against the files that are there. Events before the
   * layout is ready (Obsidian's initial create events) are not changes and are ignored.
   */
  private registerLivingIdentity(): void {
    let saving = false;
    const store = new LivingIdentityStore(this.settings.livingSourceIdentity, () => {
      if (saving) return;
      saving = true;
      void Promise.resolve().then(async () => {
        saving = false;
        this.settings.livingSourceIdentity = store.entries();
        try {
          await this.saveSettings();
        } catch (error) {
          this.logs.appendLog("warn", `living_identity_save_failed ${String(error)}`);
        }
      });
    });
    setLivingIdentityStore(this.app, store);
    this.register(() => setLivingIdentityStore(this.app, undefined));
    let ready = false;
    const statOf = (path: string) => {
      const file = this.app.vault.getAbstractFileByPath(path);
      return file instanceof TFile ? { ctime: file.stat.ctime, size: file.stat.size } : undefined;
    };
    this.app.workspace.onLayoutReady(() => {
      store.revalidate(statOf);
      ready = true;
    });
    this.registerEvent(
      this.app.vault.on("create", file => {
        const stat = ready && file instanceof TFile ? statOf(file.path) : undefined;
        if (stat) store.created(file.path, stat);
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", file => {
        const stat = ready && file instanceof TFile ? statOf(file.path) : undefined;
        if (stat) store.modified(file.path, stat);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", file => {
        if (ready && file instanceof TFile) store.deleted(file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (ready && file instanceof TFile) store.renamed(oldPath, file.path);
      })
    );
  }
  /** Quitting Obsidian does not call onunload: stop running AI calls here too, so no provider process outlives the app. */
  registerAppExitStop(): void {
    this.registerDomEvent(window, "beforeunload", () => {
      try {
        this.resetCodexRuntime();
      } finally {
        this.aiRuntime.terminateOwnedProcesses();
      }
    });
  }
  /** First install only (no saved settings, no workspace, nothing to reconnect): make one blank map to land on. */
  private async initializeFirstInstall(hasSaved: boolean): Promise<void> {
    if (hasSaved) return;
    if (this.repo.workspaceExists()) {
      this.settings.workspaceInitialized = true;
      await this.saveSettings();
      return;
    }
    this.workspaceRecoveryCandidates = await this.repo.workspaceCandidates();
    if (this.workspaceRecoveryCandidates.length) return;
    await this.repo.ensureWorkspace();
    this.settings.workspaceInitialized = true;
    try {
      this.firstInstallMapPath = await this.repo.createMap(t("ui.new_mind_map_from_sample"));
    } catch (error) {
      this.firstInstallMapPath = null;
      this.logs.appendLog(
        "warn",
        `First-install map was not created: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    await this.saveSettings();
  }
  /** Vault modify/delete/rename handlers; kept separate so tests can drive the real handlers on a fake vault. */
  /**
   * Work after Obsidian's layout is ready. The topic outline is deliberately not opened here: it opens only through
   * its command or the map toolbar, and an outline pane the user already has is restored by Obsidian itself.
   */
  async finishStartup(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) this.styleNodeLeaf(leaf);
    try {
      await this.ready;
      if (this.workspaceRecoveryCandidates.length) await this.offerWorkspaceReconnect(this.workspaceRecoveryCandidates);
      else if (this.firstInstallMapPath) await this.activateView(this.firstInstallMapPath);
    } catch (error) {
      this.logs.appendLog(
        "warn",
        t("log.initialization_incomplete_0", error instanceof Error ? error.message : String(error))
      );
      console.warn("Visual Agent Map initialization", error);
    }
  }
  /** Reads the style files into the store once at start (read only), so a `file:` style resolves on its first use. */
  private async refreshNoteStyles(): Promise<void> {
    try {
      await this.noteStyles.refresh();
    } catch (error) {
      this.logs.appendLog(
        "warn",
        `Note styles were not read at start: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  /**
   * Converts the 0.28.0 custom templates and tones once (the one write VAM makes on load), then says once which maps
   * carried a style that is no longer used. After the first load that has done both, nothing is scanned or written.
   * Never throws.
   */
  async migrateNoteStyles(): Promise<void> {
    try {
      await this.ready;
      const marker = this.settings.noteStyleRecipe;
      if (marker?.migrated && marker.mapsNotified) return;
      // Read only: maps with a style of their own, by title (the file name when the title is empty), in path order.
      const found = new Map<string, string>();
      for (const { file, map } of await this.repo.readableMaps()) {
        const styled = [map.detailTemplateId, map.toneId].some(id => typeof id === "string" && id !== "");
        if (styled) found.set(file.path, map.title.trim() || file.name.replace(/\.md$/i, ""));
      }
      const mapsWithStyle = [
        ...new Set([...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, name]) => name))
      ];
      const result = await this.noteStyles.migrateLegacy({ mapsWithStyle });
      if (result.status === "already" && result.error) {
        this.logs.appendLog("warn", `Note style maps record was not saved: ${result.error}`);
      } else if (result.status === "failed") {
        this.logs.appendLog("warn", `Note style conversion failed: ${result.error ?? "unknown error"}`);
        new Notice(t("ui.note_style_migrate_failed"));
      } else if (result.notify) {
        const maps = result.notify.maps.join(t("ui.list_separator"));
        const text = [
          t("ui.note_style_maps_notice_0", maps),
          result.notify.defaultName ? t("ui.note_style_maps_notice_default_0", result.notify.defaultName) : ""
        ]
          .filter(Boolean)
          .join(" ");
        new Notice(text, 0);
      }
    } catch (error) {
      this.logs.appendLog(
        "warn",
        `Note style conversion did not run: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  private dropKnowledgeIndex(file: unknown, oldPath?: string): void {
    if (file instanceof TFile)
      this.knowledgeIndex.changed(oldPath ? [file.path, oldPath] : [file.path], this.isMap(file));
  }
  registerVaultEvents(): void {
    // Only a map file or a card's note (a rename also reports the old path) can change which cards exist or are authorised: the next
    // message reads them again. Any other note leaves the index alone.
    this.registerEvent(this.app.vault.on("modify", file => this.dropKnowledgeIndex(file)));
    this.registerEvent(this.app.vault.on("create", file => this.dropKnowledgeIndex(file)));
    this.registerEvent(this.app.vault.on("delete", file => this.dropKnowledgeIndex(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.dropKnowledgeIndex(file, oldPath)));
    this.registerEvent(
      this.app.vault.on("modify", file => {
        if (file instanceof TFile) this.collectUnsynced(file.path);
        if (!this.writing && file instanceof TFile) for (const view of this.views()) view.changed(file);
        // Obsidian's stale-position link update of a note VAM just rewrote on rename is put right (RenameRepairWatch).
        if (file instanceof TFile && this.repo.renameWatch.watching(file.path))
          this.runMutation(() => this.repo.renameWatch.check(file.path, line => this.logs.appendLog("info", line)));
      })
    );
    this.registerEvent(
      this.app.vault.on("create", file => {
        if (file instanceof TFile) this.collectUnsynced(file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", file => {
        if (file instanceof TFile) this.collectUnsynced(file.path);
        if (file instanceof TFile) this.scheduleExternalReconciliation(file.path);
        if (!this.writing && file instanceof TFile) {
          for (const view of this.views()) view.deleted(file);
          if (
            file.path.startsWith(`${this.settings.mapsFolder}/`) ||
            (isManagedMapPath(this.settings, file.path) && file.name === "Map.md")
          )
            this.runMutation(() => this.repo.rebuildDerivedData());
        }
      })
    );
    // Renames are queued even while VAM is writing (handling is idempotent), so a user rename during a write is not lost.
    // A folder rename reports every file inside it: the first event queues a batch at once (where a single handler was
    // queued before), and every event that arrives before that batch starts joins it (perf ticket 10).
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) this.collectUnsynced(oldPath, file.path);
        if (!(file instanceof TFile) || !this.repo.renameAffectsVam(file, oldPath)) return;
        // A rename event whose path did not change (replayed after a rolled-back move) has nothing to update.
        if (file.path === oldPath) return;
        const external = !this.writing;
        // An open map follows its Map.md now, not when the batch runs: the batch ends by synchronizing every view, and
        // a view that read back first would find its old path gone and close the map as deleted.
        if (external) for (const view of this.views()) view.relocate(new Map([[oldPath, file.path]]));
        // During a write (VAM's own move, or one outside it), only the path follows: the read-back at the end of the
        // write must not find the old Map.md gone and close the map. Whoever moved it decides about the undo steps.
        else for (const view of this.views()) view.followPath(oldPath, file.path);
        const rename: PendingRename = { pair: [oldPath, file.path], file, external };
        if (this.pendingRenames) {
          this.pendingRenames.push(rename);
          return;
        }
        const batch = (this.pendingRenames = [rename]);
        this.runMutation(() => {
          // From here on a rename event opens the next batch.
          if (this.pendingRenames === batch) this.pendingRenames = null;
          return this.applyRenames(batch);
        });
      })
    );
  }
  /**
   * One batch of rename events, in event order: source paths are rewritten in one pass over the notes, every readable
   * map is rebased once, derived data is rebuilt at most once, and the open maps follow in memory; what they read back
   * is left to the scoped read-back at the end of this write (which waits while a chat batch holds a view).
   */
  private async applyRenames(renames: readonly PendingRename[]): Promise<void> {
    const pairs = renames.map(rename => rename.pair);
    let failed = false;
    try {
      // A note whose frontmatter cannot be written must not keep the maps from following the other moves: the rebase
      // and the rebuild still run, and the first error is thrown at the end.
      let sourceError: Error | undefined;
      try {
        await this.repo.replaceSourcePaths(pairs);
      } catch (replaceError) {
        sourceError = replaceError instanceof Error ? replaceError : new Error(String(replaceError));
      }
      const { changed, error, nodePaths, scope } = await this.rebaseMaps(pairs);
      // A map node whose title was its old file name follows the new one (a custom title, a folder move and other notes are left alone).
      // Only the owner's own renames (not VAM's collision numbering) are followed, and a batch is first collapsed to origin -> final
      // so a chain (A -> B -> C) or a swap through a temporary name reads each file against the name it started with.
      const origins = new Map<string, string>();
      for (const {
        pair: [from, to],
        external
      } of renames) {
        const origin = origins.get(from) ?? from;
        origins.delete(from);
        if (external) origins.set(to, origin);
      }
      for (const [to, from] of origins)
        await this.repo
          .followRenamedTitle(from, to, nodePaths, reason =>
            this.logs.appendLog("info", `title_follow_refused reason=${reason}`)
          )
          .catch(() => {
            this.logs.appendLog("info", "title_follow_refused reason=error");
            return false;
          });
      // Derived references depend only on maps and VAM notes; renaming an unrelated note leaves them unchanged.
      const vamFile = renames.some(({ file }) => {
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
        return [frontmatter?.["agent-map-node"], frontmatter?.["visual-agent-map"]].some(
          value => value === true || value === "true"
        );
      });
      // VAM's own moves (an undo or redo parking pasted copies, for one) rebuild only the maps they touch: notes of a map
      // nobody operated on stay as written (B27x). A move made outside VAM still rebuilds everything.
      const outsideMove = renames.some(rename => rename.external);
      if (changed || vamFile) await this.rebuildDerivedData(outsideMove ? undefined : scope);
      // Only one error can be thrown; the other is logged so it is not lost.
      if (sourceError && error) this.logs.appendLog("error", t("log.operation_failed_0", error.message));
      if (sourceError) throw sourceError;
      if (error) throw error;
    } catch (batchError) {
      failed = true;
      throw batchError;
    } finally {
      // A failed batch ends without the scoped read-back: queue an empty write so the views read back what is on disk.
      if (failed) this.runMutation(async () => {});
      // The open maps follow every move even when a step above failed, so the next save of a view writes the new paths.
      // Only a move made outside VAM clears the undo steps: VAM's own renames keep them.
      const outside = renames.some(rename => rename.external);
      const seq = ++this.syncSeq;
      for (const view of this.views()) {
        view.renamed(pairs, outside);
        for (const path of touchedPaths(pairs)) view.unsynced.add(path, seq);
      }
    }
  }
  /**
   * Rebases every readable map through the moves. A map whose save failed is read and rebased once more after the others
   * (its file was not written, so the moves still apply to it); a second failure is returned, after the other maps.
   */
  private async rebaseMaps(
    pairs: readonly RenamePair[]
  ): Promise<{ changed: boolean; error?: Error; nodePaths: Set<string>; scope: { roots: string[]; paths: string[] } }> {
    let changed = false;
    const failed: string[] = [];
    const nodePaths = new Set<string>();
    const rebase = chainRebase(pairs);
    // The maps a move touches: rebased, holding a moved note, or with a moved path in their folder; and the moved notes.
    const moved = touchedPaths(pairs);
    const scope = { roots: new Set<string>(), paths: new Set(pairs.map(([, to]) => to)) };
    const touch = (mapPath: string, map: MapDocument, rebased: boolean): void => {
      const root = this.repo.topicRoot(mapPath);
      if (!rebased && !moved.some(path => path.startsWith(`${root}/`) || map.nodes.some(node => node.path === path)))
        return;
      scope.roots.add(root);
      for (const node of map.nodes) scope.paths.add(node.path);
    };
    // The scan identifies affected maps; it is not a write snapshot. Apply only the path change to the
    // current Map.md inside vault.process, preserving concurrent structural and coordinate edits.
    const save = async (path: string): Promise<void> => {
      let rebased = false;
      const current = await this.repo.updateMap(path, map => {
        rebased = rebaseMapNotePaths(map, rebase);
      });
      changed ||= rebased;
      touch(path, current, true);
      for (const node of current.nodes) nodePaths.add(node.path);
    };
    for (const { file, map } of await this.repo.readableMaps()) {
      const rebased = rebaseMapNotePaths(map, rebase);
      if (!rebased) {
        touch(file.path, map, false);
        for (const node of map.nodes) nodePaths.add(node.path);
        continue;
      }
      try {
        await save(file.path);
      } catch {
        for (const node of map.nodes) nodePaths.add(node.path);
        failed.push(file.path);
      }
    }
    let error: Error | undefined;
    for (const path of failed) {
      try {
        const map = await this.repo.readMap(path);
        if (!rebaseMapNotePaths(map, rebase)) continue;
        await save(path);
      } catch (retryError) {
        error ??= retryError instanceof Error ? retryError : new Error(String(retryError));
      }
    }
    return { changed, error, nodePaths, scope: { roots: [...scope.roots], paths: [...scope.paths] } };
  }
  private readonly unreadableReported = new Map<string, number>();
  /** One Notice and log line per scan; the same map and error is not repeated within a few seconds (one rename = two scans). */
  private reportUnreadableMaps(failures: { path: string; error: string }[]): void {
    const now = Date.now();
    for (const { path, error } of failures) {
      const key = `${path}\n${error}`;
      if (now - (this.unreadableReported.get(key) ?? 0) < 5000) continue;
      this.unreadableReported.set(key, now);
      const message = t("ui.map_unreadable_skipped_0_1", path, error);
      this.logs.appendLog("warn", message);
      new Notice(message);
    }
  }
  /**
   * One persistent Notice that follows a multi-topic move: Obsidian may take a while per topic to update links (and asks
   * for each one when "Automatically update internal links" is off), so say what is being waited for.
   */
  private moveProgress(): { report: (done: number, total: number, title: string) => void; done: () => void } {
    let notice: Notice | null = null;
    return {
      report: (done, total, title) => {
        const message = t("ui.organize_progress_0_1_2", done, total, title);
        if (notice) notice.setMessage(message);
        else notice = new Notice(message, 0);
      },
      done: () => notice?.hide()
    };
  }
  /** Settings-page folder rename: moves the maps with it, keeps open views on their maps, then saves the setting. */
  async changeMapFolder(key: "mindMapsFolder" | "aimFolder", path: string): Promise<void> {
    const progress = this.moveProgress();
    let mapping: Map<string, string>;
    try {
      mapping = await this.repo.changeMapFolder(key, path, progress.report);
    } finally {
      progress.done();
    }
    for (const view of this.views()) view.relocate(mapping);
    this.app.workspace.requestSaveLayout();
    await this.saveSettings();
  }
  /** Owner-run only: previews the move of legacy Topics maps into Mind Maps / AIM and writes nothing until confirmed. */
  async offerOrganizeWorkspaceFolders(): Promise<void> {
    // Repair a topic stranded by an earlier interrupted move before planning (no-op, no writes, when nothing is lost).
    await this.mutate(async () => {
      await this.repo.reconcileMissingNodePaths();
    });
    const plan = await this.repo.planOrganizeWorkspaceFolders();
    if (!plan.moves.length) {
      let cleaned: string[] = [];
      await this.mutate(async () => {
        cleaned = await this.repo.removeEmptyLegacyFolders();
      });
      const base = plan.skipped.length
        ? t("ui.organize_only_skipped_0", plan.skipped.length)
        : t("ui.organize_nothing_to_do");
      new Notice(cleaned.length ? `${base} ${t("ui.organize_cleaned_0", cleaned.join(", "))}` : base);
      return;
    }
    const mind = plan.moves.filter(move => move.kind === "mind").length;
    let description = t("ui.organize_preview_hidden_0_1_2", mind, plan.skipped.length, this.settings.mindMapsFolder);
    if (plan.skipped.length)
      description += `\n${t("ui.organize_skipped_list_0", plan.skipped.map(item => item.mapPath).join(", "))}`;
    const toClean = await this.repo.emptyLegacyFolders(plan);
    if (toClean.length) description += `\n${t("ui.organize_will_remove_0", toClean.join(", "))}`;
    description += `\n${t("ui.organize_link_wait_hint")}`;
    new ChoiceModal(this.app, t("ui.organize_workspace_folders"), description, [
      {
        label: t("ui.organize_start"),
        action: () =>
          this.runMutation(async () => {
            const progress = this.moveProgress();
            let mapping: Map<string, string>;
            try {
              mapping = await this.repo.organizeWorkspaceFolders(plan, progress.report);
            } finally {
              progress.done();
            }
            for (const view of this.views()) view.relocate(mapping);
            this.app.workspace.requestSaveLayout();
            const cleaned = await this.repo.removeEmptyLegacyFolders();
            new Notice(
              cleaned.length
                ? `${t("ui.organize_done_0", mapping.size)} ${t("ui.organize_cleaned_0", cleaned.join(", "))}`
                : t("ui.organize_done_0", mapping.size)
            );
          })
      }
    ]).open();
  }
  /** Previews the notes whose math delimiters would change; nothing is written until the learner confirms. */
  async offerFixMathFormulas(): Promise<void> {
    const prefix = `${this.settings.workspaceFolder}/`;
    const files = (await this.repo.markedFiles("agent-map-node")).filter(file => file.path.startsWith(prefix));
    const plan = await planMathRepair(this.app.vault, files);
    if (!plan.items.length) {
      new Notice(t("ui.fix_math_none"));
      return;
    }
    new ChoiceModal(
      this.app,
      t("ui.fix_math_formulas"),
      t("ui.fix_math_preview_0_1", plan.items.length, plan.examples.join(", ")),
      [
        {
          label: t("ui.fix_math_start"),
          action: () =>
            void applyMathRepair(this.repo.app.vault, plan)
              .then(
                result =>
                  new Notice(
                    result.skipped
                      ? t("ui.fix_math_done_0_1", result.changed, result.skipped)
                      : t("ui.fix_math_done_0", result.changed)
                  )
              )
              .catch(error => new Notice(error instanceof Error ? error.message : String(error)))
        }
      ]
    ).open();
  }
  /** `anchor` is the button that asked; its window gets the notice (the settings page may be a popout window). */
  async repairWorkspace(anchor?: HTMLElement): Promise<void> {
    // A file where a folder belongs cannot be repaired here: say so instead of reporting the workspace ready.
    const blocked = this.repo.blockingFile(this.settings.mindMapsFolder);
    if (blocked) {
      noticeInWindowOf(t("ui.repair_workspace_blocked_0", blocked), anchor);
      return;
    }
    await this.repo.ensureWorkspace();
    this.settings.workspaceInitialized = true;
    await this.saveSettings();
    for (const view of this.views()) await view.refreshFromPlugin();
    noticeInWindowOf(t("ui.agent_workspace_is_ready"), anchor);
  }
  async fullRebuild(anchor?: HTMLElement): Promise<void> {
    // First re-find notes whose path changed behind the maps' back (e.g. a move interrupted by an unload); rebuilding
    // before that would read them as unowned and strip their map ids.
    await this.repo.reconcileMissingNodePaths();
    await this.repo.rebuildDerivedData();
    for (const view of this.views()) await view.refreshFromPlugin();
    noticeInWindowOf(t("ui.vam_data_has_been_refreshed"), anchor);
  }
  private connectWorkspace(root: string): void {
    this.settings.workspaceFolder = root;
    this.settings.topicsFolder = `${root}/Topics`;
    this.settings.mindMapsFolder = `${root}/Mind Maps`;
    this.settings.aimFolder = `${root}/AIM`;
    this.settings.notesFolder = `${root}/Nodes`;
    this.settings.mapsFolder = `${root}/Maps`;
    this.settings.workspaceInitialized = true;
  }
  async offerWorkspaceReconnect(known?: string[], anchor?: HTMLElement): Promise<void> {
    const candidates = known ?? (await this.repo.workspaceCandidates());
    this.workspaceRecoveryCandidates = [];
    if (!candidates.length) {
      noticeInWindowOf(t("ui.no_recognizable_existing_vam_workspace_was_found"), anchor);
      return;
    }
    const modal = new ChoiceModal(
      this.app,
      t("ui.reconnect_existing_workspace"),
      t("ui.choosing_a_workspace_only_reconnects_the_setting_it_does_not"),
      candidates.map(root => ({
        label: root,
        action: () =>
          this.mutate(async () => {
            this.connectWorkspace(root);
            await this.saveSettings();
            await this.repo.rebuildDerivedData();
            for (const view of this.views()) await view.refreshFromPlugin();
            noticeInWindowOf(t("ui.reconnected_workspace_0", root), anchor);
          })
      }))
    );
    openInWindowOf(modal, anchor);
  }
  codexDiagnostic(): { executable: string; installed: boolean } {
    return this.aiRuntime.diagnostic(this.settings.codexPath);
  }
  claudeDiagnostic(): { executable: string; installed: boolean } {
    return this.aiRuntime.diagnostic(this.settings.claudePath);
  }
  modelDiscoveryState(provider: "codex" | "claude"): ModelDiscoveryState {
    return this.modelDiscovery.state(provider);
  }
  subscribeModelDiscovery(listener: (state: ModelDiscoveryState) => void): () => void {
    return this.modelDiscovery.subscribe(listener);
  }
  /** The current model (settings page and chat menu share it): save it and tell every listener. */
  async setCurrentModel(model: string): Promise<void> {
    if (typeof model !== "string" || !model.trim()) return;
    this.settings.cliModel = model.trim();
    await this.saveSettings();
    this.rereadAllViews();
    for (const listener of [...this.currentModelListeners]) listener(this.settings.cliModel);
  }
  /** Opens the read-only full-prompt preview; `trigger` gets the focus back when it closes. */
  openPromptPreview(trigger?: HTMLElement, styleOf?: () => RunStyle): void {
    const provider = this.runtimeIdFor(this.currentModelChoice().model);
    openInWindowOf(
      new PromptPreviewModal(this.app, this.noteStyles, this.settings.language, provider, trigger, styleOf),
      trigger
    );
  }
  /** The current model and reasoning level, resolved the one way every entry point shares (ADR-021). */
  currentModelChoice(): ModelChoice {
    const { model, reasoning } = resolveTaskModel({
      current: { model: this.settings.cliModel, reasoning: normalizeReasoningLevel(this.settings.cliReasoning) }
    });
    return { model, reasoning };
  }
  subscribeCurrentModel(listener: (model: string) => void): () => void {
    this.currentModelListeners.add(listener);
    return () => {
      this.currentModelListeners.delete(listener);
    };
  }
  async refreshModelDiscovery(provider: "codex" | "claude"): Promise<ModelDiscoveryState> {
    const state = await this.modelDiscovery.refresh(provider);
    if (provider === "codex" && state.status === "ready") {
      this.settings.models = state.models.join(", ");
      await this.saveSettings();
    }
    return state;
  }
  availableModels(): string[] {
    const codex = this.modelDiscovery.state("codex");
    const models =
      codex.status === "idle" || codex.status === "loading"
        ? this.settings.models
            .split(/[\n,]/)
            .map(value => value.trim())
            .filter(Boolean)
        : [...codex.models];
    if (this.modelDiscovery.state("claude").status === "ready")
      models.push(...CLAUDE_MODEL_CHOICES.map(choice => choice.id));
    return [...new Set(models)];
  }
  /** Which runtime serves `model`, without starting it. */
  private runtimeIdFor(model: string): AiRuntimeId {
    return this.aiRuntime.runtimeFor(model).capabilities.id;
  }
  modelLabel(model: string): string {
    return (
      CLAUDE_MODEL_CHOICES.find(choice => choice.id === model)?.label ?? `${t("ui.codex_provider_label")} · ${model}`
    );
  }
  /** True when running AI with this model first asks the user to confirm the usage notice. */
  usageNoticePending(model: string): boolean {
    return !this.usageNoticeSeen(model);
  }
  private usageNoticeSeen(model: string): boolean {
    return this.runtimeIdFor(model) === "claude"
      ? this.settings.claudeUsageNoticeSeen
      : this.settings.codexUsageNoticeSeen;
  }
  private async setUsageNoticeSeen(model: string): Promise<void> {
    if (this.runtimeIdFor(model) === "claude") this.settings.claudeUsageNoticeSeen = true;
    else this.settings.codexUsageNoticeSeen = true;
    await this.saveSettings();
  }
  resetCodexRuntime(): void {
    this.expansionCoordinator.stopAll();
    this.aiCalls.stopAll();
    this.topicRuns.stopAll();
    this.modelDiscovery.invalidate("codex");
    this.aiRuntime.reset();
  }
  openCodexSetupGuide(): void {
    const diagnostic = this.codexDiagnostic();
    new CodexSetupModal(this.app, diagnostic.executable, () => {
      void this.recheckCodex(false);
    }).open();
  }
  async recheckCodex(showGuide = true): Promise<void> {
    const diagnostic = this.codexDiagnostic();
    if (!diagnostic.installed) {
      if (showGuide) this.openCodexSetupGuide();
      else new Notice(t("ui.codex_cli_was_not_found_0_set_the_codex_cli_path_in_vam_sett", diagnostic.executable));
      return;
    }
    const state = await this.refreshModelDiscovery("codex");
    if (state.status === "ready") new Notice(t("ui.codex_app_server_is_ready_0", diagnostic.executable));
    else if (state.status === "error")
      new Notice(
        t(
          "ui.codex_app_server_check_failed_0",
          this.recordFailure(t("log.codex_recheck_failed"), state.error ?? "unknown error")
        )
      );
    else new Notice(t("ui.codex_cli_was_not_found_0_set_the_codex_cli_path_in_vam_sett", diagnostic.executable));
  }
  private isMap(file: TFile): boolean {
    const marker: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.["visual-agent-map"];
    return (
      marker === true ||
      marker === "true" ||
      (file.extension === "md" &&
        (file.path.startsWith(`${this.settings.mapsFolder}/`) ||
          (isManagedMapPath(this.settings, file.path) && file.name === "Map.md")))
    );
  }
  private isNode(file: TFile): boolean {
    const marker: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.["agent-map-node"];
    return (
      marker === true ||
      marker === "true" ||
      (file.extension === "md" &&
        (file.path.startsWith(`${this.settings.notesFolder}/`) || isManagedMapPath(this.settings, file.path)))
    );
  }
  private styleNodeLeaf(leaf: WorkspaceLeaf | null): void {
    if (!(leaf?.view instanceof MarkdownView)) return;
    leaf.view.containerEl.toggleClass("vam-topic-markdown", !!leaf.view.file && this.isNode(leaf.view.file));
    // A picture-book card (it has a book role) reads as a book page; see `.vam-book-page` in styles.css.
    const bookRole: unknown =
      leaf.view.file && this.app.metadataCache.getFileCache(leaf.view.file)?.frontmatter?.["book-role"];
    const isBook = typeof bookRole === "string" && bookRole !== "";
    leaf.view.containerEl.toggleClass("vam-book-page", isBook);
    // vam-tokens: the reader sits outside the map view, so it carries the VAM token root itself (V3.3 G01).
    leaf.view.containerEl.toggleClass("vam-tokens", isBook);
  }
  /** Picture-book pipeline entries (the screen and the commands call these; refusals are thrown as BookPipelineRunError). */
  startBookPipeline(mapPath: string, options: { restart?: boolean } = {}): Promise<void> {
    return this.bookPipelineRuns.start(mapPath, options);
  }
  /** The start card's grey suggestions: one text-only call on the picture model, in the book's language. The caller owns the timeout and the abort. */
  suggestBookSettings(
    input: { mapPath: string; title: string; summary: string; chapters: string[] },
    signal: AbortSignal
  ): Promise<BookSettings> {
    return runSuggestSettings(
      this.aiCalls,
      {
        usageMapPath: input.mapPath,
        language: selectionOutputLanguage(this.settings.language, ""),
        model: this.settings.bookImageModel,
        reasoning: this.currentModelChoice().reasoning,
        bookTitle: input.title,
        summary: input.summary,
        chapters: input.chapters
      },
      { signal }
    );
  }
  /** One turn of the start card's talk with the chief editor: one text-only call on the plan model the card shows now. The caller owns the timeout and the abort. */
  editBookSettings(
    input: {
      mapPath: string;
      model: string;
      message: string;
      settings: BookSettings;
      turns: { owner: string; editor: string }[];
    },
    signal: AbortSignal
  ): Promise<EditSettingsResult> {
    return runEditSettings(
      this.aiCalls,
      {
        usageMapPath: input.mapPath,
        language: selectionOutputLanguage(this.settings.language, ""),
        model: input.model,
        reasoning: this.currentModelChoice().reasoning,
        message: input.message,
        settings: input.settings,
        turns: input.turns
      },
      { signal }
    );
  }
  stopBookPipeline(mapPath: string, options: { saved?: boolean } = {}): Promise<void> {
    return this.bookPipelineRuns.stop(mapPath, options);
  }
  abandonBookPipeline(mapPath: string): Promise<void> {
    return this.bookPipelineRuns.abandon(mapPath);
  }
  fixBookAgain(mapPath: string): Promise<void> {
    return this.bookPipelineRuns.fixAgain(mapPath);
  }
  resumeBookPipeline(mapPath: string, options: { addBudget?: number } = {}): Promise<void> {
    return this.bookPipelineRuns.resume(mapPath, options);
  }
  keepBookMap(mapPath: string): Promise<void> {
    return this.bookPipelineRuns.keepBookMap(mapPath);
  }
  undoBookStructure(mapPath: string, opIds: readonly string[] | "all"): Promise<void> {
    return this.bookPipelineRuns.undoStructureEdit(mapPath, opIds);
  }
  editBookStructureAtReview(
    mapPath: string,
    ops: readonly StructureOp[],
    expect: { runId: string; phaseStartedAt: string; nodes: readonly StructureNode[] },
    opening: string | ((affected: number) => string)
  ): ReturnType<BookPipelineRuns["editStructureAtReview"]> {
    return this.bookPipelineRuns.editStructureAtReview(mapPath, ops, expect, opening);
  }
  confirmBookGate1(mapPath: string): Promise<void> {
    return this.bookPipelineRuns.confirmGate1(mapPath);
  }
  startBookTrial(mapPath: string): Promise<void> {
    return this.bookPipelineRuns.startTrial(mapPath);
  }
  backBookToPlan(mapPath: string): Promise<void> {
    return this.bookPipelineRuns.backToPlan(mapPath);
  }
  rerunBookCard(
    mapPath: string,
    nodeId: string,
    options: { avoidSources?: readonly string[]; overwrite?: { operation: string; fingerprint: string } } = {}
  ): Promise<BookRerunResult> {
    return this.bookPipelineRuns.rerunCard(mapPath, nodeId, options);
  }
  finishBookRun(mapPath: string): Promise<void> {
    return this.bookPipelineRuns.finishRun(mapPath);
  }
  confirmBookSeam(mapPath: string, nodeId: string): Promise<void> {
    return this.bookPipelineRuns.confirmSeam(mapPath, nodeId);
  }
  getBookPipelineProgress(mapPath: string): BookPipelineProgress | undefined {
    return this.bookPipelineRuns.getProgress(mapPath);
  }
  onunload(): void {
    // Background diagram jobs stop before the repository does, so none can apply a result after the vault is released.
    // Shared Living Node runs and trials stop with the plugin.
    livingCoordinator(this).unload();
    this.topicRuns.dispose();
    this.argumentRuns.dispose();
    this.bookPipelineRuns.dispose();
    this.bookCallouts.dispose();
    this.bookHandEdits.dispose();
    if (this.bookNotesTimer !== null) window.clearTimeout(this.bookNotesTimer);
    this.bookNotesTimer = null;
    if (this.bookPaintTimer !== null) window.clearTimeout(this.bookPaintTimer);
    this.bookPaintTimer = null;
    this.bookNotesApply.dispose();
    this.bookRefindSlot.dispose();
    this.bookHighlights.dispose();
    this.readingHighlight.release();
    this.bookNotes.dispose();
    // The last pan or zoom is not lost: it is sent now, and only that viewport write may land after dispose.
    for (const view of [...this.viewportsPending]) view.flushViewportOnUnload();
    // In-flight work (a long Obsidian rename, a queued mutation) must not write into the vault after this point.
    this.repo?.dispose();
    // A pending external-delete reconcile must not touch the disposed repo after unload.
    if (this.externalReconcileTimer !== null) window.clearTimeout(this.externalReconcileTimer);
    this.externalReconcileTimer = null;
    this.externalReconcilePaths.clear();
    this.shareTranslationCache.clear();
    // A share build still running must not leave its wrapper on Obsidian's shared Mermaid object.
    releaseMermaidCapture();
    this.resetCodexRuntime();
    // After this no late dialog event can start a pre-warmed process.
    this.unloaded = true;
    this.aiRuntime.dispose();
    // Pending usage writes finish; later calls are no longer recorded.
    void this.usage?.dispose();
  }
  /** The vault operations of the note style store (Vault and FileManager APIs only). */
  private noteStylePort(): StyleFilePort {
    const folderAt = (path: string) => {
      const found = this.app.vault.getAbstractFileByPath(normalizePath(path));
      return found instanceof TFolder ? found : null;
    };
    return {
      list: async folder =>
        (folderAt(folder)?.children ?? [])
          .filter((child): child is TFile => child instanceof TFile && child.extension === "md")
          .map(child => child.name),
      read: path => {
        const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
        if (!(file instanceof TFile)) return Promise.reject(new Error(path));
        return this.app.vault.read(file);
      },
      folderExists: path => folderAt(path) !== null,
      createFolder: async path => {
        let current = "";
        for (const part of normalizePath(path).split("/")) {
          current = current ? `${current}/${part}` : part;
          if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
        }
      },
      create: async (path, content) => {
        await this.app.vault.create(normalizePath(path), content);
      },
      modify: async (path, content) => {
        const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
        if (!(file instanceof TFile)) throw new Error(path);
        await this.app.vault.modify(file, content);
      },
      trash: async path => {
        const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
        if (file instanceof TFile) await this.app.fileManager.trashFile(file);
      },
      // FileManager.renameFile (not Vault.rename): it also updates links to the file; it rejects when the target exists.
      rename: async (from, to) => {
        const file = this.app.vault.getAbstractFileByPath(normalizePath(from));
        if (!(file instanceof TFile)) throw new Error(from);
        await this.app.fileManager.renameFile(file, normalizePath(to));
      }
    };
  }
  /** Folder rename and the command that opens the block folder. Nothing here creates a file on load. */
  private registerNoteStyleEntrypoints(): void {
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFolder)
          void this.noteStyles.followFolderRename(normalizePath(oldPath), file.path).catch(() => undefined);
      })
    );
    this.addLocalizedCommand("open-note-styles-folder", "ui.command_open_note_styles_folder", () => {
      void this.openNoteStylesFolder();
    });
  }
  /** Creates the block folders (Templates and Tones) when they are missing, shows where they are and reveals the folder. */
  async openNoteStylesFolder(): Promise<string | null> {
    try {
      const folder = await this.noteStyles.ensureBlockFolder();
      new Notice(t("ui.note_style_folder_opened_0", folder));
      const target = this.app.vault.getAbstractFileByPath(normalizePath(folder));
      if (target) {
        // Best effort: the file explorer shows the folder when it is open; the Notice names the path either way.
        const explorer = this.app.workspace.getLeavesOfType?.("file-explorer")?.[0]?.view as
          { revealInFolder?: (item: TAbstractFile) => void } | undefined;
        explorer?.revealInFolder?.(target);
      }
      return folder;
    } catch (error) {
      // The raw system error goes to the log; the Notice says what to do.
      this.logs.appendLog(
        "warn",
        `${t("ui.note_style_folder_open_failed")} ${error instanceof Error ? error.message : String(error)}`
      );
      new Notice(t("ui.note_style_folder_open_failed"));
      return null;
    }
  }
  /**
   * "Edit" a part of the custom note styles: a built-in is first saved as "My <name>" (a new file, no setting changes), a
   * file is opened as it is. Opens the file in a tab and returns the ref now behind it, or null (with a Notice) when it
   * could not be done.
   */
  async editNotePart(category: PartCategory, ref: string): Promise<string | null> {
    try {
      // A built-in is copied once: a file that already holds the same text is opened instead of another copy.
      const { ref: target, created } = await this.noteStyles.copyPartOnce(category, ref);
      if (created) new Notice(t("ui.part_notice_saved_as_0", target.slice("file:".length)));
      await this.noteStyles.refresh();
      const path = this.noteStyles.partFilePath(category, target);
      const file = path ? this.app.vault.getAbstractFileByPath(normalizePath(path)) : null;
      if (!(file instanceof TFile)) throw new Error("not a file");
      await this.app.workspace.getLeaf("tab").openFile(file);
      return target;
    } catch {
      new Notice(t("ui.block_notice_open_failed"));
      return null;
    }
  }
  /**
   * The topics (notes) that name a style in their `note-style` frontmatter, read from the metadata cache. Read only: the
   * clean-up of unused copies and the delete and rename confirmations need the styles the topics choose, which the store
   * cannot see.
   */
  topicNoteStyleRefs(): { path: string; ref: string }[] {
    const found: { path: string; ref: string }[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const ref: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.["note-style"];
      if (typeof ref === "string" && ref) found.push({ path: file.path, ref });
    }
    return found;
  }
  /**
   * Renames a style or part file from the manage window and follows it (settings-redesign decision 1): `noteStyleByKind`,
   * the topics' `note-style`, and for a part the style files that name it, the `legacy` table and the global voice or
   * format. A refused name changes nothing. A topic or style file that cannot be written does not stop the others; one
   * Notice says what was updated and one lists what was not. There is no undo: renaming back follows the same way.
   */
  async renameNoteStyle(
    category: StyleCategory,
    ref: string,
    name: string
  ): Promise<
    | { ok: true; ref: string; unchanged?: true; topics: number; styles: number; failed: string[] }
    | { ok: false; reason: "missing" | "name" | "taken" | "failed" }
  > {
    const result = await renameStyleReferences(noteStylePorts(this), category, ref, name);
    if (!result.ok) {
      new Notice(t("ui.manage_rename_refused"));
      return result;
    }
    if (result.unchanged) return result;
    const failed = [...(result.settingsFailed ? [t("ui.manage_rename_settings")] : []), ...result.failed];
    new Notice(t("ui.manage_rename_done_0_1_2", name, result.topics, result.styles));
    if (failed.length) new Notice(t("ui.manage_rename_failed_0", failed.join(t("ui.list_separator"))));
    return { ok: true, ref: result.ref, topics: result.topics, styles: result.styles, failed };
  }
  /** Removes the entries of `noteStyleByKind` that name `ref` (those topic types go back to their built-in style); one save. Returns the kinds. */
  clearKindStyles(ref: string): Promise<StyleKind[]> {
    return clearKindStyles(noteStylePorts(this), ref);
  }
  /**
   * Moves a style or part file to the Obsidian trash (recoverable). A style: the topic types that used it go back to their
   * built-in style, the topics are not changed (they find no style and fall back with a notice, as for any missing file). A
   * part: the styles that name it fall back to the built-in part and show a problem; the global voice or format that named
   * it goes back to the default. Returns false (with a Notice) when the file could not be moved; nothing else is changed then.
   */
  async deleteNoteStyle(category: StyleCategory, ref: string): Promise<boolean> {
    const deleted = await deleteStyleReferences(noteStylePorts(this), category, ref);
    if (!deleted) new Notice(t("ui.manage_delete_failed"));
    return deleted;
  }
  /** Sets the style a kind uses. Choosing the kind's own built-in style removes the entry (a kind with no entry uses it). */
  setKindStyle(kind: StyleKind, ref: string): Promise<void> {
    return setKindStyle(noteStylePorts(this), kind, ref);
  }
  /**
   * Sets the global voice or format (a part ref). Choosing the built-in default (academic, standard) removes the key, and
   * the whole object when no key is left. Does nothing for a value that is not a part ref of that category.
   */
  setGlobalPart(category: "voice" | "format", ref: string): Promise<void> {
    return setGlobalPart(noteStylePorts(this), category, ref);
  }
  /** Saves a custom style from the editor and says what happened in a Notice; the result goes back to the editor. */
  async saveNoteRecipe(input: SaveRecipeInput): Promise<SaveRecipeResult> {
    const result = await this.noteStyles.saveRecipe(input);
    if (result.ok) new Notice(t("ui.recipe_notice_saved_0", result.ref.slice("file:".length)));
    else
      new Notice(
        t(
          result.reason === "name"
            ? "ui.recipe_notice_name_unavailable"
            : result.reason === "changed"
              ? "ui.recipe_notice_changed"
              : "ui.recipe_notice_failed"
        )
      );
    return result;
  }
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
  /**
   * Writers of the open map views, so the settings switch reaches them. view.ts calls `registerMapChatRecordWriter` when it makes
   * its writer (and the returned function when it closes), and creates the writer only while `settings.mapChatRecords`.
   * Each registered writer gets `setEnabled(false)` the moment the switch goes off and `setEnabled(true)` when it goes on.
   */
  private readonly mapChatRecordWriters = new Set<MapChatRecordsSwitch>();
  registerMapChatRecordWriter(writer: MapChatRecordsSwitch): () => void {
    this.mapChatRecordWriters.add(writer);
    writer.setEnabled(this.settings.mapChatRecords);
    return () => {
      this.mapChatRecordWriters.delete(writer);
    };
  }
  /** The settings switch "save map AI conversations". Off: writers stop, then the owner chooses to keep or delete the saved records. */
  async setMapChatRecords(on: boolean): Promise<void> {
    if (this.settings.mapChatRecords === on) return;
    this.settings.mapChatRecords = on;
    await this.saveSettings();
    // The side window of every open map shows or hides its "New conversation" button without waiting for a repaint.
    const refreshViews = (): void => {
      for (const view of this.views()) view.refreshChatRecordsSwitch();
    };
    if (on) {
      for (const writer of this.mapChatRecordWriters) writer.setEnabled(true);
      refreshViews();
      return;
    }
    refreshViews();
    await turnMapChatRecordsOff({
      app: this.app,
      writers: this.mapChatRecordWriters,
      stillOff: () => !this.settings.mapChatRecords
    });
  }
  async changeLanguage(value: unknown): Promise<boolean> {
    const next = uiLocale(value);
    if (this.languageSwitchPending || next === this.settings.language) return false;
    const previous = this.settings.language;
    this.languageSwitchPending = true;
    try {
      this.settingTab?.refreshAfterLanguageChange();
      const nextSettings: Settings = { ...this.settings, language: next };
      try {
        await this.saveData(nextSettings);
      } catch (error) {
        this.recordFailure(translate(previous, "ui.language_change_save_failed"), error);
        new Notice(translate(previous, "ui.language_change_save_failed"));
        return false;
      }
      Object.assign(this.settings, nextSettings);
      setUiLanguage(next);
      const failures: unknown[] = [];
      try {
        this.refreshLocalizedEntrypoints();
      } catch (error) {
        failures.push(error);
      }
      try {
        const views = this.views();
        const results = await Promise.allSettled(views.map(view => view.refreshFromPlugin()));
        for (const result of results) if (result.status === "rejected") failures.push(result.reason);
        if (!views.length) this.syncOutline(null, new Map());
      } catch (error) {
        failures.push(error);
      }
      for (const error of failures) this.recordFailure(t("ui.language_view_refresh_failed"), error);
      new Notice(
        failures.length ? t("ui.language_change_partial_failure") : t("ui.language_changed_content_preserved")
      );
      return true;
    } finally {
      this.languageSwitchPending = false;
      this.settingTab?.refreshAfterLanguageChange();
    }
  }
  private addLocalizedCommand(id: string, key: TranslationKey, callback: () => void): void {
    this.localizedCommands.push({ command: this.addCommand({ id, name: t(key), callback }), key });
  }
  refreshLocalizedEntrypoints(): void {
    this.ribbonIcon?.setAttribute("aria-label", translate(this.settings.language, "ui.open_map"));
    this.markdownSelectionAi?.refreshLanguage();
    for (const leaf of this.app.workspace.getLeavesOfType(LIVING_READER_VIEW))
      if (leaf.view instanceof LivingReaderView) leaf.view.refreshLanguage();
    for (const { command, key } of this.localizedCommands)
      command.name = `${this.manifest?.name ?? "Visual Agent Map"}: ${translate(this.settings.language, key)}`;
  }
  async aiReadyForModel(model: string): Promise<boolean> {
    const runtime = this.aiRuntime.runtimeFor(model);
    const readiness = await runtime.readiness(model);
    if (readiness.status === "ready") return true;
    if (readiness.status === "missing") {
      if (runtime.capabilities.id === "claude") this.openClaudeSetupGuide();
      else this.openCodexSetupGuide();
      return false;
    }
    // The reason is said to the user, not only written to the log, with a way to fix it and where to look in the settings.
    const service = runtime.capabilities.id === "claude" ? "Claude Code" : "Codex";
    if (readiness.error !== undefined) this.logs.appendLog("warn", t("log.codex_not_ready_0", readiness.error));
    const message =
      readiness.status === "model-unavailable"
        ? t("ui.ai_not_ready_model_0_1", this.modelLabel(model), service)
        : readiness.error
          ? t("ui.ai_not_ready_error_0_1", service, readiness.error)
          : t("ui.ai_not_ready_unknown_0", service);
    actionNotice(`${message} ${t("ui.ai_not_ready_where")}`, t("ui.connection_repair"), () =>
      this.repairConnection(model)
    );
    return false;
  }
  async codexReadyForAi(): Promise<boolean> {
    return this.aiReadyForModel(this.settings.cliModel);
  }
  /** The dialogs' "Fix connection…" link: the setup guide when the model's CLI is missing, otherwise a fresh check. */
  repairConnection(model?: string): void {
    // The other service is refreshed quietly too, so a CLI fixed meanwhile brings its models back to the picker.
    if (this.runtimeIdFor(model || this.settings.cliModel) === "claude") {
      if (this.claudeDiagnostic().installed) void this.recheckClaude();
      else this.openClaudeSetupGuide();
      void this.refreshModelDiscovery("codex");
      return;
    }
    void this.recheckCodex(true);
    void this.refreshModelDiscovery("claude");
  }
  openClaudeSetupGuide(): void {
    new ClaudeSetupModal(this.app, this.claudeDiagnostic().executable, CLAUDE_INSTALL_URL, () => {
      void this.recheckClaude();
    }).open();
  }
  async recheckClaude(): Promise<void> {
    const diagnostic = this.claudeDiagnostic();
    const state = await this.refreshModelDiscovery("claude");
    if (!diagnostic.installed) {
      new Notice(t("ui.claude_cli_was_not_found_follow_the_installation_guide_to_install_it"));
      return;
    }
    new Notice(t("ui.claude_cli_found_0", diagnostic.executable));
    if (state.status !== "ready") this.logs.appendLog("warn", `Claude model discovery status: ${state.status}`);
  }
  /** `noticeOpening` is called just before the usage notice opens (only when it really does), so a caller can say it waits for it. */
  async confirmAiUsage(
    model: string,
    run: () => Promise<void>,
    hooks?: { noticeOpening?: () => void }
  ): Promise<boolean> {
    if (!(await this.aiReadyForModel(model))) return false;
    if (!this.usageNoticeSeen(model)) {
      const provider = this.runtimeIdFor(model);
      hooks?.noticeOpening?.();
      const confirmed = await new Promise<boolean>(resolve => new AiUsageModal(this.app, provider, resolve).open());
      if (!confirmed) return false;
      await this.setUsageNoticeSeen(model);
    }
    await run();
    return true;
  }
  async confirmCodexUsage(run: () => Promise<void>): Promise<void> {
    await this.confirmAiUsage(this.settings.cliModel, run);
  }
  /**
   * Rebuilds derived note data; `paths` limits the rewrite to those notes (the ends of a changed relation), `roots` to
   * the notes under those folders (a paste rebuilds only the target map, B27).
   */
  async rebuildDerivedData(scope?: string[] | { roots: string[]; paths?: string[] }): Promise<void> {
    try {
      await this.repo.rebuildDerivedData(Array.isArray(scope) ? { roots: [], paths: scope } : scope);
    } catch (error) {
      console.error("Visual Agent Map reference rebuild", error);
      new Notice(
        t("ui.map_saved_but_reference_update_failed_0", error instanceof Error ? error.message : String(error))
      );
    }
  }
  private scheduleExternalReconciliation(deletedPath: string): void {
    this.externalReconcilePaths.add(deletedPath);
    if (this.externalReconcileTimer !== null) window.clearTimeout(this.externalReconcileTimer);
    this.externalReconcileTimer = window.setTimeout(() => {
      this.externalReconcileTimer = null;
      const deleted = [...this.externalReconcilePaths];
      this.externalReconcilePaths.clear();
      void this.mutate(async () => {
        // Only a deleted map node can leave a dangling path; other deletions need no vault scan.
        if (!(await this.repo.anyMapNodePath(deleted))) return;
        const repaired = await this.repo.reconcileMissingNodePaths();
        if (repaired) await this.rebuildDerivedData();
      }).catch(error => console.error("Visual Agent Map external rename reconciliation", error));
    }, 500);
  }
  /** Called after the node-details pane revealed its leaf; returns the unsubscribe. */
  onDetailsReveal(listener: () => void): () => void {
    return this.nodeDetailsSidebar.onReveal(listener);
  }
  /** True while the node-details pane is revealing its leaf. */
  detailsRevealing(): boolean {
    return this.nodeDetailsSidebar.revealing();
  }
  /** The node-details sidebar counts as open only while its pane is actually visible. */
  detailsShown(): boolean {
    return this.nodeDetailsSidebar.detailsShown();
  }
  showLivingTrial(
    file: TFile,
    markdown: string,
    owner: string,
    isCurrent: () => boolean,
    warnings: readonly string[] = [],
    changes?: LivingChangeSummary,
    draft = false
  ): Promise<boolean> {
    return this.nodeDetailsSidebar.showLivingTrial(file, markdown, owner, isCurrent, warnings, changes, draft);
  }
  invalidateLivingTrial(owner: string): void {
    this.nodeDetailsSidebar.invalidateLivingTrial(owner);
  }
  restoreLivingOfficial(file: TFile | undefined, owner: string, release = false): Promise<void> {
    return this.nodeDetailsSidebar.restoreLivingOfficial(file, owner, release);
  }
  /** An outline row click: moves the map to the topic and opens its note beside it. */
  async revealFromOutline(path: string): Promise<void> {
    // The reader opens first: it takes width from the map, and the card is centred on the width that is left.
    let failed: string | null = null;
    const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
    try {
      await this.openDetails(this.repo.file(path));
    } catch (error) {
      failed = message(error);
    }
    try {
      const view = this.views().find(item => item.hasPath(path));
      if (view) {
        // Bring the map tab forward first: a background tab has no size to center in.
        await this.app.workspace.revealLeaf(view.leaf);
        await view.revealPath(path);
      }
    } catch (error) {
      failed ??= message(error);
    }
    if (failed) new Notice(failed);
  }
  openDetails(file: TFile, owner?: string): Promise<void> {
    return this.nodeDetailsSidebar.openDetails(file, owner);
  } /** Whether this plugin instance is running, queued or batching an AI task for the note. A `running` note that is not busy was left by a reload. */
  isNoteTaskBusy(path: string): boolean {
    if (this.running.has(path) || this.activeTasks.has(path) || this.quickExpandPending.has(path)) return true;
    if (this.expansionCoordinator.isRunning(path)) return true;
    for (const batch of this.expansionBatches.values())
      if (batch.status === "running" && (batch.currentPath === path || batch.queuedPaths.includes(path))) return true;
    return false;
  }

  closeStaleDetails(): void {
    this.nodeDetailsSidebar.closeStaleDetails();
  }
  private async markdownContextImage(image: HTMLImageElement, signal: AbortSignal): Promise<string> {
    if (signal.aborted || !image.complete || !image.naturalWidth) throw new Error(t("ui.context_ai_image_unavailable"));
    // Use the already loaded pixels first. Cross-origin images can taint the canvas.
    try {
      const canvas = createEl("canvas");
      const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (context) {
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png");
      }
    } catch {
      /* Resolve a Vault attachment or an explicitly selected public image below. */
    }
    let bytes: ArrayBuffer;
    const embeddedPath = image.closest(".internal-embed")?.getAttribute("src")?.split("#")[0];
    const view = this.app.workspace
      .getLeavesOfType("markdown")
      .map(leaf => leaf.view)
      .find(view => view instanceof MarkdownView && view.containerEl.contains(image));
    const file = embeddedPath
      ? this.app.metadataCache.getFirstLinkpathDest(
          embeddedPath,
          view instanceof MarkdownView ? (view.file?.path ?? "") : ""
        )
      : null;
    const remote = image.currentSrc || image.src;
    if (file instanceof TFile) bytes = await this.app.vault.readBinary(file);
    else if (/^https?:\/\//i.test(remote)) {
      // A web image the note already shows: canvas reads are blocked cross-origin, so fetch its bytes directly.
      try {
        bytes = (await requestUrl({ url: remote, method: "GET", throw: true })).arrayBuffer;
      } catch {
        throw new Error(t("ui.context_ai_image_download_failed"));
      }
    } else throw new Error(t("ui.context_ai_image_unavailable"));
    if (signal.aborted) throw new Error(t("ui.ai_task_cancelled"));
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error(t("ui.context_ai_image_unavailable"));
    const buffer = Buffer.from(bytes);
    const mime = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : buffer[0] === 255 && buffer[1] === 216
        ? "image/jpeg"
        : buffer.subarray(0, 3).toString() === "GIF"
          ? "image/gif"
          : buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP"
            ? "image/webp"
            : "";
    if (!mime) throw new Error(t("ui.context_ai_image_unavailable"));
    return `data:${mime};base64,${buffer.toString("base64")}`;
  }

  /** Writes a generated image where `attachmentPath` puts attachments for `notePath`; returns the new file's path. */
  private async saveGeneratedImage(dataUrl: string, notePath: string, name: string): Promise<string> {
    const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(dataUrl);
    if (!match) throw new Error(t("ui.context_ai_image_not_generated"));
    const extension = match[1] === "jpeg" ? "jpg" : match[1];
    const path = await attachmentPath(this.app, `${name}.${extension}`, notePath);
    const bytes = Buffer.from(match[2], "base64");
    await this.app.vault.createBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return path;
  }
  /**
   * Web image search for the map chat: the Markdown quick action's `markdown.image-search` step through the model's web search,
   * parsed to https candidates (at most six). The caller has already asked for the usage notice of `model`, so this does not
   * ask again; the thumbnail check is the caller's too.
   */
  async searchImages(query: string, model: string, signal: AbortSignal): Promise<ImageCandidate[]> {
    const prepared = prepareStep(imageSearchStep, { query });
    return prepared.parse(await this.runMarkdownContextAi(prepared, model, signal, undefined, true));
  }
  private async runConfirmedMarkdownContextAi<Input, Output>(
    prepared: PreparedStep<Input, Output>,
    model: string,
    signal: AbortSignal,
    image?: HTMLImageElement,
    webSearch = false,
    generateImage = false
  ): Promise<string> {
    let result: string | undefined;
    const confirmed = await this.confirmAiUsage(model, async () => {
      result = await this.runMarkdownContextAi(prepared, model, signal, image, webSearch, generateImage);
    });
    if (!confirmed || result === undefined) throw new Error(t("ui.ai_task_cancelled"));
    return result;
  }
  private async runMarkdownContextAi<Input, Output>(
    prepared: PreparedStep<Input, Output>,
    model: string,
    signal: AbortSignal,
    image?: HTMLImageElement,
    webSearch = false,
    generateImage = false
  ): Promise<string> {
    const capabilities = this.aiCalls.capabilitiesFor(model, { imageGeneration: generateImage });
    const loaded = image ? await this.markdownContextImage(image, signal) : undefined;
    const imageDataUrl = loaded ? await fitImageForInput(loaded, capabilities.imageInput, signal) : undefined;
    if (signal.aborted) throw new Error(t("ui.ai_task_cancelled"));
    // Fail before anything is registered or logged when there is no plugin directory (not desktop Obsidian).
    this.pluginDirectory();
    const effort = effectiveReasoningLevel(
      { title: "Selected Markdown text", summary: "", detail: "", rules: "", task: prepared.prompt, ancestors: "" },
      this.currentModelChoice().reasoning
    );
    // Selected-text AI writes into a note: its tokens count as "writeback".
    return await this.aiCalls.run(
      prepared,
      {
        model,
        effort,
        topic: "Markdown selection",
        taskName: "markdown-context",
        signal,
        localCodex: !webSearch,
        usage: { action: "writeback" },
        task: {
          textOnly: !webSearch && !generateImage,
          webSearchOnly: webSearch,
          generateImage,
          imageDataUrl,
          searchBudget: webSearch ? 4 : 0,
          // Drawing takes longer than a text reply.
          ...(generateImage ? { timeoutMs: 6 * 60 * 1000 } : {})
        }
      },
      (raw, exchange) => {
        if (exchange.signal.aborted) throw new Error(t("ui.ai_task_cancelled"));
        return raw;
      }
    );
  }
  async openResearchMap(path: string): Promise<void> {
    await this.activateView(path);
  }
  /** The map tab that already shows (or is about to show) `path`, so one map is never opened twice. */
  findMapLeaf(path: string): WorkspaceLeaf | undefined {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).find(leaf => {
      if (leaf.view instanceof VisualAgentMapView) return leaf.view.targetPath() === path;
      const state = leaf.getViewState?.().state as { file?: unknown } | undefined;
      return state?.file === path;
    });
  }
  /**
   * Shows `path` in its own tab (or jumps to the tab that has it) and leaves every other map tab as it is. Never call this
   * inside `mutate`: the new tab opens its map through `mutate`, so waiting for it there would block the queue for good.
   */
  async openMapInNewTab(path: string): Promise<VisualAgentMapView | null> {
    const workspace = this.app.workspace;
    let leaf = this.findMapLeaf(path);
    const fresh = !leaf;
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      // Obsidian opens the view (onOpen) before it hands it the state, so the tab is told which map it is for up front.
      this.pendingTabMaps.set(leaf, path);
      try {
        await leaf.setViewState({ type: VIEW_TYPE, state: { file: path }, active: true });
      } finally {
        this.pendingTabMaps.delete(leaf);
      }
    }
    const view = leaf.view instanceof VisualAgentMapView ? leaf.view : null;
    // setViewState swallows a failed setState (the queue has already shown its Notice): a new tab that did not end up on the map is closed, not left blank.
    if (!view || (fresh && view.targetPath() !== path)) {
      if (fresh) leaf.detach();
      return null;
    }
    await this.showLeaf(leaf);
    // The map drew while the tab was still being set up; the opening screen's input takes the keyboard now that it is shown.
    view.focusChatHero();
    return view;
  }
  /** Maps whose new tab is being opened, by leaf: the tab's own default map must not open first (see the view's onOpen). */
  readonly pendingTabMaps = new WeakMap<WorkspaceLeaf, string>();
  /** Brings a tab forward and makes it the active leaf, so commands and the visible map are the same map. */
  async showLeaf(leaf: WorkspaceLeaf): Promise<void> {
    await this.app.workspace.revealLeaf(leaf);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }
  private async activateView(path?: string): Promise<void> {
    await this.ready;
    if (path) {
      const open = this.findMapLeaf(path);
      if (open) {
        await this.showLeaf(open);
        return;
      }
    }
    let leaf: WorkspaceLeaf | undefined = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    // Replacing the map in a tab stops its running work, so a tab that is busy keeps its map and the target gets a new tab.
    if (path && leaf?.view instanceof VisualAgentMapView && leaf.view.hasRunningWork()) leaf = undefined;
    const fresh = !leaf;
    if (!leaf) leaf = this.app.workspace.getLeaf("tab");
    // A tab made here opens its view before it is given the map (see openMapInNewTab).
    if (path) this.pendingTabMaps.set(leaf, path);
    try {
      await leaf.setViewState({
        type: VIEW_TYPE,
        active: true,
        state: path ? { file: path } : leaf.view instanceof VisualAgentMapView ? leaf.view.getState() : {}
      });
    } finally {
      this.pendingTabMaps.delete(leaf);
    }
    // A new tab whose map did not open (the queue has already shown its Notice) is closed, not left blank.
    if (fresh && path && !(leaf.view instanceof VisualAgentMapView && leaf.view.targetPath() === path)) {
      leaf.detach();
      return;
    }
    await this.showLeaf(leaf);
  }
  private async loadCodexModels(): Promise<{ models: string[]; reasoningEfforts: Record<string, string[]> }> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter) || !this.manifest.dir)
      throw new Error("Codex model discovery requires desktop Obsidian");
    const pluginDirectory = join(adapter.getBasePath(), this.manifest.dir);
    const models = await this.runtime(pluginDirectory).listModels();
    return {
      models: models.map(item => item.model),
      reasoningEfforts: Object.fromEntries(
        models.map(item => [
          item.model,
          item.supportedReasoningEfforts
            .map(effort => effort.reasoningEffort)
            .filter(value => ["low", "medium", "high"].includes(value))
        ])
      )
    };
  }
  async askModel(
    context: TaskContext,
    model: string,
    reasoning?: unknown,
    signal?: AbortSignal,
    onExchange?: (id: string) => void,
    onRequestAccepted?: () => void,
    onWebSearchEvent?: (event: CodexWebSearchEvent) => void,
    observer?: ResearchObserver
  ): Promise<AiResult> {
    return this.aiTasks.askModel(
      context,
      model,
      reasoning,
      signal,
      onExchange,
      onRequestAccepted,
      onWebSearchEvent,
      observer
    );
  }
  /**
   * Starts an idle Claude CLI while the research dialog is open, so confirming only has to write the prompt. No model
   * call happens until then; a run with different settings starts cold and leaves it for the dialog. A runtime that
   * cannot pre-start drops a waiting process instead (AiCalls).
   */
  prewarmClaude(model: string, reasoning?: unknown, webSearch = true, mode?: AiTaskKind): void {
    if (this.unloaded) return;
    try {
      const selected = normalizeReasoningLevel(reasoning ?? this.settings.cliReasoning);
      // Same rule as the run itself (effectiveReasoningLevel): auto is low for a short-source task but medium for a
      // synthesis. A long-source task resolves differently and starts cold.
      this.aiCalls.prewarm(model, {
        effort: effectiveReasoningLevel({ mode } as TaskContext, selected),
        schema: localizedResponseSchema(this.settings.language),
        webSearch
      });
    } catch {
      /* Pre-starting is an optimisation: the run starts the process itself. */
    }
  }
  /** Kills the pre-started Claude process (dialog closed unused, run stopped). */
  releaseWarmClaude(): void {
    this.aiRuntime.releaseWarm();
  }
  /** Aborts the background chart step of one note (a new run on that note replaces it), or of every note. */
  abortChartJobs(path?: string): void {
    this.topicRuns.abortCharts(path);
  }
  /** Runs the chart step in the background for a note that was just written; see {@link TopicRuns.addChartsAfterWrite}. */
  addChartsAfterWrite(job: ChartJob): void {
    this.topicRuns.addChartsAfterWrite(job);
  }
  private pluginDirectory(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error(t("ui.cli_mode_requires_desktop_obsidian"));
    if (!this.manifest.dir) throw new Error(t("ui.plugin_folder_not_found"));
    return join(adapter.getBasePath(), this.manifest.dir);
  }
  runtime(pluginDirectory: string, local = false): CodexAppServerRuntime {
    return this.aiRuntime.codex(pluginDirectory, local);
  }
  private claudeCli(pluginDirectory: string): ClaudeCodeCliRuntime {
    return this.aiRuntime.claude(pluginDirectory);
  }
}
