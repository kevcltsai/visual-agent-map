import type { ContentLanguage } from "../../../i18n";
import { renderTemplate } from "../../step-runner";
import { inLanguage, type FragmentPair } from "../_shared/fragments";
import ExtractZH from "./extract.zh.md";
import ExtractEN from "./extract.en.md";
import ReduceZH from "./reduce.zh.md";
import ReduceEN from "./reduce.en.md";

const text = (template: string): string => renderTemplate(template, {});
const EXTRACT: FragmentPair = { zh: text(ExtractZH), en: text(ExtractEN) };
const REDUCE: FragmentPair = { zh: text(ReduceZH), en: text(ReduceEN) };

/**
 * The task text of the two reference rounds. Round one extracts evidence from every source section
 * (step `task.reference-extract`); later rounds merge the extracted evidence (step `task.reference-reduce`). Each
 * round is sent as an ordinary task step with this text as its task, so its prompt is the regular task prompt.
 */
export function referenceTask(round: "extract" | "reduce", language: ContentLanguage): string {
  return inLanguage(round === "extract" ? EXTRACT : REDUCE, language);
}
