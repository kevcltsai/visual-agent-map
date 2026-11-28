import { setIcon } from "obsidian";
import { t } from "../../i18n";
import { renderChatMarkdown } from "../../core/map-chat-render";
import { INTEGRATION_DEPTHS as DEPTHS, type IntegrationDepth } from "./subtree-plan";

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

/** The depth-choice card an integration over a deeper subtree shows before it starts: numbers from the map, the option picked so far. */
export interface TopicChatChoice {
  levels: number;
  topics: number;
  researched: number;
  /** Unresearched deepest topics the research-first choice researches. */
  leaves: number;
  /** Direct subtopics (the quick choice sends their full content). */
  children: number;
  /** AI calls per choice, in the order the options are listed. */
  calls: Record<IntegrationDepth, number>;
  selected: IntegrationDepth;
}

export interface TopicChatSession {
  turns: readonly TopicChatTurn[];
  mode: TopicChatMode;
  running: boolean;
  /** The button pressed but not yet sent; pressing it put its suggestion in the input. */
  draftKind: TopicChatButtonKind | null;
  draftText: string;
  /** The depth-choice card while it waits for an answer (it writes no record and starts no AI). */
  choice?: TopicChatChoice | null;
  /** One line of progress for the running row (a subtree integration's "step x of y"); replaces the plain running text. */
  progress?: string;
  /** Set after a deeper integration ran its quick option: the log then offers "Other ways to integrate". */
  otherWays?: object | null;
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
  /** How many map sources (saved and outside the vault) a request of this window reads besides the card's note. */
  mapSourceCount(): number;
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
  /** True while the current run can be stopped (running, not yet aborted, not in the gap after the reply). */
  canStop(): boolean;
  /** Aborts the current run; the view's stop handling puts unsent additions back in the box. */
  stop(): void;
  close(): void;
  /** The depth card: picks an option. */
  chooseDepth(depth: IntegrationDepth): void;
  /** The depth card: starts with the picked option; resolves true when the run started. */
  confirmChoice(): Promise<boolean>;
  /** The depth card: drops it; nothing runs and nothing is written. */
  cancelChoice(): void;
  /** After a quick integration of a deeper branch: shows the depth card for the other ways. */
  showOtherWays(): void;
}

const KINDS: readonly TopicChatButtonKind[] = ["research", "expand", "synthesize"];
const WIDTH_FALLBACK = 340;
const NARROW_AREA = 360;
const GAP = 8;

