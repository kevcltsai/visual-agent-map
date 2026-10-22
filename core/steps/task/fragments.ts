import { renderTemplate } from "../../step-runner";
import type { ContentLanguage } from "../../../i18n";
import { inLanguage, languageVariables, type FragmentPair } from "../_shared/fragments";
import { verbatimHeadingLanguage } from "../../../i18n";
import SourceRegistryTemplate from "./source-registry.md";
import AdaptiveDetailStructureZH from "./adaptive-detail-structure.zh.md";
import AdaptiveDetailStructureEN from "./adaptive-detail-structure.en.md";
import CustomDetailStructureZH from "./custom-detail-structure.zh.md";
import CustomDetailStructureEN from "./custom-detail-structure.en.md";
import CustomRuleLogZH from "./custom-detail-rule-log.zh.md";
import CustomRuleLogEN from "./custom-detail-rule-log.en.md";
import CustomRuleDescriptionZH from "./custom-detail-rule-description.zh.md";
import CustomRuleDescriptionEN from "./custom-detail-rule-description.en.md";
import CustomRuleExactZH from "./custom-detail-rule-exact.zh.md";
import CustomRuleExactEN from "./custom-detail-rule-exact.en.md";
import CustomRuleMinZH from "./custom-detail-rule-min.zh.md";
import CustomRuleMinEN from "./custom-detail-rule-min.en.md";
import TextbookDetailStructureZH from "./textbook-detail-structure.zh.md";
import TextbookDetailStructureEN from "./textbook-detail-structure.en.md";
import RepairCountsZH from "./repair-counts.zh.md";
import RepairCountsEN from "./repair-counts.en.md";
import DecomposeZH from "./decompose.zh.md";
import DecomposeEN from "./decompose.en.md";
import DefaultTaskZH from "./default-task.zh.md";
import DefaultTaskEN from "./default-task.en.md";
import DetailStructureZH from "./detail-structure.zh.md";
import DetailStructureEN from "./detail-structure.en.md";
import GeneralTaskZH from "./general-task.zh.md";
import GeneralTaskEN from "./general-task.en.md";
import JsonZH from "./json.zh.md";
import JsonEN from "./json.en.md";
import LabelDetailZH from "./label-detail.zh.md";
import LabelDetailEN from "./label-detail.en.md";
import LabelFindingsZH from "./label-findings.zh.md";
import LabelFindingsEN from "./label-findings.en.md";
import OutputLanguageZH from "./output-language.zh.md";
import OutputLanguageEN from "./output-language.en.md";
import HeadingRuleUiZH from "./heading-rule-ui.zh.md";
import HeadingRuleUiEN from "./heading-rule-ui.en.md";
import HeadingRuleNoteZH from "./heading-rule-note.zh.md";
import HeadingRuleNoteEN from "./heading-rule-note.en.md";
import MergeZH from "./merge.zh.md";
import MergeEN from "./merge.en.md";
import MergeRepairZH from "./merge-repair.zh.md";
import MergeRepairEN from "./merge-repair.en.md";
import SynthesizeZH from "./synthesize.zh.md";
import SynthesizeEN from "./synthesize.en.md";
import VisualAutoZH from "./visual-auto.zh.md";
import VisualAutoEN from "./visual-auto.en.md";
import VisualEmbedZH from "./visual-embed.zh.md";
import VisualEmbedEN from "./visual-embed.en.md";
import VisualNoneZH from "./visual-none.zh.md";
import VisualNoneEN from "./visual-none.en.md";
import VisualOnZH from "./visual-on.zh.md";
import VisualOnEN from "./visual-on.en.md";
import VisualPreserveZH from "./visual-preserve.zh.md";
import VisualPreserveEN from "./visual-preserve.en.md";

/** Prompt text of the general task step and its visual guidance; Markdown files next to this module. */
const text = (template: string): string => renderTemplate(template, {});
const pair = (zh: string, en: string): FragmentPair => ({ zh: text(zh), en: text(en) });

export const ADAPTIVE_DETAIL_STRUCTURE: FragmentPair = pair(AdaptiveDetailStructureZH, AdaptiveDetailStructureEN);
export const DECOMPOSE: FragmentPair = pair(DecomposeZH, DecomposeEN);
export const DEFAULT_TASK: FragmentPair = pair(DefaultTaskZH, DefaultTaskEN);
/** A template, not text: {@link detailStructure} fills its `{{headings}}` placeholder. */
const DETAIL_STRUCTURE_TEMPLATE: FragmentPair = { zh: DetailStructureZH, en: DetailStructureEN };
export const GENERAL_TASK: FragmentPair = pair(GeneralTaskZH, GeneralTaskEN);
export const JSON_CONTRACT: FragmentPair = pair(JsonZH, JsonEN);
export const LABEL_DETAIL: FragmentPair = pair(LabelDetailZH, LabelDetailEN);
export const LABEL_FINDINGS: FragmentPair = pair(LabelFindingsZH, LabelFindingsEN);
/** A template, not text: {@link outputLanguage} fills its `{{language}}` and `{{headingRule}}` placeholders. */
const OUTPUT_LANGUAGE: FragmentPair = { zh: OutputLanguageZH, en: OutputLanguageEN };
const HEADING_RULE_UI: FragmentPair = pair(HeadingRuleUiZH, HeadingRuleUiEN);
const HEADING_RULE_NOTE: FragmentPair = { zh: HeadingRuleNoteZH, en: HeadingRuleNoteEN };
/**
 * The output-language paragraph. The standard Detail headings follow the interface language when it is also the note
 * language; when they differ (Simplified Chinese), they stay in the note language and only the content follows the output.
 */
