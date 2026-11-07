import { renderTemplate } from "../../step-runner";
import type { ContentLanguage } from "../../../i18n";
import { inLanguage, languageVariables, type FragmentPair } from "../_shared/fragments";
import {
  instructionLanguageOf,
  isFollowInputLanguage,
  verbatimHeadingLanguage,
  type FollowAnchor
} from "../../../i18n";
import SourceRegistryTemplate from "./source-registry.md";
import AdaptiveDetailStructureZH from "./adaptive-detail-structure.zh.md";
import AdaptiveDetailStructureEN from "./adaptive-detail-structure.en.md";
import AiDecidedSectionsZH from "./ai-decided-sections.zh.md";
import AiDecidedSectionsEN from "./ai-decided-sections.en.md";
import AiFollowedSectionsZH from "./ai-followed-sections.zh.md";
import AiFollowedSectionsEN from "./ai-followed-sections.en.md";
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
import OmitEmptyDetailStructureZH from "./omit-empty-detail-structure.zh.md";
import OmitEmptyDetailStructureEN from "./omit-empty-detail-structure.en.md";
import IntroDetailStructureZH from "./intro-detail-structure.zh.md";
import IntroDetailStructureEN from "./intro-detail-structure.en.md";
import CustomRuleCalloutZH from "./custom-detail-rule-callout.zh.md";
import CustomRuleCalloutEN from "./custom-detail-rule-callout.en.md";
import VoiceBaselineZH from "./voice-baseline.zh.md";
import VoiceBaselineEN from "./voice-baseline.en.md";
import VoiceBaselineTaiwanZH from "./voice-baseline-taiwan.zh.md";
import VoiceBaselineTaiwanEN from "./voice-baseline-taiwan.en.md";
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
import GeneralTaskTopZH from "./general-task-top.zh.md";
import GeneralTaskTopEN from "./general-task-top.en.md";
import GeneralTaskFreshZH from "./general-task-fresh.zh.md";
import GeneralTaskFreshEN from "./general-task-fresh.en.md";
import ConflictRuleZH from "./conflict-rule.zh.md";
import ConflictRuleEN from "./conflict-rule.en.md";
import SynthesizeTopZH from "./synthesize-top.zh.md";
import SynthesizeTopEN from "./synthesize-top.en.md";
import SynthesizeFreshZH from "./synthesize-fresh.zh.md";
import SynthesizeFreshEN from "./synthesize-fresh.en.md";
import LabelDetailTopZH from "./label-detail-top.zh.md";
import LabelDetailTopEN from "./label-detail-top.en.md";
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
import HeadingRuleFollowZH from "./heading-rule-follow.zh.md";
import HeadingRuleFollowEN from "./heading-rule-follow.en.md";
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
/** "AI suggested" style: the AI decides the sections (first research), or keeps the note's own (later research). */
export const AI_DECIDED_SECTIONS: FragmentPair = pair(AiDecidedSectionsZH, AiDecidedSectionsEN);
export const AI_FOLLOWED_SECTIONS: FragmentPair = pair(AiFollowedSectionsZH, AiFollowedSectionsEN);
export const DECOMPOSE: FragmentPair = pair(DecomposeZH, DecomposeEN);
export const DEFAULT_TASK: FragmentPair = pair(DefaultTaskZH, DefaultTaskEN);
/** A template, not text: {@link detailStructure} fills its `{{headings}}` placeholder. */
const DETAIL_STRUCTURE_TEMPLATE: FragmentPair = { zh: DetailStructureZH, en: DetailStructureEN };
export const GENERAL_TASK: FragmentPair = pair(GeneralTaskZH, GeneralTaskEN);
/** Update-mode fragments (note style recipe): merge keeps GENERAL_TASK/SYNTHESIZE plus the conflict rule; top and fresh replace them. */
export const CONFLICT_RULE: FragmentPair = pair(ConflictRuleZH, ConflictRuleEN);
/** A template, not text: {@link voiceBaseline} fills its `{{terms}}` placeholder (the zh file only). */
const VOICE_BASELINE_TEMPLATE: FragmentPair = { zh: VoiceBaselineZH, en: VoiceBaselineEN };
const VOICE_BASELINE_TAIWAN: FragmentPair = pair(VoiceBaselineTaiwanZH, VoiceBaselineTaiwanEN);
/**
 * The writing baseline every voice shares (no filler transitions, no hype, concrete numbers), added after the voice text of a
 * topic prompt. The Taiwan wording sentence is added only when the output is Traditional Chinese: a Chinese prompt whose
 * output language is its own note language (Simplified Chinese is not).
 */
