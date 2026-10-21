// Modals and task helpers used by the Visual Map view; moved from view.ts unchanged.
import type VisualAgentMapPlugin from "../../main";
import { listPresets } from "../../ai/prompt-presets";
import { PromptPresetsModal } from "../../ui/modals/prompt-presets-modal";
import { chooseAimContentLanguage } from "../aim/content-language";
import { noteLanguageOf, supportedLanguageLabel, SUPPORTED_LANGUAGES, t, type TranslationKey } from "../../i18n";
import { App, Component, MarkdownRenderer, Modal, Notice, Setting, TFile } from "obsidian";
import { ReferencePicker, type ReferenceTopic } from "../../ui/reference-picker";
import { type ReferenceGroup } from "../../ai/reference-materials";
import { DebugLogModal } from "../../ui/modals/debug-log-modal";
import { actionStatus, armDiscard, modalActions } from "../../ui/modals/action-bar";

export { armDiscard };
import { clone, type MapDocument, parseMap, serializeMap } from "../../map-model";
import {
  normalizeReasoningLevel,
  type ModelSource,
  type NotePatch,
  type ResearchDepth,
  type ResearchMode,
  type Settings,
  type TopicInfo,
  type VisualMode
} from "../../repository";
import type { AiResult, Suggestion } from "../../ai/types";
import {
  limitOutline,
  QUICK_OUTLINE_MAX_LEVELS,
  QUICK_OUTLINE_MAX_TOPICS,
  type OutlineLimits,
  type OutlineNode
} from "./outline-import";
import { syncModelSelect } from "../../core/model-discovery";
import {
  fieldLink,
  linkedField,
  researchDepthDescription,
  researchDepthField,
  noteStyleField
} from "./research-fields";
import { DetailTemplatesModal } from "../../ui/modals/detail-templates-modal";
import { builtinTemplates } from "../../ai/detail-templates";

export { researchDepthDescription };

export type SynthesisContent = "full" | "summary";
export interface TaskOptions {
  synthesisContent?: SynthesisContent;
  referenceGroups?: ReferenceGroup[];
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  outputLanguage?: Settings["language"];
  requirements?: string;
  researchMode: ResearchMode;
  researchDepth: ResearchDepth;
  visualMode: VisualMode;
  shallowResearch?: boolean;
  /**
   * Shallow research of the new subtopics also searches the web (and images when chosen). Absent or false: those quick
   * runs use local context only; the parent's decomposition keeps the dialog's own web choice.
   */
  shallowWebSearch?: boolean;
  /** This run's explicit content template choice; recorded on the topic when given. */
  detailTemplateId?: string;
  /** This run's explicit writing tone choice; recorded on the topic when given. */
  toneId?: string;
  /** Multi-select synthesis only: the name of the new topic. */
  synthesisTitle?: string;
  /** The synthesis draft step retried after chosen directions; it continues them even when the last draft failed. */
  continuesDirections?: boolean;
}
/**
 * How the view reports a synthesis run to the dialog that started it. While the dialog is open the next stage is
 * shown there; once it is closed the run falls back to the node badge (or selection bar) and a Notice, and nothing is
 * written into the closed dialog.
 */
export interface SynthesisObserver {
  isOpen: () => boolean;
  /** The provider accepted the request; `cancel` stops the run from now on. */
  accepted?: (cancel: () => void) => void;
  directions?: (items: Suggestion[]) => void;
  /** The result was written straight into the map (there is no draft review step); the dialog can close. */
  written?: () => void;
}
/**
 * What the view does for a dialog that hides itself once AI starts (see ui/background-run.ts). `begin` hands the
 * dialog's controller to the view, which shows Stop for it on the card or bar until the provider accepts the request;
 * `end` hands over to the view's own task state (accepted) or clears it (the run ended without being accepted).
 */
