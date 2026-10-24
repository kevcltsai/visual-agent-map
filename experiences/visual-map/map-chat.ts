import { Component, setIcon } from "obsidian";
import { t } from "../../i18n";
import type { MapChatTurn } from "../../core/map-chat-context";

/** What the user attached to the next message. Topic chips come from a dragged card; snippets and files from a drop. */
export type MapChatChip =
  | { kind: "topic"; id: string }
  | { kind: "snippet"; path: string; text: string; pathGuessed: boolean }
  | { kind: "file"; path: string };

export interface MapChatLine {
  status: "done" | "skipped" | "failed";
  text: string;
}

/** What a question was sent with, kept so "say it in more detail" can send the same question again. */
export interface MapChatOrigin {
  text: string;
  chips: MapChatChip[];
  selectedIds: string[];
}
export type MapChatStyleChoice = "concise" | "detailed";

export interface MapChatMessage {
  role: "user" | "assistant";
  /** On a user message: the question and references it was sent with. */
  origin?: MapChatOrigin;
  text: string;
  /** One line per applied, skipped or failed action. */
  lines: MapChatLine[];
  error?: boolean;
  streaming?: boolean;
}

/** What the panel needs from the view that owns it. */
export interface MapChatHost {
  /** Title of a topic, or null when it is no longer on the map. */
  topicTitle(id: string): string | null;
  /** Cards that are selected right now; they count as references without being dragged in. */
  selectedIds(): string[];
  /** The panel asks to send the current draft. */
  send(): void;
  /** The panel asks to stop the running request. */
  stop(): void;
  /** Resolves a `[[link]]` target to the vault path of the note it names, or null. */
  resolveLink(link: string): string | null;
  /** The note the user most recently had open (best guess for where dropped text came from), or null. */
  activeNotePath(): string | null;
  /** The note that is visible beside the map right now (the one a message would be sent with), or null. */
  visibleNotePath(): string | null;
  /** Lays `text` out as Markdown into `el`; `owner` carries whatever the layout registers and is unloaded by the panel. */
  renderMarkdown(text: string, el: HTMLElement, owner: Component): Promise<void>;
  /** The element that has keyboard focus right now. */
  activeElement(): Element | null;
  /** Remembered answer length (from settings). */
  style(): MapChatStyleChoice;
  /** The user picked an answer length; the view remembers it. */
  setStyle(style: MapChatStyleChoice): void;
  /** Models the chat can use; `value` "" follows the default model and its label names that model. */
  modelChoices(): { value: string; label: string }[];
  /** Remembered chat model ("" follows the default). */
  model(): string;
  /** The user picked a chat model; the view remembers it. */
  setModel(model: string): void;
  /** Calls `changed` whenever the available models change and starts a refresh; the returned function stops listening. */
  watchModels(changed: () => void): () => void;
  /** "Say it in more detail": send `origin` again with the detailed style. */
  moreDetail(origin: MapChatOrigin): void;
  /** The panel opened or closed; the view makes room for it. */
  layoutChanged(open: boolean): void;
}

const LABEL_LIMIT = 40;
const clip = (value: string, limit = LABEL_LIMIT): string => {
  const text = value.replace(/\s+/g, " ").trim();
  const characters = [...text];
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : text;
};
const baseName = (path: string): string => path.split("/").at(-1)!.replace(/\.md$/i, "");

