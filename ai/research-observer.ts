// What a caller of askModel can watch while one research request runs. All members are optional and a callback that
// throws never fails the request. Every call after the first attempt carries that attempt's id, so a late event from an
// attempt the user replaced (re-send) is easy to tell apart.
export type ResearchStageName = "searching" | "reading" | "writing";

export interface ResearchPreviewFields {
  summary?: string;
  detail?: string;
}

/** Adds one user message to the running attempt. It rejects once the attempt can no longer take one (replaced, ended, stopped). */
export type SteerSender = (text: string) => Promise<void>;

/** What a caller keeps to add text to a request that is running; the state machine behind it decides what is delivered or queued. */
export interface ResearchSteer {
  /** The current attempt can take additions through `send`; `null` drops the handler (a new attempt starts). */
  bind(send: SteerSender | null): void;
  /** `false`: this request can no longer take an addition at all (for example a Claude json run); anything not yet delivered is queued. */
  live(on: boolean): void;
}

export interface ResearchObserver {
  /** An attempt starts (attempt 1 right away, then one per user re-send); progress resets to "waiting". */
  onAttempt?(attemptId: string, attempt: number): void;
  onStage?(attemptId: string, stage: ResearchStageName, query?: string): void;
  /** The text of the answer being written so far; `null` clears it (retracted or replaced). Nothing here is saved. */
  onPreview?(attemptId: string, fields: ResearchPreviewFields | null): void;
  /**
   * No model event arrived within the wait limit (`slow` true, with a `resend` handle that replaces the attempt), or
   * the first event arrived after all (`slow` false).
   */
  onSlow?(attemptId: string, slow: boolean, resend?: () => void): void;
  /**
   * The attempt can take user additions: `steer` writes one into the running turn (text already wrapped by the neutral steer
   * template). Only called when this hook exists, so an observer without it leaves the request exactly as before. A `steer` of
   * an attempt that was replaced or stopped rejects without writing anything.
   */
  onSteer?(attemptId: string, steer: SteerSender): void;
  /** Claude only: whether the call's output is read live (`stream-json`) or only arrives at the end. Additions need `stream-json`. */
  onStreamMode?(attemptId: string, mode: "stream-json" | "json" | "json-fallback"): void;
}

/**
 * `observer` plus the three events a {@link ResearchSteer} needs: a new attempt drops the old handler, the attempt's `steer`
 * is bound, a run that cannot stream is marked not live. Events of an attempt that is no longer the latest are ignored.
 * No `observer` (a progress entry the topic already has): none is made up, because an observer would change the stream mode.
 */
export function steerObserver(observer: ResearchObserver | undefined, steer: ResearchSteer | undefined): ResearchObserver | undefined {
  if (!observer || !steer) return observer;
  let current = "";
  return {
    ...observer,
    onAttempt: (id, attempt) => {
      current = id;
      steer.bind(null);
      observer.onAttempt?.(id, attempt);
    },
    onSteer: (id, send) => {
      if (id === current) steer.bind(send);
      observer.onSteer?.(id, send);
    },
    onStreamMode: (id, mode) => {
      if (id === current && mode !== "stream-json") steer.live(false);
      observer.onStreamMode?.(id, mode);
    }
  };
}
