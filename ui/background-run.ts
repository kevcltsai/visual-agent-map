import { Notice } from "obsidian";
import { t } from "../i18n";

/**
 * Background AI runs: the shared surface for dialogs that hide themselves once AI starts.
 *
 * Detach rule (every dialog that adopts this follows it):
 * - The dialog closes itself inside the `confirmAiUsage` run callback, before the provider call, after it set its own
 *   `detached = true`. From then on `onClose` no longer aborts the dialog's controller; Stop lives on the card or in the
 *   status bar, and a Stop pressed before the provider accepts the request aborts that same controller.
 * - Closing the dialog before AI starts (usage notice not confirmed, settings still saving, validation failing) still
 *   cancels, and a declined usage notice leaves the dialog open.
 * - After detaching, the dialog's DOM is never written. Completion is a Notice with a review button plus the badge or
 *   status-bar entry that stays; a review screen never opens by itself.
 */
export interface BackgroundAction {
  label: string;
  open: () => void;
}

/**
 * One Notice that reports a finished background run. With an action it carries a single button; pressing it runs
 * `open()` and hides the Notice. Without the host's fragment helper (tests, non-Obsidian hosts) it is a plain message.
 */
export function backgroundResultNotice(message: string, action?: BackgroundAction, timeout?: number): Notice {
  // The fragment helper is a host global; a host without it (tests) gets the plain message.
  const make = (window as { createFragment?: typeof createFragment }).createFragment;
  if (!action || typeof make !== "function") return new Notice(message, timeout);
  let notice: Notice | undefined;
  const fragment = make(el => {
    el.createSpan({ text: message });
    el.createEl("button", { text: action.label, cls: "vam-background-notice-action" }).addEventListener("click", () => {
      notice?.hide();
      action.open();
    });
  });
  notice = new Notice(fragment, timeout);
  return notice;
}

export interface BackgroundStatus {
  title: string;
  value: string;
  running: boolean;
  /** Present while the run can still be stopped. */
  onStop?: () => void;
  /** Text of the Stop button; defaults to the research Stop label. */
  stopLabel?: string;
  /** Present once a result waits for review. */
  review?: BackgroundAction;
  /** Present once the run ended (done, failed or stopped): removes the bar. */
  onDismiss?: () => void;
  /** Adds elements between the value and the buttons (a stage and its seconds). */
  detail?: (bar: HTMLElement) => void;
}

/** The in-view status bar (same markup as the multi-research bar): progress, Stop while running, then Review and ×. */
export function renderBackgroundStatus(parent: HTMLElement, status: BackgroundStatus): HTMLElement {
  const bar = parent.createDiv(`vam-aim-statusbar vam-background-statusbar${status.running ? " is-active" : ""}`);
  bar.setAttr("aria-live", "polite");
  bar.createSpan({ cls: "vam-aim-status-title", text: status.title });
  bar.createSpan({
    cls: `vam-aim-status-value ${status.running ? "vam-status-running" : ""}`.trim(),
    text: status.value
  });
  status.detail?.(bar);
  if (status.running && status.onStop) {
    const stop = bar.createEl("button", { text: status.stopLabel ?? t("ui.stop_research") });
    stop.addEventListener("click", status.onStop);
  }
  if (status.review) {
    const review = bar.createEl("button", { text: status.review.label, cls: "vam-badge-new" });
    review.addEventListener("click", status.review.open);
  }
  if (!status.running && status.onDismiss) {
    const dismiss = bar.createEl("button", { text: "×" });
    dismiss.setAttr("aria-label", t("ui.dismiss"));
    dismiss.addEventListener("click", status.onDismiss);
  }
  return bar;
}