/** The note a dropped text names: `[[Note]]`, `[[Note#Heading|alias]]` or an `obsidian://open?...file=` address. Else null. */
export function droppedLinkTarget(text: string): string | null {
  const value = text.trim();
  const wiki = value.match(/^!?\[\[([^\]\n]+)\]\]$/);
  if (wiki) {
    const target = wiki[1].split("|")[0].split("#")[0].trim();
    return target || null;
  }
  const url = value.match(/^obsidian:\/\/open\?([^\s]*)$/i);
  if (url) {
    for (const part of url[1].split("&")) {
      const [key, raw = ""] = part.split("=");
      if (key !== "file") continue;
      try {
        const file = decodeURIComponent(raw.replace(/\+/g, " ")).trim();
        return file || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

let panelSequence = 0;

/**
 * The map's AI chat window: messages, draft, reference chips and the open or collapsed state. It lives on the view, builds
 * its elements once, and is put back into each repaint of the map (see {@link mount}); nothing here talks to the AI.
 */
export class MapChatPanel {
  private readonly id = `vam-map-chat-${++panelSequence}`;
  private messages: MapChatMessage[] = [];
  private chips: MapChatChip[] = [];
  private open = false;
  private busy = false;
  private composing = false;
  private el!: HTMLElement;
  private toggleEl!: HTMLButtonElement;
  private bodyEl!: HTMLElement;
  private logEl!: HTMLElement;
  private chipsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendEl!: HTMLButtonElement;
  private modelEl!: HTMLSelectElement;
  private styleEls: Record<MapChatStyleChoice, HTMLButtonElement> | null = null;
  private stopEl!: HTMLButtonElement;
  private built = false;
  private stopWatching: (() => void) | null = null;
  private messageEls: HTMLElement[] = [];
  private renderOwners = new Map<number, Component>();
  private bodyEls: HTMLElement[] = [];
  private markdownBodies: boolean[] = [];
  private paints: { busy: boolean; pending: string | null }[] = [];
  /** The visible note the user took off the chip; it stays off until another note is visible. */
  private dismissedNote: string | null = null;
  private noteChip: string | null = null;

  constructor(private readonly host: MapChatHost) {}

  get isOpen(): boolean {
    return this.open;
  }
  get isBusy(): boolean {
    return this.busy;
  }
  get isComposing(): boolean {
    return this.composing;
  }
  get draft(): string {
    return this.built ? this.inputEl.value : "";
  }
  /** True when `element` is the message field. */
  isInput(element: unknown): boolean {
    return this.built && element === this.inputEl;
  }
  /** Path of the visible note the next message goes with (the chip's note), or null. */
  currentNote(): string | null {
    this.refreshNote();
    return this.noteChip;
  }
  /** The visible note may have changed: update which note the chip names and repaint the chips. */
  refreshNote(): void {
    const visible = this.host.visibleNotePath();
    if (visible && visible !== this.dismissedNote) this.dismissedNote = null;
    this.noteChip = visible && visible !== this.dismissedNote ? visible : null;
    this.renderChips();
  }
  attachments(): MapChatChip[] {
    return this.chips.map(chip => ({ ...chip }));
  }
  /** Finished question and answer turns, oldest first, for the next request. */
  turns(): MapChatTurn[] {
    const turns: MapChatTurn[] = [];
    // Messages always come in pairs (question, answer); a pair whose answer is unfinished or failed is not history.
    for (let at = 0; at + 1 < this.messages.length; at += 2) {
      const question = this.messages[at];
      const answer = this.messages[at + 1];
      if (answer.streaming || answer.error || !answer.text.trim()) continue;
      turns.push({ role: "user", text: question.text }, { role: "assistant", text: answer.text });
    }
    return turns;
  }
  transcript(): MapChatMessage[] {
    return this.messages.map(message => ({ ...message, lines: [...message.lines] }));
  }

  /** Puts the panel into `parent` (built there the first time, moved there afterwards). */
  mount(parent: HTMLElement): void {
    if (!this.built) this.build(parent);
    else parent.appendChild(this.el);
    this.applyOpen();
    this.refreshNote();
    this.refreshControls();
  }
  /** The view is closing: stop listening for model changes. */
  dispose(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    this.unloadOwners();
  }
  private unloadOwners(): void {
    for (const owner of this.renderOwners.values()) owner.unload();
    this.renderOwners.clear();
  }
  /** Takes the panel out of the page; the next {@link mount} puts it back with all state intact. */
  detach(): void {
    if (this.built) this.el.remove();
  }
  /**
   * Call before a repaint: when the message field has focus, the returned function (call it after the repaint) gives it
   * focus again with the caret and selection where they were.
   */
  captureFocus(): () => void {
    if (!this.built || this.host.activeElement() !== this.inputEl) return () => {};
    const { selectionStart, selectionEnd } = this.inputEl;
    return () => {
      this.inputEl.focus();
      if (typeof selectionStart === "number" && typeof selectionEnd === "number")
        this.inputEl.setSelectionRange(selectionStart, selectionEnd);
    };
  }

  setOpen(open: boolean, focus = false): void {
    if (open === this.open && !focus) return;
    this.open = open;
    this.applyOpen();
    if (open) this.refreshControls();
    this.host.layoutChanged(open);
    if (!this.built) return;
    if (open && focus) this.inputEl.focus();
    if (!open && focus) this.toggleEl.focus();
  }

  /** Whether the point is over the panel (or over its button while it is collapsed). */
  hitTest(clientX: number, clientY: number): boolean {
    if (!this.built) return false;
    const rect = this.el.getBoundingClientRect();
    if (!rect.width && !rect.height) return false;
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }
  setDropHighlight(on: boolean): void {
    if (this.built) this.el.toggleClass("is-drop", on);
  }

  addTopicReference(id: string): void {
    this.addChip({ kind: "topic", id });
  }
  addSnippet(text: string, path: string, pathGuessed: boolean): void {
    if (!text.trim()) return;
    this.addChip({ kind: "snippet", path, text, pathGuessed });
  }
  addFile(path: string): void {
    this.addChip({ kind: "file", path });
  }
  private addChip(chip: MapChatChip): void {
    const same = (other: MapChatChip): boolean =>
      other.kind === chip.kind &&
      (chip.kind === "topic"
        ? other.kind === "topic" && other.id === chip.id
        : chip.kind === "file"
          ? other.kind === "file" && other.path === chip.path
          : other.kind === "snippet" && other.text === chip.text && other.path === chip.path);
    if (!this.chips.some(same)) this.chips.push(chip);
    this.setOpen(true);
    this.renderChips();
  }
  removeChip(chip: MapChatChip): void {
    const at = this.chips.indexOf(chip);
    this.chips = this.chips.filter(other => other !== chip);
    this.renderChips();
    if (at < 0 || !this.built) return;
    // The removed chip took the keyboard focus with it: hand it to the next chip, else the previous one, else the field.
    const buttons = this.chipsEl.querySelectorAll<HTMLElement>(".vam-map-chat-chip-remove");
    const target = buttons[at] ?? buttons[at - 1];
    if (target) target.focus();
    else this.inputEl.focus();
  }
  /** The selection changed: repaint the reference chips. */
  refreshSelection(): void {
    this.renderChips();
  }

  /** A turn starts: the user's text, an empty answer, and the busy state. */
  begin(userText: string, origin?: MapChatOrigin, keepDraft = false): void {
    this.messages.push({ role: "user", text: userText, lines: [], ...(origin ? { origin } : {}) });
    this.messages.push({ role: "assistant", text: "", lines: [], streaming: true });
    this.busy = true;
    if (this.built && !keepDraft) this.inputEl.value = "";
    this.renderLog();
    this.renderBusy();
  }
  /** The answer so far (the whole text, not a delta). */
  streamReply(text: string): void {
    const last = this.messages.at(-1);
    if (!last || !last.streaming) return;
    last.text = text;
    const index = this.messageEls.length - 1;
    const body = this.bodyEls[index];
    if (body && this.markdownBodies[index]) this.paintMarkdown(index, text);
    else body?.setText(text);
    this.scrollToEnd();
  }
  /** The turn ended with an answer and the outcome of each action. */
  finish(reply: string, lines: MapChatLine[]): void {
    const last = this.messages.at(-1);
    if (last?.streaming) {
      last.text = reply;
      last.lines = lines;
      last.streaming = false;
    }
    this.busy = false;
    this.renderLog();
    this.renderBusy();
  }
  /** The turn ended without an answer. */
  fail(text: string): void {
    const last = this.messages.at(-1);
    if (last?.streaming) {
      last.text = text;
      last.error = true;
      last.streaming = false;
    }
    this.busy = false;
    this.renderLog();
    this.renderBusy();
  }
  /** The user stopped the turn: whatever text arrived stays, marked as stopped. */
  markStopped(): void {
    const last = this.messages.at(-1);
    if (last?.streaming) {
      if (last.text.trim()) last.lines.push({ status: "skipped", text: t("ui.map_chat_stopped") });
      else {
        last.text = t("ui.map_chat_stopped");
        last.error = true;
      }
      last.streaming = false;
    }
    this.busy = false;
    this.renderLog();
    this.renderBusy();
  }
  /** Back to an empty conversation (a different map was opened). */
  reset(): void {
    this.messages = [];
    this.chips = [];
    this.dismissedNote = null;
    this.noteChip = null;
    this.busy = false;
    if (this.built) this.inputEl.value = "";
    this.renderLog();
    this.renderChips();
    this.renderBusy();
  }
  focusInput(): void {
    if (this.built) this.inputEl.focus();
  }

  // ---- DOM ------------------------------------------------------------------------------------------------------

  private build(parent: HTMLElement): void {
    this.built = true;
    this.el = parent.createDiv({ cls: "vam-map-chat" });
    this.toggleEl = this.el.createEl("button", {
      cls: "vam-map-chat-toggle",
      attr: { "aria-label": t("ui.map_chat_open"), "aria-expanded": "false", "aria-controls": this.id }
    });
    setIcon(this.toggleEl.createSpan("vam-map-chat-toggle-icon"), "message-square");
    this.toggleEl.addEventListener("click", () => this.setOpen(true, true));
    this.bodyEl = this.el.createDiv({
      cls: "vam-map-chat-body",
      attr: { id: this.id, role: "region", "aria-label": t("ui.map_chat_title") }
    });
    const head = this.bodyEl.createDiv("vam-map-chat-head");
    head.createSpan({ cls: "vam-map-chat-title", text: t("ui.map_chat_title") });
    const close = head.createEl("button", {
      cls: "vam-map-chat-close clickable-icon",
      attr: { "aria-label": t("ui.map_chat_close") }
    });
    setIcon(close, "x");
    close.addEventListener("click", () => this.setOpen(false, true));
    const modelRow = this.bodyEl.createDiv("vam-map-chat-model-row");
    this.modelEl = modelRow.createEl("select", {
      cls: "vam-map-chat-model dropdown",
      attr: { "aria-label": t("ui.map_chat_model_label") }
    });
    this.modelEl.addEventListener("change", () => this.host.setModel(this.modelEl.value));
    this.logEl = this.bodyEl.createDiv({
      cls: "vam-map-chat-log",
      attr: { role: "log", "aria-live": "polite", tabindex: "0" }
    });
    this.chipsEl = this.bodyEl.createDiv({
      cls: "vam-map-chat-chips",
      attr: { role: "group", "aria-label": t("ui.map_chat_references") }
    });
    this.statusEl = this.bodyEl.createDiv({ cls: "vam-map-chat-status", attr: { role: "status" } });
    const form = this.bodyEl.createDiv("vam-map-chat-form");
    this.inputEl = form.createEl("textarea", {
      cls: "vam-map-chat-input",
      attr: { rows: "3", "aria-label": t("ui.map_chat_input_label"), placeholder: t("ui.map_chat_input_placeholder") }
    });
    const side = form.createDiv("vam-map-chat-side");
    const styleGroup = side.createDiv({
      cls: "vam-map-chat-style",
      attr: { role: "group", "aria-label": t("ui.map_chat_style_label") }
    });
    const styleButton = (style: MapChatStyleChoice): HTMLButtonElement => {
      const label = t(style === "concise" ? "ui.map_chat_style_concise" : "ui.map_chat_style_detailed");
      const button = styleGroup.createEl("button", {
        cls: "vam-map-chat-style-option",
        text: label,
        attr: { type: "button", "aria-pressed": "false" }
      });
      button.addEventListener("click", () => {
        this.host.setStyle(style);
        this.refreshControls();
      });
      return button;
    };
    this.styleEls = { concise: styleButton("concise"), detailed: styleButton("detailed") };
    this.sendEl = side.createEl("button", {
      cls: "vam-map-chat-send mod-cta",
      text: t("ui.map_chat_send"),
      attr: { "aria-label": t("ui.map_chat_send") }
    });
    this.stopEl = side.createEl("button", {
      cls: "vam-map-chat-stop",
      text: t("ui.map_chat_stop"),
      attr: { "aria-label": t("ui.map_chat_stop") }
    });
    this.sendEl.addEventListener("click", () => this.host.send());
    this.stopEl.addEventListener("click", () => this.host.stop());
    this.inputEl.addEventListener("compositionstart", () => {
      this.composing = true;
    });
    this.inputEl.addEventListener("compositionend", () => {
      this.composing = false;
    });
    this.inputEl.addEventListener("keydown", event => this.onKey(event));
    for (const name of ["dragenter", "dragover"] as const)
      this.el.addEventListener(name, event => this.onDragOver(event));
    this.el.addEventListener("dragleave", () => this.setDropHighlight(false));
    this.el.addEventListener("drop", event => this.onDrop(event));
    this.renderLog();
    this.renderBusy();
    this.stopWatching = this.host.watchModels(() => this.refreshControls());
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === "Escape" && !event.isComposing && !this.composing) {
      event.preventDefault();
      this.setOpen(false, true);
      return;
    }
    // Enter sends, Shift+Enter breaks the line, and a key that confirms an IME candidate does neither.
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || this.composing) return;
    event.preventDefault();
    this.host.send();
  }

  private onDragOver(event: DragEvent): void {
    if (!event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    this.setDropHighlight(true);
  }

  private onDrop(event: DragEvent): void {
    event.preventDefault();
    this.setDropHighlight(false);
    const text = event.dataTransfer?.getData("text/plain") ?? "";
    if (!text.trim()) return;
    const lines = text.split(/\r?\n/).filter(line => line.trim());
    const links = lines.map(line => droppedLinkTarget(line));
    if (links.length && links.every(Boolean)) {
      const paths = links.map(link => this.host.resolveLink(link!));
      if (paths.every(Boolean)) {
        for (const path of paths) this.addFile(path!);
        return;
      }
    }
    const source = this.host.activeNotePath();
    this.addSnippet(text, source ?? "", true);
  }

  private applyOpen(): void {
    if (!this.built) return;
    this.el.toggleClass("is-open", this.open);
    this.bodyEl.hidden = !this.open;
    this.bodyEl.toggleClass("is-hidden", !this.open);
    this.toggleEl.hidden = this.open;
    this.toggleEl.toggleClass("is-hidden", this.open);
    this.toggleEl.setAttr("aria-expanded", String(this.open));
    this.toggleEl.setAttr("aria-label", t(this.open ? "ui.map_chat_close" : "ui.map_chat_open"));
  }

  /** Puts the answer-length buttons and the model list back in step with what the view remembers. */
  private refreshControls(): void {
    if (!this.built || !this.styleEls) return;
    const style = this.host.style();
    for (const choice of ["concise", "detailed"] as const) {
      this.styleEls[choice].setAttr("aria-pressed", String(style === choice));
      this.styleEls[choice].toggleClass("is-active", style === choice);
    }
    const choices = this.host.modelChoices();
    this.modelEl.empty();
    for (const choice of choices) this.modelEl.createEl("option", { text: choice.label, value: choice.value });
    this.modelEl.value = this.host.model();
  }

  private chipLabel(chip: MapChatChip): string {
    if (chip.kind === "topic") {
      const title = this.host.topicTitle(chip.id);
      return t("ui.map_chat_ref_topic_0", title === null ? t("ui.map_chat_ref_gone") : clip(title));
    }
    if (chip.kind === "file") return t("ui.map_chat_ref_file_0", clip(baseName(chip.path)));
    return chip.path ? t("ui.map_chat_ref_snippet_0", clip(baseName(chip.path))) : t("ui.map_chat_ref_text");
  }

  private renderChips(): void {
    if (!this.built) return;
    this.chipsEl.empty();
    const dragged = new Set(this.chips.filter(chip => chip.kind === "topic").map(chip => (chip as { id: string }).id));
    for (const id of this.host.selectedIds()) {
      if (dragged.has(id)) continue;
      const title = this.host.topicTitle(id);
      if (title === null) continue;
      const chip = this.chipsEl.createDiv({ cls: "vam-map-chat-chip is-auto" });
      chip.createSpan({ cls: "vam-map-chat-chip-label", text: t("ui.map_chat_ref_selected_0", clip(title)) });
    }
    if (this.noteChip) {
      const note = this.noteChip;
      const label = t("ui.map_chat_ref_note_0", clip(baseName(note)));
      const chip = this.chipsEl.createDiv({ cls: "vam-map-chat-chip is-note" });
      chip.createSpan({ cls: "vam-map-chat-chip-label", text: label });
      const remove = chip.createEl("button", {
        cls: "vam-map-chat-note-remove",
        text: "×",
        attr: { "aria-label": t("ui.map_chat_remove_ref_0", label), type: "button" }
      });
      remove.addEventListener("click", () => {
        this.dismissedNote = note;
        this.refreshNote();
        this.inputEl.focus();
      });
    }
    for (const entry of this.chips) {
      const label = this.chipLabel(entry);
      const chip = this.chipsEl.createDiv({ cls: `vam-map-chat-chip is-${entry.kind}` });
      chip.createSpan({ cls: "vam-map-chat-chip-label", text: label });
      const remove = chip.createEl("button", {
        cls: "vam-map-chat-chip-remove",
        text: "×",
        attr: { "aria-label": t("ui.map_chat_remove_ref_0", label), type: "button" }
      });
      remove.addEventListener("click", () => this.removeChip(entry));
    }
  }

  private renderLog(): void {
    if (!this.built) return;
    this.logEl.empty();
    this.messageEls = [];
    this.bodyEls = [];
    this.markdownBodies = [];
    this.paints = [];
    this.unloadOwners();
    for (const message of this.messages) {
      const row = this.logEl.createDiv({
        cls: `vam-map-chat-msg is-${message.role}${message.error ? " is-error" : ""}`
      });
      row.createSpan({
        cls: "vam-map-chat-role",
        text: t(message.role === "user" ? "ui.map_chat_role_you" : "ui.map_chat_role_ai")
      });
      const markdown = message.role === "assistant" && !message.error;
      const body = row.createDiv({ cls: `vam-map-chat-text${markdown ? " is-markdown" : ""}` });
      const index = this.messageEls.length;
      this.bodyEls.push(body);
      this.markdownBodies.push(markdown);
      this.paints.push({ busy: false, pending: null });
      if (markdown) this.paintMarkdown(index, message.text);
      else body.setText(message.text);
      const asked = this.messages[this.messages.indexOf(message) - 1];
      if (
        message.role === "assistant" &&
        !message.streaming &&
        !message.error &&
        message.text.trim() &&
        asked?.origin
      ) {
        const origin = asked.origin;
        const more = row.createEl("button", {
          cls: "vam-map-chat-more",
          text: t("ui.map_chat_more_detail"),
          attr: { type: "button" }
        });
        more.disabled = this.busy;
        more.addEventListener("click", () => {
          if (!this.busy) this.host.moreDetail(origin);
        });
      }
      if (message.lines.length) {
        const list = row.createDiv({ cls: "vam-map-chat-lines" });
        for (const line of message.lines)
          list.createDiv({ cls: `vam-map-chat-line is-${line.status}`, text: line.text });
      }
      this.messageEls.push(row);
    }
    this.scrollToEnd();
  }

  /** Lays message `index` out as Markdown. One layout runs at a time per message; the newest text always gets its turn. */
  private paintMarkdown(index: number, text: string): void {
    const state = this.paints[index];
    const body = this.bodyEls[index];
    if (!state || !body) return;
    if (state.busy) {
      state.pending = text;
      return;
    }
    state.busy = true;
    void (async () => {
      let next: string | null = text;
      while (next !== null) {
        const current = next;
        state.pending = null;
        const owner = new Component();
        owner.load();
        this.renderOwners.get(index)?.unload();
        this.renderOwners.set(index, owner);
        body.empty();
        try {
          await this.host.renderMarkdown(current, body, owner);
        } catch {
          body.setText(current);
        }
        next = state.pending;
      }
      state.busy = false;
    })();
  }

  private renderBusy(): void {
    if (!this.built) return;
    this.statusEl.setText(this.busy ? t("ui.map_chat_replying") : "");
    this.el.toggleClass("is-busy", this.busy);
    this.sendEl.hidden = this.busy;
    this.sendEl.toggleClass("is-hidden", this.busy);
    this.stopEl.hidden = !this.busy;
    this.stopEl.toggleClass("is-hidden", !this.busy);
  }

  private scrollToEnd(): void {
    if (this.built) this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
