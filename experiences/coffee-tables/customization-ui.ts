import { Modal, Notice, type App } from "obsidian";
import type { CoffeeEngine } from "./engine";
import { baselineFromVersions } from "./insights";
import { convergenceProposalKey, convergenceSelectionRevision, defaultCustomization, normalizeCustomization, validateCustomization, type CoffeeCustomization } from "./customization";
import { BUILTIN_COFFEE_STYLE_PROMPT, BUILTIN_COFFEE_STYLE_PROMPT_EN, cleanChatStyle } from "./prompts";

export function customizationFields(parent: HTMLElement, initial: unknown, language: string, changed: () => void = () => undefined): { read: () => CoffeeCustomization; set: (value: unknown) => void } {
  const zh = language === "zh-TW", tr = (en: string, tw: string): string => zh ? tw : en;
  const root = parent.createDiv("ct-customization-fields");
  const organize = root.createEl("section"); organize.createEl("h4", { text: tr("How to organize", "怎麼整理") });
  organize.createEl("p", { cls: "ct-muted", text: tr("Choose the viewpoints, reasons and open questions to retain.", "指定你想留下的觀點、理由與未解問題。") });
  const observerLabel = organize.createEl("label", { text: tr("Observer instructions", "觀察者整理指令") });
  const observer = observerLabel.createEl("textarea", { attr: { rows: "5", maxlength: "12000" } });
  const converge = root.createEl("section"); converge.createEl("h4", { text: tr("How to converge", "怎麼收斂") });
  converge.createEl("p", { cls: "ct-muted", text: tr("Combine similar ideas while retaining important differences and sources. Preview before applying.", "合併相似觀點，同時保留重要差異與來源。先預覽，再套用。") });
  const controls = converge.createDiv("ct-style-fields");
  const select = (label: string, options: Array<[string, string]>): HTMLSelectElement => { const field = controls.createEl("label", { text: label }); const el = field.createEl("select"); for (const [value, text] of options) el.createEl("option", { value, text }); return el; };
  const merge = select(tr("Merge level", "合併程度"), [["detailed", tr("Keep detail", "保留細節")], ["balanced", tr("Balanced", "適度合併")], ["compact", tr("Compact", "高度精簡")]]);
  const detail = select(tr("Length target", "篇幅目標"), [["brief", tr("Brief", "精簡")], ["standard", tr("Standard", "標準")], ["detailed", tr("Detailed", "詳細")]]);
  converge.createEl("small", { cls: "ct-muted", text: tr("Length is a target. Important differences may need more space.", "篇幅是目標；重要差異可能需要較多文字。") });
  const preserve = new Map<string, HTMLInputElement>();
  const fieldset = converge.createEl("fieldset"); fieldset.createEl("legend", { text: tr("Keep these aspects", "保留重點") });
  for (const [key, en, tw] of [["disagreements", "Different perspectives", "不同立場"], ["conditions", "Conditions and limits", "條件限制"], ["counterexamples", "Counterexamples", "反例"], ["questions", "Open questions", "未解問題"], ["sources", "Sources", "來源"]]) { const label = fieldset.createEl("label"); const input = label.createEl("input", { attr: { type: "checkbox" } }); label.createSpan({ text: tr(en, tw) }); preserve.set(key, input); }
  const warning = converge.createEl("p", { cls: "ct-muted", text: tr("Unchecked aspects are no longer emphasized; original notes remain available until you accept changes.", "取消勾選後將不再強調該重點；接受變更前仍保留原有整理。") }); void warning;
  const advanced = converge.createEl("details"); advanced.createEl("summary", { text: tr("Advanced: custom convergence instructions", "進階：自訂收斂指令") });
  const convergenceLabel = advanced.createEl("label", { text: tr("Additional requirements", "補充要求") });
  const convergence = convergenceLabel.createEl("textarea", { attr: { rows: "4", maxlength: "12000", placeholder: tr("For example: combine repetitions but retain minority views.", "例如：合併重複敘述，但保留少數觀點。") } });
  const errors = root.createEl("p", { cls: "ct-error", attr: { "aria-live": "polite" } });
  const read = (): CoffeeCustomization => ({ observerPrompt: observer.value, convergencePrompt: convergence.value, mergeLevel: merge.value as CoffeeCustomization["mergeLevel"], detailLevel: detail.value as CoffeeCustomization["detailLevel"], preserve: [...preserve].filter(([, input]) => input.checked).map(([key]) => key) as CoffeeCustomization["preserve"] });
  const validate = (): void => { errors.setText(validateCustomization(read(), language).join("\n")); };
  const set = (value: unknown): void => { const current = normalizeCustomization(value, language); observer.value = current.observerPrompt; convergence.value = current.convergencePrompt; merge.value = current.mergeLevel; detail.value = current.detailLevel; for (const [key, input] of preserve) input.checked = current.preserve.includes(key as CoffeeCustomization["preserve"][number]); validate(); };
  root.addEventListener("input", () => { validate(); changed(); }); root.addEventListener("change", () => { validate(); changed(); });
  const reset = root.createEl("button", { text: tr("Restore organization prompts", "還原整理與收斂 Prompt") }); reset.onclick = () => { const defaults = defaultCustomization(language); set({ ...read(), observerPrompt: defaults.observerPrompt, convergencePrompt: defaults.convergencePrompt }); changed(); };
  const protectedRules = root.createEl("details", { cls: "ct-protected-rules" }); protectedRules.createEl("summary", { text: tr("System rules · read only", "系統規則 · 唯讀") });
  protectedRules.createEl("p", { text: tr("The app manages insight IDs, output structure, completion checks, source links and saving. Editing instructions cannot change tool permissions or remove pinned insights.", "系統管理洞見識別碼、輸出結構、完成檢查、來源連結與保存。編輯指令不會改變工具權限，也不能刪除指定保留的洞見。") });
  set(initial); return { read, set };
}

