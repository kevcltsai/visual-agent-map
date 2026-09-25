import { t, setUiLanguage, topicStatusLabel, translate, initialUiLanguage, type TranslationKey } from "./i18n";
import { App, MarkdownRenderer, FileSystemAdapter, ItemView, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, getLanguage, type Command, type SettingDefinitionItem } from "obsidian";
import { ReferencePicker, type ReferenceTopic } from "./ui/reference-picker";
import { packReferenceChunks, readMarkdownFile, referenceBatches, type ReferenceGroup } from "./ai/reference-materials";
import { NameModal } from "./ui/modals/name-modal";
import { ChoiceModal } from "./ui/modals/choice-modal";
import { DebugLogModal } from "./ui/modals/debug-log-modal";
import { existsSync as nodeExistsSync, readdirSync as nodeReaddirSync } from "node:fs";
import { delimiter as nodeDelimiter, dirname as nodeDirname, isAbsolute as nodeIsAbsolute, join as nodeJoin } from "node:path";
import { canParent, clone, descendants, History, inheritModel, MapDocument, MapNode, parseMap, removeNodes, serializeMap, visibleNodes } from "./map-model";
import { arrangeMap, arrangeNewBranch } from "./map-layout";
import { DEFAULT_SETTINGS, ModelSource, normalizeReasoningLevel, Note, NotePatch, Repository, ResearchDepth, ResearchMode, Settings, TopicInfo, TopicState, VisualMode } from "./repository";
import { buildPreparedTaskContext } from "./ai/context-builder";
import { canonicalDetail, visualReferencesMarkdown } from "./ai/result-utils";
import { effectiveReasoningLevel, researchGuidance, researchLimits } from "./ai/task-policy";
import type { AiResult, Suggestion, TaskContext } from "./ai/types";
import { clampPreviewScale, legacyPreviewScale, previewMetrics } from "./ui/preview-utils";
import { BUILTIN_SAMPLE_ID, builtInSample, SAMPLE_TOUR_VERSION } from "./builtin-sample";
import { debugLog, LogManager } from "./log-manager";
import { AiExchangeLog } from "./ai-exchange-log";
import { PendingSuggestions } from "./pending-suggestions";
import { OutlineView, OUTLINE_VIEW_TYPE } from "./ui/outline-view";
import { randomUUID } from "node:crypto";
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
interface TaskOptions { referenceGroups?: ReferenceGroup[]; onProgress?: (message: string) => void; signal?: AbortSignal; requirements?: string; researchMode: ResearchMode; researchDepth: ResearchDepth; visualMode: VisualMode; multiLayer?: boolean; shallowResearch?: boolean; layers?: number; firstLayerCount?: number; childrenPerParent?: number }
function researchDepthDescription(depth: ResearchDepth): string {
  const description = depth === "fast"
    ? t("ui.quick_aim_for_up_to_1_web_search_and_2_main_sources_answer_t")
    : depth === "deep"
      ? t("ui.deep_aim_for_up_to_6_web_searches_and_10_main_sources_compar")
      : t("ui.standard_aim_for_up_to_3_web_searches_and_5_main_sources_sum");
  return `${description} ${t("ui.web_and_image_searches_share_the_search_limit_search_counts")}`;
}
function visualGuidance(context: TaskContext, language: Settings["language"]): string[] {
  const synthesis = context.mode === "synthesize";
  const maySearch = context.researchMode !== "local" && context.mode !== "decompose" && context.visualMode !== "off";
  const mayReuse = synthesis;
  const instructions: string[] = [];
  if (!maySearch) {
    instructions.push(translate(language, "prompt.visual_none"));
    if (mayReuse) instructions.push(translate(language, "prompt.visual_preserve"));
  } else if (context.visualMode === "on") instructions.push(translate(language, "prompt.visual_on"));
  else instructions.push(translate(language, "prompt.visual_auto"));
  if (maySearch || mayReuse) instructions.push(translate(language, "prompt.visual_embed"));
  return instructions;
}
function imageReferencesFromMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  const blocks = lines.flatMap((line, index) => /^\s*!\[[^\]]*\]\(https?:\/\/[^\s)]+\)/i.test(line)
    ? [lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 4)).join("\n").trim()]
    : []);
  return [...new Set(blocks)].join("\n\n");
}
class PartialChildBatchError extends Error {}
interface TaskSourceSettings { topics: () => Promise<ReferenceTopic[]>; readTopic: (topic: ReferenceTopic, signal: AbortSignal, progress: (message: string) => void) => Promise<{ path: string; content: string }[]>; currentTopicId: string; currentLabel: string; synthesisLabel?: string }
function quickShape(layers: number, firstLayerCount: number, childrenPerParent: number): { counts: bigint[]; total: bigint } {
  if (![layers, firstLayerCount, childrenPerParent].every(Number.isSafeInteger) || layers < 1 || layers > 15 || firstLayerCount < 1 || childrenPerParent < 0) throw new Error(t("ui.levels_first_level_count_and_children_per_topic_must_be_posi"));
  const counts: bigint[] = [];
  let count = BigInt(firstLayerCount), total = BigInt(0);
  for (let level = 0; level < layers; level++) { counts.push(count); total += count; if (childrenPerParent === 0) break; count *= BigInt(childrenPerParent); }
  return { counts, total };
}
function quickSuggestions(items: Suggestion[], layers: number, firstLayerCount: number, childrenPerParent: number): Suggestion[] {
  const shape = quickShape(layers, firstLayerCount, childrenPerParent);
  if (shape.total > BigInt(15)) throw new Error(t("ui.this_would_create_0_subtopics_exceeding_the_limit_of_15_redu", shape.total.toString()));
  const invalid = (): never => { throw new Error(t("ui.ai_did_not_follow_the_requested_level_counts_and_parent_chil")); };
  const byTitle = new Map<string, Suggestion>();
  for (const item of items) {
    if (!item.title?.trim() || byTitle.has(item.title.trim())) invalid();
    byTitle.set(item.title.trim(), item);
  }
  const grouped: Suggestion[][] = [];
  let previous = new Set<string>();
  for (let level = 0; level < layers; level++) {
    const current = items.filter(item => level === 0 ? !item.parentTitle?.trim() : previous.has(item.parentTitle?.trim() || ""));
    if (current.length !== Number(shape.counts[level])) invalid();
    if (level > 0 && [...previous].some(title => current.filter(item => item.parentTitle?.trim() === title).length !== childrenPerParent)) invalid();
    grouped.push(current);
    previous = new Set(current.map(item => item.title.trim()));
  }
  const selected = grouped.flat();
  if (selected.length !== items.length) invalid();
  return selected;
}
class TaskModal extends Modal {
  constructor(app: App, private value: string, private submit: (value: string, run: boolean, options: TaskOptions, rules: string) => void, private titleText = t("ui.custom_ai_task"), private description = t("ui.describe_what_you_want_ai_to_do_next"), private rules = "", private mode: ResearchMode = "research", private depth: ResearchDepth = "normal", private visual: VisualMode = "auto", _allowSave = true, private expand = false, private referenceSettings?: TaskSourceSettings) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    this.contentEl.createEl("p", { text: this.description, cls: "vam-modal-intro" });
    const label = this.contentEl.createEl("label", { cls: "vam-field" });
    label.createSpan({ text: t("ui.additional_requirements") });
    const input = label.createEl("textarea", { cls: "vam-task-input" }); input.rows = 3;
    input.setAttr("aria-label", t("ui.additional_requirements"));
    this.contentEl.createEl("p", { text: t("ui.requirements_this_task_only"), cls: "vam-hint" });
    if (this.rules.trim()) this.contentEl.createEl("p", { text: t("ui.legacy_rules_not_applied"), cls: "vam-hint" });
    const referenceLabel = this.expand ? this.referenceSettings?.currentLabel : this.referenceSettings?.synthesisLabel ?? this.referenceSettings?.currentLabel;
    const references = this.referenceSettings ? new ReferencePicker(this.app, this.contentEl, this.referenceSettings.topics, this.referenceSettings.readTopic, this.referenceSettings.currentTopicId, referenceLabel ?? "", this.mode !== "local", this.visual !== "off") : null;
    const depthLabel = this.contentEl.createEl("label", { cls: "vam-field" }); depthLabel.createSpan({ text: t("ui.research_depth") });
    const depthHint = this.contentEl.createEl("p", { cls: "vam-hint", text: researchDepthDescription(this.depth) });
    const depth = this.contentEl.createEl("select"); depth.setAttr("aria-label", t("ui.research_depth"));
    for (const [value, key] of [["fast", "ui.fast_quick_overview"], ["normal", "ui.normal_standard_research"], ["deep", "ui.deep_in_depth_research"]] as const) depth.createEl("option", { value, text: t(key) });
    depth.value = this.depth;
    depth.addEventListener("change", () => depthHint.setText(researchDepthDescription(depth.value as ResearchDepth)));
    const layers = this.expand ? this.contentEl.createEl("label", { cls: "vam-field" }) : null;
    const multiLayer = layers?.createEl("input", { type: "checkbox" });
    if (multiLayer) multiLayer.checked = true;
    if (layers) layers.createSpan({ text: t("ui.create_two_levels_and_research_each_topic_briefly_up_to_15") });
    const save = async (run: boolean): Promise<void> => {
      const value = this.value;
      const sources = await references?.ready();
      const shallowResearch = multiLayer?.checked ?? false;
      this.close(); this.submit(value, run, { referenceGroups: sources?.groups ?? [], requirements: input.value.trim(), researchMode: sources?.webSearch ? "research" : "local", researchDepth: depth.value as ResearchDepth, visualMode: sources?.imageSearch ? (this.visual === "on" ? "on" : "auto") : "off", multiLayer: shallowResearch }, "");
    };
    new Setting(this.contentEl).addButton(b => b.setButtonText(t("ui.cancel")).onClick(() => this.close()))
      .addButton(b => b.setButtonText(t("ui.confirm_and_run")).setCta().onClick(() => { void save(true).catch(error => new Notice(String(error))); }));
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  }
}
export class NextStepModal extends Modal {
  private closed = false;
  private settingsPending: Promise<void> = Promise.resolve();
  private settingsError: string | null = null;
  constructor(app: App, private topic: string, private depth: ResearchDepth, private childrenCount: number, private pendingCount: number, private plugin: VisualAgentMapPlugin,
    private research: (options: TaskOptions, focus: string, done: (result: AiResult) => void, failed: (message: string) => void) => Promise<void>,
    private expand: (options: TaskOptions, direction: string, found: (items: Suggestion[], create: (items: Suggestion[]) => Promise<void>) => void, failed: (message: string, retryable?: boolean) => void, created: () => void) => Promise<void>,
    private synthesize: (options: TaskOptions, angles: (items: Suggestion[], draft: (direction: string) => Promise<void>) => void, drafted: (result: AiResult, save: (summary: string, detail: string) => Promise<void>) => void, failed: (message: string) => void) => Promise<void>,
    private modelSettings?: { model: string; modelSource: ModelSource; reasoning: string; rules?: string; path?: string; save: (patch: NotePatch) => Promise<void>; running?: boolean; stop?: () => void; quickError?: string; sources?: TaskSourceSettings }) { super(app); }
  private references = new Map<string, ReferencePicker>();
  private taskSignal?: AbortSignal;
  private taskController?: AbortController;
  private addReferencePicker(panel: HTMLElement, mode: "research" | "expand" | "synthesize"): ReferencePicker | undefined {
    const sources = this.modelSettings?.sources;
    if (!sources) return undefined;
    const picker = new ReferencePicker(this.app, panel, sources.topics, sources.readTopic, sources.currentTopicId, mode === "synthesize" ? sources.synthesisLabel ?? sources.currentLabel : sources.currentLabel, mode !== "synthesize", mode !== "synthesize");
    this.references.set(mode, picker); return picker;
  }
  private requirementsInput?: HTMLTextAreaElement;
  private renderRequirements(): void {
    const label = this.contentEl.createEl("label", { cls: "vam-field" });
    label.createSpan({ text: t("ui.additional_requirements") });
    this.requirementsInput = label.createEl("textarea", { cls: "vam-next-focus" });
    this.requirementsInput.rows = 3;
    this.requirementsInput.setAttr("aria-label", t("ui.additional_requirements"));
    this.contentEl.createEl("p", { text: t("ui.requirements_this_task_only"), cls: "vam-hint" });
    if (this.modelSettings?.rules?.trim()) this.contentEl.createEl("p", { text: t("ui.legacy_rules_not_applied"), cls: "vam-hint" });
  }
  private requirements(): string { return this.requirementsInput?.value.trim() ?? ""; }
  onClose(): void { this.closed = true; this.taskController?.abort(); }
  private async readySettings(): Promise<void> { await this.settingsPending; if (this.settingsError) throw new Error(this.settingsError); }
  private renderModelSettings(): void {
    if (!this.modelSettings) return;
    const settings = this.modelSettings;
    const advanced = this.contentEl.createEl("details", { cls: "vam-advanced vam-next-model" }); advanced.createEl("summary", { text: t("ui.model_and_advanced_settings") });
    const error = advanced.createEl("p", { cls: "vam-hint" });
    const save = (patch: NotePatch): void => {
      this.settingsError = null; error.setText("");
      this.settingsPending = this.settingsPending.then(() => settings.save(patch)).catch(cause => {
        this.settingsError = cause instanceof Error ? cause.message : String(cause);
        error.setText(this.settingsError);
      });
    };
    const modelLabel = advanced.createEl("label", { cls: "vam-field" }); modelLabel.createSpan({ text: t("ui.model") });
    const model = modelLabel.createEl("select"); model.setAttr("aria-label", t("ui.model"));
    const options = new Set(this.plugin.settings.models.split(/[\n,]/).map(value => value.trim()).filter(Boolean));
    for (const value of options) model.createEl("option", { value, text: value });
    if (!options.has(settings.model)) { const unavailable = model.createEl("option", { value: settings.model, text: t("ui.current_model_is_unavailable") }); unavailable.disabled = true; }
    model.value = settings.model;
    model.addEventListener("change", () => { if (options.has(model.value)) save({ model: model.value, modelSource: "manual" }); });
    const reasoningLabel = advanced.createEl("label", { cls: "vam-field" }); reasoningLabel.createSpan({ text: t("ui.reasoning_level") });
    const reasoning = reasoningLabel.createEl("select"); reasoning.setAttr("aria-label", t("ui.reasoning_level"));
    for (const [value, label] of [["auto", t("ui.auto")], ["low", t("ui.low")], ["medium", t("ui.medium")], ["high", t("ui.high")]]) reasoning.createEl("option", { value, text: label });
    reasoning.value = normalizeReasoningLevel(settings.reasoning);
    reasoning.addEventListener("change", () => save({ reasoning: normalizeReasoningLevel(reasoning.value) }));
    const sourceLabels: Record<ModelSource, string> = { workspace: t("ui.workspace_default"), inherited: t("ui.inherited_at_creation"), manual: t("ui.manually_selected") };
    advanced.createEl("p", { cls: "vam-hint", text: t("ui.0_1_reasoning_can_be_adjusted_per_topic", settings.model, sourceLabels[settings.modelSource]) });
  }
  private async run(panel: HTMLElement, button: HTMLButtonElement, work: () => Promise<void>, needsUsage = true): Promise<void> {
    if (button.disabled || (this.taskController && !this.taskController.signal.aborted)) return;
    button.disabled = true;
    if (!await this.plugin.codexReadyForAi()) { this.failed(panel, button, t("ui.codex_required_for_ai")); return; }
    const start = async (): Promise<void> => {
      button.disabled = true;
      const controller = new AbortController(); this.taskController = controller; this.taskSignal = controller.signal;
      const tasksBefore = new Set(this.plugin.activeTasks?.keys?.() ?? []);
      const status = panel.querySelector<HTMLElement>(".vam-next-status");
      status?.setText(t("ui.ai_running_ai"));
      let cancel = panel.querySelector<HTMLButtonElement>(".vam-task-cancel");
      if (!cancel) cancel = panel.createEl("button", { text: t("ui.cancel"), cls: "vam-task-cancel" });
      cancel.hidden = false; cancel.onclick = () => controller.abort();
      try { await this.readySettings(); await work(); } catch (error) { this.failed(panel, button, controller.signal.aborted ? t("ui.ai_task_cancelled") : error instanceof Error ? error.message : String(error)); }
      finally {
        const backgroundTaskRunning = [...(this.plugin.activeTasks?.keys?.() ?? [])].some(path => !tasksBefore.has(path));
        const release = (): void => { cancel.hidden = true; if (this.taskSignal === controller.signal) { this.taskSignal = undefined; this.taskController = undefined; } };
        if (backgroundTaskRunning) {
          const waitForTasks = (): void => {
            if (this.taskController !== controller) return;
            if ([...(this.plugin.activeTasks?.keys?.() ?? [])].some(path => !tasksBefore.has(path))) window.setTimeout(waitForTasks, 250);
            else release();
          };
          window.setTimeout(waitForTasks, 250);
        } else release();
      }
    };
    if (!needsUsage || this.plugin.settings.codexUsageNoticeSeen) { await start(); return; }
    const notice = panel.querySelector<HTMLElement>(".vam-next-usage") ?? panel.createDiv("vam-next-usage");
    notice.empty();
    notice.createEl("strong", { text: t("ui.codex_allowance_notice") });
    notice.createEl("p", { text: t("ui.vam_runs_ai_tasks_through_your_signed_in_codex_account_and_u") });
    notice.createEl("button", { text: t("ui.cancel") }).addEventListener("click", () => notice.remove());
    notice.createEl("button", { text: t("ui.understand_and_run"), cls: "mod-cta" }).addEventListener("click", () => { void (async () => { try { this.plugin.settings.codexUsageNoticeSeen = true; await this.plugin.saveSettings(); notice.remove(); await start(); } catch (error) { this.plugin.settings.codexUsageNoticeSeen = false; this.failed(panel, button, error instanceof Error ? error.message : String(error)); } })(); });
  }
  private failed(panel: HTMLElement, button: HTMLButtonElement, message: string): void {
    if (this.closed) return;
    panel.querySelector<HTMLElement>(".vam-next-status")?.setText(message);
    button.disabled = false;
  }
  private proposals(panel: HTMLElement, suggestions: Suggestion[], create: (items: Suggestion[]) => Promise<void>, button: HTMLButtonElement, consumed: () => void, options: TaskOptions): void {
    if (this.closed) return;
    const result = panel.querySelector<HTMLElement>(".vam-next-result")!; result.empty();
    result.createEl("h4", { text: t("ui.ai_subtopic_proposals") });
    result.createEl("p", { text: t("ui.select_subtopics_to_create_you_can_edit_their_names_and_task") });
    const rows: { item: Suggestion; check: HTMLInputElement; title: HTMLInputElement; task: HTMLTextAreaElement; contribution: HTMLTextAreaElement }[] = [];
    const list = result.createDiv("vam-proposal-list");
    for (const item of suggestions) { const row = list.createDiv("vam-proposal"); if (item.parentTitle) row.createEl("p", { text: t("ui.child_of_0", item.parentTitle) }); const check = row.createEl("input", { type: "checkbox" }); check.checked = true; const title = row.createEl("input", { type: "text", value: item.title }); const task = row.createEl("textarea", { text: item.task }); task.rows = 2; const contribution = row.createEl("textarea", { text: item.contribution }); contribution.rows = 2; contribution.placeholder = t("ui.contribution_to_the_parent_topic"); rows.push({ item, check, title, task, contribution }); }
    const confirm = result.createEl("button", { text: t("ui.create_subtopics"), cls: "mod-cta" });
    confirm.addEventListener("click", () => { void (async () => {
      const selected = rows.filter(row => row.check.checked && row.title.value.trim());
      if (!selected.length) { panel.querySelector<HTMLElement>(".vam-next-status")?.setText(t("ui.select_at_least_one_subtopic")); return; }
      const renamed = new Map(selected.filter(row => !row.item.parentTitle).map(row => [row.item.title, row.title.value.trim()]));
      const names = selected.filter(row => !row.item.parentTitle).map(row => row.title.value.trim());
      if (new Set(names).size !== names.length) { this.failed(panel, button, t("ui.first_level_topic_names_must_be_unique")); return; }
      if (selected.some(row => row.item.parentTitle && !renamed.has(row.item.parentTitle))) { this.failed(panel, button, t("ui.select_the_parent_topic_before_its_child")); return; }
      void this.run(panel, confirm, async () => {
        options.signal = this.taskSignal;
        panel.querySelector<HTMLElement>(".vam-next-status")?.setText(t("ui.creating_subtopics"));
        try { await create(selected.map(row => ({ title: row.title.value.trim(), task: row.task.value.trim(), contribution: row.contribution.value.trim(), parentTitle: row.item.parentTitle ? renamed.get(row.item.parentTitle)! : "" }))); result.empty(); consumed(); panel.querySelector<HTMLElement>(".vam-next-status")?.setText(t("ui.subtopics_created")); confirm.disabled = false; button.disabled = false; }
        catch (error) { if (error instanceof PartialChildBatchError) { result.empty(); consumed(); button.disabled = false; } throw error; }
      }, false);
    })(); });
    panel.querySelector<HTMLElement>(".vam-next-status")?.setText(t("ui.review_ai_suggested_subtopics"));
  }
  onOpen(): void {
    this.modalEl.addClass("vam-next-modal");
    this.titleEl.setText(t("ui.how_would_you_like_to_explore_next"));
    this.contentEl.createEl("p", { text: t("ui.current_topic_0", this.topic), cls: "vam-modal-intro" });
    this.renderRequirements();
    const cards = this.contentEl.createDiv("vam-next-cards");
    let show: (mode: "research" | "expand" | "synthesize") => void;
    const card = (title: TranslationKey, description: TranslationKey, mode: "research" | "expand" | "synthesize"): HTMLButtonElement => {
      const button = cards.createEl("button", { cls: "vam-next-card" });
      const copy = button.createSpan(); copy.createEl("strong", { text: t(title) }); copy.createSpan({ text: t(description) });
      button.createSpan({ text: "›", cls: "vam-next-arrow" });
      button.addEventListener("click", () => show(mode));
      button.setAttr("aria-pressed", mode === "research" ? "true" : "false");
      if (mode === "research") button.addClass("is-active");
      return button;
    };
    const researchCard = card("ui.research_deeper", "ui.find_answers_for_this_topic_at_your_chosen_depth", "research");
    const expandCard = card("ui.expand_the_map", "ui.discuss_directions_or_explore_multiple_levels_with_shallow_r", "expand");
    const synthesizeCard = card("ui.synthesize_findings", "ui.find_shared_conclusions_differences_and_next_steps_across_su", "synthesize");
    if (this.modelSettings?.running) {
      const running = this.contentEl.createDiv("vam-next-running"); running.createSpan({ text: t("ui.ai_running_ai") });
      if (this.modelSettings.stop) running.createEl("button", { text: t("ui.stop_research") }).addEventListener("click", () => this.modelSettings?.stop?.());
    } else if (this.modelSettings?.quickError) this.contentEl.createEl("p", { cls: "vam-hint", text: this.modelSettings.quickError });
    const research = this.contentEl.createDiv("vam-next-research");
    research.createEl("h3", { text: t("ui.research_this_topic") });
    research.createEl("p", { text: t("ui.start_from_this_node_s_question_update_only_this_node") });
    research.createEl("p", { text: t("ui.research_depth"), cls: "vam-hint" });
    const depthHint = research.createEl("p", { cls: "vam-hint", text: researchDepthDescription(this.depth) });
    const depths = research.createDiv("vam-next-depths");
    const radios: HTMLInputElement[] = [];
    for (const [value, key] of [["fast", "ui.quick"], ["normal", "ui.standard"], ["deep", "ui.deep"]] as const) {
      const option = depths.createEl("label");
      const radio = option.createEl("input", { type: "radio", attr: { name: "vam-next-depth", value } }); radio.checked = this.depth === value; radios.push(radio);
      option.createSpan({ text: t(key) });
    }
    radios.forEach(radio => radio.addEventListener("change", () => { if (radio.checked) depthHint.setText(researchDepthDescription(radio.value as ResearchDepth)); }));
    const researchPicker = this.addReferencePicker(research, "research");
    const footer = research.createDiv("vam-next-footer");
    footer.createSpan({ text: t("ui.full_results_go_to_markdown_your_writing_is_preserved") });
    const confirm = footer.createEl("button", { text: t("ui.confirm_research_task"), cls: "mod-cta" });
    confirm.dataset.topicRun = t("ui.confirm_research_task");
    confirm.disabled = !!this.modelSettings?.running;
    research.createEl("p", { cls: "vam-next-status" });
    confirm.addEventListener("click", () => { void this.run(research, confirm, async () => {
      const selected = await researchPicker?.ready();
      const options: TaskOptions = { referenceGroups: selected?.groups ?? [], researchMode: selected?.webSearch ? "research" : "local", researchDepth: (radios.find(radio => radio.checked)?.value || "normal") as ResearchDepth, visualMode: selected?.imageSearch ? "auto" : "off", requirements: this.requirements(), signal: this.taskSignal, onProgress: message => research.querySelector<HTMLElement>(".vam-next-status")?.setText(message) };
      let started = true;
      const release = (): void => { const cancel = research.querySelector<HTMLButtonElement>(".vam-task-cancel"); if (cancel) cancel.hidden = true; this.taskSignal = undefined; this.taskController = undefined; };
      await this.research(options, "", () => { release(); this.close(); }, message => { release(); if (this.closed) new Notice(message); else { started = false; this.failed(research, confirm, message); } });
      if (this.modelSettings?.path && this.plugin.activeTasks?.has(this.modelSettings.path)) started = false;
      if (started) this.close();
    }); });
    const expandPanel = this.contentEl.createDiv("vam-next-research vam-next-choice");
    expandPanel.createEl("h3", { text: t("ui.expand_this_topic") });
    expandPanel.createEl("p", { text: t("ui.review_one_level_or_set_the_first_level_count_and_the_number") });
    const modes = expandPanel.createDiv("vam-next-depths");
    const guided = modes.createEl("button", { text: t("ui.choose_directions_together"), cls: "is-active" });
    const quick = modes.createEl("button", { text: t("ui.quickly_explore_a_map") });
    let multiLayer = false;
    const setExpandMode = (value: boolean): void => { multiLayer = value; guided.classList.toggle("is-active", !value); quick.classList.toggle("is-active", value); modeHint.setText(value ? t("ui.ai_creates_a_starter_map_at_the_chosen_size_shallow_research") : this.pendingCount ? t("ui.you_have_pending_proposals_review_them_here") : t("ui.ai_suggests_one_level_of_subtopics_review_or_edit_them_befor")); quickLimits.classList.toggle("is-hidden", !value); expandFooterText.setText(shallow.checked ? t("ui.research_each_subtopic_after_creation_and_use_codex_quota") : t("ui.create_subtopics_without_research")); expandButton.setText(value ? t("ui.create_starter_map_now") : this.pendingCount ? t("ui.review_ai_subtopic_suggestions") : t("ui.get_expansion_directions")); expandButton.dataset.topicRun = expandButton.textContent ?? ""; expandButton.disabled = !!this.modelSettings?.running || (value && !!quickError); };
    guided.addEventListener("click", () => setExpandMode(false)); quick.addEventListener("click", () => setExpandMode(true));
    const modeHint = expandPanel.createEl("p", { text: this.pendingCount ? t("ui.you_have_pending_proposals_review_them_here") : t("ui.ai_suggests_one_level_of_subtopics_review_or_edit_them_befor") });
    const quickLimits = expandPanel.createDiv("vam-quick-limits is-hidden");
    const layersLabel = quickLimits.createEl("label", { cls: "vam-field" }); layersLabel.createSpan({ text: t("ui.number_of_levels") });
    const layersInput = layersLabel.createEl("input", { type: "number", attr: { min: "1", max: "15", step: "1", value: "2" } }); layersInput.value = "2";
    quickLimits.createEl("p", { text: t("ui.expansion_levels_exclude_current_topic"), cls: "vam-hint" });
    const firstLabel = quickLimits.createEl("label", { cls: "vam-field" }); firstLabel.createSpan({ text: t("ui.first_level_subtopics") });
    const firstInput = firstLabel.createEl("input", { type: "number", attr: { min: "1", max: "15", step: "1", value: "3" } }); firstInput.value = "3";
    const childrenLabel = quickLimits.createEl("label", { cls: "vam-field" }); childrenLabel.createSpan({ text: t("ui.children_per_parent_topic") });
    const childrenInput = childrenLabel.createEl("input", { type: "number", attr: { min: "0", max: "15", step: "1", value: "2" } }); childrenInput.value = "2";
    const childrenHint = quickLimits.createEl("p", { text: t("ui.children_count_unused_for_one_level"), cls: "vam-hint" }); childrenHint.hidden = true;
    const totalHint = quickLimits.createEl("p", { cls: "vam-hint" }); totalHint.setAttr("aria-live", "polite");
    let quickError = "";
    const updateTotal = (): void => {
      try {
        const layers = Number(layersInput.value), firstLayerCount = Number(firstInput.value), childrenPerParent = Number(childrenInput.value);
        childrenInput.disabled = layers === 1;
        childrenHint.hidden = !childrenInput.disabled;
        const shape = quickShape(layers, firstLayerCount, childrenPerParent);
        quickError = shape.total > BigInt(15) ? t("ui.this_would_create_0_subtopics_exceeding_the_limit_of_15_redu", shape.total.toString()) : "";
        totalHint.setText(quickError || (childrenPerParent === 0 && layers > 1
          ? t("ui.zero_children_stops_after_first_level_0_1", shape.counts.map(String).join(" → "), shape.total.toString())
          : t("ui.topics_by_level_0_1_total", shape.counts.map(String).join(" → "), shape.total.toString())));
      } catch (error) { quickError = error instanceof Error ? error.message : String(error); totalHint.setText(quickError); }
      totalHint.classList.toggle("is-error", !!quickError);
    };
    layersInput.addEventListener("input", () => { updateTotal(); expandButton.disabled = !!this.modelSettings?.running || (multiLayer && !!quickError); });
    firstInput.addEventListener("input", () => { updateTotal(); expandButton.disabled = !!this.modelSettings?.running || (multiLayer && !!quickError); });
    childrenInput.addEventListener("input", () => { updateTotal(); expandButton.disabled = !!this.modelSettings?.running || (multiLayer && !!quickError); });
    updateTotal();
    const expandPicker = this.addReferencePicker(expandPanel, "expand");
    const shallowLabel = expandPanel.createEl("label", { cls: "vam-field vam-next-toggle" }); const shallow = shallowLabel.createEl("input", { type: "checkbox" }); shallow.checked = false; shallowLabel.createSpan({ text: t("ui.run_shallow_research_on_each_created_subtopic") });
    expandPanel.createEl("p", { cls: "vam-hint", text: t("ui.shallow_research_for_expanded_subtopics_0", researchDepthDescription("fast")) });
    const expandFooter = expandPanel.createDiv("vam-next-footer"); const expandFooterText = expandFooter.createSpan({ text: t("ui.create_subtopics_after_confirmation_without_running_research") });
    const expandButton = expandFooter.createEl("button", { text: this.pendingCount ? t("ui.review_ai_subtopic_suggestions") : t("ui.get_expansion_directions"), cls: "mod-cta" });
    expandButton.dataset.topicRun = expandButton.textContent ?? "";
    expandButton.disabled = !!this.modelSettings?.running;
    expandPanel.createEl("p", { cls: "vam-next-status" }); expandPanel.createDiv("vam-next-result");
    const consumed = (): void => { this.pendingCount = 0; setExpandMode(multiLayer); };
    shallow.addEventListener("change", () => { setExpandMode(multiLayer); });
    expandButton.addEventListener("click", () => { void this.run(expandPanel, expandButton, async () => {
      const selected = await expandPicker?.ready();
      const options: TaskOptions = { referenceGroups: selected?.groups ?? [], requirements: this.requirements(), researchMode: selected?.webSearch ? "research" : "local", multiLayer, shallowResearch: shallow.checked, researchDepth: "fast", visualMode: shallow.checked && selected?.imageSearch ? "auto" : "off", signal: this.taskSignal, onProgress: message => expandPanel.querySelector<HTMLElement>(".vam-next-status")?.setText(message) };
      if (multiLayer) {
        const layers = Number(layersInput.value), firstLayerCount = Number(firstInput.value), childrenPerParent = Number(childrenInput.value);
        const shape = quickShape(layers, firstLayerCount, childrenPerParent);
        if (shape.total > BigInt(15)) throw new Error(t("ui.this_would_create_0_subtopics_exceeding_the_limit_of_15_redu", shape.total.toString()));
        options.layers = layers; options.firstLayerCount = firstLayerCount; options.childrenPerParent = childrenPerParent;
        await this.expand(options, "", () => {}, message => new Notice(message), () => {});
        this.close();
        return;
      }
      if (!this.pendingCount) {
        await this.expand(options, "", () => {}, message => new Notice(message), () => {});
        this.close();
        return;
      }
      await this.expand(options, "", (items, create) => this.proposals(expandPanel, items, create, expandButton, consumed, options), (message, retryable) => { consumed(); this.failed(expandPanel, expandButton, message); if (retryable === false) expandButton.disabled = true; }, () => this.close());
    }, multiLayer || !this.pendingCount); });
    const synthesizePanel = this.contentEl.createDiv("vam-next-research vam-next-choice");
    synthesizePanel.createEl("h3", { text: t("ui.synthesize_subtopic_findings") });
    synthesizePanel.createEl("p", { text: this.childrenCount ? t("ui.ai_suggests_synthesis_angles_first_the_parent_topic_changes") : t("ui.this_topic_has_no_direct_subtopics_you_can_choose_other_note") });
    {
      const synthesisPicker = this.addReferencePicker(synthesizePanel, "synthesize");
      const synthFooter = synthesizePanel.createDiv("vam-next-footer");
      const synthButton = synthFooter.createEl("button", { text: t("ui.get_synthesis_suggestions_first"), cls: "mod-cta" });
      synthButton.dataset.topicRun = t("ui.get_synthesis_suggestions_first");
      synthButton.disabled = !!this.modelSettings?.running;
      const synthStatus = synthesizePanel.createEl("p", { cls: "vam-next-status" });
      const synthResult = synthesizePanel.createDiv("vam-next-result");
      const showDraft = (draft: AiResult, save: (summary: string, detail: string) => Promise<void>): void => {
        if (this.closed) return;
        synthStatus.setText(t("ui.review_the_synthesis_draft")); synthResult.empty();
        const summary = synthResult.createEl("textarea", { cls: "vam-task-input", text: draft.summary }); summary.rows = 4; summary.setAttr("aria-label", t("ui.current_understanding"));
        const detail = synthResult.createEl("textarea", { cls: "vam-task-input", text: draft.detail }); detail.rows = 16; detail.setAttr("aria-label", t("ui.markdown_detail_draft"));
        const saveButton = synthResult.createEl("button", { text: t("ui.confirm_update_to_parent_topic"), cls: "mod-cta" });
        saveButton.addEventListener("click", () => { void (async () => { saveButton.disabled = true; try { await save(summary.value, detail.value); synthStatus.setText(t("ui.subtopic_synthesis_was_saved_to_current_understanding_and_ma")); synthResult.empty(); } catch (error) { saveButton.disabled = false; this.failed(synthesizePanel, synthButton, error instanceof Error ? error.message : String(error)); } })(); });
        synthButton.disabled = false;
      };
      synthButton.addEventListener("click", () => { void this.run(synthesizePanel, synthButton, async () => {
        const selected = await synthesisPicker?.ready();
        const options: TaskOptions = { referenceGroups: selected?.groups ?? [], requirements: this.requirements(), researchMode: selected?.webSearch ? "research" : "local", researchDepth: this.depth, visualMode: selected?.imageSearch ? "auto" : "off", signal: this.taskSignal, onProgress: message => synthStatus.setText(message) };
        if (!this.childrenCount && !options.referenceGroups?.some(group => group.documents.length)) throw new Error(t("ui.choose_another_note_source_first"));
        await this.synthesize(options, (items, draft) => {
        if (this.closed) return;
        synthStatus.setText(t("ui.choose_or_edit_a_synthesis_direction_then_get_a_draft")); synthResult.empty();
        for (const item of items) {
          const choice = synthResult.createDiv("vam-next-angle");
          choice.createEl("strong", { text: item.title }); choice.createEl("p", { text: item.contribution || item.task });
          choice.createEl("button", { text: t("ui.choose_this_direction") }).addEventListener("click", () => { direction.value = item.task || item.title; });
        }
        const direction = synthResult.createEl("textarea", { cls: "vam-next-focus", text: items[0]?.task || items[0]?.title || "" });
        direction.setAttr("aria-label", t("ui.synthesis_direction"));
        const draftButton = synthResult.createEl("button", { text: t("ui.get_synthesis_draft"), cls: "mod-cta" });
        draftButton.addEventListener("click", () => { void this.run(synthesizePanel, draftButton, async () => { options.signal = this.taskSignal; await draft(direction.value.trim()); draftButton.disabled = false; }); });
        synthButton.disabled = false;
      }, showDraft, message => this.failed(synthesizePanel, synthButton, message)); }); });
    }
    show = mode => {
      for (const [name, button, panel] of [["research", researchCard, research], ["expand", expandCard, expandPanel], ["synthesize", synthesizeCard, synthesizePanel]] as const) {
        button.classList.toggle("is-active", name === mode); button.setAttr("aria-pressed", name === mode ? "true" : "false");
        panel.style.display = name === mode ? "" : "none";
      }
    };
    show("research");
    this.renderModelSettings();
    this.contentEl.createEl("p", { text: t("ui.if_an_ai_task_exceeds_3_minutes_vam_attempts_to_interrupt_it"), cls: "vam-hint" });
  }
}
class AiDraftModal extends Modal {
  constructor(app: App, private summary: string, private detail: string, private confirmLabel: string, private confirm: () => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t("ui.review_synthesis_draft"));
    this.contentEl.createEl("strong", { text: t("ui.current_understanding") });
    this.contentEl.createEl("p", { text: this.summary });
    this.contentEl.createEl("strong", { text: t("ui.markdown_detail_draft") });
    const detail = this.contentEl.createEl("textarea", { cls: "vam-task-input", text: this.detail });
    detail.rows = 18;
    detail.readOnly = true;
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText(t("ui.cancel")).onClick(() => this.close()))
      .addButton(button => button.setButtonText(this.confirmLabel).setCta().onClick(() => { this.close(); this.confirm(); }));
  }
}
class CodexUsageModal extends Modal {
  private settled = false;
  constructor(app: App, private resolve: (confirmed: boolean) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t("ui.codex_allowance_notice"));
    this.contentEl.createEl("p", { text: t("ui.vam_runs_ai_tasks_through_your_signed_in_codex_account_and_u"), cls: "vam-modal-intro" });
    const finish = (confirmed: boolean): void => { this.settled = true; this.close(); this.resolve(confirmed); };
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText(t("ui.cancel")).onClick(() => finish(false)))
      .addButton(button => button.setButtonText(t("ui.understand_and_run")).setCta().onClick(() => finish(true)));
  }
  onClose(): void { if (!this.settled) this.resolve(false); }
}
class CodexSetupModal extends Modal {
  constructor(app: App, private executable: string, private recheck: () => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t("ui.install_and_connect_codex"));
    this.contentEl.createEl("p", { text: t("ui.codex_setup_for_ai_only"), cls: "vam-modal-intro" });
    const steps = this.contentEl.createEl("ol", { cls: "vam-setup-steps" });
    const install = steps.createEl("li");
    install.appendText(t("ui.open_the_official_codex_cli_installation_guide_and_complete"));
    install.createEl("a", { text: t("ui.official_codex_cli_installation_guide"), href: CODEX_INSTALL_URL, attr: { target: "_blank", rel: "noopener noreferrer" } });
    steps.createEl("li", { text: t("ui.run_codex_in_terminal_and_sign_in_with_your_chatgpt_account") });
    steps.createEl("li", { text: t("ui.return_to_vam_and_select_i_ve_finished_check_again") });
    this.contentEl.createEl("p", { text: t("ui.no_api_key_is_required_the_standalone_codex_cli_does_not_req"), cls: "vam-setup-note" });
    this.contentEl.createEl("p", { text: t("ui.path_currently_checked_0", this.executable), cls: "vam-setup-path" });
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText(t("ui.do_this_later")).onClick(() => this.close()))
      .addButton(button => button.setButtonText(t("ui.i_ve_finished_check_again")).setCta().onClick(() => { this.close(); this.recheck(); }));
  }
}
class ChildProposalModal extends Modal {
  constructor(app: App, private suggestions: Suggestion[], private submit: (items: Suggestion[]) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t("ui.ai_subtopic_proposals"));
    this.contentEl.createEl("p", { text: t("ui.select_subtopics_to_create_you_can_edit_their_names_and_task") });
    const rows: { item: Suggestion; check: HTMLInputElement; title: HTMLInputElement; task: HTMLTextAreaElement; contribution: HTMLTextAreaElement }[] = [];
    for (const item of this.suggestions) { const row = this.contentEl.createDiv("vam-proposal"); if (item.parentTitle) row.createEl("p", { text: t("ui.child_of_0", item.parentTitle) }); const check = row.createEl("input", { type: "checkbox" }); check.checked = true; const title = row.createEl("input", { type: "text", value: item.title }); const task = row.createEl("textarea", { text: item.task }); task.rows = 2; const contribution = row.createEl("textarea", { text: item.contribution }); contribution.rows = 2; contribution.placeholder = t("ui.contribution_to_the_parent_topic"); rows.push({ item, check, title, task, contribution }); }
    new Setting(this.contentEl).addButton(b => b.setButtonText(t("ui.cancel")).onClick(() => this.close())).addButton(b => b.setButtonText(t("ui.create_subtopics")).setCta().onClick(() => {
      const selected = rows.filter(row => row.check.checked && row.title.value.trim());
      const renamed = new Map(selected.filter(row => !row.item.parentTitle).map(row => [row.item.title, row.title.value.trim()]));
      const rootNames = selected.filter(row => !row.item.parentTitle).map(row => row.title.value.trim());
      if (new Set(rootNames).size !== rootNames.length) { new Notice(t("ui.first_level_topic_names_must_be_unique")); return; }
      if (selected.some(row => row.item.parentTitle && !renamed.has(row.item.parentTitle))) { new Notice(t("ui.select_the_parent_topic_before_its_child")); return; }
      this.close(); this.submit(selected.map(row => ({ title: row.title.value.trim(), task: row.task.value.trim(), contribution: row.contribution.value.trim(), parentTitle: row.item.parentTitle ? renamed.get(row.item.parentTitle)! : "" })));
    }));
  }
}
class IntegrationModal extends Modal {
  constructor(app: App, private names: string[], _defaultRules: string, private submit: (title: string, goal: string, rules: string) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t("ui.confirm_topic_synthesis"));
    this.contentEl.createEl("p", { text: t("ui.synthesize_0_source_topics_ai_reads_their_full_knowledge_and", this.names.length), cls: "vam-modal-intro" });
    const sources = this.contentEl.createDiv("vam-integration-sources");
    sources.createEl("strong", { text: t("ui.source_topics") });
    for (const name of this.names) sources.createDiv({ text: name });
    const titleLabel = this.contentEl.createEl("label", { cls: "vam-field" }); titleLabel.createSpan({ text: t("ui.new_topic_name") });
    const title = titleLabel.createEl("input", { type: "text", value: t("ui.synthesize_topics") }); title.setAttr("aria-label", t("ui.new_topic_name"));
    const goalLabel = this.contentEl.createEl("label", { cls: "vam-field" }); goalLabel.createSpan({ text: t("ui.synthesis_goal") });
    const goal = goalLabel.createEl("textarea", { text: t("ui.identify_shared_conclusions_key_differences_tradeoffs_and_ne") }); goal.rows = 4; goal.setAttr("aria-label", t("ui.synthesis_goal"));
    const save = (): void => { if (!title.value.trim() || !goal.value.trim()) return; this.close(); this.submit(title.value.trim(), goal.value.trim(), ""); };
    new Setting(this.contentEl).addButton(button => button.setButtonText(t("ui.cancel")).onClick(() => this.close())).addButton(button => button.setButtonText(t("ui.next_set_ai_sources")).setCta().onClick(save));
    title.focus(); title.select();
  }
}
class MapConflictModal extends Modal {
  private settled = false;
  constructor(app: App, private local: MapDocument, private disk: MapDocument, private resolve: (map: MapDocument) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t("ui.mind_map_changed_externally"));
    this.contentEl.createEl("p", { text: t("ui.both_the_map_and_map_md_have_changed_choose_a_version_or_edi") });
    const input = this.contentEl.createEl("textarea", { cls: "vam-task-input", text: JSON.stringify(this.disk, null, 2) }); input.rows = 16;
    const finish = (map: MapDocument): void => { this.settled = true; this.close(); this.resolve(map); };
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText(t("ui.use_file_contents")).onClick(() => finish(clone(this.disk))))
      .addButton(button => button.setButtonText(t("ui.keep_editor_contents")).onClick(() => finish(clone(this.local))))
      .addButton(button => button.setButtonText(t("ui.save_merged_contents")).setCta().onClick(() => {
        try { finish(parseMap(serializeMap(JSON.parse(input.value) as MapDocument))); }
        catch (error) { new Notice(error instanceof Error ? t("ui.invalid_merged_contents_0", error.message) : t("ui.invalid_merged_contents")); }
      }));
  }
  onClose(): void { if (!this.settled) this.resolve(clone(this.disk)); }
}
class NoteCollectionModal extends Modal {
  constructor(app: App, private titleText: string, private files: TFile[], private actions: { label: string; run: (file: TFile) => void }[]) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    if (!this.files.length) this.contentEl.createEl("p", { text: t("ui.no_notes_yet") });
    for (const file of this.files) {
      const row = this.contentEl.createDiv("vam-collection-row"); row.createSpan({ text: file.basename });
      const actions = row.createDiv("vam-collection-actions");
      for (const action of this.actions) actions.createEl("button", { text: action.label }).addEventListener("click", () => { this.close(); action.run(file); });
    }
    new Setting(this.contentEl).addButton(button => button.setButtonText(t("ui.close")).onClick(() => this.close()));
  }
}
class TopicPickerModal extends Modal {
  constructor(app: App, private titleText: string, private topics: TopicInfo[], private choose: (topic: TopicInfo) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    for (const topic of this.topics) new Setting(this.contentEl).setName(topic.title).setDesc(topic.root).addButton(button => button.setButtonText(t("ui.select")).onClick(() => { this.close(); this.choose(topic); }));
    if (!this.topics.length) this.contentEl.createEl("p", { text: t("ui.no_other_topics") });
    new Setting(this.contentEl).addButton(button => button.setButtonText(t("ui.cancel")).onClick(() => this.close()));
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
  syncOutline(): void { this.plugin.syncOutline(this.builtIn ? null : this.map, this.notes); }
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
    if (this.builtIn || this.path !== path) this.plugin.closeStaleDetails();
    this.builtIn = false; this.path = path; this.map = map; this.integrationMode = false; this.selected = null; this.multiSelected.clear(); this.history.clear(); await this.hydrate(); this.render();
    this.app.workspace.requestSaveLayout();
  }
  async openBuiltInSample(forceTour = false): Promise<void> {
    if (this.viewportTimer !== null) { window.clearTimeout(this.viewportTimer); this.viewportTimer = null; await this.persist(); }
    const sample = builtInSample(this.plugin.settings.language);
    if (!this.builtIn) this.plugin.closeStaleDetails();
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
  private button(parent: HTMLElement, text: string, action: () => void, disabled = false): HTMLButtonElement { const button = parent.createEl("button", { text }); button.disabled = disabled; button.addEventListener("click", event => { event.stopPropagation(); action(); }); return button; }
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
    const previous = clone(this.map!), transitioned: FileMove[] = [];
    try {
      for (const move of moves) {
        const from = parked ? move.activePath : move.parkedPath, to = parked ? move.parkedPath : move.activePath;
        await this.plugin.repo.moveExact(from, to); transitioned.push(move);
        await this.plugin.repo.setLifecycle(to, move.topicId, parked ? "" : snapshot.id, parked ? move.parkedState : "active");
      }
      await this.plugin.repo.saveMap(this.path, clone(snapshot)); this.map = clone(snapshot);
      await this.plugin.rebuildDerivedData(); await this.hydrate(); this.render();
    } catch (error) {
      try {
        for (const move of transitioned.reverse()) {
          const from = parked ? move.activePath : move.parkedPath, to = parked ? move.parkedPath : move.activePath;
          if (this.app.vault.getAbstractFileByPath(to)) await this.plugin.repo.moveExact(to, from);
          await this.plugin.repo.setLifecycle(from, move.topicId, parked ? previous.id : "", parked ? "active" : move.parkedState);
        }
        await this.plugin.repo.saveMap(this.path, previous); this.map = previous;
        await this.plugin.rebuildDerivedData(); await this.hydrate(); this.render();
      } catch (rollbackError) { throw new AggregateError([error, rollbackError], "議題狀態轉換失敗，且無法完整復原"); }
      throw error;
    }
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
  private selectedRoots(): MapNode[] {
    if (!this.map) return [];
    return this.map.nodes.filter(node => this.multiSelected.has(node.id) && !this.map!.nodes.some(parent => this.multiSelected.has(parent.id) && descendants(this.map!.nodes, parent.id).has(node.id)));
  }
  private confirmRemoveSelected(): void {
    new ChoiceModal(this.app, t("ui.remove_selected_topics"), t("ui.selected_branches_leave_the_map_their_notes_move_to_unassign"), [
      { label: t("ui.confirm_removal"), action: () => this.enqueue(() => this.removeSelected()) }
    ]).open();
  }
  private async removeSelected(): Promise<void> {
    if (!this.map) return;
    const before = clone(this.map), ids = new Set<string>();
    for (const root of this.selectedRoots()) { ids.add(root.id); for (const id of descendants(before.nodes, root.id)) ids.add(id); }
    const removed = before.nodes.filter(node => ids.has(node.id)), moves: FileMove[] = [];
    try {
      for (const node of removed) {
        const target = await this.plugin.repo.moveUnique(node.path, this.plugin.repo.topicFolder(this.path, "Unassigned"));
        moves.push({ activePath: node.path, parkedPath: target, topicId: before.id, parkedState: "unassigned" });
        await this.plugin.repo.setLifecycle(target, before.id, "", "unassigned");
      }
      const after = clone(before); after.nodes = after.nodes.filter(node => !ids.has(node.id));
      await this.plugin.repo.saveMap(this.path, after); this.map = after; this.selected = null; this.multiSelected.clear();
      await this.plugin.rebuildDerivedData(); await this.hydrate();
      this.history.push({ undo: () => this.restoreLifecycle(before, moves, false), redo: () => this.restoreLifecycle(after, moves, true) }); this.render();
    } catch (error) {
      try {
        for (const move of [...moves].reverse()) {
          if (this.app.vault.getAbstractFileByPath(move.parkedPath) && !this.app.vault.getAbstractFileByPath(move.activePath)) await this.plugin.repo.moveExact(move.parkedPath, move.activePath);
          if (this.app.vault.getAbstractFileByPath(move.activePath)) await this.plugin.repo.setLifecycle(move.activePath, move.topicId, before.id, "active");
        }
        await this.plugin.repo.saveMap(this.path, before); this.map = before;
        await this.plugin.rebuildDerivedData(); await this.hydrate(); this.render();
      } catch (rollbackError) { throw new AggregateError([error, rollbackError], "批次移除失敗，且無法完整復原"); }
      throw error;
    }
  }
  private chooseSelectedParent(copyNodes: boolean): void {
    if (!this.map) return;
    const roots = this.selectedRoots();
    const targets = this.map.nodes.filter(target => copyNodes || roots.every(root => canParent(this.map!.nodes, root.id, target.id)));
    new ChoiceModal(this.app, copyNodes ? t("ui.copy_to") : t("ui.move_to"), t("ui.choose_a_new_parent_topic"), targets.map(target => ({
      label: this.notes.get(target.id)?.title ?? target.path,
      action: () => this.enqueue(() => copyNodes ? this.copySelected(target) : this.moveSelected(target))
    }))).open();
  }
  private async moveSelected(target: MapNode): Promise<void> {
    const roots = this.selectedRoots();
    await this.mapChange(map => {
      let offset = 0;
      for (const root of roots) {
        if (!canParent(map.nodes, root.id, target.id)) throw new Error(t("ui.circular_links_are_not_allowed"));
        const node = map.nodes.find(item => item.id === root.id)!;
        node.parentId = target.id; node.x = target.x + 340; node.y = target.y + offset++ * 220;
      }
      map.nodes.find(node => node.id === target.id)!.collapsed = false;
    });
    this.multiSelected.clear(); this.render();
  }
  private async copySelected(target: MapNode): Promise<void> {
    if (!this.map) return;
    const roots = this.selectedRoots(), before = clone(this.map), copies: MapNode[] = [], replacement = new Map<string, string>();
    try {
      for (const root of roots) {
        const branch: MapNode[] = [];
        const append = (node: MapNode): void => { branch.push(node); for (const child of before.nodes.filter(item => item.parentId === node.id)) append(child); };
        append(root);
        for (const original of branch) {
          const copy = await this.plugin.repo.duplicateNote(original.path, before, this.path);
          replacement.set(original.id, copy.id);
          copy.parentId = original.id === root.id ? target.id : replacement.get(original.parentId!) ?? target.id;
          copy.x = target.x + 340 + (original.x - root.x);
          copy.y = target.y + roots.indexOf(root) * 220 + (original.y - root.y);
          copies.push(copy);
        }
      }
      const after = clone(before); after.nodes.push(...copies); after.nodes.find(node => node.id === target.id)!.collapsed = false;
      await this.plugin.repo.saveMap(this.path, after); this.map = after;
      await this.plugin.rebuildDerivedData(); await this.hydrate();
      const moves: FileMove[] = [];
      this.history.push({
        undo: async () => {
          moves.length = 0;
          try {
            for (const copy of copies) {
              const parkedPath = await this.plugin.repo.moveUnique(copy.path, this.plugin.repo.topicFolder(this.path, "Unassigned"));
              moves.push({ activePath: copy.path, parkedPath, topicId: before.id, parkedState: "unassigned" });
              await this.plugin.repo.setLifecycle(parkedPath, before.id, "", "unassigned");
            }
            await this.plugin.repo.saveMap(this.path, before); this.map = clone(before);
            await this.plugin.rebuildDerivedData(); await this.hydrate(); this.render();
          } catch (error) {
            try {
              for (const move of [...moves].reverse()) {
                if (this.app.vault.getAbstractFileByPath(move.parkedPath)) await this.plugin.repo.moveExact(move.parkedPath, move.activePath);
                await this.plugin.repo.setLifecycle(move.activePath, before.id, before.id, "active");
              }
              await this.plugin.repo.saveMap(this.path, after); this.map = clone(after);
              await this.plugin.rebuildDerivedData(); await this.hydrate(); this.render();
            } catch (rollbackError) { throw new AggregateError([error, rollbackError], "復原複製失敗，且無法完整回復"); }
            throw error;
          }
        },
        redo: () => this.restoreLifecycle(after, moves, false)
      });
      this.multiSelected.clear(); this.render();
    } catch (error) {
      try {
        await this.plugin.repo.saveMap(this.path, before); this.map = before;
        for (const copy of copies) {
          if (!this.app.vault.getAbstractFileByPath(copy.path)) continue;
          const parkedPath = await this.plugin.repo.moveUnique(copy.path, this.plugin.repo.topicFolder(this.path, "Unassigned"));
          await this.plugin.repo.setLifecycle(parkedPath, before.id, "", "unassigned");
        }
        await this.plugin.rebuildDerivedData(); await this.hydrate(); this.render();
      } catch (rollbackError) { throw new AggregateError([error, rollbackError], "批次複製失敗，且無法完整復原"); }
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
    const after = clone(before), replacement = after.nodes.find(item => item.id === node.id); if (!replacement) throw new Error(t("ui.the_node_to_relink_was_not_found")); replacement.path = target;
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
    if (patch.referencePaths !== undefined) { this.plugin.pendingSuggestions.delete(node.path); this.plugin.pendingResearchOptions.delete(node.path); if (this.plugin.pendingSuggestions instanceof PendingSuggestions) await this.plugin.pendingSuggestions.flush(); }
    if (["title", "summary", "prompt", "rules", "detail", "model", "reasoning", "researchMode", "sourcePaths", "referencePaths"].some(key => key in patch)) this.plugin.activeTasks?.get(node.path)?.abort();
    this.history.push({ undo: () => this.plugin.repo.updateNote(node.path, before), redo: () => this.plugin.repo.updateNote(node.path, patch) });
    this.notes.set(node.id, await this.plugin.repo.readNote(node.path));
    this.refreshCard(node);
    this.updateHistoryButtons();
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
      choices.push({ label: t("ui.rename_current_mind_map"), description: t("ui.update_the_topic_folder_and_mind_map_name_together"), action: () => this.renameCurrentMap() });
      if (!this.path.startsWith(`${this.plugin.settings.topicsFolder}/`)) choices.push({ label: t("ui.migrate_old_data"), description: t("ui.preview_and_migrate_old_maps_into_the_current_topic_structur"), action: () => this.enqueue(() => this.previewMigration()) });
    }
    choices.push({ label: t("ui.repair_missing_mind_map"), description: t("ui.rebuild_a_missing_map_from_existing_topic_notes"), action: () => this.enqueue(() => this.repairMissingTopic()) });
    if (this.map) choices.push({ label: t("ui.delete_current_mind_map"), description: t("ui.remove_only_the_map_file_keep_all_topic_notes_undo_is_availa"), buttonLabel: t("ui.review"), action: () => this.deleteCurrentMap() });
    new ChoiceModal(this.app, t("ui.more_mind_map_actions"), t("ui.additional_map_management_actions"), choices).open();
  }
  private renameCurrentMap(): void {
    if (!this.map) return;
    new NameModal(this.app, t("ui.rename_mind_map"), this.map.title, title => this.enqueue(async () => {
      if (!this.map) return;
      if (!this.path.startsWith(`${this.plugin.settings.topicsFolder}/`)) { new Notice(t("ui.migrate_old_data_before_renaming_this_topic")); return; }
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
    new ChoiceModal(this.app, t("ui.delete_mind_map"), t("ui.move_only_the_map_file_to_the_vault_trash_keep_all_notes_you"), [
      { label: t("ui.delete_0", this.map.title), description: t("ui.topic_notes_will_be_kept"), buttonLabel: t("ui.move_to_trash"), action: () => this.enqueue(async () => {
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
    new ChoiceModal(this.app, t("ui.organize_notes"), t("ui.manage_notes_that_are_currently_outside_the_mind_map"), [
      { label: t("ui.unassigned_0", unassigned.length), description: t("ui.add_to_the_current_map_archive_or_move_to_another_topic"), action: () => this.openUnassigned(unassigned) },
      { label: t("ui.archived_0", archived.length), description: t("ui.view_archived_notes_or_move_them_back_to_unassigned"), action: () => this.openArchive(archived) },
      { label: t("ui.inbox_0", inbox.length), description: t("ui.move_notes_without_a_topic_to_a_suitable_location"), action: () => this.openInbox(inbox) }
    ]).open();
  }
  private openUnassigned(files: TFile[]): void {
    new NoteCollectionModal(this.app, t("ui.unassigned_notes"), files, [
      { label: t("ui.add_to_mind_map"), run: file => this.enqueue(() => this.claimToCurrent(file)) },
      { label: t("ui.archive"), run: file => this.enqueue(() => this.parkFile(file, "Archive", "archived")) },
      { label: t("ui.move_to_another_topic"), run: file => this.enqueue(async () => { const topics = (await this.plugin.repo.topics()).filter(topic => topic.id !== this.map?.id); new TopicPickerModal(this.app, t("ui.move_to_another_topic"), topics, topic => this.enqueue(() => this.transferToTopic(file, topic))).open(); }) },
      { label: t("ui.move_and_add_to_another_topic"), run: file => this.enqueue(async () => { const topics = (await this.plugin.repo.topics()).filter(topic => topic.id !== this.map?.id); new TopicPickerModal(this.app, t("ui.move_and_add_to_another_mind_map"), topics, topic => this.enqueue(() => this.transferAndAdd(file, topic))).open(); }) }
    ]).open();
  }
  private openArchive(files: TFile[]): void {
    new NoteCollectionModal(this.app, t("ui.archived_notes"), files, [{ label: t("ui.unarchive"), run: file => this.enqueue(() => this.parkFile(file, "Unassigned", "unassigned")) }]).open();
  }
  private openInbox(files: TFile[]): void {
    new NoteCollectionModal(this.app, t("ui.notes_without_a_topic"), files, [
      { label: t("ui.move_to_current_topic"), run: file => this.enqueue(() => this.parkFile(file, "Unassigned", "unassigned")) },
      { label: t("ui.move_and_add_to_current_mind_map"), run: file => this.enqueue(() => this.claimToCurrent(file)) },
      { label: t("ui.choose_another_topic"), run: file => this.enqueue(async () => { const topics = await this.plugin.repo.topics(); new TopicPickerModal(this.app, t("ui.move_to_topic"), topics, topic => this.enqueue(() => this.transferToTopic(file, topic))).open(); }) }
    ]).open();
  }
  private render(): void {
    if (this.closed) return;
    this.plugin.syncOutline(this.builtIn ? null : this.map, this.notes);
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
    if (this.builtIn) toolbar.createSpan({ cls: "vam-readonly-badge", text: t("ui.official_sample_read_only") });
    this.button(toolbar, t("ui.switch_mind_map"), () => this.enqueue(async () => { const topics = await this.plugin.repo.topics(); new ChoiceModal(this.app, t("ui.switch_mind_map"), t("ui.choose_a_research_topic_to_open"), [
      { label: t("ui.sample_taiwan_travel_plan"), description: t("ui.official_read_only_sample"), action: () => this.enqueue(() => this.openBuiltInSample()) },
      ...topics.map(topic => ({ label: topic.title, description: t("ui.my_editable_mind_map"), action: () => this.enqueue(() => this.openMap(topic.mapPath)) }))
    ]).open(); }));
    if (this.builtIn) {
      this.button(toolbar, t("ui.show_tour_again"), () => { this.showSampleTour = true; this.render(); });
    } else if (this.map) {
      this.button(toolbar, t("ui.mind_map"), () => new NameModal(this.app, t("ui.new_mind_map"), t("ui.new_mind_map_from_sample"), title => this.enqueue(async () => this.openMap(await this.plugin.repo.createMap(title)))).open());
      const undo = this.button(toolbar, t("ui.undo"), () => this.enqueue(() => this.travel(false)), !this.history.canUndo); undo.dataset.history = "undo";
      const redo = this.button(toolbar, t("ui.redo"), () => this.enqueue(() => this.travel(true)), !this.history.canRedo); redo.dataset.history = "redo";
      this.button(toolbar, t("ui.more"), () => this.openMapActions());
    }
    if (!this.map) {
      const empty = this.contentEl.createDiv("vam-empty-state");
      empty.createEl("h2", { text: this.plugin.repo.workspaceExists() ? t("ui.no_mind_maps_yet") : t("ui.agent_workspace_is_missing") });
      empty.createEl("p", { text: this.plugin.repo.workspaceExists() ? t("ui.create_your_first_mind_map_to_start_organizing_topics") : t("ui.the_base_folders_can_be_safely_recreated_existing_notes_will") });
      const actions = empty.createDiv("vam-empty-actions");
      if (!this.plugin.repo.workspaceExists()) {
        this.button(actions, t("ui.reconnect_existing_workspace"), () => this.enqueue(() => this.plugin.offerWorkspaceReconnect())).addClass("mod-cta");
        this.button(actions, t("ui.repair_agent_workspace"), () => this.enqueue(() => this.plugin.repairWorkspace()));
      }
      this.button(actions, t("ui.create_a_new_mind_map"), () => new NameModal(this.app, t("ui.new_mind_map"), t("ui.new_mind_map_from_sample"), title => this.enqueue(async () => this.openMap(await this.plugin.repo.createMap(title)))).open()).addClass("mod-cta");
      this.button(actions, t("ui.view_sample"), () => this.enqueue(() => this.openBuiltInSample(true)));
      return;
    }
    if (this.builtIn && this.showSampleTour) {
      const tour = this.contentEl.createDiv("vam-sample-tour");
      const steps = [
        { id: "explore", title: t("ui.1_5_start_with_the_question"), body: t("ui.break_a_fuzzy_goal_into_topics_that_can_be_explored_independ") },
        { id: "constraints", title: t("ui.2_5_expand_layered_subtopics"), body: t("ui.subtopics_can_branch_again_after_duplicating_you_can_collaps") },
        { id: "food", title: t("ui.3_5_present_key_ideas_in_preview"), body: t("ui.you_control_preview_content_it_can_contain_text_images_and_t") },
        { id: "journey", title: t("ui.4_5_synthesize_sources_into_a_new_root"), body: t("ui.the_complete_journey_cites_the_sources_it_actually_uses_so_i") },
        { id: "next", title: t("ui.5_5_duplicate_your_own_version"), body: t("ui.the_sample_runs_no_ai_and_writes_nothing_to_the_vault_duplic") }
      ];
      const step = steps[this.sampleTourStep];
      const copy = tour.createDiv(); copy.createEl("strong", { text: step.title }); copy.createEl("p", { text: step.body });
      const actions = tour.createDiv("vam-sample-tour-actions");
      if (this.sampleTourStep > 0) this.button(actions, t("ui.back"), () => { this.sampleTourStep--; this.selectSampleNode(steps[this.sampleTourStep].id); });
      if (this.sampleTourStep < steps.length - 1) this.button(actions, t("ui.next"), () => { this.sampleTourStep++; this.selectSampleNode(steps[this.sampleTourStep].id); }).addClass("mod-cta");
      this.button(actions, this.sampleTourStep === steps.length - 1 ? t("ui.finish_tour") : t("ui.skip_tour"), () => { this.showSampleTour = false; this.plugin.settings.sampleTourVersionSeen = SAMPLE_TOUR_VERSION; void this.plugin.saveSettings(); this.render(); });
    }
    if (this.builtIn) {
      const start = this.contentEl.createDiv("vam-sample-start");
      const copy = start.createDiv();
      copy.createEl("strong", { text: t("ui.start_using_vam") });
      copy.createEl("p", { text: t("ui.sample_start_hint") });
      const actions = start.createDiv("vam-sample-start-actions");
      this.button(actions, t("ui.duplicate_to_my_workspace"), () => this.enqueue(async () => this.openMap(await this.plugin.duplicateBuiltInSample()))).addClass("mod-cta");
      this.button(actions, t("ui.create_an_empty_mind_map"), () => new NameModal(this.app, t("ui.new_mind_map"), t("ui.new_mind_map_from_sample"), title => this.enqueue(async () => this.openMap(await this.plugin.repo.createMap(title)))).open());
      if (!this.plugin.settings.models.trim()) this.button(actions, t("ui.check_codex"), () => this.enqueue(() => this.plugin.recheckCodex()));
    }
    const tools = this.contentEl.createDiv("vam-map-tools");
    if (!this.builtIn) {
      this.button(tools, t("ui.topic"), () => this.enqueue(() => this.addNode(null))).addClass("mod-cta");
      this.button(tools, t("ui.organize"), () => this.enqueue(() => this.openOrganizer()));
      this.button(tools, t("ui.auto_layout"), () => this.enqueue(() => this.mapChange(map => { map.nodes = arrangeMap(map.nodes); }, false)));
      const integrate = this.button(tools, this.integrationMode ? t("ui.finish_topic_selection") : t("ui.select_topics"), () => { this.integrationMode = !this.integrationMode; this.multiSelected.clear(); this.selected = null; this.render(); });
      if (this.integrationMode) integrate.addClass("is-active");
    }
    this.button(tools, "−", () => this.zoomBy(1 / 1.2)).setAttr("aria-label", t("ui.zoom_out"));
    this.zoomLabel = tools.createSpan({ text: `${Math.round(this.map.viewport.zoom * 100)}%`, cls: "vam-zoom" });
    this.button(tools, "＋", () => this.zoomBy(1.2)).setAttr("aria-label", t("ui.zoom_in"));
    this.button(tools, t("ui.show_all"), () => this.fit());
    const previewControl = tools.createEl("label", { cls: "vam-preview-size" });
    previewControl.createSpan({ text: t("ui.preview") });
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
    tools.createSpan({ cls: "vam-hint", text: t("ui.drag_empty_space_to_pan_scroll_to_zoom_click_a_node_to_open") });
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
      selection.createSpan({ text: this.multiSelected.size ? t("ui.selected_0_1_2", this.multiSelected.size, names.slice(0, 2).join("、"), names.length > 2 ? "…" : "") : t("ui.prompt_select_topics") });
      this.button(selection, t("ui.clear"), () => { this.multiSelected.clear(); this.render(); }, !this.multiSelected.size);
      this.button(selection, t("ui.remove"), () => this.confirmRemoveSelected(), !this.multiSelected.size);
      this.button(selection, t("ui.move_to"), () => this.chooseSelectedParent(false), !this.multiSelected.size);
      this.button(selection, t("ui.copy_to"), () => this.chooseSelectedParent(true), !this.multiSelected.size);
      this.button(selection, t("ui.synthesize"), () => this.integrateSelected(), this.multiSelected.size < 2).addClass("mod-cta");
    }
    for (const node of shown) this.renderNode(node);
    if (!this.map.nodes.length) this.viewportEl.createDiv({ cls: "vam-empty", text: t("ui.this_mind_map_has_no_topics_click_topic_to_create_the_first") });
    this.setupPan(); this.transform(); this.drawEdges();
    if (this.builtIn && this.selected) { const node = this.map.nodes.find(n => n.id === this.selected); if (node) this.renderInspector(workspace, node); }
  }
  private renderNode(node: MapNode): void {
    if (!this.stageEl) return;
    const note = this.notes.get(node.id), card = this.stageEl.createDiv({ cls: `vam-node${node.id === this.selected || this.multiSelected.has(node.id) ? " is-selected" : ""}` });
    card.dataset.nodeId = node.id; card.style.left = `${node.x}px`; card.style.top = `${node.y}px`; card.tabIndex = 0; card.setAttr("aria-label", note?.title ?? t("ui.note_missing"));
    const header = card.createDiv("vam-node-header");
    if (this.integrationMode) {
      const check = header.createSpan({ cls: `vam-select-check${this.multiSelected.has(node.id) ? " is-checked" : ""}`, text: this.multiSelected.has(node.id) ? "✓" : "" });
      check.setAttr("aria-hidden", "true");
    }
    const active = this.plugin.running?.has(node.path) || this.plugin.quickExpandPending?.has(node.path);
    if (active || !note || note.status !== "completed") header.createSpan({ cls: `vam-status vam-status-${active ? "running" : note?.status ?? "error"}`, text: active ? t("ui.ai_running") : note ? topicStatusLabel(note.status, this.plugin.settings.language) : t("ui.note_missing") });
    const quickError = this.plugin.quickExpandFailures?.get(node.path);
    if (quickError && !active) { const badge = header.createSpan({ cls: "vam-status vam-status-error", text: t("ui.expansion_failed") }); badge.setAttr("title", quickError); }
    const pendingCount = this.plugin.pendingSuggestions.get(node.path)?.length ?? 0;
    if (pendingCount && !this.builtIn && !this.integrationMode) this.button(header, t("ui.view_0_expansion_suggestions", pendingCount), () => this.openNodePanel(node, "proposals")).addClass("vam-badge-new");
    if (!this.builtIn && !this.integrationMode) {
      const ai = this.button(header, "✦", () => this.openNextStep(node)); ai.addClass("vam-node-tool"); ai.setAttr("aria-label", t("ui.how_would_you_like_to_explore_next"));
      const structure = this.button(header, "⚙", () => this.openNodePanel(node, "structure")); structure.addClass("vam-node-tool"); structure.setAttr("aria-label", t("ui.structure_and_links"));
    }
    const details = this.button(header, "↗", () => this.builtIn ? this.selectSampleNode(node.id) : this.openDetails(node)); details.addClass("vam-detail-button"); details.setAttr("aria-label", this.builtIn ? t("ui.view_sample_content") : t("ui.open_details_in_right_sidebar"));
    const count = descendants(this.map!.nodes, node.id).size;
    if (count && !this.builtIn) this.button(header, node.collapsed ? t("ui.expand_0", count) : t("ui.collapse"), () => this.enqueue(() => this.mapChange(map => { const n = map.nodes.find(n => n.id === node.id)!; n.collapsed = !n.collapsed; })));
    if (!this.builtIn && !this.integrationMode) { const add = this.button(card, "+", () => this.enqueue(() => this.addNode(node))); add.addClass("vam-add-child"); add.setAttr("aria-label", t("ui.add_subtopic_manually")); }
    const title = card.createEl("h3", { text: note?.title ?? node.path, cls: "vam-card-title" });
    title.setAttr("title", note?.title ?? node.path);
    card.createEl("p", { cls: "vam-card-summary", text: note?.summary ?? t("ui.the_file_was_moved_or_deleted_you_can_remove_this_node_from") });
    if (!this.builtIn) this.enableDrag(card, node); else card.addClass("is-readonly");
    card.addEventListener("click", event => { if (Date.now() < this.suppressClickUntil) return; if ((event.target as Element).closest("button") || event.metaKey || event.ctrlKey) return; if (this.integrationMode) { if (this.multiSelected.has(node.id)) this.multiSelected.delete(node.id); else this.multiSelected.add(node.id); this.render(); return; } if (this.builtIn) this.selectSampleNode(node.id); else this.openDetails(node); });
    card.addEventListener("keydown", event => { if (event.key === "Enter" && event.target === card) { if (this.integrationMode) { if (this.multiSelected.has(node.id)) this.multiSelected.delete(node.id); else this.multiSelected.add(node.id); this.render(); } else if (this.builtIn) this.selectSampleNode(node.id); else this.openDetails(node); } });
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
    void MarkdownRenderer.render(this.app, note.preview || t("ui.no_preview_content_yet"), content, path, this);
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
    else if (status) { status.className = `vam-status vam-status-${note.status}`; status.setText(topicStatusLabel(note.status, this.plugin.settings.language)); }
    else header?.createSpan({ cls: `vam-status vam-status-${note.status}`, text: topicStatusLabel(note.status, this.plugin.settings.language) });
    this.drawEdges();
  }
  private taskSourceSettings(currentLabel: string, currentTopicId = this.map?.id ?? "", synthesisLabel?: string): TaskSourceSettings {
    return {
      currentTopicId, currentLabel,
      topics: async () => Promise.all((await this.plugin.repo.topics()).map(async topic => {
        const map = await this.plugin.repo.readMap(topic.mapPath);
        return { id: topic.id, title: topic.title, mapPath: topic.mapPath, nodePaths: map.nodes.map(node => node.path) };
      })),
      readTopic: async (topic, signal, progress) => {
        const map = await this.plugin.repo.readMap(topic.mapPath);
        const files = map.nodes.map(node => {
          const file = this.app.vault.getAbstractFileByPath(node.path);
          if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") throw new Error(t("ui.reference_map_note_unavailable", node.path));
          return file;
        });
        const documents: { path: string; content: string }[] = [];
        for (let index = 0; index < files.length; index += 20) {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          progress(t("ui.reference_read_progress", Math.min(index + 20, files.length), files.length));
          documents.push(...await Promise.all(files.slice(index, index + 20).map(file => readMarkdownFile(this.app, file))));
        }
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        return documents;
      },
      synthesisLabel
    };
  }
  private openNextStep(node: MapNode): void {
    this.enqueue(async () => {
      const note = await this.plugin.repo.readNote(node.path);
      const currentLabel = t("ui.reference_current_topic_included", note.title);
      const synthesisLabel = t("ui.reference_synthesis_topics_included", note.title);
      const sources = this.taskSourceSettings(currentLabel, this.map?.id, synthesisLabel);
      new NextStepModal(this.app, note.title, note.researchDepth, this.map?.nodes.filter(item => item.parentId === node.id).length ?? 0, this.plugin.pendingSuggestions.get(node.path)?.length ?? 0, this.plugin,
        async (options, focus, done, failed) => {
          const latest = await this.plugin.repo.readNote(node.path);
          const task = translate(this.plugin.settings.language, "prompt.research_topic", latest.title);
          await this.runAgent(node, done, failed, { task: [task, options.requirements].filter(Boolean).join("\n\n"), referenceGroups: options.referenceGroups, onProgress: options.onProgress, signal: options.signal, rules: "", researchMode: options.researchMode, researchDepth: options.researchDepth, visualMode: options.visualMode });
        },
        (options, direction, found, failed, created) => {
          if (!options.multiLayer) return this.proposeChildren(node, true, options, direction, found, failed, false, created);
          return this.startQuickExpansion(node, options, direction, failed, created);
        },
        (options, found, drafted, failed) => this.proposeIntegrationDirections(node, options, found, drafted, failed),
        { model: note.model, modelSource: note.modelSource, reasoning: note.reasoning ?? this.plugin.settings.cliReasoning, rules: note.rules, path: node.path,
          save: patch => this.plugin.mutate(() => this.noteChange(node, patch)),
          running: this.plugin.running.has(node.path) || this.plugin.quickExpandPending.has(node.path),
          stop: this.plugin.activeTasks.has(node.path) ? () => this.plugin.activeTasks.get(node.path)?.abort() : undefined,
          quickError: this.plugin.quickExpandFailures.get(node.path), sources }
      ).open();
    });
  }
  private openNodePanel(node: MapNode, mode: "structure" | "proposals"): void {
    const render = (content: HTMLElement, close: () => void): void => this.renderInspector(content, node, mode, close);
    new class extends Modal {
      onOpen(): void { this.modalEl.addClass("vam-topic-modal"); render(this.contentEl, () => this.close()); }
    }(this.app).open();
  }
  private renderInspector(parent: HTMLElement, node: MapNode, mode: "structure" | "proposals" = "structure", close?: () => void): void {
    const panel = parent.createDiv(this.builtIn ? "vam-inspector" : "vam-topic-panel"), note = this.notes.get(node.id);
    const heading = panel.createDiv("vam-inspector-heading");
    heading.createEl("strong", { text: this.builtIn ? t("ui.sample_content") : mode === "structure" ? t("ui.structure_and_links") : t("ui.expansion_suggestions") });
    if (this.builtIn) this.button(heading, t("ui.close"), () => { this.selected = null; this.render(); });
    if (note) {
      if (this.builtIn) {
        panel.createEl("h3", { text: note.title }); panel.createEl("p", { text: note.summary, cls: "vam-sample-summary" });
        const detail = panel.createDiv("vam-sample-detail"); void MarkdownRenderer.render(this.app, note.detail, detail, "", this);
        if (note.sourcePaths.length) { const sources = panel.createDiv("vam-reference-sources"); sources.createEl("strong", { text: t("ui.source_topics") }); for (const path of note.sourcePaths) { const source = this.map?.nodes.find(item => item.path === path); if (source) this.button(sources, this.notes.get(source.id)?.title ?? path, () => this.selectSampleNode(source.id)); } }
        return;
      }
      if (mode === "proposals") this.renderPendingProposals(panel, node, note, close);
      if (mode === "structure") {
      const sourcePaths = this.referenceSourcePaths(note, node.path);
      if (sourcePaths.length) {
        const sources = panel.createDiv("vam-reference-sources"); sources.createEl("strong", { text: t("ui.source_topics") });
        for (const path of sourcePaths) {
          const sourceNode = this.map?.nodes.find(item => item.path === path), sourceNote = sourceNode ? this.notes.get(sourceNode.id) : null;
          const file = this.app.vault.getAbstractFileByPath(path);
          this.button(sources, sourceNote?.title ?? (file instanceof TFile ? file.basename : t("ui.0_moved", path.split("/").at(-1)?.replace(/\.md$/, ""))), () => {
            close?.();
            if (sourceNode) { this.selected = sourceNode.id; this.render(); this.focusNode(sourceNode); }
            else if (file instanceof TFile) void this.plugin.openDetails(file);
          }, !(sourceNode || file instanceof TFile));
        }
      }
      }
    } else if (mode === "structure") {
      panel.createEl("p", { text: t("ui.this_node_s_note_is_missing_relink_an_unassigned_note_or_rem") });
      this.button(panel, t("ui.relink_note"), () => this.enqueue(async () => {
        const candidates = [...await this.plugin.repo.collectionFiles(this.path, "Unassigned"), ...await this.plugin.repo.inboxFiles()];
        new NoteCollectionModal(this.app, t("ui.relink_note"), candidates, [{ label: t("ui.use_this_note"), run: file => this.enqueue(() => this.relinkMissingNode(node, file)) }]).open();
      }));
    }
    if (mode !== "structure") return;
    const relationship = panel.createDiv();
    const parentLabel = relationship.createEl("label", { cls: "vam-field" }); parentLabel.createSpan({ text: t("ui.parent_topic") });
    const parents = parentLabel.createEl("select"); parents.setAttr("aria-label", t("ui.parent_topic_link")); parents.createEl("option", { value: "", text: t("ui.no_parent_root_topic") });
    for (const candidate of this.map!.nodes) if (canParent(this.map!.nodes, node.id, candidate.id)) parents.createEl("option", { value: candidate.id, text: this.notes.get(candidate.id)?.title ?? candidate.path });
    parents.value = node.parentId ?? "";
    parents.addEventListener("change", () => { const parentId = parents.value || null; close?.(); this.enqueue(() => this.mapChange(map => { if (!canParent(map.nodes, node.id, parentId)) throw new Error(t("ui.circular_links_are_not_allowed")); map.nodes.find(n => n.id === node.id)!.parentId = parentId; })); });
    this.button(relationship, t("ui.remove_parent_link"), () => { close?.(); this.enqueue(() => this.mapChange(map => { map.nodes.find(n => n.id === node.id)!.parentId = null; })); }, !node.parentId);
    relationship.createEl("p", { cls: "vam-hint", text: t("ui.changing_the_parent_affects_context_for_the_next_ai_task_the") });
    this.button(relationship, t("ui.remove_from_map"), () => { close?.(); new ChoiceModal(this.app, t("ui.remove_from_map"), t("ui.the_note_will_move_to_this_topic_s_unassigned_folder_you_can"), [{ label: t("ui.remove_only_this_node_children_become_roots"), action: () => this.enqueue(() => this.removeToUnassigned(node, false)) }, { label: t("ui.remove_entire_branch"), action: () => this.enqueue(() => this.removeToUnassigned(node, true)) }]).open(); });
  }
  private renderPendingProposals(panel: HTMLElement, node: MapNode, note: Note, close?: () => void): void {
    const suggestions = this.plugin.pendingSuggestions.get(node.path);
    if (!suggestions?.length) return;
    const section = panel.createDiv("vam-inspector-proposals");
    section.createEl("h3", { text: t("ui.0_expansion_suggestions", suggestions.length) });
    section.createEl("p", { text: t("ui.select_and_edit_suggestions_subtopics_are_created_only_after") });
    const rows: { original: Suggestion; check: HTMLInputElement; title: HTMLInputElement; task: HTMLTextAreaElement; contribution: HTMLTextAreaElement }[] = [];
    for (const original of suggestions) {
      const row = section.createDiv("vam-proposal");
      if (original.parentTitle) row.createEl("p", { text: t("ui.child_of_0", original.parentTitle) });
      const checkLabel = row.createEl("label", { cls: "vam-field vam-next-toggle" });
      const check = checkLabel.createEl("input", { type: "checkbox" }); check.checked = true;
      checkLabel.createSpan({ text: t("ui.create_this_subtopic") });
      const title = row.createEl("input", { type: "text", value: original.title }); title.setAttr("aria-label", t("ui.subtopic_name"));
      const task = row.createEl("textarea", { text: original.task }); task.rows = 2; task.setAttr("aria-label", t("ui.research_task"));
      const contribution = row.createEl("textarea", { text: original.contribution }); contribution.rows = 2; contribution.setAttr("aria-label", t("ui.contribution_to_the_parent_topic"));
      rows.push({ original, check, title, task, contribution });
    }
    const researchLabel = section.createEl("label", { cls: "vam-field vam-next-toggle" });
    const shallow = researchLabel.createEl("input", { type: "checkbox" }); shallow.checked = !!this.plugin.pendingResearchOptions.get(node.path)?.shallowResearch; researchLabel.createSpan({ text: t("ui.run_shallow_research_on_each_created_subtopic") });
    const status = section.createEl("p", { cls: "vam-hint" });
    const actions = section.createDiv("vam-actions");
    const create = this.button(actions, t("ui.create_selected_subtopics"), () => { void (async () => {
      const chosen = rows.filter(row => row.check.checked && row.title.value.trim());
      if (!chosen.length) { status.setText(t("ui.select_at_least_one_subtopic")); return; }
      const names = new Map(chosen.map(row => [row.original.title, row.title.value.trim()]));
      if (new Set(names.values()).size !== names.size) { status.setText(t("ui.subtopic_names_must_be_unique")); return; }
      if (chosen.some(row => row.original.parentTitle && !names.has(row.original.parentTitle))) { status.setText(t("ui.select_the_parent_topic_before_its_child")); return; }
      const items = chosen.map(row => ({ title: row.title.value.trim(), task: row.task.value.trim(), contribution: row.contribution.value.trim(), parentTitle: row.original.parentTitle ? names.get(row.original.parentTitle)! : "" }));
      create.disabled = true; status.setText(t("ui.creating_subtopics"));
      try {
        await this.plugin.mutate(async () => {
          const current = this.map?.nodes.find(item => item.id === node.id && item.path === node.path);
          if (!current) throw new Error(t("ui.the_topic_changed_select_it_again"));
          if (this.plugin.pendingSuggestions.get(node.path) !== suggestions) throw new Error(t("ui.expansion_suggestions_changed_open_them_again"));
          try { await this.createChildBatch(current, items, shallow.checked ? { ...(this.plugin.pendingResearchOptions.get(node.path) ?? { researchMode: "research" as const, researchDepth: "fast" as const, referenceGroups: [], visualMode: "off" as const }), shallowResearch: true } : undefined); }
          catch (error) { if (error instanceof PartialChildBatchError) { this.plugin.pendingSuggestions.delete(node.path); this.plugin.pendingResearchOptions.delete(node.path); } throw error; }
          this.plugin.pendingSuggestions.delete(node.path); this.plugin.pendingResearchOptions.delete(node.path);
          await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
        });
        close?.(); this.render();
      } catch (error) { create.disabled = false; status.setText(error instanceof Error ? error.message : String(error)); }
    })(); }); create.addClass("mod-cta");
    this.button(actions, t("ui.discard_these_suggestions"), () => { void (async () => {
      try {
        await this.plugin.mutate(async () => {
          if (this.plugin.pendingSuggestions.get(node.path) !== suggestions) throw new Error(t("ui.expansion_suggestions_changed_open_them_again"));
          this.plugin.pendingSuggestions.delete(node.path); this.plugin.pendingResearchOptions.delete(node.path);
          await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
        });
        close?.(); this.render();
      } catch (error) { status.setText(error instanceof Error ? error.message : String(error)); }
    })(); });
  }
  private async previewMigration(): Promise<void> {
    const plan = await this.plugin.repo.legacyMigrationPlan();
    if (!plan.maps.length && !plan.orphanPaths.length) { new Notice(t("ui.no_old_data_to_migrate")); return; }
    const noteCount = plan.maps.reduce((sum, item) => sum + item.notePaths.length, 0);
    const description = t("ui.create_0_topic_folders_move_1_map_notes_and_move_2_orphan_no", plan.maps.length, noteCount, plan.orphanPaths.length);
    new ChoiceModal(this.app, t("ui.migrate_legacy_data"), description, [{ label: t("ui.confirm_migration"), action: () => this.enqueue(async () => {
      const current = this.path, mapping = await this.plugin.repo.migrateLegacyWorkspace(plan), next = mapping.get(current);
      this.history.clear(); if (next) await this.openMap(next); else this.render(); new Notice(t("ui.old_data_was_migrated_into_topic_folders"));
    }) }]).open();
  }
  private async repairMissingTopic(): Promise<void> {
    const broken = await this.plugin.repo.brokenTopics();
    if (!broken.length) { new Notice(t("ui.no_topics_with_a_missing_map_md")); return; }
    new ChoiceModal(this.app, t("ui.repair_missing_map"), t("ui.choose_a_topic_to_repair"), broken.map(topic => ({ label: t("ui.0_1_notes", topic.title, topic.noteCount), action: () => {
      new ChoiceModal(this.app, topic.title, t("ui.rebuild_a_map_from_notes_as_root_nodes_or_relink_an_existing"), [
        { label: t("ui.rebuild_from_notes"), action: () => this.enqueue(async () => this.openMap(await this.plugin.repo.rebuildMissingMap(topic.root))) },
        { label: t("ui.relink_existing_map"), action: () => this.enqueue(async () => {
          const candidates = (await this.plugin.repo.mapFiles()).filter(file => !file.path.startsWith(`${this.plugin.settings.topicsFolder}/`));
          new ChoiceModal(this.app, t("ui.choose_existing_map"), t("ui.move_the_selected_map_into_this_topic_and_rebuild_node_paths"), candidates.map(file => ({ label: file.path, action: () => this.enqueue(async () => this.openMap(await this.plugin.repo.relinkMissingMap(topic.root, file.path))) }))).open();
        }) }
      ]).open();
    } }))).open();
  }
  private async addNode(parent: MapNode | null, suggestedTitle?: string, rebuildDerivedData = true): Promise<void> {
    if (!this.map) return;
    const model = inheritModel(parent ? (await this.plugin.repo.readNote(parent.path)).model : undefined, this.plugin.settings.cliModel);
    if (!this.path.startsWith(`${this.plugin.settings.topicsFolder}/`)) { new Notice(t("ui.use_migrate_old_data_to_convert_this_map_first")); return; }
    const node = await this.plugin.repo.createNote(suggestedTitle?.trim() || (parent ? t("ui.new_subtopic") : t("ui.my_core_topic")), model, this.map, this.path, parent ? "inherited" : "workspace");
    if (parent) { const parentNote = await this.plugin.repo.readNote(parent.path); await this.plugin.repo.updateNote(node.path, { rules: parentNote.rules, reasoning: parentNote.reasoning }); }
    node.parentId = parent?.id ?? null; node.x = parent ? parent.x + 340 : 80;
    const siblings = this.map.nodes.filter(n => n.parentId === node.parentId);
    node.y = siblings.length ? Math.max(...siblings.map(n => n.y)) + 220 : parent?.y ?? 80;
    this.notes.set(node.id, await this.plugin.repo.readNote(node.path)); this.selected = node.id;
    await this.mapChange(map => { map.nodes.push(node); if (parent) map.nodes.find(n => n.id === parent.id)!.collapsed = false; }, rebuildDerivedData); this.focusNode(node);
  }
  private startQuickExpansion(parent: MapNode, options: TaskOptions, direction: string, failed: (message: string, retryable?: boolean) => void, created: () => void): Promise<void> {
    if (this.plugin.running.has(parent.path) || this.plugin.quickExpandPending.has(parent.path)) { failed(t("ui.ai_running_ai")); return Promise.resolve(); }
    this.plugin.quickExpandFailures.delete(parent.path);
    this.plugin.quickExpandPending.add(parent.path); this.render();
    return this.proposeChildren(parent, true, options, direction, undefined, failed, true, created).catch(error => {
      this.plugin.quickExpandFailures.set(parent.path, error instanceof Error ? error.message : String(error));
      throw error;
    }).finally(() => { this.plugin.quickExpandPending.delete(parent.path); this.render(); });
  }
  private async proposeChildren(parent: MapNode, confirmed = false, options?: TaskOptions, direction = "", found?: (items: Suggestion[], create: (items: Suggestion[]) => Promise<void>) => void, failed?: (message: string, retryable?: boolean) => void, direct = false, created?: () => void): Promise<void> {
    const pending = this.plugin.pendingSuggestions.get(parent.path);
    const present = (items: Suggestion[]): void => {
      const version = this.plugin.pendingSuggestions.get(parent.path);
      const names = items.filter(item => !item.parentTitle).map(item => item.title);
      if (new Set(names).size !== names.length) {
        this.plugin.pendingSuggestions.delete(parent.path); this.plugin.pendingResearchOptions.delete(parent.path);
        const message = t("ui.ai_proposed_duplicate_first_level_names_generate_the_proposa"); if (failed) failed(message); else new Notice(message);
        return;
      }
      if (!found) { this.openChildSuggestions(parent, items); return; }
      found(items, selected => this.plugin.mutate(async () => {
        if (!version || this.plugin.pendingSuggestions.get(parent.path) !== version) throw new Error(t("ui.expansion_suggestions_changed_open_them_again"));
        try { await this.createChildBatch(parent, selected, this.plugin.pendingResearchOptions.get(parent.path)); }
        catch (error) { if (error instanceof PartialChildBatchError) { this.plugin.pendingSuggestions.delete(parent.path); this.plugin.pendingResearchOptions.delete(parent.path); } throw error; }
        this.plugin.pendingSuggestions.delete(parent.path); this.plugin.pendingResearchOptions.delete(parent.path);
        await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
      }));
    };
    if (pending?.length && !direct) {
      if (options) { if (options.shallowResearch ?? options.multiLayer) this.plugin.pendingResearchOptions.set(parent.path, { ...options, referenceGroups: [] }); else this.plugin.pendingResearchOptions.delete(parent.path); }
      present(options && !options.multiLayer ? pending.filter(item => !item.parentTitle) : pending);
      return;
    }
    const note = await this.plugin.repo.readNote(parent.path);
    if (this.plugin.running.has(parent.path)) { failed?.(t("ui.ai_running_ai")); return; }
    if (!confirmed) {
      new TaskModal(this.app, t("ui.suggest_the_most_useful_expansion_direction_or_follow_the_di"), (value, run, chosen) => { if (run) void this.plugin.confirmCodexUsage(async () => this.enqueue(() => this.proposeChildren(parent, true, chosen, value))); }, t("ui.expand_subtopics"), t("ui.specify_an_expansion_direction_or_ask_ai_to_suggest_one_prev"), note.rules, note.researchMode, note.researchDepth, note.visualMode, false, true, this.taskSourceSettings(t("ui.reference_current_topic_included", note.title))).open();
      return;
    }
    const targetMapPath = this.path, targetMapId = this.map?.id;
    const originalChildren = this.map?.nodes.filter(item => item.parentId === parent.id).map(item => item.id).sort().join("|") ?? "";
    this.plugin.running.add(parent.path); this.render();
    let building = false;
    try {
      const outputLanguage = this.plugin.settings.language;
      const existing = this.map?.nodes.filter(item => item.parentId === parent.id).map(item => {
        const child = this.notes.get(item.id);
        return `- ${child?.title || item.path}: ${child?.summary || translate(outputLanguage, "prompt.no_summary_yet")}`;
      }).join("\n") || translate(outputLanguage, "prompt.none");
      const layers = options?.layers ?? 2, firstLayerCount = options?.firstLayerCount ?? 3, childrenPerParent = options?.childrenPerParent ?? 2;
      const shape = direct ? quickShape(layers, firstLayerCount, childrenPerParent) : null;
      const effectiveLayers = shape?.counts.length ?? layers;
      if (shape && shape.total > BigInt(15)) throw new Error(t("ui.this_would_create_0_subtopics_exceeding_the_limit_of_15_redu", shape.total.toString()));
      const directTask = translate(outputLanguage, "prompt.direct_expansion", effectiveLayers, firstLayerCount, childrenPerParent, shape?.counts.join(outputLanguage === "en" ? ", " : "、"), shape?.total.toString());
      const guidedTask = translate(outputLanguage, "prompt.guided_expansion");
      const task = `${direct ? translate(outputLanguage, "prompt.preliminary_map", effectiveLayers, firstLayerCount, childrenPerParent, shape?.counts.join(outputLanguage === "en" ? ", " : "、"), shape?.total.toString()) : direction || translate(outputLanguage, "prompt.expansion_direction")}\n${translate(outputLanguage, "prompt.existing_subtopics")}\n${existing}\n${translate(outputLanguage, "prompt.avoid_duplicates")} ${direct ? directTask : guidedTask}`;
      const result = await this.plugin.askModel({ title: note.title, summary: note.summary, rules: "", detail: note.detail, task: [task, options?.requirements].filter(Boolean).join("\n\n"), ancestors: await this.ancestorContext(parent), referenceGroups: options?.referenceGroups, onProgress: options?.onProgress, mode: "decompose", researchMode: options?.researchMode ?? "research", researchDepth: options?.researchDepth ?? note.researchDepth, visualMode: "off" }, note.model, note.reasoning, options?.signal);
      const suggestions = direct ? quickSuggestions(result.suggestions, effectiveLayers, firstLayerCount, childrenPerParent) : result.suggestions.filter(item => !item.parentTitle).slice(0, 7);
      if (!direct && suggestions.length < 3) { const message = t("ui.ai_does_not_recommend_decomposition_or_did_not_propose_3_to"); if (failed) failed(message); else new Notice(message); return; }
      if (direct) {
        building = true;
        let batchFailure: Error | null = null;
        await this.plugin.mutate(async () => {
          try {
            const currentParent = this.map?.nodes.find(item => item.id === parent.id && item.path === parent.path);
            const currentChildren = this.map?.nodes.filter(item => item.parentId === parent.id).map(item => item.id).sort().join("|") ?? "";
            if (this.path !== targetMapPath || this.map?.id !== targetMapId || !currentParent || currentChildren !== originalChildren) throw new Error(t("ui.the_map_or_parent_topic_changed_while_ai_was_running_no_subt"));
            const currentNote = await this.plugin.repo.readNote(parent.path);
            const version = (value: Note): string => JSON.stringify([value.title, value.summary, value.rules, value.detail, value.prompt, value.model, value.reasoning, value.sourcePaths, value.referencePaths]);
            if (version(currentNote) !== version(note)) throw new Error(t("ui.the_map_or_parent_topic_changed_while_ai_was_running_no_subt"));
            await this.createChildBatch(currentParent, suggestions, options?.shallowResearch ? options : undefined);
          } catch (error) { batchFailure = error instanceof Error ? error : new Error(typeof error === "string" ? error : t("ui.failed_to_create_starter_map")); }
        });
        const batchError = batchFailure as Error | null;
        if (batchError) throw batchError;
        this.plugin.pendingSuggestions.delete(parent.path); this.plugin.pendingResearchOptions.delete(parent.path);
        this.plugin.quickExpandFailures?.delete(parent.path);
        created?.();
      } else {
        this.plugin.pendingSuggestions.set(parent.path, suggestions);
        await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
        if (options?.shallowResearch) this.plugin.pendingResearchOptions.set(parent.path, options);
        else this.plugin.pendingResearchOptions?.delete(parent.path);
        present(suggestions);
      }
    } catch (error) {
      if (building && error instanceof PartialChildBatchError) { this.plugin.pendingSuggestions.delete(parent.path); this.plugin.pendingResearchOptions.delete(parent.path); }
      console.error("Visual Agent Map AI split", error);
      const message = this.plugin.recordFailure(building ? "建立初步地圖失敗" : "AI 拆解失敗", error);
      if (direct) this.plugin.quickExpandFailures?.set(parent.path, message);
      if (failed) failed(message, !(error instanceof PartialChildBatchError)); else new Notice(message);
    }
    finally { this.plugin.running.delete(parent.path); await this.hydrate(); this.render(); }
  }
  private openChildSuggestions(parent: MapNode, suggestions: Suggestion[]): void {
    const version = this.plugin.pendingSuggestions.get(parent.path);
    const roots = suggestions.filter(item => !item.parentTitle).map(item => item.title);
    if (new Set(roots).size !== roots.length) {
      this.plugin.pendingSuggestions.delete(parent.path); this.plugin.pendingResearchOptions.delete(parent.path);
      new Notice(t("ui.ai_proposed_duplicate_first_level_names_generate_the_proposa")); return;
    }
    new ChildProposalModal(this.app, suggestions.slice(0, 15), items => this.enqueue(async () => {
      if (!version || this.plugin.pendingSuggestions.get(parent.path) !== version) throw new Error(t("ui.expansion_suggestions_changed_open_them_again"));
      const researchOptions = this.plugin.pendingResearchOptions.get(parent.path);
      try { await this.createChildBatch(parent, items, researchOptions); }
      catch (error) { if (error instanceof PartialChildBatchError) { this.plugin.pendingSuggestions.delete(parent.path); this.plugin.pendingResearchOptions.delete(parent.path); } throw error; }
      this.plugin.pendingSuggestions.delete(parent.path);
      this.plugin.pendingResearchOptions.delete(parent.path);
      await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
    })).open();
  }
  private async createChildBatch(parent: MapNode, items: Suggestion[], researchOptions?: TaskOptions): Promise<void> {
    if (!items.length) throw new Error(t("ui.select_at_least_one_subtopic"));
    const rootTitles = new Set(items.filter(item => !item.parentTitle).map(item => item.title));
    if (rootTitles.size !== items.filter(item => !item.parentTitle).length) throw new Error(t("ui.first_level_topic_names_must_be_unique"));
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.title)) throw new Error(t("ui.subtopic_names_must_be_unique"));
      if (item.parentTitle && !seen.has(item.parentTitle)) throw new Error(t("ui.select_the_parent_topic_before_its_child"));
      seen.add(item.title);
    }
    let created = 0; const createdByTitle = new Map<string, MapNode>(), newNodes: MapNode[] = [];
    try {
      for (const item of items) {
        const owner = item.parentTitle ? createdByTitle.get(item.parentTitle) : parent;
        if (!owner) throw new Error(t("ui.select_the_parent_topic_before_its_child"));
        await this.addNode(owner, item.title, false); created++;
        const child = this.map!.nodes.at(-1)!;
        newNodes.push(child);
        createdByTitle.set(item.title, child);
        await this.noteChange(child, { prompt: item.task, detail: researchOptions ? "" : item.contribution ? canonicalDetail(item.contribution, this.plugin.settings.language) : "", ...(researchOptions ? { researchMode: "research" as const, researchDepth: "fast" as const, visualMode: researchOptions.visualMode } : {}) });
      }
      if (newNodes.length) await this.mapChange(map => { map.nodes = arrangeNewBranch(map.nodes, parent.id, new Set(newNodes.map(node => node.id))); }, false);
      if (created) await this.plugin.rebuildDerivedData();
      if (researchOptions) for (const child of newNodes) {
        if (researchOptions.signal?.aborted) break;
        try {
          await this.runAgent(child, undefined, undefined, { rules: "", referenceGroups: [], onProgress: researchOptions.onProgress, signal: researchOptions.signal, researchMode: researchOptions.researchMode, researchDepth: researchOptions.researchDepth, visualMode: researchOptions.visualMode, task: [(await this.plugin.repo.readNote(child.path)).prompt, researchOptions.requirements].filter(Boolean).join("\n\n") });
          if (researchOptions.signal?.aborted) break;
          if ((await this.plugin.repo.readNote(child.path)).status === "idea") throw new Error(t("ui.shallow_research_did_not_start"));
        } catch (error) {
          if (researchOptions.signal?.aborted || (error instanceof Error && error.name === "AbortError")) break;
          await this.plugin.repo.updateNote(child.path, { status: "error" });
          this.plugin.recordFailure(t("ui.could_not_start_shallow_research_for_subtopic_0", child.path), error);
        }
      }
    } catch (error) {
      if (created) { await this.plugin.rebuildDerivedData(); throw new PartialChildBatchError(t("ui.some_subtopics_were_created_reopen_this_window_and_check_the") + ` ${error instanceof Error ? error.message : String(error)}`); }
      throw error;
    }
  }
  private async ancestorContext(node: MapNode): Promise<string> {
    const chain: MapNode[] = [], seen = new Set([node.id]); let parent = node.parentId;
    while (parent && !seen.has(parent)) { seen.add(parent); const n = this.map?.nodes.find(item => item.id === parent); if (!n) break; chain.unshift(n); parent = n.parentId; }
    const ancestors: string[] = [];
    const language = this.plugin.settings?.language ?? "zh-TW";
    for (const n of chain) { const info = await this.plugin.repo.readNote(n.path); ancestors.push(`- ${info.title}\n  ${translate(language, "prompt.label_current_summary")}: ${info.summary}`); }
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
  private async proposeIntegrationDirections(node: MapNode, options: TaskOptions, found: (items: Suggestion[], draft: (direction: string) => Promise<void>) => void, drafted: (result: AiResult, save: (summary: string, detail: string) => Promise<void>) => void, failed: (message: string) => void): Promise<void> {
    if (!this.map) { failed(t("ui.no_mind_map_is_available")); return; }
    if (this.plugin.running.has(node.path)) { failed(t("ui.ai_running_ai")); return; }
    const children = this.map.nodes.filter(item => item.parentId === node.id);
    if (!children.length && !options.referenceGroups?.some(group => group.documents.length)) { failed(t("ui.choose_another_note_source_first")); return; }
    const note = await this.plugin.repo.readNote(node.path);
    this.plugin.running.add(node.path); this.render();
    try {
      const childSources = await this.topicReferenceGroup(children, children.length <= 3 ? "strong" : "summary");
      const selectedSources = options.referenceGroups ?? [];
      if (!children.length && !selectedSources.some(group => group.documents.length)) { failed(t("ui.the_selected_sources_contain_no_markdown_content_to_synthesi")); return; }
      const task = translate(this.plugin.settings.language, "prompt.synthesis_directions");
      const result = await this.plugin.askModel({ title: note.title, summary: note.summary, rules: "", detail: note.detail, task: [task, options?.requirements].filter(Boolean).join("\n\n"), ancestors: await this.ancestorContext(node), referenceGroups: [childSources, ...selectedSources], onProgress: options.onProgress, mode: "synthesize", researchMode: options.researchMode, researchDepth: options.researchDepth, visualMode: "off" }, note.model, note.reasoning, options.signal);
      const angles = result.suggestions.slice(0, 2);
      if (!angles.length) { failed(t("ui.ai_did_not_suggest_a_synthesis_direction_please_retry")); return; }
      found(angles, direction => this.plugin.mutate(() => this.integrateChildren(node, true, options, direction, drafted, failed)));
    } catch (error) { console.error("Visual Agent Map integration directions", error); failed(this.plugin.recordFailure("整合方向建議失敗", error)); }
    finally { this.plugin.running.delete(node.path); await this.hydrate(); this.render(); }
  }
  private async integrateChildren(node: MapNode, confirmed = false, options?: TaskOptions, direction = "", drafted?: (result: AiResult, save: (summary: string, detail: string) => Promise<void>) => void, failed?: (message: string) => void): Promise<void> {
    if (!this.map || this.plugin.running.has(node.path)) { failed?.(t("ui.ai_running_ai")); return; }
    const note = await this.plugin.repo.readNote(node.path);
    const children = this.map.nodes.filter(item => item.parentId === node.id);
    if (!children.length && !options?.referenceGroups?.some(group => group.documents.length)) { const message = t("ui.choose_another_note_source_first"); if (failed) failed(message); else new Notice(message); return; }
    if (!confirmed) {
      new TaskModal(this.app, t("ui.synthesize_agreements_differences_tradeoffs_and_open_questio"), (value, run, chosen) => { if (run) void this.plugin.confirmCodexUsage(async () => this.enqueue(() => this.integrateChildren(node, true, chosen, value))); }, t("ui.synthesize_subtopics"), t("ui.ai_reads_direct_subtopics_and_prepares_a_synthesis_draft_not"), note.rules, "local", note.researchDepth, note.visualMode, false, false, this.taskSourceSettings(t("ui.reference_current_topic_included", note.title), this.map?.id, t("ui.reference_synthesis_topics_included", note.title))).open();
      return;
    }
    const childSources = await this.topicReferenceGroup(children, children.length <= 3 ? "strong" : "summary");
    const selectedSources = options?.referenceGroups ?? [];
    if (!children.length && !selectedSources.some(group => group.documents.length)) { const message = t("ui.the_selected_sources_contain_no_markdown_content_to_synthesi"); if (failed) failed(message); else new Notice(message); return; }
    const language = this.plugin.settings.language;
    const task = direction || translate(language, "prompt.synthesis_goal");
    this.plugin.running.add(node.path); await this.plugin.repo.updateNote(node.path, { status: "running" }); await this.hydrate(); this.render();
    try {
      const result = await this.plugin.askModel({ title: note.title, summary: note.summary, rules: "", detail: note.detail, task: [task, options?.requirements].filter(Boolean).join("\n\n"), ancestors: await this.ancestorContext(node), referenceGroups: [childSources, ...selectedSources], onProgress: options?.onProgress, mode: "synthesize", researchMode: options?.researchMode ?? "local", researchDepth: options?.researchDepth ?? note.researchDepth, visualMode: options?.visualMode ?? note.visualMode }, note.model, note.reasoning, options?.signal);
      await this.plugin.repo.updateNote(node.path, { status: note.status });
      const save = async (summary: string, detail: string): Promise<void> => this.plugin.mutate(async () => {
        const latest = await this.plugin.repo.readNote(node.path);
        if (latest.detail !== note.detail || latest.summary !== note.summary) throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
        await this.plugin.repo.updateNote(node.path, { summary, detail: canonicalDetail(detail, this.plugin.settings.language), visualReferences: visualReferencesMarkdown(result.visualReferences, language), newFindings: "", status: "completed" });
        await this.hydrate(); this.render(); new Notice(t("ui.subtopic_synthesis_was_saved_to_current_understanding_and_ma"));
      });
      if (drafted) drafted(result, save);
      else new AiDraftModal(this.app, result.summary, result.detail, t("ui.confirm_update_to_parent_topic"), () => { void save(result.summary, result.detail); }).open();
    } catch (error) {
      if (options?.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        await this.plugin.repo.updateNote(node.path, { status: note.status });
        new Notice(t("ui.research_stopped_existing_content_was_preserved"));
      } else {
        console.error("Visual Agent Map child integration", error);
        await this.plugin.repo.updateNote(node.path, { status: "error" });
        const message = this.plugin.recordFailure("子議題整合失敗", error);
        if (failed) failed(message); else new Notice(message);
      }
    }
    finally { this.plugin.running.delete(node.path); await this.hydrate(); this.render(); }
  }
  private integrateSelected(): void {
    if (!this.map || this.multiSelected.size < 2) { new Notice(t("ui.select_at_least_two_topics")); return; }
    const nodes = [...this.multiSelected].map(id => this.map!.nodes.find(node => node.id === id)).filter((node): node is MapNode => !!node);
    const notes = nodes.map(node => this.notes.get(node.id)).filter((note): note is Note => !!note);
    const sharedRules = notes.length && notes.every(note => note.rules === notes[0].rules) ? notes[0].rules : "";
    new IntegrationModal(this.app, notes.map(note => note.title), sharedRules, (title, goal, rules) => {
      const selectedLabel = t("ui.reference_selected_topics_included", notes.map(note => note.title).join(", "));
      new TaskModal(this.app, goal, (direction, run, options, topicRules) => { if (run) void this.plugin.confirmCodexUsage(async () => this.enqueue(() => this.createIntegratedNode(title, nodes, direction, topicRules, options, true))); }, t("ui.synthesis_direction_and_sources"), t("ui.prepare_a_synthesis_draft_first_then_create_the_topic_after"), rules, "local", "normal", "auto", false, false, this.taskSourceSettings(selectedLabel, this.map?.id, selectedLabel)).open();
    }).open();
  }
  private async topicReferenceGroup(sources: MapNode[], mode: "strong" | "summary" = "strong"): Promise<ReferenceGroup> {
    const language = this.plugin.settings?.language ?? "zh-TW";
    const notes = await Promise.all(sources.map(source => this.plugin.repo.readNote(source.path)));
    const documents = sources.map((source, index) => {
      const note = notes[index];
      const finding = note.newFindings.trim();
      const visuals = [note.visualReferences.trim(), imageReferencesFromMarkdown(note.detail)].filter(Boolean).join("\n\n");
      const content = [
        `${translate(language, "prompt.label_current_summary")}: ${note.summary || translate(language, "detail.no_conclusion_yet")}`,
        visuals ? `${translate(language, "prompt.label_visual_references")}\n${visuals}` : "",
        mode === "strong" && note.detail.trim() ? `${translate(language, "prompt.label_full_knowledge")}\n${note.detail.trim()}` : "",
        finding ? `${translate(language, "prompt.label_old_findings")} ${finding}` : ""
      ].filter(Boolean).join("\n\n");
      return { path: source.path, content };
    });
    return { id: `mind-map:${this.map?.id ?? "selected"}`, name: t("ui.selected_mind_map_notes"), location: this.path, documents };
  }
  private async createIntegratedNode(title: string, sources: MapNode[], goal: string, rules: string, options?: TaskOptions, review = false): Promise<void> {
    if (!this.map || sources.length < 2) return;
    this.integrationMode = false; this.multiSelected.clear(); this.render();
    const model = this.plugin.settings.cliModel;
    const language = this.plugin.settings.language;
    const sourceGroup = await this.topicReferenceGroup(sources, "strong");
    const result = await this.plugin.askModel({ title, summary: language === "en" ? "No conclusion yet" : "尚未形成結論", rules, detail: "", task: [goal, options?.requirements].filter(Boolean).join("\n\n"), ancestors: "", referenceGroups: [sourceGroup, ...(options?.referenceGroups ?? [])], onProgress: options?.onProgress, mode: "synthesize", researchMode: options?.researchMode ?? "local", researchDepth: options?.researchDepth ?? "normal", visualMode: options?.visualMode ?? "auto" }, model, this.plugin.settings.cliReasoning, options?.signal);
    if (review) {
      new AiDraftModal(this.app, result.summary, result.detail, t("ui.confirm_new_synthesis_topic"), () => this.enqueue(() => this.saveIntegratedNode(title, sources, goal, rules, model, result, language))).open();
      return;
    }
    await this.saveIntegratedNode(title, sources, goal, rules, model, result, language);
  }
  private async saveIntegratedNode(title: string, sources: MapNode[], goal: string, rules: string, model: string, result: AiResult, language: "zh-TW" | "en"): Promise<void> {
    if (!this.map) return;
    const integrated = await this.plugin.repo.createNote(title, model, this.map, this.path, "workspace");
    await this.plugin.repo.updateNote(integrated.path, { summary: result.summary, rules, detail: canonicalDetail(result.detail, this.plugin.settings.language), visualReferences: visualReferencesMarkdown(result.visualReferences, language), prompt: goal, sourcePaths: sources.map(source => source.path), status: "completed" });
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
      const finish = (e: PointerEvent): void => { this.dragging = false; this.suppressClickUntil = Date.now() + 250; card.removeEventListener("pointermove", move); card.removeEventListener("pointerup", finish); card.removeEventListener("pointercancel", finish); if (e.type === "pointercancel") { card.style.left = `${origin.x}px`; card.style.top = `${origin.y}px`; this.drawEdges(); return; } if (moved) this.enqueue(() => this.mapChange(map => { const current = map.nodes.find(n => n.id === node.id); if (!current) return; current.x = Math.round(position.x); current.y = Math.round(position.y); })); else if (e.metaKey || e.ctrlKey) { if (this.multiSelected.has(node.id)) this.multiSelected.delete(node.id); else this.multiSelected.add(node.id); this.selected = node.id; this.render(); } else { this.multiSelected.clear(); this.selected = node.id; this.render(); this.openDetails(node); } };
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
  private async runAgent(node: MapNode, done?: (result: AiResult) => void, failed?: (message: string) => void, overrides?: Partial<TaskContext>): Promise<void> {
    const taskPath = node.path;
    const note = await this.plugin.repo.readNote(node.path);
    if (!(overrides?.task ?? note.prompt)) { const message = t("ui.enter_a_question_or_task_for_ai_first"); if (failed) failed(message); else new Notice(message); return; }
    if (this.plugin.running.has(node.path)) { failed?.(t("ui.ai_running_ai")); return; }
    const context: TaskContext = { title: note.title, summary: note.summary, rules: "", detail: note.detail, task: note.prompt, ancestors: await this.ancestorContext(node), workingFindings: note.newFindings, sourceContext: "", mode: "task", researchMode: note.researchMode, researchDepth: note.researchDepth, visualMode: note.visualMode, ...overrides };
    const language = this.plugin.settings.language;
    this.plugin.pendingSuggestions.delete(node.path);
    this.plugin.running.add(node.path);
    const controller = new AbortController();
    const abortFromTaskModal = (): void => controller.abort();
    if (overrides?.signal?.aborted) controller.abort();
    else overrides?.signal?.addEventListener("abort", abortFromTaskModal, { once: true });
    this.plugin.activeTasks.set(taskPath, controller);
    try { await this.plugin.repo.updateNote(node.path, { status: "running" }); } catch (error) { this.plugin.activeTasks.delete(taskPath); this.plugin.running.delete(taskPath); throw error; }
    await this.hydrate(); this.render();
    // Leave the mutation queue immediately: independent branches can run concurrently.
    let exchangeId = "";
    void this.plugin.askModel(context, note.model, note.reasoning, controller.signal, id => { exchangeId = id; }).then(result => this.plugin.mutate(async () => {
      const latest = await this.plugin.repo.readNote(node.path);
      const stale = latest.title !== note.title || latest.prompt !== note.prompt || latest.rules !== note.rules || latest.detail !== note.detail || latest.summary !== note.summary || latest.model !== note.model || latest.reasoning !== note.reasoning || latest.researchMode !== note.researchMode || latest.researchDepth !== note.researchDepth || latest.visualMode !== note.visualMode || latest.sourcePaths.join("\n") !== note.sourcePaths.join("\n") || JSON.stringify(latest.referencePaths) !== JSON.stringify(note.referencePaths);
      if (controller.signal.aborted || stale) { await this.plugin.repo.updateNote(node.path, { status: note.status }); if (exchangeId && this.plugin.settings.aiExchangeLoggingEnabled) this.plugin.exchanges?.failed(exchangeId, stale ? "議題內容已變更，過時的 AI 結果未寫入。" : "研究已停止，結果未寫入。"); if (stale) { if (failed) failed(t("ui.the_topic_changed_so_the_outdated_ai_result_was_not_saved")); else new Notice(t("ui.the_topic_changed_so_the_outdated_ai_result_was_not_saved")); } return; }
      await this.plugin.repo.updateNote(node.path, { summary: result.summary, detail: canonicalDetail(result.detail, this.plugin.settings.language), visualReferences: visualReferencesMarkdown(result.visualReferences, language), newFindings: "", status: "completed" });
      if (exchangeId && this.plugin.settings.aiExchangeLoggingEnabled) this.plugin.exchanges?.completed(exchangeId);
      for (const view of this.plugin.views()) view.history.clear();
      if (result.suggestions.length) {
        this.plugin.pendingSuggestions.set(node.path, result.suggestions.slice(0, 7));
        try { await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.(); }
        catch (error) { const message = this.plugin.recordFailure("展開建議儲存失敗", error); new Notice(message); }
      }
      done?.(result);
    })).catch(error => this.plugin.mutate(async () => {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) { await this.plugin.repo.updateNote(node.path, { status: note.status }); if (failed) failed(t("ui.research_stopped_existing_content_was_preserved")); else new Notice(t("ui.research_stopped_existing_content_was_preserved")); return; }
      console.error("Visual Agent Map AI task", error);
      if (exchangeId && this.plugin.settings.aiExchangeLoggingEnabled && this.plugin.exchanges?.getEntries().find(item => item.id === exchangeId)?.status === "parsed") this.plugin.exchanges.failed(exchangeId, `寫入議題失敗：${error instanceof Error ? error.message : String(error)}`);
      await this.plugin.repo.updateNote(node.path, { status: "error" });
      const message = this.plugin.recordFailure("AI 任務失敗", error); if (failed) failed(message); else new Notice(message);
    })).finally(() => {
      overrides?.signal?.removeEventListener("abort", abortFromTaskModal);
      if (this.plugin.activeTasks.get(taskPath) === controller) this.plugin.activeTasks.delete(taskPath);
      this.plugin.running.delete(taskPath);
      for (const view of this.plugin.views()) view.enqueue(async () => { await view.hydrate(); view.render(); });
    }).catch(() => {});
  }
}
export class VisualAgentMapSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: VisualAgentMapPlugin) { super(app, plugin); }
  getSettingDefinitions(): SettingDefinitionItem[] {
    const text = (name: string, key: "codexPath", desc: string): SettingDefinitionItem => ({ name, desc, control: { type: "text", key } });
    const diagnostic = this.plugin.codexDiagnostic();
    const models = Object.fromEntries(this.plugin.settings.models.split(/[,\n]/).map(model => model.trim()).filter(Boolean).map(model => [model, model]));
    return [
      { name: t("ui.interface_language"), control: { type: "dropdown", key: "language", options: { "zh-TW": "繁體中文", en: "English" } } },
      text(t("ui.codex_cli_path"), "codexPath", t("ui.vam_uses_this_executable_to_start_codex_app_server")),
      { name: t("ui.workspace_default_model"), desc: t("ui.models_are_loaded_from_codex_app_server_changes_apply_only_t"), control: { type: "dropdown", key: "cliModel", options: models } },
      { name: t("ui.ai_reasoning_level"), desc: t("ui.auto_uses_low_for_simple_tasks_and_medium_for_complex_synthe"), control: { type: "dropdown", key: "cliReasoning", options: { auto: t("ui.auto"), low: t("ui.low"), medium: t("ui.medium"), high: t("ui.high") } } },
      { name: t("ui.record_ai_exchanges"), render: setting => { setting.setName(t("ui.record_ai_exchanges")).setDesc(t("ui.when_enabled_the_20_most_recent_full_requests_and_raw_replie" )).addToggle(toggle => toggle.setValue(this.plugin.settings.aiExchangeLoggingEnabled).onChange(async value => { this.plugin.settings.aiExchangeLoggingEnabled = value; await this.plugin.saveSettings(); })); } },
      { name: t("ui.workspace_location"), render: setting => { setting.setName(t("ui.workspace_location")).setDesc(t("ui.topics_folder_0_inbox_1", this.plugin.settings.topicsFolder, this.plugin.settings.inboxFolder)); } },
      { name: t("ui.repair_agent_workspace"), render: setting => { setting.setName(t("ui.repair_agent_workspace")).setDesc(t("ui.creates_only_missing_base_folders_it_never_restores_moves_or")).addButton(button => button.setButtonText(t("ui.repair")).onClick(() => { void this.plugin.mutate(() => this.plugin.repairWorkspace()); })); } },
      { name: t("ui.refresh_vam_data"), render: setting => { setting.setName(t("ui.refresh_vam_data")).setDesc(t("ui.rescan_maps_and_topic_notes_then_rebuild_references_and_deri")).addButton(button => button.setButtonText(t("ui.full_rebuild")).onClick(() => { void this.plugin.mutate(() => this.plugin.fullRebuild()); })); } },
      { name: t("ui.reconnect_existing_workspace"), render: setting => { setting.setName(t("ui.reconnect_existing_workspace")).setDesc(t("ui.scan_for_recognizable_vam_workspaces_and_reconnect_only_afte")).addButton(button => button.setButtonText(t("ui.scan")).onClick(() => { void this.plugin.offerWorkspaceReconnect(); })); } },
      { name: t("ui.codex_app_server_status"), render: setting => {
        setting.setName(t("ui.codex_app_server_status")).setDesc(diagnostic.installed ? t("ui.codex_cli_found_0", diagnostic.executable) : t("ui.codex_cli_was_not_found_follow_the_installation_guide_to_ins"));
        if (!diagnostic.installed) setting.addButton(button => button.setButtonText(t("ui.installation_guide")).onClick(() => this.plugin.openCodexSetupGuide()));
        setting.addButton(button => button.setButtonText(t("ui.check_again")).onClick(() => { void this.plugin.recheckCodex(); }));
      } }
    ];
  }
  async setControlValue(key: string, value: unknown): Promise<void> {
    const languageChanged = key === "language" && this.plugin.settings.language !== (value === "en" ? "en" : "zh-TW");
    if (key === "language") this.plugin.settings.language = value === "en" ? "en" : "zh-TW";
    else if (typeof value === "string" && (key === "codexPath" || key === "cliModel")) this.plugin.settings[key] = value.trim();
    else if (key === "cliReasoning") this.plugin.settings.cliReasoning = normalizeReasoningLevel(value);
    else return;
    if (key === "codexPath") this.plugin.resetCodexRuntime();
    setUiLanguage(this.plugin.settings.language);
    await this.plugin.saveSettings();
    if (languageChanged) {
      this.plugin.refreshLocalizedEntrypoints();
      const updated = await this.plugin.repo.syncManagedDetailHeadings(this.plugin.settings.language);
      if (updated) new Notice(t("ui.detail_headings_synced_0_notes", updated));
      for (const view of this.plugin.views()) await view.refreshFromPlugin();
      this.update();
      new Notice(t("ui.language_changed_content_preserved"));
    }
  }
}
export default class VisualAgentMapPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  repo!: Repository;
  ready: Promise<void> = Promise.resolve();
  readonly running = new Set<string>();
  readonly quickExpandPending = new Set<string>();
  readonly quickExpandFailures = new Map<string, string>();
  readonly activeTasks = new Map<string, AbortController>();
  pendingSuggestions: Map<string, Suggestion[]> = new Map();
  readonly pendingResearchOptions = new Map<string, TaskOptions>();
  readonly logs: LogManager = debugLog;
  exchanges: AiExchangeLog | null = null;
  private codexRuntime: CodexAppServerRuntime | null = null;
  private localCodexRuntime: CodexAppServerRuntime | null = null;
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
  syncOutline(map: MapDocument | null, notes: Map<string, Note>): void {
    const titles = new Map([...notes].map(([id, note]) => [id, note.title]));
    for (const leaf of this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE)) if (leaf.view instanceof OutlineView) leaf.view.setMap(map, titles);
  }
  async activateOutline(): Promise<void> {
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(OUTLINE_VIEW_TYPE)[0] ?? null;
    if (!leaf) leaf = this.app.workspace.getLeftLeaf(true);
    if (!leaf) throw new Error(t("ui.could_not_open_the_left_sidebar"));
    await leaf.setViewState({ type: OUTLINE_VIEW_TYPE, active: true });
    const mapView = this.views()[0];
    if (mapView) mapView.syncOutline();
    await this.app.workspace.revealLeaf(leaf);
  }
  async onload(): Promise<void> {
    const saved = await this.loadData() as Partial<Settings> | null;
    const legacy: (Partial<Settings> & { cliPath?: string }) | null = saved;
    this.settings = { ...DEFAULT_SETTINGS, language: initialUiLanguage(saved?.language, getLanguage()), workspaceFolder: saved?.workspaceFolder || DEFAULT_SETTINGS.workspaceFolder, topicsFolder: saved?.topicsFolder || DEFAULT_SETTINGS.topicsFolder, inboxFolder: saved?.inboxFolder || DEFAULT_SETTINGS.inboxFolder, notesFolder: saved?.notesFolder || DEFAULT_SETTINGS.notesFolder, mapsFolder: saved?.mapsFolder || DEFAULT_SETTINGS.mapsFolder, mapId: saved?.mapId || "default", codexPath: saved?.codexPath || legacy?.cliPath || DEFAULT_SETTINGS.codexPath, cliModel: saved?.cliModel || DEFAULT_SETTINGS.cliModel, cliReasoning: normalizeReasoningLevel(saved?.cliReasoning), previewScale: saved?.previewScale !== undefined ? clampPreviewScale(saved.previewScale) : legacyPreviewScale(saved?.previewSize), models: "", migrated: saved?.migrated === true, structureVersion: saved?.structureVersion ?? (saved ? 1 : DEFAULT_SETTINGS.structureVersion), firstUseNoticeSeen: saved?.firstUseNoticeSeen === true, codexUsageNoticeSeen: saved?.codexUsageNoticeSeen === true, aiExchangeLoggingEnabled: saved?.aiExchangeLoggingEnabled === true, workspaceInitialized: saved ? saved.workspaceInitialized !== false : false, sampleTourVersionSeen: saved?.sampleTourVersionSeen ?? 0 };
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
    this.registerView(VIEW_TYPE, leaf => new VisualAgentMapView(leaf, this));
    this.registerView(OUTLINE_VIEW_TYPE, leaf => new OutlineView(leaf, async path => {
      try { await this.openDetails(this.repo.file(path)); }
      catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
    }));
    this.ribbonIcon = this.addRibbonIcon("git-fork", t("ui.open_map"), () => { void this.activateView().catch(error => new Notice(String(error))); });
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
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => { if (file instanceof TFile && this.isMap(file)) menu.addItem(item => item.setTitle(t("ui.open_as_mind_map")).setIcon("git-fork").onClick(() => { void this.activateView(file.path); })); }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
      this.styleNodeLeaf(leaf);
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
  codexDiagnostic(): { executable: string; installed: boolean } {
    const executable = this.resolveExecutable(this.settings.codexPath);
    return { executable, installed: existsSync(executable) };
  }
  resetCodexRuntime(): void { for (const controller of this.activeTasks.values()) controller.abort(); this.codexRuntime?.stop(); this.localCodexRuntime?.stop(); this.codexRuntime = null; this.localCodexRuntime = null; }
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
      map.viewport = { ...sample.map.viewport }; await this.repo.saveMap(path, map); await this.repo.rebuildDerivedData(); await this.saveSettings(); new Notice(t("ui.created_an_editable_copy_of_the_sample")); return path;
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
  onunload(): void { this.resetCodexRuntime(); }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }
  private addLocalizedCommand(id: string, key: TranslationKey, callback: () => void): void {
    this.localizedCommands.push({ command: this.addCommand({ id, name: t(key), callback }), key });
  }
  refreshLocalizedEntrypoints(): void {
    this.ribbonIcon?.setAttribute("aria-label", translate(this.settings.language, "ui.open_map"));
    for (const { command, key } of this.localizedCommands) command.name = translate(this.settings.language, key);
  }
  async codexReadyForAi(): Promise<boolean> {
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
  async confirmCodexUsage(run: () => Promise<void>): Promise<void> {
    if (!await this.codexReadyForAi()) return;
    if (!this.settings.codexUsageNoticeSeen) {
      const confirmed = await new Promise<boolean>(resolve => new CodexUsageModal(this.app, resolve).open());
      if (!confirmed) return;
      this.settings.codexUsageNoticeSeen = true;
      await this.saveSettings();
    }
    await run();
  }
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
      this.app.workspace.trigger("active-leaf-change", this.app.workspace.activeLeaf);
    }
    this.detailsLeaf = null;
    this.detailsPath = null;
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
  async askModel(context: TaskContext, model: string, reasoning?: unknown, signal?: AbortSignal, onExchange?: (id: string) => void): Promise<AiResult> {
    if (model.startsWith("claude:")) throw new Error(t("ui.claude_code_is_no_longer_supported_choose_a_codex_model_in_t"));
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error(t("ui.cli_mode_requires_desktop_obsidian"));
    if (!this.manifest.dir) throw new Error(t("ui.plugin_folder_not_found"));

    if (context.referenceGroups?.some(group => group.documents.length)) {
      const findings = await this.extractReferenceFindings(context, model, reasoning, signal);
      context = { ...context, sourceContext: [context.sourceContext, findings].filter(Boolean).join("\n\n"), referenceGroups: undefined };
    }

    const totalStarted = Date.now();
    const prepared = buildPreparedTaskContext(context, model);
    if (prepared.context.sourceContext !== context.sourceContext) throw new Error(t("ui.reference_too_large", t("ui.reference_materials")));
    context = prepared.context;
    const pluginDirectory = join(adapter.getBasePath(), this.manifest.dir);
    const outputLanguage = this.settings.language;
    const interfaceLanguage = this.settings.language;
    const instructions = [
      translate(outputLanguage, "prompt.output_language"),
      translate(outputLanguage, "prompt.role"),
      translate(outputLanguage, "prompt.source_safety"),
      context.sourceContext ? translate(outputLanguage, "prompt.reference_citations") : "",
      context.sourceContext && context.researchMode !== "local" ? translate(outputLanguage, "prompt.local_first") : "",
      translate(outputLanguage, "prompt.json"),
      translate(outputLanguage, context.mode === "task" ? "prompt.general_task" : context.mode === "decompose" ? "prompt.decompose" : context.mode === "synthesize" ? "prompt.synthesize" : "prompt.default_task"),
      context.mode !== "decompose" ? translate(outputLanguage, "prompt.detail_structure", ["detail.core_conclusions", "detail.key_knowledge", "detail.evidence_and_sources", "detail.tradeoffs_and_limitations", "detail.open_questions", "detail.update_log"].map(key => `### ${translate(interfaceLanguage, key as TranslationKey)}`).join(", ")) : "",
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
      const raw = await this.runtime(pluginDirectory, context.researchMode === "local").runTask(instructions, model, effort, responseSchema, {
        signal, searchBudget: context.researchMode === "local" ? 0 : researchLimits(context.researchDepth).searches,
        onRequest: request => { stage = "等待 AI 回覆"; if (this.settings.aiExchangeLoggingEnabled) exchanges?.sent(exchangeId, JSON.stringify(request, null, 2)); }
      });
      stage = "解析 AI 回覆";
      if (this.settings.aiExchangeLoggingEnabled) exchanges?.received(exchangeId, raw);
      const result = this.parseAiResult(raw, "Codex App Server", outputLanguage);
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
  private runtime(pluginDirectory: string, local = false): CodexAppServerRuntime {
    if (local && this.localCodexRuntime) return this.localCodexRuntime;
    if (!local && this.codexRuntime) return this.codexRuntime;
    const executable = this.resolveExecutable(this.settings.codexPath);
    const runtime = new CodexAppServerRuntime({
      executable,
      cwd: pluginDirectory,
      env: this.cliEnvironment(executable),
      clientVersion: this.manifest.version || "0.0.0",
      webSearchDisabled: local,
      onLog: (level, message) => this.logs.appendLog(level, message)
    });
    if (local) this.localCodexRuntime = runtime;
    else this.codexRuntime = runtime;
    return runtime;
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
