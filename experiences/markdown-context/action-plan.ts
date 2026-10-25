export { imageMarkdown, type ImageCandidate } from "../../core/image-candidates";
export type ContextAction = "transform" | "research" | "image_search" | "diagram" | "image_generate" | "clarify";
export interface ContextPlan {
  action: ContextAction;
  query: string;
  instruction: string;
  placement: "after" | "replace";
  captionInstruction: string;
}

export function parsePlan(raw: string): ContextPlan {
  const value: unknown = JSON.parse(
    raw
      .trim()
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "")
  );
  if (!value || typeof value !== "object") throw new Error("Invalid AI action plan");
  const plan = value as Partial<ContextPlan>;
  if (
    !["transform", "research", "image_search", "diagram", "image_generate", "clarify"].includes(plan.action ?? "") ||
    typeof plan.captionInstruction !== "string" ||
    typeof plan.query !== "string" ||
    typeof plan.instruction !== "string" ||
    !["after", "replace"].includes(plan.placement ?? "")
  )
    throw new Error("Invalid AI action plan");
  return plan as ContextPlan;
}
