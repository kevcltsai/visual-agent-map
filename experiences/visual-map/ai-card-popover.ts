import { t } from "../../i18n";

/** Legacy name retained while the setup surface moves into the central workspace. */
export interface AiCardPopoverValues {
  title: string;
  question: string;
  sources: string[];
  /** Compatibility for callers of the old setup window; no longer controls writes. */
  keepOld: boolean;
}

export interface AiCardPopoverHost {
  cardTitle: string | null;
  initial: Omit<AiCardPopoverValues, "title">;
  anchor(): { card: DOMRect; area: DOMRect; controls: DOMRect | null } | null;
  pickNote(done: (name: string) => void, closed: () => void): void;
  save(values: AiCardPopoverValues): void | Promise<boolean>;
  trial?(values: AiCardPopoverValues): Promise<boolean>;
  adopt?(): Promise<boolean>;
  convert?(): Promise<boolean>;
  changed?(): void;
  cancel(): void;
}

let seq = 0;

/** The central editor owns an unsaved draft; the separate right reader owns the preview. */
export class AiCardPopover {
  readonly el: HTMLElement;
  private readonly titleEl: HTMLInputElement | null = null;
  private readonly questionEl: HTMLTextAreaElement;
  private readonly chipsEl: HTMLElement;
  private readonly saveEl: HTMLButtonElement;
  private readonly trialEl: HTMLButtonElement;
  private readonly adoptEl: HTMLButtonElement;
  private readonly statusEl: HTMLElement;
  private readonly closeChoices: HTMLElement;
  private readonly sources: string[];
  private baseline: string;
  private preview = false;
  private busy = false;
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
    header.createDiv({ cls: "vam-ai-card-pop-title", text: heading, attr: { id: labelId, dir: "auto" } });
    this.el.setAttr("aria-labelledby", labelId);
    const close = header.createEl("button", {
      text: t("ui.living_node_close"),
      attr: { type: "button" }
    });
    this.on(close, "click", () => this.requestClose());
    if (host.cardTitle === null) {
      this.titleEl = this.el.createEl("input", {
        cls: "vam-ai-card-pop-name",
        attr: {
          type: "text",
          placeholder: t("ui.ai_card_name_placeholder"),
          "aria-label": t("ui.ai_card_name_placeholder")
        }
      });
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
    this.questionEl.value = host.initial.question;
    this.on(this.questionEl, "input", () => this.changed());
    this.chipsEl = this.el.createDiv("vam-ai-card-pop-sources");
    this.statusEl = this.el.createDiv({ cls: "vam-living-editor-status", attr: { role: "status", "aria-live": "polite" } });
    const foot = this.el.createDiv("vam-ai-card-pop-foot");
    this.trialEl = foot.createEl("button", { text: t("ui.living_node_try_prompt"), attr: { type: "button" } });
    this.adoptEl = foot.createEl("button", { text: t("ui.living_node_adopt"), attr: { type: "button" } });
    this.saveEl = foot.createEl("button", { cls: "mod-cta", text: t("ui.ai_card_save"), attr: { type: "button" } });
    if (host.convert) {
      const convert = foot.createEl("button", { text: t("ui.living_node_convert"), attr: { type: "button" } });
      this.on(convert, "click", () => {
        if (this.busy || this.dirty()) return;
        void host.convert?.();
      });
    }
    this.on(this.saveEl, "click", () => void this.save());
    this.on(this.trialEl, "click", () => void this.trial());
    this.on(this.adoptEl, "click", () => void this.adopt());
    this.closeChoices = this.el.createDiv("vam-living-editor-close-choices");
    this.closeChoices.hidden = true;
    this.closeChoices.createSpan({ text: t("ui.living_node_dirty") });
    const saveClose = this.closeChoices.createEl("button", { text: t("ui.ai_card_save"), attr: { type: "button" } });
    const discard = this.closeChoices.createEl("button", { text: t("ui.living_node_discard"), attr: { type: "button" } });
    const back = this.closeChoices.createEl("button", { text: t("ui.living_node_return"), attr: { type: "button" } });
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
      keepOld: true
    };
  }

  private dirty(): boolean {
    return JSON.stringify(this.values()) !== this.baseline;
  }

  private changed(): void {
    this.preview = false;
    this.host.changed?.();
    this.refresh();
  }

  private refresh(): void {
    const empty = !this.questionEl.value.trim();
    this.saveEl.disabled = empty || this.busy;
    this.trialEl.disabled = empty || this.busy || !this.host.trial;
    this.adoptEl.disabled = !this.preview || this.busy || this.dirty() || !this.host.adopt;
    this.questionEl.disabled = this.busy;
    this.statusEl.setText(
      this.busy ? t("ui.ai_running") : this.dirty() ? t("ui.living_node_dirty") : ""
    );
  }

  private async save(close = false): Promise<void> {
    if (this.saveEl.disabled || this.destroyed) return;
    this.busy = true;
    this.refresh();
    try {
      const result = await this.host.save(this.values());
      if (result !== false && !this.destroyed) {
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
    this.preview = false;
    this.refresh();
    try {
      this.preview = await this.host.trial(this.values());
    } finally {
      this.busy = false;
      if (!this.destroyed) this.refresh();
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
      if (!this.destroyed) this.refresh();
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
      this.on(remove, "click", () => {
        if (this.busy) return;
        const at = this.sources.indexOf(name);
        if (at >= 0) this.sources.splice(at, 1);
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