export function voiceBaseline(language: ContentLanguage): string {
  const template = inLanguage(VOICE_BASELINE_TEMPLATE, language);
  if (instructionLanguageOf(language) !== "zh") return renderTemplate(template, {});
  return renderTemplate(template, {
    terms: verbatimHeadingLanguage(language) === null ? inLanguage(VOICE_BASELINE_TAIWAN, language) : ""
  });
}
export const GENERAL_TASK_TOP: FragmentPair = pair(GeneralTaskTopZH, GeneralTaskTopEN);
export const GENERAL_TASK_FRESH: FragmentPair = pair(GeneralTaskFreshZH, GeneralTaskFreshEN);
export const SYNTHESIZE_TOP: FragmentPair = pair(SynthesizeTopZH, SynthesizeTopEN);
export const SYNTHESIZE_FRESH: FragmentPair = pair(SynthesizeFreshZH, SynthesizeFreshEN);
export const LABEL_DETAIL_TOP: FragmentPair = pair(LabelDetailTopZH, LabelDetailTopEN);
export const JSON_CONTRACT: FragmentPair = pair(JsonZH, JsonEN);
export const LABEL_DETAIL: FragmentPair = pair(LabelDetailZH, LabelDetailEN);
export const LABEL_FINDINGS: FragmentPair = pair(LabelFindingsZH, LabelFindingsEN);
/** A template, not text: {@link outputLanguage} fills its `{{language}}` and `{{headingRule}}` placeholders. */
const OUTPUT_LANGUAGE: FragmentPair = { zh: OutputLanguageZH, en: OutputLanguageEN };
const HEADING_RULE_UI: FragmentPair = pair(HeadingRuleUiZH, HeadingRuleUiEN);
const HEADING_RULE_FOLLOW: FragmentPair = { zh: HeadingRuleFollowZH, en: HeadingRuleFollowEN };
const HEADING_RULE_NOTE: FragmentPair = { zh: HeadingRuleNoteZH, en: HeadingRuleNoteEN };
/**
 * The output-language paragraph. The standard Detail headings follow the interface language when it is also the note
 * language; when they differ (Simplified Chinese), they stay in the note language and only the content follows the output.
 */
export function outputLanguage(language: ContentLanguage, anchor?: FollowAnchor, sectionsFixed = true): string {
  const note = verbatimHeadingLanguage(language);
  const names = languageVariables(language, { language: "plain" }, language, undefined, anchor);
  // Following the input has no language to contrast the fixed headings with: they are simply copied as listed.
  // "AI suggested" styles (decide, follow) do not use the six standard headings: no sentence about them.
  const headingRule = !sectionsFixed
    ? ""
    : isFollowInputLanguage(language)
      ? renderTemplate(inLanguage(HEADING_RULE_FOLLOW, language), names)
      : note
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
const OMIT_EMPTY_DETAIL_STRUCTURE_TEMPLATE: FragmentPair = {
  zh: OmitEmptyDetailStructureZH,
  en: OmitEmptyDetailStructureEN
};
/** A structure that omits an empty section (`DetailTemplate.omitEmpty`): the custom structure sentence, with "leave out a whole section" in place of the placeholder sentence. */
export function omitEmptyDetailStructure(
  language: ContentLanguage,
  values: { count: string; headings: string; rules: string }
): string {
  return renderTemplate(inLanguage(OMIT_EMPTY_DETAIL_STRUCTURE_TEMPLATE, language), values);
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

const INTRO_DETAIL_STRUCTURE_TEMPLATE: FragmentPair = { zh: IntroDetailStructureZH, en: IntroDetailStructureEN };
/** A note style file with a lead-in: a lead-in per `{{intro}}`, then the `{{count}}` headings in order; empty sections are omitted. */
export function introDetailStructure(
  language: ContentLanguage,
  values: { intro: string; count: string; headings: string; rules: string }
): string {
  return renderTemplate(inLanguage(INTRO_DETAIL_STRUCTURE_TEMPLATE, language), values);
}
const CUSTOM_DETAIL_CALLOUT_TEMPLATE: FragmentPair = { zh: CustomRuleCalloutZH, en: CustomRuleCalloutEN };
const CUSTOM_DETAIL_STOP: FragmentPair = { zh: "。", en: "." };
/** One section's callout instruction from a note style file. An empty body leaves just the placement sentence. */
export function customDetailCallout(
  language: ContentLanguage,
  values: { heading: string; type: string; fold: string; body: string }
): string {
  const text = renderTemplate(inLanguage(CUSTOM_DETAIL_CALLOUT_TEMPLATE, language), values);
  return values.body ? text : text.replace(/[：:]\s*$/, inLanguage(CUSTOM_DETAIL_STOP, language));
}
