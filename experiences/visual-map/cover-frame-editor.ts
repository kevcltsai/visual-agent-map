import { Modal, type App } from "obsidian";
import { t, type TranslationKey } from "../../i18n";
import type { CoverFrame } from "./card-cover";

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

export interface CoverFrameModalOptions {
  /** The picture's resource path; the file itself is shown whole and never changed. */
  src: string;
  /** The note's frame, or null for the whole picture. */
  initial: CoverFrame | null;
  /** Called once by Apply with the frame to write (null: whole picture, remove the key). Cancel and close never call it. */
  onApply: (frame: CoverFrame | null) => Promise<void> | void;
}

/**
 * The "Adjust area" dialog: the whole picture, a white frame with the outside dimmed, eight handle buttons and the
 * inside to drag. Pointer events with pointer capture (touch works); the frame also takes arrow keys. Only Apply writes.
 */
export class CoverFrameModal extends Modal {
  private draft: CoverFrame;
  private applying = false;
  private boxEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private applyButton: HTMLButtonElement | null = null;
  constructor(
    app: App,
    private readonly options: CoverFrameModalOptions
  ) {
    super(app);
    this.draft = { ...(options.initial ?? WHOLE) };
  }
  onOpen(): void {
    this.modalEl.addClass("vam-card-frame-modal");
    this.titleEl.setText(t("ui.topic_cover_frame_title"));
    const stage = this.contentEl.createDiv({ cls: "vam-card-frame-stage" });
    const img = stage.createEl("img", {
      cls: "vam-card-frame-image",
      attr: { src: this.options.src, alt: "", draggable: "false" }
    });
    img.addEventListener("error", () => {
      if (this.applyButton) this.applyButton.disabled = true;
      this.statusEl?.setText(t("ui.topic_cover_frame_load_failed"));
    });
    const box = stage.createDiv({ cls: "vam-card-frame-box" });
    box.setAttr("tabindex", "0");
    box.setAttr("role", "group");
    box.setAttr("aria-label", t(HANDLE_KEY.move));
    this.boxEl = box;
    this.bindDrag(box, "move", stage);
    for (const mode of FRAME_HANDLES) {
      const handle = box.createEl("button", {
        cls: `vam-card-frame-handle is-${mode}`,
        attr: { type: "button", "aria-label": t(HANDLE_KEY[mode]) }
      });
      handle.dataset.mode = mode;
      this.bindDrag(handle, mode, stage);
    }
    box.addEventListener("keydown", (event: KeyboardEvent) => {
      const next = nudgeCoverFrame(this.draft, event.key, event.shiftKey);
      if (!next) return;
      event.preventDefault();
      this.setDraft(next);
    });
    this.statusEl = this.contentEl.createDiv({ cls: "vam-card-frame-status", attr: { "aria-live": "polite" } });
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
    box.focus();
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
    const box = this.boxEl;
    if (!box) return;
    const percent = (value: number): string => `${round(value * 100)}%`;
    box.style.left = percent(frame.x);
    box.style.top = percent(frame.y);
    box.style.width = percent(frame.w);
    box.style.height = percent(frame.h);
    this.statusEl?.setText(
      t(
        "ui.topic_cover_frame_status",
        Math.round(frame.x * 100),
        Math.round(frame.y * 100),
        Math.round(frame.w * 100),
        Math.round(frame.h * 100)
      )
    );
  }
  /** Pointer capture keeps the drag on this element even when the pointer leaves it or the dialog. */
  private bindDrag(target: HTMLElement, mode: FrameDragMode, stage: HTMLElement): void {
    let drag: { id: number; x: number; y: number; width: number; height: number; start: CoverFrame } | null = null;
    target.addEventListener("pointerdown", (event: PointerEvent) => {
      if (mode === "move" && event.target !== target) return;
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      event.preventDefault();
      event.stopPropagation();
      target.setPointerCapture?.(event.pointerId);
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        width: rect.width,
        height: rect.height,
        start: { ...this.draft }
      };
    });
    target.addEventListener("pointermove", (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      this.setDraft(
        dragCoverFrame(mode, drag.start, (event.clientX - drag.x) / drag.width, (event.clientY - drag.y) / drag.height)
      );
    });
    const end = (event: PointerEvent): void => {
      if (!drag || event.pointerId !== drag.id) return;
      target.releasePointerCapture?.(drag.id);
      drag = null;
    };
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }
}