function kindLabel(kind: TopicChatButtonKind): string {
  return t(`ui.topic_chat_${kind}`);
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
  private readonly modeHintEl: HTMLElement;
  private readonly kindEls = new Map<TopicChatButtonKind, HTMLButtonElement>();
  private readonly scopeEl: HTMLElement;
  private readonly sourcesEl: HTMLElement;
  private readonly modeEl: HTMLElement;
  private readonly webEl: HTMLInputElement;
  private readonly cleanups: Array<() => void> = [];
  private parentEl: HTMLElement | null = null;
  private submitting = false;
  private destroyed = false;
  private choiceShown = false;
  private readonly doc: Document | null;

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

    // What a reply of this window may write: the card and its subtree (anything else is skipped as out of scope).
    this.el.createDiv({ cls: "vam-topic-chat-writable", text: t("ui.topic_chat_writable") });
    const composer = this.el.createDiv("vam-topic-chat-composer");
    this.inputEl = composer.createEl("textarea", {
      cls: "vam-topic-chat-input",
      attr: { rows: "3", "aria-labelledby": labelId }
    });
    this.on(this.inputEl, "input", () => this.typed());
    this.on(this.inputEl, "keydown", event => this.keydown(event));
    // What the next request covers (this card, or its whole branch for an integration), what it reads, and whether it uses the web.
    const meta = composer.createDiv("vam-topic-chat-meta");
    this.scopeEl = meta.createSpan({ cls: "vam-topic-chat-scope" });
    this.sourcesEl = meta.createSpan({ cls: "vam-topic-chat-sources" });
    this.modeEl = meta.createSpan({ cls: "vam-topic-chat-mode" });
    const foot = composer.createDiv("vam-topic-chat-foot");
    // Web search is the one difference between the two AI modes: ticked is the standard mode, unticked the quick one.
    // The map remembers the mode once a research or expand is confirmed.
    const web = foot.createEl("label", { cls: "vam-topic-chat-web" });
    this.webEl = web.createEl("input", { type: "checkbox", cls: "vam-topic-chat-web-box" });
    this.on(this.webEl, "change", () => {
      if (this.host.session().running) return;
      this.host.setMode(this.webEl.checked ? "standard" : "quick");
    });
    web.createSpan({ text: t("ui.topic_chat_web_search") });
    this.doc = parent.ownerDocument ?? null;
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
      // An open depth card takes the first Escape; only the next one closes the window.
      if (this.host.session().choice) this.cancelChoice();
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

  private cancelChoice(): void {
    this.host.cancelChoice();
    if (!this.destroyed) this.inputEl.focus();
  }

  private async confirmChoice(): Promise<void> {
    const started = await this.host.confirmChoice();
    if (started && !this.destroyed) this.inputEl.focus();
  }

  private pickKind(kind: TopicChatButtonKind): void {
    if (this.host.session().running) return;
    // The suggestion goes into the input, all selected: send it as it is, or type over it.
    this.inputEl.value = suggestion(kind);
    this.host.setDraft(kind, this.inputEl.value);
    this.refresh();
    this.inputEl.focus();
    this.inputEl.select();
  }

  private typed(): void {
    const { draftKind } = this.host.session();
    this.host.setDraft(draftKind, this.inputEl.value);
    this.refresh();
  }

  private keydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void this.send();
    }
  }

  private canSend(): boolean {
    // An empty field has nothing to send, even with a button pressed. Typing alone is a question.
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
    this.webEl.checked = session.mode === "standard";
    this.webEl.disabled = session.running;
    this.scopeEl.setText(
      t(session.draftKind === "synthesize" ? "ui.topic_chat_scope_branch" : "ui.topic_chat_scope_card")
    );
    const sources = this.host.mapSourceCount();
    this.sourcesEl.setText(
      sources === 0
        ? t("ui.topic_chat_sources_note")
        : t(sources === 1 ? "ui.topic_chat_sources_note_map_one" : "ui.topic_chat_sources_note_map_0", sources)
    );
    this.modeEl.setText(t(`ui.topic_chat_meta_mode_${session.mode}`));
    this.modeHintEl.setText(session.running && !empty ? t("ui.map_chat_steer_hint") : "");
    this.inputEl.setAttr(
      "placeholder",
      session.running ? t("ui.map_chat_steer_placeholder") : t("ui.topic_chat_placeholder")
    );
    this.sendEl.disabled = !this.canSend();
    this.paintLog(session);
    // The log changed height, so the window may no longer fit where it was put; then the newest turn is brought into view again.
    this.reposition();
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private paintLog(session: TopicChatSession): void {
    // The log is emptied and drawn again on every change: remember which part of the card held the focus and give it back.
    const active = this.doc?.activeElement as HTMLElement | null | undefined;
    const heldPart = active && this.logEl.contains(active) ? (active.getAttr("data-part") ?? null) : null;
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
    if (session.choice) this.paintChoice(session.choice, heldPart, !this.choiceShown);
    this.choiceShown = !!session.choice;
    if (session.otherWays && !session.choice && !session.running) {
      const other = this.logEl.createEl("button", {
        cls: "vam-topic-chat-other-ways",
        text: t("ui.topic_chat_other_ways"),
        attr: { type: "button" }
      });
      other.addEventListener("click", () => this.host.showOtherWays());
    }
    if (session.running) {
      const running = this.logEl.createDiv({ cls: "vam-topic-chat-msg is-running" });
      running.createSpan({ text: session.progress || t("ui.topic_chat_running") });
      if (this.host.canStop()) {
        const stop = running.createEl("button", {
          cls: "vam-topic-chat-stop",
          text: t("ui.topic_chat_stop"),
          attr: { type: "button", "aria-label": t("ui.topic_chat_stop") }
        });
        stop.addEventListener("click", () => this.host.stop());
      }
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** The depth card: an AI message with three radio options and Start / Cancel. Arrows switch, Enter starts, Escape cancels. */
  private paintChoice(choice: TopicChatChoice, heldPart: string | null, focusNow: boolean): void {
    const row = this.logEl.createDiv({ cls: "vam-topic-chat-msg is-choice" });
    row.createSpan({ cls: "vam-topic-chat-who", text: t("ui.map_chat_role_ai") });
    const messageId = `vam-topic-chat-choice-${++labelSeq}`;
    row.createSpan({
      cls: "vam-topic-chat-text",
      text: t("ui.topic_chat_choice_message_0_1_2", choice.levels, choice.topics, choice.researched),
      attr: { id: messageId }
    });
    const group = row.createDiv({
      cls: "vam-topic-chat-choice",
      attr: { role: "radiogroup", "aria-labelledby": messageId }
    });
    let selectedEl: HTMLElement | null = null;
    for (const depth of DEPTHS) {
      const selected = choice.selected === depth;
      const optionId = `${messageId}-${depth}`;
      const option = group.createDiv({
        cls: selected ? "vam-topic-chat-choice-opt is-selected" : "vam-topic-chat-choice-opt",
        attr: {
          role: "radio",
          tabindex: selected ? "0" : "-1",
          "aria-checked": String(selected),
          "aria-labelledby": `${optionId}-label`,
          "aria-describedby": `${optionId}-hint`,
          "data-part": "radio"
        }
      });
      option.createSpan({ cls: "vam-topic-chat-choice-dot", attr: { "aria-hidden": "true" } });
      const body = option.createSpan({ cls: "vam-topic-chat-choice-body" });
      body.createSpan({
        cls: "vam-topic-chat-choice-label",
        text: depthLabel(depth),
        attr: { id: `${optionId}-label` }
      });
      body.createSpan({
        cls: "vam-topic-chat-choice-hint",
        text: depthHint(depth, choice),
        attr: { id: `${optionId}-hint` }
      });
      if (selected) selectedEl = option;
      option.addEventListener("click", () => this.host.chooseDepth(depth));
      option.addEventListener("keydown", event => {
        const step =
          event.key === "ArrowDown" || event.key === "ArrowRight"
            ? 1
            : event.key === "ArrowUp" || event.key === "ArrowLeft"
              ? -1
              : 0;
        if (step) {
          event.preventDefault();
          event.stopPropagation?.();
          this.host.chooseDepth(DEPTHS[(DEPTHS.indexOf(choice.selected) + step + DEPTHS.length) % DEPTHS.length]);
        } else if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          event.stopPropagation?.();
          void this.confirmChoice();
        } else if (event.key === " ") {
          event.preventDefault();
          this.host.chooseDepth(depth);
        }
      });
    }
    const actions = row.createDiv("vam-topic-chat-choice-actions");
    const start = actions.createEl("button", {
      cls: "vam-topic-chat-choice-start mod-cta",
      text: t("ui.topic_chat_choice_start"),
      attr: { type: "button", "data-part": "start" }
    });
    start.addEventListener("click", () => void this.confirmChoice());
    const cancel = actions.createEl("button", {
      cls: "vam-topic-chat-choice-cancel",
      text: t("ui.topic_chat_choice_cancel"),
      attr: { type: "button", "data-part": "cancel" }
    });
    cancel.addEventListener("click", () => this.cancelChoice());
    const focusPart = focusNow ? "radio" : heldPart;
    if (focusPart === "radio") selectedEl?.focus();
    else if (focusPart === "start") start.focus();
    else if (focusPart === "cancel") cancel.focus();
  }
}

function depthLabel(depth: IntegrationDepth): string {
  return t(
    depth === "quick"
      ? "ui.topic_chat_choice_quick"
      : depth === "bottom-up"
        ? "ui.topic_chat_choice_bottom_up"
        : "ui.topic_chat_choice_research_first"
  );
}

function depthHint(depth: IntegrationDepth, choice: TopicChatChoice): string {
  const calls = choice.calls[depth];
  if (depth === "quick") return t("ui.topic_chat_choice_quick_hint_0_1", choice.children, calls);
  if (depth === "bottom-up") return t("ui.topic_chat_choice_bottom_up_hint_0", calls);
  return t("ui.topic_chat_choice_research_first_hint_0_1", choice.leaves, calls);
}
