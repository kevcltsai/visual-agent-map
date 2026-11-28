import { t } from "../../i18n";
import { CARD_HEIGHT_MAX, CARD_HEIGHT_MIN, CARD_WIDTH, CARD_WIDTH_MAX, CARD_WIDTH_MIN } from "../../map-graph";
import { TOPIC_COLORS, colorLabelKey, type TopicColor } from "../../topic-colors";

/**
 * The selection's colour (P1.9): the one colour every selected card has (null: none), or "mixed" when they differ, which
 * presses no swatch and says so beside the title.
 */
export type BatchColorState = TopicColor | null | "mixed";

export interface BatchColorPopover {
  el: HTMLElement;
  /** Removes the popover; `restoreFocus` puts the focus back on the anchor. Later calls do nothing. */
  close(restoreFocus?: boolean): void;
}

/**
 * Opens the selection bar's Color popover in `host` (the bar; the CSS puts it above the bar). It reuses the Style popover's
 * swatches (.vam-style-popover). One click on a swatch is one call to `onColor`, for the whole selection; the owner gates and
 * writes. Esc closes it and puts the focus back on `anchor`.
 */
export function openBatchColorPopover(
  host: HTMLElement,
  anchor: HTMLElement,
  state: BatchColorState,
  count: number,
  callbacks: { onColor(color: TopicColor | null): void; onClose?(): void }
): BatchColorPopover {
  let closed = false;
  const el = host.createDiv("vam-style-popover vam-batch-popover");
  el.setAttr("role", "dialog");
  el.setAttr("aria-label", t("ui.batch_color_title_0", count));
  const head = el.createDiv("vam-style-popover-row");
  head.createSpan({ text: t("ui.topic_color"), cls: "vam-style-popover-label" });
  if (state === "mixed") head.createSpan({ text: t("ui.batch_color_mixed"), cls: "vam-batch-popover-mixed" });
  const group = el.createDiv("vam-style-popover-choices");
  group.setAttr("role", "group");
  group.setAttr("aria-label", t("ui.topic_color"));
  const buttons: HTMLElement[] = [];
  const colors = [null, ...TOPIC_COLORS];
  for (const color of colors) {
    const text = color ? t(colorLabelKey(color)) : t("ui.topic_color_none");
    const on = state === color;
    const button = group.createEl("button", { cls: "vam-style-popover-choice vam-style-popover-color" });
    button.dataset.styleChoice = `color-${color ?? "none"}`;
    button.setAttr("aria-label", text);
    button.setAttr("title", text);
    button.setAttr("aria-pressed", String(on));
    button.toggleClass("is-pressed", on);
    const swatch = button.createSpan({ cls: "vam-color-swatch", attr: { "aria-hidden": "true" } });
    if (color) swatch.dataset.topicColorSwatch = color;
    else swatch.addClass("is-none");
    button.addEventListener("click", event => {
      event.stopPropagation();
      callbacks.onColor(color);
    });
    buttons.push(button);
  }
  const close = (restoreFocus = true): void => {
    if (closed) return;
    closed = true;
    el.remove();
    if (restoreFocus) anchor.focus();
    callbacks.onClose?.();
  };
  el.addEventListener("keydown", event => {
    if (closed || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  // The pressed swatch takes the focus; a mixed selection starts on the first.
  (buttons[colors.indexOf(state as TopicColor | null)] ?? buttons[0])?.focus();
  return { el, close };
}

/**
 * The selection's size (P1.9): the one width every selected card has, the one height (null: as tall as its content), or
 * "mixed" when they differ.
 */
export interface BatchSizeState {
  width: number | "mixed";
  height: number | null | "mixed";
}
/** What Apply writes: only the keys present; undefined puts that size back (the default width, or automatic height). */
export type BatchSizeChange = { width?: number | undefined; height?: number | undefined };

/**
 * Opens the selection bar's Size popover in `host`, like the Color one: a width and a height field, each empty with the
 * current value (or "Mixed", or "Auto") as placeholder and its own Reset; "Apply to N" hands `onApply` only the fields typed
 * in or reset (nothing typed: it just closes); Cancel and Esc close it. The owner gates and writes.
 */
export function openBatchSizePopover(
  host: HTMLElement,
  anchor: HTMLElement,
  state: BatchSizeState,
  count: number,
  callbacks: { onApply(change: BatchSizeChange): void; onClose?(): void }
): BatchColorPopover {
  let closed = false;
  const el = host.createDiv("vam-style-popover vam-batch-popover vam-batch-size-popover");
  el.setAttr("role", "dialog");
  el.setAttr("aria-label", t("ui.batch_size_title_0", count));
  const field = (label: string, placeholder: string, reset: string, min: number, max: number) => {
    const row = el.createDiv("vam-style-popover-row");
    row.createSpan({ text: label, cls: "vam-style-popover-label" });
    const input = row.createEl("input", { cls: "vam-batch-size-input", type: "number" });
    input.setAttr("aria-label", label);
    input.setAttr("min", String(min));
    input.setAttr("max", String(max));
    input.placeholder = placeholder;
    row.createSpan({ text: "px", cls: "vam-style-popover-label" });
    const entry = { input, reset: false };
    const button = row.createEl("button", { cls: "vam-style-popover-choice", text: t("ui.batch_size_reset") });
    button.setAttr("aria-label", `${t("ui.batch_size_reset")} ${label}`);
    button.addEventListener("click", event => {
      event.stopPropagation();
      entry.reset = true;
      input.value = "";
      input.placeholder = reset;
      input.focus();
    });
    input.addEventListener("input", () => {
      entry.reset = false;
    });
    return entry;
  };
  const mixed = t("ui.batch_size_mixed"),
    auto = t("ui.batch_size_auto");
  const width = field(
    t("ui.batch_size_width"),
    state.width === "mixed" ? mixed : String(state.width),
    String(CARD_WIDTH),
    CARD_WIDTH_MIN,
    CARD_WIDTH_MAX
  );
  const height = field(
    t("ui.batch_size_height"),
    state.height === "mixed" ? mixed : state.height === null ? auto : String(state.height),
    auto,
    CARD_HEIGHT_MIN,
    CARD_HEIGHT_MAX
  );
  const apply = (): void => {
    const change: BatchSizeChange = {};
    for (const [key, entry] of [
      ["width", width],
      ["height", height]
    ] as const) {
      const value = entry.input.value.trim() ? Number(entry.input.value) : NaN;
      if (Number.isFinite(value)) change[key] = value;
      else if (entry.reset) change[key] = undefined;
    }
    close();
    if (Object.keys(change).length) callbacks.onApply(change);
  };
  const actions = el.createDiv("vam-style-popover-row");
  const applyButton = actions.createEl("button", {
    cls: "vam-style-popover-choice mod-cta",
    text: count === 1 ? t("ui.batch_size_apply_one") : t("ui.batch_size_apply_0", count)
  });
  applyButton.addEventListener("click", event => {
    event.stopPropagation();
    apply();
  });
  const cancel = actions.createEl("button", { cls: "vam-style-popover-choice", text: t("ui.cancel") });
  cancel.addEventListener("click", event => {
    event.stopPropagation();
    close();
  });
  const close = (restoreFocus = true): void => {
    if (closed) return;
    closed = true;
    el.remove();
    if (restoreFocus) anchor.focus();
    callbacks.onClose?.();
  };
  el.addEventListener("keydown", event => {
    if (closed) return;
    if (event.key === "Escape") close();
    else if (event.key === "Enter" && (event.target === width.input || event.target === height.input)) apply();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });
  width.input.focus();
  return { el, close };
}
