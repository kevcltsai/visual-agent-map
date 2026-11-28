import { App, Modal, displayTooltip, setTooltip } from "obsidian";
import { t, type TranslationKey } from "../../i18n";
import { modalActions } from "../../ui/modals/action-bar";
import {
  BOOK_EXPAND_PASSES,
  BOOK_SETTING_FIELDS,
  DEFAULT_BUDGET_LIMIT,
  MAX_AI_FIX_ROUNDS,
  MAX_AUTO_FIXES,
  type BookSettingField,
  type BookSettings,
  type BookSettingsPatch
} from "../../core/book-pipeline/model";
import { BOOK_SETTING_INPUT_MAX, cleanBookSettingsInput } from "../../core/book-pipeline/settings";
import { PLAN_EDIT_MIN_CARDS } from "../../core/book-pipeline/machine";
import { syncModelSelect } from "../../core/model-discovery";
import { BOOK_POOL, LOOKS_PER_CHAPTER } from "./book-pipeline-run";
import {
  EDIT_MESSAGE_CHARS,
  type EditSettingsResult,
  type EditSettingsTurn
} from "../../core/steps/book-pipeline/edit-settings";

/**
 * The card shown when "Picture book" is pressed: what will happen, about how long and how many AI calls, the model of each
 * step (four dropdowns, always shown, below the estimate), and the six whole-book settings (always open; a grey italic suggestion
 * shows in an empty field and is used when the field stays empty). The only decisions are Start and Cancel.
 */

/** How long the start card waits for its grey suggestions before it stays blank. */
export const BOOK_SUGGEST_TIMEOUT_MS = 20_000;

/** How long one turn with the chief editor waits before it is dropped as failed. */
export const BOOK_EDIT_TIMEOUT_MS = 60_000;

/**
 * One AI call of each step, measured in a live full run (2026-11-20, 15 chapters; the 75th percentile of each step's call time) with the
 * model it was measured on. Another model scales the time by {@link bookModelSpeed}.
 */
export const BOOK_STEP_SECONDS: Record<"global" | keyof BookStartModels, { seconds: number; model: string }> = {
  global: { seconds: 20, model: "opus" },
  plan: { seconds: 20, model: "opus" },
  write: { seconds: 63, model: "sonnet" },
  images: { seconds: 55, model: "haiku" },
  proof: { seconds: 19, model: "sonnet" }
};
/** The first write of a chapter is followed by up to two picture searches (the second only when the first finds too little). */
export const BOOK_IMAGE_SEARCHES = 2;
/** Each picture search may be asked once more when its captions come back in another language. */
export const BOOK_IMAGE_CALLS_PER_SEARCH = 2;

/*
 * The cover adds nothing to the estimate: a chapter's or section's cover rides in the first picture search the card already makes, and the
 * book's own cover (a root with no picture slots) is one search plus its caption-language retry, 2 calls, inside the 4 picture calls
 * bookChapterCalls() already reserves for every card. So the estimate stays the real maximum, 7 + 20 n (6 + 20 n below three cards, where there is no plan edit);
 * the 20 is the 16 plus the {@link LOOKS_PER_CHAPTER} picture looks plus the one diagram call.
 */

export { BOOK_EXPAND_PASSES };

/**
 * The AI calls of one chapter at most, step by step: one plan, then each write (the first and the {@link MAX_AUTO_FIXES} automatic
 * redo) runs the author and the author's own check; the {@link BOOK_EXPAND_PASSES} expand passes add writing calls. Only the first
 * write searches for pictures (the redo and the expand passes edit the chapter in place and keep its pictures): the searches, each
 * with its caption-language retry. Then the AI proofread: one check and up to {@link MAX_AI_FIX_ROUNDS}
 * rounds of one fix and one more check. The picture looks ({@link LOOKS_PER_CHAPTER} a chapter at most, over both searches) are one call each, and a chapter
 * whose diagram-kind slots stay empty asks for diagrams once (counted even with diagrams off: still an upper bound). Failed-step retries are not in it.
 */
