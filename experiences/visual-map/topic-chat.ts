import { t } from "../../i18n";

export type TopicChatKind = "research" | "expand" | "synthesize";
export type TopicChatMode = "quick" | "standard";

/** One line of the conversation. The text is always shown as plain text. */
export interface TopicChatTurn {
  role: "user" | "ai";
  /** The button the user pressed; only on user turns. */
  kind?: TopicChatKind;
  text: string;
}

export interface TopicChatSession {
  turns: readonly TopicChatTurn[];
  mode: TopicChatMode;
  running: boolean;
  /** The button pressed but not yet sent; its suggestion shows as grey text until adopted. */
  draftKind: TopicChatKind | null;
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
  anchor(): { card: TopicChatRect; area: TopicChatRect } | null;
  session(): TopicChatSession;
  /** Calls `changed` whenever the session changes; returns the unsubscribe function. */
  subscribe(changed: () => void): () => void;
  setMode(mode: TopicChatMode): void;
  /** Remembers the unsent button and text so a repaint keeps them. */
  setDraft(kind: TopicChatKind | null, text: string): void;
  /** Resolves true when a run started (the input then clears), false when it was declined (the input stays). */
  submit(kind: TopicChatKind, text: string): Promise<boolean>;
  close(): void;
}

const KINDS: readonly TopicChatKind[] = ["research", "expand", "synthesize"];
const WIDTH_FALLBACK = 340;
const NARROW_AREA = 360;
const GAP = 8;

function kindLabel(kind: TopicChatKind): string {
  return t(`ui.topic_chat_${kind}`);
}

function suggestion(kind: TopicChatKind): string {
  return t(`ui.topic_chat_suggest_${kind}`);
}

/** The small conversation window next to a topic card. Pure DOM; geometry comes from the host. */
export class TopicChatWindow {
  readonly el: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly inputEl: HTMLTextAreaElement;
  private readonly sendEl: HTMLButtonElement;
  private readonly tabEl: HTMLElement;
  private readonly modeHintEl: HTMLElement;
  private readonly kindEls = new Map<TopicChatKind, HTMLButtonElement>();
  private readonly modeEls = new Map<TopicChatMode, HTMLButtonElement>();
  private readonly cleanups: Array<() => void> = [];
  private submitting = false;
  private destroyed = false;

