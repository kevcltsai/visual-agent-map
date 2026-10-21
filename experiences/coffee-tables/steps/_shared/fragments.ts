import { renderTemplate } from "../../../../core/step-runner";
import observerFormatTemplate from "./observer-format.md";
import InsightUpdateFooterZH from "./insight-update-footer.zh.md";
import InsightUpdateFooterEN from "./insight-update-footer.en.md";
import ObserverTitlesZH from "./observer-titles.zh.md";
import ObserverTitlesEN from "./observer-titles.en.md";
import ObserverSourceZH from "./observer-source.zh.md";
import ObserverSourceEN from "./observer-source.en.md";
import ObserverRefreshOnlyZH from "./observer-refresh-only.zh.md";
import ObserverRefreshOnlyEN from "./observer-refresh-only.en.md";
import SegmentSummaryZH from "./segment-summary.zh.md";
import SegmentSummaryEN from "./segment-summary.en.md";
import MergeLevelDetailedZH from "./merge-level-detailed.zh.md";
import MergeLevelDetailedEN from "./merge-level-detailed.en.md";
import MergeLevelBalancedZH from "./merge-level-balanced.zh.md";
import MergeLevelBalancedEN from "./merge-level-balanced.en.md";
import MergeLevelCompactZH from "./merge-level-compact.zh.md";
import MergeLevelCompactEN from "./merge-level-compact.en.md";
import DetailLevelBriefZH from "./detail-level-brief.zh.md";
import DetailLevelBriefEN from "./detail-level-brief.en.md";
import DetailLevelStandardZH from "./detail-level-standard.zh.md";
import DetailLevelStandardEN from "./detail-level-standard.en.md";
import DetailLevelDetailedZH from "./detail-level-detailed.zh.md";
import DetailLevelDetailedEN from "./detail-level-detailed.en.md";
import GuidanceMergeDetailedZH from "./guidance-merge-detailed.zh.md";
import GuidanceMergeDetailedEN from "./guidance-merge-detailed.en.md";
import GuidanceMergeBalancedZH from "./guidance-merge-balanced.zh.md";
import GuidanceMergeBalancedEN from "./guidance-merge-balanced.en.md";
import GuidanceMergeCompactZH from "./guidance-merge-compact.zh.md";
import GuidanceMergeCompactEN from "./guidance-merge-compact.en.md";
import GuidanceDetailBriefZH from "./guidance-detail-brief.zh.md";
import GuidanceDetailBriefEN from "./guidance-detail-brief.en.md";
import GuidanceDetailStandardZH from "./guidance-detail-standard.zh.md";
import GuidanceDetailStandardEN from "./guidance-detail-standard.en.md";
import GuidanceDetailDetailedZH from "./guidance-detail-detailed.zh.md";
import GuidanceDetailDetailedEN from "./guidance-detail-detailed.en.md";
import ContextExistingInsights from "./context-existing-insights.md";
import ContextInvitedGuestsZH from "./context-invited-guests.zh.md";
import ContextInvitedGuestsEN from "./context-invited-guests.en.md";
import ContextReference from "./context-reference.md";
import TableLeadInNew from "./table-lead-in-new.md";
import TableLeadInContinue from "./table-lead-in-continue.md";
import BuiltinStyleZH from "./builtin-style.zh.md";
import BuiltinStyleEN from "./builtin-style.en.md";
import ContextIntervention from "./context-intervention.md";
import ContextFollowUp from "./context-follow-up.md";
import ContextTableAnswer from "./context-table-answer.md";
import ContextAnswerPending from "./context-answer-pending.md";
import ContextFollowUpGuests from "./context-follow-up-guests.md";
import ContextReferenceFile from "./context-reference-file.md";
import CategoryExperts from "./category-experts.md";
import CategoryCrossDomain from "./category-cross-domain.md";
import CategoryGeneralist from "./category-generalist.md";
import CategoryAffected from "./category-affected.md";
import GuestRoleExpertsZH from "./guest-role-experts.zh.md";
import GuestRoleExpertsEN from "./guest-role-experts.en.md";
import GuestRoleCrossDomainZH from "./guest-role-cross-domain.zh.md";
import GuestRoleCrossDomainEN from "./guest-role-cross-domain.en.md";
import GuestRoleGeneralistZH from "./guest-role-generalist.zh.md";
import GuestRoleGeneralistEN from "./guest-role-generalist.en.md";
import GuestRoleAffectedZH from "./guest-role-affected.zh.md";
import GuestRoleAffectedEN from "./guest-role-affected.en.md";
import LabelConversationStyle from "./label-conversation-style.md";
import LabelConversationStyleObserverZH from "./label-conversation-style-observer.zh.md";
import LabelConversationStyleObserverEN from "./label-conversation-style-observer.en.md";
import LabelBackground from "./label-background.md";
import LabelPrior from "./label-prior.md";
import LabelTableDraft from "./label-table-draft.md";
import LabelAnswerDraft from "./label-answer-draft.md";
import LabelDialogueDraft from "./label-dialogue-draft.md";
import LabelNotesDraft from "./label-notes-draft.md";
import GuidancePreferencesZH from "./guidance-preferences.zh.md";
import GuidancePreferencesEN from "./guidance-preferences.en.md";
import GuidancePreserveFallbackZH from "./guidance-preserve-fallback.zh.md";
import GuidancePreserveFallbackEN from "./guidance-preserve-fallback.en.md";
import GuidancePreserveDisagreementsZH from "./guidance-preserve-disagreements.zh.md";
import GuidancePreserveDisagreementsEN from "./guidance-preserve-disagreements.en.md";
import GuidancePreserveConditionsZH from "./guidance-preserve-conditions.zh.md";
import GuidancePreserveConditionsEN from "./guidance-preserve-conditions.en.md";
import GuidancePreserveCounterexamplesZH from "./guidance-preserve-counterexamples.zh.md";
import GuidancePreserveCounterexamplesEN from "./guidance-preserve-counterexamples.en.md";
import GuidancePreserveQuestionsZH from "./guidance-preserve-questions.zh.md";
import GuidancePreserveQuestionsEN from "./guidance-preserve-questions.en.md";
import GuidancePreserveSourcesZH from "./guidance-preserve-sources.zh.md";
import GuidancePreserveSourcesEN from "./guidance-preserve-sources.en.md";
import PreviewObserverNotesZH from "./preview-observer-notes.zh.md";
import PreviewObserverNotesEN from "./preview-observer-notes.en.md";

