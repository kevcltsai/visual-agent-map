import { Modal, type App } from "obsidian";
import { t, type TranslationKey } from "../../i18n";
import { countNotes } from "../../core/book-pipeline/book-notes";
import { actionStatus, modalActions } from "../../ui/modals/action-bar";
import type { NoteWriteResult } from "./book-pipeline-callouts";
import { addNote, checkNoteText, checkSelection, type NoteRefusal } from "./book-pipeline-notes";

/**
 * The entry points of the reader's notes in a picture-book chapter: the editor-menu item and command that add a note, the input dialog,
 * and the header action "✎ Apply N notes". Only a chapter note of a usable book has any of them. Applying the notes (the AI rewrite, its clock, cancel
 * and undo) is the controller behind {@link BookNotesPorts.applyNotes}.
 */

const WHY: Record<NoteRefusal, TranslationKey> = {
  empty: "ui.book_note_why_empty",
  multiline: "ui.book_note_why_multiline",
  marks: "ui.book_note_why_marks",
  outside: "ui.book_note_why_outside",
  changed: "ui.book_note_why_changed"
};

/** The handle of one header action: its label can change and it can be taken off. */
export interface ActionHandle {
  setLabel(label: string): void;
  /** A reason makes the action look and read as disabled (a press still answers with the reason); null makes it normal. */
  setDisabled(reason: string | null): void;
  remove(): void;
}
/** One markdown view (a tab): the note it shows, the text it holds now (typed, maybe not saved) and its header. */
export interface NotesLeaf {
  /** The view itself: one header action per key. */
  key: object;
  path(): string | undefined;
  text(): string;
  addAction(label: string, run: () => void): ActionHandle;
}
/** The editor of the active view as the menu and the command see it. */
export interface NotesEditor {
  path: string | undefined;
  text(): string;
  /** The selection as offsets into `text()`. */
  selection(): { from: number; to: number };
}
export interface BookNotesPorts {
  leaves(): NotesLeaf[];
  /** Of these note paths, the ones that are chapters of a usable picture book. */
  chapterPaths(paths: string[]): Promise<Set<string>>;
  /** The write coordinator of the chapter notes (T4). */
  write(path: string, transform: (text: string) => string): Promise<NoteWriteResult>;
  /** The input dialog: `submit` gets the note text and answers a problem to show (the dialog stays open) or null (done). */
  askNote(selected: string, submit: (note: string) => string | null): void;
  notice(message: string): void;
  /** The header action, the menu item and the command: apply the notes of this chapter, or cancel the job that is running (T6c). */
  applyNotes(path: string): void;
  /** What the header action shows for this chapter: the running clock, or the reason it is disabled. */
  applyStatus(path: string): { running: boolean; elapsed?: string; disabled?: string };
  /** Why adding a note is blocked now (a drive of the map is rewriting chapters: a note added meanwhile could be lost); absent or null: allowed. */
  addBlocked?(path: string): string | null;
}

/** What the editor menu should show for the active editor: nothing for a note that is not a chapter. */
export interface MenuPlan {
  add: { title: string; disabled: boolean };
  /** Present when the chapter has notes to apply. */
  apply?: { title: string };
}

export class BookNotes {
  private chapters = new Map<string, boolean>();
  private readonly actions = new Map<object, { handle: ActionHandle; label: string; disabled: string | null }>();
  private pass = 0;
  private disposed = false;

  constructor(private readonly ports: BookNotesPorts) {}

  isChapter(path: string | undefined): boolean {
    return !!path && this.chapters.get(path) === true;
  }

  /** Asks which of the shown notes are chapters, then paints. A newer call supersedes an older one that is still waiting. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const mine = ++this.pass;
    const paths = [...new Set(this.ports.leaves().flatMap(leaf => leaf.path() ?? []))];
    const found = await this.ports.chapterPaths(paths).catch(() => new Set<string>());
    if (this.disposed || mine !== this.pass) return;
    this.chapters = new Map(paths.map(path => [path, found.has(path)]));
    this.paint();
  }

  /** From what is known now (no reads): one header action on each view that shows a chapter with notes, none on any other. */
  paint(): void {
    if (this.disposed) return;
    const leaves = this.ports.leaves();
    const live = new Set(leaves.map(leaf => leaf.key));
    for (const [key, action] of this.actions)
      if (!live.has(key)) {
        action.handle.remove();
        this.actions.delete(key);
      }
    for (const leaf of leaves) {
      const path = leaf.path();
      const count = this.isChapter(path) ? countNotes(leaf.text()) : 0;
      const status = path ? this.ports.applyStatus(path) : { running: false };
      const shown = this.actions.get(leaf.key);
      if (!count && !status.running) {
        shown?.handle.remove();
        this.actions.delete(leaf.key);
        continue;
      }
      const label = status.running
        ? t("ui.book_note_applying_0", status.elapsed ?? "0:00")
        : t("ui.book_note_apply_0", count);
      const disabled = status.disabled ?? null;
      if (shown) {
        if (shown.label !== label)
          shown.handle.setLabel(status.running ? t("ui.book_note_cancel_hint_0", label) : label);
        if (shown.disabled !== disabled) shown.handle.setDisabled(disabled);
        shown.label = label;
        shown.disabled = disabled;
      } else {
        const handle = leaf.addAction(label, () => this.press(leaf));
        if (status.running) handle.setLabel(t("ui.book_note_cancel_hint_0", label));
        if (disabled) handle.setDisabled(disabled);
        this.actions.set(leaf.key, { handle, label, disabled });
      }
    }
  }