  constructor(
    private readonly host: TopicChatHost,
    private readonly opener: { focus(): void } | null,
    parent: HTMLElement
  ) {
    this.el = parent.createDiv({ cls: "vam-topic-chat" });
    this.el.setAttr("role", "dialog");
    this.el.setAttr("aria-label", t("ui.topic_chat_label_0", host.topicTitle()));
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
      attr: { rows: "3", "aria-label": t("ui.topic_chat_label_0", host.topicTitle()) }
    });
    this.on(this.inputEl, "input", () => this.typed());
    this.on(this.inputEl, "keydown", event => this.keydown(event));
    this.tabEl = composer.createSpan({ cls: "vam-topic-chat-tab", text: t("ui.topic_chat_tab_adopt") });
    this.tabEl.hidden = true;
    const foot = composer.createDiv("vam-topic-chat-foot");
    const modes = foot.createDiv({
      cls: "vam-topic-chat-modes",
      attr: { role: "group", "aria-label": t("ui.ai_mode") }
    });
    for (const mode of ["quick", "standard"] as const) {
      const button = modes.createEl("button", {
        cls: "vam-topic-chat-mode",
        text: mode === "quick" ? t("ui.quick") : t("ui.standard"),
        attr: { type: "button", "aria-pressed": "false" }
      });
      this.modeEls.set(mode, button);
      this.on(button, "click", () => {
        if (this.host.session().running) return;
        this.host.setMode(mode);
      });
    }
    this.sendEl = foot.createEl("button", {
      cls: "vam-topic-chat-send",
      text: "↑",
      attr: { type: "button", "aria-label": t("ui.topic_chat_send") }
    });
    this.on(this.sendEl, "click", () => void this.send());
    this.modeHintEl = composer.createDiv({
      cls: "vam-topic-chat-mode-hint",
      attr: { "aria-live": "polite" }
    });

    this.on(this.el, "keydown", event => {
      if (event.key !== "Escape") return;
      event.preventDefault?.();
      event.stopPropagation?.();
      this.requestClose();
    });
    this.cleanups.push(host.subscribe(() => this.refresh()));
    const draft = host.session();
    this.inputEl.value = draft.draftText;
    this.refresh();
  }

  /** Puts the window in `parent` (again, after a repaint), places it and moves the focus to the input. */
  mount(parent: HTMLElement): void {
    if (!parent.contains(this.el)) parent.appendChild(this.el);
    this.reposition();
    this.inputEl.focus();
  }

  /** Right of the card when it fits, else left; a narrow canvas puts the window at the bottom. Missing geometry leaves it as is. */
  reposition(): void {
    if (this.destroyed) return;
    const anchor = this.host.anchor();
    if (!anchor) return;
    const { card, area } = anchor;
    const areaWidth = area.right - area.left;
    const areaHeight = area.bottom - area.top;
    if (!(areaWidth > 0)) return;
    if (areaWidth < NARROW_AREA) {
      this.el.addClass("is-bottom");
      this.el.setCssProps({ left: "0px", top: "" });
      return;
    }
    this.el.removeClass("is-bottom");
    const width = this.el.offsetWidth || WIDTH_FALLBACK;
    const height = this.el.offsetHeight || 0;
    let left = card.right - area.left + GAP;
    if (left + width > areaWidth) left = card.left - area.left - width - GAP;
    left = Math.max(0, Math.min(left, areaWidth - width));
    let top = card.top - area.top;
    if (areaHeight > 0) top = Math.max(0, Math.min(top, areaHeight - height));
    this.el.setCssProps({ left: `${left}px`, top: `${top}px` });
  }

  /** Releases every listener and removes the window. Does not tell the host. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
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

  private pickKind(kind: TopicChatKind): void {
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
    const session = this.host.session();
    return !this.submitting && !session.running && !!session.draftKind && this.inputEl.value.trim() !== "";
  }

  private async send(): Promise<void> {
    if (!this.canSend()) return;
    const kind = this.host.session().draftKind;
    if (!kind) return;
    const text = this.inputEl.value.trim();
    this.submitting = true;
    this.refresh();
    let started = false;
    try {
      started = await this.host.submit(kind, text);
    } finally {
      this.submitting = false;
    }
    if (this.destroyed) return;
    if (started) {
      this.inputEl.value = "";
      this.host.setDraft(null, "");
    }
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
    for (const [mode, button] of this.modeEls) {
      button.setAttr("aria-pressed", String(session.mode === mode));
      button.toggleClass("is-active", session.mode === mode);
      button.disabled = session.running;
    }
    this.modeHintEl.setText(
      session.mode === "quick" ? t("ui.topic_chat_mode_quick_hint") : t("ui.topic_chat_mode_standard_hint")
    );
    const ghost = session.draftKind && empty ? suggestion(session.draftKind) : "";
    this.inputEl.setAttr("placeholder", ghost || t("ui.topic_chat_placeholder"));
    this.tabEl.hidden = !ghost || busy;
    this.sendEl.disabled = !this.canSend();
    this.paintLog(session);
  }

  private paintLog(session: TopicChatSession): void {
    this.logEl.empty();
    for (const turn of session.turns) {
      const row = this.logEl.createDiv({
        cls: turn.role === "user" ? "vam-topic-chat-msg is-me" : "vam-topic-chat-msg"
      });
      const who =
        turn.role === "user"
          ? t("ui.topic_chat_you_0", turn.kind ? kindLabel(turn.kind) : "")
          : t("ui.map_chat_role_ai");
      row.createSpan({ cls: "vam-topic-chat-who", text: who });
      row.createSpan({ cls: "vam-topic-chat-text", text: turn.text });
    }
    if (session.running) {
      this.logEl.createDiv({ cls: "vam-topic-chat-msg is-running", text: t("ui.topic_chat_running") });
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
