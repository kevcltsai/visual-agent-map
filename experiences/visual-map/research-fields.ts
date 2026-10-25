import { t } from "../../i18n";
import { DEFAULT_MAP_AI_MODE, type MapAiMode } from "./ai-mode";
import { matchPreset, NOTE_STYLE_PRESETS } from "./note-style";

/** Live model choices: the list fills in as model discovery finishes. */
export interface ModelChoices {
  list(): { id: string; label: string }[];
  /** Starts discovery and calls `changed` whenever it updates; returns the unsubscribe function. */
  watch(changed: () => void): () => void;
}

/** The two AI modes in the order shown. */
const AI_MODES: readonly MapAiMode[] = ["quick", "standard"];

/**
 * The one AI-mode choice (Quick / Standard): a two-button radio group with arrow-key movement, and a one-line hint beside
 * it about when to use Standard. The checked state is `aria-checked` plus the `is-active` class.
 */
export function aiModeField(
  parent: HTMLElement,
  options: { initial?: MapAiMode; onChange?: (mode: MapAiMode) => void } = {}
): { element: HTMLElement; value: () => MapAiMode; set: (mode: MapAiMode) => void } {
  const element = parent.createDiv("vam-ai-mode-set");
  const group = element.createDiv("vam-ai-mode");
  group.setAttr("role", "radiogroup");
  group.setAttr("aria-label", t("ui.ai_mode"));
  element.createEl("p", { cls: "vam-hint", text: t("ui.ai_mode_hint") });
  const buttons = new Map<MapAiMode, HTMLButtonElement>();
  let current: MapAiMode = options.initial ?? DEFAULT_MAP_AI_MODE;
  const paint = (): void => {
    for (const [mode, button] of buttons) {
      button.setAttr("aria-checked", String(mode === current));
      button.tabIndex = mode === current ? 0 : -1;
      button.toggleClass("is-active", mode === current);
    }
  };
  const set = (mode: MapAiMode): void => {
    current = mode;
    paint();
  };
  const choose = (mode: MapAiMode): void => {
    if (mode === current) return;
    set(mode);
    options.onChange?.(mode);
  };
  for (const mode of AI_MODES) {
    const button = group.createEl("button", { text: t(mode === "quick" ? "ui.quick" : "ui.standard") });
    button.setAttr("role", "radio");
    button.addEventListener("click", () => choose(mode));
    button.addEventListener("keydown", event => {
      const step = ["ArrowRight", "ArrowDown"].includes(event.key)
        ? 1
        : ["ArrowLeft", "ArrowUp"].includes(event.key)
          ? -1
          : 0;
      if (!step) return;
      event.preventDefault();
      const next = AI_MODES[(AI_MODES.indexOf(mode) + step + AI_MODES.length) % AI_MODES.length];
      choose(next);
      buttons.get(next)?.focus();
    });
    buttons.set(mode, button);
  }
  paint();
  return { element, value: () => current, set };
}

/**
 * A field whose label row can carry a small link (edit, fix). A div, not a label: the link must not become the label's
 * control, so each select keeps its own aria-label.
 */
export function linkedField(parent: HTMLElement, label: string): { field: HTMLDivElement; head: HTMLDivElement } {
  const field = parent.createDiv("vam-field");
  const head = field.createDiv("vam-field-head");
  head.createSpan({ text: label });
  return { field, head };
}

export function fieldLink(head: HTMLElement, text: string, run: () => void): void {
  const link = head.createEl("button", { text, cls: "vam-field-link" });
  link.type = "button";
  link.addEventListener("click", event => {
    event.preventDefault();
    run();
  });
}

/**
 * Model select whose first option (empty value) is `defaultLabel`; returns the chosen model (or undefined) and a dispose
 * function. With `repair`, a "Fix connection…" link beside it checks the chosen model's AI service.
 */
export function modelField(
  parent: HTMLElement,
  models: ModelChoices,
  defaultLabel: string,
  repair?: (model: string | undefined) => void
): { value: () => string | undefined; set: (id: string | undefined) => void; dispose: () => void } {
  const { field, head } = linkedField(parent, t("ui.model"));
  const model = field.createEl("select");
  model.setAttr("aria-label", t("ui.model"));
  const fill = (): void => {
    const selected = model.value;
    model.replaceChildren();
    model.createEl("option", { value: "", text: defaultLabel });
    const choices = models.list();
    for (const option of choices) model.createEl("option", { value: option.id, text: option.label });
    model.value = choices.some(option => option.id === selected) ? selected : "";
  };
  fill();
  if (repair) fieldLink(head, t("ui.connection_repair"), () => repair(model.value || undefined));
  const dispose = models.watch(fill);
  return {
    value: () => model.value || undefined,
    // A model that is not (yet) in the list stays selected as an extra option, so a restored choice is not lost.
    set: id => {
      if (id && !Array.from(model.children).some(option => (option as HTMLOptionElement).value === id))
        model.createEl("option", { value: id, text: id });
      model.value = id ?? "";
    },
    dispose
  };
}