  /** Plugin unload: every header action is taken off and nothing is painted afterwards. */
  dispose(): void {
    this.disposed = true;
    for (const { handle } of this.actions.values()) handle.remove();
    this.actions.clear();
    this.chapters.clear();
  }

  private press(leaf: NotesLeaf): void {
    const path = leaf.path();
    if (path && this.isChapter(path)) this.ports.applyNotes(path);
  }

  /** The menu items for the active editor; null when the note is not a chapter (no item at all). */
  menu(editor: NotesEditor): MenuPlan | null {
    if (!this.isChapter(editor.path)) return null;
    const { from, to } = editor.selection();
    const text = editor.text();
    const check = checkSelection(text, from, to);
    const count = countNotes(text);
    const blocked = this.ports.addBlocked?.(editor.path ?? "") ?? null;
    return {
      add: blocked
        ? { title: t("ui.book_note_add_disabled_0", blocked), disabled: true }
        : check.ok
          ? { title: t("ui.book_note_add"), disabled: false }
          : { title: t("ui.book_note_add_disabled_0", t(WHY[check.reason])), disabled: true },
      ...(this.ports.applyStatus(editor.path ?? "").running
        ? { apply: { title: t("ui.book_note_cancel_menu") } }
        : count
          ? { apply: { title: t("ui.book_note_apply_menu_0", count) } }
          : {})
    };
  }

  /** The command: asks for the note and writes it. */
  add(editor: NotesEditor): void {
    const path = editor.path;
    if (!path || !this.isChapter(path)) return this.ports.notice(t("ui.book_note_not_chapter"));
    const blocked = this.ports.addBlocked?.(path);
    if (blocked) return this.ports.notice(blocked);
    const { from, to } = editor.selection();
    const check = checkSelection(editor.text(), from, to);
    if (!check.ok) return this.ports.notice(t(WHY[check.reason]));
    const selected = check.text;
    this.ports.askNote(selected, note => {
      const text = checkNoteText(note);
      if (!text.ok) return t(text.problem === "empty" ? "ui.book_note_bad_empty" : "ui.book_note_bad_marks");
      void this.commit(path, from, to, selected, text.note);
      return null;
    });
  }

  /** The command twin of the header action. */
  apply(path: string | undefined): void {
    if (path && this.isChapter(path)) this.ports.applyNotes(path);
  }

  private async commit(path: string, from: number, to: number, selected: string, note: string): Promise<void> {
    let failure: NoteRefusal | "note" | undefined;
    const blocked = this.ports.addBlocked?.(path);
    if (blocked) return this.ports.notice(blocked);
    try {
      const result = await this.ports.write(path, text => {
        const added = addNote(text, from, to, selected, note);
        if (added.ok) return added.text;
        failure = added.reason;
        return text;
      });
      if (result === "written") this.ports.notice(t("ui.book_note_added"));
      else if (failure && failure !== "note") this.ports.notice(t(WHY[failure]));
      else this.ports.notice(t("ui.book_note_write_refused"));
    } catch {
      this.ports.notice(t("ui.book_note_write_refused"));
    }
    this.paint();
  }
}

/** The small input dialog for a note: one line; a note the text cannot hold is answered in the dialog and the dialog stays. */
export class BookNoteModal extends Modal {
  constructor(
    app: App,
    private readonly selected: string,
    private readonly submit: (note: string) => string | null
  ) {
    super(app);
  }
  onOpen(): void {
    this.contentEl.addClass("vam-tokens");
    this.titleEl.setText(t("ui.book_note_title"));
    this.contentEl.createEl("p", { text: this.selected, cls: "vam-book-note-selected" });
    // Mockup ⑦-4: a visible "what to change" label names the input (its accessible name is the same words).
    this.contentEl.createEl("label", { text: t("ui.book_note_input_ask"), attr: { for: "vam-book-note-input" } });
    const input = this.contentEl.createEl("input", {
      type: "text",
      cls: "vam-name-input vam-book-note-input",
      attr: { id: "vam-book-note-input" }
    });
    this.contentEl.createEl("p", { text: t("ui.book_note_input_hint"), cls: "vam-annotated-note-hint" });
    const problem = this.contentEl.createEl("p", { cls: "vam-book-note-problem" });
    problem.setAttr("role", "alert");
    const actions = modalActions(this);
    actionStatus(actions);
    actions.createEl("button", { text: t("ui.cancel") }).addEventListener("click", () => this.close());
    const ok = actions.createEl("button", { text: t("ui.book_note_add_button"), cls: "mod-cta" });
    const send = (): void => {
      const answer = this.submit(input.value);
      if (answer === null) this.close();
      else problem.setText(answer);
    };
    ok.addEventListener("click", send);
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      send();
    });
    input.focus();
  }
  onClose(): void {
    this.contentEl.empty();
  }
}
