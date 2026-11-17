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
import { BOOK_POOL } from "./book-pipeline-run";

/**
 * The card shown when "Picture book" is pressed (block 1): what will happen, about how long and how many AI calls, which model each
 * step uses, and the six whole-book settings (collapsed, may stay empty). The only decisions are Start and Cancel.
 */

/** The median wall time of one card in a live run (stage 7 measurement). The estimate says "about"; T2 live runs may recalibrate it. */
export const BOOK_CARD_P50_SECONDS = 88.5;
/** The whole-book plan before the first card: about 135 seconds (stage 7 measurement: the plan took 2m15s). */
export const BOOK_PLAN_SECONDS = 135;

export interface BookStartEstimate {
  cards: number;
  /** One whole-book plan, then plan, write, find pictures and proofread for each card. */
  calls: number;
  /** The plan, then cards run {@link BOOK_POOL} at a time, each taking about the measured median. */
  seconds: number;
}
export function bookStartEstimate(cards: number): BookStartEstimate {
  const n = Math.max(0, Math.floor(cards));
  return { cards: n, calls: 1 + 4 * n, seconds: BOOK_PLAN_SECONDS + Math.ceil(n / BOOK_POOL) * BOOK_CARD_P50_SECONDS };
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
 * What the owner changed in the six fields, for the root topic: only a field whose text differs from the current value is written;
 * a field cleared by the owner is removed (null). A field left alone is not in the patch, so nothing the owner did not touch is rewritten.
 */
export function bookSettingsPatch(
  current: BookSettings,
  typed: Partial<Record<BookSettingField, string>>
): BookSettingsPatch {
  const patch: BookSettingsPatch = {};
  const squash = (value: string): string => value.replace(/\s+/g, " ").trim();
  for (const field of BOOK_SETTING_FIELDS) {
    const raw = typed[field];
    if (raw === undefined || squash(raw) === (current[field] ?? "")) continue;
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
export interface BookStartInput {
  cards: number;
  /** Display names of the models the four steps use (from the settings). */
  models: BookStartModels;
  /** The root topic's current whole-book settings, shown in the fields. */
  settings: BookSettings;
  /** Called once, after the card closed, with what the owner changed (possibly nothing). */
  onStart: (patch: BookSettingsPatch) => void;
}

const FIELD_LABEL: Record<BookSettingField, TranslationKey> = {
  reader: "coffee.book_reader",
  goal: "coffee.book_goal",
  angle: "coffee.book_angle",
  tone: "coffee.book_tone",
  length: "coffee.book_length",
  style: "coffee.book_style"
};

export class BookStartModal extends Modal {
  private started = false;
  private opened = false;
  private focusTimer: number | null = null;
  private fields = new Map<BookSettingField, HTMLTextAreaElement>();
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
  onOpen(): void {
    this.opened = true;
    const { contentEl } = this;
    this.titleEl.setText(t("ui.book_start_title"));
    contentEl.createEl("p", { cls: "vam-modal-intro", text: t("ui.book_start_intro") });
    const estimate = contentEl.createEl("p", {
      cls: "vam-book-start-estimate",
      text: bookStartEstimateText(bookStartEstimate(this.input.cards))
    });
    estimate.setAttr("role", "status");
    contentEl.createEl("p", { cls: "vam-book-start-stops", text: t("ui.book_start_stops") });
    const models = contentEl.createEl("ul", { cls: "vam-book-start-models" });
    models.setAttr("aria-label", t("ui.book_start_models_label"));
    const rows: [TranslationKey, string][] = [
      ["ui.book_step_plan", this.input.models.plan],
      ["ui.book_step_write", this.input.models.write],
      ["ui.book_progress_step_images", this.input.models.images],
      ["ui.book_step_proof", this.input.models.proof]
    ];
    for (const [key, model] of rows) models.createEl("li", { text: t("ui.book_start_model_0_1", t(key), model) });
    const details = contentEl.createEl("details", { cls: "vam-book-start-settings" });
    details.createEl("summary", { text: t("ui.book_start_settings") });
    for (const field of BOOK_SETTING_FIELDS) {
      const label = t(FIELD_LABEL[field]);
      const id = `vam-book-start-${field}`;
      details.createEl("label", { text: label, attr: { for: id } });
      const area = details.createEl("textarea", {
        cls: "vam-book-start-field",
        attr: {
          id,
          rows: "2",
          maxlength: String(BOOK_SETTING_INPUT_MAX),
          "aria-label": label,
          placeholder: t("coffee.book_setting_empty")
        }
      });
      area.value = this.input.settings[field] ?? "";
      this.fields.set(field, area);
    }
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
  onClose(): void {
    this.opened = false;
    if (this.focusTimer !== null) window.clearTimeout(this.focusTimer);
    this.focusTimer = null;
    this.contentEl.empty();
  }
  private start(): void {
    if (this.started) return;
    this.started = true;
    const typed: Partial<Record<BookSettingField, string>> = {};
    for (const [field, area] of this.fields) typed[field] = area.value;
    const patch = bookSettingsPatch(this.input.settings, typed);
    this.close();
    this.input.onStart(patch);
  }
}
