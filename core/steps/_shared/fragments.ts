import { renderTemplate } from "../../step-runner";
import {
  instructionLanguageOf,
  languagePromptName,
  verbatimHeadingLanguage,
  type InstructionLanguage,
  type PromptNameForm,
  type UiLanguage
} from "../../../i18n";
import LabelAncestorsZH from "./label-ancestors.zh.md";
import LabelAncestorsEN from "./label-ancestors.en.md";
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
import HeadingsVerbatimZH from "./headings-verbatim.zh.md";
import HeadingsVerbatimEN from "./headings-verbatim.en.md";
import HeadingsVerbatimCustomZH from "./headings-verbatim-custom.zh.md";
import HeadingsVerbatimCustomEN from "./headings-verbatim-custom.en.md";
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
export function inLanguage(fragment: FragmentPair, language: UiLanguage): string {
  return fragment[instructionLanguageOf(language)];
}

/**
 * A fragment that names the output language. `names` maps each `{{placeholder}}` to the registry name form it takes; the
 * name is spelled for the fragment's instruction language unless `spelledIn` says the file is written in the other one
 * (a few `.zh.md` files carry English sentences).
 */
export function inLanguageNaming(
  fragment: FragmentPair,
  language: UiLanguage,
  names: Readonly<Record<string, PromptNameForm>>,
  spelledIn?: InstructionLanguage
): string {
  return renderTemplate(
    fragment[instructionLanguageOf(language)],
    languageVariables(language, names, undefined, spelledIn)
  );
}

/**
 * Template variables naming `language`: each placeholder maps to a registry name form, spelled for `spelledIn` or, by
 * default, for the instruction language of `instructionOf` (the language the prompt is written for).
 */
export function languageVariables(
  language: UiLanguage,
  names: Readonly<Record<string, PromptNameForm>>,
  instructionOf: UiLanguage = language,
  spelledIn?: InstructionLanguage
): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const [placeholder, form] of Object.entries(names))
    variables[placeholder] = languagePromptName(language, spelledIn ?? instructionLanguageOf(instructionOf), form);
  return variables;
}

/** Claude only: return through the StructuredOutput tool at once, without a text draft first. Codex prompts never include it. */
export const CLAUDE_STRUCTURED_OUTPUT: FragmentPair = pair(ClaudeStructuredOutputZH, ClaudeStructuredOutputEN);
/** A response-contract block; Claude's carries the StructuredOutput instruction after it, Codex's is the contract unchanged. */
export function withProviderOutput(contract: string, provider: "claude" | "codex", language: UiLanguage): string {
  return provider === "claude" ? `${contract}\n${inLanguage(CLAUDE_STRUCTURED_OUTPUT, language)}` : contract;
}

export const LABEL_ANCESTORS: FragmentPair = pair(LabelAncestorsZH, LabelAncestorsEN);
export const LABEL_RULES: FragmentPair = pair(LabelRulesZH, LabelRulesEN);
export const LABEL_SOURCES: FragmentPair = pair(LabelSourcesZH, LabelSourcesEN);
export const LABEL_SUMMARY: FragmentPair = pair(LabelSummaryZH, LabelSummaryEN);
export const LABEL_TASK: FragmentPair = pair(LabelTaskZH, LabelTaskEN);
export const LABEL_TOPIC: FragmentPair = pair(LabelTopicZH, LabelTopicEN);
export const LOCAL_FIRST: FragmentPair = pair(LocalFirstZH, LocalFirstEN);
export const NONE: FragmentPair = pair(NoneZH, NoneEN);
/** How a reader-facing detail uses Obsidian syntax (callouts, tables, mermaid, task lists, highlights). */
export const OBSIDIAN_FORMAT: FragmentPair = pair(ObsidianFormatZH, ObsidianFormatEN);
export const REFERENCE_CITATIONS: FragmentPair = pair(ReferenceCitationsZH, ReferenceCitationsEN);
export const ROLE: FragmentPair = pair(RoleZH, RoleEN);
export const SOURCE_SAFETY: FragmentPair = pair(SourceSafetyZH, SourceSafetyEN);

/**
 * The tone rule plus the resolved tone text. Callers add it only when a tone text exists (academic or absent adds
 * nothing), so prompts without a tone stay byte-identical to before.
 */
export function toneBlock(toneText: string, language: UiLanguage): string {
  return renderTemplate(inLanguage({ zh: ToneZH, en: ToneEN }, language), { tone: toneText });
}

const HEADINGS_VERBATIM: FragmentPair = { zh: HeadingsVerbatimZH, en: HeadingsVerbatimEN };
const HEADINGS_VERBATIM_CUSTOM: FragmentPair = { zh: HeadingsVerbatimCustomZH, en: HeadingsVerbatimCustomEN };
/**
 * When the output language is written in a different note language (Simplified Chinese interface, Traditional headings),
 * the clause that tells the model to copy the fixed headings exactly as listed while writing the content in the output
 * language. Empty for languages whose note language is themselves, so those prompts stay unchanged.
 */
export function headingsVerbatim(output: UiLanguage, instruction?: InstructionLanguage, custom = false): string {
  const note = verbatimHeadingLanguage(output);
  if (!note) return "";
  const spelled = instruction ?? instructionLanguageOf(output);
  // A custom template's headings are whatever the user wrote, so its clause does not name a heading language.
  if (custom)
    return renderTemplate(HEADINGS_VERBATIM_CUSTOM[spelled], {
      language: languagePromptName(output, spelled, "plain")
    });
  return renderTemplate(HEADINGS_VERBATIM[spelled], {
    note: languagePromptName(note, spelled, "plain"),
    language: languagePromptName(output, spelled, "plain")
  });
}
