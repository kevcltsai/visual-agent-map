import { App, Modal } from "obsidian";
import { t } from "../../i18n";
import { modalActions } from "../../ui/modals/action-bar";

/**
 * The one question before "review finished" when something is left (block 5): how many cards still need a person and how many seams are
 * unconfirmed. "Go back" is the default (keyboard focus starts there); "Finish anyway" is allowed, never forced.
 */
export interface BookFinishAsk {
  review: number;
  /** Card labels ("2 Title"); text from notes, drawn with textContent only. */
  reviewTitles: string[];
  seams: number;
}

export function finishAskLine(info: BookFinishAsk): string {
  const parts: string[] = [];
  if (info.review)
    parts.push(
      info.reviewTitles.length
        ? t("ui.book_finish_ask_review_title_0_1", info.review, info.reviewTitles.join(" · "))
        : t("ui.book_finish_ask_review_0", info.review)
    );
  if (info.seams) parts.push(t("ui.book_finish_ask_seams_0", info.seams));
  return t("ui.book_finish_ask_line_0", parts.join(t("ui.book_finish_ask_sep")));
}

export class BookFinishModal extends Modal {
  private settled = false;
  private focusTimer: number | null = null;
  constructor(
    app: App,
    private info: BookFinishAsk,
    private answer: (finish: boolean) => void
  ) {
    super(app);
  }
  onOpen(): void {
    const { contentEl } = this;
    this.titleEl.setText(t("ui.book_finish_ask_title_0", this.info.review + this.info.seams));
    contentEl.createEl("p", { cls: "vam-book-finish-line", text: finishAskLine(this.info) });
    const actions = modalActions(this);
    const back = actions.createEl("button", { cls: "vam-book-finish-back", text: t("ui.book_finish_ask_back") });
    back.addEventListener("click", () => this.settle(false));
    const go = actions.createEl("button", { cls: "mod-cta vam-book-finish-go", text: t("ui.book_finish_ask_go") });
    go.addEventListener("click", () => this.settle(true));
    // Obsidian may move focus after onOpen: the keyboard starts on "go back", so a stray Enter never finishes.
    back.focus();
    this.focusTimer = window.setTimeout(() => {
      this.focusTimer = null;
      back.focus();
    }, 0);
  }
  onClose(): void {
    if (this.focusTimer !== null) window.clearTimeout(this.focusTimer);
    this.focusTimer = null;
    this.contentEl.empty();
    // Closed by Esc or the X: the same as "go back".
    this.settle(false);
  }
  private settle(finish: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.close();
    this.answer(finish);
  }
}
