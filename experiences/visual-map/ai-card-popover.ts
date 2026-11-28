import { t, type TranslationKey } from "../../i18n";

/** Legacy name retained while the setup surface moves into the central workspace. */
export interface AiCardPopoverValues {
  title: string;
  question: string;
  sources: string[];
  /** Compatibility for callers of the old setup window; no longer controls writes. */
  keepOld: boolean;
  /** Sources whose replaced note the user confirmed again on purpose. */
  reconfirm?: string[];
}

export interface AiCardPopoverHost {
  cardTitle: string | null;
  initial: Omit<AiCardPopoverValues, "title">;
  anchor(): { card: DOMRect; area: DOMRect; controls: DOMRect | null } | null;
  pickNote(done: (name: string) => void, closed: () => void): void;
  save(values: AiCardPopoverValues): void | Promise<boolean>;
  trial?(values: AiCardPopoverValues): Promise<boolean>;
  stopTrial?(): void;
  adopt?(): Promise<boolean>;
  convert?(): Promise<boolean>;
  changed?(): void;
  cancel(): void;
}

let seq = 0;

/** The central editor owns an unsaved draft; the separate right reader owns the preview. */
/** Controls a repaint rebuilds, as selectors: the focus finds its equivalent again. */
const REPAINTED_CONTROLS = [
  ".vam-living-editor-retry",
  ".vam-ai-card-pop-chip-confirm",
  ".vam-ai-card-pop-chip-x",
  ".vam-ai-card-pop-add"
];

export class AiCardPopover {
  readonly el: HTMLElement;
  private readonly titleEl: HTMLInputElement | null = null;
  private readonly questionEl: HTMLTextAreaElement;
  private readonly chipsEl: HTMLElement;
  private readonly saveEl: HTMLButtonElement;
  private readonly trialEl: HTMLButtonElement;
  private readonly stopTrialEl: HTMLButtonElement;
  private readonly adoptEl: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private readonly closeChoices: HTMLElement;
  private readonly headingEl: HTMLElement;
  private readonly closeEl: HTMLButtonElement;
  private readonly failureEl: HTMLElement;
  private failure: TranslationKey | null = null;
  private failureDetail = "";
  private readonly labelled: Array<[HTMLElement, TranslationKey, string]> = [];
  private readonly sources: string[];
  private replaced = new Set<string>();
  private readonly reconfirm = new Set<string>();
  private baseline: string;
  private preview = false;
  private busy = false;
  private trialRunning = false;
  private trialWaiting = false;
  private readonly convertEl?: HTMLButtonElement;
  private readonly cleanups: Array<() => void> = [];
  private parentEl: HTMLElement | null = null;
  private destroyed = false;

