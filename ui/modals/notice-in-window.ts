import { Notice } from "obsidian";

/**
 * Shows a notice in the window that holds `anchor`. Like a modal, a notice made after an await lands on whatever window
 * Obsidian picks (the main one when settings is a popout), where the settings window hides it. The notice element is
 * moved into that window's notice container, which is made when the window has none yet.
 */
export function noticeInWindowOf(message: string, anchor: HTMLElement | undefined | null, duration?: number): Notice {
  const notice = new Notice(message, duration);
  const doc = anchor?.ownerDocument;
  const el = notice.containerEl;
  if (!doc?.body || !el || el.ownerDocument === doc) return notice;
  let host = doc.body.querySelector<HTMLElement>(".notice-container");
  if (!host) host = doc.body.createDiv({ cls: "notice-container" });
  host.appendChild(el);
  return notice;
}
