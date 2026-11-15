import { randomUUID } from "node:crypto";

/** How long a request may go without any model event before the slow notice (and the re-send) is offered. */
export const FIRST_EVENT_WAIT_MS = 20_000;

/** Timer and wall clock of the first-event watchdog; tests replace it with a fake. */
export interface AttemptClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: AttemptClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: handle => window.clearTimeout(handle as number)
};

/** One request to the model inside {@link runAttempts}. What counts as a model event, and when the wait starts, is the caller's rule. */
export interface Attempt {
  readonly id: string;
  /** 1 for the first request, +1 for every re-send. */
  readonly number: number;
  /** Aborted by a re-send, or when the outer signal aborts. */
  readonly signal: AbortSignal;
  /** False once this attempt was stopped or replaced: whatever it still reports must be dropped. */
  live(): boolean;
  /** Starts (or restarts) the wait for the first model event; the slow notice comes {@link FIRST_EVENT_WAIT_MS} later. */
  arm(): void;
  /** The caller saw a model event: the wait ends and a shown notice is cleared. Returns {@link Attempt.live}. */
  seen(): boolean;
  /** Without stream events (anything but stream-json) the first event cannot be seen, so the notice would be a false alarm. */
  streamMode(mode: string): void;
}

export interface RunAttemptsOptions<T> {
  /** The caller's own signal (task or whole map-chat turn). It wins over a re-send. */
  signal?: AbortSignal;
  clock?: AttemptClock;
  /** The error thrown when the outer signal aborts. */
  stopped: () => Error;
  start: (attempt: Attempt) => Promise<T>;
  onAttempt?(attempt: Attempt): void;
  /** No model event for {@link FIRST_EVENT_WAIT_MS}: `resend` replaces the attempt. Never automatic. */
  onSlow?(attempt: Attempt, resend: () => void): void;
  /** A model event arrived after the notice was shown. */
  onCleared?(attempt: Attempt): void;
  /** Synchronous, inside resend() and before the old attempt is aborted. */
  onResend?(attempt: Attempt): void;
  /** After the old attempt ended, before the next one starts; not called when the outer signal aborted. */
  onReplaced?(attempt: Attempt): void;
}

/**
 * The observed model call (S3, D-2026-10-25): each attempt runs one model request. Without a model event for
 * {@link FIRST_EVENT_WAIT_MS} after the caller armed the wait, `onSlow` hands out a `resend` that replaces the attempt:
 * it stops the old request and starts the same one again inside this same call, so the caller's stale checks and running
 * flag stay as they are and nothing from the old attempt can be written. Never automatic. The outer signal wins over a
 * re-send. A hook must not be able to fail the request.
 */
export async function runAttempts<T>(options: RunAttemptsOptions<T>): Promise<T> {
  const { signal: outer, stopped } = options;
  const clock = options.clock ?? realClock;
  const safe = (callback: (() => void) | undefined): void => {
    try {
      callback?.();
    } catch {
      /* A hook must not be able to fail the request. */
    }
  };
  let number = 0;
  for (;;) {
    if (outer?.aborted) throw stopped();
    number++;
    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort();
    outer?.addEventListener("abort", onOuterAbort, { once: true });
    let resendRequested = false,
      firstEvent = false,
      slowShown = false,
      watching = true,
      timer: unknown;
    // After a re-send or a stop, whatever the old attempt still reports is dropped.
    const live = (): boolean => !controller.signal.aborted && !resendRequested;
    const disarm = (): void => {
      if (timer === undefined) return;
      clock.clearTimeout(timer);
      timer = undefined;
    };
    const attempt: Attempt = {
      id: randomUUID(),
      number,
      signal: controller.signal,
      live,
      arm: (): void => {
        disarm();
        if (!watching || firstEvent || !live()) return;
        timer = clock.setTimeout(() => {
          timer = undefined;
          if (firstEvent || !live()) return;
          slowShown = true;
          safe(() => options.onSlow?.(attempt, resend));
        }, FIRST_EVENT_WAIT_MS);
      },
      seen: (): boolean => {
        if (!live()) return false;
        if (!firstEvent) {
          firstEvent = true;
          disarm();
          if (slowShown) safe(() => options.onCleared?.(attempt));
        }
        return true;
      },
      streamMode: (mode: string): void => {
        if (mode === "stream-json") return;
        watching = false;
        disarm();
      }
    };
    // Stop wins; an attempt that was stopped, replaced, already answered or not watched cannot be replaced.
    const resend = (): void => {
      if (outer?.aborted || !live() || firstEvent || !watching) return;
      resendRequested = true;
      disarm();
      safe(() => options.onResend?.(attempt));
      controller.abort();
    };
    safe(() => options.onAttempt?.(attempt));
    // The race makes the loop independent of a runtime that is slow to honour the abort.
    const replaced = new Promise<never>((_resolve, reject) =>
      controller.signal.addEventListener("abort", () => reject(stopped()), { once: true })
    );
    replaced.catch(() => undefined);
    try {
      const running = options.start(attempt);
      running.catch(() => undefined);
      const sent = await Promise.race([running, replaced]);
      // A reply that arrives after the user replaced this attempt is discarded.
      if (!(resendRequested && !outer?.aborted)) return sent;
    } catch (error) {
      if (outer?.aborted || !resendRequested) throw error;
    } finally {
      disarm();
      outer?.removeEventListener("abort", onOuterAbort);
    }
    safe(() => options.onReplaced?.(attempt));
  }
}
