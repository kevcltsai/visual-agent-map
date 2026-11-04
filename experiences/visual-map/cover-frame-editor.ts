import { Modal, type App } from "obsidian";
import { t, type TranslationKey } from "../../i18n";
import {
  COVER_POSITIONS,
  COVER_SIZE_DEFAULT,
  COVER_SIZE_MIN,
  parseCoverPosition,
  parseCoverSize,
  type CoverFrame,
  type CoverPosition
} from "./card-cover";
import { CARD_WIDTH, CARD_WIDTH_MAX, CARD_WIDTH_MIN, CARD_WIDTH_STEP, clampCardWidth } from "../../map-graph";
import { arrangeCover, coverWindow, placeCoverFrame, sizeCoverBox } from "./cover-layout";

/** The smallest a frame side can be, as a fraction of the picture. */
export const MIN_FRAME_SIDE = 0.08;
/** One arrow-key step, as a fraction of the picture. */
export const FRAME_KEY_STEP = 0.01;
/** The note keeps four decimals, so a frame this close to the whole picture is the whole picture. */
const WHOLE_EPSILON = 0.0005;
const ROUND = 1e6;

export type FrameDragMode = "move" | "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";
export const FRAME_HANDLES: readonly FrameDragMode[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const round = (value: number): number => Math.round(value * ROUND) / ROUND;
const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

/**
 * The frame after dragging from `start` by `dx`/`dy` (fractions of the picture's width and height). Moving keeps the
 * size; a handle moves only its own edges. Every side stays at least MIN_FRAME_SIDE and inside the picture. Pure.
 */
export function dragCoverFrame(mode: FrameDragMode, start: CoverFrame, dx: number, dy: number): CoverFrame {
  if (mode === "move") {
    return {
      x: round(clamp(start.x + dx, 0, 1 - start.w)),
      y: round(clamp(start.y + dy, 0, 1 - start.h)),
      w: start.w,
      h: start.h
    };
  }
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (mode.includes("w")) left = clamp(start.x + dx, 0, right - MIN_FRAME_SIDE);
  if (mode.includes("e")) right = clamp(right + dx, left + MIN_FRAME_SIDE, 1);
  if (mode.includes("n")) top = clamp(start.y + dy, 0, bottom - MIN_FRAME_SIDE);
  if (mode.includes("s")) bottom = clamp(bottom + dy, top + MIN_FRAME_SIDE, 1);
  return { x: round(left), y: round(top), w: round(right - left), h: round(bottom - top) };
}

/** Arrow keys move the frame 1%; with Shift they resize it from the bottom-right 1%. Null for any other key. */
export function nudgeCoverFrame(frame: CoverFrame, key: string, shift: boolean): CoverFrame | null {
  const dx = key === "ArrowRight" ? FRAME_KEY_STEP : key === "ArrowLeft" ? -FRAME_KEY_STEP : 0;
  const dy = key === "ArrowDown" ? FRAME_KEY_STEP : key === "ArrowUp" ? -FRAME_KEY_STEP : 0;
  if (!dx && !dy) return null;
  return dragCoverFrame(shift ? "se" : "move", frame, dx, dy);
}

export function isWholeFrame(frame: CoverFrame): boolean {
  return (
    frame.x < WHOLE_EPSILON && frame.y < WHOLE_EPSILON && frame.w > 1 - WHOLE_EPSILON && frame.h > 1 - WHOLE_EPSILON
  );
}

/** What goes into the note: null (no key) for the whole picture. */
export function frameToWrite(frame: CoverFrame | null): CoverFrame | null {
  return !frame || isWholeFrame(frame) ? null : frame;
}

let labelSeq = 0;
const WHOLE: CoverFrame = { x: 0, y: 0, w: 1, h: 1 };
const HANDLE_KEY: Record<FrameDragMode, TranslationKey> = {
  move: "ui.topic_cover_frame_box",
  nw: "ui.topic_cover_frame_handle_nw",
  n: "ui.topic_cover_frame_handle_n",
  ne: "ui.topic_cover_frame_handle_ne",
  e: "ui.topic_cover_frame_handle_e",
  se: "ui.topic_cover_frame_handle_se",
  s: "ui.topic_cover_frame_handle_s",
  sw: "ui.topic_cover_frame_handle_sw",
  w: "ui.topic_cover_frame_handle_w"
};

/** Arrow keys on one handle move only that handle's edges, 1% per press. Null for any other key. */
export function nudgeCoverFrameEdge(mode: FrameDragMode, frame: CoverFrame, key: string): CoverFrame | null {
  const horizontal = mode.includes("e") || mode.includes("w");
  const vertical = mode.includes("n") || mode.includes("s");
  const dx = !horizontal ? 0 : key === "ArrowRight" ? FRAME_KEY_STEP : key === "ArrowLeft" ? -FRAME_KEY_STEP : 0;
  const dy = !vertical ? 0 : key === "ArrowDown" ? FRAME_KEY_STEP : key === "ArrowUp" ? -FRAME_KEY_STEP : 0;
  if (!dx && !dy) return null;
  return dragCoverFrame(mode, frame, dx, dy);
}

/** What Apply hands over: the frame to write (null: whole picture, remove the key), the picture size (k) and position. */
export interface CardCoverEdit {
  frame: CoverFrame | null;
  size: number;
  position: CoverPosition;
  /** The card width to write to the map (CARD_WIDTH: the standard width). Present only when the user changed it. */
  width?: number;
}

/** Switching to left or right with a picture wider than this sets it to SIDE_SIZE, so the text keeps room beside it. */
export const SIDE_SIZE_LIMIT = 0.5;
export const SIDE_SIZE = 0.45;
const POSITION_KEY: Record<CoverPosition, TranslationKey> = {
  top: "ui.card_edit_position_top",
  bottom: "ui.card_edit_position_bottom",
  left: "ui.card_edit_position_left",
  right: "ui.card_edit_position_right"
};
const isSide = (position: CoverPosition): boolean => position === "left" || position === "right";

/** The picture-size slider works in whole percents of the card's content width. */
const SIZE_STEP = 1;

export interface CoverFrameModalOptions {
  /** The picture's resource path; the file itself is shown as it is and never changed. */
  src: string;
  /** The note's frame, or null for the whole picture. */
  initial: CoverFrame | null;
  /** The note's picture size (k, 0.3-1); the default 1 when absent. */
  size?: number;
  /** The note's picture position; top when absent. */
  position?: CoverPosition;
  /** The topic's card width on the map (absent: the standard width). The dialog's right edge changes it within the map's limits. */
  width?: number;
  /** The picture's width over height when the map already measured it, so the card has its size before the picture loads. */
  shape?: number | null;
  /**
   * A detached copy of the topic's card as the map draws it (same width, fonts and line wrapping). Its cover is replaced
   * by the editable one; everything else is shown as it is and does not take input. Without it, a plain card.
   */
  card?: () => HTMLElement;
  /** Called once by Apply with the frame and size to write. Cancel and close never call it. */
  onApply: (edit: CardCoverEdit) => Promise<void> | void;
}

interface CoverDrag {
  id: number;
  mode: FrameDragMode;
  x: number;
  y: number;
  /** Screen pixels per picture width and per picture height at the start of the drag. */
  across: number;
  down: number;
  start: CoverFrame;
}

/**
 * The "Edit card" dialog: one card in the middle that looks like the card on the map, edited in place. On its cover,
 * a tool row above it sets the picture size and position, dragging inside moves the mask over the still picture, the eight handles (shown on hover, focus or touch) hide a side,
 * and arrow keys move the mask 1% (Shift and arrow keys resize it from the bottom right). The picture keeps its scale
 * (cover-layout.ts). Pointer events with pointer capture, so touch works. Only Apply writes.
 */
export class CoverFrameModal extends Modal {
  private draft: CoverFrame;
  private size: number;
  private position: CoverPosition;
  private cardEl: HTMLElement | null = null;
  private width: number;
  private readonly initialWidth: number;
  private widthHandle: HTMLElement | null = null;
  private sizeSlider: HTMLInputElement | null = null;
  private shape: number | null;
  private drag: CoverDrag | null = null;
  private applying = false;
  private coverEl: HTMLElement | null = null;
  private windowEl: HTMLElement | null = null;
  private imgEl: HTMLImageElement | null = null;
  private ghostEl: HTMLImageElement | null = null;
  private boxEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private applyButton: HTMLButtonElement | null = null;
  constructor(
    app: App,
    private readonly options: CoverFrameModalOptions
  ) {
    super(app);
    this.draft = { ...(options.initial ?? WHOLE) };
    this.size = parseCoverSize(options.size ?? COVER_SIZE_DEFAULT);
    this.position = parseCoverPosition(options.position);
    this.initialWidth = this.width = clampCardWidth(options.width) ?? CARD_WIDTH;
    this.shape = options.shape && Number.isFinite(options.shape) && options.shape > 0 ? options.shape : null;
  }
  onOpen(): void {
    this.modalEl.addClass("vam-card-frame-modal");
    this.titleEl.setText(t("ui.topic_cover_frame_title"));
    this.buildTools(this.contentEl.createDiv({ cls: "vam-card-frame-tools" }));
    const stage = this.contentEl.createDiv({ cls: "vam-card-frame-stage" });
    const given = this.options.card?.();
    // Without the map card, the stylesheet's default card (its width and padding), empty but for the cover.
    const card = given ? stage.appendChild(given) : stage.createDiv({ cls: "vam-node" });
    this.cardEl = card;
    // A copied side layout is taken apart first, so every text child is a direct child that can be made inert.
    arrangeCover(card, null, "top");
    const cover = this.buildCover(card);
    // The rest of the card is shown, not edited (ticket 05 adds the text).
    for (const child of Array.from(card.children)) if (child !== cover) child.setAttr("inert", "");
    arrangeCover(card, cover, this.position);
    this.buildWidthHandle(card);
    // aria-labelledby, not aria-label: Obsidian shows an aria-label as a tooltip, which would cover the picture.
    const labelId = `vam-card-frame-label-${++labelSeq}`;
    this.contentEl.createSpan({ cls: "vam-card-frame-label", text: t(HANDLE_KEY.move), attr: { id: labelId } });
    cover.setAttr("aria-labelledby", labelId);
    // Screen readers hear the numbers; nothing shows them.
    this.statusEl = this.contentEl.createDiv({
      cls: "vam-card-frame-status vam-sr-only",
      attr: { "aria-live": "polite" }
    });
    const actions = this.contentEl.createDiv({ cls: "vam-card-frame-actions" });
    const reset = actions.createEl("button", { text: t("ui.topic_cover_frame_reset"), attr: { type: "button" } });
    reset.addEventListener("click", () => this.setDraft({ ...WHOLE }));
    const cancel = actions.createEl("button", { text: t("ui.cancel"), attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    this.applyButton = actions.createEl("button", {
      text: t("ui.topic_cover_frame_apply"),
      cls: "mod-cta",
      attr: { type: "button" }
    });
    this.applyButton.addEventListener("click", () => void this.apply());
    this.setDraft(this.draft);
    cover.focus();
  }
  /** The width splitter on the card's right edge, the same setting and limits as the map's (map-graph.ts). */
  private buildWidthHandle(card: HTMLElement): void {
    const handle = card.createSpan({
      cls: "vam-card-frame-width",
      attr: {
        role: "separator",
        "aria-orientation": "vertical",
        "aria-label": t("ui.card_resize_label"),
        "aria-valuemin": String(CARD_WIDTH_MIN),
        "aria-valuemax": String(CARD_WIDTH_MAX),
        tabindex: "0"
      }
    });
    this.widthHandle = handle;
    // The copied card already has its width; the style is only written when the user changes it.
    handle.setAttr("aria-valuenow", String(this.width));
    let drag: { id: number; x: number; from: number } | null = null;
    handle.addEventListener("pointerdown", (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      handle.setPointerCapture?.(event.pointerId);
      drag = { id: event.pointerId, x: event.clientX, from: this.width };
    });
    handle.addEventListener("pointermove", (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      this.setWidth(drag.from + (event.clientX - drag.x));
    });
    const end = (event: PointerEvent): void => {
      if (!drag || event.pointerId !== drag.id) return;
      handle.releasePointerCapture?.(drag.id);
      drag = null;
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    // The map's keys: arrows step, Home/End the limits, Enter the standard width.
    handle.addEventListener("keydown", (event: KeyboardEvent) => {
      let next: number;
      if (event.key === "ArrowRight") next = this.width + CARD_WIDTH_STEP;
      else if (event.key === "ArrowLeft") next = this.width - CARD_WIDTH_STEP;
      else if (event.key === "Home") next = CARD_WIDTH_MIN;
      else if (event.key === "End") next = CARD_WIDTH_MAX;
      else if (event.key === "Enter") next = CARD_WIDTH;
      else return;
      event.preventDefault();
      event.stopPropagation();
      this.setWidth(next);
    });
  }
  /** Sets the dialog card's width (clamped to the map's limits); wrapping and the cover follow, as they are proportions. */
  private setWidth(value: number): void {
    this.width = clampCardWidth(value) ?? this.width;
    this.cardEl?.style.setProperty("width", `${this.width}px`);
    this.widthHandle?.setAttr("aria-valuenow", String(this.width));
    this.setDraft(this.draft);
  }
  /** The tool row above the card: the picture size slider (30-100% of the content width). */
  private buildTools(row: HTMLElement): void {
    const label = row.createEl("label", { cls: "vam-card-frame-tool" });
    label.createSpan({ text: t("ui.card_edit_picture_size") });
    const slider = label.createEl("input", {
      cls: "vam-card-frame-size",
      type: "range",
      attr: { min: String(COVER_SIZE_MIN * 100), max: "100", step: String(SIZE_STEP) }
    });
    slider.value = String(Math.round(this.size * 100));
    const update = (): void => {
      const value = Number(slider.value);
      if (!Number.isFinite(value)) return;
      // The range input already holds 30-100; a stray value is clamped to it (never read as "invalid, default").
      this.size = Math.min(1, Math.max(COVER_SIZE_MIN, value / 100));
      slider.setAttr("aria-valuetext", `${Math.round(this.size * 100)}%`);
      this.setDraft(this.draft);
    };
    slider.setAttr("aria-valuetext", `${Math.round(this.size * 100)}%`);
    slider.addEventListener("input", update);
    slider.addEventListener("change", update);
    this.sizeSlider = slider;
    const place = row.createDiv({ cls: "vam-card-frame-tool" });
    const placeLabel = place.createSpan({ text: t("ui.card_edit_picture_position") });
    const group = place.createDiv({ cls: "vam-card-frame-positions" });
    group.setAttr("role", "radiogroup");
    const groupLabel = `vam-card-frame-position-${labelSeq + 1}`;
    placeLabel.setAttr("id", groupLabel);
    group.setAttr("aria-labelledby", groupLabel);
    const choices: HTMLButtonElement[] = [];
    const paint = (): void => {
      for (const [index, choice] of choices.entries()) {
        const on = COVER_POSITIONS[index] === this.position;
        choice.setAttr("aria-checked", String(on));
        choice.setAttr("tabindex", on ? "0" : "-1");
        choice.toggleClass("is-active", on);
      }
    };
    for (const position of COVER_POSITIONS) {
      const choice = group.createEl("button", {
        cls: "vam-card-frame-position",
        text: t(POSITION_KEY[position]),
        attr: { type: "button", role: "radio" }
      });
      choice.dataset.position = position;
      choice.addEventListener("click", () => {
        this.setPosition(position);
        paint();
      });
      // Arrow keys move between the four choices, as in any radio group.
      choice.addEventListener("keydown", (event: KeyboardEvent) => {
        const step =
          event.key === "ArrowRight" || event.key === "ArrowDown"
            ? 1
            : event.key === "ArrowLeft" || event.key === "ArrowUp"
              ? -1
              : 0;
        if (!step) return;
        event.preventDefault();
        const index = (COVER_POSITIONS.indexOf(this.position) + step + COVER_POSITIONS.length) % COVER_POSITIONS.length;
        this.setPosition(COVER_POSITIONS[index]);
        paint();
        choices[index].focus();
      });
      choices.push(choice);
    }
    paint();
  }
  /** Moves the picture on the dialog card; moving it beside the text with a picture over half the width makes it 45%. */
  private setPosition(position: CoverPosition): void {
    if (position === this.position) return;
    // Only a move from top or bottom to a side shrinks the picture; left to right keeps the size the user chose there.
    const toSide = isSide(position) && !isSide(this.position);
    this.position = position;
    if (toSide && this.size > SIDE_SIZE_LIMIT) {
      this.size = SIDE_SIZE;
      if (this.sizeSlider) {
        this.sizeSlider.value = String(Math.round(SIDE_SIZE * 100));
        this.sizeSlider.setAttr("aria-valuetext", `${Math.round(SIDE_SIZE * 100)}%`);
      }
    }
    if (this.cardEl && this.coverEl) arrangeCover(this.cardEl, this.coverEl, position);
    this.setDraft(this.draft);
  }
  /** Replaces the card's cover (or adds one before the title) with the editable cover: picture, window, mask box, handles. */
  private buildCover(card: HTMLElement): HTMLElement {
    const old = card.querySelector<HTMLElement>(".vam-card-cover");
    const before = old ?? card.querySelector<HTMLElement>(".vam-card-title");
    const cover = card.createDiv({ cls: "vam-card-cover is-framed" });
    cover.remove();
    (before?.parentElement ?? card).insertBefore(cover, before ?? null);
    old?.remove();
    cover.setAttr("tabindex", "0");
    cover.setAttr("role", "group");
    const picture = { src: this.options.src, alt: "", draggable: "false" };
    // The whole picture, faint, while a drag runs: it shows where the mask can go.
    this.ghostEl = cover.createEl("img", { cls: "vam-card-frame-ghost", attr: { ...picture, "aria-hidden": "true" } });
    this.windowEl = cover.createDiv({ cls: "vam-card-cover-window" });
    const img = this.windowEl.createEl("img", { attr: picture });
    this.imgEl = img;
    img.addEventListener("error", () => {
      if (this.applyButton) this.applyButton.disabled = true;
      this.contentEl.createEl("p", { cls: "vam-card-frame-error", text: t("ui.topic_cover_frame_load_failed") });
    });
    img.addEventListener("load", () => {
      const shape = img.naturalWidth / img.naturalHeight;
      if (this.shape || !coverWindow(img.naturalWidth, img.naturalHeight, null, 1)) return;
      this.shape = shape;
      this.setDraft(this.draft);
    });
    const box = cover.createDiv({ cls: "vam-card-frame-box" });
    this.boxEl = box;
    this.bindDrag(box, "move");
    for (const mode of FRAME_HANDLES) {
      const handle = box.createEl("button", {
        cls: `vam-card-frame-handle is-${mode}`,
        attr: { type: "button", "aria-label": t(HANDLE_KEY[mode]) }
      });
      handle.dataset.mode = mode;
      this.bindDrag(handle, mode);
      handle.addEventListener("keydown", (event: KeyboardEvent) => {
        const next = nudgeCoverFrameEdge(mode, this.draft, event.key);
        if (!next) return;
        event.preventDefault();
        event.stopPropagation();
        this.setDraft(next);
      });
    }
    cover.addEventListener("keydown", (event: KeyboardEvent) => {
      const next = nudgeCoverFrame(this.draft, event.key, event.shiftKey);
      if (!next) return;
      event.preventDefault();
      this.setDraft(next);
    });
    this.coverEl = cover;
    return cover;
  }
  private async apply(): Promise<void> {
    if (this.applying) return;
    this.applying = true;
    if (this.applyButton) this.applyButton.disabled = true;
    try {
      const edit: CardCoverEdit = { frame: frameToWrite(this.draft), size: this.size, position: this.position };
      if (this.width !== this.initialWidth) edit.width = this.width;
      await this.options.onApply(edit);
    } finally {
      this.close();
    }
  }
  private setDraft(frame: CoverFrame): void {
    this.draft = frame;
    this.statusEl?.setText(
      t(
        "ui.topic_cover_frame_status",
        Math.round(frame.x * 100),
        Math.round(frame.y * 100),
        Math.round(frame.w * 100),
        Math.round(frame.h * 100)
      )
    );
    const cover = this.coverEl;
    const box = this.boxEl;
    if (cover) sizeCoverBox(cover, this.size, isSide(this.position));
    if (!cover || !box || !this.windowEl || !this.imgEl || !this.ghostEl || !this.shape) return;
    // The map's own placement, so the dialog card is the map card.
    const win = placeCoverFrame({ frame: cover, window: this.windowEl, img: this.imgEl }, this.shape, frame);
    if (!win) return;
    box.style.setProperty("left", `${win.left * 100}%`);
    box.style.setProperty("width", `${win.width * 100}%`);
    box.style.setProperty("aspect-ratio", String(win.width / win.height));
    // During a drag the picture stays still: the window is shifted down by how far its top moved since the drag began
    // (between drags the window starts at the top of the cover, as on the map). Percentages of the window's own height.
    const anchor = this.drag ? this.drag.start.y : frame.y;
    const shift = `translateY(${((frame.y - anchor) / frame.h) * 100}%)`;
    this.windowEl.style.setProperty("transform", shift);
    box.style.setProperty("transform", shift);
    const ghost = this.ghostEl.style;
    ghost.setProperty("left", `${(win.left - frame.x * win.scale) * 100}%`);
    ghost.setProperty("width", `${win.scale * 100}%`);
    ghost.setProperty("aspect-ratio", String(this.shape));
    // Top as a percentage of the cover's height (the window's height, h of the picture).
    ghost.setProperty("top", `${(-anchor / frame.h) * 100}%`);
  }
  /** Pointer capture keeps the drag on this element even when the pointer leaves it or the dialog. */
  private bindDrag(target: HTMLElement, mode: FrameDragMode): void {
    target.addEventListener("pointerdown", (event: PointerEvent) => {
      if (mode === "move" && event.target !== target) return;
      const cover = this.coverEl;
      const width = cover?.getBoundingClientRect().width ?? 0;
      const scale = this.shape ? (coverWindow(this.shape, 1, this.draft, 1)?.scale ?? 1) : 1;
      if (!cover || !width || !this.shape) return;
      event.preventDefault();
      event.stopPropagation();
      target.setPointerCapture?.(event.pointerId);
      cover.addClass("is-active", "is-dragging");
      const across = width * scale;
      this.drag = {
        id: event.pointerId,
        mode,
        x: event.clientX,
        y: event.clientY,
        across,
        down: across / this.shape,
        start: { ...this.draft }
      };
    });
    target.addEventListener("pointermove", (event: PointerEvent) => {
      const drag = this.drag;
      if (!drag || drag.mode !== mode || event.pointerId !== drag.id) return;
      this.setDraft(
        dragCoverFrame(mode, drag.start, (event.clientX - drag.x) / drag.across, (event.clientY - drag.y) / drag.down)
      );
    });
    const end = (event: PointerEvent): void => {
      const drag = this.drag;
      if (!drag || drag.mode !== mode || event.pointerId !== drag.id) return;
      target.releasePointerCapture?.(drag.id);
      this.drag = null;
      this.coverEl?.removeClass("is-dragging");
      this.setDraft(this.draft);
    };
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }
}