  constructor(
    private readonly host: AiCardPopoverHost,
    parent: HTMLElement
  ) {
    this.sources = [...host.initial.sources];
    this.el = parent.createDiv({ cls: "vam-ai-card-pop vam-living-editor" });
    this.el.setAttr("role", "dialog");
    const labelId = `vam-ai-card-pop-label-${++seq}`;
    const heading = host.cardTitle ?? t("ui.ai_card");
    const header = this.el.createDiv("vam-living-editor-header");
    this.headingEl = header.createDiv({
      cls: "vam-ai-card-pop-title",
      text: heading,
      attr: { id: labelId, dir: "auto" }
    });
    this.el.setAttr("aria-labelledby", labelId);
    this.closeEl = header.createEl("button", {
      text: t("ui.living_node_close"),
      attr: { type: "button" }
    });
    this.track(this.closeEl, "ui.living_node_close");
    this.on(this.closeEl, "click", () => this.requestClose());
    if (host.cardTitle === null) {
      this.titleEl = this.el.createEl("input", {
        cls: "vam-ai-card-pop-name",
        attr: {
          type: "text",
          placeholder: t("ui.ai_card_name_placeholder"),
          "aria-label": t("ui.ai_card_name_placeholder")
        }
      });
      this.track(this.titleEl, "ui.ai_card_name_placeholder", "placeholder");
      this.track(this.titleEl, "ui.ai_card_name_placeholder", "aria-label");
      this.on(this.titleEl, "input", () => this.changed());
    }
    this.questionEl = this.el.createEl("textarea", {
      cls: "vam-topic-chat-input vam-ai-card-pop-question",
      attr: {
        rows: "12",
        placeholder: t("ui.ai_card_question_placeholder"),
        "aria-label": t("ui.ai_card_question_placeholder")
      }
    });
    this.track(this.questionEl, "ui.ai_card_question_placeholder", "placeholder");
    this.track(this.questionEl, "ui.ai_card_question_placeholder", "aria-label");
    this.questionEl.value = host.initial.question;
    this.on(this.questionEl, "input", () => this.changed());
    this.chipsEl = this.el.createDiv("vam-ai-card-pop-sources");
    this.failureEl = this.el.createDiv({ cls: "vam-living-editor-failure", attr: { role: "alert" } });
    this.failureEl.hidden = true;
    this.statusEl = this.el.createDiv({
      cls: "vam-living-editor-status",
      attr: { role: "status", "aria-live": "polite" }
    });
    const foot = this.el.createDiv("vam-ai-card-pop-foot");
    this.trialEl = foot.createEl("button", { text: t("ui.living_node_try_prompt"), attr: { type: "button" } });
    this.track(this.trialEl, "ui.living_node_try_prompt");
    this.stopTrialEl = foot.createEl("button", { text: t("ui.topic_chat_stop"), attr: { type: "button" } });
    this.track(this.stopTrialEl, "ui.topic_chat_stop");
    this.on(this.stopTrialEl, "click", () => {
      if (!this.trialRunning) return;
      this.host.stopTrial?.();
      this.stopTrialEl.disabled = true;
    });
    this.adoptEl = foot.createEl("button", { text: t("ui.living_node_adopt"), attr: { type: "button" } });
    this.track(this.adoptEl, "ui.living_node_adopt");
    this.saveEl = foot.createEl("button", { cls: "mod-cta", text: t("ui.ai_card_save"), attr: { type: "button" } });
    this.track(this.saveEl, "ui.ai_card_save");
    if (host.convert) {
      const convert = foot.createEl("button", { text: t("ui.living_node_convert"), attr: { type: "button" } });
      this.convertEl = convert;
      this.track(convert, "ui.living_node_convert");
      this.on(convert, "click", () => {
        if (this.busy || this.trialRunning || this.dirty()) return;
        void host.convert?.();
      });
    }
    this.on(this.saveEl, "click", () => void this.save());
    this.on(this.trialEl, "click", () => void this.trial());
    this.on(this.adoptEl, "click", () => void this.adopt());
    this.closeChoices = this.el.createDiv("vam-living-editor-close-choices");
    this.closeChoices.hidden = true;
    this.track(this.closeChoices.createSpan({ text: t("ui.living_node_dirty") }), "ui.living_node_dirty");
    const saveClose = this.closeChoices.createEl("button", { text: t("ui.ai_card_save"), attr: { type: "button" } });
    this.track(saveClose, "ui.ai_card_save");
    const discard = this.closeChoices.createEl("button", {
      text: t("ui.living_node_discard"),
      attr: { type: "button" }
    });
    this.track(discard, "ui.living_node_discard");
    const back = this.closeChoices.createEl("button", { text: t("ui.living_node_return"), attr: { type: "button" } });
    this.track(back, "ui.living_node_return");
    this.on(saveClose, "click", () => void this.save(true));
    this.on(discard, "click", () => this.host.cancel());
    this.on(back, "click", () => {
      this.closeChoices.hidden = true;
      this.questionEl.focus();
    });
    this.on(this.el, "keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.requestClose();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void this.save();
      }
    });
    this.baseline = JSON.stringify(this.values());
    this.paintSources();
    this.refresh();
  }

  mount(parent: HTMLElement, focus = true): void {
    if (this.destroyed) return;
    if (!parent.contains(this.el)) parent.appendChild(this.el);
    parent.addClass("has-topic-chat");
    this.parentEl = parent;
    this.reposition();
    if (focus) this.questionEl.focus();
  }

  reposition(): void {
    if (this.destroyed) return;
    // The overlay belongs to the canvas only: left chat and right reading leaf stay independent.
    this.el.setCssProps({ left: "12px", top: "12px", right: "12px", bottom: "12px" });
  }

  /** A language change: every fixed word is set again; the draft, focus and open choices stay as they are. */
  relabel(): void {
    if (this.destroyed) return;
    if (this.host.cardTitle === null) this.headingEl.setText(t("ui.ai_card"));
    for (const [el, key, attr] of this.labelled) {
      if (attr === "text") el.setText(t(key));
      else el.setAttr(attr, t(key));
    }
    const active = this.el.ownerDocument?.activeElement ?? null;
    const inside = !!active && this.el.contains(active);
    // The repaint replaces the chips and the failure box: note which of their controls the keyboard was on.
    let was: { selector: string; at: number } | undefined;
    if (inside)
      for (const selector of REPAINTED_CONTROLS) {
        const at = Array.from(this.el.querySelectorAll(selector)).indexOf(active);
        if (at >= 0) was = { selector, at };
      }
    this.paintSources();
    this.paintFailure();
    this.refresh();
    // The equivalent rebuilt control gets the focus back; the field only when that control is gone.
    if (inside && !this.el.contains(active)) {
      const same = was ? this.el.querySelectorAll<HTMLElement>(was.selector)[was.at] : undefined;
      (same ?? this.questionEl).focus();
    }
  }

  /** The trial did not finish: say so inside the editor, with the reason and a way to try again. */
  showTrialFailure(reason: TranslationKey, detail = ""): void {
    if (this.destroyed) return;
    this.failure = reason;
    this.failureDetail = detail;
    this.paintFailure();
    this.failureEl.querySelector<HTMLButtonElement>("button")?.focus();
  }

  /** The preview no longer matches its sources: it stays readable, but cannot be adopted. */
  trialInvalidated(): void {
    if (this.destroyed) return;
    this.preview = false;
    this.refresh();
  }

  /** Sources whose note was replaced: each offers an explicit confirm. */
  markReplaced(names: readonly string[]): void {
    if (this.destroyed) return;
    this.replaced = new Set(names);
    this.paintSources();
  }

  private track(el: HTMLElement, key: TranslationKey, attr = "text"): void {
    this.labelled.push([el, key, attr]);
  }

  private paintFailure(): void {
    this.failureEl.empty();
    this.failureEl.hidden = this.failure === null;
    if (this.failure === null) return;
    this.failureEl.createDiv({ cls: "vam-living-editor-failure-title", text: t("ui.living_node_trial_failed_title") });
    this.failureEl.createDiv({ cls: "vam-living-editor-failure-reason", text: t(this.failure), attr: { dir: "auto" } });
    if (this.failureDetail)
      this.failureEl.createDiv({
        cls: "vam-living-editor-failure-detail",
        text: t("ui.living_node_trial_reason_code_0", this.failureDetail),
        attr: { dir: "auto" }
      });
    this.failureEl.createDiv({ cls: "vam-living-editor-failure-note", text: t("ui.living_node_trial_failed_note") });
    const retry = this.failureEl.createEl("button", {
      cls: "vam-living-editor-retry",
      text: t("ui.living_node_trial_retry"),
      attr: { type: "button" }
    });
    this.on(retry, "click", () => void this.trial());
  }

  requestClose(): void {
    if (!this.dirty()) this.host.cancel();
    else {
      this.closeChoices.hidden = false;
      this.closeChoices.querySelector<HTMLButtonElement>("button")?.focus();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.parentEl?.removeClass("has-topic-chat");
    this.el.remove();
  }

  private values(): AiCardPopoverValues {
    return {
      title: this.titleEl?.value.trim() ?? "",
      question: this.questionEl.value.trim(),
      sources: [...this.sources],
      keepOld: true,
      ...(this.reconfirm.size ? { reconfirm: [...this.reconfirm] } : {})
    };
  }

  private dirty(): boolean {
    return JSON.stringify(this.values()) !== this.baseline;
  }

  private changed(): void {
    this.preview = false;
    this.clearFailure();
    this.host.changed?.();
    this.refresh();
  }

  private clearFailure(): void {
    if (this.failure === null) return;
    this.failure = null;
    this.paintFailure();
  }

  private refresh(): void {
    const empty = !this.questionEl.value.trim();
    this.saveEl.disabled = empty || this.busy;
    this.trialEl.disabled = empty || this.busy || !this.host.trial;
    this.stopTrialEl.hidden = !this.trialRunning || !this.host.stopTrial;
    this.stopTrialEl.disabled = !this.trialRunning;
    this.adoptEl.disabled = !this.preview || this.busy || this.dirty() || !this.host.adopt;
    this.questionEl.disabled = this.busy;
    if (this.convertEl) this.convertEl.disabled = this.trialRunning;
    this.statusEl.setText(
      this.busy && this.trialWaiting
        ? `${t("ui.ai_card_status_waiting")}: ${t("ui.living_node_trial_waiting_consent")}`
        : this.busy
          ? t("ui.ai_running")
          : this.dirty()
            ? t("ui.living_node_dirty")
            : ""
    );
  }

  /** The first-send usage question is open: the trial is waiting for the user, not running. */
  setTrialWaiting(waiting: boolean): void {
    if (this.destroyed || this.trialWaiting === waiting) return;
    this.trialWaiting = waiting;
    this.refresh();
  }

  private async save(close = false): Promise<void> {
    if (this.saveEl.disabled || this.destroyed) return;
    this.busy = true;
    this.refresh();
    try {
      const result = await this.host.save(this.values());
      if (result !== false && !this.destroyed) {
        for (const name of this.reconfirm) this.replaced.delete(name);
        this.reconfirm.clear();
        this.paintSources();
        this.baseline = JSON.stringify(this.values());
        this.closeChoices.hidden = true;
        if (close) this.host.cancel();
      }
    } finally {
      this.busy = false;
      if (!this.destroyed) this.refresh();
    }
  }

  private async trial(): Promise<void> {
    if (this.trialEl.disabled || !this.host.trial || this.destroyed) return;
    this.busy = true;
    this.trialRunning = true;
    this.preview = false;
    this.clearFailure();
    this.refresh();
    try {
      this.preview = await this.host.trial(this.values());
    } finally {
      this.trialRunning = false;
      this.trialWaiting = false;
      this.busy = false;
      if (!this.destroyed) {
        this.refresh();
        // The retry button is gone once a new try starts: keep the keyboard on this editor.
        const doc = this.el.ownerDocument;
        if (this.failure === null && (!doc?.activeElement || doc.activeElement === doc.body)) this.trialEl.focus();
      }
    }
  }

  private async adopt(): Promise<void> {
    if (this.adoptEl.disabled || !this.host.adopt || this.destroyed) return;
    this.busy = true;
    this.refresh();
    try {
      await this.host.adopt();
      this.preview = false;
    } finally {
      this.busy = false;
      if (!this.destroyed) {
        this.refresh();
        // The adopt button is now disabled and took the focus with it: keep the keyboard (and Escape) in this editor.
        const doc = this.el.ownerDocument;
        const active = doc?.activeElement ?? null;
        if (!active || active === doc?.body || !this.el.contains(active)) this.trialEl.focus();
      }
    }
  }

  private paintSources(): void {
    this.chipsEl.empty();
    for (const name of this.sources) {
      const chip = this.chipsEl.createSpan({ cls: "vam-ai-card-pop-chip" });
      chip.createSpan({ cls: "vam-ai-card-pop-chip-name", text: name, attr: { dir: "auto" } });
      const remove = chip.createEl("button", {
        cls: "vam-ai-card-pop-chip-x",
        text: "×",
        attr: { type: "button", "aria-label": t("ui.ai_card_source_remove_0", name) }
      });
      if (this.replaced.has(name) && !this.reconfirm.has(name)) {
        chip.addClass("is-replaced");
        chip.createSpan({ cls: "vam-ai-card-pop-chip-warn", text: t("ui.living_node_source_replaced") });
        const confirm = chip.createEl("button", {
          cls: "vam-ai-card-pop-chip-confirm",
          text: t("ui.living_node_source_reconfirm"),
          attr: { type: "button", "aria-label": t("ui.living_node_source_reconfirm_0", name) }
        });
        this.on(confirm, "click", () => {
          if (this.busy) return;
          this.reconfirm.add(name);
          this.paintSources();
          this.changed();
          this.questionEl.focus();
        });
      }
      this.on(remove, "click", () => {
        if (this.busy) return;
        const at = this.sources.indexOf(name);
        if (at >= 0) this.sources.splice(at, 1);
        this.replaced.delete(name);
        this.reconfirm.delete(name);
        this.paintSources();
        this.changed();
        this.questionEl.focus();
      });
    }
    const add = this.chipsEl.createEl("button", {
      cls: "vam-ai-card-pop-add",
      text: t("ui.ai_card_add_notes"),
      attr: { type: "button" }
    });
    this.on(add, "click", () => {
      if (this.busy) return;
      this.host.pickNote(
        name => {
          if (this.destroyed) return;
          if (!this.sources.includes(name)) {
            this.sources.push(name);
            this.paintSources();
            this.changed();
          }
        },
        () => {
          if (!this.destroyed) this.questionEl.focus();
        }
      );
    });
  }

  private on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    name: K,
    handler: (event: HTMLElementEventMap[K]) => void
  ): void {
    target.addEventListener(name, handler);
    this.cleanups.push(() => target.removeEventListener(name, handler));
  }
}
