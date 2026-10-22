import {
  customizationFields,
  CoffeeCustomizationModal,
  CoffeeConvergenceModal,
  convergencePreviewMarks,
  notifyConvergencePreview
} from "./customization-ui";
import {
  coffeeHandoffTask,
  dismissCoffeeHandoff,
  reopenCoffeeHandoff,
  stopCoffeeHandoff,
  subscribeCoffeeHandoff
} from "./handoff-modal";
import { renderBackgroundStatus } from "../../ui/background-run";
import { defaultCustomization, validateCustomization, type CoffeeCustomization } from "./customization";
import { coffeeSegments, extractSegmentSummary, type CoffeeNavigationSnapshot } from "./segments";
import {
  ItemView,
  MarkdownRenderer,
  Modal,
  Notice,
  setIcon,
  type App,
  type WorkspaceLeaf,
  type ViewStateResult
} from "obsidian";
import type VisualAgentMapPlugin from "../../main";
import {
  instructionLanguageOf,
  languagePromptName,
  LANGUAGES,
  noteLanguageOf,
  translate,
  uiLocale,
  type NoteLanguage,
  type TranslationKey,
  type UiLanguage
} from "../../i18n";
import { CoffeeEngine } from "./engine";
import { CoffeeStorage } from "./storage";
import {
  copyLegacySession,
  createSession,
  type AnyCoffeeSession,
  type CoffeeReference,
  type CoffeeSession,
  type GuestCategory,
  type GuestCounts,
  type GuestSettings,
  type NamedGuest
} from "./types";
import {
  BUILTIN_COFFEE_STYLE_NAME,
  builtinCoffeeStyle,
  openingPromptPreview,
  cleanChatStyle,
  tablePrompt
} from "./prompts";
import { COFFEE_SAMPLE_EN, COFFEE_SAMPLE_ZH } from "./samples";
import { coffeeContentLocale, coffeeInstruction } from "./language";
import {
  effectiveTableStatus,
  formatTableTime,
  selectTables,
  tableTime,
  topicTableCount,
  type TableListFilter,
  type TableListItem
} from "./list";
import { COFFEE_TOPICS, coffeeTopicText, pickCoffeeTopic } from "./topics";
import { findRelatedSpeech, type CoffeeSpeechTarget } from "./outline";
import { baselineFromVersions } from "./insights";
import { validateGuestInvitations } from "./guest-invitations";
import { modelDiscoverySummary, syncModelSelect } from "../../core/model-discovery";
import { providerForModel } from "../../ai/providers/provider";

