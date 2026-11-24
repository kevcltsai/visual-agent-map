/** Creates a standard named cancellation error for source readers. */
export const abortError = (): Error => Object.assign(new Error("Aborted"), { name: "AbortError" });

/** The call's result, or a rejection the moment `signal` aborts: a provider that ignores abort must not hang Stop. */
export function untilAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    const settle = (): void => signal.removeEventListener("abort", onAbort);
    work.then(
      value => {
        settle();
        resolve(value);
      },
      (error: unknown) => {
        settle();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}
