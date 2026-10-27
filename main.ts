import { registerInternalMarkerPresentation } from "./experiences/markdown-context/internal-markers";
import { registerMermaidZoom, type MermaidZoomHandle } from "./experiences/mermaid-zoom/register";
import { CoffeeTablesView, COFFEE_TABLES_VIEW_TYPE } from "./experiences/coffee-tables/view";
import type { CoffeeRequest, CoffeeSession } from "./experiences/coffee-tables/types";
import { CoffeeManager } from "./experiences/coffee-tables/engine";
import { CoffeeStorage } from "./experiences/coffee-tables/storage";
import { VisualAgentMapView, VIEW_TYPE } from "./experiences/visual-map/view";
import { planMathRepair, applyMathRepair } from "./experiences/visual-map/math-repair";
import type { TaskOptions } from "./experiences/visual-map/modals";
import { selectionOutputLanguage } from "./experiences/aim/content-language";
import {
  t,
  setUiLanguage,
  translate,
  initialUiLanguage,
  languagePromptName,
  noteLanguageOf,
  uiLocale,
  type TranslationKey,
  type ContentLanguage
} from "./i18n";
import {
  FileSystemAdapter,
  loadMermaid,
  MarkdownView,
  normalizePath,
  requestUrl,
  Notice,
  Plugin,
  TFile,
  type TFolder,
  View,
  WorkspaceLeaf,
  type Command
} from "obsidian";
import { ChoiceModal } from "./ui/modals/choice-modal";
import { DebugLogModal } from "./ui/modals/debug-log-modal";
import {
  AiUsageModal,
  ClaudeSetupModal,
  CodexSetupModal,
  VisualAgentMapSettingTab,
  CLAUDE_INSTALL_URL
} from "./ui/settings-tab";
import * as dns from "node:dns/promises";
import * as https from "node:https";
import { join } from "node:path";
import { type MapDocument, type MapNode } from "./map-model";
import {
  DEFAULT_SETTINGS,
  isManagedMapPath,
  isPlaceholder,
  moveNotePath,
  normalizeReasoningLevel,
  normalizeMapChatStyle,
  normalizeMapChatModel,
  normalizeMapChatWidth,
  normalizeMapChatOpen,
  rebaseMapNotePaths,
  resolveMapFolders,
  type Note,
  Repository,
  type Settings
} from "./repository";
import { normalizeTemplates } from "./ai/detail-templates";
import { normalizePresets } from "./ai/prompt-presets";
import { effectiveReasoningLevel } from "./ai/task-policy";
import { stepEffort } from "./core/provider-step-runner";
import type { ReasoningLevel } from "./ai/types";
import responseSchema from "./response-schema.json";
import type { AiResult, AiTaskKind, Suggestion, TaskContext } from "./ai/types";
import { clampPreviewScale, legacyPreviewScale } from "./ui/preview-utils";
import { fitImageForInput } from "./ui/fit-image-input";
import { BUILTIN_SAMPLE_ID, builtInSample } from "./builtin-sample";
import { debugLog, LogManager } from "./log-manager";
import { AiExchangeLog } from "./ai-exchange-log";
import { PendingSuggestions } from "./pending-suggestions";
import { OutlineView, OUTLINE_VIEW_TYPE } from "./ui/outline-view";
import { ShareModal } from "./experiences/sharing/share-modal";
import { releaseMermaidCapture } from "./experiences/sharing/share-exporter";
import { ShareTranslationCache } from "./experiences/sharing/share-translate-plan";
import { obsidianTranslateDom } from "./experiences/sharing/share-translate-dom";
import { providerShareTranslateRunner, ShareTranslateService } from "./experiences/sharing/share-translate-service";
import { groupRibbonIcons } from "./ui/ribbon-group";
import { CodexAppServerRuntime, type CodexWebSearchEvent } from "./ai/runtime/codex-app-server";
import { ClaudeCodeCliRuntime } from "./ai/runtime/claude-code-cli";
import { CLAUDE_MODEL_CHOICES } from "./ai/providers/provider";
import { ThinkingCore } from "./core/thinking-core";
import { prepareStep, type PreparedStep } from "./core/step-runner";
import type { ImageCandidate } from "./core/image-candidates";
import { imageSearchStep } from "./core/steps/image-search/step";
import { AiCalls } from "./core/ai-calls";
import type { AiRuntimeId } from "./core/ai-runtime";
import { AiRuntimeService } from "./core/ai-runtime-service";
import { ModelDiscovery, type ModelDiscoveryState } from "./core/model-discovery";
import { ShallowExpansionCoordinator, type ExpansionBatchState } from "./experiences/visual-map/expansion-batch";
import {
  SeamlessResearch,
  type SeamlessPhase1Input,
  type SeamlessVerifyInput,
  type SeamlessImagesInput
} from "./experiences/visual-map/seamless-research";
import { aiModeOptions } from "./experiences/visual-map/ai-mode";
import { researchTopicTask } from "./experiences/visual-map/steps/fragments";
import { researchVerifyStep, skeletonInstruction, type ResearchVerifyResult } from "./core/steps/research-verify/step";
import { researchImagesStep, type ResearchImagesResult } from "./core/steps/research-verify/images";
import { checkImageBytes, MAX_IMAGE_BYTES, normalizeHttpsUrl } from "./core/seamless-research/apply";
import { fetchPublicImage, pinnedLookup, type ImageFetchDeps } from "./core/seamless-research/image-fetch";
import { isSearchNotPerformed } from "./ai/search-not-performed";
import { ResearchProgressStore } from "./experiences/visual-map/research-progress";
import type { ResearchObserver } from "./ai/research-observer";
import { AiTaskService } from "./core/ai-task-service";
import { announceTestOverrides } from "./experiences/aim/flow-limits";
import { ReframingService, providerReframeRunner } from "./core/reframing-service";
import { OutlineGenerationService, providerOutlineRunner } from "./core/outline-generation-service";
import { StructureReviewService, providerStructureReviewRunner } from "./core/structure-review-service";
import { MapChatService, providerMapChatRunner } from "./core/map-chat-service";
import {
  RelevanceGradeService,
  providerRelevanceGradeRunner,
  type RelevanceGradeRun
} from "./core/relevance-grade-service";
import { receiveVisualMapHandoff } from "./experiences/visual-map/handoff";
import { openCoffeeResearchHandoff } from "./experiences/coffee-tables/handoff-modal";
import { MarkdownSelectionAi } from "./experiences/markdown-context/selection-ai";
import { AIM_CREATE_MAP_COMMAND_ID } from "./experiences/aim/legacy-names";

export { buildPreparedTaskContext } from "./ai/context-builder";
export { extractJsonObject } from "./core/ai-task-service";
export { executableCandidates } from "./core/ai-runtime-service";
export { canonicalDetail, visualReferencesMarkdown } from "./ai/result-utils";
export { VisualAgentMapView } from "./experiences/visual-map/view";
export { ChildProposalModal, DraftReviewModal, NextStepModal } from "./experiences/visual-map/modals";
export { VisualAgentMapSettingTab } from "./ui/settings-tab";
export { firstMarkdownImage, firstMarkdownTable, markdownImages } from "./ui/preview-utils";
export type { AiRunMetrics, PreparedTaskContext } from "./ai/types";

