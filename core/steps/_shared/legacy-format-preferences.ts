import PreferencesZH from "./format-preferences.zh.md";
import PreferencesEN from "./format-preferences.en.md";
import PlacedZH from "./format-preferences-placed.zh.md";
import PlacedEN from "./format-preferences-placed.en.md";

/**
 * The old format-preference fragments, kept only for the one-time note style upgrade (ai/note-style-upgrade.ts). No prompt
 * path reads them; the fragment files stay next to the other shared fragments.
 */
export const LEGACY_FORMAT_PREFERENCES = {
  zh: PreferencesZH,
  en: PreferencesEN,
  placedZh: PlacedZH,
  placedEn: PlacedEN
};
