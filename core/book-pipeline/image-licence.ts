// Deterministic licence status of an image candidate, from the page it was found on and the licence text shown there.
// "open": a Commons file page, or a licence text of CC0, CC BY, CC BY-SA (any version) or public domain.
// "restricted": NC, ND, "All rights reserved", ©, "copyright"; restricted wins over open (CC BY-NC-SA is restricted).
// "unknown": everything else, including an empty licence and a local Wikipedia file page.
export type LicenceStatus = "open" | "restricted" | "unknown";

const RESTRICTED = /(?:^|[^a-z])(?:nc|nd)(?:[^a-z]|$)|all rights reserved|©|\(c\)|copyright/i;
const OPEN = /(?:^|[^a-z])(?:cc0|cc[\s-]+by(?:[\s-]+sa)?|pdm?|public[\s-]+domain)(?:[^a-z]|$)/i;
const COMMONS_FILE_PAGE = /^https?:\/\/commons\.wikimedia\.org\/wiki\/File:/i;

export function licenceStatus({ source, license }: { source: string; license?: string }): LicenceStatus {
  const text = (license ?? "").trim();
  if (RESTRICTED.test(text)) return "restricted";
  if (COMMONS_FILE_PAGE.test(source.trim()) || OPEN.test(text)) return "open";
  return "unknown";
}