export function bookChapterCalls(): {
  plan: number;
  write: number;
  images: number;
  look: number;
  diagram: number;
  proof: number;
  aiProof: number;
} {
  const writes = 1 + MAX_AUTO_FIXES;
  return {
    plan: 1,
    write: writes + BOOK_EXPAND_PASSES,
    images: BOOK_IMAGE_SEARCHES * BOOK_IMAGE_CALLS_PER_SEARCH,
    look: LOOKS_PER_CHAPTER,
    diagram: 1,
    proof: writes,
    aiProof: 1 + 2 * MAX_AI_FIX_ROUNDS
  };
}

/**
 * The whole-book layer at most: the whole-book plan, the chief editor's one pass over the plans (with {@link PLAN_EDIT_MIN_CARDS} cards or
 * more), and (with two chapters to compare) the whole-book AI proofread with its fix rounds.
 */
export function bookWholeCalls(cards: number): number {
  return 1 + (cards >= PLAN_EDIT_MIN_CARDS ? 1 : 0) + (cards >= 2 ? 1 + 2 * MAX_AI_FIX_ROUNDS : 0);
}

export interface BookStartEstimate {
  cards: number;
  /** An upper bound of a run with no failed step: the whole-book plan, then {@link bookChapterCalls} for each card. */
  calls: number;
  /** The run's call budget: it pauses there whatever happens (failed-step retries included). */
  limit: number;
  /** The plan, then the trial cards and the rest {@link BOOK_POOL} at a time, each card with its redo and both searches (no language retry). */
  seconds: number;
}
/** Time relative to a Sonnet-class model (an assumption, not a measurement): Haiku is about twice as fast, Opus slower. Calls do not change with the model. */
export function bookModelSpeed(model: string): number {
  const id = model.toLowerCase();
  return id.includes("haiku") ? 0.5 : id.includes("opus") ? 1.8 : 1;
}
/** `trialCards`: how many of the cards the trial covers (the preface, chapter 1 and its sections). */
export function bookStartEstimate(cards: number, trialCards: number, models?: BookStartModels): BookStartEstimate {
  const n = Math.max(0, Math.floor(cards));
  const time = (step: keyof typeof BOOK_STEP_SECONDS): number => {
    const measured = BOOK_STEP_SECONDS[step];
    const model = step === "global" ? models?.plan : models?.[step];
    return measured.seconds * (model ? bookModelSpeed(model) / bookModelSpeed(measured.model) : 1);
  };
  const per = bookChapterCalls();
  const writes = 1 + MAX_AUTO_FIXES;
  // The AI proofread of a chapter (and of the whole book): one check, then per fix round one fix (the author) and one more check.
  // Not measured: each check is timed like one author's check and each fix like one write (an assumption).
  const aiProof = time("proof") + MAX_AI_FIX_ROUNDS * (time("write") + time("proof"));
  const perCard =
    time("plan") +
    writes * (time("write") + time("proof")) +
    BOOK_IMAGE_SEARCHES * time("images") +
    LOOKS_PER_CHAPTER * time("images") +
    BOOK_EXPAND_PASSES * time("write") +
    aiProof;
  // The trial cards run first, the rest follow, BOOK_POOL at a time (nothing waits for the owner any more).
  const trial = Math.min(n, Math.max(0, Math.floor(trialCards)));
  const rounds = Math.ceil(trial / BOOK_POOL) + Math.ceil((n - trial) / BOOK_POOL);
  return {
    cards: n,
    // The whole-book plan and proofread, and every chapter's calls: an upper bound.
    calls:
      bookWholeCalls(n) + n * (per.plan + per.write + per.images + per.look + per.diagram + per.proof + per.aiProof),
    limit: DEFAULT_BUDGET_LIMIT,
    seconds: time("global") + (n >= PLAN_EDIT_MIN_CARDS ? time("plan") : 0) + rounds * perCard + (n >= 2 ? aiProof : 0)
  };
}
/** The one cost line: cards, about how long, about how many AI calls (the breakdown, the retry note and the pause limit are not shown). */
export function bookStartEstimateText(estimate: BookStartEstimate): string {
  const minutes = Math.round(estimate.seconds / 60);
  const time = minutes < 1 ? t("ui.book_start_under_minute") : t("ui.book_start_minutes_0", minutes);
  return t("ui.book_start_estimate_0_1_2", estimate.cards, time, estimate.calls);
}