/**
 * Prompt text shared by more than one Coffee Tables step. Each fragment is a Markdown file next to this module; a
 * trailing file newline is removed so the text equals the string it replaced.
 */
const text = (template: string): string => renderTemplate(template, {});
type Pair = { readonly zh: string; readonly en: string };
const pair = (zh: string, en: string): Pair => ({ zh: text(zh), en: text(en) });

/** A template, not text: `observerFormat` fills its placeholders with `renderTemplate`. */
export const OBSERVER_FORMAT_TEMPLATE: string = observerFormatTemplate;
export const INSIGHT_UPDATE_FOOTER: Pair = pair(InsightUpdateFooterZH, InsightUpdateFooterEN);
export const OBSERVER_TITLES: Pair = pair(ObserverTitlesZH, ObserverTitlesEN);
export const OBSERVER_SOURCE: Pair = pair(ObserverSourceZH, ObserverSourceEN);
export const OBSERVER_REFRESH_ONLY: Pair = pair(ObserverRefreshOnlyZH, ObserverRefreshOnlyEN);
export const SEGMENT_SUMMARY: Pair = pair(SegmentSummaryZH, SegmentSummaryEN);

export const MERGE_LEVEL = {
  zh: {
    detailed: text(MergeLevelDetailedZH),
    balanced: text(MergeLevelBalancedZH),
    compact: text(MergeLevelCompactZH)
  },
  en: {
    detailed: text(MergeLevelDetailedEN),
    balanced: text(MergeLevelBalancedEN),
    compact: text(MergeLevelCompactEN)
  }
} as const;

export const DETAIL_LEVEL = {
  zh: {
    brief: text(DetailLevelBriefZH),
    standard: text(DetailLevelStandardZH),
    detailed: text(DetailLevelDetailedZH)
  },
  en: {
    brief: text(DetailLevelBriefEN),
    standard: text(DetailLevelStandardEN),
    detailed: text(DetailLevelDetailedEN)
  }
} as const;

/** One-line merge and detail sentences of the observer preferences block (`observerGuidance`). */
export const GUIDANCE_MERGE_LEVEL = {
  zh: {
    detailed: text(GuidanceMergeDetailedZH),
    balanced: text(GuidanceMergeBalancedZH),
    compact: text(GuidanceMergeCompactZH)
  },
  en: {
    detailed: text(GuidanceMergeDetailedEN),
    balanced: text(GuidanceMergeBalancedEN),
    compact: text(GuidanceMergeCompactEN)
  }
} as const;

export const GUIDANCE_DETAIL_LEVEL = {
  zh: {
    brief: text(GuidanceDetailBriefZH),
    standard: text(GuidanceDetailStandardZH),
    detailed: text(GuidanceDetailDetailedZH)
  },
  en: {
    brief: text(GuidanceDetailBriefEN),
    standard: text(GuidanceDetailStandardEN),
    detailed: text(GuidanceDetailDetailedEN)
  }
} as const;

/**
 * Labels that introduce a block of saved context inside the prompt (`prompt-parts.ts`). The existing-insights and
 * reference labels are Traditional Chinese in every language, as they were when inline.
 */
