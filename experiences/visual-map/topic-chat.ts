import { setIcon } from "obsidian";
import { t } from "../../i18n";
import { renderChatMarkdown } from "../../core/map-chat-render";

/** The three buttons; a message typed without one is an "ask". */
export type TopicChatButtonKind = "research" | "expand" | "synthesize";
export type TopicChatKind = TopicChatButtonKind | "ask";
export type TopicChatMode = "quick" | "standard";

/** One line of the conversation. The text is always shown as plain text. */
export interface TopicChatTurn {
  role: "user" | "ai";
  /** The button the user pressed, or "ask" for free typing; only on user turns. */
  kind?: TopicChatKind;
  text: string;
  /** An AI answer to a free question: shown through the chat's markdown whitelist (every other line is plain text). */
  markdown?: boolean;
  /** Additions typed while this turn's task ran, in typed order; shown under the turn. "live" went into the task, "queued" waits for it to end. */
  steers?: ReadonlyArray<{ text: string; state: "live" | "queued" }>;
}

export interface TopicChatSession {
  turns: readonly TopicChatTurn[];
  mode: TopicChatMode;
  running: boolean;
  /** The button pressed but not yet sent; its suggestion shows as grey text until adopted. */
  draftKind: TopicChatButtonKind | null;
  draftText: string;
}

export interface TopicChatRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What the window needs from its owner; the view implements it. */
export interface TopicChatHost {
  topicTitle(): string;
  /** The topic card and the canvas area, both in the same (client) coordinates; null while the card is not drawn. */
  anchor(): { card: TopicChatRect; area: TopicChatRect; controls?: TopicChatRect | null } | null;
  session(): TopicChatSession;
  /** Calls `changed` whenever the session changes; returns the unsubscribe function. */
  subscribe(changed: () => void): () => void;
  setMode(mode: TopicChatMode): void;
  /** Remembers the unsent button and text so a repaint keeps them. */
  setDraft(kind: TopicChatButtonKind | null, text: string): void;
  /** Resolves true when a run started (the input then clears), false when it was declined (the input stays). */
  submit(kind: TopicChatKind, text: string): Promise<boolean>;
  /** An addition typed while a task runs; true when it was taken (the input then clears), false when it was not (the input stays). */
  steer(text: string): boolean;
  close(): void;
}

const MODES: readonly TopicChatMode[] = ["quick", "standard"];
const KINDS: readonly TopicChatButtonKind[] = ["research", "expand", "synthesize"];
const WIDTH_FALLBACK = 340;
const NARROW_AREA = 360;
const GAP = 8;

function kindLabel(kind: TopicChatButtonKind): string {
  return t(`ui.topic_chat_${kind}`);
}

function modeName(mode: TopicChatMode): string {
  return mode === "quick" ? t("ui.quick") : t("ui.standard");
}

function modeIcon(mode: TopicChatMode): string {
  return mode === "quick" ? "zap" : "globe";
}

function suggestion(kind: TopicChatButtonKind): string {
  return t(`ui.topic_chat_suggest_${kind}`);
}

let labelSeq = 0;

/** The small conversation window next to a topic card. Pure DOM; geometry comes from the host. */
export class TopicChatWindow {
  readonly el: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly inputEl: HTMLTextAreaElement;
  private readonly sendEl: HTMLButtonElement;
  private readonly ghostEl: HTMLElement;
  private readonly ghostTextEl: HTMLElement;
  private readonly modeHintEl: HTMLElement;
  private readonly kindEls = new Map<TopicChatButtonKind, HTMLButtonElement>();
  private readonly modeEls = new Map<TopicChatMode, HTMLButtonElement>();
  private readonly modePickerEl: HTMLElement;
  private readonly modeToggleEl: HTMLButtonElement;
  private readonly modeMenuEl: HTMLElement;
  private iconMode: TopicChatMode | null = null;
  private readonly cleanups: Array<() => void> = [];
  private parentEl: HTMLElement | null = null;
  private submitting = false;
  private destroyed = false;

