import { Keymap, setIcon } from "obsidian";
import { t } from "../../i18n";
import type { ImageCandidate } from "../../core/image-candidates";
import type { MapChatTurn } from "../../core/map-chat-context";
import { renderChatMarkdown } from "../../core/map-chat-render";
import {
  chatSuggestionKeys,
  clampMapChatWidth,
  countChatLines,
  MAP_CHAT_EXAMPLE_KEYS,
  MAP_CHAT_LINES_FOLD_ABOVE,
  MAP_CHAT_WIDTH_DEFAULT,
  MAP_CHAT_WIDTH_MAX,
  MAP_CHAT_WIDTH_MIN,
  MAP_CHAT_WIDTH_STEP,
  type ChatLineCounts,
  type ChatSuggestionContext
} from "../../core/map-chat-layout";

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

/** A reply that waits for the user's yes: what it would do, what it costs, and the two buttons. */
export interface MapChatPlanCard {
  /** One line per reason the reply needs confirming. */
  reasons: string[];
  /** One line per action, in order. */
  items: string[];
  /** The estimated AI calls, as a sentence. */
  estimate: string;
  /** The one-sentence description; built from `reasons` when absent. */
  summary?: string;
  /** The same actions by kind of work, each folded on the card; `items` is shown flat when absent. */
  groups?: { label: string; items: string[]; danger?: { mark: string } }[];
  state: "pending" | "applied" | "cancelled";
  apply(): void;
  cancel(): void;
}
/** Maps (or anything else) the user has to pick from; picking runs `pick` once. */
export interface MapChatChoices {
  prompt: string;
  options: { label: string; pick(): void }[];
  picked: boolean;
}

/** One picture candidate of a search, and what became of it. */
export interface MapChatImageItem {
  candidate: ImageCandidate;
  /** Title of the card the picture was inserted into; set once it was. */
  inserted?: string;
  /** The thumbnail could not be loaded: the candidate cannot be picked. */
  broken?: boolean;
  /** An insertion is running; a second click does nothing. */
  busy?: boolean;
}
/**
 * The picture candidates of one `find_images`, shown under the reply that asked for them. They belong to that reply for good: a
 * later message does not drop them (they are a result that was already paid for).
 */
export interface MapChatImages {
  /** The search words. */
  query: string;
  /** The card the picture is for, with the map it was found on. */
  nodeId: string;
  nodeTitle: string;
  mapPath: string;
  mapId: string;
  state: "searching" | "ready" | "empty" | "failed" | "stopped";
  /** Why the search failed. */
  reason?: string;
  /** Why the last insertion was refused, in words. */
  notice?: string;
  items: MapChatImageItem[];
  /** Stops the search (only while it is running). */
  stop?(): void;
}
/** The outcome of inserting a candidate. */
export type MapChatInsertResult = { ok: true } | { ok: false; reason: string };
/** A finished question and answer, as the host saves them. */
export interface MapChatSavedTurn {
  question: MapChatMessage;
  answer: MapChatMessage;
}

export interface MapChatMessage {
  role: "user" | "assistant";
  /** On a user message: the question and references it was sent with. */
  origin?: MapChatOrigin;
  text: string;
  /** One line per applied, skipped or failed action. */
  lines: MapChatLine[];
  error?: boolean;
  streaming?: boolean;
  plan?: MapChatPlanCard;
  choices?: MapChatChoices;
  /** More result lines than fit are folded into a count; true while they are all shown. */
  linesOpen?: boolean;
  /** Picture candidates the reply asked for (`find_images`), oldest first. */
  images?: MapChatImages[];
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
  /** Opens the note a `[[link]]` in a reply names (`newLeaf`: in a new tab). */
  openLink(href: string, newLeaf: boolean | "tab" | "split" | "window"): void;
  /** The element that has keyboard focus right now. */
  activeElement(): Element | null;
  /** Remembered answer length (from settings). */
  style(): MapChatStyleChoice;
  /** The user picked an answer length; the view remembers it. */
  setStyle(style: MapChatStyleChoice): void;
  /** Models the chat can use; `value` "" follows the default model and its label names that model. */
  modelChoices(): { value: string; label: string; short?: string }[];
  /** Remembered chat model ("" follows the default). */
  model(): string;
  /** The user picked a chat model; the view remembers it. */
  setModel(model: string): void;
  /** Calls `changed` whenever the available models change and starts a refresh; the returned function stops listening. */
  watchModels(changed: () => void): () => void;
  /** "Say it in more detail": send `origin` again with the detailed style. */
  moreDetail(origin: MapChatOrigin): void;
  /** The panel opened, closed, folded to the narrow edge or went to the opening screen; the view makes room for it. */
  layoutChanged(open: boolean): void;
  /** Width in pixels of the side window (the view remembers it). */
  width?(): number;
  /** The widths the pane gives the window for a set width (docked, and laid over a narrow pane); null when the pane is unknown. */
  widths?(setWidth: number): { docked: number; overlay: number } | null;
  /** The user is resizing the side window; `commit` is false while the handle is still being dragged. */
  setWidth?(width: number, commit: boolean): void;
  /** What the map looks like now, to pick the suggested messages. */
  suggestions?(): Pick<ChatSuggestionContext, "selected" | "hasTopics">;
  /** "Retry" on a failed turn: send the same question again. */
  retry?(origin: MapChatOrigin): void;
  /** The conversation's state changed (a turn started or ended, a plan appeared or was settled); the canvas may say so. */
  stateChanged?(): void;
  /** Inserts a picture candidate into the card it was found for; resolves with why it was refused, if it was. */
  insertImage?(images: MapChatImages, item: MapChatImageItem): Promise<MapChatInsertResult>;
  /** Whether the conversation can be saved next to this map; `reason` says why not. */
  canSave?(): { ok: true } | { ok: false; reason: string };
  /** Saves the finished turns as a note; resolves with the new note's path, or why it could not be saved. */
  saveTranscript?(turns: MapChatSavedTurn[]): Promise<{ ok: true; path: string } | { ok: false; reason: string }>;
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
  /** The user's wish: the side window is open (remembered). Whether it shows also depends on `narrow`. */
  private open = false;
  /** The pane is too narrow to dock the window: it is a narrow edge, and `overlayOpen` lays it over the canvas. */
  private narrow = false;
  private overlayOpen = false;
  /** The opening screen: no side window yet, the same elements stand in the middle of the canvas. */
  private hero = false;
  private unread = false;
  private width = MAP_CHAT_WIDTH_DEFAULT;
  private busy = false;
  /** A confirmed plan is being applied: the window shows it is working and can stop it. */
  private applying = false;
  private composing = false;
  /** The widths the pane leaves for the docked window and for the one laid over a narrow pane (the set width when unknown). */
  private dockedPx: number | null = null;
  private overlayPx: number | null = null;
  /** Where the log was scrolled when the panel was taken out for a repaint. */
  private keptScroll: { atEnd: boolean; top: number } | null = null;
  private el!: HTMLElement;
  private toggleEl!: HTMLButtonElement;
  private badgeEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private headEl!: HTMLElement;
  private heroTitleEl!: HTMLElement;
  private guideEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private logEl!: HTMLElement;
  private suggestEl!: HTMLElement;
  private suggestKey = "";
  private suggestInHero = false;
  private resizerEl!: HTMLElement;
  private liveEl!: HTMLElement;
  private stopResizing: (() => void) | null = null;
  private chipsEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendEl!: HTMLButtonElement;
  private modelEl!: HTMLSelectElement;
  private styleEls: Record<MapChatStyleChoice, HTMLButtonElement> | null = null;
  private stopEl!: HTMLButtonElement;
  private saveEl!: HTMLButtonElement;
  /** The note is being written; a second press does nothing. */
  private saving = false;
  /** The save button reads as disabled (it stays reachable by keyboard, so its title can be read). */
  private saveDisabled = true;
  /** What the reader is told once the reply that is streaming now has ended (a picture search can end in the middle of it). */
  private spokenLater: string[] = [];
  /** The pick button of each picture candidate, to give the keyboard back after a repaint. */
  private pickEls = new WeakMap<MapChatImageItem, HTMLElement>();
  private built = false;
  private stopWatching: (() => void) | null = null;
  private messageEls: HTMLElement[] = [];
  private bodyEls: HTMLElement[] = [];
  /** The laid-out row of each message with the state it was built from; a message that has not changed keeps its row. */
  private rows = new WeakMap<
    MapChatMessage,
    { key: string; row: HTMLElement; body: HTMLElement; more: HTMLButtonElement | null }
  >();
  /** The animation frame that will lay out the streaming message, if one is waiting. */
  private frame: { cancel: () => void } | null = null;
  /** Whether the body was showing at the last applyOpen, to tell the moment it opens. */
  private wasShown = false;
  /** The scroll to the end that waits for the overlay's height to be final. */
  private openFrame: { cancel: () => void } | null = null;
  /** The visible note the user took off the chip; it stays off until another note is visible. */
  private dismissedNote: string | null = null;
  private noteChip: string | null = null;

