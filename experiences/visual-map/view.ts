import { MindSearchClarificationModal } from "../../ui/modals/mind-search-clarification-modal";
import { withThinkingOrigin } from "./thinking-origin";
import { createHash, randomUUID } from "node:crypto";
import type VisualAgentMapPlugin from "../../main";
import { t, topicStatusLabel, translate, type TranslationKey } from "../../i18n";
import { App, MarkdownRenderer, ItemView, Modal, Notice, Setting, TFile, WorkspaceLeaf } from "obsidian";
import { ReferencePicker, type ReferenceTopic } from "../../ui/reference-picker";
import { readMarkdownFile, type ReferenceGroup } from "../../ai/reference-materials";
import { NameModal } from "../../ui/modals/name-modal";
import { ChoiceModal } from "../../ui/modals/choice-modal";
import { DebugLogModal } from "../../ui/modals/debug-log-modal";
import { canParent, clearQuestionConvergenceEdges, repairMindSearchResultConvergence, clone, descendants, History, inheritModel, type MapDocument, type MapNode, parentIdsForNode, parseMap, removeNodes, serializeMap, visibleNodes } from "../../map-model";
import { arrangeMap, arrangeNewBranch } from "../../map-layout";
import { normalizeReasoningLevel, type ModelSource, type Note, type NotePatch, type ResearchDepth, type ResearchMode, type Settings, type TopicInfo, type TopicState, type VisualMode } from "../../repository";
import { canonicalDetail, visualReferencesMarkdown } from "../../ai/result-utils";
import type { AiResult, Suggestion, TaskContext } from "../../ai/types";
import { clampPreviewScale, previewMetrics } from "../../ui/preview-utils";
import { BUILTIN_SAMPLE_ID, builtInSample, SAMPLE_TOUR_VERSION } from "../../builtin-sample";
import { PendingSuggestions } from "../../pending-suggestions";
import { syncModelSelect } from "../../core/model-discovery";
import { createMindSearchMap } from "../mind-search/create-map";
import { MindSearchStartModal } from "../../ui/modals/mind-search-start-modal";
import { MindSearchAnswerModal } from "../../ui/modals/mind-search-answer-modal";
import { MindSearchManualFlow, countMindSearchAnsweredQuestions, MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION, type ManualResearchResult, type PlannerQuestionResult } from "../mind-search/manual-flow";
import { MindSearchRunStore } from "../../mindsearch-mve/research-run-store";
import { matchMindSearchFailedReportTargets } from "../mind-search/retry-targets";

export const VIEW_TYPE = "visual-agent-map-view";
interface Action { undo: () => Promise<void>; redo: () => Promise<void>; label?: string }
const originBaseline = (origin?: string): string => createHash("sha256").update(origin ?? "").digest("hex");