export interface BackgroundHooks {
  begin: (controller: AbortController) => void;
  end: () => void;
  /** A result finished while the dialog is closed and has no task state of its own to announce it. */
  completed?: (kind: "research" | "expand") => void;
  /** A quick outline finished while the dialog is closed: the view keeps it for review and announces it. */
  outlineReady?: (outline: Omit<PendingOutline, "discard">) => void;
}
/** A generated quick outline waiting for review: the dialog reopens straight at its review with these. */
export interface PendingOutline {
  nodes: OutlineNode[];
  /** Headings the AI wrote beyond the chosen levels or size; they were left out. */
  dropped: number;
  options: TaskOptions;
  /** Called once the reviewed outline was created: drops the waiting result. */
  discard: () => void;
}
export interface NextStepSettings {
  model: string;
  modelSource: ModelSource;
  reasoning: string;
  rules?: string;
  path?: string;
  save: (patch: NotePatch) => Promise<void>;
  running?: boolean;
  stop?: () => void;
  sources?: TaskSourceSettings;
  synthesisPending?: { directions: Suggestion[]; discard: () => void };
  templates?: { id: string; name: string }[];
  currentTemplate?: string;
  tones?: { id: string; name: string }[];
  /** Name of the tone the topic resolves to today (shown as the "keep" option). */
  currentTone?: string;
  /** Name of the note style (template + tone) the topic resolves to today, shown in "Keep current (…)". */
  currentStyle?: string;
  /** The topic's summary today, shown beside a draft that would replace it. */
  currentSummary?: string;
  /** The topic's research state and how many of its direct children are researched, for the suggested mode. */
  topicStatus?: "idea" | "running" | "completed" | "error";
  childrenCompleted?: number;
  /** Quick explore: an AI outline from a preset, reviewed in this dialog before any subtopic is created. */
  quickOutline?: QuickOutline;
  /** A quick outline generated while the dialog was closed; opening the dialog goes straight to its review. */
  pendingOutline?: PendingOutline;
  /** 「檢視整張圖」 (root topic) or 「檢視這個分支」 (subtopic): opens the AI structure review instead of a step. */
  structureReview?: { label: string; open: () => void };
  background?: BackgroundHooks;
}
export interface QuickOutline {
  presets: { id: string; name: string }[];
  /** Generates the outline for this topic; the outline's root is the topic itself. */
  generate: (
    request: { presetId: string; requirements: string; language: Settings["language"]; limits: OutlineLimits },
    signal: AbortSignal
  ) => Promise<OutlineNode[]>;
  /** Adds the reviewed outline under this topic. */
  create: (nodes: OutlineNode[], options: TaskOptions) => Promise<void>;
}
/** An outline's headings below its root as keyed proposals, so repeated titles stay in their own branch. */
export function outlineProposals(nodes: OutlineNode[]): ProposalItem[] {
  const root = nodes.filter(node => node.parent === null).length === 1 ? nodes[0]?.index : undefined;
  return nodes
    .filter(node => node.index !== root)
    .map(node => ({
      key: String(node.index),
      parentKey: node.parent === null || node.parent === root ? "" : String(node.parent),
      title: node.title,
      task: "",
      contribution: ""
    }));
}
/** The reviewed proposals back as outline nodes, parents before children, indexed from 0. */
export function proposalOutline(items: ProposalItem[]): OutlineNode[] {
  const index = new Map<string, number>();
  const nodes: OutlineNode[] = [];
  for (const item of items) {
    const parent = item.parentKey ? index.get(item.parentKey) : undefined;
    if (item.parentKey && parent === undefined) throw new Error(t("ui.select_the_parent_topic_before_its_child"));
    const node: OutlineNode = {
      index: nodes.length,
      title: item.title,
      level: parent === undefined ? 1 : nodes[parent].level + 1,
      parent: parent ?? null,
      line: 0
    };
    index.set(item.key ?? item.title, node.index);
    nodes.push(node);
  }
  return nodes;
}
/** Multi-select synthesis runs in the same dialog as a single topic's synthesis; this is what differs. */
export interface SelectionSynthesis {
  names: string[];
  /** Name offered for the new topic. */
  initialTitle: string;
  /** The direction used when the AI suggestions are skipped. */
  defaultDirection: string;
  fields: Pick<
    NextStepSettings,
    "sources" | "templates" | "currentTemplate" | "tones" | "currentTone" | "currentStyle"
  >;
  /** Reopened from the selection bar with directions waiting. */
  pending?: { directions: Suggestion[]; discard: () => void };
  background?: BackgroundHooks;
}
export function renderSynthesisContent(parent: HTMLElement, topics: string[]): HTMLSelectElement {
  const label = parent.createEl("label", { cls: "vam-field" });
  label.createSpan({ text: t("ui.synthesis_content") });
  const select = label.createEl("select");
  select.setAttr("aria-label", t("ui.synthesis_content"));
  select.createEl("option", { value: "full", text: t("ui.synthesis_content_full") });
  select.createEl("option", { value: "summary", text: t("ui.synthesis_content_summary") });
  select.value = "full";
  const hint = parent.createEl("p", { cls: "vam-hint", text: t("ui.synthesis_content_full_hint") });
  hint.setAttr("aria-live", "polite");
  select.addEventListener("change", () =>
    hint.setText(t(select.value === "summary" ? "ui.synthesis_content_summary_hint" : "ui.synthesis_content_full_hint"))
  );
  parent.createEl("p", { cls: "vam-hint", text: t("ui.synthesis_content_scope") });
  parent.createEl("strong", { text: t("ui.synthesis_source_topics") });
  if (topics.length) {
    const list = parent.createEl("ul");
    for (const title of topics) list.createEl("li", { text: title });
  } else parent.createEl("p", { cls: "vam-hint", text: t("ui.synthesis_no_source_topics") });
  return select;
}
export function imageReferencesFromMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  const blocks = lines.flatMap((line, index) =>
    /^\s*!\[[^\]]*\]\(https?:\/\/[^\s)]+\)/i.test(line)
      ? [
          lines
            .slice(Math.max(0, index - 2), Math.min(lines.length, index + 4))
            .join("\n")
            .trim()
        ]
      : []
  );
  return [...new Set(blocks)].join("\n\n");
}
/** Localized name of a reasoning level, for summaries; unknown values normalize the way the settings do. */
export function reasoningLabel(level: string): string {
  const labels: Record<string, string> = {
    auto: t("ui.auto"),
    low: t("ui.low"),
    medium: t("ui.medium"),
    high: t("ui.high")
  };
  return labels[normalizeReasoningLevel(level)];
}
export class PartialChildBatchError extends Error {}
export interface AgentTaskHandle {
  finished: Promise<void>;
}
export interface TaskSourceSettings {
  topics: () => Promise<ReferenceTopic[]>;
  readTopic: (
    topic: ReferenceTopic,
    signal: AbortSignal,
    progress: (message: string) => void
  ) => Promise<{ path: string; content: string }[]>;
  currentTopicId: string;
  currentLabel: string;
  synthesisLabel?: string;
  synthesisTopics?: string[];
}
export class NextStepModal extends Modal {
  private closed = false;
  /** AI started and this dialog hid itself; closing no longer stops the run (Stop is on the card or bar). */
  private detached = false;
  private backgroundBegan = false;
  private runPending = false;
  /** Model and effort edits wait here; they are saved when a run starts, never when the dialog is cancelled. */
  private pendingSettings: NotePatch = {};
  constructor(
    app: App,
    private topic: string,
    private depth: ResearchDepth,
    private childrenCount: number,
    private pendingCount: number,
    private plugin: VisualAgentMapPlugin,
    private research: (
      options: TaskOptions,
      focus: string,
      done: (result: AiResult) => void,
      failed: (message: string) => void,
      accepted: () => void
    ) => Promise<void>,
    private expand: (
      options: TaskOptions,
      direction: string,
      found: (items: Suggestion[], create: (items: Suggestion[]) => Promise<void>) => void,
      failed: (message: string, retryable?: boolean) => void,
      accepted: () => void
    ) => Promise<void>,
    private synthesize: (
      options: TaskOptions,
      direction: string | null,
      failed: (message: string) => void,
      accepted: () => void,
      observer?: SynthesisObserver
    ) => Promise<void>,
    private modelSettings?: NextStepSettings,
    /** Not `selection`: Obsidian's Modal keeps the page's text selection in that field when it opens. */
    private selectionFlow?: SelectionSynthesis
  ) {
    super(app);
  }
  /** Where the shared fields (data sources, template, tone) come from: the topic's settings, or the selection's. */
  private get info():
    | Pick<NextStepSettings, "sources" | "templates" | "currentTemplate" | "tones" | "currentTone" | "currentStyle">
    | undefined {
    return this.modelSettings ?? this.selectionFlow?.fields;
  }
  /** Suggests the next step from where the topic stands: frontier → research, settled leaf → expand, settled branch → synthesize. */
  private suggestedMode(): "research" | "expand" | "synthesize" {
    const settings = this.modelSettings;
    if (settings?.synthesisPending) return "synthesize";
    if (settings?.pendingOutline) return "expand";
    if (settings?.topicStatus !== "completed") return "research";
    if (!this.childrenCount) return "expand";
    return settings.childrenCompleted === this.childrenCount ? "synthesize" : "research";
  }
  private taskSignal?: AbortSignal;
  private taskController?: AbortController;
  private unsubscribeModels?: () => void;
  /** One data-source picker shared by every step, so choices survive switching steps. */
  private addReferencePicker(panel: HTMLElement):
    | {
        picker: ReferencePicker;
        disclosure: HTMLElement;
        forMode: (mode: "research" | "expand" | "synthesize") => void;
      }
    | undefined {
    const sources = this.info?.sources;
    if (!sources) return undefined;
    const disclosure = panel.createEl("details", { cls: "vam-next-source-details" });
    disclosure.open = false;
    const summary = disclosure.createEl("summary");
    const summaryRow = summary.createSpan({ cls: "vam-next-source-summary-row" });
    summaryRow.createEl("strong", { text: t("ui.data_sources") });
    const selection = summaryRow.createSpan({ cls: "vam-next-source-summary" });
    const pickerContent = disclosure.createDiv();
    const picker = new ReferencePicker(
      this.app,
      pickerContent,
      sources.topics,
      sources.readTopic,
      sources.currentTopicId,
      sources.currentLabel
    );
    const updateSelection = (): void => selection.setText(picker.describe());
    pickerContent.addEventListener("change", updateSelection);
    updateSelection();
    // Synthesis works from existing findings, so it defaults to no web search until the user chooses otherwise.
    const forMode = (mode: "research" | "expand" | "synthesize"): void => {
      const synthesize = mode === "synthesize";
      picker.setCurrentLabel(synthesize ? (sources.synthesisLabel ?? sources.currentLabel) : sources.currentLabel);
      picker.setNetworkDefault(!synthesize, !synthesize);
      updateSelection();
    };
    return { picker, disclosure, forMode };
  }
  private requirementsInput?: HTMLTextAreaElement;
  private renderRequirements(parent: HTMLElement): void {
    const disclosure = parent.createEl("details", { cls: "vam-next-requirements" });
    disclosure.open = false;
    const summary = disclosure.createEl("summary", { text: t("ui.additional_requirements") });
    const value = summary.createSpan({ cls: "vam-next-disclosure-value", text: t("ui.not_set") });
    const input = disclosure.createEl("textarea", { cls: "vam-next-focus" });
    this.requirementsInput = input;
    input.rows = 3;
    input.setAttr("aria-label", t("ui.additional_requirements"));
    input.addEventListener("input", () => {
      const text = input.value.trim().replace(/\s+/g, " ");
      value.setText(text ? (text.length > 24 ? `${text.slice(0, 24)}…` : text) : t("ui.not_set"));
    });
    disclosure.createEl("p", { text: t("ui.requirements_this_task_only"), cls: "vam-hint" });
    if (this.modelSettings?.rules?.trim())
      parent.createEl("p", { text: t("ui.legacy_rules_not_applied"), cls: "vam-hint" });
  }
  private requirements(): string {
    return this.requirementsInput?.value.trim() ?? "";
  }
  private get background(): BackgroundHooks | undefined {
    return this.modelSettings?.background ?? this.selectionFlow?.background;
  }
  /**
   * Hides the dialog once AI starts: usage confirmed, settings saved and sources ready (so a validation error still
   * shows in the dialog). The view takes over Stop for `controller` until the provider accepts the request.
   */
  private detach(controller: AbortController): void {
    this.detached = true;
    // Stop before the provider took the pre-started process leaves nothing waiting.
    controller.signal.addEventListener("abort", () => this.plugin.releaseWarmClaude?.(), { once: true });
    this.backgroundBegan = true;
    this.background?.begin(controller);
    this.close();
  }
  private endBackground(): void {
    if (!this.backgroundBegan) return;
    this.backgroundBegan = false;
    this.background?.end();
  }
  /** True when a started run should stop: it was aborted, or its dialog closed before AI started. */
  private dead(controller: AbortController): boolean {
    return controller.signal.aborted || (this.closed && !this.detached);
  }
  /** Pre-starts the Claude CLI for the research step (no model call); a run that does not use it kills it. */
  private prewarmAi(webSearch = true, mode?: "synthesize"): void {
    if (this.selectionFlow || this.closed) return;
    this.plugin.prewarmClaude?.(
      this.modelSettings?.model ?? this.plugin.settings.cliModel,
      this.modelSettings?.reasoning,
      webSearch,
      mode
    );
  }
  onClose(): void {
    this.closed = true;
    // Closed without starting AI: the pre-started process is no longer needed. A started run took (or will take) it.
    if (!this.detached) this.plugin.releaseWarmClaude?.();
    // A run that the provider already accepted, or that hid this dialog, keeps going in the background; one still
    // starting is stopped.
    if (!this.detached) this.taskController?.abort();
    this.unsubscribeModels?.();
  }
  /** Saves the model and effort chosen in this dialog, once, at the moment a run actually starts. */
  private async flushSettings(): Promise<void> {
    const patch = this.pendingSettings;
    if (!Object.keys(patch).length || !this.modelSettings) return;
    this.pendingSettings = {};
    try {
      await this.modelSettings.save(patch);
    } catch (error) {
      this.pendingSettings = { ...patch, ...this.pendingSettings };
      throw error;
    }
  }
  private renderModelSettings(parent: HTMLElement): HTMLElement | undefined {
    if (!this.modelSettings) return;
    const settings = this.modelSettings;
    const advanced = parent.createEl("details", { cls: "vam-advanced vam-next-model" });
    const advancedValue = advanced
      .createEl("summary", { text: t("ui.model_and_advanced_settings") })
      .createSpan({ cls: "vam-next-disclosure-value" });
    const save = (patch: NotePatch): void => {
      this.pendingSettings = { ...this.pendingSettings, ...patch };
    };
    const { field: modelLabel, head: modelHead } = linkedField(advanced, t("ui.model"));
    const model = modelLabel.createEl("select");
    model.setAttr("aria-label", t("ui.model"));
    model.add(new Option(this.plugin.modelLabel(settings.model), settings.model));
    model.value = settings.model;
    const optionList =
      typeof this.plugin.availableModels === "function"
        ? this.plugin.availableModels()
        : this.plugin.settings.models
            .split(/[\n,]/)
            .map((value: string) => value.trim())
            .filter(Boolean);
    const options = new Set<string>(optionList);
    const syncModels = (): void => {
      syncModelSelect(
        model,
        this.plugin.availableModels(),
        id => this.plugin.modelLabel(id),
        t("ui.current_model_is_unavailable")
      );
      options.clear();
      this.plugin.availableModels().forEach(id => options.add(id));
    };
    syncModels();
    // One way to recover: the link opens the setup guide when the CLI is missing, otherwise checks again.
    fieldLink(modelHead, t("ui.connection_repair"), () => this.plugin.repairConnection(model.value));
    const discovery = advanced.createDiv("vam-model-discovery-status");
    const discoveryText = discovery.createSpan({ cls: "vam-hint" });
    const updateDiscovery = (): void => {
      const codex = this.plugin.modelDiscoveryState("codex"),
        claude = this.plugin.modelDiscoveryState("claude");
      discoveryText.setText(
        `Codex: ${t(`ui.model_status_${codex.status}`)}${codex.error ? ` · ${codex.error}` : ""} | Claude: ${t(`ui.model_status_${claude.status}`)}`
      );
      syncModels();
    };
    this.unsubscribeModels?.();
    this.unsubscribeModels = this.plugin.subscribeModelDiscovery(() => {
      if (!this.closed) updateDiscovery();
    });
    updateDiscovery();
    void this.plugin.refreshModelDiscovery("codex");
    void this.plugin.refreshModelDiscovery("claude");
    const sourceLabels: Record<ModelSource, string> = {
      workspace: t("ui.workspace_default"),
      inherited: t("ui.inherited_at_creation"),
      manual: t("ui.manually_selected")
    };
    const modelSummary = advanced.createEl("p", {
      cls: "vam-hint",
      text: t(
        "ui.0_1_reasoning_can_be_adjusted_per_topic",
        this.plugin.modelLabel(settings.model),
        sourceLabels[settings.modelSource]
      )
    });
    model.value = settings.model;
    model.addEventListener("change", () => {
      if (!options.has(model.value)) return;
      settings.model = model.value;
      settings.modelSource = "manual";
      modelSummary.setText(
        t(
          "ui.0_1_reasoning_can_be_adjusted_per_topic",
          this.plugin.modelLabel(settings.model),
          sourceLabels[settings.modelSource]
        )
      );
      save({ model: settings.model, modelSource: settings.modelSource });
      describeModel();
    });
    const reasoningField = advanced.createEl("label", { cls: "vam-field" });
    reasoningField.createSpan({ text: t("ui.reasoning_level") });
    const reasoning = reasoningField.createEl("select");
    reasoning.setAttr("aria-label", t("ui.reasoning_level"));
    for (const value of ["auto", "low", "medium", "high"])
      reasoning.createEl("option", { value, text: reasoningLabel(value) });
    reasoning.value = normalizeReasoningLevel(settings.reasoning);
    const describeModel = (): void =>
      advancedValue.setText(`${this.plugin.modelLabel(settings.model)} · ${reasoningLabel(settings.reasoning)}`);
    describeModel();
    reasoning.addEventListener("change", () => {
      settings.reasoning = normalizeReasoningLevel(reasoning.value);
      save({ reasoning: normalizeReasoningLevel(reasoning.value) });
      describeModel();
    });
    return advanced;
  }
  private async run(
    panel: HTMLElement,
    button: HTMLButtonElement,
    work: () => Promise<void>,
    needsUsage = true
  ): Promise<void> {
    if (button.disabled || this.runPending || (this.taskController && !this.taskController.signal.aborted)) return;
    this.runPending = true;
    button.disabled = true;
    const start = async (): Promise<void> => {
      if (this.closed) return;
      button.disabled = true;
      const failureHelp = panel.querySelector<HTMLElement>(".vam-ai-failure-help");
      if (failureHelp) failureHelp.hidden = true;
      const controller = new AbortController();
      this.taskController = controller;
      this.taskSignal = controller.signal;
      const tasksBefore = new Set(this.plugin.activeTasks?.keys?.() ?? []);
      const status = panel.querySelector<HTMLElement>(".vam-next-status");
      status?.setText(t("ui.ai_running_ai"));
      let cancel = panel.querySelector<HTMLButtonElement>(".vam-task-cancel");
      if (!cancel) cancel = panel.createEl("button", { text: t("ui.cancel"), cls: "vam-task-cancel" });
      cancel.hidden = false;
      cancel.onclick = () => controller.abort();
      try {
        await this.flushSettings();
        if (this.dead(controller)) return;
        await work();
      } catch (error) {
        // A task already handed to the background can still fail after the dialog closed; say so.
        if (this.closed && !controller.signal.aborted)
          new Notice(error instanceof Error ? error.message : String(error));
        this.failed(
          panel,
          button,
          controller.signal.aborted ? t("ui.ai_task_cancelled") : error instanceof Error ? error.message : String(error)
        );
      } finally {
        this.endBackground();
        const backgroundTaskRunning = [...(this.plugin.activeTasks?.keys?.() ?? [])].some(
          path => !tasksBefore.has(path)
        );
        const release = (): void => {
          if (!this.closed) cancel.hidden = true;
          if (this.taskController === controller) {
            this.taskSignal = undefined;
            this.taskController = undefined;
          }
        };
        if (backgroundTaskRunning) {
          const waitForTasks = (): void => {
            if (this.taskController !== controller) return;
            if ([...(this.plugin.activeTasks?.keys?.() ?? [])].some(path => !tasksBefore.has(path)))
              window.setTimeout(waitForTasks, 250);
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
        : (await this.plugin.aiReadyForModel(model)) && (await start(), true);
      if (!started) button.disabled = false;
    } catch (error) {
      this.failed(panel, button, error instanceof Error ? error.message : String(error));
    } finally {
      this.runPending = false;
    }
  }
  /**
   * One synthesis step (directions or draft) from this dialog. The run is the view's: while this dialog is open the
   * next stage appears here, and if it is closed the run carries on in the background and falls back to the node badge.
   */
  private launchSynthesis(
    panel: HTMLElement,
    button: HTMLButtonElement,
    direction: string | null,
    buildOptions: (signal: AbortSignal) => TaskOptions | Promise<TaskOptions>,
    flow: { directions: (items: Suggestion[]) => void; written: () => void }
  ): void {
    void this.run(panel, button, async () => {
      const controller = this.taskController;
      if (!controller) return;
      const options = await buildOptions(controller.signal);
      if (this.dead(controller)) return;
      this.detach(controller);
      const cancel = panel.querySelector<HTMLButtonElement>(".vam-task-cancel");
      let outcome = false;
      let failedShown = false;
      let userCancelled = false;
      const settle = (): void => {
        if (cancel && !this.closed) cancel.hidden = true;
      };
      const observer: SynthesisObserver = {
        isOpen: () => !this.closed,
        accepted: stop => {
          // From here the run has its own controller: closing this dialog must not stop it, Cancel does.
          if (this.taskController === controller) {
            this.taskSignal = undefined;
            this.taskController = undefined;
          }
          this.endBackground();
          if (cancel && !this.closed) {
            cancel.hidden = false;
            cancel.onclick = () => {
              userCancelled = true;
              stop();
            };
          }
        },
        directions: items => {
          outcome = true;
          settle();
          flow.directions(items);
        },
        written: () => {
          outcome = true;
          settle();
          flow.written();
        }
      };
      await this.synthesize(
        options,
        direction,
        message => {
          if (this.closed) {
            new Notice(message);
            return;
          }
          settle();
          failedShown = true;
          if (userCancelled) this.failed(panel, button, message);
          else this.failedAi(panel, button, message);
        },
        () => {},
        observer
      );
      if (!this.closed && !outcome && !failedShown) {
        settle();
        this.failed(panel, button, t("ui.ai_task_cancelled"));
      }
    });
  }
  private failed(panel: HTMLElement, button: HTMLButtonElement, message: string): void {
    if (this.closed) return;
    panel.querySelector<HTMLElement>(".vam-next-status")?.setText(message);
    button.disabled = false;
  }
  private startedInBackground(): void {
    new Notice(t("ui.task_started_in_background_0", this.topic));
    this.close();
  }
  private failedAi(panel: HTMLElement, button: HTMLButtonElement, message: string): void {
    this.failed(panel, button, message);
    if (this.closed) return;
    let help = panel.querySelector<HTMLElement>(".vam-ai-failure-help");
    if (!help) {
      help = panel.createDiv({ cls: "vam-ai-failure-help", attr: { role: "alert" } });
      help.createEl("p", { text: t("ui.ai_failure_next_steps"), cls: "vam-hint" });
      help
        .createEl("button", { text: t("ui.open_debug_log") })
        .addEventListener("click", () =>
          new DebugLogModal(
            this.app,
            this.plugin.logs,
            this.plugin.exchanges,
            () => this.plugin.settings.aiExchangeLoggingEnabled
          ).open()
        );
    }
    help.hidden = false;
  }
  private proposals(
    panel: HTMLElement,
    suggestions: Suggestion[],
    create: (items: Suggestion[]) => Promise<void>,
    button: HTMLButtonElement,
    consumed: () => void,
    options: TaskOptions
  ): void {
    if (this.closed) return;
    const result = panel.querySelector<HTMLElement>(".vam-next-result")!;
    result.empty();
    result.createEl("h4", { text: t("ui.ai_subtopic_proposals") });
    result.createEl("p", { text: t("ui.select_subtopics_to_create_you_can_edit_their_names_and_task") });
    let showCount = (_count: number): void => {};
    const list = renderProposalList(result, suggestions, count => showCount(count));
    const confirm = result.createEl("button", { text: t("ui.create_0_subtopics", list.count()), cls: "mod-cta" });
    showCount = count => {
      confirm.setText(t("ui.create_0_subtopics", count));
      if (!this.runPending) confirm.disabled = count === 0;
      // A changed selection clears an old error, but keeps the review hint.
      const status = panel.querySelector<HTMLElement>(".vam-next-status");
      if (status && status.textContent !== t("ui.review_ai_suggested_subtopics")) status.setText("");
    };
    // While proposals are open, "Create subtopics" is the one primary action.
    button.classList.toggle("mod-cta", false);
    confirm.addEventListener("click", () => {
      void (async () => {
        const picked = list.selected();
        if (typeof picked === "string") {
          if (picked === t("ui.select_at_least_one_subtopic"))
            panel.querySelector<HTMLElement>(".vam-next-status")?.setText(picked);
          else this.failed(panel, button, picked);
          return;
        }
        void this.run(
          panel,
          confirm,
          async () => {
            options.signal = this.taskSignal;
            panel.querySelector<HTMLElement>(".vam-next-status")?.setText(t("ui.creating_subtopics"));
            try {
              await create(picked);
              if (options.shallowResearch) {
                this.taskSignal = undefined;
                this.taskController = undefined;
                this.startedInBackground();
                return;
              }
              // Guided expansion ends here: the subtopics exist, so say so and close instead of leaving a spent dialog.
              consumed();
              new Notice(t("ui.subtopics_created"));
              this.taskSignal = undefined;
              this.taskController = undefined;
              this.close();
            } catch (error) {
              if (error instanceof PartialChildBatchError) {
                result.empty();
                button.classList.toggle("mod-cta", true);
                consumed();
                button.disabled = true;
              }
              throw error;
            }
          },
          false
        );
      })();
    });
    panel.querySelector<HTMLElement>(".vam-next-status")?.setText(t("ui.review_ai_suggested_subtopics"));
  }
  /** The generated outline, reviewed here; nothing is created until the user confirms. */
  private outlineReview(
    panel: HTMLElement,
    nodes: OutlineNode[],
    button: HTMLButtonElement,
    create: (nodes: OutlineNode[], options: TaskOptions) => Promise<void>,
    options: TaskOptions,
    /** Headings the AI wrote beyond the chosen levels or size; they are left out of the review. */
    dropped = 0
  ): void {
    if (this.closed) return;
    const result = panel.querySelector<HTMLElement>(".vam-next-result")!;
    result.empty();
    const status = (): HTMLElement | null => panel.querySelector<HTMLElement>(".vam-next-status");
    const items = outlineProposals(nodes);
    if (!items.length) {
      this.failed(panel, button, t("ui.quick_outline_empty"));
      return;
    }
    result.createEl("h4", { text: t("ui.quick_outline_review") });
    if (dropped) result.createEl("p", { cls: "vam-hint", text: t("ui.quick_outline_trimmed_0", dropped) });
    let showCount = (_count: number): void => {};
    const list = renderProposalList(result, items, count => showCount(count), { compact: true });
    const confirm = result.createEl("button", { text: t("ui.create_0_subtopics", list.count()), cls: "mod-cta" });
    showCount = count => {
      confirm.setText(t("ui.create_0_subtopics", count));
      if (!this.runPending) confirm.disabled = count === 0;
    };
    button.classList.toggle("mod-cta", false);
    confirm.addEventListener("click", () => {
      const picked = list.selected();
      if (typeof picked === "string") {
        status()?.setText(picked);
        return;
      }
      void this.run(
        panel,
        confirm,
        async () => {
          options.signal = this.taskSignal;
          status()?.setText(t("ui.creating_subtopics"));
          await create(proposalOutline(picked), options);
          this.taskSignal = undefined;
          this.taskController = undefined;
          this.modelSettings?.pendingOutline?.discard();
          if (options.shallowResearch) {
            this.startedInBackground();
            return;
          }
          new Notice(t("ui.subtopics_created"));
          this.close();
        },
        false
      );
    });
    status()?.setText(t("ui.quick_outline_review_hint"));
  }
  onOpen(): void {
    this.modalEl.addClass("vam-next-modal");
    const selection = this.selectionFlow;
    this.titleEl.setText(t(selection ? "ui.confirm_topic_synthesis" : "ui.how_would_you_like_to_explore_next"));
    // The decision comes first: where the topic stands, the next step and one summary line; every option sits under Adjust.
    const intro = this.contentEl.createEl("p", { cls: "vam-modal-intro vam-next-topic" });
    if (!selection) intro.createSpan({ text: t("ui.current_topic_0", this.topic) });
    const topicStatus = this.modelSettings?.topicStatus;
    if (topicStatus)
      intro.createSpan({
        cls: `vam-status vam-status-${topicStatus}`,
        text: t(
          topicStatus === "completed"
            ? "ui.researched"
            : topicStatus === "running"
              ? "ui.ai_running"
              : topicStatus === "error"
                ? "ui.task_error"
                : "ui.to_research"
        )
      });
    const initialMode = selection ? "synthesize" : this.suggestedMode();
    let currentMode: "research" | "expand" | "synthesize" = initialMode;
    // One action bar below the scrolling content: Close plus the current step's primary action.
    const actions = modalActions(this);
    const closeButton = actions.createEl("button", { text: t("ui.close"), cls: "vam-next-close" });
    closeButton.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { text: t("ui.confirm_research_task"), cls: "mod-cta" });
    confirm.dataset.topicRun = t("ui.confirm_research_task");
    confirm.disabled = !!this.modelSettings?.running;
    let synthesisContentSelect: HTMLSelectElement | undefined;
    // The three steps are one choice: a radio group with arrow-key movement, not three toggles.
    const cards = this.contentEl.createDiv("vam-next-cards");
    cards.setAttr("role", "radiogroup");
    cards.setAttr("aria-label", t("ui.how_would_you_like_to_explore_next"));
    let show: (mode: "research" | "expand" | "synthesize") => void;
    const card = (
      title: TranslationKey,
      description: TranslationKey,
      mode: "research" | "expand" | "synthesize"
    ): HTMLButtonElement => {
      const button = cards.createEl("button", { cls: "vam-next-card" });
      const copy = button.createSpan();
      copy.createEl("strong", { text: t(title) });
      copy.createSpan({ text: t(description) });
      button.setAttr("role", "radio");
      button.setAttr("aria-checked", mode === initialMode ? "true" : "false");
      button.tabIndex = mode === initialMode ? 0 : -1;
      button.addEventListener("click", () => show(mode));
      button.addEventListener("keydown", event => {
        const order = ["research", "expand", "synthesize"] as const;
        const step = ["ArrowRight", "ArrowDown"].includes(event.key)
          ? 1
          : ["ArrowLeft", "ArrowUp"].includes(event.key)
            ? -1
            : 0;
        if (!step) return;
        event.preventDefault();
        const next = order[(order.indexOf(mode) + step + order.length) % order.length];
        show(next);
        cardFor[next].focus();
      });
      if (mode === initialMode) {
        button.addClass("is-active");
        button.createSpan({ text: t("ui.suggested"), cls: "vam-next-suggested" });
      }
      return button;
    };
    const researchCard = card("ui.research_deeper", "ui.find_answers_for_this_topic_at_your_chosen_depth", "research");
    const expandCard = card(
      "ui.expand_the_map",
      "ui.discuss_directions_or_explore_multiple_levels_with_shallow_r",
      "expand"
    );
    const synthesizeCard = card(
      "ui.synthesize_findings",
      "ui.find_shared_conclusions_differences_and_next_steps_across_su",
      "synthesize"
    );
    const cardFor = { research: researchCard, expand: expandCard, synthesize: synthesizeCard };
    const structureReview = selection ? undefined : this.modelSettings?.structureReview;
    if (structureReview) {
      const row = this.contentEl.createDiv("vam-next-structure");
      row.createSpan({ cls: "vam-next-structure-label", text: t("ui.structure_review_entry_label") });
      row
        .createEl("button", { text: structureReview.label, cls: "vam-next-structure-open" })
        .addEventListener("click", () => {
          this.close();
          structureReview.open();
        });
      this.contentEl.createEl("p", {
        cls: "vam-hint vam-next-structure-hint",
        text: t("ui.structure_review_entry_hint")
      });
    }
    // Multi-select synthesis is this same dialog with only its synthesis step.
    if (selection) cards.addClass("is-hidden");
    if (this.modelSettings?.running) {
      const running = this.contentEl.createDiv("vam-next-running");
      running.createSpan({ text: t("ui.ai_running_ai") });
      if (this.modelSettings.stop)
        running
          .createEl("button", { text: t("ui.stop_research") })
          .addEventListener("click", () => this.modelSettings?.stop?.());
    }
    // What this run will do, in one line; the details are under Adjust.
    const summaryEl = this.contentEl.createEl("p", { cls: "vam-next-summary", attr: { "aria-live": "polite" } });
    const research = this.contentEl.createDiv("vam-next-research");
    const expandPanel = this.contentEl.createDiv("vam-next-research vam-next-choice");
    const synthesizePanel = this.contentEl.createDiv("vam-next-research vam-next-choice");
    // Every option for every step lives here, in one disclosure; each step shows only its own section.
    const adjust = this.contentEl.createEl("details", { cls: "vam-next-adjust" });
    adjust.open = false;
    adjust.createEl("summary", { text: t("ui.adjust") });
    const adjustBody = adjust.createDiv("vam-next-adjust-body");
    const adjustFor = {
      research: adjustBody.createDiv("vam-next-adjust-section"),
      expand: adjustBody.createDiv("vam-next-adjust-section"),
      synthesize: adjustBody.createDiv("vam-next-adjust-section")
    };
    // --- Research: one confirm; the depth is under Adjust.
    research.createEl("p", { text: t("ui.start_from_this_node_s_question_update_only_this_node") });
    const depthField = researchDepthField(adjustFor.research, {
      initial: this.depth,
      onChange: () => refreshSummary()
    });
    research.createEl("p", { cls: "vam-next-status", attr: { "aria-live": "polite" } });
    confirm.addEventListener("click", () => {
      void this.run(research, confirm, async () => {
        const controller = this.taskController;
        const selected = await sharedSources?.picker.ready();
        if (!controller || this.dead(controller)) return;
        const options: TaskOptions = {
          referenceGroups: selected?.groups ?? [],
          outputLanguage: languageSelect.value as Settings["language"],
          researchMode: selected?.webSearch ? "research" : "local",
          researchDepth: depthField.value(),
          visualMode: selected?.imageSearch ? "auto" : "off",
          requirements: this.requirements(),
          ...(templateId() ? { detailTemplateId: templateId() } : {}),
          ...(toneId() ? { toneId: toneId() } : {}),
          signal: controller.signal,
          onProgress: message => {
            if (!this.closed && !controller.signal.aborted)
              research.querySelector<HTMLElement>(".vam-next-status")?.setText(message);
          }
        };
        this.detach(controller);
        let launchAccepted = false;
        let launchFailed = false;
        const release = (): void => {
          if (this.taskController === controller) {
            this.taskSignal = undefined;
            this.taskController = undefined;
          }
          if (!this.closed) {
            const cancel = research.querySelector<HTMLButtonElement>(".vam-task-cancel");
            if (cancel) cancel.hidden = true;
          }
        };
        const accepted = (): void => {
          if (controller.signal.aborted || this.taskController !== controller) return;
          this.taskSignal = undefined;
          this.taskController = undefined;
          launchAccepted = true;
          // The dialog already hid itself when AI started; the card shows the running state and Stop from here.
          this.endBackground();
          if (this.closed) return;
          const cancel = research.querySelector<HTMLButtonElement>(".vam-task-cancel");
          if (cancel) cancel.hidden = true;
          this.startedInBackground();
        };
        await this.research(
          options,
          "",
          () => {
            if (this.closed) {
              this.background?.completed?.("research");
              return;
            }
            release();
            this.close();
          },
          message => {
            if (this.closed) {
              new Notice(message);
              return;
            }
            release();
            launchFailed = true;
            this.failedAi(research, confirm, message);
          },
          accepted
        );
        if (!this.closed && !launchAccepted && !launchFailed) {
          release();
          this.failed(research, confirm, t("ui.ai_task_cancelled"));
        }
      });
    });
    // --- Expand: guided directions by default; the quick-explore numbers are under Adjust.
    const modes = adjustFor.expand.createDiv("vam-next-depths vam-next-segmented");
    modes.setAttr("role", "radiogroup");
    modes.setAttr("aria-label", t("ui.expand_the_map"));
    const guided = modes.createEl("button", { text: t("ui.choose_directions_together"), cls: "is-active" });
    const quick = modes.createEl("button", { text: t("ui.quickly_explore_a_map") });
    for (const [option, checked] of [
      [guided, true],
      [quick, false]
    ] as const) {
      option.setAttr("role", "radio");
      option.setAttr("aria-checked", String(checked));
      option.tabIndex = checked ? 0 : -1;
      option.addEventListener("keydown", event => {
        if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) return;
        event.preventDefault();
        const other = option === guided ? quick : guided;
        setExpandMode(other === quick);
        other.focus();
      });
    }
    let multiLayer = false;
    const setExpandMode = (value: boolean): void => {
      multiLayer = value;
      guided.classList.toggle("is-active", !value);
      quick.classList.toggle("is-active", value);
      guided.setAttr("aria-checked", String(!value));
      quick.setAttr("aria-checked", String(value));
      guided.tabIndex = value ? -1 : 0;
      quick.tabIndex = value ? 0 : -1;
      modeHint.setText(
        value
          ? t("ui.quick_outline_mode_hint")
          : this.pendingCount
            ? t("ui.you_have_pending_proposals_review_them_here")
            : t("ui.ai_suggests_one_level_of_subtopics_review_or_edit_them_befor")
      );
      quickLimits.classList.toggle("is-hidden", !value);
      expandFooterText.setText(
        shallow.checked
          ? t("ui.research_each_subtopic_after_creation_and_use_codex_quota")
          : t("ui.create_subtopics_without_research")
      );
      expandButton.setText(
        value
          ? t("ui.outline_ai_run")
          : this.pendingCount
            ? t("ui.review_ai_subtopic_suggestions")
            : t("ui.get_expansion_directions")
      );
      expandButton.dataset.topicRun = expandButton.textContent ?? "";
      expandButton.disabled = !!this.modelSettings?.running || (value && !quickOutline);
      refreshSummary();
    };
    guided.addEventListener("click", () => setExpandMode(false));
    quick.addEventListener("click", () => setExpandMode(true));
    const modeHint = expandPanel.createEl("p", {
      text: this.pendingCount
        ? t("ui.you_have_pending_proposals_review_them_here")
        : t("ui.ai_suggests_one_level_of_subtopics_review_or_edit_them_befor")
    });
    // Quick explore generates an outline from a preset; it is reviewed here before anything is created.
    const quickOutline = this.modelSettings?.quickOutline;
    const quickLimits = adjustFor.expand.createDiv("vam-quick-limits is-hidden");
    const presetLabel = quickLimits.createEl("label", { cls: "vam-field" });
    presetLabel.createSpan({ text: t("ui.outline_ai_preset") });
    const presetSelect = presetLabel.createEl("select");
    presetSelect.setAttr("aria-label", t("ui.outline_ai_preset"));
    for (const preset of quickOutline?.presets ?? [])
      presetSelect.createEl("option", { value: preset.id, text: preset.name });
    // How deep and how big the tree may grow: told to the AI, then enforced on its reply before the review.
    const numberField = (label: string, initial: number, max: number): (() => number) => {
      const field = quickLimits.createEl("label", { cls: "vam-field" });
      field.createSpan({ text: label });
      const input = field.createEl("input", { type: "number", attr: { min: "1", max: String(max), step: "1" } });
      input.value = String(initial);
      input.setAttr("aria-label", label);
      const read = (): number => Math.min(max, Math.max(1, Math.round(Number(input.value)) || 1));
      input.addEventListener("change", () => {
        input.value = String(read());
        refreshSummary();
      });
      return read;
    };
    const quickLevels = numberField(t("ui.number_of_levels"), 2, QUICK_OUTLINE_MAX_LEVELS);
    const quickTopics = numberField(t("ui.quick_outline_max_topics"), 15, QUICK_OUTLINE_MAX_TOPICS);
    quickLimits.createEl("p", { text: t("ui.quick_outline_hint"), cls: "vam-hint" });
    const shallowLabel = adjustFor.expand.createEl("label", { cls: "vam-field vam-next-toggle" });
    const shallow = shallowLabel.createEl("input", { type: "checkbox" });
    shallow.checked = false;
    shallowLabel.createSpan({ text: t("ui.run_shallow_research_on_each_created_subtopic") });
    // Shallow research on new subtopics is deliberately Quick: it is a first look at many topics, not a full study.
    // Subtopic research does not search the web unless the box below is ticked, and the hint says which applies.
    const shallowHintText = (): string =>
      t(
        "ui.shallow_research_for_expanded_subtopics_0",
        shallowWeb.checked ? researchDepthDescription("fast") : t("ui.shallow_research_local_description")
      );
    const shallowHint = adjustFor.expand.createEl("p", { cls: "vam-hint" });
    shallowHint.hidden = true;
    const shallowWebLabel = adjustFor.expand.createEl("label", { cls: "vam-field vam-next-toggle" });
    const shallowWeb = shallowWebLabel.createEl("input", { type: "checkbox" });
    shallowWeb.checked = false;
    shallowWebLabel.createSpan({ text: t("ui.shallow_research_web_search") });
    shallowWebLabel.hidden = true;
    shallowHint.setText(shallowHintText());
    shallowWeb.addEventListener("change", () => shallowHint.setText(shallowHintText()));
    const expandFooterText = actions.createSpan({
      text: t("ui.create_subtopics_after_confirmation_without_running_research"),
      cls: "vam-next-actions-note"
    });
    const expandButton = actions.createEl("button", {
      text: this.pendingCount ? t("ui.review_ai_subtopic_suggestions") : t("ui.get_expansion_directions"),
      cls: "mod-cta"
    });
    expandButton.dataset.topicRun = expandButton.textContent ?? "";
    expandButton.disabled = !!this.modelSettings?.running;
    expandPanel.createEl("p", { cls: "vam-next-status", attr: { "aria-live": "polite" } });
    expandPanel.createDiv("vam-next-result");
    const consumed = (): void => {
      this.pendingCount = 0;
      setExpandMode(multiLayer);
    };
    shallow.addEventListener("change", () => {
      shallowHint.hidden = !shallow.checked;
      shallowWebLabel.hidden = !shallow.checked;
      setExpandMode(multiLayer);
    });
    expandButton.addEventListener("click", () => {
      void this.run(
        expandPanel,
        expandButton,
        async () => {
          const selected = await sharedSources?.picker.ready();
          const options: TaskOptions = {
            referenceGroups: selected?.groups ?? [],
            outputLanguage: languageSelect.value as Settings["language"],
            requirements: this.requirements(),
            researchMode: selected?.webSearch ? "research" : "local",
            shallowResearch: shallow.checked,
            ...(shallow.checked && shallowWeb.checked ? { shallowWebSearch: true } : {}),
            researchDepth: "fast",
            visualMode: shallow.checked && selected?.imageSearch ? "auto" : "off",
            ...(templateId() ? { detailTemplateId: templateId() } : {}),
            ...(toneId() ? { toneId: toneId() } : {}),
            signal: this.taskSignal,
            onProgress: message => {
              if (!this.closed) expandPanel.querySelector<HTMLElement>(".vam-next-status")?.setText(message);
            }
          };
          if (multiLayer) {
            if (!quickOutline) return;
            const signal = this.taskSignal;
            const controller = this.taskController;
            if (!signal || !controller) return;
            const limits = { levels: quickLevels(), maxTopics: quickTopics() };
            const request = {
              presetId: presetSelect.value,
              requirements: this.requirements(),
              language: options.outputLanguage ?? this.plugin.settings.language,
              limits
            };
            // Usage confirmed, settings saved and sources ready: hide the dialog; the card shows running and Stop.
            this.detach(controller);
            const generated = await quickOutline.generate(request, signal);
            if (signal.aborted || (this.closed && !this.detached)) return;
            const { nodes, dropped } = limitOutline(generated, limits);
            if (this.closed) {
              // Hidden while it ran: the card badge keeps the outline for review and a Notice says it is ready.
              // The closed dialog's signal and progress callback must not outlive it in the stored options.
              this.background?.outlineReady?.({
                nodes,
                dropped,
                options: { ...options, signal: undefined, onProgress: undefined }
              });
              return;
            }
            this.outlineReview(expandPanel, nodes, expandButton, quickOutline.create, options, dropped);
            return;
          }
          if (!this.pendingCount && this.taskController) this.detach(this.taskController);
          await this.expand(
            options,
            "",
            (items, create) => {
              // Hidden while it ran: the card badge holds the suggestions and a Notice says they are ready.
              if (this.closed) this.background?.completed?.("expand");
              else this.proposals(expandPanel, items, create, expandButton, consumed, options);
            },
            (message, retryable) => {
              if (this.closed) {
                new Notice(message);
                return;
              }
              consumed();
              if (retryable === false) this.failed(expandPanel, expandButton, message);
              else this.failedAi(expandPanel, expandButton, message);
              if (retryable === false) expandButton.disabled = true;
            },
            () => {
              this.taskSignal = undefined;
              this.taskController = undefined;
              this.endBackground();
              if (!this.closed) this.startedInBackground();
            }
          );
        },
        multiLayer || !this.pendingCount
      );
    });
    // --- Synthesize: setup, directions, draft and review all happen in this one dialog.
    const pendingDirections = selection ? selection.pending : this.modelSettings?.synthesisPending;
    synthesizePanel.createEl("p", {
      text: selection
        ? t("ui.synthesize_0_source_topics_ai_reads_their_full_knowledge_and", selection.names.length)
        : this.childrenCount
          ? t("ui.ai_suggests_synthesis_angles_first_the_parent_topic_changes")
          : t("ui.this_topic_has_no_direct_subtopics_you_can_choose_other_note")
    });
    let titleInput: HTMLInputElement | undefined;
    let titleField: HTMLElement | undefined;
    if (selection) {
      const titleLabel = synthesizePanel.createEl("label", { cls: "vam-field vam-next-synth-setup" });
      titleField = titleLabel;
      titleLabel.createSpan({ text: t("ui.new_topic_name") });
      titleInput = titleLabel.createEl("input", { type: "text", value: selection.initialTitle });
      titleInput.setAttr("aria-label", t("ui.new_topic_name"));
    }
    synthesisContentSelect = renderSynthesisContent(
      adjustFor.synthesize,
      selection?.names ?? this.modelSettings?.sources?.synthesisTopics ?? []
    );
    const stageTwoHint = adjustFor.synthesize.createEl("p", {
      cls: "vam-hint vam-next-synth-fixed",
      text: t("ui.synthesis_stage_two_fixed")
    });
    stageTwoHint.hidden = true;
    synthesizePanel.createEl("p", { cls: "vam-hint", text: t("ui.synthesis_web_default_hint") });
    const synthStatus = synthesizePanel.createEl("p", { cls: "vam-next-status", attr: { "aria-live": "polite" } });
    const synthResult = synthesizePanel.createDiv("vam-next-result");
    const suggestButton = actions.createEl("button", { text: t("ui.get_synthesis_suggestions_first"), cls: "mod-cta" });
    suggestButton.dataset.topicRun = suggestButton.textContent ?? "";
    const skipButton = actions.createEl("button", { text: t("ui.synthesis_skip_suggestions") });
    const draftButton = actions.createEl("button", { text: t("ui.get_synthesis_draft"), cls: "mod-cta" });
    for (const button of [suggestButton, skipButton, draftButton]) button.disabled = !!this.modelSettings?.running;
    let stage: "setup" | "directions" = pendingDirections ? "directions" : "setup";
    // Language, template, sources and content are fixed once the directions are requested; the draft step ignores them.
    let frozenSummary = "";
    const syncSynthesisStage = (): void => {
      const locked = stage === "directions";
      const here = currentMode === "synthesize";
      suggestButton.hidden = !here || locked;
      skipButton.hidden = !here || locked;
      draftButton.hidden = !here || !locked;
      adjustFor.synthesize.toggleClass("is-fixed", locked);
      stageTwoHint.hidden = !locked;
      if (sharedSources) sharedSources.disclosure.hidden = here && locked;
      output.hidden = here && locked;
      titleField?.toggleClass("is-hidden", locked);
    };
    let directionBox: HTMLTextAreaElement | undefined;
    const showDirections = (items: Suggestion[]): void => {
      if (this.closed) return;
      stage = "directions";
      synthResult.empty();
      for (const item of items) {
        const choice = synthResult.createDiv("vam-next-angle");
        choice.createEl("strong", { text: item.title });
        choice.createEl("p", { text: item.contribution || item.task });
        choice.createEl("button", { text: t("ui.choose_this_direction") }).addEventListener("click", () => {
          if (directionBox) directionBox.value = item.task || item.title;
        });
      }
      const box = synthResult.createEl("textarea", {
        cls: "vam-next-focus",
        text: items[0]?.task || items[0]?.title || ""
      });
      box.setAttr("aria-label", t("ui.synthesis_direction"));
      directionBox = box;
      synthResult.createEl("button", { text: t("ui.discard_synthesis") }).addEventListener("click", () => {
        (selection ? selection.pending : this.modelSettings?.synthesisPending)?.discard();
        this.close();
      });
      synthStatus.setText(t("ui.choose_or_edit_a_synthesis_direction_then_get_a_draft"));
      syncSynthesisStage();
      refreshSummary();
      // The suggestions call took the pre-started process; the draft is the next call.
      warmForMode();
    };
    // The result is written by the view (no draft review step); the dialog has nothing left to show.
    const flow = { directions: showDirections, written: () => this.close() };
    const needsName = (): boolean => !!titleInput && !titleInput.value.trim();
    const checkName = (): void => {
      if (!titleInput || stage !== "setup") return;
      const missing = needsName();
      suggestButton.disabled = skipButton.disabled = missing || !!this.modelSettings?.running;
      synthStatus.setText(missing ? t("ui.synthesis_needs_name") : "");
    };
    titleInput?.addEventListener("input", checkName);
    // Setup and draft options: the setup step reads every field; the draft step reads only the extra requirements.
    const setupOptions = async (signal: AbortSignal): Promise<TaskOptions> => {
      const content: SynthesisContent = synthesisContentSelect?.value === "summary" ? "summary" : "full";
      if (synthesisContentSelect) synthesisContentSelect.disabled = true;
      const selected = await sharedSources?.picker.ready();
      const options: TaskOptions = {
        synthesisContent: content,
        referenceGroups: selected?.groups ?? [],
        outputLanguage: languageSelect.value as Settings["language"],
        requirements: this.requirements(),
        researchMode: selected?.webSearch ? "research" : "local",
        researchDepth: this.depth,
        visualMode: selected?.imageSearch ? "auto" : "off",
        ...(templateId() ? { detailTemplateId: templateId() } : {}),
        ...(toneId() ? { toneId: toneId() } : {}),
        ...(titleInput ? { synthesisTitle: titleInput.value.trim() } : {}),
        signal,
        onProgress: message => {
          if (!this.closed) synthStatus.setText(message);
        }
      };
      if (!selection && !this.childrenCount && !options.referenceGroups?.some(group => group.documents.length))
        throw new Error(t("ui.choose_another_note_source_first"));
      frozenSummary = summaryEl.textContent ?? "";
      return options;
    };
    const draftOptions = (signal: AbortSignal): TaskOptions => ({
      continuesDirections: true,
      outputLanguage: languageSelect.value as Settings["language"],
      requirements: this.requirements(),
      researchMode: "local",
      researchDepth: this.depth,
      visualMode: "off",
      ...(titleInput ? { synthesisTitle: titleInput.value.trim() } : {}),
      signal,
      onProgress: message => {
        if (!this.closed) synthStatus.setText(message);
      }
    });
    const guard = (): boolean => {
      if (!needsName()) return true;
      synthStatus.setText(t("ui.synthesis_needs_name"));
      return false;
    };
    suggestButton.addEventListener("click", () => {
      if (guard()) this.launchSynthesis(synthesizePanel, suggestButton, null, setupOptions, flow);
    });
    skipButton.addEventListener("click", () => {
      if (guard())
        this.launchSynthesis(
          synthesizePanel,
          skipButton,
          selection ? selection.defaultDirection : "",
          setupOptions,
          flow
        );
    });
    draftButton.addEventListener("click", () =>
      this.launchSynthesis(
        synthesizePanel,
        draftButton,
        (directionBox?.value ?? "").trim(),
        async signal => draftOptions(signal),
        flow
      )
    );
    // --- Shared options, all under Adjust.
    const sharedSources = this.addReferencePicker(adjustBody);
    // The research step runs with the web setting of the source picker. Expansion pre-starts one process only for local
    // (no web search) Quick child research; children run in parallel, so only the first one finds it waiting.
    const warmForMode = (): void => {
      if (currentMode === "research") this.prewarmAi(sharedSources?.picker.selection().webSearch ?? true);
      else if (currentMode === "expand" && shallow.checked && !shallowWeb.checked) this.prewarmAi(false);
      // Synthesis of this topic's children (suggestions or the draft): both are mode synthesize with the picker's web setting.
      else if (currentMode === "synthesize")
        this.prewarmAi(sharedSources?.picker.selection().webSearch ?? false, "synthesize");
      else if (!this.detached) this.plugin.releaseWarmClaude?.();
    };
    show = mode => {
      currentMode = mode;
      for (const [name, button, panel] of [
        ["research", researchCard, research],
        ["expand", expandCard, expandPanel],
        ["synthesize", synthesizeCard, synthesizePanel]
      ] as const) {
        button.classList.toggle("is-active", name === mode);
        button.setAttr("aria-checked", name === mode ? "true" : "false");
        button.tabIndex = name === mode ? 0 : -1;
        panel.style.display = name === mode ? "" : "none";
        adjustFor[name].hidden = name !== mode;
      }
      sharedSources?.forMode(mode);
      warmForMode();
      confirm.hidden = mode !== "research";
      expandButton.hidden = mode !== "expand";
      expandFooterText.hidden = mode !== "expand";
      // Once directions are requested, the synthesis step has no sources, language or template left to choose.
      syncSynthesisStage();
      refreshSummary();
    };
    this.renderRequirements(adjustBody);
    const output = adjustBody.createEl("details", { cls: "vam-next-output" });
    output.open = false;
    const outputSummary = output.createEl("summary").createSpan({ cls: "vam-next-source-summary-row" });
    outputSummary.createEl("strong", { text: t("ui.output_settings") });
    const outputValue = outputSummary.createSpan({ cls: "vam-next-source-summary" });
    const compactSettings = output.createDiv("vam-next-compact-settings");
    const languageLabel = compactSettings.createEl("label", { cls: "vam-next-language" });
    languageLabel.createSpan({ text: t("ui.output_language") });
    const languageSelect = languageLabel.createEl("select");
    for (const option of SUPPORTED_LANGUAGES)
      languageSelect.createEl("option", { value: option.id, text: option.label });
    languageSelect.value = chooseAimContentLanguage(this.plugin.settings.language, this.topic);
    languageSelect.setAttr("aria-label", t("ui.output_language"));
    const style = noteStyleField(compactSettings, {
      templates: this.info?.templates ?? [],
      tones: this.info?.tones ?? [],
      keepLabel: t("ui.note_style_keep_0", this.info?.currentStyle ?? ""),
      templateDefault: t("ui.detail_template_keep_0", this.info?.currentTemplate ?? ""),
      toneDefault: t("ui.tone_keep_0", this.info?.currentTone ?? ""),
      currentTemplate: this.info?.currentTemplate,
      currentTone: this.info?.currentTone,
      currentStyle: this.info?.currentStyle,
      manageTemplates: (selected, refreshed) => {
        const settings = this.plugin.settings;
        const choices = (): { id: string; name: string }[] =>
          builtinTemplates(noteLanguageOf(settings.language))
            .concat(settings.detailTemplates)
            .map(({ id, name }) => ({ id, name }));
        new DetailTemplatesModal(this.app, this.plugin, () => refreshed(choices()), selected).open();
      },
      manageTones: (selected, refreshed) => {
        const settings = this.plugin.settings;
        const choices = (): { id: string; name: string }[] =>
          listPresets(settings.promptPresets, "tone", settings.language).map(({ id, name }) => ({ id, name }));
        new PromptPresetsModal(this.app, this.plugin, "tone", () => refreshed(choices()), selected).open();
      },
      changed: () => refreshSummary()
    });
    const templateId = style.templateId;
    const toneId = style.toneId;
    const describeOutput = (): void => {
      outputValue.setText([supportedLanguageLabel(languageSelect.value), style.label()].filter(Boolean).join(" · "));
    };
    const depthName = (depth: ResearchDepth): string =>
      t(depth === "fast" ? "ui.quick" : depth === "deep" ? "ui.deep" : "ui.standard");
    const refreshSummary = (): void => {
      describeOutput();
      if (currentMode === "synthesize" && stage === "directions") {
        summaryEl.setText(frozenSummary);
        return;
      }
      const parts: string[] = [];
      if (currentMode === "research") parts.push(t("ui.next_summary_depth_0", depthName(depthField.value())));
      else if (currentMode === "expand")
        parts.push(
          multiLayer
            ? t("ui.quick_outline_summary_0_1", quickLevels(), quickTopics())
            : t("ui.choose_directions_together")
        );
      else
        parts.push(
          t(
            synthesisContentSelect?.value === "summary" ? "ui.next_summary_synth_summary" : "ui.next_summary_synth_full"
          )
        );
      const network = sharedSources?.picker.selection();
      if (network) parts.push(t(network.webSearch ? "ui.next_summary_web_on" : "ui.next_summary_web_off"));
      parts.push(supportedLanguageLabel(languageSelect.value));
      const styleName = style.name();
      if (styleName) parts.push(styleName);
      summaryEl.setText(parts.join(" · "));
    };
    // Select, checkbox and radio changes bubble up, so one listener keeps the summary current.
    this.contentEl.addEventListener("change", refreshSummary);
    // A changed model or reasoning level changes the command: pre-start again (the old process is killed).
    this.contentEl.addEventListener("change", () => {
      warmForMode();
    });
    if (pendingDirections) showDirections(pendingDirections.directions);
    else checkName();
    show(initialMode);
    const waitingOutline = this.modelSettings?.pendingOutline;
    if (waitingOutline && quickOutline) {
      // Reopened from the card badge or the Notice: straight into the review of the outline generated in the background.
      shallow.checked = !!waitingOutline.options.shallowResearch;
      shallowWeb.checked = !!waitingOutline.options.shallowWebSearch;
      shallowHint.hidden = !shallow.checked;
      shallowWebLabel.hidden = !shallow.checked;
      setExpandMode(true);
      const reviewOptions: TaskOptions = {
        ...waitingOutline.options,
        onProgress: message => expandPanel.querySelector<HTMLElement>(".vam-next-status")?.setText(message)
      };
      this.outlineReview(
        expandPanel,
        waitingOutline.nodes,
        expandButton,
        quickOutline.create,
        reviewOptions,
        waitingOutline.dropped
      );
    }
    // A selection shows no mode cards, so its name field takes the focus.
    (titleInput ?? cardFor[initialMode]).focus();
    (this.renderModelSettings(adjustBody) ?? adjustBody).createEl("p", {
      text: t("ui.if_an_ai_task_exceeds_3_minutes_vam_attempts_to_interrupt_it"),
      cls: "vam-hint"
    });
  }
}
/** What a proposal does: add a topic (the default), move or merge an existing one, or remove it. */
export type ProposalKind = "add" | "move" | "merge" | "remove";
export interface ProposalItem extends Suggestion {
  kind?: ProposalKind;
  /** Why the AI suggests it, shown under the name. */
  reason?: string;
  /** Move or merge: the card it goes to. */
  destination?: string;
  /** Links a child to its parent when titles may repeat (a generated outline); defaults to the title. */
  key?: string;
  parentKey?: string;
}
export interface ProposalListOptions {
  rootTitle?: string;
  /** Hide the task and contribution details (an outline has none). */
  compact?: boolean;
  /**
   * Review mode: each row is applied on its own instead of checked. The caller adds its controls to `head`; the
   * list has no checkboxes and `selected()` returns nothing.
   */
  apply?: (item: ProposalItem, row: { element: HTMLElement; head: HTMLElement; title: HTMLInputElement }) => void;
}
/** The label and reason of a proposal's kind; nothing for a plain add, so add-only lists look as before. */
function renderProposalKind(head: HTMLElement, row: HTMLElement, item: ProposalItem): void {
  if (item.kind)
    head.createSpan({
      cls: `vam-proposal-kind vam-proposal-kind-${item.kind}`,
      text: t(`ui.proposal_kind_${item.kind}`)
    });
  if (item.destination)
    row.createEl("p", {
      cls: "vam-proposal-destination",
      text: t(
        item.kind === "merge"
          ? "ui.proposal_merge_into_0"
          : item.kind === "add"
            ? "ui.proposal_add_under_0"
            : "ui.proposal_destination_0",
        item.destination
      )
    });
  if (item.reason) row.createEl("p", { cls: "vam-proposal-reason", text: item.reason });
}
/**
 * The AI's subtopic proposals as one compact list: a checkbox and editable name per row, details on demand,
 * children indented under their parent. Checking a child checks its parent; unchecking a parent unchecks its children.
 * A row may carry a kind (add, move, merge, remove) and a reason; in review mode (`apply`) rows are applied one by one.
 */
export function renderProposalList(
  parent: HTMLElement,
  suggestions: ProposalItem[],
  changed: (count: number) => void,
  options: ProposalListOptions = {}
): { count: () => number; selected: () => ProposalItem[] | string } {
  // A suggestion whose parent is the topic being expanded is first-level.
  suggestions = suggestions.map(item =>
    options.rootTitle && item.parentTitle === options.rootTitle ? { ...item, parentTitle: "" } : item
  );
  const keyOf = (item: ProposalItem): string => item.key ?? item.title;
  const parentOf = (item: ProposalItem): string => (item.key !== undefined ? item.parentKey : item.parentTitle) ?? "";
  const review = !!options.apply;
  const rows: {
    item: ProposalItem;
    check: HTMLInputElement;
    title: HTMLInputElement;
    task?: HTMLTextAreaElement;
    contribution?: HTMLTextAreaElement;
  }[] = [];
  const toolbar = parent.createDiv("vam-proposal-toolbar");
  const counter = toolbar.createSpan({ cls: "vam-proposal-count", attr: { "aria-live": "polite" } });
  const all = toolbar.createEl("button", { cls: "vam-proposal-all" });
  if (review) toolbar.hidden = true;
  const list = parent.createDiv("vam-proposal-list");
  const roots = suggestions.filter(item => !parentOf(item));
  const keyed = suggestions.some(item => item.key !== undefined);
  // Keyed rows (an outline) follow depth-first at any depth; otherwise children follow the first parent with their
  // title. Each proposal appears exactly once.
  const depthFirst = (item: ProposalItem): ProposalItem[] => [
    item,
    ...suggestions.filter(other => parentOf(other) === keyOf(item)).flatMap(depthFirst)
  ];
  const ordered = [
    ...new Set(
      keyed
        ? [...roots.flatMap(depthFirst), ...suggestions]
        : [
            ...roots.flatMap(root => [root, ...suggestions.filter(item => parentOf(item) === keyOf(root))]),
            ...suggestions.filter(item => parentOf(item) && !roots.some(root => keyOf(root) === parentOf(item)))
          ]
    )
  ];
  const depthOf = (item: ProposalItem): number => {
    let depth = 0;
    for (let up = parentOf(item); up && depth < 6; depth++)
      up = parentOf(suggestions.find(other => keyOf(other) === up) ?? { title: "", task: "", contribution: "" });
    return depth;
  };
  const count = (): number => rows.filter(row => row.check.checked).length;
  const update = (): void => {
    const picked = count();
    counter.setText(t("ui.selected_0_of_1", picked, rows.length));
    all.setText(t(picked === rows.length ? "ui.select_none" : "ui.select_all"));
    changed(picked);
  };
  for (const item of ordered) {
    const row = list.createDiv(parentOf(item) ? "vam-proposal is-child" : "vam-proposal");
    if (keyed) row.addClass(`vam-proposal-depth-${Math.min(depthOf(item), 5)}`);
    const head = row.createDiv("vam-proposal-head");
    const check = head.createEl("input", { type: "checkbox" });
    check.checked = !review;
    check.hidden = review;
    check.setAttr("aria-label", t("ui.select_proposal_0", item.title));
    const title = head.createEl("input", { type: "text", value: item.title, cls: "vam-proposal-title" });
    title.setAttr("aria-label", t("ui.proposal_name"));
    // Only a new topic's name can be edited; move, merge and remove name an existing card.
    title.readOnly = !!item.kind && item.kind !== "add";
    renderProposalKind(head, row, item);
    let task: HTMLTextAreaElement | undefined, contribution: HTMLTextAreaElement | undefined;
    if (!options.compact && (!item.kind || item.kind === "add")) {
      const more = head.createEl("button", { text: t("ui.proposal_details"), cls: "vam-proposal-more" });
      more.setAttr("aria-expanded", "false");
      const body = row.createDiv("vam-proposal-body");
      body.hidden = true;
      more.addEventListener("click", () => {
        body.hidden = !body.hidden;
        more.setAttr("aria-expanded", String(!body.hidden));
      });
      const taskField = body.createEl("label", { cls: "vam-proposal-field" });
      taskField.createSpan({ text: t("ui.research_task") });
      task = taskField.createEl("textarea", { text: item.task });
      task.rows = 2;
      task.setAttr("aria-label", t("ui.proposal_task"));
      const contributionField = body.createEl("label", { cls: "vam-proposal-field" });
      contributionField.createSpan({ text: t("ui.contribution_to_the_parent_topic") });
      contribution = contributionField.createEl("textarea", { text: item.contribution });
      contribution.rows = 2;
      contribution.placeholder = t("ui.contribution_to_the_parent_topic");
      contribution.setAttr("aria-label", t("ui.contribution_to_the_parent_topic"));
    }
    rows.push({ item, check, title, task, contribution });
    options.apply?.(item, { element: row, head, title });
    check.addEventListener("change", () => {
      // Checking a row checks its ancestors; unchecking a row unchecks its descendants, at any depth.
      const uncheckChildren = (key: string): void =>
        rows.forEach(other => {
          if (parentOf(other.item) === key && other.check.checked) {
            other.check.checked = false;
            uncheckChildren(keyOf(other.item));
          }
        });
      if (check.checked && parentOf(item)) {
        let parentKey: string | undefined = parentOf(item);
        while (parentKey) {
          const parent = rows.find(other => keyOf(other.item) === parentKey);
          if (!parent) break;
          parent.check.checked = true;
          parentKey = parentOf(parent.item);
        }
      }
      if (!check.checked) uncheckChildren(keyOf(item));
      update();
    });
  }
  all.addEventListener("click", () => {
    const value = count() !== rows.length;
    rows.forEach(row => (row.check.checked = value));
    update();
  });
  update();
  return {
    count,
    selected: () => {
      const selected = rows.filter(row => row.check.checked && row.title.value.trim());
      if (!selected.length) return t("ui.select_at_least_one_subtopic");
      // Any selected row can be a parent, so deeper suggestions keep working.
      const renamed = new Map(selected.map(row => [keyOf(row.item), row.title.value.trim()]));
      const names = selected.filter(row => !parentOf(row.item)).map(row => row.title.value.trim());
      if (new Set(names).size !== names.length) return t("ui.first_level_topic_names_must_be_unique");
      if (selected.some(row => parentOf(row.item) && !renamed.has(parentOf(row.item))))
        return t("ui.select_the_parent_topic_before_its_child");
      return selected.map(row => ({
        title: row.title.value.trim(),
        task: row.task?.value.trim() ?? row.item.task,
        contribution: row.contribution?.value.trim() ?? row.item.contribution,
        parentTitle: parentOf(row.item) ? renamed.get(parentOf(row.item))! : "",
        ...(row.item.key !== undefined ? { key: row.item.key, parentKey: row.item.parentKey ?? "" } : {})
      }));
    }
  };
}
/** A fixed action bar below the scrolling content, shared by the review dialogs. */
function reviewActions(modal: Modal): HTMLDivElement {
  return modalActions(modal);
}
export interface DraftReview {
  /** What confirming does, e.g. which topic's summary and details it replaces. */
  intro: string;
  /** The topic's summary today, shown for comparison when the draft replaces it. */
  currentSummary?: string;
  confirmLabel: string;
  sourcePath?: string;
  /** Dialog title; defaults to the synthesis draft title. */
  title?: string;
}
/**
 * Reviews an AI draft inside any dialog: rendered by default, editable on demand, and clear about what it changes.
 * The host passes the content area and a fixed action bar, and closes itself through `close`.
 */
export class DraftReviewView {
  private renderer = new Component();
  private disarm?: () => void;
  private intro?: HTMLElement;
  constructor(
    private app: App,
    private summary: string,
    private detail: string,
    private review: DraftReview,
    private confirm: (summary: string, detail: string) => void | Promise<void>,
    private discard: (() => void) | undefined,
    private close: () => void
  ) {}
  /** Starts on the draft itself: a stray Enter from whatever opened the dialog must not switch to editing. */
  focus(): void {
    this.intro?.focus();
  }
  mount(content: HTMLElement, actions: HTMLElement): void {
    this.renderer.load();
    const intro = content.createEl("p", { cls: "vam-draft-intro", text: this.review.intro });
    this.intro = intro;
    if (this.review.currentSummary?.trim()) {
      const current = content.createEl("details", { cls: "vam-draft-current" });
      current.createEl("summary", { text: t("ui.current_summary") });
      current.createEl("p", { text: this.review.currentSummary });
    }
    const toolbar = content.createDiv("vam-draft-toolbar");
    toolbar.createEl("strong", { text: t("ui.ai_draft") });
    const toggle = toolbar.createEl("button", { text: t("ui.edit_draft"), cls: "vam-draft-toggle" });
    toggle.setAttr("aria-pressed", "false");
    const section = (label: string, value: string, rows: number) => {
      const wrap = content.createDiv("vam-draft-section");
      wrap.createEl("h4", { text: label });
      const preview = wrap.createDiv("vam-draft-preview markdown-rendered");
      const input = wrap.createEl("textarea", { cls: "vam-task-input", text: value });
      input.rows = rows;
      input.hidden = true;
      input.setAttr("aria-label", label);
      return { preview, input };
    };
    const summary = section(t("ui.draft_summary"), this.summary, 4);
    const detail = section(t("ui.draft_detail"), this.detail, 16);
    // Each render gets its own child component and a generation, so a slow earlier render never lands twice.
    const generations = new WeakMap<HTMLElement, { count: number; child?: Component }>();
    const show = (target: HTMLElement, markdown: string): void => {
      const state = generations.get(target) ?? { count: 0 };
      const generation = ++state.count;
      if (state.child) this.renderer.removeChild(state.child);
      const child = this.renderer.addChild(new Component());
      state.child = child;
      generations.set(target, state);
      target.empty();
      const fallback = (): void => {
        if (state.count !== generation) return;
        target.empty();
        target.setText(markdown);
      };
      try {
        void MarkdownRenderer.render(this.app, markdown, target, this.review.sourcePath ?? "", child).catch(fallback);
      } catch {
        fallback();
      }
    };
    let editing = false;
    const setEditing = (value: boolean): void => {
      editing = value;
      toggle.setText(t(value ? "ui.preview_draft" : "ui.edit_draft"));
      toggle.setAttr("aria-pressed", String(value));
      for (const part of [summary, detail]) {
        part.preview.hidden = value;
        part.input.hidden = !value;
      }
      if (value) summary.input.focus();
      else {
        show(summary.preview, summary.input.value);
        show(detail.preview, detail.input.value);
      }
    };
    toggle.addEventListener("click", () => setEditing(!editing));
    setEditing(false);
    intro.tabIndex = -1;
    intro.focus();
    // Next to the buttons, so a save error or the discard warning is seen even when the draft is scrolled.
    const status = actionStatus(actions);
    if (this.discard) {
      // Discarding loses the AI's work, so it sits apart and asks once more before acting.
      const discard = actions.createEl("button", { text: t("ui.discard_synthesis"), cls: "vam-discard" });
      this.disarm = armDiscard(
        discard,
        status,
        () => {
          this.discard?.();
          this.close();
        },
        () => confirm.disabled
      );
    }
    const cancelButton = actions.createEl("button", { text: t("ui.cancel") });
    cancelButton.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", { text: this.review.confirmLabel, cls: "mod-cta" });
    confirm.addEventListener("click", () => {
      confirm.disabled = true;
      cancelButton.disabled = true;
      void Promise.resolve(this.confirm(summary.input.value, detail.input.value)).then(
        () => this.close(),
        error => {
          status.setText(error instanceof Error ? error.message : String(error));
          confirm.disabled = false;
          cancelButton.disabled = false;
        }
      );
    });
  }
  dispose(): void {
    this.disarm?.();
    this.renderer.unload();
  }
}
/** The draft review as a dialog of its own: used when a finished draft is opened from its node badge or selection bar. */
export class DraftReviewModal extends Modal {
  private view: DraftReviewView;
  private title?: string;
  constructor(
    app: App,
    summary: string,
    detail: string,
    review: DraftReview,
    confirm: (summary: string, detail: string) => void | Promise<void>,
    discard?: () => void
  ) {
    super(app);
    this.title = review.title;
    this.view = new DraftReviewView(app, summary, detail, review, confirm, discard, () => this.close());
  }
  onOpen(): void {
    this.modalEl.addClass("vam-draft-modal");
    this.titleEl.setText(this.title ?? t("ui.review_synthesis_draft"));
    this.view.mount(this.contentEl, reviewActions(this));
  }
  onClose(): void {
    this.view.dispose();
    this.contentEl.empty();
  }
}
export class ChildProposalModal extends Modal {
  constructor(
    app: App,
    private suggestions: Suggestion[],
    private submit: (items: Suggestion[]) => void
  ) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(t("ui.ai_subtopic_proposals"));
    this.contentEl.createEl("p", { text: t("ui.select_subtopics_to_create_you_can_edit_their_names_and_task") });
    const actions = reviewActions(this);
    const status = actions.createSpan({
      cls: "vam-next-actions-note vam-next-status",
      attr: { "aria-live": "polite" }
    });
    actions.createEl("button", { text: t("ui.cancel") }).addEventListener("click", () => this.close());
    const create = actions.createEl("button", { cls: "mod-cta" });
    const list = renderProposalList(this.contentEl, this.suggestions, count => {
      create.setText(t("ui.create_0_subtopics", count));
      create.disabled = count === 0;
      status.setText("");
    });
    create.setText(t("ui.create_0_subtopics", list.count()));
    create.addEventListener("click", () => {
      const picked = list.selected();
      // Problems stay in the dialog next to the button instead of a passing Notice.
      if (typeof picked === "string") {
        status.setText(picked);
        return;
      }
      this.close();
      this.submit(picked);
    });
  }
}
export class MapConflictModal extends Modal {
  private settled = false;
  constructor(
    app: App,
    private local: MapDocument,
    private disk: MapDocument,
    private resolve: (map: MapDocument) => void
  ) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(t("ui.mind_map_changed_externally"));
    this.contentEl.createEl("p", { text: t("ui.both_the_map_and_map_md_have_changed_choose_a_version_or_edi") });
    const finish = (map: MapDocument): void => {
      this.settled = true;
      this.close();
      this.resolve(map);
    };
    // Two plain choices first, each saying what it keeps; hand-merging JSON is the expert path, folded away.
    const options = this.contentEl.createDiv("vam-conflict-options");
    const option = (label: string, description: string, map: () => MapDocument): void => {
      const row = options.createDiv("vam-conflict-option");
      const text = row.createDiv("vam-conflict-option-text");
      text.createEl("strong", { text: label });
      text.createSpan({ text: description, cls: "vam-hint" });
      row.createEl("button", { text: label }).addEventListener("click", () => finish(map()));
    };
    option(t("ui.use_file_contents"), t("ui.conflict_use_file_desc"), () => clone(this.disk));
    option(t("ui.keep_editor_contents"), t("ui.conflict_keep_editor_desc"), () => clone(this.local));
    const advanced = this.contentEl.createEl("details", { cls: "vam-conflict-merge" });
    advanced.createEl("summary", { text: t("ui.conflict_merge_by_hand") });
    const input = advanced.createEl("textarea", {
      cls: "vam-task-input",
      text: JSON.stringify(this.disk, null, 2)
    });
    input.rows = 14;
    input.setAttr("aria-label", t("ui.conflict_merge_by_hand"));
    const actions = modalActions(this);
    const status = actions.createSpan({
      cls: "vam-next-actions-note vam-next-status",
      attr: { "aria-live": "polite" }
    });
    status.setText(t("ui.conflict_close_uses_file"));
    const merged = actions.createEl("button", { text: t("ui.save_merged_contents") });
    merged.hidden = true;
    advanced.addEventListener("toggle", () => (merged.hidden = !advanced.open));
    merged.addEventListener("click", () => {
      try {
        finish(parseMap(serializeMap(JSON.parse(input.value) as MapDocument)));
      } catch (error) {
        // Keep the edited JSON and say what is wrong next to the button.
        status.setText(
          error instanceof Error ? t("ui.invalid_merged_contents_0", error.message) : t("ui.invalid_merged_contents")
        );
      }
    });
  }
  onClose(): void {
    if (!this.settled) this.resolve(clone(this.disk));
  }
}
export class NoteCollectionModal extends Modal {
  constructor(
    app: App,
    private titleText: string,
    private files: TFile[],
    private actions: { label: string; run: (file: TFile) => void }[]
  ) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    if (!this.files.length) this.contentEl.createEl("p", { text: t("ui.no_notes_yet") });
    for (const file of this.files) {
      const row = this.contentEl.createDiv("vam-collection-row");
      row.createSpan({ text: file.basename });
      const actions = row.createDiv("vam-collection-actions");
      for (const action of this.actions)
        actions.createEl("button", { text: action.label }).addEventListener("click", () => {
          this.close();
          action.run(file);
        });
    }
    new Setting(this.contentEl).addButton(button => button.setButtonText(t("ui.close")).onClick(() => this.close()));
  }
}
export class TopicPickerModal extends Modal {
  constructor(
    app: App,
    private titleText: string,
    private topics: TopicInfo[],
    private choose: (topic: TopicInfo) => void
  ) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    for (const topic of this.topics)
      new Setting(this.contentEl)
        .setName(topic.title)
        .setDesc(topic.root)
        .addButton(button =>
          button.setButtonText(t("ui.select")).onClick(() => {
            this.close();
            this.choose(topic);
          })
        );
    if (!this.topics.length) this.contentEl.createEl("p", { text: t("ui.no_other_topics") });
    new Setting(this.contentEl).addButton(button => button.setButtonText(t("ui.cancel")).onClick(() => this.close()));
  }
}
