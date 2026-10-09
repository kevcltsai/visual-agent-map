import { translate, type UiLanguage } from "../../i18n";

export type MindSearchOutcomeGoal = "auto" | "execute" | "understand" | "explore" | "custom";
export type MindSearchOutcomeFormat = "steps" | "table" | "images" | "longform";

export interface MindSearchOutcomeExpectation {
  goal: MindSearchOutcomeGoal;
  description: string;
  formats: MindSearchOutcomeFormat[];
}

const goals: MindSearchOutcomeGoal[] = ["auto", "execute", "understand", "explore", "custom"];
const formats: MindSearchOutcomeFormat[] = ["steps", "table", "images", "longform"];

/** Validate and trim the user-controlled expectation before it is persisted. */
export function normalizeMindSearchOutcomeExpectation(value: unknown): MindSearchOutcomeExpectation | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MindSearch outcome expectation.");
  const input = value as Record<string, unknown>;
  if (typeof input.goal !== "string" || !goals.includes(input.goal as MindSearchOutcomeGoal)) throw new Error("Invalid MindSearch outcome goal.");
  if (typeof input.description !== "string") throw new Error("Invalid MindSearch outcome description.");
  if (!Array.isArray(input.formats) || input.formats.some(format => typeof format !== "string" || !formats.includes(format as MindSearchOutcomeFormat))) throw new Error("Invalid MindSearch presentation preference.");
  const goal = input.goal as MindSearchOutcomeGoal;
  const description = input.description.trim();
  if (goal === "custom" && !description) throw new Error("Describe the custom MindSearch outcome.");
  return { goal, description, formats: [...new Set(input.formats as MindSearchOutcomeFormat[])] };
}

/** Append the user-provided expectation to the existing durable root context. */
export function buildMindSearchRootContext(context: string, value: unknown, language: UiLanguage): string {
  const expectation = normalizeMindSearchOutcomeExpectation(value);
  const sections: string[] = [context.trim()];
  if (!expectation) return sections[0];
  const tr = (key: Parameters<typeof translate>[1]): string => translate(language, key);

  const goalLabels: Record<MindSearchOutcomeGoal, string> = {
    auto: tr("ui.mindsearch_outcome_auto"),
    execute: tr("ui.mindsearch_outcome_execute"),
    understand: tr("ui.mindsearch_outcome_understand"),
    explore: tr("ui.mindsearch_outcome_explore"),
    custom: tr("ui.mindsearch_outcome_custom")
  };
  const formatLabels: Record<MindSearchOutcomeFormat, string> = {
    steps: tr("ui.mindsearch_format_steps"),
    table: tr("ui.mindsearch_format_table"),
    images: tr("ui.mindsearch_format_images"),
    longform: tr("ui.mindsearch_format_longform")
  };
  const details = [
    `${tr("ui.mindsearch_outcome_goal")}: ${goalLabels[expectation.goal]}`,
    `${tr("ui.mindsearch_outcome_formats")}: ${expectation.formats.length ? expectation.formats.map(format => formatLabels[format]).join(", ") : tr("ui.mindsearch_format_system")}`
  ];
  if (expectation.description) details.push(`${tr("ui.mindsearch_outcome_description")}: ${expectation.description}`);
  sections.push(`## ${tr("ui.mindsearch_outcome_user_section")}\n\n${details.join("\n")}`);
  return sections.filter(Boolean).join("\n\n");
}
