import type { ContentLanguage } from "../../../i18n";
import { renderTemplate } from "../../step-runner";
import { inLanguage, type FragmentPair } from "../_shared/fragments";
import ExtractZH from "./extract.zh.md";
import ExtractEN from "./extract.en.md";
import ReduceZH from "./reduce.zh.md";
import ReduceEN from "./reduce.en.md";
import FocusZH from "./focus.zh.md";
import FocusEN from "./focus.en.md";
import FocusReduceZH from "./focus-reduce.zh.md";
import FocusReduceEN from "./focus-reduce.en.md";

const text = (template: string): string => renderTemplate(template, {});
const EXTRACT: FragmentPair = { zh: text(ExtractZH), en: text(ExtractEN) };
const REDUCE: FragmentPair = { zh: text(ReduceZH), en: text(ReduceEN) };
const FOCUS_EXTRACT: FragmentPair = { zh: FocusZH, en: FocusEN };
// The reduce round keeps the verbatim passages but may drop the least relevant ones (listed by [S#] and path), so the
// findings can still shrink under the condensed limit.
const FOCUS_REDUCE: FragmentPair = { zh: FocusReduceZH, en: FocusReduceEN };

/** The topic and the user's own task the evidence is condensed for; a blank task means no focus. */
export interface ReferenceFocus {
  title: string;
  task: string;
}

/**
 * The task text of the two reference rounds. Round one extracts evidence from every source section
 * (step `task.reference-extract`); later rounds merge the extracted evidence (step `task.reference-reduce`). Each
 * round is sent as an ordinary task step with this text as its task, so its prompt is the regular task prompt.
 * With a focus whose task is not blank, the rounds also see that topic and task, so an ask for the sources' own
 * text keeps the relevant passages word for word instead of a summary of them.
 */
export function referenceTask(round: "extract" | "reduce", language: ContentLanguage, focus?: ReferenceFocus): string {
  const base = inLanguage(round === "extract" ? EXTRACT : REDUCE, language);
  if (!focus?.task.trim()) return base;
  const template = inLanguage(round === "extract" ? FOCUS_EXTRACT : FOCUS_REDUCE, language);
  return `${base}\n\n${renderTemplate(template, { title: focus.title, task: focus.task.trim() })}`;
}
