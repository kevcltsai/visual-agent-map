import { renderTemplate, type StepDefinition } from "../../../../core/step-runner";
import { parsePlan, type ContextPlan } from "../../action-plan";
import template from "./prompt.md";

interface PlanInput {
  instruction: string;
  selected: string;
  context: string;
  hasImage: boolean;
}

/** Classifies the user's request on the selected Markdown text into one action. The prompt is not localized. */
export const planStep: StepDefinition<PlanInput, ContextPlan> = {
  id: "markdown.plan",
  version: 1,
  render: ({ instruction, selected, context, hasImage }) =>
    renderTemplate(template, {
      request: JSON.stringify({ userRequest: instruction, selected, nearbyContext: context, hasImage })
    }),
  parse: raw => parsePlan(raw)
};
