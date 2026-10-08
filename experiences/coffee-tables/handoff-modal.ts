import { Modal, type App } from "obsidian";
import { randomUUID } from "node:crypto";
import type VisualAgentMapPlugin from "../../main";
import { isHandoffWriteError, type ExperienceHandoffResult } from "../../core/experience-router";
import { normalizeReasoningLevel } from "../../ai/task-policy";
import { buildCoffeeSource, coffeeCommittedKey, createCoffeeHandoffArtifact, type CoffeeSource } from "./handoff-source";
import type { CoffeeSession } from "./types";
import type { CoffeeHandoffSnapshot, CoffeeStorage } from "./storage";
import { syncModelSelect } from "../../core/model-discovery";

export async function openCoffeeResearchHandoff(plugin: VisualAgentMapPlugin, store: CoffeeStorage, displayed: CoffeeSession, path: string, insightId?: string | string[]): Promise<CoffeeHandoffModal> {
  const displayedKey = coffeeCommittedKey(displayed);
  if (plugin.coffeeManager?.get(displayed.id)?.busy) throw new Error("Wait for this table to finish.");
  const snapshot = await store.handoffSnapshot(path, displayed.id);
  if (plugin.coffeeManager?.get(displayed.id)?.busy) throw new Error("Wait for this table to finish.");
  if (displayedKey !== coffeeCommittedKey(snapshot.session)) throw new Error("Coffee source differs from the displayed table; reopen the latest table.");
  const modal = new CoffeeHandoffModal(plugin.app, plugin, store, snapshot, buildCoffeeSource(snapshot.session, insightId));
  plugin.register(() => modal.close());
  modal.open();
  return modal;
}