  constructor(
    private readonly host: TopicChatHost,
    private readonly opener: { focus(): void } | null,
    parent: HTMLElement
  ) {
    this.el = parent.createDiv({ cls: "vam-topic-chat" });
    this.el.setAttr("role", "dialog");
    // aria-labelledby, not aria-label: Obsidian shows an aria-label as a hover tooltip that covers the line under the input.
    const labelId = `vam-topic-chat-label-${++labelSeq}`;
    this.el.createSpan({
      cls: "vam-sr-only",
      text: t("ui.topic_chat_label_0", host.topicTitle()),
      attr: { id: labelId }
    });
    this.el.setAttr("aria-labelledby", labelId);
    const head = this.el.createDiv("vam-topic-chat-head");
    head.createSpan({ cls: "vam-topic-chat-title", text: host.topicTitle() });
    const close = head.createEl("button", {
      cls: "vam-topic-chat-close clickable-icon",
      text: "×",
      attr: { type: "button", "aria-label": t("ui.topic_chat_close") }
    });
    this.on(close, "click", () => this.requestClose());

    this.logEl = this.el.createDiv("vam-topic-chat-log");

    const actions = this.el.createDiv("vam-topic-chat-actions");
    for (const kind of KINDS) {
      const button = actions.createEl("button", {
        cls: "vam-topic-chat-action",
        text: kindLabel(kind),
        attr: { type: "button", "aria-pressed": "false" }
      });
      this.kindEls.set(kind, button);
      this.on(button, "click", () => this.pickKind(kind));
    }

    const composer = this.el.createDiv("vam-topic-chat-composer");
    this.inputEl = composer.createEl("textarea", {
      cls: "vam-topic-chat-input",
      attr: { rows: "3", "aria-labelledby": labelId }
    });
    this.on(this.inputEl, "input", () => this.typed());
    this.on(this.inputEl, "keydown", event => this.keydown(event));
    // The grey suggestion lives in an overlay that lays out like the input (it wraps the same way); the placeholder stays for
    // assistive tech but is drawn transparent while this shows. Tab adopts it (see keydown); no on-screen label says so.
    this.ghostEl = composer.createDiv({ cls: "vam-topic-chat-ghost", attr: { "aria-hidden": "true" } });
    this.ghostTextEl = this.ghostEl.createSpan({ cls: "vam-topic-chat-ph" });
    const foot = composer.createDiv("vam-topic-chat-foot");
    // The AI mode is one small icon button; its menu is built once and only its attributes change afterwards.
    this.modePickerEl = foot.createSpan("vam-topic-chat-mode-picker");
    this.modeToggleEl = this.modePickerEl.createEl("button", {
      cls: "vam-topic-chat-mode-toggle",
      attr: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false" }
    });
    this.modeMenuEl = this.modePickerEl.createDiv({
      cls: "vam-topic-chat-mode-menu",
      attr: { role: "menu", "aria-label": t("ui.ai_mode") }
    });
    this.modeMenuEl.hidden = true;
    for (const mode of MODES) {
      const button = this.modeMenuEl.createEl("button", {
        cls: "vam-topic-chat-mode",
        attr: { type: "button", role: "menuitemradio", "aria-checked": "false" }
      });
      setIcon(button.createSpan("vam-topic-chat-mode-icon"), modeIcon(mode));
      button.createSpan({ cls: "vam-topic-chat-mode-label", text: modeName(mode) });
      setIcon(button.createSpan("vam-topic-chat-mode-check"), "check");
      this.modeEls.set(mode, button);
      this.on(button, "click", () => this.pickMode(mode));
    }
    this.on(this.modeToggleEl, "click", event => {
      if (this.modeMenuEl.hidden) this.openModeMenu(event.detail === 0);
      else this.closeModeMenu(true);
    });
    this.on(this.modeToggleEl, "keydown", event => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      if (this.modeMenuEl.hidden) this.openModeMenu(true);
    });
    this.on(this.modeMenuEl, "keydown", event => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const buttons = MODES.map(mode => this.modeEls.get(mode)!);
      const at = buttons.findIndex(button => button === event.target);
      const step = event.key === "ArrowDown" ? 1 : -1;
      buttons[(Math.max(at, 0) + step + buttons.length) % buttons.length].focus();
    });
    this.on(this.modePickerEl, "focusout", event => {
      const next = event.relatedTarget as Node | null;
      if (!next || !this.modePickerEl.contains(next)) this.closeModeMenu(false);
    });
    const doc = parent.ownerDocument;
    if (doc?.addEventListener) {
      const outside = (event: MouseEvent): void => {
        if (!this.modeMenuEl.hidden && !this.modePickerEl.contains(event.target as Node)) this.closeModeMenu(false);
      };
      doc.addEventListener("mousedown", outside);
      this.cleanups.push(() => doc.removeEventListener("mousedown", outside));
    }
    this.sendEl = foot.createEl("button", {
      cls: "vam-topic-chat-send",
      attr: { type: "button", "aria-label": t("ui.topic_chat_send") }
    });
    setIcon(this.sendEl, "corner-down-left");
    this.on(this.sendEl, "click", () => void this.send());
    this.modeHintEl = composer.createDiv({
      cls: "vam-topic-chat-mode-hint",
      attr: { "aria-live": "polite" }
    });

    this.on(this.el, "keydown", event => {
      if (event.key !== "Escape") return;
      event.preventDefault?.();
      event.stopPropagation?.();
      // An open mode menu takes the first Escape; only a second one closes the window.
      if (!this.modeMenuEl.hidden) this.closeModeMenu(true);
      else this.requestClose();
    });
    this.cleanups.push(host.subscribe(() => this.refresh()));
    const draft = host.session();
    this.inputEl.value = draft.draftText;
    this.refresh();
  }

  /** Puts `text` in the input (a draft handed back); a repaint alone never writes the input's value. */
  setInputText(text: string): void {
    if (this.destroyed) return;
    this.inputEl.value = text;
    this.refresh();
  }

  /** Puts the window in `parent` (again, after a repaint), places it and, unless `focus` is false, moves the focus to the input. */
  mount(parent: HTMLElement, focus = true): void {
    const attached = !parent.contains(this.el);
    if (attached) parent.appendChild(this.el);
    // JS-toggled (the map stylesheet allows no :has()): lifts this overlay above the controls overlay that follows it.
    parent.addClass("has-topic-chat");
    this.parentEl = parent;
    this.reposition();
    // Putting the element back resets its scroll to the top: bring the newest turn into view again (a mount that moved nothing keeps the reader's place).
    if (attached) this.logEl.scrollTop = this.logEl.scrollHeight;
    if (focus) this.inputEl.focus();
  }

  /** Right of the card when it fits, else left; a narrow canvas puts the window at the bottom. Missing geometry leaves it as is. */
  reposition(): void {
    if (this.destroyed) return;
    const anchor = this.host.anchor();
    if (!anchor) return;
    const { card, area, controls } = anchor;
    const areaWidth = area.right - area.left;
    const areaHeight = area.bottom - area.top;
    if (!(areaWidth > 0)) return;
    if (areaWidth < NARROW_AREA) {
      this.el.addClass("is-bottom");
      // The bottom placement keeps its 8px margins; a taller window gives the room back from its log.
      this.el.setCssProps({
        left: "0px",
        top: "",
        "--vam-topic-chat-max": areaHeight > 16 ? `${areaHeight - 16}px` : ""
      });
      return;
    }
    this.el.removeClass("is-bottom");
    const width = this.el.offsetWidth || WIDTH_FALLBACK;
    let left = card.right - area.left + GAP;
    if (left + width > areaWidth) left = card.left - area.left - width - GAP;
    left = Math.max(0, Math.min(left, areaWidth - width));
    let top = card.top - area.top;
    let floor = areaHeight;
    // Keep the window off the zoom/layout controls in the bottom corner: its lower edge stops above them when they share columns.
    if (controls && controls.left < area.left + left + width && controls.right > area.left + left) {
      floor = Math.min(floor, controls.top - area.top - GAP);
    }
    // The window never grows past the space it has: only its log gives way (it scrolls), so the input and buttons stay reachable.
    const height = floor > 0 ? Math.min(this.el.offsetHeight || 0, floor) : this.el.offsetHeight || 0;
    if (floor > 0) top = Math.max(0, Math.min(top, floor - height));
    this.el.setCssProps({ left: `${left}px`, top: `${top}px`, "--vam-topic-chat-max": floor > 0 ? `${floor}px` : "" });
  }

  /** Releases every listener and removes the window. Does not tell the host. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.parentEl?.removeClass("has-topic-chat");
    this.el.remove();
  }

  private on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    name: K,
    handler: (event: HTMLElementEventMap[K]) => void
  ): void {
    target.addEventListener(name, handler);
    this.cleanups.push(() => target.removeEventListener(name, handler));
  }

  private requestClose(): void {
    this.host.close();
    this.opener?.focus();
  }

  private openModeMenu(focusCurrent: boolean): void {
    if (this.host.session().running) return;
    this.modeMenuEl.hidden = false;
    this.modeToggleEl.setAttr("aria-expanded", "true");
    if (focusCurrent) this.modeEls.get(this.host.session().mode)?.focus();
  }

  private closeModeMenu(focusToggle: boolean): void {
    if (this.modeMenuEl.hidden) return;
    this.modeMenuEl.hidden = true;
    this.modeToggleEl.setAttr("aria-expanded", "false");
    if (focusToggle) this.modeToggleEl.focus();
  }

  private pickMode(mode: TopicChatMode): void {
    if (this.host.session().running) return;
    this.host.setMode(mode);
    this.closeModeMenu(true);
  }

  private pickKind(kind: TopicChatButtonKind): void {
    if (this.host.session().running) return;
    this.inputEl.value = "";
    this.host.setDraft(kind, "");
    this.refresh();
    this.inputEl.focus();
  }

  private typed(): void {
    const { draftKind } = this.host.session();
    this.host.setDraft(draftKind, this.inputEl.value);
    this.refresh();
  }

  private keydown(event: KeyboardEvent): void {
    if (event.key === "Tab" && !event.shiftKey) {
      const { draftKind, running } = this.host.session();
      if (draftKind && !running && this.inputEl.value === "") {
        event.preventDefault();
        this.inputEl.value = suggestion(draftKind);
        this.host.setDraft(draftKind, this.inputEl.value);
        this.refresh();
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void this.send();
    }
  }

  private canSend(): boolean {
    // A button pressed but its grey suggestion not adopted leaves the field empty: nothing to send. Typing alone is a question.
    return !this.submitting && this.inputEl.value.trim() !== "";
  }

  private async send(): Promise<void> {
    if (!this.canSend()) return;
    const session = this.host.session();
    const text = this.inputEl.value.trim();
    if (session.running) {
      // A task is running: the text is an addition to it (the buttons and mode stay as they are).
      if (!this.host.steer(text)) return;
      this.host.setDraft(session.draftKind, "");
      if (this.destroyed) return;
      this.inputEl.value = "";
      this.refresh();
      return;
    }
    const kind: TopicChatKind = session.draftKind ?? "ask";
    this.submitting = true;
    this.refresh();
    let started = false;
    try {
      started = await this.host.submit(kind, text);
    } finally {
      this.submitting = false;
    }
    // A sent text is never a draft, even when the window was closed or replaced while the send was under way.
    if (started) this.host.setDraft(null, "");
    if (this.destroyed) return;
    if (started) this.inputEl.value = "";
    this.refresh();
  }

  /** Repaints everything from the session; cheap enough to run on every change. */
  private refresh(): void {
    if (this.destroyed) return;
    const session = this.host.session();
    const busy = session.running || this.submitting;
    const empty = this.inputEl.value === "";
    for (const [kind, button] of this.kindEls) {
      button.setAttr("aria-pressed", String(session.draftKind === kind));
      button.toggleClass("is-active", session.draftKind === kind);
      button.disabled = busy;
    }
    if (session.running) this.closeModeMenu(false);
    for (const [mode, button] of this.modeEls) {
      button.setAttr("aria-checked", String(session.mode === mode));
      button.toggleClass("is-active", session.mode === mode);
      button.disabled = session.running;
    }
    this.modeToggleEl.disabled = session.running;
    this.modeToggleEl.setAttr("aria-label", t("ui.topic_chat_mode_button_0", modeName(session.mode)));
    if (this.iconMode !== session.mode) {
      this.iconMode = session.mode;
      setIcon(this.modeToggleEl, modeIcon(session.mode));
    }
    this.modeHintEl.setText(
      session.running && !empty
        ? t("ui.map_chat_steer_hint")
        : session.mode === "quick"
          ? t("ui.topic_chat_mode_quick_hint")
          : t("ui.topic_chat_mode_standard_hint")
    );
    const ghost = session.draftKind && empty ? suggestion(session.draftKind) : "";
    this.inputEl.setAttr(
      "placeholder",
      ghost || (session.running ? t("ui.map_chat_steer_placeholder") : t("ui.topic_chat_placeholder"))
    );
    this.ghostEl.hidden = !ghost;
    this.inputEl.toggleClass("is-ghost", !!ghost);
    this.ghostTextEl.setText(ghost);
    this.sendEl.disabled = !this.canSend();
    this.paintLog(session);
    // The log changed height, so the window may no longer fit where it was put; then the newest turn is brought into view again.
    this.reposition();
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private paintLog(session: TopicChatSession): void {
    this.logEl.empty();
    for (const turn of session.turns) {
      const row = this.logEl.createDiv({
        cls: turn.role === "user" ? "vam-topic-chat-msg is-me" : "vam-topic-chat-msg"
      });
      const who =
        turn.role === "user"
          ? turn.kind && turn.kind !== "ask"
            ? t("ui.topic_chat_you_0", kindLabel(turn.kind))
            : t("ui.map_chat_role_you")
          : t("ui.map_chat_role_ai");
      row.createSpan({ cls: "vam-topic-chat-who", text: who });
      const body = row.createSpan({ cls: "vam-topic-chat-text" });
      if (turn.markdown) renderChatMarkdown(body, turn.text, t("ui.map_chat_overflow_note"));
      else body.setText(turn.text);
      for (const steer of turn.steers ?? []) {
        const bubble = this.logEl.createDiv({
          cls: steer.state === "queued" ? "vam-topic-chat-steer is-queued" : "vam-topic-chat-steer"
        });
        bubble.createSpan({
          cls: "vam-topic-chat-steer-tag",
          text: t(steer.state === "queued" ? "ui.map_chat_steer_tag_queued" : "ui.map_chat_steer_tag_live")
        });
        bubble.createSpan({ cls: "vam-topic-chat-steer-text", text: steer.text });
      }
    }
    if (session.running) {
      this.logEl.createDiv({ cls: "vam-topic-chat-msg is-running", text: t("ui.topic_chat_running") });
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
