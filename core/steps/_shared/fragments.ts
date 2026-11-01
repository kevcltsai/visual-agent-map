import { renderTemplate } from "../../step-runner";
import {
  instructionLanguageOf,
  translate,
  isFollowInputLanguage,
  languagePromptName,
  verbatimHeadingLanguage,
  type FollowAnchor,
  type InstructionLanguage,
  type PromptNameForm,
  type ContentLanguage
} from "../../../i18n";
import LabelAncestorsZH from "./label-ancestors.zh.md";
import LabelAncestorsEN from "./label-ancestors.en.md";
import LabelSummaryDirectionZH from "./label-summary-direction.zh.md";
import LabelSummaryDirectionEN from "./label-summary-direction.en.md";
import LabelUserTextZH from "./label-user-text.zh.md";
import LabelUserTextEN from "./label-user-text.en.md";
import LabelRulesZH from "./label-rules.zh.md";
import LabelRulesEN from "./label-rules.en.md";
import LabelSourcesZH from "./label-sources.zh.md";
import LabelSourcesEN from "./label-sources.en.md";
import LabelSummaryZH from "./label-summary.zh.md";
import LabelSummaryEN from "./label-summary.en.md";
import LabelTaskZH from "./label-task.zh.md";
import LabelTaskEN from "./label-task.en.md";
import LabelTopicZH from "./label-topic.zh.md";
import LabelTopicEN from "./label-topic.en.md";
import ClaudeStructuredOutputZH from "./claude-structured-output.zh.md";
import ClaudeStructuredOutputEN from "./claude-structured-output.en.md";
import LocalFirstZH from "./local-first.zh.md";
import LocalFirstEN from "./local-first.en.md";
import NoneZH from "./none.zh.md";
import NoneEN from "./none.en.md";
import ObsidianFormatZH from "./obsidian-format.zh.md";
import ObsidianFormatEN from "./obsidian-format.en.md";
import ReferenceCitationsZH from "./reference-citations.zh.md";
import ReferenceCitationsEN from "./reference-citations.en.md";
import RoleZH from "./role.zh.md";
import RoleEN from "./role.en.md";
import SourceSafetyZH from "./source-safety.zh.md";
import SourceSafetyEN from "./source-safety.en.md";
import RoleQuickZH from "./role-quick.zh.md";
import RoleQuickEN from "./role-quick.en.md";
import SourceSafetyQuickZH from "./source-safety-quick.zh.md";
import SourceSafetyQuickEN from "./source-safety-quick.en.md";
import QuickKnowledgeZH from "./quick-knowledge.zh.md";
import QuickKnowledgeEN from "./quick-knowledge.en.md";
import HeadingsVerbatimZH from "./headings-verbatim.zh.md";
import HeadingsVerbatimEN from "./headings-verbatim.en.md";
import HeadingsVerbatimFollowZH from "./headings-verbatim-follow.zh.md";
import HeadingsVerbatimFollowEN from "./headings-verbatim-follow.en.md";
import HeadingsVerbatimCustomZH from "./headings-verbatim-custom.zh.md";
import HeadingsVerbatimCustomEN from "./headings-verbatim-custom.en.md";
import FormatPreferencesZH from "./format-preferences.zh.md";
import FormatPreferencesEN from "./format-preferences.en.md";
import FormatPreferencesPlacedZH from "./format-preferences-placed.zh.md";
import FormatPreferencesPlacedEN from "./format-preferences-placed.en.md";
import ToneZH from "./tone.zh.md";
import ToneEN from "./tone.en.md";

/**
 * Prompt text shared by the general task step and the AIM prompt builder. Each fragment is a Markdown file next to this
 * module; the file's own trailing newline is removed so the text equals the string it replaced.
 */
const text = (template: string): string => renderTemplate(template, {});
export interface FragmentPair {
  readonly zh: string;
  readonly en: string;
}
const pair = (zh: string, en: string): FragmentPair => ({ zh: text(zh), en: text(en) });