/**
 * What to write to the root topic: a field whose text differs from the current value is written; a field cleared by the owner is
 * removed (null); a field that is empty now and was empty before and has a suggestion takes the suggestion. A field left alone is
 * not in the patch, so nothing the owner did not touch is rewritten, and typed text is never replaced by a suggestion.
 */
export function bookSettingsPatch(
  current: BookSettings,
  typed: Partial<Record<BookSettingField, string>>,
  suggestions: BookSettings = {}
): BookSettingsPatch {
  const patch: BookSettingsPatch = {};
  const squash = (value: string): string => value.replace(/\s+/g, " ").trim();
  for (const field of BOOK_SETTING_FIELDS) {
    const raw = typed[field];
    if (raw === undefined) continue;
    if (!squash(raw) && !current[field] && suggestions[field]) {
      const suggested = cleanBookSettingsInput({ [field]: suggestions[field] })[field];
      if (suggested) patch[field] = suggested;
      continue;
    }
    if (squash(raw) === (current[field] ?? "")) continue;
    patch[field] = cleanBookSettingsInput({ [field]: raw })[field] ?? null;
  }
  return patch;
}

export interface BookStartModels {
  plan: string;
  write: string;
  images: string;
  proof: string;
}
/** The settings key of each step's model (the settings page uses the same keys). */
export type BookModelKey = "bookPlanModel" | "bookWriteModel" | "bookImageModel" | "bookProofModel";
const MODEL_ROWS: { key: BookModelKey; step: keyof BookStartModels; label: TranslationKey; tip: TranslationKey }[] = [
  { key: "bookPlanModel", step: "plan", label: "ui.book_step_plan", tip: "ui.book_start_tip_plan" },
  { key: "bookWriteModel", step: "write", label: "ui.book_step_write", tip: "ui.book_start_tip_write" },
  { key: "bookImageModel", step: "images", label: "ui.book_progress_step_images", tip: "ui.book_start_tip_images" },
  { key: "bookProofModel", step: "proof", label: "ui.book_step_ai_proof", tip: "ui.book_start_tip_proof" }
];
export interface BookModelChoiceInput {
  /** The model id each step uses now. */
  models: BookStartModels;
  /** The same list and labels as the AI model dropdown. */
  options: () => string[];
  label: (model: string) => string;
  /** The owner picked a model for a step: save it (the settings page keeps the same values). */
  onChange: (key: BookModelKey, model: string) => void;
}

export interface BookStartInput {
  cards: number;
  /** How many of the cards the trial covers (`bookStructure().trialOf()`). */
  trialCards: number;
  /** The preface + chapters + sections (`bookStructure()`); no longer shown: the cost line names the card count only. */
  structure?: { chapters: number; sections: number };
  /** The model ids the four steps use (from the settings). */
  models: BookStartModels;
  /** Lists and labels for the four dropdowns, and where a pick is saved. */
  modelChoice: Omit<BookModelChoiceInput, "models">;
  /** The root topic's current whole-book settings, shown in the fields. */
  settings: BookSettings;
  /** Titles of chapters that were in the book and are no longer on the map: a field that names one gets a warning line (never blocks). */
  deletedChapterTitles?: readonly string[];
  /** Titles of the chapters still on the map (a mention of one is not a mention of a deleted chapter inside it). */
  chapterTitles?: readonly string[];
  /**
   * One turn with the chief editor (the chat beside the fields; no chat without it). `settings` is what the fields show (typed text, else the grey
   * suggestion). The call is dropped by `signal` when the card closes, Start is pressed or {@link BOOK_EDIT_TIMEOUT_MS} passes.
   */
  editSettings?: (
    request: { message: string; settings: BookSettings; turns: EditSettingsTurn[]; model: string },
    signal: AbortSignal
  ) => Promise<EditSettingsResult>;
  /** Called once, after the card closed, with what the owner changed and the suggestions to take (possibly nothing), and the four models picked in the card (saved only now, never by a Cancel). */
  onStart: (patch: BookSettingsPatch, models: BookStartModels) => void;
  /** Called when the card closes for any reason: a suggestion still being made is dropped. */
  onClose?: () => void;
}

