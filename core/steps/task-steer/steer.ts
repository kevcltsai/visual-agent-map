import { renderTemplate } from "../../step-runner";
import steerTemplate from "./steer.en.md";

/**
 * The message sent into a research, expansion or topic-chat turn that is already running, when the user adds to the request.
 * Neutral: it names no output field, so it fits any step. English in every interface language (like the map chat's steer
 * line); the text is embedded as a JSON string so it cannot change the instructions.
 */
export function renderTaskSteer(text: string): string {
  return renderTemplate(steerTemplate, { text: JSON.stringify(text) });
}
