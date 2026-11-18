import { App, Modal } from "obsidian";
import { t, type TranslationKey } from "../../i18n";
import { modalActions } from "../../ui/modals/action-bar";
import {
  BOOK_SETTING_FIELDS,
  type BookSettingField,
  type BookSettings,
  type BookSettingsPatch
} from "../../core/book-pipeline/model";
import { BOOK_SETTING_INPUT_MAX, cleanBookSettingsInput } from "../../core/book-pipeline/settings";
import { syncModelSelect } from "../../core/model-discovery";
import { BOOK_POOL } from "./book-pipeline-run";

/**
 * The card shown when "Picture book" is pressed: what will happen, about how long and how many AI calls, the six whole-book
 * settings (always open; a grey italic suggestion shows in an empty field and is used when the field stays empty), and the model
 * of each step on one line with "Change" opening four dropdowns. The only decisions are Start and Cancel.
 */

/** The median wall time of one card in a live run (stage 7 measurement). The estimate says "about"; T2 live runs may recalibrate it. */
export const BOOK_CARD_P50_SECONDS = 88.5;
/** How long the start card waits for its grey suggestions before it stays blank. */
export const BOOK_SUGGEST_TIMEOUT_MS = 20_000;
/** The whole-book plan before the first card: about 135 seconds (stage 7 measurement: the plan took 2m15s). */
export const BOOK_PLAN_SECONDS = 135;

