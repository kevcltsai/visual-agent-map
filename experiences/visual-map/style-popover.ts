import { t } from "../../i18n";
import { TOPIC_COLORS, colorLabelKey, styleLabelKey, type TopicColor, type TopicStyle } from "../../topic-colors";

/** What the popover shows as pressed: the card's colour and styles as saved, and whether it has cards under it. */
export interface StylePopoverState {
  color: TopicColor | null;
  styles: readonly TopicStyle[];
  /** The card has descendants, so "apply to the whole branch" is offered. */
  hasBranch: boolean;
}

/**
 * One call per click, never on hover or pointer movement. `branch` is the "apply to the whole branch" box at the time of
 * the click. The owner gates and writes: `onColor` maps to changeTopicColor(node, color, branch) and `onStyles` to
 * changeTopicStyle(node, styles, branch), where `styles` is the full list to write.
 */
export interface StylePopoverCallbacks {
  onColor(color: TopicColor | null, branch: boolean): void;
  onStyles(styles: TopicStyle[], branch: boolean): void;
  /** The popover closed (Esc or close()); the focus is already back on the anchor. */
  onClose?(): void;
}

export interface StylePopover {
  el: HTMLElement;
  /** Repaints the pressed states (after a write, or when the note changed elsewhere). */
  update(state: StylePopoverState): void;
  /** Removes the popover and returns the focus to the anchor; later calls do nothing. */
  close(): void;
}

const TOGGLES = ["bold", "border-thick", "line-thick"] as const;
/** Small, medium (no size token) and large. */
const SIZES: { id: string; style: TopicStyle | null }[] = [
  { id: "size-small", style: "text-small" },
  { id: "size-medium", style: null },
  { id: "size-large", style: "text-large" }
];

/**
 * Opens the toolbar "Style" popover in `host` (the caller positions it). Every control is a native button or checkbox,
 * so Tab reaches each one; Esc closes it and puts the focus back on `anchor`.
 */
export function openStylePopover(
  host: HTMLElement,
  anchor: HTMLElement,
  initial: StylePopoverState,
  callbacks: StylePopoverCallbacks
): StylePopover {
  let state: StylePopoverState = { ...initial, styles: [...initial.styles] };
  let closed = false;
  const el = host.createDiv("vam-style-popover");
  el.setAttr("role", "dialog");
  el.setAttr("aria-label", t("ui.style_popover_title"));
  const pressed: { button: HTMLElement; on: () => boolean }[] = [];
  const paint = (): void => {
    for (const item of pressed) {
      const on = item.on();
      item.button.setAttr("aria-pressed", String(on));
      item.button.toggleClass("is-pressed", on);
    }
  };
  const row = (label: string): HTMLElement => {
    const line = el.createDiv("vam-style-popover-row");
    line.createSpan({ text: label, cls: "vam-style-popover-label" });
    const group = line.createDiv("vam-style-popover-choices");
    group.setAttr("role", "group");
    group.setAttr("aria-label", label);
    return group;
  };
  const choice = (group: HTMLElement, id: string, text: string, on: () => boolean, run: () => void): HTMLElement => {
    const button = group.createEl("button", { text, cls: "vam-style-popover-choice" });
    button.dataset.styleChoice = id;
    button.addEventListener("click", event => {
      event.stopPropagation();
      run();
      paint();
    });
    pressed.push({ button, on });
    return button;
  };
  let branchBox: HTMLInputElement | null = null;
  const branch = (): boolean => !!branchBox?.checked;
  const withoutSize = (): TopicStyle[] => state.styles.filter(id => id !== "text-small" && id !== "text-large");

  const colors = row(t("ui.topic_color"));
  for (const color of [null, ...TOPIC_COLORS]) {
    const text = color ? t(colorLabelKey(color)) : t("ui.topic_color_none");
    const button = choice(
      colors,
      `color-${color ?? "none"}`,
      "",
      () => state.color === color,
      () => {
        state = { ...state, color };
        callbacks.onColor(color, branch());
      }
    );
    button.addClass("vam-style-popover-color");
    button.setAttr("aria-label", text);
    button.setAttr("title", text);
    const swatch = button.createSpan({ cls: "vam-color-swatch", attr: { "aria-hidden": "true" } });
    if (color) swatch.dataset.topicColorSwatch = color;
    else swatch.addClass("is-none");
  }
  const toggles = row(t("ui.topic_style"));
  for (const id of TOGGLES)
    choice(
      toggles,
      id,
      t(styleLabelKey(id)),
      () => state.styles.includes(id),
      () => {
        const styles = state.styles.includes(id) ? state.styles.filter(item => item !== id) : [...state.styles, id];
        state = { ...state, styles };
        callbacks.onStyles([...styles], branch());
      }
    );
  const sizes = row(t("ui.topic_style_size"));
  for (const size of SIZES)
    choice(
      sizes,
      size.id,
      size.style ? t(styleLabelKey(size.style)) : t("ui.style_popover_size_medium"),
      () => (size.style ? state.styles.includes(size.style) : withoutSize().length === state.styles.length),
      () => {
        const styles = [...withoutSize(), ...(size.style ? [size.style] : [])];
        state = { ...state, styles };
        callbacks.onStyles([...styles], branch());
      }
    );
  if (state.hasBranch) {
    const label = el.createEl("label", { cls: "vam-style-popover-row vam-style-popover-branch" });
    branchBox = label.createEl("input", { type: "checkbox" });
    branchBox.dataset.styleChoice = "branch";
    label.createSpan({ text: t("ui.style_popover_whole_branch") });
  }
  paint();

  const close = (): void => {
    if (closed) return;
    closed = true;
    el.remove();
    anchor.focus();
    callbacks.onClose?.();
  };
  el.addEventListener("keydown", event => {
    if (closed || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  pressed[0]?.button.focus();
  return {
    el,
    update(next) {
      state = { ...next, styles: [...next.styles] };
      paint();
    },
    close
  };
}