/** The fragment in the language's instruction language (registry `instruction`): `en` or `zh`. */
export function inLanguage(fragment: FragmentPair, language: ContentLanguage): string {
  return fragment[instructionLanguageOf(language)];
}

/**
 * A fragment that names the output language. `names` maps each `{{placeholder}}` to the registry name form it takes; the
 * name is spelled for the fragment's instruction language unless `spelledIn` says the file is written in the other one
 * (a few `.zh.md` files carry English sentences).
 */
export function inLanguageNaming(
  fragment: FragmentPair,
  language: ContentLanguage,
  names: Readonly<Record<string, PromptNameForm>>,
  spelledIn?: InstructionLanguage,
  anchor?: FollowAnchor
): string {
  return renderTemplate(
    fragment[instructionLanguageOf(language)],
    languageVariables(language, names, undefined, spelledIn, anchor)
  );
}

/**
 * Template variables naming `language`: each placeholder maps to a registry name form, spelled for `spelledIn` or, by
 * default, for the instruction language of `instructionOf` (the language the prompt is written for). `anchor` is the
 * user's own text that a follow-the-input language is quoted from; other languages ignore it.
 */
export function languageVariables(
  language: ContentLanguage,
  names: Readonly<Record<string, PromptNameForm>>,
  instructionOf: ContentLanguage = language,
  spelledIn?: InstructionLanguage,
  anchor?: FollowAnchor
): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [placeholder, form] of Object.entries(names))
    variables[placeholder] = languagePromptName(
      language,
      spelledIn ?? instructionLanguageOf(instructionOf),
      form,
      anchor
    );
  return variables;
}

/** Claude only: return through the StructuredOutput tool at once, without a text draft first. Codex prompts never include it. */
export const CLAUDE_STRUCTURED_OUTPUT: FragmentPair = pair(ClaudeStructuredOutputZH, ClaudeStructuredOutputEN);
/** A response-contract block; Claude's carries the StructuredOutput instruction after it, Codex's is the contract unchanged. */
export function withProviderOutput(contract: string, provider: "claude" | "codex", language: ContentLanguage): string {
  return provider === "claude" ? `${contract}\n${inLanguage(CLAUDE_STRUCTURED_OUTPUT, language)}` : contract;
}

export const LABEL_ANCESTORS: FragmentPair = pair(LabelAncestorsZH, LabelAncestorsEN);
export const LABEL_RULES: FragmentPair = pair(LabelRulesZH, LabelRulesEN);
export const LABEL_SOURCES: FragmentPair = pair(LabelSourcesZH, LabelSourcesEN);
export const LABEL_SUMMARY: FragmentPair = pair(LabelSummaryZH, LabelSummaryEN);
export const LABEL_SUMMARY_DIRECTION: FragmentPair = pair(LabelSummaryDirectionZH, LabelSummaryDirectionEN);
export const LABEL_USER_TEXT: FragmentPair = pair(LabelUserTextZH, LabelUserTextEN);
export const LABEL_TASK: FragmentPair = pair(LabelTaskZH, LabelTaskEN);
export const LABEL_TOPIC: FragmentPair = pair(LabelTopicZH, LabelTopicEN);
export const LOCAL_FIRST: FragmentPair = pair(LocalFirstZH, LocalFirstEN);
export const NONE: FragmentPair = pair(NoneZH, NoneEN);
/** How a reader-facing detail uses Obsidian syntax (callouts, tables, mermaid, task lists, highlights). */
export const OBSIDIAN_FORMAT: FragmentPair = pair(ObsidianFormatZH, ObsidianFormatEN);
export const REFERENCE_CITATIONS: FragmentPair = pair(ReferenceCitationsZH, ReferenceCitationsEN);
export const ROLE: FragmentPair = pair(RoleZH, RoleEN);
/** The Quick AI mode's role text: same as ROLE except the sources half, which allows the model's own knowledge and no web search. */
export const ROLE_QUICK: FragmentPair = pair(RoleQuickZH, RoleQuickEN);
export const SOURCE_SAFETY: FragmentPair = pair(SourceSafetyZH, SourceSafetyEN);
/** The Quick AI mode's source-safety text: only the "insufficient evidence" sentence differs, so the model may use its own knowledge. */
export const SOURCE_SAFETY_QUICK: FragmentPair = pair(SourceSafetyQuickZH, SourceSafetyQuickEN);