export class CoffeeCustomizationModal extends Modal {
  private testing = false;
  constructor(app: App, private engine: CoffeeEngine, private saveDefault: (style: string, customization: CoffeeCustomization) => Promise<void>, private reviewed: () => void, private confirmRun: (work: () => Promise<void>) => Promise<void>) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("ct-customization-modal");
    const { contentEl: content, engine } = this, zh = engine.session.language === "zh-TW", tr = (en: string, tw: string): string => zh ? tw : en;
    content.createEl("h2", { text: tr("Customize this table", "客製聊天室") });
    content.createEl("p", { cls: "ct-muted", text: tr("New settings affect later actions. Existing conversation is not rewritten.", "新設定會影響後續操作；已產生的內容不會自動重寫。") });
    content.createEl("h4", { text: tr("How to chat", "怎麼聊") });
    content.createEl("p", { cls: "ct-muted", text: tr("Choose how people speak and interact. You can restore the default at any time.", "決定大家怎麼聊。可自由修改，隨時還原。") });
    const label = content.createEl("label", { text: tr("Conversation instructions", "聊天室指令") });
    const style = label.createEl("textarea", { attr: { rows: "6", maxlength: "30000" } });
    const builtin = cleanChatStyle(zh ? BUILTIN_COFFEE_STYLE_PROMPT : BUILTIN_COFFEE_STYLE_PROMPT_EN);
    style.value = cleanChatStyle(engine.session.guests?.stylePrompt ?? [builtin, engine.session.guests?.customPrompt].filter(Boolean).join("\n\n"));
    const reset = content.createEl("button", { text: tr("Restore chat default", "還原聊天預設") }); reset.onclick = () => { style.value = builtin; };
    const fields = customizationFields(content, engine.session.guests?.customization, engine.session.language);
    const resetPrompts = content.createEl("button", { text: tr("Reset prompts", "還原這桌 Prompt") });
    resetPrompts.onclick = () => { const defaults = defaultCustomization(engine.session.language); style.value = builtin; fields.set({ ...fields.read(), observerPrompt: defaults.observerPrompt, convergencePrompt: defaults.convergencePrompt }); };
    const errors = content.createEl("p", { cls: "ct-error", attr: { "aria-live": "polite" } });
    const testResult = content.createEl("textarea", { attr: { rows: "12", readonly: "true", "aria-label": tr("Settings test result", "設定試跑結果") } });
    const actions = content.createDiv("ct-customization-actions");
    const run = (label: string, action: (value: CoffeeCustomization) => Promise<void>): void => { const button = actions.createEl("button", { text: label }); button.onclick = () => { const value = fields.read(), issues = validateCustomization(value, engine.session.language); errors.setText(issues.join("\n")); if (issues.length) return; for (const item of Array.from(actions.querySelectorAll("button"))) item.disabled = true; void action(value).catch(error => errors.setText(error instanceof Error ? error.message : String(error))).finally(() => { for (const item of Array.from(actions.querySelectorAll("button"))) item.disabled = false; }); }; };
    run(tr("Apply to this table", "套用此聊天室"), async value => { await engine.setCustomization(style.value, value); new Notice(tr("Table settings saved.", "聊天室設定已保存。")); this.close(); });
    run(tr("Default for new tables", "設為新聊天室預設"), async value => { await this.saveDefault(style.value, value); new Notice(tr("Saved for new tables.", "已設為新聊天室預設。")); });
    run(tr("Test", "試跑"), async value => {
      const draftStyle = style.value;
      this.testing = true; testResult.value = "";
      try { await this.confirmRun(async () => { testResult.value = await engine.testCustomization(draftStyle, value); }); }
      finally { this.testing = false; }
    });
    run(tr("Preview convergence once", "只用這次：預覽收斂"), async value => { await this.confirmRun(() => engine.previewConvergence(value)); if (engine.session.convergenceDraft || engine.session.convergenceRawDraft) { this.close(); this.reviewed(); } });
    content.createEl("small", { cls: "ct-muted", text: tr("A one-time preview uses the organization and convergence settings here. Chat changes require Apply or Default.", "本次預覽只使用這裡的整理與收斂設定；聊天風格需按套用或設為預設才會保存。") });
    content.createEl("small", { cls: "ct-muted", text: tr("Test uses the current draft settings without saving. Reset changes this draft only; Apply to this table saves it.", "試跑使用目前草稿設定，不會保存。還原只改此草稿；套用此聊天室才會保存。") });
  }
  onClose(): void { if (this.testing) this.engine.cancelRecommendations(); this.contentEl.empty(); }
}

