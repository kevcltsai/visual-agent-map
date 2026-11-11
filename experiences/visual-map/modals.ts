// Modals and task helpers used by the Visual Map view; moved from view.ts unchanged.
import type VisualAgentMapPlugin from "../../main";
import { defaultOutputLanguage } from "../../core/content-language";
import {
  FOLLOW_INPUT_ID,
  OUTPUT_LANGUAGE_CHOICES,
  supportedLanguageLabel,
  SUPPORTED_LANGUAGES,
  t,
  type ContentLanguage
} from "../../i18n";
import { App, Component, MarkdownRenderer, Modal, Notice, Setting, TFile } from "obsidian";
import { type ReferenceGroup } from "../../ai/reference-materials";
import type { ResearchSteer } from "../../ai/research-observer";
import { DebugLogModal } from "../../ui/modals/debug-log-modal";
import { actionStatus, armDiscard, modalActions } from "../../ui/modals/action-bar";

export { armDiscard };
import { clone, type MapDocument, parseMap, serializeMap } from "../../map-model";
import { type ResearchDepth, type ResearchMode, type TopicInfo, type VisualMode } from "../../repository";
import type { AiResult, ReasoningLevel, Suggestion } from "../../ai/types";
import { type OutlineLimits, type OutlineNode } from "./outline-import";
import { FOLLOW_DEFAULT_MODEL } from "../../core/model-discovery";
import { styleChoiceField } from "./research-fields";
import { errorNotice, stylePickerFor } from "./note-style-picker";
import { type MapAiMode } from "./ai-mode";
import { titleProblemText } from "../../ui/modals/title-check";