/**
 * Content template select whose first option (empty value) is `defaultLabel`; returns the chosen template id, or
 * undefined when that first option is selected. With `manage`, an edit link beside it opens the template library;
 * `templates` is updated in place.
 */
export function templateField(
  parent: HTMLElement,
  templates: { id: string; name: string }[],
  defaultLabel: string,
  manage?: ManageChoices,
  /** Runs after the list was refreshed, so a summary that names the template stays current. */
  changed: () => void = () => {}
): (() => string | undefined) & { set: (id: string | undefined) => void } {
  const { field, head } = linkedField(parent, t("ui.detail_template"));
  const select = field.createEl("select");
  select.setAttr("aria-label", t("ui.detail_template"));
  const fill = (): void => {
    const selected = select.value;
    select.replaceChildren();
    select.createEl("option", { value: "", text: defaultLabel });
    for (const template of templates) select.createEl("option", { value: template.id, text: template.name });
    select.value = templates.some(template => template.id === selected) ? selected : "";
  };
  fill();
  if (manage)
    fieldLink(head, t("ui.template_edit"), () =>
      manage(select.value || undefined, next => {
        templates.splice(0, templates.length, ...next);
        fill();
        changed();
      })
    );
  const read = (): string | undefined => select.value || undefined;
  return Object.assign(read, {
    set: (id: string | undefined): void => {
      select.value = id && templates.some(template => template.id === id) ? id : "";
    }
  });
}

/** Opens a library (tones, templates) at `selected` when given, and reports the refreshed list once it closes. */
export type ManageChoices = (
  selected: string | undefined,
  refreshed: (choices: { id: string; name: string }[]) => void
) => void;
export type ManageTones = ManageChoices;
/** The small links a research dialog can show beside its model and template fields. */
export interface FieldLinks {
  repair?: (model: string | undefined) => void;
  manageTemplates?: ManageChoices;
  manageTones?: ManageChoices;
}

/**
 * Writing tone select whose first option (empty value) is `defaultLabel`; returns the chosen preset id, or undefined when
 * that first option is selected. With `manage`, an edit link beside it opens the tone library; `tones` is updated in place.
 */
export function toneField(
  parent: HTMLElement,
  tones: { id: string; name: string }[],
  defaultLabel: string,
  manage?: ManageTones,
  /** Runs after the list was refreshed, so a summary that names the tone stays current. */
  changed: () => void = () => {}
): (() => string | undefined) & { set: (id: string | undefined) => void } {
  const { field, head } = linkedField(parent, t("ui.tone"));
  const select = field.createEl("select");
  select.setAttr("aria-label", t("ui.tone"));
  const fill = (): void => {
    const selected = select.value;
    select.replaceChildren();
    select.createEl("option", { value: "", text: defaultLabel });
    for (const tone of tones) select.createEl("option", { value: tone.id, text: tone.name });
    select.value = tones.some(tone => tone.id === selected) ? selected : "";
  };
  fill();
  if (manage)
    fieldLink(head, t("ui.tone_edit"), () =>
      manage(select.value || undefined, next => {
        tones.splice(0, tones.length, ...next);
        fill();
        changed();
      })
    );
  const read = (): string | undefined => select.value || undefined;
  return Object.assign(read, {
    set: (id: string | undefined): void => {
      select.value = id && tones.some(tone => tone.id === id) ? id : "";
    }
  });
}

const STYLE_KEEP = "";
const STYLE_CUSTOM = "custom";
const stylePreset = (id: string): string => `preset:${id}`;

