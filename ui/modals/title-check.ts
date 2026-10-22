import { t } from "../../i18n";
import { titleProblem } from "../../core/title-safety";

/** The sentence shown beside a title field when the text cannot be saved, or "" when it is fine. */
export function titleProblemText(text: string): string {
  const problem = titleProblem(text);
  if (problem === "fence") return t("ui.title_problem_fence");
  if (problem === "brackets") return t("ui.title_problem_brackets");
  return "";
}