/** The fixed sentence a Quick answer writes in its Detail when sources and model knowledge are both insufficient (matched by `hasKnowledgeGapMarker`). */
export function knowledgeGapMarker(language: ContentLanguage): string {
  return translate(language, "research.knowledge_gap_marker");
}
/** The Quick AI mode's knowledge rule; it replaces the `research.local` text for a Quick map research or expansion. */
export function quickKnowledge(language: ContentLanguage): string {
  return renderTemplate(inLanguage({ zh: QuickKnowledgeZH, en: QuickKnowledgeEN }, language), {
    marker: knowledgeGapMarker(language)
  });
}

/**
 * The tone rule plus the resolved tone text. Callers add it only when a tone text exists (academic or absent adds
 * nothing), so prompts without a tone stay byte-identical to before.
 */
export function toneBlock(toneText: string, language: ContentLanguage): string {
  return renderTemplate(inLanguage({ zh: ToneZH, en: ToneEN }, language), { tone: toneText });
}

const HEADINGS_VERBATIM: FragmentPair = { zh: HeadingsVerbatimZH, en: HeadingsVerbatimEN };
const HEADINGS_VERBATIM_FOLLOW: FragmentPair = { zh: HeadingsVerbatimFollowZH, en: HeadingsVerbatimFollowEN };
const HEADINGS_VERBATIM_CUSTOM: FragmentPair = { zh: HeadingsVerbatimCustomZH, en: HeadingsVerbatimCustomEN };
/**
 * When the output language is written in a different note language (Simplified Chinese interface, Traditional headings),
 * the clause that tells the model to copy the fixed headings exactly as listed while writing the content in the output
 * language. Empty for languages whose note language is themselves, so those prompts stay unchanged.
 */
export function headingsVerbatim(
  output: ContentLanguage,
  instruction?: InstructionLanguage,
  custom = false,
  anchor?: FollowAnchor
): string {
  const note = verbatimHeadingLanguage(output);
  if (!note) return "";
  const spelled = instruction ?? instructionLanguageOf(output);
  const language = languagePromptName(output, spelled, "plain", anchor);
  // A custom template's headings are whatever the user wrote, so its clause does not name a heading language.
  if (custom) return renderTemplate(HEADINGS_VERBATIM_CUSTOM[spelled], { language });
  // Following the input is not a language: the headings are simply left as listed, with no "note language vs language" contrast.
  if (isFollowInputLanguage(output)) return renderTemplate(HEADINGS_VERBATIM_FOLLOW[spelled], { language });
  return renderTemplate(HEADINGS_VERBATIM[spelled], {
    note: languagePromptName(note, spelled, "plain"),
    language
  });
}

/** Which Obsidian syntaxes a note style file allows (all on, callouts "auto" = today's text). */
export interface FormatPreferences {
  callouts: "auto" | "placed";
  diagrams: boolean;
  tables: boolean;
  tasks: boolean;
  highlight: boolean;
  /** Replacement callout type (or "off" to drop the line) for the summary / warning / question / tip lines; absent = default. */
  calloutMap?: Partial<Record<"summary" | "warning" | "question" | "tip", string>>;
}
const FORMAT_PREFERENCES: FragmentPair = { zh: FormatPreferencesZH, en: FormatPreferencesEN };
const FORMAT_PREFERENCES_PLACED: FragmentPair = {
  zh: text(FormatPreferencesPlacedZH),
  en: text(FormatPreferencesPlacedEN)
};
const FORMAT_ITEM_NAMES = {
  zh: ["callout", "圖表（mermaid）", "表格", "待辦清單（- [ ]）", "螢光標記（==highlight==）"],
  en: ["callouts", "diagrams (mermaid)", "tables", "task lists (- [ ])", "highlights (==highlight==)"]
} as const;