export const COFFEE_TABLES_NAME = "Coffee Tables";
export const COFFEE_TABLES_VIEW_TYPE = "coffee-tables-view";
export function reasoningChoiceState(
  selected: string,
  efforts: string[],
  discoveryStatus: string
): { values: string[]; selected: string } {
  const values = ["auto", ...efforts.filter(value => ["low", "medium", "high"].includes(value))];
  if (discoveryStatus !== "ready" && selected && !values.includes(selected)) values.push(selected);
  return { values, selected: values.includes(selected) ? selected : "auto" };
}
class CoffeeDeleteModal extends Modal {
  private resolveResult?: (confirmed: boolean) => void;
  private confirmed = false;
  constructor(
    app: App,
    private topic: string,
    private locale: UiLanguage
  ) {
    super(app);
  }
  private t(key: TranslationKey, ...values: unknown[]): string {
    return translate(this.locale, key, ...values);
  }
  confirm(): Promise<boolean> {
    return new Promise(resolve => {
      this.resolveResult = resolve;
      this.open();
    });
  }
  onOpen(): void {
    const content = this.contentEl;
    content.empty();
    content.createEl("h2", { text: this.t("coffee.delete_this_table") });
    content.createEl("p", {
      text: this.t("coffee.will_be_backed_up_and_moved_to_the_vault_trash", this.topic)
    });
    const buttons = content.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: this.t("ui.cancel") });
    cancel.onclick = () => this.close();
    const remove = buttons.createEl("button", { text: this.t("ui.move_to_trash") });
    remove.addClass("mod-warning");
    remove.onclick = () => {
      this.confirmed = true;
      this.close();
    };
  }
  onClose(): void {
    this.contentEl.empty();
    this.resolveResult?.(this.confirmed);
    this.resolveResult = undefined;
  }
}
class CoffeeSummaryConfirmModal extends Modal {
  private result?: (confirmed: boolean) => void;
  private confirmed = false;
  constructor(
    app: App,
    private model: string,
    private locale: UiLanguage
  ) {
    super(app);
  }
  private t(key: TranslationKey, ...values: unknown[]): string {
    return translate(this.locale, key, ...values);
  }
  confirm(): Promise<boolean> {
    return new Promise(resolve => {
      this.result = resolve;
      this.open();
    });
  }
  onOpen(): void {
    this.contentEl.createEl("h2", { text: this.t("coffee.fill_segment_summaries") });
    this.contentEl.createEl("p", {
      text: this.t("coffee.use_this_tables_model_in_one_ai_request_to_summarize", this.model)
    });
    const actions = this.contentEl.createDiv("modal-button-container");
    actions.createEl("button", { text: this.t("ui.cancel") }).onclick = () => this.close();
    actions.createEl("button", { text: this.t("coffee.generate_summaries") }).onclick = () => {
      this.confirmed = true;
      this.close();
    };
  }
  onClose(): void {
    this.result?.(this.confirmed);
    this.result = undefined;
    this.contentEl.empty();
  }
}
class CoffeeStyleNameModal extends Modal {
  private resolveResult?: (value: string | null) => void;
  constructor(
    app: App,
    private initial: string,
    private locale: UiLanguage
  ) {
    super(app);
  }
  private t(key: TranslationKey, ...values: unknown[]): string {
    return translate(this.locale, key, ...values);
  }
  ask(): Promise<string | null> {
    return new Promise(resolve => {
      this.resolveResult = resolve;
      this.open();
    });
  }
  onOpen(): void {
    const content = this.contentEl;
    content.empty();
    content.createEl("h2", { text: this.t("coffee.rename_style") });
    const input = content.createEl("input", {
      attr: { type: "text", value: this.initial, maxlength: "80", "aria-label": this.t("coffee.style_name") }
    });
    const buttons = content.createDiv({ cls: "modal-button-container" });
    const cancel = buttons.createEl("button", { text: this.t("ui.cancel") });
    cancel.onclick = () => {
      this.close();
    };
    const save = buttons.createEl("button", { text: this.t("coffee.save") });
    save.addClass("mod-cta");
    save.onclick = () => {
      this.resolveResult?.(input.value.trim() || null);
      this.close();
    };
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") save.click();
    });
    input.focus();
    input.select();
  }
  onClose(): void {
    this.contentEl.empty();
    this.resolveResult?.(null);
    this.resolveResult = undefined;
  }
}
class CoffeePromptPreviewModal extends Modal {
  constructor(
    app: App,
    private prompt: string,
    private locale: UiLanguage,
    private fullPrompt?: string
  ) {
    super(app);
  }
  private t(key: TranslationKey, ...values: unknown[]): string {
    return translate(this.locale, key, ...values);
  }
  onOpen(): void {
    const content = this.contentEl;
    content.empty();
    this.modalEl.addClass("ct-prompt-preview-modal");
    content.addClass("ct-prompt-preview-content");
    content.createEl("h2", { text: this.t("coffee.opening_prompt_preview") });
    content.createEl("p", {
      cls: "ct-muted",
      text: this.t("coffee.this_preview_shows_the_topic_participants_style_and")
    });
    const textarea = content.createEl("textarea", {
      attr: {
        rows: "24",
        readonly: "true",
        wrap: "soft",
        "aria-label": this.t("coffee.opening_prompt_preview")
      }
    });
    textarea.value = this.prompt;
    content.createEl("small", {
      cls: "ct-muted",
      text: `${this.prompt.length.toLocaleString()} ${this.t("coffee.characters")}`
    });
    if (this.fullPrompt) {
      const details = content.createEl("details");
      details.createEl("summary", {
        text: this.t("coffee.actual_submitted_prompt_read_only")
      });
      details.createEl("p", {
        cls: "ct-muted",
        text: this.t("coffee.includes_the_system_format_needed_for_processing_edit")
      });
      const raw = details.createEl("textarea", {
        attr: { rows: "16", readonly: "true", "aria-label": this.t("coffee.actual_submitted_prompt") }
      });
      raw.value = this.fullPrompt;
    }
  }
  onClose(): void {
    this.contentEl.empty();
  }
}
const CATEGORIES: Array<{
  id: GuestCategory;
  label: TranslationKey;
  description: TranslationKey;
  role: TranslationKey;
}> = [
  {
    id: "experts",
    label: "coffee.guest_category_experts",
    description: "coffee.guest_category_experts_description",
    role: "coffee.guest_role_experts"
  },
  {
    id: "cross-domain",
    label: "coffee.guest_category_cross_domain",
    description: "coffee.guest_category_cross_domain_description",
    role: "coffee.guest_role_cross_domain"
  },
  {
    id: "generalist",
    label: "coffee.guest_category_generalist",
    description: "coffee.guest_category_generalist_description",
    role: "coffee.guest_role_generalist"
  },
  {
    id: "affected",
    label: "coffee.guest_category_affected",
    description: "coffee.guest_category_affected_description",
    role: "coffee.guest_role_affected"
  }
];
function categoryLabel(category: string, language: string): string {
  const names: Record<string, TranslationKey> = {
    connections: "coffee.insight_category_connections",
    questions: "coffee.insight_category_questions",
    disagreements: "coffee.insight_category_disagreements",
    directions: "coffee.insight_category_directions",
    assumptions: "coffee.insight_category_assumptions",
    solutions: "coffee.insight_category_solutions"
  };
  const key = names[category];
  return key ? translate(uiLocale(language), key) : category;
}
export function parseGuests(markdown: string): Array<{ name: string; role: string; bio: string }> {
  return [...markdown.matchAll(/^- \*\*(.+?)\s*[｜|]\s*(.+?)\*\*[：:]\s*(.+)$/gm)].map(match =>
    /主持人|觀察者|專家|藝人|當事人/.test(match[1])
      ? { name: match[2].trim(), role: match[1].trim(), bio: match[3].trim() }
      : { name: match[1].trim(), role: match[2].trim(), bio: match[3].trim() }
  );
}
export function rosterFor(
  session: CoffeeSession,
  markdown: string
): Array<{ name: string; role: string; bio: string }> {
  const locale = uiLocale(session.language),
    settings = session.guests;
  const inviteRoles = Object.fromEntries(CATEGORIES.map(item => [item.id, translate(locale, item.role)])) as Record<
    GuestCategory,
    string
  >;
  const invited = (session.questions ?? [])
    .filter(question => question.status === "complete")
    .flatMap(question => question.invitedGuests ?? [])
    .map(guest => ({ name: guest.name, role: inviteRoles[guest.category], bio: guest.description }));
  const people = [
    ...new Map(
      [...parseGuests(markdown), ...invited].map(person => [person.name.trim().toLocaleLowerCase(), person])
    ).values()
  ];
  const roles = [
    { category: "host", label: "coffee.roster_host" as TranslationKey, count: settings?.hostCount ?? 2 },
    { category: "observer", label: "coffee.roster_observer" as TranslationKey, count: 1 },
    ...CATEGORIES.map(item => ({ category: item.id, label: item.label, count: settings?.counts[item.id] ?? 0 }))
  ];
  // Display-only counting: a stored role belongs to a category when it contains that category's role or label text in
  // any registered language, so real guests of every language are matched (not a production parser).
  const textsOf = (keys: TranslationKey[]): string[] =>
    LANGUAGES.flatMap(language => keys.map(key => translate(language.id, key).trim().toLocaleLowerCase())).filter(
      Boolean
    );
  // "expert" is the tail the topic-expert and cross-domain roles share in each language (e.g. "专家").
  const expertTail = LANGUAGES.map(language => {
    const left = translate(language.id, "coffee.guest_role_experts").trim().toLocaleLowerCase();
    const right = translate(language.id, "coffee.guest_role_cross_domain").trim().toLocaleLowerCase();
    let size = 0;
    while (size < left.length && size < right.length && left[left.length - 1 - size] === right[right.length - 1 - size])
      size++;
    return left.slice(left.length - size).trim();
  }).filter(text => text.length >= 2);
  const roleTexts: Array<[string, string[]]> = [
    ["host", textsOf(["coffee.roster_host"])],
    ["observer", textsOf(["coffee.roster_observer"])],
    ["cross-domain", textsOf(["coffee.guest_role_cross_domain", "coffee.guest_category_cross_domain"])],
    ["generalist", textsOf(["coffee.guest_role_generalist", "coffee.guest_category_generalist"])],
    ["affected", textsOf(["coffee.guest_role_affected", "coffee.guest_category_affected"])],
    ["experts", [...textsOf(["coffee.guest_role_experts", "coffee.guest_category_experts"]), ...expertTail]]
  ];
  const roleKey = (role: string): string => {
    const text = role.toLocaleLowerCase();
    return roleTexts.find(([, texts]) => texts.some(item => text.includes(item)))?.[0] ?? "";
  };
  const used = new Map<string, number>();
  for (const person of people) {
    const key = roleKey(person.role);
    if (key) used.set(key, (used.get(key) ?? 0) + 1);
  }
  // Placeholders are display-only, so they follow the interface language; the roles of real guests stay as stored.
  const display = coffeeContentLocale(session.language);
  const placeholders = roles.flatMap(item =>
    Array.from({ length: Math.max(0, item.count - (used.get(item.category) ?? 0)) }, (_, index) => ({
      name: `${translate(display, item.label)} ${index + 1}`,
      role: translate(display, "coffee.roster_joining"),
      bio: translate(display, "coffee.roster_waiting_for_introduction")
    }))
  );
  return [...people, ...placeholders];
}
export function liveRosterFor(
  session: CoffeeSession,
  draftMarkdown = ""
): Array<{ name: string; role: string; bio: string }> {
  const history = [
    session.transcriptMarkdown,
    ...(session.rounds ?? []).flatMap(round => [round.markdown, round.draftMarkdown]),
    ...(session.questions ?? []).flatMap(question => [question.answer, question.draftAnswer])
  ];
  return rosterFor(session, [...history, draftMarkdown].filter(Boolean).join("\n"));
}
export function parseSpeeches(markdown: string): Array<{ name: string; role: string; text: string }> {
  const body = extractSegmentSummary(markdown).markdown.split(/^# (?:觀察者整理|Observer(?:[’']s)? notes)\s*$/m, 1)[0];
  const people = parseGuests(body),
    roles = new Map(people.map(person => [person.name, person.role]));
  return [...body.matchAll(/^###\s+([^\n]+)\n([\s\S]*?)(?=^###\s|$(?![\s\S]))/gm)]
    .map(match => {
      const [name, explicitRole] = match[1].split(/[｜|]/, 2).map(value => value.trim());
      const person = people.find(entry => entry.name === name);
      return { name, role: explicitRole || person?.role || roles.get(name) || "", text: match[2].trim() };
    })
    .filter(item => item.text && item.role && !/^(觀察者整理|Observer(?:[’']s)? notes)$/.test(item.name));
}
function isCoffeeReference(value: unknown): value is CoffeeReference {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { content?: unknown }).content === "string"
  );
}
function defaults(): GuestCounts {
  return { experts: 4, "cross-domain": 1, generalist: 1, affected: 1 };
}
function total(counts: GuestCounts): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}
export class CoffeeTablesView extends ItemView {
  private legacyNavigation: CoffeeNavigationSnapshot | null = null;
  private store!: CoffeeStorage;
  private engine: CoffeeEngine | null = null;
  private unsubscribe: (() => void) | null = null;
  private savingCoffeeStyles = false;
  private showArchivedTables = false;
  private closed = false;
  private generation = 0;
  private navigationGeneration = 0;
  private homeGeneration = 0;
  private listGeneration = 0;
  private selectedPath = "";
  private previewVisible = false;
  private homeQuery = "";
  private tableFilter: TableListFilter = "all";
  private focusedTopic: string | null = null;
  private recoveredPendingCreates = false;
  private scrollEpoch = 0;
  private homePane: "main" | "list" = "main";
  private homeForm: Record<string, string> = {};
  private homeEdit: CoffeeSession | null = null;
  private homeMainScrollTop = 0;
  private homeListScrollTop = 0;
  private firstRoomScroll: "top" | "bottom" | null = null;
  private markdownJobs: Promise<void>[] | null = null;
  private renderTimer: number | null = null;
  private statusTimer: number | null = null;
  private stateSignature = "";
  private composerValues = new Map<string, string>();
  private suppressStateRestore = false;
  private speechAnchorIndex = 0;
  private liveRenderEpoch = 0;
  private roomRenderEpoch = 0;
  private insightStates = new Map<string, { query: string; expanded: Set<string>; collapsed: Set<string> }>();
  private followUpGuests: Array<{ id: string; name: string; category: GuestCategory; description: string }> = [];
  private modelUnsubscribe?: () => void;
  private handoffUnsubscribe?: () => void;
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: VisualAgentMapPlugin
  ) {
    super(leaf);
  }
  getViewType(): string {
    return COFFEE_TABLES_VIEW_TYPE;
  }
  getDisplayText(): string {
    return COFFEE_TABLES_NAME;
  }
  getIcon(): string {
    return "coffee";
  }
  outlineSnapshot(): CoffeeNavigationSnapshot | null {
    const session = this.engine?.session;
    return session
      ? { sessionId: session.id, topic: session.topic, segments: coffeeSegments(session) }
      : this.legacyNavigation;
  }
  locateSegment(id: string): boolean {
    const nodes = Array.from(this.contentEl.querySelectorAll<HTMLElement>("[data-coffee-segment]"));
    const node = nodes.find(item => item.dataset.coffeeSegment === id);
    const scroller = this.contentEl.querySelector<HTMLElement>(".ct-chat-scroll");
    if (!node || !scroller) return false;
    const body = this.contentEl.querySelector<HTMLElement>(".ct-room-columns");
    if (body) body.dataset.pane = "chat";
    this.scrollEpoch++;
    scroller.scrollTo({
      top: Math.max(
        0,
        node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 24
      ),
      behavior: "smooth"
    });
    const message = node.querySelector<HTMLElement>(".ct-message") ?? node;
    message.addClass("ct-outline-highlight");
    window.setTimeout(() => message.removeClass("ct-outline-highlight"), 1800);
    return true;
  }
  async confirmFillSummaries(): Promise<void> {
    const engine = this.engine;
    if (!engine || engine.busy) return;
    const confirmed = await new CoffeeSummaryConfirmModal(
      this.app,
      engine.session.model,
      this.plugin.settings.language
    ).confirm();
    if (!confirmed || this.engine !== engine || engine.busy || this.closed) return;
    await this.plugin.confirmAiUsage(engine.session.model, () => engine.fillSegmentSummaries());
  }
  locateOutlineItem(text: string): boolean {
    const session = this.engine?.session;
    if (!session) return false;
    const targetRows: CoffeeSpeechTarget[] = [];
    this.contentEl.querySelectorAll("[data-coffee-speech]").forEach((element: HTMLElement, order: number) =>
      targetRows.push({
        id: element.getAttribute("data-coffee-speech") ?? "",
        text: element.getAttribute("data-coffee-speech-text") ?? "",
        order
      })
    );
    const match = findRelatedSpeech(text, targetRows);
    if (!match) return false;
    const node = this.contentEl.querySelector<HTMLElement>(`[data-coffee-speech="${match}"]`);
    if (!node) return false;
    const scroller = this.contentEl.querySelector<HTMLElement>(".ct-chat-scroll");
    if (!scroller) return false;
    const top = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTo({ top: Math.max(0, top - 24), behavior: "smooth" });
    node.addClass("ct-outline-highlight");
    window.setTimeout(() => node.removeClass("ct-outline-highlight"), 1800);
    return true;
  }
  private t(key: TranslationKey, ...values: unknown[]): string {
    return translate(uiLocale(this.plugin.settings.language), key, ...values);
  }
  async refreshForLanguageChange(): Promise<void> {
    if (this.closed) return;
    if (this.engine) {
      this.render();
      return;
    }
    const active = this.contentEl.ownerDocument.activeElement as
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    const field = active?.dataset.ctHomeField,
      start =
        active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionStart : null,
      end = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionEnd : null;
    this.homeForm.advancedOpen = this.contentEl.querySelector<HTMLDetailsElement>(".ct-advanced-settings")?.open
      ? "true"
      : (this.homeForm.advancedOpen ?? "false");
    this.homeForm.topicIdeasOpen = this.contentEl.querySelector<HTMLDetailsElement>(".ct-topic-ideas")?.open
      ? "true"
      : (this.homeForm.topicIdeasOpen ?? "false");
    this.homeMainScrollTop =
      this.contentEl.querySelector<HTMLElement>(".ct-home-main")?.scrollTop ?? this.homeMainScrollTop;
    await this.home();
    if (field) {
      const replacement = this.contentEl.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        `[data-ct-home-field="${field}"]`
      );
      replacement?.focus();
      if (replacement instanceof HTMLInputElement || replacement instanceof HTMLTextAreaElement) {
        try {
          replacement.setSelectionRange(start ?? replacement.value.length, end ?? replacement.value.length);
        } catch {
          /* Selection is unavailable for this input type. */
        }
      }
    }
  }
  async onOpen(): Promise<void> {
    await this.plugin.ready;
    this.closed = false;
    this.suppressStateRestore = false;
    this.store = this.plugin.coffeeStorage ?? new CoffeeStorage(this.app.vault, this.plugin.settings.workspaceFolder);
    this.contentEl.addClass("ct-view");
    await this.home();
  }
  /** The plugin rebuilt its Coffee Tables storage (workspace folder changed): re-read it and return to the table list. */
  rebindStorage(): void {
    if (this.closed) return;
    this.store = this.plugin.coffeeStorage ?? new CoffeeStorage(this.app.vault, this.plugin.settings.workspaceFolder);
    this.recoveredPendingCreates = false;
    this.suppressStateRestore = true;
    this.homeEdit = null;
    void this.home();
  }
  async onClose(): Promise<void> {
    this.closed = true;
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.modelUnsubscribe?.();
    this.modelUnsubscribe = undefined;
    this.handoffUnsubscribe?.();
    this.handoffUnsubscribe = undefined;
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    if (this.statusTimer !== null) window.clearInterval(this.statusTimer);
  }
  getState(): Record<string, unknown> {
    return { sessionId: this.engine?.session.id ?? null };
  }
  async setState(state: { sessionId?: string }, result: ViewStateResult): Promise<void> {
    await this.plugin.ready;
    if (!this.store)
      this.store = this.plugin.coffeeStorage ?? new CoffeeStorage(this.app.vault, this.plugin.settings.workspaceFolder);
    if (state.sessionId && !this.suppressStateRestore && state.sessionId !== this.engine?.session.id)
      await this.loadSession(state.sessionId);
    await super.setState(state, result);
  }
  private returnHome(edit?: CoffeeSession): void {
    this.suppressStateRestore = true;
    this.previewVisible = false;
    if (!edit) this.homeEdit = null;
    void this.home(edit);
    this.app.workspace.requestSaveLayout();
  }
  private button(
    parent: HTMLElement,
    label: string,
    action: () => void | Promise<void>,
    disabled = false
  ): HTMLButtonElement {
    const button = parent.createEl("button", { text: label });
    button.disabled = disabled;
    button.addEventListener("click", () => {
      void Promise.resolve()
        .then(action)
        .catch((error: unknown) => new Notice(error instanceof Error ? error.message : String(error)));
    });
    return button;
  }
  private async home(edit?: CoffeeSession): Promise<void> {
    const requestedEdit = !!edit;
    if (!edit && this.homeEdit) edit = this.homeEdit;
    if (requestedEdit && edit) {
      this.homeEdit = edit;
      const priorGuests = edit.guests?.guests?.length
        ? edit.guests.guests
        : edit.guests?.background
          ? [{ id: crypto.randomUUID(), category: "experts" as const, description: edit.guests.background }]
          : [];
      this.homeForm = {
        ...this.homeForm,
        topic: edit.topic,
        topicIdeaId: "",
        topicEdited: "true",
        model: edit.model,
        reasoning: edit.reasoning,
        hostCount: String(edit.guests?.hostCount ?? 2),
        custom: edit.guests?.customPrompt ?? "",
        customization: JSON.stringify(edit.guests?.customization ?? defaultCustomization(edit.language)),
        styleId: edit.guests?.styleId ?? "builtin",
        styleName: edit.guests?.styleName ?? BUILTIN_COFFEE_STYLE_NAME,
        stylePrompt:
          edit.guests?.stylePrompt ??
          (edit.guests?.customPrompt
            ? `${builtinCoffeeStyle(this.plugin.settings.language)}\n\n${edit.guests.customPrompt}`
            : builtinCoffeeStyle(this.plugin.settings.language)),
        refs: JSON.stringify(edit.guests?.referenceFiles ?? []),
        invites: JSON.stringify(priorGuests),
        ...Object.fromEntries(
          CATEGORIES.map(item => [`count-${item.id}`, String(edit.guests?.counts[item.id] ?? defaults()[item.id])])
        )
      };
    }
    const generation = ++this.generation;
    this.navigationGeneration++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.closed || generation !== this.generation) return;
    if (!this.recoveredPendingCreates) {
      try {
        await this.store.recoverPendingCreates();
        await this.store.recoverMoves();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
      }
      this.recoveredPendingCreates = true;
    }
    if (this.closed || generation !== this.generation) return;
    this.engine = null;
    this.legacyNavigation = null;
    if (this.plugin.isCoffeeOutlineSource?.(this)) this.plugin.refreshCoffeeOutline?.(this);
    this.contentEl.empty();
    const shell = this.contentEl.createDiv("ct-home-shell");
    const home = shell.createDiv("ct-home-main");
    home.scrollTop = this.homeMainScrollTop;
    home.addEventListener("scroll", () => (this.homeMainScrollTop = home.scrollTop));
    const tabs = shell.createDiv("ct-home-tabs");
    this.button(tabs, this.t("coffee.setup_and_preview"), () => {
      this.homePane = "main";
      shell.dataset.pane = "main";
    });
    this.button(tabs, this.t("coffee.table_list"), () => {
      this.homePane = "list";
      shell.dataset.pane = "list";
    });
    shell.dataset.pane = this.homePane;
    const title = home.createDiv("ct-home-title");
    const cup = title.createSpan({ cls: "ct-coffee-icon" });
    setIcon(cup, "coffee");
    title.createEl("h2", { text: COFFEE_TABLES_NAME });
    home.createEl("p", {
      cls: "ct-intro",
      text: this.t("coffee.bring_different_ai_perspectives_together_to_spot_blind")
    });
    home.createEl("p", {
      cls: "ct-muted",
      text: this.t("coffee.guests_and_experiences_are_ai_simulations")
    });
    const setup = home.createDiv("ct-home-section");
    setup.createEl("h3", { text: this.t("coffee.start_a_table") });
    const topic = setup.createEl("textarea", {
      attr: {
        "aria-label": this.t("coffee.topic"),
        placeholder: this.t("coffee.what_would_you_like_to_explore"),
        maxlength: "1200",
        rows: "3",
        "data-ct-home-field": "topic"
      }
    });
    const topicWasEdited = this.homeForm.topicEdited === "true",
      ideaId = this.homeForm.topicIdeaId ?? "";
    const suggestedTopic =
      ideaId && !topicWasEdited ? coffeeTopicText(ideaId, this.plugin.settings.language) : undefined;
    topic.value = topicWasEdited
      ? (this.homeForm.topic ?? "")
      : (suggestedTopic ??
        this.homeForm.topic ??
        pickCoffeeTopic(this.plugin.settings.language, this.homeForm.previousTopic ?? ""));
    if (!edit && !topicWasEdited && !ideaId)
      this.homeForm.topicIdeaId =
        COFFEE_TOPICS.find(item => item[coffeeInstruction(this.plugin.settings.language)] === topic.value)?.id ?? "";
    const ideas = setup.createEl("details", { cls: "ct-topic-ideas" });
    ideas.open = this.homeForm.topicIdeasOpen === "true";
    ideas.addEventListener("toggle", () => {
      this.homeForm.topicIdeasOpen = String(ideas.open);
    });
    ideas.createEl("summary", { text: this.t("coffee.browse_20_topic_ideas") });
    const ideaList = ideas.createDiv("ct-topic-list");
    for (const item of COFFEE_TOPICS) {
      const value = item[coffeeInstruction(this.plugin.settings.language)];
      this.button(ideaList, value, () => {
        topic.value = value;
        this.homeForm.topicIdeaId = item.id;
        this.homeForm.topicEdited = "false";
        snapshotForm();
      });
    }
    this.button(setup, this.t("coffee.surprise_me_with_a_topic"), () => {
      const previous = topic.value;
      topic.value = pickCoffeeTopic(this.plugin.settings.language, previous);
      this.homeForm.topicIdeaId =
        COFFEE_TOPICS.find(item => item[coffeeInstruction(this.plugin.settings.language)] === topic.value)?.id ?? "";
      this.homeForm.topicEdited = "false";
      this.homeForm.previousTopic = previous;
      snapshotForm();
    });
    const advanced = setup.createEl("details", { cls: "ct-advanced-settings" });
    advanced.open = this.homeForm.advancedOpen === "true";
    advanced.addEventListener("toggle", () => {
      this.homeForm.advancedOpen = String(advanced.open);
    });
    const advancedSummary = advanced.createEl("summary", { text: this.t("coffee.adjust_this_table") });
    const models = advanced.createDiv("ct-model-row");
    const model = models.createEl("select", { attr: { "aria-label": this.t("coffee.ai_model") } });
    const reasoning = models.createEl("select", { attr: { "aria-label": this.t("coffee.reasoning_effort") } });
    const efforts: Record<string, TranslationKey> = {
      auto: "coffee.reasoning_auto",
      low: "coffee.reasoning_low",
      medium: "coffee.reasoning_medium",
      high: "coffee.reasoning_high"
    };
    const setReasoning = (): void => {
      const selected =
        reasoning.value || this.homeForm.reasoning || edit?.reasoning || this.plugin.settings.cliReasoning;
      const status = this.plugin.modelDiscoveryState?.(providerForModel(model.value)).status ?? "ready";
      const state = reasoningChoiceState(selected, this.plugin.coffeeReasoningEfforts(model.value), status);
      reasoning.empty();
      state.values.forEach(value =>
        reasoning.createEl("option", { value, text: efforts[value] ? this.t(efforts[value]) : value })
      );
      reasoning.value = state.selected;
    };
    const setModels = (available: string[]): void => {
      const selected = model.value || this.homeForm.model || edit?.model || this.plugin.settings.cliModel;
      if (!model.value && selected) {
        model.add(new Option(this.plugin.modelLabel(selected), selected));
        model.value = selected;
      }
      syncModelSelect(model, available, id => this.plugin.modelLabel(id), this.t("coffee.unavailable"));
      model.value = selected;
      setReasoning();
    };
    model.dataset.ctHomeField = "model";
    reasoning.dataset.ctHomeField = "reasoning";
    const modelStatus = advanced.createEl("p", {
      cls: "ct-muted",
      text: this.t("coffee.loading_available_models")
    });
    const retryModels = this.button(advanced, this.t("coffee.retry_model_discovery"), () => {
      void this.plugin.refreshCoffeeModels();
    });
    setModels(this.plugin.availableModels());
    model.disabled = true;
    reasoning.disabled = true;
    this.modelUnsubscribe?.();
    this.modelUnsubscribe = this.plugin.subscribeModelDiscovery(state => {
      if (this.closed || generation !== this.generation) return;
      setModels(this.plugin.availableModels());
      modelStatus.setText(`${state.provider}: ${state.status}${state.error ? ` · ${state.error}` : ""}`);
      retryModels.disabled = state.status === "loading";
      start.disabled = !this.plugin.availableModels().includes(model.value);
    });
    const old = edit?.guests,
      counts: GuestCounts = old?.counts ? { ...old.counts } : defaults();
    const hostRow = advanced.createDiv("ct-host-count");
    hostRow.createEl("label", { text: this.t("coffee.hosts") });
    const hostCount = hostRow.createEl("select", {
      attr: { "aria-label": this.t("coffee.number_of_hosts"), "data-ct-home-field": "hostCount" }
    });
    for (let count = 1; count <= 4; count++)
      hostCount.createEl("option", { value: String(count), text: String(count) });
    hostCount.value = String(this.homeForm.hostCount ?? old?.hostCount ?? 2);
    hostRow.createEl("p", {
      cls: "ct-muted",
      text: this.t("coffee.one_host_can_combine_both_facilitation_styles")
    });
    const hostRisk = hostRow.createEl("p", {
      cls: "ct-risk-warning is-hidden",
      attr: { role: "status" },
      text: this.t("coffee.more_than_two_hosts_may_leave_less_room_for_guests_to")
    });
    const guestSection = advanced.createDiv("ct-guests");
    guestSection.createEl("h4", { text: this.t("coffee.choose_your_guests") });
    const guestIntro = this.t("coffee.each_perspective_adds_a_different_kind_of_question_and");
    guestSection.createEl("p", { cls: "ct-muted", text: guestIntro });
    const countInputs = new Map<GuestCategory, HTMLInputElement>();
    const updateAdvancedSummary = (): void => {
      const selectedModel = model.value ? this.plugin.modelLabel(model.value) : this.t("coffee.select_a_model");
      const guests = [...countInputs.values()].reduce((sum, input) => sum + (Number(input.value) || 0), 0);
      advancedSummary.setText(
        `${this.t("coffee.adjust_this_table")} · ${selectedModel} · ${hostCount.value} ${this.t("coffee.host_count_unit")} + ${guests} ${this.t("coffee.guest_count_unit")}`
      );
    };
    for (const category of CATEGORIES) {
      const row = guestSection.createDiv("ct-count-row");
      const label = row.createEl("label");
      label.createSpan({ text: this.t(category.label) });
      const input = label.createEl("input", {
        attr: {
          type: "number",
          min: "0",
          max: "8",
          step: "1",
          "aria-label": this.t(category.label),
          "data-ct-home-field": `count-${category.id}`
        }
      });
      input.value = this.homeForm[`count-${category.id}`] ?? String(counts[category.id]);
      countInputs.set(category.id, input);
      row.createEl("p", { cls: "ct-muted", text: this.t(category.description) });
    }
    const warning = guestSection.createEl("p", { cls: "ct-risk-warning is-hidden", attr: { role: "status" } });
    const invites = advanced.createDiv("ct-invites");
    invites.createEl("h4", { text: this.t("coffee.guests_you_have_in_mind") });
    const inviteRows: Array<{
      id: string;
      category: HTMLSelectElement;
      description: HTMLInputElement;
      row: HTMLElement;
    }> = [];
    const savedInvites = (() => {
      try {
        return JSON.parse(this.homeForm.invites ?? "[]") as NamedGuest[];
      } catch {
        return [];
      }
    })();
    const addInvite = (guest?: NamedGuest): void => {
      const row = invites.createDiv("ct-invite-row"),
        id = guest?.id ?? crypto.randomUUID();
      const select = row.createEl("select", {
        attr: { "aria-label": this.t("coffee.guest_category"), "data-ct-home-field": `invite-category-${id}` }
      });
      CATEGORIES.forEach(item => select.createEl("option", { value: item.id, text: this.t(item.label) }));
      const description = row.createEl("input", {
        attr: {
          type: "text",
          maxlength: "160",
          placeholder: this.t("coffee.name_or_background_e_g_a_frontline_support_worker"),
          "aria-label": this.t("coffee.guest_name_or_background"),
          "data-ct-home-field": `invite-description-${id}`
        }
      });
      if (guest) {
        select.value = guest.category;
        description.value = guest.description;
      }
      const remove = this.button(row, this.t("ui.reference_remove"), () => {
        row.remove();
        const rowIndex = inviteRows.findIndex(item => item.row === row);
        if (rowIndex >= 0) inviteRows.splice(rowIndex, 1);
        updateWarning();
        snapshotForm();
      });
      inviteRows.push({ id, category: select, description, row });
      select.addEventListener("change", () => {
        updateWarning();
        snapshotForm();
      });
      description.addEventListener("input", () => {
        updateWarning();
        snapshotForm();
      });
      void remove;
    };
    if (this.homeForm.invites !== undefined) savedInvites.forEach(guest => addInvite(guest));
    else if (old?.guests?.length) old.guests.forEach(guest => addInvite(guest));
    else savedInvites.forEach(guest => addInvite(guest));
    this.button(invites, this.t("coffee.add_a_guest"), () => {
      addInvite();
      snapshotForm();
    });
    const styleSection = advanced.createDiv("ct-style-settings");
    styleSection.createEl("h4", { text: this.t("coffee.customize_the_conversation") });
    const styleFields = styleSection.createDiv("ct-style-fields");
    const styleChoiceLabel = styleFields.createEl("label", { text: this.t("coffee.conversation_style") });
    const styleSelect = styleChoiceLabel.createEl("select", {
      attr: { "aria-label": this.t("coffee.choose_a_conversation_style"), "data-ct-home-field": "styleId" }
    });
    const builtinId = "builtin";
    const styles = this.plugin.settings.coffeeStyles ?? [];
    const selectedStyleId =
      this.homeForm.styleId ??
      old?.styleId ??
      (this.plugin.settings.defaultCoffeeStyleId &&
      styles.some(item => item.id === this.plugin.settings.defaultCoffeeStyleId)
        ? this.plugin.settings.defaultCoffeeStyleId
        : builtinId);
    const selectedStyle = styles.find(item => item.id === selectedStyleId);
    const initialStylePrompt =
      this.homeForm.stylePrompt ??
      old?.stylePrompt ??
      (old?.customPrompt
        ? `${builtinCoffeeStyle(this.plugin.settings.language)}\n\n${old.customPrompt}`
        : (selectedStyle?.prompt ?? builtinCoffeeStyle(this.plugin.settings.language)));
    const styleNameLabel = styleFields.createEl("label", { text: this.t("coffee.style_name") });
    const styleNameInput = styleNameLabel.createEl("input", {
      attr: {
        type: "text",
        placeholder: this.t("coffee.style_name"),
        "aria-label": this.t("coffee.style_name"),
        "data-ct-home-field": "styleName"
      }
    });
    styleNameInput.value =
      this.homeForm.styleName ?? old?.styleName ?? selectedStyle?.name ?? BUILTIN_COFFEE_STYLE_NAME;
    const stylePromptLabel = styleSection.createEl("label", {
      cls: "ct-style-prompt-label",
      text: this.t("coffee.how_to_chat")
    });
    const stylePrompt = stylePromptLabel.createEl("textarea", {
      attr: {
        rows: "12",
        maxlength: "30000",
        "aria-label": this.t("coffee.full_conversation_instructions"),
        "data-ct-home-field": "stylePrompt"
      }
    });
    stylePrompt.value = cleanChatStyle(initialStylePrompt);
    styleSection.createEl("p", {
      cls: "ct-muted",
      text: this.t("coffee.choose_how_people_speak_and_interact_you_can_freely")
    });
    const initialCustomization = (() => {
      try {
        if (this.homeForm.customization) return JSON.parse(this.homeForm.customization) as unknown;
      } catch {
        /* Use saved settings. */
      }
      return old?.customization ?? selectedStyle?.customization ?? defaultCustomization(this.plugin.settings.language);
    })();
    const customization = customizationFields(styleSection, initialCustomization, this.plugin.settings.language, () =>
      snapshotForm()
    );
    const styleActions = styleSection.createDiv("ct-style-actions");
    this.button(styleActions, this.t("coffee.preview_opening_prompt"), () => {
      try {
        const previewSettings: GuestSettings = {
          counts: Object.fromEntries(
            [...countInputs].map(([key, input]) => [key, Number(input.value) || 0])
          ) as GuestCounts,
          guests: inviteRows
            .map(item => ({
              id: item.id,
              category: item.category.value as GuestCategory,
              description: item.description.value.trim()
            }))
            .filter(item => item.description),
          background: "",
          customPrompt: "",
          hostCount: Number(hostCount.value),
          stylePrompt: stylePrompt.value,
          customization: customization.read(),
          referenceFiles: referenceFiles.map(item => ({ ...item }))
        };
        const prompt = openingPromptPreview(topic.value, this.plugin.settings.language, previewSettings);
        new CoffeePromptPreviewModal(
          this.app,
          prompt,
          this.plugin.settings.language,
          tablePrompt(topic.value, this.plugin.settings.language, previewSettings)
        ).open();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error));
      }
    });
    const refreshStyleChoices = (selected: string): void => {
      styleSelect.empty();
      styleSelect.createEl("option", {
        value: builtinId,
        text: `${BUILTIN_COFFEE_STYLE_NAME} · ${this.t("coffee.built_in")}`
      });
      for (const item of this.plugin.settings.coffeeStyles ?? [])
        styleSelect.createEl("option", { value: item.id, text: item.name });
      styleSelect.value = selected;
    };
    refreshStyleChoices(selectedStyleId);
    const snapshotForm = (): void => {
      this.homeForm = {
        ...this.homeForm,
        topic: topic.value,
        model: model.value,
        reasoning: reasoning.value,
        styleId: styleSelect.value,
        styleName: styleNameInput.value,
        stylePrompt: stylePrompt.value,
        customization: JSON.stringify(customization.read()),
        refs: JSON.stringify(referenceFiles),
        hostCount: hostCount.value,
        ...Object.fromEntries([...countInputs].map(([key, input]) => [`count-${key}`, input.value])),
        invites: JSON.stringify(
          inviteRows.map(item => ({ id: item.id, category: item.category.value, description: item.description.value }))
        )
      };
    };
    const referenceFiles: CoffeeReference[] = (() => {
      try {
        const stored: unknown = JSON.parse(this.homeForm.refs ?? "");
        if (Array.isArray(stored)) return (stored as unknown[]).filter(isCoffeeReference);
      } catch {
        /* Use this table's saved files below. */
      }
      return old?.referenceFiles?.map(item => ({ ...item })) ?? [];
    })();
    const refsSection = advanced.createDiv("ct-reference-files");
    refsSection.createEl("h4", { text: this.t("coffee.background_reference_files") });
    refsSection.createEl("p", {
      cls: "ct-muted",
      text: this.t("coffee.add_plain_text_txt_or_md_files_their_contents_are_saved")
    });
    const fileInput = refsSection.createEl("input", {
      attr: {
        type: "file",
        multiple: "true",
        accept: ".txt,.md,text/plain,text/markdown",
        "aria-label": this.t("coffee.choose_reference_files")
      }
    });
    const referenceList = refsSection.createDiv("ct-reference-list");
    const renderReferences = (): void => {
      referenceList.empty();
      for (const [index, file] of referenceFiles.entries()) {
        const row = referenceList.createDiv("ct-reference-row");
        row.createSpan({
          text: `${file.name} · ${file.content.length.toLocaleString()} ${this.t("coffee.characters")}`
        });
        this.button(row, this.t("ui.reference_remove"), () => {
          referenceFiles.splice(index, 1);
          renderReferences();
          snapshotForm();
        });
      }
    };
    renderReferences();
    fileInput.addEventListener("change", () => {
      void (async () => {
        const selected = Array.from(fileInput.files ?? []);
        for (const file of selected) {
          if (!/\.(txt|md)$/i.test(file.name)) throw new Error(this.t("coffee.unsupported_reference_file", file.name));
          const content = await file.text();
          if (!content.trim()) throw new Error(this.t("coffee.the_reference_file_is_empty", file.name));
          referenceFiles.push({ name: file.name, content });
        }
        renderReferences();
        snapshotForm();
        fileInput.value = "";
      })().catch(error => {
        fileInput.value = "";
        new Notice(error instanceof Error ? error.message : String(error));
      });
    });
    styleSelect.addEventListener("change", () => {
      const item = this.plugin.settings.coffeeStyles?.find(style => style.id === styleSelect.value);
      stylePrompt.value = cleanChatStyle(item?.prompt ?? builtinCoffeeStyle(this.plugin.settings.language));
      styleNameInput.value = item?.name ?? BUILTIN_COFFEE_STYLE_NAME;
      customization.set(item?.customization);
      snapshotForm();
    });
    stylePrompt.addEventListener("input", snapshotForm);
    styleNameInput.addEventListener("input", snapshotForm);
    this.button(styleActions, this.t("coffee.save_as_new_style"), async () => {
      const issues = validateCustomization(customization.read(), this.plugin.settings.language);
      if (issues.length) throw new Error(issues.join("\n"));
      const name = styleNameInput.value.trim();
      if (!name || !stylePrompt.value.trim()) throw new Error(this.t("coffee.enter_a_style_name_and_prompt_first"));
      const item = { id: crypto.randomUUID(), name, prompt: stylePrompt.value, customization: customization.read() };
      await this.changeCoffeeStyles(() => {
        this.plugin.settings.coffeeStyles = [...(this.plugin.settings.coffeeStyles ?? []), item];
      });
      refreshStyleChoices(item.id);
      snapshotForm();
      new Notice(this.t("coffee.style_saved"));
    });
    this.button(styleActions, this.t("coffee.update_selected_style"), async () => {
      const item = this.plugin.settings.coffeeStyles?.find(style => style.id === styleSelect.value);
      if (!item) throw new Error(this.t("coffee.the_built_in_style_cannot_be_overwritten_save_it_as_a"));
      if (!styleNameInput.value.trim() || !stylePrompt.value.trim())
        throw new Error(this.t("coffee.enter_a_style_name_and_prompt_first"));
      const issues = validateCustomization(customization.read(), this.plugin.settings.language);
      if (issues.length) throw new Error(issues.join("\n"));
      await this.changeCoffeeStyles(() => {
        this.plugin.settings.coffeeStyles = (this.plugin.settings.coffeeStyles ?? []).map(style =>
          style.id === item.id
            ? {
                ...style,
                name: styleNameInput.value.trim(),
                prompt: stylePrompt.value,
                customization: customization.read()
              }
            : style
        );
      });
      refreshStyleChoices(item.id);
      snapshotForm();
      new Notice(this.t("coffee.style_updated"));
    });
    this.button(styleActions, this.t("coffee.rename"), async () => {
      const item = this.plugin.settings.coffeeStyles?.find(style => style.id === styleSelect.value);
      if (!item) throw new Error(this.t("coffee.choose_a_saved_style_first"));
      const name = await new CoffeeStyleNameModal(this.app, item.name, this.plugin.settings.language).ask();
      if (!name) return;
      await this.changeCoffeeStyles(() => {
        this.plugin.settings.coffeeStyles = (this.plugin.settings.coffeeStyles ?? []).map(style =>
          style.id === item.id ? { ...style, name } : style
        );
      });
      styleNameInput.value = name;
      refreshStyleChoices(item.id);
      snapshotForm();
    });
    this.button(styleActions, this.t("coffee.delete_style"), async () => {
      const items = this.plugin.settings.coffeeStyles ?? [],
        index = items.findIndex(style => style.id === styleSelect.value);
      if (index < 0) throw new Error(this.t("coffee.choose_a_saved_style_first"));
      await this.changeCoffeeStyles(() => {
        this.plugin.settings.coffeeStyles = items.filter((_, at) => at !== index);
        if (this.plugin.settings.defaultCoffeeStyleId === items[index].id)
          this.plugin.settings.defaultCoffeeStyleId = undefined;
      });
      refreshStyleChoices(builtinId);
      stylePrompt.value = cleanChatStyle(builtinCoffeeStyle(this.plugin.settings.language));
      styleNameInput.value = BUILTIN_COFFEE_STYLE_NAME;
      customization.set(defaultCustomization(this.plugin.settings.language));
      snapshotForm();
    });
    this.button(styleActions, this.t("coffee.default_for_new_tables"), async () => {
      await this.saveCoffeeDefault(stylePrompt.value, customization.read());
      refreshStyleChoices("customization-default");
      snapshotForm();
      new Notice(this.t("coffee.saved_for_new_tables_existing_tables_keep_their_settings"));
    });
    this.button(styleActions, this.t("coffee.restore_built_in_text"), () => {
      styleSelect.value = builtinId;
      styleNameInput.value = BUILTIN_COFFEE_STYLE_NAME;
      stylePrompt.value = cleanChatStyle(builtinCoffeeStyle(this.plugin.settings.language));
      snapshotForm();
    });

    const updateWarning = (): void => {
      const current = Object.fromEntries(
        [...countInputs].map(([key, input]) => [key, Number(input.value)])
      ) as GuestCounts;
      const assigned = Object.fromEntries(
        CATEGORIES.map(item => [
          item.id,
          inviteRows.filter(guest => guest.category.value === item.id && guest.description.value.trim()).length
        ])
      ) as GuestCounts;
      const overflow = CATEGORIES.filter(item => assigned[item.id] > current[item.id]);
      const n = total(current);
      warning.toggleClass("is-hidden", !(n > 7 || n < 1 || n > 12 || overflow.length));
      warning.setText(
        overflow.length
          ? this.t(
              "coffee.more_named_guests_than_places",
              overflow.map(item => this.t(item.label)).join(this.t("coffee.list_separator"))
            )
          : n < 1 || n > 12
            ? this.t("coffee.choose_1_12_guests_in_total")
            : n > 7
              ? this.t("coffee.more_guests_can_mean_more_waiting_and_less_room_for")
              : ""
      );
    };
    countInputs.forEach(input =>
      input.addEventListener("input", () => {
        updateWarning();
        updateAdvancedSummary();
        snapshotForm();
      })
    );
    updateWarning();
    updateAdvancedSummary();
    topic.addEventListener("input", () => {
      this.homeForm.topicEdited = "true";
      snapshotForm();
    });
    model.addEventListener("change", () => {
      setReasoning();
      updateAdvancedSummary();
      snapshotForm();
    });
    reasoning.addEventListener("change", snapshotForm);
    hostCount.addEventListener("change", () => {
      hostRisk.toggleClass("is-hidden", Number(hostCount.value) <= 2);
      updateAdvancedSummary();
      snapshotForm();
    });
    hostRisk.toggleClass("is-hidden", Number(hostCount.value) <= 2);
    snapshotForm();
    const start = this.button(
      setup,
      edit ? this.t("coffee.open_a_new_table_with_these_settings") : this.t("coffee.open_table"),
      async () => {
        const issues = validateCustomization(customization.read(), this.plugin.settings.language);
        if (issues.length) throw new Error(issues.join("\n"));
        const finalCounts = Object.fromEntries(
          [...countInputs].map(([key, input]) => [key, Number(input.value)])
        ) as GuestCounts;
        const finalTotal = total(finalCounts);
        const guests: NamedGuest[] = inviteRows
          .filter(item => item.description.value.trim())
          .map(item => ({
            id: crypto.randomUUID(),
            category: item.category.value as GuestCategory,
            description: item.description.value.trim()
          }));
        const over = CATEGORIES.some(
          item => guests.filter(guest => guest.category === item.id).length > finalCounts[item.id]
        );
        if (
          !topic.value.trim() ||
          !model.value ||
          finalTotal < 1 ||
          finalTotal > 12 ||
          Object.values(finalCounts).some(value => !Number.isInteger(value) || value < 0 || value > 8) ||
          over
        ) {
          warning.removeClass("is-hidden");
          topic.focus();
          return;
        }
        start.disabled = true;
        try {
          await this.plugin.confirmAiUsage(model.value, async () => {
            if (this.closed || generation !== this.generation) return;
            const settings: GuestSettings = {
              counts: finalCounts,
              guests,
              background: "",
              customPrompt: "",
              styleId: styleSelect.value === builtinId ? undefined : styleSelect.value,
              styleName: styleNameInput.value.trim(),
              stylePrompt: stylePrompt.value,
              customization: customization.read(),
              referenceFiles: referenceFiles.map(item => ({ ...item })),
              hostCount: Number(hostCount.value)
            };
            const session = createSession(
              topic.value,
              model.value,
              reasoning.value,
              this.plugin.settings.language,
              settings
            );
            await this.store.save(session);
            if (this.closed || generation !== this.generation) return;
            this.homeForm = {};
            this.homeEdit = null;
            this.attach(session);
            void this.engine?.start();
          });
        } finally {
          if (!this.closed && generation === this.generation) start.disabled = false;
        }
      }
    );
    start.addClass("mod-cta");
    start.disabled = true;
    const modelLoad = this.plugin.refreshCoffeeModels();
    void modelLoad
      .then(available => {
        if (this.closed || generation !== this.generation) return;
        setModels(available);
        updateAdvancedSummary();
        modelStatus.setText(
          modelDiscoverySummary(this.plugin.modelDiscoveryState("codex"), this.plugin.modelDiscoveryState("claude"))
        );
        model.disabled = false;
        reasoning.disabled = false;
        start.disabled = !available.includes(model.value);
      })
      .catch(() => {
        if (!this.closed && generation === this.generation)
          modelStatus.setText(this.t("coffee.could_not_load_models_check_provider_setup_and_try_again"));
      });
    const samples = home.createDiv("ct-home-section");
    samples.createEl("h3", { text: this.t("coffee.see_a_sample_conversation") });
    for (const sample of [COFFEE_SAMPLE_ZH, COFFEE_SAMPLE_EN])
      this.button(samples, this.t(sample.labelKey), async () => this.openSample(sample.language)).addClass(
        "ct-session-link"
      );
    const preview = home.createDiv("ct-preview is-hidden");
    const aside = shell.createDiv("ct-home-sidebar");
    const searchRow = aside.createDiv("ct-list-search");
    const searchIcon = searchRow.createSpan({ cls: "ct-search-icon", attr: { "aria-hidden": "true" } });
    setIcon(searchIcon, "search");
    const search = searchRow.createEl("input", {
      attr: {
        type: "search",
        placeholder: this.t("coffee.search_topics"),
        "aria-label": this.t("coffee.search_topics"),
        "data-ct-home-field": "search"
      }
    });
    search.value = this.homeQuery;
    const clear = this.button(searchRow, this.t("ui.clear"), () => {
      search.value = "";
      this.homeQuery = "";
      void renderList();
    });
    clear.addClass("ct-search-clear");
    search.addEventListener("input", () => {
      this.homeQuery = search.value;
      void renderList();
    });
    const filterBar = aside.createDiv("ct-list-filters"),
      filterButtons = new Map<TableListFilter, HTMLButtonElement>();
    const filterLabels: Record<TableListFilter, TranslationKey> = {
      all: "coffee.filter_all",
      generating: "coffee.filter_generating",
      unfinished: "coffee.filter_unfinished",
      completed: "coffee.filter_completed"
    };
    for (const filter of ["all", "generating", "unfinished", "completed"] as const) {
      const button = this.button(filterBar, this.t(filterLabels[filter]), () => {
        this.tableFilter = filter;
        this.focusedTopic = null;
        updateFilters();
        void renderList();
      });
      button.setAttribute("aria-pressed", String(this.tableFilter === filter));
      filterButtons.set(filter, button);
    }
    const topicFocusRow = aside.createDiv("ct-topic-focus is-hidden");
    const topicFocusText = topicFocusRow.createSpan();
    this.button(topicFocusRow, this.t("coffee.show_all_tables"), () => {
      this.focusedTopic = null;
      updateFilters();
      void renderList();
    });
    const updateFilters = (): void => {
      for (const [filter, button] of filterButtons) {
        button.toggleClass("is-active", this.tableFilter === filter && !this.focusedTopic);
        button.setAttribute("aria-pressed", String(this.tableFilter === filter && !this.focusedTopic));
      }
      topicFocusRow.toggleClass("is-hidden", !this.focusedTopic);
      if (this.focusedTopic) topicFocusText.setText(this.t("coffee.same_topic", this.focusedTopic));
    };

    const archiveToggle = this.button(
      aside,
      this.showArchivedTables ? this.t("coffee.show_active_tables") : this.t("coffee.show_archived_tables"),
      () => {
        this.showArchivedTables = !this.showArchivedTables;
        this.selectedPath = "";
        this.previewVisible = false;
        void this.home();
      }
    );
    archiveToggle.addClass("ct-archive-toggle");
    const selectedTables = new Map<string, TableListItem>();
    let visibleTables: TableListItem[] = [],
      deletingTables = false;
    const selectionBar = aside.createDiv("ct-list-selection");
    const selectionCount = selectionBar.createSpan({ attr: { "aria-live": "polite" } });
    const selectAll = this.button(selectionBar, this.t("coffee.select_all_shown"), () => {
      for (const item of visibleTables) if (!item.unreadable) selectedTables.set(item.path, item);
      void renderList();
    });
    const clearSelection = this.button(selectionBar, this.t("coffee.clear_selection"), () => {
      selectedTables.clear();
      void renderList();
    });
    const deleteSelected = this.button(selectionBar, this.t("coffee.delete_selected"), async () => {
      if (deletingTables || !selectedTables.size) return;
      const targets = [...selectedTables.values()];
      deletingTables = true;
      updateSelection();
      try {
        const topics = this.t("coffee.tables_count_list", targets.length, targets.map(item => item.topic).join("\n"));
        if (!(await new CoffeeDeleteModal(this.app, topics, this.plugin.settings.language).confirm())) return;
        let removed = 0;
        const failures: string[] = [];
        for (const item of targets) {
          const manager = this.plugin.coffeeManager;
          let engine: CoffeeEngine | undefined;
          try {
            const inspected = await this.store.inspectReadOnly(item.path);
            if (inspected.id !== item.id) throw new Error(this.t("coffee.this_table_changed_reload_and_try_again"));
            engine = await manager?.prepareDelete(item.id);
            await this.store.delete(item.id, item.path);
            manager?.completeDelete(item.id, engine);
            selectedTables.delete(item.path);
            removed++;
            if (this.selectedPath === item.path) {
              this.selectedPath = "";
              this.previewVisible = false;
              preview.addClass("is-hidden");
              setup.removeClass("is-hidden");
              samples.removeClass("is-hidden");
            }
          } catch (error) {
            manager?.cancelDelete(item.id, engine);
            failures.push(`${item.topic}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        new Notice(this.t("coffee.deleted_tables", removed));
        if (failures.length) new Notice(this.t("coffee.could_not_delete", failures.join("\n")), 10000);
        this.app.workspace.requestSaveLayout();
      } finally {
        deletingTables = false;
        if (!this.closed) await renderList();
      }
    });
    const archiveSelected = this.button(
      selectionBar,
      this.showArchivedTables ? this.t("coffee.unarchive_selected") : this.t("coffee.archive_selected"),
      async () => {
        if (deletingTables || !selectedTables.size) return;
        deletingTables = true;
        updateSelection();
        const targets = [...selectedTables.values()],
          failures: string[] = [];
        let moved = 0;
        try {
          for (const item of targets) {
            try {
              const inspected = await this.store.inspectReadOnly(item.path);
              if (inspected.id !== item.id) throw new Error(this.t("coffee.this_table_changed_reload_first"));
              if (this.plugin.coffeeManager?.get(item.id)?.busy || inspected.status === "generating")
                throw new Error(this.t("coffee.stop_generation_before_archiving"));
              const manager = this.plugin.coffeeManager;
              const held = await manager?.prepareDelete(item.id);
              try {
                await this.store.setArchived(item.path, !this.showArchivedTables);
              } finally {
                manager?.cancelDelete(item.id, held);
              }
              selectedTables.delete(item.path);
              moved++;
              if (this.selectedPath === item.path) {
                this.selectedPath = "";
                this.previewVisible = false;
                preview.addClass("is-hidden");
                setup.removeClass("is-hidden");
                samples.removeClass("is-hidden");
              }
            } catch (error) {
              failures.push(`${item.topic}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          new Notice(
            this.showArchivedTables
              ? this.t("coffee.unarchived_tables_count", moved)
              : this.t("coffee.archived_tables_count", moved)
          );
          if (failures.length) new Notice(failures.join("\n"), 10000);
          this.app.workspace.requestSaveLayout();
        } finally {
          deletingTables = false;
          if (!this.closed) await renderList();
        }
      }
    );
    deleteSelected.addClass("mod-warning");
    const updateSelection = (): void => {
      selectionCount.setText(this.t("coffee.selected_count", selectedTables.size));
      selectAll.disabled = deletingTables || !visibleTables.some(item => !item.unreadable);
      clearSelection.disabled = deletingTables || !selectedTables.size;
      deleteSelected.disabled = deletingTables || !selectedTables.size;
      archiveSelected.disabled = deletingTables || !selectedTables.size;
      archiveToggle.disabled = deletingTables;
      for (const input of Array.from(list.querySelectorAll<HTMLInputElement>(".ct-table-checkbox")))
        input.disabled = deletingTables || input.dataset.unreadable === "true";
    };
    const listScroller = aside.createDiv("ct-list-scroll");
    const list = listScroller.createDiv("ct-list-content");
    listScroller.scrollTop = this.homeListScrollTop;
    listScroller.addEventListener("scroll", () => (this.homeListScrollTop = listScroller.scrollTop));
    const deleteTable = async (session: CoffeeSession, path?: string): Promise<void> => {
      if (!(await new CoffeeDeleteModal(this.app, session.topic, this.plugin.settings.language).confirm())) return;
      const manager = this.plugin.coffeeManager;
      let engine: CoffeeEngine | undefined;
      try {
        engine = await manager?.prepareDelete(session.id);
        await this.store.delete(session.id, path);
        manager?.completeDelete(session.id, engine);
        if (this.closed) return;
        this.selectedPath = "";
        this.suppressStateRestore = true;
        await this.home();
        this.app.workspace.requestSaveLayout();
      } catch (error) {
        manager?.cancelDelete(session.id, engine);
        throw error;
      }
    };
    const openMarkdown = async (id: string): Promise<void> => {
      const file = await this.store.openMarkdown(id);
      await this.app.workspace.getLeaf(false).openFile(file);
    };
    const openNewTable = (): void => {
      this.navigationGeneration++;
      this.homeGeneration++;
      this.suppressStateRestore = true;
      this.previewVisible = false;
      this.selectedPath = "";
      preview.addClass("is-hidden");
      setup.removeClass("is-hidden");
      samples.removeClass("is-hidden");
      this.app.workspace.requestSaveLayout();
    };
    const showPreview = async (path: string): Promise<void> => {
      const token = ++this.navigationGeneration;
      this.homeGeneration++;
      this.homePane = "main";
      shell.dataset.pane = "main";
      this.selectedPath = path;
      this.previewVisible = true;
      preview.empty();
      preview.removeClass("is-hidden");
      setup.addClass("is-hidden");
      samples.addClass("is-hidden");
      const toolbar = preview.createDiv("ct-preview-toolbar");
      const body = preview.createDiv("ct-preview-body");
      this.button(toolbar, this.t("coffee.enter_this_table"), () => {
        this.suppressStateRestore = true;
        void this.loadSession(path, true);
      }).addClass("mod-cta");
      this.button(toolbar, this.t("coffee.open_markdown"), () => openMarkdown(path));
      this.button(toolbar, this.t("coffee.delete_table"), async () => {
        const inspected = await this.store.inspectReadOnly(path),
          session = inspected.version === 3 ? inspected : copyLegacySession(inspected);
        await deleteTable(session, path);
      });
      this.button(toolbar, this.t("coffee.open_new_table"), openNewTable);
      body.createEl("p", { cls: "ct-muted", text: this.t("coffee.loading_saved_notes") });
      try {
        const inspected = await this.store.inspectReadOnly(path);
        let session: CoffeeSession =
          inspected.version === 1
            ? { ...copyLegacySession(inspected), createdAt: inspected.createdAt, updatedAt: inspected.updatedAt }
            : inspected;
        const active = this.plugin.coffeeManager?.get(session.id);
        if (active) session = active.session;
        if (this.closed || token !== this.navigationGeneration) return;
        body.empty();
        body.createEl("h2", { text: session.topic });
        body.createEl("p", {
          cls: "ct-muted",
          text: `${this.t("coffee.latest_update")} · ${new Date(session.lastCompletedAt || session.updatedAt || session.createdAt).toLocaleString()}`
        });
        if (session.dirtyNotes)
          body.createEl("p", {
            cls: "ct-warning",
            text: this.t("coffee.these_notes_predate_later_conversation_changes")
          });
        const notes = session.observerNotes?.[0] ?? session.rounds?.find(round => round.notes)?.notes ?? "";
        if (notes)
          void MarkdownRenderer.render(
            this.app,
            notes,
            body.createDiv("ct-preview-notes markdown-rendered"),
            path,
            this
          );
        else
          body.createEl("p", {
            cls: "ct-muted",
            text: this.t("coffee.no_observer_notes_yet_you_can_still_enter_this_table")
          });
      } catch (error) {
        if (this.closed || token !== this.navigationGeneration) return;
        body.empty();
        body.createEl("p", {
          cls: "ct-error",
          text: this.t("coffee.preview_unavailable", error instanceof Error ? error.message : String(error))
        });
      }
    };
    const renderList = async (): Promise<void> => {
      if (deletingTables) return;
      const token = ++this.listGeneration,
        oldTop = listScroller.scrollTop,
        entries: TableListItem[] = [];
      for (const file of this.store.list(this.showArchivedTables).filter(item => item.extension === "md")) {
        try {
          const inspected = await this.store.inspectReadOnly(file.path);
          let session: CoffeeSession =
            inspected.version === 1
              ? { ...copyLegacySession(inspected), createdAt: inspected.createdAt, updatedAt: inspected.updatedAt }
              : inspected;
          const active = this.plugin.coffeeManager?.get(session.id);
          if (active) session = active.session;
          entries.push({
            id: inspected.id,
            path: file.path,
            topic: session.topic,
            status: effectiveTableStatus(session, active?.busy),
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            lastGenerationStartedAt: session.lastGenerationStartedAt,
            lastCompletedAt: session.lastCompletedAt,
            model: session.model
          });
        } catch {
          entries.push({
            id: `unreadable:${file.path}`,
            path: file.path,
            topic: file.basename,
            status: "error",
            createdAt: new Date(file.stat.ctime).toISOString(),
            updatedAt: new Date(file.stat.mtime).toISOString(),
            model: "",
            unreadable: true
          });
        }
        if (this.closed || token !== this.listGeneration) return;
      }
      if (this.closed || token !== this.listGeneration) return;
      list.empty();
      updateFilters();
      const visible = selectTables(entries, this.homeQuery, this.tableFilter, this.focusedTopic);
      list.createEl("h3", { cls: "ct-list-heading", text: `${this.t("coffee.tables_heading")} (${visible.length})` });
      visibleTables = visible;
      const visiblePaths = new Set(visible.filter(item => !item.unreadable).map(item => item.path));
      for (const path of selectedTables.keys()) if (!visiblePaths.has(path)) selectedTables.delete(path);
      updateSelection();
      for (const item of visible) {
        const time = tableTime(item),
          timestamp = new Date(time.value),
          status =
            item.status === "generating"
              ? this.t("coffee.generating")
              : item.status === "completed"
                ? this.t("coffee.complete")
                : item.status === "error"
                  ? this.t("coffee.interrupted")
                  : this.t("coffee.draft");
        const entry = list.createDiv("ct-list-entry"),
          button = this.button(entry, "", () => {
            if (item.status === "generating") void this.loadSession(item.path);
            else void showPreview(item.path);
          });
        const checkbox = entry.createEl("input", {
          cls: "ct-table-checkbox",
          attr: { type: "checkbox", "aria-label": this.t("coffee.select_table", item.topic) }
        });
        checkbox.checked = selectedTables.has(item.path);
        checkbox.disabled = !!item.unreadable;
        checkbox.dataset.unreadable = String(!!item.unreadable);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selectedTables.set(item.path, item);
          else selectedTables.delete(item.path);
          updateSelection();
        });
        button.empty();
        button.addClass("ct-list-item");
        button.createSpan({ cls: "ct-list-title", text: item.topic });
        const meta = button.createDiv("ct-list-meta");
        meta.createSpan({ text: formatTableTime(time.value, Date.now(), this.plugin.settings.language) });
        const badge = meta.createSpan({ cls: `ct-status-badge ct-status-${item.status}`, text: status });
        badge.setAttribute("aria-label", status);
        if (time.isFallback) meta.createSpan({ cls: "ct-list-fallback", text: this.t("coffee.last_updated") });
        if (item.unreadable) {
          button.addClass("ct-list-unreadable");
          button.disabled = true;
        }
        if (this.selectedPath === item.path) button.addClass("is-selected");
        button.setAttribute("aria-current", this.selectedPath === item.path ? "true" : "false");
        if (Number.isFinite(timestamp.getTime()))
          button.setAttribute(
            "title",
            `${item.topic}\n${timestamp.toLocaleString()}${item.model ? ` · ${item.model}` : ""}`
          );
        const sameCount = topicTableCount(item.topic, entries);
        if (!item.unreadable && sameCount > 1) {
          const same = entry.createEl("button", {
            cls: "ct-same-topic-link",
            text: this.t("coffee.same_topic_tables", sameCount)
          });
          same.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            this.focusedTopic = item.topic.trim();
            this.tableFilter = "all";
            this.homeQuery = "";
            search.value = "";
            updateFilters();
            void renderList();
          });
        }
      }
      if (!visible.length)
        list.createEl("p", {
          cls: "ct-muted",
          text:
            this.homeQuery || this.focusedTopic
              ? this.t("coffee.no_matching_tables")
              : this.t("coffee.your_tables_will_appear_here")
        });
      listScroller.scrollTop = oldTop;
    };
    void this.store
      .cleanupEmptyTopicFolders()
      .catch(() => undefined)
      .then(() => renderList());
    if (this.statusTimer !== null && typeof window.clearInterval === "function") window.clearInterval(this.statusTimer);
    this.statusTimer =
      typeof window.setInterval === "function"
        ? window.setInterval(() => {
            const focused = this.contentEl.ownerDocument.activeElement;
            if (
              !this.closed &&
              this.contentEl.querySelector(".ct-home-sidebar") &&
              !focused?.closest(".ct-list-entry, .ct-list-filters, .ct-list-search")
            )
              void renderList();
          }, 3000)
        : null;
    if (this.previewVisible && this.selectedPath) void showPreview(this.selectedPath);
  }
  private async changeCoffeeStyles(change: () => void): Promise<void> {
    if (this.savingCoffeeStyles) throw new Error(this.t("coffee.settings_are_being_saved_try_again_shortly"));
    const previousStyles = this.plugin.settings.coffeeStyles,
      previousId = this.plugin.settings.defaultCoffeeStyleId;
    this.savingCoffeeStyles = true;
    try {
      change();
      await this.plugin.saveSettings();
    } catch (error) {
      this.plugin.settings.coffeeStyles = previousStyles;
      this.plugin.settings.defaultCoffeeStyleId = previousId;
      throw error;
    } finally {
      this.savingCoffeeStyles = false;
    }
  }
  private async saveCoffeeDefault(style: string, customization: CoffeeCustomization): Promise<void> {
    const issues = validateCustomization(customization, this.plugin.settings.language);
    if (issues.length) throw new Error(issues.join("\n"));
    if (style.length > 30000) throw new Error(this.t("coffee.chat_instructions_must_be_30_000_characters_or_fewer"));
    const id = "customization-default";
    await this.changeCoffeeStyles(() => {
      this.plugin.settings.coffeeStyles = [
        ...(this.plugin.settings.coffeeStyles ?? []).filter(item => item.id !== id),
        { id, name: this.t("coffee.my_conversation_defaults"), prompt: style, customization }
      ];
      this.plugin.settings.defaultCoffeeStyleId = id;
    });
  }
  private async openSample(language: NoteLanguage): Promise<void> {
    const sample = [COFFEE_SAMPLE_ZH, COFFEE_SAMPLE_EN].find(item => item.language === language) ?? COFFEE_SAMPLE_EN,
      now = new Date().toISOString();
    const roles = new Map(parseGuests(sample.markdown).map(person => [person.name, person.role]));
    const markdown = sample.markdown.replace(
      /^###\s+([^\n|｜]+)$/gm,
      (heading, name: string) => `### ${name}｜${roles.get(name.trim()) ?? "Guest"}`
    );
    const session = createSession(sample.topic, "Built-in sample", "—", language);
    session.id = `sample-${coffeeInstruction(language)}`;
    session.createdAt = now;
    session.updatedAt = now;
    session.status = "completed";
    session.transcriptMarkdown = markdown;
    session.rounds = [
      { id: "sample-round", markdown, notes: observerNotes(markdown), status: "completed", createdAt: now }
    ];
    session.observerNotes = [observerNotes(markdown)];
    session.questions = [
      {
        id: `sample-question-${coffeeInstruction(language)}`,
        question: sample.question,
        answer: sample.answer,
        status: "complete",
        createdAt: now
      }
    ];
    this.attach(session);
  }
  private async loadSession(path: string, startAtTop = false): Promise<void> {
    const generation = ++this.navigationGeneration;
    this.generation++;
    this.unsubscribe?.();
    let stored: AnyCoffeeSession;
    try {
      stored = await this.store.load(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/changed outside|外部修改|outside this room/i.test(message)) {
        const latest = await this.store.inspect(path).catch(() => null);
        if (this.closed || generation !== this.navigationGeneration) return;
        if (latest && latest.version === 3) {
          const cached = this.plugin.coffeeManager?.get(latest.id);
          if (cached) {
            if (cached.busy) await cached.stop();
            if (this.closed || generation !== this.navigationGeneration) return;
            this.attach(cached.session);
            cached.reportPersistenceError(new Error(message));
            return;
          }
        }
      }
      throw error;
    }
    if (this.closed || generation !== this.navigationGeneration) return;
    if (stored.version === 1) {
      this.attachLegacy(stored);
      return;
    }
    this.attach(stored, startAtTop);
  }
  private attachLegacy(legacy: Extract<AnyCoffeeSession, { version: 1 }>): void {
    this.navigationGeneration++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.engine = null;
    const transcript = copyLegacySession(legacy).transcriptMarkdown;
    this.legacyNavigation = {
      sessionId: legacy.id,
      topic: legacy.topic,
      readOnly: true,
      segments: [{ id: "legacy", kind: "legacy", status: "completed", text: transcript, createdAt: legacy.createdAt }]
    };
    if (this.plugin.isCoffeeOutlineSource?.(this)) this.plugin.refreshCoffeeOutline?.(this);
    this.contentEl.empty();
    const room = this.contentEl.createDiv("ct-room"),
      fixed = room.createDiv("ct-fixed"),
      header = fixed.createDiv("ct-header");
    header.createEl("h2", { text: legacy.topic });
    this.button(header, this.t("coffee.home"), () => this.returnHome());
    this.button(header, this.t("coffee.open_markdown"), async () => {
      const file = await this.store.openMarkdown(legacy.id);
      await this.app.workspace.getLeaf(false).openFile(file);
    });
    this.button(header, this.t("coffee.open_new_table"), () => this.returnHome());
    header.createEl("p", { cls: "ct-muted", text: this.t("coffee.older_saved_table_read_only") });
    const scrolling = room.createDiv("ct-chat-scroll markdown-rendered");
    void MarkdownRenderer.render(
      this.app,
      transcript,
      scrolling.createDiv({ cls: "ct-segment", attr: { "data-coffee-segment": "legacy" } }),
      this.store.sessionPath(legacy.id),
      this
    );
  }
  private attach(session: CoffeeSession, startAtTop = true): void {
    this.legacyNavigation = null;
    this.navigationGeneration++;
    this.unsubscribe?.();
    if (this.statusTimer !== null && typeof window.clearInterval === "function") {
      window.clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    this.previewVisible = false;
    this.firstRoomScroll = startAtTop && session.status === "completed" ? "top" : "bottom";
    this.composerValues.clear();
    this.followUpGuests = [];
    this.engine =
      this.plugin.coffeeManager?.open(session) ??
      new CoffeeEngine(
        session,
        request => this.plugin.runCoffeeRequest(request),
        (value, summariesOnly) => this.store.save(value, summariesOnly)
      );
    this.unsubscribe = this.engine.subscribe(() => this.refresh());
    this.handoffUnsubscribe?.();
    this.handoffUnsubscribe = subscribeCoffeeHandoff(this.plugin, () => {
      if (!this.closed) this.render();
    });
    if (this.plugin.isCoffeeOutlineSource?.(this)) this.plugin.refreshCoffeeOutline?.(this);
    this.render();
    this.app.workspace.requestSaveLayout();
  }
  /** The background "organize with AI" run of the handoff dialog: progress and Stop, then Review and dismiss. */
  private renderHandoffStatus(parent: HTMLElement, sessionId: string): void {
    const task = coffeeHandoffTask(this.plugin, sessionId);
    if (!task) return;
    const running = task.state === "running";
    renderBackgroundStatus(parent, {
      title: this.t("coffee.organize_with_ai"),
      value: running
        ? this.t("coffee.organizing_a_research_question")
        : task.state === "done"
          ? this.t("coffee.handoff_bar_ready")
          : (task.message ?? ""),
      running,
      ...(running
        ? { onStop: () => stopCoffeeHandoff(this.plugin, task) }
        : {
            review: {
              label: this.t("ui.background_review"),
              open: () => {
                void reopenCoffeeHandoff(this.plugin, task);
              }
            },
            onDismiss: () => dismissCoffeeHandoff(this.plugin, task)
          })
    });
  }
  private render(): void {
    const engine = this.engine;
    if (!engine || this.closed) return;
    const renderEpoch = ++this.roomRenderEpoch;
    this.liveRenderEpoch++;
    this.speechAnchorIndex = 0;
    const priorScroll = this.contentEl.querySelector<HTMLElement>(".ct-chat-scroll"),
      hadPriorScroll = !!priorScroll,
      oldTop = priorScroll?.scrollTop ?? 0,
      wasBottom = !!priorScroll && priorScroll.scrollHeight - priorScroll.scrollTop - priorScroll.clientHeight < 100,
      firstScroll = hadPriorScroll ? null : this.firstRoomScroll,
      scrollEpoch = this.scrollEpoch,
      active = this.contentEl.ownerDocument.activeElement as
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null,
      activeField = active?.dataset.ctField,
      activeValue = active?.value,
      activeStart =
        active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionStart : undefined,
      activeEnd =
        active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active.selectionEnd : undefined;
    this.firstRoomScroll = null;
    this.markdownJobs = [];
    this.contentEl
      .querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[data-ct-field]")
      .forEach(field => this.composerValues.set(field.dataset.ctField!, field.value));
    this.contentEl.empty();
    const room = this.contentEl.createDiv("ct-room"),
      fixed = room.createDiv("ct-fixed"),
      header = fixed.createDiv("ct-header");
    header.createEl("h2", { text: engine.session.topic });
    const actions = header.createDiv("ct-room-actions");
    this.button(actions, this.t("coffee.home"), () => this.returnHome());
    if (!engine.session.id.startsWith("sample-")) {
      this.button(actions, this.t("coffee.open_markdown"), async () => {
        const file = await this.store.openMarkdown(engine.session.id);
        await this.app.workspace.getLeaf(false).openFile(file);
      });
      this.button(actions, this.t("coffee.delete_table"), async () => {
        if (!(await new CoffeeDeleteModal(this.app, engine.session.topic, this.plugin.settings.language).confirm()))
          return;
        const manager = this.plugin.coffeeManager;
        let deleting: CoffeeEngine | undefined;
        try {
          deleting = await manager?.prepareDelete(engine.session.id);
          await this.store.delete(engine.session.id);
          manager?.completeDelete(engine.session.id, deleting);
          this.returnHome();
        } catch (error) {
          manager?.cancelDelete(engine.session.id, deleting);
          throw error;
        }
      });
    }
    this.button(actions, this.t("coffee.open_new_table"), () => this.returnHome());
    header.createEl("p", {
      cls: "ct-muted",
      text: `${this.plugin.modelLabel(engine.session.model)} · ${this.t("coffee.ai_simulated_perspectives")} · ${this.t("coffee.conversation_language", languagePromptName(coffeeContentLocale(engine.session.language), instructionLanguageOf(uiLocale(this.plugin.settings.language)), "plain"))}`
    });
    const roster = fixed.createDiv("ct-roster"),
      status = fixed.createDiv({ cls: "ct-status", attr: { role: "status", "aria-live": "polite" } });
    if (engine.busy) this.button(fixed, this.t("coffee.stop_generation"), () => engine.cancel());
    else if (engine.session.status === "error") {
      const recover = this.button(
        fixed,
        engine.persistenceFailed
          ? this.t("coffee.retry_saving")
          : engine.session.draftMarkdown
            ? this.t("coffee.continue_from_saved_draft")
            : this.t("coffee.retry_this_segment"),
        async () => {
          if (engine.persistenceFailed) await engine.retrySave();
          else await this.plugin.confirmAiUsage(engine.session.model, () => engine.start());
        }
      );
      recover.addClass("mod-cta");
    }
    const body = room.createDiv("ct-room-columns"),
      tabs = body.createDiv("ct-pane-tabs");
    body.dataset.pane = "chat";
    const chatTab = this.button(tabs, this.t("coffee.conversation"), () => {
      body.dataset.pane = "chat";
    });
    const insightTab = this.button(tabs, this.t("coffee.insights"), () => {
      body.dataset.pane = "insight";
    });
    chatTab.addClass("ct-pane-tab");
    insightTab.addClass("ct-pane-tab");
    const chatPanel = body.createDiv("ct-chat-panel"),
      scrolling = chatPanel.createDiv("ct-chat-scroll"),
      messages = scrolling.createDiv("ct-messages");
    if (priorScroll) {
      messages.setCssProps({ "--ct-live-held-height": `${priorScroll.scrollHeight}px` });
      messages.addClass("ct-live-holding");
    }
    const events: Array<{ at: string; type: "round" | "question" | "intervention"; index: number }> = [];
    (engine.session.rounds ?? []).forEach((round, index) => {
      if (round.status !== "generating") events.push({ at: round.createdAt, type: "round", index });
    });
    engine.session.questions.forEach((question, index) =>
      events.push({ at: question.createdAt ?? engine.session.createdAt, type: "question", index })
    );
    (engine.session.interventions ?? []).forEach((item, index) => {
      if (!item.roundId) events.push({ at: item.createdAt, type: "intervention", index });
    });
    events.sort((a, b) => a.at.localeCompare(b.at));
    for (const event of events) {
      if (event.type === "round") {
        const round = (engine.session.rounds ?? [])[event.index];
        this.renderRound(
          round.markdown || round.draftMarkdown || this.t("coffee.this_segment_has_no_dialogue_yet"),
          round.id,
          messages
        );
      } else if (event.type === "question") {
        const question = engine.session.questions[event.index];
        const segment = messages.createDiv({
          cls: "ct-segment",
          attr: { "data-coffee-segment": `question:${question.id}` }
        });
        this.renderUserBubble(question.question, segment);
        if (question.answer) this.renderBubbles(question.answer, segment, `question-${question.id}`);
        if (question.status !== "complete") {
          const live = segment.createDiv({ cls: "ct-live-answer", attr: { "data-live-question-id": question.id } });
          if (question.draftAnswer) this.renderStreaming(question.draftAnswer, live, `question-${question.id}`);
        }
        if (question.status === "error") segment.createEl("p", { cls: "ct-error", text: question.error });
        if (question.status !== "complete")
          this.button(segment, this.t("coffee.retry"), () => {
            void engine.ask(question.question, question.id);
          });
      } else {
        const item = engine.session.interventions![event.index];
        this.renderUserBubble(item.text, messages);
        if (item.status === "failed")
          messages.createEl("small", { cls: "ct-muted", text: this.t("coffee.not_delivered") });
      }
    }
    const draft = engine.session.status === "completed" ? "" : (engine.session.draftMarkdown ?? "");
    if (engine.busy && !draft)
      messages.createEl("p", {
        cls: "ct-waiting",
        text: this.t("coffee.waiting_for_the_first_words")
      });
    const generatingRound = (engine.session.rounds ?? []).find(item => item.status === "generating");
    if (generatingRound) {
      const live = messages.createDiv("ct-live-draft");
      this.renderRound(draft || this.t("coffee.waiting_for_dialogue"), generatingRound.id, live);
    }
    const latest = chatPanel.createDiv("ct-latest is-hidden");
    this.button(latest, this.t("coffee.go_to_bottom_of_chat"), () => {
      scrolling.scrollTop = scrolling.scrollHeight;
      latest.classList.add("is-hidden");
    });
    scrolling.addEventListener("scroll", () => {
      this.scrollEpoch++;
      latest.classList.toggle("is-hidden", scrolling.scrollHeight - scrolling.scrollTop - scrolling.clientHeight < 100);
    });
    const composer = chatPanel.createDiv("ct-composer");
    if (engine.session.status === "completed") {
      this.button(composer, this.t("coffee.continue_chatting"), async () => {
        if (engine.session.id.startsWith("sample-")) await this.copySample();
        const current = this.engine;
        if (current) await this.plugin.confirmAiUsage(current.session.model, () => current.continueTable());
      }).addClass("mod-cta");
      const question = composer.createEl("textarea", {
        attr: {
          rows: "2",
          maxlength: "1800",
          placeholder: this.t("coffee.ask_the_table_a_follow_up"),
          "aria-label": this.t("coffee.follow_up_question"),
          "data-ct-field": "follow-up"
        }
      });
      question.value = this.composerValues.get("follow-up") ?? this.composerValues.get("intervention-text") ?? "";
      question.addEventListener("input", () => this.composerValues.set("follow-up", question.value));
      this.renderFollowUpGuests(composer, engine);
      this.button(
        composer,
        this.t("coffee.ask"),
        async () => {
          const value = question.value.trim();
          if (!value) return;
          const validation = validateGuestInvitations(
            this.followUpGuests,
            engine.session.guests?.counts ?? defaults(),
            engine.session.questions,
            undefined,
            liveRosterFor(engine.session).map(person => person.name),
            engine.session.language
          );
          if (validation) {
            new Notice(validation);
            return;
          }
          const invites = this.followUpGuests.map(item => ({
            ...item,
            name: item.name.trim(),
            description: item.description.trim()
          }));
          if (engine.session.id.startsWith("sample-")) await this.copySample();
          const current = this.engine,
            questionId = crypto.randomUUID();
          if (current)
            await this.plugin.confirmAiUsage(current.session.model, () => current.ask(value, questionId, invites));
          if (this.engine?.session.questions.some(item => item.id === questionId && item.status === "complete")) {
            question.value = "";
            this.composerValues.delete("follow-up");
            this.composerValues.delete("intervention-text");
            this.followUpGuests = [];
          }
        },
        engine.busy
      ).addClass("mod-cta");
      if (engine.session.dirtyNotes) {
        this.button(
          composer,
          this.t("coffee.refresh_observer_notes_only"),
          async () => {
            await this.plugin.confirmAiUsage(engine.session.model, () => engine.refreshObserverNotes());
          },
          engine.busy || engine.persistenceFailed
        );
        composer.createEl("small", {
          cls: "ct-muted",
          text: this.t("coffee.uses_the_whole_table_and_saved_drafts_it_does_not_add")
        });
      }
    } else if (engine.session.status === "ready")
      this.button(composer, this.t("coffee.generate_conversation"), async () => {
        await this.plugin.confirmAiUsage(engine.session.model, () => engine.start());
      }).addClass("mod-cta");
    else if (engine.session.status === "error") {
      if (
        !engine.persistenceFailed &&
        (engine.session.draftMarkdown || engine.session.transcriptMarkdown || engine.session.questions.length)
      ) {
        this.button(
          composer,
          this.t("coffee.refresh_observer_notes_only"),
          async () => {
            await this.plugin.confirmAiUsage(engine.session.model, () => engine.refreshObserverNotes());
          },
          engine.busy
        );
        composer.createEl("small", {
          cls: "ct-muted",
          text: this.t("coffee.uses_saved_dialogue_and_drafts_without_adding_new")
        });
      }
      if (!engine.persistenceFailed)
        composer.createEl("small", {
          cls: "ct-muted",
          text: this.t("coffee.generation_stopped_resume_from_the_top_toolbar_you_can")
        });
      this.button(composer, this.t("coffee.edit_settings_and_start_another"), () => this.home(engine.session));
      this.button(composer, this.t("coffee.open_markdown"), async () => {
        const file = await this.store.openMarkdown(engine.session.id);
        await this.app.workspace.getLeaf(false).openFile(file);
      });
      if (engine.session.draftMarkdown)
        this.button(composer, this.t("coffee.copy_draft"), async () => {
          await navigator.clipboard.writeText(engine.session.draftMarkdown ?? "");
          new Notice(this.t("coffee.draft_copied"));
        });
      const savedDraft = !engine.persistenceFailed && !!engine.session.draftMarkdown;
      const message = composer.createEl("p", {
        cls: "ct-error",
        text: `${engine.error || engine.session.error || this.t("coffee.generation_stopped")} · ${engine.persistenceFailed ? this.t("coffee.the_latest_text_is_only_in_this_open_view_retry_saving") : savedDraft ? this.t("coffee.received_text_is_saved_as_a_draft") : this.t("coffee.the_existing_conversation_is_preserved")}`
      });
      void message;
      if (this.composerValues.get("intervention-text")) {
        composer.createEl("p", {
          cls: "ct-muted",
          text: this.t("coffee.your_unsent_message_is_kept_below")
        });
        const retained = composer.createEl("textarea", {
          attr: {
            rows: "2",
            placeholder: this.t("coffee.unsent_message"),
            "data-ct-field": "intervention-text"
          }
        });
        retained.value = this.composerValues.get("intervention-text") ?? "";
        retained.addEventListener("input", () => this.composerValues.set("intervention-text", retained.value));
      }
    } else if (engine.busy) {
      const select = composer.createEl("select", {
        attr: { "aria-label": this.t("coffee.how_to_join"), "data-ct-field": "intervention-kind" }
      });
      for (const [value, key] of [
        ["comment", "coffee.intervention_comment"],
        ["guest-question", "coffee.intervention_guest_question"],
        ["redirect", "coffee.intervention_redirect"]
      ] as const)
        select.createEl("option", { value, text: this.t(key) });
      select.value = this.composerValues.get("intervention-kind") ?? "comment";
      select.addEventListener("change", () => this.composerValues.set("intervention-kind", select.value));
      const target = composer.createEl("input", {
        attr: {
          type: "text",
          placeholder: this.t("coffee.guest_name_optional"),
          "data-ct-field": "intervention-target"
        }
      });
      target.value = this.composerValues.get("intervention-target") ?? "";
      target.addEventListener("input", () => this.composerValues.set("intervention-target", target.value));
      const input = composer.createEl("textarea", {
        attr: {
          rows: "2",
          placeholder: this.t("coffee.join_the_conversation"),
          "data-ct-field": "intervention-text"
        }
      });
      input.value = this.composerValues.get("intervention-text") ?? "";
      input.addEventListener("input", () => this.composerValues.set("intervention-text", input.value));
      this.button(composer, this.t("coffee.send"), async () => {
        if (!input.value.trim()) return;
        const text = input.value;
        input.value = "";
        this.composerValues.delete("intervention-text");
        try {
          await engine.intervene(select.value as "comment" | "guest-question" | "redirect", text, target.value);
        } catch (error) {
          input.value = text;
          this.composerValues.set("intervention-text", text);
          throw error;
        }
      });
    }
    if (/changed outside|外部修改|outside this room/i.test(engine.error))
      this.button(composer, this.t("coffee.reload_edits"), async () => {
        if (engine.busy) await engine.stop();
        const session = await this.store.reload(this.store.sessionPath(engine.session.id));
        this.plugin.coffeeManager?.forget(engine.session.id);
        this.attach(session);
      });
    const insight = body.createDiv("ct-insight-panel");
    insight.createEl("h3", { text: this.t("coffee.observers_notes") });
    const notes = engine.session.observerNotes ?? [];
    if (engine.session.dirtyNotes)
      insight.createEl("p", {
        cls: "ct-muted",
        text: this.t("coffee.the_conversation_changed_these_notes_have_not_been")
      });
    if (notes[0]) this.renderInsightNotes(notes[0], insight);
    else
      insight.createEl("p", {
        cls: "ct-muted",
        text: this.t("coffee.the_observers_notes_will_appear_when_this_segment")
      });
    if (engine.session.observerDraftMarkdown || (engine.busy && engine.session.dirtyNotes)) {
      insight.createEl("p", {
        cls: "ct-muted",
        text: this.t("coffee.updating_notes_from_the_saved_conversation")
      });
      const draft = insight.createDiv("ct-observer-draft");
      if (engine.session.observerDraftMarkdown) this.renderStreaming(engine.session.observerDraftMarkdown, draft);
    }
    if (engine.session.status === "completed" && !engine.busy && !engine.session.id.startsWith("sample-")) {
      const handoff = this.button(insight, this.t("coffee.take_to_vam_for_deeper_research"), () =>
        this.plugin.openCoffeeHandoff(engine.session, this.store.sessionPath(engine.session.id))
      );
      handoff.addClass("mod-cta");
    }
    if (!engine.session.id.startsWith("sample-")) this.renderHandoffStatus(insight, engine.session.id);
    if (!engine.session.id.startsWith("sample-")) {
      const controls = insight.createDiv("ct-customization-actions");
      const review = (): void => new CoffeeConvergenceModal(this.app, engine).open();
      this.button(
        controls,
        this.t("coffee.customize"),
        () =>
          new CoffeeCustomizationModal(
            this.app,
            engine,
            (style, value) => this.saveCoffeeDefault(style, value),
            review,
            async work => {
              await this.plugin.confirmAiUsage(engine.session.model, work);
            }
          ).open(),
        engine.busy || engine.deleted
      );
      this.button(
        controls,
        this.t("coffee.preview_convergence"),
        async () => {
          const before = convergencePreviewMarks(engine);
          await this.plugin.confirmAiUsage(engine.session.model, () => engine.previewConvergence());
          // Completion is a Notice with a review button; the review never opens by itself.
          notifyConvergencePreview(engine, before, review);
        },
        engine.busy || engine.deleted || !notes[0]
      );
      if (engine.session.convergenceDraft || engine.session.convergenceRawDraft)
        this.button(controls, this.t("coffee.review_saved_preview"), review, engine.busy);
      if (engine.session.convergenceUndo)
        this.button(
          controls,
          this.t("coffee.undo_last_convergence"),
          () => engine.undoConvergence(),
          engine.busy || engine.deleted
        );
      insight.createEl("small", {
        cls: "ct-muted",
        text: this.t("coffee.preview_first_accept_selected_changes_or_restore_the")
      });
    }
    if (engine.session.status === "completed")
      this.button(insight, this.t("coffee.edit_settings_and_start_another_table"), () =>
        this.returnHome(engine.session)
      );
    this.renderRoster(roster, liveRosterFor(engine.session, draft));
    this.updateStatus(status, engine);
    this.stateSignature = this.renderSignature(engine);
    this.contentEl
      .querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[data-ct-field]")
      .forEach(field => {
        const value = this.composerValues.get(field.dataset.ctField!);
        if (value !== undefined && !field.value) field.value = value;
      });
    if (activeField) {
      const field =
          activeField === "intervention-text" && engine.session.status === "completed" ? "follow-up" : activeField,
        replacement = this.contentEl.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
          `[data-ct-field="${field}"]`
        );
      if (replacement) {
        if (activeValue !== undefined) replacement.value = activeValue;
        replacement.focus();
        if (!(replacement instanceof HTMLSelectElement)) {
          try {
            replacement.setSelectionRange(
              activeStart ?? replacement.value.length,
              activeEnd ?? replacement.value.length
            );
          } catch {
            /* Browser may not support selection for this control. */
          }
        }
      }
    }
    if (engine.busy && this.statusTimer === null && typeof window.setInterval === "function")
      this.statusTimer = window.setInterval(() => {
        const current = this.contentEl.querySelector<HTMLElement>(".ct-status");
        if (current && this.engine) this.updateStatus(current, this.engine);
      }, 1000);
    if (!engine.busy && this.statusTimer !== null) {
      window.clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    const markdownJobs = this.markdownJobs;
    this.markdownJobs = null;
    const sessionId = engine.session.id;
    void Promise.all(markdownJobs ?? []).then(
      () =>
        new Promise<void>(resolve =>
          window.requestAnimationFrame(() => {
            if (
              this.closed ||
              this.engine?.session.id !== sessionId ||
              renderEpoch !== this.roomRenderEpoch ||
              !scrolling.isConnected
            ) {
              resolve();
              return;
            }
            const currentTop = scrolling.scrollTop;
            messages.removeClass("ct-live-holding");
            if (this.scrollEpoch !== scrollEpoch) {
              scrolling.scrollTop = currentTop;
              resolve();
              return;
            }
            if (firstScroll === "top") scrolling.scrollTop = 0;
            else if (firstScroll === "bottom" || (hadPriorScroll && wasBottom))
              scrolling.scrollTop = scrolling.scrollHeight;
            else scrolling.scrollTop = oldTop;
            resolve();
          })
        )
    );
    if (hadPriorScroll && !wasBottom) scrolling.scrollTop = oldTop;
  }
  private renderBubbles(markdown: string, target: HTMLElement, anchorPrefix = "speech"): void {
    const speeches = parseSpeeches(markdown);
    if (!speeches.length) {
      this.renderMarkdown(markdown, target);
      return;
    }
    speeches.forEach((item, index) =>
      this.renderSpeech(item.name, item.role, item.text, target, `${anchorPrefix}-${index}`)
    );
  }
  private renderFollowUpGuests(target: HTMLElement, engine: CoffeeEngine): void {
    const details = target.createEl("details", { cls: "ct-follow-up-guests" });
    details.open = this.composerValues.get("follow-up-guests-open") === "true";
    details.addEventListener("toggle", () => this.composerValues.set("follow-up-guests-open", String(details.open)));
    details.createEl("summary", { text: this.t("coffee.invite_temporary_guests") });
    const rows = details.createDiv("ct-follow-up-guest-list");
    this.followUpGuests.forEach((guest, index) => {
      const row = rows.createDiv("ct-follow-up-guest");
      const name = row.createEl("input", {
        attr: {
          type: "text",
          maxlength: "60",
          placeholder: this.t("coffee.name"),
          "aria-label": this.t("coffee.guest_name")
        }
      });
      name.disabled = engine.busy;
      name.value = guest.name;
      name.addEventListener("input", () => {
        guest.name = name.value;
      });
      const category = row.createEl("select", { attr: { "aria-label": this.t("coffee.guest_perspective") } });
      category.disabled = engine.busy;
      for (const item of CATEGORIES) category.createEl("option", { value: item.id, text: this.t(item.label) });
      category.value = guest.category;
      category.addEventListener("change", () => {
        guest.category = category.value as GuestCategory;
      });
      const description = row.createEl("input", {
        attr: {
          type: "text",
          maxlength: "160",
          placeholder: this.t("coffee.background_or_perspective"),
          "aria-label": this.t("coffee.guest_background")
        }
      });
      description.disabled = engine.busy;
      description.value = guest.description;
      description.addEventListener("input", () => {
        guest.description = description.value;
      });
      this.button(
        row,
        this.t("ui.reference_remove"),
        () => {
          this.followUpGuests.splice(index, 1);
          this.render();
        },
        engine.busy
      );
    });
    this.button(
      details,
      this.t("coffee.add_one_guest"),
      () => {
        this.followUpGuests.push({ id: crypto.randomUUID(), name: "", category: "experts", description: "" });
        this.render();
      },
      engine.busy
    );
    const totalGuests =
      Object.values(engine.session.guests?.counts ?? defaults()).reduce((sum, value) => sum + value, 0) +
      (engine.session.questions ?? [])
        .filter(question => question.status === "complete")
        .reduce((sum, question) => sum + (question.invitedGuests?.length ?? 0), 0);
    rows.createEl("small", {
      cls: "ct-muted",
      text: this.t("coffee.guest_total_and_category_limits", totalGuests)
    });
  }
  private renderInsightNotes(markdown: string, target: HTMLElement): void {
    const insights = baselineFromVersions(
      [markdown],
      this.engine?.session.language ?? noteLanguageOf(this.plugin.settings.language)
    );
    if (!insights.length) {
      this.renderMarkdown(markdown, target.createDiv("ct-insight-latest markdown-rendered"));
      return;
    }
    const tableId = this.engine?.session.id ?? "",
      state = this.insightStates.get(tableId) ?? {
        query: "",
        expanded: new Set<string>(),
        collapsed: new Set<string>()
      };
    this.insightStates.set(tableId, state);
    const search = target.createEl("input", {
      cls: "ct-insight-search",
      attr: {
        type: "search",
        placeholder: this.t("coffee.search_insights_and_context"),
        "aria-label": this.t("coffee.search_insights")
      }
    });
    search.value = state.query;
    const results = target.createDiv("ct-insight-results");
    search.addEventListener("input", () => {
      state.query = search.value;
      renderResults();
    });
    const renderResults = (): void => {
      results.empty();
      const query = state.query.trim().toLocaleLowerCase();
      const categories = new Map<string, typeof insights>();
      for (const item of insights) {
        const text = [
          item.summary,
          item.detail,
          item.question,
          item.proposedSolution,
          item.limitations,
          categoryLabel(item.category, this.plugin.settings.language)
        ]
          .filter(Boolean)
          .join("\n")
          .toLocaleLowerCase();
        if (!query || text.includes(query))
          categories.set(item.category, [...(categories.get(item.category) ?? []), item]);
      }
      if (!categories.size) results.createEl("p", { cls: "ct-muted", text: this.t("coffee.no_matching_insights") });
      for (const [category, items] of categories) {
        const group = results.createEl("details", { cls: "ct-insight-group" });
        group.open = !!query || !state.collapsed.has(category);
        group.dataset.insightCategory = category;
        group.createEl("summary", { text: categoryLabel(category, this.plugin.settings.language) });
        group.addEventListener("toggle", () => {
          if (query || !group.isConnected) return;
          if (group.open) state.collapsed.delete(category);
          else state.collapsed.add(category);
        });
        for (const item of items) {
          const details = group.createEl("details", { cls: "ct-insight-item" });
          details.dataset.insightId = item.id;
          details.open =
            state.expanded.has(item.id) ||
            (!!query &&
              [item.detail, item.question, item.proposedSolution, item.limitations].some(value =>
                value?.toLocaleLowerCase().includes(query)
              ));
          details.addEventListener("toggle", () => {
            if (query || !details.isConnected) return;
            if (details.open) state.expanded.add(item.id);
            else state.expanded.delete(item.id);
          });
          details.createEl("summary", { text: item.summary });
          const context = details.createDiv("ct-insight-detail markdown-rendered");
          const session = this.engine?.session;
          if (session && this.engine && !session.id.startsWith("sample-")) {
            const pinned = session.pinnedInsightIds?.includes(item.id) ?? false;
            const pin = this.button(
              context,
              pinned ? this.t("coffee.unpin_insight") : this.t("coffee.keep_this_insight"),
              () => this.engine!.togglePinnedInsight(item.id),
              this.engine.busy || this.engine.deleted
            );
            pin.setAttribute("aria-pressed", String(pinned));
            pin.title = this.t("coffee.convergence_keeps_this_item_unchanged_without_merging");
          }
          if (session?.status === "completed" && !this.engine?.busy && !session.id.startsWith("sample-"))
            this.button(context, this.t("coffee.research_this_insight"), () =>
              this.plugin.openCoffeeHandoff(session, this.store.sessionPath(session.id), item.id)
            );
          if (item.detail) this.renderMarkdown(item.detail, context.createDiv("ct-insight-context"));
          if (item.question) {
            context.createEl("strong", { text: this.t("coffee.original_question") });
            this.renderMarkdown(item.question, context);
          }
          if (item.proposedSolution) {
            context.createEl("strong", { text: this.t("coffee.possible_response") });
            this.renderMarkdown(item.proposedSolution, context);
          }
          if (item.limitations) {
            context.createEl("strong", { text: this.t("coffee.conditions_and_limits") });
            this.renderMarkdown(item.limitations, context);
          }
          if (item.sources.length) {
            const sources = context.createDiv("ct-insight-sources");
            for (const source of item.sources)
              this.button(sources, this.t("coffee.find_in_conversation"), () => {
                if (!this.locateOutlineItem(source))
                  new Notice(this.t("coffee.could_not_find_a_close_match_in_this_conversation"));
              });
          } else
            context.createEl("p", {
              cls: "ct-muted ct-insight-no-source",
              text: this.t("coffee.no_linkable_dialogue_source_was_provided")
            });
          if (!item.detail && !item.question && !item.proposedSolution && !item.limitations && !item.sources.length)
            context.createEl("p", {
              cls: "ct-muted",
              text: this.t("coffee.no_additional_context_was_provided")
            });
        }
      }
    };
    renderResults();
  }
  private renderRound(markdown: string, roundId: string | undefined, target: HTMLElement): void {
    target = target.createDiv({ cls: "ct-segment", attr: { "data-coffee-segment": `round:${roundId ?? "draft"}` } });
    markdown = extractSegmentSummary(markdown).markdown;
    const speeches = parseSpeeches(markdown),
      interventions = (this.engine?.session.interventions ?? [])
        .filter(item => item.roundId && item.roundId === roundId)
        .sort((a, b) => (a.afterTurn ?? 0) - (b.afterTurn ?? 0));
    if (!speeches.length) {
      if (markdown) this.renderMarkdown(markdown, target.createDiv("ct-live-plain markdown-rendered"));
      for (const item of interventions) this.renderUserBubble(item.text, target);
      return;
    }
    let next = 0;
    for (let index = 0; index <= speeches.length; index++) {
      while (next < interventions.length && (interventions[next].afterTurn ?? 0) <= index)
        this.renderUserBubble(interventions[next++].text, target);
      if (index < speeches.length) {
        const speech = speeches[index];
        this.renderSpeech(speech.name, speech.role, speech.text, target, `round-${roundId ?? "draft"}-${index}`);
      }
    }
  }
  private renderSpeech(name: string, role: string, text: string, target: HTMLElement, anchorKey?: string): void {
    if (name === "你" || name.toLowerCase() === "you") {
      this.renderUserBubble(text, target);
      return;
    }
    const index = this.speechAnchorIndex++,
      article = target.createDiv("ct-message");
    article.dataset.coffeeSpeech = `ct-speech-${anchorKey ?? index}`;
    article.dataset.coffeeSpeechText = text;
    article.createDiv({
      cls: `ct-avatar ct-color-${avatarColor(name)}`,
      text: initials(name),
      attr: { "aria-hidden": "true" }
    });
    const content = article.createDiv("ct-message-content");
    content.createEl("strong", { text: name });
    content.createSpan({ cls: "ct-role", text: role });
    this.renderMarkdown(text, content.createDiv("ct-bubble markdown-rendered"));
  }
  private renderStreaming(markdown: string, target: HTMLElement, anchorPrefix?: string): void {
    const speeches = parseSpeeches(markdown);
    if (!speeches.length) {
      this.renderMarkdown(markdown, target.createDiv("ct-live-plain markdown-rendered"));
      return;
    }
    this.renderBubbles(markdown, target, anchorPrefix);
  }
  private renderUserBubble(text: string, target: HTMLElement): void {
    const article = target.createDiv("ct-message ct-message-user");
    article.createDiv({ cls: "ct-avatar ct-user-avatar", text: this.t("coffee.you") });
    const content = article.createDiv("ct-message-content");
    content.createEl("strong", { text: this.t("coffee.you") });
    this.renderMarkdown(text, content.createDiv("ct-bubble markdown-rendered"));
  }
  private renderMarkdown(markdown: string, target: HTMLElement): void {
    const job = MarkdownRenderer.render(
      this.app,
      markdown,
      target,
      this.store.sessionPath(this.engine?.session.id ?? ""),
      this
    ).then(() => undefined);
    this.markdownJobs?.push(job);
  }
  private renderRoster(target: HTMLElement, people: Array<{ name: string; role: string; bio: string }>): void {
    target.empty();
    for (const person of people) {
      const chip = target.createEl("button", {
        cls: "ct-person",
        attr: { title: person.bio, "aria-label": `${person.name}, ${person.role}. ${person.bio}` }
      });
      chip.createSpan({
        cls: `ct-avatar ct-color-${avatarColor(person.name)}`,
        text: initials(person.name),
        attr: { "aria-hidden": "true" }
      });
      chip.createSpan({ cls: "ct-person-label", text: `${person.name} · ${person.role}` });
      chip.addEventListener("click", () => new Notice(`${person.name}｜${person.role}\n${person.bio}`));
    }
  }
  private updateStatus(status: HTMLElement, engine: CoffeeEngine): void {
    const elapsed = engine.busy ? `${Math.floor((Date.now() - engine.startedAt) / 60000)} min` : "";
    const last = parseSpeeches(engine.session.draftMarkdown ?? "").at(-1);
    status.setText(
      engine.error ||
        (engine.summarizing
          ? this.t("coffee.generating_segment_summaries")
          : engine.busy
            ? `${last ? `${last.name} · ` : ""}${this.t("coffee.is_speaking")} · ${elapsed}`
            : engine.session.status === "completed"
              ? this.t("coffee.table_complete")
              : engine.session.status === "error"
                ? this.t("coffee.stopped_draft_saved")
                : this.t("coffee.ready_to_generate"))
    );
  }
  private async copySample(): Promise<void> {
    const source = this.engine?.session;
    if (!source || !source.id.startsWith("sample-")) return;
    const copy = createSession(
      source.topic,
      this.plugin.settings.cliModel,
      this.plugin.settings.cliReasoning,
      source.language,
      source.guests
    );
    copy.status = "completed";
    copy.transcriptMarkdown = source.transcriptMarkdown;
    copy.rounds = source.rounds?.map(item => ({ ...item })) ?? [];
    copy.observerNotes = [...(source.observerNotes ?? [])];
    copy.questions = source.questions.map(item => ({ ...item, id: crypto.randomUUID() }));
    await this.store.save(copy);
    this.attach(copy);
  }
  private renderSignature(engine: CoffeeEngine): string {
    return `${engine.session.status}:${engine.busy}:${engine.error}:${engine.session.questions.length}:${engine.busy ? "streaming" : engine.session.updatedAt}:${engine.session.dirtyNotes}:${engine.session.observerNotes?.[0] ?? ""}`;
  }
  private refresh(): void {
    const engine = this.engine;
    if (!engine || this.closed) return;
    if (engine.deleted) {
      this.returnHome();
      return;
    }
    const signature = this.renderSignature(engine);
    if (signature !== this.stateSignature) {
      this.stateSignature = signature;
      this.render();
      if (this.plugin.isCoffeeOutlineSource?.(this)) this.plugin.refreshCoffeeOutline?.(this);
      return;
    }
    if (this.renderTimer !== null) return;
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      if (!this.engine || this.closed) return;
      this.refreshLive();
    }, 250);
  }
  private refreshLive(): void {
    const engine = this.engine;
    if (!engine) return;
    const renderEpoch = ++this.liveRenderEpoch,
      scrollEpoch = this.scrollEpoch;
    const held: HTMLElement[] = [];
    this.markdownJobs = [];
    const hold = (element: HTMLElement): void => {
      element.setCssProps({ "--ct-live-held-height": `${element.offsetHeight}px` });
      element.addClass("ct-live-holding");
      held.push(element);
    };
    const scroller = this.contentEl.querySelector<HTMLElement>(".ct-chat-scroll"),
      wasBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100,
      oldTop = scroller?.scrollTop ?? 0;
    const waiting = this.contentEl.querySelector<HTMLElement>(".ct-waiting");
    if (waiting && engine.session.draftMarkdown) waiting.remove();
    const status = this.contentEl.querySelector<HTMLElement>(".ct-status");
    if (status) this.updateStatus(status, engine);
    const draft = this.contentEl.querySelector<HTMLElement>(".ct-live-draft");
    if (draft) {
      hold(draft);
      draft.empty();
      const round = [...(engine.session.rounds ?? [])].reverse().find(item => item.status === "generating");
      if (engine.session.status !== "completed" && engine.session.draftMarkdown)
        this.renderRound(engine.session.draftMarkdown, round?.id, draft);
    }
    for (const question of engine.session.questions) {
      const live = this.contentEl.querySelector<HTMLElement>(`[data-live-question-id="${question.id}"]`);
      if (live) {
        hold(live);
        live.empty();
        if (question.draftAnswer) this.renderStreaming(question.draftAnswer, live, `question-${question.id}`);
      }
    }
    const roster = this.contentEl.querySelector<HTMLElement>(".ct-roster");
    if (roster) this.renderRoster(roster, liveRosterFor(engine.session, engine.session.draftMarkdown ?? ""));
    const observerDraft = this.contentEl.querySelector<HTMLElement>(".ct-observer-draft");
    if (observerDraft) {
      hold(observerDraft);
      observerDraft.empty();
      if (engine.session.observerDraftMarkdown)
        this.renderStreaming(engine.session.observerDraftMarkdown, observerDraft);
    }
    const jobs = this.markdownJobs;
    this.markdownJobs = null;
    void Promise.all(jobs ?? []).then(() =>
      window.requestAnimationFrame(() => {
        if (
          this.closed ||
          this.engine !== engine ||
          renderEpoch !== this.liveRenderEpoch ||
          scroller?.isConnected === false
        )
          return;
        const currentTop = scroller?.scrollTop ?? oldTop;
        for (const element of held) element.removeClass("ct-live-holding");
        if (scroller)
          scroller.scrollTop =
            this.scrollEpoch === scrollEpoch ? (wasBottom ? scroller.scrollHeight : oldTop) : currentTop;
      })
    );
  }
}
function observerNotes(markdown: string): string {
  return markdown.match(/^# (?:觀察者整理|Observer(?:[’']s)? notes)[\s\S]*$/m)?.[0] ?? "";
}
function initials(name: string): string {
  return [...name.replace(/[^\p{L}\p{N}]/gu, "")].slice(0, 2).join("") || "•";
}
function avatarColor(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) | 0;
  return Math.abs(hash) % 8;
}
