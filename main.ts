import { CoffeeTablesView, COFFEE_TABLES_VIEW_TYPE, COFFEE_TABLES_NAME } from "./experiences/coffee-tables/view";
import type { CoffeeRequest, CoffeeSession } from "./experiences/coffee-tables/types";
import { CoffeeManager } from "./experiences/coffee-tables/engine";
import { CoffeeStorage } from "./experiences/coffee-tables/storage";
import { VisualAgentMapView, VIEW_TYPE, type TaskOptions } from "./experiences/visual-map/view";
import { t, setUiLanguage, translate, initialUiLanguage, type TranslationKey } from "./i18n";
import { FileSystemAdapter, MarkdownView, Notice, Plugin, TFile, type TFolder, View, WorkspaceLeaf, type Command } from "obsidian";
import { ChoiceModal } from "./ui/modals/choice-modal";
import { DebugLogModal } from "./ui/modals/debug-log-modal";
import { AiUsageModal, ClaudeSetupModal, CodexSetupModal, VisualAgentMapSettingTab, CLAUDE_INSTALL_URL } from "./ui/settings-tab";
import { join } from "node:path";
import { type MapDocument, type MapNode } from "./map-model";
import { DEFAULT_SETTINGS, normalizeReasoningLevel, type Note, Repository, type Settings } from "./repository";
import { effectiveReasoningLevel } from "./ai/task-policy";
import type { AiResult, Suggestion, TaskContext } from "./ai/types";
import { clampPreviewScale, legacyPreviewScale } from "./ui/preview-utils";
import { BUILTIN_SAMPLE_ID, builtInSample } from "./builtin-sample";
import { debugLog, LogManager } from "./log-manager";
import { AiExchangeLog } from "./ai-exchange-log";
import { PendingSuggestions } from "./pending-suggestions";
import { OutlineView, OUTLINE_VIEW_TYPE } from "./ui/outline-view";
import { groupRibbonIcons } from "./ui/ribbon-group";
import { randomUUID } from "node:crypto";
import { CodexAppServerRuntime } from "./ai/runtime/codex-app-server";
import { ClaudeCodeCliRuntime } from "./ai/runtime/claude-code-cli";
import { CLAUDE_MODEL_CHOICES, providerForModel, providerModelId } from "./ai/providers/provider";
import { ThinkingCore } from "./core/thinking-core";
import { AiRuntimeService } from "./core/ai-runtime-service";
import { ModelDiscovery, type ModelDiscoveryState } from "./core/model-discovery";
import { ShallowExpansionCoordinator, type ExpansionBatchState } from "./experiences/visual-map/expansion-batch";
import { AiTaskService } from "./core/ai-task-service";
import { ReframingService, providerReframeRunner } from "./core/reframing-service";
import { createVisualMapHandoffHandler } from "./experiences/visual-map/handoff";
import { openCoffeeResearchHandoff } from "./experiences/coffee-tables/handoff-modal";
import { MarkdownSelectionAi } from "./experiences/markdown-context/selection-ai";

