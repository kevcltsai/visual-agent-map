import { t } from "../../i18n";

/** What the popover hands back on 「存好」. `sources` are link names (`[[name]]`), `title` is empty when left blank. */
export interface AiCardPopoverValues {
  title: string;
  question: string;
  sources: string[];
  /** The 「保留舊資料」 tick: new text goes on top of the old (the default); unticked rewrites the note. */
  keepOld: boolean;
}

export interface AiCardPopoverHost {
  /** The card's name when the card exists (shown, not editable); null for a card that is not made yet (a name box). */
  cardTitle: string | null;
  initial: Omit<AiCardPopoverValues, "title">;
  anchor(): { card: DOMRect; area: DOMRect; controls: DOMRect | null } | null;
  /** Opens the note picker (Markdown only); `done` gets the link name of the chosen note. */
  pickNote(done: (name: string) => void, closed: () => void): void;
  save(values: AiCardPopoverValues): void;
  cancel(): void;
}

const WIDTH_FALLBACK = 340;
const NARROW_AREA = 360;
const GAP = 8;
let seq = 0;

/** The small setup window next to an AI card: name (new card only), the question, notes to read first, keep-old tick. Pure DOM. */
export class AiCardPopover {
  readonly el: HTMLElement;
  private readonly titleEl: HTMLInputElement | null = null;
  private readonly questionEl: HTMLTextAreaElement;
  private readonly chipsEl: HTMLElement;
  private readonly keepEl: HTMLInputElement;
  private readonly saveEl: HTMLButtonElement;
  private readonly sources: string[];
  private readonly cleanups: Array<() => void> = [];
  private parentEl: HTMLElement | null = null;
  private picking = false;
  private destroyed = false;

  constructor(
    private readonly host: AiCardPopoverHost,
    parent: HTMLElement
  ) {
    this.sources = [...host.initial.sources];
    this.el = parent.createDiv({ cls: "vam-topic-chat vam-ai-card-pop" });
    this.el.setAttr("role", "dialog");
    const labelId = `vam-ai-card-pop-label-${++seq}`;
    const heading = host.cardTitle === null ? t("ui.ai_card") : host.cardTitle;
    this.el.createSpan({ cls: "vam-sr-only", text: `${t("ui.ai_card")}: ${heading}`, attr: { id: labelId } });
    this.el.setAttr("aria-labelledby", labelId);
    if (host.cardTitle === null) {
      this.titleEl = this.el.createEl("input", {
        cls: "vam-ai-card-pop-name",
        attr: { type: "text", placeholder: t("ui.ai_card_name_placeholder"), "aria-label": t("ui.ai_card_name_placeholder") }
      });
    } else {
      this.el.createDiv({ cls: "vam-ai-card-pop-title", text: host.cardTitle, attr: { dir: "auto" } });
    }
    this.questionEl = this.el.createEl("textarea", {
      cls: "vam-topic-chat-input vam-ai-card-pop-question",
      attr: { rows: "4", placeholder: t("ui.ai_card_question_placeholder"), "aria-label": t("ui.ai_card_question_placeholder") }
    });
    this.questionEl.value = host.initial.question;
    this.on(this.questionEl, "input", () => this.refresh());
    this.chipsEl = this.el.createDiv("vam-ai-card-pop-sources");
    const keep = this.el.createEl("label", { cls: "vam-ai-card-pop-keep" });
    this.keepEl = keep.createEl("input", { attr: { type: "checkbox" } });
    this.keepEl.checked = host.initial.keepOld;
    keep.createSpan({ text: t("ui.ai_card_keep_old") });
    const foot = this.el.createDiv("vam-ai-card-pop-foot");
    this.saveEl = foot.createEl("button", { cls: "mod-cta", text: t("ui.ai_card_save"), attr: { type: "button" } });
    this.on(this.saveEl, "click", () => this.save());
    this.on(this.el, "keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault?.();
        event.stopPropagation?.();
        this.host.cancel();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault?.();
        this.save();
      }
    });
    // A press outside the window (not while the note picker is open) cancels: nothing is written.
    const doc = parent.ownerDocument;
    const outside = (event: Event): void => {
      if (this.picking || this.destroyed) return;
      const target = event.target as Node | null;
      if (target && this.el.contains(target)) return;
      this.host.cancel();
    };
    doc.addEventListener("pointerdown", outside, true);
    this.cleanups.push(() => doc.removeEventListener("pointerdown", outside, true));
    this.paintSources();
    this.refresh();
  }

  /** Puts the window in `parent` (again, after a repaint), places it and focuses the question unless `focus` is false. */
  mount(parent: HTMLElement, focus = true): void {
    if (this.destroyed) return;
    if (!parent.contains(this.el)) parent.appendChild(this.el);
    parent.addClass("has-topic-chat");
    this.parentEl = parent;
    this.reposition();
    if (focus) this.questionEl.focus();
  }

  /** Right of the card when it fits, else left; a narrow canvas puts the window at the bottom. */
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
      this.el.setCssProps({ left: "0px", top: "", "--vam-topic-chat-max": areaHeight > 16 ? `${areaHeight - 16}px` : "" });
      return;
    }
    this.el.removeClass("is-bottom");
    const width = this.el.offsetWidth || WIDTH_FALLBACK;
    let left = card.right - area.left + GAP;
    if (left + width > areaWidth) left = card.left - area.left - width - GAP;
    left = Math.max(0, Math.min(left, areaWidth - width));
    let top = card.top - area.top;
    let floor = areaHeight;
    if (controls && controls.left < area.left + left + width && controls.right > area.left + left)
      floor = Math.min(floor, controls.top - area.top - GAP);
    const height = floor > 0 ? Math.min(this.el.offsetHeight || 0, floor) : this.el.offsetHeight || 0;
    if (floor > 0) top = Math.max(0, Math.min(top, floor - height));
    this.el.setCssProps({ left: `${left}px`, top: `${top}px`, "--vam-topic-chat-max": floor > 0 ? `${floor}px` : "" });
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
      keepOld: this.keepEl.checked
    };
  }

  /** An empty question saves only when it clears a question that was there (the card stops being an AI card). */
  private canSave(): boolean {
    return this.questionEl.value.trim() !== "" || this.host.initial.question.trim() !== "";
  }

  private refresh(): void {
    this.saveEl.disabled = !this.canSave();
  }

  private save(): void {
    if (!this.canSave() || this.destroyed) return;
    this.host.save(this.values());
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
        const at = this.sources.indexOf(name);
        if (at >= 0) this.sources.splice(at, 1);
        this.paintSources();
        this.questionEl.focus();
      });
    }
    const add = this.chipsEl.createEl("button", {
      cls: "vam-ai-card-pop-add",
      text: t("ui.ai_card_add_notes"),
      attr: { type: "button" }
    });
    this.on(add, "click", () => {
      this.picking = true;
      this.host.pickNote(
        name => {
          if (this.destroyed) return;
          if (!this.sources.includes(name)) this.sources.push(name);
          this.paintSources();
        },
        () => {
          this.picking = false;
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
