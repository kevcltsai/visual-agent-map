import { t, setUiLanguage } from "./i18n";
import { App, MarkdownRenderer, FileSystemAdapter, ItemView, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, type SettingDefinitionItem } from "obsidian";
import { NameModal } from "./ui/modals/name-modal";
import { ChoiceModal } from "./ui/modals/choice-modal";
import { DebugLogModal } from "./ui/modals/debug-log-modal";
import { existsSync as nodeExistsSync, readdirSync as nodeReaddirSync } from "node:fs";
import { delimiter as nodeDelimiter, dirname as nodeDirname, isAbsolute as nodeIsAbsolute, join as nodeJoin } from "node:path";
import { canParent, clone, descendants, History, inheritModel, MapDocument, MapNode, parseMap, removeNodes, serializeMap, visibleNodes } from "./map-model";
import { DEFAULT_SETTINGS, ModelSource, Note, NotePatch, Repository, Settings, TopicInfo, TopicState } from "./repository";
import { buildPreparedTaskContext } from "./ai/context-builder";
import { canonicalDetail, visualReferencesMarkdown } from "./ai/result-utils";
import type { AiResult, Suggestion, TaskContext } from "./ai/types";
import { clampPreviewScale, legacyPreviewScale, previewMetrics } from "./ui/preview-utils";
import { BUILTIN_SAMPLE_ID, builtInSample, SAMPLE_TOUR_VERSION } from "./builtin-sample";
import { debugLog, LogManager } from "./log-manager";
import responseSchema from "./response-schema.json";
import { CodexAppServerRuntime } from "./ai/runtime/codex-app-server";

