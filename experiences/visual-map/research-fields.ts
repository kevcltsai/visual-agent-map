import { t } from "../../i18n";
import { DEFAULT_MAP_AI_MODE, type MapAiMode } from "./ai-mode";
import { DEFAULT_TONE_ID } from "../../ai/prompt-presets";
import { matchPreset, NOTE_STYLE_PRESETS } from "./note-style";
import { styleProblem, type StyleListItem, type StylePicker, type StyleRef } from "./note-style-picker";

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
): {
  value: () => string | undefined;
  set: (id: string | undefined) => void;
  /** Changes the text of the first (empty-value) option, e.g. when the position it describes changes. */
  setDefaultLabel: (label: string) => void;
  dispose: () => void;
} {
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
    setDefaultLabel: label => {
      defaultLabel = label;
      fill();
    },
    dispose
  };
}

/** The small links a research dialog can show beside its model and template fields. */
export interface FieldLinks {
  repair?: (model: string | undefined) => void;
  /** The template blocks of the user for the note-style field. */
  styles?: StylePicker;
  /** The style in force, for "Edit this style" while the first option is selected. */
  currentStyleRef?: StyleRef;
}

const STYLE_KEEP = "";
const STYLE_CUSTOM = "custom";
const stylePreset = (id: string): string => `preset:${id}`;

export interface NoteStyleFieldOptions {
  /** The template blocks (the user's own, editing); without it only the five built-ins are listed. */
  styles?: StylePicker;
  /** Names for the "Custom: template · tone" label of an older pair. */
  templates: { id: string; name: string }[];
  tones: { id: string; name: string }[];
  /** First option: keeps what the topic, map or workspace says (nothing is sent). */
  keepLabel: string;
  /** Names to show in the summary when a restored pair leaves a part unset. */
  currentTemplate?: string;
  currentTone?: string;
  /** Name of the style in force today; without it the first option shows no name and the summary falls back to the tone. */
  currentStyle?: string;
  /** The style in force today, so "Edit this style" works while the first option is selected. */
  currentRef?: StyleRef;
  /** Runs after a choice or a refreshed list, so a summary that names the style stays current. */
  changed?: () => void;
}

export interface NoteStyleField {
  /** The template to send, or undefined to leave it as it is. */
  templateId: () => string | undefined;
  toneId: () => string | undefined;
  /** What the field now means, as a collapsed summary shows it: the chosen option, or the first option's own label. */
  label: () => string;
  /** The style that will be in force: the chosen preset, the file, the older pair, or (first option) the current style. */
  name: () => string;
  /** Restores an earlier pair: a built-in or file when it equals one, else "Custom: X · Y"; nothing set means the first option. */
  set: (templateId: string | undefined, toneId: string | undefined) => void;
  /** Re-reads the block folders and redraws the list, keeping the choice. */
  reload: () => Promise<void>;
}

/**
 * The one "Note style" select: keep/default, the five built-ins and the template blocks the user wrote. A built-in sends
 * its template and tone pair; a template block sends one id (`file:<name>`). A block that does not parse is listed but
 * cannot be chosen, with its reason beneath. An older template-and-tone pair that is none of these stays selectable as
 * "Custom: X · Y". "Edit this style" opens the file of the chosen style.
 */
