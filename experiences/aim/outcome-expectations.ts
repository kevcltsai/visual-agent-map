import { translate, type NoteLanguage } from "../../i18n";

export type AimOutcomeGoal = "auto" | "execute" | "understand" | "explore" | "custom";
export type AimOutcomeFormat = "steps" | "table" | "images" | "longform";

export interface AimOutcomeExpectation {
  goal: AimOutcomeGoal;
  description: string;
  formats: AimOutcomeFormat[];
}

const goals: AimOutcomeGoal[] = ["auto", "execute", "understand", "explore", "custom"];
const formats: AimOutcomeFormat[] = ["steps", "table", "images", "longform"];

/** Validate and trim the user-controlled expectation before it is persisted. */
export function normalizeAimOutcomeExpectation(value: unknown): AimOutcomeExpectation | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid AIM outcome expectation.");
  const input = value as Record<string, unknown>;
  if (typeof input.goal !== "string" || !goals.includes(input.goal as AimOutcomeGoal))
    throw new Error("Invalid AIM outcome goal.");
  if (typeof input.description !== "string") throw new Error("Invalid AIM outcome description.");
  if (
    !Array.isArray(input.formats) ||
    input.formats.some(format => typeof format !== "string" || !formats.includes(format as AimOutcomeFormat))
  )
    throw new Error("Invalid AIM presentation preference.");
  const goal = input.goal as AimOutcomeGoal;
  const description = input.description.trim();
  if (goal === "custom" && !description) throw new Error("Describe the custom AIM outcome.");
  return { goal, description, formats: [...new Set(input.formats as AimOutcomeFormat[])] };
}

/** Append the user-provided expectation to the existing durable root context. */
export function buildAimRootContext(context: string, value: unknown, language: NoteLanguage): string {
  const expectation = normalizeAimOutcomeExpectation(value);
  const sections: string[] = [context.trim()];
  if (!expectation) return sections[0];
  const tr = (key: Parameters<typeof translate>[1]): string => translate(language, key);

  const goalLabels: Record<AimOutcomeGoal, string> = {
    auto: tr("ui.aim_outcome_auto"),
    execute: tr("ui.aim_outcome_execute"),
    understand: tr("ui.aim_outcome_understand"),
    explore: tr("ui.aim_outcome_explore"),
    custom: tr("ui.aim_outcome_custom")
  };
  const formatLabels: Record<AimOutcomeFormat, string> = {
    steps: tr("ui.aim_format_steps"),
    table: tr("ui.aim_format_table"),
    images: tr("ui.aim_format_images"),
    longform: tr("ui.aim_format_longform")
  };
  const details = [
    `${tr("ui.aim_outcome_goal")}: ${goalLabels[expectation.goal]}`,
    `${tr("ui.aim_outcome_formats")}: ${expectation.formats.length ? expectation.formats.map(format => formatLabels[format]).join(", ") : tr("ui.aim_format_system")}`
  ];
  if (expectation.description) details.push(`${tr("ui.aim_outcome_description")}: ${expectation.description}`);
  sections.push(`## ${tr("ui.aim_outcome_user_section")}\n\n${details.join("\n")}`);
  return sections.filter(Boolean).join("\n\n");
}
