import { Modal, Notice, type App } from "obsidian";
import { randomUUID } from "node:crypto";
import type VisualAgentMapPlugin from "../../main";
import {
  isNoteLanguage,
  noteLanguageOf,
  NOTE_LANGUAGES,
  translate,
  uiLocale,
  type NoteLanguage,
  type TranslationKey,
  type UiLanguage
} from "../../i18n";
import { createThinkingArtifact } from "../../core/thinking-artifact";
import { isHandoffWriteError, type ExperienceHandoffResult } from "../../core/experience-router";
import { normalizeReasoningLevel } from "../../ai/task-policy";
import { buildCoffeeSource, coffeeCommittedKey, type CoffeeSource } from "./handoff-source";
import type { CoffeeSession } from "./types";
import type { CoffeeHandoffSnapshot, CoffeeStorage } from "./storage";
import { syncModelSelect } from "../../core/model-discovery";
import type { ReframeRequest } from "../../core/reframing-service";
import { backgroundResultNotice } from "../../ui/background-run";

/** What the user typed or chose when AI organizing started; the reopened dialog restores it unchanged. */
export interface CoffeeHandoffInputs {
  question: string;
  context: string;
  model: string;
  reasoning: string;
  language: NoteLanguage;
}

/** Fields the dialog is reopened with: the original inputs, plus the AI draft when one finished. */
export interface CoffeeHandoffPrefill extends CoffeeHandoffInputs {
  rationale?: string;
  method?: "manual" | "ai";
  /** Shown in the status line (failure or Stop). */
  message?: string;
}

/**
 * One background "organize with AI" run per Coffee session. The dialog hides itself once AI starts, so the plugin
 * (not the dialog) owns the controller, the inputs and the finished draft until the user reviews, dismisses or stops.
 */
export interface CoffeeHandoffTask {
  sessionId: string;
  operationId: string;
  /** Bumped by Stop and plugin unload; a run whose epoch no longer matches drops its result. */
  epoch: number;
  controller: AbortController;
  state: "running" | "done" | "failed" | "stopped";
  inputs: CoffeeHandoffInputs;
  draft?: { question: string; context: string; rationale: string };
  message?: string;
  store: CoffeeStorage;
  snapshot: CoffeeHandoffSnapshot;
  path: string;
  insightId?: string;
}

interface HandoffRegistry {
  tasks: Map<string, CoffeeHandoffTask>;
  listeners: Set<() => void>;
}

const registries = new WeakMap<object, HandoffRegistry>();

function registry(plugin: VisualAgentMapPlugin): HandoffRegistry {
  let found = registries.get(plugin);
  if (!found) {
    const created: HandoffRegistry = { tasks: new Map(), listeners: new Set() };
    found = created;
    registries.set(plugin, created);
    // Plugin unload aborts every background run; nothing may write after that.
    plugin.register?.(() => {
      for (const task of created.tasks.values()) stopTask(plugin, task, false);
      created.tasks.clear();
    });
  }
  return found;
}

function notify(plugin: VisualAgentMapPlugin): void {
  for (const listener of [...registry(plugin).listeners]) listener();
}

/** The background run (running, finished, failed or stopped) for a Coffee session, if any. */
export function coffeeHandoffTask(plugin: VisualAgentMapPlugin, sessionId: string): CoffeeHandoffTask | undefined {
  return registry(plugin).tasks.get(sessionId);
}

