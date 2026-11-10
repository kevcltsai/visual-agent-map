// AIM was previously named MindSearch. Vaults saved before the rename can still contain the old
// map keys, Markdown markers and sentinel values, so they are upgraded here when read. This is the
// only place the old name may appear in code; new data must always be written with AIM names.

export const LEGACY_KEY_PREFIX = "mindSearch";
export const LEGACY_MARKER_PREFIX = "mindsearch-";
// Obsidian command IDs are user-facing contracts (hotkeys, URIs), so the AIM create command keeps its original ID.
export const AIM_CREATE_MAP_COMMAND_ID = "create-mindsearch-map";
export const LEGACY_VALUES: ReadonlyArray<readonly [string, string]> = [
  ["__MINDSEARCH_NO_QUESTION__", "__AIM_NO_QUESTION__"],
  ["__mindsearch_unknown__", "__aim_unknown__"]
];
const LEGACY_MARKER = new RegExp(`<!--(\\s*)${LEGACY_MARKER_PREFIX}`, "g");

const upgradeKey = (key: string): string =>
  key.startsWith(LEGACY_KEY_PREFIX) ? `aim${key.slice(LEGACY_KEY_PREFIX.length)}` : key;

/** Rewrites legacy AIM markers and sentinel values inside saved text. */
export function upgradeLegacyAimText(text: string): string {
  let upgraded = text.replace(LEGACY_MARKER, "<!--$1aim-");
  for (const [legacy, current] of LEGACY_VALUES) upgraded = upgraded.split(legacy).join(current);
  return upgraded;
}

/** Recursively renames legacy AIM keys and values in parsed map JSON. Current keys win over legacy ones. */
export function upgradeLegacyAimData<T>(value: T): T {
  if (typeof value === "string") return upgradeLegacyAimText(value) as T;
  if (Array.isArray(value)) return (value as unknown[]).map(item => upgradeLegacyAimData(item)) as T;
  if (!value || typeof value !== "object") return value;
  const upgraded: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const target = upgradeKey(key);
    if (target !== key && Object.prototype.hasOwnProperty.call(value, target)) continue;
    upgraded[target] = upgradeLegacyAimData(item);
  }
  return upgraded as T;
}