/** The settings in effect for what was saved: every field is checked, and a missing or invalid one takes its default. */
export function settingsFromSaved(saved: Partial<Settings> | null): Settings {
  const legacy: (Partial<Settings> & { cliPath?: string }) | null = saved;
  const savedWorkspace = saved?.workspaceFolder || DEFAULT_SETTINGS.workspaceFolder;
  return {
    ...DEFAULT_SETTINGS,
    detailTemplates: normalizeTemplates(saved?.detailTemplates),
    promptPresets: normalizePresets(saved?.promptPresets),
    defaultDetailTemplateId:
      typeof saved?.defaultDetailTemplateId === "string" ? saved.defaultDetailTemplateId : undefined,
    coffeeStyles: Array.isArray(saved?.coffeeStyles)
      ? saved.coffeeStyles.filter(
          (item: unknown): item is { id: string; name: string; prompt: string } =>
            !!item &&
            typeof item === "object" &&
            typeof (item as { id?: unknown }).id === "string" &&
            typeof (item as { name?: unknown }).name === "string" &&
            typeof (item as { prompt?: unknown }).prompt === "string"
        )
      : [],
    defaultCoffeeStyleId: typeof saved?.defaultCoffeeStyleId === "string" ? saved.defaultCoffeeStyleId : undefined,
    language: initialUiLanguage(saved?.language),
    workspaceFolder: savedWorkspace,
    topicsFolder: saved?.topicsFolder || DEFAULT_SETTINGS.topicsFolder,
    ...resolveMapFolders(saved),
    notesFolder: saved?.notesFolder || DEFAULT_SETTINGS.notesFolder,
    mapsFolder: saved?.mapsFolder || DEFAULT_SETTINGS.mapsFolder,
    mapId: saved?.mapId || "default",
    codexPath: saved?.codexPath || legacy?.cliPath || DEFAULT_SETTINGS.codexPath,
    claudePath: saved?.claudePath || DEFAULT_SETTINGS.claudePath,
    cliModel: saved?.cliModel || DEFAULT_SETTINGS.cliModel,
    mapChatStyle: normalizeMapChatStyle(saved?.mapChatStyle),
    mapChatModel: normalizeMapChatModel(saved?.mapChatModel),
    mapChatWidth: normalizeMapChatWidth(saved?.mapChatWidth),
    mapChatOpen: normalizeMapChatOpen(saved?.mapChatOpen),
    cliReasoning: normalizeReasoningLevel(saved?.cliReasoning),
    previewScale:
      saved?.previewScale !== undefined
        ? clampPreviewScale(saved.previewScale)
        : legacyPreviewScale(saved?.previewSize),
    models: "",
    migrated: saved?.migrated === true,
    structureVersion: saved?.structureVersion ?? (saved ? 1 : DEFAULT_SETTINGS.structureVersion),
    firstUseNoticeSeen: saved?.firstUseNoticeSeen === true,
    codexUsageNoticeSeen: saved?.codexUsageNoticeSeen === true,
    claudeUsageNoticeSeen: saved?.claudeUsageNoticeSeen === true,
    aiExchangeLoggingEnabled: saved?.aiExchangeLoggingEnabled === true,
    markdownSelectionAiAutoOpen: saved?.markdownSelectionAiAutoOpen !== false,
    addDiagramsAfterResearch: saved?.addDiagramsAfterResearch !== false,
    seamlessResearch: saved?.seamlessResearch === true,
    workspaceInitialized: saved ? saved.workspaceInitialized !== false : false,
    sampleTourVersionSeen: saved?.sampleTourVersionSeen ?? 0,
    canvasHintSeen: saved?.canvasHintSeen === true
  };
}

/** Chart steps that may run at once; further jobs wait in a first-in-first-out queue. */
export const CHART_JOB_LIMIT = 3;

