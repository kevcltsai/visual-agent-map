import { CoffeeTablesView, COFFEE_TABLES_VIEW_TYPE, COFFEE_TABLES_NAME } from "./experiences/coffee-tables/view";
import type { CoffeeRequest, CoffeeSession } from "./experiences/coffee-tables/types";
import { CoffeeManager } from "./experiences/coffee-tables/engine";
import { CoffeeStorage } from "./experiences/coffee-tables/storage";
import { VisualAgentMapView, VIEW_TYPE, type TaskOptions, visualGuidance } from "./experiences/visual-map/view";
import { t, setUiLanguage, translate, initialUiLanguage, type TranslationKey } from "./i18n";
import { FileSystemAdapter, MarkdownView, Modal, Notice, Plugin, TFile, type TFolder, View, WorkspaceLeaf, type Command } from "obsidian";
import { packReferenceChunks, referenceBatches, referenceCatalog, resolveReferenceLinks } from "./ai/reference-materials";
import { ChoiceModal } from "./ui/modals/choice-modal";
import { DebugLogModal } from "./ui/modals/debug-log-modal";
import { AiUsageModal, ClaudeSetupModal, CodexSetupModal, VisualAgentMapSettingTab, CLAUDE_INSTALL_URL } from "./ui/settings-tab";
import { join } from "node:path";
import { type MapDocument, type MapNode } from "./map-model";
import { DEFAULT_SETTINGS, normalizeReasoningLevel, type Note, Repository, type Settings } from "./repository";
import { buildPreparedTaskContext } from "./ai/context-builder";
import { effectiveReasoningLevel, researchGuidance, researchLimits } from "./ai/task-policy";
import type { AiResult, Suggestion, TaskContext } from "./ai/types";
import { clampPreviewScale, legacyPreviewScale } from "./ui/preview-utils";
import { BUILTIN_SAMPLE_ID, builtInSample } from "./builtin-sample";
import { debugLog, LogManager } from "./log-manager";
import { AiExchangeLog } from "./ai-exchange-log";
import { PendingSuggestions } from "./pending-suggestions";
import { OutlineView, OUTLINE_VIEW_TYPE } from "./ui/outline-view";
import { groupRibbonIcons } from "./ui/ribbon-group";
import { randomUUID } from "node:crypto";
import responseSchema from "./response-schema.json";
import { CodexAppServerRuntime } from "./ai/runtime/codex-app-server";
import { ClaudeCodeCliRuntime } from "./ai/runtime/claude-code-cli";
import { CLAUDE_MODEL_CHOICES, providerForModel, providerModelId } from "./ai/providers/provider";
import { ThinkingCore } from "./core/thinking-core";
import { AiRuntimeService } from "./core/ai-runtime-service";
import { createThinkingArtifact, type ThinkingArtifact } from "./core/thinking-artifact";