export class CoffeeHandoffModal extends Modal {
  private readonly operationId = randomUUID();
  private controller: AbortController | null = null;
  private epoch = 0;
  private closed = false;
  private creating = false;
  private blocked = false;
  private result?: ExperienceHandoffResult;
  private method: "manual" | "ai" = "manual";
  private rationale = "";
  private question!: HTMLTextAreaElement;
  private context!: HTMLTextAreaElement;
  private model!: HTMLSelectElement;
  private reasoning!: HTMLSelectElement;
  private language!: HTMLSelectElement;
  private organize!: HTMLButtonElement;
  private stop!: HTMLButtonElement;
  private create!: HTMLButtonElement;
  private status!: HTMLElement;
  private readonly zh: boolean;
  private unsubscribeModels?: () => void;
  constructor(app: App, private readonly plugin: VisualAgentMapPlugin, private readonly store: CoffeeStorage, private readonly snapshot: CoffeeHandoffSnapshot, private readonly source: CoffeeSource) {
    super(app); this.zh = plugin.settings.language === "zh-TW";
  }
  private tr(en: string, zh: string): string { return this.zh ? zh : en; }
  onOpen(): void {
    this.titleEl.setText(this.tr("Take to Visual Map for deeper research", "帶去 Visual Map 深入研究"));
    this.contentEl.addClass("ct-handoff-modal");
    this.contentEl.createEl("p", { text: this.tr("Edit a research question and context. AI organization is optional. Coffee ideas remain simulated and unverified.", "編輯研究問題與脈絡，可選擇讓 AI 整理。Coffee 的想法仍屬模擬且未經驗證。") });
    this.question = this.field(this.tr("Research question", "研究問題"), 3); this.question.value = this.source.question;
    this.context = this.field(this.tr("Research context", "研究脈絡"), 8);
    this.context.value = this.source.sourceSnapshot.replace(/<!--\s*(?:coffee-insight:v1:|source:)[\s\S]*?-->/g, "").replace(/[ \t]+\n/g, "\n");
    const choices = this.contentEl.createDiv("ct-handoff-options");
    this.model = this.select(choices, this.tr("Model", "模型"), [...new Set([this.snapshot.session.model, ...this.plugin.availableModels()])]);
    this.model.value = this.snapshot.session.model;
    const discovery = this.contentEl.createDiv("ct-handoff-status");
    const discoveryText = discovery.createSpan({ attr: { role: "status", "aria-live": "polite" } });
    const retry = discovery.createEl("button", { text: this.tr("Retry model discovery", "重新載入模型") });
    const updateModels = (): void => {
      const selected = this.model.value;
      syncModelSelect(this.model, this.plugin.availableModels(), id => this.plugin.modelLabel(id), this.tr("unavailable", "無法使用"));
      if (selected && !Array.from(this.model.options).some(option => option.value === selected)) this.model.add(new Option(`${this.plugin.modelLabel(selected)} (${this.tr("unavailable", "無法使用")})`, selected));
      this.model.value = selected;
      const codex = this.plugin.modelDiscoveryState("codex"), claude = this.plugin.modelDiscoveryState("claude");
      discoveryText.setText(`Codex: ${codex.status}${codex.error ? ` · ${codex.error}` : ""} | Claude CLI candidates: ${claude.status}`);
      retry.disabled = codex.status === "loading";
    };
    this.unsubscribeModels = this.plugin.subscribeModelDiscovery(updateModels);
    retry.addEventListener("click", () => { void this.plugin.refreshModelDiscovery("codex"); void this.plugin.refreshModelDiscovery("claude"); });
    updateModels(); void this.plugin.refreshModelDiscovery("codex"); void this.plugin.refreshModelDiscovery("claude");
    this.reasoning = this.select(choices, this.tr("Reasoning", "推理程度"), ["low", "medium", "high", "auto"]); this.reasoning.value = normalizeReasoningLevel(this.snapshot.session.reasoning);
    this.language = this.select(choices, this.tr("Output language", "輸出語言"), ["en", "zh-TW"]); this.language.value = this.plugin.settings.language;
    this.status = this.contentEl.createEl("p", { cls: "ct-handoff-status", attr: { role: "status", "aria-live": "polite" } });
    const actions = this.contentEl.createDiv("modal-button-container");
    this.organize = actions.createEl("button", { text: this.tr("Organize with AI", "AI 整理") });
    this.stop = actions.createEl("button", { text: this.tr("Stop", "停止") }); this.stop.disabled = true;
    const copy = actions.createEl("button", { text: this.tr("Copy draft", "複製草稿") });
    this.create = actions.createEl("button", { text: this.tr("Create research map", "建立研究地圖"), cls: "mod-cta" });
    this.organize.onclick = () => { void this.generate(); };
    this.stop.onclick = () => { this.cancel(); this.status.setText(this.tr("Stopped. Your previous draft is preserved.", "已停止，原草稿已保留。")); };
    copy.onclick = () => { void navigator.clipboard.writeText([this.question.value, this.context.value, this.rationale].filter(Boolean).join("\n\n")).then(() => this.status.setText(this.tr("Draft copied.", "已複製草稿。"))).catch(error => this.showError(error)); };
    this.create.onclick = () => { void this.submit(); };
    this.question.focus();
  }
  private field(label: string, rows: number): HTMLTextAreaElement {
    const id = `ct-handoff-${randomUUID()}`;
    this.contentEl.createEl("label", { text: label, attr: { for: id } });
    return this.contentEl.createEl("textarea", { attr: { id, rows: String(rows), "aria-label": label } });
  }
  private select(parent: HTMLElement, label: string, values: string[]): HTMLSelectElement {
    const id = `ct-handoff-${randomUUID()}`;
    const group = parent.createDiv(); group.createEl("label", { text: label, attr: { for: id } });
    const select = group.createEl("select", { attr: { id, "aria-label": label } });
    for (const value of values) select.createEl("option", { text: value, value });
    return select;
  }
  private refresh(): void {
    const busy = this.controller !== null || this.creating;
    for (const input of [this.question, this.context, this.model, this.reasoning, this.language]) input.disabled = busy || this.blocked || !!this.result;
    this.organize.disabled = busy || this.blocked || !!this.result;
    this.stop.disabled = !this.controller;
    this.create.disabled = busy || this.blocked;
  }
  private cancel(): void {
    this.epoch++;
    this.controller?.abort();
    this.plugin.activeTasks.delete(`reframe-modal:${this.operationId}`);
    this.controller = null;
    if (!this.closed) this.refresh();
  }
  private async assertSource(): Promise<void> {
    if (this.closed) throw new Error("Research handoff closed");
    if (this.plugin.coffeeManager?.get(this.snapshot.session.id)?.busy) throw new Error(this.tr("The table is generating. Reopen it after it finishes.", "這桌正在生成，請完成後重新開啟。"));
    await this.store.assertHandoffSnapshot(this.snapshot);
    if (this.closed) throw new Error("Research handoff closed");
    if (this.plugin.coffeeManager?.get(this.snapshot.session.id)?.busy) throw new Error(this.tr("The table is generating. Reopen it after it finishes.", "這桌正在生成，請完成後重新開啟。"));
  }
  private showError(error: unknown): void { if (!this.closed) this.status.setText(error instanceof Error ? error.message : String(error)); }
  private async generate(): Promise<void> {
    if (this.controller || this.creating || this.blocked || this.result || this.closed) return;
    const controller = new AbortController(), epoch = ++this.epoch;
    this.controller = controller; this.plugin.activeTasks.set(`reframe-modal:${this.operationId}`, controller); this.refresh();
    const request = { targetCore: "understand" as const, source: this.source.content, question: this.question.value, context: this.context.value, model: this.model.value, reasoning: normalizeReasoningLevel(this.reasoning.value), language: this.language.value === "zh-TW" ? "zh-TW" as const : "en" as const };
    this.status.setText(this.tr("Organizing a research question…", "正在整理研究問題…"));
    try {
      await this.assertSource();
      const confirmed = await this.plugin.confirmAiUsage(request.model, async () => {
        if (controller.signal.aborted || this.closed || epoch !== this.epoch) return;
        const draft = await this.plugin.core.reframing!.reframe(request, controller.signal);
        await this.assertSource();
        if (controller.signal.aborted || this.closed || epoch !== this.epoch) return;
        this.question.value = draft.question; this.context.value = draft.context; this.rationale = draft.rationale; this.method = "ai";
        this.status.setText(this.tr("Review and edit this draft, then create the research map.", "請檢視並編輯草稿，再建立研究地圖。"));
      });
      if (!confirmed && epoch === this.epoch && !this.closed) this.status.setText(this.tr("AI did not run. Edit the draft manually or retry.", "AI 未執行，可以手動編輯草稿或重試。"));
    } catch (error) { if (epoch === this.epoch) this.showError(error); }
    finally { if (epoch === this.epoch) { this.controller = null; this.plugin.activeTasks.delete(`reframe-modal:${this.operationId}`); if (!this.closed) this.refresh(); } }
  }
  private async submit(): Promise<void> {
    if (this.controller || this.creating || this.blocked || this.closed) return;
    const title = this.question.value.trim();
    if (!title || /[\r\n]/.test(title)) { this.status.setText(this.tr("Enter a single-line research question.", "請輸入單行研究問題。")); return; }
    this.creating = true; this.refresh();
    try {
      if (this.result) {
        await this.plugin.openResearchMap(this.result.targetPath);
        this.close(); return;
      }
      await this.assertSource();
      const path = this.snapshot.path;
      const content = [this.context.value.trim(), this.rationale ? `Reframing rationale:\n${this.rationale}` : ""].filter(Boolean).join("\n\n");
      const artifact = createCoffeeHandoffArtifact({
        sessionId: this.snapshot.session.id, sourcePath: path, topic: this.snapshot.session.topic,
        source: this.source, question: title, content, model: this.model.value,
        reasoning: this.reasoning.value, language: this.language.value, reframingMethod: this.method
      });
      const result = await this.plugin.core.experiences.handoff({ target: "visual-map", artifact, beforeWrite: () => this.assertSource() });
      if (!result) throw new Error("Research handoff did not return saved target paths");
      this.result = result;
      if (result.navigationError) {
        this.status.setText(`${this.tr("Saved. Retry only opens the existing map:", "已保存，重試只會開啟既有地圖：")}\n${result.targetPath}\n${result.navigationError}`);
        this.create.setText(this.tr("Open saved map", "開啟已保存地圖"));
      } else this.close();
    } catch (error) {
      if (isHandoffWriteError(error) && error.paths.length) {
        this.blocked = true;
        this.showError(`${this.tr("Some files were created. Inspect them before starting another handoff; copy your draft.", "已建立部分檔案，請先檢查再開始新的交接，並複製草稿。")}\n${error.paths.join("\n")}\n${error.message}`);
      } else this.showError(error);
    } finally { this.creating = false; if (!this.closed) this.refresh(); }
  }
  onClose(): void { this.closed = true; this.unsubscribeModels?.(); this.unsubscribeModels = undefined; this.cancel(); this.contentEl.empty(); }
}
