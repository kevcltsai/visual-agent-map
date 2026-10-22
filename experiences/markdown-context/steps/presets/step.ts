import { renderTemplate, type StepDefinition } from "../../../../core/step-runner";
import type { ContentLanguage } from "../../../../i18n";
import { inLanguage } from "../../../../core/steps/_shared/fragments";
import condenseEn from "./condense.en.md";
import condenseZh from "./condense.zh.md";
import translateEn from "./translate.en.md";
import translateZh from "./translate.zh.md";
import searchImagesEn from "./search-images.en.md";
import searchImagesZh from "./search-images.zh.md";

export interface PresetInput {
  language: ContentLanguage;
  /** Language name to translate into; only the translate presets take it. */
  target?: string;
}

/**
 * A preset button's instruction. It is shown in the instruction box and then becomes the user request inside the
 * plan step, so it is a step of its own (rendered, never sent by itself) rather than a UI string.
 */
function presetStep(id: string, zh: string, en: string, usesTarget: boolean): StepDefinition<PresetInput, string> {
  return {
    id,
    version: 1,
    render: ({ language, target = "" }) =>
      renderTemplate(inLanguage({ zh, en }, language), usesTarget ? { target } : {}),
    parse: raw => raw
  };
}

export const condensePresetStep = presetStep("markdown.preset.condense", condenseZh, condenseEn, false);
export const translatePresetStep = presetStep("markdown.preset.translate", translateZh, translateEn, true);
export const searchImagesPresetStep = presetStep(
  "markdown.preset.search-images",
  searchImagesZh,
  searchImagesEn,
  false
);
