import type { TranslationKey } from "../../i18n";
import type { HypothesisLeaning, HypothesisStrength } from "../../note-values";

export const STRENGTH_LABEL: Record<HypothesisStrength, TranslationKey> = {
  none: "ui.hypothesis_none",
  weak: "ui.hypothesis_weak",
  medium: "ui.hypothesis_medium",
  strong: "ui.hypothesis_strong"
};

export const LEANING_LABEL: Record<HypothesisLeaning, TranslationKey> = {
  supported: "ui.hypothesis_supported",
  undecided: "ui.hypothesis_undecided",
  refuted: "ui.hypothesis_refuted"
};

/** "Hypothesis · Undecided" when undecided and no strength, otherwise "Hypothesis · Leaning · Strength"; `translate` is the UI translator. */
export function hypothesisTagText(
  leaning: HypothesisLeaning,
  strength: HypothesisStrength,
  translate: (key: TranslationKey, ...values: unknown[]) => string
): string {
  return leaning === "undecided" && strength === "none"
    ? translate("ui.hypothesis_tag_undecided")
    : translate("ui.hypothesis_tag_0_1", translate(LEANING_LABEL[leaning]), translate(STRENGTH_LABEL[strength]));
}

/** The quiet "Hypothesis · Supported · Weak" tag on a hypothesis card; `text` is already translated (it also names the card for assistive tech). */
export function renderHypothesisTag(
  parent: HTMLElement,
  leaning: HypothesisLeaning,
  strength: HypothesisStrength,
  text: string
): HTMLSpanElement {
  const tag = parent.createSpan({ cls: "vam-hypothesis-tag", text });
  tag.dataset.strength = strength;
  tag.dataset.leaning = leaning;
  return tag;
}
