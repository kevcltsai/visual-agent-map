import { t } from "../../i18n";
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
