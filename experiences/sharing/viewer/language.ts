/**
 * Which language a reader sees first (pure, no DOM). Order: the language the reader picked before (stored), the file's
 * `defaultLanguage`, the browser's language list, the original. Only languages the file carries can win.
 */

const sameTag = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const findTag = (languages: readonly string[], tag: string): string | undefined => languages.find(l => sameTag(l, tag));

/** The language of `languages` a browser language tag stands for, or undefined when the file has none. */
export function matchBrowserLanguage(tag: string, languages: readonly string[]): string | undefined {
  if (typeof tag !== "string" || !tag.trim()) return undefined;
  const exact = findTag(languages, tag.trim());
  if (exact) return exact;
  const parts = tag.trim().toLowerCase().split(/[-_]/);
  const primary = parts[0];
  if (primary === "zh") {
    const traditional = parts.slice(1).some(part => part === "hant" || part === "tw" || part === "hk" || part === "mo");
    // Traditional script and the regions that use it map to the TW tag; zh-Hans, zh-CN, zh-SG and a bare "zh" to CN.
    const region = traditional ? "TW" : "CN";
    return findTag(languages, `${primary}-${region}`);
  }
  return languages.find(l => l.toLowerCase().split(/[-_]/)[0] === primary);
}

export interface PickLanguageInput {
  /** The file's languages, the original first. */
  languages: readonly string[];
  /** What the reader chose last time (may be missing, or a language this file does not carry). */
  stored?: string | null;
  defaultLanguage?: string;
  /** `navigator.languages`, most preferred first. */
  browser: readonly string[];
}

export function pickShareLanguage(input: PickLanguageInput): string {
  const { languages } = input;
  const original = languages[0];
  if (typeof input.stored === "string") {
    const hit = findTag(languages, input.stored);
    if (hit) return hit;
  }
  if (typeof input.defaultLanguage === "string") {
    const hit = findTag(languages, input.defaultLanguage);
    if (hit) return hit;
  }
  for (const tag of input.browser) {
    const hit = matchBrowserLanguage(tag, languages);
    if (hit) return hit;
  }
  return original;
}