export const CONTEXT_EXISTING_INSIGHTS: string = text(ContextExistingInsights);
export const CONTEXT_INVITED_GUESTS: Pair = pair(ContextInvitedGuestsZH, ContextInvitedGuestsEN);
export const CONTEXT_REFERENCE: string = text(ContextReference);

/** The table step's opening instruction and its continuation lead-in (Traditional Chinese in every language). */
export const TABLE_LEAD_IN_NEW: string = text(TableLeadInNew);
export const TABLE_LEAD_IN_CONTINUE: string = text(TableLeadInContinue);

/**
 * The built-in conversation style, as templates. `{{language}}` takes the registry's `usage` name of the language the
 * table speaks; the rest is the text the user sees and can edit in the style UI.
 */
export const BUILTIN_STYLE_TEMPLATE = { zh: BuiltinStyleZH, en: BuiltinStyleEN } as const;

/** Context labels in the saved-conversation block of the prompt (Traditional Chinese in every language, as when inline). */
export const CONTEXT_INTERVENTION: string = text(ContextIntervention);
export const CONTEXT_FOLLOW_UP: string = text(ContextFollowUp);
export const CONTEXT_TABLE_ANSWER: string = text(ContextTableAnswer);
export const CONTEXT_ANSWER_PENDING: string = text(ContextAnswerPending);
export const CONTEXT_FOLLOW_UP_GUESTS: string = text(ContextFollowUpGuests);
/** A template: `{{index}}` and `{{name}}` of one reference file. */
export const CONTEXT_REFERENCE_FILE: string = ContextReferenceFile;
/** Guest category labels listed in the prompt (Traditional Chinese in every language). */
export const CATEGORY_LABEL = {
  experts: text(CategoryExperts),
  "cross-domain": text(CategoryCrossDomain),
  generalist: text(CategoryGeneralist),
  affected: text(CategoryAffected)
} as const;
/** The same categories as listed under "invited guests", spelled for the instruction language. */
export const GUEST_ROLE = {
  zh: {
    experts: text(GuestRoleExpertsZH),
    "cross-domain": text(GuestRoleCrossDomainZH),
    generalist: text(GuestRoleGeneralistZH),
    affected: text(GuestRoleAffectedZH)
  },
  en: {
    experts: text(GuestRoleExpertsEN),
    "cross-domain": text(GuestRoleCrossDomainEN),
    generalist: text(GuestRoleGeneralistEN),
    affected: text(GuestRoleAffectedEN)
  }
} as const;

/** Section labels that precede saved text in the table, question and observer-only prompts (Traditional Chinese in every language). */
export const LABEL_CONVERSATION_STYLE: string = text(LabelConversationStyle);
export const LABEL_CONVERSATION_STYLE_OBSERVER: Pair = pair(
  LabelConversationStyleObserverZH,
  LabelConversationStyleObserverEN
);
export const LABEL_BACKGROUND: string = text(LabelBackground);
export const LABEL_PRIOR: string = text(LabelPrior);
export const LABEL_TABLE_DRAFT: string = text(LabelTableDraft);
export const LABEL_ANSWER_DRAFT: string = text(LabelAnswerDraft);
export const LABEL_DIALOGUE_DRAFT: string = text(LabelDialogueDraft);
export const LABEL_NOTES_DRAFT: string = text(LabelNotesDraft);

/** The observer preferences block: a template (`{{observer}}`, `{{merge}}`, `{{detail}}`, `{{preserved}}`) per instruction language. */
export const GUIDANCE_PREFERENCES_TEMPLATE = { zh: GuidancePreferencesZH, en: GuidancePreferencesEN } as const;
export const GUIDANCE_PRESERVE_FALLBACK: Pair = pair(GuidancePreserveFallbackZH, GuidancePreserveFallbackEN);
export const GUIDANCE_PRESERVE = {
  zh: {
    disagreements: text(GuidancePreserveDisagreementsZH),
    conditions: text(GuidancePreserveConditionsZH),
    counterexamples: text(GuidancePreserveCounterexamplesZH),
    questions: text(GuidancePreserveQuestionsZH),
    sources: text(GuidancePreserveSourcesZH)
  },
  en: {
    disagreements: text(GuidancePreserveDisagreementsEN),
    conditions: text(GuidancePreserveConditionsEN),
    counterexamples: text(GuidancePreserveCounterexamplesEN),
    questions: text(GuidancePreserveQuestionsEN),
    sources: text(GuidancePreserveSourcesEN)
  }
} as const;

/** The display-only opening preview's observer paragraph: a template (`{{guidance}}`, `{{titles}}`) per instruction language. */
export const PREVIEW_OBSERVER_NOTES_TEMPLATE = { zh: PreviewObserverNotesZH, en: PreviewObserverNotesEN } as const;