export interface NoteStyleFieldOptions {
  templates: { id: string; name: string }[];
  tones: { id: string; name: string }[];
  /** First option: keeps what the topic, map or workspace says (nothing is sent). */
  keepLabel: string;
  /** Labels of the two selects inside "Custom…" (their first option keeps the current value). */
  templateDefault: string;
  toneDefault: string;
  /** Names to show in the summary when "Custom…" leaves a select on its first option. */
  currentTemplate?: string;
  currentTone?: string;
  /** Name of the style in force today; without it the first option shows no name and the summary falls back to the tone. */
  currentStyle?: string;
  manageTemplates?: ManageChoices;
  manageTones?: ManageTones;
  /** Runs after a choice or a refreshed list, so a summary that names the style stays current. */
  changed?: () => void;
}

export interface NoteStyleField {
  /** The template to send, or undefined to leave it as it is. */
  templateId: () => string | undefined;
  toneId: () => string | undefined;
  /** What the field now means, as a collapsed summary shows it: the chosen option, or the first option's own label. */
  label: () => string;
  /** The style that will be in force: the chosen preset, the custom pair, or (first option) the current style. */
  name: () => string;
  /** Restores an earlier pair: a preset when it equals one, else "Custom…"; nothing set means the first option. */
  set: (templateId: string | undefined, toneId: string | undefined) => void;
}

/**
 * The one "Note style" select. Each preset sends both a content template and a writing tone; "Custom…" shows the two
 * original selects (with their edit links) and sends their values. While the custom part is collapsed its values are not
 * sent. The field never opens "Custom…" by itself.
 */
export function noteStyleField(parent: HTMLElement, options: NoteStyleFieldOptions): NoteStyleField {
  const { field } = linkedField(parent, t("ui.note_style"));
  const select = field.createEl("select");
  select.setAttr("aria-label", t("ui.note_style"));
  select.createEl("option", { value: STYLE_KEEP, text: options.keepLabel });
  for (const preset of NOTE_STYLE_PRESETS)
    select.createEl("option", { value: stylePreset(preset.id), text: t(preset.name) });
  select.createEl("option", { value: STYLE_CUSTOM, text: t("ui.note_style_custom") });
  const hint = field.createEl("p", { cls: "vam-hint", attr: { "aria-live": "polite" } });
  const custom = field.createDiv("vam-note-style-custom");
  custom.hidden = true;
  const refresh = (notify = true): void => {
    const preset = NOTE_STYLE_PRESETS.find(item => stylePreset(item.id) === select.value);
    custom.hidden = select.value !== STYLE_CUSTOM;
    const text = preset ? t(preset.hint) : select.value === STYLE_CUSTOM ? t("ui.note_style_custom_hint") : "";
    hint.setText(text);
    hint.hidden = !text;
    if (notify) options.changed?.();
  };
  const templateId = templateField(custom, options.templates, options.templateDefault, options.manageTemplates, () =>
    options.changed?.()
  );
  const toneId = toneField(custom, options.tones, options.toneDefault, options.manageTones, () => options.changed?.());
  select.addEventListener("change", () => refresh());
  refresh(false);
  const chosenPreset = () => NOTE_STYLE_PRESETS.find(item => stylePreset(item.id) === select.value);
  const nameOf = (
    list: { id: string; name: string }[],
    id: string | undefined,
    fallback?: string
  ): string | undefined => (id ? list.find(item => item.id === id)?.name : undefined) ?? fallback;
  const customName = (): string =>
    t(
      "ui.note_style_custom_0_1",
      nameOf(options.templates, templateId(), options.currentTemplate) ?? "",
      nameOf(options.tones, toneId(), options.currentTone) ?? ""
    );
  return {
    templateId: () => (select.value === STYLE_CUSTOM ? templateId() : chosenPreset()?.templateId),
    toneId: () => (select.value === STYLE_CUSTOM ? toneId() : chosenPreset()?.toneId),
    label: () => {
      const preset = chosenPreset();
      if (preset) return t(preset.name);
      if (select.value !== STYLE_CUSTOM) return options.currentStyle ? options.keepLabel : (options.currentTone ?? "");
      return customName();
    },
    name: () => {
      const preset = chosenPreset();
      if (preset) return t(preset.name);
      if (select.value !== STYLE_CUSTOM) return options.currentStyle ?? options.currentTone ?? "";
      return customName();
    },
    set: (nextTemplate, nextTone) => {
      const preset = nextTemplate || nextTone ? matchPreset(nextTemplate, nextTone) : undefined;
      if (preset) select.value = stylePreset(preset.id);
      else if (nextTemplate || nextTone) {
        select.value = STYLE_CUSTOM;
        templateId.set(nextTemplate);
        toneId.set(nextTone);
      } else select.value = STYLE_KEEP;
      refresh(false);
    }
  };
}