export class CoffeeConvergenceModal extends Modal {
  constructor(app: App, private engine: CoffeeEngine) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("ct-customization-modal");
    const content = this.contentEl, engine = this.engine, zh = engine.session.language === "zh-TW", tr = (en: string, tw: string): string => zh ? tw : en;
    const draft = engine.session.convergenceDraft;
    content.createEl("h2", { text: tr("Review convergence", "檢閱收斂草稿") });
    content.createEl("p", { cls: "ct-muted", text: tr("Original notes are retained. Only checked changes are applied after confirmation.", "原有觀點仍保留，確認後才會套用勾選的變更。") });
    if (!draft) { content.createEl("p", { text: tr("No valid preview is available. Copy the saved response or try again.", "目前沒有可套用的草稿。可複製已保存回應或重新預覽。") }); const raw = content.createEl("textarea", { attr: { rows: "12", readonly: "true" } }); raw.value = engine.session.convergenceRawDraft ?? ""; return; }
    const baseline = baselineFromVersions(engine.session.observerNotes ?? [], engine.session.language);
    const selected = new Set<number>(), eligible = new Set<number>(), checkboxes: HTMLInputElement[] = [], edits: Record<number, { summary: string; detail: string }> = {};
    const reviewEdits: Record<string, { summary: string; detail: string }> = { ...(draft.reviewEdits ?? {}) };
    let selectionRevision = convergenceSelectionRevision({ ...draft, reviewEdits });
    const restored = new Set(draft.selection?.revision === selectionRevision ? draft.selection.proposalKeys : []);
    for (const [index, item] of draft.proposals.entries()) {
      const prior = item.sourceIds.map(id => baseline.find(source => source.id === id)).filter(source => !!source);
      const unchanged = prior.length === 1 && prior[0].summary === item.summary && prior[0].detail === item.detail && prior[0].category === item.category;
      const pinned = item.sourceIds.some(id => engine.session.pinnedInsightIds?.includes(id));
      const block = content.createEl("section", { cls: "ct-convergence-proposal" });
      const label = block.createEl("label"); const checkbox = label.createEl("input", { attr: { type: "checkbox" } }); checkbox.checked = false; checkbox.disabled = pinned || unchanged;
      checkboxes.push(checkbox);
      if (!checkbox.disabled) { eligible.add(index); checkbox.checked = restored.has(convergenceProposalKey(item)); }
      if (checkbox.checked) selected.add(index);
      label.createSpan({ text: pinned ? tr("Pinned · unchanged", "指定保留 · 不變") : unchanged ? tr("Unchanged", "保留不變") : item.sourceIds.length > 1 ? tr(`Merge ${item.sourceIds.length} insights`, `合併 ${item.sourceIds.length} 項洞見`) : tr("Revise insight", "修正洞見") });
      checkbox.onchange = () => { if (checkbox.checked) selected.add(index); else selected.delete(index); updateSelection(); };
      const before = block.createEl("details"); before.createEl("summary", { text: tr("Original viewpoints", "原有觀點") }); for (const source of prior) { before.createEl("p", { text: source.summary }); if (source.detail) before.createEl("p", { cls: "ct-muted", text: source.detail }); }
      const key = convergenceProposalKey(item), savedEdit = reviewEdits[key];
      const summaryLabel = block.createEl("label", { text: tr("Suggested viewpoint", "建議觀點") }); const summary = summaryLabel.createEl("textarea", { attr: { rows: "2", maxlength: "1000" } }); summary.value = savedEdit?.summary ?? item.summary; summary.disabled = pinned || unchanged;
      const detailLabel = block.createEl("label", { text: tr("Context and differences", "脈絡與差異") }); const detail = detailLabel.createEl("textarea", { attr: { rows: "4", maxlength: "12000" } }); detail.value = savedEdit?.detail ?? item.detail; detail.disabled = pinned || unchanged;
      if (savedEdit) edits[index] = { ...savedEdit };
      const changed = (): void => {
        const edit = { summary: summary.value, detail: detail.value };
        edits[index] = edit; reviewEdits[key] = edit;
        const nextRevision = convergenceSelectionRevision({ ...draft, reviewEdits });
        if (nextRevision !== selectionRevision) { selectionRevision = nextRevision; selected.clear(); for (const input of checkboxes) input.checked = false; }
        updateSelection();
      };
      summary.oninput = changed; detail.oninput = changed;
    }
    const errors = content.createEl("p", { cls: "ct-error", attr: { "aria-live": "polite" } }), actions = content.createDiv("ct-customization-actions");
    const selectionActions = content.createDiv("ct-customization-actions");
    const selectAll = selectionActions.createEl("button", { text: tr("Select all changes", "全選可套用變更") }); selectAll.disabled = !eligible.size;
    selectAll.onclick = () => { for (const index of eligible) selected.add(index); for (const checkbox of checkboxes) checkbox.checked = !checkbox.disabled; updateSelection(); };
    const clearSelection = selectionActions.createEl("button", { text: tr("Clear selection", "清除選取") }); clearSelection.disabled = true;
    clearSelection.onclick = () => { selected.clear(); for (const checkbox of checkboxes) checkbox.checked = false; updateSelection(); };
    const apply = actions.createEl("button", { text: "", cls: "mod-cta" });
    const updateSelection = (persist = true): void => { apply.setText(tr(`Accept selected changes (${selected.size})`, `接受勾選變更（${selected.size}）`)); apply.disabled = selected.size === 0; clearSelection.disabled = selected.size === 0; if (persist) engine.updateConvergenceReviewState(selectionRevision, [...selected].map(index => convergenceProposalKey(draft.proposals[index])), reviewEdits); };
    updateSelection(false);
    const isCurrentDraft = (): boolean => { const current = engine.session.convergenceDraft; return !!current && current.createdAt === draft.createdAt && current.baseFingerprint === draft.baseFingerprint && convergenceSelectionRevision(current) === selectionRevision; };
    apply.onclick = () => { if (!isCurrentDraft()) { errors.setText(tr("The draft changed. Reopen the latest preview.", "草稿已更新，請重新開啟最新預覽。")); return; } if (!selected.size) { errors.setText(tr("Select a change to apply.", "請先勾選要套用的變更。")); return; } apply.disabled = true; void engine.applyConvergence([...selected], edits).then(() => this.close()).catch(error => { errors.setText(error instanceof Error ? error.message : String(error)); updateSelection(false); }); };
    const discard = actions.createEl("button", { text: tr("Discard preview", "捨棄草稿") }); discard.onclick = () => { if (!isCurrentDraft()) { errors.setText(tr("The draft changed. Reopen the latest preview.", "草稿已更新，請重新開啟最新預覽。")); return; } discard.disabled = true; void engine.discardConvergence().then(() => this.close()).catch(error => { errors.setText(String(error)); discard.disabled = false; }); };
  }
  onClose(): void { this.contentEl.empty(); }
}