/** Subscribes to registry changes (the Coffee view re-renders its status bar); returns the unsubscribe. */
export function subscribeCoffeeHandoff(plugin: VisualAgentMapPlugin, listener: () => void): () => void {
  const { listeners } = registry(plugin);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dismissCoffeeHandoff(plugin: VisualAgentMapPlugin, task: CoffeeHandoffTask): void {
  const { tasks } = registry(plugin);
  if (tasks.get(task.sessionId) !== task || task.state === "running") return;
  tasks.delete(task.sessionId);
  notify(plugin);
}

function stopTask(plugin: VisualAgentMapPlugin, task: CoffeeHandoffTask, announce: boolean): void {
  if (task.state !== "running") return;
  task.epoch++;
  task.state = "stopped";
  task.message = translate(uiLocale(plugin.settings.language), "coffee.handoff_stopped");
  task.controller.abort();
  plugin.activeTasks.delete(`reframe-modal:${task.operationId}`);
  if (announce) notify(plugin);
}

/** Stop from the status bar: aborts the request (before or after the provider accepted it) and writes nothing. */
export function stopCoffeeHandoff(plugin: VisualAgentMapPlugin, task: CoffeeHandoffTask): void {
  if (registry(plugin).tasks.get(task.sessionId) !== task) return;
  stopTask(plugin, task, true);
}

/**
 * Reopens the dialog from a finished, failed or stopped background run with its inputs (and the AI draft) restored.
 * The source is re-checked first; if it changed since the run started, the existing error is shown and nothing is
 * opened or written.
 */
export async function reopenCoffeeHandoff(
  plugin: VisualAgentMapPlugin,
  task: CoffeeHandoffTask
): Promise<CoffeeHandoffModal | undefined> {
  const { tasks } = registry(plugin);
  if (tasks.get(task.sessionId) !== task || task.state === "running") return undefined;
  try {
    await task.store.assertHandoffSnapshot(task.snapshot);
    const prefill: CoffeeHandoffPrefill = {
      ...task.inputs,
      ...(task.state === "done" && task.draft
        ? { question: task.draft.question, context: task.draft.context, rationale: task.draft.rationale, method: "ai" }
        : { message: task.message ?? "" })
    };
    const modal = await openCoffeeResearchHandoff(
      plugin,
      task.store,
      task.snapshot.session,
      task.path,
      task.insightId,
      prefill
    );
    if (tasks.get(task.sessionId) === task) {
      tasks.delete(task.sessionId);
      notify(plugin);
    }
    return modal;
  } catch (error) {
    new Notice(error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

export async function openCoffeeResearchHandoff(
  plugin: VisualAgentMapPlugin,
  store: CoffeeStorage,
  displayed: CoffeeSession,
  path: string,
  insightId?: string,
  prefill?: CoffeeHandoffPrefill
): Promise<CoffeeHandoffModal | undefined> {
  const waiting = coffeeHandoffTask(plugin, displayed.id);
  if (!prefill && waiting) {
    // One background job per session: a running one blocks; a finished one is reviewed instead of starting over.
    if (waiting.state === "running") throw new Error(translate(uiLocale(plugin.settings.language), "ui.ai_running_ai"));
    if (waiting.insightId === insightId) return reopenCoffeeHandoff(plugin, waiting);
    // A finished draft the owner never reviewed is not dropped silently.
    if (waiting.state === "done" && waiting.draft)
      new Notice(translate(uiLocale(plugin.settings.language), "coffee.handoff_draft_discarded"));
    dismissCoffeeHandoff(plugin, waiting);
  }
  const displayedKey = coffeeCommittedKey(displayed);
  if (plugin.coffeeManager?.get(displayed.id)?.busy) throw new Error("Wait for this table to finish.");
  const snapshot = await store.handoffSnapshot(path, displayed.id);
  if (plugin.coffeeManager?.get(displayed.id)?.busy) throw new Error("Wait for this table to finish.");
  if (displayedKey !== coffeeCommittedKey(snapshot.session))
    throw new Error("Coffee source differs from the displayed table; reopen the latest table.");
  const modal = new CoffeeHandoffModal(
    plugin.app,
    plugin,
    store,
    snapshot,
    buildCoffeeSource(snapshot.session, insightId),
    path,
    insightId,
    prefill
  );
  plugin.register(() => modal.close());
  modal.open();
  return modal;
}

export class CoffeeHandoffModal extends Modal {
  private readonly operationId = randomUUID();
  private controller: AbortController | null = null;
  private epoch = 0;
  private closed = false;
  /** Set once AI started and the dialog hid itself: from then on the registry task owns the run, not this dialog. */
  private detached = false;
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
  private readonly locale: UiLanguage;
  private unsubscribeModels?: () => void;
  constructor(
    app: App,
    private readonly plugin: VisualAgentMapPlugin,
    private readonly store: CoffeeStorage,
    private readonly snapshot: CoffeeHandoffSnapshot,
    private readonly source: CoffeeSource,
    private readonly path: string = snapshot.path,
    private readonly insightId?: string,
    private readonly prefill?: CoffeeHandoffPrefill
  ) {
    super(app);
    this.locale = uiLocale(plugin.settings.language);
  }
  private t(key: TranslationKey, ...values: unknown[]): string {
    return translate(this.locale, key, ...values);
  }
  onOpen(): void {
    this.titleEl.setText(this.t("coffee.take_to_visual_map_for_deeper_research"));
    this.contentEl.addClass("ct-handoff-modal");
    this.contentEl.createEl("p", {
      text: this.t("coffee.edit_a_research_question_and_context_ai_organization_is")
    });
    this.question = this.field(this.t("coffee.research_question"), 3);
    this.question.value = this.source.question;
    this.context = this.field(this.t("coffee.research_context"), 8);
    this.context.value = this.source.sourceSnapshot
      .replace(/<!--\s*(?:coffee-insight:v1:|source:)[\s\S]*?-->/g, "")
      .replace(/[ \t]+\n/g, "\n");
    const choices = this.contentEl.createDiv("ct-handoff-options");
    this.model = this.select(choices, this.t("coffee.model"), [
      ...new Set([this.snapshot.session.model, ...this.plugin.availableModels()])
    ]);
    this.model.value = this.snapshot.session.model;
    const discovery = this.contentEl.createDiv("ct-handoff-status");
    const discoveryText = discovery.createSpan({ attr: { role: "status", "aria-live": "polite" } });
    const retry = discovery.createEl("button", { text: this.t("coffee.retry_model_discovery") });
    const updateModels = (): void => {
      const selected = this.model.value;
      syncModelSelect(
        this.model,
        this.plugin.availableModels(),
        id => this.plugin.modelLabel(id),
        this.t("coffee.unavailable")
      );
      if (selected && !Array.from(this.model.options).some(option => option.value === selected))
        this.model.add(new Option(`${this.plugin.modelLabel(selected)} (${this.t("coffee.unavailable")})`, selected));
      this.model.value = selected;
      const codex = this.plugin.modelDiscoveryState("codex"),
        claude = this.plugin.modelDiscoveryState("claude");
      discoveryText.setText(
        `Codex: ${codex.status}${codex.error ? ` · ${codex.error}` : ""} | Claude CLI candidates: ${claude.status}`
      );
      retry.disabled = codex.status === "loading";
    };
    this.unsubscribeModels = this.plugin.subscribeModelDiscovery(updateModels);
    retry.addEventListener("click", () => {
      void this.plugin.refreshModelDiscovery("codex");
      void this.plugin.refreshModelDiscovery("claude");
    });
    updateModels();
    void this.plugin.refreshModelDiscovery("codex");
    void this.plugin.refreshModelDiscovery("claude");
    this.reasoning = this.select(choices, this.t("coffee.reasoning"), ["low", "medium", "high", "auto"]);
    this.reasoning.value = normalizeReasoningLevel(this.snapshot.session.reasoning);
    this.language = this.select(choices, this.t("coffee.output_language"), [...NOTE_LANGUAGES]);
    this.language.value = noteLanguageOf(this.plugin.settings.language);
    this.status = this.contentEl.createEl("p", {
      cls: "ct-handoff-status",
      attr: { role: "status", "aria-live": "polite" }
    });
    this.applyPrefill();
    const actions = this.contentEl.createDiv("modal-button-container");
    this.organize = actions.createEl("button", { text: this.t("coffee.organize_with_ai") });
    this.stop = actions.createEl("button", { text: this.t("coffee.stop_organizing") });
    this.stop.disabled = true;
    const copy = actions.createEl("button", { text: this.t("coffee.copy_draft") });
    this.create = actions.createEl("button", { text: this.t("coffee.create_research_map"), cls: "mod-cta" });
    this.organize.onclick = () => {
      void this.generate();
    };
    this.stop.onclick = () => {
      this.cancel();
      this.status.setText(this.t("coffee.stopped_your_previous_draft_is_preserved"));
    };
    copy.onclick = () => {
      void navigator.clipboard
        .writeText([this.question.value, this.context.value, this.rationale].filter(Boolean).join("\n\n"))
        .then(() => this.status.setText(this.t("ui.context_ai_copied")))
        .catch(error => this.showError(error));
    };
    this.create.onclick = () => {
      void this.submit();
    };
    this.question.focus();
  }
  /** Restores the inputs (and the AI draft) the dialog was hidden with. */
  private applyPrefill(): void {
    const prefill = this.prefill;
    if (!prefill) return;
    this.question.value = prefill.question;
    this.context.value = prefill.context;
    if (prefill.model && !Array.from(this.model.options).some(option => option.value === prefill.model))
      this.model.add(
        new Option(`${this.plugin.modelLabel(prefill.model)} (${this.t("coffee.unavailable")})`, prefill.model)
      );
    if (prefill.model) this.model.value = prefill.model;
    this.reasoning.value = normalizeReasoningLevel(prefill.reasoning);
    this.language.value = prefill.language;
    if (prefill.rationale !== undefined) this.rationale = prefill.rationale;
    if (prefill.method) this.method = prefill.method;
    if (prefill.message !== undefined) this.status.setText(prefill.message);
    else if (prefill.method === "ai")
      this.status.setText(this.t("coffee.review_and_edit_this_draft_then_create_the_research_map"));
  }
  private field(label: string, rows: number): HTMLTextAreaElement {
    const id = `ct-handoff-${randomUUID()}`;
    this.contentEl.createEl("label", { text: label, attr: { for: id } });
    return this.contentEl.createEl("textarea", { attr: { id, rows: String(rows), "aria-label": label } });
  }
  private select(parent: HTMLElement, label: string, values: string[]): HTMLSelectElement {
    const id = `ct-handoff-${randomUUID()}`;
    const group = parent.createDiv();
    group.createEl("label", { text: label, attr: { for: id } });
    const select = group.createEl("select", { attr: { id, "aria-label": label } });
    for (const value of values) select.createEl("option", { text: value, value });
    return select;
  }
  private refresh(): void {
    const busy = this.controller !== null || this.creating;
    for (const input of [this.question, this.context, this.model, this.reasoning, this.language])
      input.disabled = busy || this.blocked || !!this.result;
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
    if (this.plugin.coffeeManager?.get(this.snapshot.session.id)?.busy)
      throw new Error(this.t("coffee.the_table_is_generating_reopen_it_after_it_finishes"));
    await this.store.assertHandoffSnapshot(this.snapshot);
    if (this.closed) throw new Error("Research handoff closed");
    if (this.plugin.coffeeManager?.get(this.snapshot.session.id)?.busy)
      throw new Error(this.t("coffee.the_table_is_generating_reopen_it_after_it_finishes"));
  }
  private showError(error: unknown): void {
    if (!this.closed) this.status.setText(error instanceof Error ? error.message : String(error));
  }
  private async generate(): Promise<void> {
    if (this.controller || this.creating || this.blocked || this.result || this.closed || this.detached) return;
    const running = coffeeHandoffTask(this.plugin, this.snapshot.session.id);
    if (running?.state === "running") {
      this.status.setText(this.t("ui.ai_running_ai"));
      return;
    }
    const controller = new AbortController(),
      epoch = ++this.epoch;
    this.controller = controller;
    this.plugin.activeTasks.set(`reframe-modal:${this.operationId}`, controller);
    this.refresh();
    const language: NoteLanguage = isNoteLanguage(this.language.value) ? this.language.value : "en";
    const request = {
      targetCore: "understand" as const,
      source: this.source.content,
      question: this.question.value,
      context: this.context.value,
      model: this.model.value,
      reasoning: normalizeReasoningLevel(this.reasoning.value),
      language
    };
    this.status.setText(this.t("coffee.organizing_a_research_question"));
    try {
      await this.assertSource();
      const confirmed = await this.plugin.confirmAiUsage(request.model, async () => {
        if (controller.signal.aborted || this.closed || epoch !== this.epoch) return;
        // AI starts now: the plugin takes over the run and the dialog hides. The inputs are snapshotted first.
        const task = this.startBackground(controller, {
          question: request.question,
          context: request.context,
          model: request.model,
          reasoning: request.reasoning,
          language
        });
        this.detached = true;
        this.close();
        await this.runBackground(task, request);
      });
      if (!confirmed && !this.detached && epoch === this.epoch && !this.closed)
        this.status.setText(this.t("coffee.ai_did_not_run_edit_the_draft_manually_or_retry"));
    } catch (error) {
      if (!this.detached && epoch === this.epoch) this.showError(error);
    } finally {
      if (!this.detached && epoch === this.epoch) {
        this.controller = null;
        this.plugin.activeTasks.delete(`reframe-modal:${this.operationId}`);
        if (!this.closed) this.refresh();
      }
    }
  }
  private startBackground(controller: AbortController, inputs: CoffeeHandoffInputs): CoffeeHandoffTask {
    const task: CoffeeHandoffTask = {
      sessionId: this.snapshot.session.id,
      operationId: this.operationId,
      epoch: 0,
      controller,
      state: "running",
      inputs,
      store: this.store,
      snapshot: this.snapshot,
      path: this.path,
      ...(this.insightId ? { insightId: this.insightId } : {})
    };
    registry(this.plugin).tasks.set(task.sessionId, task);
    notify(this.plugin);
    return task;
  }
  /** Runs after the dialog hid itself: never touches the dialog; results land in the task and a Notice. */
  private async runBackground(task: CoffeeHandoffTask, request: ReframeRequest): Promise<void> {
    const epoch = task.epoch;
    // Dropped when Stop, a dismissal or a newer run replaced this one; an abort from elsewhere (runtime reset) ends it as stopped.
    const stale = (): boolean => {
      if (task.epoch !== epoch || !this.isCurrent(task)) return true;
      if (!task.controller.signal.aborted) return false;
      task.state = "stopped";
      task.message = this.t("coffee.handoff_stopped");
      return true;
    };
    try {
      const draft = await this.plugin.core.reframing!.reframe(request, task.controller.signal);
      if (stale()) return;
      await this.assertTaskSource();
      if (stale()) return;
      task.draft = draft;
      task.state = "done";
      backgroundResultNotice(this.t("coffee.handoff_draft_ready"), {
        label: this.t("ui.background_review"),
        open: () => {
          void reopenCoffeeHandoff(this.plugin, task);
        }
      });
    } catch (error) {
      if (stale()) return;
      task.state = "failed";
      task.message = error instanceof Error ? error.message : String(error);
      new Notice(task.message);
    } finally {
      if (task.epoch === epoch) {
        this.plugin.activeTasks.delete(`reframe-modal:${this.operationId}`);
        notify(this.plugin);
      }
    }
  }
  private isCurrent(task: CoffeeHandoffTask): boolean {
    return registry(this.plugin).tasks.get(task.sessionId) === task;
  }
  private async assertTaskSource(): Promise<void> {
    const busy = (): boolean => !!this.plugin.coffeeManager?.get(this.snapshot.session.id)?.busy;
    if (busy()) throw new Error(this.t("coffee.the_table_is_generating_reopen_it_after_it_finishes"));
    await this.store.assertHandoffSnapshot(this.snapshot);
    if (busy()) throw new Error(this.t("coffee.the_table_is_generating_reopen_it_after_it_finishes"));
  }
  private async submit(): Promise<void> {
    if (this.controller || this.creating || this.blocked || this.closed) return;
    const title = this.question.value.trim();
    if (!title || /[\r\n]/.test(title)) {
      this.status.setText(this.t("coffee.enter_a_single_line_research_question"));
      return;
    }
    this.creating = true;
    this.refresh();
    try {
      if (this.result) {
        await this.plugin.openResearchMap(this.result.targetPath);
        this.close();
        return;
      }
      await this.assertSource();
      const path = this.snapshot.path;
      const artifact = createThinkingArtifact({
        id: this.operationId,
        kind: "question",
        title,
        content: [this.context.value.trim(), this.rationale ? `Reframing rationale:\n${this.rationale}` : ""]
          .filter(Boolean)
          .join("\n\n"),
        sourceSnapshot: this.source.sourceSnapshot,
        origin: { experience: "coffee-tables", sessionId: this.snapshot.session.id, path },
        sources: [
          {
            label: this.snapshot.session.topic,
            path,
            experience: "coffee-tables",
            sessionId: this.snapshot.session.id,
            artifactId: this.source.artifactId
          }
        ],
        metadata: {
          model: this.model.value,
          reasoning: this.reasoning.value,
          reframingMethod: this.method,
          sourceIdentityKind: this.source.identityKind
        }
      });
      const result = await this.plugin.core.experiences.handoff({
        target: "visual-map",
        artifact,
        beforeWrite: () => this.assertSource()
      });
      if (!result) throw new Error("Research handoff did not return saved target paths");
      this.result = result;
      if (result.navigationError) {
        this.status.setText(
          `${this.t("coffee.saved_retry_only_opens_the_existing_map")}\n${result.targetPath}\n${result.navigationError}`
        );
        this.create.setText(this.t("coffee.open_saved_map"));
      } else this.close();
    } catch (error) {
      if (isHandoffWriteError(error) && error.paths.length) {
        this.blocked = true;
        this.showError(
          `${this.t("coffee.some_files_were_created_inspect_them_before_starting")}\n${error.paths.join("\n")}\n${error.message}`
        );
      } else this.showError(error);
    } finally {
      this.creating = false;
      if (!this.closed) this.refresh();
    }
  }
  onClose(): void {
    this.closed = true;
    this.unsubscribeModels?.();
    this.unsubscribeModels = undefined;
    // After AI started the plugin task owns the run: hiding the dialog must not abort it.
    if (!this.detached) this.cancel();
    this.contentEl.empty();
  }
}