/**
 * The Obsidian syntax text with the lines of syntaxes a note style does not use removed, followed by the fixed
 * "this style does not use" sentence. With every preference at its default (or none given) it is OBSIDIAN_FORMAT as is.
 * Rules 1-10 are never touched.
 */
export function obsidianFormat(language: ContentLanguage, preferences?: FormatPreferences): string {
  const original = inLanguage(OBSIDIAN_FORMAT, language);
  if (!preferences) return original;
  const { callouts, diagrams, tables, tasks, highlight } = preferences;
  const placed = callouts === "placed";
  const calloutMap = preferences.calloutMap ?? {};
  if (!placed && diagrams && tables && tasks && highlight && !Object.keys(calloutMap).length) return original;
  const zh = instructionLanguageOf(language) === "zh";
  const off = [placed, !diagrams, !tables, !tasks, !highlight];
  const lines: string[] = [];
  let lastBullet = 0;
  for (let line of original.split("\n")) {
    if (line.startsWith("- ")) {
      if (placed && line.includes("> [!")) continue;
      // A remapped callout line (D5): its first callout token names the line; "off" drops it, otherwise the type is swapped.
      const lead = /^- [^`]*`> \[!(summary|warning|question|tip)\]`/.exec(line);
      const to = lead ? calloutMap[lead[1] as "summary" | "warning" | "question" | "tip"] : undefined;
      if (lead && to === "off") continue;
      if (lead && to)
        line =
          lead[1] === "tip"
            ? line.replace(zh ? "`> [!tip]` 或 `> [!example]`" : "`> [!tip]` or `> [!example]`", `\`> [!${to}]\``)
            : line.replace(`\`> [!${lead[1]}]\``, `\`> [!${to}]\``);
      if (!diagrams && line.includes("```mermaid```")) continue;
      if (!tasks && line.includes("`- [ ]`")) continue;
      if (!highlight && line.includes("==highlight==")) continue;
      if (line.includes(zh ? "Markdown 表格" : "a Markdown table")) {
        if (!tables) continue;
        // The chart that goes right under a table is a diagram: without diagrams the line keeps only the table.
        if (!diagrams) line = line.slice(0, line.indexOf(zh ? "表格裡有" : " When the table holds")).trimEnd();
      }
      lines.push(line);
      lastBullet = lines.length - 1;
    } else lines.push(line);
  }
  // Only callout lines were remapped or dropped: no syntax is switched off, so no "does not use" sentence.
  if (!off.some(Boolean)) return lines.join("\n");
  const names = FORMAT_ITEM_NAMES[zh ? "zh" : "en"];
  const list = names.filter((_, index) => off[index]).join(zh ? "、" : ", ");
  const sentence = [
    renderTemplate(inLanguage(FORMAT_PREFERENCES, language), { list }),
    placed ? inLanguage(FORMAT_PREFERENCES_PLACED, language) : ""
  ]
    .filter(Boolean)
    .join(zh ? "" : " ");
  if (lastBullet) lines.splice(lastBullet + 1, 0, "", sentence);
  else {
    // Every bullet was removed: keep one blank line between the lead-in, the sentence and the rules.
    const rest = lines.slice(1).filter((line, index, all) => line || all[index - 1] !== "");
    lines.splice(1, lines.length - 1, ...rest);
    lines.splice(2, 0, sentence, "");
  }
  return lines.join("\n");
}
