import type { TranslationKey } from "../i18n";

/** The voices the settings card and the style editor offer as chips (the retired ones are not listed), each with its sample sentence. */
export const CARD_VOICES = [
  { id: "academic", name: "ui.preset_name_academic", sample: "ui.note_style_sample_academic" },
  { id: "plain", name: "ui.preset_name_plain", sample: "ui.note_style_sample_plain" },
  { id: "magazine", name: "ui.preset_name_magazine", sample: "ui.note_style_sample_magazine" },
  { id: "picture-book", name: "ui.preset_name_picture_book", sample: "ui.note_style_sample_picture_book" }
] as const satisfies readonly { id: string; name: TranslationKey; sample: TranslationKey }[];
