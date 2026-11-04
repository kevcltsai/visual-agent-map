import { Modal, type App } from "obsidian";
import { t, type TranslationKey } from "../../i18n";
import type { CoverFrame } from "./card-cover";
import { coverWindow, placeCoverFrame } from "./cover-layout";

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

export interface CoverFrameModalOptions {
  /** The picture's resource path; the file itself is shown as it is and never changed. */
  src: string;
  /** The note's frame, or null for the whole picture. */
  initial: CoverFrame | null;
  /** The picture's width over height when the map already measured it, so the card has its size before the picture loads. */
  shape?: number | null;
  /**
   * A detached copy of the topic's card as the map draws it (same width, fonts and line wrapping). Its cover is replaced
   * by the editable one; everything else is shown as it is and does not take input. Without it, a plain card.
   */
  card?: () => HTMLElement;
  /** Called once by Apply with the frame to write (null: whole picture, remove the key). Cancel and close never call it. */
  onApply: (frame: CoverFrame | null) => Promise<void> | void;
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
 * dragging inside moves the mask over the still picture, the eight handles (shown on hover, focus or touch) hide a side,
 * and arrow keys move the mask 1% (Shift and arrow keys resize it from the bottom right). The picture keeps its scale
 * (cover-layout.ts). Pointer events with pointer capture, so touch works. Only Apply writes.
 */
export class CoverFrameModal extends Modal {
  private draft: CoverFrame;
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
    this.shape = options.shape && Number.isFinite(options.shape) && options.shape > 0 ? options.shape : null;
  }
  onOpen(): void {
    this.modalEl.addClass("vam-card-frame-modal");
    this.titleEl.setText(t("ui.topic_cover_frame_title"));
    const stage = this.contentEl.createDiv({ cls: "vam-card-frame-stage" });
    const given = this.options.card?.();
    // Without the map card, the stylesheet's default card (its width and padding), empty but for the cover.
    const card = given ? stage.appendChild(given) : stage.createDiv({ cls: "vam-node" });
    const cover = this.buildCover(card);
    // The rest of the card is shown, not edited (ticket 05 adds the text).
    for (const child of Array.from(card.children)) if (child !== cover) child.setAttr("inert", "");
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
      await this.options.onApply(frameToWrite(this.draft));
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
