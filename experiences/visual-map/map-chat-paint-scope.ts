type PaintWindow = Partial<
  Pick<Window, "setInterval" | "clearInterval" | "requestAnimationFrame" | "cancelAnimationFrame">
>;
type IntervalSlot = "stage" | "chain-wait";
type FrameSlot = "stream" | "scroll";
type PaintSlot = IntervalSlot | FrameSlot;
interface PendingPaint {
  cancel?: () => void;
}

/** Owns the panel's paint callbacks; cancellation invalidates queued callbacks even if their window cannot cancel them. */
export class MapChatPaintScope {
  private readonly pending = new Map<PaintSlot, PendingPaint>();
  private disposed = false;

  activate(): void {
    this.disposed = false;
  }

  interval(slot: IntervalSlot, win: PaintWindow | undefined, paint: () => void): void {
    if (this.disposed || this.pending.has(slot) || typeof win?.setInterval !== "function") return;
    const entry: PendingPaint = {};
    this.pending.set(slot, entry);
    const id = win.setInterval(() => {
      if (this.pending.get(slot) === entry) paint();
    }, 1000);
    entry.cancel = () => win.clearInterval?.(id);
  }

  frame(slot: FrameSlot, win: PaintWindow | undefined, paint: () => void): void {
    if (this.disposed || this.pending.has(slot)) return;
    if (typeof win?.requestAnimationFrame !== "function") {
      paint();
      return;
    }
    const entry: PendingPaint = {};
    this.pending.set(slot, entry);
    const id = win.requestAnimationFrame(() => {
      if (this.pending.get(slot) !== entry) return;
      this.pending.delete(slot);
      paint();
    });
    entry.cancel = () => win.cancelAnimationFrame?.(id);
  }

  cancel(slot: PaintSlot): void {
    const entry = this.pending.get(slot);
    this.pending.delete(slot);
    entry?.cancel?.();
  }

  reset(): void {
    for (const slot of this.pending.keys()) this.cancel(slot);
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }
}