const FIELD_LABEL: Record<BookSettingField, TranslationKey> = {
  reader: "ui.book_setting_reader",
  goal: "ui.book_setting_goal",
  angle: "ui.book_setting_angle",
  tone: "ui.book_setting_tone",
  length: "ui.book_setting_length",
  style: "ui.book_setting_style"
};

/** A read-only look at a book's six settings (the bar's "Book settings"): a field with no value shows the empty-field line. */
export class BookSettingsViewModal extends Modal {
  constructor(
    app: App,
    private values: BookSettings
  ) {
    super(app);
  }
  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("vam-tokens");
    this.titleEl.setText(t("ui.book_settings_view"));
    const list = contentEl.createEl("dl", { cls: "vam-book-settings-list" });
    for (const field of BOOK_SETTING_FIELDS) {
      list.createEl("dt", { text: t(FIELD_LABEL[field]) });
      const value = this.values[field]?.trim();
      list.createEl("dd", { text: value || t("ui.book_setting_empty"), cls: value ? "" : "is-empty" });
    }
    contentEl.createEl("p", { cls: "vam-modal-intro", text: t("ui.book_settings_view_hint") });
    const actions = modalActions(this);
    const close = actions.createEl("button", { text: t("ui.close") });
    close.addEventListener("click", () => this.close());
    close.focus();
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

export interface BookSettingsFields {
  areas: Map<BookSettingField, HTMLTextAreaElement>;
  /** Each field's label (the start card hangs its "chief editor changed this" mark on it). */
  labels: Map<BookSettingField, HTMLElement>;
  /** Show these as grey italic suggestions in the fields that are empty; typed text is never touched. */
  suggest: (suggestions: BookSettings) => void;
}
/**
 * The deleted chapters' titles a field's text mentions (a title of one letter is too common to mean a chapter). The titles of the
 * chapters still on the map are taken out of the text first, longest first, so "研磨與萃取" does not count as a mention of a deleted "研磨".
 */
export function mentionedDeletedChapters(
  text: string,
  deletedTitles: readonly string[],
  existingTitles: readonly string[] = []
): string[] {
  let lower = text.toLowerCase();
  const present = existingTitles.map(title => title.trim().toLowerCase()).filter(Boolean);
  for (const title of present.sort((a, b) => b.length - a.length)) lower = lower.split(title).join(" ");
  return deletedTitles.filter(title => title.trim().length >= 2 && lower.includes(title.trim().toLowerCase()));
}
/** The deleted chapters' titles: in the book's snapshot, whose card is no longer on the map and whose title no chapter on the map has now. */
export function deletedChapterTitles(
  snapshot: Record<string, { title: string }> | undefined,
  currentTitles: ReadonlyMap<string, string>
): string[] {
  if (!snapshot) return [];
  const present = new Set([...currentTitles.values()].map(title => title.trim().toLowerCase()));
  const out: string[] = [];
  for (const [id, { title }] of Object.entries(snapshot)) {
    const clean = title.trim();
    if (currentTitles.has(id) || !clean || present.has(clean.toLowerCase()) || out.includes(clean)) continue;
    out.push(clean);
  }
  return out;
}
/** The six whole-book fields, always open, prefilled with `current`. Shared with the trial-confirmation screen. */
export function renderBookSettingsFields(
  parent: HTMLElement,
  current: BookSettings,
  deletedTitles: readonly string[] = [],
  chapterTitles: readonly string[] = []
): BookSettingsFields {
  const areas = new Map<BookSettingField, HTMLTextAreaElement>();
  const labels = new Map<BookSettingField, HTMLElement>();
  for (const field of BOOK_SETTING_FIELDS) {
    const label = t(FIELD_LABEL[field]);
    const id = `vam-book-start-${field}`;
    labels.set(field, parent.createEl("label", { text: label, attr: { for: id } }));
    // The shimmer after the field shows over it while loading and the field is empty (CSS only; typing hides it).
    const wrap = parent.createDiv({ cls: "vam-book-start-field-wrap" });
    const area = wrap.createEl("textarea", {
      cls: "vam-book-start-field",
      attr: {
        id,
        rows: "2",
        maxlength: String(BOOK_SETTING_INPUT_MAX),
        "aria-label": label,
        placeholder: t("ui.book_setting_empty")
      }
    });
    wrap.createSpan({ cls: "vam-book-start-shimmer", attr: { "aria-hidden": "true" } });
    area.value = current[field] ?? "";
    areas.set(field, area);
    // The warning line follows the text as it is edited; it only informs.
    const hint = parent.createEl("p", { cls: "vam-book-start-hint", attr: { id: `${id}-hint`, role: "status" } });
    const refresh = (): void => {
      const found = mentionedDeletedChapters(area.value, deletedTitles, chapterTitles);
      hint.setText(
        found.length
          ? `${t("ui.book_deleted_chapter_hint_0", found.join("、"))}\n${t("ui.book_deleted_chapter_hint_keep")}`
          : ""
      );
      hint.toggleClass("is-empty", !found.length);
    };
    if (deletedTitles.length) {
      area.setAttr("aria-describedby", `${id}-hint`);
      area.addEventListener("input", refresh);
    }
    refresh();
  }
  return {
    areas,
    labels,
    suggest: suggestions => {
      for (const [field, area] of areas) {
        const text = suggestions[field];
        if (!text || area.value.trim()) continue;
        area.setAttr("placeholder", text);
        area.addClass("vam-book-start-suggested");
      }
    }
  };
}

/** The four model dropdowns (plan, author, pictures, proofread). Shared with the trial-confirmation screen. */
export function renderBookModelChoice(parent: HTMLElement, input: BookModelChoiceInput): void {
  let warning: HTMLElement | null = null;
  // The AI proofread works best with a model other than the author's: a reminder (never a block) while they are the same.
  const refreshWarning = (): void => {
    warning?.setText(input.models.proof === input.models.write ? t("ui.book_start_proof_same_as_author") : "");
  };
  for (const row of MODEL_ROWS) {
    const id = `vam-book-start-model-${row.step}`;
    const name = t(row.label);
    // The label and an ⓘ that says what the step does (hover, or keyboard focus).
    const head = parent.createDiv({ cls: "vam-book-start-model-label" });
    head.createEl("label", { text: name, attr: { for: id } });
    const tip = t(row.tip);
    const info = head.createSpan({
      cls: "vam-book-start-info",
      text: "ⓘ",
      attr: { tabindex: "0", role: "img", "aria-label": tip }
    });
    setTooltip(info, tip);
    info.addEventListener("focus", () => displayTooltip(info, tip));
    const select = parent.createEl("select", {
      cls: "dropdown vam-book-start-model",
      attr: { id, "aria-label": name }
    });
    const selected = input.models[row.step];
    select.add(new Option(selected, selected));
    select.value = selected;
    syncModelSelect(select, input.options(), input.label, t("ui.current_model_is_unavailable"));
    select.addEventListener("change", () => {
      if (!select.value) return;
      input.models[row.step] = select.value;
      refreshWarning();
      input.onChange(row.key, select.value);
    });
    if (row.step === "proof") {
      warning = parent.createSpan({ cls: "vam-book-start-model-warning" });
      warning.setAttr("role", "status");
    }
  }
  refreshWarning();
}

export class BookStartModal extends Modal {
  private started = false;
  private opened = false;
  private focusTimer: number | null = null;
  private fields: BookSettingsFields | null = null;
  private suggested: BookSettings = {};
  private suggestingEl: HTMLElement | null = null;
  private settingsEl: HTMLElement | null = null;
  private estimateEl: HTMLElement | null = null;
  /** The chat with the chief editor (only with `editSettings`): the turn in flight, the finished turns, and what each field was set to by the editor. */
  private pending: AbortController | null = null;
  private pendingTimer: number | null = null;
  private turns: EditSettingsTurn[] = [];
  private marks = new Map<BookSettingField, { written: string; chip: HTMLElement | null }>();
  private chatLog: HTMLElement | null = null;
  private chatInput: HTMLInputElement | null = null;
  private chatSend: HTMLButtonElement | null = null;
  private chatBusy: HTMLElement | null = null;
  constructor(
    app: App,
    private input: BookStartInput
  ) {
    super(app);
  }
  /** True from open to close (the screen opens one card at a time). Not named isOpen: Obsidian's Modal writes that property itself. */
  get isShown(): boolean {
    return this.opened;
  }
  /** The suggestion arrived (or did not): the fields show it in grey; a card already started or closed ignores it. */
  setSuggestions(suggestions: BookSettings | null): void {
    if (!this.opened || this.started) return;
    this.settingsEl?.removeClass("is-loading");
    this.suggestingEl?.remove();
    this.suggestingEl = null;
    this.refreshSend();
    if (!suggestions) return;
    for (const field of BOOK_SETTING_FIELDS) {
      const text = suggestions[field];
      // Only a field that really shows the suggestion as its placeholder: a prefilled field or one typed in before the answer is not recorded.
      const typedNow = this.fields?.areas.get(field)?.value.trim();
      if (text && !this.input.settings[field]?.trim() && !typedNow) this.suggested[field] = text;
    }
    this.fields?.suggest(this.suggested);
    this.refreshSend();
  }
  onOpen(): void {
    this.opened = true;
    const { contentEl } = this;
    contentEl.addClass("vam-tokens");
    this.titleEl.setText(t("ui.book_start_title"));
    contentEl.createEl("p", { cls: "vam-modal-intro", text: t("ui.book_start_intro") });
    this.estimateEl = contentEl.createEl("p", { cls: "vam-book-start-estimate" });
    this.estimateEl.setAttr("role", "status");
    const choice = contentEl.createDiv({ cls: "vam-book-start-model-choice" });
    renderBookModelChoice(choice, {
      ...this.input.modelChoice,
      models: this.input.models,
      // A pick only changes this card's copy; it is saved when Start is pressed.
      onChange: () => this.refreshEstimate()
    });
    const settings = contentEl.createDiv({ cls: "vam-book-start-settings" });
    settings.setAttr("role", "group");
    settings.setAttr("aria-label", t("ui.book_start_settings"));
    settings.createEl("strong", { text: t("ui.book_start_settings") });
    // While the suggestions are being made: a spinner beside the line and a shimmer in each empty field (CSS, .is-loading).
    this.suggestingEl = settings.createEl("p", { cls: "vam-book-start-suggesting" });
    this.suggestingEl.createSpan({ cls: "vam-book-start-spinner", attr: { "aria-hidden": "true" } });
    this.suggestingEl.createSpan({ text: t("ui.book_start_suggesting") });
    this.suggestingEl.setAttr("role", "status");
    settings.addClass("is-loading");
    this.settingsEl = settings;
    const split = this.input.editSettings ? settings.createDiv({ cls: "vam-book-start-split" }) : null;
    if (split) this.renderChat(split.createDiv({ cls: "vam-book-start-chat" }));
    this.fields = renderBookSettingsFields(
      split ? split.createDiv({ cls: "vam-book-start-fields" }) : settings,
      this.input.settings,
      this.input.deletedChapterTitles,
      this.input.chapterTitles
    );
    for (const [field, area] of this.fields.areas) area.addEventListener("input", () => this.refreshMark(field));
    this.refreshEstimate();
    const actions = modalActions(this);
    const cancel = actions.createEl("button", { text: t("ui.cancel") });
    cancel.addEventListener("click", () => this.close());
    const start = actions.createEl("button", { cls: "mod-cta vam-book-start-go", text: t("ui.book_start_go") });
    start.addEventListener("click", () => this.start());
    // The run costs AI calls: the keyboard starts on Cancel, so a stray Enter never starts it. Obsidian may move focus after onOpen.
    cancel.focus();
    this.focusTimer = window.setTimeout(() => {
      this.focusTimer = null;
      cancel.focus();
    }, 0);
  }
  /** What the fields show now: typed text, else the grey suggestion, else nothing. This is what the chief editor is told. */
  private visibleSettings(): BookSettings {
    const out: BookSettings = {};
    for (const [field, area] of this.fields?.areas ?? []) {
      const value = area.value.trim() || this.suggested[field] || "";
      if (value) out[field] = value;
    }
    return out;
  }
  /** The "chief editor changed this" mark follows the field: it stays while the text is still what the editor wrote and goes with a hand edit or an undo. */
  private refreshMark(field: BookSettingField): void {
    const mark = this.marks.get(field);
    const label = this.fields?.labels.get(field);
    if (!mark || !label) return;
    const on = !!mark.written && this.fields?.areas.get(field)?.value === mark.written;
    if (on && !mark.chip)
      mark.chip = label.createSpan({ cls: "vam-book-start-edited", text: t("ui.book_chat_edited") });
    if (!on && mark.chip) {
      mark.chip.remove();
      mark.chip = null;
    }
  }
  private renderChat(parent: HTMLElement): void {
    parent.createEl("label", { text: t("ui.book_chat_label"), attr: { for: "vam-book-chat-input" } });
    const log = parent.createDiv({ cls: "vam-book-chat-log", attr: { role: "log", "aria-live": "polite" } });
    this.chatLog = log;
    this.chatBusy = parent.createEl("p", { cls: "vam-book-chat-busy is-empty", attr: { role: "status" } });
    const row = parent.createDiv({ cls: "vam-book-chat-row" });
    const box = row.createEl("input", {
      cls: "vam-book-chat-input",
      attr: {
        id: "vam-book-chat-input",
        type: "text",
        maxlength: String(EDIT_MESSAGE_CHARS),
        placeholder: t("ui.book_chat_placeholder")
      }
    });
    const send = row.createEl("button", { cls: "mod-cta vam-book-chat-send", text: t("ui.book_chat_send") });
    this.chatInput = box;
    this.chatSend = send;
    box.addEventListener("input", () => this.refreshSend());
    box.addEventListener("keydown", event => {
      // Enter sends; a key that confirms an IME composition is not a send.
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      this.sendChat();
    });
    send.addEventListener("click", () => this.sendChat());
    this.refreshSend();
  }
  /** One sentence at a time: the send button waits while a turn is in flight or the grey suggestions are still loading. */
  private refreshSend(): void {
    if (!this.chatSend || !this.chatInput) return;
    this.chatSend.disabled = !!this.pending || !!this.suggestingEl || !this.chatInput.value.trim();
  }
  private sendChat(): void {
    const edit = this.input.editSettings;
    const box = this.chatInput;
    if (!edit || !box || this.pending || this.suggestingEl || this.started || !this.opened) return;
    const message = box.value.trim().slice(0, EDIT_MESSAGE_CHARS);
    if (!message) return;
    box.value = "";
    this.chatLog?.createDiv({ cls: "vam-book-chat-me", text: message });
    const run = new AbortController();
    this.pending = run;
    this.chatBusy?.setText(t("ui.book_chat_thinking"));
    this.chatBusy?.removeClass("is-empty");
    this.refreshSend();
    this.pendingTimer = window.setTimeout(() => run.abort(), BOOK_EDIT_TIMEOUT_MS);
    const asked = {
      message,
      settings: this.visibleSettings(),
      turns: this.turns.slice(),
      model: this.input.models.plan
    };
    let call: Promise<EditSettingsResult>;
    try {
      call = edit(asked, run.signal);
    } catch (error) {
      call = Promise.reject(error instanceof Error ? error : new Error("edit failed"));
    }
    const aborted = new Promise<never>((_, reject) =>
      run.signal.addEventListener("abort", () => reject(new Error("edit dropped")), { once: true })
    );
    Promise.race([call, aborted]).then(
      result => {
        // A card that closed, started or moved to another turn ignores a late answer.
        if (this.pending !== run) return;
        this.finishTurn();
        this.applyEdit(message, result);
      },
      () => {
        if (this.pending !== run) return;
        this.finishTurn();
        this.chatLog?.createDiv({ cls: "vam-book-chat-failed", text: t("ui.book_chat_failed") });
      }
    );
    call.catch(() => undefined);
  }
  private finishTurn(): void {
    if (this.pendingTimer !== null) window.clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pending = null;
    this.chatBusy?.setText("");
    this.chatBusy?.addClass("is-empty");
    this.refreshSend();
  }
  /** Stop any turn in flight: its answer, early or late, is dropped. */
  private dropPending(): void {
    const run = this.pending;
    this.pending = null;
    if (this.pendingTimer !== null) window.clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    run?.abort();
  }
  private applyEdit(message: string, result: EditSettingsResult): void {
    const undo: { field: BookSettingField; before: string; written: string }[] = [];
    for (const field of BOOK_SETTING_FIELDS) {
      const text = result.changes[field];
      const area = this.fields?.areas.get(field);
      if (!text || !area) continue;
      undo.push({ field, before: area.value, written: text });
      area.value = text;
      area.removeClass("vam-book-start-suggested");
      this.marks.set(field, { written: text, chip: this.marks.get(field)?.chip ?? null });
      this.refreshMark(field);
    }
    const bubble = this.chatLog?.createDiv({ cls: "vam-book-chat-ed" });
    bubble?.createEl("b", { text: t("ui.book_chat_editor") });
    bubble?.createSpan({ cls: "vam-book-chat-reply", text: result.reply });
    if (bubble && undo.length) {
      const button = bubble.createEl("button", { cls: "vam-book-chat-undo", text: t("ui.book_chat_undo") });
      button.addEventListener("click", () => {
        // Only a field still holding what this turn wrote goes back; a field edited by hand since keeps the hand edit.
        for (const item of undo) {
          const area = this.fields?.areas.get(item.field);
          if (!area || area.value !== item.written) continue;
          area.value = item.before;
          if (!item.before.trim() && this.suggested[item.field]) area.addClass("vam-book-start-suggested");
          this.refreshMark(item.field);
        }
        button.remove();
      });
    }
    this.turns.push({ owner: message, editor: result.reply });
  }
  /** The estimate follows the models in the dropdowns. */
  private refreshEstimate(): void {
    this.estimateEl?.setText(
      bookStartEstimateText(bookStartEstimate(this.input.cards, this.input.trialCards, this.input.models))
    );
  }
  onClose(): void {
    this.opened = false;
    this.dropPending();
    if (this.focusTimer !== null) window.clearTimeout(this.focusTimer);
    this.focusTimer = null;
    this.contentEl.empty();
    this.input.onClose?.();
  }
  private start(): void {
    if (this.started) return;
    this.started = true;
    this.dropPending();
    const typed: Partial<Record<BookSettingField, string>> = {};
    for (const [field, area] of this.fields?.areas ?? []) typed[field] = area.value;
    const patch = bookSettingsPatch(this.input.settings, typed, this.suggested);
    this.close();
    this.input.onStart(patch, { ...this.input.models });
  }
}
