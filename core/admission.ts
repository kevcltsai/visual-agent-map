/**
 * Admission control for model calls. A caller that carries an {@link AdmissionContext} must reserve one call before every
 * actual provider request; a refusal is the distinct outcome `budget-exhausted`, never a note error. A call without a
 * context is not affected at all. Pure types plus one error class: no vault, no UI.
 */
export class BudgetExhaustedError extends Error {
  readonly outcome = "budget-exhausted" as const;
  constructor() {
    super("budget-exhausted");
    this.name = "BudgetExhaustedError";
  }
}

/** True for the refusal of an admission context (also across module copies, which share the error name). */
export function isBudgetExhausted(error: unknown): boolean {
  return (
    error instanceof BudgetExhaustedError ||
    (!!error && typeof error === "object" && (error as { name?: unknown }).name === "BudgetExhaustedError")
  );
}

export interface AdmissionContext {
  /**
   * Reserves and persists one call, or throws {@link BudgetExhaustedError}. Resolving means the reservation is saved:
   * a crash after it still counts the call.
   */
  reserve(): Promise<void>;
}
