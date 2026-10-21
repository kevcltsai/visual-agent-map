// What a caller of askModel can watch while one research request runs. All members are optional and a callback that
// throws never fails the request. Every call after the first attempt carries that attempt's id, so a late event from an
// attempt the user replaced (re-send) is easy to tell apart.
export type ResearchStageName = "searching" | "reading" | "writing";

export interface ResearchPreviewFields {
  summary?: string;
  detail?: string;
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
}
