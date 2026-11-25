/** The "N paragraphs changed · Undo" box: fixed at the window's bottom right (never over the header buttons) and removed after `ms` by its own timer. */
interface NoticeHost {
  createDiv(o: { cls: string; attr: Record<string, string> }): NoticeBox;
}
interface NoticeBox {
  createSpan(o: { text: string }): unknown;
  createEl(
    tag: "a",
    o: { text: string; cls: string; href: string }
  ): { addEventListener(type: "click", fn: (e: { preventDefault(): void }) => void): void };
  remove(): void;
}
export function showAppliedNotice(
  host: NoticeHost,
  timers: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void },
  message: string,
  label: string,
  onClick: () => void,
  ms: number
): { hide(): void } {
  const box = host.createDiv({ cls: "vam-book-applied-notice", attr: { role: "status" } });
  box.createSpan({ text: message });
  box.createEl("a", { text: label, cls: "vam-book-undo-link", href: "#" }).addEventListener("click", event => {
    event.preventDefault();
    onClick();
  });
  const timer = timers.set(() => box.remove(), ms);
  return {
    hide: () => {
      timers.clear(timer);
      box.remove();
    }
  };
}