export default class VisualAgentMapPlugin extends Plugin {
  /** Diagnostics for the mermaid zoom viewer (observer count); read by UI checks only. */
  mermaidZoom: MermaidZoomHandle | null = null;
  settings: Settings = { ...DEFAULT_SETTINGS };
  repo!: Repository;
  ready: Promise<void> = Promise.resolve();
  readonly running = new Set<string>();
  readonly quickExpandPending = new Set<string>();
  readonly aiCalls = new AiCalls({
    runtimeFor: model => this.aiRuntime.runtimeFor(model),
    exchanges: () => (this.settings.aiExchangeLoggingEnabled ? this.exchanges : null),
    releaseWarm: () => this.aiRuntime.releaseWarm()
  });
  readonly activeTasks = this.aiCalls.activeTasks;
  /** Background chart steps (running and queued), keyed by note path: one per path, at most {@link CHART_JOB_LIMIT} run at a time. */
  readonly chartJobs = new Map<string, AbortController>();
  /** Set by onunload; a late dialog event must not start a pre-warmed process after it. */
  private unloaded = false;
  /** Stage, elapsed time and the unsaved answer preview of research and chart steps in flight, keyed by note path. */
  readonly researchProgress = new ResearchProgressStore();
  /** The progress entry each background chart job owns (the research run's own entry ends when the note is written). */
  private readonly chartProgressIds = new Map<string, string>();
  private chartProgressSeq = 0;
  /** Jobs waiting for a free slot, first in first out. */
  private readonly chartQueue: Array<{ controller: AbortController; start: () => void }> = [];
  private chartRunning = 0;
  readonly expansionBatches = new Map<string, ExpansionBatchState>();
  readonly expansionCoordinator = new ShallowExpansionCoordinator(this.activeTasks, this.expansionBatches);
  /** The one-button research flow; created on first use, so with `settings.seamlessResearch` off nothing of it exists. */
  private seamless: SeamlessResearch | null = null;
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
  private readonly aiTaskOptions = {
    pluginDirectory: () => this.pluginDirectory(),
    language: () => this.settings.language,
    defaultReasoning: () => this.settings.cliReasoning,
    exchangeLoggingEnabled: () => this.settings.aiExchangeLoggingEnabled,
    exchanges: () => this.exchanges,
    diagramsEnabled: () => this.settings.addDiagramsAfterResearch,
    codexRuntime: (directory: string, local: boolean) => this.runtime(directory, local),
    claudeRuntime: (directory: string) => this.claudeCli(directory),
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
  readonly core = new ThinkingCore(
    this.aiRuntime,
    this.aiTasks,
    this.aiCalls,
    new ReframingService(providerReframeRunner(this.aiCalls))
  );
  readonly outlineGeneration = new OutlineGenerationService(providerOutlineRunner(this.aiCalls));
  readonly structureReview = new StructureReviewService(providerStructureReviewRunner(this.aiCalls));
  readonly mapChat = new MapChatService(providerMapChatRunner(this.aiCalls));
  readonly relevanceGrade = new RelevanceGradeService(providerRelevanceGradeRunner(this.aiCalls));
  /** Translated share text kept for this Obsidian session only (never written to disk); emptied on unload. */
  readonly shareTranslationCache = new ShareTranslationCache();
  readonly shareTranslate = new ShareTranslateService(providerShareTranslateRunner(this.aiCalls));
  /** The relevance grading run of each map, by map path. A view shows it; only one run per map. */
  readonly relevanceGrades = new Map<string, RelevanceGradeRun>();
  exchanges: AiExchangeLog | null = null;
  readonly modelDiscovery = new ModelDiscovery(
    () => this.codexDiagnostic().installed,
    () => this.loadCodexModels(),
    () => this.claudeDiagnostic().installed
  );
  coffeeManager: CoffeeManager | null = null;
  coffeeStorage: CoffeeStorage | null = null;
  private coffeeOutlineActive = false;
  private coffeeOutlineSource: CoffeeTablesView | null = null;
  private outlineSourceView: VisualAgentMapView | null = null;
  private outlineMap: MapDocument | null = null;
  private outlineTitles = new Map<string, string>();
  private outlineSample = false;
  private settingTab!: VisualAgentMapSettingTab;
  private detailsLeaf: WorkspaceLeaf | null = null;
  private detailsPath: string | null = null;
  private ribbonIcon: HTMLElement | null = null;
  private coffeeRibbonIcon: HTMLElement | null = null;
  private localizedCommands: { command: Command; key: TranslationKey }[] = [];
  private queue: Promise<void> = Promise.resolve();
  private writing = 0;
  private externalReconcileTimer: number | null = null;
  private readonly externalReconcilePaths = new Set<string>();
  private firstInstallSamplePending = false;
  private workspaceRecoveryCandidates: string[] = [];
  languageSwitchPending = false;
  recordFailure(context: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    this.logs.appendLog("error", `${context}：${message}`);
    return message;
  }
  /**
   * Runs a write after every earlier one. Views re-read the map and its notes afterwards unless the caller states the
   * write only touches the viewport (`sync: false`), which changes nothing another view could need to reload.
   */
  async mutate(work: () => Promise<void>, options: { sync?: boolean } = {}): Promise<void> {
    const result = this.queue.then(async () => {
      this.writing++;
      try {
        await work();
        if (options.sync !== false) for (const view of this.views()) await view.synchronize();
      } finally {
        this.writing--;
      }
    });
    this.queue = result.catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      this.logs.appendLog("error", t("log.operation_failed_0", message));
      console.error("Visual Agent Map", error);
      new Notice(message);
    });
    return result;
  }
  /** Fire-and-forget mutation for event and command handlers; mutate() has already logged any failure. */
  runMutation(work: () => Promise<void>): void {
    this.mutate(work).catch(() => {
      /* Logged by mutate(). */
    });
  }
  views(): VisualAgentMapView[] {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE)
      .map(leaf => leaf.view)
      .filter((view): view is VisualAgentMapView => view instanceof VisualAgentMapView);
  }
  /** A map view passes itself as `source`; only the outline's source view may update it, so background tabs never win. */
  syncOutline(map: MapDocument | null, notes: Map<string, Note>, sample = false, source?: VisualAgentMapView): void {
    if (source) {
      if (this.outlineSourceView && this.outlineSourceView !== source) return;
      this.outlineSourceView = source;
    }
    const titles = new Map([...notes].map(([id, note]) => [id, note.title]));
    this.outlineMap = map;
    this.outlineTitles = titles;
    this.outlineSample = sample;
    for (const leaf of this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE))
      if (leaf.view instanceof OutlineView) {
        if (!this.coffeeOutlineActive) leaf.view.setMap(map, titles, sample);
      }
  }
  /** Marks the active outline row without rebuilding the outline. */
  setOutlineActive(path: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE))
      if (leaf.view instanceof OutlineView) leaf.view.setActive(path);
  }
  syncCoffeeOutline(view?: CoffeeTablesView): void {
    this.coffeeOutlineSource = view ?? null;
    this.coffeeOutlineActive = !!view;
    for (const leaf of this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE))
      if (leaf.view instanceof OutlineView) {
        leaf.view.setCoffeeOutline(
          this.coffeeOutlineSource?.outlineSnapshot() ?? null,
          this.coffeeOutlineActive,
          id => this.coffeeOutlineSource?.locateSegment(id) ?? false,
          () => {
            void this.coffeeOutlineSource?.confirmFillSummaries();
          }
        );
        if (!this.coffeeOutlineActive) leaf.view.setMap(this.outlineMap, this.outlineTitles, this.outlineSample);
      }
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
  isCoffeeOutlineSource(view: CoffeeTablesView): boolean {
    return this.coffeeOutlineSource === view;
  }
  refreshCoffeeOutline(view: CoffeeTablesView): void {
    if (this.coffeeOutlineSource !== view) return;
    for (const leaf of this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE))
      if (leaf.view instanceof OutlineView)
        leaf.view.setCoffeeOutline(
          view.outlineSnapshot(),
          true,
          id => view.locateSegment(id),
          () => {
            void view.confirmFillSummaries();
          }
        );
  }
  /** Opens the share dialog for a map view (the active one by default), or says why this map cannot be shared. */
  openShare(source?: VisualAgentMapView): void {
    const view = source ?? this.app.workspace.getActiveViewOfType(VisualAgentMapView) ?? this.views()[0];
    const snapshot = view?.shareSnapshot();
    if (!snapshot || snapshot === "none") return void new Notice(t("share.unavailable_no_map"));
    if (snapshot === "sample") return void new Notice(t("share.unavailable_sample"));
    if (snapshot === "aim") return void new Notice(t("share.unavailable_aim"));
    if (snapshot === "empty") return void new Notice(t("share.unavailable_empty"));
    new ShareModal(this.app, {
      source: snapshot,
      vamVersion: this.manifest.version || "0.0.0",
      language: this.settings.language,
      translation: {
        service: this.shareTranslate,
        cache: this.shareTranslationCache,
        dom: obsidianTranslateDom(),
        models: () => this.availableModels(),
        modelLabel: model => this.modelLabel(model),
        defaultModel: () => this.settings.cliModel,
        reasoning: () => normalizeReasoningLevel(this.settings.cliReasoning),
        confirmAiUsage: (model, run) => this.confirmAiUsage(model, run)
      }
    }).open();
  }
  async activateOutline(source?: VisualAgentMapView): Promise<void> {
    const activeCoffeeView = this.app.workspace.getActiveViewOfType(CoffeeTablesView);
    if (activeCoffeeView) this.syncCoffeeOutline(activeCoffeeView);
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE)[0] ?? null;
    if (!leaf) leaf = this.app.workspace.getLeftLeaf(true);
    if (!leaf) throw new Error(t("ui.could_not_open_the_left_sidebar"));
    await leaf.setViewState({ type: OUTLINE_VIEW_TYPE, active: true });
    this.syncCoffeeOutline(this.coffeeOutlineSource ?? undefined);
    const mapView =
      source ?? this.app.workspace.getActiveViewOfType(VisualAgentMapView) ?? this.outlineSourceView ?? this.views()[0];
    if (mapView) this.useOutlineSource(mapView);
    await this.app.workspace.revealLeaf(leaf);
  }
  onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
    this.styleNodeLeaf(leaf);
    if (leaf?.view instanceof OutlineView) return;
    if (leaf?.view instanceof CoffeeTablesView) {
      this.syncCoffeeOutline(leaf.view);
      return;
    }
    this.syncCoffeeOutline();
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
    announceTestOverrides(message => new Notice(message, 0));
    const saved = (await this.loadData()) as Partial<Settings> | null;
    this.settings = settingsFromSaved(saved);
    setUiLanguage(this.settings.language);
    registerInternalMarkerPresentation(this);
    this.mermaidZoom = registerMermaidZoom(this);
    const markdownSelectionAi = new MarkdownSelectionAi(this.app, {
      model: () => this.settings.cliModel,
      autoOpen: () => this.settings.markdownSelectionAiAutoOpen,
      language: selected =>
        languagePromptName(selectionOutputLanguage(this.settings.language, selected), "en", "plain", {
          kind: "selection",
          text: selected
        }),
      translateTarget: () => languagePromptName(this.settings.language, "en", "plain"),
      run: (prepared, model, signal, image, webSearch, generateImage) =>
        this.runConfirmedMarkdownContextAi(prepared, model, signal, image, webSearch, generateImage),
      saveImage: (dataUrl, notePath, name) => this.saveGeneratedImage(dataUrl, notePath, name)
    });
    this.addChild(markdownSelectionAi);
    // Tag reading-view blocks with their source lines so an action on a rendered image finds its embed.
    this.registerMarkdownPostProcessor((element, context) => {
      const section = context.getSectionInfo(element);
      if (!section || !element.querySelector("img, .internal-embed")) return;
      element.dataset.vamLineStart = String(section.lineStart);
      element.dataset.vamLineEnd = String(section.lineEnd);
    });
    this.localizedCommands.push({
      command: this.addCommand({
        id: "markdown-selection-ai",
        name: t("ui.context_ai_open"),
        checkCallback: checking => markdownSelectionAi.openForSelection(checking)
      }),
      key: "ui.context_ai_open"
    });
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
    this.repo = new Repository(this.app, this.settings);
    this.repo.onUnreadableMaps = failures => this.reportUnreadableMaps(failures);
    const initialize = (
      this.settings.migrated
        ? Promise.resolve()
        : this.repo.migrate().then(async () => {
            await this.repo.rebuildDerivedData();
            this.settings.migrated = true;
          })
    ).then(async () => {
      if (!saved) {
        if (this.repo.workspaceExists()) {
          this.settings.workspaceInitialized = true;
          await this.saveSettings();
        } else {
          this.workspaceRecoveryCandidates = await this.repo.workspaceCandidates();
          if (!this.workspaceRecoveryCandidates.length) {
            await this.repo.ensureWorkspace();
            this.settings.workspaceInitialized = true;
            this.firstInstallSamplePending = true;
            await this.saveSettings();
          }
        }
      }
      if (this.settings.structureVersion < 2) {
        const count = await this.repo.normalizeGeneratedNoteFilenames();
        this.settings.structureVersion = 2;
        await this.saveSettings();
        if (count) new Notice(t("ui.synced_0_subtopic_filenames_with_their_names", count));
      }
    });
    this.ready = initialize;
    this.register(
      this.core.experiences.register("visual-map", (artifact, beforeWrite) =>
        receiveVisualMapHandoff(artifact, {
          repo: this.repo,
          defaultModel: () => this.settings.cliModel,
          exists: path => !!this.app.vault.getAbstractFileByPath(path),
          mutate: work => this.mutate(work),
          navigate: path => this.activateView(path),
          beforeWrite
        })
      )
    );
    this.registerView(COFFEE_TABLES_VIEW_TYPE, leaf => new CoffeeTablesView(leaf, this));
    this.buildCoffee();
    const openCoffee = (): void => {
      void this.activateCoffeeTables().catch((error: unknown) => new Notice(String(error)));
    };
    const coffeeRibbonIcon = this.addRibbonIcon("coffee", t("ui.open_coffee_tables"), openCoffee);
    this.coffeeRibbonIcon = coffeeRibbonIcon;
    this.addLocalizedCommand("open-coffee-tables", "ui.open_coffee_tables", openCoffee);
    this.registerView(VIEW_TYPE, leaf => new VisualAgentMapView(leaf, this));
    this.registerView(
      OUTLINE_VIEW_TYPE,
      leaf =>
        new OutlineView(leaf, async path => {
          try {
            // The outline moves the map to the topic and opens its note beside it.
            const view = this.views().find(item => item.hasPath(path));
            if (view) {
              // Bring the map tab forward first: a background tab has no size to center in.
              await this.app.workspace.revealLeaf(view.leaf);
              await view.revealPath(path);
            }
            await this.openDetails(this.repo.file(path));
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error));
          }
        })
    );
    this.ribbonIcon = this.addRibbonIcon("brain-circuit", t("ui.open_map"), () => {
      void this.activateView().catch(error => new Notice(String(error)));
    });
    const mapRibbonIcon = this.ribbonIcon;
    this.app.workspace.onLayoutReady(() => this.register(groupRibbonIcons(mapRibbonIcon, coffeeRibbonIcon)));
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
    this.addLocalizedCommand("open-map", "ui.open_map", () => {
      void this.activateView().catch(error => new Notice(String(error)));
    });
    this.addLocalizedCommand(AIM_CREATE_MAP_COMMAND_ID, "ui.aim_create_map", () => {
      void this.activateView()
        .then(() => this.views()[0]?.openAimStart())
        .catch(error => new Notice(String(error)));
    });
    this.addLocalizedCommand("import-outline", "ui.outline_import", () => {
      void this.activateView()
        .then(() => this.views()[0]?.openOutlineImport())
        .catch(error => new Notice(String(error)));
    });
    this.addLocalizedCommand("share-map", "share.command", () => this.openShare());
    this.addLocalizedCommand("open-topic-outline", "ui.open_topic_outline", () => {
      void this.activateOutline().catch(error => new Notice(String(error)));
    });
    this.addLocalizedCommand("rebuild-references", "ui.refresh_vam_data", () => {
      this.runMutation(() => this.fullRebuild());
    });
    this.addLocalizedCommand("normalize-note-filenames", "ui.sync_topic_names_and_filenames", () => {
      this.runMutation(async () => {
        const count = await this.repo.normalizeGeneratedNoteFilenames();
        new Notice(count ? t("ui.synced_0_topic_filenames", count) : t("ui.topic_filenames_are_up_to_date"));
      });
    });
    this.addLocalizedCommand("repair-note-presentation", "ui.repair_topic_note_display", () => {
      this.runMutation(async () => {
        await this.repo.ensureNodePresentation();
        new Notice(t("ui.topic_note_display_repaired"));
      });
    });
    this.addLocalizedCommand("fix-math-formulas", "ui.fix_math_formulas", () => {
      void this.offerFixMathFormulas().catch(
        error => new Notice(error instanceof Error ? error.message : String(error))
      );
    });
    this.addLocalizedCommand("organize-workspace-folders", "ui.organize_workspace_folders", () => {
      void this.offerOrganizeWorkspaceFolders().catch(
        error => new Notice(error instanceof Error ? error.message : String(error))
      );
    });
    this.addLocalizedCommand("open-built-in-sample", "ui.open_the_taiwan_travel_sample", () => {
      void this.activateBuiltInSample(true);
    });
    this.addLocalizedCommand("repair-workspace", "ui.repair_agent_workspace", () => {
      this.runMutation(() => this.repairWorkspace());
    });
    this.addLocalizedCommand("reconnect-workspace", "ui.reconnect_existing_workspace", () => {
      void this.offerWorkspaceReconnect();
    });
    this.addLocalizedCommand("open-prompt-monitor", "ui.prompt_monitor", () =>
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
    this.addLocalizedCommand("open-debug-log", "ui.open_debug_log", () =>
      new DebugLogModal(this.app, this.logs, this.exchanges, () => this.settings.aiExchangeLoggingEnabled).open()
    );
    this.settingTab = new VisualAgentMapSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
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
    // A seamless-research result held for an open note is applied once the note is no longer shown (nothing exists with the setting off).
    this.registerEvent(this.app.workspace.on("layout-change", () => void this.seamless?.flushHeld().catch(() => {})));
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => void this.seamless?.flushHeld().catch(() => {}))
    );
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
    this.registerVaultEvents();
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
      else if (this.firstInstallSamplePending) await this.activateBuiltInSample();
    } catch (error) {
      this.logs.appendLog(
        "warn",
        t("log.initialization_incomplete_0", error instanceof Error ? error.message : String(error))
      );
      console.warn("Visual Agent Map initialization", error);
    }
  }
  registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on("modify", file => {
        if (!this.writing && file instanceof TFile) for (const view of this.views()) view.changed(file);
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", file => {
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
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile) || !this.repo.renameAffectsVam(file, oldPath)) return;
        // A rename event whose path did not change (replayed after a rolled-back move) has nothing to update.
        if (file.path === oldPath) return;
        const external = !this.writing;
        this.runMutation(async () => {
          await this.repo.replaceSourcePath(oldPath, file.path);
          let mapChanged = false;
          for (const { file: mapFile, map } of await this.repo.readableMaps()) {
            if (rebaseMapNotePaths(map, moveNotePath(oldPath, file.path))) {
              await this.repo.saveMap(mapFile.path, map);
              mapChanged = true;
            }
          }
          // Derived references depend only on maps and VAM notes; renaming an unrelated note leaves them unchanged.
          const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
          const vamFile = [frontmatter?.["agent-map-node"], frontmatter?.["visual-agent-map"]].some(
            value => value === true || value === "true"
          );
          if (mapChanged || vamFile) await this.rebuildDerivedData();
          // VAM's own renames already update open views (and must keep their undo history).
          if (external) for (const view of this.views()) await view.renamed(file, oldPath);
        });
      })
    );
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
  consumeFirstInstallSample(): boolean {
    const pending = this.firstInstallSamplePending;
    this.firstInstallSamplePending = false;
    return pending;
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
      mapping = await this.repo.changeMapFolder(
        key,
        path,
        mapPath => this.views().some(view => view.hasActiveAimWork(mapPath)),
        progress.report
      );
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
    const busyOpen = this.views().some(view => plan.moves.some(move => view.hasActiveAimWork(move.mapPath)));
    if (plan.busy.length || busyOpen) {
      new Notice(t("error.organize_aim_busy"));
      return;
    }
    const mind = plan.moves.filter(move => move.kind === "mind").length;
    let description = t(
      "ui.organize_preview_0_1_2_3_4",
      mind,
      plan.moves.length - mind,
      plan.skipped.length,
      this.settings.mindMapsFolder,
      this.settings.aimFolder
    );
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
            void applyMathRepair(this.app.vault, plan)
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
  async repairWorkspace(): Promise<void> {
    await this.repo.ensureWorkspace();
    this.settings.workspaceInitialized = true;
    await this.saveSettings();
    for (const view of this.views()) await view.refreshFromPlugin();
    new Notice(t("ui.agent_workspace_is_ready"));
  }
  async fullRebuild(): Promise<void> {
    // First re-find notes whose path changed behind the maps' back (e.g. a move interrupted by an unload); rebuilding
    // before that would read them as unowned and strip their map ids.
    await this.repo.reconcileMissingNodePaths();
    await this.repo.rebuildDerivedData();
    for (const view of this.views()) await view.refreshFromPlugin();
    new Notice(t("ui.vam_data_has_been_refreshed"));
  }
  /** Builds Coffee Tables storage and manager for the current workspace folder (CoffeeStorage fixes its folder at construction). */
  private buildCoffee(): void {
    const storage = new CoffeeStorage(
      this.app.vault,
      this.settings.workspaceFolder,
      (file, path) => this.app.fileManager.renameFile(file, path),
      file => this.app.fileManager.trashFile(file),
      message => this.logs.appendLog("warn", message)
    );
    this.coffeeStorage = storage;
    // Bound to its own storage so a manager that is still stopping never flushes into a newer workspace folder.
    this.coffeeManager = new CoffeeManager(
      request => this.runCoffeeRequest(request),
      (session, summariesOnly) => storage.save(session, summariesOnly)
    );
  }
  /**
   * After the workspace folder changes: build the new storage and manager first (coffeeManager is never null), re-point
   * open views, then let the old manager finish and flush into the old folder through its own storage.
   */
  private async rebuildCoffee(): Promise<void> {
    const previous = this.coffeeManager;
    this.buildCoffee();
    for (const view of this.coffeeViews()) view.rebindStorage();
    try {
      await previous?.stop();
    } catch (error) {
      this.logs.appendLog(
        "warn",
        `Coffee Tables did not stop cleanly: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
  async offerWorkspaceReconnect(known?: string[]): Promise<void> {
    const candidates = known ?? (await this.repo.workspaceCandidates());
    this.workspaceRecoveryCandidates = [];
    if (!candidates.length) {
      new Notice(t("ui.no_recognizable_existing_vam_workspace_was_found"));
      return;
    }
    new ChoiceModal(
      this.app,
      t("ui.reconnect_existing_workspace"),
      t("ui.choosing_a_workspace_only_reconnects_the_setting_it_does_not"),
      candidates.map(root => ({
        label: root,
        action: () =>
          this.mutate(async () => {
            this.connectWorkspace(root);
            await this.saveSettings();
            await this.rebuildCoffee();
            await this.repo.rebuildDerivedData();
            for (const view of this.views()) await view.refreshFromPlugin();
            new Notice(t("ui.reconnected_workspace_0", root));
          })
      }))
    ).open();
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
  async refreshCoffeeModels(): Promise<string[]> {
    const states = await Promise.all([this.refreshModelDiscovery("codex"), this.refreshModelDiscovery("claude")]);
    for (const state of states)
      if (state.status === "error")
        this.logs.appendLog("warn", `${state.provider} model discovery failed: ${state.error ?? "unknown error"}`);
    return this.availableModels();
  }
  /** Which runtime serves `model`, without starting it. */
  private runtimeIdFor(model: string): AiRuntimeId {
    return this.aiRuntime.runtimeFor(model).capabilities.id;
  }
  coffeeReasoningEfforts(model: string): string[] {
    const fixed = this.aiRuntime.runtimeFor(model).capabilities.fixedReasoningEfforts;
    // A copy: the list belongs to the runtime's shared capabilities.
    if (fixed) return [...fixed];
    return this.modelDiscovery.state("codex").reasoningEfforts?.[model] ?? [];
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
    this.seamless?.abortAll();
    this.aiCalls.stopAll();
    this.abortChartJobs();
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
  async duplicateBuiltInSample(): Promise<string> {
    await this.repo.ensureWorkspace();
    this.settings.workspaceInitialized = true;
    const sample = builtInSample(noteLanguageOf(this.settings.language), false);
    let createdRoot: TFolder | undefined;
    try {
      const path = await this.repo.createMap(sample.map.title, [], folder => {
        createdRoot = folder;
      });
      const root = this.repo.topicRoot(path);
      const map = await this.repo.readMap(path);
      await this.repo.folder(`${root}/Attachments`);
      for (const [name, data] of sample.assets) await this.app.vault.createBinary(`${root}/Attachments/${name}`, data);
      const byOldPath = new Map<string, MapNode>();
      for (const source of sample.map.nodes) {
        const note = sample.notes.get(source.id)!;
        const created = await this.repo.createNote(
          note.title,
          this.settings.cliModel,
          map,
          path,
          source.parentId ? "inherited" : "workspace"
        );
        created.x = source.x;
        created.y = source.y;
        created.collapsed = source.collapsed;
        byOldPath.set(source.path, created);
        map.nodes.push(created);
      }
      for (const source of sample.map.nodes) {
        const created = byOldPath.get(source.path)!,
          note = sample.notes.get(source.id)!;
        created.parentId = source.parentId
          ? byOldPath.get(sample.map.nodes.find(item => item.id === source.parentId)!.path)!.id
          : null;
        await this.repo.updateNote(created.path, {
          summary: note.summary,
          prompt: note.prompt,
          rules: note.rules,
          preview: note.preview,
          detail: note.detail,
          status: note.status,
          sourcePaths: note.sourcePaths.map(sourcePath => byOldPath.get(sourcePath)!.path)
        });
      }
      map.viewport = { ...sample.map.viewport };
      await this.repo.saveMap(path, map);
      await this.repo.rebuildDerivedData(root);
      await this.saveSettings();
      new Notice(t("ui.created_an_editable_copy_of_the_sample"));
      return path;
    } catch (error) {
      if (createdRoot) {
        const root = createdRoot.path;
        try {
          const current = this.app.vault.getAbstractFileByPath(root);
          if (current && current !== createdRoot) throw new Error(t("ui.sample_cleanup_folder_changed"));
          if (current) await this.app.fileManager.trashFile(createdRoot);
        } catch (cleanupError) {
          const message = (value: unknown): string => (value instanceof Error ? value.message : String(value));
          throw new Error(t("ui.sample_cleanup_failed", message(error), root, message(cleanupError)), { cause: error });
        }
      }
      throw error;
    }
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
  }
  onunload(): void {
    // Seamless research: abort every topic and forget held results before the repository goes away.
    this.seamless?.dispose();
    this.seamless = null;
    // Background diagram jobs stop before the repository does, so none can apply a result after the vault is released.
    this.abortChartJobs();
    // In-flight work (a long Obsidian rename, a queued mutation) must not write into the vault after this point.
    this.repo?.dispose();
    void this.coffeeManager?.stop();
    this.coffeeManager = null;
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
  }
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
      try {
        const views = this.coffeeViews();
        const results = await Promise.allSettled(views.map(view => view.refreshForLanguageChange()));
        for (const result of results) if (result.status === "rejected") failures.push(result.reason);
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
    this.coffeeRibbonIcon?.setAttribute("aria-label", translate(this.settings.language, "ui.open_coffee_tables"));
    for (const { command, key } of this.localizedCommands)
      command.name = `Visual Agent Map (VAM): ${translate(this.settings.language, key)}`;
  }
  coffeeViews(): CoffeeTablesView[] {
    return this.app.workspace
      .getLeavesOfType(COFFEE_TABLES_VIEW_TYPE)
      .map(leaf => leaf.view)
      .filter((view): view is CoffeeTablesView => view instanceof CoffeeTablesView);
  }
  async aiReadyForModel(model: string): Promise<boolean> {
    const runtime = this.aiRuntime.runtimeFor(model);
    const readiness = await runtime.readiness(model);
    if (readiness.status === "ready") return true;
    if (readiness.status === "missing") {
      if (runtime.capabilities.id === "claude") this.openClaudeSetupGuide();
      else this.openCodexSetupGuide();
    } else if (readiness.status === "model-unavailable") new Notice(t("ui.current_model_is_unavailable"));
    else if (readiness.error !== undefined) this.logs.appendLog("warn", t("log.codex_not_ready_0", readiness.error));
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
  async confirmAiUsage(model: string, run: () => Promise<void>): Promise<boolean> {
    if (!(await this.aiReadyForModel(model))) return false;
    if (!this.usageNoticeSeen(model)) {
      const provider = this.runtimeIdFor(model);
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
  async rebuildDerivedData(): Promise<void> {
    try {
      await this.repo.rebuildDerivedData();
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
        let tracked = false;
        for (const path of deleted)
          if (await this.repo.isMapNodePath(path)) {
            tracked = true;
            break;
          }
        if (!tracked) return;
        const repaired = await this.repo.reconcileMissingNodePaths();
        if (repaired) await this.rebuildDerivedData();
      }).catch(error => console.error("Visual Agent Map external rename reconciliation", error));
    }, 500);
  }
  /** The node-details sidebar counts as open only while its pane is actually visible. */
  detailsShown(): boolean {
    const split = this.app.workspace.rightSplit;
    if (split.collapsed) return false;
    return this.app.workspace
      .getLeavesOfType("markdown")
      .some(
        leaf =>
          leaf.getRoot() === split &&
          leaf.view instanceof MarkdownView &&
          !!leaf.view.file &&
          this.app.metadataCache.getFileCache(leaf.view.file)?.frontmatter?.["agent-map-node"] === true &&
          leaf.view.containerEl.isShown()
      );
  }
  async openDetails(file: TFile): Promise<void> {
    const markdownLeaves = this.app.workspace.getLeavesOfType("markdown");
    if (
      this.detailsLeaf &&
      (!markdownLeaves.includes(this.detailsLeaf) || this.detailsLeaf.getRoot() !== this.app.workspace.rightSplit)
    )
      this.detailsLeaf = null;
    if (!this.detailsLeaf) {
      this.detailsLeaf =
        markdownLeaves
          .filter(
            leaf =>
              leaf.getRoot() === this.app.workspace.rightSplit &&
              leaf.view instanceof MarkdownView &&
              !!leaf.view.file &&
              this.app.metadataCache.getFileCache(leaf.view.file)?.frontmatter?.["agent-map-node"] === true
          )
          .sort(
            (a, b) => a.view.containerEl.getBoundingClientRect().top - b.view.containerEl.getBoundingClientRect().top
          )[0] ??
        this.app.workspace.getRightLeaf(false) ??
        this.app.workspace.getRightLeaf(true);
    }
    if (!this.detailsLeaf) throw new Error(t("ui.unable_to_open_the_right_details_sidebar"));
    await this.detailsLeaf.openFile(file);
    this.detailsPath = file.path;
    this.styleNodeLeaf(this.detailsLeaf);
    await this.app.workspace.revealLeaf(this.detailsLeaf);
  }
  closeStaleDetails(): void {
    const closed =
      this.detailsLeaf?.view instanceof MarkdownView && this.detailsLeaf.view.file?.path === this.detailsPath;
    if (closed) {
      this.detailsLeaf!.detach();
      this.app.workspace.trigger("file-open", null);
      this.app.workspace.trigger("active-leaf-change", this.app.workspace.getActiveViewOfType(View)?.leaf ?? null);
    }
    this.detailsLeaf = null;
    this.detailsPath = null;
  }
  async activateCoffeeTables(): Promise<void> {
    await this.ready;
    let leaf = this.app.workspace.getLeavesOfType(COFFEE_TABLES_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: COFFEE_TABLES_VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof CoffeeTablesView) this.syncCoffeeOutline(leaf.view);
  }
  async runCoffeeRequest(request: CoffeeRequest): Promise<string> {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter) || !this.manifest.dir)
      throw new Error("Coffee Tables requires the desktop runtime");
    const { session, signal, prompt } = request;
    const effort = effectiveReasoningLevel(
      { title: session.topic, summary: "", detail: "", rules: "", task: "", ancestors: "" },
      normalizeReasoningLevel(session.reasoning)
    );
    return this.aiCalls.runCall(
      { prompt, step: request.step },
      {
        model: session.model,
        effort,
        topic: `Coffee Tables · ${session.topic}`,
        taskName: "coffee",
        signal,
        localCodex: true,
        milestones: false,
        stopped: () => new Error("Coffee Tables request cancelled"),
        task: {
          textOnly: true,
          searchBudget: 0,
          timeoutMs: 15 * 60 * 1000,
          timeoutMessage: t("ui.coffee_generation_timed_out"),
          onText: (text: string): void => request.onText?.(text),
          onSteer: (handler: (text: string) => Promise<void>): void => request.registerIntervention?.(handler)
        }
      },
      raw => raw
    );
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

  /** Writes a generated image where the vault keeps attachments for `notePath`; returns the new file's path. */
  private async saveGeneratedImage(dataUrl: string, notePath: string, name: string): Promise<string> {
    const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(dataUrl);
    if (!match) throw new Error(t("ui.context_ai_image_not_generated"));
    const extension = match[1] === "jpeg" ? "jpg" : match[1];
    const path = await this.app.fileManager.getAvailablePathForAttachment(`${name}.${extension}`, notePath);
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
  /** The seamless research flow (see experiences/visual-map/seamless-research.ts). Callers check `settings.seamlessResearch` first; `research()` refuses when it is off. */
  seamlessResearchService(): SeamlessResearch {
    this.seamless ??= new SeamlessResearch({
      enabled: () => this.settings.seamlessResearch,
      repo: {
        readNote: path => this.repo.readNote(path),
        updateNote: (path, patch) => this.repo.updateNote(path, patch)
      },
      mutate: work => this.mutate(work),
      askModel: input => this.runSeamlessPhase1(input),
      runVerify: input => this.runResearchVerify(input),
      runImages: input => this.runResearchImages(input),
      saveImage: (image, notePath, signal, name) => this.saveResearchImage(image.imageUrl, notePath, signal, name),
      removeImage: path => this.removeResearchImage(path),
      isShown: path => this.isNoteShown(path),
      capabilitiesFor: model => this.aiCalls.capabilitiesFor(model),
      defaultModel: () => this.settings.cliModel,
      running: this.running,
      busyElsewhere: path => this.quickExpandPending.has(path) || this.activeTasks.has(path),
      skeletonInstruction: language => skeletonInstruction(language),
      log: message => this.logs.appendLog("info", message),
      isPlaceholderSummary: summary => !summary.trim() || isPlaceholder(summary)
    });
    return this.seamless;
  }
  /** The note is open in a Markdown leaf that is visible right now. */
  isNoteShown(path: string): boolean {
    return this.app.workspace
      .getLeavesOfType("markdown")
      .some(
        leaf => leaf.view instanceof MarkdownView && leaf.view.file?.path === path && leaf.view.containerEl.isShown()
      );
  }
  /**
   * Seamless phase 1: one short Quick call without the web, fast depth, low effort, no images. The page template is not used:
   * the task text asks for a few short sections and a length cap, so the first write lands quickly (phase 2 writes the full
   * page). The caller filters the text before it is written; that filter, not the prompt, is the guarantee.
   */
  private async runSeamlessPhase1(input: SeamlessPhase1Input): Promise<{ summary: string; detail: string }> {
    const note = await this.repo.readNote(input.path);
    const context: TaskContext = {
      title: input.title,
      summary: isPlaceholder(note.summary) ? "" : note.summary,
      rules: "",
      detail: "",
      task: [
        note.prompt || researchTopicTask(input.language, input.title),
        input.instruction,
        ...(input.requirements ? [input.requirements] : [])
      ].join("\n\n"),
      ancestors: input.context,
      mode: "task",
      ...aiModeOptions("quick", "research"),
      researchDepth: "fast",
      visualMode: "off",
      outputLanguage: input.language,
      // No fixed page layout: the skeleton task text carries the short format.
      detailFormat: "adaptive",
      ...(input.toneText ? { toneText: input.toneText } : {}),
      addCharts: false
    };
    const result = await this.askModel(context, input.model, "low", input.signal);
    return { summary: result.summary, detail: result.detail };
  }
  /** Seamless phase 2, text and footnotes: web search only. One more try when the model finished without any web retrieval. */
  async runResearchVerify(input: SeamlessVerifyInput): Promise<ResearchVerifyResult> {
    const prepared = prepareStep(researchVerifyStep, {
      topic: input.title,
      context: input.context,
      skeleton: input.skeleton,
      language: input.language,
      ...(input.requirements ? { requirements: input.requirements } : {}),
      ...(input.toneText ? { toneText: input.toneText } : {}),
      ...(input.structure ? { structure: input.structure } : {})
    });
    return this.runSeamlessWebCall(prepared, input, "research-verify", 8, true);
  }
  /** Seamless phase 2, images: a separate web call beside runResearchVerify. No retry; the caller decides what a failure means. */
  async runResearchImages(input: SeamlessImagesInput): Promise<ResearchImagesResult> {
    const prepared = prepareStep(researchImagesStep, { topic: input.title, context: input.context });
    return this.runSeamlessWebCall(prepared, input, "research-images", 6, false);
  }
  private async runSeamlessWebCall<Input, Output>(
    prepared: PreparedStep<Input, Output>,
    input: { title: string; model: string; reasoning?: unknown; signal: AbortSignal },
    taskName: string,
    searchBudget: number,
    retryWithoutSearch: boolean
  ): Promise<Output> {
    const cancelled = (): Error => Object.assign(new Error(t("ui.ai_task_cancelled")), { name: "AbortError" });
    for (let attempt = 1; ; attempt++) {
      try {
        this.aiCalls.capabilitiesFor(input.model);
        // Fail before anything is registered or logged when there is no plugin directory (not desktop Obsidian).
        this.pluginDirectory();
        const effort = effectiveReasoningLevel(
          { title: input.title, summary: "", detail: "", rules: "", task: prepared.prompt, ancestors: "" },
          normalizeReasoningLevel(input.reasoning ?? this.settings.cliReasoning)
        );
        return await this.aiCalls.run(
          prepared,
          {
            model: input.model,
            effort,
            topic: input.title,
            taskName,
            signal: input.signal,
            localCodex: false,
            stopped: cancelled,
            task: { textOnly: false, webSearchOnly: true, generateImage: false, searchBudget }
          },
          (raw, exchange) => {
            if (exchange.signal.aborted) throw cancelled();
            const value = prepared.parse(raw);
            exchange.parsed();
            return value;
          }
        );
      } catch (error) {
        if (!retryWithoutSearch || attempt >= 2 || input.signal.aborted || !isSearchNotPerformed(error)) throw error;
      }
    }
  }
  /**
   * Saves one researched image as a local copy next to `notePath`'s attachments. https only; the bytes must be png, jpeg, gif or
   * webp (checked by magic bytes, not by name or content type) and at most 10 MB. Every hop (the address and each redirect) must
   * be a public host: all DNS answers are checked and the connection is pinned to the checked address. Returns the Vault path,
   * or undefined when the run was stopped; anything else that is wrong throws, and the caller drops that one image.
   */
  async saveResearchImage(
    url: string,
    notePath: string,
    signal: AbortSignal,
    name = "research-image"
  ): Promise<string | undefined> {
    const safeUrl = normalizeHttpsUrl(url);
    if (!safeUrl) throw new Error("image address is not allowed");
    if (signal.aborted) return undefined;
    const bytes = await fetchPublicImage(safeUrl, await nodeImageFetchDeps(signal));
    if (!bytes || signal.aborted) return undefined;
    const checked = checkImageBytes(bytes);
    if ("rejected" in checked) throw new Error(`image rejected: ${checked.rejected}`);
    const extension = checked.kind === "jpeg" ? "jpg" : checked.kind;
    const path = await this.app.fileManager.getAvailablePathForAttachment(`${name}.${extension}`, notePath);
    await this.app.vault.createBinary(
      path,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    );
    return path;
  }
  /** Deletes a copy saved by saveResearchImage when its result was discarded. Only a file in the Vault is touched; a missing file is fine. */
  async removeResearchImage(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.fileManager.trashFile(file);
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
      normalizeReasoningLevel(this.settings.cliReasoning)
    );
    return this.aiCalls.run(
      prepared,
      {
        model,
        effort,
        topic: "Markdown selection",
        taskName: "markdown-context",
        signal,
        localCodex: !webSearch,
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
  async openCoffeeHandoff(session: CoffeeSession, sourcePath: string, insightId?: string): Promise<void> {
    try {
      if (!this.coffeeStorage) throw new Error("Coffee storage is not ready");
      await openCoffeeResearchHandoff(this, this.coffeeStorage, session, sourcePath, insightId);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error));
    }
  }
  async openResearchMap(path: string): Promise<void> {
    await this.activateView(path);
  }
  private async activateView(path?: string): Promise<void> {
    await this.ready;
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE,
      active: true,
      state: path ? { file: path } : leaf.view instanceof VisualAgentMapView ? leaf.view.getState() : {}
    });
    await this.app.workspace.revealLeaf(leaf);
  }
  private async activateBuiltInSample(forceTour = false): Promise<void> {
    await this.ready;
    this.firstInstallSamplePending = false;
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true, state: { sample: BUILTIN_SAMPLE_ID } });
    if (forceTour && leaf.view instanceof VisualAgentMapView) await leaf.view.openBuiltInSample(true);
    await this.app.workspace.revealLeaf(leaf);
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
        schema: responseSchema,
        webSearch
      });
    } catch {
      /* Pre-starting is an optimisation: the run starts the process itself. */
    }
  }
  /**
   * Starts an idle Claude CLI for a step that has not been sent yet (the relevance panel just opened), with the very
   * command the step will use: its schema, the effort {@link stepEffort} gives, no web search. No model call happens.
   */
  prewarmClaudeStep(model: string, reasoning: ReasoningLevel, schema: unknown): void {
    if (this.unloaded) return;
    try {
      this.aiCalls.prewarm(model, { effort: stepEffort(reasoning), schema, webSearch: false });
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
    for (const [key, controller] of [...this.chartJobs])
      if (path === undefined || key === path) {
        controller.abort();
        this.chartJobs.delete(key);
        this.endChartProgress(key);
        // A queued job never starts; a running one frees its slot when it settles.
        const queued = this.chartQueue.findIndex(item => item.controller === controller);
        if (queued >= 0) this.chartQueue.splice(queued, 1);
      }
  }
  private endChartProgress(path: string): void {
    const id = this.chartProgressIds.get(path);
    if (id === undefined) return;
    this.chartProgressIds.delete(path);
    this.researchProgress.end(path, id);
  }
  private pumpChartQueue(): void {
    while (this.chartRunning < CHART_JOB_LIMIT && this.chartQueue.length) {
      this.chartRunning++;
      this.chartQueue.shift()!.start();
    }
  }
  /**
   * Runs the chart step in the background for a note that was just written. It never blocks or fails the research:
   * a failure, Stop, a stale note or unload leaves the note as written (the chart exchange is marked failed with the
   * reason). `apply` runs in the mutation queue and returns false when the note no longer equals its snapshot at
   * write time or is running again; only then are the diagrams not applied.
   */
  addChartsAfterWrite(job: {
    path: string;
    context: TaskContext;
    /** The detail exactly as written to the note. */
    detail: string;
    countIssues?: AiResult["formatIssues"];
    model: string;
    apply: (detail: string) => Promise<boolean>;
  }): void {
    // After unload the repository is released: no chart job may start.
    if (this.repo?.isDisposed?.()) return;
    if (!this.aiTasks.chartEligible(job.context) || !job.detail.trim()) return;
    this.abortChartJobs(job.path);
    const controller = new AbortController();
    this.chartJobs.set(job.path, controller);
    const progressId = `charts-${++this.chartProgressSeq}`;
    this.chartProgressIds.set(job.path, progressId);
    this.researchProgress.begin(job.path, progressId, Date.now());
    this.researchProgress.stage(job.path, progressId, "charts", Date.now());
    let exchangeId = "";
    const run = async (): Promise<void> => {
      try {
        const detail = await this.aiTasks.chartDetail({
          input: job.context,
          detail: job.detail,
          countIssues: job.countIssues,
          model: job.model,
          signal: controller.signal,
          onExchange: id => {
            exchangeId = id;
          }
        });
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (detail === job.detail) return;
        let applied = false;
        await this.mutate(async () => {
          applied = !controller.signal.aborted && (await job.apply(detail));
        });
        if (!applied) this.aiTasks.failExchange(exchangeId, t("log.chart_stale_not_applied"));
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError"))
          this.aiTasks.failExchange(exchangeId, t("log.chart_stopped_not_applied"));
        else {
          console.warn("Visual Agent Map chart step", error);
          this.aiTasks.failExchange(exchangeId, t("log.chart_not_added_0", "apply_error"));
        }
      } finally {
        if (this.chartJobs.get(job.path) === controller) this.chartJobs.delete(job.path);
        if (this.chartProgressIds.get(job.path) === progressId) this.endChartProgress(job.path);
        this.chartRunning--;
        this.pumpChartQueue();
      }
    };
    this.chartQueue.push({
      controller,
      start: () => {
        void run();
      }
    });
    this.pumpChartQueue();
  }
  /** The chart step for a finished AIM conclusion; the setting is checked inside, so off returns the detail untouched. */
  async addAimDiagrams(request: {
    title: string;
    detail: string;
    language: ContentLanguage;
    model: string;
    signal?: AbortSignal;
    onStart?: () => void;
  }): Promise<string> {
    return this.aiTasks.addDiagramsToDetail(request);
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

/** Node-backed deps for fetchPublicImage (desktop only). Fails closed when Node networking is missing; never falls back to requestUrl, which follows redirects unseen. */
async function nodeImageFetchDeps(signal: AbortSignal): Promise<ImageFetchDeps> {
  if (typeof dns?.lookup !== "function" || typeof https?.request !== "function")
    throw new Error("image download unavailable");
  return {
    signal,
    lookup: async hostname => {
      const answers = await dns.lookup(hostname, { all: true, verbatim: true });
      return answers.map(answer => ({ address: answer.address, family: answer.family === 6 ? 6 : 4 }));
    },
    get: (request, requestSignal) =>
      new Promise((resolve, reject) => {
        const isIp = request.hostname.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(request.hostname);
        const host = request.hostname.replace(/^\[|\]$/g, "");
        let settled = false;
        const chunks: Uint8Array[] = [];
        let total = 0;
        const req = https.request({
          protocol: "https:",
          host,
          servername: isIp ? undefined : host,
          port: new URL(request.url).port || 443,
          path: new URL(request.url).pathname + new URL(request.url).search,
          method: "GET",
          timeout: 30000,
          lookup: pinnedLookup(request.address, request.family)
        });
        const finish = (error: Error | undefined, value?: { status: number; location?: string; body?: Uint8Array }) => {
          if (settled) return;
          settled = true;
          requestSignal.removeEventListener("abort", onAbort);
          if (error) {
            req.destroy();
            reject(error);
          } else resolve(value as { status: number });
        };
        const onAbort = () => finish(new Error("image download stopped"));
        requestSignal.addEventListener("abort", onAbort, { once: true });
        if (requestSignal.aborted) return onAbort();
        req.on("timeout", () => finish(new Error("image download timed out")));
        req.on("error", () => finish(new Error("image download failed")));
        req.on("response", res => {
          const status = res.statusCode ?? 0;
          const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
          if (status < 200 || status >= 300) {
            res.resume();
            finish(undefined, { status, location });
            req.destroy();
            return;
          }
          res.on("data", (chunk: Uint8Array) => {
            total += chunk.length;
            if (total > MAX_IMAGE_BYTES) {
              res.destroy();
              finish(new Error("image rejected: too-large"));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", () => finish(new Error("image download failed")));
          res.on("aborted", () => finish(new Error("image download failed")));
          res.on("close", () => finish(new Error("image download failed")));
          res.on("end", () => {
            const body = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              body.set(chunk, offset);
              offset += chunk.length;
            }
            finish(undefined, { status, body });
          });
        });
        req.end();
      })
  };
}
