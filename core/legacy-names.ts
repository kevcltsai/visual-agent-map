// AIM was previously named MindSearch. Notes and exchange logs saved before the rename can still contain the old
// Markdown markers and sentinel values, so they are upgraded here when read. This is the only place the old name may
// appear in code.

export const LEGACY_MARKER_PREFIX = "mindsearch-";
export const LEGACY_VALUES: ReadonlyArray<readonly [string, string]> = [
  ["__MINDSEARCH_NO_QUESTION__", "__AIM_NO_QUESTION__"],
  ["__mindsearch_unknown__", "__aim_unknown__"]
];
const LEGACY_MARKER = new RegExp(`<!--(\\s*)${LEGACY_MARKER_PREFIX}`, "g");

/** Rewrites legacy AIM markers and sentinel values inside saved text. */
export function upgradeLegacyAimText(text: string): string {
  let upgraded = text.replace(LEGACY_MARKER, "<!--$1aim-");
  for (const [legacy, current] of LEGACY_VALUES) upgraded = upgraded.split(legacy).join(current);
  return upgraded;
}