type SynthesisContent = "full" | "summary";
type MindSearchQuestionStatus = "running" | "completed" | "partial" | "failed" | "cancelled" | "not_started";
function mindSearchQuestionStatus(map: MapDocument, questionNodeId: string, activeQuestionNodeId: string | null): MindSearchQuestionStatus {
  if (activeQuestionNodeId === questionNodeId) return "running";
  const branches = map.mindSearch?.branches.filter(branch => branch.questionNodeId === questionNodeId) ?? [];
  const statuses = branches.map(branch => {
    if (branch.researchPlanError && !branch.researchPlan) return "failed" as const;
    const runs = (map.mindSearch?.runs ?? []).filter(item => item.branchId === branch.id);
    if (runs.some(run => { const attempt = run.attempts.find(item => item.id === run.currentAttemptId); return attempt?.status === "running" || attempt?.status === "saving"; })) return "running" as const;
    const terminal = [...branch.results].reverse().find(result => result.kind !== "research");
    if (terminal) {
      const terminalRun = runs.find(item => item.id === terminal.runId), terminalAttempt = terminalRun?.attempts.find(item => item.id === terminal.attemptId);
      const latestRun = [...runs].reverse()[0], latestAttempt = latestRun?.attempts.find(item => item.id === latestRun.currentAttemptId);
      if (latestAttempt?.status === "failed") return "failed" as const;
      if (latestAttempt?.status === "cancelled") return "cancelled" as const;
      return terminalAttempt?.status === "partial" ? "partial" as const : "completed" as const;
    }
    const latest = [...runs].reverse().find(run => run.attempts.some(item => item.id === run.currentAttemptId));
    const status = latest?.attempts.find(item => item.id === latest.currentAttemptId)?.status;
    if (status === "failed") return "failed" as const;
    if (status === "cancelled") return "cancelled" as const;
    return branch.researchPlan || branch.results.length || status === "completed" ? "partial" as const : "not_started" as const;
  });
  if (statuses.includes("running")) return "running";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("partial")) return "partial";
  if (statuses.includes("completed")) return "completed";
  if (statuses.includes("cancelled")) return "cancelled";
  return "not_started";
}
export interface TaskOptions { synthesisContent?: SynthesisContent; referenceGroups?: ReferenceGroup[]; onProgress?: (message: string) => void; signal?: AbortSignal; outputLanguage?: Settings["language"]; requirements?: string; researchMode: ResearchMode; researchDepth: ResearchDepth; visualMode: VisualMode; multiLayer?: boolean; shallowResearch?: boolean; layers?: number; firstLayerCount?: number; childrenPerParent?: number }
function renderSynthesisContent(parent: HTMLElement, topics: string[]): HTMLSelectElement {
  const label = parent.createEl("label", { cls: "vam-field" });
  label.createSpan({ text: t("ui.synthesis_content") });
  const select = label.createEl("select"); select.setAttr("aria-label", t("ui.synthesis_content"));
  select.createEl("option", { value: "full", text: t("ui.synthesis_content_full") });
  select.createEl("option", { value: "summary", text: t("ui.synthesis_content_summary") });
  select.value = "full";
  const hint = parent.createEl("p", { cls: "vam-hint", text: t("ui.synthesis_content_full_hint") });
  hint.setAttr("aria-live", "polite");
  select.addEventListener("change", () => hint.setText(t(select.value === "summary" ? "ui.synthesis_content_summary_hint" : "ui.synthesis_content_full_hint")));
  parent.createEl("p", { cls: "vam-hint", text: t("ui.synthesis_content_scope") });
  parent.createEl("p", { cls: "vam-hint", text: t("ui.synthesis_content_locked_hint") });
  parent.createEl("strong", { text: t("ui.synthesis_source_topics") });
  if (topics.length) {
    const list = parent.createEl("ul");
    for (const title of topics) list.createEl("li", { text: title });
  } else parent.createEl("p", { cls: "vam-hint", text: t("ui.synthesis_no_source_topics") });
  return select;
}
function researchDepthDescription(depth: ResearchDepth): string {
  const description = depth === "fast"
    ? t("ui.quick_aim_for_up_to_1_web_search_and_2_main_sources_answer_t")
    : depth === "deep"
      ? t("ui.deep_aim_for_up_to_6_web_searches_and_10_main_sources_compar")
      : t("ui.standard_aim_for_up_to_3_web_searches_and_5_main_sources_sum");
  return `${description} ${t("ui.web_and_image_searches_share_the_search_limit_search_counts")}`;
}
function imageReferencesFromMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  const blocks = lines.flatMap((line, index) => /^\s*!\[[^\]]*\]\(https?:\/\/[^\s)]+\)/i.test(line)
    ? [lines.slice(Math.max(0, index - 2), Math.min(lines.length, index + 4)).join("\n").trim()]
    : []);
  return [...new Set(blocks)].join("\n\n");
}
class PartialChildBatchError extends Error {}
interface AgentTaskHandle { finished: Promise<void> }
interface TaskSourceSettings { topics: () => Promise<ReferenceTopic[]>; readTopic: (topic: ReferenceTopic, signal: AbortSignal, progress: (message: string) => void) => Promise<{ path: string; content: string }[]>; currentTopicId: string; currentLabel: string; synthesisLabel?: string; synthesisTopics?: string[] }
function quickShape(layers: number, firstLayerCount: number, childrenPerParent: number): { counts: bigint[]; total: bigint } {
  if (![layers, firstLayerCount].every(Number.isSafeInteger) || layers < 1 || layers > 15 || firstLayerCount < 1 || (layers > 1 && (!Number.isSafeInteger(childrenPerParent) || childrenPerParent < 1))) throw new Error(t("ui.levels_first_level_count_and_children_per_topic_must_be_posi"));
  const counts: bigint[] = [];
  let count = BigInt(firstLayerCount), total = BigInt(0);
  for (let level = 0; level < layers; level++) { counts.push(count); total += count; if (level + 1 < layers) count *= BigInt(childrenPerParent); }
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
  constructor(app: App, private value: string, private submit: (value: string, run: boolean, options: TaskOptions, rules: string) => void, private titleText = t("ui.custom_ai_task"), private description = t("ui.describe_what_you_want_ai_to_do_next"), private rules = "", private mode: ResearchMode = "research", private depth: ResearchDepth = "normal", private visual: VisualMode = "auto", _allowSave = true, private expand = false, private referenceSettings?: TaskSourceSettings, private synthesisTopics?: string[], private currentLanguage: Settings["language"] = "zh-TW", private modelId = "", private reasoningId = "auto", private targetLabel = "") { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    this.contentEl.createEl("p", { text: this.description, cls: "vam-modal-intro" });
    const label = this.contentEl.createEl("label", { cls: "vam-field" });
    label.createSpan({ text: t("ui.additional_requirements") });
    const input = label.createEl("textarea", { cls: "vam-task-input" }); input.rows = 3;
    input.setAttr("aria-label", t("ui.additional_requirements"));
    this.contentEl.createEl("p", { text: t("ui.requirements_this_task_only"), cls: "vam-hint" });
    this.contentEl.createEl("p", { text: t("ui.summary_fields_hint"), cls: "vam-hint" });
    const languageLabel = this.contentEl.createEl("label", { cls: "vam-field" }); languageLabel.createSpan({ text: t("ui.output_language") });
    const languageSelect = languageLabel.createEl("select"); languageSelect.setAttr("aria-label", t("ui.output_language"));
    languageSelect.createEl("option", { value: "zh-TW", text: "繁體中文" }); languageSelect.createEl("option", { value: "en", text: "English" }); languageSelect.value = this.currentLanguage;
    if (this.rules.trim()) this.contentEl.createEl("p", { text: t("ui.legacy_rules_not_applied"), cls: "vam-hint" });
    const synthesis = this.synthesisTopics ? renderSynthesisContent(this.contentEl, this.synthesisTopics) : undefined;
    const referenceLabel = this.expand ? this.referenceSettings?.currentLabel : this.referenceSettings?.synthesisLabel ?? this.referenceSettings?.currentLabel;
    const references = this.referenceSettings ? new ReferencePicker(this.app, this.contentEl, this.referenceSettings.topics, this.referenceSettings.readTopic, this.referenceSettings.currentTopicId, referenceLabel ?? "", this.mode !== "local", this.visual !== "off") : null;
    const executionSummary = this.contentEl.createEl("p", { cls: "vam-hint", attr: { "aria-live": "polite" } });
    const updateSummary = (): void => {
      const selected = references?.selection();
      const result = this.synthesisTopics ? t("ui.review_synthesis_draft") : this.expand ? t("ui.expand_subtopics") : t("ui.current_understanding");
      executionSummary.setText(t("ui.ai_task_summary", this.modelId, this.reasoningId, references?.describe() ?? `0 ${t("ui.markdown_files")}`, t(selected?.webSearch ? "ui.on" : "ui.off"), this.targetLabel ? `${this.targetLabel} · ${result}` : result));
    };
    this.contentEl.addEventListener("change", updateSummary); updateSummary();
    const depthLabel = this.contentEl.createEl("label", { cls: "vam-field" }); depthLabel.createSpan({ text: t("ui.research_depth") });
    const depthHint = this.contentEl.createEl("p", { cls: "vam-hint", text: researchDepthDescription(this.depth) });
    const depth = this.contentEl.createEl("select", { cls: "vam-depth-select" }); depth.setAttr("aria-label", t("ui.research_depth"));
    for (const [value, key] of [["fast", "ui.fast_quick_overview"], ["normal", "ui.normal_standard_research"], ["deep", "ui.deep_in_depth_research"]] as const) depth.createEl("option", { value, text: t(key) });
    depth.value = this.depth;
    depth.addEventListener("change", () => depthHint.setText(researchDepthDescription(depth.value as ResearchDepth)));
    const layers = this.expand ? this.contentEl.createEl("label", { cls: "vam-field" }) : null;
    const multiLayer = layers?.createEl("input", { type: "checkbox" });
    if (multiLayer) multiLayer.checked = true;
    if (layers) layers.createSpan({ text: t("ui.create_two_levels_and_research_each_topic_briefly_up_to_15") });
    const save = async (run: boolean): Promise<void> => {
      const value = this.value;
      const synthesisContent: SynthesisContent = synthesis?.value === "summary" ? "summary" : "full";
      if (synthesis) synthesis.disabled = true;
      const sources = await references?.ready();
      const shallowResearch = multiLayer?.checked ?? false;
      this.close(); this.submit(value, run, { ...(synthesis ? { synthesisContent } : {}), referenceGroups: sources?.groups ?? [], requirements: input.value.trim(), outputLanguage: languageSelect.value as Settings["language"], researchMode: sources?.webSearch ? "research" : "local", researchDepth: depth.value as ResearchDepth, visualMode: sources?.imageSearch ? (this.visual === "on" ? "on" : "auto") : "off", multiLayer: shallowResearch }, "");
    };
    new Setting(this.contentEl).addButton(b => b.setButtonText(t("ui.cancel")).onClick(() => this.close()))
      .addButton(b => b.setButtonText(t("ui.confirm_and_run")).setCta().onClick(() => { void save(true).catch(error => new Notice(String(error))); }));
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  }
}
export class NextStepModal extends Modal {
  private closed = false;
  private runPending = false;
  private settingsPending: Promise<void> = Promise.resolve();
  private settingsError: string | null = null;
  constructor(app: App, private topic: string, private depth: ResearchDepth, private childrenCount: number, private pendingCount: number, private plugin: VisualAgentMapPlugin,
    private research: (options: TaskOptions, focus: string, done: (result: AiResult) => void, failed: (message: string) => void, accepted: () => void) => Promise<void>,
    private expand: (options: TaskOptions, direction: string, found: (items: Suggestion[], create: (items: Suggestion[]) => Promise<void>) => void, failed: (message: string, retryable?: boolean) => void, created: () => void, accepted: () => void) => Promise<void>,
    private synthesize: (options: TaskOptions, angles: (items: Suggestion[], draft: (direction: string) => Promise<void>) => void, drafted: (result: AiResult, save: (summary: string, detail: string) => Promise<void>) => void, failed: (message: string) => void) => Promise<void>,
    private modelSettings?: { model: string; modelSource: ModelSource; reasoning: string; rules?: string; path?: string; save: (patch: NotePatch) => Promise<void>; running?: boolean; stop?: () => void; quickError?: string; sources?: TaskSourceSettings }) { super(app); }
  private taskSignal?: AbortSignal;
  private taskController?: AbortController;
  private unsubscribeModels?: () => void;
  private addReferencePicker(panel: HTMLElement, mode: "research" | "expand" | "synthesize"): ReferencePicker | undefined {
    const sources = this.modelSettings?.sources;
    if (!sources) return undefined;
    const disclosure = panel.createEl("details", { cls: "vam-next-source-details" });
    disclosure.open = false;
    const summary = disclosure.createEl("summary");
    const summaryRow = summary.createSpan({ cls: "vam-next-source-summary-row" });
    summaryRow.createEl("strong", { text: t("ui.data_sources") });
    const selection = summaryRow.createSpan({ cls: "vam-next-source-summary" });
    const pickerContent = disclosure.createDiv();
    const picker = new ReferencePicker(this.app, pickerContent, sources.topics, sources.readTopic, sources.currentTopicId, mode === "synthesize" ? sources.synthesisLabel ?? sources.currentLabel : sources.currentLabel, mode !== "synthesize", mode !== "synthesize");
    const updateSelection = (): void => selection.setText(picker.describe());
    pickerContent.addEventListener("change", updateSelection);
    updateSelection();
    return picker;
  }
  private requirementsInput?: HTMLTextAreaElement;
  private renderRequirements(): void {
    const disclosure = this.contentEl.createEl("details", { cls: "vam-next-requirements" });
    disclosure.open = false;
    disclosure.createEl("summary", { text: t("ui.additional_requirements") });
    this.requirementsInput = disclosure.createEl("textarea", { cls: "vam-next-focus" });
    this.requirementsInput.rows = 3;
    this.requirementsInput.setAttr("aria-label", t("ui.additional_requirements"));
    disclosure.createEl("p", { text: t("ui.requirements_this_task_only"), cls: "vam-hint" });
    if (this.modelSettings?.rules?.trim()) this.contentEl.createEl("p", { text: t("ui.legacy_rules_not_applied"), cls: "vam-hint" });
  }
  private requirements(): string { return this.requirementsInput?.value.trim() ?? ""; }
  onClose(): void { this.closed = true; this.taskController?.abort(); this.unsubscribeModels?.(); }
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
    model.add(new Option(this.plugin.modelLabel(settings.model), settings.model)); model.value = settings.model;
    const optionList = typeof this.plugin.availableModels === "function" ? this.plugin.availableModels() : this.plugin.settings.models.split(/[\n,]/).map((value: string) => value.trim()).filter(Boolean);
    const options = new Set<string>(optionList);
    const syncModels = (): void => { syncModelSelect(model, this.plugin.availableModels(), id => this.plugin.modelLabel(id), t("ui.current_model_is_unavailable")); options.clear(); this.plugin.availableModels().forEach(id => options.add(id)); };
    syncModels();
    const discovery = advanced.createDiv("vam-model-discovery-status");
    const discoveryText = discovery.createSpan({ cls: "vam-hint" });
    const retry = discovery.createEl("button", { text: t("ui.check_again") });
    const updateDiscovery = (): void => {
      const codex = this.plugin.modelDiscoveryState("codex"), claude = this.plugin.modelDiscoveryState("claude");
      discoveryText.setText(`Codex: ${codex.status}${codex.error ? ` · ${codex.error}` : ""} | Claude CLI candidates: ${claude.status}`);
      retry.disabled = codex.status === "loading";
      syncModels();
    };
    this.unsubscribeModels?.();
    this.unsubscribeModels = this.plugin.subscribeModelDiscovery(() => { if (!this.closed) updateDiscovery(); });
    retry.addEventListener("click", () => { void this.plugin.refreshModelDiscovery("codex"); void this.plugin.refreshModelDiscovery("claude"); });
    updateDiscovery();
    void this.plugin.refreshModelDiscovery("codex"); void this.plugin.refreshModelDiscovery("claude");
    const sourceLabels: Record<ModelSource, string> = { workspace: t("ui.workspace_default"), inherited: t("ui.inherited_at_creation"), manual: t("ui.manually_selected") };
    const modelSummary = advanced.createEl("p", { cls: "vam-hint", text: t("ui.0_1_reasoning_can_be_adjusted_per_topic", settings.model, sourceLabels[settings.modelSource]) });
    model.value = settings.model;
    model.addEventListener("change", () => {
      if (!options.has(model.value)) return;
      settings.model = model.value; settings.modelSource = "manual";
      modelSummary.setText(t("ui.0_1_reasoning_can_be_adjusted_per_topic", settings.model, sourceLabels[settings.modelSource]));
      save({ model: settings.model, modelSource: settings.modelSource });
    });
    const reasoningLabel = advanced.createEl("label", { cls: "vam-field" }); reasoningLabel.createSpan({ text: t("ui.reasoning_level") });
    const reasoning = reasoningLabel.createEl("select"); reasoning.setAttr("aria-label", t("ui.reasoning_level"));
    for (const [value, label] of [["auto", t("ui.auto")], ["low", t("ui.low")], ["medium", t("ui.medium")], ["high", t("ui.high")]]) reasoning.createEl("option", { value, text: label });
    reasoning.value = normalizeReasoningLevel(settings.reasoning);
    reasoning.addEventListener("change", () => { settings.reasoning = normalizeReasoningLevel(reasoning.value); save({ reasoning: normalizeReasoningLevel(reasoning.value) }); });
  }
  private async run(panel: HTMLElement, button: HTMLButtonElement, work: () => Promise<void>, needsUsage = true): Promise<void> {
    if (button.disabled || this.runPending || (this.taskController && !this.taskController.signal.aborted)) return;
    this.runPending = true;
    button.disabled = true;
    const start = async (): Promise<void> => {
      if (this.closed) return;
      button.disabled = true;
      const failureHelp = panel.querySelector<HTMLElement>(".vam-ai-failure-help"); if (failureHelp) failureHelp.hidden = true;
      const controller = new AbortController(); this.taskController = controller; this.taskSignal = controller.signal;
      const tasksBefore = new Set(this.plugin.activeTasks?.keys?.() ?? []);
      const status = panel.querySelector<HTMLElement>(".vam-next-status");
      status?.setText(t("ui.ai_running_ai"));
      let cancel = panel.querySelector<HTMLButtonElement>(".vam-task-cancel");
      if (!cancel) cancel = panel.createEl("button", { text: t("ui.cancel"), cls: "vam-task-cancel" });
      cancel.hidden = false; cancel.onclick = () => controller.abort();
      try {
        await this.readySettings();
        if (this.closed || controller.signal.aborted) return;
        await work();
      } catch (error) { this.failed(panel, button, controller.signal.aborted ? t("ui.ai_task_cancelled") : error instanceof Error ? error.message : String(error)); }
      finally {
        const backgroundTaskRunning = [...(this.plugin.activeTasks?.keys?.() ?? [])].some(path => !tasksBefore.has(path));
        const release = (): void => { if (!this.closed) cancel.hidden = true; if (this.taskController === controller) { this.taskSignal = undefined; this.taskController = undefined; } };
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
    try {
      const model = this.modelSettings?.model ?? this.plugin.settings.cliModel;
      const started = needsUsage
        ? await this.plugin.confirmAiUsage(model, start)
        : await this.plugin.aiReadyForModel(model) && (await start(), true);
      if (!started) button.disabled = false;
    } catch (error) { this.failed(panel, button, error instanceof Error ? error.message : String(error)); }
    finally { this.runPending = false; }
  }
  private failed(panel: HTMLElement, button: HTMLButtonElement, message: string): void {
    if (this.closed) return;
    panel.querySelector<HTMLElement>(".vam-next-status")?.setText(message);
    button.disabled = false;
  }
  private failedAi(panel: HTMLElement, button: HTMLButtonElement, message: string): void {
    this.failed(panel, button, message);
    if (this.closed) return;
    let help = panel.querySelector<HTMLElement>(".vam-ai-failure-help");
    if (!help) {
      help = panel.createDiv("vam-ai-failure-help");
      help.createEl("p", { text: t("ui.ai_failure_next_steps"), cls: "vam-hint" });
      help.createEl("button", { text: t("ui.open_debug_log") }).addEventListener("click", () =>
        new DebugLogModal(this.app, this.plugin.logs, this.plugin.exchanges, () => this.plugin.settings.aiExchangeLoggingEnabled).open());
    }
    help.hidden = false;
  }
  private proposals(panel: HTMLElement, suggestions: Suggestion[], create: (items: Suggestion[]) => Promise<void>, button: HTMLButtonElement, consumed: () => void, options: TaskOptions): void {
    if (this.closed) return;
    const result = panel.querySelector<HTMLElement>(".vam-next-result")!; result.empty();
    result.createEl("h4", { text: t("ui.ai_subtopic_proposals") });
    result.createEl("p", { text: t("ui.select_subtopics_to_create_you_can_edit_their_names_and_task") });
    const rows: { item: Suggestion; check: HTMLInputElement; title: HTMLInputElement; task: HTMLTextAreaElement; contribution: HTMLTextAreaElement }[] = [];
    const list = result.createDiv("vam-proposal-list");
    for (const item of suggestions) {
      const row = list.createDiv("vam-proposal");
      if (item.parentTitle) row.createEl("p", { text: t("ui.child_of_0", item.parentTitle) });
      const check = row.createEl("input", { type: "checkbox" }); check.checked = true; check.setAttr("aria-label", t("ui.select_proposal_0", item.title));
      const titleField = row.createEl("label", { cls: "vam-proposal-field" }); titleField.createSpan({ text: t("ui.subtopic_name") });
      const title = titleField.createEl("input", { type: "text", value: item.title }); title.setAttr("aria-label", t("ui.proposal_name"));
      const taskField = row.createEl("label", { cls: "vam-proposal-field" }); taskField.createSpan({ text: t("ui.research_task") });
      const task = taskField.createEl("textarea", { text: item.task }); task.rows = 2; task.setAttr("aria-label", t("ui.proposal_task"));
      const contributionField = row.createEl("label", { cls: "vam-proposal-field" }); contributionField.createSpan({ text: t("ui.contribution_to_the_parent_topic") });
      const contribution = contributionField.createEl("textarea", { text: item.contribution }); contribution.rows = 2; contribution.placeholder = t("ui.contribution_to_the_parent_topic"); contribution.setAttr("aria-label", t("ui.contribution_to_the_parent_topic"));
      rows.push({ item, check, title, task, contribution });
    }
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
        try {
          await create(selected.map(row => ({ title: row.title.value.trim(), task: row.task.value.trim(), contribution: row.contribution.value.trim(), parentTitle: row.item.parentTitle ? renamed.get(row.item.parentTitle)! : "" })));
          if (options.shallowResearch) { this.taskSignal = undefined; this.taskController = undefined; this.close(); return; }
          result.empty(); consumed(); panel.querySelector<HTMLElement>(".vam-next-status")?.setText(t("ui.subtopics_created")); confirm.disabled = false; button.disabled = false;
        }
        catch (error) { if (error instanceof PartialChildBatchError) { result.empty(); consumed(); button.disabled = true; } throw error; }
      }, false);
    })(); });
    panel.querySelector<HTMLElement>(".vam-next-status")?.setText(t("ui.review_ai_suggested_subtopics"));
  }
  onOpen(): void {
    this.modalEl.addClass("vam-next-modal");
    this.titleEl.setText(t("ui.how_would_you_like_to_explore_next"));
    this.contentEl.createEl("p", { text: t("ui.current_topic_0", this.topic), cls: "vam-modal-intro" });
    this.renderRequirements();
    const compactSettings = this.contentEl.createDiv("vam-next-compact-settings");
    const languageLabel = compactSettings.createEl("label", { cls: "vam-next-language" }); languageLabel.createSpan({ text: t("ui.output_language") });
    const languageSelect = languageLabel.createEl("select"); languageSelect.createEl("option", { value: "zh-TW", text: "繁體中文" }); languageSelect.createEl("option", { value: "en", text: "English" }); languageSelect.value = this.plugin.settings.language; languageSelect.setAttr("aria-label", t("ui.output_language"));
    const panelHeader = this.contentEl.createDiv("vam-next-panel-header");
    const panelTitle = panelHeader.createEl("h3", { text: t("ui.research_this_topic") });
    const confirm = panelHeader.createEl("button", { text: t("ui.confirm_research_task"), cls: "mod-cta" });
    confirm.dataset.topicRun = t("ui.confirm_research_task");
    confirm.disabled = !!this.modelSettings?.running;
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
    research.createEl("p", { text: t("ui.start_from_this_node_s_question_update_only_this_node") });
    const depthSet = research.createEl("fieldset", { cls: "vam-next-depth-set" });
    depthSet.createEl("legend", { text: t("ui.research_depth") });
    const depths = depthSet.createDiv("vam-next-depths");
    const radios: HTMLInputElement[] = [];
    for (const [value, key] of [["fast", "ui.quick"], ["normal", "ui.standard"], ["deep", "ui.deep"]] as const) {
      const option = depths.createEl("label");
      const radio = option.createEl("input", { type: "radio", attr: { name: "vam-next-depth", value } }); radio.checked = this.depth === value; radios.push(radio);
      option.createSpan({ text: t(key) });
    }
    const depthDisclosure = research.createEl("details", { cls: "vam-next-depth-help" });
    depthDisclosure.open = false;
    depthDisclosure.createEl("summary", { text: t("ui.depth_guidance") });
    const depthHint = depthDisclosure.createEl("p", { cls: "vam-hint", text: researchDepthDescription(this.depth) });
    radios.forEach(radio => radio.addEventListener("change", () => { if (radio.checked) depthHint.setText(researchDepthDescription(radio.value as ResearchDepth)); }));
    const researchPicker = this.addReferencePicker(research, "research");
    research.createEl("p", { cls: "vam-next-status" });
    confirm.addEventListener("click", () => { void this.run(research, confirm, async () => {
      const controller = this.taskController;
      const selected = await researchPicker?.ready();
      if (this.closed || !controller || controller.signal.aborted) return;
      const options: TaskOptions = { referenceGroups: selected?.groups ?? [], outputLanguage: languageSelect.value as Settings["language"], researchMode: selected?.webSearch ? "research" : "local", researchDepth: (radios.find(radio => radio.checked)?.value || "normal") as ResearchDepth, visualMode: selected?.imageSearch ? "auto" : "off", requirements: this.requirements(), signal: controller.signal, onProgress: message => { if (!this.closed && !controller.signal.aborted) research.querySelector<HTMLElement>(".vam-next-status")?.setText(message); } };
      let launchAccepted = false;
      let launchFailed = false;
      const release = (): void => { if (this.taskController === controller) { this.taskSignal = undefined; this.taskController = undefined; } if (!this.closed) { const cancel = research.querySelector<HTMLButtonElement>(".vam-task-cancel"); if (cancel) cancel.hidden = true; } };
      const accepted = (): void => {
        if (this.closed || controller.signal.aborted || this.taskController !== controller) return;
        this.taskSignal = undefined; this.taskController = undefined;
        const cancel = research.querySelector<HTMLButtonElement>(".vam-task-cancel"); if (cancel) cancel.hidden = true;
        launchAccepted = true;
        this.close();
      };
      await this.research(options, "", () => { if (this.closed) return; release(); this.close(); }, message => { if (this.closed) { new Notice(message); return; } release(); launchFailed = true; this.failedAi(research, confirm, message); }, accepted);
      if (!this.closed && !launchAccepted && !launchFailed) {
        release();
        this.failed(research, confirm, t("ui.ai_task_cancelled"));
      }
    }); });
    const expandPanel = this.contentEl.createDiv("vam-next-research vam-next-choice");
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
    const childrenInput = childrenLabel.createEl("input", { type: "number", attr: { min: "1", max: "15", step: "1", value: "2" } }); childrenInput.value = "2";
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
        totalHint.setText(quickError || t("ui.topics_by_level_0_1_total", shape.counts.map(String).join(" → "), shape.total.toString()));
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
      const options: TaskOptions = { referenceGroups: selected?.groups ?? [], outputLanguage: languageSelect.value as Settings["language"], requirements: this.requirements(), researchMode: selected?.webSearch ? "research" : "local", multiLayer, shallowResearch: shallow.checked, researchDepth: "fast", visualMode: shallow.checked && selected?.imageSearch ? "auto" : "off", signal: this.taskSignal, onProgress: message => expandPanel.querySelector<HTMLElement>(".vam-next-status")?.setText(message) };
      if (multiLayer) {
        const layers = Number(layersInput.value), firstLayerCount = Number(firstInput.value), childrenPerParent = Number(childrenInput.value);
        const shape = quickShape(layers, firstLayerCount, childrenPerParent);
        if (shape.total > BigInt(15)) throw new Error(t("ui.this_would_create_0_subtopics_exceeding_the_limit_of_15_redu", shape.total.toString()));
        options.layers = layers; options.firstLayerCount = firstLayerCount; options.childrenPerParent = layers === 1 ? 1 : childrenPerParent;
        await this.expand(options, "", () => {}, (message, retryable) => { if (retryable === false) { this.failed(expandPanel, expandButton, message); expandButton.disabled = true; } else this.failedAi(expandPanel, expandButton, message); }, () => this.close(), () => { this.taskSignal = undefined; this.taskController = undefined; this.close(); });
        return;
      }
      await this.expand(options, "", (items, create) => this.proposals(expandPanel, items, create, expandButton, consumed, options), (message, retryable) => { consumed(); if (retryable === false) this.failed(expandPanel, expandButton, message); else this.failedAi(expandPanel, expandButton, message); if (retryable === false) expandButton.disabled = true; }, () => this.close(), () => { this.taskSignal = undefined; this.taskController = undefined; this.close(); });
    }, multiLayer || !this.pendingCount); });
    const synthesizePanel = this.contentEl.createDiv("vam-next-research vam-next-choice");
    synthesizePanel.createEl("p", { text: this.childrenCount ? t("ui.ai_suggests_synthesis_angles_first_the_parent_topic_changes") : t("ui.this_topic_has_no_direct_subtopics_you_can_choose_other_note") });
    {
      const synthesisContent = renderSynthesisContent(synthesizePanel, this.modelSettings?.sources?.synthesisTopics ?? []);
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
        const content: SynthesisContent = synthesisContent.value === "summary" ? "summary" : "full";
        synthesisContent.disabled = true;
        const selected = await synthesisPicker?.ready();
        const options: TaskOptions = { synthesisContent: content, referenceGroups: selected?.groups ?? [], outputLanguage: languageSelect.value as Settings["language"], requirements: this.requirements(), researchMode: selected?.webSearch ? "research" : "local", researchDepth: this.depth, visualMode: selected?.imageSearch ? "auto" : "off", signal: this.taskSignal, onProgress: message => synthStatus.setText(message) };
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
      }, showDraft, message => this.failedAi(synthesizePanel, synthButton, message)); }); });
    }
    show = mode => {
      for (const [name, button, panel] of [["research", researchCard, research], ["expand", expandCard, expandPanel], ["synthesize", synthesizeCard, synthesizePanel]] as const) {
        button.classList.toggle("is-active", name === mode); button.setAttr("aria-pressed", name === mode ? "true" : "false");
        panel.style.display = name === mode ? "" : "none";
      }
      panelTitle.setText(t(mode === "expand" ? "ui.expand_this_topic" : mode === "synthesize" ? "ui.synthesize_subtopic_findings" : "ui.research_this_topic"));
      confirm.hidden = mode !== "research";
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
class ChildProposalModal extends Modal {
  constructor(app: App, private suggestions: Suggestion[], private submit: (items: Suggestion[]) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t("ui.ai_subtopic_proposals"));
    this.contentEl.createEl("p", { text: t("ui.select_subtopics_to_create_you_can_edit_their_names_and_task") });
    const rows: { item: Suggestion; check: HTMLInputElement; title: HTMLInputElement; task: HTMLTextAreaElement; contribution: HTMLTextAreaElement }[] = [];
    for (const item of this.suggestions) {
      const row = this.contentEl.createDiv("vam-proposal");
      if (item.parentTitle) row.createEl("p", { text: t("ui.child_of_0", item.parentTitle) });
      const check = row.createEl("input", { type: "checkbox" }); check.checked = true; check.setAttr("aria-label", t("ui.select_proposal_0", item.title));
      const titleField = row.createEl("label", { cls: "vam-proposal-field" }); titleField.createSpan({ text: t("ui.subtopic_name") });
      const title = titleField.createEl("input", { type: "text", value: item.title }); title.setAttr("aria-label", t("ui.proposal_name"));
      const taskField = row.createEl("label", { cls: "vam-proposal-field" }); taskField.createSpan({ text: t("ui.research_task") });
      const task = taskField.createEl("textarea", { text: item.task }); task.rows = 2; task.setAttr("aria-label", t("ui.proposal_task"));
      const contributionField = row.createEl("label", { cls: "vam-proposal-field" }); contributionField.createSpan({ text: t("ui.contribution_to_the_parent_topic") });
      const contribution = contributionField.createEl("textarea", { text: item.contribution }); contribution.rows = 2; contribution.placeholder = t("ui.contribution_to_the_parent_topic"); contribution.setAttr("aria-label", t("ui.contribution_to_the_parent_topic"));
      rows.push({ item, check, title, task, contribution });
    }
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
  private deletedMap: { path: string; content: string; map: MapDocument; deleted: boolean; deleteAction?: Action } | null = null;
  private integrationTask: { title: string; goal: string; rules: string; sources: MapNode[]; options: TaskOptions; mapPath: string; mapId: string; sourceContent: string; controller: AbortController; state: "running" | "draft" | "failed" | "cancelled"; progress: string; draft?: AiResult } | null = null;
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
  private mindSearchViewEpoch = 0;
  private mapOpenEpoch = 0;
  private headerTitle = "";
  private builtIn = false;
  private showSampleTour = false;
  private sampleTourStep = 0;
  private readonly mindSearchRuns: MindSearchRunStore;
  private readonly mindSearchManual: MindSearchManualFlow;
  private readonly mindSearchRecovery: MindSearchManualFlow;
  private mindSearchBusy = false;
  private mindSearchController: AbortController | null = null;
  private mindSearchActiveQuestionNodeId: string | null = null;
  private mindSearchActivityKind: "planning" | "research" | "clarifying" | null = null;
  private mindSearchFailedReports = new Map<string, { runId: string; diagnosticNotePath: string }>();
  private mindSearchAnswerRequestIds = new Map<string, string>();
  constructor(leaf: WorkspaceLeaf, private plugin: VisualAgentMapPlugin) {
    super(leaf);
    this.mindSearchRuns = new MindSearchRunStore(plugin.repo);
    this.mindSearchManual = new MindSearchManualFlow(plugin.repo, this.mindSearchRuns, (context, model, reasoning, signal, onWebSearchEvent) => plugin.askModel(context, model, reasoning, signal, undefined, undefined, onWebSearchEvent), undefined, async <T>(operation: () => Promise<T>): Promise<T> => {
      let result!: T; await plugin.mutate(async () => { result = await operation(); }); return result;
    });
    // openMapInMutation already owns the repository queue. Startup recovery must persist
    // directly within that scope instead of attempting to enqueue the same operation again.
    this.mindSearchRecovery = new MindSearchManualFlow(plugin.repo, this.mindSearchRuns, (context, model, reasoning, signal, onWebSearchEvent) => plugin.askModel(context, model, reasoning, signal, undefined, undefined, onWebSearchEvent));
  }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.map?.title ?? "Visual Agent Map"; }
  getIcon(): string { return "brain-circuit"; }
  getState(): Record<string, unknown> { return this.builtIn ? { sample: BUILTIN_SAMPLE_ID } : { file: this.path }; }
  async setState(state: Record<string, unknown>, result: { history: boolean }): Promise<void> {
    if (state.sample === BUILTIN_SAMPLE_ID && !this.builtIn) await this.openBuiltInSample();
    else if (typeof state.file === "string" && state.file !== this.path) await this.openMap(state.file);
    await super.setState(state, result);
  }
  async onOpen(): Promise<void> {
    this.closed = false;
    const epoch = ++this.mindSearchViewEpoch;
    this.mapOpenEpoch++;
    this.contentEl.addClass("vam-view"); this.contentEl.tabIndex = 0;
    this.registerDomEvent(this.contentEl, "keydown", event => {
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); this.enqueue(() => this.travel(event.shiftKey)); }
      if (event.key === "Escape") { this.selected = null; this.multiSelected.clear(); this.integrationMode = false; this.render(); }
    });
    await this.plugin.ready;
    if (this.closed || this.mindSearchViewEpoch !== epoch) return;
    if (!this.path && !this.builtIn) {
      if (this.plugin.consumeFirstInstallSample()) await this.openBuiltInSample();
      else if (!this.plugin.repo.workspaceExists()) this.render();
      else { const files = await this.plugin.repo.mapFiles(); if (this.closed || this.mindSearchViewEpoch !== epoch) return; if (files.length) {
        let defaultPath = files[0].path;
        for (const file of files) {
          let candidate: MapDocument;
          try { candidate = await this.plugin.repo.readMap(file.path); } catch { continue; }
          if (this.closed || this.mindSearchViewEpoch !== epoch) return;
          if (!candidate.mindSearch) { defaultPath = file.path; break; }
        }
        await this.openMap(defaultPath);
      } else this.render(); }
    }
  }
  async onClose(): Promise<void> {
    this.closed = true;
    this.mindSearchViewEpoch++;
    this.mapOpenEpoch++;
    const controller = this.mindSearchController;
    this.mindSearchController = null;
    this.mindSearchBusy = false;
    this.mindSearchActiveQuestionNodeId = null; this.mindSearchActivityKind = null;
    controller?.abort();
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    if (this.hoverTimer !== null) window.clearTimeout(this.hoverTimer);
    this.hoverCard?.remove();
    if (this.viewportTimer !== null) { window.clearTimeout(this.viewportTimer); await this.persist(); }
  }
  private mindSearchViewIsCurrent(epoch: number, mapPath: string): boolean { return !this.closed && this.mindSearchViewEpoch === epoch && this.path === mapPath; }
  async refreshFromPlugin(): Promise<void> {
    if (this.builtIn) {
      const sample = builtInSample(this.plugin.settings.language);
      if (this.map) sample.map.viewport = { ...this.map.viewport };
      this.map = sample.map; this.notes = sample.notes; this.renderPreservingFocus(); return;
    }
    await this.hydrate(); this.renderPreservingFocus();
  }
  private renderPreservingFocus(): void {
    if (typeof document === "undefined" || !this.contentEl.contains(document.activeElement)) { this.render(); return; }
    const focusedContainer = document.activeElement === this.contentEl;
    const before = Array.from(this.contentEl.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])"));
    const activeIndex = before.indexOf(document.activeElement as HTMLElement);
    const active = document.activeElement as HTMLInputElement;
    const selection = active.tagName === "INPUT" || active.tagName === "TEXTAREA" ? [active.selectionStart, active.selectionEnd] as const : null;
    this.render();
    const after = Array.from(this.contentEl.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])"));
    const target = after[activeIndex];
    if (focusedContainer) this.contentEl.focus(); else target?.focus();
    if (selection && (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") && selection[0] !== null && selection[1] !== null) (target as HTMLInputElement).setSelectionRange(selection[0], selection[1]);
  }
  syncOutline(): void { this.plugin.syncOutline(this.builtIn ? null : this.map, this.notes, this.builtIn); }
  private enqueue(work: () => Promise<void>): void { void this.plugin.mutate(work).catch(() => {}); }
  private async persist(): Promise<void> { if (!this.builtIn && this.map && this.path) await this.plugin.repo.saveMap(this.path, this.map); }
  private async hydrate(isCurrent: () => boolean = () => true): Promise<void> {
    this.mindSearchFailedReports.clear();
    if (this.builtIn) { if (isCurrent()) this.notes = builtInSample(this.plugin.settings.language).notes; return; }
    const loaded = new Map<string, Note>();
    for (const node of this.map?.nodes ?? []) {
      if (!isCurrent()) return;
      try { loaded.set(node.id, await this.plugin.repo.readNote(node.path)); } catch { /* A missing note remains visible and removable on the map. */ }
    }
    if (!isCurrent()) return;
    this.notes = loaded;
    await this.hydrateFailedReportTargets(isCurrent);
  }
  private async hydrateFailedReportTargets(isCurrent: () => boolean): Promise<void> {
    const map = this.map, mapPath = this.path;
    if (!mapPath || !map?.mindSearch) return;
    const failed = map.mindSearch.runs.some(run => run.attempts.find(item => item.id === run.currentAttemptId)?.status === "failed");
    if (!failed) return;
    const notesFolder = this.plugin.repo.topicFolder(mapPath, "Notes"), candidates: Array<{ path: string; note: Note }> = [];
    for (const file of this.plugin.repo.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(`${notesFolder}/`)) continue;
      if (!isCurrent()) return;
      try { candidates.push({ path: file.path, note: await this.plugin.repo.readNote(file.path) }); } catch { /* Unreadable notes cannot authorize a retry action. */ }
    }
    if (!isCurrent()) return;
    this.mindSearchFailedReports.clear();
    for (const [questionNodeId, target] of matchMindSearchFailedReportTargets(map, candidates)) this.mindSearchFailedReports.set(questionNodeId, target);
  }
  async openMap(path: string): Promise<void> {
    await this.plugin.mutate(() => this.openMapInMutation(path));
  }
  private async openMapInMutation(path: string): Promise<void> {
    const viewEpoch = this.mindSearchViewEpoch, openEpoch = ++this.mapOpenEpoch;
    const isCurrent = () => !this.closed && this.mindSearchViewEpoch === viewEpoch && this.mapOpenEpoch === openEpoch;
    if (!isCurrent()) return;
    if (this.viewportTimer !== null) { window.clearTimeout(this.viewportTimer); this.viewportTimer = null; await this.persist(); if (!isCurrent()) return; }
    let map = await this.plugin.repo.readMap(path);
    if (!isCurrent()) return;
    if (map.mindSearch?.creationId && map.mindSearch.rootDraft) {
      const resumed = await createMindSearchMap(this.plugin.repo, this.plugin.settings.cliModel, {
        requestId: map.mindSearch.creationId,
        topic: map.title,
        context: map.mindSearch.rootDraft.context,
        model: map.mindSearch.rootDraft.model,
        reasoning: map.mindSearch.rootDraft.reasoning
      });
      if (!isCurrent()) return;
      map = resumed.map;
    }
    if (map.mindSearch?.questionDraft) { await this.mindSearchRecovery.recoverQuestionDraft(path); if (!isCurrent()) return; map = await this.plugin.repo.readMap(path); if (!isCurrent()) return; }
    if (map.mindSearch) {
      await this.mindSearchRuns.recoverPending(path);
      if (!isCurrent()) return;
      await this.mindSearchRuns.failInterrupted(path);
      if (!isCurrent()) return;
      await this.mindSearchRecovery.recoverPostReportQuestions(path);
      if (!isCurrent()) return;
      map = await this.plugin.repo.readMap(path);
      if (!isCurrent()) return;
    }
    const clearedQuestionEdges = clearQuestionConvergenceEdges(map);
    const repairedResultEdges = repairMindSearchResultConvergence(map);
    if (clearedQuestionEdges || repairedResultEdges) {
      await this.plugin.repo.saveMap(path, map);
      if (!isCurrent()) return;
    }
    if (this.builtIn || this.path !== path) this.plugin.closeStaleDetails();
    this.builtIn = false; this.path = path; this.map = map; this.integrationMode = false; this.selected = null; this.multiSelected.clear(); this.history.clear(); await this.hydrate(isCurrent); if (!isCurrent()) return; this.render();
    this.app.workspace.requestSaveLayout();
  }
  openMindSearchStart(): void {
    if (this.closed) return;
    const epoch = this.mindSearchViewEpoch;
    const isCurrent = () => !this.closed && this.mindSearchViewEpoch === epoch;
    const availableModels = typeof this.plugin.availableModels === "function" ? this.plugin.availableModels() : [];
    const configuredModel = this.plugin.settings.cliModel?.trim() || "gpt-5.6-luna";
    const configuredReasoning = normalizeReasoningLevel(this.plugin.settings.cliReasoning);
    const defaultReasoning = configuredReasoning === "medium" || configuredReasoning === "high" ? configuredReasoning : "low";
    const modelIds = [...new Set([configuredModel, ...availableModels].filter(Boolean))];
    const modelChoices = modelIds.map(id => ({ id, label: typeof this.plugin.modelLabel === "function" ? this.plugin.modelLabel(id) : id }));
    new MindSearchStartModal(this.app, input => this.plugin.mutate(async () => {
      if (!isCurrent()) return;
      await this.plugin.repo.ensureWorkspace();
      if (!isCurrent()) return;
      const created = await createMindSearchMap(this.plugin.repo, input.model, input);
      await this.plugin.rebuildDerivedData();
      if (!isCurrent()) return;
      await this.openMapInMutation(created.mapPath);
      if (!isCurrent() || this.path !== created.mapPath || this.map?.id !== created.map.id) return;
      this.selected = created.root.id; this.render(); this.focusNode(created.root);
    }), modelChoices, configuredModel, defaultReasoning, async () => {
      const states = await Promise.all([this.plugin.refreshModelDiscovery("codex"), this.plugin.refreshModelDiscovery("claude")]);
      const ready = states.filter(state => state.status === "ready");
      const models = [...new Set(ready.flatMap(state => state.models))];
      if (!ready.length || !models.length) throw new Error(states.map(state => state.error).filter(Boolean).join("; ") || t("ui.mindsearch_no_models_found"));
      const choices = models.map(id => ({ id, label: this.plugin.modelLabel(id) }));
      const errors = states.filter(state => state.status === "error").map(state => state.error).filter(Boolean);
      return errors.length ? { models: choices, message: t("ui.mindsearch_models_refreshed_partial_0", errors.join("; ")), preserveSelection: true } : choices;
    }).open();
  }
  private openNewMindMapModal(): void {
    new NameModal(this.app, t("ui.new_mind_map"), t("ui.new_mind_map_from_sample"), title => this.enqueue(async () => this.openMapInMutation(await this.plugin.repo.createMap(title)))).open();
  }
  async planMindSearchQuestion(parentNodeId: string, requestId: string, parentBranchId: string | null = null, signal?: AbortSignal): Promise<PlannerQuestionResult> {
    if (this.closed || !this.map || !this.path || this.builtIn) throw new Error("Open a saved MindSearch map before planning its next question.");
    const mapPath = this.path, epoch = this.mindSearchViewEpoch;
    const parent = this.notes.get(parentNodeId);
    if (!parent) throw new Error("The selected Planner question parent is unavailable.");
    const planned: PlannerQuestionResult = await this.mindSearchManual.planNextQuestion(mapPath, parentNodeId, parent.model, parent.reasoning, requestId, parentBranchId, signal);
    const isCurrent = () => this.mindSearchViewIsCurrent(epoch, mapPath) && !signal?.aborted;
    if (isCurrent()) {
      const latest = await this.plugin.repo.readMap(mapPath);
      if (isCurrent()) { this.map = latest; await this.hydrate(isCurrent); if (isCurrent()) { this.render(); this.syncOutline(); } }
    }
    return planned;
  }
  async submitMindSearchAnswer(questionNodeId: string, input: { requestId: string; selections: string[]; freeText: string }, signal?: AbortSignal): Promise<ManualResearchResult> {
    if (this.closed || !this.map || !this.path || this.builtIn) throw new Error("Open a saved MindSearch map before submitting an answer.");
    const mapPath = this.path, epoch = this.mindSearchViewEpoch;
    const isCurrent = () => this.mindSearchViewIsCurrent(epoch, mapPath) && !signal?.aborted;
    const question = this.notes.get(questionNodeId);
    if (!question) throw new Error("The selected Planner question is unavailable.");
    signal?.throwIfAborted();
    let recoveredBranches = 0;
    await this.plugin.mutate(async () => { recoveredBranches = await this.mindSearchRuns.recoverAnswerBranches(mapPath); });
    if (recoveredBranches) {
      if (!isCurrent()) return { status: "stale", branchId: "" };
      this.map = await this.plugin.repo.readMap(mapPath);
      await this.hydrate(isCurrent);
      if (!isCurrent()) return { status: "stale", branchId: "" };
      this.render(); this.syncOutline();
    }
    try {
      const outcome = await this.mindSearchManual.answerAndResearch(mapPath, questionNodeId, input, question.model, question.reasoning, signal, async activeQuestionNodeId => {
        if (!isCurrent()) return;
        this.mindSearchActiveQuestionNodeId = activeQuestionNodeId;
        this.map = await this.plugin.repo.readMap(mapPath);
        await this.hydrate(isCurrent);
        if (isCurrent()) this.render();
      });
      if (isCurrent()) {
        const latest = await this.plugin.repo.readMap(mapPath);
        if (isCurrent()) { this.map = latest; await this.hydrate(isCurrent); if (isCurrent()) { this.render(); this.syncOutline(); } }
      }
      return outcome;
    } catch (error) {
      if (isCurrent()) {
        const latest = await this.plugin.repo.readMap(mapPath);
        if (isCurrent()) { this.map = latest; await this.hydrate(isCurrent); if (isCurrent()) { this.render(); this.syncOutline(); } }
      }
      throw error;
    }
  }
  private renderMindSearchFailure(card: HTMLElement, branch: import("../../map-model").MindSearchBranchRecord): void {
    const runs = this.map?.mindSearch?.runs.filter(run => run.branchId === branch.id) ?? [];
    const latest = runs.at(-1), attempt = latest?.attempts.find(item => item.id === latest.currentAttemptId);
    if (attempt?.status !== "failed" && !branch.researchPlanError) return;
    const box = card.createDiv({ cls: "vam-mindsearch-failure" });
    box.createEl("p", { text: t("ui.mindsearch_failure_reason", attempt?.stopReason || branch.researchPlanError || t("ui.expansion_failed")) });
    const phase = attempt?.phase ?? branch.deliveryRecovery?.phase ?? (branch.researchPlanError ? "research-plan" : undefined);
    const labels: Record<string, string> = {
      "subtopic-research": t("ui.mindsearch_stage_subtopic"), "report-review": t("ui.mindsearch_stage_review"), "research-plan": t("ui.mindsearch_stage_plan"),
      "delivery-outline": t("ui.mindsearch_stage_delivery-outline"), "delivery-research": t("ui.mindsearch_stage_delivery-research"),
      "delivery-writing": t("ui.mindsearch_stage_delivery-writing"), "delivery-acceptance": t("ui.mindsearch_stage_delivery-acceptance")
    };
    if (phase && labels[phase]) box.createEl("p", { text: t("ui.mindsearch_failure_stage", labels[phase]) });
    const timedOut = /超過.*分鐘|timed?\s*out|timeout|exceeded.*minutes/i.test(attempt?.stopReason ?? branch.researchPlanError ?? "");
    const reason = attempt?.stopReason ?? branch.researchPlanError ?? "";
    const remedy = timedOut ? "ui.mindsearch_repair_timeout_hint" : /auth|login|sign.in|登入|unauthorized|quota|rate.limit/i.test(reason) ? "ui.mindsearch_repair_auth_hint" : /format|schema|JSON|marker|格式|分類/i.test(reason) ? "ui.mindsearch_repair_format_hint" : /search|搜尋|網路|network/i.test(reason) ? "ui.mindsearch_repair_search_hint" : "ui.mindsearch_repair_retry_hint";
    box.createEl("p", { text: t(remedy) });
    if (timedOut) this.button(box, t("ui.mindsearch_repair_timeout"), () => {
      const terminal = [...branch.results].reverse().find(result => result.kind !== "research");
      if (terminal) void this.continueMindSearchResearch(branch.questionNodeId, terminal.runId, 600_000);
      else void this.retryMindSearchSubtopics(branch.id, 600_000);
    }, this.mindSearchBusy).addClass("mod-cta");
  }

  private async retryMindSearchSubtopics(branchId: string, timeoutMs?: number): Promise<void> {
    const branch = this.map?.mindSearch?.branches.find(item => item.id === branchId), question = branch && this.map?.nodes.find(item => item.id === branch.questionNodeId);
    const note = question && this.notes.get(question.id);
    if (this.closed || !this.path || !branch || !question || !note || this.mindSearchBusy) return;
    const branchRuns = (this.map?.mindSearch?.runs ?? []).filter(item => item.branchId === branch.id);
    if (branchRuns.some(run => { const attempt = run.attempts.find(item => item.id === run.currentAttemptId); return attempt?.status === "running" || attempt?.status === "saving"; })) return;
    const terminal = branch.results.some(result => result.kind !== "research");
    if (terminal) return;
    const epoch = this.mindSearchViewEpoch, mapPath = this.path, controller = new AbortController();
    this.mindSearchBusy = true; this.mindSearchController = controller; this.mindSearchActiveQuestionNodeId = question.id; this.mindSearchActivityKind = "research"; this.render();
    try {
      if (timeoutMs) await this.plugin.mutate(() => this.mindSearchRuns.configureRetryTimeout(mapPath, branch.id, timeoutMs));
      const result = branch.researchPlan
        ? await this.mindSearchManual.resumeAnswerResearch(mapPath, branch.id, note.model, note.reasoning, controller.signal)
        : await this.mindSearchManual.retryAnswerResearch(mapPath, branch.id, note.model, note.reasoning, controller.signal);
      if (!this.mindSearchViewIsCurrent(epoch, mapPath) || this.mindSearchController !== controller) return;
      const latest = await this.plugin.repo.readMap(mapPath);
      if (this.mindSearchViewIsCurrent(epoch, mapPath)) { this.map = latest; await this.hydrate(() => this.mindSearchViewIsCurrent(epoch, mapPath)); this.render(); this.syncOutline(); }
      if (result.status === "waiting-user") new Notice(t("ui.mindsearch_waiting_user"));
      else if (result.status === "partial") new Notice(t("ui.mindsearch_research_partial"));
      else if (result.status === "completed") new Notice(t("ui.mindsearch_research_saved"));
      else if (result.status === "in-progress") new Notice(t("ui.mindsearch_research_already_running"));
    } catch (error) {
      if (!this.mindSearchViewIsCurrent(epoch, mapPath) || this.mindSearchController !== controller) return;
      if (controller.signal.aborted) new Notice(t("ui.research_stopped_existing_content_was_preserved"));
      else new Notice(error instanceof Error ? error.message : String(error));
      const latest = await this.plugin.repo.readMap(mapPath);
      if (this.mindSearchViewIsCurrent(epoch, mapPath)) { this.map = latest; await this.hydrate(() => this.mindSearchViewIsCurrent(epoch, mapPath)); this.render(); this.syncOutline(); }
    } finally {
      if (this.mindSearchController === controller) { this.mindSearchBusy = false; this.mindSearchController = null; this.mindSearchActiveQuestionNodeId = null; this.mindSearchActivityKind = null; if (this.mindSearchViewIsCurrent(epoch, mapPath)) this.render(); }
    }
  }
  async reviewMindSearchFailedReport(runId: string, diagnosticNotePath: string, signal?: AbortSignal): Promise<ManualResearchResult> {
    if (this.closed || !this.map || !this.path || this.builtIn) throw new Error("Open the saved MindSearch map before reviewing a failed report.");
    const mapPath = this.path, epoch = this.mindSearchViewEpoch;
    const outcome = await this.mindSearchManual.reviewFailedAttemptReport(mapPath, runId, diagnosticNotePath, signal);
    const isCurrent = () => this.mindSearchViewIsCurrent(epoch, mapPath) && !signal?.aborted;
    if (isCurrent()) {
      const latest = await this.plugin.repo.readMap(mapPath);
      if (isCurrent()) { this.map = latest; await this.hydrate(isCurrent); if (isCurrent()) { this.render(); this.syncOutline(); } }
    }
    return outcome;
  }
  private async planMindSearchFromSelection(nodeId = this.selected): Promise<void> {
    const node = this.map?.nodes.find(item => item.id === nodeId);
    if (this.closed || !node || !this.path || !this.map?.mindSearch || this.mindSearchBusy) return;
    const epoch = this.mindSearchViewEpoch, mapPath = this.path, controller = new AbortController();
    const parentBranchId = this.map.mindSearch.branches.find(branch => branch.results.some(result => result.nodeId === node.id))?.id ?? null;
    this.mindSearchBusy = true; this.mindSearchController = controller; this.mindSearchActiveQuestionNodeId = node.id; this.mindSearchActivityKind = "planning"; this.render();
    try {
    const rootNote = this.notes.get(node.id);
    if (node.mindSearchKind === "topic" && rootNote && !rootNote.detail.includes("<!-- mindsearch-intake-complete -->")) {
      this.mindSearchActivityKind = "clarifying"; this.render();
      const questions = await this.mindSearchManual.prepareClarification(rootNote, controller.signal);
      if (!this.mindSearchViewIsCurrent(epoch, mapPath) || controller.signal.aborted) return;
      if (questions.length) {
        new MindSearchClarificationModal(this.app, questions, async answers => {
          if (!this.mindSearchViewIsCurrent(epoch, mapPath)) throw new Error("Reopen the original MindSearch map to continue.");
          await this.plugin.mutate(async () => {
            const latest = await this.plugin.repo.readNote(node.path);
            if (!latest.detail.includes("<!-- mindsearch-intake-complete -->")) {
              await this.plugin.repo.updateNote(node.path, { detail: latest.detail + "\n\n<!-- mindsearch-intake-complete -->\n## " + (this.plugin.settings.language === "en" ? "Initial user clarification" : "開始前條件釐清") + "\n\n" + answers });
            }
          });
          await this.hydrate();
          void this.planMindSearchFromSelection(node.id);
        }, this.plugin.settings.language === "en").open();
        return;
      }
      await this.plugin.mutate(async () => {
        const latest = await this.plugin.repo.readNote(node.path);
        await this.plugin.repo.updateNote(node.path, { detail: latest.detail + "\n\n<!-- mindsearch-intake-complete -->" });
      });
      await this.hydrate();
    }
    this.mindSearchActivityKind = "planning"; this.render();
    const result = await this.planMindSearchQuestion(node.id, randomUUID(), parentBranchId, controller.signal);
      if (!this.mindSearchViewIsCurrent(epoch, mapPath) || this.mindSearchController !== controller) return;
      if (result.status === "question") { this.selected = result.node.id; this.render(); this.focusNode(result.node); new Notice(t("ui.mindsearch_question_ready")); }
      else if (result.outcome) {
        const outcome = result.outcome;
        if (outcome.status === "partial") new Notice(t("ui.mindsearch_research_partial"));
        else if (outcome.status === "waiting-user") { const question = this.map?.nodes.find(item => item.id === outcome.questionNodeId); if (question) { this.selected = question.id; this.render(); this.focusNode(question); } new Notice(t("ui.mindsearch_waiting_user")); }
        else if (outcome.status === "completed") new Notice(t("ui.mindsearch_research_saved"));
        else if (outcome.status === "in-progress") new Notice(t("ui.mindsearch_research_already_running"));
        else new Notice(t("ui.mindsearch_research_result_stale"));
      } else new Notice(t("ui.mindsearch_no_question_needed"));
    } catch (error) {
      if (!this.mindSearchViewIsCurrent(epoch, mapPath) || this.mindSearchController !== controller) return;
      if (controller.signal.aborted) new Notice(t("ui.research_stopped_existing_content_was_preserved"));
      else new Notice(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.mindSearchController === controller) { this.mindSearchBusy = false; this.mindSearchController = null; this.mindSearchActiveQuestionNodeId = null; this.mindSearchActivityKind = null; if (this.mindSearchViewIsCurrent(epoch, mapPath)) this.render(); }
    }
  }
  private async retryMindSearchFromSavedReport(questionNodeId: string): Promise<void> {
    const target = this.mindSearchFailedReports.get(questionNodeId), mapPath = this.path, epoch = this.mindSearchViewEpoch;
    if (this.closed || !target || !mapPath || !this.map?.mindSearch || this.mindSearchBusy || this.builtIn) return;
    const run = this.map.mindSearch.runs.find(item => item.id === target.runId);
    const currentAttempt = run?.attempts.find(item => item.id === run.currentAttemptId);
    const branch = run && this.map.mindSearch.branches.find(item => item.id === run.branchId);
    if (!run || currentAttempt?.status !== "failed" || branch?.questionNodeId !== questionNodeId) {
      this.mindSearchFailedReports.delete(questionNodeId); this.render(); return;
    }
    const controller = new AbortController();
    this.mindSearchBusy = true; this.mindSearchController = controller; this.mindSearchActiveQuestionNodeId = questionNodeId; this.mindSearchActivityKind = "research"; this.render();
    try {
      const result = await this.reviewMindSearchFailedReport(target.runId, target.diagnosticNotePath, controller.signal);
      if (!this.mindSearchViewIsCurrent(epoch, mapPath) || this.mindSearchController !== controller) return;
      if (result.status === "waiting-user") {
        const question = this.map?.nodes.find(item => item.id === result.questionNodeId);
        if (question) { this.selected = question.id; this.render(); this.focusNode(question); }
        new Notice(t("ui.mindsearch_waiting_user"));
      } else if (result.status === "partial") new Notice(t("ui.mindsearch_research_partial"));
      else if (result.status === "completed") new Notice(t("ui.mindsearch_research_saved"));
      else if (result.status === "in-progress") new Notice(t("ui.mindsearch_research_already_running"));
      else new Notice(t("ui.mindsearch_research_result_stale"));
    } catch (error) {
      if (!this.mindSearchViewIsCurrent(epoch, mapPath) || this.mindSearchController !== controller) return;
      if (controller.signal.aborted) new Notice(t("ui.research_stopped_existing_content_was_preserved"));
      else new Notice(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.mindSearchController === controller) { this.mindSearchBusy = false; this.mindSearchController = null; this.mindSearchActiveQuestionNodeId = null; this.mindSearchActivityKind = null; if (this.mindSearchViewIsCurrent(epoch, mapPath)) this.render(); }
    }
  }
  private async continueMindSearchResearch(questionNodeId: string, runId: string, timeoutMs?: number): Promise<void> {
    const mapPath = this.path, epoch = this.mindSearchViewEpoch;
    if (this.closed || !mapPath || !this.map?.mindSearch || this.mindSearchBusy || this.builtIn) return;
    const run = this.map.mindSearch.runs.find(item => item.id === runId);
    const branch = run && this.map.mindSearch.branches.find(item => item.id === run.branchId);
    if (!run || branch?.questionNodeId !== questionNodeId) return;
    const controller = new AbortController();
    this.mindSearchBusy = true; this.mindSearchController = controller; this.mindSearchActiveQuestionNodeId = questionNodeId; this.mindSearchActivityKind = "research"; this.render();
    const isCurrent = () => this.mindSearchViewIsCurrent(epoch, mapPath) && this.mindSearchController === controller;
    try {
      if (timeoutMs && branch) await this.plugin.mutate(() => this.mindSearchRuns.configureRetryTimeout(mapPath, branch.id, timeoutMs));
      const result = await this.mindSearchManual.continuePartial(mapPath, runId, undefined, undefined, controller.signal);
      if (!isCurrent()) return;
      if (result.status === "waiting-user") new Notice(t("ui.mindsearch_waiting_user"));
      else if (result.status === "partial") new Notice(t("ui.mindsearch_research_partial"));
      else if (result.status === "completed") new Notice(t("ui.mindsearch_research_saved"));
      else if (result.status === "in-progress") new Notice(t("ui.mindsearch_research_already_running"));
    } catch (error) {
      if (!isCurrent()) return;
      new Notice(controller.signal.aborted ? t("ui.research_stopped_existing_content_was_preserved") : error instanceof Error ? error.message : String(error));
    } finally {
      if (this.mindSearchController === controller) {
        try {
          if (this.mindSearchViewIsCurrent(epoch, mapPath)) {
            const latest = await this.plugin.repo.readMap(mapPath);
            if (isCurrent()) { this.map = latest; await this.hydrate(isCurrent); }
          }
        } catch (error) {
          if (isCurrent()) new Notice(error instanceof Error ? error.message : String(error));
        } finally {
          if (this.mindSearchController === controller) {
            this.mindSearchBusy = false; this.mindSearchController = null; this.mindSearchActiveQuestionNodeId = null; this.mindSearchActivityKind = null;
            if (this.mindSearchViewIsCurrent(epoch, mapPath)) { this.render(); this.syncOutline(); }
          }
        }
      }
    }
  }
  private openMindSearchAnswer(node: MapNode): void {
    const contract = node.mindSearchQuestion, note = this.notes.get(node.id);
    if (this.closed || !contract || !note || this.mindSearchBusy) return;
    const epoch = this.mindSearchViewEpoch, mapPath = this.path, requestId = contract.requestId;
    if (mapPath && (this.map?.mindSearch?.branches.filter(branch => branch.questionNodeId === node.id).length ?? 0) > 1) {
      void this.plugin.mutate(async () => {
        const repaired = await this.mindSearchRuns.recoverAnswerBranches(mapPath);
        if (!repaired || !this.mindSearchViewIsCurrent(epoch, mapPath)) return;
        this.map = await this.plugin.repo.readMap(mapPath);
        await this.hydrate(() => this.mindSearchViewIsCurrent(epoch, mapPath));
        if (!this.mindSearchViewIsCurrent(epoch, mapPath)) return;
        this.render();
        const current = this.map?.nodes.find(item => item.id === node.id);
        if (current) this.openMindSearchAnswer(current);
      }).catch(error => { if (this.mindSearchViewIsCurrent(epoch, mapPath)) new Notice(error instanceof Error ? error.message : String(error)); });
      return;
    }
    new MindSearchAnswerModal(this.app, note.summary, contract.options, async input => {
      const currentQuestion = this.map?.nodes.find(item => item.id === node.id);
      if (!this.mindSearchViewIsCurrent(epoch, mapPath) || currentQuestion?.mindSearchQuestion?.requestId !== requestId || this.mindSearchBusy) return;
      const controller = new AbortController();
      this.mindSearchBusy = true; this.mindSearchController = controller; this.mindSearchActiveQuestionNodeId = node.id; this.mindSearchActivityKind = "research"; this.render();
      try {
        const result = await this.submitMindSearchAnswer(node.id, input, controller.signal);
        if (!this.mindSearchViewIsCurrent(epoch, mapPath) || this.mindSearchController !== controller) return;
        this.mindSearchAnswerRequestIds.delete(node.id);
        if (result.status === "waiting-user") {
          const question = this.map?.nodes.find(item => item.id === result.questionNodeId);
          if (question) { this.selected = question.id; this.render(); this.focusNode(question); }
          new Notice(t("ui.mindsearch_waiting_user"));
        }
        else if (result.status === "partial") new Notice(t("ui.mindsearch_research_partial"));
        else if (result.status === "completed") new Notice(t("ui.mindsearch_research_saved"));
        else if (result.status === "in-progress") new Notice(t("ui.mindsearch_research_already_running"));
        else new Notice(t("ui.mindsearch_research_result_stale"));
      } catch (error) {
        if (!this.mindSearchViewIsCurrent(epoch, mapPath) || this.mindSearchController !== controller) throw error;
        this.mindSearchAnswerRequestIds.set(node.id, input.requestId);
        if (controller.signal.aborted) new Notice(t("ui.research_stopped_existing_content_was_preserved"));
        else new Notice(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        if (this.mindSearchController === controller) { this.mindSearchBusy = false; this.mindSearchController = null; this.mindSearchActiveQuestionNodeId = null; this.mindSearchActivityKind = null; if (this.mindSearchViewIsCurrent(epoch, mapPath)) this.render(); }
      }
    }, this.mindSearchAnswerRequestIds.get(node.id) ?? randomUUID()).open();
  }
  async openBuiltInSample(forceTour = false): Promise<void> {
    const viewEpoch = this.mindSearchViewEpoch, openEpoch = ++this.mapOpenEpoch;
    const isCurrent = () => !this.closed && this.mindSearchViewEpoch === viewEpoch && this.mapOpenEpoch === openEpoch;
    if (this.viewportTimer !== null) { window.clearTimeout(this.viewportTimer); this.viewportTimer = null; await this.persist(); }
    if (!isCurrent()) return;
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
  deleted(file: TFile): void { if (file.path === this.path) { this.map = null; this.path = ""; if (this.deletedMap?.path !== file.path) this.history.clear(); this.render(); } else this.changed(file); }
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
    const removableQuestions = new Set(node.mindSearchKind === "question" ? before.nodes.filter(item => ids.has(item.id) && item.mindSearchKind === "question").map(item => item.id) : []);
    this.assertMindSearchReferencesRemain(before, ids, false, removableQuestions);
    const removed = before.nodes.filter(item => ids.has(item.id)), moves: FileMove[] = [];
    try {
      for (const item of removed) {
        const target = await this.plugin.repo.moveUnique(item.path, this.plugin.repo.topicFolder(this.path, "Unassigned"));
        moves.push({ activePath: item.path, parkedPath: target, topicId: before.id, parkedState: "unassigned" });
        await this.plugin.repo.setLifecycle(target, before.id, "", "unassigned");
      }
      const after = clone(before); after.nodes = removeNodes(after.nodes, node.id, branch); this.removeMindSearchReferences(after, ids, before.nodes);
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
  private confirmRemoveNode(node: MapNode): void {
    new ChoiceModal(this.app, t("ui.remove_from_map"), t("ui.the_note_will_move_to_this_topic_s_unassigned_folder_you_can"), [
      ...(!this.map?.mindSearch || node.mindSearchKind !== "question" ? [{ label: t("ui.remove_only_this_node_children_become_roots"), action: () => this.enqueue(() => this.removeToUnassigned(node, false)) }] : []),
      { label: t("ui.remove_entire_branch"), action: () => this.enqueue(() => this.removeToUnassigned(node, true)) }
    ]).open();
  }
  private async removeSelected(): Promise<void> {
    if (!this.map) return;
    const before = clone(this.map), ids = new Set<string>();
    const roots = this.selectedRoots(), removableQuestions = new Set<string>();
    for (const root of roots) {
      const branchIds = new Set([root.id, ...descendants(before.nodes, root.id)]);
      for (const id of branchIds) ids.add(id);
      if (root.mindSearchKind === "question") for (const item of before.nodes) if (branchIds.has(item.id) && item.mindSearchKind === "question") removableQuestions.add(item.id);
    }
    this.assertMindSearchReferencesRemain(before, ids, false, removableQuestions);
    const removed = before.nodes.filter(node => ids.has(node.id)), moves: FileMove[] = [];
    try {
      for (const node of removed) {
        const target = await this.plugin.repo.moveUnique(node.path, this.plugin.repo.topicFolder(this.path, "Unassigned"));
        moves.push({ activePath: node.path, parkedPath: target, topicId: before.id, parkedState: "unassigned" });
        await this.plugin.repo.setLifecycle(target, before.id, "", "unassigned");
      }
      const after = clone(before); after.nodes = after.nodes.filter(node => !ids.has(node.id)); this.removeMindSearchReferences(after, ids, before.nodes);
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
    this.assertMindSearchReferencesRemain(this.map!, new Set(roots.map(root => root.id)), true);
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
  private assertMindSearchReferencesRemain(map: MapDocument, ids: Set<string>, moving = false, removableQuestionNodeIds = new Set<string>()): void {
    const data = map.mindSearch;
    if (!data) return;
    const protectedIds = new Set<string>();
    const removableBranchIds = new Set(data.branches.filter(branch => removableQuestionNodeIds.has(branch.questionNodeId)).map(branch => branch.id));
    for (const branch of data.branches) {
      if (!removableBranchIds.has(branch.id)) {
        protectedIds.add(branch.questionNodeId);
        for (const result of branch.results) protectedIds.add(result.nodeId);
      }
    }
    for (const draft of data.resultDrafts ?? []) if (!removableBranchIds.has(draft.branchId)) protectedIds.add(draft.nodeId);
    for (const pending of data.pendingCommits) if (!removableBranchIds.has(pending.branchId)) protectedIds.add(pending.nodeId);
    if (data.questionDraft && (ids.has(data.questionDraft.parentId) || removableBranchIds.has(data.questionDraft.parentBranchId ?? ""))) throw new Error("A MindSearch question is still being saved and cannot be removed yet.");
    if ((data.resultDrafts ?? []).some(draft => removableBranchIds.has(draft.branchId)) || data.pendingCommits.some(commit => removableBranchIds.has(commit.branchId))) throw new Error("A MindSearch result is still being saved and cannot be removed yet.");
    if ([...ids].some(id => protectedIds.has(id))) throw new Error(moving ? "MindSearch question and result nodes referenced by saved branches cannot be moved." : "MindSearch question and result nodes referenced by saved branches cannot be removed.");
    for (const run of data.runs) if (removableBranchIds.has(run.branchId) && run.attempts.some(attempt => attempt.status === "running" || attempt.status === "saving")) throw new Error("A MindSearch branch is still running and cannot be removed yet.");
  }
  private removeMindSearchReferences(map: MapDocument, removedNodeIds: Set<string>, originalNodes: MapNode[] = map.nodes): void {
    const data = map.mindSearch;
    if (!data) return;
    for (const question of originalNodes.filter(node => removedNodeIds.has(node.id) && node.mindSearchQuestion)) {
      const parent = map.nodes.find(node => node.id === question.parentId && !removedNodeIds.has(node.id));
      if (parent) parent.mindSearchDismissedQuestionRequestIds = [...new Set([...(parent.mindSearchDismissedQuestionRequestIds ?? []), question.mindSearchQuestion!.requestId])];
    }
    const removedBranchIds = new Set(data.branches.filter(branch => removedNodeIds.has(branch.questionNodeId)).map(branch => branch.id));
    data.branches = data.branches.filter(branch => !removedBranchIds.has(branch.id));
    for (const branch of data.branches) if (branch.parentBranchId && removedBranchIds.has(branch.parentBranchId)) branch.parentBranchId = null;
    data.runs = data.runs.filter(run => !removedBranchIds.has(run.branchId));
    if (data.resultDrafts) data.resultDrafts = data.resultDrafts.filter(draft => !removedBranchIds.has(draft.branchId) && !removedNodeIds.has(draft.nodeId));
    data.pendingCommits = data.pendingCommits.filter(commit => !removedBranchIds.has(commit.branchId) && !removedNodeIds.has(commit.nodeId));
    if (data.questionDraft && (removedNodeIds.has(data.questionDraft.parentId) || removedBranchIds.has(data.questionDraft.parentBranchId ?? ""))) delete data.questionDraft;
    for (const node of map.nodes) {
      if (node.mindSearchConvergesFromNodeIds) node.mindSearchConvergesFromNodeIds = node.mindSearchConvergesFromNodeIds.filter(id => !removedNodeIds.has(id));
      if (node.mindSearchQuestion?.parentBranchId && removedBranchIds.has(node.mindSearchQuestion.parentBranchId)) node.mindSearchQuestion.parentBranchId = null;
    }
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
    this.render();
  }
  private recordNoteWrite(path: string, before: Note, after: Note, fields: (keyof NotePatch)[], label: string): void {
    const oldValues: NotePatch = {}, newValues: NotePatch = {};
    for (const field of fields) {
      (oldValues as Record<string, unknown>)[field] = before[field];
      (newValues as Record<string, unknown>)[field] = after[field];
    }
    const restore = async (expected: NotePatch, replacement: NotePatch): Promise<void> => {
      const latest = await this.plugin.repo.readNote(path);
      for (const field of fields) if (JSON.stringify(latest[field]) !== JSON.stringify(expected[field])) throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
      await this.plugin.repo.updateNote(path, replacement);
    };
    this.history.push({ label, undo: () => restore(newValues, oldValues), redo: () => restore(oldValues, newValues) });
    this.updateHistoryButtons();
  }
  private openDetails(node: MapNode): void { void this.plugin.openDetails(this.plugin.repo.file(node.path)).catch(error => new Notice(error instanceof Error ? error.message : String(error))); }
  private async travel(redo: boolean): Promise<void> {
    const action = redo ? this.history.redo() : this.history.undo(); if (!action) return;
    try { await (redo ? action.redo() : action.undo()); await this.hydrate(); this.render(); } catch (error) { if (redo) this.history.undo(); else this.history.redo(); throw error; }
  }
  private updateHistoryButtons(): void { const undo = this.contentEl?.querySelector<HTMLButtonElement>("[data-history=undo]"), redo = this.contentEl?.querySelector<HTMLButtonElement>("[data-history=redo]"); if (undo) { undo.disabled = !this.history.canUndo; undo.setText(this.history.undoEntry?.label ? `${t("ui.undo")}: ${this.history.undoEntry.label}` : t("ui.undo")); } if (redo) { redo.disabled = !this.history.canRedo; redo.setText(this.history.redoEntry?.label ? `${t("ui.redo")}: ${this.history.redoEntry.label}` : t("ui.redo")); } }
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
  private mindSearchActiveForPath(path: string): boolean {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).some(leaf => {
      const view = leaf.view;
      if (!(view instanceof VisualAgentMapView) || view.path !== path || !view.map?.mindSearch) return false;
      return view.mindSearchBusy || view.map.mindSearch.runs.some(run => {
        const attempt = run.attempts.find(item => item.id === run.currentAttemptId);
        return attempt?.status === "running" || attempt?.status === "saving";
      });
    });
  }
  private renameCurrentMap(): void {
    if (!this.map) return;
    if (this.mindSearchActiveForPath(this.path)) { new Notice(t("ui.mindsearch_research_already_running")); return; }
    new NameModal(this.app, t("ui.rename_mind_map"), this.map.title, title => this.enqueue(async () => {
      if (!this.map) return;
      if (this.mindSearchActiveForPath(this.path)) { new Notice(t("ui.mindsearch_research_already_running")); return; }
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
        if (this.viewportTimer !== null) { window.clearTimeout(this.viewportTimer); this.viewportTimer = null; await this.persist(); }
        const path = this.path, file = this.plugin.repo.file(path), content = await this.app.vault.read(file), map = clone(this.map);
        this.deletedMap = { path, content, map, deleted: true };
        try { await this.app.fileManager.trashFile(file); }
        catch (error) { this.deletedMap = null; throw error; }
        this.map = null; this.path = ""; await this.plugin.rebuildDerivedData();
        const deleteAction: Action = {
          label: t("ui.delete_mind_map"),
          undo: async () => { await this.restoreDeletedMap(); },
          redo: async () => { await this.deleteRestoredMap(); }
        };
        this.deletedMap.deleteAction = deleteAction;
        this.history.push(deleteAction);
        this.render();
      }) }
    ]).open();
  }
  private async restoreDeletedMap(): Promise<void> {
    const deleted = this.deletedMap;
    if (!deleted?.deleted) return;
    if (this.app.vault.getAbstractFileByPath(deleted.path)) throw new Error(t("ui.restore_path_occupied"));
    await this.app.vault.create(deleted.path, deleted.content);
    deleted.deleted = false;
    this.builtIn = false;
    this.path = deleted.path;
    this.map = clone(deleted.map);
    await this.plugin.rebuildDerivedData();
    await this.hydrate();
    this.render();
  }
  private async deleteRestoredMap(): Promise<void> {
    const deleted = this.deletedMap;
    if (!deleted || deleted.deleted) return;
    const file = this.app.vault.getAbstractFileByPath(deleted.path);
    if (!(file instanceof TFile) || await this.app.vault.read(file) !== deleted.content) throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
    await this.app.fileManager.trashFile(file);
    deleted.deleted = true; this.path = ""; this.map = null;
    await this.plugin.rebuildDerivedData(); this.render();
  }
  private async restoreDeletedMapFromUi(): Promise<void> {
    if (this.viewportTimer !== null) { window.clearTimeout(this.viewportTimer); this.viewportTimer = null; await this.persist(); }
    if (this.history.undoEntry === this.deletedMap?.deleteAction) await this.travel(false);
    else {
      await this.restoreDeletedMap();
      this.history.clear();
      this.history.push({ label: t("ui.restore_deleted_map"), undo: () => this.deleteRestoredMap(), redo: () => this.restoreDeletedMap() });
      this.updateHistoryButtons();
    }
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
    this.plugin.syncOutline(this.builtIn ? null : this.map, this.notes, this.builtIn);
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
      ...topics.map(topic => ({ label: topic.title, description: t("ui.my_editable_mind_map"), action: () => this.enqueue(() => this.openMapInMutation(topic.mapPath)) }))
    ]).open(); }));
    if (this.builtIn) {
      this.button(toolbar, t("ui.show_tour_again"), () => { this.showSampleTour = true; this.render(); });
    } else if (this.map) {
      this.button(toolbar, t("ui.mind_map"), () => new NameModal(this.app, t("ui.new_mind_map"), t("ui.new_mind_map_from_sample"), title => this.enqueue(async () => this.openMapInMutation(await this.plugin.repo.createMap(title)))).open());
      const undo = this.button(toolbar, t("ui.undo"), () => this.enqueue(() => this.travel(false)), !this.history.canUndo); undo.dataset.history = "undo";
      const redo = this.button(toolbar, t("ui.redo"), () => this.enqueue(() => this.travel(true)), !this.history.canRedo); redo.dataset.history = "redo";
      this.updateHistoryButtons();
      this.button(toolbar, t("ui.more"), () => this.openMapActions());
    }
    const selectedNode = this.map?.nodes.find(node => node.id === this.selected);
    if (!this.builtIn && this.map?.mindSearch) {
      const statusbar = this.contentEl.createDiv(`vam-mindsearch-statusbar${this.mindSearchBusy ? " is-active" : ""}`);
      statusbar.setAttr("aria-live", "polite");
      const data = this.map.mindSearch;
      const questions = this.map.nodes.filter(node => node.mindSearchKind === "question");
      const pendingQuestion = questions.find(question => !data.branches.some(branch => branch.questionNodeId === question.id));
      const runningBranch = data.branches.find(branch => {
        const run = data.runs.find(item => item.branchId === branch.id);
        const attempt = run?.attempts.find(item => item.id === run.currentAttemptId);
        return attempt?.status === "running" || attempt?.status === "saving";
      });
      let stateText: string;
      let stateClass: string;
      if (this.mindSearchBusy) {
        const activeTitle = this.notes.get(this.mindSearchActiveQuestionNodeId ?? "")?.title ?? this.map.title;
        const planning = this.mindSearchActivityKind === "planning";
        stateText = this.mindSearchActivityKind === "clarifying"
          ? (this.plugin.settings.language === "en" ? "Preparing initial clarification…" : "正在準備開始前的條件釐清…")
          : t(planning ? "ui.mindsearch_status_planning_0" : "ui.mindsearch_status_researching_0", activeTitle);
        stateClass = "running";
      } else if (runningBranch) {
        const activeTitle = this.notes.get(runningBranch.questionNodeId)?.title ?? this.map.title;
        stateText = t("ui.mindsearch_status_researching_0", activeTitle); stateClass = "running";
      } else if (!questions.length) {
        stateText = t("ui.mindsearch_status_ready"); stateClass = "idea";
      } else if (pendingQuestion) {
        stateText = t("ui.mindsearch_status_waiting_answer_0", this.notes.get(pendingQuestion.id)?.title ?? ""); stateClass = "idea";
      } else if (data.branches.some(branch => branch.results.some(result => result.kind === "conclusion"))) {
        stateText = t("ui.mindsearch_status_complete"); stateClass = "completed";
      } else {
        stateText = t("ui.mindsearch_status_exploring"); stateClass = "idea";
      }
      statusbar.createSpan({ cls: "vam-mindsearch-status-title", text: "MindSearch" });
      statusbar.createSpan({ cls: `vam-mindsearch-status-value vam-status-${stateClass}`, text: stateText });
      if (this.mindSearchBusy) this.button(statusbar, t("ui.stop_research"), () => { this.mindSearchController?.abort(); });
      const attribution = this.contentEl.createDiv("vam-mindsearch-attribution");
      attribution.createSpan({ text: t("ui.mindsearch_attribution") });
      attribution.createEl("a", { text: t("ui.mindsearch_source_project"), href: "https://github.com/InternLM/MindSearch", attr: { target: "_blank", rel: "noopener noreferrer" } });
      attribution.createEl("a", { text: t("ui.mindsearch_source_paper"), href: "https://arxiv.org/abs/2407.20183", attr: { target: "_blank", rel: "noopener noreferrer" } });
    }
    if (!this.builtIn && this.map?.mindSearch && selectedNode?.mindSearchKind === "question" && selectedNode.mindSearchQuestion) {
      const actions = toolbar.createDiv("vam-mindsearch-actions");
      this.button(actions, t("ui.mindsearch_answer_question"), () => this.openMindSearchAnswer(selectedNode), this.mindSearchBusy);
      if (this.mindSearchFailedReports.has(selectedNode.id)) this.button(actions, t("ui.mindsearch_retry_saved_report"), () => { void this.retryMindSearchFromSavedReport(selectedNode.id); }, this.mindSearchBusy);
    }
    if (!this.map && (this.history.canUndo || this.history.canRedo)) {
      const undo = this.button(toolbar, t("ui.undo"), () => this.enqueue(() => this.travel(false)), !this.history.canUndo); undo.dataset.history = "undo";
      const redo = this.button(toolbar, t("ui.redo"), () => this.enqueue(() => this.travel(true)), !this.history.canRedo); redo.dataset.history = "redo";
      this.updateHistoryButtons();
    }
    if (this.deletedMap?.deleted) this.button(toolbar, t("ui.restore_deleted_map"), () => this.enqueue(() => this.restoreDeletedMapFromUi()));
    if (this.integrationTask && this.integrationTask.mapPath === this.path) {
      const task = this.integrationTask, state = this.contentEl.createDiv("vam-integration-progress");
      state.setAttr("aria-live", "polite");
      state.createSpan({ text: task.state === "running" ? task.progress || t("ui.integration_running") : task.state === "draft" ? t("ui.integration_draft_ready") : task.state === "failed" ? task.progress || t("ui.integration_failed") : t("ui.research_stopped_existing_content_was_preserved") });
      if (task.state === "running") this.button(state, t("ui.stop_research"), () => { task.controller.abort(); task.state = "cancelled"; this.render(); });
      if (task.state === "draft") this.button(state, t("ui.review_synthesis_draft"), () => this.reviewIntegratedDraft(task));
      if (task.state === "failed" || task.state === "cancelled") this.button(state, t("ui.try_again"), () => this.enqueue(() => this.createIntegratedNode(task.title, task.sources, task.goal, task.rules, task.options, true)));
    }
    if (!this.map) {
      const empty = this.contentEl.createDiv("vam-empty-state");
      empty.createEl("h2", { text: this.plugin.repo.workspaceExists() ? t("ui.no_map_open") : t("ui.agent_workspace_is_missing") });
      empty.createEl("p", { text: this.plugin.repo.workspaceExists() ? t("ui.open_or_create_map_hint") : t("ui.the_base_folders_can_be_safely_recreated_existing_notes_will") });
      const actions = empty.createDiv("vam-empty-actions");
      if (!this.plugin.repo.workspaceExists()) {
        this.button(actions, t("ui.reconnect_existing_workspace"), () => this.enqueue(() => this.plugin.offerWorkspaceReconnect())).addClass("mod-cta");
        this.button(actions, t("ui.repair_agent_workspace"), () => this.enqueue(() => this.plugin.repairWorkspace()));
      }
      this.button(actions, t("ui.create_a_new_mind_map"), () => this.openNewMindMapModal()).addClass("mod-cta");
      this.button(actions, t("ui.mindsearch_create_map"), () => this.openMindSearchStart());
      this.button(actions, t("ui.view_sample"), () => this.enqueue(() => this.openBuiltInSample(true)));
      if (this.deletedMap?.deleted) this.button(actions, t("ui.restore_deleted_map"), () => this.enqueue(() => this.restoreDeletedMapFromUi()));
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
      this.button(actions, t("ui.duplicate_to_my_workspace"), () => this.enqueue(async () => this.openMapInMutation(await this.plugin.duplicateBuiltInSample()))).addClass("mod-cta");
      this.button(actions, t("ui.create_an_empty_mind_map"), () => new NameModal(this.app, t("ui.new_mind_map"), t("ui.new_mind_map_from_sample"), title => this.enqueue(async () => this.openMapInMutation(await this.plugin.repo.createMap(title)))).open());
      if (!this.plugin.settings.models.trim()) this.button(actions, t("ui.check_codex"), () => this.enqueue(() => this.plugin.recheckCodex()));
    }
    const tools = this.contentEl.createDiv("vam-map-tools");
    if (!this.builtIn) {
      const mindSearchMode = !!this.map.mindSearch;
      if (!mindSearchMode) this.button(tools, t("ui.topic"), () => this.enqueue(() => this.addNode(null))).addClass("mod-cta");
      if (mindSearchMode) this.button(tools, t("ui.create_a_new_mind_map"), () => this.openNewMindMapModal());
      this.button(tools, t("ui.mindsearch_create_map"), () => this.openMindSearchStart());
      if (!mindSearchMode) this.button(tools, t("ui.organize"), () => this.enqueue(() => this.openOrganizer()));
      this.button(tools, t("ui.auto_layout"), () => this.enqueue(() => this.mapChange(map => { map.nodes = arrangeMap(map.nodes); }, false)));
      if (!mindSearchMode) {
        const integrate = this.button(tools, this.integrationMode ? t("ui.finish_topic_selection") : t("ui.select_topics"), () => { this.integrationMode = !this.integrationMode; this.multiSelected.clear(); this.selected = null; this.render(); });
        if (this.integrationMode) integrate.addClass("is-active");
      }
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
    if (!this.map.nodes.length) {
      const emptyMap = this.viewportEl.createDiv("vam-empty");
      emptyMap.createSpan({ text: t(this.map.mindSearch ? "ui.mindsearch_empty_map_hint" : "ui.this_mind_map_has_no_topics_click_topic_to_create_the_first") });
      if (!this.map.mindSearch) this.button(emptyMap, t("ui.topic"), () => this.enqueue(() => this.addNode(null)));
    }
    this.setupPan(); this.transform(); this.drawEdges();
    if (this.builtIn && this.selected) { const node = this.map.nodes.find(n => n.id === this.selected); if (node) this.renderInspector(workspace, node); }
  }
  private renderNode(node: MapNode): void {
    if (!this.stageEl) return;
    const note = this.notes.get(node.id), card = this.stageEl.createDiv({ cls: `vam-node${node.id === this.selected || this.multiSelected.has(node.id) ? " is-selected" : ""}` });
    if (node.mindSearchKind) card.setAttr("data-mindsearch-kind", node.mindSearchKind);
    if (node.mindSearchKind === "conclusion") {
      const background = createSvg("svg"); background.addClass("vam-conclusion-background");
      background.setAttribute("viewBox", "0 0 100 100"); background.setAttribute("preserveAspectRatio", "none"); background.setAttribute("aria-hidden", "true"); background.setAttribute("focusable", "false");
      const shape = createSvg("polygon"); shape.setAttribute("points", "25,0.5 75,0.5 99.5,50 75,99.5 25,99.5 0.5,50"); shape.setAttribute("vector-effect", "non-scaling-stroke");
      background.appendChild(shape); card.appendChild(background);
    }
    card.dataset.nodeId = node.id; card.style.left = `${node.x}px`; card.style.top = `${node.y}px`; card.tabIndex = 0; card.setAttr("aria-label", note?.title ?? t("ui.note_missing"));
    const header = card.createDiv("vam-node-header");
    if (this.integrationMode) {
      const select = header.createEl("input", { type: "checkbox" }); select.checked = this.multiSelected.has(node.id); select.setAttr("aria-label", note?.title ?? node.path);
      select.addEventListener("click", event => { event.stopPropagation(); if (select.checked) this.multiSelected.add(node.id); else this.multiSelected.delete(node.id); this.render(); });
    }
    const batch = this.plugin.expansionBatches.get(node.path);
    const active = this.plugin.running?.has(node.path) || this.plugin.quickExpandPending?.has(node.path);
    if (node.mindSearchKind === "question" && this.map?.mindSearch) {
      const status = mindSearchQuestionStatus(this.map, node.id, this.mindSearchActiveQuestionNodeId);
      const key: Record<MindSearchQuestionStatus, TranslationKey> = { running: "ui.mindsearch_branch_running", completed: "ui.mindsearch_branch_completed", partial: "ui.mindsearch_branch_partial", failed: "ui.mindsearch_branch_failed", cancelled: "ui.mindsearch_branch_cancelled", not_started: "ui.mindsearch_branch_not_started" };
      header.createSpan({ cls: `vam-status vam-mindsearch-question-status vam-status-${status === "running" ? "running" : status === "completed" ? "completed" : status === "not_started" ? "idea" : "error"}`, text: status === "not_started" && this.map.mindSearch.branches.some(branch => branch.questionNodeId === node.id) ? (this.plugin.settings.language === "en" ? "Answered · research not started" : "已回答・研究尚未開始") : t(key[status]) });
    } else if (node.mindSearchKind === "topic" && this.map?.mindSearch && this.map.mindSearch.branches.some(branch => branch.questionNodeId === node.id && !branch.parentBranchId)) {
      const status = mindSearchQuestionStatus(this.map, node.id, this.mindSearchActiveQuestionNodeId);
      const key: Record<MindSearchQuestionStatus, TranslationKey> = { running: "ui.mindsearch_branch_running", completed: "ui.mindsearch_branch_completed", partial: "ui.mindsearch_branch_partial", failed: "ui.mindsearch_branch_failed", cancelled: "ui.mindsearch_branch_cancelled", not_started: "ui.mindsearch_branch_not_started" };
      header.createSpan({ cls: `vam-status vam-mindsearch-question-status vam-status-${status === "running" ? "running" : status === "completed" ? "completed" : status === "not_started" ? "idea" : "error"}`, text: status === "not_started" && this.map.mindSearch.branches.some(branch => branch.questionNodeId === node.id) ? (this.plugin.settings.language === "en" ? "Answered · research not started" : "已回答・研究尚未開始") : t(key[status]) });
    } else if (active || !note || note.status !== "completed") header.createSpan({ cls: `vam-status vam-status-${active ? "running" : note?.status ?? "error"}`, text: active ? t("ui.ai_running") : note ? topicStatusLabel(note.status, this.plugin.settings.language) : t("ui.note_missing") });
    if (batch) {
      const currentNode = batch.currentPath ? this.map?.nodes.find(item => item.path === batch.currentPath) : undefined;
      const currentTitle = currentNode ? this.notes.get(currentNode.id)?.title : undefined;
      const label = `${t("ui.shallow_research_progress")}: ${batch.completed}/${batch.total}${currentTitle ? ` · ${currentTitle}` : ""}${batch.status === "stopped" ? ` · ${t("ui.shallow_research_stopped")}` : ""}`;
      header.createSpan({ cls: `vam-status vam-status-${batch.status === "running" ? "running" : batch.failures.length ? "error" : "completed"}`, text: label });
      if (batch.status === "running") this.button(header, t("ui.stop_research"), () => this.plugin.expansionCoordinator.stop(node.path));
      if (batch.failures.length) { const failure = header.createSpan({ cls: "vam-status vam-status-error", text: `${batch.failures.length} ${t("ui.failed")}` }); failure.setAttr("title", batch.failures.join("\n")); }
    }
    if (this.plugin.quickExpandPending?.has(node.path) && batch?.status !== "running") {
      this.button(header, t("ui.stop_research"), () => this.plugin.activeTasks.get(node.path)?.abort());
    }
    const quickError = this.plugin.quickExpandFailures?.get(node.path);
    if (quickError && !active) { const badge = header.createSpan({ cls: "vam-status vam-status-error", text: t("ui.expansion_failed") }); badge.setAttr("title", quickError); }
    const pendingCount = this.plugin.pendingSuggestions.get(node.path)?.length ?? 0;
    if (pendingCount && !this.builtIn && !this.integrationMode && !this.map?.mindSearch) this.button(header, t("ui.view_0_expansion_suggestions", pendingCount), () => this.openNodePanel(node, "proposals")).addClass("vam-badge-new");
    if (!this.builtIn && !this.integrationMode) {
      if (!this.map?.mindSearch) {
        const ai = this.button(header, "✦", () => this.openNextStep(node)); ai.addClass("vam-node-tool"); ai.setAttr("aria-label", t("ui.how_would_you_like_to_explore_next"));
        const structure = this.button(header, "⚙", () => this.openNodePanel(node, "structure")); structure.addClass("vam-node-tool"); structure.setAttr("aria-label", t("ui.structure_and_links"));
        if (note) { const rename = this.button(header, "✎", () => new NameModal(this.app, t("ui.new_topic_name"), note.title, title => this.enqueue(() => this.noteChange(node, { title }))).open()); rename.addClass("vam-node-tool"); rename.setAttr("aria-label", t("ui.new_topic_name")); }
      }
      if (node.mindSearchKind === "question") { const remove = this.button(header, "×", () => this.confirmRemoveNode(node)); remove.addClass("vam-node-tool"); remove.setAttr("aria-label", t("ui.remove_from_map")); }
      if (this.map?.mindSearch && node.mindSearchKind === "synthesis" && this.map.mindSearch.branches.some(branch => branch.results.some(result => result.nodeId === node.id))) {
        const next = this.button(header, t("ui.mindsearch_new_question"), () => void this.planMindSearchFromSelection(node.id), this.mindSearchBusy);
        next.addClass("vam-node-tool");
        next.setAttr("aria-label", t("ui.mindsearch_new_question_hint"));
        next.setAttr("title", t("ui.mindsearch_new_question_hint"));
      }
    }
    const details = this.button(header, "↗", () => this.builtIn ? this.selectSampleNode(node.id) : this.openDetails(node)); details.addClass("vam-detail-button"); details.setAttr("aria-label", this.builtIn ? t("ui.view_sample_content") : t("ui.open_details_in_right_sidebar"));
    const count = descendants(this.map!.nodes, node.id).size;
    if (count && !this.builtIn) this.button(header, node.collapsed ? t("ui.expand_0", count) : t("ui.collapse"), () => this.enqueue(() => this.mapChange(map => { const n = map.nodes.find(n => n.id === node.id)!; n.collapsed = !n.collapsed; })));
    if (!this.builtIn && !this.integrationMode && !this.map?.mindSearch) { const add = this.button(card, "+", () => this.enqueue(() => this.addNode(node))); add.addClass("vam-add-child"); add.setAttr("aria-label", t("ui.add_subtopic_manually")); }
    const title = card.createEl("h3", { text: note?.title ?? node.path, cls: "vam-card-title" });
    title.setAttr("title", note?.title ?? node.path);
    card.createEl("p", { cls: "vam-card-summary", text: note?.summary ?? t("ui.the_file_was_moved_or_deleted_you_can_remove_this_node_from") });
    if (node.mindSearchKind === "conclusion" && this.map?.mindSearch && !this.builtIn) {
      const branch = this.map.mindSearch.branches.find(item => item.results.some(result => result.nodeId === node.id));
      const hasFollowup = this.map.nodes.some(item => item.parentId === node.id && item.mindSearchKind === "question");
      if (branch && !hasFollowup && countMindSearchAnsweredQuestions(this.map, branch.id) < MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION) {
        card.createEl("p", { cls: "vam-hint", text: t("ui.mindsearch_early_conclusion_hint") });
        this.button(card, t("ui.mindsearch_resume_early_conclusion"), () => void this.planMindSearchFromSelection(node.id), this.mindSearchBusy).addClass("mod-cta");
      }
    }
    if (node.mindSearchKind === "topic" && this.map?.mindSearch && !this.map.nodes.some(item => item.mindSearchKind === "question")) {
      const initialBranch = this.map.mindSearch.branches.find(item => item.questionNodeId === node.id && !item.parentBranchId);
      const initialRuns = initialBranch ? this.map.mindSearch.runs.filter(item => item.branchId === initialBranch.id) : [];
      const activeInitialRun = initialRuns.some(run => { const attempt = run.attempts.find(item => item.id === run.currentAttemptId); return attempt?.status === "running" || attempt?.status === "saving"; });
      const terminalResult = initialBranch ? [...initialBranch.results].reverse().find(result => result.kind !== "research") : undefined;
      const terminalRun = terminalResult ? initialRuns.find(item => item.id === terminalResult.runId) : undefined;
      const terminalAttempt = terminalResult && terminalRun ? terminalRun.attempts.find(item => item.id === terminalResult.attemptId) : undefined;
      if (!initialBranch) {
        const start = this.button(card, t("ui.mindsearch_start_exploration"), () => { void this.planMindSearchFromSelection(node.id); }, this.mindSearchBusy);
        start.addClass("mod-cta"); start.addClass("vam-mindsearch-start");
      } else if (!activeInitialRun && terminalAttempt?.status === "partial" && terminalRun) {
        this.button(card, t("ui.mindsearch_continue_research"), () => void this.continueMindSearchResearch(node.id, terminalRun.id), this.mindSearchBusy).addClass("vam-mindsearch-retry");
      } else if (!activeInitialRun && !terminalResult) {
        this.renderMindSearchFailure(card, initialBranch);
        const label = initialBranch.researchPlan || initialBranch.results.length ? t("ui.mindsearch_continue_research") : t("ui.mindsearch_retry_subtopics");
        this.button(card, label, () => void this.retryMindSearchSubtopics(initialBranch.id), this.mindSearchBusy).addClass("vam-mindsearch-retry");
      }
    }
    if (node.mindSearchKind === "question" && this.map?.mindSearch) {
      const branch = this.map.mindSearch.branches.find(item => item.questionNodeId === node.id);
      if (branch) {
        this.renderMindSearchFailure(card, branch);
        const labels = node.mindSearchQuestion?.options.filter(option => branch.answerSnapshot.selections.includes(option.id)).map(option => option.label) ?? branch.answerSnapshot.selections;
        const answer = [...labels, branch.answerSnapshot.freeText].filter(Boolean).join(" — ");
        card.createEl("p", { cls: "vam-mindsearch-answer-snapshot", text: `${t("ui.mindsearch_answer_snapshot")}: ${answer || t("ui.mindsearch_unknown_answer")}` });
        const branchRuns = this.map.mindSearch.runs.filter(item => item.branchId === branch.id);
        const activeBranchRun = branchRuns.some(run => { const current = run.attempts.find(item => item.id === run.currentAttemptId); return current?.status === "running" || current?.status === "saving"; });
        const terminalResult = [...branch.results].reverse().find(result => result.kind !== "research");
        const terminalRun = terminalResult && branchRuns.find(item => item.id === terminalResult.runId);
        const terminalAttempt = terminalRun?.attempts.find(item => item.id === terminalResult?.attemptId);
        if (!activeBranchRun && terminalAttempt?.status === "partial" && terminalRun) {
          this.button(card, t("ui.mindsearch_continue_research"), () => void this.continueMindSearchResearch(node.id, terminalRun.id), this.mindSearchBusy).addClass("vam-mindsearch-retry");
        }
        if (!branch.researchPlan && branch.results.length === 0) {
          const status = card.createEl("p", { cls: "vam-mindsearch-plan-error", text: t("ui.mindsearch_research_not_generated") });
          if (branch.researchPlanError) status.setAttr("title", branch.researchPlanError);
          if (!activeBranchRun && !terminalResult) {
            const retry = this.button(card, t("ui.mindsearch_retry_subtopics"), () => void this.retryMindSearchSubtopics(branch.id));
            retry.addClass("vam-mindsearch-retry"); retry.disabled = this.mindSearchBusy;
          }
        } else if (!activeBranchRun && !terminalResult) {
          this.button(card, t(branch.deliveryRecovery ? "ui.mindsearch_resume_stage" : "ui.mindsearch_continue_research"), () => void this.retryMindSearchSubtopics(branch.id), this.mindSearchBusy).addClass("vam-mindsearch-retry");
        }
      }
    }
    if (node.mindSearchKind === "answer" && this.map?.mindSearch) {
      const branch = this.map.mindSearch.branches.find(item => item.answerNodeId === node.id);
      const question = branch && this.map.nodes.find(item => item.id === branch.questionNodeId);
      if (branch) {
        const labels = question?.mindSearchQuestion?.options.filter(option => branch.answerSnapshot.selections.includes(option.id)).map(option => option.label) ?? branch.answerSnapshot.selections;
        const answer = [...labels, branch.answerSnapshot.freeText].filter(Boolean).join(" — ");
        card.createEl("p", { cls: "vam-mindsearch-answer-snapshot", text: `${t("ui.mindsearch_answer_snapshot")}: ${answer || t("ui.mindsearch_unknown_answer")}` });
      }
    }
    if (!this.builtIn) this.enableDrag(card, node); else card.addClass("is-readonly");
    card.addEventListener("click", event => { if (Date.now() < this.suppressClickUntil) return; if ((event.target as Element).closest("button") || event.metaKey || event.ctrlKey) return; if (this.integrationMode) { if (this.multiSelected.has(node.id)) this.multiSelected.delete(node.id); else this.multiSelected.add(node.id); this.render(); return; } if (this.builtIn) this.selectSampleNode(node.id); else { this.selectMapNode(node); this.openDetails(node); } });
    card.addEventListener("keydown", event => { if (event.key === "Enter" && event.target === card) { if (this.integrationMode) { if (this.multiSelected.has(node.id)) this.multiSelected.delete(node.id); else this.multiSelected.add(node.id); this.render(); } else if (this.builtIn) this.selectSampleNode(node.id); else { this.selectMapNode(node); if (node.mindSearchKind === "question") this.openMindSearchAnswer(node); else this.openDetails(node); } } });
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
  private selectMapNode(node: MapNode): void {
    if (this.selected === node.id && this.multiSelected.size === 0) return;
    this.selected = node.id; this.multiSelected.clear(); this.render();
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
      sources.synthesisTopics = this.map?.nodes.filter(item => item.parentId === node.id).map(item => this.notes.get(item.id)?.title ?? item.path) ?? [];
      new NextStepModal(this.app, note.title, note.researchDepth, this.map?.nodes.filter(item => item.parentId === node.id).length ?? 0, this.plugin.pendingSuggestions.get(node.path)?.length ?? 0, this.plugin,
        async (options, focus, done, failed, accepted) => {
          const latest = await this.plugin.repo.readNote(node.path);
          const task = translate(this.plugin.settings.language, "prompt.research_topic", latest.title);
          await this.runAgent(node, done, failed, { task: [task, options.requirements].filter(Boolean).join("\n\n"), referenceGroups: options.referenceGroups, onProgress: options.onProgress, signal: options.signal, outputLanguage: options.outputLanguage, rules: "", researchMode: options.researchMode, researchDepth: options.researchDepth, visualMode: options.visualMode }, accepted);
        },
        (options, direction, found, failed, created, accepted) => {
          if (!options.multiLayer) return this.proposeChildren(node, true, options, direction, found, failed, false, created, accepted);
          return this.startQuickExpansion(node, options, direction, failed, created, accepted);
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
    this.button(relationship, t("ui.remove_from_map"), () => { close?.(); this.confirmRemoveNode(node); });
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
      const titleField = row.createEl("label", { cls: "vam-proposal-field" }); titleField.createSpan({ text: t("ui.subtopic_name") });
      const title = titleField.createEl("input", { type: "text", value: original.title }); title.setAttr("aria-label", t("ui.subtopic_name"));
      const taskField = row.createEl("label", { cls: "vam-proposal-field" }); taskField.createSpan({ text: t("ui.research_task") });
      const task = taskField.createEl("textarea", { text: original.task }); task.rows = 2; task.setAttr("aria-label", t("ui.research_task"));
      const contributionField = row.createEl("label", { cls: "vam-proposal-field" }); contributionField.createSpan({ text: t("ui.contribution_to_the_parent_topic") });
      const contribution = contributionField.createEl("textarea", { text: original.contribution }); contribution.rows = 2; contribution.setAttr("aria-label", t("ui.contribution_to_the_parent_topic"));
      rows.push({ original, check, title, task, contribution });
    }
    const researchLabel = section.createEl("label", { cls: "vam-field vam-next-toggle" });
    const shallow = researchLabel.createEl("input", { type: "checkbox" }); shallow.checked = !!this.plugin.pendingResearchOptions.get(node.path)?.shallowResearch; researchLabel.createSpan({ text: t("ui.run_shallow_research_on_each_created_subtopic") });
    const status = section.createEl("p", { cls: "vam-hint" });
    const actions = section.createDiv("vam-actions");
    const create = this.button(actions, t("ui.create_selected_subtopics"), () => { void (async () => {
      if (this.plugin.expansionCoordinator.isRunning(node.path)) { status.setText(t("ui.ai_running_ai")); return; }
      const chosen = rows.filter(row => row.check.checked && row.title.value.trim());
      if (!chosen.length) { status.setText(t("ui.select_at_least_one_subtopic")); return; }
      const names = new Map(chosen.map(row => [row.original.title, row.title.value.trim()]));
      if (new Set(names.values()).size !== names.size) { status.setText(t("ui.subtopic_names_must_be_unique")); return; }
      if (chosen.some(row => row.original.parentTitle && row.original.parentTitle !== note.title && !names.has(row.original.parentTitle))) { status.setText(t("ui.select_the_parent_topic_before_its_child")); return; }
      const items = chosen.map(row => ({ title: row.title.value.trim(), task: row.task.value.trim(), contribution: row.contribution.value.trim(), parentTitle: row.original.parentTitle && row.original.parentTitle !== note.title ? names.get(row.original.parentTitle)! : "" }));
      create.disabled = true; status.setText(t("ui.creating_subtopics"));
      try {
        let createdNodes: MapNode[] = [];
        const researchOptions: TaskOptions | undefined = shallow.checked ? { ...(this.plugin.pendingResearchOptions.get(node.path) ?? { researchMode: "research" as const, researchDepth: "fast" as const, referenceGroups: [], visualMode: "off" as const }), shallowResearch: true } : undefined;
        await this.plugin.mutate(async () => {
          const current = this.map?.nodes.find(item => item.id === node.id && item.path === node.path);
          if (!current) throw new Error(t("ui.the_topic_changed_select_it_again"));
          if (this.plugin.pendingSuggestions.get(node.path) !== suggestions) throw new Error(t("ui.expansion_suggestions_changed_open_them_again"));
          await this.assertSuggestionOrigin(current, suggestions);
          try { createdNodes = await this.createChildBatch(current, items, researchOptions); }
          catch (error) { if (error instanceof PartialChildBatchError) await this.clearPartialSuggestions(node.path, error); throw error; }
          this.plugin.pendingSuggestions.delete(node.path); this.plugin.pendingResearchOptions.delete(node.path);
          await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
        });
        if (researchOptions && createdNodes.length) await this.startShallowResearch(node, createdNodes, researchOptions);
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
      this.history.clear(); if (next) await this.openMapInMutation(next); else this.render(); new Notice(t("ui.old_data_was_migrated_into_topic_folders"));
    }) }]).open();
  }
  private async repairMissingTopic(): Promise<void> {
    const broken = await this.plugin.repo.brokenTopics();
    if (!broken.length) { new Notice(t("ui.no_topics_with_a_missing_map_md")); return; }
    new ChoiceModal(this.app, t("ui.repair_missing_map"), t("ui.choose_a_topic_to_repair"), broken.map(topic => ({ label: t("ui.0_1_notes", topic.title, topic.noteCount), action: () => {
      new ChoiceModal(this.app, topic.title, t("ui.rebuild_a_map_from_notes_as_root_nodes_or_relink_an_existing"), [
        { label: t("ui.rebuild_from_notes"), action: () => this.enqueue(async () => this.openMapInMutation(await this.plugin.repo.rebuildMissingMap(topic.root))) },
        { label: t("ui.relink_existing_map"), action: () => this.enqueue(async () => {
          const candidates = (await this.plugin.repo.mapFiles()).filter(file => !file.path.startsWith(`${this.plugin.settings.topicsFolder}/`));
          new ChoiceModal(this.app, t("ui.choose_existing_map"), t("ui.move_the_selected_map_into_this_topic_and_rebuild_node_paths"), candidates.map(file => ({ label: file.path, action: () => this.enqueue(async () => this.openMapInMutation(await this.plugin.repo.relinkMissingMap(topic.root, file.path))) }))).open();
        }) }
      ]).open();
    } }))).open();
  }
  private async addNode(parent: MapNode | null, suggestedTitle?: string, rebuildDerivedData = true): Promise<void> {
    if (!this.map) return;
    if (!suggestedTitle?.trim()) {
      new NameModal(this.app, parent ? t("ui.new_subtopic") : t("ui.my_core_topic"), "", title => this.enqueue(() => this.addNode(parent, title))).open();
      return;
    }
    const model = inheritModel(parent ? (await this.plugin.repo.readNote(parent.path)).model : undefined, this.plugin.settings.cliModel);
    if (!this.path.startsWith(`${this.plugin.settings.topicsFolder}/`)) { new Notice(t("ui.use_migrate_old_data_to_convert_this_map_first")); return; }
    const node = await this.plugin.repo.createNote(suggestedTitle?.trim() || (parent ? t("ui.new_subtopic") : t("ui.my_core_topic")), model, this.map, this.path, parent ? "inherited" : "workspace");
    if (parent) { const parentNote = await this.plugin.repo.readNote(parent.path); await this.plugin.repo.updateNote(node.path, { reasoning: parentNote.reasoning }); }
    node.parentId = parent?.id ?? null; node.x = parent ? parent.x + 340 : 80;
    const siblings = this.map.nodes.filter(n => n.parentId === node.parentId);
    node.y = siblings.length ? Math.max(...siblings.map(n => n.y)) + 220 : parent?.y ?? 80;
    this.notes.set(node.id, await this.plugin.repo.readNote(node.path)); this.selected = node.id;
    await this.mapChange(map => { map.nodes.push(node); if (parent) map.nodes.find(n => n.id === parent.id)!.collapsed = false; }, rebuildDerivedData); if (this.map) this.map.viewport.zoom = Math.max(this.map.viewport.zoom, 0.7); this.focusNode(node);
  }
  private startQuickExpansion(parent: MapNode, options: TaskOptions, direction: string, failed: (message: string, retryable?: boolean) => void, created: () => void, accepted?: () => void): Promise<void> {
    if (this.plugin.running.has(parent.path) || this.plugin.quickExpandPending.has(parent.path)) { failed(t("ui.ai_running_ai")); return Promise.resolve(); }
    this.plugin.quickExpandFailures.delete(parent.path);
    this.plugin.quickExpandPending.add(parent.path); this.render();
    return this.proposeChildren(parent, true, options, direction, undefined, failed, true, created, accepted).catch(error => {
      this.plugin.quickExpandFailures.set(parent.path, error instanceof Error ? error.message : String(error));
      throw error;
    }).finally(() => { if (this.plugin.expansionBatches.get(parent.path)?.status !== "running") this.plugin.quickExpandPending.delete(parent.path); this.render(); });
  }
  private async proposeChildren(parent: MapNode, confirmed = false, options?: TaskOptions, direction = "", found?: (items: Suggestion[], create: (items: Suggestion[]) => Promise<void>) => void, failed?: (message: string, retryable?: boolean) => void, direct = false, created?: () => void, acceptedCallback?: () => void): Promise<void> {
    if (this.plugin.expansionCoordinator.isRunning(parent.path)) { failed?.(t("ui.ai_running_ai")); return; }
    const previousBatch = this.plugin.expansionBatches.get(parent.path);
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
      found(items, async selected => {
        if (this.plugin.expansionCoordinator.isRunning(parent.path)) throw new Error(t("ui.ai_running_ai"));
        let createdNodes: MapNode[] = [];
        const savedOptions = this.plugin.pendingResearchOptions.get(parent.path);
        const researchOptions = savedOptions ? { ...savedOptions, signal: options?.signal, onProgress: options?.onProgress } : undefined;
        await this.plugin.mutate(async () => {
          if (!version || this.plugin.pendingSuggestions.get(parent.path) !== version) throw new Error(t("ui.expansion_suggestions_changed_open_them_again"));
          await this.assertSuggestionOrigin(parent, version);
          try { createdNodes = await this.createChildBatch(parent, selected, researchOptions); }
          catch (error) { if (error instanceof PartialChildBatchError) await this.clearPartialSuggestions(parent.path, error); throw error; }
          this.plugin.pendingSuggestions.delete(parent.path); this.plugin.pendingResearchOptions.delete(parent.path);
          await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
          this.render();
        });
        if (researchOptions?.shallowResearch && createdNodes.length) await this.startShallowResearch(parent, createdNodes, researchOptions);
      });
    };
    if (pending?.length && !direct) {
      if (options) { if (options.shallowResearch ?? options.multiLayer) this.plugin.pendingResearchOptions.set(parent.path, this.researchChoices(options)); else this.plugin.pendingResearchOptions.delete(parent.path); }
      present(options && !options.multiLayer ? pending.filter(item => !item.parentTitle) : pending);
      return;
    }
    if (this.plugin.running.has(parent.path)) { failed?.(t("ui.ai_running_ai")); return; }
    if (!confirmed) {
      const note = await this.plugin.repo.readNote(parent.path);
      new TaskModal(this.app, t("ui.suggest_the_most_useful_expansion_direction_or_follow_the_di"), (value, run, chosen) => { if (run) void this.plugin.confirmAiUsage(note.model, async () => this.enqueue(() => this.proposeChildren(parent, true, chosen, value))); }, t("ui.expand_subtopics"), t("ui.specify_an_expansion_direction_or_ask_ai_to_suggest_one_prev"), note.rules, note.researchMode, note.researchDepth, note.visualMode, false, true, this.taskSourceSettings(t("ui.reference_current_topic_included", note.title)), undefined, this.plugin.settings.language, note.model, note.reasoning ?? this.plugin.settings.cliReasoning, note.title).open();
      return;
    }
    const controller = new AbortController();
    const modalSignal = options?.signal;
    const abortBeforeAcceptance = (): void => controller.abort();
    if (modalSignal?.aborted) controller.abort();
    else modalSignal?.addEventListener("abort", abortBeforeAcceptance, { once: true });
    let accepted = false;
    const acceptDispatch = (): void => {
      if (accepted || controller.signal.aborted) return;
      accepted = true;
      modalSignal?.removeEventListener("abort", abortBeforeAcceptance);
      acceptedCallback?.();
    };
    const releaseTask = (): void => {
      modalSignal?.removeEventListener("abort", abortBeforeAcceptance);
      if (this.plugin.activeTasks.get(parent.path) === controller) this.plugin.activeTasks.delete(parent.path);
      this.plugin.running.delete(parent.path);
      if (!this.plugin.expansionCoordinator.isRunning(parent.path)) this.plugin.quickExpandPending.delete(parent.path);
    };
    this.plugin.running.add(parent.path);
    this.plugin.quickExpandPending.add(parent.path);
    this.plugin.activeTasks.set(parent.path, controller);
    this.render();
    let building = false;
    try {
      const note = await this.plugin.repo.readNote(parent.path);
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const targetMapPath = this.path, targetMapId = this.map?.id;
      const originalChildren = this.map?.nodes.filter(item => item.parentId === parent.id).map(item => item.id).sort().join("|") ?? "";
      const outputLanguage = options?.outputLanguage ?? this.plugin.settings.language;
      const existing = this.map?.nodes.filter(item => item.parentId === parent.id).map(item => {
        const child = this.notes.get(item.id);
        return `- ${child?.title || item.path}: ${child?.summary || translate(outputLanguage, "prompt.no_summary_yet")}`;
      }).join("\n") || translate(outputLanguage, "prompt.none");
      const layers = options?.layers ?? 2, firstLayerCount = options?.firstLayerCount ?? 3, childrenPerParent = layers === 1 ? 1 : options?.childrenPerParent ?? 2;
      const shape = direct ? quickShape(layers, firstLayerCount, childrenPerParent) : null;
      const effectiveLayers = shape?.counts.length ?? layers;
      if (shape && shape.total > BigInt(15)) throw new Error(t("ui.this_would_create_0_subtopics_exceeding_the_limit_of_15_redu", shape.total.toString()));
      const directTask = translate(outputLanguage, "prompt.direct_expansion", effectiveLayers, firstLayerCount, childrenPerParent, shape?.counts.join(outputLanguage === "en" ? ", " : "、"), shape?.total.toString());
      const guidedTask = translate(outputLanguage, "prompt.guided_expansion");
      const task = `${direct ? translate(outputLanguage, "prompt.preliminary_map", effectiveLayers, firstLayerCount, childrenPerParent, shape?.counts.join(outputLanguage === "en" ? ", " : "、"), shape?.total.toString()) : direction || translate(outputLanguage, "prompt.expansion_direction")}\n${translate(outputLanguage, "prompt.existing_subtopics")}\n${existing}\n${translate(outputLanguage, "prompt.avoid_duplicates")} ${direct ? directTask : guidedTask}`;
      const result = await this.plugin.askModel(withThinkingOrigin({ title: note.title, summary: note.summary, rules: "", detail: note.detail, task: [task, options?.requirements].filter(Boolean).join("\n\n"), ancestors: await this.ancestorContext(parent), referenceGroups: options?.referenceGroups, outputLanguage: options?.outputLanguage, mode: "decompose", researchMode: options?.researchMode ?? "research", researchDepth: options?.researchDepth ?? note.researchDepth, visualMode: "off" }, note), note.model, note.reasoning, controller.signal, undefined, acceptDispatch);
      if (!accepted) acceptDispatch();
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const suggestions = direct ? quickSuggestions(result.suggestions, effectiveLayers, firstLayerCount, childrenPerParent) : result.suggestions.filter(item => !item.parentTitle).slice(0, 7);
      if (!direct && suggestions.length === 0) { const message = result.detail.trim() || t("ui.ai_does_not_recommend_decomposition_or_did_not_propose_3_to"); if (failed) failed(message); else new Notice(message); return; }
      if (direct) {
        building = true;
        let batchFailure: Error | null = null;
        let createdNodes: MapNode[] = [];
        await this.plugin.mutate(async () => {
          if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
          try {
            const currentParent = this.map?.nodes.find(item => item.id === parent.id && item.path === parent.path);
            const currentChildren = this.map?.nodes.filter(item => item.parentId === parent.id).map(item => item.id).sort().join("|") ?? "";
            if (this.path !== targetMapPath || this.map?.id !== targetMapId || !currentParent || currentChildren !== originalChildren) throw new Error(t("ui.the_map_or_parent_topic_changed_while_ai_was_running_no_subt"));
            const currentNote = await this.plugin.repo.readNote(parent.path);
            const version = (value: Note): string => JSON.stringify([value.title, value.summary, value.rules, value.detail, value.prompt, value.model, value.reasoning, value.sourcePaths, value.referencePaths, value.thinkingOrigin]);
            if (version(currentNote) !== version(note)) throw new Error(t("ui.the_map_or_parent_topic_changed_while_ai_was_running_no_subt"));
            createdNodes = await this.createChildBatch(currentParent, suggestions, options?.shallowResearch ? { ...options, signal: controller.signal } : undefined, controller.signal);
          } catch (error) { batchFailure = error instanceof Error ? error : new Error(typeof error === "string" ? error : t("ui.failed_to_create_starter_map")); }
        });
        const batchError = batchFailure as Error | null;
        if (batchError) throw batchError;
        if (options?.shallowResearch && createdNodes.length) await this.startShallowResearch(parent, createdNodes, { ...options, signal: controller.signal });
        this.plugin.pendingSuggestions.delete(parent.path); this.plugin.pendingResearchOptions.delete(parent.path);
        this.plugin.quickExpandFailures?.delete(parent.path);
        created?.();
      } else {
        const latest = await this.plugin.repo.readNote(parent.path);
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (latest.thinkingOrigin !== note.thinkingOrigin) throw new Error(t("ui.the_topic_changed_so_the_outdated_ai_result_was_not_saved"));
        const pendingItems = suggestions.map(item => ({ ...item, thinkingOriginBaseline: originBaseline(note.thinkingOrigin) }));
        this.plugin.pendingSuggestions.set(parent.path, pendingItems);
        await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
        if (controller.signal.aborted) {
          this.plugin.pendingSuggestions.delete(parent.path);
          await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
          throw new DOMException("Aborted", "AbortError");
        }
        if (options?.shallowResearch) this.plugin.pendingResearchOptions.set(parent.path, this.researchChoices(options));
        else this.plugin.pendingResearchOptions?.delete(parent.path);
        present(pendingItems);
      }
    } catch (error) {
      if (building && error instanceof PartialChildBatchError) await this.clearPartialSuggestions(parent.path, error);
      const partial = error instanceof PartialChildBatchError;
      const currentBatch = this.plugin.expansionBatches.get(parent.path);
      const stoppedBatch = currentBatch !== previousBatch && currentBatch?.status === "stopped";
      const cancelled = !partial && (controller.signal.aborted || stoppedBatch);
      if (!cancelled) {
        console.error("Visual Agent Map AI split", error);
        const message = this.plugin.recordFailure(building ? "建立初步地圖失敗" : "AI 拆解失敗", error);
        if (direct) this.plugin.quickExpandFailures?.set(parent.path, message);
        if (failed) failed(message, !partial); else new Notice(message);
      }
    }
    finally { releaseTask(); await this.hydrate(); this.render(); }
  }
  private async assertSuggestionOrigin(parent: MapNode, suggestions: Suggestion[]): Promise<void> {
    const origin = (await this.plugin.repo.readNote(parent.path)).thinkingOrigin ?? "";
    if (suggestions.every(item => item.thinkingOriginBaseline === originBaseline(origin) || (item.thinkingOriginBaseline === undefined && !origin))) return;
    this.plugin.pendingSuggestions.delete(parent.path);
    this.plugin.pendingResearchOptions.delete(parent.path);
    await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
    throw new Error(t("ui.the_topic_changed_so_the_outdated_ai_result_was_not_saved"));
  }
  private openChildSuggestions(parent: MapNode, suggestions: Suggestion[]): void {
    const version = this.plugin.pendingSuggestions.get(parent.path);
    const roots = suggestions.filter(item => !item.parentTitle).map(item => item.title);
    if (new Set(roots).size !== roots.length) {
      this.plugin.pendingSuggestions.delete(parent.path); this.plugin.pendingResearchOptions.delete(parent.path);
      new Notice(t("ui.ai_proposed_duplicate_first_level_names_generate_the_proposa")); return;
    }
    new ChildProposalModal(this.app, suggestions.slice(0, 15), items => { void (async () => {
      if (this.plugin.expansionCoordinator.isRunning(parent.path)) throw new Error(t("ui.ai_running_ai"));
      let researchOptions: TaskOptions | undefined, createdNodes: MapNode[] = [];
      await this.plugin.mutate(async () => {
        if (!version || this.plugin.pendingSuggestions.get(parent.path) !== version) throw new Error(t("ui.expansion_suggestions_changed_open_them_again"));
        await this.assertSuggestionOrigin(parent, version);
        researchOptions = this.plugin.pendingResearchOptions.get(parent.path);
        try { createdNodes = await this.createChildBatch(parent, items, researchOptions); }
        catch (error) { if (error instanceof PartialChildBatchError) await this.clearPartialSuggestions(parent.path, error); throw error; }
        this.plugin.pendingSuggestions.delete(parent.path);
        this.plugin.pendingResearchOptions.delete(parent.path);
        await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
        this.render();
      });
      if (researchOptions?.shallowResearch && createdNodes.length) await this.startShallowResearch(parent, createdNodes, researchOptions);
    })().catch(error => { new Notice(error instanceof Error ? error.message : String(error)); }); }).open();
  }
  private async createChildBatch(parent: MapNode, items: Suggestion[], researchOptions?: TaskOptions, signal?: AbortSignal): Promise<MapNode[]> {
    if (this.plugin.expansionCoordinator.isRunning(parent.path)) throw new Error(t("ui.ai_running_ai"));
    if (!this.map?.nodes.some(node => node.id === parent.id && node.path === parent.path)) throw new Error(t("ui.the_map_or_parent_topic_changed_while_ai_was_running_no_subt"));
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
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const owner = item.parentTitle ? createdByTitle.get(item.parentTitle) : parent;
        if (!owner) throw new Error(t("ui.select_the_parent_topic_before_its_child"));
        await this.addNode(owner, item.title, false); created++;
        const child = this.map.nodes.at(-1)!;
        newNodes.push(child);
        createdByTitle.set(item.title, child);
        await this.noteChange(child, { prompt: item.task, detail: researchOptions ? "" : item.contribution ? canonicalDetail(item.contribution, this.plugin.settings.language) : "", ...(researchOptions ? { researchMode: "research" as const, researchDepth: "fast" as const, visualMode: researchOptions.visualMode } : {}) });
      }
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (newNodes.length) await this.mapChange(map => { map.nodes = arrangeNewBranch(map.nodes, parent.id, new Set(newNodes.map(node => node.id))); }, false);
      if (created) await this.plugin.rebuildDerivedData();
      return newNodes;
    } catch (error) {
      if (created) { await this.plugin.rebuildDerivedData(); throw new PartialChildBatchError(t("ui.some_subtopics_were_created_reopen_this_window_and_check_the") + ` ${error instanceof Error ? error.message : String(error)}`); }
      throw error;
    }
  }
  private startShallowResearch(parent: MapNode, children: MapNode[], options: TaskOptions): Promise<void> {
    const signal = options.signal;
    const pendingOptions = this.researchChoices(options);
    this.plugin.quickExpandPending.add(parent.path);
    return this.plugin.expansionCoordinator.start(parent.path, children, async (child, batchSignal, accepted) => {
      const note = await this.plugin.repo.readNote(child.path);
      let started = false;
      let failure: string | undefined;
      const handle = await this.runAgent(child, undefined, message => { failure = message; }, {
        rules: "", referenceGroups: [],
        signal: batchSignal, outputLanguage: pendingOptions.outputLanguage,
        researchMode: pendingOptions.researchMode, researchDepth: pendingOptions.researchDepth,
        visualMode: pendingOptions.visualMode,
        task: [note.prompt, pendingOptions.requirements].filter(Boolean).join("\n\n")
      }, () => { started = true; accepted(); });
      if (!started || !handle) throw new Error(failure ?? t("ui.shallow_research_did_not_start"));
      await handle.finished;
      if (failure && !batchSignal.aborted) throw new Error(failure);
    }, () => {
      const state = this.plugin.expansionBatches.get(parent.path);
      if (state?.status === "running") this.plugin.quickExpandPending.add(parent.path);
      else this.plugin.quickExpandPending.delete(parent.path);
      this.render();
    }, signal);
  }
  private researchChoices(options: TaskOptions): TaskOptions {
    const { signal: _signal, onProgress: _onProgress, ...choices } = options;
    return { ...choices, signal: undefined, onProgress: undefined, referenceGroups: [] };
  }
  private async clearPendingSuggestions(path: string): Promise<void> {
    this.plugin.pendingSuggestions.delete(path);
    this.plugin.pendingResearchOptions.delete(path);
    try { await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.(); }
    catch (error) { throw new Error(this.plugin.recordFailure(t("ui.expansion_suggestions_changed_open_them_again"), error)); }
  }
  private async clearPartialSuggestions(path: string, partial: PartialChildBatchError): Promise<void> {
    try { await this.clearPendingSuggestions(path); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new PartialChildBatchError(`${partial.message} ${detail}`);
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
      const childSources = await this.topicReferenceGroup(children, options?.synthesisContent === "summary" ? "summary" : "strong");
      const selectedSources = options.referenceGroups ?? [];
      if (!children.length && !selectedSources.some(group => group.documents.length)) { failed(t("ui.the_selected_sources_contain_no_markdown_content_to_synthesi")); return; }
      const task = translate(this.plugin.settings.language, "prompt.synthesis_directions");
      const result = await this.plugin.askModel(withThinkingOrigin({ title: note.title, summary: note.summary, rules: "", detail: note.detail, task: [task, options?.requirements].filter(Boolean).join("\n\n"), ancestors: await this.ancestorContext(node), referenceGroups: [...selectedSources, childSources], onProgress: options.onProgress, outputLanguage: options.outputLanguage, mode: "synthesize", researchMode: options.researchMode, researchDepth: options.researchDepth, visualMode: "off" }, note), note.model, note.reasoning, options.signal);
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
      new TaskModal(this.app, t("ui.synthesize_agreements_differences_tradeoffs_and_open_questio"), (value, run, chosen) => { if (run) void this.plugin.confirmAiUsage(note.model, async () => this.enqueue(() => this.integrateChildren(node, true, chosen, value))); }, t("ui.synthesize_subtopics"), t("ui.ai_reads_direct_subtopics_and_prepares_a_synthesis_draft_not"), note.rules, "local", note.researchDepth, note.visualMode, false, false, this.taskSourceSettings(t("ui.reference_current_topic_included", note.title), this.map?.id, t("ui.reference_synthesis_topics_included", note.title)), children.map(child => this.notes.get(child.id)?.title ?? child.path), this.plugin.settings.language, note.model, note.reasoning ?? this.plugin.settings.cliReasoning, note.title).open();
      return;
    }
    const childSources = await this.topicReferenceGroup(children, options?.synthesisContent === "summary" ? "summary" : "strong");
    const sourceSnapshot = JSON.stringify(childSources.documents);
    const childIds = children.map(child => child.id).sort().join("|");
    const mapPath = this.path, mapId = this.map.id;
    const noteSnapshot = JSON.stringify([note.title, note.summary, note.detail, note.prompt, note.rules, note.model, note.reasoning, note.sourcePaths, note.referencePaths, note.thinkingOrigin]);
    const selectedSources = options?.referenceGroups ?? [];
    if (!children.length && !selectedSources.some(group => group.documents.length)) { const message = t("ui.the_selected_sources_contain_no_markdown_content_to_synthesi"); if (failed) failed(message); else new Notice(message); return; }
    const language = this.plugin.settings.language;
    const task = direction || translate(language, "prompt.synthesis_goal");
    this.plugin.running.add(node.path); await this.plugin.repo.updateNote(node.path, { status: "running" }); await this.hydrate(); this.render();
    try {
      const result = await this.plugin.askModel(withThinkingOrigin({ title: note.title, summary: note.summary, rules: "", detail: note.detail, task: [task, options?.requirements].filter(Boolean).join("\n\n"), ancestors: await this.ancestorContext(node), referenceGroups: [...selectedSources, childSources], onProgress: options?.onProgress, outputLanguage: options?.outputLanguage, mode: "synthesize", researchMode: options?.researchMode ?? "local", researchDepth: options?.researchDepth ?? note.researchDepth, visualMode: options?.visualMode ?? note.visualMode }, note), note.model, note.reasoning, options?.signal);
      if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await this.plugin.repo.updateNote(node.path, { status: note.status });
      const save = async (summary: string, detail: string): Promise<void> => this.plugin.mutate(async () => {
        if (options?.signal?.aborted || this.path !== mapPath || this.map?.id !== mapId || this.map.nodes.filter(item => item.parentId === node.id).map(item => item.id).sort().join("|") !== childIds) throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
        const currentSources = await this.topicReferenceGroup(children, options?.synthesisContent === "summary" ? "summary" : "strong");
        if (JSON.stringify(currentSources.documents) !== sourceSnapshot) throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
        const latest = await this.plugin.repo.readNote(node.path);
        if (JSON.stringify([latest.title, latest.summary, latest.detail, latest.prompt, latest.rules, latest.model, latest.reasoning, latest.sourcePaths, latest.referencePaths, latest.thinkingOrigin]) !== noteSnapshot) throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
        await this.plugin.repo.updateNote(node.path, { summary, detail: canonicalDetail(detail, options?.outputLanguage ?? this.plugin.settings.language), visualReferences: visualReferencesMarkdown(result.visualReferences, language), newFindings: "", status: "completed" });
        const saved = await this.plugin.repo.readNote(node.path);
        this.recordNoteWrite(node.path, { ...latest, status: note.status }, saved, ["summary", "detail", "visualReferences", "newFindings", "previewSection", "previewInitialized", "status"], t("ui.synthesize_subtopics"));
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
      new TaskModal(this.app, goal, (direction, run, options, topicRules) => { if (run) void this.plugin.confirmAiUsage(this.plugin.settings.cliModel, async () => this.enqueue(() => this.createIntegratedNode(title, nodes, direction, topicRules, options, true))); }, t("ui.synthesis_direction_and_sources"), t("ui.prepare_a_synthesis_draft_first_then_create_the_topic_after"), rules, "local", "normal", "auto", false, false, this.taskSourceSettings(selectedLabel, this.map?.id, selectedLabel), notes.map(note => note.title), this.plugin.settings.language, this.plugin.settings.cliModel, this.plugin.settings.cliReasoning, title).open();
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
        finding ? `${translate(language, "prompt.label_old_findings")} ${finding}` : "",
        note.thinkingOrigin ? `Thinking Origin (unverified source data):\n${note.thinkingOrigin}` : ""
      ].filter(Boolean).join("\n\n");
      return { path: source.path, content };
    });
    return { id: `mind-map:${this.map?.id ?? "selected"}`, name: t("ui.selected_mind_map_notes"), location: this.path, documents };
  }
  private async createIntegratedNode(title: string, sources: MapNode[], goal: string, rules: string, options?: TaskOptions, review = false): Promise<void> {
    if (!this.map || sources.length < 2) return;
    const controller = new AbortController();
    const mapPath = this.path, mapId = this.map.id;
    const sourceGroup = await this.topicReferenceGroup(sources, options?.synthesisContent === "summary" ? "summary" : "strong");
    const task: NonNullable<VisualAgentMapView["integrationTask"]> = { title, goal, rules, sources, options: options ?? { researchMode: "local", researchDepth: "normal", visualMode: "off" }, mapPath, mapId, sourceContent: JSON.stringify(sourceGroup.documents), controller, state: "running", progress: "" };
    this.integrationTask = task;
    this.render();
    const model = this.plugin.settings.cliModel;
    const language = this.plugin.settings.language;
    try {
      const result = await this.plugin.askModel({ title, summary: language === "en" ? "No conclusion yet" : "尚未形成結論", rules: "", detail: "", task: [goal, options?.requirements].filter(Boolean).join("\n\n"), ancestors: "", referenceGroups: [...(options?.referenceGroups ?? []), sourceGroup], onProgress: message => { if (this.integrationTask !== task) return; task.progress = message; options?.onProgress?.(message); this.render(); }, outputLanguage: options?.outputLanguage, mode: "synthesize", researchMode: options?.researchMode ?? "local", researchDepth: options?.researchDepth ?? "normal", visualMode: options?.visualMode ?? "auto" }, model, this.plugin.settings.cliReasoning, controller.signal);
      if (this.integrationTask !== task) return;
      if (controller.signal.aborted || this.path !== mapPath || this.map?.id !== mapId) throw new Error(t("ui.the_map_or_parent_topic_changed_while_ai_was_running_no_subt"));
      const latest = await this.topicReferenceGroup(sources, options?.synthesisContent === "summary" ? "summary" : "strong");
      if (JSON.stringify(latest.documents) !== task.sourceContent) throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
      task.state = "draft"; task.draft = result; this.render();
      if (review) this.reviewIntegratedDraft(task);
      else await this.saveIntegratedNode(title, sources, goal, rules, model, result, options?.outputLanguage ?? language, task);
    } catch (error) {
      if (this.integrationTask !== task) return;
      task.state = controller.signal.aborted ? "cancelled" : "failed";
      task.progress = controller.signal.aborted ? t("ui.research_stopped_existing_content_was_preserved") : error instanceof Error ? error.message : String(error);
      this.render();
      if (!controller.signal.aborted) throw error;
    }
  }
  private reviewIntegratedDraft(task: NonNullable<VisualAgentMapView["integrationTask"]>): void {
    if (!task.draft) return;
    new AiDraftModal(this.app, task.draft.summary, task.draft.detail, t("ui.confirm_new_synthesis_topic"), () => this.enqueue(() => this.saveIntegratedNode(task.title, task.sources, task.goal, task.rules, this.plugin.settings.cliModel, task.draft!, task.options.outputLanguage ?? this.plugin.settings.language, task))).open();
  }
  private async saveIntegratedNode(title: string, sources: MapNode[], goal: string, rules: string, model: string, result: AiResult, language: "zh-TW" | "en", task: NonNullable<VisualAgentMapView["integrationTask"]>): Promise<void> {
    if (!this.map || this.integrationTask !== task || this.path !== task.mapPath || this.map.id !== task.mapId || task.state !== "draft") throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
    const latest = await this.topicReferenceGroup(sources, task.options.synthesisContent === "summary" ? "summary" : "strong");
    if (JSON.stringify(latest.documents) !== task.sourceContent || sources.some(source => !this.map?.nodes.some(node => node.id === source.id && node.path === source.path))) throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
    const integrated = await this.plugin.repo.createNote(title, model, this.map, this.path, "workspace");
    try {
      await this.plugin.repo.updateNote(integrated.path, { summary: result.summary, detail: canonicalDetail(result.detail, language), visualReferences: visualReferencesMarkdown(result.visualReferences, language), prompt: goal, sourcePaths: sources.map(source => source.path), status: "completed" });
      integrated.parentId = null;
      integrated.x = Math.max(...sources.map(node => node.x)) + 340;
      integrated.y = sources.reduce((sum, node) => sum + node.y, 0) / sources.length;
      await this.mapChange(map => { map.nodes.push(integrated); });
      if (this.history.undoEntry) this.history.undoEntry.label = t("ui.confirm_new_synthesis_topic");
      this.integrationTask = null; this.selected = integrated.id; this.multiSelected.clear(); this.integrationMode = false;
      await this.hydrate(); this.render(); this.focusNode(integrated);
    } catch (error) {
      const disk = await this.plugin.repo.readMap(this.path);
      if (!disk.nodes.some(node => node.id === integrated.id)) {
        const parked = await this.plugin.repo.moveUnique(integrated.path, this.plugin.repo.topicFolder(this.path, "Unassigned"));
        await this.plugin.repo.setLifecycle(parked, disk.id, "", "unassigned");
        await this.plugin.rebuildDerivedData();
      } else {
        this.integrationTask = null; this.map = disk; this.selected = integrated.id; this.multiSelected.clear(); this.integrationMode = false;
        try { await this.plugin.rebuildDerivedData(); await this.hydrate(); this.render(); this.focusNode(integrated); }
        catch { this.render(); new Notice(t("ui.synthesis_saved_refresh_failed")); }
        return;
      }
      throw error;
    }
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
      const finish = (e: PointerEvent): void => { this.dragging = false; this.suppressClickUntil = Date.now() + 250; card.removeEventListener("pointermove", move); card.removeEventListener("pointerup", finish); card.removeEventListener("pointercancel", finish); if (e.type === "pointercancel") { card.style.left = `${origin.x}px`; card.style.top = `${origin.y}px`; this.drawEdges(); return; } if (moved) this.enqueue(() => this.mapChange(map => { const current = map.nodes.find(n => n.id === node.id); if (!current) return; current.x = Math.round(position.x); current.y = Math.round(position.y); })); else if (e.metaKey || e.ctrlKey) { if (this.multiSelected.has(node.id)) this.multiSelected.delete(node.id); else this.multiSelected.add(node.id); this.selected = node.id; this.render(); } else { this.multiSelected.clear(); this.selected = node.id; this.render(); if (node.mindSearchKind === "question") this.openMindSearchAnswer(node); else this.openDetails(node); } };
      card.addEventListener("pointermove", move); card.addEventListener("pointerup", finish); card.addEventListener("pointercancel", finish);
    });
  }
  private drawEdges(): void {
    if (!this.edgesEl || !this.stageEl || !this.map) return;
    this.edgesEl.replaceChildren();
    for (const node of visibleNodes(this.map.nodes)) {
      const parents = parentIdsForNode(node);
      for (const parentId of parents) {
        const parent = this.stageEl.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(parentId)}"]`), child = this.stageEl.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(node.id)}"]`); if (!parent || !child) continue;
        const x1 = parent.offsetLeft + parent.offsetWidth, y1 = parent.offsetTop + parent.offsetHeight / 2, x2 = child.offsetLeft, y2 = child.offsetTop + child.offsetHeight / 2, bend = Math.max(60, Math.abs(x2 - x1) / 2);
        const path = createSvg("path"); path.setAttribute("d", `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`); path.addClass("vam-edge"); if (parentId !== node.parentId) path.addClass("vam-edge-convergence"); this.edgesEl.appendChild(path);
      }
    }
  }
  private async runAgent(node: MapNode, done?: (result: AiResult) => void, failed?: (message: string) => void, overrides?: Partial<TaskContext>, onLaunchAccepted?: () => void): Promise<AgentTaskHandle | null> {
    const taskPath = node.path;
    const note = await this.plugin.repo.readNote(node.path);
    if (!(overrides?.task ?? note.prompt)) { const message = t("ui.enter_a_question_or_task_for_ai_first"); if (failed) failed(message); else new Notice(message); return null; }
    if (this.plugin.running.has(node.path)) { failed?.(t("ui.ai_running_ai")); return null; }
    const context: TaskContext = withThinkingOrigin({ title: note.title, summary: note.summary, rules: "", detail: note.detail, task: note.prompt, ancestors: await this.ancestorContext(node), workingFindings: note.newFindings, sourceContext: "", mode: "task", researchMode: note.researchMode, researchDepth: note.researchDepth, visualMode: note.visualMode, ...overrides }, note);
    const language = this.plugin.settings.language;
    this.plugin.pendingSuggestions.delete(node.path);
    this.plugin.running.add(node.path);
    const controller = new AbortController();
    const abortFromTaskModal = (): void => controller.abort();
    if (overrides?.signal?.aborted) controller.abort();
    else overrides?.signal?.addEventListener("abort", abortFromTaskModal, { once: true });
    this.plugin.activeTasks.set(taskPath, controller);
    const releaseStartup = (): void => {
      overrides?.signal?.removeEventListener("abort", abortFromTaskModal);
      if (this.plugin.activeTasks.get(taskPath) === controller) this.plugin.activeTasks.delete(taskPath);
      this.plugin.running.delete(taskPath);
    };
    let startupStatusAttempted = false;
    try {
      startupStatusAttempted = true;
      await this.plugin.repo.updateNote(node.path, { status: "running" });
      await this.hydrate(); this.render();
      if (controller.signal.aborted) {
        try { await this.plugin.repo.updateNote(node.path, { status: note.status }); }
        finally { releaseStartup(); }
        return null;
      }
    } catch (error) {
      try { if (startupStatusAttempted) await this.plugin.repo.updateNote(node.path, { status: note.status }); }
      catch { /* Keep the startup error; the registered task still must be released. */ }
      finally { releaseStartup(); }
      throw error;
    }
    // Leave the mutation queue immediately: independent branches can run concurrently.
    let exchangeId = "";
    let resolveAccepted!: (accepted: boolean) => void;
    const acceptedPromise = new Promise<boolean>(resolve => { resolveAccepted = resolve; });
    let requestAccepted = false;
    const markAccepted = (): void => { if (requestAccepted) return; requestAccepted = true; resolveAccepted(true); onLaunchAccepted?.(); };
    const completion = this.plugin.askModel(context, note.model, note.reasoning, controller.signal, id => { exchangeId = id; }, markAccepted).then(result => this.plugin.mutate(async () => {
      const latest = await this.plugin.repo.readNote(node.path);
      const stale = latest.thinkingOrigin !== note.thinkingOrigin || latest.title !== note.title || latest.prompt !== note.prompt || latest.rules !== note.rules || latest.detail !== note.detail || latest.summary !== note.summary || latest.model !== note.model || latest.reasoning !== note.reasoning || latest.researchMode !== note.researchMode || latest.researchDepth !== note.researchDepth || latest.visualMode !== note.visualMode || latest.sourcePaths.join("\n") !== note.sourcePaths.join("\n") || JSON.stringify(latest.referencePaths) !== JSON.stringify(note.referencePaths);
      if (controller.signal.aborted || stale) { await this.plugin.repo.updateNote(node.path, { status: note.status }); if (exchangeId && this.plugin.settings.aiExchangeLoggingEnabled) this.plugin.exchanges?.failed(exchangeId, stale ? "議題內容已變更，過時的 AI 結果未寫入。" : "研究已停止，結果未寫入。"); if (stale) { if (failed) failed(t("ui.the_topic_changed_so_the_outdated_ai_result_was_not_saved")); else new Notice(t("ui.the_topic_changed_so_the_outdated_ai_result_was_not_saved")); } return; }
      await this.plugin.repo.updateNote(node.path, { summary: result.summary, detail: canonicalDetail(result.detail, context.outputLanguage ?? this.plugin.settings.language), visualReferences: visualReferencesMarkdown(result.visualReferences, language), newFindings: "", status: "completed" });
      const saved = await this.plugin.repo.readNote(node.path);
      this.recordNoteWrite(node.path, { ...latest, status: note.status }, saved, ["summary", "detail", "visualReferences", "newFindings", "previewSection", "previewInitialized", "status"], t("ui.research_task"));
      if (exchangeId && this.plugin.settings.aiExchangeLoggingEnabled) this.plugin.exchanges?.completed(exchangeId);
      for (const view of this.plugin.views()) if (view !== this) view.history.clear();
      if (result.suggestions.length) {
        this.plugin.pendingSuggestions.set(node.path, result.suggestions.slice(0, 7).map(item => ({ ...item, thinkingOriginBaseline: originBaseline(note.thinkingOrigin) })));
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
    const accepted = await Promise.race([acceptedPromise, completion.then(() => false)]);
    if (!accepted) { await completion; return null; }
    return { finished: completion };
  }
}
