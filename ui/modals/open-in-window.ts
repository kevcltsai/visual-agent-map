import type { Modal } from "obsidian";

/**
 * Opens `modal` in the window that holds `anchor` (the button that asked for it).
 *
 * Obsidian's `Modal.open()` shows the modal on the window that is active at that moment (`activeWindow`; the API says
 * "Show the modal on the active window"). When the settings page lives in a popout window, an `open()` that comes after an
 * await, or after the focus moved, can land in the main window. The modal's `containerEl` is a plain element, so it is moved
 * to the anchor's `ownerDocument.body`; the browser adopts the element (and its listeners) into that document.
 */
export function openInWindowOf(modal: Modal, anchor: HTMLElement | undefined | null): void {
  modal.open();
  const doc = anchor?.ownerDocument;
  const container = modal.containerEl;
  if (!doc?.body || !container || container.ownerDocument === doc) return;
  // `onOpen` put the focus inside the modal while it was still in the old document; the move drops it, so it is set again.
  const focused = container.ownerDocument?.activeElement;
  const keep = focused && container.contains?.(focused) ? (focused as HTMLElement) : undefined;
  doc.body.appendChild(container);
  keep?.focus?.();
}

