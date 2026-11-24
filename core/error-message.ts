/** Message of any thrown value, without relying on instanceof Error (errors may cross realms). */
export function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(error);
}
