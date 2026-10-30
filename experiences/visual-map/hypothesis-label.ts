import type { TranslationKey } from "../../i18n";
import type { HypothesisStrength } from "../../note-values";

export const STRENGTH_LABEL: Record<HypothesisStrength, TranslationKey> = {
  weak: "ui.hypothesis_weak",
  medium: "ui.hypothesis_medium",
  strong: "ui.hypothesis_strong"
};

/** The quiet "Hypothesis · Weak" tag on a hypothesis card; `text` is already translated (it also names the card for assistive tech). */
export function renderHypothesisTag(parent: HTMLElement, strength: HypothesisStrength, text: string): HTMLSpanElement {
  const tag = parent.createSpan({ cls: "vam-hypothesis-tag", text });
  tag.dataset.strength = strength;
  return tag;
}