export interface BookStartEstimate {
  cards: number;
  /** One whole-book plan, then plan, write, find pictures and proofread for each card. */
  calls: number;
  /** The plan, then cards run {@link BOOK_POOL} at a time, each taking about the measured median. */
  seconds: number;
}
/** Time relative to a Sonnet-class model (an assumption, not a measurement): Haiku is about twice as fast, Opus slower. Calls do not change with the model. */
export function bookModelSpeed(model: string): number {
  const id = model.toLowerCase();
  return id.includes("haiku") ? 0.5 : id.includes("opus") ? 1.8 : 1;
}
/** How the time of one card splits over its four steps (they sum to 1). */
const CARD_TIME_SHARE = { plan: 0.1, write: 0.5, images: 0.2, proof: 0.2 };
export function bookStartEstimate(cards: number, models?: BookStartModels): BookStartEstimate {
  const n = Math.max(0, Math.floor(cards));
  const speed = (step: keyof BookStartModels): number => (models ? bookModelSpeed(models[step]) : 1);
  const perCard =
    BOOK_CARD_P50_SECONDS *
    (CARD_TIME_SHARE.plan * speed("plan") +
      CARD_TIME_SHARE.write * speed("write") +
      CARD_TIME_SHARE.images * speed("images") +
      CARD_TIME_SHARE.proof * speed("proof"));
  return {
    cards: n,
    calls: 1 + 4 * n,
    seconds: BOOK_PLAN_SECONDS * speed("plan") + Math.ceil(n / BOOK_POOL) * perCard
  };
}
export function bookStartEstimateText(estimate: BookStartEstimate): string {
  const minutes = Math.round(estimate.seconds / 60);
  return t(
    "ui.book_start_estimate_0_1_2",
    estimate.cards,
    minutes < 1 ? t("ui.book_start_under_minute") : t("ui.book_start_minutes_0", minutes),
    estimate.calls
  );
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
const MODEL_ROWS: { key: BookModelKey; step: keyof BookStartModels; label: TranslationKey }[] = [
  { key: "bookPlanModel", step: "plan", label: "ui.book_step_plan" },
  { key: "bookWriteModel", step: "write", label: "ui.book_step_write" },
  { key: "bookImageModel", step: "images", label: "ui.book_progress_step_images" },
  { key: "bookProofModel", step: "proof", label: "ui.book_step_proof" }
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
  /** The model ids the four steps use (from the settings). */
  models: BookStartModels;
  /** Lists and labels for the four dropdowns, and where a pick is saved. */
  modelChoice: Omit<BookModelChoiceInput, "models">;
  /** The root topic's current whole-book settings, shown in the fields. */
  settings: BookSettings;
  /** Called once, after the card closed, with what the owner changed and the suggestions to take (possibly nothing). */
  onStart: (patch: BookSettingsPatch) => void;
  /** Called when the card closes for any reason: a suggestion still being made is dropped. */
  onClose?: () => void;
}

const FIELD_LABEL: Record<BookSettingField, TranslationKey> = {
  reader: "coffee.book_reader",
  goal: "coffee.book_goal",
  angle: "coffee.book_angle",
  tone: "coffee.book_tone",
  length: "coffee.book_length",
  style: "coffee.book_style"
};

export interface BookSettingsFields {
  areas: Map<BookSettingField, HTMLTextAreaElement>;
  /** Show these as grey italic suggestions in the fields that are empty; typed text is never touched. */
  suggest: (suggestions: BookSettings) => void;
}
/** The six whole-book fields, always open, prefilled with `current`. Shared with the trial-confirmation screen. */
export function renderBookSettingsFields(parent: HTMLElement, current: BookSettings): BookSettingsFields {
  const areas = new Map<BookSettingField, HTMLTextAreaElement>();
  for (const field of BOOK_SETTING_FIELDS) {
    const label = t(FIELD_LABEL[field]);
    const id = `vam-book-start-${field}`;
    parent.createEl("label", { text: label, attr: { for: id } });
    const area = parent.createEl("textarea", {
      cls: "vam-book-start-field",
      attr: {
        id,
        rows: "2",
        maxlength: String(BOOK_SETTING_INPUT_MAX),
        "aria-label": label,
        placeholder: t("coffee.book_setting_empty")
      }
    });
    area.value = current[field] ?? "";
    areas.set(field, area);
  }
  return {
    areas,
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

/** "Model: Plan X, Author Y, ..." in one line. */
export function bookModelSummary(models: BookStartModels, label: (model: string) => string): string {
  return t(
    "ui.book_start_models_summary_0_1_2_3",
    label(models.plan),
    label(models.write),
    label(models.images),
    label(models.proof)
  );
}
/** The four model dropdowns (plan, author, pictures, proofread). Shared with the trial-confirmation screen. */
export function renderBookModelChoice(parent: HTMLElement, input: BookModelChoiceInput): void {
  for (const row of MODEL_ROWS) {
    const id = `vam-book-start-model-${row.step}`;
    const name = t(row.label);
    parent.createEl("label", { text: name, attr: { for: id } });
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
      input.onChange(row.key, select.value);
    });
  }
}

export class BookStartModal extends Modal {
  private started = false;
  private opened = false;
  private focusTimer: number | null = null;
  private fields: BookSettingsFields | null = null;
  private suggested: BookSettings = {};
  private suggestingEl: HTMLElement | null = null;
  private estimateEl: HTMLElement | null = null;
  private modelSummaryEl: HTMLElement | null = null;
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
    this.suggestingEl?.remove();
    this.suggestingEl = null;
    if (!suggestions) return;
    for (const field of BOOK_SETTING_FIELDS) {
      const text = suggestions[field];
      // Only a field that really shows the suggestion as its placeholder: a prefilled field or one typed in before the answer is not recorded.
      const typedNow = this.fields?.areas.get(field)?.value.trim();
      if (text && !this.input.settings[field]?.trim() && !typedNow) this.suggested[field] = text;
    }
    this.fields?.suggest(this.suggested);
  }
  onOpen(): void {
    this.opened = true;
    const { contentEl } = this;
    this.titleEl.setText(t("ui.book_start_title"));
    contentEl.createEl("p", { cls: "vam-modal-intro", text: t("ui.book_start_intro") });
    this.estimateEl = contentEl.createEl("p", { cls: "vam-book-start-estimate" });
    this.estimateEl.setAttr("role", "status");
    contentEl.createEl("p", { cls: "vam-book-start-stops", text: t("ui.book_start_stops") });
    contentEl.createEl("p", { cls: "vam-book-start-stops", text: t("ui.book_start_rerun_hint") });
    const settings = contentEl.createDiv({ cls: "vam-book-start-settings" });
    settings.setAttr("role", "group");
    settings.setAttr("aria-label", t("ui.book_start_settings"));
    settings.createEl("strong", { text: t("ui.book_start_settings") });
    this.suggestingEl = settings.createEl("p", {
      cls: "vam-book-start-suggesting",
      text: t("ui.book_start_suggesting")
    });
    this.suggestingEl.setAttr("role", "status");
    this.fields = renderBookSettingsFields(settings, this.input.settings);
    const models = contentEl.createDiv({ cls: "vam-book-start-models" });
    this.modelSummaryEl = models.createSpan({ cls: "vam-book-start-models-summary" });
    const change = models.createEl("button", {
      cls: "vam-book-start-models-change",
      text: t("ui.book_start_models_change")
    });
    change.setAttr("aria-expanded", "false");
    const choice = contentEl.createDiv({ cls: "vam-book-start-model-choice" });
    choice.hidden = true;
    renderBookModelChoice(choice, {
      ...this.input.modelChoice,
      models: this.input.models,
      onChange: (key, model) => {
        this.input.modelChoice.onChange(key, model);
        this.refreshModels();
      }
    });
    change.addEventListener("click", () => {
      choice.hidden = !choice.hidden;
      change.setAttr("aria-expanded", String(!choice.hidden));
    });
    this.refreshModels();
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
  /** The summary line and the estimate follow the models in the dropdowns. */
  private refreshModels(): void {
    this.estimateEl?.setText(bookStartEstimateText(bookStartEstimate(this.input.cards, this.input.models)));
    this.modelSummaryEl?.setText(bookModelSummary(this.input.models, this.input.modelChoice.label));
  }
  onClose(): void {
    this.opened = false;
    if (this.focusTimer !== null) window.clearTimeout(this.focusTimer);
    this.focusTimer = null;
    this.contentEl.empty();
    this.input.onClose?.();
  }
  private start(): void {
    if (this.started) return;
    this.started = true;
    const typed: Partial<Record<BookSettingField, string>> = {};
    for (const [field, area] of this.fields?.areas ?? []) typed[field] = area.value;
    const patch = bookSettingsPatch(this.input.settings, typed, this.suggested);
    this.close();
    this.input.onStart(patch);
  }
}