export function noteStyleField(parent: HTMLElement, options: NoteStyleFieldOptions): NoteStyleField {
  const { field, head } = linkedField(parent, t("ui.note_style"));
  const select = field.createEl("select");
  select.setAttr("aria-label", t("ui.note_style"));
  const edit = head.createEl("button", { text: t("ui.note_style_edit"), cls: "vam-field-link" });
  edit.type = "button";
  const hint = field.createEl("p", { cls: "vam-hint", attr: { "aria-live": "polite" } });
  const problems = field.createDiv("vam-note-style-problems");
  let custom: { template?: string; tone?: string } | undefined;
  const picker = options.styles;
  const preset = (value: string) => NOTE_STYLE_PRESETS.find(item => stylePreset(item.id) === value);
  const nameOf = (
    list: { id: string; name: string }[],
    id: string | undefined,
    fallback?: string
  ): string | undefined =>
    (id ? (list.find(item => item.id === id)?.name ?? id.replace(/^(?:style|file):/, "")) : undefined) ?? fallback;
  const customName = (): string =>
    t(
      "ui.note_style_custom_0_1",
      nameOf(options.templates, custom?.template, options.currentTemplate) ?? "",
      nameOf(options.tones, custom?.tone, options.currentTone) ?? ""
    );
  /** The picker rows other than the built-ins: the template blocks of the user (their value is their `file:<name>` id). */
  let items: StyleListItem[] = [];
  const refOf = (value: string): StyleRef | undefined => {
    if (value === STYLE_KEEP) return options.currentRef;
    const chosen = preset(value);
    if (chosen) return { kind: "builtin", id: chosen.id };
    return value.startsWith("file:") ? { kind: "file", id: value } : undefined;
  };
  /** Every option drawn and whether it can be chosen (the DOM's own option list is not needed). */
  let entries: { value: string; disabled: boolean }[] = [];
  const build = (): void => {
    const selected = select.value;
    select.replaceChildren();
    entries = [{ value: STYLE_KEEP, disabled: false }];
    select.createEl("option", { value: STYLE_KEEP, text: options.keepLabel });
    const broken: StyleListItem[] = [];
    for (const item of NOTE_STYLE_PRESETS) {
      select.createEl("option", { value: stylePreset(item.id), text: t(item.name) });
      entries.push({ value: stylePreset(item.id), disabled: false });
    }
    if (items.length) {
      const group = select.createEl("optgroup", { attr: { label: t("ui.note_style_group_folder") } });
      for (const item of items) {
        if (item.issues.length) broken.push(item);
        const option = group.createEl("option", {
          value: item.id,
          text: item.issues.length ? t("ui.note_style_unusable_option_0", item.name) : item.name
        });
        option.disabled = item.issues.length > 0;
        entries.push({ value: item.id, disabled: item.issues.length > 0 });
      }
    }
    if (custom) {
      select.createEl("option", { value: STYLE_CUSTOM, text: customName() });
      entries.push({ value: STYLE_CUSTOM, disabled: false });
    }
    select.value = entries.some(entry => entry.value === selected && !entry.disabled) ? selected : STYLE_KEEP;
    problems.replaceChildren();
    for (const item of broken) {
      const row = problems.createDiv({ cls: "vam-note-style-problem", attr: { role: "status" } });
      row.createSpan({ text: styleProblem(item) ?? "" });
      if (picker) {
        const open = row.createEl("button", { text: t("ui.note_style_open_file"), cls: "vam-field-link" });
        open.type = "button";
        open.addEventListener("click", () => void picker.edit({ kind: item.kind, id: item.id }));
      }
    }
  };
  const refresh = (notify = true): void => {
    const chosen = preset(select.value);
    const text = chosen ? t(chosen.hint) : "";
    hint.setText(text);
    hint.hidden = !text;
    const target = picker ? refOf(select.value) : undefined;
    edit.hidden = !picker;
    edit.disabled = !target;
    edit.setAttr("aria-disabled", String(!target));
    if (notify) options.changed?.();
  };
  const load = (): void => {
    items = picker?.list() ?? [];
    build();
  };
  load();
  select.addEventListener("change", () => refresh());
  edit.addEventListener("click", event => {
    event.preventDefault();
    const target = refOf(select.value);
    if (target) void picker?.edit(target);
  });
  refresh(false);
  const chosenPreset = () => preset(select.value);
  const chosenFile = (): { id: string } | undefined =>
    select.value.startsWith("file:") ? { id: select.value } : undefined;
  const nameFromList = (): string => {
    const file = chosenFile();
    return file
      ? (nameOf(
          items.map(item => ({ id: item.id, name: item.name })),
          file.id
        ) ?? "")
      : "";
  };
  return {
    templateId: () => {
      if (select.value === STYLE_CUSTOM) return custom?.template;
      return chosenPreset()?.templateId ?? chosenFile()?.id;
    },
    toneId: () => (select.value === STYLE_CUSTOM ? custom?.tone : chosenPreset()?.toneId),
    label: () => {
      const current = chosenPreset();
      if (current) return t(current.name);
      if (select.value === STYLE_CUSTOM) return customName();
      if (chosenFile()) return nameFromList();
      return options.currentStyle ? options.keepLabel : (options.currentTone ?? "");
    },
    name: () => {
      const current = chosenPreset();
      if (current) return t(current.name);
      if (select.value === STYLE_CUSTOM) return customName();
      if (chosenFile()) return nameFromList();
      return options.currentStyle ?? options.currentTone ?? "";
    },
    set: (nextTemplate, nextTone) => {
      custom = undefined;
      const matched = nextTemplate || nextTone ? matchPreset(nextTemplate, nextTone) : undefined;
      const plainTone = !nextTone || nextTone === DEFAULT_TONE_ID;
      const fileOption =
        nextTemplate && plainTone
          ? entries.find(entry => !entry.disabled && entry.value.startsWith("file:") && entry.value === nextTemplate)
          : undefined;
      if (matched) select.value = stylePreset(matched.id);
      else if (fileOption) select.value = fileOption.value;
      else if (nextTemplate || nextTone) {
        custom = { template: nextTemplate, tone: nextTone };
        build();
        select.value = STYLE_CUSTOM;
      } else select.value = STYLE_KEEP;
      refresh(false);
    },
    reload: async () => {
      if (!picker) return;
      await picker.refresh();
      load();
      refresh(false);
      options.changed?.();
    }
  };
}
