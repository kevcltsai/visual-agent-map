import { App, FileSystemAdapter, ItemView, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, type SettingDefinitionItem } from "obsidian";
import { spawn, type VisualAgentChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import responseSchema from "./response-schema.json";
import { join } from "node:path";
import { canParent, clone, descendants, History, inheritModel, MapDocument, MapNode, parseMap, removeNodes, serializeMap, visibleNodes } from "./map-model";
import { DEFAULT_SETTINGS, ModelSource, Note, NotePatch, Repository, Settings, TopicInfo, TopicState, VisualReference } from "./repository";
const VIEW_TYPE = "visual-agent-map-view";
const RESPONSE_SCHEMA_JSON = `${JSON.stringify(responseSchema, null, 2)}\n`;
interface Action { undo: () => Promise<void>; redo: () => Promise<void> }
interface Suggestion { title: string; task: string; contribution: string }
type AiTaskKind = "task" | "decompose" | "synthesize";
interface TaskContext { title: string; summary: string; rules: string; detail: string; task: string; ancestors: string; workingFindings?: string; sourceContext?: string; mode?: AiTaskKind }
interface AiResult { summary: string; detail: string; suggestions: Suggestion[]; visualReferences: VisualReference[] }
interface AcpRequest { jsonrpc: "2.0"; id: number; method: string; params?: unknown }
interface AcpResponse { jsonrpc: "2.0"; id: number; result?: unknown; error?: { message?: string } | string }
interface AcpNotification { jsonrpc: "2.0"; method: string; params?: unknown }
type AcpMessage = AcpRequest | AcpResponse | AcpNotification;
const labels = { idea: "待研究", running: "AI 執行中", completed: "AI 完成", error: "執行錯誤" };
interface PreviewMetrics { min: number; max: number; height: number; image: string; title: string; body: string; labelSize: string; table: string; line: string; padding: string }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isUnknownArray(value: unknown): value is unknown[] { return Array.isArray(value); }
function metadataValue(value: unknown, key: string): unknown { return isRecord(value) ? value[key] : undefined; }
function clampPreviewScale(value: unknown): number {
  const scale = typeof value === "number" ? value : Number(value);
  return Number.isFinite(scale) ? Math.max(80, Math.min(240, Math.round(scale))) : 120;
}
function legacyPreviewScale(value: unknown): number {
  return value === "small" ? 90 : value === "large" ? 160 : 120;
}
function previewMetrics(scaleValue: number): PreviewMetrics {
  const scale = clampPreviewScale(scaleValue) / 120;
  return {
    min: Math.round(240 * scale),
    max: Math.round(320 * scale),
    height: Math.round(420 * scale),
    image: `${Math.round(150 * scale)}px`,
    title: `${Math.round(15 * scale)}px`,
    body: `${Math.round(13 * scale)}px`,
    labelSize: `${Math.round(11 * scale)}px`,
    table: `${Math.round(11 * scale)}px`,
    line: String(Math.max(1.3, Math.min(1.75, 1.45 + (scale - 1) * 0.18))),
    padding: `${Math.round(14 * scale)}px ${Math.round(16 * scale)}px`
  };
}
const KNOWLEDGE_HEADINGS = ["核心結論", "關鍵知識", "證據與來源", "取捨與限制", "待確認事項", "更新紀錄"] as const;
export function canonicalDetail(value: string): string {
  const detail = value.trim();
  if (KNOWLEDGE_HEADINGS.every(heading => new RegExp(`^### ${heading}\\s*$`, "m").test(detail))) return detail;
  const stamp = new Date().toLocaleDateString("zh-TW");
  return [
    `### 核心結論\n\n${detail || "尚待整理。"}`,
    "### 關鍵知識\n\n尚待補充。",
    "### 證據與來源\n\n尚待補充。",
    "### 取捨與限制\n\n尚待補充。",
    "### 待確認事項\n\n尚待補充。",
    `### 更新紀錄\n\n- ${stamp}：整理為結構化知識。`
  ].join("\n\n");
}
export function visualReferencesMarkdown(references: VisualReference[] = []): string {
  return references.map(item => {
    const title = item.title.trim() || "視覺參考";
    const imageUrl = item.imageUrl.trim();
    const sourceUrl = item.sourceUrl.trim();
    if (!imageUrl || !sourceUrl) return "";
    const palette = item.palette.map(color => color.trim()).filter(Boolean).join(" / ");
    return [
      `### ${title}`,
      "",
      `![${title}](${imageUrl})`,
      "",
      `來源：${sourceUrl}`,
      item.description.trim() ? `用途：${item.description.trim()}` : "",
      palette ? `配色：${palette}` : "",
      item.formula.trim() ? `可套用公式：${item.formula.trim()}` : ""
    ].filter(Boolean).join("\n");
  }).filter(Boolean).join("\n\n");
}
export function markdownImages(markdown: string, limit = 4): { alt: string; url: string }[] {
  const images: { alt: string; url: string }[] = [];
  for (const match of markdown.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi)) {
    images.push({ alt: match[1] || "視覺參考", url: match[2] });
    if (images.length >= limit) break;
  }
  return images;
}
export function firstMarkdownImage(markdown: string): { alt: string; url: string } | null {
  return markdownImages(markdown, 1)[0] ?? null;
}
export function firstMarkdownTable(markdown: string): string[][] {
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^\s*\|.+\|\s*$/.test(lines[i]) || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue;
    const rows: string[][] = [];
    for (let j = i; j < lines.length && /^\s*\|.+\|\s*$/.test(lines[j]); j++) {
      if (j === i + 1) continue;
      rows.push(lines[j].trim().slice(1, -1).split("|").map(cell => cell.trim()).filter(Boolean));
      if (rows.length >= 4) break;
    }
    return rows.filter(row => row.length);
  }
  return [];
}
class NameModal extends Modal {
  constructor(app: App, private titleText: string, private value: string, private submit: (value: string) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    const input = this.contentEl.createEl("input", { type: "text", value: this.value, cls: "vam-name-input" });
    input.setAttr("aria-label", this.titleText);
    const save = (): void => { const value = input.value.trim(); if (value) { this.close(); this.submit(value); } };
    input.addEventListener("keydown", event => { if (event.key === "Enter") save(); });
    new Setting(this.contentEl).addButton(b => b.setButtonText("取消").onClick(() => this.close())).addButton(b => b.setButtonText("儲存").setCta().onClick(save));
    input.focus(); input.select();
  }
}
class ChoiceModal extends Modal {
  constructor(app: App, private titleText: string, private description: string, private choices: { label: string; description?: string; buttonLabel?: string; action: () => void }[]) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    this.contentEl.createEl("p", { text: this.description, cls: "vam-modal-intro" });
    for (const choice of this.choices) {
      const setting = new Setting(this.contentEl);
      if (choice.description) setting.setName(choice.label).setDesc(choice.description).addButton(b => b.setButtonText(choice.buttonLabel ?? "選擇").onClick(() => { this.close(); choice.action(); }));
      else setting.addButton(b => b.setButtonText(choice.label).onClick(() => { this.close(); choice.action(); }));
    }
    new Setting(this.contentEl).addButton(b => b.setButtonText("取消").onClick(() => this.close()));
  }
}
class TaskModal extends Modal {
  constructor(app: App, private value: string, private submit: (value: string, run: boolean) => void, private titleText = "自訂 AI 任務", private description = "描述這一步要請 AI 完成什麼。", private rules = "") { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    this.contentEl.createEl("p", { text: this.description, cls: "vam-modal-intro" });
    const rulePreview = this.contentEl.createDiv("vam-rule-preview");
    rulePreview.createEl("strong", { text: "本次套用的 AI 規則" });
    rulePreview.createEl("p", { text: this.rules.trim() || "未設定額外規則。" });
    const input = this.contentEl.createEl("textarea", { text: this.value, cls: "vam-task-input" }); input.rows = 7; input.setAttr("aria-label", "自訂 AI 任務");
    const save = (run: boolean): void => { const value = input.value.trim(); if (!value) return; this.close(); this.submit(value, run); };
    new Setting(this.contentEl).addButton(b => b.setButtonText("取消").onClick(() => this.close())).addButton(b => b.setButtonText("只儲存").onClick(() => save(false))).addButton(b => b.setButtonText("確認並執行").setCta().onClick(() => save(true)));
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  }
}
class ChildProposalModal extends Modal {
  constructor(app: App, private suggestions: Suggestion[], private submit: (items: Suggestion[]) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText("AI 子議題提案");
    this.contentEl.createEl("p", { text: "勾選要建立的子議題；建立前可直接修改名稱與任務。" });
    const rows: { check: HTMLInputElement; title: HTMLInputElement; task: HTMLTextAreaElement; contribution: HTMLTextAreaElement }[] = [];
    for (const item of this.suggestions) { const row = this.contentEl.createDiv("vam-proposal"); const check = row.createEl("input", { type: "checkbox" }); check.checked = true; const title = row.createEl("input", { type: "text", value: item.title }); const task = row.createEl("textarea", { text: item.task }); task.rows = 2; const contribution = row.createEl("textarea", { text: item.contribution }); contribution.rows = 2; contribution.placeholder = "對母議題的貢獻"; rows.push({ check, title, task, contribution }); }
    new Setting(this.contentEl).addButton(b => b.setButtonText("取消").onClick(() => this.close())).addButton(b => b.setButtonText("建立子議題").setCta().onClick(() => { this.close(); this.submit(rows.filter(row => row.check.checked && row.title.value.trim()).map(row => ({ title: row.title.value.trim(), task: row.task.value.trim(), contribution: row.contribution.value.trim() }))); }));
  }
}
class IntegrationModal extends Modal {
  constructor(app: App, private names: string[], private defaultRules: string, private submit: (title: string, goal: string, rules: string) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText("確認整合議題");
    this.contentEl.createEl("p", { text: `將整合 ${this.names.length} 個來源議題，AI 會讀取完整知識內容並建立新的根議題。`, cls: "vam-modal-intro" });
    const sources = this.contentEl.createDiv("vam-integration-sources");
    sources.createEl("strong", { text: "來源議題" });
    for (const name of this.names) sources.createDiv({ text: name });
    const titleLabel = this.contentEl.createEl("label", { cls: "vam-field" }); titleLabel.createSpan({ text: "新議題名稱" });
    const title = titleLabel.createEl("input", { type: "text", value: "整合議題" }); title.setAttr("aria-label", "新議題名稱");
    const goalLabel = this.contentEl.createEl("label", { cls: "vam-field" }); goalLabel.createSpan({ text: "整合目標" });
    const goal = goalLabel.createEl("textarea", { text: "找出共同結論、重要差異、取捨與下一步。" }); goal.rows = 4; goal.setAttr("aria-label", "整合目標");
    const rulesLabel = this.contentEl.createEl("label", { cls: "vam-field" }); rulesLabel.createSpan({ text: "AI 規則" });
    const rules = rulesLabel.createEl("textarea", { text: this.defaultRules }); rules.rows = 3; rules.setAttr("aria-label", "AI 規則");
    const save = (): void => { if (!title.value.trim() || !goal.value.trim()) return; this.close(); this.submit(title.value.trim(), goal.value.trim(), rules.value.trim()); };
    new Setting(this.contentEl).addButton(button => button.setButtonText("取消").onClick(() => this.close())).addButton(button => button.setButtonText("確認並執行").setCta().onClick(save));
    title.focus(); title.select();
  }
}
class ConflictModal extends Modal {
  constructor(app: App, private label: string, private local: string, private disk: string, private resolve: (value: string | null) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(`${this.label}有外部修改`);
    this.contentEl.createEl("p", { text: "畫面與 Markdown 都有修改。請選擇要保留的內容，或在下方手動合併。" });
    const input = this.contentEl.createEl("textarea", { cls: "vam-task-input", text: `${this.disk}\n\n${this.local}` }); input.rows = 10;
    new Setting(this.contentEl)
      .addButton(b => b.setButtonText("使用檔案內容").onClick(() => { this.close(); this.resolve(null); }))
      .addButton(b => b.setButtonText("保留畫面內容").onClick(() => { this.close(); this.resolve(this.local); }))
      .addButton(b => b.setButtonText("儲存合併內容").setCta().onClick(() => { this.close(); this.resolve(input.value.trim()); }));
  }
}
class MapConflictModal extends Modal {
  private settled = false;
  constructor(app: App, private local: MapDocument, private disk: MapDocument, private resolve: (map: MapDocument) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText("心智圖有外部修改");
    this.contentEl.createEl("p", { text: "畫面與 Map.md 的結構都已改變。可選擇其中一版，或編輯下方 JSON 後手動合併。" });
    const input = this.contentEl.createEl("textarea", { cls: "vam-task-input", text: JSON.stringify(this.disk, null, 2) }); input.rows = 16;
    const finish = (map: MapDocument): void => { this.settled = true; this.close(); this.resolve(map); };
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText("使用檔案內容").onClick(() => finish(clone(this.disk))))
      .addButton(button => button.setButtonText("保留畫面內容").onClick(() => finish(clone(this.local))))
      .addButton(button => button.setButtonText("儲存合併內容").setCta().onClick(() => {
        try { finish(parseMap(serializeMap(JSON.parse(input.value) as MapDocument))); }
        catch (error) { new Notice(error instanceof Error ? `合併內容無效：${error.message}` : "合併內容無效。"); }
      }));
  }
  onClose(): void { if (!this.settled) this.resolve(clone(this.disk)); }
}
class NoteCollectionModal extends Modal {
  constructor(app: App, private titleText: string, private files: TFile[], private actions: { label: string; run: (file: TFile) => void }[]) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    if (!this.files.length) this.contentEl.createEl("p", { text: "目前沒有筆記。" });
    for (const file of this.files) {
      const row = this.contentEl.createDiv("vam-collection-row"); row.createSpan({ text: file.basename });
      const actions = row.createDiv("vam-collection-actions");
      for (const action of this.actions) actions.createEl("button", { text: action.label }).addEventListener("click", () => { this.close(); action.run(file); });
    }
    new Setting(this.contentEl).addButton(button => button.setButtonText("關閉").onClick(() => this.close()));
  }
}
class TopicPickerModal extends Modal {
  constructor(app: App, private titleText: string, private topics: TopicInfo[], private choose: (topic: TopicInfo) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    for (const topic of this.topics) new Setting(this.contentEl).setName(topic.title).setDesc(topic.root).addButton(button => button.setButtonText("選擇").onClick(() => { this.close(); this.choose(topic); }));
    if (!this.topics.length) this.contentEl.createEl("p", { text: "沒有其他主題。" });
    new Setting(this.contentEl).addButton(button => button.setButtonText("取消").onClick(() => this.close()));
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
  private closed = false;
  private headerTitle = "";
  constructor(leaf: WorkspaceLeaf, private plugin: VisualAgentMapPlugin) { super(leaf); }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.map?.title ?? "Visual Agent Map"; }
  getIcon(): string { return "git-fork"; }
  getState(): Record<string, unknown> { return { file: this.path }; }
  async setState(state: Record<string, unknown>, result: { history: boolean }): Promise<void> { if (typeof state.file === "string" && state.file !== this.path) await this.openMap(state.file); await super.setState(state, result); }
  async onOpen(): Promise<void> {
    this.contentEl.addClass("vam-view"); this.contentEl.tabIndex = 0;
    this.registerDomEvent(this.contentEl, "keydown", event => {
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); this.enqueue(() => this.travel(event.shiftKey)); }
      if (event.key === "Escape") { this.selected = null; this.multiSelected.clear(); this.integrationMode = false; this.render(); }
    });
    await this.plugin.ready;
    if (!this.path) { const files = await this.plugin.repo.mapFiles(); if (files.length) await this.openMap(files[0].path); else this.render(); }
  }
  async onClose(): Promise<void> { this.closed = true; if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer); if (this.hoverTimer !== null) window.clearTimeout(this.hoverTimer); this.hoverCard?.remove(); if (this.viewportTimer !== null) { window.clearTimeout(this.viewportTimer); await this.persist(); } }
  async refreshFromPlugin(): Promise<void> { await this.hydrate(); this.render(); }
  private enqueue(work: () => Promise<void>): void { void this.plugin.mutate(work).catch(() => {}); }
  private async persist(): Promise<void> { if (this.map && this.path) await this.plugin.repo.saveMap(this.path, this.map); }
  private async hydrate(): Promise<void> {
    this.notes.clear();
    for (const node of this.map?.nodes ?? []) { try { this.notes.set(node.id, await this.plugin.repo.readNote(node.path)); } catch { /* A missing note remains visible and removable on the map. */ } }
  }
  async openMap(path: string): Promise<void> {
    if (this.viewportTimer !== null) { window.clearTimeout(this.viewportTimer); this.viewportTimer = null; await this.persist(); }
    const map = await this.plugin.repo.readMap(path);
    this.path = path; this.map = map; this.selected = null; this.multiSelected.clear(); this.history.clear(); await this.hydrate(); this.render();
    this.app.workspace.requestSaveLayout();
  }
  changed(file: TFile): void {
    if (file.path !== this.path && !this.map?.nodes.some(node => node.path === file.path)) return;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      if (this.closed) return;
      if (this.contentEl.contains(document.activeElement) && document.activeElement?.matches("input, textarea, select")) { this.changed(file); return; }
      this.enqueue(async () => { if (file.path === this.path) { this.map = await this.plugin.repo.readMap(this.path); this.history.clear(); await this.plugin.rebuildDerivedData(); } await this.hydrate(); this.render(); });
    }, 400);
  }
  async renamed(file: TFile, oldPath: string): Promise<void> { if (this.path === oldPath) this.path = file.path; if (this.map) { for (const node of this.map.nodes) if (node.path === oldPath) node.path = file.path; this.history.clear(); await this.hydrate(); this.render(); } }
  deleted(file: TFile): void { if (file.path === this.path) { this.map = null; this.path = ""; this.history.clear(); this.render(); } else this.changed(file); }
  private button(parent: HTMLElement, text: string, action: () => void, disabled = false): HTMLButtonElement { const button = parent.createEl("button", { text }); button.disabled = disabled; button.addEventListener("click", event => { event.stopPropagation(); action(); }); return button; }
  private async mapChange(change: (map: MapDocument) => void): Promise<void> {
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
    await this.plugin.rebuildDerivedData();
    const restore = async (snapshot: MapDocument): Promise<void> => { const next = clone(snapshot); if (this.map) next.viewport = clone(this.map.viewport); await this.plugin.repo.saveMap(path, next); this.map = next; await this.plugin.rebuildDerivedData(); await this.hydrate(); };
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
    const after = clone(before), replacement = after.nodes.find(item => item.id === node.id); if (!replacement) throw new Error("找不到要重新連結的節點。"); replacement.path = target;
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
  private async saveFieldWithConflict(node: MapNode, key: "title" | "summary" | "rules", label: string, base: string, value: string): Promise<void> {
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
    if (!this.path || !this.map || this.closed) return;
    if (!(this.app.vault.getAbstractFileByPath(this.path) instanceof TFile)) { this.map = null; this.path = ""; this.history.clear(); this.render(); return; }
    const disk = await this.plugin.repo.readMap(this.path);
    const structureChanged = JSON.stringify({ ...disk, viewport: null }) !== JSON.stringify({ ...this.map, viewport: null });
    if (structureChanged) { disk.viewport = this.map.viewport; this.map = disk; this.history.clear(); }
    const before = JSON.stringify(Array.from(this.notes));
    await this.hydrate();
    if (structureChanged || before !== JSON.stringify(Array.from(this.notes))) {
      const editing = this.contentEl.contains(document.activeElement) && document.activeElement?.matches("input, textarea, select");
      if (!editing || structureChanged) this.render();
      else for (const node of this.map.nodes) this.refreshCard(node);
    }
  }
  private openMapActions(): void {
    const choices: { label: string; description?: string; buttonLabel?: string; action: () => void }[] = [];
    if (this.map) {
      choices.push({ label: "重新命名目前心智圖", description: "同時更新主題資料夾與心智圖名稱。", action: () => this.renameCurrentMap() });
      if (!this.path.startsWith(`${this.plugin.settings.topicsFolder}/`)) choices.push({ label: "整理舊資料", description: "預覽後把舊版心智圖整理成目前的主題結構。", action: () => this.enqueue(() => this.previewMigration()) });
    }
    choices.push({ label: "修復遺失的心智圖", description: "從現有議題筆記重新建立缺少的 Map。", action: () => this.enqueue(() => this.repairMissingTopic()) });
    if (this.map) choices.push({ label: "刪除目前心智圖", description: "只移除心智圖檔案，保留所有議題筆記，並可用復原還原。", buttonLabel: "檢視", action: () => this.deleteCurrentMap() });
    new ChoiceModal(this.app, "更多心智圖操作", "低頻的管理操作集中在這裡。", choices).open();
  }
  private renameCurrentMap(): void {
    if (!this.map) return;
    new NameModal(this.app, "重新命名心智圖", this.map.title, title => this.enqueue(async () => {
      if (!this.map) return;
      if (!this.path.startsWith(`${this.plugin.settings.topicsFolder}/`)) { new Notice("請先整理舊資料，再重新命名主題。"); return; }
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
    new ChoiceModal(this.app, "刪除心智圖", "只將心智圖檔案移到 Vault 垃圾桶，保留所有議題筆記。可以使用復原還原。", [
      { label: `刪除「${this.map.title}」`, description: "議題筆記不會被刪除。", buttonLabel: "移到垃圾桶", action: () => this.enqueue(async () => {
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
    new ChoiceModal(this.app, "整理筆記", "集中處理暫時不在心智圖上的內容。", [
      { label: `未歸類（${unassigned.length}）`, description: "認領到目前心智圖、封存，或移至其他主題。", action: () => this.openUnassigned(unassigned) },
      { label: `封存（${archived.length}）`, description: "查看已封存筆記，或將它們移回未歸類。", action: () => this.openArchive(archived) },
      { label: `收件匣（${inbox.length}）`, description: "將還沒有主題的筆記移入適合的位置。", action: () => this.openInbox(inbox) }
    ]).open();
  }
  private openUnassigned(files: TFile[]): void {
    new NoteCollectionModal(this.app, "未歸類筆記", files, [
      { label: "認領到心智圖", run: file => this.enqueue(() => this.claimToCurrent(file)) },
      { label: "封存", run: file => this.enqueue(() => this.parkFile(file, "Archive", "archived")) },
      { label: "移至其他主題", run: file => this.enqueue(async () => { const topics = (await this.plugin.repo.topics()).filter(topic => topic.id !== this.map?.id); new TopicPickerModal(this.app, "移至其他主題", topics, topic => this.enqueue(() => this.transferToTopic(file, topic))).open(); }) },
      { label: "移動並加入其他主題", run: file => this.enqueue(async () => { const topics = (await this.plugin.repo.topics()).filter(topic => topic.id !== this.map?.id); new TopicPickerModal(this.app, "移動並加入其他心智圖", topics, topic => this.enqueue(() => this.transferAndAdd(file, topic))).open(); }) }
    ]).open();
  }
  private openArchive(files: TFile[]): void {
    new NoteCollectionModal(this.app, "封存筆記", files, [{ label: "取消封存", run: file => this.enqueue(() => this.parkFile(file, "Unassigned", "unassigned")) }]).open();
  }
  private openInbox(files: TFile[]): void {
    new NoteCollectionModal(this.app, "未指定主題的筆記", files, [
      { label: "移至目前主題", run: file => this.enqueue(() => this.parkFile(file, "Unassigned", "unassigned")) },
      { label: "移動並加入目前心智圖", run: file => this.enqueue(() => this.claimToCurrent(file)) },
      { label: "選擇其他主題", run: file => this.enqueue(async () => { const topics = await this.plugin.repo.topics(); new TopicPickerModal(this.app, "移至主題", topics, topic => this.enqueue(() => this.transferToTopic(file, topic))).open(); }) }
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
    this.button(toolbar, "切換心智圖", () => this.enqueue(async () => { const topics = await this.plugin.repo.topics(); new ChoiceModal(this.app, "切換心智圖", "選擇要開啟的研究主題", topics.map(topic => ({ label: topic.title, action: () => this.enqueue(() => this.openMap(topic.mapPath)) }))).open(); }));
    this.button(toolbar, "＋ 心智圖", () => new NameModal(this.app, "新增心智圖", "新的心智圖", title => this.enqueue(async () => this.openMap(await this.plugin.repo.createMap(title)))).open());
    const undo = this.button(toolbar, "復原", () => this.enqueue(() => this.travel(false)), !this.history.canUndo); undo.dataset.history = "undo";
    const redo = this.button(toolbar, "重做", () => this.enqueue(() => this.travel(true)), !this.history.canRedo); redo.dataset.history = "redo";
    this.button(toolbar, "更多…", () => this.openMapActions());
    if (!this.map) { this.contentEl.createDiv({ cls: "vam-empty", text: "新增或開啟一張心智圖，開始整理你的議題。" }); return; }
    const tools = this.contentEl.createDiv("vam-map-tools");
    this.button(tools, "＋ 議題", () => this.enqueue(() => this.addNode(null))).addClass("mod-cta");
    this.button(tools, "整理", () => this.enqueue(() => this.openOrganizer()));
    const integrate = this.button(tools, this.integrationMode ? "結束整合" : "整合議題", () => { this.integrationMode = !this.integrationMode; this.multiSelected.clear(); this.selected = null; this.render(); });
    if (this.integrationMode) integrate.addClass("is-active");
    this.button(tools, "−", () => this.zoomBy(1 / 1.2)).setAttr("aria-label", "縮小");
    this.zoomLabel = tools.createSpan({ text: `${Math.round(this.map.viewport.zoom * 100)}%`, cls: "vam-zoom" });
    this.button(tools, "＋", () => this.zoomBy(1.2)).setAttr("aria-label", "放大");
    this.button(tools, "顯示全部", () => this.fit());
    const previewControl = tools.createEl("label", { cls: "vam-preview-size" });
    previewControl.createSpan({ text: "預覽" });
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
    tools.createSpan({ cls: "vam-hint", text: "拖曳空白處平移 · 滾輪縮放 · 點選節點編輯" });
    const workspace = this.contentEl.createDiv("vam-workspace");
    this.viewportEl = workspace.createDiv("vam-viewport");
    this.stageEl = this.viewportEl.createDiv("vam-stage");
    this.edgesEl = this.stageEl.createSvg("svg", { cls: "vam-edges" });
    const shown = visibleNodes(this.map.nodes);
    if (this.selected && !shown.some(node => node.id === this.selected)) this.selected = null;
    this.multiSelected = new Set([...this.multiSelected].filter(id => shown.some(node => node.id === id)));
    if (this.integrationMode) {
      const selection = workspace.createDiv("vam-selection-bar");
      const names = [...this.multiSelected].map(id => this.notes.get(id)?.title).filter(Boolean);
      selection.createSpan({ text: this.multiSelected.size ? `已選 ${this.multiSelected.size} 個：${names.slice(0, 2).join("、")}${names.length > 2 ? "…" : ""}` : "請點選至少 2 個議題" });
      this.button(selection, "清除", () => { this.multiSelected.clear(); this.render(); }, !this.multiSelected.size);
      this.button(selection, "下一步", () => this.integrateSelected(), this.multiSelected.size < 2).addClass("mod-cta");
    }
    for (const node of shown) this.renderNode(node);
    if (!this.map.nodes.length) this.viewportEl.createDiv({ cls: "vam-empty", text: "這張心智圖還沒有議題。點「＋ 議題」建立第一個節點。" });
    this.setupPan(); this.transform(); this.drawEdges();
    if (this.selected) { const node = this.map.nodes.find(n => n.id === this.selected); if (node) this.renderInspector(workspace, node); }
  }
  private renderNode(node: MapNode): void {
    if (!this.stageEl) return;
    const note = this.notes.get(node.id), card = this.stageEl.createDiv({ cls: `vam-node${node.id === this.selected || this.multiSelected.has(node.id) ? " is-selected" : ""}` });
    card.dataset.nodeId = node.id; card.style.left = `${node.x}px`; card.style.top = `${node.y}px`; card.tabIndex = 0; card.setAttr("aria-label", note?.title ?? "筆記不存在");
    const header = card.createDiv("vam-node-header");
    if (this.integrationMode) {
      const check = header.createSpan({ cls: `vam-select-check${this.multiSelected.has(node.id) ? " is-checked" : ""}`, text: this.multiSelected.has(node.id) ? "✓" : "" });
      check.setAttr("aria-hidden", "true");
    }
    if (!note || note.status !== "completed") header.createSpan({ cls: `vam-status vam-status-${note?.status ?? "error"}`, text: note ? labels[note.status] : "筆記不存在" });
    if (this.plugin.pendingSuggestions.has(node.path)) header.createSpan({ cls: "vam-badge-new", text: "待確認建議" });
    const details = this.button(header, "↗", () => this.openDetails(node)); details.addClass("vam-detail-button"); details.setAttr("aria-label", "在右側欄開啟詳情");
    const count = descendants(this.map!.nodes, node.id).size;
    if (count) this.button(header, node.collapsed ? `展開 ${count}` : "收合", () => this.enqueue(() => this.mapChange(map => { const n = map.nodes.find(n => n.id === node.id)!; n.collapsed = !n.collapsed; })));
    const title = card.createEl("h3", { text: note?.title ?? node.path, cls: "vam-card-title" });
    title.setAttr("title", note?.title ?? node.path);
    card.createEl("p", { cls: "vam-card-summary", text: note?.summary ?? "檔案已移動或刪除，可從圖中移除此節點。" });
    this.enableDrag(card, node);
    card.addEventListener("click", event => { if ((event.target as Element).closest("button") || event.metaKey || event.ctrlKey) return; if (this.integrationMode) { if (this.multiSelected.has(node.id)) this.multiSelected.delete(node.id); else this.multiSelected.add(node.id); this.render(); return; } this.multiSelected.clear(); this.selected = node.id; this.render(); });
    card.addEventListener("keydown", event => { if (event.key === "Enter" && event.target === card) { this.selected = node.id; this.render(); } });
    card.addEventListener("contextmenu", event => { event.preventDefault(); new ChoiceModal(this.app, note?.title ?? "議題操作", "選擇操作", [
      { label: "新增子議題", action: () => this.enqueue(() => this.addNode(node)) },
      { label: "AI 拆解議題", action: () => this.enqueue(() => this.proposeChildren(node)) },
      { label: node.collapsed ? "展開分支" : "收合分支", action: () => this.enqueue(() => this.mapChange(map => { map.nodes.find(n => n.id === node.id)!.collapsed = !node.collapsed; })) },
      { label: "在右側欄開啟詳情", action: () => this.openDetails(node) },
      { label: "重新讀取筆記", action: () => this.enqueue(async () => { await this.hydrate(); this.render(); }) },
      { label: "從圖中移除", action: () => this.enqueue(() => this.removeToUnassigned(node, false)) }
    ]).open(); });
    card.addEventListener("mouseenter", () => { if (!note || this.integrationMode) return; this.clearHoverTimer(); this.hoverTimer = window.setTimeout(() => this.showHoverCard(card, note), 320); });
    card.addEventListener("mouseleave", () => this.hideHoverCardSoon());
  }
  private clearHoverTimer(): void {
    if (this.hoverTimer !== null) window.clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
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
    preview.createSpan({ cls: "vam-hover-label", text: "目前結論" });
    preview.createEl("p", { text: note.summary || "尚未形成結論" });
    preview.createSpan({ cls: "vam-hover-label", text: "User Notes" });
    const images = markdownImages(note.userNotes, 4);
    if (images.length) {
      const grid = preview.createDiv("vam-hover-image-grid");
      for (const image of images) {
        const img = grid.createEl("img", { cls: "vam-hover-image", attr: { src: image.url, alt: image.alt } });
        img.setAttr("loading", "lazy");
      }
    }
    const table = firstMarkdownTable(note.userNotes);
    if (table.length) {
      const tableEl = preview.createEl("table", { cls: "vam-hover-table" });
      for (const row of table) {
        const tr = tableEl.createEl("tr");
        for (const cell of row.slice(0, 3)) tr.createEl("td", { text: cell });
      }
    } else {
      preview.createEl("p", { text: note.userNotes.trim().replace(/!\[[^\]]*\]\([^)]+\)/g, "").trim() || "尚未加入筆記" });
    }
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
    const heading = panel.createDiv("vam-inspector-heading"); heading.createEl("strong", { text: "議題工作台" }); this.button(heading, "關閉", () => { this.selected = null; this.render(); });
    if (note) {
      const field = (label: string, key: "title" | "summary" | "rules", rows = 0): void => {
        const wrapper = panel.createEl("label", { cls: "vam-field" }); wrapper.createSpan({ text: label });
        const input = rows ? wrapper.createEl("textarea", { text: note[key] }) : wrapper.createEl("input", { type: "text", value: note[key] });
        input.setAttr("aria-label", label); if (input instanceof HTMLTextAreaElement) input.rows = rows;
        const base = note[key];
        input.addEventListener("change", () => {
          const value = key === "title" ? input.value.trim() || "未命名議題" : input.value.trim();
          note[key] = value;
          this.enqueue(() => this.saveFieldWithConflict(node, key, label, base, value));
        });
      };
      field("議題", "title"); field("目前理解", "summary", 4); field("AI 規則", "rules", 4);
      const sourcePaths = this.referenceSourcePaths(note, node.path);
      if (sourcePaths.length) {
        const sources = panel.createDiv("vam-reference-sources"); sources.createEl("strong", { text: "來源議題" });
        for (const path of sourcePaths) {
          const sourceNode = this.map?.nodes.find(item => item.path === path), sourceNote = sourceNode ? this.notes.get(sourceNode.id) : null;
          const file = this.app.vault.getAbstractFileByPath(path);
          this.button(sources, sourceNote?.title ?? (file instanceof TFile ? file.basename : `${path.split("/").at(-1)?.replace(/\.md$/, "")}（已移動）`), () => {
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
          (value, run) => this.enqueue(async () => { await this.noteChange(node, { prompt: value }); if (run) await this.runAgent(node); }),
          title,
          "AI 完成後會直接更新目前理解，完整結果會保存在 MD 詳情中。送出前可調整任務。",
          latest.rules
        ).open();
      });
      const nextSteps: { label: string; description?: string; action: () => void }[] = [
        { label: "研究這個議題", description: "補足資訊、來源與仍待確認之處。", action: () => previewTask("確認研究任務", `研究「${note.title}」，補足資訊、來源與不確定處。`) },
        { label: "比較可行選項", description: "整理方案、取捨與建議。", action: () => previewTask("確認比較任務", `比較「${note.title}」的可行選項、取捨與建議。`) },
        { label: "檢查風險與假設", description: "尋找反例、風險及待驗證假設。", action: () => previewTask("確認風險檢查任務", `找出「${note.title}」的反例、風險與待驗證假設。`) },
        { label: "由 AI 拆成子議題", description: "產生 3–7 個建議；確認後才建立節點。", action: () => this.enqueue(() => this.proposeChildren(node)) },
        { label: "整合子議題發現", description: "彙整直屬子議題；確認任務後自動更新目前理解。", action: () => this.enqueue(() => this.integrateChildren(node)) },
        { label: "手動新增子議題", description: "建立空白子議題，不會執行 AI。", action: () => this.enqueue(() => this.addNode(node)) },
        { label: "自己描述下一步", description: "自行撰寫這次要 AI 完成的工作，可只儲存或確認並執行。", action: () => previewTask("自己描述下一步", note.prompt) }
      ];
      if (note.prompt.trim()) nextSteps.splice(3, 0, { label: "執行已保存的任務", description: "執行先前保存的任務；送出前仍可修改。", action: () => previewTask("確認已保存的任務", note.prompt) });
      this.button(actions, running ? "AI 執行中…" : "選擇下一步", () => this.enqueue(async () => {
        const input = panel.querySelector<HTMLTextAreaElement>('textarea[aria-label="AI 規則"]');
        const rules = input?.value.trim() ?? note.rules;
        const latest = await this.plugin.repo.readNote(node.path);
        if (rules !== latest.rules) await this.noteChange(node, { rules });
        new ChoiceModal(this.app, "下一步", "選擇目的後，再確認 AI 將執行的任務。", nextSteps).open();
      }), running).addClass("mod-cta");
      const pending = this.plugin.pendingSuggestions.get(node.path);
      if (pending?.length) this.button(actions, `查看 AI 子議題建議（${pending.length}）`, () => this.openChildSuggestions(node, pending), running);
      const advanced = panel.createEl("details", { cls: "vam-advanced" }); advanced.createEl("summary", { text: "模型與進階設定" });
      const modelLabel = advanced.createEl("label", { cls: "vam-field" }); modelLabel.createSpan({ text: "使用模型" });
      const select = modelLabel.createEl("select"); select.setAttr("aria-label", "使用模型");
      const options = new Set([this.plugin.settings.cliModel, ...this.plugin.settings.models.split(/[\n,]/), ...Array.from(this.notes.values()).map(n => n.model)].map(s => s.trim()).filter(Boolean));
      for (const model of options) select.createEl("option", { value: model, text: model });
      select.createEl("option", { value: "__custom__", text: "自訂模型…" }); select.value = note.model;
      const custom = modelLabel.createEl("input", { type: "text", placeholder: "輸入模型 ID" }); custom.setAttr("aria-label", "自訂模型 ID"); custom.hidden = true;
      select.addEventListener("change", () => { custom.hidden = select.value !== "__custom__"; if (!custom.hidden) custom.focus(); else this.enqueue(() => this.noteChange(node, { model: select.value, modelSource: "manual" })); });
      custom.addEventListener("change", () => { const model = custom.value.trim(); if (!model) return; this.enqueue(async () => { await this.noteChange(node, { model, modelSource: "manual" }); if (!Array.from(select.options).some(option => option.value === model)) select.add(new Option(model, model), select.options.length - 1); select.value = model; custom.hidden = true; }); });
      const sourceLabels: Record<ModelSource, string> = { workspace: "工作區預設", inherited: "建立時繼承", manual: "手動指定" };
      advanced.createEl("p", { cls: "vam-hint", text: `${note.model} · ${sourceLabels[note.modelSource]}；一般任務使用低推理，整合子議題使用高推理。` });
    } else {
      panel.createEl("p", { text: "此節點的筆記不存在，可重新連結未歸類筆記或從圖中移除。" });
      this.button(panel, "重新連結筆記", () => this.enqueue(async () => {
        const candidates = [...await this.plugin.repo.collectionFiles(this.path, "Unassigned"), ...await this.plugin.repo.inboxFiles()];
        new NoteCollectionModal(this.app, "重新連結筆記", candidates, [{ label: "使用這份筆記", run: file => this.enqueue(() => this.relinkMissingNode(node, file)) }]).open();
      }));
    }
    const relationship = panel.createEl("details", { cls: "vam-advanced" }); relationship.createEl("summary", { text: "結構與連結" });
    const parentLabel = relationship.createEl("label", { cls: "vam-field" }); parentLabel.createSpan({ text: "所屬母議題" });
    const parents = parentLabel.createEl("select"); parents.setAttr("aria-label", "母議題／連結"); parents.createEl("option", { value: "", text: "無母議題（根議題）" });
    for (const candidate of this.map!.nodes) if (canParent(this.map!.nodes, node.id, candidate.id)) parents.createEl("option", { value: candidate.id, text: this.notes.get(candidate.id)?.title ?? candidate.path });
    parents.value = node.parentId ?? "";
    parents.addEventListener("change", () => { const parentId = parents.value || null; this.enqueue(() => this.mapChange(map => { if (!canParent(map.nodes, node.id, parentId)) throw new Error("不能建立循環連結。"); map.nodes.find(n => n.id === node.id)!.parentId = parentId; })); });
    this.button(relationship, "移除母議題連結", () => this.enqueue(() => this.mapChange(map => { map.nodes.find(n => n.id === node.id)!.parentId = null; })), !node.parentId);
    relationship.createEl("p", { cls: "vam-hint", text: "更換母議題會影響下次 AI 任務取得的背景，不會更動模型。" });
    this.button(relationship, "從圖中移除", () => new ChoiceModal(this.app, "從圖中移除", "筆記會移至目前主題的 Unassigned，可重新認領或復原。", [{ label: "只移除此節點，子議題變成根議題", action: () => this.enqueue(() => this.removeToUnassigned(node, false)) }, { label: "移除整個分支", action: () => this.enqueue(() => this.removeToUnassigned(node, true)) }]).open());
  }
  private async previewMigration(): Promise<void> {
    const plan = await this.plugin.repo.legacyMigrationPlan();
    if (!plan.maps.length && !plan.orphanPaths.length) { new Notice("沒有需要整理的舊資料。"); return; }
    const noteCount = plan.maps.reduce((sum, item) => sum + item.notePaths.length, 0);
    const description = `將建立 ${plan.maps.length} 個主題資料夾，搬移 ${noteCount} 份圖內筆記，並將 ${plan.orphanPaths.length} 份孤兒筆記移至 Inbox。任一步失敗都會還原已搬移的檔案。`;
    new ChoiceModal(this.app, "整理舊版資料", description, [{ label: "確認整理", action: () => this.enqueue(async () => {
      const current = this.path, mapping = await this.plugin.repo.migrateLegacyWorkspace(plan), next = mapping.get(current);
      this.history.clear(); if (next) await this.openMap(next); else this.render(); new Notice("舊資料已整理為主題資料夾。");
    }) }]).open();
  }
  private async repairMissingTopic(): Promise<void> {
    const broken = await this.plugin.repo.brokenTopics();
    if (!broken.length) { new Notice("沒有缺少 Map.md 的主題。"); return; }
    new ChoiceModal(this.app, "修復遺失 Map", "選擇要修復的主題", broken.map(topic => ({ label: `${topic.title}（${topic.noteCount} 份 Notes）`, action: () => {
      new ChoiceModal(this.app, topic.title, "可由 Notes 重建所有節點皆為根節點的新 Map，或重新連結位於主題資料夾外的既有 Map。", [
        { label: "從 Notes 重建", action: () => this.enqueue(async () => this.openMap(await this.plugin.repo.rebuildMissingMap(topic.root))) },
        { label: "重新連結既有 Map", action: () => this.enqueue(async () => {
          const candidates = (await this.plugin.repo.mapFiles()).filter(file => !file.path.startsWith(`${this.plugin.settings.topicsFolder}/`));
          new ChoiceModal(this.app, "選擇既有 Map", "選取後會搬回此主題並重新建立可辨識的節點路徑。", candidates.map(file => ({ label: file.path, action: () => this.enqueue(async () => this.openMap(await this.plugin.repo.relinkMissingMap(topic.root, file.path))) }))).open();
        }) }
      ]).open();
    } }))).open();
  }
  private async addNode(parent: MapNode | null, suggestedTitle?: string): Promise<void> {
    if (!this.map) return;
    const model = inheritModel(parent ? (await this.plugin.repo.readNote(parent.path)).model : undefined, this.plugin.settings.cliModel);
    if (!this.path.startsWith(`${this.plugin.settings.topicsFolder}/`)) { new Notice("請先使用「整理舊資料」轉換目前心智圖。"); return; }
    const node = await this.plugin.repo.createNote(suggestedTitle?.trim() || (parent ? "新的子議題" : "我的核心議題"), model, this.map, this.path, parent ? "inherited" : "workspace");
    if (parent) await this.plugin.repo.updateNote(node.path, { rules: (await this.plugin.repo.readNote(parent.path)).rules });
    node.parentId = parent?.id ?? null; node.x = parent ? parent.x + 340 : 80;
    const siblings = this.map.nodes.filter(n => n.parentId === node.parentId);
    node.y = siblings.length ? Math.max(...siblings.map(n => n.y)) + 220 : parent?.y ?? 80;
    this.notes.set(node.id, await this.plugin.repo.readNote(node.path)); this.selected = node.id;
    await this.mapChange(map => { map.nodes.push(node); if (parent) map.nodes.find(n => n.id === parent.id)!.collapsed = false; }); this.focusNode(node);
  }
  private async proposeChildren(parent: MapNode, confirmed = false): Promise<void> {
    const pending = this.plugin.pendingSuggestions.get(parent.path);
    if (pending?.length) { this.openChildSuggestions(parent, pending); return; }
    const note = await this.plugin.repo.readNote(parent.path);
    if (this.plugin.running.has(parent.path)) return;
    if (!confirmed) {
      new ChoiceModal(this.app, "確認 AI 拆解", `AI 會分析目前議題並提出 3–7 個子議題；結果完成後仍需由你確認才會建立節點。\n\n本次套用的 AI 規則：\n${note.rules.trim() || "未設定額外規則。"}`, [
        { label: `使用 ${note.model}`, description: "這會執行一次低推理 AI 任務，不會直接修改心智圖結構。", buttonLabel: "確認並執行", action: () => this.enqueue(() => this.proposeChildren(parent, true)) }
      ]).open();
      return;
    }
    this.plugin.running.add(parent.path); this.render();
    try {
      const result = await this.plugin.askModel({ title: note.title, summary: note.summary, rules: note.rules, detail: note.detail, task: "請判斷此議題是否需要拆解。若需要，提出 3 到 7 個可獨立處理的子議題，每項提供 title、task 與 contribution；不要建立或修改任何檔案。", ancestors: await this.ancestorContext(parent), mode: "decompose" }, note.model);
      const suggestions = result.suggestions.slice(0, 7);
      if (!suggestions.length) { new Notice("AI 認為目前不需要拆解，或沒有提出可建立的子議題。"); return; }
      this.plugin.pendingSuggestions.set(parent.path, suggestions);
      new Notice(`子議題建議完成：${suggestions.length} 項。點選節點後可查看。`);
    } catch (error) { console.error("Visual Agent Map AI split", error); new Notice(error instanceof Error ? error.message : String(error)); }
    finally { this.plugin.running.delete(parent.path); await this.hydrate(); this.render(); }
  }
  private openChildSuggestions(parent: MapNode, suggestions: Suggestion[]): void {
    new ChildProposalModal(this.app, suggestions.slice(0, 7), items => this.enqueue(async () => {
      this.plugin.pendingSuggestions.delete(parent.path);
      for (const item of items) { await this.addNode(parent, item.title); const child = this.map!.nodes.at(-1)!; await this.noteChange(child, { prompt: item.task, detail: item.contribution ? canonicalDetail(item.contribution) : "" }); }
    })).open();
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
    if (!children.length) { new Notice("這個議題目前沒有直屬子議題。"); return; }
    if (!confirmed) {
      new ChoiceModal(this.app, "確認整合子議題", `AI 會讀取 ${children.length} 個直屬子議題；完成後直接更新目前理解與 MD 詳情。\n\n本次套用的 AI 規則：\n${note.rules.trim() || "未設定額外規則。"}`, [
        { label: `使用 ${note.model}`, description: "這會執行一次高推理 AI 任務。", buttonLabel: "確認並執行", action: () => this.enqueue(() => this.integrateChildren(node, true)) }
      ]).open();
      return;
    }
    const sourceContext = await this.sourceDigest(children, "strong");
    const task = "根據直屬子議題的完整知識，更新母議題的目前理解與結構化知識；合併重複資訊，清楚標示共識、差異、取捨與待確認事項。";
    this.plugin.running.add(node.path); await this.plugin.repo.updateNote(node.path, { status: "running" }); await this.hydrate(); this.render();
    try {
      const result = await this.plugin.askModel({ title: note.title, summary: note.summary, rules: note.rules, detail: note.detail, task, ancestors: await this.ancestorContext(node), sourceContext, mode: "synthesize" }, note.model);
      await this.plugin.repo.updateNote(node.path, { summary: result.summary, detail: canonicalDetail(result.detail), visualReferences: visualReferencesMarkdown(result.visualReferences), newFindings: "", status: "completed" });
      await this.plugin.rebuildDerivedData();
      new Notice("子議題整合已寫入目前理解與 MD 詳情。");
    } catch (error) { console.error("Visual Agent Map child integration", error); await this.plugin.repo.updateNote(node.path, { status: "error" }); new Notice(error instanceof Error ? error.message : String(error)); }
    finally { this.plugin.running.delete(node.path); await this.hydrate(); this.render(); }
  }
  private integrateSelected(): void {
    if (!this.map || this.multiSelected.size < 2) { new Notice("請至少選取兩個議題。"); return; }
    const nodes = [...this.multiSelected].map(id => this.map!.nodes.find(node => node.id === id)).filter((node): node is MapNode => !!node);
    const notes = nodes.map(node => this.notes.get(node.id)).filter((note): note is Note => !!note);
    const sharedRules = notes.length && notes.every(note => note.rules === notes[0].rules) ? notes[0].rules : "";
    new IntegrationModal(this.app, notes.map(note => note.title), sharedRules, (title, goal, rules) => this.enqueue(() => this.createIntegratedNode(title, nodes, goal, rules))).open();
  }
  private async sourceDigest(sources: MapNode[], mode: "strong" | "weak" = "strong"): Promise<string> {
    if (mode === "weak") return sources.map(source => `- [[${source.path.replace(/\.md$/, "")}]]`).join("\n");
    const notes = await Promise.all(sources.map(source => this.plugin.repo.readNote(source.path)));
    return sources.map((source, index) => {
      const note = notes[index];
      const finding = note.newFindings.trim();
      return [
        `- [[${source.path.replace(/\.md$/, "")}]]`,
        `  - 目前理解：${note.summary || "尚未形成結論"}`,
        note.detail.trim() ? `  - 完整知識：\n${note.detail.trim().split("\n").map(line => `    ${line}`).join("\n")}` : "",
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
    this.focusNode(integrated);
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
      const start = { x: event.clientX, y: event.clientY }, origin = { x: node.x, y: node.y }; let position = { ...origin }, moved = false;
      card.setPointerCapture(event.pointerId);
      const move = (e: PointerEvent): void => { moved ||= Math.hypot(e.clientX - start.x, e.clientY - start.y) > 3; if (!moved) return; position = { x: origin.x + (e.clientX - start.x) / this.map!.viewport.zoom, y: origin.y + (e.clientY - start.y) / this.map!.viewport.zoom }; card.style.left = `${position.x}px`; card.style.top = `${position.y}px`; this.drawEdges(); };
      const finish = (e: PointerEvent): void => { card.removeEventListener("pointermove", move); card.removeEventListener("pointerup", finish); card.removeEventListener("pointercancel", finish); if (e.type === "pointercancel") { card.style.left = `${origin.x}px`; card.style.top = `${origin.y}px`; this.drawEdges(); return; } if (moved) this.enqueue(() => this.mapChange(map => { const current = map.nodes.find(n => n.id === node.id)!; current.x = Math.round(position.x); current.y = Math.round(position.y); })); else if (e.metaKey || e.ctrlKey) { if (this.multiSelected.has(node.id)) this.multiSelected.delete(node.id); else this.multiSelected.add(node.id); this.selected = node.id; this.render(); } else { this.multiSelected.clear(); this.selected = node.id; this.render(); } };
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
      this.edgesEl.createSvg("path", { cls: "vam-edge", attr: { d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}` } });
    }
  }
  private async runAgent(node: MapNode): Promise<void> {
    const note = await this.plugin.repo.readNote(node.path);
    if (!note.prompt) { new Notice("請先輸入要交給 AI 的問題或任務。"); return; }
    if (this.plugin.running.has(node.path)) return;
    const context: TaskContext = { title: note.title, summary: note.summary, rules: note.rules, detail: note.detail, task: note.prompt, ancestors: await this.ancestorContext(node), workingFindings: note.newFindings, sourceContext: await this.extractedSourceContext(note), mode: "task" };
    this.plugin.pendingSuggestions.delete(node.path);
    this.plugin.running.add(node.path);
    try { await this.plugin.repo.updateNote(node.path, { status: "running" }); } catch (error) { this.plugin.running.delete(node.path); throw error; }
    await this.hydrate(); this.render();
    // Leave the mutation queue immediately: independent branches can run concurrently.
    void this.plugin.askModel(context, note.model).then(result => this.plugin.mutate(async () => {
      await this.plugin.repo.updateNote(node.path, { summary: result.summary, detail: canonicalDetail(result.detail), visualReferences: visualReferencesMarkdown(result.visualReferences), newFindings: "", status: "completed" });
      await this.plugin.rebuildDerivedData();
      for (const view of this.plugin.views()) view.history.clear();
      if (result.suggestions.length) this.plugin.pendingSuggestions.set(node.path, result.suggestions.slice(0, 7));
    })).catch(error => this.plugin.mutate(async () => {
      console.error("Visual Agent Map AI task", error); await this.plugin.repo.updateNote(node.path, { status: "error" });
      new Notice(error instanceof Error ? `AI 任務失敗：${error.message}` : "AI 任務失敗。");
    })).finally(() => {
      this.plugin.running.delete(node.path);
      for (const view of this.plugin.views()) view.enqueue(async () => { await view.hydrate(); view.render(); });
    }).catch(() => {});
  }
}
class VisualAgentMapSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: VisualAgentMapPlugin) { super(app, plugin); }
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [{
      type: "group",
      heading: "AI providers",
      items: [
        { name: "Codex ACP 路徑", desc: "Codex 的主要執行方式；會重用 session 並取得可用模型。", control: { type: "text", key: "codexAcpPath" } },
        { name: "Claude Code CLI 路徑", desc: "用於 claude:sonnet、claude:opus、claude:fable；需先完成 Claude Code 登入。", control: { type: "text", key: "claudePath" } },
        { name: "工作區預設 Model", desc: "目前最低成本模型為 gpt-5.6-luna；變更只影響之後新增的根議題。", control: { type: "text", key: "cliModel" } },
        { name: "Model 選單", desc: "Codex 模型透過 Codex ACP 或 Codex CLI 執行；Claude Code 請使用 claude:sonnet、claude:opus 或 claude:fable。", control: { type: "text", key: "models" } },
        { name: "Codex CLI fallback 路徑", desc: "只有 Codex ACP 失敗時才使用。", control: { type: "text", key: "cliPath" } },
        { name: "資料夾", desc: `主題資料夾：${this.plugin.settings.topicsFolder} · 未分類收件匣：${this.plugin.settings.inboxFolder}`, searchable: false }
      ]
    }];
  }
  getControlValue(key: string): unknown { return key in this.plugin.settings ? this.plugin.settings[key as keyof Settings] : undefined; }
  async setControlValue(key: string, value: unknown): Promise<void> {
    if (typeof value !== "string" || !["codexAcpPath", "claudePath", "cliModel", "models", "cliPath"].includes(key)) return;
    this.plugin.settings[key as "codexAcpPath" | "claudePath" | "cliModel" | "models" | "cliPath"] = value.trim();
    await this.plugin.saveSettings();
  }
  display(): void {
    this.containerEl.empty(); new Setting(this.containerEl).setName("AI providers").setHeading();
    this.containerEl.createEl("p", { text: "支援本機 Codex ACP、Codex CLI fallback 與 Claude Code CLI。外部工具只會在你執行 AI 任務時啟動；結果會更新目前理解並保存在議題 MD 詳情中。" });
    const text = (name: string, key: "cliPath" | "codexAcpPath" | "claudePath" | "cliModel" | "models", desc: string): void => { new Setting(this.containerEl).setName(name).setDesc(desc).addText(input => input.setValue(this.plugin.settings[key]).onChange(async value => { this.plugin.settings[key] = value.trim(); await this.plugin.saveSettings(); })); };
    text("Codex ACP 路徑", "codexAcpPath", "Codex 的主要執行方式；會重用 session 並取得可用模型。"); text("Claude Code CLI 路徑", "claudePath", "用於 claude:sonnet、claude:opus、claude:fable；需先完成 Claude Code 登入。"); text("工作區預設 Model", "cliModel", "目前最低成本模型為 gpt-5.6-luna；變更只影響之後新增的根議題。"); text("Model 選單", "models", "Codex 模型透過 Codex ACP 或 Codex CLI 執行；Claude Code 請使用 claude:sonnet、claude:opus 或 claude:fable。");
    this.containerEl.createEl("p", { cls: "setting-item-description", text: "一般任務使用低推理；整合子議題使用高推理。" });
    const advanced = this.containerEl.createEl("details"); advanced.createEl("summary", { text: "Advanced" });
    new Setting(advanced).setName("Codex CLI fallback 路徑").setDesc("只有 Codex ACP 失敗時才使用。").addText(input => input.setValue(this.plugin.settings.cliPath).onChange(async value => { this.plugin.settings.cliPath = value.trim(); await this.plugin.saveSettings(); }));
    this.containerEl.createEl("p", { text: `主題資料夾：${this.plugin.settings.topicsFolder} · 未分類收件匣：${this.plugin.settings.inboxFolder}` });
  }
}
export default class VisualAgentMapPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  repo!: Repository;
  ready: Promise<void> = Promise.resolve();
  readonly running = new Set<string>();
  readonly pendingSuggestions = new Map<string, Suggestion[]>();
  private childProcesses = new Set<VisualAgentChildProcess>();
  private acp: { child: VisualAgentChildProcess; buffer: string; nextId: number; sessionId: string | null; pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>; updates: unknown[] } | null = null;
  private acpConfigIds = { model: "model", reasoning: "" };
  private detailsLeaf: WorkspaceLeaf | null = null;
  private queue: Promise<void> = Promise.resolve();
  private writing = 0;
  async mutate(work: () => Promise<void>): Promise<void> {
    const result = this.queue.then(async () => { this.writing++; try { await work(); for (const view of this.views()) await view.synchronize(); } finally { this.writing--; } });
    this.queue = result.catch(error => { console.error("Visual Agent Map", error); new Notice(error instanceof Error ? error.message : String(error)); });
    return result;
  }
  views(): VisualAgentMapView[] { return this.app.workspace.getLeavesOfType(VIEW_TYPE).map(leaf => leaf.view).filter((view): view is VisualAgentMapView => view instanceof VisualAgentMapView); }
  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<Settings> | null;
    this.settings = { ...DEFAULT_SETTINGS, workspaceFolder: saved?.workspaceFolder || DEFAULT_SETTINGS.workspaceFolder, topicsFolder: saved?.topicsFolder || DEFAULT_SETTINGS.topicsFolder, inboxFolder: saved?.inboxFolder || DEFAULT_SETTINGS.inboxFolder, notesFolder: saved?.notesFolder || DEFAULT_SETTINGS.notesFolder, mapsFolder: saved?.mapsFolder || DEFAULT_SETTINGS.mapsFolder, mapId: saved?.mapId || "default", cliPath: saved?.cliPath || DEFAULT_SETTINGS.cliPath, codexAcpPath: saved?.codexAcpPath || DEFAULT_SETTINGS.codexAcpPath, claudePath: saved?.claudePath || DEFAULT_SETTINGS.claudePath, cliModel: saved?.cliModel || DEFAULT_SETTINGS.cliModel, cliReasoning: saved?.cliReasoning || DEFAULT_SETTINGS.cliReasoning, previewScale: saved?.previewScale !== undefined ? clampPreviewScale(saved.previewScale) : legacyPreviewScale(saved?.previewSize), models: saved?.models || DEFAULT_SETTINGS.models, migrated: saved?.migrated === true, structureVersion: saved?.structureVersion ?? (saved ? 1 : DEFAULT_SETTINGS.structureVersion) };
    this.repo = new Repository(this.app, this.settings);
    const initialize = (this.settings.migrated ? Promise.resolve() : this.repo.migrate().then(async () => { await this.repo.rebuildDerivedData(); this.settings.migrated = true; })).then(async () => {
      if (this.settings.structureVersion < 2) {
        const count = await this.repo.normalizeGeneratedNoteFilenames();
        this.settings.structureVersion = 2; await this.saveSettings();
        if (count) new Notice(`已將 ${count} 份子議題檔名同步為議題名稱。`);
      }
    });
    this.ready = initialize;
    this.registerView(VIEW_TYPE, leaf => new VisualAgentMapView(leaf, this));
    this.addRibbonIcon("git-fork", "Open Visual Agent Map", () => { void this.activateView().catch(error => new Notice(String(error))); });
    this.addCommand({ id: "open", name: "Open map", callback: () => { void this.activateView().catch(error => new Notice(String(error))); } });
    this.addCommand({ id: "rebuild-references", name: "重建議題 reference", callback: () => { void this.mutate(async () => { await this.repo.rebuildDerivedData(); new Notice("議題 reference 已依心智圖重建。"); }); } });
    this.addCommand({ id: "normalize-note-filenames", name: "同步議題名稱與檔名", callback: () => { void this.mutate(async () => { const count = await this.repo.normalizeGeneratedNoteFilenames(); new Notice(count ? `已同步 ${count} 份議題檔名。` : "議題檔名已是最新狀態。"); }); } });
    this.addSettingTab(new VisualAgentMapSettingTab(this.app, this));
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => { if (file instanceof TFile && this.isMap(file)) menu.addItem(item => item.setTitle("以心智圖開啟").setIcon("git-fork").onClick(() => { void this.activateView(file.path); })); }));
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
      void this.ready.then(() => this.repo.ensureNodePresentation()).catch(error => {
        console.error("Visual Agent Map topic presentation", error);
        new Notice(`無法套用議題筆記顯示設定：${error instanceof Error ? error.message : String(error)}`);
      });
    });
    this.registerEvent(this.app.vault.on("modify", file => { if (!this.writing && file instanceof TFile) for (const view of this.views()) view.changed(file); }));
    this.registerEvent(this.app.vault.on("delete", file => { if (!this.writing && file instanceof TFile) { for (const view of this.views()) view.deleted(file); if (file.path.startsWith(`${this.settings.mapsFolder}/`) || file.path.startsWith(`${this.settings.topicsFolder}/`) && file.name === "Map.md") void this.mutate(() => this.repo.rebuildDerivedData()); } }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => { if (!this.writing && file instanceof TFile) void this.mutate(async () => {
      for (const mapFile of await this.repo.mapFiles()) { const map = await this.repo.readMap(mapFile.path); let changed = false; for (const node of map.nodes) if (node.path === oldPath) { node.path = file.path; changed = true; } if (changed) await this.repo.saveMap(mapFile.path, map); }
      await this.rebuildDerivedData();
      for (const view of this.views()) await view.renamed(file, oldPath);
    }); }));
  }
  private isMap(file: TFile): boolean {
    const frontmatter: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const marker = metadataValue(frontmatter, "visual-agent-map");
    return marker === true || marker === "true" || (file.extension === "md" && (file.path.startsWith(`${this.settings.mapsFolder}/`) || file.path.startsWith(`${this.settings.topicsFolder}/`) && file.name === "Map.md"));
  }
  private isNode(file: TFile): boolean {
    const frontmatter: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const marker = metadataValue(frontmatter, "agent-map-node");
    return marker === true || marker === "true" || (file.extension === "md" && (file.path.startsWith(`${this.settings.notesFolder}/`) || file.path.startsWith(`${this.settings.topicsFolder}/`) || file.path.startsWith(`${this.settings.inboxFolder}/`)));
  }
  private styleNodeLeaf(leaf: WorkspaceLeaf | null): void {
    if (!(leaf?.view instanceof MarkdownView)) return;
    leaf.view.containerEl.toggleClass("vam-topic-markdown", !!leaf.view.file && this.isNode(leaf.view.file));
  }
  onunload(): void { if (this.acp) { this.acp.child.kill(); this.acp = null; } for (const child of this.childProcesses) child.kill(); this.childProcesses.clear(); }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
  async rebuildDerivedData(): Promise<void> { try { await this.repo.rebuildDerivedData(); } catch (error) { console.error("Visual Agent Map reference rebuild", error); new Notice(`心智圖已儲存，但 reference 更新失敗：${error instanceof Error ? error.message : String(error)}`); } }
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
    if (!this.detailsLeaf) throw new Error("無法開啟右側詳情欄。");
    await this.detailsLeaf.openFile(file);
    this.styleNodeLeaf(this.detailsLeaf);
    await this.app.workspace.revealLeaf(this.detailsLeaf);
  }
  private async activateView(path?: string): Promise<void> { await this.ready; let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]; if (!leaf) leaf = this.app.workspace.getLeaf("tab"); await leaf.setViewState({ type: VIEW_TYPE, active: true, state: path ? { file: path } : leaf.view instanceof VisualAgentMapView ? leaf.view.getState() : {} }); await this.app.workspace.revealLeaf(leaf); }
  async askModel(context: TaskContext, model: string): Promise<AiResult> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("CLI 模式只支援桌面版 Obsidian");
    if (!this.manifest.dir) throw new Error("找不到外掛目錄");

    const pluginDirectory = join(adapter.getBasePath(), this.manifest.dir);
    const schemaPath = join(pluginDirectory, "response-schema.json");
    if (model.startsWith("claude:")) return this.askClaude(context, model.slice("claude:".length), pluginDirectory);
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
      `目前議題：\n${context.title}`,
      `目前理解：\n${context.summary}`,
      context.mode !== "decompose" ? `現有 Detail（須整合後完整取代，不能原樣重複追加）：\n${context.detail || "（無）"}` : "",
      `目前議題的 AI 規則（優先遵守）：\n${context.rules || "（無）"}`,
      context.workingFindings ? `舊版待整理發現（本次必須一併收斂）：\n${context.workingFindings}` : "",
      context.sourceContext ? `整合來源背景：\n${context.sourceContext}` : "",
      `祖先議題背景：\n${context.ancestors || "（無）"}`,
      `目前任務：\n${context.task}`
    ].join("\n\n");

    try {
      return await this.askCodexAcp(instructions, model, pluginDirectory);
    } catch (error) {
      console.warn("Visual Agent Map Codex ACP failed; falling back to Codex CLI", error);
      return this.askCodexExec(instructions, model, pluginDirectory, schemaPath);
    }
  }
  private parseAiResult(raw: string, label: string): AiResult {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned) as { summary?: unknown; detail?: unknown; suggestions?: unknown; visualReferences?: unknown };
    if (typeof parsed.summary !== "string" || typeof parsed.detail !== "string") throw new Error(`${label} 沒有回傳 summary 與 detail`);
    const suggestions = isUnknownArray(parsed.suggestions) ? parsed.suggestions.filter((item): item is Record<string, unknown> & { title: string; task: string } => isRecord(item) && typeof item.title === "string" && typeof item.task === "string").map(item => ({ title: item.title.trim(), task: item.task.trim(), contribution: typeof item.contribution === "string" ? item.contribution.trim() : "" })).filter(item => item.title) : [];
    const visualReferences = isUnknownArray(parsed.visualReferences) ? parsed.visualReferences.filter((item): item is Record<string, unknown> & { imageUrl: string; sourceUrl: string } => isRecord(item) && typeof item.imageUrl === "string" && typeof item.sourceUrl === "string").map(item => ({
      title: typeof item.title === "string" ? item.title.trim() : "視覺參考",
      imageUrl: item.imageUrl.trim(),
      sourceUrl: item.sourceUrl.trim(),
      description: typeof item.description === "string" ? item.description.trim() : "",
      palette: isUnknownArray(item.palette) ? item.palette.filter((color): color is string => typeof color === "string").map(color => color.trim()).filter(Boolean).slice(0, 8) : [],
      formula: typeof item.formula === "string" ? item.formula.trim() : ""
    })).filter(item => /^https?:\/\//i.test(item.imageUrl) && /^https?:\/\//i.test(item.sourceUrl)).slice(0, 6) : [];
    return { summary: Array.from(parsed.summary.trim()).slice(0, 80).join(""), detail: parsed.detail.trim(), suggestions, visualReferences };
  }
  private acpSend(message: AcpMessage): void {
    if (!this.acp) throw new Error("Codex ACP 尚未啟動");
    this.acp.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private acpRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this.acp) throw new Error("Codex ACP 尚未啟動");
    const id = this.acp.nextId++;
    this.acpSend({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => this.acp?.pending.set(id, { resolve, reject }));
  }
  private acpRespond(id: number, result: unknown): void { this.acpSend({ jsonrpc: "2.0", id, result }); }
  private handleAcpMessage(message: AcpMessage): void {
    if ("id" in message && ("result" in message || "error" in message)) {
      const entry = this.acp?.pending.get(message.id);
      if (!entry) return;
      this.acp?.pending.delete(message.id);
      if (message.error) entry.reject(new Error(typeof message.error === "string" ? message.error : message.error.message || "Codex ACP 回傳錯誤"));
      else entry.resolve(message.result);
      return;
    }
    if ("method" in message && message.method === "session/update") {
      this.acp?.updates.push(message.params);
      return;
    }
    if ("id" in message && "method" in message) {
      if (message.method === "session/request_permission") { this.acpRespond(message.id, { outcome: { outcome: "cancelled" } }); return; }
      if (message.method === "terminal/create") { this.acpRespond(message.id, { terminalId: "visual-agent-map-denied" }); return; }
      if (message.method === "terminal/output") { this.acpRespond(message.id, { output: "", truncated: false, exitStatus: { exitCode: 1 } }); return; }
      if (message.method === "terminal/wait_for_exit") { this.acpRespond(message.id, { exitCode: 1 }); return; }
      this.acpRespond(message.id, {});
    }
  }
  private async ensureAcp(pluginDirectory: string): Promise<string> {
    if (!this.acp) {
      const child = spawn(this.settings.codexAcpPath, [], { cwd: pluginDirectory, stdio: ["pipe", "pipe", "pipe"] });
      this.childProcesses.add(child);
      this.acp = { child, buffer: "", nextId: 1, sessionId: null, pending: new Map(), updates: [] };
      let stderr = "";
      child.stdout.on("data", chunk => {
        if (!this.acp || this.acp.child !== child) return;
        this.acp.buffer += chunk.toString("utf8");
        while (true) {
          const newline = this.acp.buffer.indexOf("\n");
          if (newline === -1) return;
          const line = this.acp.buffer.slice(0, newline).trim();
          this.acp.buffer = this.acp.buffer.slice(newline + 1);
          if (line) this.handleAcpMessage(JSON.parse(line) as AcpMessage);
        }
      });
      child.stderr.on("data", chunk => { stderr += chunk.toString(); });
      child.on("error", error => {
        for (const entry of this.acp?.pending.values() ?? []) entry.reject(new Error(`無法啟動 Codex ACP：${error.message}`));
        this.childProcesses.delete(child);
        if (this.acp?.child === child) this.acp = null;
      });
      child.on("close", code => {
        for (const entry of this.acp?.pending.values() ?? []) entry.reject(new Error(stderr.trim() || `Codex ACP 結束碼：${code ?? "未知"}`));
        this.childProcesses.delete(child);
        if (this.acp?.child === child) this.acp = null;
      });
      await this.acpRequest("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "visual-agent-map", version: this.manifest.version || "0.0.0" } });
    }
    if (!this.acp.sessionId) {
      const session = await this.acpRequest("session/new", { cwd: pluginDirectory, mcpServers: [] }) as { sessionId?: string; configOptions?: unknown[] };
      if (!session.sessionId) throw new Error("Codex ACP 沒有建立 session");
      this.acp.sessionId = session.sessionId;
      this.acpConfigIds = this.codexConfigIds(session.configOptions);
      const acpModels = this.codexModelsFromConfig(session.configOptions);
      if (acpModels.length) {
        const merged = Array.from(new Set([...acpModels, ...this.settings.models.split(/[\n,]/).map(item => item.trim()).filter(Boolean)]));
        const next = merged.join(", ");
        if (next !== this.settings.models) { this.settings.models = next; await this.saveSettings(); }
      }
    }
    return this.acp.sessionId;
  }
  private codexModelsFromConfig(configOptions: unknown): string[] {
    if (!Array.isArray(configOptions)) return [];
    const option = configOptions.find(item => {
      const record = item as { id?: unknown; category?: unknown };
      return record.id === "model" || record.category === "model";
    }) as { options?: unknown } | undefined;
    if (!Array.isArray(option?.options)) return [];
    const flatten = (items: unknown[]): string[] => items.flatMap(item => {
      const record = item as { value?: unknown; options?: unknown };
      if (Array.isArray(record.options)) return flatten(record.options);
      return typeof record.value === "string" ? [record.value] : [];
    });
    return flatten(option.options);
  }
  private codexConfigIds(configOptions: unknown): { model: string; reasoning: string } {
    if (!Array.isArray(configOptions)) return { model: "model", reasoning: "" };
    const findId = (matches: string[]): string => {
      const option = configOptions.find(item => {
        const record = item as { id?: unknown; category?: unknown };
        return matches.includes(String(record.id)) || matches.includes(String(record.category));
      }) as { id?: unknown } | undefined;
      return typeof option?.id === "string" ? option.id : "";
    };
    return { model: findId(["model"]) || "model", reasoning: findId(["reasoning", "reasoning-effort", "model_reasoning_effort"]) };
  }
  private acpTextSince(since: number): string {
    return (this.acp?.updates.slice(since) ?? []).map(item => (item as { update?: { sessionUpdate?: string; type?: string; text?: string; content?: string } }).update).filter(update => update?.sessionUpdate === "agent_message_chunk" || update?.type === "agent_message_chunk").map(update => update?.text || update?.content || "").join("");
  }
  private async askCodexAcp(prompt: string, model: string, pluginDirectory: string): Promise<AiResult> {
    const sessionId = await this.ensureAcp(pluginDirectory);
    const modelOption = model.trim();
    if (modelOption) await this.acpRequest("session/set_config_option", { sessionId, configId: this.acpConfigIds.model, value: modelOption });
    const modeLine = prompt.includes("這是 Synthesize 模式") ? "high" : "low";
    if (this.acpConfigIds.reasoning) await this.acpRequest("session/set_config_option", { sessionId, configId: this.acpConfigIds.reasoning, value: modeLine }).catch(() => undefined);
    const since = this.acp?.updates.length ?? 0;
    await this.acpRequest("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
    const text = this.acpTextSince(since).trim();
    return this.parseAiResult(text, "Codex ACP");
  }
  private ensureResponseSchema(schemaPath: string): void {
    try {
      if (readFileSync(schemaPath, "utf8") === RESPONSE_SCHEMA_JSON) return;
    } catch {
      // Community Plugins installs only main.js, manifest.json, and styles.css.
    }
    writeFileSync(schemaPath, RESPONSE_SCHEMA_JSON, "utf8");
  }
  private async askCodexExec(instructions: string, model: string, pluginDirectory: string, schemaPath: string): Promise<AiResult> {
    this.ensureResponseSchema(schemaPath);
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox", "read-only",
      "--color", "never",
      "--output-schema", schemaPath,
      "-C", pluginDirectory
    ];
    if (model) args.push("--model", model);
    args.push("--config", `model_reasoning_effort=${this.settings.cliReasoning || "low"}`);
    args.push("-");
    return new Promise((resolve, reject) => {
      const child = spawn(this.settings.cliPath, args, {
        cwd: pluginDirectory,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.childProcesses.add(child);
      let stdout = "";
      let stderr = "";
      const outputLimit = 5 * 1024 * 1024;
      const timeout = window.setTimeout(() => {
        child.kill();
        reject(new Error("Codex CLI 執行超過 15 分鐘"));
      }, 15 * 60 * 1000);

      child.stdout.on("data", chunk => {
        stdout += chunk.toString();
        if (stdout.length > outputLimit) child.kill();
      });
      child.stderr.on("data", chunk => {
        stderr += chunk.toString();
        if (stderr.length > outputLimit) child.kill();
      });
      child.on("error", (error) => {
        window.clearTimeout(timeout);
        this.childProcesses.delete(child);
        reject(new Error(`無法啟動 Codex CLI：${error.message}`));
      });
      child.on("close", (code) => {
        window.clearTimeout(timeout);
        this.childProcesses.delete(child);
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Codex CLI 結束碼：${code ?? "未知"}`));
          return;
        }
        try {
          resolve(this.parseAiResult(stdout, "Codex CLI"));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.stdin.end(instructions);
    });
  }
  private async askClaude(context: TaskContext, model: string, pluginDirectory: string): Promise<AiResult> {
    const schema = RESPONSE_SCHEMA_JSON;
    const args = [
      "-p",
      "--output-format", "json",
      "--permission-mode", "dontAsk",
      "--permission-prompts", "none",
      "--tools", "",
      "--no-session-persistence",
      "--json-schema", schema,
      "--model", model || "sonnet"
    ];
    const instructions = [
      "你是視覺化思考 Agent。不要修改任何檔案，也不要讀取本機檔案。",
      context.mode === "task"
        ? "這是一般任務：summary 必須是一句適合心智圖顯示的新目前理解，80 字內；detail 是會直接取代舊 Detail 的完整知識頁，必須吸收舊內容與本次發現、去除重複、保留仍有效的來源。"
        : context.mode === "decompose"
          ? "這是 Decompose 模式：只產生 3–7 個可獨立處理的子議題 suggestions。summary 與 detail 簡述拆解判斷；不要更新結論。"
          : context.mode === "synthesize"
            ? "這是 Synthesize 模式：summary 必須是高品質整合結論，80 字內；detail 必須整合來源完整知識、收斂重複內容、清楚呈現共識、分歧、取捨與未解問題；完成後會直接寫回。"
            : "summary 必須是一句適合心智圖顯示的新目前理解，detail 必須是完整繁體中文 Markdown 分析。",
      context.mode !== "decompose" ? "detail 必須且只能依序使用以下六個三級標題：### 核心結論、### 關鍵知識、### 證據與來源、### 取捨與限制、### 待確認事項、### 更新紀錄。更新紀錄只新增一行本次變更摘要，不可重貼完整答案；沒有內容的段落寫「尚待補充」。" : "",
      context.mode !== "decompose" ? "若任務需要視覺理解（例如穿搭、配色、室內設計、食譜外觀、UI 參考），請提供 1–6 個已搜尋到的圖片參考 visualReferences；必須包含圖片 URL 與來源頁 URL，不要生成圖片，不要編造來源。" : "",
      `目前議題：\n${context.title}`,
      `目前理解：\n${context.summary}`,
      context.mode !== "decompose" ? `現有 Detail（須整合後完整取代，不能原樣重複追加）：\n${context.detail || "（無）"}` : "",
      `目前議題的 AI 規則（優先遵守）：\n${context.rules || "（無）"}`,
      context.workingFindings ? `舊版待整理發現（本次必須一併收斂）：\n${context.workingFindings}` : "",
      context.sourceContext ? `整合來源背景：\n${context.sourceContext}` : "",
      `祖先議題背景：\n${context.ancestors || "（無）"}`,
      `目前任務：\n${context.task}`
    ].join("\n\n");

    return new Promise((resolve, reject) => {
      const child = spawn(this.settings.claudePath, args, {
        cwd: pluginDirectory,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.childProcesses.add(child);
      let stdout = "";
      let stderr = "";
      const outputLimit = 5 * 1024 * 1024;
      const timeout = window.setTimeout(() => {
        child.kill();
        reject(new Error("Claude Code CLI 執行超過 15 分鐘"));
      }, 15 * 60 * 1000);

      child.stdout.on("data", chunk => {
        stdout += chunk.toString();
        if (stdout.length > outputLimit) child.kill();
      });
      child.stderr.on("data", chunk => {
        stderr += chunk.toString();
        if (stderr.length > outputLimit) child.kill();
      });
      child.on("error", (error) => {
        window.clearTimeout(timeout);
        this.childProcesses.delete(child);
        reject(new Error(`無法啟動 Claude Code CLI：${error.message}`));
      });
      child.on("close", (code) => {
        window.clearTimeout(timeout);
        this.childProcesses.delete(child);
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Claude Code CLI 結束碼：${code ?? "未知"}`));
          return;
        }
        try {
          const wrapper = JSON.parse(stdout.trim()) as { result?: unknown; is_error?: unknown };
          if (wrapper.is_error) throw new Error(typeof wrapper.result === "string" ? wrapper.result : "Claude Code CLI 回傳錯誤");
          const raw = typeof wrapper.result === "string" ? wrapper.result.trim() : stdout.trim();
          resolve(this.parseAiResult(raw, "Claude"));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.stdin.end(instructions);
    });
  }
}