export function outputLanguage(language: ContentLanguage): string {
  const note = verbatimHeadingLanguage(language);
  const names = languageVariables(language, { language: "plain" });
  const headingRule = note
    ? renderTemplate(inLanguage(HEADING_RULE_NOTE, language), {
        ...names,
        ...languageVariables(note, { note: "plain" }, language)
      })
    : inLanguage(HEADING_RULE_UI, language);
  return renderTemplate(inLanguage(OUTPUT_LANGUAGE, language), { language: names.language, headingRule });
}
/** Merge mode: organize only what the sources say (no synthesis of agreements, tradeoffs or open questions). */
export const MERGE: FragmentPair = pair(MergeZH, MergeEN);
export const SYNTHESIZE: FragmentPair = pair(SynthesizeZH, SynthesizeEN);
export const VISUAL_AUTO: FragmentPair = pair(VisualAutoZH, VisualAutoEN);
export const VISUAL_EMBED: FragmentPair = pair(VisualEmbedZH, VisualEmbedEN);
export const VISUAL_NONE: FragmentPair = pair(VisualNoneZH, VisualNoneEN);
export const VISUAL_ON: FragmentPair = pair(VisualOnZH, VisualOnEN);
export const VISUAL_PRESERVE: FragmentPair = pair(VisualPreserveZH, VisualPreserveEN);

/** The six standard Detail headings are interface text, so the caller builds them; this fills the structure sentence. */
export function detailStructure(language: ContentLanguage, headings: string): string {
  return renderTemplate(inLanguage(DETAIL_STRUCTURE_TEMPLATE, language), { headings });
}
const CUSTOM_DETAIL_STRUCTURE_TEMPLATE: FragmentPair = { zh: CustomDetailStructureZH, en: CustomDetailStructureEN };
/** A custom template's structure sentence: `{{count}}` headings, the heading list, then any per-section rules. */
export function customDetailStructure(
  language: ContentLanguage,
  values: { count: string; headings: string; rules: string }
): string {
  return renderTemplate(inLanguage(CUSTOM_DETAIL_STRUCTURE_TEMPLATE, language), values);
}
const CUSTOM_DETAIL_RULES: Record<"log" | "description" | "exact" | "min", FragmentPair> = {
  log: { zh: CustomRuleLogZH, en: CustomRuleLogEN },
  description: { zh: CustomRuleDescriptionZH, en: CustomRuleDescriptionEN },
  exact: { zh: CustomRuleExactZH, en: CustomRuleExactEN },
  min: { zh: CustomRuleMinZH, en: CustomRuleMinEN }
};
export function customDetailRule(
  kind: "log" | "description" | "exact" | "min",
  language: ContentLanguage,
  values: Record<string, string>
): string {
  return renderTemplate(inLanguage(CUSTOM_DETAIL_RULES[kind], language), values);
}
const REPAIR_COUNTS_TEMPLATE: FragmentPair = { zh: RepairCountsZH, en: RepairCountsEN };
/** The single follow-up request that asks the model to fix sections whose item counts missed the template. */
export function repairCounts(language: ContentLanguage, issues: string): string {
  return renderTemplate(inLanguage(REPAIR_COUNTS_TEMPLATE, language), { issues });
}
const MERGE_REPAIR_TEMPLATE: FragmentPair = { zh: MergeRepairZH, en: MergeRepairEN };
/** The single follow-up request of an AI merge whose result lost or invented numbers, links or embeds. */
export function mergeRepair(language: ContentLanguage, missing: string, added: string, title: string): string {
  return renderTemplate(inLanguage(MERGE_REPAIR_TEMPLATE, language), { missing, added, title });
}
export function sourceRegistry(catalog: string): string {
  return renderTemplate(SourceRegistryTemplate, { catalog });
}

const TEXTBOOK_DETAIL_STRUCTURE_TEMPLATE: FragmentPair = {
  zh: TextbookDetailStructureZH,
  en: TextbookDetailStructureEN
};
/** The Textbook template's structure text: lead-in, `{{headings}}` in order, omit-empty override, self-check before `{{log}}`. */
export function textbookDetailStructure(language: ContentLanguage, values: { headings: string; log: string }): string {
  return renderTemplate(inLanguage(TEXTBOOK_DETAIL_STRUCTURE_TEMPLATE, language), values);
}