export type SynthesisContent = "full" | "summary";
export interface TaskOptions {
  synthesisContent?: SynthesisContent;
  referenceGroups?: ReferenceGroup[];
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  outputLanguage?: ContentLanguage;
  requirements?: string;
  researchMode: ResearchMode;
  researchDepth: ResearchDepth;
  visualMode: VisualMode;
  shallowResearch?: boolean;
  /**
   * The AI mode the run was started in (Quick or Standard); the research task context carries it so a Quick run uses the
   * Quick prompt. Absent for a run that has no mode (a synthesis, the map chat).
   */
  mapAiMode?: MapAiMode;
  /**
   * This run's note style (`builtin:<id>` or `file:<name>`), chosen in the dialog for this run only. It is never written to
   * a topic or a map; absent: each topic resolves its own style.
   */
  noteStyle?: string;
  /** Multi-select synthesis only: the name of the new topic. */
  synthesisTitle?: string;
  /** The synthesis draft step retried after chosen directions; it continues them even when the last draft failed. */
  continuesDirections?: boolean;
  /**
   * A model (and effort) picked for this run only. It is never written to the topic; the view resolves it first
   * (ADR-021). Absent: the topic's own resolution applies.
   */
  runOnce?: RunOnceModel;
  /** Takes user additions while the run's main call is going (the topic chat window). Absent: the run takes none. */
  steer?: ResearchSteer;
}
/** A model chosen for one run. Absent reasoning means the current model's. */
export interface RunOnceModel {
  model: string;
  reasoning?: ReasoningLevel;
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
  begin: (controller: AbortController, kind?: "research" | "expand") => void;
  end: () => void;
  /**
   * A result finished while the dialog is closed and has no task state of its own to announce it. A Quick research passes
   * its result so the notice can offer "Re-run with Standard" when the answer says the model's knowledge was not enough.
   */
  completed?: (kind: "research" | "expand", result?: AiResult) => void;
}
/** The map's remembered output language and how to record a manual choice (D-2026-10-88). */
export interface OutputLanguageMemory {
  /** What the map remembers today; unknown stored values are already dropped. */
  outputLanguage?: ContentLanguage;
  /** The map's title: a Latin card title in a map titled in another script is written in the map's language. */
  mapTitle?: string;
  /** Records the language picked by hand in this dialog; called once, when a run starts. */
  rememberOutputLanguage?: (language: ContentLanguage) => Promise<void>;
}
/** The map's remembered AI mode and how to record the one a research or expansion starts with. */
export interface AiModeMemory {
  /** What the map remembers today; unknown stored values are already dropped. Absent: Quick. */
  aiMode?: MapAiMode;
  /** Records the mode when a research or expansion starts (never when the dialog is cancelled). */
  rememberAiMode?: (mode: MapAiMode) => Promise<void>;
}
export { FOLLOW_DEFAULT_MODEL };
export interface QuickOutline {
  presets: { id: string; name: string }[];
  /** Generates the outline for this topic; the outline's root is the topic itself. */
  generate: (
    request: {
      presetId: string;
      requirements: string;
      language: ContentLanguage;
      limits: OutlineLimits;
      /** The topic chat's Expand: the note is the main source and `requirements` (the owner's words) leads; no preset text. */
      fromNote?: boolean;
      /** The dialog's one-run model; absent: the topic's own. */
      runOnce?: RunOnceModel;
    },
    signal: AbortSignal,
    /** Takes user additions while the outline is generated (the topic chat window); absent: none. */
    steer?: ResearchSteer
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
  fields: OutputLanguageMemory & { sources?: TaskSourceSettings; currentStyle?: string };
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

/** What the manual merge says for a bad edit: a JSON syntax slip, or a structure the map cannot take. */
export function invalidMergedContentsText(error: unknown): string {
  // Checked by name: `instanceof SyntaxError` fails for an error from another realm (a vm bundle, a worker).
  const syntax = typeof error === "object" && error !== null && (error as { name?: unknown }).name === "SyntaxError";
  return syntax ? t("ui.invalid_merged_json") : t("ui.invalid_merged_contents");
}

export class PartialChildBatchError extends Error {}
export interface AgentTaskHandle {
  finished: Promise<void>;
}
export interface TaskSourceSettings {
  /** The map's saved sources resolved to reference groups when a task starts; rejects when the signal aborts. */
  mapSources: (signal: AbortSignal) => Promise<ReferenceGroup[]>;
  synthesisTopics?: string[];
}
export { defaultOutputLanguage };

/** The multi-select synthesis dialog: setup, directions, draft and review all happen here. */
export class NextStepModal extends Modal {
  private closed = false;
  /** AI started and this dialog hid itself; closing no longer stops the run (Stop is on the selection bar). */
  private detached = false;
  private backgroundBegan = false;
  private runPending = false;
  /** The output language the person picked in this dialog; saved on the map when a run starts. */
  private manualOutputLanguage?: ContentLanguage;
  private taskController?: AbortController;
  constructor(
    app: App,
    private plugin: VisualAgentMapPlugin,
    private synthesize: (
      options: TaskOptions,
      direction: string | null,
      failed: (message: string) => void,
      accepted: () => void,
      observer?: SynthesisObserver
    ) => Promise<void>,
    private selectionFlow: SelectionSynthesis
  ) {
    super(app);
  }
  /**
   * The selection's saved data sources, read under the task signal when a run starts. Sources that cannot be read are
   * skipped: the run goes on with the rest and the dialog shows nothing about them.
   */
  private async mapSourceGroups(signal: AbortSignal | undefined): Promise<ReferenceGroup[]> {
    const groups =
      (await this.selectionFlow.fields.sources?.mapSources?.(signal ?? new AbortController().signal)) ?? [];
    if (signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    return groups;
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
  }
  private requirements(): string {
    return this.requirementsInput?.value.trim() ?? "";
  }
  /**
   * Hides the dialog once AI starts: usage confirmed, settings saved and sources ready (so a validation error still
   * shows in the dialog). The view takes over Stop for `controller` until the provider accepts the request.
   */
  private detach(controller: AbortController): void {
    this.detached = true;
    this.backgroundBegan = true;
    this.selectionFlow.background?.begin(controller);
    this.close();
  }
  private endBackground(): void {
    if (!this.backgroundBegan) return;
    this.backgroundBegan = false;
    this.selectionFlow.background?.end();
  }
  /** True when a started run should stop: it was aborted, or its dialog closed before AI started. */
  private dead(controller: AbortController): boolean {
    return controller.signal.aborted || (this.closed && !this.detached);
  }
  onClose(): void {
    this.closed = true;
    // A run that the provider already accepted, or that hid this dialog, keeps going in the background; one still
    // starting is stopped.
    if (!this.detached) this.taskController?.abort();
  }
  /** The output language picked by hand is remembered on the map, once, at the moment a run actually starts. */
  private async flushSettings(): Promise<void> {
    const manual = this.manualOutputLanguage;
    const remember = this.selectionFlow.fields.rememberOutputLanguage;
    if (manual !== undefined && remember) {
      this.manualOutputLanguage = undefined;
      try {
        await remember(manual);
      } catch (error) {
        this.manualOutputLanguage ??= manual;
        throw error;
      }
    }
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
        if (this.closed && !controller.signal.aborted) errorNotice(error);
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
          if (this.taskController === controller) this.taskController = undefined;
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
      const model = this.plugin.settings.cliModel;
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
          if (this.taskController === controller) this.taskController = undefined;
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
  onOpen(): void {
    this.modalEl.addClass("vam-next-modal");
    const selection = this.selectionFlow;
    this.titleEl.setText(t("ui.confirm_topic_synthesis"));
    // One action bar below the scrolling content: Close plus the current stage's primary actions.
    const actions = modalActions(this);
    const closeButton = actions.createEl("button", { text: t("ui.close"), cls: "vam-next-close" });
    closeButton.addEventListener("click", () => this.close());
    // What this run will do, in one line; the details are under Adjust.
    const summaryEl = this.contentEl.createEl("p", { cls: "vam-next-summary", attr: { "aria-live": "polite" } });
    const synthesizePanel = this.contentEl.createDiv("vam-next-research vam-next-choice");
    // Every option lives here, in one disclosure.
    const adjust = this.contentEl.createEl("details", { cls: "vam-next-adjust" });
    adjust.open = false;
    adjust.createEl("summary", { text: t("ui.adjust") });
    const adjustBody = adjust.createDiv("vam-next-adjust-body");
    const adjustSynthesize = adjustBody.createDiv("vam-next-adjust-section");
    const pendingDirections = selection.pending;
    synthesizePanel.createEl("p", {
      text: t("ui.synthesize_0_source_topics_ai_reads_their_full_knowledge_and", selection.names.length)
    });
    const titleField = synthesizePanel.createEl("label", { cls: "vam-field vam-next-synth-setup" });
    titleField.createSpan({ text: t("ui.new_topic_name") });
    const titleInput = titleField.createEl("input", { type: "text", value: selection.initialTitle });
    titleInput.setAttr("aria-label", t("ui.new_topic_name"));
    const synthesisContentSelect = renderSynthesisContent(adjustSynthesize, selection.names);
    const stageTwoHint = adjustSynthesize.createEl("p", {
      cls: "vam-hint vam-next-synth-fixed",
      text: t("ui.synthesis_stage_two_fixed")
    });
    stageTwoHint.hidden = true;
    synthesizePanel.createEl("p", { cls: "vam-hint", text: t("ui.synthesis_standard_first_hint") });
    const synthStatus = synthesizePanel.createEl("p", { cls: "vam-next-status", attr: { "aria-live": "polite" } });
    const synthResult = synthesizePanel.createDiv("vam-next-result");
    const suggestButton = actions.createEl("button", { text: t("ui.get_synthesis_suggestions_first"), cls: "mod-cta" });
    suggestButton.dataset.topicRun = suggestButton.textContent ?? "";
    const skipButton = actions.createEl("button", { text: t("ui.synthesis_skip_suggestions") });
    const draftButton = actions.createEl("button", { text: t("ui.get_synthesis_draft"), cls: "mod-cta" });
    let stage: "setup" | "directions" = pendingDirections ? "directions" : "setup";
    // Language, template, sources and content are fixed once the directions are requested; the draft step ignores them.
    let frozenSummary = "";
    const syncSynthesisStage = (): void => {
      const locked = stage === "directions";
      suggestButton.hidden = locked;
      skipButton.hidden = locked;
      draftButton.hidden = !locked;
      adjustSynthesize.toggleClass("is-fixed", locked);
      stageTwoHint.hidden = !locked;
      output.hidden = locked;
      titleField.toggleClass("is-hidden", locked);
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
        selection.pending?.discard();
        this.close();
      });
      synthStatus.setText(t("ui.choose_or_edit_a_synthesis_direction_then_get_a_draft"));
      syncSynthesisStage();
      refreshSummary();
    };
    // The result is written by the view (no draft review step); the dialog has nothing left to show.
    const flow = { directions: showDirections, written: () => this.close() };
    const nameProblem = (): string => titleProblemText(titleInput.value);
    const needsName = (): boolean => !titleInput.value.trim() || !!nameProblem();
    const checkName = (): void => {
      if (stage !== "setup") return;
      const missing = needsName();
      suggestButton.disabled = skipButton.disabled = missing;
      synthStatus.setText(missing ? nameProblem() || t("ui.synthesis_needs_name") : "");
    };
    titleInput.addEventListener("input", checkName);
    // Setup and draft options: the setup step reads every field; the draft step reads only the extra requirements.
    const setupOptions = async (signal: AbortSignal): Promise<TaskOptions> => {
      const content: SynthesisContent = synthesisContentSelect.value === "summary" ? "summary" : "full";
      synthesisContentSelect.disabled = true;
      const referenceGroups = await this.mapSourceGroups(signal);
      const options: TaskOptions = {
        synthesisContent: content,
        referenceGroups,
        outputLanguage: languageSelect.value as ContentLanguage,
        requirements: this.requirements(),
        ...(noteStyle() ? { noteStyle: noteStyle() } : {}),
        // A synthesis arranges what the topics already hold: Quick policy text, no web (D-2026-10-229).
        researchMode: "local",
        researchDepth: "normal",
        visualMode: "off",
        synthesisTitle: titleInput.value.trim(),
        signal,
        onProgress: message => {
          if (!this.closed) synthStatus.setText(message);
        }
      };
      frozenSummary = summaryEl.textContent ?? "";
      return options;
    };
    const draftOptions = (signal: AbortSignal): TaskOptions => ({
      continuesDirections: true,
      outputLanguage: languageSelect.value as ContentLanguage,
      requirements: this.requirements(),
      researchMode: "local",
      researchDepth: "normal",
      visualMode: "off",
      synthesisTitle: titleInput.value.trim(),
      signal,
      onProgress: message => {
        if (!this.closed) synthStatus.setText(message);
      }
    });
    const guard = (): boolean => {
      if (!needsName()) return true;
      synthStatus.setText(nameProblem() || t("ui.synthesis_needs_name"));
      return false;
    };
    suggestButton.addEventListener("click", () => {
      if (guard()) this.launchSynthesis(synthesizePanel, suggestButton, null, setupOptions, flow);
    });
    skipButton.addEventListener("click", () => {
      if (guard()) this.launchSynthesis(synthesizePanel, skipButton, selection.defaultDirection, setupOptions, flow);
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
    // Top row: the model follows the language of the user's text; not a language, so it sits above the list.
    languageSelect.createEl("option", { value: FOLLOW_INPUT_ID, text: supportedLanguageLabel(FOLLOW_INPUT_ID) });
    for (const option of SUPPORTED_LANGUAGES)
      languageSelect.createEl("option", { value: option.id, text: option.label });
    // Languages with no interface dictionary: the AI can write in them, so they are choosable here only.
    const moreLanguages = languageSelect.createEl("optgroup", { attr: { label: t("ui.output_language_more") } });
    for (const option of OUTPUT_LANGUAGE_CHOICES)
      moreLanguages.createEl("option", { value: option.id, text: option.label });
    languageSelect.value = defaultOutputLanguage(
      this.plugin.settings.language,
      "",
      undefined,
      selection.fields.outputLanguage,
      selection.fields.mapTitle
    );
    languageSelect.setAttr("aria-label", t("ui.output_language"));
    languageSelect.addEventListener("change", () => {
      this.manualOutputLanguage = languageSelect.value as ContentLanguage;
    });
    const style = styleChoiceField(compactSettings, {
      styles: stylePickerFor(this.app, this.plugin),
      current: selection.fields.currentStyle ?? "",
      changed: () => refreshSummary()
    });
    const noteStyle = style.style;
    const describeOutput = (): void => {
      outputValue.setText([supportedLanguageLabel(languageSelect.value), style.label()].filter(Boolean).join(" · "));
    };
    const refreshSummary = (): void => {
      describeOutput();
      if (stage === "directions") {
        summaryEl.setText(frozenSummary);
        return;
      }
      const parts: string[] = [
        t(synthesisContentSelect.value === "summary" ? "ui.next_summary_synth_summary" : "ui.next_summary_synth_full"),
        supportedLanguageLabel(languageSelect.value)
      ];
      const styleName = style.name();
      if (styleName) parts.push(styleName);
      summaryEl.setText(parts.join(" · "));
    };
    // After refreshSummary exists: reload() reports the redrawn list through `changed`.
    void style.reload();
    // Select, checkbox and radio changes bubble up, so one listener keeps the summary current.
    this.contentEl.addEventListener("change", refreshSummary);
    if (pendingDirections) showDirections(pendingDirections.directions);
    else checkName();
    syncSynthesisStage();
    refreshSummary();
    titleInput.focus();
    adjustBody.createEl("p", {
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
  // An untyped suggestion whose parent is itself or names no suggestion in this batch (the AI invented it) is
  // first-level, so it neither shows a parent hint nor blocks creation. Keyed and typed rows are left alone.
  const batchTitles = new Set(suggestions.map(item => item.title));
  suggestions = suggestions.map(item =>
    item.key === undefined &&
    !item.kind &&
    item.parentTitle &&
    (item.parentTitle === item.title || !batchTitles.has(item.parentTitle))
      ? { ...item, parentTitle: "" }
      : item
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
        // Keep the edited JSON and say what is wrong next to the button (never the parser's English message).
        status.setText(invalidMergedContentsText(error));
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