  constructor(private readonly host: MapChatHost) {}

  /** The window is showing (docked, laid over the canvas, or as the opening screen). */
  get isOpen(): boolean {
    return this.shown;
  }
  /** The user's choice to keep it open, which is what is remembered; it can differ from what shows on a narrow pane. */
  get wantsOpen(): boolean {
    return this.open;
  }
  get isHero(): boolean {
    return this.hero;
  }
  get isNarrow(): boolean {
    return this.narrow;
  }
  get hasMessages(): boolean {
    return this.messages.length > 0;
  }
  get docked(): boolean {
    return !this.hero && this.open && !this.narrow;
  }
  private get floating(): boolean {
    return !this.hero && this.narrow && this.overlayOpen;
  }
  private get shown(): boolean {
    return this.hero || this.docked || this.floating;
  }
  /** A turn is running (a request or its actions). */
  get isBusy(): boolean {
    return this.busy;
  }
  /** The window is laid over the canvas of a narrow pane. */
  get isOverlay(): boolean {
    return this.floating;
  }
  /** Width of the window laid over the canvas, 0 when it is not. */
  get overlayWidth(): number {
    return this.floating ? this.shownWidth() : 0;
  }
  /** A turn or a plan being applied is running: no new message can be sent, and Stop is offered. */
  private get working(): boolean {
    return this.busy || this.applying;
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
    this.renderSuggestions();
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
  /** Finished question and answer pairs, oldest first: what "save as a note" writes (a streaming or failed answer is left out). */
  completedTurns(): MapChatSavedTurn[] {
    const turns: MapChatSavedTurn[] = [];
    for (let at = 0; at + 1 < this.messages.length; at += 2) {
      const question = this.messages[at];
      const answer = this.messages[at + 1];
      if (answer.streaming || answer.error || !answer.text.trim()) continue;
      turns.push({ question, answer });
    }
    return turns;
  }
  transcript(): MapChatMessage[] {
    return this.messages.map(message => ({ ...message, lines: [...message.lines] }));
  }

  /**
   * Puts the panel into `parent` (built there the first time, moved there afterwards). "side" makes it the first child of
   * `parent`, the window left of the canvas; "hero" is the opening screen, which goes wherever `parent` is.
   */
  mount(parent: HTMLElement, mode: "side" | "hero" = "side"): void {
    this.hero = mode === "hero";
    if (!this.built) this.build(parent);
    else if (mode === "hero") this.place(parent, null);
    if (mode === "side") this.place(parent, parent.firstChild);
    this.width = clampMapChatWidth(this.host.width?.() ?? this.width);
    this.applyOpen();
    this.refreshNote();
    this.refreshControls();
    this.restoreScroll();
  }
  /** After a repaint the log is scrolled where it was: at the end it stays at the end (a new element starts at the top). */
  private restoreScroll(): void {
    const kept = this.keptScroll;
    this.keptScroll = null;
    if (!kept || !this.built) return;
    if (kept.atEnd) this.scrollToEnd();
    else this.logEl.scrollTop = kept.top;
  }
  /** Moves the panel to `parent`, before `before` (the end when null). */
  private place(parent: HTMLElement, before: ChildNode | null): void {
    // `before` is read before the panel leaves, so when it is the panel itself, the panel stays first.
    const ref = before === this.el ? this.el.nextSibling : before;
    this.el.remove();
    parent.insertBefore(this.el, ref);
  }
  /** The view is closing: stop listening for model changes and let go of a resize in progress. */
  dispose(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    this.stopResizing?.();
    this.cancelFrame();
    this.rows = new WeakMap();
  }
  /** Takes the panel out of the page; the next {@link mount} puts it back with all state intact. */
  detach(): void {
    if (!this.built) return;
    this.keptScroll = { atEnd: this.atEnd(), top: this.logEl.scrollTop };
    this.el.remove();
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
    if (open === this.open && (!this.narrow || open === this.overlayOpen) && !focus) return;
    this.open = open;
    this.overlayOpen = open;
    this.applyOpen();
    if (open) {
      this.refreshControls();
      this.refreshNote();
    }
    this.host.layoutChanged(this.shown);
    if (!this.built) return;
    if (open && focus) this.inputEl.focus();
    if (!open && focus) this.toggleEl.focus();
  }
  /** The saved open state is applied without telling the view (it asked for it). */
  restoreOpen(open: boolean): void {
    this.open = open;
    this.overlayOpen = false;
    this.applyOpen();
  }
  /** The pane became too narrow to dock the window (or wide enough again). The window folds to its edge, or docks back. */
  setNarrow(narrow: boolean, widths?: { docked: number; overlay: number }): void {
    if (widths && (widths.docked !== this.dockedPx || widths.overlay !== this.overlayPx)) {
      this.dockedPx = widths.docked;
      this.overlayPx = widths.overlay;
      this.applyWidth();
    }
    if (narrow === this.narrow) return;
    const hadFocus = this.hasFocus();
    this.narrow = narrow;
    this.overlayOpen = false;
    this.applyOpen();
    this.host.layoutChanged(this.shown);
    if (hadFocus && !this.shown && this.built) this.toggleEl.focus();
  }
  /** Lays the folded window back to its edge without forgetting that the user wants it open (Escape, a click on the canvas). */
  collapseOverlay(focus = false): void {
    if (!this.floating) return;
    const hadFocus = this.hasFocus();
    this.overlayOpen = false;
    this.applyOpen();
    this.host.layoutChanged(this.shown);
    if ((focus || hadFocus) && this.built) this.toggleEl.focus();
  }
  /** The command that opens or closes the window: it ends with the keyboard in the message field when it opens. */
  toggleFromCommand(): void {
    if (this.hero) {
      this.focusInput();
      return;
    }
    if (!this.shown) this.setOpen(true, true);
    else if (this.built && this.host.activeElement() !== this.inputEl) this.inputEl.focus();
    else if (this.narrow) this.collapseOverlay(true);
    else this.setOpen(false, true);
  }
  private hasFocus(): boolean {
    const active = this.host.activeElement();
    return this.built && !!active && this.el.contains(active);
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
  /** The selection changed: repaint the reference chips and the suggestions. */
  refreshSelection(): void {
    this.renderChips();
    this.renderSuggestions();
  }

  /** A turn starts: the user's text, an empty answer, and the busy state. */
  begin(userText: string, origin?: MapChatOrigin, keepDraft = false): void {
    // A list of maps to pick from belongs to the message before; a new message ends its choices.
    this.retireChoices();
    this.messages.push({ role: "user", text: userText, lines: [], ...(origin ? { origin } : {}) });
    this.messages.push({ role: "assistant", text: "", lines: [], streaming: true });
    this.busy = true;
    if (this.built && !keepDraft) this.inputEl.value = "";
    this.renderLog(true);
    this.renderBusy();
  }
  /** Every list of choices already shown stops working (a pick was made, or a newer message came). */
  private retireChoices(except?: MapChatChoices): void {
    for (const message of this.messages)
      if (message.choices && message.choices !== except) message.choices.picked = true;
  }
  /** A confirmed plan is being applied (true) or is done (false). */
  setApplying(on: boolean): void {
    if (this.applying === on) return;
    this.applying = on;
    this.renderLog();
    this.renderBusy();
  }
  /** The answer so far (the whole text, not a delta). */
  streamReply(text: string): void {
    const last = this.messages.at(-1);
    if (!last || !last.streaming) return;
    last.text = text;
    if (!this.built || this.frame) return;
    // Chunks that arrive within one frame are laid out once, with the newest text.
    // The window the log is shown in (a popped-out view has its own), because only that one paints its frames.
    const win =
      this.logEl.win ?? this.logEl.ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : undefined);
    if (typeof win?.requestAnimationFrame !== "function") {
      this.layoutStreaming();
      return;
    }
    const id = win.requestAnimationFrame(() => {
      this.frame = null;
      this.layoutStreaming();
    });
    this.frame = { cancel: () => win.cancelAnimationFrame?.(id) };
  }
  /** Lays the streaming message out with the text it has now; no other message is touched. */
  private layoutStreaming(): void {
    const last = this.messages.at(-1);
    const entry = last ? this.rows.get(last) : undefined;
    if (!last || !last.streaming || !entry) return;
    const stick = this.atEnd();
    renderChatMarkdown(entry.body, last.text, t("ui.map_chat_overflow_note"));
    entry.key = this.rowKey(last);
    if (stick) this.scrollToEnd();
  }
  private cancelFrame(): void {
    this.frame?.cancel();
    this.frame = null;
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
    // The one thing a screen reader hears of the turn: the log itself is silent while the reply streams.
    this.announce(this.spokenTurn(reply, lines));
    this.markUnread();
  }
  /** The turn ended without an answer. */
  fail(text: string, announce?: string): void {
    const last = this.messages.at(-1);
    if (last?.streaming) {
      last.text = text;
      last.error = true;
      last.streaming = false;
    }
    this.busy = false;
    this.renderLog();
    this.renderBusy();
    // `announce` is the whole sentence when `text` already says that the chat failed; it is never prefixed twice.
    this.announce(announce !== undefined ? clip(announce, 160) : t("ui.map_chat_live_failed_0", clip(text, 160)));
    this.markUnread();
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
    this.announce(t("ui.map_chat_stopped"));
  }
  /** The reply just finished needs the user's yes: shows the plan card on its message. */
  showPlan(plan: MapChatPlanCard): void {
    const last = this.messages.at(-1);
    if (!last || last.role !== "assistant") return;
    last.plan = plan;
    this.renderLog();
    this.renderHint();
    // A plan waits for an answer and nothing else tells a screen reader so: say the reply and the plan once.
    this.announce(
      `${t("ui.map_chat_live_done_0", clip(last.text, 160))} ${t(
        "ui.map_chat_live_plan_0",
        clip(plan.summary ?? t("ui.map_chat_plan_summary_0", plan.reasons.join(t("ui.map_chat_count_separator"))), 160)
      )}`
    );
    this.host.stateChanged?.();
  }
  /** The plan card still waiting for an answer, if any. */
  pendingPlan(): MapChatPlanCard | null {
    return this.messages.find(message => message.plan?.state === "pending")?.plan ?? null;
  }
  /** A plan was applied or cancelled: its buttons stop working; `lines` (the result of applying) join its message. */
  settlePlan(plan: MapChatPlanCard, state: "applied" | "cancelled", lines?: MapChatLine[]): void {
    const message = this.messages.find(item => item.plan === plan);
    if (!message) return;
    plan.state = state;
    if (lines) message.lines = lines;
    this.renderLog();
    this.renderHint();
    this.host.stateChanged?.();
    // The results of an applied plan arrive well after the reply: say them once, like the results of a reply.
    if (lines?.length)
      this.announce(
        t("ui.map_chat_live_results_0", this.countsText(countChatLines(lines, t("ui.map_chat_not_undoable"))))
      );
  }
  /** Offers a short list to pick from under the last answer. */
  showChoices(choices: MapChatChoices): void {
    const last = this.messages.at(-1);
    if (!last || last.role !== "assistant") return;
    this.retireChoices();
    last.choices = choices;
    this.renderLog();
  }
  /** Adds result lines to the last answer (after something that happened later, such as a picked map). */
  appendLines(lines: MapChatLine[]): void {
    const last = this.messages.at(-1);
    if (!last || last.role !== "assistant") return;
    last.lines = [...last.lines, ...lines];
    this.renderLog();
  }
  /** A picture search starts under the last answer. The block is shown at once and changes with {@link settleImages}. */
  addImages(block: MapChatImages): void {
    const last = this.messages.at(-1);
    if (!last || last.role !== "assistant") return;
    last.images = [...(last.images ?? []), block];
    this.renderLog();
  }
  /**
   * A picture search ended (or was stopped): the block takes `patch` and its row is laid out again. The keyboard stays where it
   * is, and the reader hears one sentence (after the reply that is streaming now, if one is).
   */
  settleImages(block: MapChatImages, patch: Partial<Pick<MapChatImages, "state" | "reason" | "items">>): void {
    if (!this.messages.some(message => message.images?.includes(block))) return;
    Object.assign(block, patch);
    block.stop = undefined;
    this.renderLog();
    if (block.state === "ready")
      this.announceImages(t("ui.map_chat_images_ready_0_1", block.items.length, clip(block.nodeTitle)));
    else if (block.state === "empty") this.announceImages(t("ui.map_chat_images_none"));
    else if (block.state === "failed")
      this.announceImages(t("ui.map_chat_images_failed_0", clip(block.reason ?? "", 160)));
    else if (block.state === "stopped") this.announceImages(t("ui.map_chat_images_stopped"));
  }
  /** Back to an empty conversation (a different map was opened). */
  reset(): void {
    this.cancelFrame();
    this.rows = new WeakMap();
    this.messages = [];
    this.spokenLater = [];
    this.chips = [];
    this.dismissedNote = null;
    this.noteChip = null;
    this.busy = false;
    this.applying = false;
    this.unread = false;
    if (this.built) this.inputEl.value = "";
    this.renderLog();
    this.renderChips();
    this.renderBusy();
    this.renderHint();
    this.applyOpen();
    this.host.stateChanged?.();
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
    this.badgeEl = this.toggleEl.createSpan({ cls: "vam-map-chat-unread", attr: { "aria-hidden": "true" } });
    this.badgeEl.hidden = true;
    this.toggleEl.addEventListener("click", () => this.setOpen(true, true));
    this.bodyEl = this.el.createDiv({
      cls: "vam-map-chat-body",
      attr: { id: this.id, role: "region", "aria-label": t("ui.map_chat_title") }
    });
    // Top row: the title, the model for this chat, and the button that folds the window.
    this.headEl = this.bodyEl.createDiv("vam-map-chat-head");
    this.headEl.createSpan({ cls: "vam-map-chat-title", text: t("ui.map_chat_title") });
    this.modelEl = this.headEl.createEl("select", {
      cls: "vam-map-chat-model dropdown",
      attr: { "aria-label": t("ui.map_chat_model_label") }
    });
    this.modelEl.addEventListener("change", () => {
      this.host.setModel(this.modelEl.value);
      this.refreshControls();
    });
    this.saveEl = this.headEl.createEl("button", {
      cls: "vam-map-chat-save clickable-icon",
      attr: { type: "button", "aria-label": t("ui.map_chat_save"), title: t("ui.map_chat_save") }
    });
    setIcon(this.saveEl, "file-down");
    this.saveEl.addEventListener("click", () => void this.saveNote());
    const close = this.headEl.createEl("button", {
      cls: "vam-map-chat-close clickable-icon",
      attr: { "aria-label": t("ui.map_chat_close") }
    });
    setIcon(close, "x");
    close.addEventListener("click", () => this.setOpen(false, true));
    this.heroTitleEl = this.bodyEl.createDiv({
      cls: "vam-map-chat-hero-title",
      text: t("ui.map_chat_hero_title"),
      attr: { role: "heading", "aria-level": "2" }
    });
    // A map that has content opens the window onto an empty log: one line says what it is for.
    this.guideEl = this.bodyEl.createDiv({ cls: "vam-map-chat-guide", text: t("ui.map_chat_empty_log") });
    // The log is not a live region: a streaming reply would be read out word by word. `liveEl` says it once, when it ends.
    this.logEl = this.bodyEl.createDiv({
      cls: "vam-map-chat-log",
      attr: { role: "group", "aria-label": t("ui.map_chat_log_label"), tabindex: "0" }
    });
    // A [[link]] in a reply is an internal link anchor; Obsidian's own handler is not attached to this panel, so open it here.
    const openInternal = (event: MouseEvent | KeyboardEvent, from: unknown): void => {
      const target = from as { closest?: (selector: string) => Element | null } | null;
      const anchor = target?.closest?.("a");
      if (!anchor?.classList.contains("internal-link")) return;
      const href = anchor.getAttribute("data-href");
      if (!href) return;
      event.preventDefault();
      this.host.openLink(href, Keymap.isModEvent(event));
    };
    this.logEl.addEventListener("click", event => openInternal(event, event.target));
    // The link has no href, so it is reached with Tab and opened with Enter.
    this.logEl.addEventListener("keydown", event => {
      if (event.key === "Enter") openInternal(event, event.target);
    });
    // Suggested messages (examples on the opening screen). Tab order: these, the chips, the message field, the controls.
    this.suggestEl = this.bodyEl.createDiv({ cls: "vam-map-chat-suggest", attr: { role: "group" } });
    this.chipsEl = this.bodyEl.createDiv({
      cls: "vam-map-chat-chips",
      attr: { role: "group", "aria-label": t("ui.map_chat_references") }
    });
    this.hintEl = this.bodyEl.createDiv({ cls: "vam-map-chat-plan-hint" });
    this.hintEl.hidden = true;
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
    // The visible note can change without any event the view hears (a collapsed sidebar, say); focusing the field is the last look before typing.
    this.inputEl.addEventListener("focus", () => this.refreshNote());
    // Escape on any other control of the window folds it too (the message field handles its own, above).
    this.el.addEventListener("keydown", event => {
      const target = event.target as { tagName?: string } | null;
      if (event.key !== "Escape" || event.target === this.inputEl || target?.tagName === "SELECT") return;
      if (this.hero || event.isComposing) return;
      event.preventDefault();
      if (this.narrow) this.collapseOverlay(true);
      else this.setOpen(false, true);
    });
    this.resizerEl = this.el.createDiv({
      cls: "vam-map-chat-resizer",
      attr: {
        role: "separator",
        "aria-orientation": "vertical",
        "aria-label": t("ui.map_chat_width_label"),
        "aria-valuemin": String(MAP_CHAT_WIDTH_MIN),
        "aria-valuemax": String(MAP_CHAT_WIDTH_MAX),
        "aria-valuenow": String(this.width),
        tabindex: "0"
      }
    });
    this.resizerEl.addEventListener("keydown", event => this.onResizerKey(event));
    this.resizerEl.addEventListener("pointerdown", event => this.startResize(event));
    this.liveEl = this.el.createDiv({ cls: "vam-sr-only", attr: { "aria-live": "polite", "aria-atomic": "true" } });
    for (const name of ["dragenter", "dragover"] as const)
      this.el.addEventListener(name, event => this.onDragOver(event));
    this.el.addEventListener("dragleave", () => this.setDropHighlight(false));
    this.el.addEventListener("drop", event => this.onDrop(event));
    this.renderLog();
    this.renderBusy();
    this.stopWatching = this.host.watchModels(() => this.refreshControls());
  }

  /**
   * The save button: hidden on the opening screen, and "disabled" (still reachable by keyboard, so its title can be read) while
   * there is no finished turn or the map has no folder to save into.
   */
  private refreshSave(): void {
    if (!this.built || !this.saveEl) return;
    this.saveEl.hidden = this.hero;
    this.saveEl.toggleClass("is-hidden", this.hero);
    let why = "";
    if (!this.completedTurns().length) why = t("ui.map_chat_save_empty");
    else if (!this.host.saveTranscript) why = t("ui.map_chat_save_unavailable");
    else {
      const can = this.host.canSave?.();
      if (can && !can.ok) why = can.reason;
    }
    const disabled = !!why || this.saving;
    this.saveDisabled = disabled;
    this.saveEl.setAttr("aria-disabled", String(disabled));
    this.saveEl.toggleClass("is-disabled", disabled);
    this.saveEl.setAttr("title", why || t("ui.map_chat_save"));
  }
  private async saveNote(): Promise<void> {
    if (!this.built || this.saving || this.saveDisabled) return;
    const turns = this.completedTurns();
    if (!turns.length || !this.host.saveTranscript) return;
    this.saving = true;
    this.refreshSave();
    try {
      const result = await this.host.saveTranscript(turns);
      // The keyboard stays on the button; the reader is told once.
      this.announceImages(result.ok ? t("ui.map_chat_saved_0", result.path) : result.reason);
    } finally {
      this.saving = false;
      this.refreshSave();
    }
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === "Escape" && !event.isComposing && !this.composing) {
      // On the opening screen there is no window to fold.
      if (this.hero) return;
      event.preventDefault();
      if (this.narrow) this.collapseOverlay(true);
      else this.setOpen(false, true);
      return;
    }
    // Enter sends, Shift+Enter breaks the line, and a key that confirms an IME candidate does neither.
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || this.composing) return;
    event.preventDefault();
    this.host.send();
  }

  // ---- width ----------------------------------------------------------------------------------------------------

  /**
   * `from` is the set width and the shown width before this adjustment. A window the pane squeezed shows less than was set; a
   * widening that stays under the set width must not shrink the set width, so a width is written only when it is larger than
   * the set width or narrower than what was shown.
   */
  private resizeTo(
    width: number,
    commit: boolean,
    from: { set: number; shown: number } = { set: this.width, shown: this.shownWidth() }
  ): void {
    const next = clampMapChatWidth(width);
    const writes = next > from.set || next < from.shown;
    const widths = this.host.widths?.(next);
    if (widths) {
      this.dockedPx = widths.docked;
      this.overlayPx = widths.overlay;
    }
    if (writes) this.width = next;
    this.applyWidth();
    if (writes) this.host.setWidth?.(this.width, commit);
  }
  /** The width the window has on the page now: the set width, given way to when the pane has no room for it. */
  private shownWidth(): number {
    if (this.floating) return this.overlayPx ?? this.width;
    return this.dockedPx ?? this.width;
  }
  private applyWidth(): void {
    if (!this.built) return;
    this.el.style.width = this.docked || this.floating ? `${this.shownWidth()}px` : "";
    this.resizerEl.setAttr("aria-valuenow", String(this.shownWidth()));
  }
  private onResizerKey(event: KeyboardEvent): void {
    const to =
      event.key === "ArrowLeft"
        ? this.shownWidth() - MAP_CHAT_WIDTH_STEP
        : event.key === "ArrowRight"
          ? this.shownWidth() + MAP_CHAT_WIDTH_STEP
          : event.key === "Home"
            ? MAP_CHAT_WIDTH_MIN
            : event.key === "End"
              ? MAP_CHAT_WIDTH_MAX
              : null;
    if (to === null) return;
    event.preventDefault();
    this.resizeTo(to, true);
  }
  /**
   * Dragging the handle. The listeners sit on the page's document, not on the handle, so a repaint of the map in the middle
   * (which lifts the panel out and puts it back) does not break the drag. They are removed when the button is let go, when
   * the pointer capture is lost, and when the view closes.
   */
  private startResize(event: PointerEvent): void {
    if (event.button) return;
    this.stopResizing?.();
    const doc: Document | undefined = this.el.ownerDocument;
    if (!doc?.addEventListener) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.shownWidth();
    const from = { set: this.width, shown: startWidth };
    const handle = this.resizerEl;
    const move = (next: PointerEvent): void => {
      if (next.buttons === 0) end();
      else this.resizeTo(startWidth + (next.clientX - startX), false, from);
    };
    const end = (): void => {
      const stop = this.stopResizing;
      this.stopResizing = null;
      stop?.();
      this.host.setWidth?.(this.width, true);
    };
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", end);
    doc.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // No capture (a synthetic event): the document listeners still follow the pointer.
    }
    this.el.addClass("is-resizing");
    this.stopResizing = () => {
      doc.removeEventListener("pointermove", move);
      doc.removeEventListener("pointerup", end);
      doc.removeEventListener("pointercancel", end);
      handle.removeEventListener("lostpointercapture", end);
      this.el.removeClass("is-resizing");
      this.stopResizing = null;
    };
  }

  // ---- messages the reader hears and the dot on the narrow edge ----------------------------------------------------

  private announce(text: string): void {
    if (!this.built) return;
    // Sentences held back while a reply streamed are read right after the one that ends it.
    this.liveEl.setText([text, ...this.spokenLater.splice(0)].filter(Boolean).join(" "));
  }
  private announceImages(text: string): void {
    if (this.busy) this.spokenLater.push(text);
    else this.announce(text);
  }
  private countsText(counts: ChatLineCounts): string {
    const parts: string[] = [];
    if (counts.done) parts.push(t("ui.map_chat_count_done_0", counts.done));
    if (counts.skipped) parts.push(t("ui.map_chat_count_skipped_0", counts.skipped));
    if (counts.failed) parts.push(t("ui.map_chat_count_failed_0", counts.failed));
    return parts.join(t("ui.map_chat_count_separator"));
  }
  /** The counts as one sentence; a failed count is set apart in the error colour, and its word says it as well. */
  private buildCounts(parent: HTMLElement, counts: ChatLineCounts): void {
    if (!counts.failed) {
      parent.setText(this.countsText(counts));
      return;
    }
    const rest = this.countsText({ ...counts, failed: 0 });
    if (rest) parent.createSpan({ text: `${rest}${t("ui.map_chat_count_separator")}` });
    parent.createSpan({ cls: "vam-map-chat-count-failed", text: t("ui.map_chat_count_failed_0", counts.failed) });
  }
  private spokenTurn(reply: string, lines: MapChatLine[]): string {
    const said = t("ui.map_chat_live_done_0", clip(reply, 160));
    const counts = this.countsText(countChatLines(lines, t("ui.map_chat_not_undoable")));
    return counts ? `${said} ${t("ui.map_chat_live_results_0", counts)}` : said;
  }
  /** A reply came in while the window is folded to its edge: the edge shows a dot. */
  private markUnread(): void {
    if (this.shown || !this.built) return;
    this.unread = true;
    this.applyOpen();
  }

  // ---- suggested messages -----------------------------------------------------------------------------------------

  /** Puts `text` into the message field and gives it the keyboard. Sending is always the user's own act. */
  private fill(text: string): void {
    const draft = this.inputEl.value;
    this.inputEl.value = draft.trim() ? `${draft.replace(/\s+$/, "")}\n${text}` : text;
    this.inputEl.focus();
    const end = this.inputEl.value.length;
    this.inputEl.setSelectionRange(end, end);
  }
  private renderSuggestions(): void {
    if (!this.built) return;
    const hero = this.hero;
    const keys = hero
      ? [...MAP_CHAT_EXAMPLE_KEYS]
      : this.host.suggestions
        ? chatSuggestionKeys({ ...this.host.suggestions(), hasNote: !!this.noteChip })
        : [];
    // Repaint only when something changed: a rebuilt button would take the keyboard focus away from a reader tabbing through.
    const signature = [hero ? "hero" : "side", ...keys.map(key => t(key))].join("\u0001");
    if (signature === this.suggestKey && hero === this.suggestInHero) return;
    this.suggestKey = signature;
    if (hero !== this.suggestInHero) {
      this.suggestInHero = hero;
      // The opening screen reads: title, message field, examples. The window reads: suggestions, chips, message field.
      this.suggestEl.remove();
      this.bodyEl.insertBefore(this.suggestEl, hero ? null : this.chipsEl);
    }
    this.suggestEl.empty();
    this.suggestEl.setAttr("aria-label", t(hero ? "ui.map_chat_examples_label" : "ui.map_chat_suggestions_label"));
    this.suggestEl.toggleClass("is-examples", hero);
    this.suggestEl.hidden = keys.length === 0;
    for (const key of keys) {
      const text = t(key);
      const button = this.suggestEl.createEl("button", {
        cls: hero ? "vam-map-chat-example" : "vam-map-chat-suggestion",
        text,
        attr: { type: "button" }
      });
      button.addEventListener("click", () => this.fill(text));
    }
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
    const { hero, docked, floating, shown } = {
      hero: this.hero,
      docked: this.docked,
      floating: this.floating,
      shown: this.shown
    };
    const hadUnread = this.unread;
    if (shown) this.unread = false;
    // Measured before the classes change: a folded log measures as at its end.
    const opening = shown && !this.wasShown && floating && !hero;
    const stick = opening && this.atEnd();
    this.wasShown = shown;
    if (!shown) this.cancelOpenFrame();
    this.el.toggleClass("is-open", shown && !hero);
    this.el.toggleClass("is-hero", hero);
    this.el.toggleClass("is-docked", docked);
    this.el.toggleClass("is-overlay", floating);
    this.el.toggleClass("is-rail", !shown);
    this.bodyEl.hidden = !shown;
    this.bodyEl.toggleClass("is-hidden", !shown);
    this.toggleEl.hidden = shown;
    this.toggleEl.toggleClass("is-hidden", shown);
    this.toggleEl.toggleClass("has-unread", this.unread);
    this.badgeEl.hidden = !this.unread;
    this.toggleEl.setAttr("aria-expanded", String(shown));
    this.toggleEl.setAttr(
      "aria-label",
      t(shown ? "ui.map_chat_close" : this.unread ? "ui.map_chat_open_unread" : "ui.map_chat_open")
    );
    this.resizerEl.hidden = !docked;
    this.resizerEl.toggleClass("is-hidden", !docked);
    this.headEl.toggleClass("is-hero", hero);
    this.heroTitleEl.hidden = !hero;
    this.heroTitleEl.toggleClass("is-hidden", !hero);
    // The opening screen asks for a topic; the side window talks about the map in front of it.
    this.inputEl.setAttr("placeholder", t(hero ? "ui.map_chat_hero_placeholder" : "ui.map_chat_input_placeholder"));
    this.applyWidth();
    this.renderSuggestions();
    this.renderGuide();
    this.refreshSave();
    // Someone opens the window because a reply came in while it was folded: they land on the newest message.
    if (shown && hadUnread) this.scrollToEnd();
    if (stick) this.scrollToEndWhenSettled();
  }
  private cancelOpenFrame(): void {
    this.openFrame?.cancel();
    this.openFrame = null;
  }
  /** The overlay's height is final only after the classes are laid out, so the scroll to the end waits for the next frame. */
  private scrollToEndWhenSettled(): void {
    this.cancelOpenFrame();
    const win =
      this.logEl.win ?? this.logEl.ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : undefined);
    if (typeof win?.requestAnimationFrame !== "function") {
      this.scrollToEnd();
      return;
    }
    const id = win.requestAnimationFrame(() => {
      this.openFrame = null;
      if (this.shown) this.scrollToEnd();
    });
    this.openFrame = { cancel: () => win.cancelAnimationFrame?.(id) };
  }
  /** An empty conversation in the side window shows one line of guidance in place of the log. */
  private renderGuide(): void {
    if (!this.built) return;
    const empty = this.messages.length === 0 && !this.hero;
    this.guideEl.hidden = !empty;
    this.guideEl.toggleClass("is-hidden", !empty);
    this.logEl.hidden = empty;
    this.logEl.toggleClass("is-hidden", empty);
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
    // A long label (the follow-default entry names the model) is shortened in the list; the full one is its tooltip.
    for (const choice of choices)
      this.modelEl.createEl("option", {
        text: choice.short ?? choice.label,
        value: choice.value,
        attr: { title: choice.label }
      });
    this.modelEl.value = this.host.model();
    this.modelEl.setAttr("title", choices.find(choice => choice.value === this.modelEl.value)?.label ?? "");
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

  /** Everything a message row shows; the row is rebuilt only when this changes. */
  private rowKey(message: MapChatMessage): string {
    const asked = this.messages[this.messages.indexOf(message) - 1];
    const more = this.hasMore(message, asked);
    return [
      message.role,
      message.error ? "e" : "",
      message.streaming ? "s" : "",
      more ? "m" : "",
      this.canRetry(message, asked) ? "r" : "",
      message.linesOpen ? "o" : "",
      t("ui.map_chat_retry"),
      t("ui.map_chat_lines_hide"),
      t("ui.map_chat_plan_summary_0", ""),
      t("ui.map_chat_plan_title"),
      t("ui.map_chat_plan_title_applied"),
      t("ui.map_chat_plan_title_cancelled"),
      t("ui.map_chat_role_you"),
      t("ui.map_chat_role_ai"),
      t("ui.map_chat_overflow_note"),
      t("ui.map_chat_images_source"),
      more ? t("ui.map_chat_more_detail") : "",
      message.lines.map(line => `${line.status}:${line.text}`).join("\n"),
      message.plan
        ? `plan:${message.plan.state}:${message.plan.items.length}:${message.plan.estimate}:${message.plan.groups?.map(group => `${group.label}${group.danger ? "!" : ""}`).join("|") ?? ""}`
        : "",
      message.choices ? `choices:${message.choices.picked}:${message.choices.options.map(o => o.label).join("|")}` : "",
      (message.images ?? [])
        .map(
          block =>
            `images:${block.state}:${block.reason ?? ""}:${block.notice ?? ""}:${block.items
              .map(item => [item.candidate.url, item.inserted ?? "", item.broken ? 1 : 0, item.busy ? 1 : 0].join("~"))
              .join(",")}`
        )
        .join(";"),
      message.text
    ].join("\u0001");
  }
  private canRetry(message: MapChatMessage, asked: MapChatMessage | undefined): boolean {
    return (
      message.role === "assistant" && !!message.error && !message.streaming && !!asked?.origin && !!this.host.retry
    );
  }
  private hasMore(message: MapChatMessage, asked: MapChatMessage | undefined): boolean {
    return (
      message.role === "assistant" &&
      !message.streaming &&
      !message.error &&
      !!message.text.trim() &&
      !!asked?.origin &&
      // Saying it again would replace the plan that waits for its answer.
      message.plan?.state !== "pending"
    );
  }

  private renderLog(forceEnd = false): void {
    if (!this.built) return;
    this.cancelFrame();
    const stick = forceEnd || this.atEnd();
    // Rows of messages that have not changed are kept as they are (no parsing, no new elements); only the rest is built.
    const keys = this.messages.map(message => this.rowKey(message));
    const kept = new Set<HTMLElement>();
    this.messages.forEach((message, index) => {
      const entry = this.rows.get(message);
      if (entry && entry.key === keys[index]) kept.add(entry.row);
    });
    for (const child of Array.from(this.logEl.children)) if (!kept.has(child as HTMLElement)) child.remove();
    this.messageEls = [];
    this.bodyEls = [];
    this.messages.forEach((message, index) => {
      let entry = this.rows.get(message);
      if (!entry || entry.key !== keys[index]) {
        entry = { ...this.buildRow(message), key: keys[index] };
        this.rows.set(message, entry);
      }
      const at = this.logEl.children[index];
      if (at !== entry.row) this.logEl.insertBefore(entry.row, at ?? null);
      if (entry.more) entry.more.disabled = this.working;
      this.messageEls.push(entry.row);
      this.bodyEls.push(entry.body);
    });
    this.renderGuide();
    this.refreshSave();
    if (stick) this.scrollToEnd();
  }

  private buildRow(message: MapChatMessage): {
    row: HTMLElement;
    body: HTMLElement;
    more: HTMLButtonElement | null;
  } {
    const row = this.logEl.createDiv({
      cls: `vam-map-chat-msg is-${message.role}${message.error ? " is-error" : ""}`
    });
    row.createSpan({
      cls: "vam-map-chat-role",
      text: t(message.role === "user" ? "ui.map_chat_role_you" : "ui.map_chat_role_ai")
    });
    const markdown = message.role === "assistant" && !message.error;
    const body = row.createDiv({ cls: `vam-map-chat-text${markdown ? " is-markdown" : ""}` });
    if (markdown) renderChatMarkdown(body, message.text, t("ui.map_chat_overflow_note"));
    else body.setText(message.text);
    if (message.plan) this.buildPlan(row, message.plan);
    if (message.choices) this.buildChoices(row, message.choices);
    if (message.lines.length) this.buildLines(row, message);
    for (const block of message.images ?? []) this.buildImages(row, block);
    // What the AI actually did comes straight after what it said; the buttons that act on the answer come last.
    const asked = this.messages[this.messages.indexOf(message) - 1];
    let more: HTMLButtonElement | null = null;
    if (this.hasMore(message, asked) && asked?.origin) {
      const origin = asked.origin;
      more = row.createEl("button", {
        cls: "vam-map-chat-more",
        text: t("ui.map_chat_more_detail"),
        attr: { type: "button" }
      });
      more.disabled = this.working;
      more.addEventListener("click", () => {
        if (!this.working) this.host.moreDetail(origin);
      });
    }
    if (this.canRetry(message, asked) && asked?.origin) {
      const origin = asked.origin;
      more = row.createEl("button", {
        cls: "vam-map-chat-retry",
        text: t("ui.map_chat_retry"),
        attr: { type: "button" }
      });
      more.disabled = this.working;
      more.addEventListener("click", () => {
        if (!this.working) this.host.retry?.(origin);
      });
    }
    return { row, body, more };
  }

  /**
   * One line per action. More than five fold into a count (the closing "cannot be undone" note stays); each line says what
   * happened in words, so the colour is never the only sign.
   */
  private buildLines(row: HTMLElement, message: MapChatMessage): void {
    const closing = t("ui.map_chat_not_undoable");
    const results = message.lines.filter(line => line.text !== closing);
    const notes = message.lines.filter(line => line.text === closing);
    const list = row.createDiv({ cls: "vam-map-chat-lines" });
    const fold = results.length > MAP_CHAT_LINES_FOLD_ABOVE;
    const shown = !fold || message.linesOpen === true;
    if (fold) {
      this.buildCounts(list.createDiv("vam-map-chat-lines-summary"), countChatLines(results));
      const toggle = list.createEl("button", {
        cls: "vam-map-chat-lines-toggle",
        text: shown ? t("ui.map_chat_lines_hide") : t("ui.map_chat_lines_show_0", results.length),
        attr: { type: "button", "aria-expanded": String(shown) }
      });
      toggle.addEventListener("click", () => {
        message.linesOpen = !shown;
        this.renderLog();
        // The row was rebuilt, and the button with it: the keyboard goes to its successor.
        this.rows.get(message)?.row.querySelector<HTMLElement>(".vam-map-chat-lines-toggle")?.focus();
      });
    }
    if (shown)
      for (const line of results) list.createDiv({ cls: `vam-map-chat-line is-${line.status}`, text: line.text });
    for (const note of notes) list.createDiv({ cls: "vam-map-chat-line is-note", text: note.text });
  }

  /**
   * The plan card: one sentence, the actions folded by kind of work, the estimate, and Apply / Cancel. All plain elements
   * (buttons, details), so Tab, Enter and Space work without any script.
   */
  private buildPlan(row: HTMLElement, plan: MapChatPlanCard): void {
    const card = row.createDiv({ cls: `vam-map-chat-plan is-${plan.state}` });
    // The title follows what became of the plan, so a card read again later does not look as if it still waits.
    const title = t(
      plan.state === "applied"
        ? "ui.map_chat_plan_title_applied"
        : plan.state === "cancelled"
          ? "ui.map_chat_plan_title_cancelled"
          : "ui.map_chat_plan_title"
    );
    card.setAttr("role", "group");
    card.setAttr("aria-label", title);
    card.createDiv({ cls: "vam-map-chat-plan-title", text: title });
    card.createDiv({
      cls: "vam-map-chat-plan-sentence",
      text: plan.summary ?? t("ui.map_chat_plan_summary_0", plan.reasons.join(t("ui.map_chat_count_separator")))
    });
    const groups = plan.groups ?? (plan.items.length ? [{ label: "", items: plan.items }] : []);
    for (const group of groups) {
      const danger = "danger" in group ? group.danger : undefined;
      const list = group.label
        ? card.createEl("details", { cls: `vam-map-chat-plan-group${danger ? " is-danger" : ""}` })
        : card.createDiv("vam-map-chat-plan-group");
      if (group.label) {
        const summary = list.createEl("summary", { cls: "vam-map-chat-plan-group-title", text: group.label });
        // Text as well as colour: a group that removes cards says so in words.
        if (danger) summary.createSpan({ cls: "vam-map-chat-plan-mark", text: danger.mark });
      }
      const items = list.createEl("ol", { cls: "vam-map-chat-plan-items" });
      for (const item of group.items) items.createEl("li", { text: item });
    }
    card.createDiv({ cls: "vam-map-chat-plan-estimate", text: plan.estimate });
    if (plan.state !== "pending") {
      card.createDiv({
        cls: "vam-map-chat-plan-state",
        text: t(plan.state === "applied" ? "ui.map_chat_plan_applied" : "ui.map_chat_plan_cancelled")
      });
      return;
    }
    card.createDiv({ cls: "vam-map-chat-plan-note", text: t("ui.map_chat_plan_intro") });
    const buttons = card.createDiv({ cls: "vam-map-chat-plan-buttons" });
    const apply = buttons.createEl("button", {
      cls: "mod-cta vam-map-chat-plan-apply",
      text: t("ui.map_chat_plan_apply"),
      attr: { type: "button" }
    });
    const cancel = buttons.createEl("button", {
      cls: "vam-map-chat-plan-cancel",
      text: t("ui.map_chat_plan_cancel"),
      attr: { type: "button" }
    });
    // Said before the button is pressed, not after: applying clears the undo history.
    buttons.createSpan({ cls: "vam-map-chat-plan-warning", text: t("ui.map_chat_plan_irreversible") });
    // A second press does nothing: the buttons stop working as soon as one is used. They disappear with the repaint, so the
    // keyboard goes back to the message field instead of falling to the page.
    apply.addEventListener("click", () => {
      if (plan.state !== "pending") return;
      apply.disabled = cancel.disabled = true;
      plan.apply();
      this.focusInput();
    });
    cancel.addEventListener("click", () => {
      if (plan.state !== "pending") return;
      apply.disabled = cancel.disabled = true;
      plan.cancel();
      this.focusInput();
    });
  }
  /**
   * The picture candidates of one search. Every state says itself in words. A candidate is one button (insert it) and one link
   * (the page it came from); nothing here is run or fetched except the thumbnails, which are https images shown without a
   * referrer. All text goes in as text.
   */
  private buildImages(row: HTMLElement, block: MapChatImages): void {
    const box = row.createDiv({
      cls: `vam-map-chat-images is-${block.state}`,
      attr: { role: "group", "aria-label": t("ui.map_chat_images_label_0", clip(block.nodeTitle)) }
    });
    const text =
      block.state === "searching"
        ? t("ui.map_chat_images_searching_0", clip(block.query, 80))
        : block.state === "ready"
          ? t("ui.map_chat_images_ready_0_1", block.items.length, clip(block.nodeTitle))
          : block.state === "empty"
            ? t("ui.map_chat_images_none")
            : block.state === "failed"
              ? t("ui.map_chat_images_failed_0", clip(block.reason ?? "", 160))
              : t("ui.map_chat_images_stopped");
    box.createDiv({ cls: "vam-map-chat-images-status", text });
    if (block.state === "searching" && block.stop) {
      const stop = box.createEl("button", {
        cls: "vam-map-chat-images-stop",
        text: t("ui.map_chat_images_stop"),
        attr: { type: "button" }
      });
      stop.addEventListener("click", () => block.stop?.());
    }
    if (block.state === "ready") {
      const list = box.createDiv({ cls: "vam-map-chat-images-list", attr: { role: "list" } });
      block.items.forEach(item => this.buildImageItem(list, block, item));
    }
    if (block.notice)
      box.createDiv({ cls: "vam-map-chat-images-notice", text: block.notice, attr: { role: "status" } });
  }
  private buildImageItem(list: HTMLElement, block: MapChatImages, item: MapChatImageItem): void {
    const { candidate } = item;
    const cell = list.createDiv({ cls: "vam-map-chat-images-item", attr: { role: "listitem" } });
    const pick = cell.createEl("button", {
      cls: "vam-map-chat-images-pick",
      attr: {
        type: "button",
        "aria-label": item.inserted
          ? t("ui.map_chat_images_inserted_0", clip(item.inserted))
          : t("ui.map_chat_images_insert_0_1", clip(candidate.title), clip(block.nodeTitle)),
        "aria-disabled": String(!!item.inserted || !!item.broken || !!item.busy)
      }
    });
    this.pickEls.set(item, pick);
    // Only the https address the parser kept; no referrer is sent, and nothing runs.
    const thumb = item.broken
      ? null
      : pick.createEl("img", {
          cls: "vam-map-chat-images-thumb",
          attr: { src: candidate.url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }
        });
    pick.createSpan({ cls: "vam-map-chat-images-title", text: clip(candidate.title, 80) });
    if (item.inserted)
      pick.createSpan({
        cls: "vam-map-chat-images-state",
        text: t("ui.map_chat_images_inserted_0", clip(item.inserted))
      });
    if (item.broken) pick.createSpan({ cls: "vam-map-chat-images-state", text: t("ui.map_chat_images_broken") });
    thumb?.addEventListener("error", () => {
      item.broken = true;
      pick.setAttr("aria-disabled", "true");
      thumb.remove();
      pick.createSpan({ cls: "vam-map-chat-images-state", text: t("ui.map_chat_images_broken") });
    });
    pick.addEventListener("click", () => this.pickImage(block, item));
    cell.createEl("a", {
      cls: "vam-map-chat-images-source",
      text: t("ui.map_chat_images_source"),
      attr: {
        href: candidate.source,
        target: "_blank",
        rel: "noopener noreferrer",
        "aria-label": t("ui.map_chat_images_source_0", clip(candidate.title))
      }
    });
  }
  /** A candidate was chosen: the host inserts it into the card; the button is inert while that runs and afterwards. */
  private pickImage(block: MapChatImages, item: MapChatImageItem): void {
    if (item.inserted || item.broken || item.busy || !this.host.insertImage) return;
    const hadFocus = this.hasFocus();
    item.busy = true;
    block.notice = undefined;
    this.renderLog();
    if (hadFocus) this.pickEls.get(item)?.focus();
    void this.host.insertImage(block, item).then(
      result => {
        item.busy = false;
        if (result.ok) item.inserted = block.nodeTitle;
        block.notice = result.ok ? undefined : result.reason;
        this.renderLog();
        if (hadFocus) this.pickEls.get(item)?.focus();
        this.announceImages(result.ok ? t("ui.map_chat_images_inserted_0", clip(block.nodeTitle)) : result.reason);
      },
      (error: unknown) => {
        item.busy = false;
        block.notice = t("ui.map_chat_images_insert_failed_0", error instanceof Error ? error.message : String(error));
        this.renderLog();
        if (hadFocus) this.pickEls.get(item)?.focus();
      }
    );
  }
  private buildChoices(row: HTMLElement, choices: MapChatChoices): void {
    const box = row.createDiv({ cls: "vam-map-chat-choices" });
    box.setAttr("role", "group");
    box.setAttr("aria-label", choices.prompt);
    box.createDiv({ cls: "vam-map-chat-choices-prompt", text: choices.prompt });
    const buttons: HTMLButtonElement[] = [];
    for (const option of choices.options) {
      const button = box.createEl("button", {
        cls: "vam-map-chat-choice",
        text: option.label,
        attr: { type: "button" }
      });
      button.disabled = choices.picked;
      buttons.push(button);
      button.addEventListener("click", () => {
        if (choices.picked) return;
        choices.picked = true;
        for (const other of buttons) other.disabled = true;
        // One pick ends every list of maps shown so far.
        this.retireChoices(choices);
        option.pick();
        this.focusInput();
      });
    }
  }

  private renderBusy(): void {
    if (!this.built) return;
    this.statusEl.setText(this.busy ? t("ui.map_chat_replying") : this.applying ? t("ui.map_chat_applying") : "");
    this.el.toggleClass("is-busy", this.working);
    this.sendEl.hidden = this.working;
    this.sendEl.toggleClass("is-hidden", this.working);
    this.stopEl.hidden = !this.working;
    this.stopEl.toggleClass("is-hidden", !this.working);
    this.renderHint();
    this.host.stateChanged?.();
  }
  /** While a plan waits for its answer a line above the message field says what sending a new message does to it. */
  private renderHint(): void {
    if (!this.built) return;
    const waiting = !this.working && this.pendingPlan() !== null;
    this.hintEl.setText(waiting ? t("ui.map_chat_plan_replace_hint") : "");
    this.hintEl.hidden = !waiting;
    this.hintEl.toggleClass("is-hidden", !waiting);
  }

  /** True when the log is scrolled to its end (or cannot be measured), so a longer reply should keep the end in view. */
  private atEnd(): boolean {
    if (!this.built) return true;
    const gap = this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight;
    return !Number.isFinite(gap) || gap <= 8;
  }
  private scrollToEnd(): void {
    if (this.built) this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
