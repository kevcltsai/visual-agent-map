import { App, Modal } from "obsidian";
import { t, type TranslationKey } from "../../i18n";
import { modalActions } from "../../ui/modals/action-bar";
import {
  BOOK_EXPAND_PASSES,
  BOOK_SETTING_FIELDS,
  DEFAULT_BUDGET_LIMIT,
  MAX_AUTO_FIXES,
  TRIAL_SIZE,
  type BookSettingField,
  type BookSettings,
  type BookSettingsPatch
} from "../../core/book-pipeline/model";
import { BOOK_SETTING_INPUT_MAX, cleanBookSettingsInput } from "../../core/book-pipeline/settings";
import { syncModelSelect } from "../../core/model-discovery";
import { BOOK_POOL } from "./book-pipeline-run";

/**
 * The card shown when "Picture book" is pressed: what will happen, about how long and how many AI calls, the model of each
 * step (four dropdowns, always shown, below the estimate), and the six whole-book settings (always open; a grey italic suggestion
 * shows in an empty field and is used when the field stays empty). The only decisions are Start and Cancel.
 */

/** How long the start card waits for its grey suggestions before it stays blank. */
export const BOOK_SUGGEST_TIMEOUT_MS = 20_000;

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
/** One write of a chapter is followed by up to two picture searches (the second only when the first finds too little). */
export const BOOK_IMAGE_SEARCHES = 2;
/** Each picture search may be asked once more when its captions come back in another language. */
export const BOOK_IMAGE_CALLS_PER_SEARCH = 2;

export { BOOK_EXPAND_PASSES };

/**
 * The AI calls of one chapter at most, step by step: one plan, then each write (the first and the {@link MAX_AUTO_FIXES} automatic
 * redo) runs the author, the picture searches (each with its caption-language retry) and the proofread; the
 * {@link BOOK_EXPAND_PASSES} expand passes add writing calls. Failed-step retries are not in it.
 */
export function bookChapterCalls(): { plan: number; write: number; images: number; proof: number } {
  const writes = 1 + MAX_AUTO_FIXES;
  return {
    plan: 1,
    write: writes + BOOK_EXPAND_PASSES,
    images: writes * BOOK_IMAGE_SEARCHES * BOOK_IMAGE_CALLS_PER_SEARCH,
    proof: writes
  };
}

/** What a trial chapter's second fix round adds at most: one write, its picture searches (with language retry) and one proofread. */
export function bookTrialExtraCalls(): number {
  return 1 + BOOK_IMAGE_SEARCHES * BOOK_IMAGE_CALLS_PER_SEARCH + 1;
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
export function bookStartEstimate(cards: number, models?: BookStartModels): BookStartEstimate {
  const n = Math.max(0, Math.floor(cards));
  const time = (step: keyof typeof BOOK_STEP_SECONDS): number => {
    const measured = BOOK_STEP_SECONDS[step];
    const model = step === "global" ? models?.plan : models?.[step];
    return measured.seconds * (model ? bookModelSpeed(model) / bookModelSpeed(measured.model) : 1);
  };
  const per = bookChapterCalls();
  const writes = 1 + MAX_AUTO_FIXES;
  const perCard =
    time("plan") +
    writes * (time("write") + BOOK_IMAGE_SEARCHES * time("images") + time("proof")) +
    BOOK_EXPAND_PASSES * time("write");
  // The trial cards run first and wait for the owner; the rest follow, BOOK_POOL at a time.
  const trial = Math.min(n, TRIAL_SIZE);
  const rounds = Math.ceil(trial / BOOK_POOL) + Math.ceil((n - trial) / BOOK_POOL);
  return {
    cards: n,
    // The global plan, every chapter's calls, and the one whole-book consistency check once there are two chapters to compare.
    // A trial chapter has a second fix round (before and after gate 1): one more write with its searches and proofread each.
    calls: 1 + n * (per.plan + per.write + per.images + per.proof) + trial * bookTrialExtraCalls() + (n >= 2 ? 1 : 0),
    limit: DEFAULT_BUDGET_LIMIT,
    seconds: time("global") + rounds * perCard
  };
}
export function bookStartEstimateText(estimate: BookStartEstimate): string {
  const minutes = Math.round(estimate.seconds / 60);
  return t(
    "ui.book_start_estimate_0_1_2_3",
    estimate.cards,
    minutes < 1 ? t("ui.book_start_under_minute") : t("ui.book_start_minutes_0", minutes),
    estimate.calls,
    estimate.limit
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
  /** Titles of chapters that were in the book and are no longer on the map: a field that names one gets a warning line (never blocks). */
  deletedChapterTitles?: readonly string[];
  /** Titles of the chapters still on the map (a mention of one is not a mention of a deleted chapter inside it). */
  chapterTitles?: readonly string[];
  /** Called once, after the card closed, with what the owner changed and the suggestions to take (possibly nothing), and the four models picked in the card (saved only now, never by a Cancel). */
  onStart: (patch: BookSettingsPatch, models: BookStartModels) => void;
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
    const choice = contentEl.createDiv({ cls: "vam-book-start-model-choice" });
    renderBookModelChoice(choice, {
      ...this.input.modelChoice,
      models: this.input.models,
      // A pick only changes this card's copy; it is saved when Start is pressed.
      onChange: () => this.refreshEstimate()
    });
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
    this.fields = renderBookSettingsFields(
      settings,
      this.input.settings,
      this.input.deletedChapterTitles,
      this.input.chapterTitles
    );
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
  /** The estimate follows the models in the dropdowns. */
  private refreshEstimate(): void {
    this.estimateEl?.setText(bookStartEstimateText(bookStartEstimate(this.input.cards, this.input.models)));
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
    this.input.onStart(patch, { ...this.input.models });
  }
}