export { buildPreparedTaskContext } from "./ai/context-builder";
export { canonicalDetail, visualReferencesMarkdown } from "./ai/result-utils";
export { firstMarkdownImage, firstMarkdownTable, markdownImages } from "./ui/preview-utils";
export type { AiRunMetrics, PreparedTaskContext } from "./ai/types";
const VIEW_TYPE = "visual-agent-map-view";
const CODEX_INSTALL_URL = "https://developers.openai.com/codex/cli/";
type ProcessEnvironment = Record<string, string | undefined>;
function typedNodeBinding<T>(value: unknown): T { return value as T; }
const existsSync = typedNodeBinding<(path: string) => boolean>(nodeExistsSync);
const readdirSync = typedNodeBinding<(path: string) => string[]>(nodeReaddirSync);
const delimiter = typedNodeBinding<string>(nodeDelimiter);
const dirname = typedNodeBinding<(path: string) => string>(nodeDirname);
const isAbsolute = typedNodeBinding<(path: string) => boolean>(nodeIsAbsolute);
const join = typedNodeBinding<(...paths: string[]) => string>(nodeJoin);
function currentProcessEnvironment(): ProcessEnvironment {
  return (window as Window & { process?: { env?: ProcessEnvironment } }).process?.env ?? {};
}
interface Action { undo: () => Promise<void>; redo: () => Promise<void> }

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
export function executableCandidates(configured: string, home: string, pathValue: string, nvmVersions: string[] = []): string[] {
  if (configured.includes("/") || configured.includes("\\")) return [configured];
  const dirs = [
    home ? join(home, ".local/bin") : "",
    home ? join(home, ".npm-global/bin") : "",
    home ? join(home, ".volta/bin") : "",
    home ? join(home, ".fnm/current/bin") : "",
    "/opt/homebrew/bin", "/usr/local/bin",
    ...nvmVersions.map(version => join(home, ".nvm/versions/node", version, "bin")),
    ...pathValue.split(delimiter)
  ].filter(Boolean);
  return [...new Set(dirs)].map(directory => join(directory, configured));
}
const labels = { idea: t("待研究"), running: t("AI 執行中"), completed: t("AI 完成"), error: t("執行錯誤") };
class TaskModal extends Modal {
  constructor(app: App, private value: string, private submit: (value: string, run: boolean) => void, private titleText = t("自訂 AI 任務"), private description = t("描述這一步要請 AI 完成什麼。"), private rules = "") { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    this.contentEl.createEl("p", { text: this.description, cls: "vam-modal-intro" });
    const rulePreview = this.contentEl.createDiv("vam-rule-preview");
    rulePreview.createEl("strong", { text: t("本次套用的 AI 規則") });
    rulePreview.createEl("p", { text: this.rules.trim() || t("未設定額外規則。") });
    const input = this.contentEl.createEl("textarea", { text: this.value, cls: "vam-task-input" }); input.rows = 7; input.setAttr("aria-label", t("自訂 AI 任務"));
    const save = (run: boolean): void => { const value = input.value.trim(); if (!value) return; this.close(); this.submit(value, run); };
    new Setting(this.contentEl).addButton(b => b.setButtonText(t("取消")).onClick(() => this.close())).addButton(b => b.setButtonText(t("只儲存")).onClick(() => save(false))).addButton(b => b.setButtonText(t("確認並執行")).setCta().onClick(() => save(true)));
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  }
}
class CodexUsageModal extends Modal {
  private settled = false;
  constructor(app: App, private resolve: (confirmed: boolean) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t("Codex 額度提醒"));
    this.contentEl.createEl("p", { text: t("VAM 會透過你目前登入的 Codex 帳號執行 AI 任務，並使用該帳號的 Codex 使用額度。可用額度與限制依你的 ChatGPT 方案而定。"), cls: "vam-modal-intro" });
    const finish = (confirmed: boolean): void => { this.settled = true; this.close(); this.resolve(confirmed); };
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText(t("取消")).onClick(() => finish(false)))
      .addButton(button => button.setButtonText(t("了解並執行")).setCta().onClick(() => finish(true)));
  }
  onClose(): void { if (!this.settled) this.resolve(false); }
}
class CodexSetupModal extends Modal {
  constructor(app: App, private executable: string, private recheck: () => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t("安裝並連接 Codex"));
    this.contentEl.createEl("p", { text: t("VAM 需要 Codex CLI 才能建立第一張可編輯心智圖與執行 AI 任務。ChatGPT Free 也可使用，但 Codex 額度較少。"), cls: "vam-modal-intro" });
    const steps = this.contentEl.createEl("ol", { cls: "vam-setup-steps" });
    const install = steps.createEl("li");
    install.appendText(t("開啟官方 Codex CLI 安裝指南並完成安裝："));
    install.createEl("a", { text: t("Codex CLI 官方安裝指南"), href: CODEX_INSTALL_URL, attr: { target: "_blank", rel: "noopener noreferrer" } });
    steps.createEl("li", { text: t("在 Terminal 執行 codex，並用你的 ChatGPT 帳號登入。") });
    steps.createEl("li", { text: t("回到 VAM，選擇「我已完成，重新檢查」。") });
    this.contentEl.createEl("p", { text: t("不需要 API key。獨立版 Codex CLI 不需要 npm；只有從原始碼建置 VAM 才需要 Node.js 與 npm。"), cls: "vam-setup-note" });
    this.contentEl.createEl("p", { text: t("目前檢查的路徑：{0}", this.executable), cls: "vam-setup-path" });
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText(t("稍後處理")).onClick(() => this.close()))
      .addButton(button => button.setButtonText(t("我已完成，重新檢查")).setCta().onClick(() => { this.close(); this.recheck(); }));
  }
}
class ChildProposalModal extends Modal {
  constructor(app: App, private suggestions: Suggestion[], private submit: (items: Suggestion[]) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t("AI 子議題提案"));
    this.contentEl.createEl("p", { text: t("勾選要建立的子議題；建立前可直接修改名稱與任務。") });
    const rows: { check: HTMLInputElement; title: HTMLInputElement; task: HTMLTextAreaElement; contribution: HTMLTextAreaElement }[] = [];
    for (const item of this.suggestions) { const row = this.contentEl.createDiv("vam-proposal"); const check = row.createEl("input", { type: "checkbox" }); check.checked = true; const title = row.createEl("input", { type: "text", value: item.title }); const task = row.createEl("textarea", { text: item.task }); task.rows = 2; const contribution = row.createEl("textarea", { text: item.contribution }); contribution.rows = 2; contribution.placeholder = t("對母議題的貢獻"); rows.push({ check, title, task, contribution }); }
    new Setting(this.contentEl).addButton(b => b.setButtonText(t("取消")).onClick(() => this.close())).addButton(b => b.setButtonText(t("建立子議題")).setCta().onClick(() => { this.close(); this.submit(rows.filter(row => row.check.checked && row.title.value.trim()).map(row => ({ title: row.title.value.trim(), task: row.task.value.trim(), contribution: row.contribution.value.trim() }))); }));
  }
}
class IntegrationModal extends Modal {
  constructor(app: App, private names: string[], private defaultRules: string, private submit: (title: string, goal: string, rules: string) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t("確認整合議題"));
    this.contentEl.createEl("p", { text: t("將整合 {0} 個來源議題，AI 會讀取完整知識內容並建立新的根議題。", this.names.length), cls: "vam-modal-intro" });
    const sources = this.contentEl.createDiv("vam-integration-sources");
    sources.createEl("strong", { text: t("來源議題") });
    for (const name of this.names) sources.createDiv({ text: name });
    const titleLabel = this.contentEl.createEl("label", { cls: "vam-field" }); titleLabel.createSpan({ text: t("新議題名稱") });
    const title = titleLabel.createEl("input", { type: "text", value: t("整合議題") }); title.setAttr("aria-label", t("新議題名稱"));
    const goalLabel = this.contentEl.createEl("label", { cls: "vam-field" }); goalLabel.createSpan({ text: t("整合目標") });
    const goal = goalLabel.createEl("textarea", { text: t("找出共同結論、重要差異、取捨與下一步。") }); goal.rows = 4; goal.setAttr("aria-label", t("整合目標"));
    const rulesLabel = this.contentEl.createEl("label", { cls: "vam-field" }); rulesLabel.createSpan({ text: t("AI 規則") });
    const rules = rulesLabel.createEl("textarea", { text: this.defaultRules }); rules.rows = 3; rules.setAttr("aria-label", t("AI 規則"));
    const save = (): void => { if (!title.value.trim() || !goal.value.trim()) return; this.close(); this.submit(title.value.trim(), goal.value.trim(), rules.value.trim()); };
    new Setting(this.contentEl).addButton(button => button.setButtonText(t("取消")).onClick(() => this.close())).addButton(button => button.setButtonText(t("確認並執行")).setCta().onClick(save));
    title.focus(); title.select();
  }
}
class ConflictModal extends Modal {
  constructor(app: App, private label: string, private local: string, private disk: string, private resolve: (value: string | null) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t("{0}有外部修改", this.label));
    this.contentEl.createEl("p", { text: t("畫面與 Markdown 都有修改。請選擇要保留的內容，或在下方手動合併。") });
    const input = this.contentEl.createEl("textarea", { cls: "vam-task-input", text: `${this.disk}\n\n${this.local}` }); input.rows = 10;
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText(t("使用檔案內容")).onClick(() => { this.close(); this.resolve(null); }))
      .addButton(b => b.setButtonText(t("保留畫面內容")).onClick(() => { this.close(); this.resolve(this.local); }))
      .addButton(b => b.setButtonText(t("儲存合併內容")).setCta().onClick(() => { this.close(); this.resolve(input.value.trim()); }));
  }
}
class MapConflictModal extends Modal {
  private settled = false;
  constructor(app: App, private local: MapDocument, private disk: MapDocument, private resolve: (map: MapDocument) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t("心智圖有外部修改"));
    this.contentEl.createEl("p", { text: t("畫面與 Map.md 的結構都已改變。可選擇其中一版，或編輯下方 JSON 後手動合併。") });
    const input = this.contentEl.createEl("textarea", { cls: "vam-task-input", text: JSON.stringify(this.disk, null, 2) }); input.rows = 16;
    const finish = (map: MapDocument): void => { this.settled = true; this.close(); this.resolve(map); };
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText(t("使用檔案內容")).onClick(() => finish(clone(this.disk))))
      .addButton(button => button.setButtonText(t("保留畫面內容")).onClick(() => finish(clone(this.local))))
      .addButton(button => button.setButtonText(t("儲存合併內容")).setCta().onClick(() => {
        try { finish(parseMap(serializeMap(JSON.parse(input.value) as MapDocument))); }
        catch (error) { new Notice(error instanceof Error ? t("合併內容無效：{0}", error.message) : t("合併內容無效。")); }
      }));
  }
  onClose(): void { if (!this.settled) this.resolve(clone(this.disk)); }
}
class NoteCollectionModal extends Modal {
  constructor(app: App, private titleText: string, private files: TFile[], private actions: { label: string; run: (file: TFile) => void }[]) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    if (!this.files.length) this.contentEl.createEl("p", { text: t("目前沒有筆記。") });
    for (const file of this.files) {
      const row = this.contentEl.createDiv("vam-collection-row"); row.createSpan({ text: file.basename });
      const actions = row.createDiv("vam-collection-actions");
      for (const action of this.actions) actions.createEl("button", { text: action.label }).addEventListener("click", () => { this.close(); action.run(file); });
    }
    new Setting(this.contentEl).addButton(button => button.setButtonText(t("關閉")).onClick(() => this.close()));
  }
}
class TopicPickerModal extends Modal {
  constructor(app: App, private titleText: string, private topics: TopicInfo[], private choose: (topic: TopicInfo) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    for (const topic of this.topics) new Setting(this.contentEl).setName(topic.title).setDesc(topic.root).addButton(button => button.setButtonText(t("選擇")).onClick(() => { this.close(); this.choose(topic); }));
    if (!this.topics.length) this.contentEl.createEl("p", { text: t("沒有其他主題。") });
    new Setting(this.contentEl).addButton(button => button.setButtonText(t("取消")).onClick(() => this.close()));
  }
}
interface FileMove { activePath: string; parkedPath: string; topicId: string; parkedState: TopicState }
export class VisualAgentMapView extends ItemView {
  private map: MapDocument | null = null;
  private path = "";
  private notes = new Map<string, Note>();
  private selected: string | null = null;
  private multiSelected = new Set<string>();
  private history = new History<Action>();
  private viewportEl: HTMLElement | null = null;
  private stageEl: HTMLElement | null = null;
  private edgesEl: SVGSVGElement | null = null;
  private zoomLabel: HTMLElement | null = null;
  private refreshTimer: number | null = null;
  private viewportTimer: number | null = null;
  private hoverTimer: number | null = null;
  private hoverCard: HTMLElement | null = null;
  private integrationMode = false;
  private dragging = false;
  private suppressClickUntil = 0;
  private closed = false;
  private headerTitle = "";
  private builtIn = false;
  private showSampleTour = false;
  private sampleTourStep = 0;
  constructor(leaf: WorkspaceLeaf, private plugin: VisualAgentMapPlugin) { super(leaf); }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.map?.title ?? "Visual Agent Map"; }
  getIcon(): string { return "git-fork"; }
  getState(): Record<string, unknown> { return this.builtIn ? { sample: BUILTIN_SAMPLE_ID } : { file: this.path }; }
  async setState(state: Record<string, unknown>, result: { history: boolean }): Promise<void> {
    if (state.sample === BUILTIN_SAMPLE_ID) await this.openBuiltInSample();
    else if (typeof state.file === "string" && state.file !== this.path) await this.openMap(state.file);
    await super.setState(state, result);
  }
  async onOpen(): Promise<void> {
    this.contentEl.addClass("vam-view"); this.contentEl.tabIndex = 0;
    this.registerDomEvent(this.contentEl, "keydown", event => {
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); this.enqueue(() => this.travel(event.shiftKey)); }
      if (event.key === "Escape") { this.selected = null; this.multiSelected.clear(); this.integrationMode = false; this.render(); }
    });
    await this.plugin.ready;
    if (!this.path && !this.builtIn) {
      if (this.plugin.consumeFirstInstallSample()) await this.openBuiltInSample();
      else if (!this.plugin.repo.workspaceExists()) this.render();
      else { const files = await this.plugin.repo.mapFiles(); if (files.length) await this.openMap(files[0].path); else this.render(); }
    }
  }
  async onClose(): Promise<void> { this.closed = true; if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer); if (this.hoverTimer !== null) window.clearTimeout(this.hoverTimer); this.hoverCard?.remove(); if (this.viewportTimer !== null) { window.clearTimeout(this.viewportTimer); await this.persist(); } }
  async refreshFromPlugin(): Promise<void> { if (this.builtIn) { await this.openBuiltInSample(this.showSampleTour); return; } await this.hydrate(); this.render(); }
  private enqueue(work: () => Promise<void>): void { void this.plugin.mutate(work).catch(() => {}); }
  private async persist(): Promise<void> { if (!this.builtIn && this.map && this.path) await this.plugin.repo.saveMap(this.path, this.map); }
  private async hydrate(): Promise<void> {
    if (this.builtIn) { this.notes = builtInSample(this.plugin.settings.language).notes; return; }
    this.notes.clear();
    for (const node of this.map?.nodes ?? []) { try { this.notes.set(node.id, await this.plugin.repo.readNote(node.path)); } catch { /* A missing note remains visible and removable on the map. */ } }
  }
  async openMap(path: string): Promise<void> {
    if (this.viewportTimer !== null) { window.clearTimeout(this.viewportTimer); this.viewportTimer = null; await this.persist(); }
    const map = await this.plugin.repo.readMap(path);
    this.builtIn = false; this.path = path; this.map = map; this.integrationMode = false; this.selected = null; this.multiSelected.clear(); this.history.clear(); await this.hydrate(); this.render();
    this.app.workspace.requestSaveLayout();
  }
  async openBuiltInSample(forceTour = false): Promise<void> {
    if (this.viewportTimer !== null) { window.clearTimeout(this.viewportTimer); this.viewportTimer = null; await this.persist(); }
    const sample = builtInSample(this.plugin.settings.language);
    this.builtIn = true; this.path = ""; this.map = sample.map; this.notes = sample.notes; this.integrationMode = false; this.selected = null; this.multiSelected.clear(); this.history.clear();
    this.showSampleTour = forceTour || this.plugin.settings.sampleTourVersionSeen < SAMPLE_TOUR_VERSION;
    this.sampleTourStep = 0; this.selected = this.showSampleTour ? "explore" : null;
    this.render(); this.app.workspace.requestSaveLayout();
  }
  changed(file: TFile): void {
    if (file.path !== this.path && !this.map?.nodes.some(node => node.path === file.path)) return;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      if (this.closed) return;
      if (this.dragging) { this.changed(file); return; }
      if (this.contentEl.contains(document.activeElement) && document.activeElement?.matches("input, textarea, select")) { this.changed(file); return; }
      this.enqueue(async () => { if (file.path === this.path) { this.map = await this.plugin.repo.readMap(this.path); this.history.clear(); await this.plugin.rebuildDerivedData(); } await this.hydrate(); this.render(); });
    }, 400);
  }
  async renamed(file: TFile, oldPath: string): Promise<void> { if (this.path === oldPath) this.path = file.path; if (this.map) { for (const node of this.map.nodes) if (node.path === oldPath) node.path = file.path; this.history.clear(); await this.hydrate(); this.render(); } }
  deleted(file: TFile): void { if (file.path === this.path) { this.map = null; this.path = ""; this.history.clear(); this.render(); } else this.changed(file); }
  private button(parent: HTMLElement, text: string, action: () => void, disabled = false): HTMLButtonElement { const button = parent.createEl("button", { text: t(text) }); button.disabled = disabled; button.addEventListener("click", event => { event.stopPropagation(); action(); }); return button; }
  private async mapChange(change: (map: MapDocument) => void, rebuildDerivedData = true): Promise<void> {
    if (!this.map) return;
    const path = this.path;
    const disk = await this.plugin.repo.readMap(path);
    const structure = (map: MapDocument): string => JSON.stringify({ ...map, viewport: null });
    if (structure(disk) !== structure(this.map)) {
      const local = clone(this.map);
      this.map = await new Promise<MapDocument>(resolve => new MapConflictModal(this.app, local, disk, resolve).open());
      this.history.clear();
    }
    const before = clone(this.map);
    try { change(this.map); } catch (error) { this.map = before; throw error; }
    const after = clone(this.map);
    try { await this.persist(); } catch (error) { this.map = before; this.render(); throw error; }
    const ownership = (map: MapDocument): string => JSON.stringify(map.nodes.map(node => [node.id, node.path, node.parentId]));
    if (rebuildDerivedData && ownership(before) !== ownership(after)) await this.plugin.rebuildDerivedData();
    const restore = async (snapshot: MapDocument): Promise<void> => { const previous = clone(this.map!); const next = clone(snapshot); if (this.map) next.viewport = clone(this.map.viewport); await this.plugin.repo.saveMap(path, next); this.map = next; if (ownership(previous) !== ownership(next)) await this.plugin.rebuildDerivedData(); await this.hydrate(); };
    this.history.push({ undo: () => restore(before), redo: () => restore(after) }); this.render();
  }
  private async restoreLifecycle(snapshot: MapDocument, moves: FileMove[], parked: boolean): Promise<void> {
    for (const move of moves) {
      const from = parked ? move.activePath : move.parkedPath, to = parked ? move.parkedPath : move.activePath;
      await this.plugin.repo.moveExact(from, to);
      await this.plugin.repo.setLifecycle(to, move.topicId, parked ? "" : snapshot.id, parked ? move.parkedState : "active");
    }
    await this.plugin.repo.saveMap(this.path, clone(snapshot)); this.map = clone(snapshot);
    await this.plugin.rebuildDerivedData(); await this.hydrate(); this.render();
  }
  private async removeToUnassigned(node: MapNode, branch: boolean): Promise<void> {
    if (!this.map) return;
    const before = clone(this.map), ids = branch ? new Set([node.id, ...descendants(before.nodes, node.id)]) : new Set([node.id]);
    const removed = before.nodes.filter(item => ids.has(item.id)), moves: FileMove[] = [];
    try {
      for (const item of removed) {
        const target = await this.plugin.repo.moveUnique(item.path, this.plugin.repo.topicFolder(this.path, "Unassigned"));
        moves.push({ activePath: item.path, parkedPath: target, topicId: before.id, parkedState: "unassigned" });
        await this.plugin.repo.setLifecycle(target, before.id, "", "unassigned");
      }
      const after = clone(before); after.nodes = removeNodes(after.nodes, node.id, branch);
      await this.plugin.repo.saveMap(this.path, after); this.map = after; this.selected = null; this.multiSelected.clear();
      await this.plugin.rebuildDerivedData(); await this.hydrate();
      this.history.push({ undo: () => this.restoreLifecycle(before, moves, false), redo: () => this.restoreLifecycle(after, moves, true) }); this.render();
    } catch (error) {
      for (const move of [...moves].reverse()) if (this.app.vault.getAbstractFileByPath(move.parkedPath) && !this.app.vault.getAbstractFileByPath(move.activePath)) await this.plugin.repo.moveExact(move.parkedPath, move.activePath);
      throw error;
    }
  }
  private async claimToCurrent(file: TFile): Promise<void> {
    if (!this.map) return;
    const before = clone(this.map), previous = await this.plugin.repo.readNote(file.path), original = file.path;
    const target = await this.plugin.repo.moveUnique(original, this.plugin.repo.topicFolder(this.path, "Notes"));
    await this.plugin.repo.setLifecycle(target, this.map.id, this.map.id, "active");
    const node: MapNode = { id: crypto.randomUUID(), path: target, parentId: null, x: 80, y: Math.max(-100, ...this.map.nodes.map(item => item.y)) + 240, collapsed: false };
    const after = clone(before); after.nodes.push(node);
    await this.plugin.repo.saveMap(this.path, after); this.map = after; this.selected = node.id; await this.plugin.rebuildDerivedData(); await this.hydrate();
    const undo = async (): Promise<void> => { await this.plugin.repo.moveExact(target, original); await this.plugin.repo.setLifecycle(original, previous.topicId, previous.mapId, previous.topicState); await this.plugin.repo.saveMap(this.path, before); this.map = clone(before); await this.plugin.rebuildDerivedData(); await this.hydrate(); this.render(); };
    const redo = async (): Promise<void> => { await this.plugin.repo.moveExact(original, target); await this.plugin.repo.setLifecycle(target, after.id, after.id, "active"); await this.plugin.repo.saveMap(this.path, after); this.map = clone(after); await this.plugin.rebuildDerivedData(); await this.hydrate(); this.render(); };
    this.history.push({ undo, redo }); this.render(); this.focusNode(node);
  }
  private async relinkMissingNode(node: MapNode, file: TFile): Promise<void> {
    if (!this.map) return;
    const before = clone(this.map), previous = await this.plugin.repo.readNote(file.path), original = file.path;
    const target = await this.plugin.repo.moveUnique(original, this.plugin.repo.topicFolder(this.path, "Notes")); await this.plugin.repo.setLifecycle(target, this.map.id, this.map.id, "active");
    const after = clone(before), replacement = after.nodes.find(item => item.id === node.id); if (!replacement) throw new Error(t("找不到要重新連結的節點。")); replacement.path = target;
    await this.plugin.repo.saveMap(this.path, after); this.map = after; await this.plugin.rebuildDerivedData(); await this.hydrate();
    const undo = async (): Promise<void> => { await this.plugin.repo.moveExact(target, original); await this.plugin.repo.setLifecycle(original, previous.topicId, previous.mapId, previous.topicState); await this.plugin.repo.saveMap(this.path, before); this.map = clone(before); await this.plugin.rebuildDerivedData(); await this.hydrate(); this.render(); };
    const redo = async (): Promise<void> => { await this.plugin.repo.moveExact(original, target); await this.plugin.repo.setLifecycle(target, after.id, after.id, "active"); await this.plugin.repo.saveMap(this.path, after); this.map = clone(after); await this.plugin.rebuildDerivedData(); await this.hydrate(); this.render(); };
    this.history.push({ undo, redo }); this.render();
  }
  private async parkFile(file: TFile, collection: "Unassigned" | "Archive", state: "unassigned" | "archived"): Promise<void> {
    if (!this.map) return;
    const before = await this.plugin.repo.readNote(file.path), original = file.path;
    const target = await this.plugin.repo.moveUnique(original, this.plugin.repo.topicFolder(this.path, collection));
    await this.plugin.repo.setLifecycle(target, this.map.id, "", state); await this.plugin.rebuildDerivedData();
    const undo = async (): Promise<void> => { await this.plugin.repo.moveExact(target, original); await this.plugin.repo.setLifecycle(original, before.topicId, before.mapId, before.topicState); await this.plugin.rebuildDerivedData(); this.render(); };
    const redo = async (): Promise<void> => { await this.plugin.repo.moveExact(original, target); await this.plugin.repo.setLifecycle(target, this.map!.id, "", state); await this.plugin.rebuildDerivedData(); this.render(); };
    this.history.push({ undo, redo }); this.render();
  }
  private async transferToTopic(file: TFile, topic: TopicInfo): Promise<void> {
    const before = await this.plugin.repo.readNote(file.path), original = file.path, folder = `${topic.root}/Unassigned`;
    const target = await this.plugin.repo.moveUnique(original, folder); await this.plugin.repo.setLifecycle(target, topic.id, "", "unassigned"); await this.plugin.rebuildDerivedData();
    const undo = async (): Promise<void> => { await this.plugin.repo.moveExact(target, original); await this.plugin.repo.setLifecycle(original, before.topicId, before.mapId, before.topicState); await this.plugin.rebuildDerivedData(); this.render(); };
    const redo = async (): Promise<void> => { await this.plugin.repo.moveExact(original, target); await this.plugin.repo.setLifecycle(target, topic.id, "", "unassigned"); await this.plugin.rebuildDerivedData(); this.render(); };
    this.history.push({ undo, redo }); this.render();
  }
  private async transferAndAdd(file: TFile, topic: TopicInfo): Promise<void> {
    const previous = await this.plugin.repo.readNote(file.path), original = file.path, before = await this.plugin.repo.readMap(topic.mapPath);
    const target = await this.plugin.repo.moveUnique(original, `${topic.root}/Notes`); await this.plugin.repo.setLifecycle(target, topic.id, topic.id, "active");
    const node: MapNode = { id: crypto.randomUUID(), path: target, parentId: null, x: 80, y: Math.max(-100, ...before.nodes.map(item => item.y)) + 240, collapsed: false };
    const after = clone(before); after.nodes.push(node); await this.plugin.repo.saveMap(topic.mapPath, after); await this.plugin.rebuildDerivedData();
    const undo = async (): Promise<void> => { await this.plugin.repo.moveExact(target, original); await this.plugin.repo.setLifecycle(original, previous.topicId, previous.mapId, previous.topicState); await this.plugin.repo.saveMap(topic.mapPath, before); await this.plugin.rebuildDerivedData(); this.render(); };
    const redo = async (): Promise<void> => { await this.plugin.repo.moveExact(original, target); await this.plugin.repo.setLifecycle(target, topic.id, topic.id, "active"); await this.plugin.repo.saveMap(topic.mapPath, after); await this.plugin.rebuildDerivedData(); this.render(); };
    this.history.push({ undo, redo }); this.render();
  }
  private async noteChange(node: MapNode, patch: NotePatch): Promise<void> {
    const current = await this.plugin.repo.readNote(node.path), before: NotePatch = {};
    for (const key of Object.keys(patch) as (keyof Note)[]) (before as Record<string, unknown>)[key] = current[key];
    if (Object.keys(patch).every(key => current[key as keyof Note] === patch[key as keyof Note])) return;
    await this.plugin.repo.updateNote(node.path, patch);
    this.history.push({ undo: () => this.plugin.repo.updateNote(node.path, before), redo: () => this.plugin.repo.updateNote(node.path, patch) });
    this.notes.set(node.id, await this.plugin.repo.readNote(node.path));
    this.refreshCard(node);
    this.updateHistoryButtons();
  }
  private async renameNode(node: MapNode, title: string): Promise<void> {
    if (!this.map) return;
    const current = await this.plugin.repo.readNote(node.path), oldTitle = current.title, oldPath = node.path;
    if (oldTitle === title && oldPath.endsWith(`/${title}.md`)) return;
    const apply = async (from: string, to: string | undefined, nextTitle: string): Promise<string> => {
      const nextPath = await this.plugin.repo.renameNote(from, nextTitle, to);
      const target = this.map?.nodes.find(item => item.id === node.id); if (target) target.path = nextPath;
      node.path = nextPath;
      if (this.map) await this.plugin.repo.saveMap(this.path, this.map);
      await this.plugin.repo.replaceSourcePath(from, nextPath);
      await this.plugin.rebuildDerivedData(); await this.hydrate(); this.render();
      return nextPath;
    };
    const newPath = await apply(oldPath, undefined, title);
    this.history.push({ undo: () => apply(newPath, oldPath, oldTitle).then(() => {}), redo: () => apply(oldPath, newPath, title).then(() => {}) });
    this.updateHistoryButtons();
  }
  private async saveFieldWithConflict(node: MapNode, key: "title" | "summary" | "rules" | "preview", label: string, base: string, value: string): Promise<void> {
    const latest = await this.plugin.repo.readNote(node.path);
    if (latest[key] !== base && latest[key] !== value) {
      new ConflictModal(this.app, label, value, latest[key], resolved => {
        if (resolved === null) this.enqueue(async () => { await this.hydrate(); this.render(); });
        else this.enqueue(() => key === "title" ? this.renameNode(node, resolved) : this.noteChange(node, { [key]: resolved }));
      }).open();
      return;
    }
    if (key === "title") await this.renameNode(node, value); else await this.noteChange(node, { [key]: value });
  }
  private openDetails(node: MapNode): void { void this.plugin.openDetails(this.plugin.repo.file(node.path)).catch(error => new Notice(error instanceof Error ? error.message : String(error))); }
  private async travel(redo: boolean): Promise<void> {
    const action = redo ? this.history.redo() : this.history.undo(); if (!action) return;
    try { await (redo ? action.redo() : action.undo()); await this.hydrate(); this.render(); } catch (error) { if (redo) this.history.undo(); else this.history.redo(); throw error; }
  }
  private updateHistoryButtons(): void { const undo = this.contentEl.querySelector<HTMLButtonElement>("[data-history=undo]"), redo = this.contentEl.querySelector<HTMLButtonElement>("[data-history=redo]"); if (undo) undo.disabled = !this.history.canUndo; if (redo) redo.disabled = !this.history.canRedo; }
  async synchronize(): Promise<void> {
    if (this.builtIn) return;
    if (!this.path || !this.map || this.closed) return;
    if (!(this.app.vault.getAbstractFileByPath(this.path) instanceof TFile)) { this.map = null; this.path = ""; this.history.clear(); this.render(); return; }
    const disk = await this.plugin.repo.readMap(this.path);
    const structureChanged = JSON.stringify({ ...disk, viewport: null }) !== JSON.stringify({ ...this.map, viewport: null });
    if (structureChanged) { disk.viewport = this.map.viewport; this.map = disk; this.history.clear(); }
    const before = JSON.stringify(Array.from(this.notes));
    await this.hydrate();
    if (structureChanged || before !== JSON.stringify(Array.from(this.notes))) {
      const editing = this.contentEl.contains(document.activeElement) && document.activeElement?.matches("input, textarea, select");
      if ((!editing || structureChanged) && !this.dragging) this.render();
      else for (const node of this.map.nodes) this.refreshCard(node);
    }
  }
  private openMapActions(): void {
    const choices: { label: string; description?: string; buttonLabel?: string; action: () => void }[] = [];
    if (this.map) {
      choices.push({ label: t("重新命名目前心智圖"), description: t("同時更新主題資料夾與心智圖名稱。"), action: () => this.renameCurrentMap() });
      if (!this.path.startsWith(`${this.plugin.settings.topicsFolder}/`)) choices.push({ label: t("整理舊資料"), description: t("預覽後把舊版心智圖整理成目前的主題結構。"), action: () => this.enqueue(() => this.previewMigration()) });
    }
    choices.push({ label: t("修復遺失的心智圖"), description: t("從現有議題筆記重新建立缺少的 Map。"), action: () => this.enqueue(() => this.repairMissingTopic()) });
    if (this.map) choices.push({ label: t("刪除目前心智圖"), description: t("只移除心智圖檔案，保留所有議題筆記，並可用復原還原。"), buttonLabel: t("檢視"), action: () => this.deleteCurrentMap() });
    new ChoiceModal(this.app, t("更多心智圖操作"), t("低頻的管理操作集中在這裡。"), choices).open();
  }
  private renameCurrentMap(): void {
    if (!this.map) return;
    new NameModal(this.app, t("重新命名心智圖"), this.map.title, title => this.enqueue(async () => {
      if (!this.map) return;
      if (!this.path.startsWith(`${this.plugin.settings.topicsFolder}/`)) { new Notice(t("請先整理舊資料，再重新命名主題。")); return; }
      const before = clone(this.map), beforeRoot = this.plugin.repo.topicRoot(this.path);
      this.path = await this.plugin.repo.renameTopic(this.path, title);
      this.map = await this.plugin.repo.readMap(this.path);
      const after = clone(this.map), afterRoot = this.plugin.repo.topicRoot(this.path);
      const restore = async (map: MapDocument, root: string): Promise<void> => {
        this.path = await this.plugin.repo.renameTopic(this.path, map.title, root); this.map = clone(map);
        await this.plugin.repo.saveMap(this.path, this.map); await this.plugin.rebuildDerivedData(); this.render();
      };
      this.history.push({ undo: () => restore(before, beforeRoot), redo: () => restore(after, afterRoot) });
      this.render(); this.app.workspace.requestSaveLayout();
    })).open();
  }
  private deleteCurrentMap(): void {
    if (!this.map) return;
    new ChoiceModal(this.app, t("刪除心智圖"), t("只將心智圖檔案移到 Vault 垃圾桶，保留所有議題筆記。可以使用復原還原。"), [
      { label: t("刪除「{0}」", this.map.title), description: t("議題筆記不會被刪除。"), buttonLabel: t("移到垃圾桶"), action: () => this.enqueue(async () => {
        if (!this.map) return;
        const path = this.path, file = this.plugin.repo.file(path), content = await this.app.vault.read(file), map = clone(this.map);
        await this.app.fileManager.trashFile(file); this.map = null; this.path = ""; await this.plugin.rebuildDerivedData();
        this.history.push({
          undo: async () => { await this.app.vault.create(path, content); this.path = path; this.map = clone(map); await this.plugin.rebuildDerivedData(); },
          redo: async () => { await this.app.fileManager.trashFile(this.plugin.repo.file(path)); this.path = ""; this.map = null; await this.plugin.rebuildDerivedData(); }
        });
        this.render();
      }) }
    ]).open();
  }
  private async openOrganizer(): Promise<void> {
    if (!this.map) return;
    const [unassigned, archived, inbox] = await Promise.all([
      this.plugin.repo.collectionFiles(this.path, "Unassigned"),
      this.plugin.repo.collectionFiles(this.path, "Archive"),
      this.plugin.repo.inboxFiles()
    ]);
    new ChoiceModal(this.app, t("整理筆記"), t("集中處理暫時不在心智圖上的內容。"), [
      { label: t("未歸類（{0}）", unassigned.length), description: t("認領到目前心智圖、封存，或移至其他主題。"), action: () => this.openUnassigned(unassigned) },
      { label: t("封存（{0}）", archived.length), description: t("查看已封存筆記，或將它們移回未歸類。"), action: () => this.openArchive(archived) },
      { label: t("收件匣（{0}）", inbox.length), description: t("將還沒有主題的筆記移入適合的位置。"), action: () => this.openInbox(inbox) }
    ]).open();
  }
  private openUnassigned(files: TFile[]): void {
    new NoteCollectionModal(this.app, t("未歸類筆記"), files, [
      { label: t("認領到心智圖"), run: file => this.enqueue(() => this.claimToCurrent(file)) },
      { label: t("封存"), run: file => this.enqueue(() => this.parkFile(file, "Archive", "archived")) },
      { label: t("移至其他主題"), run: file => this.enqueue(async () => { const topics = (await this.plugin.repo.topics()).filter(topic => topic.id !== this.map?.id); new TopicPickerModal(this.app, t("移至其他主題"), topics, topic => this.enqueue(() => this.transferToTopic(file, topic))).open(); }) },
      { label: t("移動並加入其他主題"), run: file => this.enqueue(async () => { const topics = (await this.plugin.repo.topics()).filter(topic => topic.id !== this.map?.id); new TopicPickerModal(this.app, t("移動並加入其他心智圖"), topics, topic => this.enqueue(() => this.transferAndAdd(file, topic))).open(); }) }
    ]).open();
  }
  private openArchive(files: TFile[]): void {
    new NoteCollectionModal(this.app, t("封存筆記"), files, [{ label: t("取消封存"), run: file => this.enqueue(() => this.parkFile(file, "Unassigned", "unassigned")) }]).open();
  }
  private openInbox(files: TFile[]): void {
    new NoteCollectionModal(this.app, t("未指定主題的筆記"), files, [
      { label: t("移至目前主題"), run: file => this.enqueue(() => this.parkFile(file, "Unassigned", "unassigned")) },
      { label: t("移動並加入目前心智圖"), run: file => this.enqueue(() => this.claimToCurrent(file)) },
      { label: t("選擇其他主題"), run: file => this.enqueue(async () => { const topics = await this.plugin.repo.topics(); new TopicPickerModal(this.app, t("移至主題"), topics, topic => this.enqueue(() => this.transferToTopic(file, topic))).open(); }) }
    ]).open();
  }
  private render(): void {
    if (this.closed) return;
    if (this.hoverTimer !== null) { window.clearTimeout(this.hoverTimer); this.hoverTimer = null; }
    this.hoverCard?.remove(); this.hoverCard = null;
    const title = this.getDisplayText();
    if (title !== this.headerTitle) {
      this.headerTitle = title;
      window.setTimeout(() => { if (!this.closed) void this.leaf.setViewState({ type: VIEW_TYPE, state: this.getState() }); }, 0);
    }
    this.contentEl.empty();
    const toolbar = this.contentEl.createDiv("vam-toolbar");
    toolbar.createEl("strong", { text: this.map?.title ?? "Visual Agent Map", cls: "vam-map-title" });
    if (this.builtIn) toolbar.createSpan({ cls: "vam-readonly-badge", text: t("官方範例 · 唯讀") });
    this.button(toolbar, t("切換心智圖"), () => this.enqueue(async () => { const topics = await this.plugin.repo.topics(); new ChoiceModal(this.app, t("切換心智圖"), t("選擇要開啟的研究主題"), [
      { label: t("範例：台灣旅行規劃"), description: t("官方唯讀範例"), action: () => this.enqueue(() => this.openBuiltInSample()) },
      ...topics.map(topic => ({ label: topic.title, action: () => this.enqueue(() => this.openMap(topic.mapPath)) }))
    ]).open(); }));
    if (this.builtIn) {
      this.button(toolbar, t("重新顯示導覽"), () => { this.showSampleTour = true; this.render(); });
    } else if (this.map) {
      this.button(toolbar, t("＋ 心智圖"), () => new NameModal(this.app, t("新增心智圖"), t("新的心智圖"), title => this.enqueue(async () => this.openMap(await this.plugin.repo.createMap(title)))).open());
      const undo = this.button(toolbar, t("復原"), () => this.enqueue(() => this.travel(false)), !this.history.canUndo); undo.dataset.history = "undo";
      const redo = this.button(toolbar, t("重做"), () => this.enqueue(() => this.travel(true)), !this.history.canRedo); redo.dataset.history = "redo";
      this.button(toolbar, t("更多…"), () => this.openMapActions());
    }
    if (!this.map) {
      const empty = this.contentEl.createDiv("vam-empty-state");
      empty.createEl("h2", { text: this.plugin.repo.workspaceExists() ? t("還沒有心智圖") : t("Agent Workspace 不存在") });
      empty.createEl("p", { text: this.plugin.repo.workspaceExists() ? t("建立第一張心智圖，開始整理你的議題。") : t("可以安全地重建基本資料夾；既有筆記不會被覆寫。") });
      const actions = empty.createDiv("vam-empty-actions");
      if (!this.plugin.repo.workspaceExists()) {
        this.button(actions, t("找回既有 Workspace"), () => this.enqueue(() => this.plugin.offerWorkspaceReconnect())).addClass("mod-cta");
        this.button(actions, t("修復 Agent Workspace"), () => this.enqueue(() => this.plugin.repairWorkspace()));
      }
      if (this.plugin.settings.models.trim()) this.button(actions, t("建立新心智圖"), () => new NameModal(this.app, t("新增心智圖"), t("新的心智圖"), title => this.enqueue(async () => this.openMap(await this.plugin.repo.createMap(title)))).open());
      else this.button(actions, t("檢查 Codex"), () => this.enqueue(() => this.plugin.recheckCodex())).addClass("mod-cta");
      this.button(actions, t("查看範例"), () => this.enqueue(() => this.openBuiltInSample(true)));
      return;
    }
    if (this.builtIn && this.showSampleTour) {
      const tour = this.contentEl.createDiv("vam-sample-tour");
      const steps = [
        { id: "explore", title: t("1 / 5　從問題開始"), body: t("先把模糊目標拆成可以分別研究的議題。") },
        { id: "constraints", title: t("2 / 5　展開多層子議題"), body: t("子議題還能繼續展開；複製後也可以收合與調整結構。") },
        { id: "food", title: t("3 / 5　用預覽呈現重點"), body: t("預覽由你控制，可以放文字、圖片與表格，並顯示在 hover card。") },
        { id: "journey", title: t("4 / 5　把來源收斂成新根議題"), body: t("完整旅程引用實際採用的來源，方便回頭檢查假設。") },
        { id: "next", title: t("5 / 5　複製成自己的版本"), body: t("這張範例不執行 AI、不寫入 Vault；複製後即可自由修改與繼續研究。") }
      ];
      const step = steps[this.sampleTourStep];
      const copy = tour.createDiv(); copy.createEl("strong", { text: step.title }); copy.createEl("p", { text: step.body });
      const actions = tour.createDiv("vam-sample-tour-actions");
      if (this.sampleTourStep > 0) this.button(actions, t("上一步"), () => { this.sampleTourStep--; this.selectSampleNode(steps[this.sampleTourStep].id); });
      if (this.sampleTourStep < steps.length - 1) this.button(actions, t("下一步"), () => { this.sampleTourStep++; this.selectSampleNode(steps[this.sampleTourStep].id); }).addClass("mod-cta");
      this.button(actions, this.sampleTourStep === steps.length - 1 ? t("完成導覽") : t("跳過導覽"), () => { this.showSampleTour = false; this.plugin.settings.sampleTourVersionSeen = SAMPLE_TOUR_VERSION; void this.plugin.saveSettings(); this.render(); });
    }
    if (this.builtIn) {
      const start = this.contentEl.createDiv("vam-sample-start");
      const ready = !!this.plugin.settings.models.trim();
      const copy = start.createDiv();
      copy.createEl("strong", { text: t("開始使用 VAM") });
      copy.createEl("p", { text: ready ? t("Codex 已就緒。複製範例或建立空白心智圖，開始自己的研究。") : t("先完成 Codex 設定，再複製範例或建立心智圖。你仍可繼續瀏覽這份唯讀範例。") });
      const actions = start.createDiv("vam-sample-start-actions");
      if (ready) {
        this.button(actions, t("複製到我的工作區"), () => this.enqueue(async () => this.openMap(await this.plugin.duplicateBuiltInSample()))).addClass("mod-cta");
        this.button(actions, t("建立空白心智圖"), () => new NameModal(this.app, t("新增心智圖"), t("新的心智圖"), title => this.enqueue(async () => this.openMap(await this.plugin.repo.createMap(title)))).open());
      } else this.button(actions, t("檢查 Codex"), () => this.enqueue(() => this.plugin.recheckCodex())).addClass("mod-cta");
    }
    const tools = this.contentEl.createDiv("vam-map-tools");
    if (!this.builtIn) {
      this.button(tools, t("＋ 議題"), () => this.enqueue(() => this.addNode(null))).addClass("mod-cta");
      this.button(tools, t("整理"), () => this.enqueue(() => this.openOrganizer()));
      const integrate = this.button(tools, this.integrationMode ? t("結束整合") : t("整合議題"), () => { this.integrationMode = !this.integrationMode; this.multiSelected.clear(); this.selected = null; this.render(); });
      if (this.integrationMode) integrate.addClass("is-active");
    }
    this.button(tools, "−", () => this.zoomBy(1 / 1.2)).setAttr("aria-label", t("縮小"));
    this.zoomLabel = tools.createSpan({ text: `${Math.round(this.map.viewport.zoom * 100)}%`, cls: "vam-zoom" });
    this.button(tools, "＋", () => this.zoomBy(1.2)).setAttr("aria-label", t("放大"));
    this.button(tools, t("顯示全部"), () => this.fit());
    const previewControl = tools.createEl("label", { cls: "vam-preview-size" });
    previewControl.createSpan({ text: t("預覽") });
    const previewRange = previewControl.createEl("input", { type: "range", attr: { min: "80", max: "240", step: "5", value: String(clampPreviewScale(this.plugin.settings.previewScale)) } });
    const previewValue = previewControl.createSpan({ cls: "vam-preview-value", text: `${clampPreviewScale(this.plugin.settings.previewScale)}%` });
    let previewSaveTimer: number | null = null;
    previewRange.addEventListener("input", () => {
      const value = clampPreviewScale(previewRange.value);
      this.plugin.settings.previewScale = value;
      previewValue.setText(`${value}%`);
      this.hoverCard?.remove(); this.hoverCard = null;
      if (previewSaveTimer !== null) window.clearTimeout(previewSaveTimer);
      previewSaveTimer = window.setTimeout(() => { void this.plugin.saveSettings(); previewSaveTimer = null; }, 250);
    });
    tools.createSpan({ cls: "vam-hint", text: t("拖曳空白處平移 · 滾輪縮放 · 點選節點編輯") });
    const workspace = this.contentEl.createDiv("vam-workspace");
    this.viewportEl = workspace.createDiv("vam-viewport");
    this.stageEl = this.viewportEl.createDiv("vam-stage");
    this.edgesEl = createSvg("svg"); this.edgesEl.addClass("vam-edges"); this.stageEl.appendChild(this.edgesEl);
    const shown = visibleNodes(this.map.nodes);
    if (this.selected && !shown.some(node => node.id === this.selected)) this.selected = null;
    this.multiSelected = new Set([...this.multiSelected].filter(id => shown.some(node => node.id === id)));
    if (this.integrationMode) {
      const selection = workspace.createDiv("vam-selection-bar");
      const names = [...this.multiSelected].map(id => this.notes.get(id)?.title).filter(Boolean);
      selection.createSpan({ text: this.multiSelected.size ? t("已選 {0} 個：{1}{2}", this.multiSelected.size, names.slice(0, 2).join("、"), names.length > 2 ? "…" : "") : t("請點選至少 2 個議題") });
      this.button(selection, t("清除"), () => { this.multiSelected.clear(); this.render(); }, !this.multiSelected.size);
      this.button(selection, t("下一步"), () => this.integrateSelected(), this.multiSelected.size < 2).addClass("mod-cta");
    }
    for (const node of shown) this.renderNode(node);
    if (!this.map.nodes.length) this.viewportEl.createDiv({ cls: "vam-empty", text: t("這張心智圖還沒有議題。點「＋ 議題」建立第一個節點。") });
    this.setupPan(); this.transform(); this.drawEdges();
    if (this.selected) { const node = this.map.nodes.find(n => n.id === this.selected); if (node) this.renderInspector(workspace, node); }
  }
  private renderNode(node: MapNode): void {
    if (!this.stageEl) return;
    const note = this.notes.get(node.id), card = this.stageEl.createDiv({ cls: `vam-node${node.id === this.selected || this.multiSelected.has(node.id) ? " is-selected" : ""}` });
    card.dataset.nodeId = node.id; card.style.left = `${node.x}px`; card.style.top = `${node.y}px`; card.tabIndex = 0; card.setAttr("aria-label", note?.title ?? t("筆記不存在"));
    const header = card.createDiv("vam-node-header");
    if (this.integrationMode) {
      const check = header.createSpan({ cls: `vam-select-check${this.multiSelected.has(node.id) ? " is-checked" : ""}`, text: this.multiSelected.has(node.id) ? "✓" : "" });
      check.setAttr("aria-hidden", "true");
    }
    if (!note || note.status !== "completed") header.createSpan({ cls: `vam-status vam-status-${note?.status ?? "error"}`, text: note ? t(labels[note.status]) : t("筆記不存在") });
    if (this.plugin.pendingSuggestions.has(node.path)) header.createSpan({ cls: "vam-badge-new", text: t("待確認建議") });
    const details = this.button(header, "↗", () => this.builtIn ? this.selectSampleNode(node.id) : this.openDetails(node)); details.addClass("vam-detail-button"); details.setAttr("aria-label", this.builtIn ? t("查看範例內容") : t("在右側欄開啟詳情"));
    const count = descendants(this.map!.nodes, node.id).size;
    if (count && !this.builtIn) this.button(header, node.collapsed ? t("展開 {0}", count) : t("收合"), () => this.enqueue(() => this.mapChange(map => { const n = map.nodes.find(n => n.id === node.id)!; n.collapsed = !n.collapsed; })));
    const title = card.createEl("h3", { text: note?.title ?? node.path, cls: "vam-card-title" });
    title.setAttr("title", note?.title ?? node.path);
    card.createEl("p", { cls: "vam-card-summary", text: note?.summary ?? t("檔案已移動或刪除，可從圖中移除此節點。") });
    if (!this.builtIn) this.enableDrag(card, node); else card.addClass("is-readonly");
    card.addEventListener("click", event => { if (Date.now() < this.suppressClickUntil) return; if ((event.target as Element).closest("button") || event.metaKey || event.ctrlKey) return; if (this.integrationMode) { if (this.multiSelected.has(node.id)) this.multiSelected.delete(node.id); else this.multiSelected.add(node.id); this.render(); return; } this.multiSelected.clear(); this.selected = node.id; this.render(); });
    card.addEventListener("keydown", event => { if (event.key === "Enter" && event.target === card) { this.selected = node.id; this.render(); } });
    if (!this.builtIn) card.addEventListener("contextmenu", event => { event.preventDefault(); new ChoiceModal(this.app, note?.title ?? t("議題操作"), t("選擇操作"), [
      { label: t("新增子議題"), action: () => this.enqueue(() => this.addNode(node)) },
      { label: t("AI 拆解議題"), action: () => this.enqueue(() => this.proposeChildren(node)) },
      { label: node.collapsed ? t("展開分支") : t("收合分支"), action: () => this.enqueue(() => this.mapChange(map => { map.nodes.find(n => n.id === node.id)!.collapsed = !node.collapsed; })) },
      { label: t("在右側欄開啟詳情"), action: () => this.openDetails(node) },
      { label: t("重新讀取筆記"), action: () => this.enqueue(async () => { await this.hydrate(); this.render(); }) },
      { label: t("從圖中移除"), action: () => this.enqueue(() => this.removeToUnassigned(node, false)) }
    ]).open(); });
    card.addEventListener("mouseenter", () => { if (!note || this.integrationMode || this.dragging) return; this.clearHoverTimer(); this.hoverTimer = window.setTimeout(() => { if (!this.dragging && card.isConnected) this.showHoverCard(card, note); }, 700); });
    card.addEventListener("mouseleave", () => this.hideHoverCardSoon());
  }
  private clearHoverTimer(): void {
    if (this.hoverTimer !== null) window.clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
  }
  private selectSampleNode(id: string): void {
    const node = this.map?.nodes.find(item => item.id === id); if (!node) return;
    this.selected = id; this.render(); this.focusNode(node);
  }
  private hideHoverCardSoon(): void {
    this.clearHoverTimer();
    this.hoverTimer = window.setTimeout(() => { this.hoverCard?.remove(); this.hoverCard = null; this.hoverTimer = null; }, 220);
  }
  private showHoverCard(card: HTMLElement, note: Note): void {
    const workspace = this.contentEl.querySelector<HTMLElement>(".vam-workspace"); if (!workspace) return;
    this.hoverCard?.remove();
    const preview = workspace.createDiv("vam-hover-card"); this.hoverCard = preview;
    const size = previewMetrics(this.plugin.settings.previewScale);
    preview.style.maxHeight = `${size.height}px`;
    preview.style.setProperty("--vam-hover-image-max", size.image);
    preview.style.setProperty("--vam-hover-title-size", size.title);
    preview.style.setProperty("--vam-hover-body-size", size.body);
    preview.style.setProperty("--vam-hover-label-size", size.labelSize);
    preview.style.setProperty("--vam-hover-table-size", size.table);
    preview.style.setProperty("--vam-hover-line-height", size.line);
    preview.style.setProperty("--vam-hover-padding", size.padding);
    preview.addEventListener("mouseenter", () => this.clearHoverTimer());
    preview.addEventListener("mouseleave", () => this.hideHoverCardSoon());
    preview.createEl("strong", { text: note.title });
    const content = preview.createDiv("vam-hover-markdown");
    const path = this.map?.nodes.find(node => node.id === card.dataset.nodeId)?.path ?? "";
    void MarkdownRenderer.render(this.app, note.preview || t("尚未加入預覽內容"), content, path, this);
    const host = workspace.getBoundingClientRect(), rect = card.getBoundingClientRect();
    const availableWidth = Math.max(180, host.width - 24);
    const width = Math.min(size.max, Math.max(Math.min(size.min, availableWidth), availableWidth));
    preview.style.width = `${width}px`;
    let left = rect.right - host.left + 12; if (left + width > host.width - 12) left = rect.left - host.left - width - 12;
    const visibleHeight = Math.min(size.height, Math.max(180, host.height - 24));
    const maxTop = Math.max(12, host.height - visibleHeight - 12);
    preview.style.left = `${Math.max(12, Math.min(left, Math.max(12, host.width - width - 12)))}px`; preview.style.top = `${Math.max(12, Math.min(rect.top - host.top, maxTop))}px`;
  }
  private refreshCard(node: MapNode): void {
    const card = this.stageEl?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(node.id)}"]`), note = this.notes.get(node.id);
    if (!card || !note) return;
    card.setAttr("aria-label", note.title); card.querySelector(".vam-card-title")?.setAttr("title", note.title); card.querySelector(".vam-card-title")?.setText(note.title); card.querySelector(".vam-card-summary")?.setText(note.summary);
    const header = card.querySelector<HTMLElement>(".vam-node-header");
    const status = card.querySelector<HTMLElement>(".vam-status");
    if (note.status === "completed") status?.remove();
    else if (status) { status.className = `vam-status vam-status-${note.status}`; status.setText(labels[note.status]); }
    else header?.createSpan({ cls: `vam-status vam-status-${note.status}`, text: labels[note.status] });
    this.drawEdges();
  }
  private renderInspector(parent: HTMLElement, node: MapNode): void {
    const panel = parent.createDiv("vam-inspector"), note = this.notes.get(node.id);
    const heading = panel.createDiv("vam-inspector-heading"); heading.createEl("strong", { text: this.builtIn ? t("範例內容") : t("議題工作台") }); this.button(heading, t("關閉"), () => { this.selected = null; this.render(); });
    if (note) {
      if (this.builtIn) {
        panel.createEl("h3", { text: note.title }); panel.createEl("p", { text: note.summary, cls: "vam-sample-summary" });
        const detail = panel.createDiv("vam-sample-detail"); void MarkdownRenderer.render(this.app, note.detail, detail, "", this);
        if (note.sourcePaths.length) { const sources = panel.createDiv("vam-reference-sources"); sources.createEl("strong", { text: t("來源議題") }); for (const path of note.sourcePaths) { const source = this.map?.nodes.find(item => item.path === path); if (source) this.button(sources, this.notes.get(source.id)?.title ?? path, () => this.selectSampleNode(source.id)); } }
        return;
      }
      const field = (label: string, key: "title" | "summary" | "rules" | "preview", rows = 0): void => {
        const wrapper = panel.createEl("label", { cls: "vam-field" }); wrapper.createSpan({ text: label });
        const input = rows ? wrapper.createEl("textarea", { text: note[key] }) : wrapper.createEl("input", { type: "text", value: note[key] });
        input.setAttr("aria-label", label); if (input instanceof HTMLTextAreaElement) input.rows = rows;
        const base = note[key];
        input.addEventListener("change", () => {
          const value = key === "title" ? input.value.trim() || t("未命名議題") : input.value.trim();
          note[key] = value;
          this.enqueue(() => this.saveFieldWithConflict(node, key, label, base, value));
        });
      };
      field(t("議題"), "title"); field(t("目前理解"), "summary", 4); field(t("預覽"), "preview", 6); field(t("AI 規則"), "rules", 4);
      const sourcePaths = this.referenceSourcePaths(note, node.path);
      if (sourcePaths.length) {
        const sources = panel.createDiv("vam-reference-sources"); sources.createEl("strong", { text: t("來源議題") });
        for (const path of sourcePaths) {
          const sourceNode = this.map?.nodes.find(item => item.path === path), sourceNote = sourceNode ? this.notes.get(sourceNode.id) : null;
          const file = this.app.vault.getAbstractFileByPath(path);
          this.button(sources, sourceNote?.title ?? (file instanceof TFile ? file.basename : t("{0}（已移動）", path.split("/").at(-1)?.replace(/\.md$/, ""))), () => {
            if (sourceNode) { this.selected = sourceNode.id; this.render(); this.focusNode(sourceNode); }
            else if (file instanceof TFile) void this.plugin.openDetails(file);
          }, !(sourceNode || file instanceof TFile));
        }
      }
      const actions = panel.createDiv("vam-actions");
      const running = this.plugin.running.has(node.path);
      const previewTask = (title: string, prompt: string): void => this.enqueue(async () => {
        const latest = await this.plugin.repo.readNote(node.path);
        new TaskModal(
          this.app,
          prompt,
          (value, run) => this.enqueue(async () => { await this.noteChange(node, { prompt: value }); if (run) await this.plugin.confirmCodexUsage(() => this.runAgent(node)); }),
          title,
          t("AI 完成後會直接更新目前理解，完整結果會保存在 MD 詳情中。送出前可調整任務。"),
          latest.rules
        ).open();
      });
      const nextSteps: { label: string; description?: string; action: () => void }[] = [
        { label: t("研究這個議題"), description: t("補足資訊、來源與仍待確認之處。"), action: () => previewTask(t("確認研究任務"), `研究「${note.title}」，補足資訊、來源與不確定處。`) },
        { label: t("比較可行選項"), description: t("整理方案、取捨與建議。"), action: () => previewTask(t("確認比較任務"), `比較「${note.title}」的可行選項、取捨與建議。`) },
        { label: t("檢查風險與假設"), description: t("尋找反例、風險及待驗證假設。"), action: () => previewTask(t("確認風險檢查任務"), `找出「${note.title}」的反例、風險與待驗證假設。`) },
        { label: t("由 AI 拆成子議題"), description: t("產生 3–7 個建議；確認後才建立節點。"), action: () => this.enqueue(() => this.proposeChildren(node)) },
        { label: t("整合子議題發現"), description: t("彙整直屬子議題；確認任務後自動更新目前理解。"), action: () => this.enqueue(() => this.integrateChildren(node)) },
        { label: t("手動新增子議題"), description: t("建立空白子議題，不會執行 AI。"), action: () => this.enqueue(() => this.addNode(node)) },
        { label: t("自己描述下一步"), description: t("自行撰寫這次要 AI 完成的工作，可只儲存或確認並執行。"), action: () => previewTask(t("自己描述下一步"), note.prompt) }
      ];
      if (note.prompt.trim()) nextSteps.splice(3, 0, { label: t("執行已保存的任務"), description: t("執行先前保存的任務；送出前仍可修改。"), action: () => previewTask(t("確認已保存的任務"), note.prompt) });
      this.button(actions, running ? t("AI 執行中…") : t("選擇下一步"), () => this.enqueue(async () => {
        const input = panel.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${t("AI 規則")}"]`);
        const rules = input?.value.trim() ?? note.rules;
        const latest = await this.plugin.repo.readNote(node.path);
        if (rules !== latest.rules) await this.noteChange(node, { rules });
        new ChoiceModal(this.app, t("下一步"), t("選擇目的後，再確認 AI 將執行的任務。"), nextSteps).open();
      }), running).addClass("mod-cta");
      const pending = this.plugin.pendingSuggestions.get(node.path);
      if (pending?.length) this.button(actions, t("查看 AI 子議題建議（{0}）", pending.length), () => this.openChildSuggestions(node, pending), running);
      const advanced = panel.createEl("details", { cls: "vam-advanced" }); advanced.createEl("summary", { text: t("模型與進階設定") });
      const modelLabel = advanced.createEl("label", { cls: "vam-field" }); modelLabel.createSpan({ text: t("使用模型") });
      const select = modelLabel.createEl("select"); select.setAttr("aria-label", t("使用模型"));
      const options = new Set(this.plugin.settings.models.split(/[\n,]/).map(s => s.trim()).filter(Boolean));
      for (const model of options) select.createEl("option", { value: model, text: model });
      if (!options.has(note.model)) { const unavailable = select.createEl("option", { value: note.model, text: t("目前模型已不可用") }); unavailable.disabled = true; }
      select.value = note.model;
      select.addEventListener("change", () => { if (options.has(select.value)) this.enqueue(() => this.noteChange(node, { model: select.value, modelSource: "manual" })); });
      const sourceLabels: Record<ModelSource, string> = { workspace: t("工作區預設"), inherited: t("建立時繼承"), manual: t("手動指定") };
      advanced.createEl("p", { cls: "vam-hint", text: t("{0} · {1}；一般任務使用低推理，整合子議題使用高推理。", note.model, sourceLabels[note.modelSource]) });
    } else {
      panel.createEl("p", { text: t("此節點的筆記不存在，可重新連結未歸類筆記或從圖中移除。") });
      this.button(panel, t("重新連結筆記"), () => this.enqueue(async () => {
        const candidates = [...await this.plugin.repo.collectionFiles(this.path, "Unassigned"), ...await this.plugin.repo.inboxFiles()];
        new NoteCollectionModal(this.app, t("重新連結筆記"), candidates, [{ label: t("使用這份筆記"), run: file => this.enqueue(() => this.relinkMissingNode(node, file)) }]).open();
      }));
    }
    this.button(panel, t("從圖中移除"), () => new ChoiceModal(this.app, t("從圖中移除"), t("筆記會移至目前主題的 Unassigned，可重新認領或復原。"), [{ label: t("只移除此節點，子議題變成根議題"), action: () => this.enqueue(() => this.removeToUnassigned(node, false)) }]).open());
    const relationship = panel.createEl("details", { cls: "vam-advanced" }); relationship.createEl("summary", { text: t("結構與連結") });
    const parentLabel = relationship.createEl("label", { cls: "vam-field" }); parentLabel.createSpan({ text: t("所屬母議題") });
    const parents = parentLabel.createEl("select"); parents.setAttr("aria-label", t("母議題／連結")); parents.createEl("option", { value: "", text: t("無母議題（根議題）") });
    for (const candidate of this.map!.nodes) if (canParent(this.map!.nodes, node.id, candidate.id)) parents.createEl("option", { value: candidate.id, text: this.notes.get(candidate.id)?.title ?? candidate.path });
    parents.value = node.parentId ?? "";
    parents.addEventListener("change", () => { const parentId = parents.value || null; this.enqueue(() => this.mapChange(map => { if (!canParent(map.nodes, node.id, parentId)) throw new Error(t("不能建立循環連結。")); map.nodes.find(n => n.id === node.id)!.parentId = parentId; })); });
    this.button(relationship, t("移除母議題連結"), () => this.enqueue(() => this.mapChange(map => { map.nodes.find(n => n.id === node.id)!.parentId = null; })), !node.parentId);
    relationship.createEl("p", { cls: "vam-hint", text: t("更換母議題會影響下次 AI 任務取得的背景，不會更動模型。") });
    this.button(relationship, t("從圖中移除"), () => new ChoiceModal(this.app, t("從圖中移除"), t("筆記會移至目前主題的 Unassigned，可重新認領或復原。"), [{ label: t("只移除此節點，子議題變成根議題"), action: () => this.enqueue(() => this.removeToUnassigned(node, false)) }, { label: t("移除整個分支"), action: () => this.enqueue(() => this.removeToUnassigned(node, true)) }]).open());
  }
  private async previewMigration(): Promise<void> {
    const plan = await this.plugin.repo.legacyMigrationPlan();
    if (!plan.maps.length && !plan.orphanPaths.length) { new Notice(t("沒有需要整理的舊資料。")); return; }
    const noteCount = plan.maps.reduce((sum, item) => sum + item.notePaths.length, 0);
    const description = t("將建立 {0} 個主題資料夾，搬移 {1} 份圖內筆記，並將 {2} 份孤兒筆記移至 Inbox。任一步失敗都會還原已搬移的檔案。", plan.maps.length, noteCount, plan.orphanPaths.length);
    new ChoiceModal(this.app, t("整理舊版資料"), description, [{ label: t("確認整理"), action: () => this.enqueue(async () => {
      const current = this.path, mapping = await this.plugin.repo.migrateLegacyWorkspace(plan), next = mapping.get(current);
      this.history.clear(); if (next) await this.openMap(next); else this.render(); new Notice(t("舊資料已整理為主題資料夾。"));
    }) }]).open();
  }
  private async repairMissingTopic(): Promise<void> {
    const broken = await this.plugin.repo.brokenTopics();
    if (!broken.length) { new Notice(t("沒有缺少 Map.md 的主題。")); return; }
    new ChoiceModal(this.app, t("修復遺失 Map"), t("選擇要修復的主題"), broken.map(topic => ({ label: t("{0}（{1} 份 Notes）", topic.title, topic.noteCount), action: () => {
      new ChoiceModal(this.app, topic.title, t("可由 Notes 重建所有節點皆為根節點的新 Map，或重新連結位於主題資料夾外的既有 Map。"), [
        { label: t("從 Notes 重建"), action: () => this.enqueue(async () => this.openMap(await this.plugin.repo.rebuildMissingMap(topic.root))) },
        { label: t("重新連結既有 Map"), action: () => this.enqueue(async () => {
          const candidates = (await this.plugin.repo.mapFiles()).filter(file => !file.path.startsWith(`${this.plugin.settings.topicsFolder}/`));
          new ChoiceModal(this.app, t("選擇既有 Map"), t("選取後會搬回此主題並重新建立可辨識的節點路徑。"), candidates.map(file => ({ label: file.path, action: () => this.enqueue(async () => this.openMap(await this.plugin.repo.relinkMissingMap(topic.root, file.path))) }))).open();
        }) }
      ]).open();
    } }))).open();
  }
  private async addNode(parent: MapNode | null, suggestedTitle?: string, rebuildDerivedData = true): Promise<void> {
    if (!this.map) return;
    const model = inheritModel(parent ? (await this.plugin.repo.readNote(parent.path)).model : undefined, this.plugin.settings.cliModel);
    if (!this.path.startsWith(`${this.plugin.settings.topicsFolder}/`)) { new Notice(t("請先使用「整理舊資料」轉換目前心智圖。")); return; }
    const node = await this.plugin.repo.createNote(suggestedTitle?.trim() || (parent ? t("新的子議題") : t("我的核心議題")), model, this.map, this.path, parent ? "inherited" : "workspace");
    if (parent) await this.plugin.repo.updateNote(node.path, { rules: (await this.plugin.repo.readNote(parent.path)).rules });
    node.parentId = parent?.id ?? null; node.x = parent ? parent.x + 340 : 80;
    const siblings = this.map.nodes.filter(n => n.parentId === node.parentId);
    node.y = siblings.length ? Math.max(...siblings.map(n => n.y)) + 220 : parent?.y ?? 80;
    this.notes.set(node.id, await this.plugin.repo.readNote(node.path)); this.selected = node.id;
    await this.mapChange(map => { map.nodes.push(node); if (parent) map.nodes.find(n => n.id === parent.id)!.collapsed = false; }, rebuildDerivedData); this.focusNode(node);
  }
  private async proposeChildren(parent: MapNode, confirmed = false): Promise<void> {
    const pending = this.plugin.pendingSuggestions.get(parent.path);
    if (pending?.length) { this.openChildSuggestions(parent, pending); return; }
    const note = await this.plugin.repo.readNote(parent.path);
    if (this.plugin.running.has(parent.path)) return;
    if (!confirmed) {
      new ChoiceModal(this.app, t("確認 AI 拆解"), t("AI 會分析目前議題並提出 3–7 個子議題；結果完成後仍需由你確認才會建立節點。\n\n本次套用的 AI 規則：\n{0}", note.rules.trim() || "未設定額外規則。"), [
        { label: t("使用 {0}", note.model), description: t("這會執行一次低推理 AI 任務，不會直接修改心智圖結構。"), buttonLabel: t("確認並執行"), action: () => void this.plugin.confirmCodexUsage(async () => this.enqueue(() => this.proposeChildren(parent, true))) }
      ]).open();
      return;
    }
    this.plugin.running.add(parent.path); this.render();
    try {
      const result = await this.plugin.askModel({ title: note.title, summary: note.summary, rules: note.rules, detail: note.detail, task: "請判斷此議題是否需要拆解。若需要，提出 3 到 7 個可獨立處理的子議題，每項提供 title、task 與 contribution；不要建立或修改任何檔案。", ancestors: await this.ancestorContext(parent), mode: "decompose" }, note.model);
      const suggestions = result.suggestions.slice(0, 7);
      if (suggestions.length < 3) { new Notice(t("AI 認為目前不需要拆解，或沒有提出 3 至 7 個可建立的子議題。")); return; }
      this.plugin.pendingSuggestions.set(parent.path, suggestions);
      new Notice(t("子議題建議完成：{0} 項。點選節點後可查看。", suggestions.length));
    } catch (error) { console.error("Visual Agent Map AI split", error); new Notice(this.plugin.recordFailure("AI 拆解失敗", error)); }
    finally { this.plugin.running.delete(parent.path); await this.hydrate(); this.render(); }
  }
  private openChildSuggestions(parent: MapNode, suggestions: Suggestion[]): void {
    new ChildProposalModal(this.app, suggestions.slice(0, 7), items => this.enqueue(async () => {
      this.plugin.pendingSuggestions.delete(parent.path);
      await this.createChildBatch(parent, items);
    })).open();
  }
  private async createChildBatch(parent: MapNode, items: Suggestion[]): Promise<void> {
    let created = 0;
    try {
      for (const item of items) {
        await this.addNode(parent, item.title, false); created++;
        const child = this.map!.nodes.at(-1)!;
        await this.noteChange(child, { prompt: item.task, detail: item.contribution ? canonicalDetail(item.contribution) : "" });
      }
    } finally {
      if (created) await this.plugin.rebuildDerivedData();
    }
  }
  private async ancestorContext(node: MapNode): Promise<string> {
    const chain: MapNode[] = [], seen = new Set([node.id]); let parent = node.parentId;
    while (parent && !seen.has(parent)) { seen.add(parent); const n = this.map?.nodes.find(item => item.id === parent); if (!n) break; chain.unshift(n); parent = n.parentId; }
    const ancestors: string[] = [];
    for (const n of chain) { const info = await this.plugin.repo.readNote(n.path); ancestors.push(`- ${info.title}\n  目前理解：${info.summary}\n  AI 規則：${info.rules || "（無）"}`); }
    return ancestors.join("\n");
  }
  private referenceSourcePaths(note: Note, ownerPath: string): string[] {
    if (note.sourcePaths.length) return [...new Set(note.sourcePaths)];
    const markers = ["### 整合來源（保存內容）", "### 萃取來源（強連結備份）", "### 萃取來源（弱連結）", "### 合併來源"];
    const marker = markers.find(value => note.detail.includes(value)); if (!marker) return [];
    const section = note.detail.slice(note.detail.indexOf(marker) + marker.length);
    const paths = [...section.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map(match => {
      const link = match[1], direct = link.endsWith(".md") ? link : `${link}.md`;
      if (this.app.vault.getAbstractFileByPath(direct) instanceof TFile) return direct;
      return this.app.metadataCache.getFirstLinkpathDest(link, ownerPath)?.path ?? direct;
    });
    return [...new Set(paths)];
  }
  private async integrateChildren(node: MapNode, confirmed = false): Promise<void> {
    if (!this.map || this.plugin.running.has(node.path)) return;
    const note = await this.plugin.repo.readNote(node.path);
    const children = this.map.nodes.filter(item => item.parentId === node.id);
    if (!children.length) { new Notice(t("這個議題目前沒有直屬子議題。")); return; }
    if (!confirmed) {
      new ChoiceModal(this.app, t("確認整合子議題"), t("AI 會讀取 {0} 個直屬子議題；完成後直接更新目前理解與 MD 詳情。\n\n本次套用的 AI 規則：\n{1}", children.length, note.rules.trim() || "未設定額外規則。"), [
        { label: t("使用 {0}", note.model), description: t("這會執行一次高推理 AI 任務。"), buttonLabel: t("確認並執行"), action: () => void this.plugin.confirmCodexUsage(async () => this.enqueue(() => this.integrateChildren(node, true))) }
      ]).open();
      return;
    }
    const sourceContext = await this.sourceDigest(children, children.length <= 3 ? "strong" : "summary");
    const task = "根據直屬子議題的完整知識，更新母議題的目前理解與結構化知識；合併重複資訊，清楚標示共識、差異、取捨與待確認事項。";
    this.plugin.running.add(node.path); await this.plugin.repo.updateNote(node.path, { status: "running" }); await this.hydrate(); this.render();
    try {
      const result = await this.plugin.askModel({ title: note.title, summary: note.summary, rules: note.rules, detail: note.detail, task, ancestors: await this.ancestorContext(node), sourceContext, mode: "synthesize" }, note.model);
      await this.plugin.repo.updateNote(node.path, { summary: result.summary, detail: canonicalDetail(result.detail), visualReferences: visualReferencesMarkdown(result.visualReferences), newFindings: "", status: "completed" });
      new Notice(t("子議題整合已寫入目前理解與 MD 詳情。"));
    } catch (error) { console.error("Visual Agent Map child integration", error); await this.plugin.repo.updateNote(node.path, { status: "error" }); new Notice(this.plugin.recordFailure("子議題整合失敗", error)); }
    finally { this.plugin.running.delete(node.path); await this.hydrate(); this.render(); }
  }
  private integrateSelected(): void {
    if (!this.map || this.multiSelected.size < 2) { new Notice(t("請至少選取兩個議題。")); return; }
    const nodes = [...this.multiSelected].map(id => this.map!.nodes.find(node => node.id === id)).filter((node): node is MapNode => !!node);
    const notes = nodes.map(node => this.notes.get(node.id)).filter((note): note is Note => !!note);
    const sharedRules = notes.length && notes.every(note => note.rules === notes[0].rules) ? notes[0].rules : "";
    new IntegrationModal(this.app, notes.map(note => note.title), sharedRules, (title, goal, rules) => void this.plugin.confirmCodexUsage(async () => this.enqueue(() => this.createIntegratedNode(title, nodes, goal, rules)))).open();
  }
  private async sourceDigest(sources: MapNode[], mode: "strong" | "summary" | "weak" = "strong"): Promise<string> {
    if (mode === "weak") return sources.map(source => `- [[${source.path.replace(/\.md$/, "")}]]`).join("\n");
    const notes = await Promise.all(sources.map(source => this.plugin.repo.readNote(source.path)));
    return sources.map((source, index) => {
      const note = notes[index];
      const finding = note.newFindings.trim();
      return [
        `- [[${source.path.replace(/\.md$/, "")}]]`,
        `  - 目前理解：${note.summary || "尚未形成結論"}`,
        mode === "strong" && note.detail.trim() ? `  - 完整知識：\n${note.detail.trim().split("\n").map(line => `    ${line}`).join("\n")}` : "",
        finding ? `  - 舊版待整理發現：${finding}` : ""
      ].filter(Boolean).join("\n");
    }).join("\n");
  }
  private async extractedSourceContext(note: Note): Promise<string> {
    if (note.sourcePaths.length) {
      const lines: string[] = [];
      for (const path of note.sourcePaths) {
        try { lines.push((await this.sourceDigest([{ id: path, path, parentId: null, x: 0, y: 0, collapsed: false }], "strong")).trim()); }
        catch { lines.push(`- [[${path.replace(/\.md$/, "")}]]\n  - 來源讀取失敗或已移動。`); }
      }
      return lines.join("\n");
    }
    for (const marker of ["### 整合來源（保存內容）", "### 萃取來源（強連結備份）", "### 合併來源"]) {
      const index = note.detail.indexOf(marker);
      if (index >= 0) return note.detail.slice(index + marker.length).trim();
    }
    const weakMarker = "### 萃取來源（弱連結）";
    const weakIndex = note.detail.indexOf(weakMarker);
    if (weakIndex < 0) return "";
    const sourceSection = note.detail.slice(weakIndex + weakMarker.length);
    const paths = [...sourceSection.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map(match => `${match[1]}.md`);
    const unique = [...new Set(paths)];
    const lines: string[] = [];
    for (const path of unique) {
      try {
        lines.push((await this.sourceDigest([{ id: path, path, parentId: null, x: 0, y: 0, collapsed: false }], "strong")).trim());
      } catch {
        lines.push(`- [[${path.replace(/\.md$/, "")}]]\n  - 來源讀取失敗或已移動。`);
      }
    }
    return lines.join("\n");
  }
  private async createIntegratedNode(title: string, sources: MapNode[], goal: string, rules: string): Promise<void> {
    if (!this.map || sources.length < 2) return;
    this.integrationMode = false; this.multiSelected.clear(); this.render();
    const model = this.plugin.settings.cliModel;
    const sourceText = await this.sourceDigest(sources, "strong");
    const result = await this.plugin.askModel({ title, summary: "尚未形成結論", rules, detail: "", task: goal, ancestors: "", sourceContext: sourceText, mode: "synthesize" }, model);
    const integrated = await this.plugin.repo.createNote(title, model, this.map, this.path, "workspace");
    await this.plugin.repo.updateNote(integrated.path, { summary: result.summary, rules, detail: canonicalDetail(result.detail), visualReferences: visualReferencesMarkdown(result.visualReferences), prompt: goal, sourcePaths: sources.map(source => source.path), status: "completed" });
    integrated.parentId = null;
    integrated.x = Math.max(...sources.map(node => node.x)) + 340;
    integrated.y = sources.reduce((sum, node) => sum + node.y, 0) / sources.length;
    this.notes.set(integrated.id, await this.plugin.repo.readNote(integrated.path)); this.selected = integrated.id; this.multiSelected.clear(); this.integrationMode = false;
    await this.mapChange(map => { map.nodes.push(integrated); });
    await this.hydrate(); this.render(); this.focusNode(integrated);
  }
  private transform(): void { if (!this.map || !this.stageEl) return; const { x, y, zoom } = this.map.viewport; this.stageEl.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`; this.zoomLabel?.setText(`${Math.round(zoom * 100)}%`); }
  private saveViewport(): void { if (this.viewportTimer !== null) window.clearTimeout(this.viewportTimer); this.viewportTimer = window.setTimeout(() => { this.viewportTimer = null; this.enqueue(() => this.persist()); }, 250); }
  private zoomBy(factor: number, point?: { x: number; y: number }): void {
    if (!this.map || !this.viewportEl) return;
    const center = point ?? { x: this.viewportEl.clientWidth / 2, y: this.viewportEl.clientHeight / 2 }, v = this.map.viewport;
    const zoom = Math.min(2, Math.max(0.25, v.zoom * factor)), ratio = zoom / v.zoom;
    v.x = center.x - (center.x - v.x) * ratio; v.y = center.y - (center.y - v.y) * ratio; v.zoom = zoom; this.transform(); this.saveViewport();
  }
  private focusNode(node: MapNode): void { if (!this.map || !this.viewportEl) return; const v = this.map.viewport; v.x = this.viewportEl.clientWidth / 2 - (node.x + 140) * v.zoom; v.y = this.viewportEl.clientHeight / 2 - (node.y + 80) * v.zoom; this.transform(); this.saveViewport(); }
  private fit(): void {
    if (!this.map || !this.viewportEl) return;
    const nodes = visibleNodes(this.map.nodes); if (!nodes.length) return;
    const minX = Math.min(...nodes.map(n => n.x)), maxX = Math.max(...nodes.map(n => n.x + 280));
    const minY = Math.min(...nodes.map(n => n.y)), maxY = Math.max(...nodes.map(n => n.y + (this.stageEl?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(n.id)}"]`)?.offsetHeight ?? 180)));
    const width = this.viewportEl.clientWidth, height = this.viewportEl.clientHeight;
    const zoom = Math.max(0.25, Math.min(1.2, (width - 80) / (maxX - minX), (height - 80) / (maxY - minY)));
    this.map.viewport = { zoom, x: (width - (maxX - minX) * zoom) / 2 - minX * zoom, y: (height - (maxY - minY) * zoom) / 2 - minY * zoom }; this.transform(); this.saveViewport();
  }
  private setupPan(): void {
    const viewport = this.viewportEl!;
    viewport.addEventListener("wheel", event => { event.preventDefault(); const rect = viewport.getBoundingClientRect(); this.zoomBy(Math.exp(-event.deltaY * (event.deltaMode === 0 ? 0.002 : 0.04)), { x: event.clientX - rect.left, y: event.clientY - rect.top }); }, { passive: false });
    viewport.addEventListener("pointerdown", event => {
      if ((event.target as Element).closest(".vam-node") || event.button !== 0 || !this.map) return;
      const x = event.clientX, y = event.clientY, origin = { ...this.map.viewport }; let moved = false;
      viewport.setPointerCapture(event.pointerId); viewport.addClass("is-panning");
      const move = (e: PointerEvent): void => { moved ||= Math.hypot(e.clientX - x, e.clientY - y) > 3; this.map!.viewport.x = origin.x + e.clientX - x; this.map!.viewport.y = origin.y + e.clientY - y; this.transform(); };
      const up = (): void => { viewport.removeEventListener("pointermove", move); viewport.removeEventListener("pointerup", up); viewport.removeEventListener("pointercancel", up); viewport.removeClass("is-panning"); this.saveViewport(); if (!moved && !this.integrationMode) { this.selected = null; this.multiSelected.clear(); this.render(); } };
      viewport.addEventListener("pointermove", move); viewport.addEventListener("pointerup", up); viewport.addEventListener("pointercancel", up);
    });
  }
  private enableDrag(card: HTMLElement, node: MapNode): void {
    card.addEventListener("pointerdown", event => {
      if (this.integrationMode || (event.target as Element).closest("button") || event.button !== 0 || !this.map) return;
      this.clearHoverTimer(); this.hoverCard?.remove(); this.hoverCard = null; this.dragging = true;
      const currentNode = this.map.nodes.find(item => item.id === node.id); if (!currentNode) { this.dragging = false; return; }
      const start = { x: event.clientX, y: event.clientY }, origin = { x: currentNode.x, y: currentNode.y }; let position = { ...origin }, moved = false;
      card.setPointerCapture(event.pointerId);
      const move = (e: PointerEvent): void => { moved ||= Math.hypot(e.clientX - start.x, e.clientY - start.y) > 3; if (!moved) return; position = { x: origin.x + (e.clientX - start.x) / this.map!.viewport.zoom, y: origin.y + (e.clientY - start.y) / this.map!.viewport.zoom }; card.style.left = `${position.x}px`; card.style.top = `${position.y}px`; this.drawEdges(); };
      const finish = (e: PointerEvent): void => { this.dragging = false; this.suppressClickUntil = moved ? Date.now() + 250 : 0; card.removeEventListener("pointermove", move); card.removeEventListener("pointerup", finish); card.removeEventListener("pointercancel", finish); if (e.type === "pointercancel") { card.style.left = `${origin.x}px`; card.style.top = `${origin.y}px`; this.drawEdges(); return; } if (moved) this.enqueue(() => this.mapChange(map => { const current = map.nodes.find(n => n.id === node.id); if (!current) return; current.x = Math.round(position.x); current.y = Math.round(position.y); })); else if (e.metaKey || e.ctrlKey) { if (this.multiSelected.has(node.id)) this.multiSelected.delete(node.id); else this.multiSelected.add(node.id); this.selected = node.id; this.render(); } else { this.multiSelected.clear(); this.selected = node.id; this.render(); } };
      card.addEventListener("pointermove", move); card.addEventListener("pointerup", finish); card.addEventListener("pointercancel", finish);
    });
  }
  private drawEdges(): void {
    if (!this.edgesEl || !this.stageEl || !this.map) return;
    this.edgesEl.replaceChildren();
    for (const node of visibleNodes(this.map.nodes)) {
      if (!node.parentId) continue;
      const parent = this.stageEl.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(node.parentId)}"]`), child = this.stageEl.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(node.id)}"]`); if (!parent || !child) continue;
      const x1 = parent.offsetLeft + parent.offsetWidth, y1 = parent.offsetTop + parent.offsetHeight / 2, x2 = child.offsetLeft, y2 = child.offsetTop + child.offsetHeight / 2, bend = Math.max(60, Math.abs(x2 - x1) / 2);
      const path = createSvg("path"); path.setAttribute("d", `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`); path.addClass("vam-edge"); this.edgesEl.appendChild(path);
    }
  }
  private async runAgent(node: MapNode): Promise<void> {
    const note = await this.plugin.repo.readNote(node.path);
    if (!note.prompt) { new Notice(t("請先輸入要交給 AI 的問題或任務。")); return; }
    if (this.plugin.running.has(node.path)) return;
    const context: TaskContext = { title: note.title, summary: note.summary, rules: note.rules, detail: note.detail, task: note.prompt, ancestors: await this.ancestorContext(node), workingFindings: note.newFindings, sourceContext: await this.extractedSourceContext(note), mode: "task" };
    this.plugin.pendingSuggestions.delete(node.path);
    this.plugin.running.add(node.path);
    try { await this.plugin.repo.updateNote(node.path, { status: "running" }); } catch (error) { this.plugin.running.delete(node.path); throw error; }
    await this.hydrate(); this.render();
    // Leave the mutation queue immediately: independent branches can run concurrently.
    void this.plugin.askModel(context, note.model).then(result => this.plugin.mutate(async () => {
      await this.plugin.repo.updateNote(node.path, { summary: result.summary, detail: canonicalDetail(result.detail), visualReferences: visualReferencesMarkdown(result.visualReferences), newFindings: "", status: "completed" });
      for (const view of this.plugin.views()) view.history.clear();
      if (result.suggestions.length) this.plugin.pendingSuggestions.set(node.path, result.suggestions.slice(0, 7));
    })).catch(error => this.plugin.mutate(async () => {
      console.error("Visual Agent Map AI task", error); await this.plugin.repo.updateNote(node.path, { status: "error" });
      new Notice(this.plugin.recordFailure("AI 任務失敗", error));
    })).finally(() => {
      this.plugin.running.delete(node.path);
      for (const view of this.plugin.views()) view.enqueue(async () => { await view.hydrate(); view.render(); });
    }).catch(() => {});
  }
}
class VisualAgentMapSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: VisualAgentMapPlugin) { super(app, plugin); }
  getSettingDefinitions(): SettingDefinitionItem[] {
    const text = (name: string, key: "codexPath", desc: string): SettingDefinitionItem => ({ name, desc, control: { type: "text", key } });
    const diagnostic = this.plugin.codexDiagnostic();
    const models = Object.fromEntries(this.plugin.settings.models.split(/[,\n]/).map(model => model.trim()).filter(Boolean).map(model => [model, model]));
    return [
      { name: t("介面語言"), control: { type: "dropdown", key: "language", options: { "zh-TW": "繁體中文", en: "English" } } },
      text(t("Codex CLI 路徑"), "codexPath", t("VAM 會以此啟動 codex app-server。")),
      { name: t("工作區預設 Model"), desc: t("模型清單由 Codex App Server 自動取得；變更只影響之後新增的根議題。"), control: { type: "dropdown", key: "cliModel", options: models } },
      { name: t("Workspace 位置"), render: setting => { setting.setName(t("Workspace 位置")).setDesc(t("主題資料夾：{0}　未分類收件匣：{1}", this.plugin.settings.topicsFolder, this.plugin.settings.inboxFolder)); } },
      { name: t("修復 Agent Workspace"), render: setting => { setting.setName(t("修復 Agent Workspace")).setDesc(t("只建立缺少的基本資料夾，不會復原、搬移或覆寫筆記與心智圖。")).addButton(button => button.setButtonText(t("修復")).onClick(() => { void this.plugin.mutate(() => this.plugin.repairWorkspace()); })); } },
      { name: t("重新整理 VAM 資料"), render: setting => { setting.setName(t("重新整理 VAM 資料")).setDesc(t("重新掃描心智圖與議題筆記，重建 reference 與衍生資料。原始內容不會被覆寫。")).addButton(button => button.setButtonText(t("完整重建")).onClick(() => { void this.plugin.mutate(() => this.plugin.fullRebuild()); })); } },
      { name: t("找回既有 Workspace"), render: setting => { setting.setName(t("找回既有 Workspace")).setDesc(t("掃描可辨識的 VAM Workspace，確認後才重新連結，不會搬移或覆寫資料。")).addButton(button => button.setButtonText(t("掃描")).onClick(() => { void this.plugin.offerWorkspaceReconnect(); })); } },
      { name: t("Codex App Server 狀態"), render: setting => {
        setting.setName(t("Codex App Server 狀態")).setDesc(diagnostic.installed ? t("已找到 Codex CLI：{0}", diagnostic.executable) : t("未找到 Codex CLI。請依安裝說明完成安裝與 ChatGPT 登入；VAM 不會自動安裝系統套件。"));
        if (!diagnostic.installed) setting.addButton(button => button.setButtonText(t("安裝說明")).onClick(() => this.plugin.openCodexSetupGuide()));
        setting.addButton(button => button.setButtonText(t("重新檢查")).onClick(() => { void this.plugin.recheckCodex(); }));
      } }
    ];
  }
  async setControlValue(key: string, value: unknown): Promise<void> {
    const languageChanged = key === "language";
    if (languageChanged) this.plugin.settings.language = value === "en" ? "en" : "zh-TW";
    else if (typeof value === "string" && (key === "codexPath" || key === "cliModel")) this.plugin.settings[key] = value.trim();
    else return;
    if (key === "codexPath") this.plugin.resetCodexRuntime();
    setUiLanguage(this.plugin.settings.language);
    await this.plugin.saveSettings();
    if (languageChanged) {
      for (const view of this.plugin.views()) await view.refreshFromPlugin();
      this.update();
    }
  }
}
export default class VisualAgentMapPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  repo!: Repository;
  ready: Promise<void> = Promise.resolve();
  readonly running = new Set<string>();
  readonly pendingSuggestions = new Map<string, Suggestion[]>();
  readonly logs: LogManager = debugLog;
  private codexRuntime: CodexAppServerRuntime | null = null;
  private settingTab!: VisualAgentMapSettingTab;
  private detailsLeaf: WorkspaceLeaf | null = null;
  private queue: Promise<void> = Promise.resolve();
  private writing = 0;
  private externalReconcileTimer: number | null = null;
  private firstInstallSamplePending = false;
  private workspaceRecoveryCandidates: string[] = [];
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
  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<Settings> | null;
    const legacy: (Partial<Settings> & { cliPath?: string }) | null = saved;
    this.settings = { ...DEFAULT_SETTINGS, language: saved?.language === "en" ? "en" : "zh-TW", workspaceFolder: saved?.workspaceFolder || DEFAULT_SETTINGS.workspaceFolder, topicsFolder: saved?.topicsFolder || DEFAULT_SETTINGS.topicsFolder, inboxFolder: saved?.inboxFolder || DEFAULT_SETTINGS.inboxFolder, notesFolder: saved?.notesFolder || DEFAULT_SETTINGS.notesFolder, mapsFolder: saved?.mapsFolder || DEFAULT_SETTINGS.mapsFolder, mapId: saved?.mapId || "default", codexPath: saved?.codexPath || legacy?.cliPath || DEFAULT_SETTINGS.codexPath, cliModel: saved?.cliModel || DEFAULT_SETTINGS.cliModel, cliReasoning: saved?.cliReasoning || DEFAULT_SETTINGS.cliReasoning, previewScale: saved?.previewScale !== undefined ? clampPreviewScale(saved.previewScale) : legacyPreviewScale(saved?.previewSize), models: "", migrated: saved?.migrated === true, structureVersion: saved?.structureVersion ?? (saved ? 1 : DEFAULT_SETTINGS.structureVersion), firstUseNoticeSeen: saved?.firstUseNoticeSeen === true, codexUsageNoticeSeen: saved?.codexUsageNoticeSeen === true, workspaceInitialized: saved ? saved.workspaceInitialized !== false : false, sampleTourVersionSeen: saved?.sampleTourVersionSeen ?? 0 };
    setUiLanguage(this.settings.language);
    this.logs.appendLog("info", `Visual Agent Map ${this.manifest.version || "unknown"} 載入`);
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
        if (count) new Notice(t("已將 {0} 份子議題檔名同步為議題名稱。", count));
      }
    });
    this.ready = initialize;
    this.registerView(VIEW_TYPE, leaf => new VisualAgentMapView(leaf, this));
    this.addRibbonIcon("git-fork", "Open map", () => { void this.activateView().catch(error => new Notice(String(error))); });
    this.addCommand({ id: "open-map", name: "Open map", callback: () => { void this.activateView().catch(error => new Notice(String(error))); } });
    this.addCommand({ id: "rebuild-references", name: t("重新整理 VAM 資料"), callback: () => { void this.mutate(() => this.fullRebuild()); } });
    this.addCommand({ id: "normalize-note-filenames", name: t("同步議題名稱與檔名"), callback: () => { void this.mutate(async () => { const count = await this.repo.normalizeGeneratedNoteFilenames(); new Notice(count ? t("已同步 {0} 份議題檔名。", count) : t("議題檔名已是最新狀態。")); }); } });
    this.addCommand({ id: "repair-note-presentation", name: t("修復議題筆記顯示"), callback: () => { void this.mutate(async () => { await this.repo.ensureNodePresentation(); new Notice(t("已修復議題筆記顯示。")); }); } });
    this.addCommand({ id: "open-built-in-sample", name: t("開啟台灣旅行範例"), callback: () => { void this.activateBuiltInSample(true); } });
    this.addCommand({ id: "repair-workspace", name: t("修復 Agent Workspace"), callback: () => { void this.mutate(() => this.repairWorkspace()); } });
    this.addCommand({ id: "reconnect-workspace", name: t("找回既有 Workspace"), callback: () => { void this.offerWorkspaceReconnect(); } });
    this.addCommand({ id: "open-debug-log", name: t("開啟偵錯日誌 (Open Debug Log)"), callback: () => new DebugLogModal(this.app, this.logs).open() });
    this.settingTab = new VisualAgentMapSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => { if (file instanceof TFile && this.isMap(file)) menu.addItem(item => item.setTitle(t("以心智圖開啟")).setIcon("git-fork").onClick(() => { void this.activateView(file.path); })); }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
      this.styleNodeLeaf(leaf);
      if (!(leaf?.view instanceof MarkdownView) || !leaf.view.file || !this.isMap(leaf.view.file)) return;
      const path = leaf.view.file.path;
      void leaf.setViewState({ type: VIEW_TYPE, state: { file: path }, active: true }).catch(error => new Notice(error instanceof Error ? error.message : String(error)));
    }));
    this.registerEvent(this.app.workspace.on("file-open", () => {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) this.styleNodeLeaf(leaf);
    }));
    this.app.workspace.onLayoutReady(() => {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) this.styleNodeLeaf(leaf);
      void this.ready.then(async () => {
        if (this.workspaceRecoveryCandidates.length) await this.offerWorkspaceReconnect(this.workspaceRecoveryCandidates);
        else if (this.firstInstallSamplePending) await this.activateBuiltInSample();
        try { await this.refreshCodexModels(); }
        catch (error) { const message = error instanceof Error ? error.message : String(error); this.logs.appendLog("warn", `Codex App Server 尚未就緒：${message}`); new Notice(t("Codex App Server 尚未就緒；Sample 與非 AI 功能仍可使用。請到 VAM Settings 查看並重新檢查。")); }
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
  async repairWorkspace(): Promise<void> { await this.repo.ensureWorkspace(); this.settings.workspaceInitialized = true; await this.saveSettings(); for (const view of this.views()) await view.refreshFromPlugin(); new Notice(t("Agent Workspace 已可使用。")); }
  async fullRebuild(): Promise<void> { await this.repo.rebuildDerivedData(); for (const view of this.views()) await view.refreshFromPlugin(); new Notice(t("VAM 資料已重新整理。")); }
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
    if (!candidates.length) { new Notice(t("找不到可辨識的既有 VAM Workspace。")); return; }
    new ChoiceModal(this.app, t("找回既有 Workspace"), t("選擇後只會重新連結設定，不會搬移或改寫內容。"), candidates.map(root => ({ label: root, action: () => this.mutate(async () => {
      this.connectWorkspace(root); await this.saveSettings(); await this.repo.rebuildDerivedData(); for (const view of this.views()) await view.refreshFromPlugin(); new Notice(t("已重新連結 Workspace：{0}", root));
    }) }))).open();
  }
  codexDiagnostic(): { executable: string; installed: boolean } {
    const executable = this.resolveExecutable(this.settings.codexPath);
    return { executable, installed: existsSync(executable) };
  }
  resetCodexRuntime(): void { this.codexRuntime?.stop(); this.codexRuntime = null; }
  openCodexSetupGuide(): void {
    const diagnostic = this.codexDiagnostic();
    new CodexSetupModal(this.app, diagnostic.executable, () => { void this.recheckCodex(); }).open();
  }
  async recheckCodex(): Promise<void> {
    const diagnostic = this.codexDiagnostic();
    if (!diagnostic.installed) { this.openCodexSetupGuide(); return; }
    try {
      await this.refreshCodexModels(); new Notice(t("Codex App Server 已就緒：{0}", diagnostic.executable));
    } catch (error) { new Notice(t("Codex App Server 檢查失敗：{0}", this.recordFailure("Codex App Server 重新檢查失敗", error))); }
  }
  async duplicateBuiltInSample(): Promise<string> {
    await this.repo.ensureWorkspace(); this.settings.workspaceInitialized = true;
    const sample = builtInSample(this.settings.language, false), path = await this.repo.createMap(sample.map.title), map = await this.repo.readMap(path), root = this.repo.topicRoot(path);
    try {
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
      map.viewport = { ...sample.map.viewport }; await this.repo.saveMap(path, map); await this.repo.rebuildDerivedData(); await this.saveSettings(); new Notice(t("已建立可自由修改的範例副本。")); return path;
    } catch (error) {
      const folder = this.app.vault.getAbstractFileByPath(root); if (folder) { try { await this.app.fileManager.trashFile(folder); } catch { /* Preserve the original duplicate failure. */ } }
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
  onunload(): void { this.codexRuntime?.stop(); this.codexRuntime = null; }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
  async confirmCodexUsage(run: () => Promise<void>): Promise<void> {
    if (!this.settings.codexUsageNoticeSeen) {
      const confirmed = await new Promise<boolean>(resolve => new CodexUsageModal(this.app, resolve).open());
      if (!confirmed) return;
      this.settings.codexUsageNoticeSeen = true;
      await this.saveSettings();
    }
    await run();
  }
  async rebuildDerivedData(): Promise<void> { try { await this.repo.rebuildDerivedData(); } catch (error) { console.error("Visual Agent Map reference rebuild", error); new Notice(t("心智圖已儲存，但 reference 更新失敗：{0}", error instanceof Error ? error.message : String(error))); } }
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
    if (!this.detailsLeaf) throw new Error(t("無法開啟右側詳情欄。"));
    await this.detailsLeaf.openFile(file);
    this.styleNodeLeaf(this.detailsLeaf);
    await this.app.workspace.revealLeaf(this.detailsLeaf);
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
    this.settings.models = models.map(item => item.model).join(", ");
    if (!models.some(item => item.model === this.settings.cliModel)) this.settings.cliModel = models.find(item => item.model === DEFAULT_SETTINGS.cliModel)?.model || models.find(item => item.isDefault)?.model || models[0]?.model || "";
    await this.saveSettings();
    this.settingTab?.update();
    for (const view of this.views()) await view.refreshFromPlugin();
  }
  async askModel(context: TaskContext, model: string): Promise<AiResult> {
    if (model.startsWith("claude:")) throw new Error(t("Claude Code 已不再支援。請在議題設定中選擇 Codex model。"));
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error(t("CLI 模式只支援桌面版 Obsidian"));
    if (!this.manifest.dir) throw new Error(t("找不到外掛目錄"));

    const totalStarted = Date.now();
    const prepared = buildPreparedTaskContext(context, model);
    context = prepared.context;
    const pluginDirectory = join(adapter.getBasePath(), this.manifest.dir);
    const instructions = [
      "你是視覺化思考 Agent。不要修改任何檔案；除非任務明確指定，否則不要讀取本機檔案。",
      "只回傳 JSON，不要使用 Markdown code fence。格式必須符合：{\"summary\":\"...\",\"detail\":\"...\",\"suggestions\":[{\"title\":\"...\",\"task\":\"...\",\"contribution\":\"...\"}],\"visualReferences\":[{\"title\":\"...\",\"imageUrl\":\"https://...\",\"sourceUrl\":\"https://...\",\"description\":\"...\",\"palette\":[\"navy\",\"white\"],\"formula\":\"...\"}]}。若沒有視覺參考，visualReferences 回傳空陣列。",
      context.mode === "task"
        ? "這是一般任務：summary 必須是一句適合心智圖顯示的新目前理解，80 字內；detail 是會直接取代舊 Detail 的完整知識頁，必須吸收舊內容與本次發現、去除重複、保留仍有效的來源。若議題過於複雜才提供 suggestions，否則回傳空陣列。"
        : context.mode === "decompose"
          ? "這是 Decompose 模式：只產生 3–7 個可獨立處理的子議題 suggestions。summary 簡述是否建議拆解，detail 簡述拆解理由；不要更新結論。"
          : context.mode === "synthesize"
            ? "這是 Synthesize 模式：summary 必須是高品質整合結論，80 字內；detail 必須整合來源完整知識、收斂重複內容、清楚呈現共識、分歧、取捨與未解問題；完成後會直接寫回。"
            : "summary 必須是一句適合心智圖顯示的新目前理解，detail 必須是完整繁體中文 Markdown 分析。",
      context.mode !== "decompose" ? "detail 必須且只能依序使用以下六個三級標題：### 核心結論、### 關鍵知識、### 證據與來源、### 取捨與限制、### 待確認事項、### 更新紀錄。更新紀錄只新增一行本次變更摘要，不可重貼完整答案；沒有內容的段落寫「尚待補充」。" : "",
      context.mode !== "decompose" ? "若任務需要視覺理解（例如穿搭、配色、室內設計、食譜外觀、UI 參考），請提供 1–6 個已搜尋到的圖片參考 visualReferences；必須包含圖片 URL 與來源頁 URL，不要生成圖片，不要編造來源。" : "",
      context.mode !== "decompose" ? "圖片必須直接嵌入 detail 的相關說明段落之後，使用 Markdown 圖片語法，並在圖片下方附來源頁連結。不要建立視覺參考、圖示或圖片集合的獨立段落；圖片與 visualReferences 使用相同 URL。優先搜尋可幫助理解議題的相關圖片，找不到可靠圖片時不要編造。" : "",
      `目前議題：\n${context.title}`,
      `目前理解：\n${context.summary}`,
      context.mode !== "decompose" ? `現有 Detail（須整合後完整取代，不能原樣重複追加）：\n${context.detail || "（無）"}` : "",
      `目前議題的 AI 規則（優先遵守）：\n${context.rules || "（無）"}`,
      context.workingFindings ? `舊版待整理發現（本次必須一併收斂）：\n${context.workingFindings}` : "",
      context.sourceContext ? `整合來源背景：\n${context.sourceContext}` : "",
      `祖先議題背景：\n${context.ancestors || "（無）"}`,
      `目前任務：\n${context.task}`
    ].join("\n\n");

    console.debug("Visual Agent Map AI metrics", prepared.metrics);
    const providerStarted = Date.now();
    const effort = context.mode === "synthesize" ? "high" : this.settings.cliReasoning || "low";
    const raw = await this.runtime(pluginDirectory).runTask(instructions, model, effort, responseSchema);
    const result = this.parseAiResult(raw, "Codex App Server");
    console.debug("Visual Agent Map AI metrics", { ...prepared.metrics, providerMs: Date.now() - providerStarted, totalMs: Date.now() - totalStarted });
    return result;
  }
  private parseAiResult(raw: string, label: string): AiResult {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed: { summary?: unknown; detail?: unknown; suggestions?: unknown; visualReferences?: unknown } = JSON.parse(extractJsonObject(cleaned)) as { summary?: unknown; detail?: unknown; suggestions?: unknown; visualReferences?: unknown };
    if (typeof parsed.summary !== "string" || typeof parsed.detail !== "string") throw new Error(`${label} 沒有回傳 summary 與 detail`);
    const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
    const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.title === "string" && typeof item.task === "string").map(item => ({ title: String(item.title).trim(), task: String(item.task).trim(), contribution: typeof item.contribution === "string" ? item.contribution.trim() : "" })).filter(item => item.title) : [];
    const visualReferences = Array.isArray(parsed.visualReferences) ? parsed.visualReferences.filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.imageUrl === "string" && typeof item.sourceUrl === "string").map(item => ({
      title: typeof item.title === "string" ? item.title.trim() : "視覺參考",
      imageUrl: String(item.imageUrl).trim(),
      sourceUrl: String(item.sourceUrl).trim(),
      description: typeof item.description === "string" ? item.description.trim() : "",
      palette: Array.isArray(item.palette) ? item.palette.map(String).map(color => color.trim()).filter(Boolean).slice(0, 8) : [],
      formula: typeof item.formula === "string" ? item.formula.trim() : ""
    })).filter(item => /^https?:\/\//i.test(item.imageUrl) && /^https?:\/\//i.test(item.sourceUrl)).slice(0, 6) : [];
    return { summary: Array.from(parsed.summary.trim()).slice(0, 80).join(""), detail: parsed.detail.trim(), suggestions, visualReferences };
  }
  private runtime(pluginDirectory: string): CodexAppServerRuntime {
    if (!this.codexRuntime) {
      const executable = this.resolveExecutable(this.settings.codexPath);
      this.codexRuntime = new CodexAppServerRuntime({
        executable,
        cwd: pluginDirectory,
        env: this.cliEnvironment(executable),
        clientVersion: this.manifest.version || "0.0.0",
        onLog: (level, message) => this.logs.appendLog(level, message)
      });
    }
    return this.codexRuntime;
  }
  private resolveExecutable(configured: string): string {
    const environment = currentProcessEnvironment();
    const home = environment.HOME || "";
    let nvmVersions: string[] = [];
    if (home) { try { nvmVersions = readdirSync(join(home, ".nvm/versions/node")); } catch { /* nvm is optional. */ } }
    return executableCandidates(configured, home, environment.PATH || "", nvmVersions).find(candidate => existsSync(candidate)) || configured;
  }
  private cliEnvironment(executable: string): ProcessEnvironment {
    const environment = currentProcessEnvironment();
    const home = environment.HOME || "";
    // npm launchers use /usr/bin/env node; keep the resolved installation ahead of GUI defaults.
    const paths = [isAbsolute(executable) ? dirname(executable) : "", home ? join(home, ".local/bin") : "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", ...(environment.PATH || "").split(delimiter)].filter(Boolean);
    return { ...environment, PATH: [...new Set(paths)].join(delimiter) };
  }
}