export { buildPreparedTaskContext } from "./ai/context-builder";
export { executableCandidates } from "./core/ai-runtime-service";
export { canonicalDetail, visualReferencesMarkdown } from "./ai/result-utils";
export { NextStepModal, VisualAgentMapView } from "./experiences/visual-map/view";
export { firstMarkdownImage, firstMarkdownTable, markdownImages } from "./ui/preview-utils";
export type { AiRunMetrics, PreparedTaskContext } from "./ai/types";
export function extractJsonObject(raw: string): string {
  const candidates: string[] = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (start < 0) {
      if (character === "{") { start = index; depth = 1; quoted = false; escaped = false; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) { candidates.push(raw.slice(start, index + 1)); start = -1; }
  }
  for (const candidate of candidates.reverse()) {
    try { JSON.parse(candidate); return candidate; }
    catch { /* Continue to an earlier balanced object. */ }
  }
  throw new SyntaxError("Codex 回應中找不到完整 JSON object");
}
export default class VisualAgentMapPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  repo!: Repository;
  ready: Promise<void> = Promise.resolve();
  readonly running = new Set<string>();
  readonly quickExpandPending = new Set<string>();
  readonly quickExpandFailures = new Map<string, string>();
  readonly activeTasks = new Map<string, AbortController>();
  readonly core = new ThinkingCore();
  pendingSuggestions: Map<string, Suggestion[]> = new Map();
  readonly pendingResearchOptions = new Map<string, TaskOptions>();
  readonly logs: LogManager = debugLog;
  readonly aiRuntime = new AiRuntimeService({
    codexPath: () => this.settings.codexPath,
    claudePath: () => this.settings.claudePath,
    clientVersion: () => this.manifest.version || "0.0.0",
    onLog: (level, message) => this.logs.appendLog(level, message)
  });
  exchanges: AiExchangeLog | null = null;
  private coffeeModelEfforts = new Map<string, string[]>();
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
    this.settings = { ...DEFAULT_SETTINGS, coffeeStyles: Array.isArray(saved?.coffeeStyles) ? saved.coffeeStyles.filter((item: unknown): item is { id: string; name: string; prompt: string } => !!item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string" && typeof (item as { name?: unknown }).name === "string" && typeof (item as { prompt?: unknown }).prompt === "string") : [], defaultCoffeeStyleId: typeof saved?.defaultCoffeeStyleId === "string" ? saved.defaultCoffeeStyleId : undefined, language: initialUiLanguage(saved?.language), workspaceFolder: saved?.workspaceFolder || DEFAULT_SETTINGS.workspaceFolder, topicsFolder: saved?.topicsFolder || DEFAULT_SETTINGS.topicsFolder, inboxFolder: saved?.inboxFolder || DEFAULT_SETTINGS.inboxFolder, notesFolder: saved?.notesFolder || DEFAULT_SETTINGS.notesFolder, mapsFolder: saved?.mapsFolder || DEFAULT_SETTINGS.mapsFolder, mapId: saved?.mapId || "default", codexPath: saved?.codexPath || legacy?.cliPath || DEFAULT_SETTINGS.codexPath, claudePath: saved?.claudePath || DEFAULT_SETTINGS.claudePath, cliModel: saved?.cliModel || DEFAULT_SETTINGS.cliModel, cliReasoning: normalizeReasoningLevel(saved?.cliReasoning), previewScale: saved?.previewScale !== undefined ? clampPreviewScale(saved.previewScale) : legacyPreviewScale(saved?.previewSize), models: "", migrated: saved?.migrated === true, structureVersion: saved?.structureVersion ?? (saved ? 1 : DEFAULT_SETTINGS.structureVersion), firstUseNoticeSeen: saved?.firstUseNoticeSeen === true, codexUsageNoticeSeen: saved?.codexUsageNoticeSeen === true, claudeUsageNoticeSeen: saved?.claudeUsageNoticeSeen === true, aiExchangeLoggingEnabled: saved?.aiExchangeLoggingEnabled === true, workspaceInitialized: saved ? saved.workspaceInitialized !== false : false, sampleTourVersionSeen: saved?.sampleTourVersionSeen ?? 0 };
    setUiLanguage(this.settings.language);
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
    this.register(this.core.experiences.register("visual-map", artifact => this.openArtifactInVisualMap(artifact)));
    this.registerView(COFFEE_TABLES_VIEW_TYPE, leaf => new CoffeeTablesView(leaf, this));
    this.coffeeStorage = new CoffeeStorage(this.app.vault, this.settings.workspaceFolder, (file, path) => this.app.fileManager.renameFile(file, path), file => this.app.fileManager.trashFile(file));
    this.coffeeManager = new CoffeeManager(request => this.runCoffeeRequest(request), (session, summariesOnly) => this.coffeeStorage!.save(session, summariesOnly));
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
  availableModels(): string[] {
    const models = this.settings.models.split(/[\n,]/).map(value => value.trim()).filter(Boolean);
    if (this.claudeDiagnostic().installed) models.push(...CLAUDE_MODEL_CHOICES.map(choice => choice.id));
    return [...new Set(models)];
  }
  async refreshCoffeeModels(): Promise<string[]> {
    if (this.codexDiagnostic().installed) {
      try { await this.refreshCodexModels(); }
      catch (error) { this.logs.appendLog("warn", `Coffee Tables 無法載入 Codex 模型：${error instanceof Error ? error.message : String(error)}`); }
    }
    return this.availableModels();
  }
  coffeeReasoningEfforts(model: string): string[] {
    if (providerForModel(model) === "claude") return ["low", "medium", "high"];
    return this.coffeeModelEfforts.get(model) ?? [];
  }
  modelLabel(model: string): string { return CLAUDE_MODEL_CHOICES.find(choice => choice.id === model)?.label ?? `${t("ui.codex_provider_label")} · ${model}`; }
  private usageNoticeSeen(model: string): boolean { return providerForModel(model) === "claude" ? this.settings.claudeUsageNoticeSeen : this.settings.codexUsageNoticeSeen; }
  private async setUsageNoticeSeen(model: string): Promise<void> {
    if (providerForModel(model) === "claude") this.settings.claudeUsageNoticeSeen = true;
    else this.settings.codexUsageNoticeSeen = true;
    await this.saveSettings();
  }
  resetCodexRuntime(): void { for (const controller of this.activeTasks.values()) controller.abort(); this.aiRuntime.reset(); }
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
    try {
      await this.refreshCodexModels(); new Notice(t("ui.codex_app_server_is_ready_0", diagnostic.executable));
    } catch (error) { new Notice(t("ui.codex_app_server_check_failed_0", this.recordFailure("Codex App Server 重新檢查失敗", error))); }
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
      if (!this.claudeDiagnostic().installed) { this.openClaudeSetupGuide(); return false; }
      return true;
    }
    if (!this.codexDiagnostic().installed) { this.openCodexSetupGuide(); return false; }
    if (this.settings.models.trim()) return true;
    try {
      await this.refreshCodexModels();
      if (this.settings.models.trim()) return true;
    } catch (error) {
      this.logs.appendLog("warn", `Codex App Server 尚未就緒：${error instanceof Error ? error.message : String(error)}`);
    }
    this.openCodexSetupGuide(); return false;
  }
  async codexReadyForAi(): Promise<boolean> { return this.aiReadyForModel(this.settings.cliModel); }
  openClaudeSetupGuide(): void { new ClaudeSetupModal(this.app, this.claudeDiagnostic().executable, CLAUDE_INSTALL_URL, () => { void this.recheckClaude(); }).open(); }
  async recheckClaude(): Promise<void> {
    const diagnostic = this.claudeDiagnostic();
    if (!diagnostic.installed) { new Notice(t("ui.claude_cli_was_not_found_follow_the_installation_guide_to_install_it")); return; }
    new Notice(t("ui.claude_cli_found_0", diagnostic.executable));
    this.settingTab?.update();
    for (const view of this.views()) await view.refreshFromPlugin();
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
  async openCoffeeHandoff(session: CoffeeSession, sourcePath: string): Promise<void> {
    const zh = this.settings.language === "zh-TW";
    const modal = new Modal(this.app);
    modal.titleEl.setText(zh ? "帶去 VAM 深入研究" : "Take to VAM for deeper research");
    modal.contentEl.createEl("p", { text: zh ? "編輯要深入研究的問題，並從來源對談開始。" : "Edit the question for deeper research. The source conversation will be linked." });
    const question = modal.contentEl.createEl("textarea", { cls: "ct-handoff-question", attr: { rows: "3", "aria-label": zh ? "研究問題" : "Research question" } });
    question.value = session.topic;
    const create = modal.contentEl.createEl("button", { text: zh ? "建立研究地圖" : "Create research map", cls: "mod-cta" });
    create.addEventListener("click", () => {
      const title = question.value.trim(); if (!title || create.disabled) return;
      create.disabled = true;
      const artifact = createThinkingArtifact({
        id: randomUUID(),
        kind: "question",
        title,
        content: zh ? "Coffee Tables 的模擬對談，內容尚未查證，不代表使用者結論。" : "Simulated Coffee Tables discussion; unverified and not the user's conclusion.",
        origin: { experience: "coffee-tables", sessionId: session.id, path: sourcePath },
        sources: [{ label: "Coffee Tables", path: sourcePath, experience: "coffee-tables", sessionId: session.id }],
        metadata: { model: session.model, reasoning: session.reasoning }
      });
      void this.core.experiences.handoff({ target: "visual-map", artifact })
        .then(() => modal.close())
        .catch((error: unknown) => { create.disabled = false; new Notice(`${String(error)} · ${zh ? "可能已建立部分研究檔案，請先檢查再重試。" : "Some research files may have been created; inspect before retrying."}`); });
    });
    modal.open();
  }
  private async openArtifactInVisualMap(artifact: ThinkingArtifact): Promise<void> {
    await this.mutate(async () => {
      const model = typeof artifact.metadata?.model === "string" ? artifact.metadata.model : this.settings.cliModel;
      const reasoning = normalizeReasoningLevel(artifact.metadata?.reasoning);
      const path = await this.repo.createMap(artifact.title);
      const map = await this.repo.readMap(path);
      const node = await this.repo.createNote(artifact.title, model, map, path, "manual");
      const links = artifact.sources.filter(source => source.path).map(source => `[[${source.path}|${source.label}]]`);
      const detail = [artifact.content, ...links].filter(Boolean).join("\n\n");
      await this.repo.updateNote(node.path, { detail, reasoning });
      map.nodes.push(node);
      await this.repo.saveMap(path, map);
      await this.activateView(path);
    });
  }
  private async activateView(path?: string): Promise<void> { await this.ready; let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]; if (!leaf) leaf = this.app.workspace.getLeaf("tab"); await leaf.setViewState({ type: VIEW_TYPE, active: true, state: path ? { file: path } : leaf.view instanceof VisualAgentMapView ? leaf.view.getState() : {} }); await this.app.workspace.revealLeaf(leaf); }
  private async activateBuiltInSample(forceTour = false): Promise<void> {
    await this.ready; this.firstInstallSamplePending = false;
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]; if (!leaf) leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE, active: true, state: { sample: BUILTIN_SAMPLE_ID } });
    if (forceTour && leaf.view instanceof VisualAgentMapView) await leaf.view.openBuiltInSample(true);
    await this.app.workspace.revealLeaf(leaf);
  }
  private async refreshCodexModels(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter) || !this.manifest.dir) return;
    const pluginDirectory = join(adapter.getBasePath(), this.manifest.dir);
    const models = await this.runtime(pluginDirectory).listModels();
    this.coffeeModelEfforts = new Map(models.map(item => [item.model, item.supportedReasoningEfforts.map(effort => effort.reasoningEffort).filter(value => ["low", "medium", "high"].includes(value))]));
    this.settings.models = models.map(item => item.model).join(", ");
    if (providerForModel(this.settings.cliModel) === "codex" && !models.some(item => item.model === this.settings.cliModel)) this.settings.cliModel = models.find(item => item.model === DEFAULT_SETTINGS.cliModel)?.model || models.find(item => item.isDefault)?.model || models[0]?.model || "";
    await this.saveSettings();
    this.settingTab?.update();
    for (const view of this.views()) await view.refreshFromPlugin();
  }
  async askModel(context: TaskContext, model: string, reasoning?: unknown, signal?: AbortSignal, onExchange?: (id: string) => void): Promise<AiResult> {
    const provider = providerForModel(model);
    if (provider === "claude" && !CLAUDE_MODEL_CHOICES.some(choice => choice.id === model)) throw new Error(t("ui.claude_model_is_not_supported_0", model));
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error(t("ui.cli_mode_requires_desktop_obsidian"));
    if (!this.manifest.dir) throw new Error(t("ui.plugin_folder_not_found"));

    const referenceGroups = context.referenceGroups ?? [];
    if (referenceGroups.some(group => group.documents.length)) {
      const findings = await this.extractReferenceFindings(context, model, reasoning, signal);
      context = { ...context, sourceContext: [context.sourceContext, findings, `Source registry (retain these identities in citations):\n${referenceCatalog(referenceGroups)}`].filter(Boolean).join("\n\n"), referenceGroups: undefined };
    }

    const totalStarted = Date.now();
    const prepared = buildPreparedTaskContext(context, model, 32_000, provider);
    if (prepared.context.sourceContext !== context.sourceContext) throw new Error(t("ui.reference_too_large", t("ui.reference_materials")));
    context = prepared.context;
    const pluginDirectory = join(adapter.getBasePath(), this.manifest.dir);
    const outputLanguage = context.outputLanguage ?? this.settings.language;
    const instructions = [
      translate(outputLanguage, "prompt.output_language"),
      translate(outputLanguage, "prompt.role"),
      translate(outputLanguage, "prompt.source_safety"),
      context.sourceContext ? translate(outputLanguage, "prompt.reference_citations") : "",
      context.sourceContext && context.researchMode !== "local" ? translate(outputLanguage, "prompt.local_first") : "",
      translate(outputLanguage, "prompt.json"),
      translate(outputLanguage, context.mode === "task" ? "prompt.general_task" : context.mode === "decompose" ? "prompt.decompose" : context.mode === "synthesize" ? "prompt.synthesize" : "prompt.default_task"),
      context.mode !== "decompose" ? translate(outputLanguage, "prompt.detail_structure", ["detail.core_conclusions", "detail.key_knowledge", "detail.evidence_and_sources", "detail.tradeoffs_and_limitations", "detail.open_questions", "detail.update_log"].map(key => `### ${translate(outputLanguage, key as TranslationKey)}`).join(", ")) : "",
      researchGuidance(context, outputLanguage),
      ...visualGuidance(context, outputLanguage),
      `${translate(outputLanguage, "prompt.label_topic")}:\n${context.title}`,
      `${translate(outputLanguage, "prompt.label_summary")}:\n${context.summary}`,
      context.mode !== "decompose" ? `${translate(outputLanguage, "prompt.label_detail")}:\n${context.detail || translate(outputLanguage, "prompt.none")}` : "",
      `${translate(outputLanguage, "prompt.label_rules")}:\n${context.rules || translate(outputLanguage, "prompt.none")}`,
      context.workingFindings ? `${translate(outputLanguage, "prompt.label_findings")}:\n${context.workingFindings}` : "",
      context.sourceContext ? `${translate(outputLanguage, "prompt.label_sources")}:\n${context.sourceContext}` : "",
      `${translate(outputLanguage, "prompt.label_ancestors")}:\n${context.ancestors || translate(outputLanguage, "prompt.none")}`,
      `${translate(outputLanguage, "prompt.label_task")}:\n${context.task}`
    ].join("\n\n");

    console.debug("Visual Agent Map AI metrics", prepared.metrics);
    const providerStarted = Date.now();
    const effort = effectiveReasoningLevel(context, normalizeReasoningLevel(reasoning ?? this.settings.cliReasoning));
    const exchanges = this.settings.aiExchangeLoggingEnabled ? this.exchanges : null;
    const exchangeId = exchanges ? randomUUID() : "";
    if (exchanges) { exchanges.begin({ id: exchangeId, startedAt: new Date().toISOString(), topic: context.title, mode: context.mode ?? "task", model, effort }); onExchange?.(exchangeId); }
    let stage = "啟動 AI";
    try {
      const controls = {
        signal, searchBudget: context.researchMode === "local" ? 0 : researchLimits(context.researchDepth).searches,
        onRequest: (request: unknown) => { stage = "等待 AI 回覆"; if (this.settings.aiExchangeLoggingEnabled) exchanges?.sent(exchangeId, JSON.stringify(request, null, 2)); }
      };
      const raw = provider === "claude"
        ? await this.claudeCli(pluginDirectory).runTask(instructions, providerModelId(model), effort, responseSchema, controls)
        : await this.runtime(pluginDirectory, context.researchMode === "local").runTask(instructions, model, effort, responseSchema, controls);
      stage = "解析 AI 回覆";
      if (this.settings.aiExchangeLoggingEnabled) exchanges?.received(exchangeId, raw);
      const result = this.parseAiResult(raw, provider === "claude" ? "Claude Code" : "Codex App Server", outputLanguage);
      if (referenceGroups.length) {
        result.summary = resolveReferenceLinks(result.summary, referenceGroups);
        result.detail = resolveReferenceLinks(result.detail, referenceGroups);
      }
      if (this.settings.aiExchangeLoggingEnabled) exchanges?.parsed(exchangeId);
      console.debug("Visual Agent Map AI metrics", { ...prepared.metrics, providerMs: Date.now() - providerStarted, totalMs: Date.now() - totalStarted });
      return result;
    } catch (error) {
      if (this.settings.aiExchangeLoggingEnabled) exchanges?.failed(exchangeId, `${stage}：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
  private async extractReferenceFindings(context: TaskContext, model: string, reasoning: unknown, signal?: AbortSignal): Promise<string> {
    let working = referenceBatches(context.referenceGroups ?? []);
    let round = 0;
    while (true) {
      round++;
      const batches = round === 1 ? working : packReferenceChunks(working);
      const findings: string[] = [];
      for (let index = 0; index < batches.length; index++) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        context.onProgress?.(t("ui.reference_processing_progress", index + 1, batches.length));
        const result = await this.askModel({
          title: context.title, summary: "", rules: "", detail: "",
          task: round === 1
            ? translate(this.settings.language, "prompt.reference_extract")
            : translate(this.settings.language, "prompt.reference_reduce"),
          ancestors: "", sourceContext: batches[index], mode: "task", researchMode: "local", researchDepth: "fast", visualMode: "off"
        }, model, reasoning, signal);
        if (!result.detail.trim()) throw new Error(t("ui.reference_processing_empty_result"));
        findings.push(result.detail.trim());
      }
      const joined = findings.map(value => `Evidence:\n${value}`).join("\n\n");
      if (joined.length <= 18_000) { context.onProgress?.(""); return joined; }
      if (joined.length >= working.reduce((sum, value) => sum + value.length, 0)) throw new Error(t("ui.reference_processing_could_not_reduce"));
      working = findings;
    }
  }
  private parseAiResult(raw: string, label: string, language: "zh-TW" | "en"): AiResult {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed: { summary?: unknown; detail?: unknown; suggestions?: unknown; visualReferences?: unknown } = JSON.parse(extractJsonObject(cleaned)) as { summary?: unknown; detail?: unknown; suggestions?: unknown; visualReferences?: unknown };
    if (typeof parsed.summary !== "string" || typeof parsed.detail !== "string") throw new Error(`${label} 沒有回傳 summary 與 detail`);
    const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
    const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.title === "string" && typeof item.task === "string").map(item => ({ title: String(item.title).trim(), task: String(item.task).trim(), contribution: typeof item.contribution === "string" ? item.contribution.trim() : "", parentTitle: typeof item.parentTitle === "string" ? item.parentTitle.trim() : "" })).filter(item => item.title) : [];
    const visualReferences = Array.isArray(parsed.visualReferences) ? parsed.visualReferences.filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.imageUrl === "string" && typeof item.sourceUrl === "string").map(item => ({
      title: typeof item.title === "string" ? item.title.trim() : language === "en" ? "Visual reference" : "視覺參考",
      imageUrl: String(item.imageUrl).trim(),
      sourceUrl: String(item.sourceUrl).trim(),
      description: typeof item.description === "string" ? item.description.trim() : "",
      palette: Array.isArray(item.palette) ? item.palette.map(String).map(color => color.trim()).filter(Boolean).slice(0, 8) : [],
      formula: typeof item.formula === "string" ? item.formula.trim() : ""
    })).filter(item => /^https?:\/\//i.test(item.imageUrl) && /^https?:\/\//i.test(item.sourceUrl)).slice(0, 6) : [];
    return { summary: Array.from(parsed.summary.trim()).slice(0, 80).join(""), detail: parsed.detail.trim(), suggestions, visualReferences };
  }
  runtime(pluginDirectory: string, local = false): CodexAppServerRuntime { return this.aiRuntime.codex(pluginDirectory, local); }
  private claudeCli(pluginDirectory: string): ClaudeCodeCliRuntime { return this.aiRuntime.claude(pluginDirectory); }

}