export { buildPreparedTaskContext } from "./ai/context-builder";
export { extractJsonObject } from "./core/ai-task-service";
export { executableCandidates } from "./core/ai-runtime-service";
export { canonicalDetail, visualReferencesMarkdown } from "./ai/result-utils";
export { NextStepModal, VisualAgentMapView } from "./experiences/visual-map/view";
export { VisualAgentMapSettingTab } from "./ui/settings-tab";
export { firstMarkdownImage, firstMarkdownTable, markdownImages } from "./ui/preview-utils";
export type { AiRunMetrics, PreparedTaskContext } from "./ai/types";
export default class VisualAgentMapPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  repo!: Repository;
  ready: Promise<void> = Promise.resolve();
  readonly running = new Set<string>();
  readonly quickExpandPending = new Set<string>();
  readonly quickExpandFailures = new Map<string, string>();
  readonly activeTasks = new Map<string, AbortController>();
  readonly expansionBatches = new Map<string, ExpansionBatchState>();
  readonly expansionCoordinator = new ShallowExpansionCoordinator(this.activeTasks, this.expansionBatches);
  pendingSuggestions: Map<string, Suggestion[]> = new Map();
  readonly pendingResearchOptions = new Map<string, TaskOptions>();
  readonly logs: LogManager = debugLog;
  readonly aiRuntime = new AiRuntimeService({
    codexPath: () => this.settings.codexPath,
    claudePath: () => this.settings.claudePath,
    clientVersion: () => this.manifest.version || "0.0.0",
    onLog: (level, message) => this.logs.appendLog(level, message)
  });
  private readonly aiTaskOptions = {
    pluginDirectory: () => this.pluginDirectory(),
    language: () => this.settings.language,
    defaultReasoning: () => this.settings.cliReasoning,
    exchangeLoggingEnabled: () => this.settings.aiExchangeLoggingEnabled,
    exchanges: () => this.exchanges,
    codexRuntime: (directory: string, local: boolean) => this.runtime(directory, local),
    claudeRuntime: (directory: string) => this.claudeCli(directory)
  };
  readonly aiTasks = new AiTaskService(this.aiTaskOptions);
  readonly core = new ThinkingCore(this.aiRuntime, this.aiTasks, new ReframingService(providerReframeRunner(this.aiTaskOptions, this.activeTasks)));
  exchanges: AiExchangeLog | null = null;
  readonly modelDiscovery = new ModelDiscovery(() => this.codexDiagnostic().installed, () => this.loadCodexModels(), () => this.claudeDiagnostic().installed);
  coffeeManager: CoffeeManager | null = null;
  coffeeStorage: CoffeeStorage | null = null;
  private coffeeOutlineActive = false;
  private coffeeOutlineSource: CoffeeTablesView | null = null;
  private outlineMap: MapDocument | null = null;
  private outlineTitles = new Map<string, string>();
  private outlineSample = false;
  private settingTab!: VisualAgentMapSettingTab;
  private detailsLeaf: WorkspaceLeaf | null = null;
  private detailsPath: string | null = null;
  private ribbonIcon: HTMLElement | null = null;
  private localizedCommands: { command: Command; key: TranslationKey }[] = [];
  private queue: Promise<void> = Promise.resolve();
  private writing = 0;
  private externalReconcileTimer: number | null = null;
  private firstInstallSamplePending = false;
  private workspaceRecoveryCandidates: string[] = [];
  languageSwitchPending = false;
  recordFailure(context: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    this.logs.appendLog("error", `${context}：${message}`);
    return message;
  }
  async mutate(work: () => Promise<void>): Promise<void> {
    const result = this.queue.then(async () => { this.writing++; try { await work(); for (const view of this.views()) await view.synchronize(); } finally { this.writing--; } });
    this.queue = result.catch(error => { const message = error instanceof Error ? error.message : String(error); this.logs.appendLog("error", `操作失敗：${message}`); console.error("Visual Agent Map", error); new Notice(message); });
    return result;
  }
  views(): VisualAgentMapView[] { return this.app.workspace.getLeavesOfType(VIEW_TYPE).map(leaf => leaf.view).filter((view): view is VisualAgentMapView => view instanceof VisualAgentMapView); }
  syncOutline(map: MapDocument | null, notes: Map<string, Note>, sample = false): void {
    const titles = new Map([...notes].map(([id, note]) => [id, note.title]));
    this.outlineMap = map; this.outlineTitles = titles; this.outlineSample = sample;
    for (const leaf of this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE)) if (leaf.view instanceof OutlineView) { if (!this.coffeeOutlineActive) leaf.view.setMap(map, titles, sample); }
  }
  syncCoffeeOutline(view?: CoffeeTablesView): void {
    this.coffeeOutlineSource = view ?? null;
    this.coffeeOutlineActive = !!view;
    for (const leaf of this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE)) if (leaf.view instanceof OutlineView) {
      leaf.view.setCoffeeOutline(this.coffeeOutlineSource?.outlineSnapshot() ?? null, this.coffeeOutlineActive, id => this.coffeeOutlineSource?.locateSegment(id) ?? false, () => { void this.coffeeOutlineSource?.confirmFillSummaries(); });
      if (!this.coffeeOutlineActive) leaf.view.setMap(this.outlineMap, this.outlineTitles, this.outlineSample);
    }
  }
  isCoffeeOutlineSource(view: CoffeeTablesView): boolean { return this.coffeeOutlineSource === view; }
  refreshCoffeeOutline(view: CoffeeTablesView): void {
    if (this.coffeeOutlineSource !== view) return;
    for (const leaf of this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE)) if (leaf.view instanceof OutlineView) leaf.view.setCoffeeOutline(view.outlineSnapshot(), true, id => view.locateSegment(id), () => { void view.confirmFillSummaries(); });
  }
  async activateOutline(): Promise<void> {
    const activeCoffeeView = this.app.workspace.getActiveViewOfType(CoffeeTablesView);
    if (activeCoffeeView) this.syncCoffeeOutline(activeCoffeeView);
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE)[0] ?? null;
    if (!leaf) leaf = this.app.workspace.getLeftLeaf(true);
    if (!leaf) throw new Error(t("ui.could_not_open_the_left_sidebar"));
    await leaf.setViewState({ type: OUTLINE_VIEW_TYPE, active: true });
    this.syncCoffeeOutline(this.coffeeOutlineSource ?? undefined);
    const mapView = this.views()[0];
    if (mapView) mapView.syncOutline();
    await this.app.workspace.revealLeaf(leaf);
  }
  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<Settings> | null;
    const legacy: (Partial<Settings> & { cliPath?: string }) | null = saved;
    this.settings = { ...DEFAULT_SETTINGS, coffeePersonas: Array.isArray(saved?.coffeePersonas) ? saved.coffeePersonas.filter((item: unknown): item is import("./experiences/coffee-tables/types").CoffeePersonaTemplate => !!item && typeof item === "object" && ["id", "identity", "role", "description", "prompt"].every(key => typeof (item as Record<string, unknown>)[key] === "string") && ["experts", "cross-domain", "generalist", "affected"].includes(String((item as Record<string, unknown>).category))) : [], coffeeStyles: Array.isArray(saved?.coffeeStyles) ? saved.coffeeStyles.filter((item: unknown): item is { id: string; name: string; prompt: string } => !!item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" && typeof (item as { name?: unknown }).name === "string" && typeof (item as { prompt?: unknown }).prompt === "string") : [], defaultCoffeeStyleId: typeof saved?.defaultCoffeeStyleId === "string" ? saved.defaultCoffeeStyleId : undefined, language: initialUiLanguage(saved?.language), workspaceFolder: saved?.workspaceFolder || DEFAULT_SETTINGS.workspaceFolder, topicsFolder: saved?.topicsFolder || DEFAULT_SETTINGS.topicsFolder, inboxFolder: saved?.inboxFolder || DEFAULT_SETTINGS.inboxFolder, notesFolder: saved?.notesFolder || DEFAULT_SETTINGS.notesFolder, mapsFolder: saved?.mapsFolder || DEFAULT_SETTINGS.mapsFolder, mapId: saved?.mapId || "default", codexPath: saved?.codexPath || legacy?.cliPath || DEFAULT_SETTINGS.codexPath, claudePath: saved?.claudePath || DEFAULT_SETTINGS.claudePath, cliModel: saved?.cliModel || DEFAULT_SETTINGS.cliModel, cliReasoning: normalizeReasoningLevel(saved?.cliReasoning), previewScale: saved?.previewScale !== undefined ? clampPreviewScale(saved.previewScale) : legacyPreviewScale(saved?.previewSize), models: "", migrated: saved?.migrated === true, structureVersion: saved?.structureVersion ?? (saved ? 1 : DEFAULT_SETTINGS.structureVersion), firstUseNoticeSeen: saved?.firstUseNoticeSeen === true, codexUsageNoticeSeen: saved?.codexUsageNoticeSeen === true, claudeUsageNoticeSeen: saved?.claudeUsageNoticeSeen === true, aiExchangeLoggingEnabled: saved?.aiExchangeLoggingEnabled === true, workspaceInitialized: saved ? saved.workspaceInitialized !== false : false, sampleTourVersionSeen: saved?.sampleTourVersionSeen ?? 0 };
    setUiLanguage(this.settings.language);
    const markdownSelectionAi = new MarkdownSelectionAi(this.app, {
      model: () => this.settings.cliModel,
      language: () => this.settings.language === "zh-TW" ? "Traditional Chinese" : "English",
      run: (prompt, model, signal, image) => this.runConfirmedMarkdownContextAi(prompt, model, signal, image)
    });
    this.addChild(markdownSelectionAi);
    this.addCommand({ id: "markdown-selection-ai", name: t("ui.context_ai_open"), checkCallback: checking => markdownSelectionAi.openForSelection(checking) });
    this.logs.appendLog("info", `Visual Agent Map ${this.manifest.version || "unknown"} 載入`);
    if (this.app.vault.adapter instanceof FileSystemAdapter && this.manifest.dir) {
      const pluginDirectory = join(this.app.vault.adapter.getBasePath(), this.manifest.dir);
      this.exchanges = new AiExchangeLog(join(pluginDirectory, "ai-exchanges.json"), error => this.logs.appendLog("error", `AI 往返紀錄儲存失敗：${error instanceof Error ? error.message : String(error)}`));
      await this.exchanges.load();
      this.pendingSuggestions = new PendingSuggestions(join(pluginDirectory, "pending-suggestions.json"), error => this.logs.appendLog("error", `待確認建議儲存失敗：${error instanceof Error ? error.message : String(error)}`));
      await (this.pendingSuggestions as PendingSuggestions).load();
    }
    this.repo = new Repository(this.app, this.settings);
    const initialize = (this.settings.migrated ? Promise.resolve() : this.repo.migrate().then(async () => { await this.repo.rebuildDerivedData(); this.settings.migrated = true; })).then(async () => {
      if (!saved) {
        if (this.repo.workspaceExists()) { this.settings.workspaceInitialized = true; await this.saveSettings(); }
        else {
          this.workspaceRecoveryCandidates = await this.repo.workspaceCandidates();
          if (!this.workspaceRecoveryCandidates.length) { await this.repo.ensureWorkspace(); this.settings.workspaceInitialized = true; this.firstInstallSamplePending = true; await this.saveSettings(); }
        }
      }
      if (this.settings.structureVersion < 2) {
        const count = await this.repo.normalizeGeneratedNoteFilenames();
        this.settings.structureVersion = 2; await this.saveSettings();
        if (count) new Notice(t("ui.synced_0_subtopic_filenames_with_their_names", count));
      }
    });
    this.ready = initialize;
    this.register(this.core.experiences.register("visual-map", createVisualMapHandoffHandler({
      repo: this.repo,
      defaultModel: () => this.settings.cliModel,
      exists: path => !!this.app.vault.getAbstractFileByPath(path),
      mutate: work => this.mutate(work),
      navigate: path => this.activateView(path)
    })));
    this.registerView(COFFEE_TABLES_VIEW_TYPE, leaf => new CoffeeTablesView(leaf, this));
    this.coffeeStorage = new CoffeeStorage(this.app.vault, this.settings.workspaceFolder, (file, path) => this.app.fileManager.renameFile(file, path), file => this.app.fileManager.trashFile(file));
    this.coffeeManager = new CoffeeManager(request => this.runCoffeeRequest(request), (session, summariesOnly) => this.coffeeStorage!.save(session, summariesOnly), sessionId => this.coffeeStorage!.load(sessionId));
    const openCoffee = (): void => { void this.activateCoffeeTables().catch((error: unknown) => new Notice(String(error))); };
    const coffeeRibbonIcon = this.addRibbonIcon("coffee", `Open ${COFFEE_TABLES_NAME}`, openCoffee);
    this.addCommand({ id: "open-coffee-tables", name: `Open ${COFFEE_TABLES_NAME}`, callback: openCoffee });
    this.registerView(VIEW_TYPE, leaf => new VisualAgentMapView(leaf, this));
    this.registerView(OUTLINE_VIEW_TYPE, leaf => new OutlineView(leaf, async path => {
      try { await this.openDetails(this.repo.file(path)); }
      catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
    }));
    this.ribbonIcon = this.addRibbonIcon("brain-circuit", t("ui.open_map"), () => { void this.activateView().catch(error => new Notice(String(error))); });
    const mapRibbonIcon = this.ribbonIcon;
    this.app.workspace.onLayoutReady(() => this.register(groupRibbonIcons(mapRibbonIcon, coffeeRibbonIcon)));
    this.addLocalizedCommand("open-map", "ui.open_map", () => { void this.activateView().catch(error => new Notice(String(error))); });
    this.addLocalizedCommand("open-topic-outline", "ui.open_topic_outline", () => { void this.activateOutline().catch(error => new Notice(String(error))); });
    this.addLocalizedCommand("rebuild-references", "ui.refresh_vam_data", () => { void this.mutate(() => this.fullRebuild()); });
    this.addLocalizedCommand("normalize-note-filenames", "ui.sync_topic_names_and_filenames", () => { void this.mutate(async () => { const count = await this.repo.normalizeGeneratedNoteFilenames(); new Notice(count ? t("ui.synced_0_topic_filenames", count) : t("ui.topic_filenames_are_up_to_date")); }); });
    this.addLocalizedCommand("repair-note-presentation", "ui.repair_topic_note_display", () => { void this.mutate(async () => { await this.repo.ensureNodePresentation(); new Notice(t("ui.topic_note_display_repaired")); }); });
    this.addLocalizedCommand("open-built-in-sample", "ui.open_the_taiwan_travel_sample", () => { void this.activateBuiltInSample(true); });
    this.addLocalizedCommand("repair-workspace", "ui.repair_agent_workspace", () => { void this.mutate(() => this.repairWorkspace()); });
    this.addLocalizedCommand("reconnect-workspace", "ui.reconnect_existing_workspace", () => { void this.offerWorkspaceReconnect(); });
    this.addLocalizedCommand("open-debug-log", "ui.open_debug_log", () => new DebugLogModal(this.app, this.logs, this.exchanges, () => this.settings.aiExchangeLoggingEnabled).open());
    this.settingTab = new VisualAgentMapSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => { if (file instanceof TFile && this.isMap(file)) menu.addItem(item => item.setTitle(t("ui.open_as_mind_map")).setIcon("brain-circuit").onClick(() => { void this.activateView(file.path); })); }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
      this.styleNodeLeaf(leaf);
      if (leaf?.view instanceof OutlineView) return;
      if (leaf?.view instanceof CoffeeTablesView) { this.syncCoffeeOutline(leaf.view); return; }
      this.syncCoffeeOutline();
      if (!(leaf?.view instanceof MarkdownView) || !leaf.view.file || !this.isMap(leaf.view.file)) return;
      const path = leaf.view.file.path;
      void leaf.setViewState({ type: VIEW_TYPE, state: { file: path }, active: true }).catch(error => new Notice(error instanceof Error ? error.message : String(error)));
    }));
    this.registerEvent(this.app.workspace.on("file-open", file => {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) this.styleNodeLeaf(leaf);
      for (const leaf of this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE)) if (leaf.view instanceof OutlineView) leaf.view.setActivePath(file?.path ?? "");
    }));
    this.app.workspace.onLayoutReady(() => {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) this.styleNodeLeaf(leaf);
      void this.ready.then(async () => {
        if (this.workspaceRecoveryCandidates.length) await this.offerWorkspaceReconnect(this.workspaceRecoveryCandidates);
        else if (this.firstInstallSamplePending) await this.activateBuiltInSample();
        await this.activateOutline();
      }).catch(error => { this.logs.appendLog("warn", `初始化未完成：${error instanceof Error ? error.message : String(error)}`); console.warn("Visual Agent Map initialization", error); });
    });
    this.registerEvent(this.app.vault.on("modify", file => { if (!this.writing && file instanceof TFile) for (const view of this.views()) view.changed(file); }));
    this.registerEvent(this.app.vault.on("delete", file => { if (!this.writing && file instanceof TFile) { for (const view of this.views()) view.deleted(file); this.scheduleExternalReconciliation(); if (file.path.startsWith(`${this.settings.mapsFolder}/`) || file.path.startsWith(`${this.settings.topicsFolder}/`) && file.name === "Map.md") void this.mutate(() => this.repo.rebuildDerivedData()); } }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => { if (!this.writing && file instanceof TFile) void this.mutate(async () => {
      await this.repo.replaceSourcePath(oldPath, file.path);
      for (const mapFile of await this.repo.mapFiles()) { const map = await this.repo.readMap(mapFile.path); let changed = false; for (const node of map.nodes) if (node.path === oldPath) { node.path = file.path; changed = true; } if (changed) await this.repo.saveMap(mapFile.path, map); }
      await this.rebuildDerivedData();
      for (const view of this.views()) await view.renamed(file, oldPath);
    }); }));
  }
  consumeFirstInstallSample(): boolean { const pending = this.firstInstallSamplePending; this.firstInstallSamplePending = false; return pending; }
  async repairWorkspace(): Promise<void> { await this.repo.ensureWorkspace(); this.settings.workspaceInitialized = true; await this.saveSettings(); for (const view of this.views()) await view.refreshFromPlugin(); new Notice(t("ui.agent_workspace_is_ready")); }
  async fullRebuild(): Promise<void> { await this.repo.rebuildDerivedData(); for (const view of this.views()) await view.refreshFromPlugin(); new Notice(t("ui.vam_data_has_been_refreshed")); }
  private connectWorkspace(root: string): void {
    this.settings.workspaceFolder = root;
    this.settings.topicsFolder = `${root}/Topics`;
    this.settings.inboxFolder = `${root}/Inbox`;
    this.settings.notesFolder = `${root}/Nodes`;
    this.settings.mapsFolder = `${root}/Maps`;
    this.settings.workspaceInitialized = true;
  }
  async offerWorkspaceReconnect(known?: string[]): Promise<void> {
    const candidates = known ?? await this.repo.workspaceCandidates();
    this.workspaceRecoveryCandidates = [];
    if (!candidates.length) { new Notice(t("ui.no_recognizable_existing_vam_workspace_was_found")); return; }
    new ChoiceModal(this.app, t("ui.reconnect_existing_workspace"), t("ui.choosing_a_workspace_only_reconnects_the_setting_it_does_not"), candidates.map(root => ({ label: root, action: () => this.mutate(async () => {
      this.connectWorkspace(root); await this.saveSettings(); await this.repo.rebuildDerivedData(); for (const view of this.views()) await view.refreshFromPlugin(); new Notice(t("ui.reconnected_workspace_0", root));
    }) }))).open();
  }
  codexDiagnostic(): { executable: string; installed: boolean } { return this.aiRuntime.diagnostic(this.settings.codexPath); }
  claudeDiagnostic(): { executable: string; installed: boolean } { return this.aiRuntime.diagnostic(this.settings.claudePath); }
  modelDiscoveryState(provider: "codex" | "claude"): ModelDiscoveryState { return this.modelDiscovery.state(provider); }
  subscribeModelDiscovery(listener: (state: ModelDiscoveryState) => void): () => void { return this.modelDiscovery.subscribe(listener); }
  async refreshModelDiscovery(provider: "codex" | "claude"): Promise<ModelDiscoveryState> {
    const state = await this.modelDiscovery.refresh(provider);
    if (provider === "codex" && state.status === "ready") { this.settings.models = state.models.join(", "); await this.saveSettings(); }
    return state;
  }
  availableModels(): string[] {
    const codex = this.modelDiscovery.state("codex");
    const models = codex.status === "idle" || codex.status === "loading"
      ? this.settings.models.split(/[\n,]/).map(value => value.trim()).filter(Boolean)
      : [...codex.models];
    if (this.modelDiscovery.state("claude").status === "ready") models.push(...CLAUDE_MODEL_CHOICES.map(choice => choice.id));
    return [...new Set(models)];
  }
  async refreshCoffeeModels(): Promise<string[]> {
    const states = await Promise.all([this.refreshModelDiscovery("codex"), this.refreshModelDiscovery("claude")]);
    for (const state of states) if (state.status === "error") this.logs.appendLog("warn", `${state.provider} model discovery failed: ${state.error ?? "unknown error"}`);
    return this.availableModels();
  }
  coffeeReasoningEfforts(model: string): string[] {
    if (providerForModel(model) === "claude") return ["low", "medium", "high"];
    return this.modelDiscovery.state("codex").reasoningEfforts?.[model] ?? [];
  }
  modelLabel(model: string): string { return CLAUDE_MODEL_CHOICES.find(choice => choice.id === model)?.label ?? `${t("ui.codex_provider_label")} · ${model}`; }
  private usageNoticeSeen(model: string): boolean { return providerForModel(model) === "claude" ? this.settings.claudeUsageNoticeSeen : this.settings.codexUsageNoticeSeen; }
  private async setUsageNoticeSeen(model: string): Promise<void> {
    if (providerForModel(model) === "claude") this.settings.claudeUsageNoticeSeen = true;
    else this.settings.codexUsageNoticeSeen = true;
    await this.saveSettings();
  }
  resetCodexRuntime(): void { this.expansionCoordinator.stopAll(); for (const controller of this.activeTasks.values()) controller.abort(); this.modelDiscovery.invalidate("codex"); this.aiRuntime.reset(); }
  openCodexSetupGuide(): void {
    const diagnostic = this.codexDiagnostic();
    new CodexSetupModal(this.app, diagnostic.executable, () => { void this.recheckCodex(false); }).open();
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
    else if (state.status === "error") new Notice(t("ui.codex_app_server_check_failed_0", this.recordFailure("Codex App Server 重新檢查失敗", state.error ?? "unknown error")));
    else new Notice(t("ui.codex_cli_was_not_found_0_set_the_codex_cli_path_in_vam_sett", diagnostic.executable));
  }
  async duplicateBuiltInSample(): Promise<string> {
    await this.repo.ensureWorkspace(); this.settings.workspaceInitialized = true;
    const sample = builtInSample(this.settings.language, false);
    let createdRoot: TFolder | undefined;
    try {
      const path = await this.repo.createMap(sample.map.title, [], folder => { createdRoot = folder; });
      const root = this.repo.topicRoot(path);
      const map = await this.repo.readMap(path);
      await this.repo.folder(`${root}/Attachments`);
      for (const [name, data] of sample.assets) await this.app.vault.createBinary(`${root}/Attachments/${name}`, data);
      const byOldPath = new Map<string, MapNode>();
      for (const source of sample.map.nodes) {
        const note = sample.notes.get(source.id)!;
        const created = await this.repo.createNote(note.title, this.settings.cliModel, map, path, source.parentId ? "inherited" : "workspace");
        created.x = source.x; created.y = source.y; created.collapsed = source.collapsed; byOldPath.set(source.path, created); map.nodes.push(created);
      }
      for (const source of sample.map.nodes) {
        const created = byOldPath.get(source.path)!, note = sample.notes.get(source.id)!;
        created.parentId = source.parentId ? byOldPath.get(sample.map.nodes.find(item => item.id === source.parentId)!.path)!.id : null;
        await this.repo.updateNote(created.path, { summary: note.summary, prompt: note.prompt, rules: note.rules, preview: note.preview, detail: note.detail, status: note.status, sourcePaths: note.sourcePaths.map(sourcePath => byOldPath.get(sourcePath)!.path) });
      }
      map.viewport = { ...sample.map.viewport }; await this.repo.saveMap(path, map); await this.repo.rebuildDerivedData(root); await this.saveSettings(); new Notice(t("ui.created_an_editable_copy_of_the_sample")); return path;
    } catch (error) {
      if (createdRoot) {
        const root = createdRoot.path;
        try {
          const current = this.app.vault.getAbstractFileByPath(root);
          if (current && current !== createdRoot) throw new Error(t("ui.sample_cleanup_folder_changed"));
          if (current) await this.app.fileManager.trashFile(createdRoot);
        }
        catch (cleanupError) {
          const message = (value: unknown): string => value instanceof Error ? value.message : String(value);
          throw new Error(t("ui.sample_cleanup_failed", message(error), root, message(cleanupError)), { cause: error });
        }
      }
      throw error;
    }
  }
  private isMap(file: TFile): boolean {
    const marker: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.["visual-agent-map"];
    return marker === true || marker === "true" || (file.extension === "md" && (file.path.startsWith(`${this.settings.mapsFolder}/`) || file.path.startsWith(`${this.settings.topicsFolder}/`) && file.name === "Map.md"));
  }
  private isNode(file: TFile): boolean {
    const marker: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.["agent-map-node"];
    return marker === true || marker === "true" || (file.extension === "md" && (file.path.startsWith(`${this.settings.notesFolder}/`) || file.path.startsWith(`${this.settings.topicsFolder}/`) || file.path.startsWith(`${this.settings.inboxFolder}/`)));
  }
  private styleNodeLeaf(leaf: WorkspaceLeaf | null): void {
    if (!(leaf?.view instanceof MarkdownView)) return;
    leaf.view.containerEl.toggleClass("vam-topic-markdown", !!leaf.view.file && this.isNode(leaf.view.file));
  }
  onunload(): void { void this.coffeeManager?.stop(); this.coffeeManager = null; this.resetCodexRuntime(); }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
  async changeLanguage(value: unknown): Promise<boolean> {
    const next = value === "zh-TW" ? "zh-TW" : "en";
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
      try { this.refreshLocalizedEntrypoints(); } catch (error) { failures.push(error); }
      try {
        const views = this.views();
        const results = await Promise.allSettled(views.map(view => view.refreshFromPlugin()));
        for (const result of results) if (result.status === "rejected") failures.push(result.reason);
        if (!views.length) this.syncOutline(null, new Map());
      } catch (error) { failures.push(error); }
      try {
        const views = this.coffeeViews();
        const results = await Promise.allSettled(views.map(view => view.refreshForLanguageChange()));
        for (const result of results) if (result.status === "rejected") failures.push(result.reason);
      } catch (error) { failures.push(error); }
      for (const error of failures) this.recordFailure(t("ui.language_view_refresh_failed"), error);
      new Notice(failures.length ? t("ui.language_change_partial_failure") : t("ui.language_changed_content_preserved"));
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
    for (const { command, key } of this.localizedCommands) command.name = `Visual Agent Map (VAM): ${translate(this.settings.language, key)}`;
  }
  coffeeViews(): CoffeeTablesView[] { return this.app.workspace.getLeavesOfType(COFFEE_TABLES_VIEW_TYPE).map(leaf => leaf.view).filter((view): view is CoffeeTablesView => view instanceof CoffeeTablesView); }
  async aiReadyForModel(model: string): Promise<boolean> {
    if (providerForModel(model) === "claude") {
      const state = await this.refreshModelDiscovery("claude");
      if (state.status === "missing") { this.openClaudeSetupGuide(); return false; }
      return state.status === "ready" && state.models.includes(model);
    }
    if (!this.codexDiagnostic().installed) { this.openCodexSetupGuide(); return false; }
    try {
      const state = await this.refreshModelDiscovery("codex");
      if (state.status === "ready" && state.models.includes(model)) return true;
      if (state.status === "missing") { this.openCodexSetupGuide(); return false; }
      new Notice(t("ui.current_model_is_unavailable"));
    } catch (error) {
      this.logs.appendLog("warn", `Codex App Server 尚未就緒：${error instanceof Error ? error.message : String(error)}`);
    }
    return false;
  }
  async codexReadyForAi(): Promise<boolean> { return this.aiReadyForModel(this.settings.cliModel); }
  openClaudeSetupGuide(): void { new ClaudeSetupModal(this.app, this.claudeDiagnostic().executable, CLAUDE_INSTALL_URL, () => { void this.recheckClaude(); }).open(); }
  async recheckClaude(): Promise<void> {
    const diagnostic = this.claudeDiagnostic();
    const state = await this.refreshModelDiscovery("claude");
    if (!diagnostic.installed) { new Notice(t("ui.claude_cli_was_not_found_follow_the_installation_guide_to_install_it")); return; }
    new Notice(t("ui.claude_cli_found_0", diagnostic.executable));
    if (state.status !== "ready") this.logs.appendLog("warn", `Claude model discovery status: ${state.status}`);
  }
  async confirmAiUsage(model: string, run: () => Promise<void>): Promise<boolean> {
    if (!await this.aiReadyForModel(model)) return false;
    if (!this.usageNoticeSeen(model)) {
      const provider = providerForModel(model);
      const confirmed = await new Promise<boolean>(resolve => new AiUsageModal(this.app, provider, resolve).open());
      if (!confirmed) return false;
      await this.setUsageNoticeSeen(model);
    }
    await run();
    return true;
  }
  async confirmCodexUsage(run: () => Promise<void>): Promise<void> { await this.confirmAiUsage(this.settings.cliModel, run); }
  async rebuildDerivedData(): Promise<void> { try { await this.repo.rebuildDerivedData(); } catch (error) { console.error("Visual Agent Map reference rebuild", error); new Notice(t("ui.map_saved_but_reference_update_failed_0", error instanceof Error ? error.message : String(error))); } }
  private scheduleExternalReconciliation(): void {
    if (this.writing) return;
    if (this.externalReconcileTimer !== null) window.clearTimeout(this.externalReconcileTimer);
    this.externalReconcileTimer = window.setTimeout(() => {
      this.externalReconcileTimer = null;
      void this.mutate(async () => {
        const repaired = await this.repo.reconcileMissingNodePaths();
        if (repaired) await this.rebuildDerivedData();
      }).catch(error => console.error("Visual Agent Map external rename reconciliation", error));
    }, 500);
  }
  async openDetails(file: TFile): Promise<void> {
    const markdownLeaves = this.app.workspace.getLeavesOfType("markdown");
    if (this.detailsLeaf && (!markdownLeaves.includes(this.detailsLeaf) || this.detailsLeaf.getRoot() !== this.app.workspace.rightSplit)) this.detailsLeaf = null;
    if (!this.detailsLeaf) {
      this.detailsLeaf = markdownLeaves
        .filter(leaf => leaf.getRoot() === this.app.workspace.rightSplit && leaf.view instanceof MarkdownView && !!leaf.view.file && this.app.metadataCache.getFileCache(leaf.view.file)?.frontmatter?.["agent-map-node"] === true)
        .sort((a, b) => a.view.containerEl.getBoundingClientRect().top - b.view.containerEl.getBoundingClientRect().top)[0]
        ?? this.app.workspace.getRightLeaf(false)
        ?? this.app.workspace.getRightLeaf(true);
    }
    if (!this.detailsLeaf) throw new Error(t("ui.unable_to_open_the_right_details_sidebar"));
    await this.detailsLeaf.openFile(file);
    this.detailsPath = file.path;
    this.styleNodeLeaf(this.detailsLeaf);
    await this.app.workspace.revealLeaf(this.detailsLeaf);
  }
  closeStaleDetails(): void {
    const closed = this.detailsLeaf?.view instanceof MarkdownView && this.detailsLeaf.view.file?.path === this.detailsPath;
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
    if (!leaf) { leaf = this.app.workspace.getLeaf("tab"); await leaf.setViewState({ type: COFFEE_TABLES_VIEW_TYPE, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof CoffeeTablesView) this.syncCoffeeOutline(leaf.view);
  }
  async runCoffeeRequest(request: CoffeeRequest): Promise<string> {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter) || !this.manifest.dir) throw new Error("Coffee Tables requires the desktop runtime");
    const { session, signal, prompt } = request;
    const directory = join(this.app.vault.adapter.getBasePath(), this.manifest.dir);
    const effort = effectiveReasoningLevel({ title: session.topic, summary: "", detail: "", rules: "", task: "", ancestors: "" }, normalizeReasoningLevel(session.reasoning));
    const exchanges = this.settings.aiExchangeLoggingEnabled ? this.exchanges : null;
    const id = randomUUID();
    const key = `coffee:${id}`; const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    this.activeTasks.set(key, controller);
    exchanges?.begin({ id, startedAt: new Date().toISOString(), topic: `Coffee Tables · ${session.topic}`, mode: "task", model: session.model, effort });
    try {
      const controls = { textOnly: true, signal: controller.signal, searchBudget: 0, timeoutMs: 15 * 60 * 1000, onText: (text: string): void => request.onText?.(text), onSteer: (handler: (text: string) => Promise<void>): void => request.registerIntervention?.(handler), onRequest: (data: unknown): void => { if (this.settings.aiExchangeLoggingEnabled) exchanges?.sent(id, JSON.stringify({ request: data, prompt }, null, 2)); } };
      const raw = providerForModel(session.model) === "claude"
        ? await this.claudeCli(directory).runTask(prompt, providerModelId(session.model), effort, undefined, controls)
        : await this.runtime(directory, true).runTask(prompt, session.model, effort, undefined, controls);
      if (controller.signal.aborted) throw new Error("Coffee Tables request cancelled");
      if (this.settings.aiExchangeLoggingEnabled) { exchanges?.received(id, raw); exchanges?.completed(id); }
      return raw;
    } catch (error) {
      if (this.settings.aiExchangeLoggingEnabled) exchanges?.failed(id, error instanceof Error ? error.message : String(error));
      throw error;
    } finally { signal.removeEventListener("abort", abort); this.activeTasks.delete(key); }
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
      if (context) { context.drawImage(image, 0, 0, canvas.width, canvas.height); return canvas.toDataURL("image/png"); }
    } catch { /* Resolve a Vault attachment or an explicitly selected public image below. */ }
    let bytes: ArrayBuffer;
    const embeddedPath = image.closest(".internal-embed")?.getAttribute("src")?.split("#")[0];
    const view = this.app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view).find(view => view instanceof MarkdownView && view.containerEl.contains(image));
    const file = embeddedPath ? this.app.metadataCache.getFirstLinkpathDest(embeddedPath, view instanceof MarkdownView ? view.file?.path ?? "" : "") : null;
    if (file instanceof TFile) bytes = await this.app.vault.readBinary(file);
    else throw new Error(t("ui.context_ai_image_unavailable"));
    if (signal.aborted) throw new Error(t("ui.ai_task_cancelled"));
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error(t("ui.context_ai_image_unavailable"));
    const buffer = Buffer.from(bytes);
    const mime = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
      : buffer[0] === 255 && buffer[1] === 216 ? "image/jpeg"
      : buffer.subarray(0, 3).toString() === "GIF" ? "image/gif"
      : buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP" ? "image/webp" : "";
    if (!mime) throw new Error(t("ui.context_ai_image_unavailable"));
    return `data:${mime};base64,${buffer.toString("base64")}`;
  }

  private async runConfirmedMarkdownContextAi(prompt: string, model: string, signal: AbortSignal, image?: HTMLImageElement): Promise<string> {
    let result: string | undefined;
    const confirmed = await this.confirmAiUsage(model, async () => { result = await this.runMarkdownContextAi(prompt, model, signal, image); });
    if (!confirmed || result === undefined) throw new Error(t("ui.ai_task_cancelled"));
    return result;
  }
  private async runMarkdownContextAi(prompt: string, model: string, signal: AbortSignal, image?: HTMLImageElement): Promise<string> {
    if (image && providerForModel(model) === "claude") throw new Error(t("ui.context_ai_image_claude"));
    const imageDataUrl = image ? await this.markdownContextImage(image, signal) : undefined;
    if (signal.aborted) throw new Error(t("ui.ai_task_cancelled"));
    const directory = this.pluginDirectory();
    const effort = effectiveReasoningLevel({ title: "Selected Markdown text", summary: "", detail: "", rules: "", task: prompt, ancestors: "" }, normalizeReasoningLevel(this.settings.cliReasoning));
    const exchanges = this.settings.aiExchangeLoggingEnabled ? this.exchanges : null;
    const id = randomUUID();
    const key = `markdown-context:${id}`;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    this.activeTasks.set(key, controller);
    exchanges?.begin({ id, startedAt: new Date().toISOString(), topic: "Markdown selection", mode: "task", model, effort });
    try {
      const controls = {
        textOnly: true,
        imageDataUrl,
        signal: controller.signal,
        searchBudget: 0,
        onRequest: (data: unknown): void => { if (this.settings.aiExchangeLoggingEnabled) exchanges?.sent(id, JSON.stringify({ request: data, prompt }, null, 2)); }
      };
      const raw = providerForModel(model) === "claude"
        ? await this.claudeCli(directory).runTask(prompt, providerModelId(model), effort, undefined, controls)
        : await this.runtime(directory, true).runTask(prompt, model, effort, undefined, controls);
      if (controller.signal.aborted) throw new Error(t("ui.ai_task_cancelled"));
      if (this.settings.aiExchangeLoggingEnabled) { exchanges?.received(id, raw); exchanges?.completed(id); }
      return raw;
    } catch (error) {
      if (this.settings.aiExchangeLoggingEnabled) exchanges?.failed(id, error instanceof Error ? error.message : String(error));
      throw error;
    } finally { signal.removeEventListener("abort", abort); this.activeTasks.delete(key); }
  }
  async openCoffeeHandoff(session: CoffeeSession, sourcePath: string, insightId?: string | string[]): Promise<void> {
    try {
      if (!this.coffeeStorage) throw new Error("Coffee storage is not ready");
      await openCoffeeResearchHandoff(this, this.coffeeStorage, session, sourcePath, insightId);
    } catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
  }
  async openResearchMap(path: string): Promise<void> { await this.activateView(path); }
  private async activateView(path?: string): Promise<void> { await this.ready; let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]; if (!leaf) leaf = this.app.workspace.getLeaf("tab"); await leaf.setViewState({ type: VIEW_TYPE, active: true, state: path ? { file: path } : leaf.view instanceof VisualAgentMapView ? leaf.view.getState() : {} }); await this.app.workspace.revealLeaf(leaf); }
  private async activateBuiltInSample(forceTour = false): Promise<void> {
    await this.ready; this.firstInstallSamplePending = false;
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]; if (!leaf) leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true, state: { sample: BUILTIN_SAMPLE_ID } });
    if (forceTour && leaf.view instanceof VisualAgentMapView) await leaf.view.openBuiltInSample(true);
    await this.app.workspace.revealLeaf(leaf);
  }
  private async loadCodexModels(): Promise<{ models: string[]; reasoningEfforts: Record<string, string[]> }> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter) || !this.manifest.dir) throw new Error("Codex model discovery requires desktop Obsidian");
    const pluginDirectory = join(adapter.getBasePath(), this.manifest.dir);
    const models = await this.runtime(pluginDirectory).listModels();
    return {
      models: models.map(item => item.model),
      reasoningEfforts: Object.fromEntries(models.map(item => [item.model, item.supportedReasoningEfforts.map(effort => effort.reasoningEffort).filter(value => ["low", "medium", "high"].includes(value))]))
    };
  }
  async askModel(context: TaskContext, model: string, reasoning?: unknown, signal?: AbortSignal, onExchange?: (id: string) => void, onRequestAccepted?: () => void): Promise<AiResult> {
    return this.aiTasks.askModel(context, model, reasoning, signal, onExchange, onRequestAccepted);
  }
  private pluginDirectory(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error(t("ui.cli_mode_requires_desktop_obsidian"));
    if (!this.manifest.dir) throw new Error(t("ui.plugin_folder_not_found"));
    return join(adapter.getBasePath(), this.manifest.dir);
  }
  runtime(pluginDirectory: string, local = false): CodexAppServerRuntime { return this.aiRuntime.codex(pluginDirectory, local); }
  private claudeCli(pluginDirectory: string): ClaudeCodeCliRuntime { return this.aiRuntime.claude(pluginDirectory); }

}
